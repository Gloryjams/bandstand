/** Floating zoom buttons. Pinch works too; these give a tap target and a quick reset. */
export function ZoomControls({
  scale,
  onIn,
  onOut,
  onReset,
}: {
  scale: number;
  onIn: () => void;
  onOut: () => void;
  onReset: () => void;
}) {
  return (
    <div className="zoom-controls">
      <button onClick={onIn} aria-label="Zoom in">+</button>
      <button className="zoom-level" onClick={onReset} aria-label="Reset zoom">
        {Math.round(scale * 100)}%
      </button>
      <button onClick={onOut} aria-label="Zoom out">−</button>
    </div>
  );
}
