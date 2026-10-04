import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { db, type Piece } from "../lib/db";
import type { SItem } from "../lib/setlist-nav";

/**
 * One chart card in the filmstrip. A piece card fetches its own first-page
 * thumbnail (same authed endpoint the peek overlay uses); a break card just
 * shows its label. Tapping the card jumps setlist playback to this item.
 */
function FilmCard({
  item,
  pieceMeta,
  ordinal,
  current,
  onJump,
  cardRef,
}: {
  item: SItem;
  pieceMeta: Map<string, Piece>;
  ordinal: number;
  current: boolean;
  onJump: () => void;
  cardRef?: (el: HTMLButtonElement | null) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const pieceId = item.piece_id;

  useEffect(() => {
    if (item.kind !== "piece" || !pieceId) return;
    let made: string | null = null;
    let alive = true;
    (async () => {
      try {
        const res = await api.raw(`/api/thumb/${pieceId}`);
        if (res.ok && alive) {
          made = URL.createObjectURL(await res.blob());
          setUrl(made);
        }
      } catch {
        /* offline or no thumb — the title still identifies the tune */
      }
    })();
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [item.kind, pieceId]);

  const meta = item.kind === "piece" && pieceId ? pieceMeta.get(pieceId) : undefined;
  const title = item.kind === "break" ? (item.break_label ?? "Break") : (meta?.title ?? "Untitled");
  const keyLabel = item.kind === "piece" ? meta?.music_key : null;

  return (
    <button
      ref={cardRef}
      type="button"
      className={`film-card${current ? " current" : ""}${item.kind === "break" ? " is-break" : ""}`}
      onClick={onJump}
      aria-label={`Jump to ${ordinal}. ${title}${current ? " (now playing)" : ""}`}
      aria-current={current ? "true" : undefined}
    >
      <span className="fc-ord">{ordinal}</span>
      {current && <span className="fc-now">NOW</span>}
      <span className="fc-thumb">
        {item.kind === "break" ? (
          <span className="fc-break">{title}</span>
        ) : url ? (
          <img src={url} alt="" />
        ) : (
          <span className="fc-load" />
        )}
      </span>
      <span className="fc-title">{title}</span>
      {keyLabel && <span className="fc-key">{keyLabel}</span>}
    </button>
  );
}

/**
 * Bottom-sheet filmstrip of every item in the current setlist. Scrolls
 * horizontally (swipe through the book); the current item is centered on open
 * and badged NOW. Tap any chart to jump straight there. Tap the backdrop or ×
 * to dismiss without moving.
 */
export function SetlistFilmstrip({
  items,
  pieceMeta,
  currentIndex,
  setlistId,
  onJump,
  onClose,
}: {
  items: SItem[];
  pieceMeta: Map<string, Piece>;
  currentIndex: number;
  setlistId: string;
  onJump: (index: number) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState<string>("");
  const currentRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const sl = await db.setlists.get(setlistId);
      if (alive) setName(sl?.name ?? "");
    })();
    return () => {
      alive = false;
    };
  }, [setlistId]);

  // Center the current card when the strip opens.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, []);

  return (
    <div className="film-overlay" onClick={onClose}>
      <div className="film-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="film-head">
          <span className="film-title">{name || "Jump to a tune"}</span>
          <span className="film-hint">tap a chart to jump</span>
          <button type="button" className="film-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="film-strip">
          {items.map((it, i) => (
            <FilmCard
              key={i}
              item={it}
              pieceMeta={pieceMeta}
              ordinal={i + 1}
              current={i === currentIndex}
              onJump={() => onJump(i)}
              cardRef={
                i === currentIndex
                  ? (el) => {
                      currentRef.current = el;
                    }
                  : undefined
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
