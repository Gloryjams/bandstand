import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { db, type Piece } from "../lib/db";
import { rankResults, type SearchablePiece } from "../lib/search";
import { queueWrite } from "../lib/sync-queue";
import { newUlid } from "../lib/ulid";
import { useUi, useViewer } from "../lib/store";
import { useHardwareBack } from "../lib/hardware-back";

export function QuickFind() {
  const open = useUi((s) => s.quickFindOpen);
  const setOpen = useUi((s) => s.setQuickFindOpen);
  const [query, setQuery] = useState("");
  const [pieces, setPieces] = useState<Piece[]>([]);
  const recents = useUi((s) => s.recentPieceIds);
  const setlistId = useViewer((s) => s.setlistId);
  const setlistPos = useViewer((s) => s.setlistPosition);
  const nav = useNavigate();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (e.key === "/" && !tag.match(/INPUT|TEXTAREA/)) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) db.pieces.toArray().then((rows) =>
      setPieces(rows.filter((p) => !p.deleted_at)));
  }, [open]);

  // Stable handler so useHardwareBack's effect doesn't re-run (and bounce itself
  // closed via its cleanup's history.back()) on every unrelated re-render.
  const close = useCallback(() => setOpen(false), [setOpen]);
  useHardwareBack(open, close);

  const searchable: SearchablePiece[] = useMemo(
    () => pieces.map((p) => ({
      id: p.id, title: p.title, composer: p.composer,
      music_key: p.music_key,
      tags: JSON.parse(p.tags) as string[],
      notes: p.notes,
    })),
    [pieces],
  );
  const ranked = useMemo(
    () => rankResults(searchable, query, recents).slice(0, 30),
    [searchable, query, recents],
  );

  async function addToCurrentSetlist(pieceId: string) {
    if (!setlistId) return;
    const items = await db.setlist_items
      .where("setlist_id").equals(setlistId).sortBy("ordinal");
    const insertAt = (setlistPos ?? items.length - 1) + 1;
    const next = items.slice();
    next.splice(insertAt, 0, {
      id: newUlid(), setlist_id: setlistId,
      kind: "piece", piece_id: pieceId, break_label: null, ordinal: insertAt,
    });
    next.forEach((item, i) => item.ordinal = i);
    await db.setlist_items.where("setlist_id").equals(setlistId).delete();
    await db.setlist_items.bulkPut(next);
    await queueWrite("upsert", "setlist_items", {
      setlist_id: setlistId,
      items: next.map((it) => ({ id: it.id, kind: it.kind, piece_id: it.piece_id, break_label: it.break_label })),
    });
    setOpen(false);
  }

  if (!open) return null;
  return (
    <>
        <div className="qf-overlay" onClick={() => setOpen(false)}>
          <div className="qf-panel" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              className="qf-input"
              placeholder="Find a tune…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <ul className="qf-results">
              {ranked.map((r) => {
                const full = pieces.find((p) => p.id === r.id)!;
                return (
                  <li key={r.id}>
                    <button className="qf-row"
                            onClick={() => { setOpen(false); nav(`/play/${r.id}`); }}>
                      <strong>{full.title}</strong>
                      {full.composer && <span> · {full.composer}</span>}
                      {full.music_key && <span className="key">{full.music_key}</span>}
                    </button>
                    {setlistId && (
                      <button className="qf-add"
                              onClick={() => addToCurrentSetlist(r.id)}
                              aria-label="Add to current setlist">+</button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
    </>
  );
}
