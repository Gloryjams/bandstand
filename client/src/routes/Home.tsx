import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { chartEditorUrl, showChartEditorLink } from "../lib/chart-editor";
import { BandSheet } from "../components/BandSheet";
import { db } from "../lib/db";
import { DATA_CHANGED_EVENT } from "../lib/live";
import {
  ROOMS_OFF_HINT, ROOMS_OFF_TEXT, createRoom, roomsStatus, startRoomProblem,
  type RoomSnapshot,
} from "../lib/rooms";
import { useUi } from "../lib/store";

export function Home() {
  const bands = useUi((s) => s.bands);
  const activeBandId = useUi((s) => s.activeBandId);
  const identity = useUi((s) => s.identity);
  const chartEditor = useUi((s) => s.chartEditor);
  const band = bands.find((b) => b.id === activeBandId);
  const [counts, setCounts] = useState({ pieces: 0, sets: 0 });
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  // Rooms are a server setting, off on a new install. Until the server has
  // answered, the card stays neutral rather than offering a button that fails.
  const [roomsOn, setRoomsOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [showBands, setShowBands] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    let alive = true;
    const recount = () => {
      void Promise.all([db.pieces.toArray(), db.setlists.count()])
        .then(([pieces, sets]) => {
          if (alive) setCounts({ pieces: pieces.filter((piece) => !piece.deleted_at).length, sets });
        });
    };
    recount();
    window.addEventListener(DATA_CHANGED_EVENT, recount);
    return () => { alive = false; window.removeEventListener(DATA_CHANGED_EVENT, recount); };
  }, [activeBandId]);

  useEffect(() => {
    void roomsStatus()
      .then((status) => {
        setRoomsOn(status.enabled);
        setRoom(status.enabled ? status.room : null);
      })
      .catch(() => { setRoom(null); setRoomsOn(true); });
  }, [activeBandId]);

  async function startRoom() {
    setBusy(true);
    setProblem("");
    try {
      const created = await createRoom(`${band?.label ?? "Band"} rehearsal`);
      nav(`/room-host/${created.id}`);
    } catch (error) {
      setProblem(startRoomProblem(error));
    } finally {
      setBusy(false);
    }
  }

  const roomHeading = roomsOn === false
    ? ROOMS_OFF_TEXT
    : room ? room.room.title : "Start the room when everyone arrives";
  const roomText = roomsOn === false
    ? ROOMS_OFF_HINT
    : room
      ? `${room.participants.length} joined · ${room.proposals.length} songs proposed`
      : "Queue tunes, take votes, and see who can cover each part.";

  return (
    <main className="workspace-home">
      <section className="workspace-hero">
        <p className="eyebrow">Your workspace</p>
        <h1>{band?.label ?? "Bandstand"}</h1>
        <p className="workspace-role">
          {identity ? `Signed in as ${identity.name}` : "Checking sign-in..."}
        </p>
      </section>

      <section className="workspace-stats" aria-label="Workspace summary">
        <Link to="/repertoire"><strong>{counts.pieces}</strong><span>tunes</span></Link>
        <Link to="/setlists"><strong>{counts.sets}</strong><span>sets</span></Link>
        <button onClick={() => setShowBands(true)}><strong>{bands.length}</strong><span>workspaces</span></button>
      </section>
      {showBands && <BandSheet onClose={() => setShowBands(false)} />}

      <section className="workspace-next">
        <div>
          <p className="eyebrow">Rehearsal room</p>
          <h2>{roomHeading}</h2>
          <p>{roomText}</p>
          {problem && <p role="alert" className="room-error">{problem}</p>}
        </div>
        {roomsOn === false ? null : room ? (
          <Link className="primary-btn" to={`/room-host/${room.room.id}`}>Open room</Link>
        ) : roomsOn && identity?.role === "director" ? (
          <button className="primary-btn" onClick={startRoom} disabled={busy}>
            {busy ? "Starting…" : "Start rehearsal"}
          </button>
        ) : null}
      </section>

      <section className="workspace-actions">
        <Link to="/repertoire"><span>Repertoire</span><small>Charts, PDFs, audio, and parts</small></Link>
        <Link to="/setlists"><span>Sets</span><small>Build and perform an ordered set</small></Link>
        <Link to="/gigs"><span>Gigs</span><small>Dates, venues, and readiness</small></Link>
        <Link to="/people"><span>People</span><small>Members, instruments, and access</small></Link>
        {identity?.role === "director" && (showChartEditorLink(chartEditor) ? (
          <a href={chartEditorUrl()}><span>New chart</span><small>Open the Bandstand chart editor</small></a>
        ) : (
          <div className="workspace-action-off" aria-disabled="true">
            <span>New chart</span><small>The chart editor is not installed on this server</small>
          </div>
        ))}
        <Link to="/settings"><span>Settings</span><small>Appearance, connection, and storage</small></Link>
      </section>
    </main>
  );
}
