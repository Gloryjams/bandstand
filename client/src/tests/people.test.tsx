import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { People } from "../routes/People";
import { configureApi } from "../lib/api";
import { INVITE_TAKEN } from "../lib/members";
import { useUi } from "../lib/store";

// The QR generator needs a canvas jsdom does not have.
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,stub") },
}));

const SERVER = "http://band.test:7800";
const MINTED = { id: "01MEMBER", name: "Rea", role: "member", key: "f".repeat(64) };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** GET list answers with `members`; POSTs answer with `mint` in order. */
function stubFetch(members: unknown[] = [], mints: Response[] = [json(MINTED, 201)]) {
  const mock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") return Promise.resolve(json({ members }));
    return Promise.resolve(mints.shift() ?? json(MINTED, 201));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function director(online = true) {
  useUi.setState({
    online,
    pairing: { url: SERVER, key: "director-key" },
    identity: { id: "root", name: "Director", role: "director" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  configureApi({ baseUrl: SERVER, key: "director-key" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("People, as the bandleader", () => {
  it("explains what a sign-in link is when the band has no players yet", async () => {
    stubFetch([]);
    director();
    render(<People />);
    await waitFor(() => expect(screen.getByText("No players yet.")).toBeInTheDocument());
    expect(screen.getByText(/A sign-in link is a web address that carries a player’s key/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make sign-in link" })).toBeDisabled();
  });

  it("sends the typed name and shows the link once, key in the fragment", async () => {
    const fetchMock = stubFetch([]);
    director();
    render(<People />);
    const input = screen.getByLabelText("Player’s name");
    const btn = screen.getByRole("button", { name: "Make sign-in link" });

    fireEvent.change(input, { target: { value: "  Rea " } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByText("Sign-in link for Rea")).toBeInTheDocument());
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST")!;
    expect(post[0]).toBe(`${SERVER}/api/member-invites`);
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ name: "Rea" });
    expect(((post[1] as RequestInit).headers as Record<string, string>)["X-Bandstand-Key"]).toBe("director-key");

    const link = `${SERVER}/app/#url=${encodeURIComponent(SERVER)}&key=${MINTED.key}`;
    expect(screen.getByText(link)).toBeInTheDocument();
    expect(screen.getByText(/Anyone who opens it is signed in as Rea/)).toBeInTheDocument();
    // The form is ready for the next player, and the link goes away on Done.
    expect(input).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(link)).not.toBeInTheDocument();
  });

  it("mints exactly one key when the button is double-tapped", async () => {
    const fetchMock = stubFetch([]);
    director();
    render(<People />);
    fireEvent.change(screen.getByLabelText("Player’s name"), { target: { value: "Rea" } });
    const btn = screen.getByRole("button", { name: "Make sign-in link" });
    await act(async () => { btn.click(); btn.click(); });
    await waitFor(() => expect(screen.getByText("Sign-in link for Rea")).toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST")).toHaveLength(1);
  });

  it("says so when the name is already taken, and lets the bandleader try again", async () => {
    stubFetch([], [new Response("taken", { status: 409 }), json(MINTED, 201)]);
    director();
    render(<People />);
    const input = screen.getByLabelText("Player’s name");
    fireEvent.change(input, { target: { value: "Rea" } });
    fireEvent.click(screen.getByRole("button", { name: "Make sign-in link" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(INVITE_TAKEN));
    expect(input).toHaveValue("Rea");

    fireEvent.change(input, { target: { value: "Rea (bass)" } });
    fireEvent.click(screen.getByRole("button", { name: "Make sign-in link" }));
    await waitFor(() => expect(screen.getByText("Sign-in link for Rea")).toBeInTheDocument());
  });

  it("lists the players and replaces a lost link only after a confirm", async () => {
    const fetchMock = stubFetch([
      { id: "root", name: "Director", role: "director", created_at: 0, revoked_at: null },
      { id: "01A", name: "Anya", role: "member", created_at: 1700000000000, revoked_at: null },
      { id: "01B", name: "Gone", role: "member", created_at: 1700000000000, revoked_at: 1700000001000 },
    ], [json({ ...MINTED, id: "01C", name: "Anya" }, 201)]);
    director();
    render(<People />);
    await waitFor(() => expect(screen.getByText("Anya")).toBeInTheDocument());
    expect(screen.queryByText("Gone")).not.toBeInTheDocument();
    expect(screen.queryByText("No players yet.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New link" }));
    expect(screen.getByText("The old link stops working.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "New link" }));
    await waitFor(() => expect(screen.getByText("Sign-in link for Anya")).toBeInTheDocument());
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST")!;
    expect(post[0]).toBe(`${SERVER}/api/member-invites/01A/replace`);
  });

  it("holds the form while offline", () => {
    stubFetch([]);
    director(false);
    render(<People />);
    fireEvent.change(screen.getByLabelText("Player’s name"), { target: { value: "Rea" } });
    expect(screen.getByRole("button", { name: "Make sign-in link" })).toBeDisabled();
    expect(screen.getByText(/Adding players needs the server/)).toBeInTheDocument();
  });
});

describe("People, as a member", () => {
  it("shows no add-a-player form", () => {
    const fetchMock = stubFetch([]);
    useUi.setState({
      online: true,
      pairing: { url: SERVER, key: "member-key" },
      identity: { id: "01M", name: "Rea", role: "member" },
    });
    render(<People />);
    expect(screen.getByText("Rea")).toBeInTheDocument();
    expect(screen.queryByLabelText("Player’s name")).not.toBeInTheDocument();
    expect(screen.getByText(/Your bandleader adds players/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the server for nothing while it is not yet known who this device is", () => {
    // identity is null only until refreshIdentity resolves; on a member's device the
    // old render fired one GET the server answered 403.
    const fetchMock = stubFetch([]);
    useUi.setState({
      online: true,
      pairing: { url: SERVER, key: "member-key" },
      identity: null,
    });
    render(<People />);
    expect(screen.queryByLabelText("Player’s name")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
