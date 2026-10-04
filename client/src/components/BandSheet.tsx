import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { switchBand } from "../lib/bands";
import { useUi } from "../lib/store";

/** The band switcher: a bottom sheet listing every band this device is signed in to.
 *  Opens from the Library header. Switching swaps the whole app (mirror, live-push,
 *  identity) to that band. Sign-out lives in Settings, not here — this sheet is the
 *  fast path, kept safe to fat-finger. */
export function BandSheet({ onClose }: { onClose: () => void }) {
  const bands = useUi((s) => s.bands);
  const activeBandId = useUi((s) => s.activeBandId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const nav = useNavigate();

  async function pick(id: string) {
    if (id === activeBandId) { onClose(); return; }
    setBusyId(id);
    try {
      await switchBand(id);
      nav("/");
      onClose();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="qf-overlay" onClick={onClose}>
      <div className="qf-panel band-sheet" onClick={(e) => e.stopPropagation()}>
        <h2 className="band-sheet-title">Your bands</h2>
        <ul className="band-rows">
          {bands.map((b) => (
            <li key={b.id}>
              <button
                className={`band-row${b.id === activeBandId ? " on" : ""}`}
                onClick={() => pick(b.id)}
                disabled={busyId !== null}
                aria-current={b.id === activeBandId ? "true" : undefined}
              >
                <span className="band-row-name">{b.label}</span>
                <span className="band-row-sub">{b.url.replace(/^https?:\/\//, "")}</span>
                {b.id === activeBandId && <span className="band-row-chip">current</span>}
                {busyId === b.id && <span className="band-row-chip">switching…</span>}
              </button>
            </li>
          ))}
        </ul>
        <p className="band-sheet-hint">
          Joining another band? Open the sign-in link its bandleader sent you and it
          will appear here.
        </p>
        <button className="qf-done" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
