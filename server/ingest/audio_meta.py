from dataclasses import dataclass
from pathlib import Path

import mutagen


@dataclass(frozen=True)
class AudioInfo:
    duration_ms: int | None


def read(path: Path) -> AudioInfo:
    try:
        f = mutagen.File(str(path))
        if f is None or not getattr(f, "info", None):
            return AudioInfo(duration_ms=None)
        return AudioInfo(duration_ms=int(f.info.length * 1000))
    except Exception as exc:
        print(f"[audio_meta] {path}: {exc}")
        return AudioInfo(duration_ms=None)
