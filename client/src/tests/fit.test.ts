import { describe, expect, test } from "vitest";

import { fitScale } from "../lib/fit";

describe("fitScale", () => {
  test("fits a portrait letter page into a landscape tablet by height", () => {
    // page 612x792 (scale 1), container 1280x800 -> limited by height: 800/792
    expect(fitScale({ width: 612, height: 792 }, { width: 1280, height: 800 }))
      .toBeCloseTo(800 / 792, 5);
  });

  test("fits by width when the container is narrow", () => {
    // page 612x792, container 600x900 -> limited by width: 600/612
    expect(fitScale({ width: 612, height: 792 }, { width: 600, height: 900 }))
      .toBeCloseTo(600 / 612, 5);
  });

  test("can scale up a small page to fill the container (contain)", () => {
    // page 100x100, container 500x400 -> min(5, 4) = 4
    expect(fitScale({ width: 100, height: 100 }, { width: 500, height: 400 })).toBeCloseTo(4, 5);
  });

  test("returns a safe 1 when page has zero size", () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 800, height: 600 })).toBe(1);
  });
});
