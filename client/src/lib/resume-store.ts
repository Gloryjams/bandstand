import { db, type AppState } from "./db";
import { buildResume } from "./resume";
import type { Pos } from "./viewer-nav";

let timer: ReturnType<typeof setTimeout> | null = null;

/** Debounced (500ms) persist of the current viewer position to the single app_state row. */
export function writeResume(args: {
  pieceId: string;
  files: { id: string }[];
  pos: Pos;
  setlistId: string | null;
  setlistPos: number | null;
}): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const payload = buildResume(args);
    void db.app_state.put({ id: "current", ...payload, updated_at: Date.now() });
  }, 500);
}

export function readResume(): Promise<AppState | undefined> {
  return db.app_state.get("current");
}

export async function clearResume(): Promise<void> {
  await db.app_state.delete("current");
}
