import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, test, vi } from "vitest";

import { BandstandDB, LEGACY_DB_NAME } from "../lib/db";
import {
  legacyBandId, loadBandsState, migrateLegacyPairing, normalizeUrl, removeBand,
  saveBandsState, upsertBand, type BandPairing, type BandsState,
} from "../lib/meta";

const empty: BandsState = { bands: [], activeId: null };
const EVIL = "https://evil.example/b7373b6a";
const REAL = "https://bandstand.example.com";
const COLLISION_ID = "200b78e0";

function storedBand(url: string, key: string, dbName = `bandstand-${COLLISION_ID}`): BandPairing {
  return { id: COLLISION_ID, url, key, label: "Stored band", dbName };
}

afterEach(() => vi.unstubAllGlobals());

describe("legacyBandId / normalizeUrl", () => {
  test("stable across trailing slashes and host case", () => {
    expect(legacyBandId("http://192.168.1.21:7830/")).toBe(legacyBandId("http://192.168.1.21:7830"));
    expect(legacyBandId("https://Lockups.Example.com")).toBe(legacyBandId("https://lockups.example.com"));
  });
  test("different servers get different ids", () => {
    expect(legacyBandId("http://a:7830")).not.toBe(legacyBandId("http://b:7830"));
  });
  test("the attack URLs collide under the old FNV-1a 32-bit scheme", () => {
    expect(legacyBandId(EVIL)).toBe(COLLISION_ID);
    expect(legacyBandId(REAL)).toBe(COLLISION_ID);
  });
  test("normalization removes trailing path slashes", () => {
    expect(normalizeUrl("https://x.com///")).toBe("https://x.com");
    expect(normalizeUrl("https://x.com/app")).toBe("https://x.com/app");
  });
  test("normalization canonicalizes hosts and default ports but preserves path case", () => {
    expect(normalizeUrl(" HTTPS://Band.Example:443/Bands/One/ ")).toBe("https://band.example/Bands/One");
    expect(normalizeUrl("https://band.example/Bands/One")).not.toBe(normalizeUrl("https://band.example/bands/one"));
  });
});

describe("upsertBand", () => {
  test("a new first band gets a fresh id and database", () => {
    const { state, band, added } = upsertBand(empty, "http://a:7830", "k1");
    expect(added).toBe(true);
    expect(band.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(band.dbName).toBe(`bandstand-${band.id}`);
    expect(state.activeId).toBe(band.id);
  });

  test("second band gets its own namespaced db and becomes active", () => {
    const one = upsertBand(empty, "http://a:7830", "k1").state;
    const { state, band, added } = upsertBand(one, "http://b:7830", "k2");
    expect(added).toBe(true);
    expect(band.dbName).toBe(`bandstand-${band.id}`);
    expect(state.bands).toHaveLength(2);
    expect(state.activeId).toBe(band.id);
  });

  test("known url replaces the key (rotation), keeps dbName, re-activates", () => {
    const one = upsertBand(empty, "http://a:7830", "k1").state;
    const two = upsertBand(one, "http://b:7830", "k2").state;
    const { state, band, added } = upsertBand(two, "http://a:7830/", "k1-rotated");
    expect(added).toBe(false);
    expect(state.bands).toHaveLength(2);
    expect(band.key).toBe("k1-rotated");
    expect(band.id).toBe(one.bands[0]!.id);
    expect(band.dbName).toBe(one.bands[0]!.dbName);
    expect(state.activeId).toBe(band.id);
  });

  test("label from health wins; absent label preserved on rotation", () => {
    const { state } = upsertBand(empty, "http://a:7830", "k1", "The Lockups");
    expect(state.bands[0]!.label).toBe("The Lockups");
    const rotated = upsertBand(state, "http://a:7830", "k2");
    expect(rotated.band.label).toBe("The Lockups");
  });

  test.each([[EVIL, REAL], [REAL, EVIL]])("colliding URLs stay separate when %s is added first", (first, second) => {
    // Establish that this exercises an actual legacy hash collision.
    expect(legacyBandId(first!)).toBe(COLLISION_ID);
    expect(legacyBandId(second!)).toBe(COLLISION_ID);
    const one = upsertBand(empty, first!, "first-test-key");
    const two = upsertBand(one.state, second!, "second-test-key");
    expect(two.added).toBe(true);
    expect(two.state.bands).toEqual([one.band, two.band]);
    expect(two.band.url).toBe(second);
    expect(one.band.id).not.toBe(two.band.id);
    expect(one.band.dbName).not.toBe(two.band.dbName);
    const rotated = upsertBand(two.state, `${first}/`, "rotated-test-key");
    expect(rotated.added).toBe(false);
    expect(rotated.band).toEqual({ ...one.band, key: "rotated-test-key" });
    expect(rotated.state.bands[1]).toEqual(two.band);
  });

  test.each([[EVIL, REAL], [REAL, EVIL]])("a stored FNV band for %s cannot capture another URL's key", (first, second) => {
    const old = storedBand(first!, "old-test-key", LEGACY_DB_NAME);
    const state = { bands: [old], activeId: old.id };
    const added = upsertBand(state, second!, "new-test-key");
    expect(added.added).toBe(true);
    expect(added.state.bands[0]).toEqual(old);
    expect(added.band.url).toBe(second);
    expect(added.band.id).not.toBe(old.id);
    expect(added.band.dbName).not.toBe(old.dbName);
    const rotated = upsertBand(added.state, `${first}/`, "rotated-test-key");
    expect(rotated.band).toEqual({ ...old, key: "rotated-test-key" });
    expect(rotated.state.bands[1]).toEqual(added.band);
  });

  test("new ids work without secure-context crypto APIs", () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    vi.stubGlobal("isSecureContext", false);
    const { band } = upsertBand(empty, "http://192.168.1.20:7800", "lan-test-key");
    expect(band.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("host case rotates the same band but case-sensitive paths stay separate", () => {
    const one = upsertBand(empty, "https://Band.Example/Bands/One", "first-test-key");
    const rotated = upsertBand(one.state, "https://band.example:443/Bands/One/", "rotated-test-key");
    expect(rotated.added).toBe(false);
    expect(rotated.band.id).toBe(one.band.id);
    const other = upsertBand(rotated.state, "https://band.example/bands/one", "other-test-key");
    expect(other.added).toBe(true);
    expect(other.band.id).not.toBe(one.band.id);
  });
});

describe("stored registry migration", () => {
  test("keeps legacy ids, database names, mirrors and queued writes across reload and rotation", async () => {
    const old = storedBand("https://Bandstand.Example.com/", "old-test-key", LEGACY_DB_NAME);
    const other = { ...storedBand("http://other.example", "other-test-key"), id: "abcdef12", dbName: "bandstand-abcdef12" };
    const mirror = new BandstandDB(old.dbName);
    const otherMirror = new BandstandDB(other.dbName);
    try {
      await mirror.kv.put({ key: "mirror-marker", value: "kept" });
      await mirror.sync_queue.add({ op: "upsert", entity: "pieces", payload: { id: "pending" }, created_at: 1 });
      await otherMirror.kv.put({ key: "mirror-marker", value: "other-kept" });
      await saveBandsState({ bands: [old, other], activeId: other.id });
      const migrated = await loadBandsState();
      expect(migrated).toEqual({ bands: [{ ...old, url: REAL }, other], activeId: other.id });
      expect(await loadBandsState()).toEqual(migrated);
      expect((await mirror.kv.get("mirror-marker"))?.value).toBe("kept");
      expect(await mirror.sync_queue.count()).toBe(1);
      expect((await otherMirror.kv.get("mirror-marker"))?.value).toBe("other-kept");
      const rotated = upsertBand(migrated, REAL, "rotated-test-key");
      expect(rotated.band).toEqual({ ...old, url: REAL, key: "rotated-test-key" });
      expect(rotated.state.bands[1]).toEqual(other);
    } finally {
      await mirror.delete();
      await otherMirror.delete();
      await saveBandsState(empty);
    }
  });

  test.each([[EVIL, REAL], [REAL, EVIL]])("repairs duplicate stored ids when %s is older", async (first, second) => {
    const older = storedBand(first!, "older-test-key");
    const newer = storedBand(second!, "newer-test-key");
    const sharedMirror = new BandstandDB(older.dbName);
    let freshMirror: BandstandDB | undefined;
    try {
      await sharedMirror.kv.put({ key: "mirror-marker", value: "older-data" });
      await saveBandsState({ bands: [older, newer], activeId: COLLISION_ID });
      const migrated = await loadBandsState();
      expect(migrated.bands).toHaveLength(2);
      expect(migrated.bands[0]).toEqual(older);
      const repaired = migrated.bands[1]!;
      expect(repaired).toMatchObject({ url: second, key: newer.key, label: newer.label });
      expect(repaired.id).not.toBe(older.id);
      expect(repaired.dbName).toBe(`bandstand-${repaired.id}`);
      expect(repaired.dbName).not.toBe(older.dbName);
      // A formerly ambiguous active id keeps pointing at the first record, as before.
      expect(migrated.activeId).toBe(older.id);
      expect(await loadBandsState()).toEqual(migrated);
      const registry = new Dexie("bandstand-meta");
      registry.version(1).stores({ kv: "key" });
      try {
        expect((await registry.table("kv").get("bands")).value).toEqual(migrated.bands);
      } finally { registry.close(); }
      freshMirror = new BandstandDB(repaired.dbName);
      expect(await freshMirror.kv.count()).toBe(0);
      await freshMirror.kv.put({ key: "mirror-marker", value: "newer-data" });
      expect((await sharedMirror.kv.get("mirror-marker"))?.value).toBe("older-data");
      const rotated = upsertBand(migrated, second!, "rotated-test-key");
      expect(rotated.state.bands[0]).toEqual(older);
      expect(rotated.band).toEqual({ ...repaired, key: "rotated-test-key" });
    } finally {
      await sharedMirror.delete();
      await freshMirror?.delete();
      await saveBandsState(empty);
    }
  });

  test("the pre-switcher pairing keeps its FNV id and legacy database", async () => {
    const legacy = new BandstandDB(LEGACY_DB_NAME);
    try {
      await saveBandsState(empty);
      await legacy.kv.bulkPut([
        { key: "server_url", value: REAL }, { key: "server_key", value: "legacy-test-key" },
        { key: "mirror-marker", value: "kept" },
      ]);
      await migrateLegacyPairing();
      const migrated = await loadBandsState();
      expect(migrated.bands).toEqual([expect.objectContaining({ id: COLLISION_ID, url: REAL, key: "legacy-test-key", dbName: LEGACY_DB_NAME })]);
      expect(migrated.activeId).toBe(COLLISION_ID);
      expect(await legacy.kv.get("server_url")).toBeUndefined();
      expect(await legacy.kv.get("server_key")).toBeUndefined();
      expect((await legacy.kv.get("mirror-marker"))?.value).toBe("kept");
      await migrateLegacyPairing();
      expect(await loadBandsState()).toEqual(migrated);
    } finally {
      await legacy.delete();
      await saveBandsState(empty);
    }
  });
});

describe("removeBand", () => {
  test("removing the active band activates the next remaining one", () => {
    const a = upsertBand(empty, "http://a:7830", "k1").state;
    const withB = upsertBand(a, "http://b:7830", "k2");
    const next = removeBand(withB.state, withB.band.id); // b was active
    expect(next.bands).toHaveLength(1);
    expect(next.activeId).toBe(next.bands[0]!.id);
  });

  test("removing the last band empties the registry", () => {
    const { state, band } = upsertBand(empty, "http://a:7830", "k1");
    const next = removeBand(state, band.id);
    expect(next.bands).toHaveLength(0);
    expect(next.activeId).toBeNull();
  });

  test("removing an inactive band keeps the active one", () => {
    const a = upsertBand(empty, "http://a:7830", "k1");
    const withB = upsertBand(a.state, "http://b:7830", "k2");
    const next = removeBand(withB.state, a.band.id); // remove a; b stays active
    expect(next.activeId).toBe(withB.band.id);
  });
});
