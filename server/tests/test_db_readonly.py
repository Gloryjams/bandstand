"""server.db.connect_ro — the public share app's only door into SQLite.

The WAL tests are the load-bearing ones: the whole share design assumes a second Windows
process can read fresh commits (a revocation, above all) from a database the main app is
writing to. That is asserted here, not assumed.
"""
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from server import db

MIGRATIONS = Path(__file__).parent.parent / "migrations"


def _writable(path: Path) -> sqlite3.Connection:
    c = db.connect(path)
    db.run_migrations(c, MIGRATIONS)
    return c


def test_connect_ro_reads_an_existing_db(tmp_path):
    path = tmp_path / "library.db"
    w = _writable(path)
    w.execute(
        "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
        "VALUES ('s1', 'tok', 'piece', 'p1', 'Take Five', 1)"
    )
    w.close()
    ro = db.connect_ro(path)
    try:
        row = ro.execute("SELECT label FROM shares WHERE token = 'tok'").fetchone()
        assert row["label"] == "Take Five"  # sqlite3.Row, not a tuple
    finally:
        ro.close()


def test_connect_ro_refuses_writes(tmp_path):
    path = tmp_path / "library.db"
    _writable(path).close()
    ro = db.connect_ro(path)
    try:
        with pytest.raises(sqlite3.OperationalError):
            ro.execute(
                "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
                "VALUES ('s2', 'nope', 'piece', 'p', 'L', 1)"
            )
    finally:
        ro.close()


def test_connect_ro_does_not_create_the_db(tmp_path):
    missing = tmp_path / "nested" / "library.db"
    with pytest.raises(sqlite3.OperationalError):
        db.connect_ro(missing)
    assert not missing.exists()
    assert not missing.parent.exists()


def test_connect_ro_handles_a_path_with_spaces(tmp_path):
    # Windows data dirs live under paths like "D:/Band stand"; the URI form has to survive
    # that (and anything else percent-encoding covers).
    directory = tmp_path / "Band stand #1"
    directory.mkdir()
    path = directory / "library.db"
    _writable(path).close()
    ro = db.connect_ro(path)
    try:
        assert ro.execute("SELECT COUNT(*) FROM shares").fetchone()[0] == 0
    finally:
        ro.close()


def test_connect_ro_leaves_journal_mode_alone(tmp_path):
    path = tmp_path / "library.db"
    _writable(path).close()
    ro = db.connect_ro(path)
    try:
        assert ro.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert ro.execute("PRAGMA query_only").fetchone()[0] == 1
    finally:
        ro.close()


def test_ro_sees_writer_commits_immediately_same_process(tmp_path):
    """Two live connections on one WAL database. This is the cheap version; the real
    two-PROCESS case is the next test, because sharing a process shares SQLite's cache
    and page manager and so proves much less than it looks like it does."""
    path = tmp_path / "library.db"
    w = _writable(path)
    ro = db.connect_ro(path)
    try:
        assert ro.execute("SELECT COUNT(*) FROM shares").fetchone()[0] == 0

        w.execute("BEGIN IMMEDIATE")
        w.execute(
            "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
            "VALUES ('s1', 'live-tok', 'piece', 'p1', 'Take Five', 1)"
        )
        w.execute("COMMIT")

        row = ro.execute(
            "SELECT revoked_at FROM shares WHERE token = 'live-tok'"
        ).fetchone()
        assert row is not None and row["revoked_at"] is None

        w.execute("UPDATE shares SET revoked_at = 99 WHERE token = 'live-tok'")

        row = ro.execute(
            "SELECT revoked_at FROM shares WHERE token = 'live-tok'"
        ).fetchone()
        assert row["revoked_at"] == 99
    finally:
        ro.close()
        w.close()


# Reader half of the two-process test. Holds ONE long-lived connect_ro() open across both
# of the parent's commits, so it proves a live connection sees fresh WAL data rather than
# proving that a newly opened connection does.
_READER_SRC = '''
import sys, time
sys.path.insert(0, {root!r})
from pathlib import Path
from server import db

conn = db.connect_ro(Path({dbpath!r}))
print("READY", flush=True)


def wait_for(predicate, label):
    deadline = time.time() + 20
    while time.time() < deadline:
        row = conn.execute(
            "SELECT revoked_at FROM shares WHERE token = 'live-tok'"
        ).fetchone()
        if predicate(row):
            print(label, flush=True)
            return
        time.sleep(0.02)
    print("TIMEOUT " + label, flush=True)
    sys.exit(1)


sys.stdin.readline()
wait_for(lambda r: r is not None, "SAW_CREATE")
sys.stdin.readline()
wait_for(lambda r: r is not None and r["revoked_at"] is not None, "SAW_REVOKE")
'''


def test_ro_in_a_separate_process_sees_writer_commits(tmp_path):
    """The claim the whole design rests on: a SECOND OS PROCESS reading through
    connect_ro() observes this process's commits, promptly. If it ever stops holding,
    revocations stop biting on the live server even though every in-process test passes.

    Handshaked over stdin/stdout rather than timed, so the test cannot pass by luck: the
    child only looks after the parent says it has written, and reports TIMEOUT (exit 1)
    rather than hanging if the row never shows up.
    """
    path = tmp_path / "library.db"
    root = str(Path(db.__file__).resolve().parent.parent)
    reader = tmp_path / "reader.py"
    reader.write_text(_READER_SRC.format(root=root, dbpath=str(path)), encoding="utf-8")

    w = _writable(path)  # creates + migrates before the child opens it read-only
    proc = subprocess.Popen(
        [sys.executable, str(reader)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True,
    )

    def expect(line: str) -> None:
        got = (proc.stdout.readline() or "").strip()
        if got != line:
            proc.kill()
            raise AssertionError(f"expected {line!r}, got {got!r}; stderr={proc.stderr.read()}")

    try:
        expect("READY")

        w.execute(
            "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
            "VALUES ('s1', 'live-tok', 'piece', 'p1', 'Take Five', 1)"
        )
        proc.stdin.write("go\n")
        proc.stdin.flush()
        expect("SAW_CREATE")

        w.execute("UPDATE shares SET revoked_at = 99 WHERE token = 'live-tok'")
        proc.stdin.write("go\n")
        proc.stdin.flush()
        expect("SAW_REVOKE")

        assert proc.wait(timeout=20) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.stdin.close()
        proc.stdout.close()
        proc.stderr.close()
        w.close()


def _wal_bytes(path: Path) -> int:
    wal = path.with_name(path.name + "-wal")
    return wal.stat().st_size if wal.exists() else 0


def test_an_open_ro_read_blocks_truncation_without_erroring(tmp_path):
    """A reader mid-result-set holds a snapshot, so TRUNCATE must report busy and leave
    the WAL alone. The reader must still finish its rows cleanly: blocked, not broken.

    Asserting the checkpoint's return value is the point. Ignoring it (as this test used
    to) would pass even if SQLite refused to do anything at all.
    """
    path = tmp_path / "library.db"
    w = _writable(path)
    for i in range(200):
        w.execute(
            "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
            "VALUES (?, ?, 'piece', 'p', 'L', ?)",
            (f"s{i}", f"tok{i}", i),
        )
    assert _wal_bytes(path) > 0
    ro = db.connect_ro(path)
    try:
        cursor = ro.execute("SELECT id FROM shares ORDER BY created_at")
        assert cursor.fetchone()["id"] == "s0"  # read transaction is now open

        busy, log, checkpointed = w.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        assert busy == 1, "a held read snapshot should block TRUNCATE"
        assert log > 0, "the WAL must survive while a reader still needs it"
        assert _wal_bytes(path) > 0

        assert len(cursor.fetchall()) == 199  # reader completes, unharmed
    finally:
        ro.close()
        w.close()


def test_ro_connection_survives_a_completed_wal_truncation(tmp_path):
    """Once the reader releases its snapshot the checkpoint really does truncate, and the
    same long-lived ro connection keeps working against the rebuilt WAL."""
    path = tmp_path / "library.db"
    w = _writable(path)
    for i in range(200):
        w.execute(
            "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
            "VALUES (?, ?, 'piece', 'p', 'L', ?)",
            (f"s{i}", f"tok{i}", i),
        )
    ro = db.connect_ro(path)
    try:
        assert ro.execute("SELECT COUNT(*) FROM shares").fetchone()[0] == 200

        busy, log, checkpointed = w.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        assert (busy, log, checkpointed) == (0, 0, 0), "TRUNCATE should have completed"
        assert _wal_bytes(path) == 0, "the WAL file should be truncated to nothing"

        # Same connection, opened before the truncation, still reads correctly after it.
        assert ro.execute("SELECT COUNT(*) FROM shares").fetchone()[0] == 200
        w.execute(
            "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
            "VALUES ('after', 'after-tok', 'piece', 'p', 'L', 1)"
        )
        assert ro.execute("SELECT COUNT(*) FROM shares").fetchone()[0] == 201
    finally:
        ro.close()
        w.close()
