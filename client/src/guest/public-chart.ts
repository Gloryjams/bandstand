import type {
  ArrangementStep, Bar, Barline, ChartSettings, PublicChart, Section,
} from "../chart/types";

/**
 * Parse the public chart DTO a share link serves.
 *
 * The server's allowlist validates this shape too; this is the client half of that
 * belt-and-braces on the one public surface. The bundle is a standalone page on a
 * stranger's phone, so every field the renderer touches is normalized to the type it
 * expects rather than cast to it. A cast is not enough: `bars: [null]`, a chord that
 * is not a string, or `solos: "Bob"` (a string has a .length but no .join) all throw
 * inside render, and a throw here is a blank screen. Anything unrecognized is dropped,
 * not guessed at. The error boundary above this is the backstop for the rest.
 */

const BARLINES: readonly string[] = [
  "normal", "double", "final", "repeat-start", "repeat-end",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Optional display text: kept only when it is a non-empty string, so the renderer
    never receives an object where it expects a React child. */
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function toBar(v: unknown): Bar {
  if (!isRecord(v)) return { chords: "" };
  const bar: Bar = { chords: str(v.chords) };
  const lyrics = optStr(v.lyrics);
  if (lyrics) bar.lyrics = lyrics;
  if (typeof v.barline === "string" && BARLINES.includes(v.barline)) {
    bar.barline = v.barline as Barline;
  }
  const ending = optStr(v.ending);
  if (ending) bar.ending = ending;
  if (v.sign === "segno" || v.sign === "coda") bar.sign = v.sign;
  const direction = optStr(v.direction);
  if (direction) bar.direction = direction;
  const hits = optStr(v.hits);
  if (hits) bar.hits = hits;
  return bar;
}

/** barsPerRow is either a single count or a per-row pattern like [2,4,4]. */
function toBarsPerRow(v: unknown): number | number[] | undefined {
  const n = optNum(v);
  if (n !== undefined) return n;
  if (Array.isArray(v)) {
    const nums = v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    if (nums.length > 0) return nums;
  }
  return undefined;
}

function toSection(v: Record<string, unknown>): Section {
  const section: Section = {
    id: str(v.id),
    label: str(v.label),
    bars: (v.bars as unknown[]).map(toBar),
  };
  const bpr = toBarsPerRow(v.barsPerRow);
  if (bpr !== undefined) section.barsPerRow = bpr;
  const description = optStr(v.description);
  if (description) section.description = description;
  const hits = optStr(v.hits);
  if (hits) section.hits = hits;
  return section;
}

function toStep(v: Record<string, unknown>): ArrangementStep {
  const step: ArrangementStep = { id: str(v.id), sectionId: str(v.sectionId) };
  const repeats = optNum(v.repeats);
  if (repeats !== undefined) step.repeats = repeats;
  if (v.open === true) step.open = true;
  if (Array.isArray(v.solos)) {
    const solos = v.solos.filter((s): s is string => typeof s === "string" && s !== "");
    if (solos.length > 0) step.solos = solos;
  }
  const hits = optStr(v.hits);
  if (hits) step.hits = hits;
  const note = optStr(v.note);
  if (note) step.note = note;
  return step;
}

function toSettings(v: unknown): ChartSettings {
  const r = isRecord(v) ? v : {};
  return {
    barsPerRow: optNum(r.barsPerRow) ?? 4,
    fontSize: typeof r.fontSize === "string" ? (r.fontSize as ChartSettings["fontSize"]) : "medium",
    showLyrics: r.showLyrics === true,
    onePage: r.onePage === true,
  };
}

export function asPublicChart(value: unknown): PublicChart | null {
  if (!isRecord(value) || !Array.isArray(value.sections)) return null;

  const sections: Section[] = [];
  for (const raw of value.sections) {
    // A section without a bar list has nothing to draw; drop it, not the chart.
    if (!isRecord(raw) || !Array.isArray(raw.bars)) continue;
    sections.push(toSection(raw));
  }

  // A step pointing at no section is skipped by the roadmap anyway; dropping it here
  // keeps the rail from rendering an empty row.
  const arrangement = Array.isArray(value.arrangement)
    ? value.arrangement.filter(isRecord).map(toStep).filter((s) => s.sectionId !== "")
    : undefined;

  return {
    title: str(value.title),
    artist: str(value.artist),
    key: str(value.key),
    time: str(value.time),
    bpm: str(value.bpm),
    style: str(value.style),
    capo: str(value.capo),
    sections,
    arrangement,
    settings: toSettings(value.settings),
  };
}
