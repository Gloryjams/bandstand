"""What happens to an EXISTING library when the program version changes.

There are no down-migrations, so three things have to hold: a copy is taken before
an upgrade touches anything, an older program refuses data written by a newer one,
and a failed upgrade is explained in one sentence and leaves the data as it was.
"""
import shutil
import sqlite3
from pathlib import Path

import pytest

from server import backup, config, db, serve

MIGRATIONS = Path(__file__).parent.parent / "migrations"
VERSIONS = db.migration_versions(MIGRATIONS)
LATEST = VERSIONS[-1]

_INSERT_PIECE = (
    "INSERT INTO pieces (id, title, page_count, added_at, updated_at) "
    "VALUES ('p1', 'Take Five', 3, 1, 1)"
)


def _cfg(tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path / "data"))
    return config.load()


def _library_at(cfg, version: int) -> None:
    """A populated library as an older release left it."""
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    conn = db.connect(cfg.db_path)
    try:
        for f in sorted(MIGRATIONS.glob("*.sql")):
            if int(f.stem.split("_", 1)[0]) <= version:
                conn.executescript(f.read_text(encoding="utf-8"))
        conn.execute(_INSERT_PIECE)
    finally:
        conn.close()


def _version(path) -> int:
    conn = sqlite3.connect(path)
    try:
        return conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
    finally:
        conn.close()


def _titles(path) -> list[str]:
    conn = sqlite3.connect(path)
    try:
        return [r[0] for r in conn.execute("SELECT title FROM pieces")]
    finally:
        conn.close()


def _copies(cfg) -> list[Path]:
    found = sorted((cfg.data_dir / "backups").glob("library.db.before-upgrade-*"))
    assert not [p for p in found if p.name.endswith(".part")], "a half-made copy was left"
    return found


def test_an_upgrade_copies_the_database_before_it_changes_it(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    _library_at(cfg, LATEST - 1)

    report = db.bootstrap_schema(cfg)

    assert (report.before, report.after) == (LATEST - 1, LATEST)
    assert report.upgraded
    assert _copies(cfg) == [report.copy]
    # The copy is the OLD schema with the data in it: that is what makes it a way back.
    assert _version(report.copy) == LATEST - 1
    assert _titles(report.copy) == ["Take Five"]
    assert _version(cfg.db_path) == LATEST
    assert _titles(cfg.db_path) == ["Take Five"]
    assert f"v{LATEST - 1}-to-v{LATEST}" in report.copy.name


def test_the_log_says_that_an_upgrade_happened_and_where_the_copy_is(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    _library_at(cfg, LATEST - 1)
    lines: list[str] = []
    serve.prepare(cfg, lines.append)
    printed = "\n".join(lines)
    assert f"Database upgraded from version {LATEST - 1} to {LATEST}" in printed
    assert str(_copies(cfg)[0]) in printed
    assert cfg.key_path.read_text().strip() not in printed


def test_no_copy_on_a_first_start_or_when_already_current(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    first = db.bootstrap_schema(cfg)
    assert (first.before, first.after, first.copy) == (0, LATEST, None)
    again = db.bootstrap_schema(cfg)
    assert (again.before, again.after, again.copy) == (LATEST, LATEST, None)
    assert not first.upgraded and not again.upgraded
    assert _copies(cfg) == []


def test_the_daily_prune_never_deletes_a_pre_upgrade_copy(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    _library_at(cfg, LATEST - 1)
    report = db.bootstrap_schema(cfg)
    backups_dir = cfg.data_dir / "backups"
    for i in range(20):
        (backups_dir / f"library.db.bak-202606{i:02d}-000000").write_text("x")
    backup.prune(backups_dir)
    assert len(list(backups_dir.glob("library.db.bak-*"))) == 14
    assert report.copy.exists()


def test_data_from_a_newer_release_is_refused_and_left_alone(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    _library_at(cfg, LATEST)
    conn = db.connect(cfg.db_path)
    conn.execute("INSERT INTO schema_version(version, applied_at) VALUES (?, 1)", (LATEST + 1,))
    conn.execute("CREATE TABLE from_the_future (id TEXT)")
    conn.close()

    with pytest.raises(db.DatabaseTooNew) as err:
        db.bootstrap_schema(cfg)

    assert f"database version {LATEST + 1}" in str(err.value)
    assert _version(cfg.db_path) == LATEST + 1
    assert _titles(cfg.db_path) == ["Take Five"]
    assert _copies(cfg) == []


def test_run_migrations_alone_also_refuses_newer_data(tmp_path, monkeypatch):
    # The members CLI and older call sites reach run_migrations directly.
    cfg = _cfg(tmp_path, monkeypatch)
    _library_at(cfg, LATEST)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "INSERT INTO schema_version(version, applied_at) VALUES (?, 1)", (LATEST + 3,)
        )
        with pytest.raises(db.DatabaseTooNew):
            db.run_migrations(conn, MIGRATIONS)
    finally:
        conn.close()


def _migrations_with_a_broken_one(tmp_path) -> Path:
    folder = tmp_path / "migrations"
    shutil.copytree(MIGRATIONS, folder)
    (folder / f"{LATEST + 1:04d}_broken.sql").write_text(
        "BEGIN;\n"
        "CREATE TABLE half_applied (id TEXT);\n"
        "CREATE TABLE pieces (id TEXT);\n"  # already exists: fails mid-transaction
        f"INSERT INTO schema_version(version, applied_at) VALUES({LATEST + 1}, 1);\n"
        "COMMIT;\n"
    )
    return folder


def test_a_failed_upgrade_is_one_sentence_and_changes_nothing(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    _library_at(cfg, LATEST)
    broken = _migrations_with_a_broken_one(tmp_path)

    with pytest.raises(db.MigrationFailed) as err:
        db.bootstrap_schema(cfg, broken)

    message = str(err.value)
    assert f"{LATEST + 1:04d}_broken.sql" in message
    assert "already exists" in message
    assert "Nothing was changed" in message
    assert "Traceback" not in message
    assert _version(cfg.db_path) == LATEST
    assert _titles(cfg.db_path) == ["Take Five"]
    conn = sqlite3.connect(cfg.db_path)
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        conn.close()
    assert "half_applied" not in tables
    # The copy was taken before the attempt, so the way back exists even here.
    assert len(_copies(cfg)) == 1


def test_a_failing_upgrade_that_is_retried_does_not_pile_up_copies(tmp_path, monkeypatch):
    # Seen in a container: a supervisor restarted the server every second, and each
    # attempt left another copy that nothing ever deletes.
    cfg = _cfg(tmp_path, monkeypatch)
    _library_at(cfg, LATEST)
    broken = _migrations_with_a_broken_one(tmp_path)
    for _ in range(5):
        with pytest.raises(db.MigrationFailed):
            db.bootstrap_schema(cfg, broken)
    assert len(_copies(cfg)) == 1
    assert _titles(_copies(cfg)[0]) == ["Take Five"]


def test_a_changed_database_gets_a_fresh_copy(tmp_path, monkeypatch):
    import time
    cfg = _cfg(tmp_path, monkeypatch)
    _library_at(cfg, LATEST)
    broken = _migrations_with_a_broken_one(tmp_path)
    with pytest.raises(db.MigrationFailed):
        db.bootstrap_schema(cfg, broken)
    # The library is used again (on the old program), then the upgrade is retried.
    conn = db.connect(cfg.db_path)
    conn.execute(_INSERT_PIECE.replace("'p1'", "'p2'").replace("Take Five", "So What"))
    conn.close()
    monkeypatch.setattr(time, "strftime", lambda _fmt: "20990101-000000")
    with pytest.raises(db.MigrationFailed):
        db.bootstrap_schema(cfg, broken)
    assert len(_copies(cfg)) == 2
    assert sorted(_titles(_copies(cfg)[-1])) == ["So What", "Take Five"]


def test_the_newer_data_message_points_the_right_way(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    _library_at(cfg, LATEST)
    conn = db.connect(cfg.db_path)
    conn.execute("INSERT INTO schema_version(version, applied_at) VALUES (?, 1)", (LATEST + 1,))
    conn.close()
    with pytest.raises(db.DatabaseTooNew) as err:
        db.bootstrap_schema(cfg)
    message = str(err.value)
    assert "start the newer Bandstand again" in message
    assert "Going back after a bad update" in message
    assert "version that was running before" not in message


@pytest.mark.parametrize("problem", ["too_new", "broken"])
def test_the_entry_point_explains_a_schema_problem_without_a_traceback(
    problem, tmp_path, monkeypatch, capsys
):
    cfg = _cfg(tmp_path, monkeypatch)
    _library_at(cfg, LATEST)
    if problem == "too_new":
        conn = db.connect(cfg.db_path)
        conn.execute(
            "INSERT INTO schema_version(version, applied_at) VALUES (?, 1)", (LATEST + 1,)
        )
        conn.close()
    else:
        monkeypatch.setattr(db, "MIGRATIONS_DIR", _migrations_with_a_broken_one(tmp_path))
    started = []
    monkeypatch.setattr("uvicorn.run", lambda *a, **k: started.append(1))

    assert serve.main() == 1

    err = capsys.readouterr().err
    assert err.startswith("Cannot start: ")
    assert "Traceback" not in err
    assert cfg.key_path.exists() is False or cfg.key_path.read_text().strip() not in err
    assert started == []
