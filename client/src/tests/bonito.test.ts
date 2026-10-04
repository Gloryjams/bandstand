import { describe, expect, test } from "vitest";

import { moodFor, EXPRESSIONS, OUTFITS, isOutfit } from "../lib/bonito";

const base = { playing: false, loopArmed: false, looping: false, ended: false };

describe("moodFor (practice-player state -> expression)", () => {
  test("paused and idle -> sleepy (cat naps between reps)", () => {
    expect(moodFor(base)).toBe("sleepy");
  });
  test("playing -> happy", () => {
    expect(moodFor({ ...base, playing: true })).toBe("happy");
  });
  test("A armed -> curious (waiting for the B mark)", () => {
    expect(moodFor({ ...base, playing: true, loopArmed: true })).toBe("curious");
    expect(moodFor({ ...base, loopArmed: true })).toBe("curious");
  });
  test("A-B looping -> wink (locked in)", () => {
    expect(moodFor({ ...base, playing: true, looping: true })).toBe("wink");
  });
  test("track ended -> surprised", () => {
    expect(moodFor({ ...base, ended: true })).toBe("surprised");
  });
  test("ended outranks a stale loop state", () => {
    expect(moodFor({ ...base, looping: true, ended: true })).toBe("surprised");
  });
});

describe("canon tables", () => {
  test("all 7 expressions from the design handoff exist", () => {
    expect(EXPRESSIONS.map((e) => e.key)).toEqual([
      "happy", "in-love", "star-struck", "wink", "sleepy", "surprised", "curious",
    ]);
  });
  test("all 5 dressing-room outfits exist, conductor first (the default)", () => {
    expect(OUTFITS.map((o) => o.key)).toEqual([
      "conductor", "starman", "duke", "thriller", "moonwalk",
    ]);
  });
  test("isOutfit guards persisted junk", () => {
    expect(isOutfit("moonwalk")).toBe(true);
    expect(isOutfit("tuxedo")).toBe(false);
    expect(isOutfit(null)).toBe(false);
  });
});
