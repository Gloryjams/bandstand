from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from server import auth, config, db


def _make_app(tmp_data_dir):
    cfg = config.load()
    db.bootstrap(cfg)
    app = FastAPI()

    @app.get("/secret", dependencies=[Depends(auth.require_key)])
    def secret():
        return {"ok": True}

    return app, cfg


def test_missing_header_returns_401(tmp_data_dir):
    app, _ = _make_app(tmp_data_dir)
    client = TestClient(app)
    r = client.get("/secret")
    assert r.status_code == 401


def test_wrong_key_returns_401(tmp_data_dir):
    app, _ = _make_app(tmp_data_dir)
    client = TestClient(app)
    r = client.get("/secret", headers={"X-Bandstand-Key": "wrong"})
    assert r.status_code == 401


def test_correct_key_returns_200(tmp_data_dir):
    app, cfg = _make_app(tmp_data_dir)
    key = cfg.key_path.read_text().strip()
    client = TestClient(app)
    r = client.get("/secret", headers={"X-Bandstand-Key": key})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_truncated_key_file_refuses_to_authenticate(tmp_data_dir):
    # A short/corrupt .key (e.g. a partial Syncthing write) must not become a
    # guessable password — the server should refuse it rather than trust a weak key.
    app, cfg = _make_app(tmp_data_dir)
    cfg.key_path.write_text("abc")
    client = TestClient(app)
    r = client.get("/secret", headers={"X-Bandstand-Key": "abc"})
    assert r.status_code != 200
