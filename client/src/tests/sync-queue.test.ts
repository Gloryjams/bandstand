import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the api layer the queue posts through.
const rawMock = vi.fn();
vi.mock("../lib/api", () => ({ api: { raw: (...a: unknown[]) => rawMock(...a) } }));

import { db } from "../lib/db";
import { enqueue, drainQueue } from "../lib/sync-queue";

beforeEach(async () => {
  await db.delete();
  await db.open();
  rawMock.mockReset();
});

describe("sync-queue", () => {
  it("enqueue appends an op (and does not touch the network)", async () => {
    await enqueue("upsert", "bookmarks", { id: "b1" });
    const rows = await db.sync_queue.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op: "upsert", entity: "bookmarks", payload: { id: "b1" } });
    expect(rawMock).not.toHaveBeenCalled();
  });

  it("drains queued ops in order and clears them on success", async () => {
    rawMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, applied: 2, errors: [] }) });
    await enqueue("upsert", "bookmarks", { id: "b1" });
    await enqueue("delete", "bookmarks", { id: "b1" });

    const done = await drainQueue();

    expect(done).toBe(true);
    expect(rawMock).toHaveBeenCalledOnce();
    const [path, init] = rawMock.mock.calls[0]!;
    expect(path).toBe("/api/sync");
    const sent = JSON.parse(init.body).ops;
    expect(sent.map((o: { op: string }) => o.op)).toEqual(["upsert", "delete"]); // FIFO
    expect(await db.sync_queue.count()).toBe(0);
  });

  it("keeps the queue intact when the server is unreachable", async () => {
    rawMock.mockResolvedValue({ ok: false, status: 503 });
    await enqueue("upsert", "setlists", { id: "s1" });
    expect(await drainQueue()).toBe(false);
    expect(await db.sync_queue.count()).toBe(1);
  });

  it("keeps the queue intact when offline (network throws)", async () => {
    rawMock.mockRejectedValue(new Error("Failed to fetch"));
    await enqueue("upsert", "pieces", { id: "p1" });
    expect(await drainQueue()).toBe(false);
    expect(await db.sync_queue.count()).toBe(1);
  });

  it("only deletes the ops it sent, preserving writes queued mid-drain", async () => {
    // The POST resolves after a new op is enqueued, simulating a write during the flush.
    await enqueue("upsert", "pieces", { id: "p1" });
    rawMock.mockImplementation(async () => {
      await enqueue("upsert", "pieces", { id: "p2" }); // queued while draining
      return { ok: true, json: async () => ({ ok: true, applied: 1, errors: [] }) };
    });

    const done = await drainQueue();

    expect(done).toBe(false); // queue not empty (p2 remains)
    const left = await db.sync_queue.toArray();
    expect(left.map((o) => (o.payload as { id: string }).id)).toEqual(["p2"]);
  });

  it("drops applied ops even when the server reports per-op errors (forward progress)", async () => {
    rawMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, applied: 0, errors: [{ index: 0, error: "boom" }] }) });
    await enqueue("upsert", "bookmarks", { id: "bad" });
    expect(await drainQueue()).toBe(true);
    expect(await db.sync_queue.count()).toBe(0);
  });
});
