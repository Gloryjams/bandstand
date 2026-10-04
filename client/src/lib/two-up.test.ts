import { describe, expect, it } from "vitest";
import { isLandscape } from "./two-up";

describe("isLandscape", () => {
  it("true only with a real landscape margin (1.15x)", () => {
    expect(isLandscape(1280, 800)).toBe(true);
    expect(isLandscape(920, 800)).toBe(false);   // 1.15x exactly = 920: not >
    expect(isLandscape(921, 800)).toBe(true);
    expect(isLandscape(800, 1280)).toBe(false);
  });

  it("false on degenerate sizes", () => {
    expect(isLandscape(0, 0)).toBe(false);
    expect(isLandscape(100, 0)).toBe(false);
  });
});
