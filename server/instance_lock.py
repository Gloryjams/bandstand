"""One server per data folder.

Two servers on one folder means two watchers, two backup schedulers and two writers
on the same library. The second one must refuse to start, in one plain sentence.

The lock is an operating system lock on `<data folder>/.lock`, held for the life of
the process. It is released by the kernel when the process ends, however it ends, so
a crash never leaves a stale lock behind. The file itself is left in place.

Only the main app takes it. The share pages process and the members command line
read and write the same folder by design and do not.
"""
import errno
import os
from pathlib import Path
from typing import IO

LOCK_NAME = ".lock"


class DataFolderInUse(Exception):
    """Another Bandstand server already has this data folder open."""


def _message(data_dir: Path) -> str:
    return (
        f"Another Bandstand server is already running on the data folder {data_dir}. "
        "One data folder belongs to one server. Stop the other server first, or give "
        "this one its own folder with BANDSTAND_DATA_DIR."
    )


def _lock(handle: IO[bytes]) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)  # type: ignore[attr-defined]
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


_BUSY = {errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES, errno.EDEADLK}


def acquire(data_dir: Path) -> IO[bytes] | None:
    """Take the folder. Returns the open handle (keep it for as long as the server
    runs), or None when this filesystem cannot lock at all, in which case the server
    runs unguarded as it always did. Raises DataFolderInUse when somebody else holds
    the folder."""
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / LOCK_NAME
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    handle = os.fdopen(fd, "r+b", buffering=0)
    try:
        _lock(handle)
    except OSError as exc:
        handle.close()
        if exc.errno in _BUSY:
            raise DataFolderInUse(_message(data_dir)) from None
        # Some network and container filesystems have no locking. Not having the
        # guard is better than not having a server.
        print(f"[lock] this filesystem cannot lock {path} ({exc}); continuing without the guard")
        return None
    return handle


def release(handle: IO[bytes] | None) -> None:
    if handle is None:
        return
    try:
        handle.close()  # closing the descriptor releases the lock
    except OSError:
        pass


def check_free(data_dir: Path) -> None:
    """Raise DataFolderInUse when a server holds the folder. Used before the web
    server starts, so the refusal is a sentence and not a startup traceback."""
    release(acquire(data_dir))
