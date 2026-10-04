import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { confirmLabel, planPairLinks } from "../lib/pair-confirm";
import { legacyBandId, upsertBand, type BandsState } from "../lib/meta";
import { useUi } from "../lib/store";

// The confirm screen must not touch the registry until the player taps confirm, so
// the orchestration module is stubbed and its call count is the evidence.
vi.mock("../lib/bands", () => ({ signIn: vi.fn() }));
vi.mock("../lib/recents", () => ({ hydrateRecents: vi.fn().mockResolvedValue(undefined) }));

import { signIn } from "../lib/bands";
import { PairConfirm } from "../routes/PairConfirm";

const signInMock = vi.mocked(signIn);

const LOCKUPS = "http://192.168.1.21:7830";
const STRANGER = "http://203.0.113.9:7800";
const KEY_MINE = "m".repeat(64);
const KEY_OTHER = "o".repeat(64);

const empty: BandsState = { bands: [], activeId: null };
const EVIL = "https://evil.example/b7373b6a";
const REAL = "https://bandstand.example.com";

function legacyCollisionState(url: string): BandsState {
  const id = legacyBandId(url);
  return { bands: [{ id, url, key: KEY_MINE, label: "Stored band", dbName: `bandstand-${id}` }], activeId: id };
}

function stubHealth(names: Record<string, string>) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.keys(names).find((base) => url.startsWith(base));
    if (!hit) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify({ ok: true, version: "t", name: names[hit], piece_count: 0 }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  signInMock.mockReset();
  signInMock.mockResolvedValue({ id: "x", url: STRANGER, key: KEY_OTHER, label: "x", dbName: "x" });
  useUi.setState({ bands: [], activeBandId: null, pairing: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("planPairLinks", () => {
  test.each([[EVIL, REAL], [REAL, EVIL]])("a legacy id collision with %s is an add", (stored, incoming) => {
    expect(legacyBandId(stored!)).toBe("200b78e0");
    expect(legacyBandId(incoming!)).toBe("200b78e0");
    const plan = planPairLinks(legacyCollisionState(stored!), [{ url: incoming!, key: KEY_OTHER }]);
    expect(plan).toEqual([{ url: incoming, key: KEY_OTHER, action: "add", existing: null }]);
    expect(confirmLabel(plan)).toBe("Add band");
  });

  test("a multi-band link keeps both colliding URLs and deduplicates by normalized URL", () => {
    const plan = planPairLinks(empty, [
      { url: EVIL, key: KEY_MINE }, { url: REAL, key: KEY_OTHER },
      { url: `${REAL}/`, key: "duplicate-test-key" },
    ]);
    expect(plan.map((p) => p.url)).toEqual([EVIL, REAL]);
    expect(plan.map((p) => p.action)).toEqual(["add", "add"]);
    expect(confirmLabel(plan)).toBe("Add bands");
  });

  test("a server this device has never seen is an add", () => {
    const plan = planPairLinks(empty, [{ url: STRANGER, key: KEY_OTHER }]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.action).toBe("add");
    expect(plan[0]!.existing).toBeNull();
  });

  test("a known server with a different key is a replace, naming the band it touches", () => {
    const state = upsertBand(empty, LOCKUPS, KEY_MINE, "The Lockups").state;
    const plan = planPairLinks(state, [{ url: `${LOCKUPS}/`, key: KEY_OTHER }]);
    expect(plan[0]!.action).toBe("replace");
    expect(plan[0]!.existing?.label).toBe("The Lockups");
    expect(plan[0]!.url).toBe(LOCKUPS); // normalized like the registry
  });

  test("a known server with the very same key changes nothing", () => {
    const state = upsertBand(empty, LOCKUPS, KEY_MINE, "The Lockups").state;
    expect(planPairLinks(state, [{ url: LOCKUPS, key: KEY_MINE }])[0]!.action).toBe("same");
  });

  test("a multi-band link is planned per band, duplicates and empties dropped", () => {
    const state = upsertBand(empty, LOCKUPS, KEY_MINE, "The Lockups").state;
    const plan = planPairLinks(state, [
      { url: STRANGER, key: KEY_OTHER },
      { url: LOCKUPS, key: KEY_OTHER },
      { url: STRANGER, key: "again" },
      { url: "", key: "k" },
    ]);
    expect(plan.map((p) => p.action)).toEqual(["add", "replace"]);
  });

  test("the confirm button says what it does", () => {
    const state = upsertBand(empty, LOCKUPS, KEY_MINE).state;
    expect(confirmLabel(planPairLinks(empty, [{ url: STRANGER, key: KEY_OTHER }]))).toBe("Add band");
    expect(confirmLabel(planPairLinks(empty, [
      { url: STRANGER, key: KEY_OTHER }, { url: LOCKUPS, key: KEY_MINE },
    ]))).toBe("Add bands");
    expect(confirmLabel(planPairLinks(state, [{ url: LOCKUPS, key: KEY_OTHER }]))).toBe("Replace sign-in");
    expect(confirmLabel(planPairLinks(state, [{ url: LOCKUPS, key: KEY_MINE }]))).toBe("Open");
  });
});

describe("PairConfirm: the add path", () => {
  test.each([[EVIL, REAL], [REAL, EVIL]])("shows Add band for a URL colliding with stored %s", async (stored, incoming) => {
    const state = legacyCollisionState(stored!);
    useUi.setState({ bands: state.bands, activeBandId: state.activeId, pairing: { url: stored!, key: KEY_MINE } });
    stubHealth({ [incoming!]: "New band name" });
    const onClose = vi.fn();
    render(<PairConfirm links={[{ url: incoming!, key: KEY_OTHER }]} onClose={onClose} />);
    await screen.findByText("New band name");
    expect(screen.getByText("New band")).toBeInTheDocument();
    expect(screen.queryByText("Replaces sign-in")).not.toBeInTheDocument();
    expect(signInMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add band" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(signInMock).toHaveBeenCalledWith(incoming, KEY_OTHER);
    expect(useUi.getState().bands).toEqual(state.bands);
  });

  test("shows the band and server, writes nothing until Add band is tapped", async () => {
    stubHealth({ [STRANGER]: "Somebody Else's Band" });
    const onClose = vi.fn();
    render(<PairConfirm links={[{ url: STRANGER, key: KEY_OTHER }]} onClose={onClose} />);

    expect(screen.getByRole("heading", { name: "Sign in with this link?" })).toBeInTheDocument();
    expect(screen.getByText(STRANGER)).toBeInTheDocument();
    expect(screen.getByText("New band")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Somebody Else's Band")).toBeInTheDocument());
    expect(screen.getByText("This will add Somebody Else's Band to this device.")).toBeInTheDocument();

    // Opening the link alone must not sign in: only a keyless health read happened.
    expect(signInMock).not.toHaveBeenCalled();
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(init?.headers).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Add band" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(signInMock).toHaveBeenCalledWith(STRANGER, KEY_OTHER);
  });

  test("Cancel adds nothing", async () => {
    stubHealth({ [STRANGER]: "Somebody Else's Band" });
    const onClose = vi.fn();
    render(<PairConfirm links={[{ url: STRANGER, key: KEY_OTHER }]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(signInMock).not.toHaveBeenCalled();
  });

  test("an unreachable server is said so, and the tap still decides", async () => {
    stubHealth({});
    render(<PairConfirm links={[{ url: STRANGER, key: KEY_OTHER }]} onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText("Could not reach this server right now.")).toBeInTheDocument(),
    );
    expect(signInMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add band" })).toBeEnabled();
  });
});

describe("PairConfirm: the replace path", () => {
  function signedInToLockups() {
    const state = upsertBand(empty, LOCKUPS, KEY_MINE, "The Lockups").state;
    useUi.setState({
      bands: state.bands, activeBandId: state.activeId, pairing: { url: LOCKUPS, key: KEY_MINE },
    });
  }

  test("names the band it would replace and keeps the current sign-in until confirmed", async () => {
    signedInToLockups();
    stubHealth({ [LOCKUPS]: "The Lockups" });
    const onClose = vi.fn();
    render(<PairConfirm links={[{ url: LOCKUPS, key: KEY_OTHER }]} onClose={onClose} />);

    // The band name comes from the registry straight away, before the probe answers.
    expect(screen.getByText("The Lockups")).toBeInTheDocument();
    expect(screen.getByText("Replaces sign-in")).toBeInTheDocument();
    expect(screen.getByText(/it will replace the sign-in you have now/)).toBeInTheDocument();
    expect(screen.getByText("Cancel keeps the bands you are signed in to as they are.")).toBeInTheDocument();
    expect(signInMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Replace sign-in" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(signInMock).toHaveBeenCalledWith(LOCKUPS, KEY_OTHER);
  });

  test("Cancel leaves the player in their band", () => {
    signedInToLockups();
    stubHealth({ [LOCKUPS]: "The Lockups" });
    const onClose = vi.fn();
    render(<PairConfirm links={[{ url: LOCKUPS, key: KEY_OTHER }]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(signInMock).not.toHaveBeenCalled();
    expect(useUi.getState().pairing).toEqual({ url: LOCKUPS, key: KEY_MINE });
  });

  test("the same key again says nothing will change", () => {
    signedInToLockups();
    stubHealth({ [LOCKUPS]: "The Lockups" });
    render(<PairConfirm links={[{ url: LOCKUPS, key: KEY_MINE }]} onClose={() => {}} />);
    expect(screen.getByText("Already here")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(signInMock).not.toHaveBeenCalled();
  });

  test("a crossover link signs in the extra band first so the first band ends up active", async () => {
    signedInToLockups();
    stubHealth({ [LOCKUPS]: "The Lockups", [STRANGER]: "Second Band" });
    const onClose = vi.fn();
    render(
      <PairConfirm
        links={[{ url: LOCKUPS, key: KEY_OTHER }, { url: STRANGER, key: KEY_OTHER }]}
        onClose={onClose}
      />,
    );
    expect(signInMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Replace sign-in" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(signInMock.mock.calls.map((c) => c[0])).toEqual([STRANGER, LOCKUPS]);
  });

  test("a failed sign-in is shown and nothing closes", async () => {
    signedInToLockups();
    stubHealth({ [LOCKUPS]: "The Lockups" });
    signInMock.mockRejectedValueOnce(new Error("Health check failed"));
    const onClose = vi.fn();
    render(<PairConfirm links={[{ url: LOCKUPS, key: KEY_OTHER }]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Replace sign-in" }));
    await waitFor(() => expect(screen.getByText("Health check failed")).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });
});
