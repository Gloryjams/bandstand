import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import QRCode from "qrcode";

import {
  closeRoom, getRoom, makeCurrent, promoteProposal, removeProposal, roomJoinUrl, roomToken,
  type RoomSnapshot,
} from "../lib/rooms";

export function RoomHost() {
  const { id = "" } = useParams();
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    try { setSnapshot(await getRoom(id)); setError(""); }
    catch { setError("Could not refresh the room."); }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    void roomToken(id).then(async (token) => {
      if (token) setQr(await QRCode.toDataURL(roomJoinUrl(id, token), { width: 280, margin: 1 }));
    });
    return () => window.clearInterval(timer);
  }, [id]);

  // The director's way to deal with a song that should not be on the wall: it
  // leaves the pool and the queue on every phone at once.
  async function remove(proposalId: string) {
    try { await removeProposal(id, proposalId); await refresh(); }
    catch { setError("Could not remove that song. Try again."); }
  }

  if (!snapshot) return <main className="room-host"><p>{error || "Opening rehearsal…"}</p></main>;
  const current = snapshot.queue.find((entry) => entry.state === "current");
  const queued = snapshot.queue.filter((entry) => entry.state === "queued");
  const openProposals = snapshot.proposals.filter((proposal) => proposal.state === "open");

  return (
    <main className="room-host">
      <header className="room-heading">
        <div><p className="eyebrow">Live rehearsal</p><h1>{snapshot.room.title}</h1></div>
        <Link to="/">Workspace home</Link>
      </header>
      {error && <p role="status" className="room-error">{error}</p>}

      <section className="room-now">
        <p className="eyebrow">Current tune</p>
        <h2>{current?.title ?? "Nothing called yet"}</h2>
        {current?.music_key && <span className="room-key">{current.music_key}</span>}
      </section>

      <div className="room-columns">
        <section>
          <h2>On deck</h2>
          {queued.length ? queued.map((entry, index) => (
            <div className="room-row" key={entry.id}>
              <span className="room-order">{index + 1}</span>
              <div><strong>{entry.title}</strong><small>{entry.music_key || "Key not set"}</small></div>
              <button onClick={async () => { await makeCurrent(id, entry.id); await refresh(); }}>Call it</button>
              {entry.proposal_id && (
                <button className="room-remove" aria-label={`Remove ${entry.title}`} onClick={() => { if (entry.proposal_id) void remove(entry.proposal_id); }}>Remove</button>
              )}
            </div>
          )) : <p className="workspace-empty">Promote a song from the pool.</p>}
        </section>

        <section>
          <h2>Song pool</h2>
          {openProposals.length ? openProposals.map((proposal) => (
            <article className="proposal-card" key={proposal.id}>
              <div><strong>{proposal.title}</strong>{proposal.music_key && <span className="room-key">{proposal.music_key}</span>}</div>
              <small>Proposed by {proposal.proposed_by}</small>
              <p>{proposal.play_votes} want to play · {proposal.hear_votes} want to hear</p>
              <div className="coverage">{proposal.volunteers.map((v) => <span key={`${v.participant_id}:${v.instrument}`}>{v.instrument}: {v.display_name}</span>)}</div>
              <div className="song-actions">
                <button onClick={async () => { await promoteProposal(id, proposal.id); await refresh(); }}>Add to queue</button>
                <button className="room-remove" aria-label={`Remove ${proposal.title}`} onClick={() => remove(proposal.id)}>Remove</button>
              </div>
            </article>
          )) : <p className="workspace-empty">Guest suggestions will appear here.</p>}
        </section>

        <aside className="room-join">
          <h2>Join this room</h2>
          {qr ? <img src={qr} alt="QR code to join this rehearsal room" /> : <p>QR unavailable on this device.</p>}
          <p>{snapshot.participants.length} joined</p>
          <div className="participant-chips">{snapshot.participants.map((p) => <span key={p.id}>{p.display_name} · {p.instrument}</span>)}</div>
        </aside>
      </div>

      <button className="ghost-btn room-close" onClick={async () => { await closeRoom(id); location.assign("/app/"); }}>Close rehearsal</button>
    </main>
  );
}
