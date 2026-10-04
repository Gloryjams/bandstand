import sqlite3
import threading
import time
from pathlib import Path

from server.config import Config

_PREFIX = "library.db.bak-"
_KEEP = 14
_INTERVAL_SECONDS = 24 * 60 * 60
_MIN_AGE_SECONDS = 20 * 60 * 60  # skip a startup backup if the newest is younger


def _existing(backups_dir: Path) -> list[Path]:
    # Names are timestamped (library.db.bak-YYYYmmdd-HHMMSS) so sort == chronological.
    return sorted(backups_dir.glob(f"{_PREFIX}*"))


def snapshot(db_path: Path, backups_dir: Path) -> Path:
    """Snapshot the live DB via the sqlite3 backup API — safe against a concurrently
    written WAL db, unlike a raw shutil.copy which can capture a torn file."""
    backups_dir.mkdir(parents=True, exist_ok=True)
    dest = backups_dir / f"{_PREFIX}{time.strftime('%Y%m%d-%H%M%S')}"
    src = sqlite3.connect(db_path)
    try:
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return dest


def prune(backups_dir: Path, keep: int = _KEEP) -> None:
    """Keep only the newest `keep` snapshots; delete the rest."""
    files = _existing(backups_dir)
    for old in files[:-keep] if len(files) > keep else []:
        old.unlink(missing_ok=True)


def run_backup(cfg: Config, *, force: bool = False) -> Path | None:
    """Snapshot the DB and prune to the newest 14. Returns the new file, or None if
    skipped because a recent backup already exists (avoids churn on PM2 restart loops)."""
    backups_dir = cfg.data_dir / "backups"
    if not force:
        existing = _existing(backups_dir)
        if existing:
            newest_age = time.time() - existing[-1].stat().st_mtime
            if newest_age < _MIN_AGE_SECONDS:
                return None
    dest = snapshot(cfg.db_path, backups_dir)
    prune(backups_dir)
    return dest


class BackupScheduler:
    """Daemon thread that snapshots the DB at startup, then every 24h. Modeled on the
    Watcher's start()/stop() lifecycle. Backup failures are logged, never fatal."""

    def __init__(self, cfg: Config, interval_seconds: float = _INTERVAL_SECONDS):
        self.cfg = cfg
        self.interval = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                run_backup(self.cfg)
            except Exception as exc:  # never let a backup crash or block the server
                print(f"[backup] failed: {exc}")
            self._stop.wait(self.interval)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
