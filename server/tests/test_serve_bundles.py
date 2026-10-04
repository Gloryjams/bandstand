"""The /app and /charts bundle mounts: same-origin PWA serving."""

from fastapi.testclient import TestClient

from server import main


def _client(tmp_data_dir):
    from server import config, db
    cfg = config.load()
    db.bootstrap(cfg)
    return TestClient(main.build_app())


def _build_bundle(root, marker: str):
    root.mkdir(parents=True)
    (root / "index.html").write_text(f"<!doctype html><title>{marker}</title>", encoding="utf-8")
    (root / "assets").mkdir()
    (root / "assets" / "x-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (root / "sw.js").write_text("// sw", encoding="utf-8")
    (root / "manifest.webmanifest").write_text("{}", encoding="utf-8")


def test_unbuilt_bundle_404s(tmp_data_dir, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "_STATIC_CHARTS", tmp_path / "not-built")
    c = _client(tmp_data_dir)
    assert c.get("/charts").status_code == 404
    assert c.get("/charts/anything").status_code == 404


def test_bundle_serves_index_and_assets(tmp_data_dir, tmp_path, monkeypatch):
    root = tmp_path / "charts-bundle"
    _build_bundle(root, "charts")
    monkeypatch.setattr(main, "_STATIC_CHARTS", root)
    c = _client(tmp_data_dir)

    for path in ("/charts", "/charts/"):
        r = c.get(path)
        assert r.status_code == 200
        assert "charts" in r.text
        assert r.headers["cache-control"] == "no-cache"

    r = c.get("/charts/assets/x-abc123.js")
    assert r.status_code == 200
    assert "cache-control" not in r.headers or "no-cache" not in r.headers["cache-control"]

    # PWA control files must revalidate (update standard)
    assert c.get("/charts/sw.js").headers["cache-control"] == "no-cache"
    assert c.get("/charts/manifest.webmanifest").headers["cache-control"] == "no-cache"

    # extensionless client-side routes fall back to index.html
    r = c.get("/charts/some/deep/route")
    assert r.status_code == 200
    assert "charts" in r.text

    # ...but a missing FILE (stale content-hashed asset after a rebuild) is a
    # real 404, never index.html handed to a <script> parser
    assert c.get("/charts/assets/x-GONE99.js").status_code == 404


def test_bundle_built_after_startup_needs_no_restart(tmp_data_dir, tmp_path, monkeypatch):
    root = tmp_path / "late-bundle"
    monkeypatch.setattr(main, "_STATIC_CHARTS", root)
    c = _client(tmp_data_dir)
    assert c.get("/charts").status_code == 404
    _build_bundle(root, "late")
    assert c.get("/charts").status_code == 200


def test_bundle_blocks_path_traversal(tmp_data_dir, tmp_path, monkeypatch):
    root = tmp_path / "charts-bundle"
    _build_bundle(root, "charts")
    (tmp_path / "outside.txt").write_text("secret", encoding="utf-8")
    monkeypatch.setattr(main, "_STATIC_CHARTS", root)
    c = _client(tmp_data_dir)
    # traversal never escapes the bundle root — falls back to index.html
    r = c.get("/charts/..%2Foutside.txt")
    assert "secret" not in r.text


def test_app_bundle_uses_same_mount(tmp_data_dir, tmp_path, monkeypatch):
    root = tmp_path / "app-bundle"
    _build_bundle(root, "bandstand-app")
    monkeypatch.setattr(main, "_STATIC_APP", root)
    c = _client(tmp_data_dir)
    r = c.get("/app/")
    assert r.status_code == 200
    assert "bandstand-app" in r.text


def _room_bundle(tmp_path, monkeypatch):
    root = tmp_path / "room-bundle"
    root.mkdir()
    (root / "room.html").write_text(
        "<!doctype html><title>rehearsal-room</title>", encoding="utf-8"
    )
    (root / "room.js").write_text("console.log('room')", encoding="utf-8")
    monkeypatch.setattr(main, "_STATIC_ROOM", root)


def test_room_bundle_uses_its_named_entrypoint(tmp_data_dir, tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_ROOMS", "1")
    _room_bundle(tmp_path, monkeypatch)
    c = _client(tmp_data_dir)

    r = c.get("/room/")
    assert r.status_code == 200
    assert "rehearsal-room" in r.text
    assert c.get("/room/room.js").status_code == 200


def test_room_bundle_is_off_until_rooms_are_switched_on(tmp_data_dir, tmp_path, monkeypatch):
    # The guest page is the thing a QR code on a wall points at. While rooms are
    # off it answers with a plain sentence, and no part of the bundle is served.
    monkeypatch.delenv("BANDSTAND_ROOMS", raising=False)
    _room_bundle(tmp_path, monkeypatch)
    c = _client(tmp_data_dir)

    for path in ("/room", "/room/", "/room/01ARZ3NDEKTSV4RRFFQ69G5FAV"):
        r = c.get(path)
        assert r.status_code == 404
        assert "switched off" in r.text
        assert "rehearsal-room" not in r.text
        assert r.headers["cache-control"] == "no-store"
    r = c.get("/room/room.js")
    assert r.status_code == 404
    assert "console.log" not in r.text

    # Config is read per request, so the same app answers once the switch is on.
    monkeypatch.setenv("BANDSTAND_ROOMS", "on")
    assert c.get("/room/").status_code == 200


def test_missing_charts_bundle_explains_itself(tmp_data_dir, tmp_path, monkeypatch):
    # SaltyCharts lives in its own repository, so a self-hosted install may simply
    # not have it. The director who taps "New chart" must get an explanation, not a
    # bare error, and must be told the rest of the app is fine.
    monkeypatch.setattr(main, "_STATIC_CHARTS", tmp_path / "not-built")
    c = _client(tmp_data_dir)
    for path in ("/charts", "/charts/", "/charts/some/deep/route"):
        r = c.get(path)
        assert r.status_code == 404, path
        assert r.headers["content-type"].startswith("text/html"), path
        assert r.headers["cache-control"] == "no-store", path
        assert "chart editor is not installed" in r.text, path
        assert 'href="/app/"' in r.text, path
    # An asset request is not a person reading a page: plain 404, no HTML handed to
    # a script or stylesheet parser.
    r = c.get("/charts/assets/index-abc123.js")
    assert r.status_code == 404
    assert "chart editor" not in r.text


def test_missing_charts_page_gives_way_to_the_real_bundle(tmp_data_dir, tmp_path, monkeypatch):
    root = tmp_path / "late-charts"
    monkeypatch.setattr(main, "_STATIC_CHARTS", root)
    c = _client(tmp_data_dir)
    assert "chart editor is not installed" in c.get("/charts/").text
    _build_bundle(root, "real-editor")
    r = c.get("/charts/")
    assert r.status_code == 200
    assert "real-editor" in r.text
    assert "not installed" not in r.text


def test_other_bundles_keep_the_plain_404(tmp_data_dir, tmp_path, monkeypatch):
    # /app is not optional. If it is missing the install is broken, and saying
    # "optional app not installed" there would be wrong.
    monkeypatch.setattr(main, "_STATIC_APP", tmp_path / "no-app")
    monkeypatch.setattr(main, "_STATIC_ROOM", tmp_path / "no-room")
    c = _client(tmp_data_dir)
    for path in ("/app/", "/room/"):
        r = c.get(path)
        assert r.status_code == 404
        assert "chart editor" not in r.text


def test_user_facing_copy_has_no_em_dash():
    assert "\u2014" not in main._CHARTS_MISSING_HTML
    assert "\u2014" not in main._ROOMS_OFF_HTML
