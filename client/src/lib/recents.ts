import { db } from "./db";
import { queueWrite } from "./sync-queue";
import { useUi } from "./store";

// Persisted in db.kv (not the server manifest), so it survives both a cold start
// and a manifest mirror (the mirror clears the synced tables but never touches kv).
const KV_KEY = "recent_piece_ids";

/**
 * Record that a piece was opened. Updates the in-memory recents list (quick-find
 * ordering), persists it to db.kv, and bumps the piece's last_opened_at /
 * play_count — enqueued as a pieces upsert so the stats sync to the server and
 * come back on the next mirror.
 */
export async function recordPieceOpened(pieceId: string): Promise<void> {
  useUi.getState().pushRecent(pieceId);
  const ids = useUi.getState().recentPieceIds;
  await db.kv.put({ key: KV_KEY, value: ids });

  const piece = await db.pieces.get(pieceId);
  if (!piece) return; // unknown piece (e.g. deleted between manifest pulls)
  const last_opened_at = Date.now();
  const play_count = (piece.play_count ?? 0) + 1;
  await db.pieces.update(pieceId, { last_opened_at, play_count });
  await queueWrite("upsert", "pieces", { id: pieceId, last_opened_at, play_count });
}

/** Load the persisted recents list into the store on app start. */
export async function hydrateRecents(): Promise<void> {
  const row = await db.kv.get(KV_KEY);
  if (row && Array.isArray(row.value)) {
    useUi.getState().setRecents(row.value as string[]);
  }
}
