import sqlite3
from pathlib import Path

import pytest

from server import db as _db

# Derived from the migrations directory, never hardcoded: adding migration 0008 must
# not turn every version assertion in this file red (that drift is how six of these
# tests were failing against a perfectly healthy schema).
MIGRATIONS = Path(__file__).parent.parent / "migrations"
VERSIONS = _db.migration_versions(MIGRATIONS)
LATEST = VERSIONS[-1]

_INSERT_PIECE = (
    "INSERT INTO pieces (id, title, page_count, added_at, updated_at) "
    "VALUES ('p1', 'Take Five', 3, 1, 1)"
)


def _apply_through(conn, version: int) -> None:
    """Bring a fresh database to exactly `version` by running the files in order."""
    for f in sorted(MIGRATIONS.glob("*.sql")):
        if int(f.stem.split("_", 1)[0]) <= version:
            conn.executescript(f.read_text(encoding="utf-8"))


def test_migration_files_are_contiguous_from_one():
    # run_migrations skips any file whose number is <= the applied maximum, so a gap
    # or a duplicate number would silently never run. Catch it at the source.
    assert VERSIONS == list(range(1, len(VERSIONS) + 1))


def test_each_migration_records_its_own_version(tmp_path):
    # A migration that forgets its schema_version INSERT (or records the wrong
    # number) would be re-run on every boot. Apply one at a time and check.
    c = _db.connect(tmp_path / "library.db")
    try:
        for f in sorted(MIGRATIONS.glob("*.sql")):
            expected = int(f.stem.split("_", 1)[0])
            c.executescript(f.read_text(encoding="utf-8"))
            got = c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
            assert got == expected, f.name
    finally:
        c.close()


def test_connect_creates_db(tmp_data_dir):
    from server import db
    c = db.connect(tmp_data_dir / "library.db")
    assert (tmp_data_dir / "library.db").exists()
    c.close()


def test_foreign_keys_enabled(conn):
    row = conn.execute("PRAGMA foreign_keys").fetchone()
    assert row[0] == 1


def test_schema_version_recorded(conn):
    row = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()
    assert row[0] == LATEST


def test_pieces_table_exists(conn):
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='pieces'"
    ).fetchone()
    assert row is not None


def test_migration_idempotent(tmp_data_dir):
    from server import db
    c1 = db.connect(tmp_data_dir / "library.db")
    db.run_migrations(c1, Path(__file__).parent.parent / "migrations")
    c1.close()
    c2 = db.connect(tmp_data_dir / "library.db")
    db.run_migrations(c2, Path(__file__).parent.parent / "migrations")
    row = c2.execute("SELECT MAX(version) FROM schema_version").fetchone()
    assert row[0] == LATEST
    count = c2.execute("SELECT COUNT(*) FROM schema_version").fetchone()[0]
    assert count == len(VERSIONS)
    c2.close()


def test_migration_0002_applies_cleanly_on_v1(tmp_path):
    # Simulate a v1 database (only 0001 applied), then run migrations — 0002 must apply
    # atomically: all four columns, the index, and the version bump land together.
    from server import db
    migrations = Path(__file__).parent.parent / "migrations"
    c = db.connect(tmp_path / "library.db")
    try:
        c.executescript((migrations / "0001_init.sql").read_text(encoding="utf-8"))
        assert c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 1
        # Applying all migrations now runs only 0002 (0001 is already applied).
        db.run_migrations(c, migrations)
        cols = {r[1] for r in c.execute("PRAGMA table_info(pieces)").fetchall()}
        assert {"kind", "chart_json", "chart_source_id", "chart_file"} <= cols
        idx = {r[1] for r in c.execute("PRAGMA index_list(pieces)").fetchall()}
        assert "idx_pieces_chart_source" in idx
        # run_migrations applies every pending file (0002 onwards) from v1.
        assert c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == LATEST
    finally:
        c.close()


def test_migration_0003_applies_cleanly_on_v2(tmp_path):
    # Simulate a v2 database (0001 + 0002 applied), then run migrations — 0003 must add
    # the setlists.source_id column, its index, and the version bump together.
    from server import db
    migrations = Path(__file__).parent.parent / "migrations"
    c = db.connect(tmp_path / "library.db")
    try:
        c.executescript((migrations / "0001_init.sql").read_text(encoding="utf-8"))
        c.executescript((migrations / "0002_chart_pieces.sql").read_text(encoding="utf-8"))
        assert c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 2
        db.run_migrations(c, migrations)
        cols = {r[1] for r in c.execute("PRAGMA table_info(setlists)").fetchall()}
        assert "source_id" in cols
        idx = {r[1] for r in c.execute("PRAGMA index_list(setlists)").fetchall()}
        assert "idx_setlists_source" in idx
        assert c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == LATEST
    finally:
        c.close()


def test_migration_0004_applies_cleanly_on_v3(tmp_path):
    # Simulate a v3 database (0001..0003 applied), then run migrations — 0004 must create
    # the shares table, its index, and the version bump together.
    from server import db
    migrations = Path(__file__).parent.parent / "migrations"
    c = db.connect(tmp_path / "library.db")
    try:
        for name in ("0001_init.sql", "0002_chart_pieces.sql", "0003_setlist_source.sql"):
            c.executescript((migrations / name).read_text(encoding="utf-8"))
        assert c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 3
        db.run_migrations(c, migrations)
        cols = {r[1] for r in c.execute("PRAGMA table_info(shares)").fetchall()}
        assert cols == {
            "id", "token", "target_kind", "target_id", "label",
            "created_at", "expires_at", "revoked_at",
        }
        idx = {r[1] for r in c.execute("PRAGMA index_list(shares)").fetchall()}
        assert "idx_shares_created" in idx
        assert c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == LATEST
    finally:
        c.close()


def test_migration_0005_applies_cleanly_on_v4(tmp_path):
    # Simulate a v4 database (0001..0004 applied), then run migrations — 0005 must
    # create the members table and the version bump together.
    from server import db
    migrations = Path(__file__).parent.parent / "migrations"
    c = db.connect(tmp_path / "library.db")
    try:
        for name in ("0001_init.sql", "0002_chart_pieces.sql",
                     "0003_setlist_source.sql", "0004_shares.sql"):
            c.executescript((migrations / name).read_text(encoding="utf-8"))
        assert c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 4
        db.run_migrations(c, migrations)
        cols = {r[1] for r in c.execute("PRAGMA table_info(members)").fetchall()}
        assert cols == {"id", "name", "role", "key_hash", "created_at", "revoked_at"}
        assert c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == LATEST
    finally:
        c.close()


def test_migration_0007_applies_cleanly_on_v6(tmp_path):
    # Simulate a v6 database holding a real piece, then run migrations: 0007 must
    # create personal_notes, add both placeholder columns and their index, leave the
    # existing row intact with the non-placeholder default, and record version 7.
    from server import db
    c = db.connect(tmp_path / "library.db")
    try:
        _apply_through(c, 6)
        assert c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 6
        assert c.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='personal_notes'"
        ).fetchone() is None
        c.execute(_INSERT_PIECE)
        db.run_migrations(c, MIGRATIONS)
        info = c.execute("PRAGMA table_info(personal_notes)").fetchall()
        assert {r[1] for r in info} == {
            "owner_id", "piece_id", "content", "revision", "mutation_id", "updated_at",
        }
        # Column 5 of table_info is the 1-based position inside the primary key.
        pk = [r[1] for r in sorted((r for r in info if r[5]), key=lambda r: r[5])]
        assert pk == ["owner_id", "piece_id"]
        piece_cols = {r[1] for r in c.execute("PRAGMA table_info(pieces)").fetchall()}
        assert {"is_placeholder", "placeholder_source_id"} <= piece_cols
        idx = {r[1] for r in c.execute("PRAGMA index_list(pieces)").fetchall()}
        assert "idx_pieces_placeholder_source" in idx
        row = c.execute(
            "SELECT title, is_placeholder, placeholder_source_id FROM pieces WHERE id = 'p1'"
        ).fetchone()
        assert (row["title"], row["is_placeholder"], row["placeholder_source_id"]) == (
            "Take Five", 0, None,
        )
        assert c.execute(
            "SELECT COUNT(*) FROM schema_version WHERE version = 7"
        ).fetchone()[0] == 1
        assert c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == LATEST
    finally:
        c.close()


def test_personal_notes_are_keyed_per_owner(conn):
    # Two owners may each hold a note on the same piece; one owner may not hold two.
    import sqlite3
    import pytest
    conn.execute(_INSERT_PIECE)
    insert = (
        "INSERT INTO personal_notes (owner_id, piece_id, content, revision, mutation_id, updated_at) "
        "VALUES (?, ?, ?, 1, 'm1', 1)"
    )
    conn.execute(insert, ("rea", "p1", "mine"))
    conn.execute(insert, ("liam", "p1", "also mine"))
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(insert, ("rea", "p1", "second"))
    # The piece reference is enforced (foreign_keys is ON for every connection).
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(insert, ("rea", "no-such-piece", "x"))


def test_shares_target_kind_is_constrained(conn):
    import sqlite3
    import pytest
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
            "VALUES ('a', 't', 'album', 'x', 'L', 1)"
        )


def test_shares_token_is_unique(conn):
    import sqlite3
    import pytest
    conn.execute(
        "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
        "VALUES ('a', 'dupe', 'piece', 'x', 'L', 1)"
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
            "VALUES ('b', 'dupe', 'piece', 'y', 'L', 1)"
        )


def test_bootstrap_creates_directories_and_key(tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    from server import config, db
    cfg = config.load()
    db.bootstrap(cfg)
    assert (tmp_path / "library").is_dir()
    assert (tmp_path / "thumbs").is_dir()
    assert (tmp_path / "library.db").exists()
    assert (tmp_path / ".key").exists()
    key = (tmp_path / ".key").read_text().strip()
    assert len(key) == 64


def test_bootstrap_idempotent(tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    from server import config, db
    cfg = config.load()
    db.bootstrap(cfg)
    key1 = (tmp_path / ".key").read_text()
    db.bootstrap(cfg)
    key2 = (tmp_path / ".key").read_text()
    assert key1 == key2


def test_bootstrap_scans_existing_library(tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    (tmp_path / "library").mkdir()
    from pathlib import Path as P
    import shutil
    fx = P(__file__).parent / "fixtures" / "three_page_titled.pdf"
    shutil.copy(fx, tmp_path / "library" / "Take Five.pdf")
    from server import config, db
    cfg = config.load()
    db.bootstrap(cfg)
    conn = db.connect(cfg.db_path)
    n = conn.execute("SELECT COUNT(*) FROM pieces").fetchone()[0]
    conn.close()
    assert n == 1


def test_migration_0008_lifts_the_one_open_room_index_on_v7(tmp_path):
    # A v7 library with an open room and a proposal in it: after the upgrade the
    # "exactly one open room" index is gone (the server enforces the cap from
    # BANDSTAND_ROOMS_MAX_OPEN instead), the room and its proposal are untouched,
    # and a second open room is now possible at the database level.
    from server import db
    c = db.connect(tmp_path / "library.db")
    try:
        _apply_through(c, 7)
        assert c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 7
        c.execute(_INSERT_PIECE)
        c.execute(
            "INSERT INTO rehearsal_rooms (id, title, state, join_token_hash, join_expires_at, "
            "created_at, updated_at) VALUES ('r1', 'Sunday', 'open', 'h1', 9, 1, 1)"
        )
        c.execute(
            "INSERT INTO room_participants (id, room_id, display_name, instrument, "
            "credential_hash, joined_at) VALUES ('g1', 'r1', 'Maya', 'Vocals', 'c1', 1)"
        )
        c.execute(
            "INSERT INTO room_proposals (id, room_id, participant_id, title, created_at, "
            "updated_at) VALUES ('p1', 'r1', 'g1', 'Cissy Strut', 1, 1)"
        )
        with pytest.raises(sqlite3.IntegrityError):
            c.execute(
                "INSERT INTO rehearsal_rooms (id, title, state, join_token_hash, "
                "join_expires_at, created_at, updated_at) "
                "VALUES ('r2', 'Monday', 'open', 'h2', 9, 2, 2)"
            )
        c.commit()

        db.run_migrations(c, MIGRATIONS)

        names = {r[1] for r in c.execute("PRAGMA index_list(rehearsal_rooms)").fetchall()}
        assert "one_open_rehearsal_room" not in names
        assert [tuple(r) for r in c.execute("SELECT title, state FROM rehearsal_rooms")] == [
            ("Sunday", "open")
        ]
        assert c.execute("SELECT title FROM room_proposals").fetchone()[0] == "Cissy Strut"
        c.execute(
            "INSERT INTO rehearsal_rooms (id, title, state, join_token_hash, join_expires_at, "
            "created_at, updated_at) VALUES ('r2', 'Monday', 'open', 'h2', 9, 2, 2)"
        )
        assert c.execute(
            "SELECT COUNT(*) FROM rehearsal_rooms WHERE state = 'open'"
        ).fetchone()[0] == 2
        assert c.execute(
            "SELECT COUNT(*) FROM schema_version WHERE version = 8"
        ).fetchone()[0] == 1
        assert c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == LATEST
    finally:
        c.close()
