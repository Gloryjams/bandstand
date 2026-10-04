"""Small things an operator meets: health that means something, a log level that
cannot leak the key, the bare address, hidden files, and the members command."""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import config, db, healthcheck, main, serve

REPO = Path(__file__).parent.parent.parent


def _client(tmp_data_dir):
    cfg = config.load()
    db.bootstrap(cfg)
    return TestClient(main.build_app()), cfg


# ---------------------------------------------------------------- health


@pytest.mark.parametrize("damage", ["missing", "truncated", "empty"])
def test_a_server_nobody_can_sign_in_to_is_not_healthy(tmp_data_dir, damage, capsys):
    client, cfg = _client(tmp_data_dir)
    key = cfg.key_path.read_text().strip()
    assert client.get("/api/health").status_code == 200
    if damage == "missing":
        cfg.key_path.unlink()
    else:
        cfg.key_path.write_text("abc" if damage == "truncated" else "")
    r = client.get("/api/health")
    assert r.status_code == 503
    body = r.json()
    assert body["ok"] is False
    # A keyless caller learns that it is not ok, and not why or where.
    assert str(cfg.key_path) not in r.text and "key" not in r.text.lower()
    assert "piece_count" not in body
    # The operator does, in the log, once.
    client.get("/api/health")
    out = capsys.readouterr().out
    assert out.count("the director key is missing or damaged") == 1
    assert str(cfg.key_path) in out
    # Restored: healthy again, with the same key.
    cfg.key_path.write_text(key)
    assert client.get("/api/health").json()["ok"] is True


def test_the_probe_reads_a_503_as_unhealthy(tmp_data_dir, monkeypatch):
    client, cfg = _client(tmp_data_dir)
    cfg.key_path.unlink()
    response = client.get("/api/health")

    import json
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(response.status_code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response.json()).encode())

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        healthy, reason = healthcheck.check(f"http://127.0.0.1:{server.server_address[1]}/api/health")
    finally:
        server.shutdown()
        server.server_close()
    assert (healthy, reason) == (False, "status 503")


def test_the_probe_can_be_pointed_at_the_share_pages(monkeypatch):
    monkeypatch.setenv("BANDSTAND_HEALTH_URL", "http://127.0.0.1:7810/health")
    assert healthcheck.url() == "http://127.0.0.1:7810/health"


@pytest.mark.parametrize("target", ["http://example.com/health", "https://127.0.0.1:1/", "file:///data/.key"])
def test_the_probe_only_ever_looks_at_its_own_machine(monkeypatch, capsys, target):
    monkeypatch.setenv("BANDSTAND_HEALTH_URL", target)
    assert healthcheck.main() == 1
    assert "BANDSTAND_HEALTH_URL" in capsys.readouterr().err


# ---------------------------------------------------------------- log level


@pytest.mark.parametrize("level", serve.LOG_LEVELS)
def test_documented_log_levels_are_accepted(monkeypatch, level):
    monkeypatch.setenv("BANDSTAND_LOG_LEVEL", level.upper())
    said: list[str] = []
    assert serve.log_level(said.append) == level
    assert said == []


@pytest.mark.parametrize("level", ["trace", "TRACE", " trace ", "verbose", "5"])
def test_any_other_log_level_becomes_info_and_says_so(monkeypatch, level):
    # "trace" makes the web server print every request scope, query string included,
    # and the live-update stream carries the key in its query string.
    monkeypatch.setenv("BANDSTAND_LOG_LEVEL", level)
    said: list[str] = []
    assert serve.log_level(said.append) == "info"
    assert len(said) == 1 and "Using info" in said[0]


def test_trace_is_not_a_level_the_server_will_ever_use():
    assert "trace" not in serve.LOG_LEVELS


def test_the_level_handed_to_the_web_server_is_the_checked_one(tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("BANDSTAND_LOG_LEVEL", "trace")
    seen: dict = {}
    import uvicorn
    monkeypatch.setattr(uvicorn, "run", lambda *a, **kw: seen.update(kw))
    assert serve.main() == 0
    assert seen["log_level"] == "info"


# ---------------------------------------------------------------- temporary files


def test_large_temporary_files_go_to_the_data_disk(tmp_path, monkeypatch):
    import tempfile
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("TMPDIR", raising=False)
    monkeypatch.setattr(tempfile, "tempdir", None)
    cfg = config.load()
    serve.prepare(cfg, lambda _line: None)
    (cfg.data_dir / "tmp").mkdir()
    (cfg.data_dir / "tmp" / "left-over-from-a-crash").write_bytes(b"x" * 10)

    serve.use_data_folder_for_temporary_files(cfg)

    assert Path(tempfile.gettempdir()).resolve() == (cfg.data_dir / "tmp").resolve()
    assert list((cfg.data_dir / "tmp").iterdir()) == []
    with tempfile.NamedTemporaryFile() as f:
        assert Path(f.name).resolve().parent == (cfg.data_dir / "tmp").resolve()


def test_an_operator_who_set_tmpdir_is_left_alone(tmp_path, monkeypatch):
    import tempfile
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    monkeypatch.setattr(tempfile, "tempdir", None)
    cfg = config.load()
    serve.prepare(cfg, lambda _line: None)
    serve.use_data_folder_for_temporary_files(cfg)
    assert os.environ["TMPDIR"] == str(tmp_path)
    assert not (cfg.data_dir / "tmp").exists()


# ---------------------------------------------------------------- addresses


def test_the_bare_address_leads_to_the_app(tmp_data_dir):
    client, _cfg = _client(tmp_data_dir)
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"] == "/app/"


@pytest.mark.parametrize(
    "path",
    [".git/config", ".secrets-file", ".env", "assets/.hidden.js", ".well-known/x", "a/.b/c.js"],
)
def test_nothing_hidden_is_served_from_a_bundle(tmp_data_dir, tmp_path, monkeypatch, path):
    root = tmp_path / "charts-bundle"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>charts</title>")
    (root / "assets" / "x.js").write_text("console.log(1)")
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("url = https://user:hunter2@example.com/repo.git")
    monkeypatch.setattr(main, "_STATIC_CHARTS", root)
    client, _cfg = _client(tmp_data_dir)

    r = client.get(f"/charts/{path}")

    assert r.status_code == 404
    assert "hunter2" not in r.text
    # What the bundle is FOR still works.
    assert client.get("/charts/assets/x.js").status_code == 200
    assert client.get("/charts/").status_code == 200


# ---------------------------------------------------------------- members command


def _members(args, data_dir, **env):
    full = {k: v for k, v in os.environ.items() if not k.startswith("BANDSTAND_")}
    if data_dir is not None:
        full["BANDSTAND_DATA_DIR"] = str(data_dir)
    full.update(env)
    return subprocess.run(
        [sys.executable, "-m", "server.members", *args],
        cwd=REPO, env=full, capture_output=True, text=True, timeout=60, check=False,
    )


def test_members_says_which_folder_it_works_on_and_keeps_its_output_format(tmp_path):
    added = _members(["add", "Rea"], tmp_path)
    assert added.returncode == 0
    # Scripts read these four lines from standard output. The folder goes to stderr.
    lines = added.stdout.splitlines()
    assert [l.split(":")[0] for l in lines[:4]] == ["id", "name", "role", "key"]
    assert f"Data folder: {tmp_path}" in added.stderr
    assert str(tmp_path) not in added.stdout
    assert "pair link" not in added.stdout
    listed = _members(["list"], tmp_path)
    assert "Rea" in listed.stdout and len(listed.stdout.splitlines()) == 1


def test_members_can_be_pointed_at_a_folder_for_one_run(tmp_path):
    other = tmp_path / "other-band"
    added = _members(["--data-dir", str(other), "add", "Anya"], tmp_path / "default")
    assert added.returncode == 0
    assert f"Data folder: {other}" in added.stderr
    assert (other / "library.db").exists()
    assert not (tmp_path / "default").exists()


def test_members_refuses_a_blank_data_folder(tmp_path):
    result = _members(["add", "Oops"], None, BANDSTAND_DATA_DIR="", HOME=str(tmp_path))
    assert result.returncode == 1
    assert "BANDSTAND_DATA_DIR is set but empty" in result.stderr
    assert "Traceback" not in result.stderr
    assert "key:" not in result.stdout
    assert not (tmp_path / "Bandstand").exists()
