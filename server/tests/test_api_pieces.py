import json
import shutil
from pathlib import Path

from fastapi.testclient import TestClient

from server import config, db
from server.ingest import pipeline

FIXTURES = Path(__file__).parent / "fixtures"


def _setup(tmp_data_dir):
    from server.main import build_app
    cfg = config.load()
    db.bootstrap(cfg)
    target = cfg.library_dir / "Take Five.pdf"
    shutil.copy(FIXTURES / "three_page_titled.pdf", target)
    pipeline.ingest_path(cfg, target)
    app = build_app()
    key = cfg.key_path.read_text().strip()
    return TestClient(app), key, cfg


def _piece_id(cfg):
    conn = db.connect(cfg.db_path)
    try:
        return conn.execute("SELECT id FROM pieces").fetchone()["id"]
    finally:
        conn.close()


def test_upsert_updates_fields(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    pid = _piece_id(cfg)
    patch = {
        "title": "Take Five (Brubeck)",
        "music_key": "Ebm",
        "tempo": 176,
        "tags": ["jazz", "standard"],
        "preferred_orientation": "landscape",
    }
    r = client.put(
        f"/api/pieces/{pid}",
        headers={"X-Bandstand-Key": key},
        json=patch,
    )
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT * FROM pieces WHERE id = ?", (pid,)).fetchone()
        assert row["title"] == "Take Five (Brubeck)"
        assert row["music_key"] == "Ebm"
        assert row["tempo"] == 176
        assert json.loads(row["tags"]) == ["jazz", "standard"]
        assert row["preferred_orientation"] == "landscape"
    finally:
        conn.close()


def test_upsert_unknown_piece_returns_404(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    r = client.put(
        "/api/pieces/UNKNOWN",
        headers={"X-Bandstand-Key": key},
        json={"title": "x"},
    )
    assert r.status_code == 404


def test_upsert_ignores_unknown_fields(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    pid = _piece_id(cfg)
    r = client.put(
        f"/api/pieces/{pid}",
        headers={"X-Bandstand-Key": key},
        json={"bogus_field": "ignored"},
    )
    assert r.status_code == 200


def test_delete_soft_deletes(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    pid = _piece_id(cfg)
    r = client.delete(
        f"/api/pieces/{pid}",
        headers={"X-Bandstand-Key": key},
    )
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT deleted_at FROM pieces WHERE id = ?", (pid,)).fetchone()
        assert row["deleted_at"] is not None
    finally:
        conn.close()


def test_upsert_requires_auth(tmp_data_dir):
    client, _, cfg = _setup(tmp_data_dir)
    pid = _piece_id(cfg)
    r = client.put(f"/api/pieces/{pid}", json={"title": "x"})
    assert r.status_code == 401
