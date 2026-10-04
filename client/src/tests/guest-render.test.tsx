import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { GuestChart } from "../guest/GuestChart";
import { GuestBoundary } from "../guest/GuestBoundary";

/**
 * Render-level cover for the guest page. The point is not that hostile payloads parse
 * "correctly" but that a stranger never gets a blank screen: either the chart draws, or
 * the dead-link state does.
 */

const GOOD = {
  title: "Blue Bossa",
  artist: "Kenny Dorham",
  key: "Cm",
  time: "4/4",
  bpm: "150",
  style: "Bossa",
  capo: "",
  sections: [{ id: "s1", label: "Head", bars: [{ chords: "Cm7" }, { chords: "Fm7" }] }],
  arrangement: [{ id: "a1", sectionId: "s1", repeats: 2 }],
  settings: { barsPerRow: 4, fontSize: "medium", showLyrics: false, onePage: false },
};

function serve(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ));
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("guest chart page", () => {
  it("draws a well-formed chart", async () => {
    serve(GOOD);
    render(<GuestChart chartUrl="/s/tok/chart/p1" />);
    expect(await screen.findByText("Blue Bossa")).toBeInTheDocument();
  });

  it("shows the dead-link state when the server refuses", async () => {
    serve({}, 404);
    render(<GuestChart chartUrl="/s/tok/chart/p1" />);
    expect(await screen.findByText("This link is no longer available.")).toBeInTheDocument();
  });

  it("fetches without credentials or an auth header", async () => {
    serve(GOOD);
    render(<GuestChart chartUrl="/s/tok/chart/p1" />);
    await screen.findByText("Blue Bossa");
    const [, init] = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]!;
    expect(init.credentials).toBe("omit");
    expect(init.headers).toBeUndefined();
  });

  // Each of these threw inside render before the DTO was normalized field by field.
  // The server allowlists the same shape; this is the client half of that defense, and
  // the point is that a guest still gets a readable chart rather than a dead page.
  it("survives a null bar", async () => {
    serve({ ...GOOD, sections: [{ id: "s1", label: "Head", bars: [null, { chords: "C" }] }] });
    render(<GuestChart chartUrl="/x" />);
    expect(await screen.findByText("Blue Bossa")).toBeInTheDocument();
  });

  it("survives chords that are not strings", async () => {
    serve({
      ...GOOD,
      sections: [{ id: "s1", label: "Head", bars: [{ chords: 42 }, { chords: { a: 1 } }] }],
    });
    render(<GuestChart chartUrl="/x" />);
    expect(await screen.findByText("Blue Bossa")).toBeInTheDocument();
  });

  it("survives solos sent as a string instead of a list", async () => {
    // A string has .length, so the roadmap passed the guard and then called .join.
    serve({ ...GOOD, arrangement: [{ id: "a1", sectionId: "s1", solos: "Bob" }] });
    render(<GuestChart chartUrl="/x" />);
    expect(await screen.findByText("Blue Bossa")).toBeInTheDocument();
  });

  it("survives malformed arrangement steps", async () => {
    serve({ ...GOOD, arrangement: [null, {}, { sectionId: 5 }, "nope", { id: "a1", sectionId: "s1" }] });
    render(<GuestChart chartUrl="/x" />);
    expect(await screen.findByText("Blue Bossa")).toBeInTheDocument();
  });

  it("survives objects where display text belongs", async () => {
    serve({
      ...GOOD,
      sections: [{
        id: "s1",
        label: "Head",
        description: { not: "text" },
        bars: [{ chords: "C", lyrics: { a: 1 }, direction: [], barline: "bogus", sign: "nope" }],
      }],
    });
    render(<GuestChart chartUrl="/x" />);
    expect(await screen.findByText("Blue Bossa")).toBeInTheDocument();
  });
});

describe("guest chrome", () => {
  it("renders the attribution and a Set link when the shell supplies them", async () => {
    serve(GOOD);
    render(<GuestChart chartUrl="/x" attribution="Shared from a gig book" setlistUrl="/s/tok" />);
    await screen.findByText("Blue Bossa");
    expect(screen.getByText("Shared from a gig book")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set" })).toHaveAttribute("href", "/s/tok");
  });

  it("renders no Set link when the share is not a setlist", async () => {
    serve(GOOD);
    render(<GuestChart chartUrl="/x" attribution="Shared from a gig book" />);
    await screen.findByText("Blue Bossa");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders no bar at all when the shell supplies neither", async () => {
    serve(GOOD);
    const { container } = render(<GuestChart chartUrl="/x" />);
    await screen.findByText("Blue Bossa");
    expect(container.querySelector(".guest-bar")).toBeNull();
  });
});

describe("GuestBoundary", () => {
  it("swaps a throwing subtree for the dead-link state", () => {
    // React reports caught errors on console; the real page passes onCaughtError.
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom(): React.ReactNode {
      throw new Error("render blew up");
    }
    render(
      <GuestBoundary fallback={<p>This link is no longer available.</p>}>
        <Boom />
      </GuestBoundary>,
    );
    expect(screen.getByText("This link is no longer available.")).toBeInTheDocument();
  });
});
