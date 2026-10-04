"""Let the share pages run as a DIFFERENT user that cannot read the director key.

Share pages are the one part of Bandstand that strangers reach. They run as their
own process, and in the container as their own user (1001) in the server's group.
A bug in that process must not hand out the key or allow a write to the database,
so the data folder is laid out like this when share pages are switched on
(BANDSTAND_SHARE_PAGES=1):

    data folder      rwxr-x---   the group may look inside, not create or delete
    .key             rw-------   owner only: the share user cannot read it
    library.db       rw-r-----   the group may read
    library.db-wal   rw-r-----   the group may read
    library.db-shm   rw-rw----   the group may read and write (see below)
    .share-cache/    rwxrwx---   the share process keeps its rendered pages here
    backups/, tmp/   rwx------   owner only

SQLite in WAL mode needs every reader to write to the small -shm index (that is where
readers register themselves). It holds no library content. The -wal and -shm files
only exist while a connection is open, so the main server keeps one open for as long
as it runs: the share process never has to create them, which it has no right to do.

POSIX only. On Windows the modes are not expressed this way and nothing is changed.
"""
import os
import sqlite3
import stat
from pathlib import Path

from server import db
from server.config import Config

SHARE_CACHE = ".share-cache"


def enabled() -> bool:
    raw = os.environ.get("BANDSTAND_SHARE_PAGES", "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _chmod(path: Path, mode: int) -> None:
    try:
        if path.exists() and stat.S_IMODE(path.stat().st_mode) != mode:
            os.chmod(path, mode)
    except OSError as exc:
        print(f"[share] could not set permissions on {path}: {exc}", flush=True)


class ShareAccess:
    """Holds the database open and the permissions right while the server runs."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._conn: sqlite3.Connection | None = None

    def start(self) -> None:
        cfg = self.cfg
        # check_same_thread off: opened in the startup thread, closed at shutdown.
        self._conn = sqlite3.connect(cfg.db_path, isolation_level=None, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode = WAL")
        # A read makes SQLite create -wal and -shm if they are not there yet.
        self._conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()
        if os.name != "posix":
            return
        (cfg.data_dir / SHARE_CACHE).mkdir(exist_ok=True)
        _chmod(cfg.key_path, 0o600)
        _chmod(cfg.data_dir, 0o750)
        _chmod(cfg.db_path, 0o640)
        _chmod(Path(f"{cfg.db_path}-wal"), 0o640)
        _chmod(Path(f"{cfg.db_path}-shm"), 0o660)
        _chmod(cfg.data_dir / SHARE_CACHE, 0o770)
        _chmod(cfg.data_dir / "backups", 0o700)
        _chmod(cfg.data_dir / "tmp", 0o700)

    def stop(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None


def close_again(cfg: Config) -> bool:
    """Share pages were on once and are off now: the group loses its way in.

    Acts only on a folder that carries this module's own marks (mode 750 and a
    share cache), so a folder whose permissions somebody chose by hand is never
    touched. Returns True when it changed something."""
    if os.name != "posix":
        return False
    try:
        ours = (
            stat.S_IMODE(cfg.data_dir.stat().st_mode) == 0o750
            and (cfg.data_dir / SHARE_CACHE).is_dir()
        )
    except OSError:
        return False
    if not ours:
        return False
    _chmod(cfg.data_dir, 0o700)
    return True


class ShareProblem(Exception):
    """Why the share pages cannot start. Written for the operator."""


def check_from_share_process(cfg: Config) -> list[str]:
    """Run by the share process before it starts serving. Returns warnings; raises
    ShareProblem when it cannot work at all."""
    try:
        listing_ok = cfg.db_path.exists()
    except OSError:
        listing_ok = False
    if not listing_ok:
        raise ShareProblem(
            f"The share pages cannot see the library in {cfg.data_dir}. Either the main "
            "server has not started yet, or share pages are not switched on for it. "
            "Set BANDSTAND_SHARE_PAGES=1 in the file .env, then run: docker compose up -d"
        )
    try:
        conn = db.connect_ro(cfg.db_path)
        try:
            conn.execute("SELECT COUNT(*) FROM shares").fetchone()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        raise ShareProblem(
            f"The share pages cannot read the library in {cfg.data_dir} ({exc}). "
            "The main server must be running, with BANDSTAND_SHARE_PAGES=1 in the "
            "file .env."
        ) from None
    warnings = []
    if os.access(cfg.key_path, os.R_OK):
        warnings.append(
            "WARNING: this process can read the director key. Share pages face "
            "strangers and should run as a different user from the main server. "
            "See docs/SELF-HOSTING.md, section \"Share links\"."
        )
    return warnings
