import hashlib
import os
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

from server.config import Config


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def connect_ro(db_path: Path) -> sqlite3.Connection:
    """Open the library DB read-only, for the public share app.

    Deliberately NOT connect(): that one mkdirs, opens writable, and sets journal_mode,
    all of which the public process must never do. `mode=ro` plus `query_only` means a
    stray write is refused by SQLite itself, not just by convention.

    No `immutable=1`: the main process writes WAL continuously and a share revocation has
    to be visible here immediately, which immutable mode would hide.
    """
    # SQLite parses the URI path itself, so '?' and '#' inside a Windows path would be
    # read as query/fragment separators; percent-encode everything but the drive colon
    # and the separators. as_posix() turns C:\x into C:/x, which SQLite accepts.
    uri = f"file:{quote(Path(db_path).as_posix(), safe='/:')}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


def _current_version(conn: sqlite3.Connection) -> int:
    has_table = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).fetchone()
    if not has_table:
        return 0
    row = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()
    return row[0] or 0


MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def migration_versions(migrations_dir: Path = MIGRATIONS_DIR) -> list[int]:
    """Version numbers of the migration files on disk, ascending.

    The migrations directory is the single source of truth for the schema version:
    tests derive their expectations from this instead of hardcoding a number that
    goes stale the moment someone adds a migration.
    """
    return sorted(int(f.stem.split("_", 1)[0]) for f in migrations_dir.glob("*.sql"))


class SchemaProblem(Exception):
    """The database cannot be brought to the version this program needs. The message
    is written for the person who runs the server."""


class DatabaseTooNew(SchemaProblem):
    """The data was written by a newer release than the one that is starting."""


class MigrationFailed(SchemaProblem):
    """A schema change did not apply. The database is left as it was."""


@dataclass(frozen=True)
class SchemaReport:
    """What bootstrap_schema did. `copy` is the snapshot taken before an upgrade."""
    before: int
    after: int
    copy: Path | None = None

    @property
    def upgraded(self) -> bool:
        return 0 < self.before < self.after

    def lines(self) -> list[str]:
        if not self.upgraded:
            return []
        return [
            f"Database upgraded from version {self.before} to {self.after}. "
            f"A copy from before the upgrade is at {self.copy}"
        ]


_PRE_UPGRADE_PREFIX = "library.db.before-upgrade-"


def _refuse_newer(applied: int, known: int) -> None:
    if applied > known:
        raise DatabaseTooNew(
            f"This data was written by a newer Bandstand (database version {applied}; "
            f"this version understands up to {known}). Nothing was changed. Either "
            "start the newer Bandstand again, or put back the data from before the "
            'upgrade: see docs/SELF-HOSTING.md, section "Going back after a bad update".'
        )


def run_migrations(conn: sqlite3.Connection, migrations_dir: Path) -> None:
    applied = _current_version(conn)
    files = sorted(migrations_dir.glob("*.sql"))
    known = max((int(f.stem.split("_", 1)[0]) for f in files), default=0)
    # Old code on a newer schema reads and writes columns it does not understand.
    # That is how a rollback quietly damages a library, so it stops here instead.
    _refuse_newer(applied, known)
    for f in files:
        version = int(f.stem.split("_", 1)[0])
        if version <= applied:
            continue
        try:
            conn.executescript(f.read_text(encoding="utf-8"))
        except sqlite3.Error as exc:
            # Every migration is one BEGIN ... COMMIT, so a failure leaves an open
            # transaction behind. Undo it explicitly: nothing half-applied survives.
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise MigrationFailed(
                f"The database could not be upgraded to version {version} "
                f"({f.name}: {exc}). Nothing was changed: it is still version "
                f"{_current_version(conn)}. Go back to the Bandstand version that was "
                "running before, and report this message."
            ) from exc


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _copy_before_upgrade(cfg: Config, before: int, after: int) -> Path:
    """Snapshot the database as it is, before any migration touches it. There are no
    down-migrations, so this file is the way back from a bad upgrade. It lives next
    to the daily snapshots but under its own name, which the 14-file prune ignores."""
    backups_dir = cfg.data_dir / "backups"
    backups_dir.mkdir(parents=True, exist_ok=True)
    label = f"{_PRE_UPGRADE_PREFIX}v{before}-to-v{after}-"
    dest = backups_dir / f"{label}{time.strftime('%Y%m%d-%H%M%S')}"
    fresh = dest.with_name(dest.name + ".part")
    src = sqlite3.connect(cfg.db_path)
    try:
        dst = sqlite3.connect(fresh)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    # A failed upgrade is retried on every start, and a supervisor restarts a server
    # that cannot start. These copies are never pruned, so one per attempt would
    # fill the disk. When the newest copy for this same upgrade already holds
    # exactly this content, it is kept and the fresh one is dropped.
    earlier = sorted(
        p for p in backups_dir.glob(f"{label}*")
        if not p.name.endswith((".part", "-wal", "-shm"))
    )
    if earlier and _digest(earlier[-1]) == _digest(fresh):
        fresh.unlink()
        return earlier[-1]
    if dest.exists():  # two attempts within one second, with different content
        dest = dest.with_name(f"{dest.name}-{secrets.token_hex(2)}")
    fresh.replace(dest)
    return dest


def bootstrap_schema(cfg: Config, migrations_dir: Path | None = None) -> SchemaReport:
    """Dirs + key + migrations, WITHOUT the library scan: enough for the members CLI
    and the band-instance factory to operate before a server has ever started.

    An existing database that is behind gets copied first, then upgraded. One that is
    ahead of this program is refused."""
    migrations_dir = MIGRATIONS_DIR if migrations_dir is None else migrations_dir
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    cfg.library_dir.mkdir(exist_ok=True)
    cfg.thumbs_dir.mkdir(exist_ok=True)
    key_existed = cfg.key_path.exists()
    if not key_existed:
        try:
            fd = os.open(cfg.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(secrets.token_hex(32))
        except FileExistsError:
            pass
    known = max(migration_versions(migrations_dir), default=0)
    conn = connect(cfg.db_path)
    try:
        before = _current_version(conn)
        _refuse_newer(before, known)
        copy = None
        if 0 < before < known:
            try:
                copy = _copy_before_upgrade(cfg, before, known)
            except (OSError, sqlite3.Error) as exc:
                raise MigrationFailed(
                    f"The database needs an upgrade from version {before} to {known}, "
                    "but a copy could not be made first "
                    f"({type(exc).__name__}: {exc}). Nothing was changed. Check that "
                    f"the disk is not full and that {cfg.data_dir} can be written to."
                ) from exc
        run_migrations(conn, migrations_dir)
        # This is the one place that knows whether the data folder is new or an
        # upgrade. The live update stream keeps its old address working for an
        # upgrade only; see server/stream_ticket.py. Late import: that module
        # connects through this one.
        from server import stream_ticket
        stream_ticket.record_install_age(conn, existing=key_existed or before > 0)
        return SchemaReport(before=before, after=_current_version(conn), copy=copy)
    finally:
        conn.close()


def bootstrap(cfg: Config) -> SchemaReport:
    report = bootstrap_schema(cfg)
    for line in report.lines():
        print(line, flush=True)
    # Index any existing library files (idempotent via content_hash dedupe).
    # Late import to avoid circular import: pipeline.py imports from server.db.
    from server.ingest.pipeline import scan_library
    scan_library(cfg)
    return report
