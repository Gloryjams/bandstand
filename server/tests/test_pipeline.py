import shutil
from pathlib import Path

from server import config, db
from server.ingest import pipeline

FIXTURES = Path(__file__).parent / "fixtures"


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    cfg = config.load()
    db.bootstrap(cfg)
    return cfg


def test_ingest_flat_pdf_creates_piece_and_file(tmp_path, monkeypatch):
    cfg = _setup(tmp_path, monkeypatch)
    src = FIXTURES / "three_page_titled.pdf"
    target = cfg.library_dir / "Take Five.pdf"
    shutil.copy(src, target)
    pipeline.ingest_path(cfg, target)
    conn = db.connect(cfg.db_path)
    pieces = conn.execute("SELECT * FROM pieces").fetchall()
    assert len(pieces) == 1
    assert pieces[0]["title"] == "Take Five"
    assert pieces[0]["composer"] == "Paul Desmond"
    assert pieces[0]["page_count"] == 3
    files = conn.execute("SELECT * FROM files").fetchall()
    assert len(files) == 1
    assert files[0]["kind"] == "pdf"
    assert files[0]["page_count"] == 3
    conn.close()


def test_ingest_dedupes_by_content_hash(tmp_path, monkeypatch):
    cfg = _setup(tmp_path, monkeypatch)
    src = FIXTURES / "three_page_titled.pdf"
    a = cfg.library_dir / "Take Five.pdf"
    b = cfg.library_dir / "Take Five copy.pdf"
    shutil.copy(src, a)
    shutil.copy(src, b)
    pipeline.ingest_path(cfg, a)
    pipeline.ingest_path(cfg, b)
    conn = db.connect(cfg.db_path)
    pieces = conn.execute("SELECT * FROM pieces").fetchall()
    files = conn.execute("SELECT * FROM files").fetchall()
    assert len(pieces) == 1
    assert len(files) == 1
    conn.close()


def test_ingest_multifile_folder(tmp_path, monkeypatch):
    cfg = _setup(tmp_path, monkeypatch)
    folder = cfg.library_dir / "Misty"
    folder.mkdir()
    shutil.copy(FIXTURES / "five_page.pdf", folder / "01-leadsheet.pdf")
    shutil.copy(FIXTURES / "three_page_titled.pdf", folder / "02-chord-chart.pdf")
    pipeline.ingest_path(cfg, folder / "01-leadsheet.pdf")
    pipeline.ingest_path(cfg, folder / "02-chord-chart.pdf")
    conn = db.connect(cfg.db_path)
    pieces = conn.execute("SELECT * FROM pieces").fetchall()
    files = conn.execute("SELECT * FROM files ORDER BY ordinal").fetchall()
    assert len(pieces) == 1
    assert pieces[0]["title"] == "Misty"
    assert pieces[0]["page_count"] == 8
    assert len(files) == 2
    assert files[0]["ordinal"] == 1
    assert files[1]["ordinal"] == 2
    conn.close()


def test_ingest_audio_attaches_to_existing_piece(tmp_path, monkeypatch):
    cfg = _setup(tmp_path, monkeypatch)
    folder = cfg.library_dir / "Misty"
    folder.mkdir()
    shutil.copy(FIXTURES / "five_page.pdf", folder / "leadsheet.pdf")
    shutil.copy(FIXTURES / "silent.mp3", folder / "backing.mp3")
    pipeline.ingest_path(cfg, folder / "leadsheet.pdf")
    pipeline.ingest_path(cfg, folder / "backing.mp3")
    conn = db.connect(cfg.db_path)
    pieces = conn.execute("SELECT * FROM pieces").fetchall()
    audio = conn.execute("SELECT * FROM audio_tracks").fetchall()
    assert len(pieces) == 1
    assert len(audio) == 1
    assert audio[0]["filename"].endswith("backing.mp3")
    assert audio[0]["duration_ms"] is not None
    conn.close()


def test_ingest_thumbnail_written(tmp_path, monkeypatch):
    cfg = _setup(tmp_path, monkeypatch)
    target = cfg.library_dir / "Take Five.pdf"
    shutil.copy(FIXTURES / "three_page_titled.pdf", target)
    pipeline.ingest_path(cfg, target)
    thumbs = list(cfg.thumbs_dir.glob("*.png"))
    assert len(thumbs) == 1


def test_rename_updates_filename_in_place(tmp_path, monkeypatch):
    cfg = _setup(tmp_path, monkeypatch)
    src = FIXTURES / "three_page_titled.pdf"
    a = cfg.library_dir / "Take Five.pdf"
    shutil.copy(src, a)
    pipeline.ingest_path(cfg, a)
    new_path = cfg.library_dir / "Take 5.pdf"
    a.rename(new_path)
    pipeline.ingest_path(cfg, new_path)
    conn = db.connect(cfg.db_path)
    files = conn.execute("SELECT filename FROM files").fetchall()
    assert len(files) == 1
    assert files[0]["filename"].endswith("Take 5.pdf")
    conn.close()
