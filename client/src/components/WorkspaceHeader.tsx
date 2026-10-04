import { useState } from "react";
import { Link } from "react-router-dom";

import { useUi } from "../lib/store";
import { BandSheet } from "./BandSheet";
import { Heart, Sparkle } from "./Kawaii";

export function WorkspaceHeader() {
  const bands = useUi((s) => s.bands);
  const activeBandId = useUi((s) => s.activeBandId);
  const band = bands.find((entry) => entry.id === activeBandId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className="workspace-header">
        <button className="wordmark wordmark-btn" onClick={() => setOpen(true)} aria-label="Open your bands">
          <span className="beat"><Heart /></span>
          <span><small>Bandstand</small>{band?.label ?? "Workspace"}</span>
          <span className="spark tw" aria-hidden><Sparkle /></span>
        </button>
        <Link className="workspace-settings" to="/settings" aria-label="Workspace settings">
          <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
          </svg>
        </Link>
      </header>
      {open && <BandSheet onClose={() => setOpen(false)} />}
    </>
  );
}
