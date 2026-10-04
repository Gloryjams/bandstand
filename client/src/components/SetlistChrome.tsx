import { useEffect, useState } from "react";

import { api } from "../lib/api";

/** Full-stage card shown when the current setlist item is a break ("Set 2", "Encore"). */
export function BreakSlide({ label }: { label: string }) {
  return (
    <div className="break-slide">
      <div className="break-rule" />
      <div className="break-label">{label}</div>
      <div className="break-hint">tap right / pedal to continue</div>
    </div>
  );
}

/**
 * The next-tune chip during setlist play. Ghosted by default; `prominent` near the end
 * of the current tune (or on a break). Tappable to peek the next piece's first page.
 */
export function UpNextChip({
  title,
  sub,
  prominent,
  peekable,
  onPeek,
}: {
  title: string;
  sub: string;
  prominent: boolean;
  peekable: boolean;
  onPeek: () => void;
}) {
  return (
    <button
      className={`up-next${prominent ? " prominent" : ""}`}
      onClick={onPeek}
      disabled={!peekable}
      aria-label={`Up next: ${title}`}
    >
      <span className="un-label">UP NEXT</span>
      <span className="un-title">{title}</span>
      {sub && <span className="un-sub">{sub}</span>}
    </button>
  );
}

/** Overlay showing a piece's first-page thumbnail. Tap anywhere to dismiss. */
export function PeekOverlay({ pieceId, onClose }: { pieceId: string; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    let alive = true;
    (async () => {
      try {
        const res = await api.raw(`/api/thumb/${pieceId}`);
        if (res.ok && alive) {
          made = URL.createObjectURL(await res.blob());
          setUrl(made);
        }
      } catch { /* offline; no thumb */ }
    })();
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [pieceId]);

  return (
    <div className="peek-overlay" onClick={onClose}>
      {url ? <img src={url} alt="" className="peek-img" /> : <div className="peek-loading">Loading…</div>}
    </div>
  );
}
