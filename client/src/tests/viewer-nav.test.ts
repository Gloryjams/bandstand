import { describe, expect, test } from "vitest";

import { nextPos, prevPos, globalPage, lastPos, type FileLike, type Pos } from "../lib/viewer-nav";

const single: FileLike[] = [{ page_count: 3 }];
const multi: FileLike[] = [{ page_count: 2 }, { page_count: 1 }, { page_count: 2 }];

describe("nextPos", () => {
  test("advances within a file", () => {
    expect(nextPos(single, { fileIndex: 0, pageIndex: 0 })).toEqual({ fileIndex: 0, pageIndex: 1 });
  });

  test("crosses into the next file at end of current file", () => {
    expect(nextPos(multi, { fileIndex: 0, pageIndex: 1 })).toEqual({ fileIndex: 1, pageIndex: 0 });
  });

  test("returns null at the last page of the last file", () => {
    expect(nextPos(single, { fileIndex: 0, pageIndex: 2 })).toBeNull();
    expect(nextPos(multi, { fileIndex: 2, pageIndex: 1 })).toBeNull();
  });
});

describe("prevPos", () => {
  test("steps back within a file", () => {
    expect(prevPos(single, { fileIndex: 0, pageIndex: 2 })).toEqual({ fileIndex: 0, pageIndex: 1 });
  });

  test("crosses back to the last page of the previous file", () => {
    expect(prevPos(multi, { fileIndex: 1, pageIndex: 0 })).toEqual({ fileIndex: 0, pageIndex: 1 });
  });

  test("returns null at the very first page", () => {
    expect(prevPos(single, { fileIndex: 0, pageIndex: 0 })).toBeNull();
    expect(prevPos(multi, { fileIndex: 0, pageIndex: 0 })).toBeNull();
  });
});

describe("globalPage", () => {
  test("single file is 1-based with total", () => {
    expect(globalPage(single, { fileIndex: 0, pageIndex: 0 })).toEqual({ n: 1, total: 3 });
    expect(globalPage(single, { fileIndex: 0, pageIndex: 2 })).toEqual({ n: 3, total: 3 });
  });

  test("multi-file sums preceding files' pages", () => {
    // files: [2,1,2] total 5. position file1/page0 => 2 preceding + 1 = 3
    expect(globalPage(multi, { fileIndex: 1, pageIndex: 0 })).toEqual({ n: 3, total: 5 });
    // file2/page1 => 2+1 preceding + 2 = 5
    expect(globalPage(multi, { fileIndex: 2, pageIndex: 1 })).toEqual({ n: 5, total: 5 });
  });
});

describe("lastPos", () => {
  test("single file lands on its final page", () => {
    expect(lastPos(single)).toEqual({ fileIndex: 0, pageIndex: 2 });
  });

  test("multi-file lands on the last page of the last file", () => {
    expect(lastPos(multi)).toEqual({ fileIndex: 2, pageIndex: 1 });
  });

  test("empty piece is the origin", () => {
    expect(lastPos([])).toEqual({ fileIndex: 0, pageIndex: 0 });
  });
});

describe("empty files (defensive)", () => {
  test("globalPage of empty piece is 0/0", () => {
    const empty: FileLike[] = [];
    const pos: Pos = { fileIndex: 0, pageIndex: 0 };
    expect(globalPage(empty, pos)).toEqual({ n: 0, total: 0 });
  });
});
