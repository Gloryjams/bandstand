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
import { fetchManifestAndMirror } from "../lib/sync";
import { Home } from "../routes/Home";
import { PairConfirm } from "../routes/PairConfirm";
import { Pairing } from "../routes/Pairing";
import { Settings } from "../routes/Settings";

const URL = "http://band.example";
const KEY = "test-key";
const MEMBER = { id: "m1", name: "Player", role: "member" as const };
const REJECTED = "That key was not accepted by this server. Check it and try again.";
const KEPT = "This device keeps your sign-in and charts.";
const CLEARABLE = "This browser may clear Bandstand's data if you do not open it for a while. Add it to your Home Screen to keep it.";
const HOME_SCREEN_HINT = "Keep Bandstand signed in: tap Share, then Add to Home Screen, and open it from that icon.";
const RECOVERY = "Lost your sign-in? Open the sign-in link your bandleader sent you again, or ask them for a new one.";
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

function device(userAgent = "Macintosh", maxTouchPoints = 0, mode = "browser", standalone = false) {
  const storage = {
    persisted: vi.fn().mockResolvedValue(false),
    persist: vi.fn().mockResolvedValue(true),
  };
  vi.stubGlobal("navigator", {
    userAgent, platform: userAgent === "Macintosh" ? "MacIntel" : userAgent,
    maxTouchPoints, standalone, storage,
  });
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === `(display-mode: ${mode})`,
  })));
  return storage;
}

async function enterBand(path: "sign-in" | "boot") {
  if (path === "sign-in") return signIn(URL, KEY);
  const { state } = upsertBand({ bands: [], activeId: null }, URL, KEY, "First band");
  await saveBandsState(state);
  return bootBands();
}

beforeEach(async () => {
  setActiveDb(LEGACY_DB_NAME);
  await db.delete();
  await db.open();
  await saveBandsState({ bands: [], activeId: null });
  configureApi({ baseUrl: URL, key: KEY });
  localStorage.clear();
  useUi.setState({
    bands: [], activeBandId: null, pairing: null, identity: null,
    storagePersisted: false, homeScreenHint: false,
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

describe("keeping device storage", () => {
  test.each(["sign-in", "boot"] as const)("requests persistence after activation at %s", async (path) => {
    const storage = device();
    serve();
    storage.persist.mockImplementation(async () => {
      expect(useUi.getState().pairing).toEqual({ url: URL, key: KEY });
      expect(useUi.getState().bands).toHaveLength(1);
      expect(db.name).toBe(useUi.getState().bands[0]?.dbName);
      return true;
    });
    await enterBand(path);
    await waitFor(() => expect(useUi.getState().storagePersisted).toBe(true));
    expect(storage.persisted).toHaveBeenCalledTimes(1);
    expect(storage.persist).toHaveBeenCalledTimes(1);
  });

  test.each(["sign-in", "boot"] as const)("does not request persistence already granted at %s", async (path) => {
    const storage = device();
    storage.persisted.mockResolvedValue(true);
    serve();
    await enterBand(path);
    await waitFor(() => expect(useUi.getState().storagePersisted).toBe(true));
    expect(storage.persisted).toHaveBeenCalledTimes(1);
    expect(storage.persist).not.toHaveBeenCalled();
  });

  test("an empty boot does not ask for persistence", async () => {
    const storage = device();
    expect(await bootBands()).toBeNull();
    expect(storage.persisted).not.toHaveBeenCalled();
    expect(storage.persist).not.toHaveBeenCalled();
  });

  test("boot requests persistence when a stored band has no active selection", async () => {
    const storage = device();
    const { state } = upsertBand({ bands: [], activeId: null }, URL, KEY, "First band");
    await saveBandsState({ ...state, activeId: null });
    expect(await bootBands()).toBeNull();
    await waitFor(() => expect(storage.persist).toHaveBeenCalledTimes(1));
  });

  test.each((["sign-in", "boot"] as const).flatMap((path) =>
    ["missing storage", "missing methods", "persisted rejects", "persist rejects", "denied"]
      .map((failure) => [path, failure] as const),
  ))(
    "%s survives %s", async (path, failure) => {
      const storage = device();
      if (failure === "missing storage") vi.stubGlobal("navigator", {});
      if (failure === "missing methods") vi.stubGlobal("navigator", { storage: {} });
      if (failure === "persisted rejects") storage.persisted.mockRejectedValue(new Error("Unavailable"));
      if (failure === "persist rejects") storage.persist.mockRejectedValue(new Error("Unavailable"));
      if (failure === "denied") storage.persist.mockResolvedValue(false);
      serve();
      await expect(enterBand(path)).resolves.toMatchObject({ url: URL });
      expect(useUi.getState().pairing).toEqual({ url: URL, key: KEY });
      expect((await loadBandsState()).bands).toHaveLength(1);
      expect(useUi.getState().storagePersisted).toBe(false);
      if (failure === "persisted rejects") expect(storage.persist).not.toHaveBeenCalled();
      if (failure === "persist rejects" || failure === "denied") {
        expect(storage.persist).toHaveBeenCalledTimes(1);
      }
    },
  );

  test("records existing persistence even without the request API", async () => {
    const storage = device();
    storage.persisted.mockResolvedValue(true);
    vi.stubGlobal("navigator", { storage: { persisted: storage.persisted } });
    serve();
    await signIn(URL, KEY);
    await waitFor(() => expect(useUi.getState().storagePersisted).toBe(true));
    expect(storage.persist).not.toHaveBeenCalled();
  });

  test("a pending storage permission does not delay sign-in", async () => {
    const storage = device();
    let finishPermission!: (kept: boolean) => void;
    storage.persist.mockReturnValue(new Promise<boolean>((resolve) => { finishPermission = resolve; }));
    serve();
    try {
      await expect(signIn(URL, KEY)).resolves.toMatchObject({ url: URL });
      expect(storage.persist).toHaveBeenCalledTimes(1);
    } finally {
      finishPermission(true);
    }
    await waitFor(() => expect(useUi.getState().storagePersisted).toBe(true));
  });

  test("a rejected key never requests persistence", async () => {
    const storage = device();
    serve(401);
    await expect(signIn(URL, KEY)).rejects.toThrow(REJECTED);
    expect(storage.persisted).not.toHaveBeenCalled();
    expect(storage.persist).not.toHaveBeenCalled();
  });

  test.each([true, false])("Settings shows whether persistence was granted: %s", async (kept) => {
    const storage = device();
    storage.persist.mockResolvedValue(kept);
    serve();
    await signIn(URL, KEY);
    render(<MemoryRouter><Settings /></MemoryRouter>);
    await screen.findByText(kept ? KEPT : CLEARABLE);
    expect(screen.queryByText(kept ? CLEARABLE : KEPT)).not.toBeInTheDocument();
  });
});

describe("Home Screen hint", () => {
  test.each([
    ["iPhone tab", "iPhone", 0, "browser", false, true],
    ["iPad tab", "iPad", 0, "browser", false, true],
    ["iPadOS Mac tab", "Macintosh", 5, "browser", false, true],
    ["Mac tab", "Macintosh", 0, "browser", false, false],
    ["Android tab", "Android", 5, "browser", false, false],
    ["Windows tab", "Windows", 0, "browser", false, false],
    ["standalone iPhone", "iPhone", 0, "standalone", false, false],
    ["fullscreen iPad", "iPad", 0, "fullscreen", false, false],
    ["Safari installed app", "iPhone", 0, "browser", true, false],
  ] as const)("shows only when needed on %s", async (_label, agent, touches, mode, standalone, visible) => {
    device(agent, touches, mode, standalone);
    serve();
    await signIn(URL, KEY);
    render(<MemoryRouter><Home /></MemoryRouter>);
    await screen.findByRole("link", { name: /^1\s*tunes$/ });
    expect(screen.queryByText(HOME_SCREEN_HINT) !== null).toBe(visible);
  });

  test("recognizes iPadOS by its Mac platform and touch points", async () => {
    device("Desktop browser", 5);
    Object.assign(navigator, { platform: "MacIntel" });
    serve();
    await signIn(URL, KEY);
    render(<MemoryRouter><Home /></MemoryRouter>);
    await screen.findByText(HOME_SCREEN_HINT);
  });

  test("works on iOS without matchMedia", async () => {
    device("iPhone");
    vi.stubGlobal("matchMedia", undefined);
    serve();
    await signIn(URL, KEY);
    render(<MemoryRouter><Home /></MemoryRouter>);
    await screen.findByText(HOME_SCREEN_HINT);
  });

  test("is absent before a successful sign-in", async () => {
    device("iPhone");
    serve();
    render(<MemoryRouter><Home /></MemoryRouter>);
    await screen.findByRole("link", { name: /^0\s*tunes$/ });
    expect(screen.queryByText(HOME_SCREEN_HINT)).not.toBeInTheDocument();
  });

  test("dismissal survives remount and another sign-in on this device", async () => {
    device("iPhone");
    serve();
    await signIn(URL, KEY);
    const first = render(<MemoryRouter><Home /></MemoryRouter>);
    await screen.findByText(HOME_SCREEN_HINT);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Home Screen hint" }));
    expect(screen.queryByText(HOME_SCREEN_HINT)).not.toBeInTheDocument();
    first.unmount();
    useUi.setState({ homeScreenHint: false });
    await signIn(URL, KEY);
    render(<MemoryRouter><Home /></MemoryRouter>);
    await screen.findByRole("link", { name: /^1\s*tunes$/ });
    expect(screen.queryByText(HOME_SCREEN_HINT)).not.toBeInTheDocument();
  });

  test("unavailable localStorage does not break sign-in or dismissal", async () => {
    device("iPhone");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Unavailable"); });
    serve();
    await expect(signIn(URL, KEY)).resolves.toMatchObject({ url: URL });
    render(<MemoryRouter><Home /></MemoryRouter>);
    await screen.findByText(HOME_SCREEN_HINT);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Home Screen hint" }));
    expect(screen.queryByText(HOME_SCREEN_HINT)).not.toBeInTheDocument();
  });

  test("comes back at a later start for an iPhone tab that is already signed in", async () => {
    device("iPhone");
    serve();
    await enterBand("boot");
    await fetchManifestAndMirror();
    render(<MemoryRouter><Home /></MemoryRouter>);
    await screen.findByRole("link", { name: /^1\s*tunes$/ });
    expect(screen.getByText(HOME_SCREEN_HINT)).toBeInTheDocument();
  });

  test("stays hidden at a later start once dismissed", async () => {
    device("iPhone");
    serve();
    localStorage.setItem("bandstand-home-screen-dismissed", "1");
    await enterBand("boot");
    await fetchManifestAndMirror();
    render(<MemoryRouter><Home /></MemoryRouter>);
    await screen.findByRole("link", { name: /^1\s*tunes$/ });
    expect(screen.queryByText(HOME_SCREEN_HINT)).not.toBeInTheDocument();
  });
});

describe("first screens", () => {
  test("Pairing explains how to recover a lost sign-in", () => {
    render(<MemoryRouter><Pairing /></MemoryRouter>);
    expect(screen.getByText(RECOVERY)).toBeInTheDocument();
  });

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
