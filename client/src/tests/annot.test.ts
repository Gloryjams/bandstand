import { describe, expect, test } from "vitest";

import {
  serializeStrokes,
  parseStrokes,
  normPoint,
  strokeToPath,
  eraseAt,
  type Stroke,
} from "../lib/annot";

const stroke = (over: Partial<Stroke> = {}): Stroke => ({
  id: "s1",
  tool: "pen",
  color: "#fff",
  width: 0.004,
  points: [
    [0, 0.5],
    [1, 0.5],
  ],
  ...over,
});

describe("serializeStrokes / parseStrokes", () => {
  test("round-trips strokes through JSON", () => {
    const s = [stroke(), stroke({ id: "s2", tool: "highlighter" })];
    expect(parseStrokes(serializeStrokes(s))).toEqual(s);
  });

  test("empty string parses to no strokes", () => {
    expect(parseStrokes("")).toEqual([]);
  });

  test("malformed JSON parses to no strokes (never throws)", () => {
    expect(parseStrokes("{not json")).toEqual([]);
  });

  test("a non-array payload parses to no strokes", () => {
    expect(parseStrokes('{"foo":1}')).toEqual([]);
  });
});

describe("normPoint", () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };

  test("maps a client point to normalized page coords", () => {
    expect(normPoint(200, 100, rect)).toEqual([0.5, 0.5]);
  });

  test("clamps points outside the page to the [0,1] range", () => {
    expect(normPoint(0, 0, rect)).toEqual([0, 0]); // left/top of the page
    expect(normPoint(1000, 1000, rect)).toEqual([1, 1]); // far beyond bottom-right
  });
});

describe("strokeToPath", () => {
  test("builds an SVG path in pixels from normalized points", () => {
    expect(strokeToPath([[0, 0], [0.5, 0.5], [1, 1]], 100, 200)).toBe("M 0 0 L 50 100 L 100 200");
  });

  test("a single point still renders (a dot) as a degenerate move", () => {
    expect(strokeToPath([[0.5, 0.5]], 100, 100)).toBe("M 50 50");
  });
});

describe("eraseAt", () => {
  test("removes a stroke when the erase point lands on its line", () => {
    const r = eraseAt([stroke()], [0.5, 0.5], 0.03);
    expect(r.erased).toEqual(["s1"]);
    expect(r.strokes).toEqual([]);
  });

  test("leaves strokes the erase point misses", () => {
    const r = eraseAt([stroke()], [0.5, 0.9], 0.03); // line is at y=0.5
    expect(r.erased).toEqual([]);
    expect(r.strokes).toHaveLength(1);
  });

  test("erases only the strokes within radius, keeping the rest", () => {
    const top = stroke({ id: "top", points: [[0, 0.1], [1, 0.1]] });
    const bottom = stroke({ id: "bottom", points: [[0, 0.9], [1, 0.9]] });
    const r = eraseAt([top, bottom], [0.5, 0.1], 0.03);
    expect(r.erased).toEqual(["top"]);
    expect(r.strokes.map((s) => s.id)).toEqual(["bottom"]);
  });

  test("hit-tests distance to the nearest segment, not just vertices", () => {
    // A long horizontal stroke with vertices only at the ends; erase in the middle.
    const r = eraseAt([stroke({ points: [[0, 0.5], [1, 0.5]] })], [0.42, 0.52], 0.03);
    expect(r.erased).toEqual(["s1"]);
  });
});
