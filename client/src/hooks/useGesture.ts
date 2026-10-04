import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { normPoint, type Stroke } from "../lib/annot";
import { centerView, clampView, twoFinger, zoomAbout, type View } from "../lib/view";
import { newUlid } from "../lib/ulid";

interface GestureArgs {
  pageSize: { w: number; h: number };
  stageRef: RefObject<HTMLDivElement | null>;
  pageWrapRef: RefObject<HTMLDivElement | null>;
  /** Changes when the page changes, to recenter + reset zoom to fit. */
  resetKey: string;
  mode: "reading" | "annotate";
  tool: "pen" | "highlighter" | "eraser" | "text";
  color: string;
  annotWidth: number;
  onCommit: (s: Stroke) => void;
  onErase: (p: [number, number]) => void;
  /** A tap (not a drag) on the page with the text tool active, in normalized coords. */
  onTapText: (p: [number, number]) => void;
  go: (dir: 1 | -1) => void;
  toggleChrome: () => void;
  /** Tap-hold on the right turn zone: peek at the next page without turning.
      Called with true when the hold matures, false when the finger lifts. */
  onPeek?: (on: boolean) => void;
}

const PEEK_HOLD_MS = 400;
const PEEK_SLOP_PX = 12;

/**
 * The viewer's single pointer state machine: one finger turns pages (reading) or draws
 * (annotate), two fingers pinch-zoom + pan, one finger pans when zoomed. Also owns the
 * pan/zoom transform and the in-progress (`live`) stroke. Keeping it all here means draw,
 * pan, pinch and page-nav share one source of truth.
 */
export function useGesture({
  pageSize, stageRef, pageWrapRef, resetKey,
  mode, tool, color, annotWidth, onCommit, onErase, onTapText, go, toggleChrome, onPeek,
}: GestureArgs) {
  const [view, setViewState] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef<View>(view); // latest transform, readable between renders
  const setView = useCallback((v: View) => { viewRef.current = v; setViewState(v); }, []);
  const [live, setLive] = useState<Stroke | null>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gesture = useRef<"none" | "draw" | "pan" | "nav" | "pinch" | "text">("none");
  const navStartX = useRef<number | null>(null);
  const navStartY = useRef<number | null>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peeking = useRef(false);
  const cancelPeekArm = () => {
    if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
  };
  const endPeek = () => {
    cancelPeekArm();
    if (peeking.current) { peeking.current = false; onPeek?.(false); }
  };
  useEffect(() => endPeek, []); // eslint-disable-line react-hooks/exhaustive-deps
  const textStart = useRef<{ x: number; y: number } | null>(null);
  const panLast = useRef<{ x: number; y: number } | null>(null);
  const pinchPrev = useRef<{ ids: [number, number]; a: [number, number]; b: [number, number] } | null>(null);

  const stageW = () => stageRef.current?.getBoundingClientRect().width ?? 0;
  const stageH = () => stageRef.current?.getBoundingClientRect().height ?? 0;
  const stageLocal = (cx: number, cy: number): [number, number] => {
    const r = stageRef.current?.getBoundingClientRect();
    return [cx - (r?.left ?? 0), cy - (r?.top ?? 0)];
  };
  // Normalized page coords for drawing — uses the (transformed) page-wrap rect, so it
  // stays correct at any zoom/pan.
  const pageNorm = (cx: number, cy: number): [number, number] => {
    const r = pageWrapRef.current?.getBoundingClientRect();
    return r ? normPoint(cx, cy, r) : [0, 0];
  };
  const settle = (v: View) => setView(clampView(v, pageSize.w, pageSize.h, stageW(), stageH()));

  // Reset zoom + recenter the page when the page changes or the viewport resizes.
  // An EXTERNAL page change (pedal/keyboard) mid-hold also lands here: kill any
  // live or pending peek and abandon the in-flight nav gesture, or a matured
  // timer could open a peek on the wrong page and the release would mis-fire.
  useEffect(() => {
    endPeek();
    gesture.current = "none";
    navStartX.current = null;
    navStartY.current = null;
    if (pageSize.w > 0 && pageSize.h > 0) setView(centerView(pageSize.w, pageSize.h, stageW(), stageH()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize.w, pageSize.h, resetKey, setView]);

  function onPointerDown(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2) {
      setLive(null); // abandon any in-progress stroke; two fingers means pinch
      endPeek();
      gesture.current = "pinch";
      const ids = [...pointers.current.keys()].slice(0, 2) as [number, number];
      const p1 = pointers.current.get(ids[0])!, p2 = pointers.current.get(ids[1])!;
      pinchPrev.current = { ids, a: stageLocal(p1.x, p1.y), b: stageLocal(p2.x, p2.y) };
      return;
    }
    if (mode === "annotate") {
      if (tool === "eraser") {
        gesture.current = "draw";
        onErase(pageNorm(e.clientX, e.clientY));
      } else if (tool === "text") {
        // Text is placed on a tap, resolved on pointerup (so a drag can be distinguished).
        gesture.current = "text";
        textStart.current = { x: e.clientX, y: e.clientY };
      } else {
        gesture.current = "draw";
        setLive({ id: "live", tool, color, width: annotWidth, points: [pageNorm(e.clientX, e.clientY)] });
      }
    } else if (viewRef.current.scale > 1) {
      gesture.current = "pan";
      panLast.current = { x: e.clientX, y: e.clientY };
    } else {
      gesture.current = "nav";
      navStartX.current = e.clientX;
      navStartY.current = e.clientY;
      // Arm the peek hold only in the right turn zone (peek = glance at NEXT).
      const r = stageRef.current?.getBoundingClientRect();
      if (onPeek && r && e.clientX - r.left > (2 * r.width) / 3) {
        cancelPeekArm();
        peekTimer.current = setTimeout(() => {
          peekTimer.current = null;
          if (gesture.current === "nav") { peeking.current = true; onPeek(true); }
        }, PEEK_HOLD_MS);
      }
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g === "pinch" && pinchPrev.current) {
      const { ids } = pinchPrev.current;
      const p1 = pointers.current.get(ids[0]), p2 = pointers.current.get(ids[1]);
      if (!p1 || !p2) return;
      const a1 = stageLocal(p1.x, p1.y), b1 = stageLocal(p2.x, p2.y);
      settle(twoFinger(viewRef.current, pinchPrev.current.a, pinchPrev.current.b, a1, b1));
      pinchPrev.current = { ids, a: a1, b: b1 };
    } else if (g === "draw" && mode === "annotate") {
      if (tool === "eraser") {
        onErase(pageNorm(e.clientX, e.clientY));
      } else {
        const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
        const evs = native.getCoalescedEvents?.() ?? [native];
        const pts = evs.map((ev) => pageNorm(ev.clientX, ev.clientY));
        setLive((cur) => (cur ? { ...cur, points: [...cur.points, ...pts] } : cur));
      }
    } else if (g === "pan" && panLast.current) {
      const dx = e.clientX - panLast.current.x, dy = e.clientY - panLast.current.y;
      panLast.current = { x: e.clientX, y: e.clientY };
      const v = viewRef.current;
      settle({ scale: v.scale, tx: v.tx + dx, ty: v.ty + dy });
    } else if (g === "nav" && !peeking.current && peekTimer.current
               && navStartX.current != null && navStartY.current != null
               && Math.hypot(e.clientX - navStartX.current, e.clientY - navStartY.current) > PEEK_SLOP_PX) {
      cancelPeekArm(); // a real swipe is starting — it should turn, not peek
    }
  }

  // A cancelled pointer is NOT a successful release: never turn a page or toggle
  // chrome from it — just drop all in-flight gesture state.
  function onPointerCancel(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    endPeek();
    gesture.current = "none";
    navStartX.current = null;
    navStartY.current = null;
    panLast.current = null;
    pinchPrev.current = null;
    setLive(null);
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!pointers.current.delete(e.pointerId)) return; // untracked/duplicate up: ignore
    const g = gesture.current;
    if (g === "pinch") {
      pinchPrev.current = null;
      gesture.current = "none"; // ignore the lone remaining finger until it lifts too
      return;
    }
    if (g === "draw") {
      if (tool !== "eraser") {
        setLive((cur) => {
          if (cur && cur.points.length) onCommit({ ...cur, id: newUlid() });
          return null;
        });
      }
      gesture.current = "none";
      return;
    }
    if (g === "pan") {
      gesture.current = "none";
      panLast.current = null;
      return;
    }
    if (g === "text") {
      gesture.current = "none";
      const s = textStart.current;
      textStart.current = null;
      if (!s) return;
      // Only a near-stationary press counts as a placement tap; a real drag is ignored.
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 10) onTapText(pageNorm(s.x, s.y));
      return;
    }
    if (g === "nav") {
      gesture.current = "none";
      const start = navStartX.current;
      navStartX.current = null;
      navStartY.current = null;
      cancelPeekArm();
      if (peeking.current) {
        // The hold was a peek: releasing returns to the page, never turns it.
        peeking.current = false;
        onPeek?.(false);
        return;
      }
      if (start == null) return;
      const dx = e.clientX - start;
      if (Math.abs(dx) > 60) {
        go(dx < 0 ? 1 : -1);
        return;
      }
      const r = stageRef.current?.getBoundingClientRect();
      if (!r) return;
      const x = e.clientX - r.left;
      if (x < r.width / 3) go(-1);
      else if (x > (2 * r.width) / 3) go(1);
      else toggleChrome();
    }
  }

  const zoomBy = (factor: number) => {
    const v = viewRef.current;
    settle(zoomAbout(v, stageW() / 2, stageH() / 2, v.scale * factor));
  };
  const zoomReset = () => setView(centerView(pageSize.w, pageSize.h, stageW(), stageH()));

  return { view, live, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, zoomBy, zoomReset };
}
