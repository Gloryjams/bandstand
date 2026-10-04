import type { AppState } from "./db";
import type { Pos as NavPos } from "./viewer-nav";

const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;

/** A recent session is resumable if it names a piece and is within the 12h window. */
export function isResumable(state: AppState | undefined, nowMs: number): boolean {
  if (!state || !state.piece_id) return false;
  return nowMs - state.updated_at <= RESUME_WINDOW_MS;
}

/** Build the resume payload (everything but id/updated_at) from current viewer position. */
export function buildResume(args: {
  pieceId: string;
  files: { id: string }[];
  pos: NavPos;
  setlistId: string | null;
  setlistPos: number | null;
}): Omit<AppState, "id" | "updated_at"> {
  return {
    piece_id: args.pieceId,
    file_id: args.files[args.pos.fileIndex]?.id ?? null,
    page_index: args.pos.pageIndex,
    mode: "reading",
    zoom: 1,
    setlist_id: args.setlistId,
    setlist_position: args.setlistPos,
  };
}

/** Map a saved state back to a viewer position against the loaded files. */
export function restorePos(state: AppState, files: { id: string }[]): NavPos {
  const idx = files.findIndex((f) => f.id === state.file_id);
  return { fileIndex: idx >= 0 ? idx : 0, pageIndex: state.page_index };
}
