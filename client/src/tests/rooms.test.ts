import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ROOMS_OFF_TEXT, removeProposal, roomJoinUrl, roomsStatus, startRoomProblem,
} from "../lib/rooms";
import { configureApi } from "../lib/api";
import { ROOM_FULL_TEXT, SLOW_DOWN_TEXT, roomProblem } from "../room/problems";

describe("roomJoinUrl", () => {
  test("carries the temporary room credential in the fragment", () => {
    configureApi({ baseUrl: "https://lockups.example.com/", key: "director" });
    const link = roomJoinUrl("room one", "secret value");
    expect(link).toBe(
      "https://lockups.example.com/room/room%20one#token=secret%20value",
    );
    expect(link.split("#")[0]).not.toContain("secret");
  });
});

function serve(status: number, body?: unknown) {
  const mock = vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("roomsStatus", () => {
  beforeEach(() => { configureApi({ baseUrl: "https://band.example.com", key: "director" }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  test("a 404 means the server has rooms switched off, not a missing room", async () => {
    serve(404, { detail: "Rehearsal rooms are switched off on this server" });
    expect(await roomsStatus()).toEqual({ enabled: false });
  });

  test("rooms on with nobody rehearsing is enabled with no room", async () => {
    serve(200, null);
    expect(await roomsStatus()).toEqual({ enabled: true, room: null });
  });

  test("rooms on with an open room hands the room over", async () => {
    const room = { room: { id: "r1", title: "Sunday", state: "open", revision: 3, queue_revision: 1 }, participants: [], proposals: [], queue: [] };
    serve(200, room);
    expect(await roomsStatus()).toEqual({ enabled: true, room });
  });

  test("any other failure is still a failure, so the card does not pretend", async () => {
    serve(500);
    await expect(roomsStatus()).rejects.toThrow("500");
  });
});

describe("removeProposal", () => {
  beforeEach(() => { configureApi({ baseUrl: "https://band.example.com", key: "director" }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  test("is a director DELETE on the proposal", async () => {
    const mock = serve(200, { ok: true, revision: 4 });
    await removeProposal("r1", "p1");
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://band.example.com/api/rooms/r1/proposals/p1");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>)["X-Bandstand-Key"]).toBe("director");
  });

  test("a refusal reaches the caller", async () => {
    serve(404, { detail: "Proposal not found" });
    await expect(removeProposal("r1", "gone")).rejects.toThrow("404");
  });
});

describe("startRoomProblem", () => {
  test("says plainly when rooms are off, when one is open, and otherwise", () => {
    expect(startRoomProblem(new Error("POST /api/rooms -> 404"))).toBe(ROOMS_OFF_TEXT);
    expect(startRoomProblem(new Error("POST /api/rooms -> 409"))).toBe("A room is already open. Close it first.");
    expect(startRoomProblem(new Error("POST /api/rooms -> 500"))).toBe(
      "Could not start the room. Check the connection and try again.",
    );
    expect(startRoomProblem("not an error")).toBe(
      "Could not start the room. Check the connection and try again.",
    );
  });
});

describe("guest page problems", () => {
  test("maps the server's answers to what the page should say", () => {
    expect(roomProblem(410)).toBe("closed");
    expect(roomProblem(404)).toBe("off");
    expect(roomProblem(429)).toBe("slow");
    expect(roomProblem(409)).toBe("full");
    expect(roomProblem(401)).toBe("request");
    expect(roomProblem(500)).toBe("request");
  });

  test("the slow-down sentence is plain and has no dash", () => {
    expect(SLOW_DOWN_TEXT).toBe("That is a lot of songs at once. Wait a moment, then post again.");
    expect(SLOW_DOWN_TEXT).not.toMatch(/[–—]/);
    expect(ROOM_FULL_TEXT).toBe("This room is full. Ask the host to make space, then try again.");
    expect(ROOM_FULL_TEXT).not.toMatch(/[–—]/);
    expect(ROOMS_OFF_TEXT).not.toMatch(/[–—]/);
  });
});
