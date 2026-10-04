"""The container entry point: first-boot key handling and what it prints."""
import os
import stat

import pytest

from server import config, serve


def _cfg(tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path / "data"))
    return config.load()


def test_first_boot_creates_a_private_key_and_prints_only_its_path(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    lines: list[str] = []
    created = serve.prepare(cfg, lines.append)
    assert created is True
    key = cfg.key_path.read_text().strip()
    assert len(key) == 64
    printed = "\n".join(lines)
    assert str(cfg.key_path) in printed
    assert key not in printed
    # Not even a recognisable fragment of it.
    assert key[:12] not in printed and key[-12:] not in printed
    if os.name == "posix":
        assert stat.S_IMODE(cfg.key_path.stat().st_mode) == 0o600


def test_second_boot_reuses_the_key_and_the_database(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    serve.prepare(cfg, lambda _line: None)
    key = cfg.key_path.read_text()
    from server import db
    conn = db.connect(cfg.db_path)
    conn.execute(
        "INSERT INTO pieces (id, title, page_count, added_at, updated_at) "
        "VALUES ('p1', 'Take Five', 1, 1, 1)"
    )
    conn.close()

    lines: list[str] = []
    created = serve.prepare(cfg, lines.append)
    assert created is False
    assert cfg.key_path.read_text() == key
    conn = db.connect(cfg.db_path)
    assert conn.execute("SELECT title FROM pieces").fetchone()["title"] == "Take Five"
    conn.close()
    printed = "\n".join(lines)
    assert "First start" not in printed
    assert key.strip() not in printed


def test_a_damaged_key_stops_the_boot_without_echoing_it(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    cfg.data_dir.mkdir(parents=True)
    cfg.key_path.write_text("short-secret")
    with pytest.raises(serve.KeyProblem) as err:
        serve.prepare(cfg, lambda _line: None)
    assert str(cfg.key_path) in str(err.value)
    assert "short-secret" not in str(err.value)
    # A damaged key is never silently replaced: that would unpair every device.
    assert cfg.key_path.read_text() == "short-secret"


@pytest.mark.skipif(os.name != "posix", reason="mode bits are a POSIX concept")
def test_a_loosely_permissioned_key_is_tightened(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, monkeypatch)
    serve.prepare(cfg, lambda _line: None)
    os.chmod(cfg.key_path, 0o644)
    lines: list[str] = []
    serve.prepare(cfg, lines.append)
    assert stat.S_IMODE(cfg.key_path.stat().st_mode) == 0o600
    assert any("tightened" in line for line in lines)


def test_main_reports_a_key_problem_and_exits_nonzero(tmp_path, monkeypatch, capsys):
    cfg = _cfg(tmp_path, monkeypatch)
    cfg.data_dir.mkdir(parents=True)
    cfg.key_path.write_text("short-secret")
    assert serve.main() == 1
    captured = capsys.readouterr()
    assert "Cannot start" in captured.err
    assert "short-secret" not in captured.err + captured.out


def test_access_log_is_off_unless_asked_for(tmp_path, monkeypatch):
    # The live-update stream authenticates with ?key= in the URL, and the access log
    # records the URL. Default off, or every container log holds the director key.
    cfg = _cfg(tmp_path, monkeypatch)
    seen: dict = {}

    import uvicorn
    monkeypatch.setattr(uvicorn, "run", lambda *a, **kw: seen.update(kw, target=a[0]))

    monkeypatch.delenv("BANDSTAND_ACCESS_LOG", raising=False)
    monkeypatch.delenv("BANDSTAND_HOST", raising=False)
    assert serve.main() == 0
    assert seen["access_log"] is False
    assert seen["host"] == "127.0.0.1"
    assert seen["port"] == cfg.port
    assert seen["target"] == "server.main:app"

    monkeypatch.setenv("BANDSTAND_ACCESS_LOG", "1")
    monkeypatch.setenv("BANDSTAND_HOST", "0.0.0.0")
    assert serve.main() == 0
    assert seen["access_log"] is True
    assert seen["host"] == "0.0.0.0"


@pytest.mark.skipif(
    os.name != "posix" or os.geteuid() == 0, reason="needs POSIX permissions and a non-root user"
)
def test_an_unreadable_key_is_explained_not_dumped_as_a_traceback(tmp_path, monkeypatch, capsys):
    # What a restore with the wrong file ownership looks like from inside the server.
    cfg = _cfg(tmp_path, monkeypatch)
    serve.prepare(cfg, lambda _line: None)
    key = cfg.key_path.read_text().strip()
    os.chmod(cfg.key_path, 0o000)
    try:
        assert serve.main() == 1
    finally:
        os.chmod(cfg.key_path, 0o600)
    err = capsys.readouterr().err
    assert "Cannot start" in err
    assert "data folder" in err and "Restore a backup" in err
    assert "Traceback" not in err
    assert key not in err


@pytest.mark.skipif(
    os.name != "posix" or os.geteuid() == 0, reason="needs POSIX permissions and a non-root user"
)
def test_an_unwritable_data_folder_is_explained(tmp_path, monkeypatch, capsys):
    cfg = _cfg(tmp_path, monkeypatch)
    cfg.data_dir.mkdir(parents=True)
    os.chmod(cfg.data_dir, 0o500)
    try:
        assert serve.main() == 1
    finally:
        os.chmod(cfg.data_dir, 0o700)
    err = capsys.readouterr().err
    assert "Cannot start" in err and "data folder" in err
    assert "Traceback" not in err
