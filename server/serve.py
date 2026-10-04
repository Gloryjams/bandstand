"""Start a Bandstand server: `python -m server.serve`.

This is what the container runs. It does the first-boot work BEFORE the web server
starts, so the operator reads, in order: the version, where the data lives, and
where the director key is.

The key VALUE is never printed, logged or returned. Only its path is. Logs get
copied into bug reports and chat windows; a path is safe there and a key is not.
"""
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
from typing import Callable

from server import config, db, instance_lock
from server.config import Config
from server.version import VERSION

_MIN_KEY_LENGTH = 32  # auth.py refuses anything shorter; fail at boot, not per request.


class StartupProblem(Exception):
    """Something the operator has to fix before the server can run. The message is
    written for them, and it never contains a key."""


class KeyProblem(StartupProblem):
    """The director key exists but cannot be trusted. The message names the path only."""


class DataFolderProblem(StartupProblem):
    """The data folder cannot be read or written by the user the server runs as."""


def _who() -> str:
    return f"user {os.getuid()}" if hasattr(os, "getuid") else "the current user"


def _data_folder_problem(cfg: Config, exc: OSError) -> DataFolderProblem:
    return DataFolderProblem(
        f"The server cannot use its data folder, {cfg.data_dir} "
        f"({type(exc).__name__} on {exc.filename or cfg.data_dir}). "
        f"The server runs as {_who()} and everything in that folder must belong to it. "
        "This usually happens after files were copied into the folder by hand. "
        'See docs/SELF-HOSTING.md, section "Restore a backup", for the one command '
        "that fixes it."
    )


# "trace" is left out on purpose: at that level the web server prints the whole
# request scope, query string included, and /api/events carries a stream ticket
# there (and the key itself, while BANDSTAND_EVENTS_KEY_IN_URL keeps the old
# address working).
LOG_LEVELS = ("critical", "error", "warning", "info", "debug")
DEFAULT_LOG_LEVEL = "info"


def log_level(out: Callable[[str], None] = print) -> str:
    raw = os.environ.get("BANDSTAND_LOG_LEVEL", "").strip().lower()
    if not raw:
        return DEFAULT_LOG_LEVEL
    if raw not in LOG_LEVELS:
        out(
            f"BANDSTAND_LOG_LEVEL={raw!r} is not one of {', '.join(LOG_LEVELS)}. "
            f"Using {DEFAULT_LOG_LEVEL}."
        )
        return DEFAULT_LOG_LEVEL
    return raw


def use_data_folder_for_temporary_files(cfg: Config) -> None:
    """Large uploads and exports are written to a temporary file first. In the
    container /tmp is a small slice of memory, so they go to a folder on the data
    disk instead. Leftovers from a crash are cleared at start. An operator who set
    TMPDIR knows better and is left alone."""
    if os.environ.get("TMPDIR", "").strip():
        return
    folder = cfg.data_dir / "tmp"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)
    os.environ["TMPDIR"] = str(folder)
    tempfile.tempdir = None  # make the module look again


def _truthy(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _tighten(cfg: Config, out: Callable[[str], None]) -> None:
    """Make the key readable by its owner only. POSIX only: Windows ACLs are not
    expressed in mode bits."""
    if os.name != "posix":
        return
    mode = stat.S_IMODE(cfg.key_path.stat().st_mode)
    if mode & 0o077:
        try:
            os.chmod(cfg.key_path, 0o600)
            out(f"Director key permissions tightened to owner-only: {cfg.key_path}")
        except OSError:
            out(
                "WARNING: the director key is readable by other users on this "
                f"computer and could not be fixed automatically: {cfg.key_path}"
            )


def prepare(cfg: Config, out: Callable[[str], None] = print) -> bool:
    """Create the data folders, the key and the schema. Returns True when THIS boot
    created the key (a first boot)."""
    try:
        existed = cfg.key_path.exists()
        instance_lock.check_free(cfg.data_dir)
        report = db.bootstrap_schema(cfg)
        if not cfg.key_path.exists():
            raise KeyProblem(f"The director key could not be created at {cfg.key_path}")
        # Length only. The value itself never leaves this expression.
        key_length = len(cfg.key_path.read_text().strip())
    except instance_lock.DataFolderInUse as exc:
        raise StartupProblem(str(exc)) from None
    except db.SchemaProblem as exc:
        raise StartupProblem(str(exc)) from None
    except OSError as exc:
        raise _data_folder_problem(cfg, exc) from None
    except sqlite3.OperationalError as exc:
        # SQLite reports an unwritable or unreadable database file this way.
        if "readonly" in str(exc).lower() or "unable to open" in str(exc).lower():
            raise _data_folder_problem(cfg, OSError(str(exc))) from None
        raise
    if key_length < _MIN_KEY_LENGTH:
        raise KeyProblem(
            f"The director key at {cfg.key_path} is empty or damaged. Restore it from "
            "a backup, or delete the file to have a new key created on the next start "
            "(every device will then need to be paired again)."
        )
    _tighten(cfg, out)
    out(f"Bandstand {VERSION}")
    out(f"Data folder: {cfg.data_dir}")
    if existed:
        out(f"Director key: {cfg.key_path}")
    else:
        out(f"First start: a new director key was created at {cfg.key_path}")
        out("Open that file to read the key. It is never shown in these logs.")
    for line in report.lines():
        out(line)
    return not existed


def main() -> int:
    try:
        cfg = config.load()
    except ValueError as problem:  # a setting that cannot be understood
        print(f"Cannot start: {problem}", file=sys.stderr)
        return 1
    try:
        prepare(cfg)
        use_data_folder_for_temporary_files(cfg)
    except StartupProblem as problem:
        print(f"Cannot start: {problem}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"Cannot start: {_data_folder_problem(cfg, exc)}", file=sys.stderr)
        return 1
    level = log_level()
    host = os.environ.get("BANDSTAND_HOST", "").strip() or "127.0.0.1"
    print(f"Listening on {host}:{cfg.port}", flush=True)

    import uvicorn

    uvicorn.run(
        "server.main:app",
        host=host,
        port=cfg.port,
        # Off unless asked for: the access log records the full request line, and
        # /api/events carries a stream ticket in the query string (the key itself,
        # while BANDSTAND_EVENTS_KEY_IN_URL keeps the old address working).
        access_log=_truthy("BANDSTAND_ACCESS_LOG", default=False),
        log_level=level,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
