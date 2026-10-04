import { useEffect, useRef, useState, type ReactNode } from "react";

import { Bonito } from "./Bonito";
import { loadOutfit } from "../lib/bonito";

export interface BonesAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
}

const POS_KEY = "bandstand-bones-pos";
const FAB = 56; // launcher diameter
const MARGIN = 16;
const DRAG_THRESHOLD = 5;

type Pos = { x: number; y: number };

function clamp(p: Pos): Pos {
  const w = typeof window === "undefined" ? 1024 : window.innerWidth;
  const h = typeof window === "undefined" ? 768 : window.innerHeight;
  return {
    x: Math.max(MARGIN, Math.min(w - FAB - MARGIN, p.x)),
    y: Math.max(MARGIN, Math.min(h - FAB - MARGIN, p.y)),
  };
}

function loadPos(): Pos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Pos;
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) return clamp(p);
    }
  } catch { /* ignore */ }
  const w = typeof window === "undefined" ? 1024 : window.innerWidth;
  const h = typeof window === "undefined" ? 768 : window.innerHeight;
  return { x: w - FAB - MARGIN, y: h - FAB - MARGIN - 70 }; // default: lower-right, above nav
}

/**
 * Bones as a moveable action hub (chat-head style, à la ConductorBonito).
 * Drag him anywhere to keep him off the chart; tap to pop his baton up and
 * fan out the actions. A real drag never counts as a tap.
 */
export function BonesLauncher({ actions, mood = "ready" }: { actions: BonesAction[]; mood?: "ready" | "asleep" }) {
  const [pos, setPos] = useState<Pos>(loadPos);
  const [open, setOpen] = useState(false);
  const drag = useRef<{ id: number; sx: number; sy: number; bx: number; by: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);

  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, bx: pos.x, by: pos.y, moved: false };
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      d.moved = true;
      setOpen(false); // dragging dismisses the menu
    }
    if (d.moved) setPos(clamp({ x: d.bx + dx, y: d.by + dy }));
  }
  function onPointerUp(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    drag.current = null;
    if (d.moved) {
      justDragged.current = true;
      setPos((p) => { try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* ignore */ } return p; });
    }
  }
  function onClick() {
    if (justDragged.current) { justDragged.current = false; return; }
    setOpen((o) => !o);
  }

  // Open the action stack toward the side with more room.
  const openUp = pos.y > (typeof window === "undefined" ? 768 : window.innerHeight) / 2;

  return (
    <>
      {open && <div className="bones-scrim" onPointerDown={() => setOpen(false)} />}
      <div className="bones-launcher" style={{ left: pos.x, top: pos.y }}>
        <div className={`bones-menu ${openUp ? "up" : "down"} ${open ? "open" : ""}`}>
          {actions.map((a, i) => (
            <button
              key={a.key}
              className={`bones-action ${a.active ? "on" : ""}`}
              style={{ transitionDelay: open ? `${i * 30}ms` : "0ms" }}
              onClick={() => { setOpen(false); a.onClick(); }}
              tabIndex={open ? 0 : -1}
              aria-hidden={!open}
            >
              <span className="ba-icon">{a.icon}</span>
              <span className="ba-label">{a.label}</span>
            </button>
          ))}
        </div>
        <button
          className={`bones-fab ${open ? "open" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={onClick}
          aria-label="Bones: tap for actions, drag to move"
          aria-expanded={open}
        >
          <Bonito
            outfit={loadOutfit()}
            expression={open ? "happy" : mood === "asleep" ? "sleepy" : "curious"}
            size={64}
            className="bones-fab-art"
          />
        </button>
      </div>
    </>
  );
}

// Small inline action icons (stroke = currentColor).
export const ActionIcons = {
  draw: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20l4-1 10-10-3-3L5 16l-1 4z" /><path d="M14 6l3 3" />
    </svg>
  ),
  marks: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4h12v16l-6-4-6 4z" />
    </svg>
  ),
  find: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" />
    </svg>
  ),
};
