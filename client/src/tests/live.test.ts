import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/sync", () => ({ fetchManifestAndMirror: vi.fn().mockResolvedValue(undefined) }));

import {
  fetchStreamTicket, startLivePush, stopLivePush, streamUrl, RECONNECT_DELAYS_MS,
} from "../lib/live";
import { CLIENT_ID } from "../lib/client-id";

// A stand-in for the browser's EventSource that records every address it was
// opened with and lets a test fire open/error by hand.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners: Record<string, (() => void)[]> = {};
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  close() { this.closed = true; }
}

function ticketReply(ticket: string) {
  return new Response(JSON.stringify({ ticket, expires_in: 60 }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

async function flush() {
  // Let the ticket fetch and the JSON parse settle (real I/O ticks, not timers).
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
}

describe("live push", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    stopLivePush();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks for a ticket with the header key and never puts the key in the address", async () => {
    let n = 0;
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ticketReply(`t${++n}`)));
    vi.stubGlobal("fetch", fetchMock);

    startLivePush("http://band.test/", "secret-key");
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://band.test/api/events/ticket",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Bandstand-Key": "secret-key" }),
      }),
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    const url = FakeEventSource.instances[0]!.url;
    expect(url).toBe(`http://band.test/api/events?ticket=t1&client=${encodeURIComponent(CLIENT_ID)}`);
    expect(url).not.toContain("secret-key");
  });

  it("does the same behind the member door: a /bands/<band> address, ticket first, no key in the address", async () => {
    // A member's pairing address is the public door's band path. The door passes
    // the ticket request on with the member key and the stream on with the ticket.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ticketReply("door-t1")));
    vi.stubGlobal("fetch", fetchMock);

    startLivePush("https://members.test/bands/lockups/", "member-key");
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://members.test/bands/lockups/api/events/ticket",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Bandstand-Key": "member-key" }),
      }),
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    const url = FakeEventSource.instances[0]!.url;
    expect(url).toBe(`https://members.test/bands/lockups/api/events?ticket=door-t1&client=${encodeURIComponent(CLIENT_ID)}`);
    expect(url).not.toContain("member-key");
  });

  it("reconnects with a fresh ticket after an error instead of reusing the spent one", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(ticketReply(`t${++n}`))));

    startLivePush("http://band.test", "k");
    await flush();
    const first = FakeEventSource.instances[0]!;
    first.onopen?.();
    first.onerror?.();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]!);
    await flush();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toContain("ticket=t2");
  });

  it("backs off while the server stays away, and stops on stopLivePush", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);

    startLivePush("http://band.test", "k");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[1]! - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    stopLivePush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not open a stream for a session that was stopped while the ticket was in flight", async () => {
    let resolve: ((r: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise<Response>((r) => { resolve = r; })));

    startLivePush("http://band.test", "k");
    await flush();
    stopLivePush();
    resolve!(ticketReply("late"));
    await flush();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("falls back to the key in the address only for a server from before tickets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })));
    expect(await fetchStreamTicket("http://old.test", "k")).toBeNull();
    expect(streamUrl("http://old.test", "k", null)).toContain("key=k");
    expect(streamUrl("http://new.test", "k", "t")).not.toContain("key=");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    await expect(fetchStreamTicket("http://band.test", "k")).rejects.toThrow(/401/);
  });
});
