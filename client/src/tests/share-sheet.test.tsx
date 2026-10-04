import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ShareSheet } from "../components/ShareSheet";
import { configureApi } from "../lib/api";

// The QR generator needs a canvas jsdom does not have; the sheet's own catch would
// handle it, but stubbing keeps these tests about the create path.
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,stub") },
}));

const CREATED = { id: "s1", token: "tok", url: "https://share.example/s/tok" };

function stubFetch() {
  const mock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(CREATED), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  vi.restoreAllMocks();
  configureApi({ baseUrl: "http://example.test", key: "test-key" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const target = { kind: "piece" as const, id: "p1", label: "Autumn Leaves" };

describe("ShareSheet create", () => {
  it("mints exactly one link when the button is double-tapped", async () => {
    const fetchMock = stubFetch();
    render(<ShareSheet target={target} onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: "Make link" });

    // Both taps must land inside ONE frame, before React commits `busy` and disables
    // the button. fireEvent flushes between calls, so it cannot reproduce this: native
    // clicks inside a single act() can. Without the synchronous ref guard this posts
    // twice, and the first link is unrevokable in practice because it never appears.
    await act(async () => {
      btn.click();
      btn.click();
    });

    await waitFor(() => expect(screen.getByText(CREATED.url)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets a failed attempt be retried", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(CREATED), {
        status: 200, headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ShareSheet target={target} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Make link" }));
    await screen.findByText(/Couldn.t make the link/);

    fireEvent.click(screen.getByRole("button", { name: "Make link" }));
    await waitFor(() => expect(screen.getByText(CREATED.url)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("says that share pages are not set up, instead of asking to try again", async () => {
    // A server with no public address answers 503. The connection is fine and a
    // retry cannot work, so the usual sentence would send the director in circles.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "Share pages are not set up on this server." }), {
        status: 503, headers: { "content-type": "application/json" },
      }),
    ));
    render(<ShareSheet target={target} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Make link" }));
    await waitFor(() =>
      expect(screen.getByText(/Share pages are not set up on this server yet/)).toBeInTheDocument());
    expect(screen.queryByText(/Check the connection/)).not.toBeInTheDocument();
    expect(screen.queryByText(/127\.0\.0\.1/)).not.toBeInTheDocument();
  });

  it("keeps the usual sentence for any other failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    render(<ShareSheet target={target} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Make link" }));
    await waitFor(() => expect(screen.getByText(/Check the connection/)).toBeInTheDocument());
  });

  it("posts the picked duration, defaulting to 24 hours", async () => {
    const fetchMock = stubFetch();
    render(<ShareSheet target={target} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Make link" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toEqual({
      target_kind: "piece", target_id: "p1", ttl_hours: 24,
    });
  });

  it("marks 24 hours as the default and posts whichever option is picked", async () => {
    const fetchMock = stubFetch();
    render(<ShareSheet target={target} onClose={() => {}} />);
    // drive-share.mjs selects `.share-dur.on` containing "24" to prove the default.
    expect(screen.getByRole("button", { name: "24 hours" }).className).toContain("on");

    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(screen.getByRole("button", { name: "7 days" }).className).toContain("on");
    expect(screen.getByRole("button", { name: "24 hours" }).className).not.toContain("on");

    fireEvent.click(screen.getByRole("button", { name: "Make link" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string).ttl_hours).toBe(168);
  });

  it("says a setlist share stays live, and does not say it for a chart", async () => {
    stubFetch();
    const { unmount } = render(
      <ShareSheet target={{ kind: "setlist", id: "sl1", label: "Friday" }} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Make link" }));
    expect(await screen.findByText(/Setlist edits show up live\./)).toBeInTheDocument();
    unmount();

    stubFetch();
    render(<ShareSheet target={target} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Make link" }));
    await screen.findByText(CREATED.url);
    expect(screen.queryByText(/Setlist edits/)).toBeNull();
  });
});
