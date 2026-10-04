import { useBattery } from "../hooks/useBattery";
import { useClock } from "../hooks/useClock";

export function ViewerToolbar({
  title,
  pageN,
  pageTotal,
  setlistPos,
  setlistTotal,
  onBack,
  onOpenSetlist,
}: {
  title: string;
  pageN: number;
  pageTotal: number;
  setlistPos: number | null;
  setlistTotal: number | null;
  onBack: () => void;
  onOpenSetlist?: () => void;
}) {
  const clock = useClock();
  const { level, charging } = useBattery();
  const pct = level != null ? Math.round(level * 100) : null;
  const battClass = pct == null ? "" : pct <= 10 ? "batt-red" : pct <= 20 ? "batt-yellow" : "";

  return (
    <div className="viewer-bar">
      <button className="vb-back" onClick={onBack} aria-label="Back">
        ←
      </button>
      <span className="vb-title">{title}</span>
      <span className="vb-page">
        {pageTotal > 0 && `${pageN} / ${pageTotal}`}
        {setlistPos != null && (
          <>
            {pageTotal > 0 ? " · " : ""}
            {onOpenSetlist ? (
              <button className="vb-set vb-set-btn" onClick={onOpenSetlist} aria-label="Open set list">
                Set {setlistPos + 1}
                {setlistTotal ? `/${setlistTotal}` : ""} ⌄
              </button>
            ) : (
              <span className="vb-set">
                Set {setlistPos + 1}
                {setlistTotal ? `/${setlistTotal}` : ""}
              </span>
            )}
          </>
        )}
      </span>
      {pct != null && (
        <span className={`vb-batt ${battClass}`}>
          {charging ? "⚡ " : ""}
          {pct}%
        </span>
      )}
      <span className="vb-clock">{clock}</span>
    </div>
  );
}
