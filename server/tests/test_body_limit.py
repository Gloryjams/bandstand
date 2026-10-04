"""Nobody gets to make the server store bytes before it knows who they are.

These tests drive the ASGI app directly so they can see what the HTTP test client
hides: whether the application ever SAW the request. A refused upload is read off
the connection and thrown away; it is never parsed, buffered or written to disk.
"""
import asyncio
import json

import pytest

from server import body_limit, config, db, members
from server.main import build_app

MB = 1024 * 1024


@pytest.fixture
def server(tmp_data_dir):
    cfg = config.load()
    db.bootstrap(cfg)
    return build_app(), cfg.key_path.read_text().strip(), cfg


def _member_key(cfg) -> str:
    conn = db.connect(cfg.db_path)
    try:
        return members.add_member(conn, "Rea")[1]
    finally:
        conn.close()


class _Spy:
    """Stands where the application stands, behind the limit layer."""

    def __init__(self):
        self.calls = 0
        self.body = 0

    async def __call__(self, scope, receive, send):
        self.calls += 1
        while True:
            message = await receive()
            self.body += len(message.get("body", b""))
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b'{"reached": true}'})


def _guarded():
    spy = _Spy()
    return body_limit.BodyLimitMiddleware(spy), spy


def _no_temporary_files(monkeypatch):
    """Any attempt to spool a body to a temporary file fails the test."""
    import tempfile

    def refuse(*args, **kwargs):
        raise AssertionError("a request body was written to a temporary file")

    monkeypatch.setattr(tempfile, "SpooledTemporaryFile", refuse)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", refuse)
    monkeypatch.setattr(tempfile, "TemporaryFile", refuse)


def _send(app, path, *, headers=(), chunks=(b"",), method="POST"):
    """One request. Returns (status, json body, body chunks taken off the wire, headers)."""
    queue = list(chunks)
    read = 0
    out: dict = {"body": b""}

    async def receive():
        nonlocal read
        if not queue:
            return {"type": "http.disconnect"}
        read += 1
        chunk = queue.pop(0)
        return {"type": "http.request", "body": chunk, "more_body": bool(queue)}

    async def send(message):
        if message["type"] == "http.response.start":
            out["status"] = message["status"]
            out["headers"] = {k.decode(): v.decode() for k, v in message["headers"]}
        elif message["type"] == "http.response.body":
            out["body"] += message.get("body", b"")

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method, "path": path, "raw_path": path.encode(), "query_string": b"",
        "root_path": "", "scheme": "http", "server": ("testserver", 80),
        "client": ("203.0.113.9", 50000),
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers],
    }
    asyncio.run(app(scope, receive, send))
    body = json.loads(out["body"]) if out["body"] else None
    return out["status"], body, read, out.get("headers", {})


def _multipart(payload: bytes, boundary="xBOUNDARYx"):
    head = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="x.pdf"\r\n'
        "Content-Type: application/pdf\r\n\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    return head + payload + tail, f"multipart/form-data; boundary={boundary}"


def _in_chunks(blob: bytes, size=256 * 1024):
    return [blob[i:i + size] for i in range(0, len(blob), size)] or [b""]


@pytest.mark.parametrize("path", sorted(body_limit.LARGE_BODY_PATHS))
@pytest.mark.parametrize("key", [None, "not-the-key" * 8])
def test_a_stranger_never_reaches_the_application(server, monkeypatch, path, key):
    _app, _real, _cfg = server
    guarded, spy = _guarded()
    blob, ctype = _multipart(b"\0" * (3 * MB))
    headers = [("content-type", ctype), ("content-length", str(len(blob)))]
    if key:
        headers.append(("x-bandstand-key", key))
    status, body, _read, response_headers = _send(
        guarded, path, headers=headers, chunks=_in_chunks(blob)
    )
    assert status == 401
    assert body == {"detail": "Invalid or missing key"}
    assert (spy.calls, spy.body) == (0, 0), "the application saw an unauthenticated upload"
    assert response_headers.get("connection") == "close"


@pytest.mark.parametrize("path", sorted(body_limit.LARGE_BODY_PATHS))
def test_a_refused_upload_is_stored_nowhere(server, monkeypatch, path):
    # The whole stack this time, with every way of making a temporary file rigged
    # to fail. The old behaviour wrote all 3 MB to one before answering 401.
    app, _real, cfg = server
    _no_temporary_files(monkeypatch)
    before = sorted(p.name for p in cfg.data_dir.rglob("*"))
    blob, ctype = _multipart(b"\0" * (3 * MB))
    status, _body, read, _ = _send(
        app, path,
        headers=[("content-type", ctype), ("content-length", str(len(blob)))],
        chunks=_in_chunks(blob),
    )
    assert status == 401
    # Taken off the wire so the sender gets an answer and not a broken connection.
    assert read == len(_in_chunks(blob))
    assert sorted(p.name for p in cfg.data_dir.rglob("*")) == before


def test_a_member_key_never_reaches_the_application(server):
    _app, _real, cfg = server
    guarded, spy = _guarded()
    blob, ctype = _multipart(b"\0" * (3 * MB))
    status, body, _read, _ = _send(
        guarded, "/api/upload-piece",
        headers=[("content-type", ctype), ("x-bandstand-key", _member_key(cfg))],
        chunks=_in_chunks(blob),
    )
    assert (status, spy.calls) == (403, 0)
    assert body == {"detail": "Director key required"}


def test_a_stranger_who_declares_no_size_never_reaches_the_application(server, monkeypatch):
    # Chunked transfer: no Content-Length at all, so a size check alone sees nothing.
    monkeypatch.setenv("BANDSTAND_MAX_UPLOAD_MB", "1")
    _app, _real, _cfg = server
    guarded, spy = _guarded()
    blob, ctype = _multipart(b"\0" * (8 * MB))
    chunks = _in_chunks(blob)
    status, _body, read, _ = _send(
        guarded, "/api/upload-piece", headers=[("content-type", ctype)], chunks=chunks
    )
    assert (status, spy.calls) == (401, 0)
    # And the throwing away stops at the ceiling (2 MB here), not after all 8 MB.
    assert read < len(chunks) / 2


def test_the_director_does_reach_the_application(server):
    _app, key, _cfg = server
    guarded, spy = _guarded()
    blob, ctype = _multipart(b"\0" * MB)
    status, body, _read, _ = _send(
        guarded, "/api/upload-piece",
        headers=[("content-type", ctype), ("content-length", str(len(blob))),
                 ("x-bandstand-key", key)],
        chunks=_in_chunks(blob),
    )
    assert (status, body, spy.calls, spy.body) == (200, {"reached": True}, 1, len(blob))


def test_a_declared_size_over_the_upload_limit_is_refused_unread(server, monkeypatch):
    monkeypatch.setenv("BANDSTAND_MAX_UPLOAD_MB", "1")
    app, key, _cfg = server
    blob, ctype = _multipart(b"\0" * (3 * MB))
    status, body, read, _ = _send(
        app, "/api/upload-piece",
        headers=[("content-type", ctype), ("content-length", str(len(blob))),
                 ("x-bandstand-key", key)],
        chunks=_in_chunks(blob),
    )
    assert (status, read) == (413, 0)
    assert body == {"detail": "Body too large"}


def test_an_undeclared_upload_is_cut_off_at_the_limit(server, monkeypatch):
    monkeypatch.setenv("BANDSTAND_MAX_UPLOAD_MB", "1")
    app, key, cfg = server
    blob, ctype = _multipart(b"\0" * (6 * MB))
    chunks = _in_chunks(blob)
    status, _body, read, _ = _send(
        app, "/api/upload-piece",
        headers=[("content-type", ctype), ("x-bandstand-key", key)], chunks=chunks,
    )
    assert status == 413
    # Cut off just past the ceiling (1 MB file + 1 MB envelope), not after all 6 MB.
    assert read < len(chunks) / 2
    assert list(cfg.library_dir.iterdir()) == []


def test_an_undeclared_json_body_is_cut_off_at_the_ceiling(server):
    # The old check trusted Content-Length and let a chunked body of any size through.
    app, key, _cfg = server
    blob = b'{"ops": "' + b"a" * (7 * MB) + b'"}'
    chunks = _in_chunks(blob)
    status, body, read, _ = _send(
        app, "/api/sync",
        headers=[("content-type", "application/json"), ("x-bandstand-key", key)],
        chunks=chunks,
    )
    assert status == 413
    assert body == {"detail": "Body too large"}
    assert read < len(chunks)


def test_the_ceiling_follows_the_configured_upload_limit(server, monkeypatch):
    monkeypatch.setenv("BANDSTAND_MAX_UPLOAD_MB", "20")
    assert body_limit.ceiling_for("/api/upload-piece") == 21 * MB
    assert body_limit.ceiling_for("/api/transfer/import") == 201 * MB
    assert body_limit.ceiling_for("/api/sync") == 5 * MB
    assert body_limit.ceiling_for("/room-api/anything") == 5 * MB


def test_a_file_exactly_at_the_limit_still_uploads(server, monkeypatch):
    # The envelope allowance: the ceiling must never reject what the route accepts.
    from pathlib import Path
    monkeypatch.setenv("BANDSTAND_MAX_UPLOAD_MB", "1")
    app, key, cfg = server
    pdf = (Path(__file__).parent / "fixtures" / "three_page_titled.pdf").read_bytes()
    payload = pdf + b"\n%" + b"p" * (MB - len(pdf) - 2)
    assert len(payload) == MB
    blob, ctype = _multipart(payload)
    status, body, _read, _ = _send(
        app, "/api/upload-piece",
        headers=[("content-type", ctype), ("content-length", str(len(blob))),
                 ("x-bandstand-key", key)],
        chunks=_in_chunks(blob),
    )
    assert status == 200, body
    assert (cfg.library_dir / "x.pdf").stat().st_size == MB


def test_reads_are_not_touched(server):
    app, _key, _cfg = server
    status, body, _read, _ = _send(app, "/api/health", method="GET")
    assert status == 200 and body["ok"] is True
