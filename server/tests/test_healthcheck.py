"""The container health probe."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from server import healthcheck


def _serve(status: int, body: bytes):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # keep test output quiet
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.mark.parametrize(
    "status, body, healthy",
    [
        (200, json.dumps({"ok": True, "version": "1.2.3"}).encode(), True),
        (200, json.dumps({"ok": False}).encode(), False),
        (200, b"<html>a proxy error page</html>", False),
        (200, json.dumps(["ok"]).encode(), False),
        (500, json.dumps({"ok": True}).encode(), False),
    ],
)
def test_probe_verdicts(status, body, healthy):
    server = _serve(status, body)
    try:
        target = f"http://127.0.0.1:{server.server_address[1]}/api/health"
        assert healthcheck.check(target)[0] is healthy
    finally:
        server.shutdown()
        server.server_close()


def test_nothing_listening_is_unhealthy():
    server = _serve(200, b"{}")
    port = server.server_address[1]
    server.shutdown()
    server.server_close()
    assert healthcheck.check(f"http://127.0.0.1:{port}/api/health", timeout=1)[0] is False


def test_probe_follows_the_configured_port(monkeypatch):
    monkeypatch.setenv("BANDSTAND_PORT", "7895")
    assert healthcheck.url() == "http://127.0.0.1:7895/api/health"
    monkeypatch.delenv("BANDSTAND_PORT")
    assert healthcheck.url() == "http://127.0.0.1:7800/api/health"


def test_bad_port_is_a_clean_failure(monkeypatch, capsys):
    monkeypatch.setenv("BANDSTAND_PORT", "not-a-port")
    assert healthcheck.main() == 1
    assert "BANDSTAND_PORT" in capsys.readouterr().err
