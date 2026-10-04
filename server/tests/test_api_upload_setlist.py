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


def chart(cid: str, title: str = "Tune", **over):
    """A minimal valid Saltycharts chart (envelope = title + sections + id)."""
    c = {"id": cid, "title": title, "artist": "Someone", "sections": []}
    c.update(over)
    return c


def _post_set(client, key, source_id, name, charts):
    return client.post(
        "/api/upload-setlist",
        headers={"X-Bandstand-Key": key},
        json={"setlist": {"id": source_id, "name": name, "charts": charts}},
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------

def test_upload_setlist_creates_pieces_and_ordered_setlist(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    charts = [chart("c1", "First"), chart("c2", "Second"), chart("c3", "Third")]
    r = _post_set(client, key, "set-1", "Friday Gig", charts)
    assert r.status_code == 200
    out = r.json()
    setlist_id = out["id"]
    piece_ids = out["pieceIds"]
    assert setlist_id
    assert len(piece_ids) == 3

    conn = db.connect(cfg.db_path)
    try:
        # Three chart pieces created.
        assert conn.execute(
            "SELECT COUNT(*) FROM pieces WHERE kind = 'chart' AND deleted_at IS NULL"
        ).fetchone()[0] == 3
        # Setlist row keyed on the Saltycharts id.
        srow = conn.execute(
            "SELECT * FROM setlists WHERE id = ?", (setlist_id,)
        ).fetchone()
        assert srow["source_id"] == "set-1"
        assert srow["name"] == "Friday Gig"
        # Items in payload order, all kind='piece', matching returned pieceIds.
        items = conn.execute(
            "SELECT piece_id, kind, ordinal FROM setlist_items "
            "WHERE setlist_id = ? ORDER BY ordinal",
            (setlist_id,),
        ).fetchall()
        assert [it["piece_id"] for it in items] == piece_ids
        assert [it["ordinal"] for it in items] == [0, 1, 2]
        assert all(it["kind"] == "piece" for it in items)
    finally:
        conn.close()

    # One .saltychart.json per chart on disk.
    assert len(list(cfg.library_dir.glob("*.saltychart.json"))) == 3


def test_upload_setlist_response_shape(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    r = _post_set(client, key, "set-x", "S", [chart("only", "Only")])
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == {"id", "pieceIds"}
    assert body["pieceIds"] and isinstance(body["pieceIds"], list)


# ---------------------------------------------------------------------------
# Re-send upsert (order changed, chart edited, item removed) — no duplicates
# ---------------------------------------------------------------------------

def test_resend_reorders_edits_and_removes_without_duplicates(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    r1 = _post_set(client, key, "set-1", "Set One",
                   [chart("c1", "First"), chart("c2", "Second"), chart("c3", "Third")])
    first_id = r1.json()["id"]
    first_pieces = r1.json()["pieceIds"]

    # Re-send: drop c2, reorder to [c3, c1], edit c1's title.
    r2 = _post_set(client, key, "set-1", "Set One (rev)",
                   [chart("c3", "Third"), chart("c1", "First EDITED")])
    assert r2.status_code == 200
    second_id = r2.json()["id"]
    # Same Bandstand setlist (upsert, not a new one).
    assert second_id == first_id

    conn = db.connect(cfg.db_path)
    try:
        # No duplicate setlists.
        assert conn.execute(
            "SELECT COUNT(*) FROM setlists WHERE source_id = 'set-1'"
        ).fetchone()[0] == 1
        # Name followed the payload.
        assert conn.execute(
            "SELECT name FROM setlists WHERE id = ?", (first_id,)
        ).fetchone()["name"] == "Set One (rev)"
        # No duplicate chart pieces: c1,c2,c3 still exactly 3 rows (c2 stays in the
        # library as a piece — only the setlist item referencing it is dropped).
        assert conn.execute(
            "SELECT COUNT(*) FROM pieces WHERE kind = 'chart' AND deleted_at IS NULL"
        ).fetchone()[0] == 3
        # c1 edited in place, not duplicated.
        c1_rows = conn.execute(
            "SELECT title FROM pieces WHERE chart_source_id = 'c1' AND deleted_at IS NULL"
        ).fetchall()
        assert len(c1_rows) == 1
        assert c1_rows[0]["title"] == "First EDITED"
        # Items now [c3, c1] in order, c2 removed.
        items = conn.execute(
            "SELECT p.chart_source_id AS src, si.ordinal FROM setlist_items si "
            "JOIN pieces p ON p.id = si.piece_id "
            "WHERE si.setlist_id = ? ORDER BY si.ordinal",
            (first_id,),
        ).fetchall()
        assert [it["src"] for it in items] == ["c3", "c1"]
    finally:
        conn.close()

    # Second send's pieceIds reuse the same piece ids (upsert), not new ones.
    second_pieces = r2.json()["pieceIds"]
    assert set(second_pieces).issubset(set(first_pieces))


def test_resend_preserves_bandstand_native_setlist_fields(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    _post_set(client, key, "set-1", "Gig", [chart("c1", "A")])
    conn = db.connect(cfg.db_path)
    try:
        sid = conn.execute(
            "SELECT id FROM setlists WHERE source_id = 'set-1'"
        ).fetchone()["id"]
        # Simulate a Bandstand-native edit the tablet would make: set date/venue/notes.
        conn.execute("BEGIN")
        conn.execute(
            "UPDATE setlists SET date = ?, venue = ?, notes = ? WHERE id = ?",
            ("2026-08-01", "The Blue Room", "bring the Rhodes", sid),
        )
        conn.execute("COMMIT")
    finally:
        conn.close()

    # Re-send from Saltycharts (never carries date/venue/notes).
    _post_set(client, key, "set-1", "Gig (rev)", [chart("c1", "A"), chart("c2", "B")])

    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT * FROM setlists WHERE source_id = 'set-1'"
        ).fetchone()
        # Native fields preserved; name overwritten.
        assert row["date"] == "2026-08-01"
        assert row["venue"] == "The Blue Room"
        assert row["notes"] == "bring the Rhodes"
        assert row["name"] == "Gig (rev)"
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Atomic reject — one bad chart, nothing written
# ---------------------------------------------------------------------------

def test_one_bad_chart_rejects_whole_set_atomically(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    # Middle chart is invalid (missing sections envelope).
    bad = {"id": "c2", "title": "No sections"}
    r = _post_set(client, key, "set-1", "Set",
                  [chart("c1", "Good"), bad, chart("c3", "AlsoGood")])
    assert r.status_code == 400  # bad envelope

    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM pieces WHERE kind = 'chart'").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM setlists").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM setlist_items").fetchone()[0] == 0
    finally:
        conn.close()
    # Nothing hit disk either.
    assert list(cfg.library_dir.glob("*.saltychart.json")) == []


def test_chart_missing_id_rejects_whole_set(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    no_id = {"title": "Idless", "sections": []}
    r = _post_set(client, key, "set-1", "Set", [chart("c1", "Good"), no_id])
    assert r.status_code == 422
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM pieces WHERE kind = 'chart'").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM setlists").fetchone()[0] == 0
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Envelope validation
# ---------------------------------------------------------------------------

def test_empty_setlist_id_is_422(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    for bad in ("", "   "):
        r = _post_set(client, key, bad, "Set", [chart("c1", "A")])
        assert r.status_code == 422
    # No setlist id key at all.
    r = client.post("/api/upload-setlist", headers={"X-Bandstand-Key": key},
                    json={"setlist": {"name": "Set", "charts": [chart("c1", "A")]}})
    assert r.status_code == 422
    # Nothing written.
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM setlists").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM pieces WHERE kind = 'chart'").fetchone()[0] == 0
    finally:
        conn.close()


def test_missing_setlist_object_is_422(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    assert client.post("/api/upload-setlist", headers={"X-Bandstand-Key": key},
                       json={}).status_code == 422


def test_charts_not_array_is_422(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    r = client.post("/api/upload-setlist", headers={"X-Bandstand-Key": key},
                    json={"setlist": {"id": "s", "name": "S", "charts": {}}})
    assert r.status_code == 422


def test_too_many_charts_is_422(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    charts = [chart(f"c{i}", f"T{i}") for i in range(51)]
    r = _post_set(client, key, "big", "Big", charts)
    assert r.status_code == 422
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM setlists").fetchone()[0] == 0
    finally:
        conn.close()


def test_empty_charts_creates_empty_setlist(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    r = _post_set(client, key, "empty", "Empty Set", [])
    assert r.status_code == 200
    assert r.json()["pieceIds"] == []
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute(
            "SELECT name FROM setlists WHERE source_id = 'empty'"
        ).fetchone()["name"] == "Empty Set"
    finally:
        conn.close()


def test_name_fallback_to_untitled_set(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    # Blank name and non-string name both fall back.
    _post_set(client, key, "s1", "   ", [chart("c1", "A")])
    client.post("/api/upload-setlist", headers={"X-Bandstand-Key": key},
                json={"setlist": {"id": "s2", "name": 5, "charts": [chart("c2", "B")]}})
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute("SELECT name FROM setlists WHERE source_id = 's1'").fetchone()["name"] == "Untitled set"
        assert conn.execute("SELECT name FROM setlists WHERE source_id = 's2'").fetchone()["name"] == "Untitled set"
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Auth + CORS
# ---------------------------------------------------------------------------

def test_upload_setlist_requires_auth(tmp_data_dir):
    client, _, _ = _setup(tmp_data_dir)
    r = client.post("/api/upload-setlist",
                    json={"setlist": {"id": "s", "name": "S", "charts": []}})
    assert r.status_code == 401


def test_cors_preflight_allows_cross_origin_post(tmp_data_dir):
    client, _, _ = _setup(tmp_data_dir)
    r = client.options(
        "/api/upload-setlist",
        headers={
            "Origin": "http://localhost:5180",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-bandstand-key,content-type",
        },
    )
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "*"


# ---------------------------------------------------------------------------
# Manifest integration
# ---------------------------------------------------------------------------

def test_manifest_includes_setlist_and_items(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    _post_set(client, key, "set-1", "Gig", [chart("c1", "A"), chart("c2", "B")])
    m = client.get("/api/manifest", headers={"X-Bandstand-Key": key}).json()
    sets = [s for s in m["setlists"] if s.get("source_id") == "set-1"]
    assert len(sets) == 1
    sid = sets[0]["id"]
    items = [it for it in m["setlist_items"] if it["setlist_id"] == sid]
    assert len(items) == 2
    assert [it["ordinal"] for it in sorted(items, key=lambda x: x["ordinal"])] == [0, 1]
    # chart_json rides the manifest so devices render the set offline.
    chart_pieces = [p for p in m["pieces"] if p["kind"] == "chart"]
    assert len(chart_pieces) == 2
    assert all(json.loads(p["chart_json"]) for p in chart_pieces)
