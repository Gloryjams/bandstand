import sqlite3
import time

from server import backup, config, db


def _seed_db(cfg):
    db.bootstrap(cfg)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "INSERT INTO pieces (id, title, page_count, added_at, updated_at) "
            "VALUES ('P1', 'Take Five', 0, 0, 0)"
        )
    finally:
        conn.close()


def test_snapshot_creates_valid_sqlite_with_data(tmp_data_dir):
    cfg = config.load()
    _seed_db(cfg)
    dest = backup.run_backup(cfg, force=True)
    assert dest is not None and dest.exists()
    conn = sqlite3.connect(dest)
    try:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        title = conn.execute("SELECT title FROM pieces WHERE id = 'P1'").fetchone()[0]
        assert title == "Take Five"
    finally:
        conn.close()


def test_prune_keeps_newest_14(tmp_data_dir):
    backups_dir = tmp_data_dir / "backups"
    backups_dir.mkdir()
    # 20 timestamped snapshots; names sort chronologically.
    for i in range(20):
        (backups_dir / f"library.db.bak-202606{i:02d}-000000").write_text("x")
    backup.prune(backups_dir)
    remaining = sorted(p.name for p in backups_dir.glob("library.db.bak-*"))
    assert len(remaining) == 14
    assert remaining[0] == "library.db.bak-20260606-000000"  # oldest 6 dropped
    assert remaining[-1] == "library.db.bak-20260619-000000"


def test_startup_backup_skipped_when_recent(tmp_data_dir):
    cfg = config.load()
    _seed_db(cfg)
    first = backup.run_backup(cfg, force=True)
    assert first is not None
    # A backup <20h old already exists — a non-forced run must skip (no churn).
    assert backup.run_backup(cfg) is None


def test_backup_runs_when_newest_is_old(tmp_data_dir):
    cfg = config.load()
    _seed_db(cfg)
    dest = backup.run_backup(cfg, force=True)
    # Age the existing snapshot past the 20h threshold.
    old = time.time() - 21 * 60 * 60
    import os
    os.utime(dest, (old, old))
    assert backup.run_backup(cfg) is not None
