import { describe, it, expect } from "vitest";

import { rankResults, type SearchablePiece } from "../lib/search";

const pieces: SearchablePiece[] = [
  { id: "1", title: "Take Five", composer: "Paul Desmond", music_key: "Ebm",
    tags: ["jazz"], notes: null },
  { id: "2", title: "Stella by Starlight", composer: "Victor Young",
    music_key: "Bb", tags: ["jazz", "standard"], notes: null },
  { id: "3", title: "Stella's Theme", composer: null, music_key: null,
    tags: [], notes: null },
];

describe("rankResults", () => {
  it("typo tolerates 'stel'", () => {
    const out = rankResults(pieces, "stel", []);
    expect(out[0]?.id).toMatch(/^[23]$/);
  });

  it("exact prefix beats fuzzy", () => {
    const out = rankResults(pieces, "Take", []);
    expect(out[0]?.id).toBe("1");
  });

  it("recents float to top", () => {
    const out = rankResults(pieces, "stella", ["3"]);
    expect(out[0]?.id).toBe("3");
  });

  it("empty query returns recents-first", () => {
    const out = rankResults(pieces, "", ["2", "3"]);
    expect(out.slice(0, 2).map((p) => p.id)).toEqual(["2", "3"]);
  });
});
