from dataclasses import dataclass
from pathlib import Path

import pymupdf
from pypdf import PdfReader
from pypdf.errors import PdfReadError as _PypdfReadError


class PdfReadError(Exception):
    """The file is not a PDF that can be opened: wrong bytes under a .pdf name, an
    empty file, a download cut short, or a document with no pages. Callers answer
    this with a 400, never a 500: the file is at fault, not the server."""


# PyMuPDF raises its own FileNotFoundError (a RuntimeError, not an OSError) for a
# file that is not there; a vanished file is still the server's problem.
_PYMUPDF_MISSING = getattr(pymupdf, "FileNotFoundError", ())


def _is_environment_error(exc: BaseException) -> bool:
    # Disk and memory trouble is the server's problem and must stay a server error.
    return isinstance(exc, (OSError, MemoryError, _PYMUPDF_MISSING))


@dataclass(frozen=True)
class PdfInfo:
    page_count: int
    title: str | None
    author: str | None


def read(path: Path) -> PdfInfo:
    try:
        reader = PdfReader(str(path))
        meta = reader.metadata or {}
        title = meta.get("/Title")
        author = meta.get("/Author")
        return PdfInfo(
            page_count=len(reader.pages),
            title=str(title) if title else None,
            author=str(author) if author else None,
        )
    except _PypdfReadError as exc:
        raise PdfReadError(str(exc)) from exc
    except Exception as exc:
        # pypdf reports some broken files with plain ValueError/TypeError/KeyError
        # and the like rather than its own error class. Whatever the flavour, the
        # file could not be read as a PDF.
        if _is_environment_error(exc):
            raise
        raise PdfReadError(f"{type(exc).__name__}: {exc}") from exc


def render_thumbnail(pdf_path: Path, out_path: Path, max_width: int = 400) -> None:
    try:
        doc = pymupdf.open(str(pdf_path))
    except Exception as exc:
        # pymupdf.FileDataError (a RuntimeError) for bytes that are not a PDF.
        if _is_environment_error(exc):
            raise
        raise PdfReadError(f"{type(exc).__name__}: {exc}") from exc
    try:
        _render_first_page(doc, out_path, max_width)
    except Exception as exc:
        # A render that failed part way must not leave a half-written PNG behind.
        out_path.unlink(missing_ok=True)
        if _is_environment_error(exc):
            raise
        raise PdfReadError(f"{type(exc).__name__}: {exc}") from exc
    finally:
        doc.close()


def _render_first_page(doc, out_path: Path, max_width: int) -> None:
    if doc.page_count < 1:
        raise IndexError("PDF has no pages")
    page = doc[0]
    rect = page.rect
    scale = max_width / rect.width if rect.width > max_width else 1.0
    # Clamp total pixels: a crafted page (say 200 x 2,000,000 pt) at scale 1.0
    # would allocate a multi-GB pixmap. Same bound public.py uses for renders.
    max_pixels = 4_000_000
    if (rect.width * scale) * (rect.height * scale) > max_pixels:
        import math
        scale = math.sqrt(max_pixels / (rect.width * rect.height))
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    pix.save(str(out_path))
