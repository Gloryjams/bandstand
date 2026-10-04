import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove, SortableContext, useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { api } from "../lib/api";
import { db, type SetlistItem, type Piece, type Setlist } from "../lib/db";
import { canAuthor } from "../lib/identity";
import { queueWrite } from "../lib/sync-queue";
import { newUlid } from "../lib/ulid";
import { rankResults, type SearchablePiece } from "../lib/search";
import { DATA_CHANGED_EVENT } from "../lib/live";
import { useUi } from "../lib/store";

type Item = SetlistItem & { _piece?: Piece };

export function SetlistEditor() {
  const { id: setlistId } = useParams<{ id: string }>();
  const [setlist, setSetlist] = useState<Setlist | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [pickingPiece, setPickingPiece] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const itemsRef = useRef<Item[]>([]);
  const [allPieces, setAllPieces] = useState<Piece[]>([]);
  const [cacheJob, setCacheJob] = useState<
    { done: number; total: number; cached: number; status: "running" | "done" | "error"; error?: string } | null
  >(null);
  const recents = useUi((s) => s.recentPieceIds);
  const author = canAuthor(useUi((s) => s.identity));
  const nav = useNavigate();

  // A small activation distance keeps grip taps from becoming accidental micro-drags;
  // the grip's touch-action:none (styles.css) is what lets a touch drag start at all —
  // without it the tablet browser claims the gesture for scrolling and dnd-kit never
  // sees anything past pointerdown.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const searchable: SearchablePiece[] = useMemo(
    () => allPieces.map((p) => ({
      id: p.id, title: p.title, composer: p.composer,
      music_key: p.music_key,
      tags: JSON.parse(p.tags) as string[],
      notes: p.notes,
    })),
    [allPieces],
  );
  const ranked = useMemo(
    () => rankResults(searchable, pickerQuery, recents),
    [searchable, pickerQuery, recents],
  );

  async function load() {
    if (!setlistId) return;
    setSetlist((await db.setlists.get(setlistId)) ?? null);
    const raw = await db.setlist_items
      .where("setlist_id").equals(setlistId).sortBy("ordinal");
    const pieces = await db.pieces.bulkGet(
      raw.filter((r) => r.piece_id).map((r) => r.piece_id!),
    );
    const map = new Map(pieces.filter((p): p is Piece => !!p).map((p) => [p.id, p]));
    setItems(raw.map((r) => ({ ...r, _piece: r.piece_id ? map.get(r.piece_id) : undefined })));
    setAllPieces((await db.pieces.toArray()).filter((p) => !p.deleted_at));
  }
  useEffect(() => { load(); }, [setlistId]);

  // Another device edited data (maybe this very setlist) — reload from Dexie.
  useEffect(() => {
    const onChange = () => { load(); };
    window.addEventListener(DATA_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(DATA_CHANGED_EVENT, onChange);
  }, [setlistId]);

  async function persist(next: Item[]) {
    if (!setlistId) return;
    setItems(next.map((it, i) => ({ ...it, ordinal: i })));
    const rows = next.map((it, i) => ({
      id: it.id || newUlid(), setlist_id: setlistId,
      kind: it.kind, piece_id: it.piece_id, break_label: it.break_label,
      ordinal: i,
    }));
    await db.setlist_items.where("setlist_id").equals(setlistId).delete();
    await db.setlist_items.bulkPut(rows);
    // Server replace-mode: send the items with their ids so local + server agree.
    await queueWrite("upsert", "setlist_items", {
      setlist_id: setlistId,
      items: rows.map((it) => ({ id: it.id, kind: it.kind, piece_id: it.piece_id, break_label: it.break_label })),
    });
  }

  function openPicker() {
    setPickerQuery("");
    setPicked([]);
    setPickingPiece(true);
  }

  function closePicker() {
    setPickingPiece(false);
    setPicked([]);
  }

  function togglePick(pid: string) {
    setPicked((cur) => (cur.includes(pid) ? cur.filter((x) => x !== pid) : [...cur, pid]));
  }

  // Batch add: append every selected tune in one pass (one persist / one sync op),
  // so building a full set doesn't mean reopening the picker per song.
  async function addPicked() {
    if (picked.length === 0) return;
    const byId = new Map(allPieces.map((p) => [p.id, p]));
    const additions: Item[] = picked
      .map((pid) => byId.get(pid))
      .filter((p): p is Piece => !!p)
      .map((p, k) => ({
        id: newUlid(), setlist_id: setlistId!, kind: "piece" as const,
        piece_id: p.id, break_label: null, ordinal: items.length + k, _piece: p,
      }));
    await persist([...items, ...additions]);
    closePicker();
  }

  async function addBreak() {
    const next: Item[] = [...items, {
      id: newUlid(), setlist_id: setlistId!, kind: "break" as const,
      piece_id: null, break_label: "Set 2", ordinal: items.length,
    }];
    await persist(next);
  }

  // Set metadata (date/venue/notes) — single-row setlists upsert, like the name field.
  async function updateSetlist(patch: Partial<Setlist>) {
    if (!setlist) return;
    const next = { ...setlist, ...patch, updated_at: Date.now() };
    setSetlist(next);
    await db.setlists.put(next);
    await queueWrite("upsert", "setlists", { id: next.id, ...patch, updated_at: next.updated_at });
  }

  // Break labels: edit locally as you type, persist the whole item list on blur
  // (setlist_items sync is replace-mode, so we resend once instead of per keystroke).
  function relabelBreak(idx: number, label: string) {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, break_label: label } : it)));
  }
  function commitBreak() {
    void persist(itemsRef.current);
  }

  async function removeAt(idx: number) {
    const next = items.slice();
    next.splice(idx, 1);
    await persist(next);
  }

  async function moveTo(idx: number, target: "top" | "bottom" | number) {
    const next = items.slice();
    const [it] = next.splice(idx, 1);
    if (!it) return;
    if (target === "top") next.unshift(it);
    else if (target === "bottom") next.push(it);
    else next.splice(Math.max(0, Math.min(target, next.length)), 0, it);
    await persist(next);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((it) => it.id === active.id);
    const newIndex = items.findIndex((it) => it.id === over.id);
    persist(arrayMove(items, oldIndex, newIndex));
  }

  async function preCacheForOffline() {
    // Gather every blob to cache up front so the bar reflects real total work.
    const targets: { url: string; cat: "files" | "audio"; hash: string; ext: string }[] = [];
    for (const it of items) {
      if (it.kind !== "piece" || !it.piece_id) continue;
      for (const f of await db.files.where("piece_id").equals(it.piece_id).toArray()) {
        targets.push({ url: `/api/file/${f.piece_id}/${f.id}`, cat: "files", hash: f.content_hash, ext: ext(f.filename) });
      }
      for (const a of await db.audio_tracks.where("piece_id").equals(it.piece_id).toArray()) {
        targets.push({ url: `/api/audio/${a.piece_id}/${a.id}`, cat: "audio", hash: a.content_hash, ext: ext(a.filename) });
      }
    }
    if (targets.length === 0) { setCacheJob({ done: 0, total: 0, cached: 0, status: "done" }); return; }

    setCacheJob({ done: 0, total: targets.length, cached: 0, status: "running" });
    const { writeFile, storageErrorMessage } = await import("../lib/opfs");
    let done = 0, cached = 0;
    let error: string | undefined;
    for (const t of targets) {
      try {
        const r = await api.raw(t.url);
        const blob = r.ok ? await r.blob() : null;
        if (!blob) throw new Error(`fetch ${r.status}`);
        try {
          await writeFile(t.cat, t.hash, t.ext, blob);
        } catch (e) {
          error = storageErrorMessage(e);
          throw e;
        }
        cached++;
      } catch {
        error ??= "Some files could not be downloaded. Check your connection and try again.";
      }
      done++;
      setCacheJob({ done, total: targets.length, cached, status: "running" });
    }
    setCacheJob({ done, total: targets.length, cached, status: cached === 0 ? "error" : "done", error });
  }

  function ext(filename: string) {
    const i = filename.lastIndexOf(".");
    return i >= 0 ? filename.slice(i) : "";
  }

  if (!setlist) return <div>Loading…</div>;

  const firstItem = items[0];
  itemsRef.current = items; // latest items for commitBreak's on-blur persist

  return (
    <div className="setlist-editor">
      <header className="library-header">
        <Link to="/setlists">← Setlists</Link>
        {author ? (
          <input
            className="sl-name-input"
            value={setlist.name}
            onChange={(e) => updateSetlist({ name: e.target.value })}
          />
        ) : (
          <span className="sl-name-input">{setlist.name}</span>
        )}
        {author && <button onClick={openPicker}>+ Piece</button>}
        {author && <button onClick={addBreak}>+ Break</button>}
        <button onClick={preCacheForOffline} disabled={cacheJob?.status === "running"}>
          {cacheJob?.status === "running" ? "Caching…" : "Pre-cache for offline"}
        </button>
        {firstItem && (
          <button onClick={() => nav(
            `/play/${firstItem.piece_id}?setlist=${setlist.id}&i=0`,
          )} disabled={firstItem.kind !== "piece"}>Play</button>
        )}
      </header>

      <div className="setlist-details">
        <label className="sd-field">
          <span className="sd-label">Date</span>
          <input type="date" value={setlist.date ?? ""} readOnly={!author}
                 onChange={(e) => updateSetlist({ date: e.target.value || null })} />
        </label>
        <label className="sd-field">
          <span className="sd-label">Venue</span>
          <input value={setlist.venue ?? ""} placeholder="Venue" readOnly={!author}
                 onChange={(e) => updateSetlist({ venue: e.target.value || null })} />
        </label>
        <label className="sd-field sd-notes">
          <span className="sd-label">Notes</span>
          <textarea value={setlist.notes ?? ""} rows={2} readOnly={!author}
                    placeholder="Set notes, cues, dress code…"
                    onChange={(e) => updateSetlist({ notes: e.target.value || null })} />
        </label>
      </div>

      {cacheJob && (
        <div className={`precache precache-${cacheJob.status}`} role="status">
          {cacheJob.status === "running" && (
            <>
              <div className="precache-track">
                <div className="precache-fill"
                     style={{ width: `${cacheJob.total ? Math.round((cacheJob.done / cacheJob.total) * 100) : 0}%` }} />
              </div>
              <span className="precache-label">Caching for offline… {cacheJob.done}/{cacheJob.total}</span>
            </>
          )}
          {cacheJob.status === "done" && (
            <span className="precache-label">
              {cacheJob.total === 0
                ? "Nothing to cache. Add some tunes first."
                : cacheJob.cached === cacheJob.total
                  ? `Cached ${cacheJob.total} file${cacheJob.total === 1 ? "" : "s"} for offline use.`
                  : `Cached ${cacheJob.cached} of ${cacheJob.total}. ${cacheJob.error}`}
              <button className="precache-x" onClick={() => setCacheJob(null)} aria-label="Dismiss">×</button>
            </span>
          )}
          {cacheJob.status === "error" && (
            <span className="precache-label">
              {cacheJob.error}
              <button className="precache-x" onClick={() => setCacheJob(null)} aria-label="Dismiss">×</button>
            </span>
          )}
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((i) => i.id)}
                          strategy={verticalListSortingStrategy}>
          <ul className="setlist-items">
            {items.map((it, idx) => (
              <SortableItem key={it.id} item={it} idx={idx} readOnly={!author}
                onOpen={it.kind === "piece" && it.piece_id && it._piece
                  ? () => nav(`/play/${it.piece_id}?setlist=${setlistId}&i=${idx}`)
                  : undefined}
                onRemove={() => removeAt(idx)}
                onMoveTop={() => moveTo(idx, "top")}
                onMoveBottom={() => moveTo(idx, "bottom")}
                onRelabel={(label) => relabelBreak(idx, label)}
                onCommit={commitBreak} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {pickingPiece && (
        <div className="qf-overlay" onClick={closePicker}>
          <div className="qf-panel" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              className="qf-input"
              placeholder="Find tunes to add…"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
            />
            <ul className="qf-results">
              {ranked.map((r) => {
                const sel = picked.includes(r.id);
                return (
                  <li key={r.id}>
                    <button
                      className={`qf-row${sel ? " picked" : ""}`}
                      onClick={() => togglePick(r.id)}
                      aria-pressed={sel}
                    >
                      <span className="qf-check" aria-hidden>{sel ? "✓" : ""}</span>
                      <strong>{r.title}</strong>
                      {r.composer && <span> · {r.composer}</span>}
                      {r.music_key && <span className="key">{r.music_key}</span>}
                    </button>
                  </li>
                );
              })}
              {ranked.length === 0 && (
                <li className="qf-empty">No tunes match “{pickerQuery}”.</li>
              )}
            </ul>
            <div className="qf-footer">
              <button className="qf-cancel" onClick={closePicker}>Cancel</button>
              <button className="qf-done" disabled={picked.length === 0} onClick={addPicked}>
                {picked.length === 0 ? "Add tunes" : `Add ${picked.length}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SortableItem({ item, idx, readOnly, onOpen, onRemove, onMoveTop, onMoveBottom, onRelabel, onCommit }: {
  item: Item; idx: number; readOnly?: boolean; onOpen?: () => void; onRemove: () => void;
  onMoveTop: () => void; onMoveBottom: () => void;
  onRelabel: (label: string) => void; onCommit: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: item.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <li ref={setNodeRef} style={style} className={`item ${item.kind}`}>
      <span className="ordinal">{idx + 1}</span>
      {/* The grip carries the drag listeners; without it a member can't reorder. */}
      {!readOnly && <span className="grip" {...attributes} {...listeners}>≡</span>}
      <span className="label">
        {item.kind === "piece" ? (
          // Tap a tune to open its chart with setlist playback anchored here —
          // same deep-link the header Play button uses, at this row's position.
          onOpen ? (
            <button type="button" className="label-open" onClick={onOpen}>
              {item._piece?.title ?? "(missing)"}
            </button>
          ) : (
            item._piece?.title ?? "(missing)"
          )
        ) : readOnly ? (
          <span className="break-label-input">{item.break_label || "Break"}</span>
        ) : (
          <input
            className="break-label-input"
            value={item.break_label ?? ""}
            placeholder="Break"
            aria-label="Break label"
            onChange={(e) => onRelabel(e.target.value)}
            onBlur={onCommit}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
        )}
      </span>
      {!readOnly && <button onClick={onMoveTop}>↑↑</button>}
      {!readOnly && <button onClick={onMoveBottom}>↓↓</button>}
      {!readOnly && <button onClick={onRemove}>×</button>}
    </li>
  );
}
