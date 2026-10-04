// Pan/zoom transform for the viewer page. The page-wrap is positioned at the stage
// origin and transformed by `translate(tx,ty) scale(scale)` with transform-origin 0 0.
// All coordinates here are STAGE-LOCAL (client coords minus the stage's top-left), so
// a content point at local L renders at screen = t + scale*L.

export interface View {
  scale: number;
  tx: number;
  ty: number;
}

// Floor at 1.0: scale 1 is already fit-to-screen, so zooming out past it only
// shrinks the chart into empty margins and hurts legibility — never wanted for reading.
const MIN = 1;
const MAX = 4;

export function clampScale(s: number): number {
  return s < MIN ? MIN : s > MAX ? MAX : s;
}

/** A scale-1 view that centers the page within the stage. */
export function centerView(pageW: number, pageH: number, stageW: number, stageH: number): View {
  return { scale: 1, tx: (stageW - pageW) / 2, ty: (stageH - pageH) / 2 };
}

/** Zoom toward a focal point (stage-local), keeping that point fixed on screen. */
export function zoomAbout(view: View, focalX: number, focalY: number, targetScale: number): View {
  const s2 = clampScale(targetScale);
  const r = s2 / view.scale;
  return {
    scale: s2,
    tx: focalX - r * (focalX - view.tx),
    ty: focalY - r * (focalY - view.ty),
  };
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
function mid(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Update the view from a two-finger move: scale by the change in finger distance about
 * the previous midpoint, then pan by the midpoint's travel. Coordinates are stage-local.
 */
export function twoFinger(
  view: View,
  a0: [number, number],
  b0: [number, number],
  a1: [number, number],
  b1: [number, number],
): View {
  const d0 = dist(a0, b0) || 1;
  const d1 = dist(a1, b1);
  const s2 = clampScale(view.scale * (d1 / d0));
  const r = s2 / view.scale;
  const m0 = mid(a0, b0);
  const m1 = mid(a1, b1);
  // zoom about m0...
  const zx = m0[0] - r * (m0[0] - view.tx);
  const zy = m0[1] - r * (m0[1] - view.ty);
  // ...then pan by the midpoint's travel.
  return { scale: s2, tx: zx + (m1[0] - m0[0]), ty: zy + (m1[1] - m0[1]) };
}

function clampAxis(t: number, scaled: number, container: number): number {
  if (scaled <= container) return (container - scaled) / 2; // center when it fits
  const min = container - scaled; // most-negative (page bottom/right flush)
  return t < min ? min : t > 0 ? 0 : t;
}

/** Keep the (possibly zoomed) page from being panned out of the viewport. */
export function clampView(
  view: View,
  pageW: number,
  pageH: number,
  stageW: number,
  stageH: number,
): View {
  return {
    scale: view.scale,
    tx: clampAxis(view.tx, pageW * view.scale, stageW),
    ty: clampAxis(view.ty, pageH * view.scale, stageH),
  };
}
