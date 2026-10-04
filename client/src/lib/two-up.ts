// Two-up landscape (forScore steal-next, last shortlist item): in a landscape
// stage, reading mode shows the current page and the next side by side.
// Sliding-window pairs (N, N+1) — a turn moves one page, so navigation,
// setlists, resume and section jumps need no changes at all.

const LS_KEY = "two_up_landscape";

export function loadTwoUp(): boolean {
  try { return localStorage.getItem(LS_KEY) === "1"; } catch { return false; }
}
export function saveTwoUp(on: boolean): void {
  try { localStorage.setItem(LS_KEY, on ? "1" : "0"); } catch { /* private mode */ }
}

/** Landscape with margin — a near-square stage flapping between layouts on
    tiny resizes would be worse than either layout. */
export function isLandscape(w: number, h: number): boolean {
  return w > 0 && h > 0 && w * 100 > h * 115; // integer form of w > 1.15h (no fp dust)
}

/** Gap between the two pages, CSS px. */
export const TWO_UP_GAP = 12;
