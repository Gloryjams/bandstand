import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";

import { db } from "../lib/db";

describe("Dexie schema", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("creates expected tables", () => {
    expect(db.tables.map((t) => t.name).sort()).toEqual(
      [
        "annotations",
        "app_state",
        "audio_tracks",
        "bookmarks",
        "files",
        "kv",
        "pieces",
        "section_links",
        "setlist_items",
        "setlists",
        "sync_queue",
      ],
    );
  });

  it("inserts and queries a piece", async () => {
    await db.pieces.put({
      id: "p1",
      title: "Take Five",
      composer: "Paul Desmond",
      music_key: "Ebm",
      time_sig: "5/4",
      tempo: 174,
      genre: "jazz",
      tags: "[]",
      notes: null,
      page_count: 3,
      added_at: 1,
      updated_at: 1,
      last_opened_at: null,
      play_count: 0,
      preferred_orientation: null,
      default_half_page_turns: 0,
      deleted_at: null,
    });
    const p = await db.pieces.get("p1");
    expect(p?.title).toBe("Take Five");
  });

  it("composite key on annotations", async () => {
    await db.annotations.put({
      piece_id: "p1",
      file_id: "f1",
      page_index: 0,
      svg_paths: "[]",
      updated_at: 1,
    });
    const got = await db.annotations.get(["p1", "f1", 0]);
    expect(got).toBeTruthy();
  });
});
