import { describe, expect, test } from "vitest";

import { LEGACY_DB_NAME } from "../lib/db";
import { bandId, normalizeUrl, removeBand, upsertBand, type BandsState } from "../lib/meta";

const empty: BandsState = { bands: [], activeId: null };

describe("bandId / normalizeUrl", () => {
  test("stable across trailing slashes and host case", () => {
    expect(bandId("http://192.168.1.21:7830/")).toBe(bandId("http://192.168.1.21:7830"));
    expect(bandId("https://Lockups.Example.com")).toBe(bandId("https://lockups.example.com"));
  });
  test("different servers get different ids", () => {
    expect(bandId("http://a:7830")).not.toBe(bandId("http://b:7830"));
  });
  test("normalize strips trailing slashes only", () => {
    expect(normalizeUrl("https://x.com///")).toBe("https://x.com");
    expect(normalizeUrl("https://x.com/app")).toBe("https://x.com/app");
  });
});

describe("upsertBand", () => {
  test("first band adopts the LEGACY db name (pre-switcher mirrors survive)", () => {
    const { state, band, added } = upsertBand(empty, "http://a:7830", "k1");
    expect(added).toBe(true);
    expect(band.dbName).toBe(LEGACY_DB_NAME);
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
    expect(band.dbName).toBe(LEGACY_DB_NAME);
    expect(state.activeId).toBe(band.id);
  });

  test("label from health wins; absent label preserved on rotation", () => {
    const { state } = upsertBand(empty, "http://a:7830", "k1", "The Lockups");
    expect(state.bands[0]!.label).toBe("The Lockups");
    const rotated = upsertBand(state, "http://a:7830", "k2");
    expect(rotated.band.label).toBe("The Lockups");
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
