import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../lib/api";
import type { Piece } from "../lib/db";
import { ShareIcon } from "./ShareSheet";

// Render keys in musician's notation: Bb -> B♭, F#m -> F♯m.
function prettyKey(k: string): string {
  return k.replace(/b/g, "♭").replace(/#/g, "♯");
}

const NOTE_BADGE = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
       strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
  </svg>
);

export function PieceCard({
  piece,
  hasAudio = false,
  onShare,
}: { piece: Piece; hasAudio?: boolean; onShare?: () => void }) {
  const isChart = piece.kind === "chart";
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  useEffect(() => {
    // Charts have no rendered thumbnail — don't waste a request that 404s.
    if (isChart) return;
    let url: string | null = null;
    (async () => {
      try {
        const res = await api.raw(`/api/thumb/${piece.id}`);
        if (res.ok) {
          url = URL.createObjectURL(await res.blob());
          setThumbUrl(url);
        }
      } catch { /* offline; no thumb */ }
    })();
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [piece.id, isChart]);

  return (
    <Link to={`/play/${piece.id}`} className="piece-card">
      {thumbUrl
        ? <img src={thumbUrl} alt="" />
        : <div className={`thumb-placeholder${isChart ? " chart-thumb" : ""}`}>{piece.title[0]}</div>}
      {onShare && (
        // The whole card is a Link, so the action has to swallow the navigation.
        <button
          className="card-share"
          aria-label={`Share ${piece.title}`}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onShare(); }}
        >
          <ShareIcon />
        </button>
      )}
      {isChart && <span className="chart-badge" title="Native chord chart">CHART</span>}
      {hasAudio && <span className="audio-badge" title="Has practice audio">{NOTE_BADGE}</span>}
      <div className="piece-meta">
        <div className="title">{piece.title}</div>
        {piece.composer && <div className="composer">{piece.composer}</div>}
        {piece.music_key && <span className="key-pill">{prettyKey(piece.music_key)}</span>}
      </div>
    </Link>
  );
}
