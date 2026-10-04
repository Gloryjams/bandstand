from pathlib import Path

from server.ingest import folder_convention as fc


def test_flat_pdf_in_root_is_flat_piece(tmp_path):
    library = tmp_path / "library"
    library.mkdir()
    pdf = library / "Take Five.pdf"
    pdf.write_bytes(b"")
    cls = fc.classify(library, pdf)
    assert cls.kind == "flat"
    assert cls.piece_key == "Take Five"
    assert cls.title_default == "Take Five"


def test_pdf_in_subfolder_is_multifile(tmp_path):
    library = tmp_path / "library"
    folder = library / "Misty"
    folder.mkdir(parents=True)
    pdf = folder / "01-leadsheet.pdf"
    pdf.write_bytes(b"")
    cls = fc.classify(library, pdf)
    assert cls.kind == "multi"
    assert cls.piece_key == "Misty"
    assert cls.title_default == "Misty"
    assert cls.numeric_prefix == 1


def test_no_numeric_prefix(tmp_path):
    library = tmp_path / "library"
    folder = library / "Naima"
    folder.mkdir(parents=True)
    pdf = folder / "leadsheet.pdf"
    pdf.write_bytes(b"")
    cls = fc.classify(library, pdf)
    assert cls.kind == "multi"
    assert cls.numeric_prefix is None


def test_audio_extensions_recognized(tmp_path):
    library = tmp_path / "library"
    folder = library / "Misty"
    folder.mkdir(parents=True)
    mp3 = folder / "backing.mp3"
    mp3.write_bytes(b"")
    cls = fc.classify(library, mp3)
    assert cls.kind == "multi"
    assert cls.media == "audio"


def test_unknown_extension_classified_ignore(tmp_path):
    library = tmp_path / "library"
    folder = library / "Misty"
    folder.mkdir(parents=True)
    txt = folder / "notes.txt"
    txt.write_bytes(b"")
    cls = fc.classify(library, txt)
    assert cls.kind == "ignore"
