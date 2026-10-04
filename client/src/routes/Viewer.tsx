import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api } from "../lib/api";
import { db, type AudioTrack, type FileRow, type Piece, type Bookmark, type SectionLink } from "../lib/db";
import { readFile, writeFile, deleteFile } from "../lib/opfs";
import { analyzeContentBBox, loadDoc, renderPage, dropDoc } from "../lib/pdf";
import { globalPage, lastPos, nextPos, prevPos, type Pos } from "../lib/viewer-nav";
import { halfNext, halfPrev, loadHalfPage, loadSplitFrac, saveSplitFrac, clampSplitFrac } from "../lib/half-turn";
import { parseItems, isTextItem, textSizeFromThickness, type Item, type TextItem } from "../lib/annot";
import { advance, itemLocation, type SItem } from "../lib/setlist-nav";
import { sectionJump } from "../lib/section-jump";
import { restorePos } from "../lib/resume";
import { readResume, writeResume } from "../lib/resume-store";
import { queueWrite } from "../lib/sync-queue";
import { recordPieceOpened } from "../lib/recents";
import { newUlid } from "../lib/ulid";
import { useUi, useViewer } from "../lib/store";
import { canAuthor } from "../lib/identity";
import { useAnnotations } from "../hooks/useAnnotations";
import { useGesture } from "../hooks/useGesture";
import { useWakeLock } from "../hooks/useWakeLock";
import { useGigMode } from "../hooks/useGigMode";
import { ViewerToolbar } from "../components/ViewerToolbar";
import { BreakSlide, UpNextChip, PeekOverlay } from "../components/SetlistChrome";
import { SetlistFilmstrip } from "../components/SetlistFilmstrip";
import { MarksSheet } from "../components/MarksSheet";
import { AnnotationLayer } from "../components/AnnotationLayer";
import { AnnotToolbar } from "../components/AnnotToolbar";
import { ZoomControls } from "../components/ZoomControls";
import { BonesLauncher, ActionIcons } from "../components/BonesLauncher";
import { AudioPlayer } from "../components/AudioPlayer";
import { MetronomeBar } from "../components/Metronome";
import { loadAutocrop, type BBoxFrac } from "../lib/autocrop";
import { parseBeatsPerBar } from "../lib/metronome";
import { isLandscape, loadTwoUp, TWO_UP_GAP } from "../lib/two-up";
import { ShareSheet, ShareIcon } from "../components/ShareSheet";
import { ChartStage } from "../chart/ChartStage";
import type { Chart } from "../chart/types";

const ANNOT_COLORS = ["#ff3b30", "#1e90ff", "#111111"]; // quick-access: red, blue, black

const GIG_ICON = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

const AUDIO_ICON = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
  </svg>
);

const METRO_ICON = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 3h6l4 18H5z" /><path d="M12 14 17 5" /><circle cx="12" cy="15.5" r="1.4" />
  </svg>
);

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i) : "";
}

export function Viewer() {
  const { pieceId } = useParams<{ pieceId: string }>();
  const [params] = useSearchParams();
  const nav = useNavigate();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pageWrapRef = useRef<HTMLDivElement>(null);

  const [piece, setPiece] = useState<Piece | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [pos, setPos] = useState<Pos>({ fileIndex: 0, pageIndex: 0 });
  const [chrome, setChrome] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resizeTick, setResizeTick] = useState(0);
  const [pageSize, setPageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Native chord charts render a ChartStage instead of the PDF path: they have no files
  // row, so the whole content is opaque JSON on the piece. Parse it once per piece.
  const isChart = piece?.kind === "chart";
  const chart = useMemo<Chart | null>(() => {
    if (!piece || piece.kind !== "chart" || !piece.chart_json) return null;
    try {
      return JSON.parse(piece.chart_json) as Chart;
    } catch {
      return null;
    }
  }, [piece]);

  // Setlist playback state.
  const [items, setItems] = useState<SItem[]>([]);
  const [pieceMeta, setPieceMeta] = useState<Map<string, Piece>>(new Map());
  const [index, setIndex] = useState(0);
  const [breakLabel, setBreakLabel] = useState<string | null>(null);
  const [peekId, setPeekId] = useState<string | null>(null);
  const [setlistOpen, setSetlistOpen] = useState(false);

  // Bookmarks + section links (per current piece).
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [links, setLinks] = useState<SectionLink[]>([]);
  const [counters, setCounters] = useState<Map<string, number>>(new Map());
  const [marksOpen, setMarksOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  // Annotation tool UI (the strokes/history themselves live in useAnnotations).
  const [mode, setMode] = useState<"reading" | "annotate">("reading");
  const [tool, setTool] = useState<"pen" | "highlighter" | "eraser" | "text">("pen");
  const [color, setColor] = useState<string>(ANNOT_COLORS[0]!);
  const [thickness, setThickness] = useState(3);

  // Typed-text annotation UI. `textEdit` drives the floating input (id === null → a new
  // label; otherwise editing an existing one). `liveMove` previews a label being dragged.
  const [textEdit, setTextEdit] = useState<{ id: string | null; nx: number; ny: number; value: string } | null>(null);
  const [liveMove, setLiveMove] = useState<{ id: string; x: number; y: number } | null>(null);
  const textDrag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean; x: number; y: number } | null>(null);
  const doneRef = useRef(false); // set by the Done button so input blur doesn't cancel first

  // Half-page turns (Settings toggle, default off). `split` means: the top half of the
  // NEXT page is clipped over the top of the page box while the bottom of the current
  // page (pos, the logical page) stays readable below the divider. Pure decisions live
  // in lib/half-turn.ts; go() consults them at the single input convergence point.
  const [halfOn] = useState(loadHalfPage);
  const [split, setSplit] = useState(false);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const [overlayItems, setOverlayItems] = useState<Item[]>([]);
  const [peekHeld, setPeekHeld] = useState(false); // tap-hold peek (gesture-owned)
  const scaleRef = useRef(1); // go() is defined before the gesture hook; read zoom via ref
  // Where the split divider sits (fraction of page height the overlay covers).
  // Dragged live via the divider handle; persisted device-local on release.
  const [splitFrac, setSplitFrac] = useState(loadSplitFrac);
  const dividerDrag = useRef<{ y: number; frac: number } | null>(null);

  const openQuickFind = useUi((s) => s.setQuickFindOpen);
  const author = canAuthor(useUi((s) => s.identity));
  const setSetlistContext = useViewer((s) => s.setSetlistContext);

  useWakeLock();
  const gig = useGigMode();
  // Inverted dark stage (forScore-style): pages render white-on-black. Scoped to
  // gig mode so a persisted preference can never strand the viewer inverted with
  // no visible control; the filter also covers the annotation layers so black ink
  // flips to white instead of vanishing (ANNOT_COLORS includes #111111).
  const [invertPage, setInvertPage] = useState(() => localStorage.getItem("gig_invert") === "1");
  const toggleInvert = () => setInvertPage((v) => {
    const next = !v;
    localStorage.setItem("gig_invert", next ? "1" : "0");
    return next;
  });

  const setlistId = params.get("setlist");
  const setlistPosParam = params.get("i") != null ? Number(params.get("i")) : null;

  // Load a piece's files into the viewer and position at the requested page edge.
  const loadPiece = useCallback(
    async (pid: string, landOn: "start" | "end") => {
      const p = (await db.pieces.get(pid)) ?? null;
      const fs = (await db.files.where("piece_id").equals(pid).toArray())
        .filter((f) => !f.deleted_at)
        .sort((a, b) => a.ordinal - b.ordinal);
      setPiece(p);
      setFiles(fs);
      setBreakLabel(null);
      setCounters(new Map()); // fresh play-through, even on a reprise of the same piece
      setSplit(false); // item changes land on full pages
      setPos(landOn === "end" ? lastPos(fs) : { fileIndex: 0, pageIndex: 0 });
      void recordPieceOpened(pid);
    },
    [],
  );

  // Initial load for the route's piece (entry point), with optional resume.
  useEffect(() => {
    let alive = true;
    if (!pieceId) return;
    (async () => {
      const p = (await db.pieces.get(pieceId)) ?? null;
      const fs = (await db.files.where("piece_id").equals(pieceId).toArray())
        .filter((f) => !f.deleted_at)
        .sort((a, b) => a.ordinal - b.ordinal);
      if (!alive) return;
      setPiece(p);
      setFiles(fs);
      setBreakLabel(null);
      setSplit(false); // route-level piece switches (QuickFind) land on full pages too
      if (params.get("resume") === "1") {
        const st = await readResume();
        setPos(st && st.piece_id === pieceId ? restorePos(st, fs) : { fileIndex: 0, pageIndex: 0 });
      } else {
        setPos({ fileIndex: 0, pageIndex: 0 });
      }
      void recordPieceOpened(pieceId);
    })();
    return () => {
      alive = false;
    };
  }, [pieceId]);

  // Load the setlist's ordered items + piece metadata for the up-next chip.
  useEffect(() => {
    let alive = true;
    if (!setlistId) {
      setItems([]);
      setPieceMeta(new Map());
      setIndex(0);
      return;
    }
    (async () => {
      const raw = await db.setlist_items.where("setlist_id").equals(setlistId).sortBy("ordinal");
      const ids = [...new Set(raw.filter((r) => r.piece_id).map((r) => r.piece_id!))];
      const ps = await db.pieces.bulkGet(ids);
      if (!alive) return;
      setItems(raw.map((r) => ({ kind: r.kind, piece_id: r.piece_id, break_label: r.break_label })));
      setPieceMeta(new Map(ps.filter((p): p is Piece => !!p).map((p) => [p.id, p])));
      setIndex(Number.isFinite(setlistPosParam) ? (setlistPosParam as number) : 0);
    })();
    return () => {
      alive = false;
    };
  }, [setlistId, setlistPosParam]);

  useEffect(() => {
    setSetlistContext(setlistId, setlistId ? index : null);
  }, [setlistId, index, setSetlistContext]);

  // Load the current piece's bookmarks + section links; reset trigger counters so
  // a D.S. al Coda fires fresh each time the piece is opened.
  const currentPieceId = piece?.id ?? null;
  useEffect(() => {
    let alive = true;
    if (!currentPieceId) {
      setBookmarks([]);
      setLinks([]);
      setCounters(new Map());
      return;
    }
    (async () => {
      const [bms, lks] = await Promise.all([
        db.bookmarks.where("piece_id").equals(currentPieceId).toArray(),
        db.section_links.filter((l) => l.piece_id === currentPieceId).toArray(),
      ]);
      if (!alive) return;
      setBookmarks(bms.sort((a, b) => a.ordinal - b.ordinal));
      setLinks(lks);
      setCounters(new Map());
    })();
    return () => {
      alive = false;
    };
  }, [currentPieceId]);

  const currentFileId = files[pos.fileIndex]?.id ?? null;
  const annot = useAnnotations(currentPieceId, currentFileId, pos.pageIndex);

  // Practice tracks for the current piece. The bar itself stays mounted across piece
  // switches (audioOpen persists) so a practice session can walk a whole set.
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [audioOpen, setAudioOpen] = useState(false);
  const [metroOpen, setMetroOpen] = useState(false);
  // Auto-crop margins (Settings toggle, read on chart open). READING MODE ONLY:
  // annotate lifts the crop so drawing always happens on the full page and the
  // ink coordinate contract stays untouched. Also stands down for half-page
  // turns (the split overlay assumes full-page geometry).
  const [autocropOn] = useState(loadAutocrop);
  const [crop, setCrop] = useState<BBoxFrac | null>(null);
  // Two-up landscape (Settings toggle, read on chart open): reading mode shows
  // the current and next page side by side when the stage is landscape.
  // Sliding-window pairs — a turn still moves ONE page, so nav/setlists/resume
  // are untouched. Annotate, half-page split, auto-crop and peek all stand
  // down while paired (same fail-safe pattern as the auto-crop lift).
  const [twoUpOn] = useState(loadTwoUp);
  // TRUE only after a paired left-page render has actually landed — JSX, the
  // gesture pair-box, and every gate key off the RENDERED layout, never the
  // intended one, so state and canvas can't diverge (Codex round 5).
  const [renderedPaired, setRenderedPaired] = useState(false);
  const [rightSize, setRightSize] = useState({ w: 0, h: 0 });
  const rightCanvasRef = useRef<HTMLCanvasElement>(null);
  const [rightItems, setRightItems] = useState<Item[]>([]);
  useEffect(() => {
    let alive = true;
    if (!currentPieceId) { setAudioTracks([]); return; }
    (async () => {
      const ts = (await db.audio_tracks.where("piece_id").equals(currentPieceId).toArray())
        .filter((t) => !t.deleted_at)
        .sort((a, b) => a.ordinal - b.ordinal);
      if (alive) setAudioTracks(ts);
    })();
    return () => { alive = false; };
  }, [currentPieceId]);
  // Entering gig mode is "performing now": stow the practice bar. Under the blackout
  // it would be near-invisible but still tappable (the dim overlay is pointer-events:
  // none), and rehearsal audio has no place on stage. Unmounting also pauses the take.
  useEffect(() => { if (gig.active) setAudioOpen(false); }, [gig.active]);

  // Fetch a file's bytes, using OPFS as a best-effort cache. OPFS needs a secure
  // context (HTTPS/localhost); over plain HTTP on a LAN IP it is absent, so caching
  // is optional — the chart must still open straight from the fetched bytes.
  const getBlob = useCallback(async (f: FileRow): Promise<Blob> => {
    const ext = extOf(f.filename);
    // Cache is keyed by content_hash, not file_id: a chart edited on disk keeps
    // its file_id but gets a new hash, so the stale cached bytes are never read.
    try {
      const cached = await readFile("files", f.content_hash, ext);
      if (cached) return cached;
    } catch { /* OPFS unavailable */ }
    const res = await api.raw(`/api/file/${f.piece_id}/${f.id}`);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const blob = await res.blob();
    try {
      await writeFile("files", f.content_hash, ext, blob);
    } catch { /* OPFS unavailable; render without caching */ }
    return blob;
  }, []);

  // Render the current page whenever position, files, or viewport size change.
  // Skipped on break slides (no PDF to render).
  useEffect(() => {
    let alive = true;
    if (breakLabel) return;
    const f = files[pos.fileIndex];
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!f || !canvas || !stage) return;
    (async () => {
      try {
        setError(null);
        const blob = await getBlob(f);
        const doc = await loadDoc(f.content_hash, blob);
        if (!alive) return;
        const rect = stage.getBoundingClientRect();
        const paired = twoUpOn && isLandscape(rect.width, rect.height) && !split && mode === "reading";
        const wantCrop = autocropOn && !split && !paired && mode === "reading";
        const box = wantCrop
          ? await analyzeContentBBox(doc, pos.pageIndex, `${f.content_hash}:${pos.pageIndex}`)
          : null;
        if (!alive) return;
        const container = paired
          ? { width: (rect.width - TWO_UP_GAP) / 2, height: rect.height }
          : { width: rect.width, height: rect.height };
        await renderPage(doc, pos.pageIndex, canvas, container, undefined, box);
        if (alive) {
          // committed together, AFTER the render: layout state describes what
          // is actually on the canvas
          setCrop(box);
          setRenderedPaired(paired);
          const cr = canvas.getBoundingClientRect();
          setPageSize({ w: cr.width, h: cr.height });
        }
      } catch {
        if (alive) setError("Couldn't open this chart.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [files, pos, getBlob, resizeTick, breakLabel, autocropOn, split, mode, twoUpOn]);

  // Re-fit on resize / orientation change.
  useEffect(() => {
    const onResize = () => setResizeTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Persist resume state (debounced) as the reader moves. Skipped on break slides.
  useEffect(() => {
    if (breakLabel || files.length === 0) return;
    const pid = piece?.id ?? pieceId;
    if (!pid) return;
    writeResume({ pieceId: pid, files, pos, setlistId, setlistPos: setlistId ? index : null });
  }, [piece, pieceId, files, pos, setlistId, index, breakLabel]);

  const go = useCallback(
    (dir: 1 | -1) => {
      const onBreak = breakLabel != null;

      // A chart is one continuous page (scrolled, not paged): a turn only ever crosses
      // to the adjacent setlist item. Skip the whole PDF page/section/half-page machine.
      if (isChart && !onBreak) {
        const a = advance([], { fileIndex: 0, pageIndex: 0 }, items, index, dir);
        if (a.type === "item") {
          setIndex(a.loc.index);
          if (a.loc.kind === "piece") void loadPiece(a.loc.pieceId, a.loc.landOn);
          else { setBreakLabel(a.loc.label); setError(null); }
        }
        return;
      }

      // A forward turn may trigger a section link (D.S. al Coda / repeat) before
      // a normal page turn, jumping to a bookmarked section within the piece.
      if (dir === 1 && !onBreak) {
        const fromFileId = files[pos.fileIndex]?.id;
        if (fromFileId) {
          const j = sectionJump(links, bookmarks, counters, fromFileId, pos.pageIndex);
          if (j.jump) {
            const fi = files.findIndex((f) => f.id === j.toFileId);
            if (fi >= 0) {
              setCounters((m) => new Map(m).set(j.linkId, j.remaining));
              setSplit(false); // section jumps land on full pages
              setPos({ fileIndex: fi, pageIndex: j.toPageIndex });
              return;
            }
          }
        }
      }

      // Half-page turns: consulted after section links (a D.S. from page N replaces the
      // turn on the first tap from full N, exactly as today) and before advance(). With
      // the flag off this block is skipped entirely — the turn path is unchanged.
      if (halfOn && !onBreak) {
        const ctx = {
          enabled: true,
          zoomed: scaleRef.current > 1,
          reading: mode === "reading",
          split,
          hasNext: nextPos(files, pos) != null,
          hasPrev: prevPos(files, pos) != null,
        };
        const act = dir === 1 ? halfNext(ctx) : halfPrev(ctx);
        if (act === "enter-split") { setSplit(true); return; }
        if (act === "complete-split") {
          const np = nextPos(files, pos);
          if (np) { setSplit(false); setPos(np); }
          return;
        }
        if (act === "back-exit-split") { setSplit(false); return; }
        if (act === "back-enter-split") {
          const pp = prevPos(files, pos);
          if (pp) { setPos(pp); setSplit(true); }
          return;
        }
        // "pass" falls through to the existing advance() path (item boundaries etc.)
      }

      const navFiles = onBreak ? [] : files;
      const navPos = onBreak ? { fileIndex: 0, pageIndex: 0 } : pos;
      const a = advance(navFiles, navPos, items, index, dir);
      if (a.type === "page") {
        setSplit(false); // pass-through page turns are always full pages
        setPos(a.pos);
      } else if (a.type === "item") {
        setIndex(a.loc.index);
        if (a.loc.kind === "piece") {
          void loadPiece(a.loc.pieceId, a.loc.landOn);
        } else {
          setBreakLabel(a.loc.label);
          setError(null);
        }
      }
      // a.type === "none" -> stay put
    },
    [breakLabel, files, pos, items, index, loadPiece, links, bookmarks, counters, halfOn, split, mode, isChart],
  );

  // Direct jump from the in-play set-list sheet: land straight on any tune (or break)
  // instead of paging there. Mirrors go()'s item-crossing (no URL nav; resume tracks it).
  const jumpToItem = useCallback(
    (k: number) => {
      const loc = itemLocation(items, k, "start");
      if (!loc) return;
      setIndex(k);
      setSplit(false); // direct jumps land on full pages
      if (loc.kind === "piece") {
        void loadPiece(loc.pieceId, "start");
      } else {
        setBreakLabel(loc.label);
        setError(null);
      }
      setSetlistOpen(false);
    },
    [items, loadPiece],
  );

  const baseWidth = thickness * 0.0012;
  const annotWidth = tool === "highlighter" ? baseWidth * 5 : baseWidth;

  // A tap on empty page with the text tool opens the floating input at that point.
  const onTapText = useCallback((p: [number, number]) => {
    setTextEdit({ id: null, nx: p[0], ny: p[1], value: "" });
  }, []);

  // BLOCKER fix (Codex round 4): annotate input must not arm while the CROPPED
  // canvas is still on screen — pageNorm would normalize against cropped
  // geometry and commit cropped-space coords as full-page ink (permanent
  // corruption). Gestures keep reading behavior until the uncropped render has
  // landed (crop === null). Fails safe: if that render errors, drawing simply
  // never arms rather than corrupting.
  // Annotation may only arm on a rendered FULL-WIDTH page: crop lifted AND the
  // pair stood down. In two-up crop is already null, so without the
  // renderedPaired term a Draw tap would normalize ink over the half-width
  // canvas — the same corruption class the auto-crop gate closes.
  const annotateArmed = mode === "annotate" && crop === null && !renderedPaired;

  // The gesture layer centers/clamps the PAIR box while paired, so pan and the
  // fit transform frame both pages; annotation layers keep per-page sizes.
  const gstSize = renderedPaired && rightSize.w > 0
    ? { w: pageSize.w + TWO_UP_GAP + rightSize.w, h: Math.max(pageSize.h, rightSize.h) }
    : pageSize;

  // A peek held through a rotation into two-up would otherwise stay latched
  // (its overlay hidden) and reappear on rotating back.
  useEffect(() => { if (renderedPaired) setPeekHeld(false); }, [renderedPaired]);

  const gst = useGesture({
    pageSize: gstSize,
    stageRef,
    pageWrapRef,
    resetKey: `${currentFileId ?? ""}:${pos.pageIndex}`,
    mode: annotateArmed ? "annotate" : "reading",
    tool,
    color,
    annotWidth,
    onCommit: annot.commitStroke,
    onErase: annot.eraseStroke,
    onTapText,
    go,
    toggleChrome: () => setChrome((c) => !c),
    // Two-up already shows the next page — peek would just swallow long taps.
    onPeek: renderedPaired ? undefined : setPeekHeld,
  });

  // Commit the floating text input: new empty → no-op; existing empty → delete; else
  // add/update. All routed through the shared annotation history via commitItems.
  function commitText() {
    const te = textEdit;
    if (!te) return;
    const text = te.value.trim();
    if (te.id == null) {
      if (text) {
        const item: TextItem = {
          id: newUlid(), kind: "text", x: te.nx, y: te.ny,
          size: textSizeFromThickness(thickness), color, text,
        };
        annot.commitItems([...annot.items, item]);
      }
    } else if (text) {
      annot.commitItems(annot.items.map((it) => (it.id === te.id && isTextItem(it) ? { ...it, text } : it)));
    } else {
      annot.commitItems(annot.items.filter((it) => it.id !== te.id));
    }
    setTextEdit(null);
  }

  // Leaving annotate with the text input still open resolves it exactly like a
  // blur (commit non-empty / delete emptied) — reading mode never hosts the
  // editor, so it can never render against auto-cropped geometry.
  useEffect(() => {
    if (mode !== "annotate" && textEdit) commitText();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Tap-or-drag on an existing label (text tool only). stopPropagation keeps the stage's
  // gesture machine from ever seeing these pointers — the same isolation the half-divider
  // uses. A small move = a tap (re-open the editor); a real drag moves + commits the label.
  function onTextDown(t: TextItem, e: React.PointerEvent) {
    if (mode !== "annotate" || tool !== "text") return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    textDrag.current = { id: t.id, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y, moved: false, x: t.x, y: t.y };
  }
  function onTextMove(e: React.PointerEvent) {
    const d = textDrag.current;
    if (!d) return;
    e.stopPropagation();
    const scale = gst.view.scale || 1;
    const ndx = (e.clientX - d.sx) / (pageSize.w * scale || 1);
    const ndy = (e.clientY - d.sy) / (pageSize.h * scale || 1);
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 6) d.moved = true;
    d.x = Math.min(1, Math.max(0, d.ox + ndx));
    d.y = Math.min(1, Math.max(0, d.oy + ndy));
    if (d.moved) setLiveMove({ id: d.id, x: d.x, y: d.y });
  }
  function onTextUp(e: React.PointerEvent) {
    const d = textDrag.current;
    if (!d) return;
    e.stopPropagation();
    textDrag.current = null;
    setLiveMove(null);
    if (d.moved) {
      annot.commitItems(annot.items.map((it) => (it.id === d.id && isTextItem(it) ? { ...it, x: d.x, y: d.y } : it)));
    } else {
      const item = annot.items.find((it) => it.id === d.id);
      if (item && isTextItem(item)) setTextEdit({ id: item.id, nx: item.x, ny: item.y, value: item.text });
    }
  }

  // What the main layer draws: committed items, with the dragged label shown at its live
  // position while a move is in progress.
  const displayItems = liveMove
    ? annot.items.map((it) => (it.id === liveMove.id && isTextItem(it) ? { ...it, x: liveMove.x, y: liveMove.y } : it))
    : annot.items;
  const textActive = mode === "annotate" && tool === "text";
  const textHandlers = textActive ? { onDown: onTextDown, onMove: onTextMove, onUp: onTextUp } : undefined;

  // Split collapse guards: leaving fit zoom or reading mode resolves the split to the
  // full logical page N (what you were finishing — matches resume persistence).
  useEffect(() => {
    scaleRef.current = gst.view.scale;
    // `split` in the deps sweeps a phantom split on its next flip even when the scale
    // hasn't changed since (stage-device insurance; the machine already prevents it).
    if (gst.view.scale > 1) setSplit(false);
  }, [gst.view.scale, split]);
  useEffect(() => { if (mode !== "reading") setSplit(false); }, [mode]);

  // The overlay's page (top half of N+1). Memoized so the render/stroke effects don't
  // loop on nextPos's fresh object identity.
  const splitNext = useMemo(
    () => (split && !breakLabel ? nextPos(files, pos) : null),
    [split, breakLabel, files, pos],
  );

  // Two-up right page: same content-addressed render path, half-stage container.
  const twoUpNext = useMemo(
    () => (renderedPaired ? nextPos(files, pos) : null),
    [renderedPaired, files, pos],
  );

  useEffect(() => {
    let alive = true;
    if (!twoUpNext) { setRightSize((s) => (s.w === 0 ? s : { w: 0, h: 0 })); return; }
    const f = files[twoUpNext.fileIndex];
    const canvas = rightCanvasRef.current;
    const stage = stageRef.current;
    if (!f || !canvas || !stage) return;
    (async () => {
      try {
        const blob = await getBlob(f);
        const doc = await loadDoc(f.content_hash, blob);
        if (!alive) return;
        const rect = stage.getBoundingClientRect();
        await renderPage(doc, twoUpNext.pageIndex, canvas, { width: (rect.width - TWO_UP_GAP) / 2, height: rect.height });
        if (alive) {
          const cr = canvas.getBoundingClientRect();
          setRightSize({ w: cr.width, h: cr.height });
        }
      } catch { /* best-effort; the left page still reads */ }
    })();
    return () => { alive = false; };
  }, [twoUpNext, files, getBlob, resizeTick]);

  useEffect(() => {
    let alive = true;
    const clear = () => setRightItems((s) => (s.length === 0 ? s : []));
    clear();
    if (!twoUpNext || !currentPieceId) return;
    const f = files[twoUpNext.fileIndex];
    if (!f) return;
    (async () => {
      const row = await db.annotations.get([currentPieceId, f.id, twoUpNext.pageIndex]);
      if (!alive) return;
      if (row) setRightItems(parseItems(row.svg_paths));
    })();
    return () => { alive = false; };
  }, [twoUpNext, files, currentPieceId]);

  // Tap-hold peek: hold the right turn zone to glance at the next page without
  // turning; release snaps back (gesture machine swallows the turn). Same
  // content-addressed render path as the split overlay, full-page.
  const peekCanvasRef = useRef<HTMLCanvasElement>(null);
  const [peekItems, setPeekItems] = useState<Item[]>([]);
  const peekNext = useMemo(
    () => (peekHeld && !renderedPaired && !breakLabel ? nextPos(files, pos) : null),
    [peekHeld, renderedPaired, breakLabel, files, pos],
  );

  useEffect(() => {
    let alive = true;
    if (!peekNext) return;
    const f = files[peekNext.fileIndex];
    const canvas = peekCanvasRef.current;
    const stage = stageRef.current;
    if (!f || !canvas || !stage) return;
    (async () => {
      try {
        const blob = await getBlob(f);
        const doc = await loadDoc(f.content_hash, blob);
        if (!alive) return;
        const rect = stage.getBoundingClientRect();
        await renderPage(doc, peekNext.pageIndex, canvas, { width: rect.width, height: rect.height });
      } catch { /* best-effort glance; a blank peek is harmless */ }
    })();
    return () => { alive = false; };
  }, [peekNext, files, getBlob, resizeTick]);

  useEffect(() => {
    let alive = true;
    const clear = () => setPeekItems((s) => (s.length === 0 ? s : []));
    // Clear synchronously on EVERY target change, so a peek that retargets
    // (external turn mid-hold) never wears the previous page's ink while the
    // new page's annotations load.
    clear();
    if (!peekNext || !currentPieceId) return;
    const f = files[peekNext.fileIndex];
    if (!f) return;
    (async () => {
      const row = await db.annotations.get([currentPieceId, f.id, peekNext.pageIndex]);
      if (!alive) return;
      if (row) setPeekItems(parseItems(row.svg_paths));
    })();
    return () => { alive = false; };
  }, [peekNext, files, currentPieceId]);

  // Render N+1 into the clipped overlay canvas via the same content-addressed path as
  // the base page — this doubles as pre-rendering the next page, so completing the
  // split is instant. Best-effort: a failed overlay render just leaves the divider on
  // white; the completion turn still renders through the normal path.
  useEffect(() => {
    let alive = true;
    if (!splitNext) return;
    const f = files[splitNext.fileIndex];
    const canvas = overlayCanvasRef.current;
    const stage = stageRef.current;
    if (!f || !canvas || !stage) return;
    (async () => {
      try {
        const blob = await getBlob(f);
        const doc = await loadDoc(f.content_hash, blob);
        if (!alive) return;
        const rect = stage.getBoundingClientRect();
        await renderPage(doc, splitNext.pageIndex, canvas, { width: rect.width, height: rect.height });
      } catch { /* best-effort; see above */ }
    })();
    return () => { alive = false; };
  }, [splitNext, files, getBlob, resizeTick]);

  // N+1's committed annotations for the overlay (read-only; the visible top half).
  useEffect(() => {
    let alive = true;
    // keep the empty-array identity stable — a fresh [] each pass would re-render
    // every piece load even with the feature off
    const clear = () => setOverlayItems((s) => (s.length === 0 ? s : []));
    if (!splitNext || !currentPieceId) { clear(); return; }
    const f = files[splitNext.fileIndex];
    if (!f) { clear(); return; }
    (async () => {
      const row = await db.annotations.get([currentPieceId, f.id, splitNext.pageIndex]);
      if (!alive) return;
      if (row) setOverlayItems(parseItems(row.svg_paths));
      else clear();
    })();
    return () => { alive = false; };
  }, [splitNext, files, currentPieceId]);

  // Keyboard / Bluetooth pedal (pedals emit standard keys).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (/INPUT|TEXTAREA/.test(tag)) return;
      if (["PageDown", " ", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        go(1);
      } else if (["PageUp", "ArrowLeft"].includes(e.key)) {
        e.preventDefault();
        go(-1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  async function resync() {
    const f = files[pos.fileIndex];
    if (!f) return;
    dropDoc(f.content_hash);
    await deleteFile("files", f.content_hash, extOf(f.filename));
    setResizeTick((t) => t + 1); // force a re-render/refetch
  }

  // 1-based page number of a (file, page) within the whole piece — for the Marks list.
  function pageNumberFor(fileId: string, pageIndex: number): number {
    const fi = files.findIndex((f) => f.id === fileId);
    if (fi < 0) return pageIndex + 1;
    return globalPage(files, { fileIndex: fi, pageIndex }).n;
  }

  async function addBookmark(label: string) {
    const f = files[pos.fileIndex];
    if (!f || !currentPieceId) return;
    const bm: Bookmark = {
      id: newUlid(), piece_id: currentPieceId, file_id: f.id,
      page_index: pos.pageIndex, label, ordinal: bookmarks.length,
    };
    await db.bookmarks.put(bm);
    setBookmarks((b) => [...b, bm]);
    await queueWrite("upsert", "bookmarks", bm);
  }

  function jumpBookmark(b: Bookmark) {
    setSplit(false); // bookmark jumps land on full pages
    const fi = files.findIndex((f) => f.id === b.file_id);
    if (fi >= 0) setPos({ fileIndex: fi, pageIndex: b.page_index });
    setMarksOpen(false);
  }

  async function deleteLink(id: string) {
    await db.section_links.delete(id);
    setLinks((ls) => ls.filter((x) => x.id !== id));
    await queueWrite("delete", "section_links", { id });
  }

  async function deleteBookmark(id: string) {
    await db.bookmarks.delete(id);
    setBookmarks((b) => b.filter((x) => x.id !== id));
    await queueWrite("delete", "bookmarks", { id });
    for (const l of links.filter((x) => x.to_bookmark_id === id)) await deleteLink(l.id);
  }

  async function addLink(toBookmarkId: string, triggers: number) {
    const f = files[pos.fileIndex];
    if (!f || !currentPieceId) return;
    const lk: SectionLink = {
      id: newUlid(), piece_id: currentPieceId, from_file_id: f.id,
      from_page_index: pos.pageIndex, to_bookmark_id: toBookmarkId,
      initial_triggers: triggers, active: 1,
    };
    await db.section_links.put(lk);
    setLinks((l) => [...l, lk]);
    await queueWrite("upsert", "section_links", lk);
  }

  async function toggleLink(l: SectionLink) {
    const active = l.active ? 0 : 1;
    await db.section_links.update(l.id, { active });
    setLinks((ls) => ls.map((x) => (x.id === l.id ? { ...x, active } : x)));
    await queueWrite("upsert", "section_links", { id: l.id, active });
  }

  const gp = globalPage(files, pos);

  // Up-next chip: the upcoming setlist item, if any.
  const upNext = setlistId && index + 1 < items.length ? items[index + 1] : null;
  const upNextMeta = upNext?.piece_id ? pieceMeta.get(upNext.piece_id) : undefined;
  const upNextTitle = upNext
    ? upNext.kind === "break"
      ? upNext.break_label ?? "Break"
      : upNextMeta?.title ?? "Next tune"
    : "";
  const upNextSub = upNext && upNext.kind === "piece"
    ? [upNextMeta?.music_key && `key ${upNextMeta.music_key}`, upNextMeta?.tempo && `${upNextMeta.tempo} bpm`]
        .filter(Boolean)
        .join(" · ")
    : "";
  // Prominent in the last 2 pages of a tune, or whenever a break is the lead-in.
  const upNextProminent = breakLabel != null || (gp.total > 0 && gp.total - gp.n <= 1);

  return (
    // The stage is always dark — a white chart reads best on black, whatever the app theme.
    <div className="viewer" data-theme="dark">
      <div
        className={`viewer-stage${isChart ? " chart-mode" : ""}`}
        ref={stageRef}
        {...(isChart
          ? {}
          : {
              onPointerDown: gst.onPointerDown,
              onPointerMove: gst.onPointerMove,
              onPointerUp: gst.onPointerUp,
              onPointerCancel: gst.onPointerCancel,
            })}
      >
        {breakLabel ? (
          <BreakSlide label={breakLabel} />
        ) : isChart ? (
          chart ? (
            <>
              {/* Thin edge zones advance setlist items on tap; the wide middle scrolls
                  the chart. A tap on the chart body toggles chrome (pedal/keys also turn). */}
              {setlistId && (
                <>
                  <button className="chart-tap chart-tap-prev" aria-label="Previous" onClick={() => go(-1)} />
                  <button className="chart-tap chart-tap-next" aria-label="Next" onClick={() => go(1)} />
                </>
              )}
              <div className="chart-tapchrome" onClick={() => setChrome((c) => !c)}>
                <ChartStage key={piece?.id} chart={chart} controlsVisible={chrome} />
              </div>
            </>
          ) : (
            <div className="viewer-error"><p>This chart couldn't be read.</p></div>
          )
        ) : (
          <div
            className={`page-wrap${gig.active && invertPage ? " inverted" : ""}`}
            ref={pageWrapRef}
            style={{
              transform: `translate(${gst.view.tx}px, ${gst.view.ty}px) scale(${gst.view.scale})`,
              transformOrigin: "0 0",
            }}
          >
            <canvas ref={canvasRef} className="viewer-canvas" />
            {pageSize.w > 0 && (
              <AnnotationLayer items={displayItems} live={gst.live} pageW={pageSize.w} pageH={pageSize.h} crop={crop}
                               onText={annotateArmed ? textHandlers : undefined} />
            )}
            {renderedPaired && twoUpNext && (
              <div className="tu-right" style={{ left: pageSize.w + TWO_UP_GAP }} aria-hidden>
                <canvas ref={rightCanvasRef} className="viewer-canvas" />
                {rightSize.w > 0 && (
                  <AnnotationLayer items={rightItems} live={null} pageW={rightSize.w} pageH={rightSize.h} />
                )}
              </div>
            )}
            {peekNext && pageSize.w > 0 && (
              <div className="peek-overlay" style={{ width: pageSize.w, height: pageSize.h }} aria-hidden>
                <canvas ref={peekCanvasRef} className="viewer-canvas" />
                <AnnotationLayer items={peekItems} live={null} pageW={pageSize.w} pageH={pageSize.h} />
              </div>
            )}
            {splitNext && pageSize.w > 0 && gst.view.scale === 1 && mode === "reading" && (
              <>
                <div
                  className="half-overlay"
                  style={{ width: pageSize.w, height: pageSize.h * splitFrac }}
                  aria-hidden
                >
                  <canvas ref={overlayCanvasRef} className="viewer-canvas" />
                  <AnnotationLayer items={overlayItems} live={null} pageW={pageSize.w} pageH={pageSize.h} />
                </div>
                {/* Drag handle on the divider. stopPropagation keeps the stage's gesture
                    machine (page turns / draw) from ever seeing these pointers; the split
                    only exists at fit zoom, so clientY deltas map 1:1 to page pixels. */}
                <div
                  className="half-divider"
                  style={{ top: pageSize.h * splitFrac, width: pageSize.w }}
                  role="separator"
                  aria-label="Adjust split position"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    dividerDrag.current = { y: e.clientY, frac: splitFrac };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!dividerDrag.current) return;
                    e.stopPropagation();
                    const d = dividerDrag.current;
                    setSplitFrac(clampSplitFrac(d.frac + (e.clientY - d.y) / pageSize.h));
                  }}
                  onPointerUp={(e) => {
                    if (!dividerDrag.current) return;
                    e.stopPropagation();
                    const d = dividerDrag.current;
                    dividerDrag.current = null;
                    const f = clampSplitFrac(d.frac + (e.clientY - d.y) / pageSize.h);
                    setSplitFrac(f);
                    saveSplitFrac(f);
                  }}
                  onPointerCancel={(e) => {
                    if (!dividerDrag.current) return;
                    e.stopPropagation();
                    dividerDrag.current = null;
                    saveSplitFrac(splitFrac);
                  }}
                >
                  <span className="half-divider-pill" aria-hidden />
                </div>
              </>
            )}
          </div>
        )}

        {/* Floating single-line text input, positioned at the tap point in stage coords
            (page-wrap sits at stage 0,0, transformed by the view). stopPropagation keeps
            the stage gesture machine from starting a fresh text tap under it. */}
        {textEdit && mode === "annotate" && !breakLabel && pageSize.w > 0 && (
          <div
            className="annot-text-edit"
            style={{
              left: gst.view.tx + textEdit.nx * pageSize.w * gst.view.scale,
              top: gst.view.ty + textEdit.ny * pageSize.h * gst.view.scale,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <input
              className="annot-text-input"
              autoFocus
              value={textEdit.value}
              placeholder="label"
              style={{ fontSize: Math.max(13, textSizeFromThickness(thickness) * pageSize.h * gst.view.scale), color }}
              onChange={(e) => setTextEdit((t) => (t ? { ...t, value: e.target.value } : t))}
              onFocus={() => { doneRef.current = false; }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitText(); }
                else if (e.key === "Escape") {
                  e.preventDefault();
                  doneRef.current = true; // teardown blur (if any) must not re-commit
                  setTextEdit(null);
                }
              }}
              onBlur={(e) => {
                if (doneRef.current) { doneRef.current = false; return; } // Done/Escape handled it
                // Tap-away keeps typed work on a finger tablet: non-empty commits; empty
                // cancels a new label / reverts an edit (only explicit Done/Enter with
                // empty text deletes an existing one — commitText's delete branch).
                if (e.currentTarget.value.trim()) commitText();
                else setTextEdit(null);
              }}
            />
            {/* pointerdown fires before input blur → flag it so blur doesn't cancel first. */}
            <button
              className="annot-text-done"
              onPointerDown={() => { doneRef.current = true; }}
              onClick={() => commitText()}
              aria-label="Done"
            >
              Done
            </button>
          </div>
        )}
      </div>

      {chrome && (
        <ViewerToolbar
          title={breakLabel ?? piece?.title ?? ""}
          pageN={breakLabel ? 0 : gp.n}
          pageTotal={breakLabel ? 0 : gp.total}
          setlistPos={setlistId ? index : null}
          setlistTotal={setlistId ? items.length || null : null}
          onBack={() => nav(setlistId ? `/setlists/${setlistId}` : "/")}
          onOpenSetlist={setlistId && items.length > 0 ? () => setSetlistOpen(true) : undefined}
        />
      )}

      {setlistOpen && setlistId && (
        <SetlistFilmstrip
          items={items}
          pieceMeta={pieceMeta}
          currentIndex={index}
          setlistId={setlistId}
          onJump={jumpToItem}
          onClose={() => setSetlistOpen(false)}
        />
      )}

      {!breakLabel && currentPieceId && (
        <BonesLauncher
          actions={[
            // Draw + Marks operate on PDF pages/annotations — not meaningful for a chart,
            // and they author director data, so band members don't get them (Phase 1:
            // members read; per-member ink layers are the Phase 2 build).
            ...(!isChart && author
              ? [
                  {
                    key: "draw",
                    label: mode === "annotate" ? "Done" : "Draw",
                    icon: ActionIcons.draw,
                    active: mode === "annotate",
                    onClick: () => setMode((m) => (m === "annotate" ? "reading" : "annotate")),
                  },
                  { key: "marks", label: "Marks", icon: ActionIcons.marks, onClick: () => setMarksOpen(true) },
                ]
              : []),
            { key: "find", label: "Find", icon: ActionIcons.find, onClick: () => openQuickFind(true) },
            ...(author
              ? [{ key: "share", label: "Share", icon: <ShareIcon />, onClick: () => setShareOpen(true) }]
              : []),
            ...(audioTracks.length > 0
              ? [{
                  key: "audio",
                  label: audioOpen ? "Hide player" : "Audio",
                  icon: AUDIO_ICON,
                  active: audioOpen,
                  onClick: () => setAudioOpen((o) => !o),
                }]
              : []),
            { key: "click", label: metroOpen ? "Hide click" : "Click", icon: METRO_ICON, active: metroOpen, onClick: () => setMetroOpen((o) => !o) },
            { key: "gig", label: gig.active ? "Exit gig" : "Gig", icon: GIG_ICON, active: gig.active, onClick: gig.toggle },
          ]}
        />
      )}

      {shareOpen && currentPieceId && (
        <ShareSheet
          target={{ kind: "piece", id: currentPieceId, label: piece?.title ?? "This chart" }}
          onClose={() => setShareOpen(false)}
        />
      )}

      {audioOpen && audioTracks.length > 0 && !breakLabel && (
        <AudioPlayer
          tracks={audioTracks}
          hidden={mode === "annotate"}
          onClose={() => setAudioOpen(false)}
        />
      )}

      {metroOpen && !breakLabel && (
        <MetronomeBar
          key={currentPieceId ?? "none"}
          initialBpm={piece?.tempo ?? null}
          beatsPerBar={parseBeatsPerBar(piece?.time_sig)}
          hidden={mode === "annotate"}
          onClose={() => setMetroOpen(false)}
        />
      )}

      {chrome && mode === "annotate" && !breakLabel && (
        <AnnotToolbar
          tool={tool}
          color={color}
          thickness={thickness}
          colors={ANNOT_COLORS}
          canUndo={annot.canUndo}
          canRedo={annot.canRedo}
          onTool={setTool}
          onColor={(c) => {
            setColor(c);
            if (tool === "eraser") setTool("pen");
          }}
          onThickness={setThickness}
          onUndo={annot.undo}
          onRedo={annot.redo}
        />
      )}

      {chrome && !breakLabel && !isChart && (
        <ZoomControls
          scale={gst.view.scale}
          onIn={() => gst.zoomBy(1.5)}
          onOut={() => gst.zoomBy(1 / 1.5)}
          onReset={gst.zoomReset}
        />
      )}

      {marksOpen && currentPieceId && (
        <MarksSheet
          fromPageLabel={gp.n}
          bookmarks={bookmarks}
          links={links}
          pageNumberFor={pageNumberFor}
          onAddBookmark={addBookmark}
          onJumpBookmark={jumpBookmark}
          onDeleteBookmark={deleteBookmark}
          onAddLink={addLink}
          onToggleLink={toggleLink}
          onDeleteLink={deleteLink}
          onClose={() => setMarksOpen(false)}
        />
      )}

      {chrome && upNext && (
        <UpNextChip
          title={upNextTitle}
          sub={upNextSub}
          prominent={upNextProminent}
          peekable={upNext.kind === "piece" && !!upNext.piece_id}
          onPeek={() => upNext.piece_id && setPeekId(upNext.piece_id)}
        />
      )}

      {peekId && <PeekOverlay pieceId={peekId} onClose={() => setPeekId(null)} />}

      {gig.active && (
        <>
          {/* Dim overlay — pointer-events:none so page-turn taps pass straight through. */}
          <div className="gig-dim" style={{ opacity: gig.dim }} aria-hidden />
          <div className="gig-controls" role="group" aria-label="Gig mode">
            <span className="gig-tag">GIG</span>
            <input
              className="gig-slider"
              type="range"
              min={0}
              max={0.85}
              step={0.05}
              value={gig.dim}
              onChange={(e) => gig.setDim(Number(e.target.value))}
              aria-label="Screen dim"
            />
            <button className={`gig-invert${invertPage ? " on" : ""}`} onClick={toggleInvert}
                    aria-pressed={invertPage} aria-label="Invert page colors">
              {invertPage ? "Paper" : "Invert"}
            </button>
            <button className="gig-exit" onClick={gig.toggle}>Exit</button>
          </div>
        </>
      )}

      {error && (
        <div className="viewer-error">
          <p>{error}</p>
          <button onClick={resync}>Re-sync from server</button>
          <button onClick={() => nav("/")}>Back to library</button>
        </div>
      )}
    </div>
  );
}
