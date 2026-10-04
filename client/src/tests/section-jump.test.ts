import { describe, expect, test } from "vitest";

import { sectionJump, type LinkLike, type BookmarkTarget } from "../lib/section-jump";

// A chart with a "Head" bookmark on file f1 page 0, and a D.S. link that fires
// from f1 page 3 back to the Head.
const head: BookmarkTarget = { id: "bm-head", file_id: "f1", page_index: 0 };
const coda: BookmarkTarget = { id: "bm-coda", file_id: "f1", page_index: 4 };
const bookmarks = [head, coda];

const link = (over: Partial<LinkLike> = {}): LinkLike => ({
  id: "lk1",
  from_file_id: "f1",
  from_page_index: 3,
  to_bookmark_id: "bm-head",
  initial_triggers: 1,
  active: 1,
  ...over,
});

describe("sectionJump", () => {
  test("no link at the current position falls through", () => {
    expect(sectionJump([link()], bookmarks, new Map(), "f1", 0)).toEqual({ jump: false });
  });

  test("an active link fires and reports the bookmark target + decremented count", () => {
    expect(sectionJump([link()], bookmarks, new Map(), "f1", 3)).toEqual({
      jump: true,
      linkId: "lk1",
      toFileId: "f1",
      toPageIndex: 0,
      remaining: 0,
    });
  });

  test("a single-trigger link is exhausted on its second encounter", () => {
    const counters = new Map([["lk1", 0]]); // already fired once this session
    expect(sectionJump([link()], bookmarks, counters, "f1", 3)).toEqual({ jump: false });
  });

  test("a 2-trigger link fires twice then falls through", () => {
    const links = [link({ initial_triggers: 2 })];
    const first = sectionJump(links, bookmarks, new Map(), "f1", 3);
    expect(first).toMatchObject({ jump: true, remaining: 1 });
    const second = sectionJump(links, bookmarks, new Map([["lk1", 1]]), "f1", 3);
    expect(second).toMatchObject({ jump: true, remaining: 0 });
    const third = sectionJump(links, bookmarks, new Map([["lk1", 0]]), "f1", 3);
    expect(third).toEqual({ jump: false });
  });

  test("an unlimited link (-1) always fires and never decrements", () => {
    const links = [link({ initial_triggers: -1 })];
    expect(sectionJump(links, bookmarks, new Map(), "f1", 3)).toMatchObject({ jump: true, remaining: -1 });
    expect(sectionJump(links, bookmarks, new Map([["lk1", -1]]), "f1", 3)).toMatchObject({
      jump: true,
      remaining: -1,
    });
  });

  test("an inactive link never fires", () => {
    expect(sectionJump([link({ active: 0 })], bookmarks, new Map(), "f1", 3)).toEqual({ jump: false });
  });

  test("a link whose target bookmark is missing falls through", () => {
    expect(sectionJump([link({ to_bookmark_id: "gone" })], bookmarks, new Map(), "f1", 3)).toEqual({
      jump: false,
    });
  });

  test("resolves the link matching the current file + page among several", () => {
    const links = [
      link({ id: "a", from_page_index: 1, to_bookmark_id: "bm-coda" }),
      link({ id: "b", from_page_index: 3, to_bookmark_id: "bm-head" }),
    ];
    expect(sectionJump(links, bookmarks, new Map(), "f1", 1)).toMatchObject({
      jump: true,
      linkId: "a",
      toPageIndex: 4,
    });
  });
});
