import threading
import time
from pathlib import Path
from typing import Callable

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from server import db as dbmod
from server.config import Config
from server.ingest import pipeline


class _Handler(FileSystemEventHandler):
    def __init__(self, cfg: Config, debounce_seconds: float,
                 on_event: Callable[[Path, str], None]):
        self.cfg = cfg
        self.debounce = debounce_seconds
        self.on_event = on_event
        self._timers: dict[Path, threading.Timer] = {}
        self._lock = threading.Lock()

    def _schedule(self, path: Path, op: str):
        with self._lock:
            t = self._timers.pop(path, None)
            if t:
                t.cancel()

        def fire():
            with self._lock:
                self._timers.pop(path, None)
            self.on_event(path, op)

        timer = threading.Timer(self.debounce, fire)
        timer.daemon = True
        with self._lock:
            self._timers[path] = timer
        timer.start()

    def on_created(self, event: FileSystemEvent):
        if not event.is_directory:
            self._schedule(Path(event.src_path), "upsert")

    def on_modified(self, event: FileSystemEvent):
        if not event.is_directory:
            self._schedule(Path(event.src_path), "upsert")

    def on_deleted(self, event: FileSystemEvent):
        if not event.is_directory:
            self._schedule(Path(event.src_path), "delete")

    def on_moved(self, event):
        if not event.is_directory:
            self._schedule(Path(event.dest_path), "upsert")


class Watcher:
    def __init__(self, cfg: Config, debounce_seconds: float = 2.0):
        self.cfg = cfg
        self._lib = cfg.library_dir.resolve()
        self._handler = _Handler(cfg, debounce_seconds, self._handle)
        self._observer = Observer()

    def _handle(self, path: Path, op: str):
        try:
            if op == "upsert" and path.exists():
                pipeline.ingest_path(self.cfg, path)
                self._publish("piece_changed", path)
            elif op == "delete":
                self._soft_delete(path)
                self._publish("piece_deleted", path)
        except Exception as exc:
            print(f"[watcher] {op} {path}: {exc}")

    def _publish(self, event_type: str, path: Path) -> None:
        # Lazy import to avoid pulling FastAPI/SSE machinery for headless watcher tests.
        try:
            from server.api import events as _events
            _events.publish(event_type, path=str(path))
        except Exception as exc:  # pragma: no cover - non-fatal
            print(f"[watcher] publish failed: {exc}")

    def _soft_delete(self, path: Path):
        try:
            rel = path.relative_to(self._lib).as_posix()
        except ValueError:
            print(f"[watcher] path outside library, ignoring: {path}")
            return
        now = int(time.time() * 1000)
        conn = dbmod.connect(self.cfg.db_path)
        try:
            # Remember which pieces own this chart before we delete its file rows.
            owners = [r[0] for r in conn.execute(
                "SELECT DISTINCT piece_id FROM files "
                "WHERE filename = ? AND deleted_at IS NULL",
                (rel,),
            ).fetchall()]
            conn.execute(
                "UPDATE files SET deleted_at = ? "
                "WHERE filename = ? AND deleted_at IS NULL",
                (now, rel),
            )
            conn.execute(
                "UPDATE audio_tracks SET deleted_at = ? "
                "WHERE filename = ? AND deleted_at IS NULL",
                (now, rel),
            )
            # A piece with no remaining charts is an orphan — soft-delete it too, or
            # an empty card lingers in the library forever (files-only delete wasn't
            # enough). updated_at bumps so the change rides the next manifest mirror.
            for pid in owners:
                remaining = conn.execute(
                    "SELECT COUNT(*) FROM files WHERE piece_id = ? AND deleted_at IS NULL",
                    (pid,),
                ).fetchone()[0]
                if remaining == 0:
                    conn.execute(
                        "UPDATE pieces SET deleted_at = ?, updated_at = ? "
                        "WHERE id = ? AND deleted_at IS NULL",
                        (now, now, pid),
                    )
            # Native charts have no files row — the piece IS the content — so match the
            # removed .saltychart.json to its piece by the stored on-disk filename.
            conn.execute(
                "UPDATE pieces SET deleted_at = ?, updated_at = ? "
                "WHERE chart_file = ? AND kind = 'chart' AND deleted_at IS NULL",
                (now, now, rel),
            )
        finally:
            conn.close()

    def start(self):
        self._observer.schedule(self._handler, str(self._lib),
                                recursive=True)
        self._observer.start()

    def stop(self):
        self._observer.stop()
        self._observer.join(timeout=2)
