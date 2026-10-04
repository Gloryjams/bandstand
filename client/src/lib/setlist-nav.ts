// Pure navigation math for setlist playback: walking *items* (pieces and breaks)
// once page-level navigation runs off the end of the current piece.

import { nextPos, prevPos, type FileLike, type Pos } from "./viewer-nav";

export interface SItem {
  kind: "piece" | "break";
  piece_id: string | null;
  break_label: string | null;
}

/** Where setlist navigation lands: a piece (with which page edge to open on) or a break slide. */
export type PlayLoc =
  | { kind: "piece"; index: number; pieceId: string; landOn: "start" | "end" }
  | { kind: "break"; index: number; label: string };

/** The viewer's decision for a single page-turn input. */
export type Advance =
  | { type: "page"; pos: Pos }
  | { type: "item"; loc: PlayLoc }
  | { type: "none" };

/**
 * Resolve the setlist item at `index` to a play location, or null if out of range.
 * Used both by sequential page-turns (below) and by direct jumps from the in-play
 * setlist sheet (tap any tune to go straight to it). Defaults to a piece's start.
 */
export function itemLocation(
  items: SItem[],
  index: number,
  landOn: "start" | "end" = "start",
): PlayLoc | null {
  const it = items[index];
  if (!it) return null;
  if (it.kind === "piece" && it.piece_id) {
    return { kind: "piece", index, pieceId: it.piece_id, landOn };
  }
  return { kind: "break", index, label: it.break_label ?? "Break" };
}

/** The next setlist item after `index`, or null past the end. Forward lands on a piece's start. */
export function nextItem(items: SItem[], index: number): PlayLoc | null {
  return itemLocation(items, index + 1, "start");
}

/** The previous setlist item before `index`, or null before the start. Backward lands on a piece's end. */
export function prevItem(items: SItem[], index: number): PlayLoc | null {
  return itemLocation(items, index - 1, "end");
}

/**
 * Decide a page-turn: stay within the piece if a page remains, else cross to the
 * adjacent setlist item, else (no setlist, or at the set's edge) do nothing.
 */
export function advance(
  files: FileLike[],
  pos: Pos,
  items: SItem[],
  index: number,
  dir: 1 | -1,
): Advance {
  const within = dir === 1 ? nextPos(files, pos) : prevPos(files, pos);
  if (within) return { type: "page", pos: within };
  if (items.length === 0) return { type: "none" };
  const loc = dir === 1 ? nextItem(items, index) : prevItem(items, index);
  return loc ? { type: "item", loc } : { type: "none" };
}
