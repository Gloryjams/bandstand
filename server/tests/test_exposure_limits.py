"""Abuse ceilings added for the internet-exposed demo instance (2026-08-14
security review): upload size cap + library quota, JSON body ceiling, keyless
surface hygiene (no docs, no filesystem paths in /api/health), and the SSE
truncated-key refusal."""
import shutil
from pathlib import Path

from fastapi.testclient import TestClient

from server import config, db
from server.ingest import pipeline

FIXTURES = Path(__file__).parent / "fixtures"


def _setup(tmp_data_dir):
    from server.main import build_app
    cfg = config.load()
    db.bootstrap(cfg)
    key = cfg.key_path.read_text().strip()
    return TestClient(build_app()), key, cfg


def _auth(key):
    return {"X-Bandstand-Key": key}


def _pdf_bytes() -> bytes:
    return (FIXTURES / "three_page_titled.pdf").read_bytes()


def test_upload_over_size_cap_is_413(tmp_data_dir, monkeypatch):
    monkeypatch.setenv("BANDSTAND_MAX_UPLOAD_MB", "1")
    client, key, cfg = _setup(tmp_data_dir)
    blob = _pdf_bytes() + b"\0" * (2 * 1024 * 1024)
    r = client.post(
        "/api/upload-piece",
        files={"file": ("Big Chart.pdf", blob, "application/pdf")},
        headers=_auth(key),
    )
    assert r.status_code == 413
    assert not (cfg.library_dir / "Big Chart.pdf").exists()


def test_upload_over_library_quota_is_413(tmp_data_dir, monkeypatch):
    monkeypatch.setenv("BANDSTAND_LIBRARY_QUOTA_MB", "1")
    client, key, cfg = _setup(tmp_data_dir)
    # Fill the library past the quota with an existing (non-upload) file.
    filler = cfg.library_dir / "filler.bin"
    filler.write_bytes(b"\0" * (1024 * 1024 + 1))
    r = client.post(
        "/api/upload-piece",
        files={"file": ("Quota Chart.pdf", _pdf_bytes(), "application/pdf")},
        headers=_auth(key),
    )
    assert r.status_code == 413
    assert not (cfg.library_dir / "Quota Chart.pdf").exists()


def test_upload_within_limits_still_works(tmp_data_dir, monkeypatch):
    monkeypatch.setenv("BANDSTAND_MAX_UPLOAD_MB", "5")
    monkeypatch.setenv("BANDSTAND_LIBRARY_QUOTA_MB", "50")
    client, key, cfg = _setup(tmp_data_dir)
    r = client.post(
        "/api/upload-piece",
        files={"file": ("Fine Chart.pdf", _pdf_bytes(), "application/pdf")},
        headers=_auth(key),
    )
    assert r.status_code == 200
    assert (cfg.library_dir / "Fine Chart.pdf").exists()


def test_oversized_json_body_is_413(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    blob = b'{"svg_paths": ["' + b"a" * (6 * 1024 * 1024) + b'"]}'
    r = client.put(
        "/api/annotations/p1/f1/0",
        content=blob,
        headers={**_auth(key), "Content-Type": "application/json"},
    )
    assert r.status_code == 413


def test_docs_and_openapi_are_disabled(tmp_data_dir):
    client, _, _ = _setup(tmp_data_dir)
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404, path


def test_health_has_no_filesystem_path(tmp_data_dir):
    client, _, _ = _setup(tmp_data_dir)
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert "library_path" not in body
    assert "piece_count" in body


def test_events_refuses_truncated_key(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    cfg.key_path.write_text("aa")  # partially written key file
    r = client.get("/api/events?key=aa")
    assert r.status_code == 401
