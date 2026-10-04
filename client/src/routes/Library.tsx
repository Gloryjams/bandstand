import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../lib/api";
import { chartEditorUrl, showChartEditorLink } from "../lib/chart-editor";
import { db, type Piece } from "../lib/db";
import { applyLibraryView, collectTags, decodeTags, loadView, saveView, type LibrarySort, type LibView } from "../lib/library-view";
import { rankResults, type SearchablePiece } from "../lib/search";
import { globalPage } from "../lib/viewer-nav";
import { isResumable, restorePos } from "../lib/resume";
import { readResume } from "../lib/resume-store";
import { useUi } from "../lib/store";
import { canAuthor } from "../lib/identity";
import { fetchManifestAndMirror } from "../lib/sync";
import { DATA_CHANGED_EVENT } from "../lib/live";
import { readFailureDetail, uploadFailureMessage } from "../lib/upload-message";
import { PieceCard } from "../components/PieceCard";
import { ShareSheet, type ShareTarget } from "../components/ShareSheet";
import { EmptyState } from "../components/EmptyState";

export function Library() {
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [audioIds, setAudioIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [resume, setResume] = useState<{ url: string; label: string } | null>(null);
  const [upload, setUpload] = useState<{ done: number; total: number; errors: string[] } | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [view, setView] = useState<LibView>(() => loadView());
  const updateView = (patch: Partial<LibView>) =>
    setView((v) => { const next = { ...v, ...patch }; saveView(next); return next; });
  const fileInput = useRef<HTMLInputElement>(null);
  const recents = useUi((s) => s.recentPieceIds);
  const activeBandId = useUi((s) => s.activeBandId);
  const author = canAuthor(useUi((s) => s.identity));
  const chartEditor = useUi((s) => s.chartEditor);
  const nav = useNavigate();

  async function load() {
    const all = await db.pieces.toArray();
    setPieces(all.filter((p) => !p.deleted_at));
    // one pass over audio_tracks for the whole grid (badge on practice-able tunes)
    const tracks = await db.audio_tracks.toArray();
    setAudioIds(new Set(tracks.filter((t) => !t.deleted_at).map((t) => t.piece_id)));
    setLoaded(true);
  }

  // Offer to resume the last session (within 12h, piece still present).
  // Re-evaluated per band: resume state lives in the band's own DB.
  useEffect(() => {
    setResume(null);
    (async () => {
      const st = await readResume();
      if (!isResumable(st, Date.now()) || !st?.piece_id) return;
      const p = await db.pieces.get(st.piece_id);
      if (!p || p.deleted_at) return;
      const fs = (await db.files.where("piece_id").equals(st.piece_id).toArray())
        .filter((f) => !f.deleted_at)
        .sort((a, b) => a.ordinal - b.ordinal);
      const gp = globalPage(fs, restorePos(st, fs));
      const sl = st.setlist_id
        ? `&setlist=${st.setlist_id}&i=${st.setlist_position ?? 0}`
        : "";
      setResume({ url: `/play/${st.piece_id}?resume=1${sl}`, label: `${p.title}, page ${gp.n}` });
    })();
  }, [activeBandId]);

  useEffect(() => { load(); }, [activeBandId]);
  useEffect(() => {
    (async () => {
      try {
        await fetchManifestAndMirror();
        await load();
      } catch { /* offline */ }
    })();
  }, []);

  // Live push already mirrored the manifest; just reload the list from Dexie.
  useEffect(() => {
    const onChange = () => { load(); };
    window.addEventListener(DATA_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(DATA_CHANGED_EVENT, onChange);
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      await fetchManifestAndMirror();
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  // Upload charts straight from this device. The server drops each file into the
  // library and ingests it, so it also live-pushes to every other device.
  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // let the same file be re-picked later
    if (files.length === 0) return;
    const errors: string[] = [];
    setUpload({ done: 0, total: files.length, errors });
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const fd = new FormData();
      fd.append("file", f);
      try {
        const r = await api.raw("/api/upload-piece", { method: "POST", body: fd });
        if (!r.ok) {
          errors.push(`${f.name}: ${uploadFailureMessage(r.status, await readFailureDetail(r))}`);
        }
      } catch {
        errors.push(`${f.name}: couldn't reach the server`);
      }
      setUpload({ done: i + 1, total: files.length, errors: [...errors] });
    }
    try { await fetchManifestAndMirror(); await load(); } catch { /* offline */ }
    setUpload(errors.length === 0 ? null : { done: files.length, total: files.length, errors });
  }

  const searchable: SearchablePiece[] = useMemo(
    () => pieces.map((p) => ({
      id: p.id, title: p.title, composer: p.composer,
      music_key: p.music_key,
      tags: decodeTags(p.tags),
      notes: p.notes,
    })),
    [pieces],
  );

  const allTags = useMemo(() => collectTags(pieces), [pieces]);

  // Filters always apply; a live query ranks the filtered set, otherwise the
  // chosen sort orders the browse grid.
  const shown = useMemo(() => {
    const filtered = applyLibraryView(pieces, audioIds, view);
    if (!query.trim()) return filtered;
    const byId = new Map(filtered.map((p) => [p.id, p]));
    const searchableFiltered = searchable.filter((p) => byId.has(p.id));
    return rankResults(searchableFiltered, query, recents)
      .map((r) => byId.get(r.id))
      .filter((p): p is Piece => !!p);
  }, [pieces, audioIds, view, query, searchable, recents]);

  // An active filter must always have a visible, tappable chip — even when its
  // tag vanished from the library or the last audio track went away — or a
  // persisted filter becomes an invisible empty-library trap.
  const chipTags = view.tag && !allTags.includes(view.tag) ? [view.tag, ...allTags] : allTags;
  const showAudioChip = audioIds.size > 0 || view.audioOnly;
  const filtersActive = view.tag !== null || view.audioOnly;

  if (!loaded) return <div className="library" />;

  return (
    <div className="library">
      <div className="app-top">
        <h1>Repertoire</h1>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.cho,.chordpro,.crd,.mp3,.wav,.m4a,.flac"
          style={{ display: "none" }}
          onChange={onPickFiles}
        />
        <div className="top-actions">
          {author && (
            <button className="ghost-btn" onClick={() => fileInput.current?.click()}
                    disabled={!!upload && upload.done < upload.total}>
              {upload && upload.done < upload.total ? `Adding ${upload.done}/${upload.total}…` : "Add chart"}
            </button>
          )}
          <button className="ghost-btn" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Syncing…" : "Sync"}
          </button>
          {/* Open the chart editor belonging to the active workspace. Hidden when
              the server says the editor is not built in; Home carries the note. */}
          {author && showChartEditorLink(chartEditor) && (
            <a className="ghost-btn" href={chartEditorUrl()}>New chart</a>
          )}
        </div>
      </div>

      {upload && upload.errors.length > 0 && upload.done >= upload.total && (
        <div className="upload-errors" role="status">
          {upload.errors.map((msg, i) => <div key={i}>{msg}</div>)}
          <button className="precache-x" onClick={() => setUpload(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {pieces.length === 0 ? (
        <EmptyState
          title="No tunes yet"
          hint={<>Tap <strong>Add chart</strong> to upload one from this device, or drop a file into the server&apos;s <code>library</code> folder and Bones will have it on the stand.</>}
        />
      ) : (
        <>
          <input
            className="search lib-search"
            placeholder="Search tunes, composers, keys…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="lib-controls">
            <div className="seg" role="group" aria-label="Sort">
              {(["recent", "title", "played"] as LibrarySort[]).map((s) => (
                <button key={s} className={`seg-btn ${view.sort === s ? "on" : ""}`}
                        onClick={() => updateView({ sort: s })}>
                  {s === "recent" ? "Recent" : s === "title" ? "A-Z" : "Played"}
                </button>
              ))}
            </div>
            {(chipTags.length > 0 || showAudioChip) && (
              <div className="tag-row">
                {showAudioChip && (
                  <button className={`tag-chip ${view.audioOnly ? "on" : ""}`}
                          onClick={() => updateView({ audioOnly: !view.audioOnly })}>
                    Audio
                  </button>
                )}
                {chipTags.map((t) => (
                  <button key={t} className={`tag-chip ${view.tag === t ? "on" : ""}`}
                          onClick={() => updateView({ tag: view.tag === t ? null : t })}>
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
          {resume && (
            <button className="resume-banner" onClick={() => nav(resume.url)}>
              <span className="resume-eyebrow">Resume</span>
              {resume.label}
            </button>
          )}
          {shown.length === 0 && (
            <p className="lib-empty-note">
              No tunes match.
              {filtersActive && (
                <button className="tag-chip" style={{ marginLeft: 8 }}
                        onClick={() => updateView({ tag: null, audioOnly: false })}>
                  Clear filters
                </button>
              )}
            </p>
          )}
          <div className="grid">
            {shown.map((p) => (
              <PieceCard
                key={p.id}
                piece={p}
                hasAudio={audioIds.has(p.id)}
                onShare={author ? () => setShareTarget({ kind: "piece", id: p.id, label: p.title }) : undefined}
              />
            ))}
          </div>
        </>
      )}

      {shareTarget && <ShareSheet target={shareTarget} onClose={() => setShareTarget(null)} />}
    </div>
  );
}
