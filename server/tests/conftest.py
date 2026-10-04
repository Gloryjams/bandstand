from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _a_configured_share_address(monkeypatch):
    """Share links need an address guests can open, and there is no default. Tests
    that are about something else get one; tests about a server WITHOUT one remove
    the variable themselves."""
    monkeypatch.setenv("BANDSTAND_PUBLIC_BASE", "https://share.test")
    # Never inherit these from the shell that runs the tests.
    monkeypatch.delenv("BANDSTAND_SHARE_PAGES", raising=False)
    monkeypatch.delenv("BANDSTAND_HEALTH_URL", raising=False)


@pytest.fixture
def tmp_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    (tmp_path / "library").mkdir()
    (tmp_path / "thumbs").mkdir()
    return tmp_path


@pytest.fixture
def conn(tmp_data_dir):
    from server import db
    c = db.connect(tmp_data_dir / "library.db")
    db.run_migrations(c, Path(__file__).parent.parent / "migrations")
    yield c
    c.close()
