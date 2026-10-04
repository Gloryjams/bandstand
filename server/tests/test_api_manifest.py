import shutil
import time
from pathlib import Path

from fastapi.testclient import TestClient

from server import config, db
from server.ingest import pipeline

FIXTURES = Path(__file__).parent / "fixtures"


def _client_and_key(tmp_data_dir):
    from server.main import build_app
    cfg = config.load()
    db.bootstrap(cfg)
    app = build_app()
    key = cfg.key_path.read_text().strip()
    return TestClient(app), key, cfg


def test_manifest_requires_auth(tmp_data_dir):
    client, _, _ = _client_and_key(tmp_data_dir)
    r = client.get("/api/manifest")
    assert r.status_code == 401


def test_manifest_empty_library(tmp_data_dir):
    client, key, _ = _client_and_key(tmp_data_dir)
    r = client.get("/api/manifest", headers={"X-Bandstand-Key": key})
    assert r.status_code == 200
    body = r.json()
    for k in ("pieces", "files", "audio_tracks", "bookmarks", "annotations",
              "section_links", "setlists", "setlist_items"):
        assert body[k] == []
    assert isinstance(body["server_time_ms"], int)


def test_manifest_includes_annotations(tmp_data_dir):
    client, key, cfg = _client_and_key(tmp_data_dir)
    target = cfg.library_dir / "Take Five.pdf"
    shutil.copy(FIXTURES / "three_page_titled.pdf", target)
    pipeline.ingest_path(cfg, target)
    body = client.get("/api/manifest", headers={"X-Bandstand-Key": key}).json()
    piece_id = body["pieces"][0]["id"]
    file_id = body["files"][0]["id"]
    strokes = [{"id": "s1", "tool": "pen", "color": "#fff", "width": 0.004,
                "points": [[0, 0.5], [1, 0.5]]}]
    r = client.put(
        f"/api/annotations/{piece_id}/{file_id}/0",
        headers={"X-Bandstand-Key": key},
        json={"svg_paths": strokes, "updated_at": 123},
    )
    assert r.status_code == 200
    body = client.get("/api/manifest", headers={"X-Bandstand-Key": key}).json()
    assert len(body["annotations"]) == 1
    ann = body["annotations"][0]
    assert ann["piece_id"] == piece_id and ann["file_id"] == file_id and ann["page_index"] == 0
    # svg_paths comes back as a JSON string holding the stroke array.
    import json as _json
    assert _json.loads(ann["svg_paths"]) == strokes


def test_manifest_includes_imported_piece(tmp_data_dir):
    client, key, cfg = _client_and_key(tmp_data_dir)
    target = cfg.library_dir / "Take Five.pdf"
    shutil.copy(FIXTURES / "three_page_titled.pdf", target)
    pipeline.ingest_path(cfg, target)
    r = client.get("/api/manifest", headers={"X-Bandstand-Key": key})
    body = r.json()
    assert len(body["pieces"]) == 1
    assert body["pieces"][0]["title"] == "Take Five"
    assert len(body["files"]) == 1


def test_manifest_excludes_soft_deleted(tmp_data_dir):
    client, key, cfg = _client_and_key(tmp_data_dir)
    target = cfg.library_dir / "Take Five.pdf"
    shutil.copy(FIXTURES / "three_page_titled.pdf", target)
    pipeline.ingest_path(cfg, target)
    conn = db.connect(cfg.db_path)
    try:
        now = int(time.time() * 1000)
        conn.execute("UPDATE pieces SET deleted_at = ?", (now,))
    finally:
        conn.close()
    r = client.get("/api/manifest", headers={"X-Bandstand-Key": key})
    body = r.json()
    assert body["pieces"] == []
