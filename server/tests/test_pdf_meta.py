from pathlib import Path

import pytest

from server.ingest import pdf_meta

FIXTURES = Path(__file__).parent / "fixtures"


def test_page_count_three():
    info = pdf_meta.read(FIXTURES / "three_page_titled.pdf")
    assert info.page_count == 3


def test_title_extracted():
    info = pdf_meta.read(FIXTURES / "three_page_titled.pdf")
    assert info.title == "Take Five"


def test_author_extracted():
    info = pdf_meta.read(FIXTURES / "three_page_titled.pdf")
    assert info.author == "Paul Desmond"


def test_missing_title_is_none():
    info = pdf_meta.read(FIXTURES / "one_page_untitled.pdf")
    assert info.title is None
    assert info.author is None
    assert info.page_count == 1


def test_corrupt_pdf_raises(tmp_path):
    bad = tmp_path / "broken.pdf"
    bad.write_bytes(b"not a pdf")
    with pytest.raises(pdf_meta.PdfReadError):
        pdf_meta.read(bad)


def test_render_thumbnail_writes_png(tmp_path):
    out = tmp_path / "thumb.png"
    pdf_meta.render_thumbnail(FIXTURES / "three_page_titled.pdf", out, max_width=200)
    assert out.exists()
    from PIL import Image
    img = Image.open(out)
    assert img.format == "PNG"
    assert img.width <= 200


def test_empty_pdf_raises(tmp_path):
    empty = tmp_path / "empty.pdf"
    empty.write_bytes(b"")
    with pytest.raises(pdf_meta.PdfReadError):
        pdf_meta.read(empty)


def test_render_thumbnail_on_corrupt_pdf_raises_and_writes_nothing(tmp_path):
    bad = tmp_path / "broken.pdf"
    bad.write_bytes(b"not a pdf")
    out = tmp_path / "thumbs" / "broken.png"
    with pytest.raises(pdf_meta.PdfReadError):
        pdf_meta.render_thumbnail(bad, out)
    assert not out.exists()


def test_render_thumbnail_on_empty_pdf_raises(tmp_path):
    empty = tmp_path / "empty.pdf"
    empty.write_bytes(b"")
    with pytest.raises(pdf_meta.PdfReadError):
        pdf_meta.render_thumbnail(empty, tmp_path / "empty.png")


def test_read_missing_file_stays_os_error(tmp_path):
    # Disk trouble is the server's problem: it must not be dressed up as a bad file.
    with pytest.raises(OSError):
        pdf_meta.read(tmp_path / "gone.pdf")


def test_render_thumbnail_missing_file_is_not_a_bad_file(tmp_path):
    # PyMuPDF has its own FileNotFoundError (a RuntimeError). A vanished file must
    # not come back as PdfReadError, which the upload route answers with a 400.
    with pytest.raises(Exception) as info:
        pdf_meta.render_thumbnail(tmp_path / "gone.pdf", tmp_path / "gone.png")
    assert not isinstance(info.value, pdf_meta.PdfReadError)
    assert not (tmp_path / "gone.png").exists()
