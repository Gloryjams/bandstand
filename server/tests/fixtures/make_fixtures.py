"""Run once to generate test fixtures. Idempotent — overwrites."""
from pathlib import Path

from pypdf import PdfWriter

HERE = Path(__file__).parent


def make_pdf(name: str, page_count: int, title: str | None, author: str | None) -> Path:
    writer = PdfWriter()
    for _ in range(page_count):
        writer.add_blank_page(width=612, height=792)
    meta = {}
    if title:
        meta["/Title"] = title
    if author:
        meta["/Author"] = author
    if meta:
        writer.add_metadata(meta)
    out = HERE / name
    with open(out, "wb") as f:
        writer.write(f)
    return out


import subprocess
import wave


def make_silent_mp3():
    wav = HERE / "silent.wav"
    with wave.open(str(wav), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes(b"\x00\x00" * 44100)
    mp3 = HERE / "silent.mp3"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(wav), "-codec:a", "libmp3lame", str(mp3)],
            check=True, capture_output=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        # Fall back: pydub via pip if available
        try:
            from pydub import AudioSegment
            seg = AudioSegment.silent(duration=1000)
            seg.export(str(mp3), format="mp3")
        except Exception:
            print("WARN: could not generate silent.mp3 — install ffmpeg or pydub")
    finally:
        wav.unlink(missing_ok=True)


if __name__ == "__main__":
    make_pdf("three_page_titled.pdf", 3, "Take Five", "Paul Desmond")
    make_pdf("one_page_untitled.pdf", 1, None, None)
    make_pdf("five_page.pdf", 5, "Misty", "Erroll Garner")
    make_silent_mp3()
    print("fixtures written")
