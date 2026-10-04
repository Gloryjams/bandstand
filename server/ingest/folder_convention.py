import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

PDF_EXTS = {".pdf"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg"}
CHORDPRO_EXTS = {".cho", ".chordpro", ".crd"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".flac"}

Kind = Literal["flat", "multi", "ignore"]
Media = Literal["pdf", "image", "chordpro", "audio"]

_NUMERIC_PREFIX = re.compile(r"^(\d+)[-_]")


@dataclass(frozen=True)
class Classification:
    kind: Kind
    piece_key: str | None
    title_default: str | None
    media: Media | None
    numeric_prefix: int | None


def _media_for(suffix: str) -> Media | None:
    s = suffix.lower()
    if s in PDF_EXTS:
        return "pdf"
    if s in IMAGE_EXTS:
        return "image"
    if s in CHORDPRO_EXTS:
        return "chordpro"
    if s in AUDIO_EXTS:
        return "audio"
    return None


def _numeric_prefix_of(name: str) -> int | None:
    m = _NUMERIC_PREFIX.match(name)
    return int(m.group(1)) if m else None


def classify(library_root: Path, path: Path) -> Classification:
    media = _media_for(path.suffix)
    if media is None:
        return Classification(
            kind="ignore", piece_key=None, title_default=None,
            media=None, numeric_prefix=None,
        )
    rel = path.relative_to(library_root)
    parts = rel.parts
    if len(parts) == 1:
        if media == "audio":
            return Classification(
                kind="ignore", piece_key=None, title_default=None,
                media=None, numeric_prefix=None,
            )
        return Classification(
            kind="flat",
            piece_key=path.stem,
            title_default=path.stem,
            media=media,
            numeric_prefix=None,
        )
    folder = parts[0]
    return Classification(
        kind="multi",
        piece_key=folder,
        title_default=folder,
        media=media,
        numeric_prefix=_numeric_prefix_of(path.name),
    )
