import { useState } from "react";

import type { Bookmark, SectionLink } from "../lib/db";

/**
 * Bottom sheet to manage a piece's bookmarks (jump targets) and section links
 * (D.S. al Coda / repeat jumps). Set these up at home before the gig; on stage
 * they drive automatic navigation as you turn pages.
 */
export function MarksSheet({
  fromPageLabel,
  bookmarks,
  links,
  pageNumberFor,
  onAddBookmark,
  onJumpBookmark,
  onDeleteBookmark,
  onAddLink,
  onToggleLink,
  onDeleteLink,
  onClose,
}: {
  fromPageLabel: number; // global page number of the current page (the link source)
  bookmarks: Bookmark[];
  links: SectionLink[];
  pageNumberFor: (fileId: string, pageIndex: number) => number;
  onAddBookmark: (label: string) => void;
  onJumpBookmark: (b: Bookmark) => void;
  onDeleteBookmark: (id: string) => void;
  onAddLink: (toBookmarkId: string, triggers: number) => void;
  onToggleLink: (l: SectionLink) => void;
  onDeleteLink: (id: string) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [triggers, setTriggers] = useState("1");
  const bmLabel = (id: string) => bookmarks.find((b) => b.id === id)?.label ?? "(deleted)";

  function addBookmark() {
    const l = label.trim();
    if (!l) return;
    onAddBookmark(l);
    setLabel("");
  }

  function addLink() {
    if (!target) return;
    onAddLink(target, triggers === "inf" ? -1 : Number(triggers));
    setTarget("");
    setTriggers("1");
  }

  return (
    <div className="marks-overlay" onClick={onClose}>
      <div className="marks-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="marks-head">
          <span>Marks</span>
          <button className="marks-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <section className="marks-sec">
          <h4>Bookmarks</h4>
          <ul className="marks-list">
            {bookmarks.length === 0 && <li className="marks-empty">No bookmarks yet.</li>}
            {bookmarks.map((b) => (
              <li key={b.id}>
                <button className="marks-jump" onClick={() => onJumpBookmark(b)}>
                  <span className="marks-pg">p.{pageNumberFor(b.file_id, b.page_index)}</span>
                  <span className="marks-label">{b.label}</span>
                </button>
                <button className="marks-del" onClick={() => onDeleteBookmark(b.id)} aria-label="Delete bookmark">×</button>
              </li>
            ))}
          </ul>
          <div className="marks-add">
            <input
              className="marks-input"
              placeholder={`Label this page (p.${fromPageLabel})`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addBookmark()}
            />
            <button onClick={addBookmark}>Add</button>
          </div>
        </section>

        <section className="marks-sec">
          <h4>Section links</h4>
          <ul className="marks-list">
            {links.length === 0 && <li className="marks-empty">No links yet.</li>}
            {links.map((l) => (
              <li key={l.id}>
                <span className={`marks-link${l.active ? "" : " off"}`}>
                  p.{pageNumberFor(l.from_file_id, l.from_page_index)} → {bmLabel(l.to_bookmark_id)}
                  {" · "}
                  {l.initial_triggers < 0 ? "∞" : `×${l.initial_triggers}`}
                </span>
                <button className="marks-toggle" onClick={() => onToggleLink(l)}>
                  {l.active ? "on" : "off"}
                </button>
                <button className="marks-del" onClick={() => onDeleteLink(l.id)} aria-label="Delete link">×</button>
              </li>
            ))}
          </ul>
          <div className="marks-add">
            <span className="marks-from">from p.{fromPageLabel} →</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">choose bookmark…</option>
              {bookmarks.map((b) => (
                <option key={b.id} value={b.id}>{b.label}</option>
              ))}
            </select>
            <select value={triggers} onChange={(e) => setTriggers(e.target.value)} aria-label="Times">
              <option value="1">×1</option>
              <option value="2">×2</option>
              <option value="3">×3</option>
              <option value="inf">∞</option>
            </select>
            <button onClick={addLink} disabled={!target}>Add</button>
          </div>
        </section>
      </div>
    </div>
  );
}
