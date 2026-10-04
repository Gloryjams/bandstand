import { describe, expect, test } from "vitest";

import {
  nextItem,
  prevItem,
  advance,
  itemLocation,
  type SItem,
} from "../lib/setlist-nav";
import type { FileLike, Pos } from "../lib/viewer-nav";

const piece = (id: string): SItem => ({ kind: "piece", piece_id: id, break_label: null });
const brk = (label: string): SItem => ({ kind: "break", piece_id: null, break_label: label });

// A typical set: two tunes, a break, then a reprise of the first tune.
const set: SItem[] = [piece("a"), piece("b"), brk("Set 2"), piece("a")];

describe("nextItem", () => {
  test("steps forward into the next piece, landing on its start", () => {
    expect(nextItem(set, 0)).toEqual({ kind: "piece", index: 1, pieceId: "b", landOn: "start" });
  });

  test("steps forward into a break, carrying its label", () => {
    expect(nextItem(set, 1)).toEqual({ kind: "break", index: 2, label: "Set 2" });
  });

  test("a reprise resolves to the repeated piece at its own item index", () => {
    expect(nextItem(set, 2)).toEqual({ kind: "piece", index: 3, pieceId: "a", landOn: "start" });
  });

  test("returns null past the last item", () => {
    expect(nextItem(set, 3)).toBeNull();
  });
});

describe("prevItem", () => {
  test("steps back into the previous piece, landing on its end", () => {
    expect(prevItem(set, 1)).toEqual({ kind: "piece", index: 0, pieceId: "a", landOn: "end" });
  });

  test("steps back into a break, carrying its label", () => {
    expect(prevItem(set, 3)).toEqual({ kind: "break", index: 2, label: "Set 2" });
  });

  test("returns null before the first item", () => {
    expect(prevItem(set, 0)).toBeNull();
  });
});

describe("itemLocation", () => {
  test("resolves a piece item, landing on its start by default (direct jump)", () => {
    expect(itemLocation(set, 0)).toEqual({ kind: "piece", index: 0, pieceId: "a", landOn: "start" });
  });

  test("resolves a reprise to the repeated piece at its own item index", () => {
    expect(itemLocation(set, 3)).toEqual({ kind: "piece", index: 3, pieceId: "a", landOn: "start" });
  });

  test("resolves a break item, carrying its label", () => {
    expect(itemLocation(set, 2)).toEqual({ kind: "break", index: 2, label: "Set 2" });
  });

  test("returns null for an out-of-range index", () => {
    expect(itemLocation(set, 4)).toBeNull();
    expect(itemLocation(set, -1)).toBeNull();
  });

  test("honors an explicit landing edge", () => {
    expect(itemLocation(set, 1, "end")).toEqual({ kind: "piece", index: 1, pieceId: "b", landOn: "end" });
  });
});

describe("advance", () => {
  const files: FileLike[] = [{ page_count: 2 }, { page_count: 1 }]; // a 3-page, 2-file piece
  const start: Pos = { fileIndex: 0, pageIndex: 0 };
  const lastPage: Pos = { fileIndex: 1, pageIndex: 0 };

  test("turns a page within the piece when one remains", () => {
    expect(advance(files, start, set, 0, 1)).toEqual({
      type: "page",
      pos: { fileIndex: 0, pageIndex: 1 },
    });
  });

  test("crosses to the next setlist item at the piece's last page", () => {
    expect(advance(files, lastPage, set, 0, 1)).toEqual({
      type: "item",
      loc: { kind: "piece", index: 1, pieceId: "b", landOn: "start" },
    });
  });

  test("crossing forward into a break yields a break item", () => {
    expect(advance(files, lastPage, set, 1, 1)).toEqual({
      type: "item",
      loc: { kind: "break", index: 2, label: "Set 2" },
    });
  });

  test("forward at the last item of the last piece is a no-op", () => {
    expect(advance(files, lastPage, set, 3, 1)).toEqual({ type: "none" });
  });

  test("backward at the piece start crosses to the previous item, landing on its end", () => {
    expect(advance(files, start, set, 1, -1)).toEqual({
      type: "item",
      loc: { kind: "piece", index: 0, pieceId: "a", landOn: "end" },
    });
  });

  test("backward at the very first item is a no-op", () => {
    expect(advance(files, start, set, 0, -1)).toEqual({ type: "none" });
  });

  test("on a break (no files), forward crosses straight to the next item", () => {
    expect(advance([], { fileIndex: 0, pageIndex: 0 }, set, 2, 1)).toEqual({
      type: "item",
      loc: { kind: "piece", index: 3, pieceId: "a", landOn: "start" },
    });
  });

  test("on a break (no files), backward crosses straight to the previous item", () => {
    expect(advance([], { fileIndex: 0, pageIndex: 0 }, set, 2, -1)).toEqual({
      type: "item",
      loc: { kind: "piece", index: 1, pieceId: "b", landOn: "end" },
    });
  });

  test("with no setlist context, the piece end is a plain no-op", () => {
    expect(advance(files, lastPage, [], 0, 1)).toEqual({ type: "none" });
  });
});
