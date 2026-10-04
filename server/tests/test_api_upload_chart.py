import json
import time
from pathlib import Path

from fastapi.testclient import TestClient

from server import config, db
from server.ingest import chart_meta


def _setup(tmp_data_dir):
    from server.main import build_app
    cfg = config.load()
    db.bootstrap(cfg)
    app = build_app()
    key = cfg.key_path.read_text().strip()
    return TestClient(app), key, cfg


def sample_chart(**over):
    """A chart exercising sections with bars, a pocket section (description + hits),
    an arrangement with repeats/open/solos/step-hits, volta endings, and segno/direction."""
    chart = {
        "id": "chart-abc-123",
        "title": "Blue Bossa",
        "artist": "Kenny Dorham",
        "key": "Cm",
        "time": "4/4",
        "bpm": "150",
        "style": "Bossa",
        "capo": "",
        "sections": [
            {
                "id": "s1",
                "label": "Head",
                "bars": [
                    {"chords": "Cm7", "sign": "segno"},
                    {"chords": "Fm7"},
                    {"chords": "Dm7b5", "hits": "2& 4"},
                    {"chords": "G7", "barline": "repeat-end", "ending": "1.",
                     "direction": "D.S. al Coda"},
                    {"chords": "Cm7", "ending": "2.", "barline": "final"},
                ],
            },
            {
                "id": "s2",
                "label": "Solos",
                "bars": [],
                "description": "Cm blues, trade 4s",
                "hits": "#..x. .x.. x... ..x.",
            },
        ],
        "arrangement": [
            {"id": "a1", "sectionId": "s1", "repeats": 2},
            {"id": "a2", "sectionId": "s2", "open": True,
             "solos": ["gtr", "keys"], "hits": "1 3", "note": "build it"},
            {"id": "a3", "sectionId": "s1", "note": "last x ritard"},
        ],
        "settings": {"barsPerRow": 4, "fontSize": "large",
                     "showLyrics": False, "onePage": False},
        "tags": ["jazz", "standard"],
        "createdAt": 1,
        "updatedAt": 2,
    }
    chart.update(over)
    return chart


def test_upload_chart_creates_piece(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    r = client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                    json={"chart": sample_chart()})
    assert r.status_code == 200
    piece_id = r.json()["id"]
    assert piece_id

    # A .saltychart.json file lands on disk (parity with every other piece).
    disk = list(cfg.library_dir.glob("*.saltychart.json"))
    assert len(disk) == 1

    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT * FROM pieces WHERE id = ?", (piece_id,)).fetchone()
        assert row["kind"] == "chart"
        assert row["title"] == "Blue Bossa"
        assert row["composer"] == "Kenny Dorham"
        assert row["chart_source_id"] == "chart-abc-123"
        stored = json.loads(row["chart_json"])
        assert stored["sections"][1]["description"] == "Cm blues, trade 4s"
        assert stored["arrangement"][1]["open"] is True
        # The on-disk filename is recorded so the watcher can soft-delete on removal.
        assert row["chart_file"] == disk[0].name
        # No PDF files row for a chart.
        assert conn.execute(
            "SELECT COUNT(*) FROM files WHERE piece_id = ?", (piece_id,)
        ).fetchone()[0] == 0
    finally:
        conn.close()


def test_upload_chart_upserts_by_chart_id(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    r1 = client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                     json={"chart": sample_chart()})
    id1 = r1.json()["id"]
    # Re-send the same chart id with an edited title — replaces, does not duplicate.
    r2 = client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                     json={"chart": sample_chart(title="Blue Bossa (edit)")})
    id2 = r2.json()["id"]
    assert id1 == id2

    conn = db.connect(cfg.db_path)
    try:
        rows = conn.execute(
            "SELECT title FROM pieces WHERE kind = 'chart' AND deleted_at IS NULL"
        ).fetchall()
        assert len(rows) == 1
        assert rows[0]["title"] == "Blue Bossa (edit)"
    finally:
        conn.close()
    # Overwrote the same on-disk file, no duplicate.
    assert len(list(cfg.library_dir.glob("*.saltychart.json"))) == 1


def test_upload_chart_requires_auth(tmp_data_dir):
    client, _, _ = _setup(tmp_data_dir)
    r = client.post("/api/upload-chart", json={"chart": sample_chart()})
    assert r.status_code == 401


def test_upload_chart_rejects_bad_envelope(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    # Missing title / sections.
    assert client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                       json={"chart": {"id": "x"}}).status_code == 400
    # title not a string.
    assert client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                       json={"chart": {"title": 5, "sections": []}}).status_code == 400
    # sections not an array.
    assert client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                       json={"chart": {"title": "x", "sections": {}}}).status_code == 400
    # not an object at all.
    assert client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                       json={"chart": "nope"}).status_code == 400


def test_upload_chart_rejects_oversize(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    huge = sample_chart(notes="x" * (chart_meta.MAX_CHART_BYTES + 10))
    r = client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                    json={"chart": huge})
    assert r.status_code == 400


def test_upload_chart_rejects_empty_id(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    for bad_id in ("", "   "):
        r = client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                        json={"chart": sample_chart(id=bad_id)})
        assert r.status_code == 422
    # Missing id key entirely -> also 422.
    chart = sample_chart()
    del chart["id"]
    r = client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                    json={"chart": chart})
    assert r.status_code == 422
    # Nothing was written or inserted on rejection.
    assert list(cfg.library_dir.glob("*.saltychart.json")) == []
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute(
            "SELECT COUNT(*) FROM pieces WHERE kind = 'chart'"
        ).fetchone()[0] == 0
    finally:
        conn.close()


def test_dropped_idless_chart_is_skipped(tmp_data_dir):
    # A hand-crafted idless drop must not create a piece (no UPSERT identity).
    from server.ingest import pipeline
    cfg = config.load()
    db.bootstrap(cfg)
    dropped = cfg.library_dir / "idless.saltychart.json"
    chart = sample_chart()
    del chart["id"]
    dropped.write_text(json.dumps(chart), encoding="utf-8")
    pipeline.ingest_path(cfg, dropped)  # must not raise, must not insert
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute(
            "SELECT COUNT(*) FROM pieces WHERE kind = 'chart'"
        ).fetchone()[0] == 0
    finally:
        conn.close()


def test_manifest_includes_chart_piece(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                json={"chart": sample_chart()})
    m = client.get("/api/manifest", headers={"X-Bandstand-Key": key}).json()
    charts = [p for p in m["pieces"] if p["kind"] == "chart"]
    assert len(charts) == 1
    # chart_json rides the manifest so devices render offline.
    stored = json.loads(charts[0]["chart_json"])
    assert stored["title"] == "Blue Bossa"


def test_cors_preflight_allows_cross_origin_post(tmp_data_dir):
    client, _, _ = _setup(tmp_data_dir)
    r = client.options(
        "/api/upload-chart",
        headers={
            "Origin": "http://localhost:5180",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-bandstand-key,content-type",
        },
    )
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "*"


def test_watcher_style_ingest_of_dropped_chart(tmp_data_dir):
    # A .saltychart.json dropped into the library ingests exactly like the endpoint path.
    from server.ingest import pipeline
    cfg = config.load()
    db.bootstrap(cfg)
    dropped = cfg.library_dir / "some-chart.saltychart.json"
    dropped.write_text(json.dumps(sample_chart()), encoding="utf-8")
    pipeline.ingest_path(cfg, dropped)

    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT * FROM pieces WHERE kind = 'chart'"
        ).fetchone()
        assert row is not None
        assert row["title"] == "Blue Bossa"
        assert row["chart_source_id"] == "chart-abc-123"
    finally:
        conn.close()


def test_dropped_chart_ingest_is_idempotent(tmp_data_dir):
    from server.ingest import pipeline
    cfg = config.load()
    db.bootstrap(cfg)
    dropped = cfg.library_dir / "some-chart.saltychart.json"
    dropped.write_text(json.dumps(sample_chart()), encoding="utf-8")
    pipeline.ingest_path(cfg, dropped)
    pipeline.ingest_path(cfg, dropped)  # e.g. a modify event after create
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute(
            "SELECT COUNT(*) FROM pieces WHERE kind = 'chart'"
        ).fetchone()[0] == 1
    finally:
        conn.close()


def test_malformed_chart_file_is_skipped(tmp_data_dir):
    from server.ingest import pipeline
    cfg = config.load()
    db.bootstrap(cfg)
    bad = cfg.library_dir / "broken.saltychart.json"
    bad.write_text("{not valid json", encoding="utf-8")
    pipeline.ingest_path(cfg, bad)  # must not raise
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute(
            "SELECT COUNT(*) FROM pieces WHERE kind = 'chart'"
        ).fetchone()[0] == 0
    finally:
        conn.close()


def test_upsert_chart_piece_defaults_untitled(tmp_data_dir):
    from server.ingest import pipeline
    cfg = config.load()
    db.bootstrap(cfg)
    conn = db.connect(cfg.db_path)
    try:
        pid = pipeline.upsert_chart_piece(
            conn, {"id": "z", "title": "", "sections": []}, int(time.time() * 1000)
        )
        row = conn.execute("SELECT title FROM pieces WHERE id = ?", (pid,)).fetchone()
        assert row["title"] == "Untitled"
    finally:
        conn.close()
