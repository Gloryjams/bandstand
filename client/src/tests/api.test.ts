import { describe, it, expect, beforeEach, vi } from "vitest";

import { api, configureApi } from "../lib/api";

describe("api", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    configureApi({ baseUrl: "http://example.test", key: "test-key" });
  });

  it("attaches X-Bandstand-Key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await api.get("/api/health");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.test/api/health",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Bandstand-Key": "test-key" }),
      }),
    );
  });

  it("throws on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("nope", { status: 401 }),
    ));
    await expect(api.get("/api/secret")).rejects.toThrow(/401/);
  });

  it("posts JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await api.put("/api/pieces/x", { title: "t" });
    const call = fetchMock.mock.calls[0]!;
    expect(call[1]?.method).toBe("PUT");
    expect(call[1]?.body).toBe(JSON.stringify({ title: "t" }));
  });
});
