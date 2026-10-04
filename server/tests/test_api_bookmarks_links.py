from fastapi.testclient import TestClient

from server import config, db


def _setup(tmp_data_dir):
    from server.main import build_app
    cfg = config.load()
    db.bootstrap(cfg)
    # Create a real piece P1 to satisfy FK constraints.
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "INSERT INTO pieces (id, title, page_count, added_at, updated_at) "
            "VALUES (?, ?, 0, 0, 0)",
            ("P1", "Test Piece"),
        )
    finally:
        conn.close()
    app = build_app()
    key = cfg.key_path.read_text().strip()
    return TestClient(app), key, cfg


def test_bookmark_upsert_and_delete(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    payload = {
        "piece_id": "P1",
        "file_id": "F1",
        "page_index": 2,
        "label": "Chorus",
        "ordinal": 0,
    }
    r = client.put(
        "/api/bookmarks/BM1",
        headers={"X-Bandstand-Key": key},
        json=payload,
    )
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT * FROM bookmarks WHERE id = ?", ("BM1",)).fetchone()
        assert row["label"] == "Chorus"
        assert row["page_index"] == 2
    finally:
        conn.close()

    # Update label.
    r = client.put(
        "/api/bookmarks/BM1",
        headers={"X-Bandstand-Key": key},
        json={"label": "Bridge"},
    )
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT * FROM bookmarks WHERE id = ?", ("BM1",)).fetchone()
        assert row["label"] == "Bridge"
    finally:
        conn.close()

    # Delete.
    r = client.delete("/api/bookmarks/BM1", headers={"X-Bandstand-Key": key})
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT * FROM bookmarks WHERE id = ?", ("BM1",)).fetchone()
        assert row is None
    finally:
        conn.close()


def test_section_link_upsert_and_delete(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    # Need a bookmark first for FK.
    client.put(
        "/api/bookmarks/BM1",
        headers={"X-Bandstand-Key": key},
        json={
            "piece_id": "P1", "file_id": "F1", "page_index": 2,
            "label": "Chorus", "ordinal": 0,
        },
    )
    payload = {
        "piece_id": "P1",
        "from_file_id": "F1",
        "from_page_index": 5,
        "to_bookmark_id": "BM1",
        "initial_triggers": 2,
        "active": 1,
    }
    r = client.put(
        "/api/section-links/SL1",
        headers={"X-Bandstand-Key": key},
        json=payload,
    )
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT * FROM section_links WHERE id = ?", ("SL1",)).fetchone()
        assert row["from_page_index"] == 5
        assert row["to_bookmark_id"] == "BM1"
        assert row["initial_triggers"] == 2
    finally:
        conn.close()

    # Update active.
    r = client.put(
        "/api/section-links/SL1",
        headers={"X-Bandstand-Key": key},
        json={"active": 0},
    )
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT * FROM section_links WHERE id = ?", ("SL1",)).fetchone()
        assert row["active"] == 0
    finally:
        conn.close()

    # Delete.
    r = client.delete("/api/section-links/SL1", headers={"X-Bandstand-Key": key})
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT * FROM section_links WHERE id = ?", ("SL1",)).fetchone()
        assert row is None
    finally:
        conn.close()


def test_bookmarks_links_require_auth(tmp_data_dir):
    client, _, _ = _setup(tmp_data_dir)
    assert client.put("/api/bookmarks/BM1", json={}).status_code == 401
    assert client.put("/api/section-links/SL1", json={}).status_code == 401
