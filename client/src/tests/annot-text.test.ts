import { describe, expect, test } from "vitest";

import {
  parseItems,
  serializeItems,
  eraseAt,
  isTextItem,
  textBBox,
  textHit,
  textSizeFromThickness,
  type Item,
  type Stroke,
  type TextItem,
} from "../lib/annot";

// A legacy stroke: stored with NO `kind` field, as older pages have on disk.
const legacyStroke: Stroke = {
  id: "s1",
  tool: "pen",
  color: "#fff",
  width: 0.004,
  points: [
    [0, 0.5],
    [1, 0.5],
  ],
};

const text = (over: Partial<TextItem> = {}): TextItem => ({
  id: "t1",
  kind: "text",
  x: 0.1,
  y: 0.2,
  size: 0.05,
  color: "#1e90ff",
  text: "capo 2",
  ...over,
});

describe("parseItems / serializeItems", () => {
  test("round-trips a mixed array of legacy strokes + text items", () => {
    const items: Item[] = [legacyStroke, text(), legacyStroke];
    expect(parseItems(serializeItems(items))).toEqual(items);
  });

  test("a legacy stroke-only array is returned unchanged (kind-less = stroke)", () => {
    const items: Item[] = [legacyStroke, { ...legacyStroke, id: "s2", tool: "highlighter" }];
    const round = parseItems(serializeItems(items));
    expect(round).toEqual(items);
    expect(round.every((it) => !isTextItem(it))).toBe(true);
  });

  test("an unknown kind is ignored (dropped) without throwing", () => {
    const raw = JSON.stringify([legacyStroke, { kind: "sticker", id: "x", foo: 1 }, text()]);
    const round = parseItems(raw);
    expect(round.map((it) => it.id)).toEqual(["s1", "t1"]);
  });

  test("bad / non-array JSON parses to nothing", () => {
    expect(parseItems("{not json")).toEqual([]);
    expect(parseItems('{"foo":1}')).toEqual([]);
    expect(parseItems("")).toEqual([]);
  });

  test("isTextItem discriminates text from strokes", () => {
    expect(isTextItem(text())).toBe(true);
    expect(isTextItem(legacyStroke)).toBe(false);
  });
});

describe("textSizeFromThickness", () => {
  test("default thickness (3) maps to 2.5% of page height", () => {
    expect(textSizeFromThickness(3)).toBeCloseTo(0.025, 6);
  });

  test("is linear across the slider range", () => {
    expect(textSizeFromThickness(1)).toBeCloseTo(1 / 120, 6);
    expect(textSizeFromThickness(10)).toBeCloseTo(10 / 120, 6);
  });
});

describe("textBBox / textHit", () => {
  test("bbox anchors at top-left, height = size, width scales with text length", () => {
    const b = textBBox(text({ text: "ab", size: 0.05, x: 0.1, y: 0.2 }));
    expect(b).toEqual({ x: 0.1, y: 0.2, w: 2 * 0.05 * 0.6, h: 0.05 });
  });

  test("hit inside the box, miss outside it", () => {
    const t = text({ x: 0.1, y: 0.2, size: 0.05, text: "capo 2" });
    expect(textHit(t, [0.12, 0.22])).toBe(true); // just inside the top-left
    expect(textHit(t, [0.9, 0.9])).toBe(false); // far away
    expect(textHit(t, [0.05, 0.22])).toBe(false); // left of the box
  });
});

describe("eraseAt removes text items", () => {
  test("erases a text label when the point is inside its bbox", () => {
    const r = eraseAt([text()], [0.12, 0.22], 0.02);
    expect(r.erased).toEqual(["t1"]);
    expect(r.strokes).toEqual([]);
  });

  test("spares a text label when the point is outside its bbox", () => {
    const r = eraseAt([text()], [0.9, 0.9], 0.02);
    expect(r.erased).toEqual([]);
    expect(r.strokes).toHaveLength(1);
  });

  test("erases text and strokes in one pass, keeping the misses", () => {
    const t = text({ id: "t1", x: 0.1, y: 0.1, size: 0.05 });
    const s = { ...legacyStroke, id: "s1", points: [[0, 0.9], [1, 0.9]] as [number, number][] };
    const r = eraseAt([t, s], [0.12, 0.12], 0.02); // inside the text box, far from the stroke
    expect(r.erased).toEqual(["t1"]);
    expect(r.strokes.map((it) => it.id)).toEqual(["s1"]);
  });
});
