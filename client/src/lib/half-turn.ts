// forScore-style half-page turns: the pure decision core.
//
// A "split" shows the TOP half of the next page clipped over the top of the page box
// while the bottom half of the current page stays visible under a divider — you finish
// reading this page's last lines with the next page's opening already up. The logical
// page during a split is the BASE page N (you haven't finished it; resume persists N).
//
// Every turn input (tap zone, swipe, pedal, keyboard) converges on the viewer's go();
// these functions decide what a turn means there. "pass" defers to the existing
// advance() path — that single word is the flag-off guarantee and the item-boundary
// rule: at a piece's edge hasNext/hasPrev are null, so item crossings (breaks, next
// tune, reprises) behave exactly as they do today, always on full pages.

export interface HalfCtx {
  /** The Settings toggle (default off). */
  enabled: boolean;
  /** Splits only at fit zoom; zoomed turns behave as today. */
  zoomed: boolean;
  /** Only in reading mode — drawing over a composite page is ambiguous. */
  reading: boolean;
  /** Currently showing a split (base N + top of N+1). */
  split: boolean;
  /** nextPos(files, pos) != null — a next page exists within this piece. */
  hasNext: boolean;
  /** prevPos(files, pos) != null — a previous page exists within this piece. */
  hasPrev: boolean;
}

export type HalfAction =
  | "pass"              // defer to the existing advance() path
  | "enter-split"       // full(N)   -> split(N): overlay top of N+1, pos stays N
  | "complete-split"    // split(N)  -> full(N+1): pos advances, overlay drops
  | "back-exit-split"   // split(N)  -> full(N): overlay drops, pos stays
  | "back-enter-split"; // full(M)   -> split(M-1): pos becomes M-1, overlay = top of M

export function halfNext(c: HalfCtx): HalfAction {
  if (!c.enabled || c.zoomed || !c.reading) return "pass";
  if (c.split) return c.hasNext ? "complete-split" : "pass"; // stale split degrades safely
  return c.hasNext ? "enter-split" : "pass";
}

export function halfPrev(c: HalfCtx): HalfAction {
  if (!c.enabled || c.zoomed || !c.reading) return "pass";
  if (c.split) return "back-exit-split";
  return c.hasPrev ? "back-enter-split" : "pass";
}

const KEY = "bandstand-half-page-turns";

/** Device-local Settings toggle (like the Bonito outfit — never synced). */
export function loadHalfPage(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function saveHalfPage(on: boolean): void {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* ignore */ }
}

// Where the divider sits, as a fraction of page height covered by the overlay.
// Adjustable by dragging the divider in a split; device-local like the toggle
// (it's about THIS screen's geometry, not the music).
const FRAC_KEY = "bandstand-half-split-frac";
export const SPLIT_FRAC_DEFAULT = 0.5;
export const SPLIT_FRAC_MIN = 0.2;
export const SPLIT_FRAC_MAX = 0.8;

export function clampSplitFrac(f: number): number {
  if (!Number.isFinite(f)) return SPLIT_FRAC_DEFAULT;
  return Math.min(SPLIT_FRAC_MAX, Math.max(SPLIT_FRAC_MIN, f));
}
export function loadSplitFrac(): number {
  try {
    const raw = localStorage.getItem(FRAC_KEY);
    return raw == null ? SPLIT_FRAC_DEFAULT : clampSplitFrac(Number(raw));
  } catch { return SPLIT_FRAC_DEFAULT; }
}
export function saveSplitFrac(f: number): void {
  try { localStorage.setItem(FRAC_KEY, String(clampSplitFrac(f))); } catch { /* ignore */ }
}
