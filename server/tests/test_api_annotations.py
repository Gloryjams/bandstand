import json

from fastapi.testclient import TestClient

from server import config, db


def _setup(tmp_data_dir):
    from server.main import build_app
    cfg = config.load()
    db.bootstrap(cfg)
    app = build_app()
    key = cfg.key_path.read_text().strip()
    return TestClient(app), key, cfg


def test_create_annotation(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    payload = {
        "svg_paths": [
            {"d": "M10 10 L20 20", "stroke": "red", "width": 3}
        ],
        "updated_at": 1234567890000,
    }
    r = client.put(
        "/api/annotations/PIECE/FILE/0",
        headers={"X-Bandstand-Key": key},
        json=payload,
    )
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT * FROM annotations").fetchone()
        assert row is not None
        assert row["piece_id"] == "PIECE"
        assert row["file_id"] == "FILE"
        assert row["page_index"] == 0
        paths = json.loads(row["svg_paths"])
        assert paths[0]["stroke"] == "red"
    finally:
        conn.close()


def test_overwrite_annotation_updates_color(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    client.put(
        "/api/annotations/PIECE/FILE/0",
        headers={"X-Bandstand-Key": key},
        json={"svg_paths": [{"d": "M0 0", "stroke": "red"}], "updated_at": 1},
    )
    client.put(
        "/api/annotations/PIECE/FILE/0",
        headers={"X-Bandstand-Key": key},
        json={"svg_paths": [{"d": "M0 0", "stroke": "blue"}], "updated_at": 2},
    )
    conn = db.connect(cfg.db_path)
    try:
        rows = conn.execute("SELECT * FROM annotations").fetchall()
        assert len(rows) == 1
        paths = json.loads(rows[0]["svg_paths"])
        assert paths[0]["stroke"] == "blue"
        assert rows[0]["updated_at"] == 2
    finally:
        conn.close()


def test_delete_annotation(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    client.put(
        "/api/annotations/PIECE/FILE/0",
        headers={"X-Bandstand-Key": key},
        json={"svg_paths": [], "updated_at": 1},
    )
    r = client.delete(
        "/api/annotations/PIECE/FILE/0",
        headers={"X-Bandstand-Key": key},
    )
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        rows = conn.execute("SELECT * FROM annotations").fetchall()
        assert rows == []
    finally:
        conn.close()


def test_annotations_require_auth(tmp_data_dir):
    client, _, _ = _setup(tmp_data_dir)
    r = client.put("/api/annotations/A/B/0", json={"svg_paths": []})
    assert r.status_code == 401
