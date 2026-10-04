import { useEffect, useState } from "react";

import { ChartStage } from "../chart/ChartStage";
import type { PublicChart } from "../chart/types";
import { GuestBoundary } from "./GuestBoundary";
import { asPublicChart } from "./public-chart";

type State =
  | { phase: "loading" }
  | { phase: "ready"; chart: PublicChart }
  | { phase: "gone" };

export interface GuestChartProps {
  chartUrl: string;
  /** Footer wording, supplied by the public app so nothing personal is compiled in. */
  attribution?: string;
  /** Landing page of the setlist this chart was reached through, when there is one. */
  setlistUrl?: string;
}

/**
 * The whole guest app: fetch one chart, draw it read-only. No auth header — the share
 * token in the URL path is the entire credential, and the guest has nothing to
 * authenticate with. Every failure (revoked, expired, unknown token, bad payload)
 * lands in the same quiet state, mirroring the server's one-404-for-everything rule.
 */
export function GuestChart({ chartUrl, attribution = "", setlistUrl = "" }: GuestChartProps) {
  // A shell with no data-chart-url is already a dead end, so it starts in that state
  // rather than flashing a loading frame first.
  const [state, setState] = useState<State>(() =>
    chartUrl ? { phase: "loading" } : { phase: "gone" },
  );

  useEffect(() => {
    let alive = true;
    if (!chartUrl) return;
    (async () => {
      try {
        const res = await fetch(chartUrl, { credentials: "omit" });
        if (!res.ok) throw new Error(String(res.status));
        const chart = asPublicChart(await res.json());
        if (!chart) throw new Error("unreadable");
        if (alive) setState({ phase: "ready", chart });
      } catch {
        if (alive) setState({ phase: "gone" });
      }
    })();
    return () => { alive = false; };
  }, [chartUrl]);

  const gone = (
    <div className="guest-gone">
      <p>This link is no longer available.</p>
    </div>
  );

  if (state.phase === "loading") return <div className="guest-loading" aria-label="Loading chart" />;
  if (state.phase === "gone") return gone;

  return (
    <GuestBoundary fallback={gone}>
      <div className="guest-stage">
        <ChartStage chart={state.chart} />
        <GuestBar attribution={attribution} setlistUrl={setlistUrl} />
      </div>
    </GuestBoundary>
  );
}

/** Bottom bar mirroring the PDF pager's: the attribution, and a way back to the set
    listing when this chart was opened through a setlist share. */
function GuestBar({ attribution, setlistUrl }: { attribution: string; setlistUrl: string }) {
  if (!attribution && !setlistUrl) return null;
  return (
    <div className="guest-bar">
      <span className="guest-credit">{attribution}</span>
      {setlistUrl && <a className="guest-back" href={setlistUrl}>Set</a>}
    </div>
  );
}
