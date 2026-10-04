import json
import shutil
import time
from pathlib import Path

from server import config, db
from server.ingest import watcher

FIXTURES = Path(__file__).parent / "fixtures"

_CHART = {
    "id": "watch-del-1", "title": "Watcher Tune", "artist": "X",
    "key": "F", "time": "4/4", "bpm": "", "style": "", "capo": "",
    "sections": [{"id": "a", "label": "A", "bars": [{"chords": "F"}]}],
    "settings": {"barsPerRow": 4, "fontSize": "medium", "showLyrics": False, "onePage": False},
    "tags": [], "createdAt": 1, "updatedAt": 1,
}


def _wait_for(predicate, timeout=5.0, interval=0.1):
    start = time.time()
    while time.time() - start < timeout:
        if predicate():
            return True
        time.sleep(interval)
    return False


def test_watcher_ingests_new_file(tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    cfg = config.load()
    db.bootstrap(cfg)
    w = watcher.Watcher(cfg, debounce_seconds=0.3)
    w.start()
    try:
        shutil.copy(FIXTURES / "three_page_titled.pdf",
                    cfg.library_dir / "Take Five.pdf")

        def has_piece():
            conn = db.connect(cfg.db_path)
            try:
                return conn.execute(
                    "SELECT COUNT(*) FROM pieces"
                ).fetchone()[0] >= 1
            finally:
                conn.close()

        assert _wait_for(has_piece)
    finally:
        w.stop()


def test_watcher_soft_deletes_on_remove(tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    cfg = config.load()
    db.bootstrap(cfg)
    target = cfg.library_dir / "Take Five.pdf"
    shutil.copy(FIXTURES / "three_page_titled.pdf", target)
    from server.ingest import pipeline
    pipeline.ingest_path(cfg, target)
    w = watcher.Watcher(cfg, debounce_seconds=0.3)
    w.start()
    try:
        target.unlink()

        def has_soft_deleted():
            conn = db.connect(cfg.db_path)
            try:
                return conn.execute(
                    "SELECT COUNT(*) FROM files WHERE deleted_at IS NOT NULL"
                ).fetchone()[0] >= 1
            finally:
                conn.close()

        assert _wait_for(has_soft_deleted)
    finally:
        w.stop()


def test_watcher_soft_deletes_chart_on_file_remove(tmp_path, monkeypatch):
    # A native chart has no files row — deleting its .saltychart.json must still
    # soft-delete the piece (matched by the stored chart_file), or an orphan lingers.
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    cfg = config.load()
    db.bootstrap(cfg)
    target = cfg.library_dir / "watch-del-1.saltychart.json"
    target.write_text(json.dumps(_CHART), encoding="utf-8")
    from server.ingest import pipeline
    pipeline.ingest_path(cfg, target)
    w = watcher.Watcher(cfg, debounce_seconds=0.3)
    w.start()
    try:
        target.unlink()

        def chart_soft_deleted():
            conn = db.connect(cfg.db_path)
            try:
                return conn.execute(
                    "SELECT COUNT(*) FROM pieces "
                    "WHERE kind = 'chart' AND deleted_at IS NOT NULL"
                ).fetchone()[0] >= 1
            finally:
                conn.close()

        assert _wait_for(chart_soft_deleted)
    finally:
        w.stop()


def test_watcher_soft_deletes_orphaned_piece(tmp_path, monkeypatch):
    # Removing a piece's only chart must soft-delete the piece too, else an empty
    # card lingers in the library forever.
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    cfg = config.load()
    db.bootstrap(cfg)
    target = cfg.library_dir / "Take Five.pdf"
    shutil.copy(FIXTURES / "three_page_titled.pdf", target)
    from server.ingest import pipeline
    pipeline.ingest_path(cfg, target)
    w = watcher.Watcher(cfg, debounce_seconds=0.3)
    w.start()
    try:
        target.unlink()

        def piece_soft_deleted():
            conn = db.connect(cfg.db_path)
            try:
                return conn.execute(
                    "SELECT COUNT(*) FROM pieces WHERE deleted_at IS NOT NULL"
                ).fetchone()[0] >= 1
            finally:
                conn.close()

        assert _wait_for(piece_soft_deleted)
    finally:
        w.stop()
