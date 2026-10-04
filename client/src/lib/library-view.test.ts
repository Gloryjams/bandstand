import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLibraryView, collectTags, decodeTags, DEFAULT_VIEW, loadView } from "./library-view";

const piece = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over });
const base = () => ({
  id: "p1",
  title: "Alpha",
  tags: "[]",
  added_at: 100,
  last_opened_at: null as number | null,
  play_count: 0,
});

describe("collectTags", () => {
  it("unions tags, most-used first then alphabetical", () => {
    const tags = collectTags([
      { tags: '["funk","soul"]' },
      { tags: '["funk"]' },
      { tags: '["blues"]' },
    ]);
    expect(tags).toEqual(["funk", "blues", "soul"]);
  });

  it("tolerates junk rows and non-string entries", () => {
    expect(collectTags([{ tags: "not json" }, { tags: '{"a":1}' }, { tags: '[3,""," ok"]' }])).toEqual(["ok"]);
  });

  it("normalizes whitespace variants and counts a tag once per piece", () => {
    const tags = collectTags([
      { tags: '["funk","funk"," funk "]' },   // one piece, one funk
      { tags: '["soul"]' },
      { tags: '["soul"]' },
    ]);
    expect(tags).toEqual(["soul", "funk"]);
  });
});

describe("decodeTags", () => {
  it("returns [] for non-strings, junk JSON, and non-arrays", () => {
    expect(decodeTags(null)).toEqual([]);
    expect(decodeTags(undefined)).toEqual([]);
    expect(decodeTags(42)).toEqual([]);
    expect(decodeTags("not json")).toEqual([]);
    expect(decodeTags('{"a":1}')).toEqual([]);
  });

  it("trims, drops empties and non-strings, dedupes", () => {
    expect(decodeTags('[" funk ","funk",""," ",3,"soul"]')).toEqual(["funk", "soul"]);
  });
});

describe("loadView validation", () => {
  const stub = (stored: string | null) => {
    vi.stubGlobal("localStorage", {
      getItem: () => stored,
      setItem: () => {},
      removeItem: () => {},
    });
  };
  afterEach(() => vi.unstubAllGlobals());

  it("degrades stored junk per field instead of trusting it", () => {
    stub(JSON.stringify({ sort: "bogus", tag: 4, audioOnly: "false" }));
    expect(loadView()).toEqual({ sort: "recent", tag: null, audioOnly: false });
  });

  it("keeps valid stored values", () => {
    stub(JSON.stringify({ sort: "played", tag: "funk", audioOnly: true }));
    expect(loadView()).toEqual({ sort: "played", tag: "funk", audioOnly: true });
  });

  it("survives corrupt JSON and empty storage", () => {
    stub("{{{");
    expect(loadView()).toEqual(DEFAULT_VIEW);
    stub(null);
    expect(loadView()).toEqual(DEFAULT_VIEW);
  });
});

describe("applyLibraryView", () => {
  const a = piece({ id: "a", title: "Zebra", added_at: 10, play_count: 5, tags: '["funk"]' });
  const b = piece({ id: "b", title: "Apple", added_at: 20, last_opened_at: 900, play_count: 1 });
  const c = piece({ id: "c", title: "Mango", added_at: 30, last_opened_at: 500, play_count: 5 });
  const all = [a, b, c];
  const audio = new Set(["c"]);

  it("recent: last_opened wins, added_at is the fallback", () => {
    expect(applyLibraryView(all, audio, { ...DEFAULT_VIEW }).map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("title: case-insensitive A-Z", () => {
    expect(applyLibraryView(all, audio, { ...DEFAULT_VIEW, sort: "title" }).map((p) => p.id)).toEqual(["b", "c", "a"]);
    // equal-base titles compare 0 (sensitivity: base) — the sort is stable, input order holds
    expect(applyLibraryView([piece({ id: "x", title: "apple" }), b], audio, { ...DEFAULT_VIEW, sort: "title" }).map((p) => p.title)).toEqual(["apple", "Apple"]);
  });

  it("played: count desc, title breaks ties", () => {
    expect(applyLibraryView(all, audio, { ...DEFAULT_VIEW, sort: "played" }).map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("tag and audio filters narrow before sorting", () => {
    expect(applyLibraryView(all, audio, { ...DEFAULT_VIEW, tag: "funk" }).map((p) => p.id)).toEqual(["a"]);
    expect(applyLibraryView(all, audio, { ...DEFAULT_VIEW, audioOnly: true }).map((p) => p.id)).toEqual(["c"]);
  });

  it("does not mutate the input array", () => {
    const input = [...all];
    applyLibraryView(input, audio, { ...DEFAULT_VIEW, sort: "title" });
    expect(input.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});
