import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { configureApi } from "../lib/api";
import { chartEditorUrl, refreshChartEditor, showChartEditorLink } from "../lib/chart-editor";
import { db } from "../lib/db";
import { useUi } from "../lib/store";
import { Home } from "../routes/Home";
import { Library } from "../routes/Library";

/**
 * The client links to /charts/ from Home and the Library. On an install built
 * without the optional chart editor that link lands a director on the "not
 * installed" page, so the app asks /api/health first and hides the link (Library)
 * or shows it switched off with a one-line note (Home).
 */

const DIRECTOR = { id: "root", name: "Director", role: "director" as const };
const MEMBER = { id: "m1", name: "Rea", role: "member" as const };

function serveHealth(body: unknown) {
  const mock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  configureApi({ baseUrl: "http://band.example", key: "test-key" });
  await db.delete();
  await db.open();
  useUi.setState({ identity: DIRECTOR, chartEditor: null, bands: [], activeBandId: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("refreshChartEditor", () => {
  it("reads chart_editor from /api/health", async () => {
    const fetchMock = serveHealth({ ok: true, chart_editor: true });
    expect(await refreshChartEditor()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://band.example/api/health", expect.anything());

    serveHealth({ ok: true, chart_editor: false });
    expect(await refreshChartEditor()).toBe(false);
  });

  it("does not know on a server too old to say", async () => {
    // Pre-release servers have no chart_editor field. They are the existing
    // installs, which all carry the editor, so unknown keeps the link.
    serveHealth({ ok: true, version: "0.1.0" });
    expect(await refreshChartEditor()).toBe(null);
    expect(showChartEditorLink(null)).toBe(true);
  });

  it("falls back to what this device last learned when offline", async () => {
    serveHealth({ ok: true, chart_editor: false });
    await refreshChartEditor();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await refreshChartEditor()).toBe(false);
  });

  it("is unknown when offline with nothing cached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await refreshChartEditor()).toBe(null);
  });

  it("links to the editor on the paired server, not the page origin", () => {
    expect(chartEditorUrl()).toBe("http://band.example/charts/");
  });
});

describe("Home", () => {
  function renderHome() {
    return render(<MemoryRouter><Home /></MemoryRouter>);
  }

  it("links a director to the editor when it is installed", async () => {
    serveHealth(null); // the rehearsal-room probe
    useUi.setState({ chartEditor: true });
    renderHome();
    const link = await screen.findByRole("link", { name: /New chart/ });
    expect(link).toHaveAttribute("href", "http://band.example/charts/");
    expect(screen.queryByText(/not installed/)).not.toBeInTheDocument();
  });

  it("keeps the link while the answer is not known yet", async () => {
    serveHealth(null);
    useUi.setState({ chartEditor: null });
    renderHome();
    expect(await screen.findByRole("link", { name: /New chart/ })).toBeInTheDocument();
  });

  it("switches the card off with a note when the editor is not installed", async () => {
    serveHealth(null);
    useUi.setState({ chartEditor: false });
    renderHome();
    expect(await screen.findByText("The chart editor is not installed on this server")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /New chart/ })).not.toBeInTheDocument();
    const card = screen.getByText("New chart").closest(".workspace-action-off");
    expect(card).toHaveAttribute("aria-disabled", "true");
  });

  it("shows a member neither the link nor the note", async () => {
    serveHealth(null);
    useUi.setState({ identity: MEMBER, chartEditor: false });
    renderHome();
    await screen.findByText("Repertoire");
    expect(screen.queryByText(/New chart/)).not.toBeInTheDocument();
  });
});

describe("Library", () => {
  function renderLibrary() {
    return render(<MemoryRouter><Library /></MemoryRouter>);
  }

  it("shows the New chart button when the editor is installed", async () => {
    // The manifest mirror on mount fails here; the Library treats that as offline.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    useUi.setState({ chartEditor: true });
    renderLibrary();
    await waitFor(() => expect(screen.getByRole("link", { name: "New chart" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "New chart" })).toHaveAttribute("href", "http://band.example/charts/");
  });

  it("hides the New chart button when the editor is not installed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    useUi.setState({ chartEditor: false });
    renderLibrary();
    await screen.findByRole("button", { name: "Add chart" });
    expect(screen.queryByRole("link", { name: "New chart" })).not.toBeInTheDocument();
  });
});
