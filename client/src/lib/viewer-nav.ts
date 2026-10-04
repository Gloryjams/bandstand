// Pure navigation math for the viewer: walking pages across a piece's files.

export interface FileLike {
  page_count: number;
}

export interface Pos {
  fileIndex: number;
  pageIndex: number;
}

/** Next page, crossing into the next file at a file boundary. null at piece end. */
export function nextPos(files: FileLike[], pos: Pos): Pos | null {
  const file = files[pos.fileIndex];
  if (!file) return null;
  if (pos.pageIndex < file.page_count - 1) {
    return { fileIndex: pos.fileIndex, pageIndex: pos.pageIndex + 1 };
  }
  if (pos.fileIndex < files.length - 1) {
    return { fileIndex: pos.fileIndex + 1, pageIndex: 0 };
  }
  return null;
}

/** Previous page, crossing back to the last page of the prior file. null at piece start. */
export function prevPos(files: FileLike[], pos: Pos): Pos | null {
  if (pos.pageIndex > 0) {
    return { fileIndex: pos.fileIndex, pageIndex: pos.pageIndex - 1 };
  }
  if (pos.fileIndex > 0) {
    const prev = files[pos.fileIndex - 1];
    if (!prev) return null;
    return { fileIndex: pos.fileIndex - 1, pageIndex: prev.page_count - 1 };
  }
  return null;
}

/** The last page of the piece (last page of the last file). Origin for an empty piece. */
export function lastPos(files: FileLike[]): Pos {
  if (files.length === 0) return { fileIndex: 0, pageIndex: 0 };
  const fileIndex = files.length - 1;
  return { fileIndex, pageIndex: Math.max(0, (files[fileIndex]?.page_count ?? 1) - 1) };
}

/** 1-based page number within the whole piece, and the piece's total page count. */
export function globalPage(files: FileLike[], pos: Pos): { n: number; total: number } {
  const total = files.reduce((sum, f) => sum + f.page_count, 0);
  if (files.length === 0) return { n: 0, total: 0 };
  let preceding = 0;
  for (let i = 0; i < pos.fileIndex && i < files.length; i++) {
    preceding += files[i]?.page_count ?? 0;
  }
  return { n: preceding + pos.pageIndex + 1, total };
}
