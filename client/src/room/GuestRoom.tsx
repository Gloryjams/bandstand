import { useEffect, useMemo, useState } from "react";

import { ROOM_FULL_TEXT, ROOMS_OFF_TEXT, ROOMS_OFF_TITLE, SLOW_DOWN_TEXT, roomProblem } from "./problems";

type Snapshot = {
  room: { id: string; title: string; revision: number };
  participants: Array<{ id: string; display_name: string; instrument: string }>;
  proposals: Array<{
    id: string; title: string; music_key: string | null; proposed_by: string;
    play_votes: number; hear_votes: number;
    volunteers: Array<{ participant_id: string; display_name: string; instrument: string }>;
  }>;
  queue: Array<{ id: string; title: string; music_key: string | null; state: string; ordinal: number }>;
};

const roomId = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() ?? "");
const tokenKey = `bandstand-room:${roomId}`;

function consumeRoomToken(): string {
  const params = new URLSearchParams(location.hash.slice(1));
  const incoming = params.get("token");
  if (incoming) {
    sessionStorage.setItem(tokenKey, incoming);
    history.replaceState(null, "", location.pathname + location.search);
    return incoming;
  }
  return sessionStorage.getItem(tokenKey) ?? "";
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

const roomToken = consumeRoomToken();
const participantKey = `${tokenKey}:participant`;
const storedParticipant = JSON.parse(localStorage.getItem(participantKey) || "null") as
  { id: string; token: string; displayName: string; instrument: string } | null;

async function roomFetch(path = "", init: RequestInit = {}, participant = storedParticipant) {
  const response = await fetch(`/room-api/${encodeURIComponent(roomId)}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      "Content-Type": "application/json",
      "X-Bandstand-Room": roomToken,
      ...(participant ? { "X-Bandstand-Participant": participant.token } : {}),
    },
  });
  if (!response.ok) throw new Error(roomProblem(response.status));
  return response.json();
}

export function GuestRoom() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [participant, setParticipant] = useState(storedParticipant);
  const [name, setName] = useState("");
  const [instrument, setInstrument] = useState("");
  const [song, setSong] = useState("");
  const [songKey, setSongKey] = useState("");
  const [phase, setPhase] = useState<"loading" | "ready" | "reconnecting" | "closed" | "off">("loading");
  const [notice, setNotice] = useState("");

  async function refresh() {
    try { setSnapshot(await roomFetch()); setPhase("ready"); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "request";
      setPhase(reason === "closed" ? "closed" : reason === "off" ? "off" : "reconnecting");
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, []);

  const current = snapshot?.queue.find((entry) => entry.state === "current");
  const queued = useMemo(
    () => snapshot?.queue.filter((entry) => entry.state === "queued").sort((a, b) => a.ordinal - b.ordinal) ?? [],
    [snapshot],
  );

  async function join(event: React.FormEvent) {
    event.preventDefault();
    const next = { id: crypto.randomUUID(), token: randomSecret(), displayName: name.trim(), instrument: instrument.trim() };
    setNotice("");
    try {
      await roomFetch("/join", {
        method: "POST",
        body: JSON.stringify({ participant_id: next.id, participant_token: next.token, display_name: next.displayName, instrument: next.instrument }),
      }, null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "request";
      if (reason === "full") { setNotice(ROOM_FULL_TEXT); return; }
      if (reason === "closed" || reason === "off") { await refresh(); return; }
      setNotice("Could not join the room. Try again.");
      return;
    }
    localStorage.setItem(participantKey, JSON.stringify(next));
    setParticipant(next);
    await refresh();
  }

  async function propose(event: React.FormEvent) {
    event.preventDefault();
    if (!participant) return;
    setNotice("");
    try {
      await roomFetch("/proposals", { method: "POST", body: JSON.stringify({ title: song, music_key: songKey, sharing_scope: "session" }) }, participant);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "request";
      if (reason === "slow") { setNotice(SLOW_DOWN_TEXT); return; }
      if (reason === "closed" || reason === "off") { await refresh(); return; }
      setNotice("Could not post that song. Try again.");
      return;
    }
    setSong(""); setSongKey(""); await refresh();
  }

  async function act(path: string) {
    if (!participant) return;
    // A song the host just removed answers 404 here; the next refresh clears it.
    try { await roomFetch(path, { method: "PUT" }, participant); }
    catch { /* the refresh below shows the room as it is now */ }
    await refresh();
  }

  if (!roomToken) return <main className="guest-room-state"><h1>Room link incomplete</h1><p>Scan the room QR again.</p></main>;
  if (phase === "closed") return <main className="guest-room-state"><h1>This rehearsal has ended</h1><p>The host closed the room.</p></main>;
  if (phase === "off") return <main className="guest-room-state"><h1>{ROOMS_OFF_TITLE}</h1><p>{ROOMS_OFF_TEXT}</p></main>;
  if (!snapshot) return <main className="guest-room-state"><h1>Opening the room</h1><p>{phase === "reconnecting" ? "Trying the connection again…" : "Loading…"}</p></main>;

  return (
    <main className="guest-room">
      <header><p className="eyebrow">Bandstand rehearsal</p><h1>{snapshot.room.title}</h1>{phase === "reconnecting" && <span className="status">Reconnecting</span>}</header>
      <section className="now"><p className="eyebrow">Current tune</p><h2>{current?.title ?? "Waiting for the host"}</h2>{current?.music_key && <span className="key">{current.music_key}</span>}</section>
      {queued[0] && <p className="up-next">Up next: <strong>{queued[0].title}</strong></p>}

      {!participant ? (
        <form className="join-card" onSubmit={join}><h2>Join the room</h2><input required maxLength={60} placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} /><input required maxLength={60} placeholder="Instrument" value={instrument} onChange={(e) => setInstrument(e.target.value)} /><button>Join rehearsal</button>{notice && <p role="alert" className="notice">{notice}</p>}</form>
      ) : (
        <p className="joined">Joined as <strong>{participant.displayName}</strong> · {participant.instrument}</p>
      )}

      {participant && <form className="proposal-form" onSubmit={propose}><h2>Post a song</h2><div><input required placeholder="Song title" value={song} onChange={(e) => setSong(e.target.value)} /><input className="key-input" placeholder="Key" value={songKey} onChange={(e) => setSongKey(e.target.value)} /><button>Post</button></div><small>Shared with this rehearsal only.</small>{notice && <p role="alert" className="notice">{notice}</p>}</form>}

      <section className="song-pool"><h2>Song pool</h2>{snapshot.proposals.map((proposal) => (
        <article key={proposal.id}><div className="song-title"><strong>{proposal.title}</strong>{proposal.music_key && <span className="key">{proposal.music_key}</span>}</div><small>Proposed by {proposal.proposed_by}</small><p>{proposal.play_votes} want to play · {proposal.hear_votes} want to hear</p><div className="volunteers">{proposal.volunteers.map((person) => <span key={`${person.participant_id}:${person.instrument}`}>{person.instrument}: {person.display_name}</span>)}</div>{participant && <div className="song-actions"><button onClick={() => act(`/proposals/${proposal.id}/votes/play`)}>I want to play</button><button onClick={() => act(`/proposals/${proposal.id}/votes/hear`)}>I want to hear</button><button onClick={() => act(`/proposals/${proposal.id}/volunteers/${encodeURIComponent(participant.instrument)}`)}>Cover {participant.instrument}</button></div>}</article>
      ))}</section>

      <section className="people"><h2>In the room</h2><div>{snapshot.participants.map((person) => <span key={person.id}>{person.display_name} · {person.instrument}</span>)}</div></section>
    </main>
  );
}
