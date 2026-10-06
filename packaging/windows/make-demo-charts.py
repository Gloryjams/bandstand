"""Generate Bandstand's public demo library. Contains no personal source material."""
from __future__ import annotations

import math
import struct
import sys
import wave
from pathlib import Path

import pymupdf as fitz

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / ".tmp" / "library"
PAGE = (612, 792)
# Bonito Pop palette, design canon tokens/bonito.css.
INK = (44 / 255, 34 / 255, 51 / 255)
ACCENT = (229 / 255, 66 / 255, 127 / 255)
MUTED = (110 / 255, 99 / 255, 121 / 255)


def page(doc: fitz.Document, title: str, subtitle: str = "") -> fitz.Page:
    p = doc.new_page(width=PAGE[0], height=PAGE[1])
    p.draw_rect(p.rect, color=(1, 224 / 255, 240 / 255), fill=(1, 245 / 255, 249 / 255))
    p.insert_text((54, 64), title, fontsize=25, fontname="hebo", color=INK)
    if subtitle:
        p.insert_text((55, 86), subtitle, fontsize=10, fontname="heit", color=MUTED)
    p.draw_line((54, 101), (558, 101), color=ACCENT, width=2)
    return p


def footer(p: fitz.Page) -> None:
    p.draw_line((54, 744), (558, 744), color=(1, 224 / 255, 240 / 255), width=0.7)
    p.insert_text((54, 762), "Bandstand demo library", fontsize=8, color=MUTED)


def section(p: fitz.Page, y: float, label: str, bars: list[str]) -> float:
    p.insert_text((54, y + 18), label, fontsize=12, fontname="hebo", color=ACCENT)
    x0, x1 = 100, 558
    width = (x1 - x0) / 4
    p.draw_line((x0, y), (x1, y), color=INK, width=1.2)
    p.draw_line((x0, y + 43), (x1, y + 43), color=INK, width=1.2)
    for i in range(5):
        x = x0 + i * width
        p.draw_line((x, y), (x, y + 43), color=INK, width=1.2 if i in (0, 4) else 0.7)
    for i, chord in enumerate(bars[:4]):
        p.insert_text((x0 + i * width + 13, y + 27), chord, fontsize=15, fontname="hebo", color=INK)
    return y + 58


def save(doc: fitz.Document, path: Path, title: str) -> None:
    doc.set_metadata({"title": title, "author": "Bandstand Demo"})
    doc.save(path, garbage=4, deflate=True)
    doc.close()


def blues() -> None:
    d = fitz.open(); p = page(d, "Demo Blues in F", "Medium shuffle  |  4/4  |  112 bpm")
    y = 145
    for label, bars in [("1", ["F7", "Bb7", "F7", "F7"]), ("5", ["Bb7", "Bb7", "F7", "D7"]), ("9", ["Gm7", "C7", "F7  D7", "Gm7  C7"] )]:
        y = section(p, y, label, bars)
    p.insert_text((100, y + 22), "Head x2  |  Solos  |  Head out", fontsize=11, color=MUTED)
    footer(p); save(d, OUT / "Demo Blues in F.pdf", "Demo Blues in F")


def ballad() -> None:
    d = fitz.open()
    p = page(d, "Midnight Ballad", "AABA  |  Slow swing  |  68 bpm",)
    y = 140
    for label, bars in [("A1", ["Dm9", "G13", "Cmaj7", "A7alt"]), ("", ["Dm9", "G13", "Em7 A7", "Dm7 G7"]), ("A2", ["Dm9", "G13", "Cmaj7", "A7alt"]), ("", ["Dm9", "G13", "C6", "C6"] )]: y = section(p, y, label, bars)
    p.insert_text((54, 690), "Turn page for bridge and final A", fontsize=10, fontname="heit", color=MUTED)
    footer(p)
    p = page(d, "Midnight Ballad", "Page 2  |  Bridge and final A")
    y = 140
    for label, bars in [("B", ["Fmaj7", "Bb13", "Em7", "A7alt"]), ("", ["Dm7", "G7", "Cmaj7", "A7alt"]), ("A3", ["Dm9", "G13", "Cmaj7", "A7alt"]), ("TAG", ["Dm9", "G13", "C6", "C6 (hold)"] )]: y = section(p, y, label, bars)
    footer(p); save(d, OUT / "Midnight Ballad.pdf", "Midnight Ballad")


def groove() -> None:
    folder = OUT / "Groove Etude"; folder.mkdir(parents=True, exist_ok=True)
    d = fitz.open(); p = page(d, "Groove Etude", "Pocket study  |  4/4  |  96 bpm")
    y = 150
    for label, bars in [("VAMP", ["Em9", "Em9", "A13", "A13"]), ("B", ["Cmaj7", "B7#9", "Em9", "Em9"]), ("BREAK", ["Em9", "N.C.", "Em9", "N.C."] )]: y = section(p, y, label, bars)
    p.insert_text((100, y + 26), "Keep the sixteenths even. Sit behind the click.", fontsize=11, color=MUTED)
    footer(p); save(d, folder / "01-chart.pdf", "Groove Etude")
    rate, seconds, bpm = 22050, 60, 96
    beat = 60 / bpm
    frames = bytearray()
    for i in range(rate * seconds):
        t = i / rate; beat_no = int(t / beat); within = t - beat_no * beat
        amp = 0.0
        if within < 0.025:
            freq = 1760 if beat_no % 4 == 0 else 1120
            amp = 0.48 * math.exp(-within * 115) * math.sin(2 * math.pi * freq * within)
        frames += struct.pack("<h", int(max(-1, min(1, amp)) * 32767))
    with wave.open(str(folder / "click-96bpm.wav"), "wb") as w:
        w.setparams((1, 2, rate, 0, "NONE", "not compressed")); w.writeframes(frames)


def segno() -> None:
    d = fitz.open(); p = page(d, "Segno Workout", "Road-map reading  |  4/4  |  120 bpm")
    y = 135
    for label, bars in [("INTRO", ["Am7", "D7", "Gmaj7", "E7"]), ("A   [SEGNO]", ["Am7", "D7", "Gmaj7", "Gmaj7"]), ("B", ["Cmaj7", "Bm7 E7", "Am7", "D7"]), ("CODA", ["Gmaj7", "E7alt", "Am7 D7", "G6"] )]: y = section(p, y, label, bars)
    p.insert_text((100, y + 20), "D.S. al Coda after B on the second pass", fontsize=11, fontname="hebo", color=INK)
    footer(p); save(d, OUT / "Segno Workout.pdf", "Segno Workout")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    blues(); ballad(); groove(); segno()
    print(f"Generated demo charts in {OUT}")
