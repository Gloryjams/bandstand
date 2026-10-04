import { useState } from "react";

import type { PublicChart } from "./types";
import { ChartGrid } from "./ChartGrid";
import { transposeKey } from "./theory";
import "./chart.css";

// Font ladder for the on-stage size toggle (scales every chart size via --cs).
const FONT_SCALES = [0.9, 1, 1.18, 1.4] as const;
const FONT_LABELS = ["S", "M", "L", "XL"] as const;

/** Full-screen native chart reader. Renders the roadmap flight-plan + sections, with
 *  a display-only transpose control (fulfils the backlog's "ChordPro transpose" wish),
 *  a Nashville toggle, and a font-size step. All state is display-only — the stored
 *  chart is never rewritten. Keyed by piece id in the Viewer so it resets per tune.
 *  Takes the PublicChart subset so the guest share bundle renders through this same
 *  component with a DTO that carries no library identity. */
export function ChartStage({ chart, controlsVisible = true }: { chart: PublicChart; controlsVisible?: boolean }) {
  const [transpose, setTranspose] = useState(0);
  const [nashville, setNashville] = useState(false);
  const [fontIdx, setFontIdx] = useState(1);

  const clampT = (t: number) => Math.max(-11, Math.min(11, t));
  const soundingKey = chart.key ? transposeKey(chart.key, transpose) : "";
  const scale = FONT_SCALES[fontIdx] ?? 1;

  return (
    <div className="chart-stage">
      {controlsVisible && (
        // Stop taps on the controls from bubbling to the Viewer's chrome-toggle wrapper
        // (which would hide the controls mid-adjust).
        <div className="chart-controls" role="group" aria-label="Chart controls" onClick={(e) => e.stopPropagation()}>

          <div className="cc-transpose">
            <button className="cc-btn" onClick={() => setTranspose((t) => clampT(t - 1))} aria-label="Transpose down">−</button>
            <span className="cc-key">
              {/* Middot for "no key set", matching the empty-bar glyph the grid uses. */}
              {soundingKey || "·"}
              {transpose !== 0 && <span className="cc-steps">{transpose > 0 ? `+${transpose}` : transpose}</span>}
            </span>
            <button className="cc-btn" onClick={() => setTranspose((t) => clampT(t + 1))} aria-label="Transpose up">+</button>
            {transpose !== 0 && (
              <button className="cc-reset" onClick={() => setTranspose(0)} aria-label="Reset transpose">reset</button>
            )}
          </div>
          <button
            className={`cc-toggle${nashville ? " on" : ""}`}
            onClick={() => setNashville((n) => !n)}
            aria-pressed={nashville}
          >
            Nashville
          </button>
          <button
            className="cc-toggle cc-font"
            onClick={() => setFontIdx((i) => (i + 1) % FONT_SCALES.length)}
            aria-label="Cycle font size"
          >
            {FONT_LABELS[fontIdx]}
          </button>
        </div>
      )}
      <div className="chart-scroll" style={{ ["--cs" as string]: scale }}>
        <div className="chart-head">
          <h2 className="chart-title">{chart.title}</h2>
          <div className="chart-sub">
            {[chart.artist, soundingKey && `Key ${soundingKey}`, chart.time, chart.bpm && `${chart.bpm} bpm`, chart.style]
              .filter(Boolean)
              .join("  ·  ")}
          </div>
        </div>
        <ChartGrid chart={chart} transpose={transpose} nashville={nashville} roadmapRail />
      </div>
    </div>
  );
}
