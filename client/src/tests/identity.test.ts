import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { configureApi } from "../lib/api";
import { db } from "../lib/db";
import { canAuthor, DIRECTOR_FALLBACK, refreshIdentity, type Identity } from "../lib/identity";

const member: Identity = { id: "m1", name: "Rea", role: "member" };
const director: Identity = { id: "root", name: "Director", role: "director" };

describe("canAuthor", () => {
  test("director authors", () => {
    expect(canAuthor(director)).toBe(true);
  });

  test("member does not author", () => {
    expect(canAuthor(member)).toBe(false);
  });

  test("unresolved identity errs toward author UI (server still gates writes)", () => {
    // A cold start resolves identity async; hiding-then-revealing would flicker
    // for the director every launch, and a member's stray tap just 403s.
    expect(canAuthor(null)).toBe(true);
  });

  test("legacy fallback is the director", () => {
    // Pre-members servers 404 /api/whoami; behavior must match the old
    // single-user world where the one key had full authority.
    expect(canAuthor(DIRECTOR_FALLBACK)).toBe(true);
    expect(DIRECTOR_FALLBACK.role).toBe("director");
  });
});

describe("refreshIdentity", () => {
  beforeEach(async () => {
    configureApi({ baseUrl: "http://band.example", key: "test-key" });
    await db.delete();
    await db.open();
  });
  afterEach(() => vi.unstubAllGlobals());

  test.each([401, 403])("does not use a cached director or fallback on %s", async (status) => {
    await db.kv.put({ key: "identity", value: director });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(null, { status })));
    expect(await refreshIdentity()).toBeNull();
    expect(await db.kv.get("identity")).toBeUndefined();
    expect(await refreshIdentity()).toBeNull();
  });

  test("404 means an older director server, even with a cached member", async () => {
    await db.kv.put({ key: "identity", value: member });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    expect(await refreshIdentity()).toEqual(DIRECTOR_FALLBACK);
  });

  test("keeps the cached member while offline", async () => {
    await db.kv.put({ key: "identity", value: member });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await refreshIdentity()).toEqual(member);
  });
});
