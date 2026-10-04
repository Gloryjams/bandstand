from pathlib import Path

from fastapi.testclient import TestClient

from server import config, db

FIXTURES = Path(__file__).parent / "fixtures"


def _setup(tmp_data_dir):
    from server.main import build_app
    cfg = config.load()
    db.bootstrap(cfg)
    app = build_app()
    key = cfg.key_path.read_text().strip()
    return TestClient(app), key, cfg


def test_upload_creates_piece_and_file(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    pdf_bytes = (FIXTURES / "three_page_titled.pdf").read_bytes()
    files = {"file": ("Take Five.pdf", pdf_bytes, "application/pdf")}
    r = client.post(
        "/api/upload-piece",
        headers={"X-Bandstand-Key": key},
        files=files,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["piece_id"] is not None

    # File on disk.
    assert (cfg.library_dir / "Take Five.pdf").exists()

    conn = db.connect(cfg.db_path)
    try:
        pieces = conn.execute("SELECT * FROM pieces").fetchall()
        files_rows = conn.execute("SELECT * FROM files").fetchall()
        assert len(pieces) == 1
        assert pieces[0]["title"] == "Take Five"
        assert len(files_rows) == 1
    finally:
        conn.close()


def test_upload_conflict_when_filename_exists(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    pdf_bytes = (FIXTURES / "three_page_titled.pdf").read_bytes()
    files = {"file": ("Take Five.pdf", pdf_bytes, "application/pdf")}
    r1 = client.post(
        "/api/upload-piece",
        headers={"X-Bandstand-Key": key},
        files=files,
    )
    assert r1.status_code == 200
    files2 = {"file": ("Take Five.pdf", pdf_bytes, "application/pdf")}
    r2 = client.post(
        "/api/upload-piece",
        headers={"X-Bandstand-Key": key},
        files=files2,
    )
    assert r2.status_code == 409


def test_upload_requires_auth(tmp_data_dir):
    client, _, _ = _setup(tmp_data_dir)
    pdf_bytes = (FIXTURES / "three_page_titled.pdf").read_bytes()
    files = {"file": ("Take Five.pdf", pdf_bytes, "application/pdf")}
    r = client.post("/api/upload-piece", files=files)
    assert r.status_code == 401


def test_upload_filename_cannot_escape_library(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    pdf_bytes = (FIXTURES / "three_page_titled.pdf").read_bytes()
    # One level up lands in the (controlled) data dir, not the real temp tree.
    files = {"file": ("../evil.pdf", pdf_bytes, "application/pdf")}
    r = client.post("/api/upload-piece", headers={"X-Bandstand-Key": key}, files=files)
    # No file may be written outside the library dir.
    assert not (cfg.library_dir.parent / "evil.pdf").exists()
    # The directory-stripped basename is what lands (safely) inside the library.
    assert r.status_code == 200
    assert (cfg.library_dir / "evil.pdf").exists()


def test_upload_rejects_non_media_extension(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    files = {"file": ("evil.bat", b"echo pwned", "application/octet-stream")}
    r = client.post("/api/upload-piece", headers={"X-Bandstand-Key": key}, files=files)
    assert r.status_code == 400
    assert not (cfg.library_dir / "evil.bat").exists()


def _post(client, key, name, data, ctype="application/pdf", **form):
    return client.post(
        "/api/upload-piece",
        headers={"X-Bandstand-Key": key},
        files={"file": (name, data, ctype)},
        data=form,
    )


def _library_is_untouched(cfg):
    leftovers = [p for p in cfg.library_dir.rglob("*")]
    thumbs = [p for p in cfg.thumbs_dir.rglob("*")]
    conn = db.connect(cfg.db_path)
    try:
        pieces = conn.execute("SELECT COUNT(*) AS n FROM pieces").fetchone()["n"]
        files = conn.execute("SELECT COUNT(*) AS n FROM files").fetchone()["n"]
    finally:
        conn.close()
    return leftovers == [] and thumbs == [] and pieces == 0 and files == 0


def test_upload_fake_pdf_answers_400_and_leaves_nothing_behind(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    r = _post(client, key, "Not Really.pdf", b"this is a text file wearing a .pdf name")
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "PDF" in detail
    assert "—" not in detail and "–" not in detail
    assert _library_is_untouched(cfg)
    # The name is free again: a real PDF under the same name goes in.
    good = (FIXTURES / "three_page_titled.pdf").read_bytes()
    assert _post(client, key, "Not Really.pdf", good).status_code == 200


def test_upload_truncated_pdf_answers_400(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    good = (FIXTURES / "three_page_titled.pdf").read_bytes()
    r = _post(client, key, "Cut Short.pdf", good[: len(good) // 2])
    assert r.status_code == 400
    assert _library_is_untouched(cfg)


def test_upload_empty_file_answers_400(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    r = _post(client, key, "Nothing.pdf", b"")
    assert r.status_code == 400
    assert "empty" in r.json()["detail"].lower()
    assert _library_is_untouched(cfg)


def test_upload_empty_image_answers_400(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    r = _post(client, key, "Nothing.png", b"", "image/png")
    assert r.status_code == 400
    assert _library_is_untouched(cfg)


def test_upload_huge_file_answers_413(tmp_data_dir, monkeypatch):
    monkeypatch.setenv("BANDSTAND_MAX_UPLOAD_MB", "1")
    client, key, cfg = _setup(tmp_data_dir)
    r = _post(client, key, "Huge.pdf", b"%PDF-1.4 " + b"\0" * (2 * 1024 * 1024))
    assert r.status_code == 413
    assert _library_is_untouched(cfg)


def test_upload_fake_pdf_into_placeholder_keeps_the_placeholder(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "INSERT INTO pieces (id, title, page_count, added_at, updated_at, is_placeholder) "
            "VALUES ('PH1', 'Waiting', 0, 1, 1, 1)"
        )
        conn.commit()
    finally:
        conn.close()
    r = _post(client, key, "Not Really.pdf", b"nope", piece_id="PH1")
    assert r.status_code == 400
    # The folder made for the placeholder's chart must not linger either.
    assert not (cfg.library_dir / "PH1").exists()
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT is_placeholder FROM pieces WHERE id='PH1'").fetchone()
        assert row["is_placeholder"] == 1
        assert conn.execute("SELECT COUNT(*) AS n FROM files").fetchone()["n"] == 0
    finally:
        conn.close()
