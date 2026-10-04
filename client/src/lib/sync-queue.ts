// Offline-first write queue. Every change writes to Dexie immediately (the on-device
// source of truth) and appends an op here; `drainQueue` flushes the ops to the server
// in FIFO order via POST /api/sync. Offline at a gig, writes pile up safely and sync
// when the tablet is back on the network — nothing is lost.

import { api } from "./api";
import { db } from "./db";
import { CLIENT_ID } from "./client-id";
import { useUi } from "./store";

export type Entity =
  | "annotations"
  | "bookmarks"
  | "section_links"
  | "pieces"
  | "setlists"
  | "setlist_items";
export type Action = "upsert" | "delete";

/** Append a write to the queue. Local Dexie state is updated separately by the caller. */
export async function enqueue(op: Action, entity: Entity, payload: unknown): Promise<void> {
  // Members can't author (server 403s every /api/sync op from a member key). Author
  // UI is hidden for them, so this only catches stragglers — but a queued write that
  // can never be accepted would block the manifest mirror forever (drain-before-mirror
  // bails on a non-empty queue), wedging the device. Drop instead of queue.
  if (useUi.getState().identity?.role === "member") return;
  await db.sync_queue.add({ op, entity, payload, created_at: Date.now() });
}

let draining = false;

/**
 * Flush queued writes to the server in FIFO order. Returns true if the queue is empty
 * afterward, false if it stopped early (offline / server error — the queue is preserved
 * for a later retry). Re-entrancy-safe: a concurrent call no-ops.
 */
export async function drainQueue(): Promise<boolean> {
  if (draining) return false;
  draining = true;
  try {
    const ops = await db.sync_queue.orderBy("id").toArray();
    if (ops.length === 0) return true;
    let res: Response;
    try {
      res = await api.raw("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bandstand-Client": CLIENT_ID },
        body: JSON.stringify({ ops: ops.map((o) => ({ op: o.op, entity: o.entity, payload: o.payload })) }),
      });
    } catch {
      return false; // offline / network error — keep the queue
    }
    if (res.status === 403) {
      // This key is not allowed to write (member device with pre-gating leftovers,
      // or a role change). These ops can NEVER be accepted; keeping them would block
      // every future manifest mirror. Drop the batch.
      await db.sync_queue.bulkDelete(ops.map((o) => o.id as number));
      console.warn("[sync] server refused writes for this key; dropped", ops.length, "ops");
      return (await db.sync_queue.count()) === 0;
    }
    if (!res.ok) return false; // server unreachable — keep the queue
    const body = await res.json().catch(() => ({}));
    if (Array.isArray(body.errors) && body.errors.length) {
      // Single-user app: a rejected op is malformed/unrecoverable. Log and drop it with
      // the rest so a poison op can never wedge the queue forever.
      console.warn("[sync] server rejected ops:", body.errors);
    }
    // Delete only the ops we sent; writes queued during the flush keep their place.
    await db.sync_queue.bulkDelete(ops.map((o) => o.id as number));
    return (await db.sync_queue.count()) === 0;
  } finally {
    draining = false;
  }
}

/** Queue a write and opportunistically flush it (instant when online, safe when not). */
export async function queueWrite(op: Action, entity: Entity, payload: unknown): Promise<void> {
  await enqueue(op, entity, payload);
  void drainQueue();
}
