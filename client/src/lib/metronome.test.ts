import { describe, expect, it } from "vitest";
import { clampBpm, parseBeatsPerBar } from "./metronome";

describe("clampBpm", () => {
  it("rounds and clamps to 30..300", () => {
    expect(clampBpm(96.4)).toBe(96);
    expect(clampBpm(5)).toBe(30);
    expect(clampBpm(999)).toBe(300);
    expect(clampBpm(NaN)).toBe(100);
    expect(clampBpm(Infinity)).toBe(100);
  });
});

describe("parseBeatsPerBar", () => {
  it("reads the numerator of N/D", () => {
    expect(parseBeatsPerBar("4/4")).toBe(4);
    expect(parseBeatsPerBar("3/4")).toBe(3);
    expect(parseBeatsPerBar("12/8")).toBe(12);
    expect(parseBeatsPerBar(" 6 / 8 ")).toBe(6);
  });

  it("defaults to 4 on junk, absence, or out-of-range numerators", () => {
    expect(parseBeatsPerBar(null)).toBe(4);
    expect(parseBeatsPerBar(undefined)).toBe(4);
    expect(parseBeatsPerBar("swing")).toBe(4);
    expect(parseBeatsPerBar("0/4")).toBe(4);
    expect(parseBeatsPerBar("13/8")).toBe(4);
    expect(parseBeatsPerBar("4")).toBe(4);
  });
});
