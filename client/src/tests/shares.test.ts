import { describe, it, expect, beforeEach, vi } from "vitest";

import { configureApi } from "../lib/api";
import { createShare, expiryLabel, shareNote, type ShareRow } from "../lib/shares";

const NOW = 1_770_000_000_000;

function row(over: Partial<ShareRow> = {}): ShareRow {
  return {
    id: "s1", target_kind: "piece", target_id: "p1", label: "Autumn Leaves",
    created_at: NOW, expires_at: NOW + 86_400_000, revoked_at: null, state: "active",
    ...over,
  };
}

describe("expiryLabel", () => {
  it("reports days, hours and minutes remaining", () => {
    expect(expiryLabel(row({ expires_at: NOW + 6 * 86_400_000 }), NOW)).toBe("Expires in 6 days");
    expect(expiryLabel(row({ expires_at: NOW + 86_400_000 }), NOW)).toBe("Expires in 1 day");
    expect(expiryLabel(row({ expires_at: NOW + 3 * 3_600_000 }), NOW)).toBe("Expires in 3 hours");
    expect(expiryLabel(row({ expires_at: NOW + 90_000 }), NOW)).toBe("Expires in 2 minutes");
  });

  it("never counts down past zero", () => {
    expect(expiryLabel(row({ expires_at: NOW - 1000 }), NOW)).toBe("Expired");
    expect(expiryLabel(row({ state: "expired", expires_at: NOW + 5000 }), NOW)).toBe("Expired");
  });

  it("revoked and open-ended links read plainly", () => {
    expect(expiryLabel(row({ state: "revoked", revoked_at: NOW }), NOW)).toBe("Revoked");
    expect(expiryLabel(row({ expires_at: null }), NOW)).toBe("No expiry");
  });
});

describe("shareNote", () => {
  it("warns that the link is a bearer credential", () => {
    expect(shareNote("piece")).toBe(
      "Anyone with this link can view until it expires or you revoke it.",
    );
  });

  it("adds the live-edit line for setlists only", () => {
    expect(shareNote("setlist")).toContain("Setlist edits show up live.");
    expect(shareNote("piece")).not.toContain("Setlist edits");
  });
});

describe("share api calls", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    configureApi({ baseUrl: "http://example.test", key: "test-key" });
  });

  function stubFetch(body: unknown) {
    const mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("posts the create payload in the server's snake_case shape", async () => {
    const mock = stubFetch({ id: "s1", token: "t", url: "https://x/s/t" });
    await createShare("setlist", "sl1", 168);
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe("http://example.test/api/shares");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      target_kind: "setlist", target_id: "sl1", ttl_hours: 168,
    });
  });

  it("sends a null ttl for an until-revoked link", async () => {
    const mock = stubFetch({ id: "s1", token: "t", url: "https://x/s/t" });
    await createShare("piece", "p1", null);
    expect(JSON.parse(mock.mock.calls[0]![1]?.body as string).ttl_hours).toBeNull();
  });

});
