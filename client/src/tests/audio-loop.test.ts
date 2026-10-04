import { describe, expect, test } from "vitest";

import { normalizeLoop, loopSeek, nextRate, fmtTime, MIN_LOOP_GAP } from "../lib/audio-loop";

describe("normalizeLoop", () => {
  test("orders the marks regardless of which was tapped first", () => {
    expect(normalizeLoop(8, 4, 60)).toEqual({ a: 4, b: 8 });
    expect(normalizeLoop(4, 8, 60)).toEqual({ a: 4, b: 8 });
  });

  test("clamps into the track and enforces a minimum gap", () => {
    // marks tapped almost on top of each other still yield a playable window
    const r = normalizeLoop(10, 10.1, 60)!;
    expect(r.b - r.a).toBeGreaterThanOrEqual(MIN_LOOP_GAP - 1e-9); // fp-tolerant
    // marks beyond the end pull back inside the track
    const e = normalizeLoop(59.9, 70, 60)!;
    expect(e.b).toBeLessThanOrEqual(60);
    expect(e.a).toBeLessThanOrEqual(e.b - MIN_LOOP_GAP);
  });

  test("degenerate mark at the very end still fits a window before it", () => {
    const r = normalizeLoop(60, 60, 60)!;
    expect(r.a).toBeCloseTo(60 - MIN_LOOP_GAP);
    expect(r.b).toBe(60);
  });

  test("unloopable duration -> null (e.g. B tapped before metadata loaded)", () => {
    // clamping into a zero/unknown track would pin the playhead to 0:00 forever
    expect(normalizeLoop(0.5, 1.5, 0)).toBeNull();
    expect(normalizeLoop(0.5, 1.5, NaN)).toBeNull();
    expect(normalizeLoop(0.5, 1.5, Infinity)).toBeNull();
    expect(normalizeLoop(0, 0.2, 0.2)).toBeNull(); // track shorter than the minimum gap
  });
});

describe("loopSeek", () => {
  const loop = { a: 4, b: 8 };
  test("no loop -> never seeks", () => {
    expect(loopSeek(9, null)).toBeNull();
  });
  test("inside the window -> no seek", () => {
    expect(loopSeek(5, loop)).toBeNull();
    expect(loopSeek(4, loop)).toBeNull();
  });
  test("passing B snaps back to A", () => {
    expect(loopSeek(8, loop)).toBe(4);
    expect(loopSeek(8.3, loop)).toBe(4);
  });
  test("before A (user scrubbed back) is left alone", () => {
    // scrubbing before A is a deliberate act; the loop re-engages when playback re-enters
    expect(loopSeek(2, loop)).toBeNull();
  });
});

describe("nextRate", () => {
  test("steps through the practice ladder", () => {
    expect(nextRate(1, -1)).toBe(0.9);
    expect(nextRate(0.9, -1)).toBe(0.8);
    expect(nextRate(1, +1)).toBe(1.1);
  });
  test("clamps at both ends", () => {
    expect(nextRate(0.5, -1)).toBe(0.5);
    expect(nextRate(1.25, +1)).toBe(1.25);
  });
  test("snaps an off-ladder rate to the nearest step first", () => {
    expect(nextRate(0.72, +1)).toBe(0.75); // nearest is 0.7, then up
    expect(nextRate(0.72, -1)).toBe(0.6);
  });
});

describe("fmtTime", () => {
  test("renders m:ss", () => {
    expect(fmtTime(0)).toBe("0:00");
    expect(fmtTime(61)).toBe("1:01");
    expect(fmtTime(600)).toBe("10:00");
  });
  test("junk input degrades to 0:00", () => {
    expect(fmtTime(NaN)).toBe("0:00");
    expect(fmtTime(Infinity)).toBe("0:00");
    expect(fmtTime(-3)).toBe("0:00");
  });
});
