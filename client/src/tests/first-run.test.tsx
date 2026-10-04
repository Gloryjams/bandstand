import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { configureApi, getApiConfig } from "../lib/api";
import { bootBands, signIn } from "../lib/bands";
import { db, LEGACY_DB_NAME, setActiveDb, type Piece } from "../lib/db";
import { DATA_CHANGED_EVENT } from "../lib/live";
import { loadBandsState, saveBandsState, upsertBand } from "../lib/meta";
import { useUi } from "../lib/store";
import { Home } from "../routes/Home";
import { PairConfirm } from "../routes/PairConfirm";
import { Settings } from "../routes/Settings";

const URL = "http://band.example";
const KEY = "test-key";
const MEMBER = { id: "m1", name: "Player", role: "member" as const };
const REJECTED = "That key was not accepted by this server. Check it and try again.";
const piece: Piece = {
  id: "p1", title: "First tune", composer: null, music_key: null, time_sig: null,
  tempo: null, genre: null, tags: "[]", notes: null, page_count: 1,
  added_at: 1, updated_at: 1, last_opened_at: null, play_count: 0,
  preferred_orientation: null, default_half_page_turns: 0, deleted_at: null,
};
const manifest = {
  pieces: [piece], files: [], audio_tracks: [], annotations: [], bookmarks: [],
  section_links: [], setlists: [{ id: "s1", name: "First set", updated_at: 1 }], setlist_items: [],
};

function serve(identityStatus = 200, manifestStatus = 200) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const status = url.endsWith("/api/whoami") ? identityStatus
      : url.endsWith("/api/manifest") ? manifestStatus : 200;
    const body = url.endsWith("/api/whoami") ? MEMBER
      : url.endsWith("/api/manifest") ? manifest
      : url.endsWith("/api/rooms/active") ? null
      : { ok: true, name: "First band", rooms: false, piece_count: 1 };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(async () => {
  setActiveDb(LEGACY_DB_NAME);
  await db.delete();
  await db.open();
  await saveBandsState({ bands: [], activeId: null });
  configureApi({ baseUrl: URL, key: KEY });
  useUi.setState({ bands: [], activeBandId: null, pairing: null, identity: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("first sign-in", () => {
  test.each([401, 403])("rejects %s before saving or activating, preserving the current band", async (status) => {
    const { state } = upsertBand({ bands: [], activeId: null }, URL, KEY, "First band");
    await saveBandsState(state);
    await bootBands();
    const fetchMock = serve(status);
    await expect(signIn(URL, "refused-test-key")).rejects.toThrow(REJECTED);
    expect(await loadBandsState()).toEqual(state);
    expect(useUi.getState().pairing).toEqual({ url: URL, key: KEY });
    expect(getApiConfig()).toEqual({ baseUrl: URL, key: KEY });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/manifest"))).toBe(false);
  });

  test("checks the key header, mirrors tunes and sets, then announces the data", async () => {
    const fetchMock = serve();
    const changed = vi.fn();
    window.addEventListener(DATA_CHANGED_EVENT, changed);
    try {
      await signIn(URL, KEY);
      expect(fetchMock).toHaveBeenCalledWith(`${URL}/api/whoami`, expect.objectContaining({
        headers: { "X-Bandstand-Key": KEY },
      }));
      expect(await db.pieces.count()).toBe(1);
      expect(await db.setlists.count()).toBe(1);
      expect(changed).toHaveBeenCalledTimes(1);
      render(<MemoryRouter><Home /></MemoryRouter>);
      await screen.findByRole("link", { name: /^1\s*tunes$/ });
      expect(screen.getByRole("link", { name: /^1\s*sets$/ })).toBeInTheDocument();
    } finally {
      window.removeEventListener(DATA_CHANGED_EVENT, changed);
    }
  });

  test("accepts an older server without whoami", async () => {
    serve(404);
    await signIn(URL, KEY);
    expect(useUi.getState().pairing).toEqual({ url: URL, key: KEY });
  });

  test("a mirror failure after authentication keeps the new band and API consistent", async () => {
    serve(200, 503);
    await signIn(URL, KEY);
    expect(useUi.getState().pairing).toEqual({ url: URL, key: KEY });
    expect(getApiConfig()).toEqual({ baseUrl: URL, key: KEY });
  });

  test("boot finishes with no pairing when the registry is empty", async () => {
    useUi.setState({ pairing: undefined });
    expect(await bootBands()).toBeNull();
    expect(useUi.getState().pairing).toBeNull();
  });
});

describe("first screens", () => {
  test("Home recounts on data changes and opens the workspace picker", async () => {
    serve();
    useUi.setState({ identity: { id: "root", name: "Director", role: "director" } });
    render(<MemoryRouter><Home /></MemoryRouter>);
    await screen.findByRole("button", { name: "Start rehearsal" });
    await act(async () => {
      await db.pieces.bulkPut([piece, { ...piece, id: "deleted", deleted_at: 1 }]);
      window.dispatchEvent(new Event(DATA_CHANGED_EVENT));
    });
    await screen.findByRole("link", { name: /^1\s*tunes$/ });
    fireEvent.click(screen.getByRole("button", { name: /^0\s*workspaces$/ }));
    expect(screen.getByRole("heading", { name: "Your bands" })).toBeInTheDocument();
  });

  test.each([401, 403])("confirmed links stay on the confirm screen when the key gets %s", async (status) => {
    serve(status);
    const onClose = vi.fn();
    render(<PairConfirm links={[{ url: URL, key: KEY }]} onClose={onClose} />);
    await screen.findByText("First band");
    fireEvent.click(screen.getByRole("button", { name: "Add band" }));
    await screen.findByText(REJECTED);
    expect(onClose).not.toHaveBeenCalled();
    expect((await loadBandsState()).bands).toEqual([]);
    expect(useUi.getState().pairing).toBeNull();
  });

  test("Settings does not call a rejected key Connected", async () => {
    serve(401);
    useUi.setState({ identity: MEMBER });
    render(<MemoryRouter><Settings /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText("Checking…")).not.toBeInTheDocument());
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.getByText(REJECTED)).toBeInTheDocument();
  });
});
