import json

from server import config, db
from server.tests.test_api_upload_chart import _setup, sample_chart


def _upload(client, key, **over):
    return client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                       json={"chart": sample_chart(**over)})


def test_list_charts_returns_uploaded(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    _upload(client, key)
    r = client.get("/api/charts", headers={"X-Bandstand-Key": key})
    assert r.status_code == 200
    charts = r.json()["charts"]
    assert len(charts) == 1
    assert charts[0]["source_id"] == "chart-abc-123"
    assert charts[0]["chart"]["title"] == "Blue Bossa"
    assert charts[0]["deleted_at"] is None


def test_delete_chart_tombstones_and_removes_file(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    _upload(client, key)
    assert len(list(cfg.library_dir.glob("*.saltychart.json"))) == 1

    r = client.delete("/api/charts/chart-abc-123", headers={"X-Bandstand-Key": key})
    assert r.status_code == 200
    # The on-disk file is gone (else boot-time scan_library would resurrect the piece).
    assert list(cfg.library_dir.glob("*.saltychart.json")) == []
    # The pull still carries the row, now as a tombstone, so other devices delete too.
    charts = client.get("/api/charts", headers={"X-Bandstand-Key": key}).json()["charts"]
    assert len(charts) == 1
    assert charts[0]["deleted_at"] is not None
    # And the manifest (live rows only) no longer shows it to Bandstand devices.
    m = client.get("/api/manifest", headers={"X-Bandstand-Key": key}).json()
    assert [p for p in m["pieces"] if p["kind"] == "chart"] == []


def test_delete_unknown_chart_404(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    r = client.delete("/api/charts/nope", headers={"X-Bandstand-Key": key})
    assert r.status_code == 404


def test_stale_upload_is_dropped_silently(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    _upload(client, key, title="Newer", updatedAt=100)
    # An older offline copy arrives afterwards: 200 (applied semantics, so the sending
    # device clears its queue) but nothing changes, on disk or in the DB.
    r = _upload(client, key, title="Older", updatedAt=50)
    assert r.status_code == 200
    charts = client.get("/api/charts", headers={"X-Bandstand-Key": key}).json()["charts"]
    assert charts[0]["chart"]["title"] == "Newer"
    disk = list(cfg.library_dir.glob("*.saltychart.json"))
    assert len(disk) == 1
    assert json.loads(disk[0].read_text(encoding="utf-8"))["title"] == "Newer"


def test_equal_timestamp_upload_applies(tmp_data_dir):
    # Only STRICTLY newer stored content drops a push; equal timestamps stay
    # last-write-wins so a re-send after a transient failure isn't refused.
    client, key, _ = _setup(tmp_data_dir)
    _upload(client, key, title="First", updatedAt=100)
    _upload(client, key, title="Second", updatedAt=100)
    charts = client.get("/api/charts", headers={"X-Bandstand-Key": key}).json()["charts"]
    assert charts[0]["chart"]["title"] == "Second"


def test_newer_upload_revives_tombstone_in_place(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    _upload(client, key, updatedAt=100)
    client.delete("/api/charts/chart-abc-123", headers={"X-Bandstand-Key": key})
    # A device whose copy outlives the delete pushes again: the SAME row revives —
    # no duplicate chart_source_id rows (the old live-rows-only match inserted one).
    r = _upload(client, key, title="Revived", updatedAt=10_000_000_000_000)
    assert r.status_code == 200
    charts = client.get("/api/charts", headers={"X-Bandstand-Key": key}).json()["charts"]
    assert len(charts) == 1
    assert charts[0]["deleted_at"] is None
    assert charts[0]["chart"]["title"] == "Revived"

    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute(
            "SELECT COUNT(*) FROM pieces WHERE chart_source_id = 'chart-abc-123'"
        ).fetchone()[0] == 1
    finally:
        conn.close()


def test_saltycharts_setlists_pull(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    c1 = sample_chart(id="c1", title="One", updatedAt=10)
    c2 = sample_chart(id="c2", title="Two", updatedAt=10)
    r = client.post("/api/upload-setlist", headers={"X-Bandstand-Key": key},
                    json={"setlist": {"id": "set-1", "name": "Friday",
                                      "updatedAt": 500, "charts": [c2, c1]}})
    assert r.status_code == 200
    out = client.get("/api/saltycharts-setlists",
                     headers={"X-Bandstand-Key": key}).json()["setlists"]
    assert len(out) == 1
    assert out[0]["source_id"] == "set-1"
    assert out[0]["name"] == "Friday"
    # Payload order is preserved (Saltycharts owns the order).
    assert out[0]["chart_source_ids"] == ["c2", "c1"]
    # The client's updatedAt is stored verbatim: freshness stays in one clock domain.
    assert out[0]["updated_at"] == 500


def test_stale_setlist_upload_keeps_row_and_items(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    c1 = sample_chart(id="c1", title="One", updatedAt=10)
    c2 = sample_chart(id="c2", title="Two", updatedAt=10)
    client.post("/api/upload-setlist", headers={"X-Bandstand-Key": key},
                json={"setlist": {"id": "set-1", "name": "Newer name",
                                  "updatedAt": 900, "charts": [c1, c2]}})
    # A stale copy with a different name and order arrives: 200, no changes.
    r = client.post("/api/upload-setlist", headers={"X-Bandstand-Key": key},
                    json={"setlist": {"id": "set-1", "name": "Older name",
                                      "updatedAt": 100, "charts": [c2]}})
    assert r.status_code == 200
    out = client.get("/api/saltycharts-setlists",
                     headers={"X-Bandstand-Key": key}).json()["setlists"]
    assert out[0]["name"] == "Newer name"
    assert out[0]["chart_source_ids"] == ["c1", "c2"]
    assert out[0]["updated_at"] == 900


def test_setlist_upload_without_updated_at_stays_lww(tmp_data_dir):
    # The manual send-the-set button predates the timestamp: no updatedAt means
    # plain last-write-wins, exactly the old behavior.
    client, key, _ = _setup(tmp_data_dir)
    c1 = sample_chart(id="c1", title="One", updatedAt=10)
    client.post("/api/upload-setlist", headers={"X-Bandstand-Key": key},
                json={"setlist": {"id": "set-1", "name": "First",
                                  "updatedAt": 900, "charts": [c1]}})
    client.post("/api/upload-setlist", headers={"X-Bandstand-Key": key},
                json={"setlist": {"id": "set-1", "name": "Manual resend",
                                  "charts": [c1]}})
    out = client.get("/api/saltycharts-setlists",
                     headers={"X-Bandstand-Key": key}).json()["setlists"]
    assert out[0]["name"] == "Manual resend"


def test_charts_sync_endpoints_require_auth(tmp_data_dir):
    client, _, _ = _setup(tmp_data_dir)
    assert client.get("/api/charts").status_code == 401
    assert client.delete("/api/charts/x").status_code == 401
    assert client.get("/api/saltycharts-setlists").status_code == 401


def test_delete_saltycharts_setlist_by_source_id(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    c1 = sample_chart(id="c1", title="One", updatedAt=10)
    client.post("/api/upload-setlist", headers={"X-Bandstand-Key": key},
                json={"setlist": {"id": "set-1", "name": "Friday",
                                  "updatedAt": 500, "charts": [c1]}})
    r = client.delete("/api/saltycharts-setlists/set-1",
                      headers={"X-Bandstand-Key": key})
    assert r.status_code == 200
    out = client.get("/api/saltycharts-setlists",
                     headers={"X-Bandstand-Key": key}).json()["setlists"]
    assert out == []
    # Items cascade; the charts themselves are untouched.
    charts = client.get("/api/charts", headers={"X-Bandstand-Key": key}).json()["charts"]
    assert len(charts) == 1 and charts[0]["deleted_at"] is None
    # Idempotent: an offline queue re-flushing the delete must not wedge on 404.
    assert client.delete("/api/saltycharts-setlists/set-1",
                         headers={"X-Bandstand-Key": key}).status_code == 200
