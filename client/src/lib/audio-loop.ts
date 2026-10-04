// Pure math for the practice player: A-B loop windows and the tempo ladder.

export interface LoopRange {
  a: number;
  b: number;
}

/** Shortest loop worth playing — two taps in the same instant still practice something. */
export const MIN_LOOP_GAP = 0.35;

/**
 * Turn two raw marks (tapped in either order, possibly outside the track) into a
 * playable window: ordered, clamped to [0, duration], at least MIN_LOOP_GAP long.
 * Returns null when the track can't hold a window at all (duration unknown/NaN/0 —
 * e.g. B tapped before metadata loaded) — clamping would pin the playhead to 0:00.
 */
export function normalizeLoop(m1: number, m2: number, duration: number): LoopRange | null {
  if (!Number.isFinite(duration) || duration < MIN_LOOP_GAP) return null;
  const clamp = (t: number) => Math.max(0, Math.min(duration, t));
  let a = clamp(Math.min(m1, m2));
  let b = clamp(Math.max(m1, m2));
  if (b - a < MIN_LOOP_GAP) {
    b = clamp(a + MIN_LOOP_GAP);
    a = Math.max(0, b - MIN_LOOP_GAP); // when b hit the end, grow the window backwards
  }
  return { a, b };
}

/**
 * Loop enforcement decision: given the playhead, where should it jump?
 * Only fires once playback reaches B — scrubbing *before* A is deliberate and left
 * alone (the loop re-engages when the playhead re-enters the window).
 */
export function loopSeek(t: number, loop: LoopRange | null): number | null {
  if (!loop) return null;
  return t >= loop.b ? loop.a : null;
}

/** Practice tempo ladder. 1 sits in the middle; extremes chosen to stay musical. */
export const RATE_STEPS: readonly number[] = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.25];

/** Move one step along the ladder (dir ±1), snapping off-ladder rates to the nearest step. */
export function nextRate(rate: number, dir: 1 | -1): number {
  let nearest = 0;
  for (let i = 1; i < RATE_STEPS.length; i++) {
    const cur = RATE_STEPS[i] ?? 1;
    const best = RATE_STEPS[nearest] ?? 1;
    if (Math.abs(cur - rate) < Math.abs(best - rate)) nearest = i;
  }
  const j = Math.max(0, Math.min(RATE_STEPS.length - 1, nearest + dir));
  return RATE_STEPS[j] ?? 1;
}

/** m:ss for the time readout; junk (NaN/∞/negative) renders as 0:00. */
export function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
