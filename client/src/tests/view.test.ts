import { describe, expect, test } from "vitest";

import { clampScale, centerView, zoomAbout, twoFinger, clampView } from "../lib/view";

describe("clampScale", () => {
  test("never goes below 100% (fit) and caps at 4x", () => {
    expect(clampScale(0.2)).toBe(1); // can't shrink past fit-to-screen
    expect(clampScale(0.9)).toBe(1);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(2)).toBe(2);
    expect(clampScale(9)).toBe(4);
  });
});

describe("centerView", () => {
  test("centers an unscaled page in the stage", () => {
    expect(centerView(100, 200, 300, 400)).toEqual({ scale: 1, tx: 100, ty: 100 });
  });
});

describe("zoomAbout", () => {
  test("zooms toward a focal point, keeping that point fixed on screen", () => {
    // content point under focal x=50 stays under x=50 after doubling.
    const v = zoomAbout({ scale: 1, tx: 0, ty: 0 }, 50, 0, 2);
    expect(v).toEqual({ scale: 2, tx: -50, ty: 0 });
    // verify the focal invariant: screen = t + s * local, local was (50 - 0)/1 = 50
    expect(v.tx + v.scale * 50).toBe(50);
  });

  test("clamps the target scale", () => {
    expect(zoomAbout({ scale: 1, tx: 0, ty: 0 }, 0, 0, 99).scale).toBe(4);
  });
});

describe("twoFinger", () => {
  test("pure pinch doubles scale and keeps the pinch midpoint fixed", () => {
    // midpoint stays at x=50; fingers spread from 100px apart to 200px apart.
    const v = twoFinger({ scale: 1, tx: 0, ty: 0 }, [0, 0], [100, 0], [-50, 0], [150, 0]);
    expect(v.scale).toBe(2);
    // midpoint 50: local under it was 50; must remain under 50.
    expect(v.tx + v.scale * 50).toBe(50);
  });

  test("two-finger drag with no spread just pans", () => {
    const v = twoFinger({ scale: 1, tx: 0, ty: 0 }, [0, 0], [100, 0], [10, 5], [110, 5]);
    expect(v.scale).toBe(1);
    expect(v).toMatchObject({ tx: 10, ty: 5 });
  });
});

describe("clampView", () => {
  test("centers an axis when the scaled page is smaller than the stage", () => {
    // page 100 wide at scale 1 -> 100 < 300 stage -> centered tx = 100
    const v = clampView({ scale: 1, tx: -999, ty: -999 }, 100, 100, 300, 300);
    expect(v.tx).toBe(100);
    expect(v.ty).toBe(100);
  });

  test("bounds translation so a larger-than-stage page cannot leave the viewport", () => {
    // page 100 at scale 4 -> 400 wide > 300 stage -> tx clamped to [300-400, 0] = [-100, 0]
    expect(clampView({ scale: 4, tx: 50, ty: 0 }, 100, 100, 300, 300).tx).toBe(0);
    expect(clampView({ scale: 4, tx: -250, ty: 0 }, 100, 100, 300, 300).tx).toBe(-100);
    expect(clampView({ scale: 4, tx: -40, ty: 0 }, 100, 100, 300, 300).tx).toBe(-40);
  });
});
