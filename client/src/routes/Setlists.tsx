import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { db, type Setlist } from "../lib/db";
import { canAuthor } from "../lib/identity";
import { useUi } from "../lib/store";
import { queueWrite } from "../lib/sync-queue";
import { newUlid } from "../lib/ulid";
import { DATA_CHANGED_EVENT } from "../lib/live";
import { EmptyState } from "../components/EmptyState";
import { ShareSheet, type ShareTarget } from "../components/ShareSheet";

export function Setlists() {
  const [lists, setLists] = useState<Setlist[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [loaded, setLoaded] = useState(false);
  const author = canAuthor(useUi((s) => s.identity));
  const nav = useNavigate();

  async function load() {
    const ls = await db.setlists.orderBy("updated_at").reverse().toArray();
    const items = await db.setlist_items.toArray();
    const c: Record<string, number> = {};
    for (const it of items) {
      if (it.kind === "piece") c[it.setlist_id] = (c[it.setlist_id] ?? 0) + 1;
    }
    setLists(ls);
    setCounts(c);
    setLoaded(true);
  }
  useEffect(() => { load(); }, []);

  // Another device added/edited a setlist — reload the list live.
  useEffect(() => {
    const onChange = () => { load(); };
    window.addEventListener(DATA_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(DATA_CHANGED_EVENT, onChange);
  }, []);

  async function create() {
    const id = newUlid();
    const sl: Setlist = {
      id, name: "New setlist", date: null, venue: null, notes: null,
      created_at: Date.now(), updated_at: Date.now(),
    };
    await db.setlists.put(sl);
    await queueWrite("upsert", "setlists", sl);
    nav(`/setlists/${id}`);
  }

  async function remove(id: string) {
    await db.setlist_items.where("setlist_id").equals(id).delete();
    await db.setlists.delete(id);
    await queueWrite("delete", "setlists", { id }); // server cascades setlist_items
    setConfirmId(null);
    load();
  }

  return (
    <div className="setlists">
      <div className="app-top">
        <h1 className="screen-title">Setlists</h1>
        {author && <button className="ghost-btn" onClick={create}>+ New</button>}
      </div>

      {!loaded ? null : lists.length === 0 ? (
        <EmptyState
          title="No setlists yet"
          hint={author
            ? <>Build a set for the next gig. Tap <strong>+ New</strong> to start one.</>
            : <>Sets show up here as soon as your bandleader builds one.</>}
        />
      ) : (
        <ul className="setlist-list">
          {lists.map((s) => (
            <li key={s.id} className="setlist-row">
              <Link to={`/setlists/${s.id}`} className="setlist-link">
                <span className="sl-name">{s.name}</span>
                <span className="sl-meta">
                  <span className="sl-count">{counts[s.id] ?? 0} {(counts[s.id] ?? 0) === 1 ? "tune" : "tunes"}</span>
                  {s.venue && <span>· {s.venue}</span>}
                  {s.date && <span>· {s.date}</span>}
                </span>
              </Link>
              {!author ? null : confirmId === s.id ? (
                <span className="row-confirm">
                  <span className="row-confirm-q">Delete?</span>
                  <button className="danger" onClick={() => remove(s.id)}>Yes</button>
                  <button onClick={() => setConfirmId(null)}>Cancel</button>
                </span>
              ) : (
                <>
                  <button
                    className="row-share"
                    aria-label={`Share setlist ${s.name}`}
                    onClick={() => setShareTarget({ kind: "setlist", id: s.id, label: s.name })}
                  >
                    Share
                  </button>
                  <button
                    className="row-del"
                    aria-label={`Delete setlist ${s.name}`}
                    onClick={() => setConfirmId(s.id)}
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {shareTarget && <ShareSheet target={shareTarget} onClose={() => setShareTarget(null)} />}
    </div>
  );
}
