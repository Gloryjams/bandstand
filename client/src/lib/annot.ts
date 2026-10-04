// Annotation strokes for the SVG overlay. Points are stored in NORMALIZED page
// coordinates (0..1 of the rendered page's width/height) so they stay put across
// viewport resize, orientation change, and (later) zoom — the same chart mark
// always sits on the same spot of the music.

export interface Stroke {
  id: string;
  // Legacy strokes were stored with no `kind` field; it stays optional so old arrays
  // round-trip untouched and kind-less items are still recognized as strokes.
  kind?: "stroke";
  tool: "pen" | "highlighter";
  color: string;
  width: number; // normalized: fraction of page width
  points: [number, number][]; // normalized 0..1
}

/**
 * A typed text label placed on the page (the first user reads on a finger-only tablet, so
 * handwriting is illegible — these are for "capo 2", cues, chord names). x/y are the
 * TOP-LEFT anchor in normalized 0..1 page coords; `size` is the glyph height as a
 * fraction of page height (like stroke widths, it survives resize/zoom).
 */
export interface TextItem {
  id: string;
  kind: "text";
  x: number; // normalized 0..1 (left)
  y: number; // normalized 0..1 (top)
  size: number; // normalized: fraction of page height
  color: string;
  text: string;
}

/** One entry in a page's annotation array: a freehand stroke or a typed text label. */
export type Item = Stroke | TextItem;

export function isTextItem(it: Item): it is TextItem {
  return (it as { kind?: unknown }).kind === "text";
}

export function serializeItems(items: Item[]): string {
  return JSON.stringify(items);
}

/**
 * Defensive parse of a page's annotation array. Kind-less objects are legacy strokes;
 * `kind:"text"` are labels; any other/unknown kind is ignored (dropped) so a newer
 * item type from another device can't crash an older client. Bad/empty/non-array JSON
 * yields nothing rather than throwing.
 */
export function parseItems(json: string): Item[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((it): it is Item => {
      if (!it || typeof it !== "object") return false;
      const k = (it as { kind?: unknown }).kind;
      return k === undefined || k === "stroke" || k === "text";
    });
  } catch {
    return [];
  }
}

// --- Legacy stroke-only aliases (kept for existing call sites / tests) --------------
export function serializeStrokes(strokes: Stroke[]): string {
  return JSON.stringify(strokes);
}

/** Defensive parse: bad/empty/non-array JSON yields no strokes rather than throwing. */
export function parseStrokes(json: string): Stroke[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Stroke[]) : [];
  } catch {
    return [];
  }
}

// --- Text sizing + hit-testing -----------------------------------------------------

/**
 * Map the annotate toolbar's thickness slider (1..10) to a text height fraction of the
 * page. Chosen so the default thickness (3) lands on 0.025 = 2.5% of page height; the
 * slider then spans ~0.8%..8.3%.
 */
export function textSizeFromThickness(thickness: number): number {
  return thickness / 120;
}

// Average glyph advance as a fraction of the font height — a rough estimate used only
// to give text labels a bounding box for eraser hit-testing.
const TEXT_CHAR_W = 0.6;

/** Bounding box of a text label in normalized page coords (x/y = top-left). */
export function textBBox(t: TextItem): { x: number; y: number; w: number; h: number } {
  return {
    x: t.x,
    y: t.y,
    w: Math.max(t.text.length, 1) * t.size * TEXT_CHAR_W,
    h: t.size,
  };
}

/** True when `point` (normalized) falls inside the label's bounding box. */
export function textHit(t: TextItem, point: [number, number]): boolean {
  const b = textBBox(t);
  return point[0] >= b.x && point[0] <= b.x + b.w && point[1] >= b.y && point[1] <= b.y + b.h;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Convert a client (viewport) point to normalized page coords within `rect`, clamped to the page. */
export function normPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): [number, number] {
  const x = rect.width ? (clientX - rect.left) / rect.width : 0;
  const y = rect.height ? (clientY - rect.top) / rect.height : 0;
  return [clamp01(x), clamp01(y)];
}

function fmt(n: number): number {
  return Math.round(n * 100) / 100;
}

/** An SVG path `d` string in pixels for a stroke's normalized points at page size w×h. */
export function strokeToPath(points: [number, number][], w: number, h: number): string {
  if (points.length === 0) return "";
  return points
    .map(([nx, ny], i) => `${i === 0 ? "M" : "L"} ${fmt(nx * w)} ${fmt(ny * h)}`)
    .join(" ");
}

// Shortest distance from point p to segment a-b (all in normalized space).
function distToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function strokeHit(stroke: Stroke, point: [number, number], radius: number): boolean {
  const pts = stroke.points;
  if (pts.length === 0) return false;
  if (pts.length === 1) {
    const [x, y] = pts[0]!;
    return Math.hypot(x - point[0], y - point[1]) <= radius;
  }
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(point, pts[i - 1]!, pts[i]!) <= radius) return true;
  }
  return false;
}

/**
 * Remove every item hit by `point`: strokes whose path passes within `radius`, and text
 * labels whose bounding box contains the point. One pass over the mixed array. (The
 * returned array is still called `strokes` for backward compatibility with callers.)
 */
export function eraseAt(
  items: Item[],
  point: [number, number],
  radius: number,
): { strokes: Item[]; erased: string[] } {
  const erased: string[] = [];
  const kept = items.filter((it) => {
    const hit = isTextItem(it) ? textHit(it, point) : strokeHit(it, point, radius);
    if (hit) {
      erased.push(it.id);
      return false;
    }
    return true;
  });
  return { strokes: kept, erased };
}
