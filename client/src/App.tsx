import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { bootBands } from "./lib/bands";
import type { PairLink } from "./lib/pair-confirm";
import { takeInitialPairLinks } from "./lib/pair-link";
import { drainQueue } from "./lib/sync-queue";
import { refreshIdentity } from "./lib/identity";
import { refreshChartEditor } from "./lib/chart-editor";
import { hydrateRecents } from "./lib/recents";
import { startLivePush, stopLivePush } from "./lib/live";
import { useUi } from "./lib/store";
import { PairConfirm } from "./routes/PairConfirm";
import { Pairing } from "./routes/Pairing";
import { Library } from "./routes/Library";
import { Home } from "./routes/Home";
import { Gigs } from "./routes/Gigs";
import { People } from "./routes/People";
import { RoomHost } from "./routes/RoomHost";
import { Setlists } from "./routes/Setlists";
import { SetlistEditor } from "./routes/SetlistEditor";
import { Viewer } from "./routes/Viewer";
import { Settings } from "./routes/Settings";
import { Shell } from "./components/Shell";
import { QuickFind } from "./components/QuickFind";

export function App() {
  const pairing = useUi((s) => s.pairing);
  const setOnline = useUi((s) => s.setOnline);
  const setIdentity = useUi((s) => s.setIdentity);
  const setChartEditor = useUi((s) => s.setChartEditor);
  // A sign-in link the app was opened from, waiting for the player's tap. It is never
  // applied on its own: signed in or not, the confirm screen shows what the link would
  // add or replace first (a stray link must not sign a player out of their band or add
  // a stranger's server).
  const [pendingLinks, setPendingLinks] = useState<PairLink[] | null | undefined>(undefined);

  useEffect(() => {
    (async () => {
      // Band registry boot: migrates the pre-switcher single pairing on first run,
      // opens the active band's DB, configures the API, and sets pairing (which
      // drives the SSE + whoami effects below).
      const band = await bootBands();
      if (band) {
        void hydrateRecents(); // restore quick-find recency (per-band, needs the DB open)
        void drainQueue(); // flush anything queued while last offline
      }
      // Read AFTER boot so the confirm screen compares the link with what this device
      // already holds. The hash was snapshotted in main.tsx before the router dropped it.
      const links = takeInitialPairLinks();
      setPendingLinks((current) => links.length > 0 ? links : current ?? null);
    })();
    const on = () => { setOnline(true); void drainQueue(); };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [setOnline]);

  // Open the live-push stream once paired (and re-open if the pairing changes),
  // so charts dropped on the desktop appear without tapping Sync.
  useEffect(() => {
    if (!pairing) return;
    startLivePush(pairing.url, pairing.key);
    return () => stopLivePush();
  }, [pairing]);

  // Resolve who this key belongs to (director vs band member) — drives which
  // author affordances render. Older servers 404 whoami = director, as ever.
  useEffect(() => {
    if (!pairing) { setIdentity(null); return; }
    void refreshIdentity().then(setIdentity);
  }, [pairing, setIdentity]);

  // Ask the server whether the optional chart editor is built in, so the
  // "New chart" link only shows where it leads somewhere. Stays above the
  // early return below so the hook order never changes.
  useEffect(() => {
    if (!pairing) { setChartEditor(null); return; }
    void refreshChartEditor().then(setChartEditor);
  }, [pairing, setChartEditor]);

  // Keep the entry path while boot loads the pairing and checks for sign-in links.
  if (pairing === undefined || pendingLinks === undefined) {
    return <div className="pairing" role="status">Loading Bandstand...</div>;
  }

  if (pendingLinks) {
    return <PairConfirm links={pendingLinks} onClose={() => setPendingLinks(null)} />;
  }

  if (!pairing) {
    return (
      <Routes>
        <Route path="/pair" element={<Pairing />} />
        <Route path="*" element={<Navigate to="/pair" replace />} />
      </Routes>
    );
  }

  return (
    <>
      <Routes>
        <Route path="/" element={<Shell><Home /></Shell>} />
        <Route path="/repertoire" element={<Shell><Library /></Shell>} />
        <Route path="/setlists" element={<Shell><Setlists /></Shell>} />
        <Route path="/gigs" element={<Shell><Gigs /></Shell>} />
        <Route path="/people" element={<Shell><People /></Shell>} />
        <Route path="/room-host/:id" element={<RoomHost />} />
        <Route path="/setlists/:id" element={<Shell><SetlistEditor /></Shell>} />
        <Route path="/play/:pieceId" element={<Viewer />} />
        <Route path="/settings" element={<Shell><Settings /></Shell>} />
        <Route path="/pair" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <QuickFind />
    </>
  );
}
