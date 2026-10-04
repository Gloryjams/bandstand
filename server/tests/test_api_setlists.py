from fastapi.testclient import TestClient

from server import config, db


def _setup(tmp_data_dir):
    from server.main import build_app
    cfg = config.load()
    db.bootstrap(cfg)
    # Create pieces P1, P2 for setlist items.
    conn = db.connect(cfg.db_path)
    try:
        for pid in ("P1", "P2"):
            conn.execute(
                "INSERT INTO pieces (id, title, page_count, added_at, updated_at) "
                "VALUES (?, ?, 0, 0, 0)",
                (pid, f"Piece {pid}"),
            )
    finally:
        conn.close()
    app = build_app()
    key = cfg.key_path.read_text().strip()
    return TestClient(app), key, cfg


def test_create_setlist_with_items_and_break_and_reprise(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    r = client.put(
        "/api/setlists/SL1",
        headers={"X-Bandstand-Key": key},
        json={"name": "Friday Gig", "venue": "The Blue Room"},
    )
    assert r.status_code == 200

    items = [
        {"kind": "piece", "piece_id": "P1"},
        {"kind": "piece", "piece_id": "P2"},
        {"kind": "break", "break_label": "Set Break"},
        {"kind": "piece", "piece_id": "P1"},  # reprise
    ]
    r = client.put(
        "/api/setlists/SL1/items",
        headers={"X-Bandstand-Key": key},
        json=items,
    )
    assert r.status_code == 200

    conn = db.connect(cfg.db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM setlist_items WHERE setlist_id = ? ORDER BY ordinal",
            ("SL1",),
        ).fetchall()
        assert len(rows) == 4
        assert rows[0]["kind"] == "piece" and rows[0]["piece_id"] == "P1"
        assert rows[1]["piece_id"] == "P2"
        assert rows[2]["kind"] == "break" and rows[2]["break_label"] == "Set Break"
        assert rows[3]["piece_id"] == "P1"  # reprise
    finally:
        conn.close()


def test_replace_items_idempotent(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    client.put(
        "/api/setlists/SL1",
        headers={"X-Bandstand-Key": key},
        json={"name": "x"},
    )
    items_v1 = [{"kind": "piece", "piece_id": "P1"}, {"kind": "piece", "piece_id": "P2"}]
    items_v2 = [{"kind": "piece", "piece_id": "P2"}]
    client.put(
        "/api/setlists/SL1/items",
        headers={"X-Bandstand-Key": key},
        json=items_v1,
    )
    client.put(
        "/api/setlists/SL1/items",
        headers={"X-Bandstand-Key": key},
        json=items_v2,
    )
    conn = db.connect(cfg.db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM setlist_items WHERE setlist_id = ?", ("SL1",)
        ).fetchall()
        assert len(rows) == 1
        assert rows[0]["piece_id"] == "P2"
    finally:
        conn.close()


def test_delete_cascades_to_items(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    client.put(
        "/api/setlists/SL1",
        headers={"X-Bandstand-Key": key},
        json={"name": "x"},
    )
    client.put(
        "/api/setlists/SL1/items",
        headers={"X-Bandstand-Key": key},
        json=[{"kind": "piece", "piece_id": "P1"}],
    )
    r = client.delete("/api/setlists/SL1", headers={"X-Bandstand-Key": key})
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM setlist_items WHERE setlist_id = ?", ("SL1",)
        ).fetchall()
        assert rows == []
        sl = conn.execute("SELECT * FROM setlists WHERE id = ?", ("SL1",)).fetchone()
        assert sl is None
    finally:
        conn.close()


def test_setlists_require_auth(tmp_data_dir):
    client, _, _ = _setup(tmp_data_dir)
    assert client.put("/api/setlists/X", json={}).status_code == 401
    assert client.put("/api/setlists/X/items", json=[]).status_code == 401
