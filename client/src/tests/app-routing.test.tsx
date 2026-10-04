import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { bootBands } from "../lib/bands";
import { takeInitialPairLinks } from "../lib/pair-link";
import { useUi } from "../lib/store";
import { App } from "../App";

vi.mock("../lib/bands", () => ({ bootBands: vi.fn(), signIn: vi.fn() }));
vi.mock("../lib/pair-link", () => ({ takeInitialPairLinks: vi.fn() }));
vi.mock("../lib/recents", () => ({ hydrateRecents: vi.fn() }));
vi.mock("../lib/sync-queue", () => ({ drainQueue: vi.fn() }));
vi.mock("../lib/live", () => ({ startLivePush: vi.fn(), stopLivePush: vi.fn() }));
vi.mock("../lib/identity", () => ({ refreshIdentity: vi.fn().mockResolvedValue(null) }));
vi.mock("../lib/chart-editor", () => ({ refreshChartEditor: vi.fn().mockResolvedValue(null) }));
vi.mock("../components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../components/QuickFind", () => ({ QuickFind: () => null }));
vi.mock("../routes/Home", () => ({ Home: () => <p>Home page</p> }));
vi.mock("../routes/Viewer", () => ({ Viewer: () => <p>Reader page</p> }));
vi.mock("../routes/Settings", () => ({ Settings: () => <p>Settings page</p> }));
vi.mock("../routes/Library", () => ({ Library: () => null }));
vi.mock("../routes/Gigs", () => ({ Gigs: () => null }));
vi.mock("../routes/People", () => ({ People: () => null }));
vi.mock("../routes/RoomHost", () => ({ RoomHost: () => null }));
vi.mock("../routes/Setlists", () => ({ Setlists: () => null }));
vi.mock("../routes/SetlistEditor", () => ({ SetlistEditor: () => null }));

const band = { id: "b1", url: "http://band.example", key: "test-key", label: "Test band", dbName: "bandstand" };
let finishBoot: (value: typeof band | null) => void;

beforeEach(() => {
  useUi.setState({ pairing: undefined, bands: [], activeBandId: null });
  vi.mocked(takeInitialPairLinks).mockReturnValue([]);
  vi.mocked(bootBands).mockImplementation(() => new Promise((resolve) => {
    finishBoot = (value) => {
      useUi.getState().setPairing(value ? { url: value.url, key: value.key } : null);
      resolve(value);
    };
  }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: "Test band" }))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Location() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}{location.hash}</div>;
}
function open(path: string) {
  render(<MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter>);
}

test.each([
  ["/play/p1?resume=1&setlist=s1", "Reader page"],
  ["/settings", "Settings page"],
])("keeps the entry path %s while loading and after signed-in boot", async (path, page) => {
  open(path);
  expect(screen.getByRole("status")).toHaveTextContent("Loading Bandstand...");
  expect(screen.getByTestId("location")).toHaveTextContent(path);
  await act(async () => finishBoot(band));
  expect(screen.getByText(page)).toBeInTheDocument();
  expect(screen.getByTestId("location")).toHaveTextContent(path);
  expect(screen.queryByText("Home page")).not.toBeInTheDocument();
});

test("a new device reaches sign-in only after boot finishes", async () => {
  open("/play/p1");
  expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
  await act(async () => finishBoot(null));
  expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  expect(screen.getByTestId("location")).toHaveTextContent("/pair");
});

test.each([true, false])("a captured hash still requires confirmation after boot (signed in: %s)", async (signedIn) => {
  vi.mocked(takeInitialPairLinks).mockReturnValue([{ url: band.url, key: band.key }]);
  open("/settings");
  await act(async () => finishBoot(signedIn ? band : null));
  expect(screen.getByRole("heading", { name: "Sign in with this link?" })).toBeInTheDocument();
  expect(screen.getByTestId("location")).toHaveTextContent("/settings");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(signedIn ? screen.getByText("Settings page") : screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
});
