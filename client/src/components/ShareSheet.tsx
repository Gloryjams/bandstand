import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

import { copyText } from "../lib/copy-text";
import { useUi } from "../lib/store";
import {
  SHARE_DURATIONS, createShare, shareErrorMessage, shareNote,
  type CreatedShare, type ShareDuration, type ShareTargetKind,
} from "../lib/shares";

export interface ShareTarget {
  kind: ShareTargetKind;
  id: string;
  /** Title/name shown in the sheet so it is obvious what is about to go public. */
  label: string;
}

/** Share glyph for the card action and the Bones launcher (stroke = currentColor). */
export function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </svg>
  );
}

/**
 * Pick a duration, get a link. The QR fills the screen so someone can scan it from
 * across a stage. Creating is a direct authenticated POST (no offline queue), so the
 * whole sheet is inert without a server.
 */
export function ShareSheet({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const online = useUi((s) => s.online);
  const [duration, setDuration] = useState<ShareDuration>(SHARE_DURATIONS[0]!);
  const [share, setShare] = useState<CreatedShare | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  // Guards the create POST synchronously. `busy` only disables the button on the NEXT
  // render, so two taps inside one frame would mint two live links and only show the
  // second one. The first would be a bearer credential nobody knows to revoke.
  const creating = useRef(false);

  useEffect(() => {
    if (!share) return;
    let alive = true;
    QRCode.toDataURL(share.url, { width: 560, margin: 1, color: { dark: "#0a0a0a", light: "#ffffff" } })
      .then((d) => { if (alive) setQr(d); })
      .catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [share]);

  async function create() {
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    setError(null);
    try {
      setShare(await createShare(target.kind, target.id, duration.ttlHours));
    } catch (err) {
      setError(shareErrorMessage(err));
      creating.current = false; // a failed attempt may be retried
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!share) return;
    setCopied((await copyText(share.url)) ? "yes" : "no");
  }

  return (
    <div className="share-overlay" onClick={onClose}>
      <div
        className={`share-sheet${share ? " live" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Share ${target.label}`}
      >
        <div className="share-head">
          <span className="share-kind">Share {target.kind === "setlist" ? "setlist" : "chart"}</span>
          <button className="share-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="share-target">{target.label}</div>

        {!share ? (
          <>
            <div className="share-durations" role="group" aria-label="Link duration">
              {SHARE_DURATIONS.map((d) => (
                <button
                  key={d.label}
                  className={`share-dur${d === duration ? " on" : ""}`}
                  onClick={() => setDuration(d)}
                  aria-pressed={d === duration}
                  disabled={!online || busy}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <button className="btn share-go" onClick={create} disabled={!online || busy}>
              {busy ? "Making a link…" : "Make link"}
            </button>
            {!online && (
              <p className="share-hint">Sharing needs the server. Reconnect to make a link.</p>
            )}
            {error && <p className="share-error">{error}</p>}
          </>
        ) : (
          <>
            <div className="share-qr">
              {qr
                ? <img src={qr} alt="QR code for the share link" />
                : <div className="share-qr-load" aria-label="Generating QR code" />}
            </div>
            <div className="share-url">
              <span className="share-url-text">{share.url}</span>
              <button className="btn share-copy" onClick={copy}>
                {copied === "yes" ? "Copied" : "Copy"}
              </button>
            </div>
            {copied === "no" && (
              <p className="share-hint">Couldn&rsquo;t copy automatically. Select the link and copy it.</p>
            )}
            <p className="share-note">{shareNote(target.kind)}</p>
            <button className="btn share-done" onClick={onClose}>Done</button>
          </>
        )}
      </div>
    </div>
  );
}
