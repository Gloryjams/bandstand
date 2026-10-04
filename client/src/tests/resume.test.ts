import { describe, expect, test } from "vitest";

import { isResumable, buildResume, restorePos } from "../lib/resume";
import type { AppState } from "../lib/db";

const HOUR = 60 * 60 * 1000;

function state(over: Partial<AppState> = {}): AppState {
  return {
    id: "current",
    piece_id: "P1",
    file_id: "F1",
    page_index: 0,
    mode: "reading",
    zoom: 1,
    setlist_id: null,
    setlist_position: null,
    updated_at: 0,
    ...over,
  };
}

describe("isResumable", () => {
  test("false when there is no state", () => {
    expect(isResumable(undefined, 1000)).toBe(false);
  });
  test("false when piece_id is missing", () => {
    expect(isResumable(state({ piece_id: null }), 1000)).toBe(false);
  });
  test("true within the 12h window", () => {
    const now = 100_000_000;
    expect(isResumable(state({ updated_at: now - 1 * HOUR }), now)).toBe(true);
  });
  test("false beyond the 12h window", () => {
    const now = 100_000_000;
    expect(isResumable(state({ updated_at: now - 13 * HOUR }), now)).toBe(false);
  });
  test("true exactly at the 12h boundary", () => {
    const now = 100_000_000;
    expect(isResumable(state({ updated_at: now - 12 * HOUR }), now)).toBe(true);
  });
});

describe("buildResume", () => {
  test("maps the current file id and page index", () => {
    const r = buildResume({
      pieceId: "P1",
      files: [{ id: "A" }, { id: "B" }],
      pos: { fileIndex: 1, pageIndex: 2 },
      setlistId: "S",
      setlistPos: 3,
    });
    expect(r).toEqual({
      piece_id: "P1",
      file_id: "B",
      page_index: 2,
      mode: "reading",
      zoom: 1,
      setlist_id: "S",
      setlist_position: 3,
    });
  });
  test("file_id is null when there are no files", () => {
    const r = buildResume({
      pieceId: "P1",
      files: [],
      pos: { fileIndex: 0, pageIndex: 0 },
      setlistId: null,
      setlistPos: null,
    });
    expect(r.file_id).toBeNull();
  });
});

describe("restorePos", () => {
  test("finds the file index by file_id", () => {
    expect(restorePos(state({ file_id: "B", page_index: 1 }), [{ id: "A" }, { id: "B" }]))
      .toEqual({ fileIndex: 1, pageIndex: 1 });
  });
  test("defaults to the first file when file_id is not found", () => {
    expect(restorePos(state({ file_id: "Z", page_index: 0 }), [{ id: "A" }]))
      .toEqual({ fileIndex: 0, pageIndex: 0 });
  });
});
