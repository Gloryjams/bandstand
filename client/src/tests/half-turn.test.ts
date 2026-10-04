import { describe, expect, test } from "vitest";

import {
  halfNext, halfPrev, clampSplitFrac,
  SPLIT_FRAC_DEFAULT, SPLIT_FRAC_MIN, SPLIT_FRAC_MAX,
  type HalfCtx,
} from "../lib/half-turn";

const base: HalfCtx = {
  enabled: true, zoomed: false, reading: true, split: false, hasNext: true, hasPrev: true,
};

describe("halfNext", () => {
  test("flag off -> always pass (the existing turn path, untouched)", () => {
    expect(halfNext({ ...base, enabled: false })).toBe("pass");
    expect(halfNext({ ...base, enabled: false, split: true })).toBe("pass");
  });
  test("zoomed in -> pass (splits only at fit)", () => {
    expect(halfNext({ ...base, zoomed: true })).toBe("pass");
  });
  test("not reading (annotate mode) -> pass", () => {
    expect(halfNext({ ...base, reading: false })).toBe("pass");
  });
  test("full page with a next page -> enter the split", () => {
    expect(halfNext(base)).toBe("enter-split");
  });
  test("split -> complete to the full next page", () => {
    expect(halfNext({ ...base, split: true })).toBe("complete-split");
  });
  test("last page of the piece -> pass (item boundaries never split)", () => {
    expect(halfNext({ ...base, hasNext: false })).toBe("pass");
  });
  test("stale split with no next page (data changed underneath) degrades to pass", () => {
    expect(halfNext({ ...base, split: true, hasNext: false })).toBe("pass");
  });
});

describe("halfPrev", () => {
  test("flag off / zoomed / annotate -> pass", () => {
    expect(halfPrev({ ...base, enabled: false })).toBe("pass");
    expect(halfPrev({ ...base, zoomed: true })).toBe("pass");
    expect(halfPrev({ ...base, reading: false })).toBe("pass");
  });
  test("split(N) -> back to full(N): retraces the forward sequence", () => {
    expect(halfPrev({ ...base, split: true })).toBe("back-exit-split");
  });
  test("full(M) with a previous page -> split(M-1)", () => {
    expect(halfPrev(base)).toBe("back-enter-split");
  });
  test("first page of the piece -> pass (item boundaries never split)", () => {
    expect(halfPrev({ ...base, hasPrev: false })).toBe("pass");
  });
});

describe("clampSplitFrac (adjustable divider)", () => {
  test("in-range values pass through", () => {
    expect(clampSplitFrac(0.5)).toBe(0.5);
    expect(clampSplitFrac(0.35)).toBe(0.35);
  });
  test("out-of-range values pin to the bounds (divider stays grabbable)", () => {
    expect(clampSplitFrac(0)).toBe(SPLIT_FRAC_MIN);
    expect(clampSplitFrac(1)).toBe(SPLIT_FRAC_MAX);
    expect(clampSplitFrac(-3)).toBe(SPLIT_FRAC_MIN);
  });
  test("garbage (NaN/Infinity from a corrupt store) falls back to the default", () => {
    expect(clampSplitFrac(NaN)).toBe(SPLIT_FRAC_DEFAULT);
    expect(clampSplitFrac(Infinity)).toBe(SPLIT_FRAC_DEFAULT);
  });
});

describe("round trips", () => {
  test("forward then back returns through the same states", () => {
    // full(N) --next--> split(N) --next--> full(N+1) --prev--> split(N) --prev--> full(N)
    expect(halfNext(base)).toBe("enter-split");
    expect(halfNext({ ...base, split: true })).toBe("complete-split");
    expect(halfPrev(base)).toBe("back-enter-split");
    expect(halfPrev({ ...base, split: true })).toBe("back-exit-split");
  });
});
