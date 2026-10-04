import type { PointerEvent as ReactPointerEvent } from "react";

import { strokeToPath, isTextItem, type Item, type Stroke, type TextItem } from "../lib/annot";
import { cropViewBox, type BBoxFrac } from "../lib/autocrop";

/** Pointer handlers for interactive (editable/movable) text labels. Omitted for the
 *  read-only overlay copy, which leaves the labels inert. */
export interface TextHandlers {
  onDown: (t: TextItem, e: ReactPointerEvent) => void;
  onMove: (e: ReactPointerEvent) => void;
  onUp: (e: ReactPointerEvent) => void;
}

/**
 * Render-only SVG overlay sized exactly to the rendered page. Shows committed strokes +
 * text labels plus the in-progress stroke. Stroke/pan/pinch/nav input all lives in the
 * viewer's gesture layer, so the <svg> itself never captures input (pointer-events:none)
 * and scales with the page transform for free. Text labels are the one exception: when
 * `onText` is supplied (annotate mode + text tool) each label opts back into pointer
 * events so it can be tapped-to-edit / dragged-to-move; without it (overlay) they stay
 * inert.
 */
export function AnnotationLayer({
  items,
  live,
  pageW,
  pageH,
  crop = null,
  onText,
}: {
  items: Item[];
  live: Stroke | null;
  pageW: number;
  pageH: number;
  /** Auto-crop reframe: ink stays in full-page normalized coords; the svg keeps
      the cropped CSS size while its viewBox shows only the crop window. */
  crop?: BBoxFrac | null;
  onText?: TextHandlers;
}) {
  // Coordinate space of the FULL page in css px; without a crop it equals the svg size.
  const coordW = crop ? pageW / (crop.x1 - crop.x0) : pageW;
  const coordH = crop ? pageH / (crop.y1 - crop.y0) : pageH;

  const renderStroke = (s: Stroke, key: string, isLive = false) => {
    const isHi = s.tool === "highlighter";
    return (
      <path
        key={key}
        d={strokeToPath(s.points, coordW, coordH)}
        fill="none"
        stroke={s.color}
        strokeWidth={Math.max(1, s.width * coordW)}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={isHi ? 0.38 : isLive ? 0.9 : 1}
        style={isHi ? { mixBlendMode: "multiply" } : undefined}
      />
    );
  };

  const renderText = (t: TextItem) => {
    const fs = t.size * coordH;
    return (
      <text
        key={t.id}
        x={t.x * coordW}
        y={t.y * coordH}
        fontSize={fs}
        fill={t.color}
        stroke="#ffffff"
        strokeWidth={fs * 0.14}
        strokeLinejoin="round"
        dominantBaseline="hanging"
        style={{
          paintOrder: "stroke", // white halo painted behind the fill → readable over dense notation
          fontFamily: "var(--body)",
          fontWeight: 600,
          userSelect: "none",
          pointerEvents: onText ? "auto" : "none",
          cursor: onText ? "move" : undefined,
        }}
        onPointerDown={onText ? (e) => onText.onDown(t, e) : undefined}
        onPointerMove={onText ? onText.onMove : undefined}
        onPointerUp={onText ? onText.onUp : undefined}
      >
        {t.text}
      </text>
    );
  };

  return (
    <svg className="annot-layer" width={pageW} height={pageH}
         viewBox={crop ? cropViewBox(crop, coordW, coordH) : undefined}
         style={{ pointerEvents: "none" }}>
      {items.map((it) => (isTextItem(it) ? renderText(it) : renderStroke(it, it.id)))}
      {live && live.points.length > 0 && renderStroke(live, "live", true)}
    </svg>
  );
}
