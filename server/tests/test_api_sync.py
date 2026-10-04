import json

from fastapi.testclient import TestClient

from server import config, db


def _setup(tmp_data_dir):
    from server.main import build_app
    cfg = config.load()
    db.bootstrap(cfg)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "INSERT INTO pieces (id, title, page_count, added_at, updated_at) "
            "VALUES (?, ?, 0, 0, 0)",
            ("P1", "Take Five"),
        )
    finally:
        conn.close()
    app = build_app()
    key = cfg.key_path.read_text().strip()
    return TestClient(app), key, cfg


def test_sync_three_ops_apply_in_order(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    body = {
        "ops": [
            {
                "op": "upsert",
                "entity": "annotations",
                "payload": {
                    "piece_id": "P1",
                    "file_id": "F1",
                    "page_index": 0,
                    "svg_paths": [{"d": "M0 0", "stroke": "red"}],
                    "updated_at": 100,
                },
            },
            {
                "op": "upsert",
                "entity": "bookmarks",
                "payload": {
                    "id": "BM1",
                    "piece_id": "P1",
                    "file_id": "F1",
                    "page_index": 2,
                    "label": "Solo",
                    "ordinal": 0,
                },
            },
            {
                "op": "upsert",
                "entity": "pieces",
                "payload": {"id": "P1", "tempo": 176},
            },
        ]
    }
    r = client.post("/api/sync", headers={"X-Bandstand-Key": key}, json=body)
    assert r.status_code == 200
    out = r.json()
    assert out["ok"] is True
    assert out["applied"] == 3
    assert out["errors"] == []

    conn = db.connect(cfg.db_path)
    try:
        ann = conn.execute("SELECT * FROM annotations").fetchone()
        assert ann is not None
        assert json.loads(ann["svg_paths"])[0]["stroke"] == "red"
        bm = conn.execute("SELECT * FROM bookmarks WHERE id = ?", ("BM1",)).fetchone()
        assert bm["label"] == "Solo"
        piece = conn.execute("SELECT * FROM pieces WHERE id = ?", ("P1",)).fetchone()
        assert piece["tempo"] == 176
    finally:
        conn.close()


def test_sync_partial_failure_returns_errors(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    body = {
        "ops": [
            {
                "op": "upsert",
                "entity": "annotations",
                "payload": {
                    "piece_id": "P1", "file_id": "F1", "page_index": 0,
                    "svg_paths": [], "updated_at": 1,
                },
            },
            {
                "op": "upsert",
                "entity": "unknown_entity",
                "payload": {},
            },
            {
                "op": "upsert",
                "entity": "pieces",
                "payload": {"id": "P1", "tempo": 200},
            },
        ]
    }
    r = client.post("/api/sync", headers={"X-Bandstand-Key": key}, json=body)
    assert r.status_code == 200
    out = r.json()
    assert out["applied"] == 2
    assert len(out["errors"]) == 1
    assert out["errors"][0]["index"] == 1


def test_sync_setlist_items_op_is_atomic(tmp_data_dir):
    # A multi-statement op (DELETE + re-INSERT) must roll back fully if any insert
    # fails — never leave the setlist half-rebuilt.
    client, key, cfg = _setup(tmp_data_dir)
    seed = {"ops": [
        {"op": "upsert", "entity": "setlists", "payload": {"id": "SL1", "name": "Gig"}},
        {"op": "upsert", "entity": "setlist_items", "payload": {"setlist_id": "SL1", "items": [
            {"kind": "piece", "piece_id": "P1"},
            {"kind": "piece", "piece_id": "P1"},
        ]}},
    ]}
    client.post("/api/sync", headers={"X-Bandstand-Key": key}, json=seed)
    # Replace with a list whose 2nd item violates the piece FK partway through.
    bad = {"ops": [
        {"op": "upsert", "entity": "setlist_items", "payload": {"setlist_id": "SL1", "items": [
            {"kind": "piece", "piece_id": "P1"},
            {"kind": "piece", "piece_id": "GHOST"},
        ]}},
    ]}
    r = client.post("/api/sync", headers={"X-Bandstand-Key": key}, json=bad)
    assert r.json()["applied"] == 0
    assert len(r.json()["errors"]) == 1
    conn = db.connect(cfg.db_path)
    try:
        rows = conn.execute("SELECT * FROM setlist_items WHERE setlist_id = ?", ("SL1",)).fetchall()
        assert len(rows) == 2  # original survives; a non-atomic op would leave 1
    finally:
        conn.close()


def test_sync_requires_auth(tmp_data_dir):
    client, _, _ = _setup(tmp_data_dir)
    r = client.post("/api/sync", json={"ops": []})
    assert r.status_code == 401


def _ann_op(updated_at, stroke, page_index=0):
    payload = {
        "piece_id": "P1", "file_id": "F1", "page_index": page_index,
        "svg_paths": [{"d": "M0 0", "stroke": stroke}],
    }
    if updated_at is not None:
        payload["updated_at"] = updated_at
    return {"op": "upsert", "entity": "annotations", "payload": payload}


def _current_stroke(cfg, page_index=0):
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT svg_paths FROM annotations WHERE page_index = ?", (page_index,)
        ).fetchone()
        return json.loads(row["svg_paths"])[0]["stroke"] if row else None
    finally:
        conn.close()


def _apply(conn, op):
    from server.api.sync import _apply_one
    conn.execute("BEGIN")
    _apply_one(conn, op)
    conn.execute("COMMIT")


def test_stale_annotation_older_payload_is_dropped(conn):
    _apply(conn, _ann_op(200, "red"))
    _apply(conn, _ann_op(100, "blue"))  # older — must not clobber
    row = conn.execute("SELECT svg_paths, updated_at FROM annotations").fetchone()
    assert json.loads(row["svg_paths"])[0]["stroke"] == "red"
    assert row["updated_at"] == 200


def test_newer_annotation_payload_wins(conn):
    _apply(conn, _ann_op(100, "red"))
    _apply(conn, _ann_op(200, "blue"))
    row = conn.execute("SELECT svg_paths, updated_at FROM annotations").fetchone()
    assert json.loads(row["svg_paths"])[0]["stroke"] == "blue"
    assert row["updated_at"] == 200


def test_annotation_without_updated_at_always_wins(conn):
    _apply(conn, _ann_op(999999999999, "red"))
    _apply(conn, _ann_op(None, "blue"))  # no updated_at — server stamps now, wins
    row = conn.execute("SELECT svg_paths FROM annotations").fetchone()
    assert json.loads(row["svg_paths"])[0]["stroke"] == "blue"


def test_new_annotation_with_old_updated_at_is_inserted(conn):
    _apply(conn, _ann_op(1, "red"))  # no existing row — inserts despite old ts
    row = conn.execute("SELECT svg_paths, updated_at FROM annotations").fetchone()
    assert json.loads(row["svg_paths"])[0]["stroke"] == "red"
    assert row["updated_at"] == 1


def test_stale_annotation_op_reports_as_applied(tmp_data_dir):
    # A dropped stale op must count as success from the client's perspective — a
    # rejected op would stay queued forever and wedge the device's manifest mirror.
    client, key, cfg = _setup(tmp_data_dir)
    client.post("/api/sync", headers={"X-Bandstand-Key": key},
                json={"ops": [_ann_op(200, "red")]})
    r = client.post("/api/sync", headers={"X-Bandstand-Key": key},
                    json={"ops": [_ann_op(100, "blue")]})
    assert r.status_code == 200
    out = r.json()
    assert out["applied"] == 1
    assert out["errors"] == []
    assert _current_stroke(cfg) == "red"  # server ink untouched


def test_sync_setlist_items_replace(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    # Create a setlist via sync
    body = {
        "ops": [
            {"op": "upsert", "entity": "setlists",
             "payload": {"id": "SL1", "name": "Gig"}},
            {"op": "upsert", "entity": "setlist_items",
             "payload": {"setlist_id": "SL1", "items": [
                 {"kind": "piece", "piece_id": "P1"},
             ]}},
        ]
    }
    r = client.post("/api/sync", headers={"X-Bandstand-Key": key}, json=body)
    assert r.status_code == 200
    assert r.json()["applied"] == 2
    conn = db.connect(cfg.db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM setlist_items WHERE setlist_id = ?", ("SL1",)
        ).fetchall()
        assert len(rows) == 1
    finally:
        conn.close()
