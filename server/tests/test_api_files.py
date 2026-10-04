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


def _piece_and_file(cfg):
    conn = db.connect(cfg.db_path)
    try:
        p = conn.execute("SELECT id FROM pieces").fetchone()["id"]
        f = conn.execute("SELECT id FROM files").fetchone()["id"]
        return p, f
    finally:
        conn.close()


def test_get_file_full_returns_200(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    piece_id, file_id = _piece_and_file(cfg)
    r = client.get(
        f"/api/file/{piece_id}/{file_id}",
        headers={"X-Bandstand-Key": key},
    )
    assert r.status_code == 200
    assert r.headers.get("accept-ranges") == "bytes"
    assert r.content[:4] == b"%PDF"


def test_get_file_range_returns_206(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    piece_id, file_id = _piece_and_file(cfg)
    r = client.get(
        f"/api/file/{piece_id}/{file_id}",
        headers={"X-Bandstand-Key": key, "Range": "bytes=0-3"},
    )
    assert r.status_code == 206
    assert r.content == b"%PDF"
    assert "content-range" in r.headers
    assert r.headers["content-length"] == "4"


def test_get_file_unknown_id_returns_404(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    r = client.get(
        "/api/file/nope/nope",
        headers={"X-Bandstand-Key": key},
    )
    assert r.status_code == 404


def test_get_thumb_returns_png(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    piece_id, _ = _piece_and_file(cfg)
    r = client.get(
        f"/api/thumb/{piece_id}",
        headers={"X-Bandstand-Key": key},
    )
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"


def test_get_file_requires_auth(tmp_data_dir):
    client, _, cfg = _setup(tmp_data_dir)
    piece_id, file_id = _piece_and_file(cfg)
    r = client.get(f"/api/file/{piece_id}/{file_id}")
    assert r.status_code == 401
