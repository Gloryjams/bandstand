import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApi, getApiConfig } from "../lib/api";
import { signIn } from "../lib/bands";

/**
 * A failed sign-in must leave the app talking to the band it was already in.
 * signIn points the API at the link's server to read its name; if that server is
 * unreachable or unhappy, the API goes back to where it was, so a signed-in player
 * who taps a dead link and then Cancel keeps syncing with their own band.
 */

const OWN = { baseUrl: "http://own-band.example", key: "a".repeat(64) };

beforeEach(() => {
  vi.restoreAllMocks();
  configureApi(OWN);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signIn when the link's server cannot be used", () => {
  it("puts the API back on the current band when the server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(signIn("http://dead.example/", "b".repeat(64))).rejects.toThrow();

    expect(getApiConfig()).toEqual(OWN);
  });

  it("puts the API back on the current band when the server says it is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(signIn("http://sad.example", "b".repeat(64))).rejects.toThrow("Health check failed");

    expect(getApiConfig()).toEqual(OWN);
  });
});
