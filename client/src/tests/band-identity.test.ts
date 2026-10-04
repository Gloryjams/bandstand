import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getApiConfig } from "../lib/api";
import { bootBands, signIn, switchBand } from "../lib/bands";
import { db, LEGACY_DB_NAME, setActiveDb } from "../lib/db";
import { legacyBandId, loadBandsState, saveBandsState } from "../lib/meta";
import { useUi } from "../lib/store";

const EVIL = "https://evil.example/b7373b6a";
const REAL = "https://bandstand.example.com";
const keys: Record<string, string> = { [EVIL]: "evil-test-key", [REAL]: "real-test-key" };
const manifest = {
  pieces: [], files: [], audio_tracks: [], annotations: [], bookmarks: [],
  section_links: [], setlists: [], setlist_items: [], server_time_ms: 1,
};

beforeEach(async () => {
  setActiveDb(LEGACY_DB_NAME);
  await db.delete();
  await db.open();
  await saveBandsState({ bands: [], activeId: null });
  useUi.setState({ bands: [], activeBandId: null, pairing: null, identity: null });
});

afterEach(async () => {
  const { bands } = await loadBandsState();
  db.close();
  for (const band of bands) await Dexie.delete(band.dbName);
  setActiveDb(LEGACY_DB_NAME);
  await db.delete();
  await saveBandsState({ bands: [], activeId: null });
  vi.unstubAllGlobals();
});

describe("band identity through sign-in and switching", () => {
  test.each([[EVIL, REAL], [REAL, EVIL]])("keeps keys and database contents separate with %s first", async (first, second) => {
    expect(legacyBandId(first!)).toBe("200b78e0");
    expect(legacyBandId(second!)).toBe("200b78e0");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const address = String(input);
      const base = [EVIL, REAL].find((url) => address.startsWith(`${url}/api/`));
      if (!base) throw new Error("Unexpected test server");
      // Every request must send this URL's own key, including after activation.
      expect(new Headers(init?.headers).get("X-Bandstand-Key")).toBe(keys[base]);
      const body = address.endsWith("/api/whoami")
        ? { id: "test-member", name: "Test member", role: "member" }
        : address.endsWith("/api/manifest") ? manifest : { ok: true, name: base };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const older = await signIn(first!, keys[first!]!);
    expect(db.name).toBe(older.dbName);
    await db.kv.put({ key: "mirror-marker", value: first });
    const newer = await signIn(second!, keys[second!]!);
    expect(db.name).toBe(newer.dbName);
    expect(await db.kv.get("mirror-marker")).toBeUndefined();
    await db.kv.put({ key: "mirror-marker", value: second });
    expect(older.id).not.toBe(newer.id);
    expect(older.dbName).not.toBe(newer.dbName);
    expect((await loadBandsState()).bands).toEqual([older, newer]);

    expect(await bootBands()).toEqual(newer);
    for (const band of [older, newer]) {
      await switchBand(band.id);
      expect(db.name).toBe(band.dbName);
      expect(getApiConfig()).toEqual({ baseUrl: band.url, key: band.key });
      expect(useUi.getState().pairing).toEqual({ url: band.url, key: band.key });
      expect((await db.kv.get("mirror-marker"))?.value).toBe(band.url);
      expect(fetchMock).toHaveBeenCalledWith(`${band.url}/api/manifest`, expect.objectContaining({
        headers: { "X-Bandstand-Key": band.key },
      }));
    }
    expect(fetchMock.mock.calls.every(([address, init]) => {
      const base = [EVIL, REAL].find((url) => String(address).startsWith(`${url}/api/`));
      return base && new Headers(init?.headers).get("X-Bandstand-Key") === keys[base];
    })).toBe(true);
  });
});
