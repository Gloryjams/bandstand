type Tool = "pen" | "highlighter" | "eraser" | "text";

// Clean sans "T" glyph (SVG, house style — no emoji). Uses currentColor so it inherits
// the button's active-state color like the text-label buttons do.
const TEXT_ICON = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 6 H19" />
    <path d="M12 6 V19" />
  </svg>
);

/** Floating palette shown in annotate mode: tool, colors, thickness, undo/redo. */
export function AnnotToolbar({
  tool,
  color,
  thickness,
  colors,
  canUndo,
  canRedo,
  onTool,
  onColor,
  onThickness,
  onUndo,
  onRedo,
}: {
  tool: Tool;
  color: string;
  thickness: number;
  colors: string[];
  canUndo: boolean;
  canRedo: boolean;
  onTool: (t: Tool) => void;
  onColor: (c: string) => void;
  onThickness: (n: number) => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div className="annot-bar">
      <div className="annot-tools">
        <button className={tool === "pen" ? "on" : ""} onClick={() => onTool("pen")}>Pen</button>
        <button className={tool === "highlighter" ? "on" : ""} onClick={() => onTool("highlighter")}>Hi-lite</button>
        <button className={tool === "text" ? "on" : ""} onClick={() => onTool("text")} aria-label="Text">{TEXT_ICON}</button>
        <button className={tool === "eraser" ? "on" : ""} onClick={() => onTool("eraser")}>Erase</button>
      </div>
      <div className="annot-colors">
        {colors.map((c) => (
          <button
            key={c}
            className={`swatch${color === c && tool !== "eraser" ? " on" : ""}`}
            style={{ background: c }}
            onClick={() => onColor(c)}
            aria-label={`Color ${c}`}
          />
        ))}
      </div>
      <input
        className="annot-thick"
        type="range"
        min={1}
        max={10}
        value={thickness}
        onChange={(e) => onThickness(Number(e.target.value))}
        aria-label="Thickness"
      />
      <div className="annot-history">
        <button onClick={onUndo} disabled={!canUndo} aria-label="Undo">↶</button>
        <button onClick={onRedo} disabled={!canRedo} aria-label="Redo">↷</button>
      </div>
    </div>
  );
}
