from fastapi.testclient import TestClient


def _client(tmp_data_dir):
    from server import config, db
    from server.main import build_app
    cfg = config.load()
    db.bootstrap(cfg)
    app = build_app()
    return TestClient(app)


def _pyproject_version() -> str:
    # Read the file directly rather than importing server.version: the point is to
    # prove the endpoint reports what pyproject.toml says, by an independent route.
    import tomllib
    from pathlib import Path
    with (Path(__file__).parent.parent / "pyproject.toml").open("rb") as f:
        return tomllib.load(f)["project"]["version"]


def test_health_returns_ok(tmp_data_dir):
    client = _client(tmp_data_dir)
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["version"] == _pyproject_version()
    # Keyless route on an internet-exposed instance: no filesystem paths.
    assert "library_path" not in body
    assert body["piece_count"] == 0


def test_health_no_auth_required(tmp_data_dir):
    client = _client(tmp_data_dir)
    # No header passed — should still work.
    r = client.get("/api/health")
    assert r.status_code == 200


def test_health_reports_band_display_name(tmp_data_dir, monkeypatch):
    # The client's band switcher labels bands from this field; default stays plain.
    from fastapi.testclient import TestClient
    from server import config, db
    from server.main import build_app

    monkeypatch.setenv("BANDSTAND_NAME", "The Lockups")
    db.bootstrap(config.load())
    r = TestClient(build_app()).get("/api/health")
    assert r.status_code == 200
    assert r.json()["name"] == "The Lockups"

    monkeypatch.delenv("BANDSTAND_NAME")
    assert TestClient(build_app()).get("/api/health").json()["name"] == "Bandstand"


def test_health_says_whether_the_chart_editor_is_installed(tmp_data_dir, tmp_path, monkeypatch):
    # The app reads this to decide whether to show its "New chart" link. Without it
    # a director on an install built without SaltyCharts lands on the "not
    # installed" page. Checked per request, like the /charts mount: an editor added
    # later shows up without a restart.
    from server import main

    charts = tmp_path / "charts-bundle"
    monkeypatch.setattr(main, "_STATIC_CHARTS", charts)
    client = _client(tmp_data_dir)

    assert client.get("/api/health").json()["chart_editor"] is False

    charts.mkdir()
    assert client.get("/api/health").json()["chart_editor"] is False  # folder alone is not an editor

    (charts / "index.html").write_text("<!doctype html><title>editor</title>", encoding="utf-8")
    assert client.get("/api/health").json()["chart_editor"] is True
