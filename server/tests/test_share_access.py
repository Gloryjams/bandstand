"""Share pages run as a different user that must not be able to read the key."""
import os
import sqlite3
import stat

import pytest
from fastapi.testclient import TestClient

from server import config, db, serve_share, share_access

posix = pytest.mark.skipif(os.name != "posix", reason="mode bits are a POSIX concept")


def _mode(path) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


def _cfg(tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path / "data"))
    cfg = config.load()
    db.bootstrap(cfg)
    return cfg


@pytest.mark.parametrize("value, on", [("1", True), ("true", True), ("on", True),
                                       ("", False), ("0", False), ("no", False)])
def test_share_pages_are_off_unless_switched_on(monkeypatch, value, on):
    monkeypatch.setenv("BANDSTAND_SHARE_PAGES", value)
    assert share_access.enabled() is on


@posix
def test_the_layout_gives_the_group_the_library_and_never_the_key(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    os.chmod(cfg.data_dir, 0o700)
    os.chmod(cfg.key_path, 0o644)  # as if a restore had loosened it
    (cfg.data_dir / "backups").mkdir(exist_ok=True)
    access = share_access.ShareAccess(cfg)
    access.start()
    try:
        assert _mode(cfg.key_path) == 0o600
        assert _mode(cfg.data_dir) == 0o750          # look, do not create or delete
        assert _mode(cfg.db_path) == 0o640           # read, do not write
        assert _mode(f"{cfg.db_path}-wal") == 0o640
        assert _mode(f"{cfg.db_path}-shm") == 0o660  # readers register themselves here
        assert _mode(cfg.data_dir / ".share-cache") == 0o770
        assert _mode(cfg.data_dir / "backups") == 0o700
        # No "other" access anywhere at the top of the folder.
        for entry in cfg.data_dir.iterdir():
            if entry.name in {"library", "thumbs"}:
                continue
            assert _mode(entry) & 0o007 == 0, entry.name
    finally:
        access.stop()


@posix
def test_the_database_files_stay_in_place_while_the_server_runs(tmp_path, monkeypatch):
    # The share user may not create files in the data folder, so -wal and -shm must
    # already be there whenever it opens the database.
    cfg = _cfg(tmp_path, monkeypatch)
    access = share_access.ShareAccess(cfg)
    access.start()
    try:
        for _ in range(3):  # other connections come and go, as they do per request
            conn = db.connect(cfg.db_path)
            conn.execute("SELECT COUNT(*) FROM pieces").fetchone()
            conn.close()
            assert os.path.exists(f"{cfg.db_path}-wal")
            assert os.path.exists(f"{cfg.db_path}-shm")
        reader = db.connect_ro(cfg.db_path)
        assert reader.execute("SELECT COUNT(*) FROM shares").fetchone()[0] == 0
        with pytest.raises(sqlite3.OperationalError):
            reader.execute("DELETE FROM shares")
        reader.close()
    finally:
        access.stop()


def test_the_server_only_changes_permissions_when_asked(tmp_data_dir, monkeypatch):
    import asyncio

    from server.main import build_app, lifespan
    os.chmod(tmp_data_dir, 0o700)
    monkeypatch.delenv("BANDSTAND_SHARE_PAGES", raising=False)

    async def run():
        async with lifespan(build_app()):
            return _mode(tmp_data_dir), (tmp_data_dir / ".share-cache").exists()

    assert asyncio.run(run()) == (0o700, False)
    monkeypatch.setenv("BANDSTAND_SHARE_PAGES", "1")
    if os.name == "posix":
        assert asyncio.run(run()) == (0o750, True)


@posix
def test_switching_share_pages_off_closes_the_folder_again(tmp_data_dir, monkeypatch):
    import asyncio

    from server.main import build_app, lifespan

    async def run():
        async with lifespan(build_app()):
            return _mode(tmp_data_dir)

    monkeypatch.setenv("BANDSTAND_SHARE_PAGES", "1")
    assert asyncio.run(run()) == 0o750
    monkeypatch.setenv("BANDSTAND_SHARE_PAGES", "0")
    assert asyncio.run(run()) == 0o700


@posix
@pytest.mark.parametrize("mode", [0o755, 0o770, 0o711])
def test_a_folder_with_permissions_somebody_chose_is_left_alone(tmp_path, monkeypatch, mode):
    cfg = _cfg(tmp_path, monkeypatch)
    (cfg.data_dir / ".share-cache").mkdir()  # share pages run here, as the same user
    os.chmod(cfg.data_dir, mode)
    assert share_access.close_again(cfg) is False
    assert _mode(cfg.data_dir) == mode


@posix
def test_a_folder_that_never_had_share_pages_is_left_alone(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    os.chmod(cfg.data_dir, 0o750)
    assert share_access.close_again(cfg) is False
    assert _mode(cfg.data_dir) == 0o750


def test_the_share_process_explains_a_library_it_cannot_see(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path / "nothing-here"))
    started = []
    monkeypatch.setattr("uvicorn.run", lambda *a, **k: started.append(1))
    assert serve_share.main() == 1
    err = capsys.readouterr().err
    assert err.startswith("Cannot start: The share pages cannot see the library")
    assert "BANDSTAND_SHARE_PAGES=1" in err
    assert "Traceback" not in err
    assert started == []
    assert not (tmp_path / "nothing-here").exists(), "the share process created a folder"


def test_the_share_process_never_logs_requests_and_warns_about_a_readable_key(
    tmp_path, monkeypatch, capsys
):
    cfg = _cfg(tmp_path, monkeypatch)
    monkeypatch.setenv("BANDSTAND_ACCESS_LOG", "1")  # has no effect here, on purpose
    monkeypatch.setenv("BANDSTAND_LOG_LEVEL", "trace")
    monkeypatch.setenv("BANDSTAND_HOST", "0.0.0.0")
    seen: dict = {}
    monkeypatch.setattr("uvicorn.run", lambda *a, **k: seen.update(k, target=a[0]))

    assert serve_share.main() == 0

    assert seen["target"] == "server.public:app"
    assert seen["access_log"] is False
    assert seen["log_level"] == "info"
    assert (seen["host"], seen["port"]) == ("0.0.0.0", 7810)
    out = capsys.readouterr().out
    # The tests run as one user, so the key IS readable here, which is exactly the
    # situation the warning exists for.
    assert "WARNING: this process can read the director key" in out
    assert cfg.key_path.read_text().strip() not in out


def test_the_share_port_can_be_changed_and_a_bad_one_is_explained(monkeypatch, capsys, tmp_path):
    _cfg(tmp_path, monkeypatch)
    monkeypatch.setenv("BANDSTAND_SHARE_PORT", "7811")
    assert serve_share.port() == 7811
    monkeypatch.setenv("BANDSTAND_SHARE_PORT", "share")
    monkeypatch.setattr("uvicorn.run", lambda *a, **k: pytest.fail("started"))
    assert serve_share.main() == 1
    assert "BANDSTAND_SHARE_PORT" in capsys.readouterr().err


def test_share_pages_have_a_health_address_that_says_nothing(tmp_data_dir):
    from server.public import build_public_app
    cfg = config.load()
    db.bootstrap(cfg)
    client = TestClient(build_public_app(), raise_server_exceptions=False)
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert r.headers["cache-control"] == "no-store"
    # The main app's health address does not exist here.
    assert client.get("/api/health").status_code == 404


def test_share_health_fails_when_the_library_cannot_be_read(tmp_path, monkeypatch):
    from server.public import build_public_app
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path / "gone"))
    client = TestClient(build_public_app(), raise_server_exceptions=False)
    r = client.get("/health")
    assert r.status_code == 503
    assert r.json() == {"ok": False}
    assert str(tmp_path) not in r.text
