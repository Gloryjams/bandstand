"""A data folder reached through a symlink (macOS /var is /private/var) must work.

Upload code resolves its target path and then takes it relative to the library
folder; when the configured folder was not resolved too, that raised ValueError
and the upload answered 500."""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import config, db

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def linked_data_dir(tmp_path, monkeypatch):
    real = tmp_path / "real-data"
    (real / "library").mkdir(parents=True)
    (real / "thumbs").mkdir()
    link = tmp_path / "linked-data"
    link.symlink_to(real, target_is_directory=True)
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(link))
    return real.resolve()


def _setup():
    from server.main import build_app
    cfg = config.load()
    db.bootstrap(cfg)
    app = build_app()
    key = cfg.key_path.read_text().strip()
    return TestClient(app), key


def test_config_resolves_a_linked_data_dir(linked_data_dir):
    cfg = config.load()
    assert cfg.data_dir == linked_data_dir
    assert cfg.library_dir == linked_data_dir / "library"


def test_chart_upload_works_through_a_symlink(linked_data_dir):
    client, key = _setup()
    from server.tests.test_api_upload_chart import sample_chart
    r = client.post("/api/upload-chart", headers={"X-Bandstand-Key": key},
                    json={"chart": sample_chart(id="linked-chart")})
    assert r.status_code == 200, r.text
    assert (linked_data_dir / "library" / "linked-chart.saltychart.json").exists()


def test_pdf_upload_works_through_a_symlink(linked_data_dir):
    client, key = _setup()
    pdf = (FIXTURES / "three_page_titled.pdf").read_bytes()
    r = client.post("/api/upload-piece", headers={"X-Bandstand-Key": key},
                    files={"file": ("Linked.pdf", pdf, "application/pdf")})
    assert r.status_code == 200, r.text
    assert (linked_data_dir / "library" / "Linked.pdf").exists()
