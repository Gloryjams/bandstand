import { api, getApiConfig } from "./api";
import { db } from "./db";

export type RoomParticipant = {
  id: string;
  display_name: string;
  instrument: string;
  joined_at: number;
};

export type RoomVolunteer = {
  participant_id: string;
  display_name: string;
  instrument: string;
};

export type RoomProposal = {
  id: string;
  participant_id: string;
  proposed_by: string;
  title: string;
  music_key: string | null;
  sharing_scope: "session" | "save_allowed";
  state: "open" | "queued";
  play_votes: number;
  hear_votes: number;
  volunteers: RoomVolunteer[];
};

export type RoomQueueEntry = {
  id: string;
  proposal_id: string | null;
  title: string;
  music_key: string | null;
  state: "queued" | "current" | "played" | "skipped";
  ordinal: number;
};

export type RoomSnapshot = {
  room: {
    id: string;
    title: string;
    state: "open" | "closed";
    revision: number;
    queue_revision: number;
  };
  participants: RoomParticipant[];
  proposals: RoomProposal[];
  queue: RoomQueueEntry[];
};

/** What the home screen needs to know about rooms on this server. */
export type RoomsStatus =
  | { enabled: true; room: RoomSnapshot | null }
  | { enabled: false };

export const ROOMS_OFF_TEXT = "Rehearsal rooms are switched off on this server.";
export const ROOMS_OFF_HINT =
  "Whoever runs the server can switch them on. The self-hosting guide, under Rehearsal rooms, says how.";

/**
 * Rooms are a server setting (BANDSTAND_ROOMS) and are off on a new install.
 * While off, every rooms route answers 404, which is how the app tells
 * "no room open right now" (200 with null) from "no rooms here at all".
 */
export async function roomsStatus(): Promise<RoomsStatus> {
  const res = await api.raw("/api/rooms/active");
  if (res.status === 404) return { enabled: false };
  if (!res.ok) throw new Error(`GET /api/rooms/active -> ${res.status}`);
  return { enabled: true, room: (await res.json()) as RoomSnapshot | null };
}

export async function activeRoom(): Promise<RoomSnapshot | null> {
  const status = await roomsStatus();
  return status.enabled ? status.room : null;
}

export async function createRoom(title: string): Promise<{ id: string; join_token: string }> {
  const created = await api.post<{ id: string; join_token: string }>("/api/rooms", { title });
  await db.kv.put({ key: `room-token:${created.id}`, value: created.join_token });
  return created;
}

export async function roomToken(roomId: string): Promise<string | null> {
  return ((await db.kv.get(`room-token:${roomId}`))?.value as string | undefined) ?? null;
}

export async function getRoom(roomId: string): Promise<RoomSnapshot> {
  return api.get<RoomSnapshot>(`/api/rooms/${roomId}`);
}

export async function closeRoom(roomId: string): Promise<void> {
  await api.post(`/api/rooms/${roomId}/close`);
  await db.kv.delete(`room-token:${roomId}`);
}

export async function promoteProposal(roomId: string, proposalId: string): Promise<void> {
  await api.post(`/api/rooms/${roomId}/queue`, { proposal_id: proposalId });
}

export async function makeCurrent(roomId: string, entryId: string): Promise<void> {
  await api.post(`/api/rooms/${roomId}/queue/${entryId}/current`);
}

/** Takes a guest's song off every screen: the pool, and the queue if it was promoted. */
export async function removeProposal(roomId: string, proposalId: string): Promise<void> {
  await api.delete(`/api/rooms/${roomId}/proposals/${proposalId}`);
}

/** The sentence a director sees when opening a room fails. */
export function startRoomProblem(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  if (text.endsWith("-> 404")) return ROOMS_OFF_TEXT;
  if (text.endsWith("-> 409")) return "A room is already open. Close it first.";
  return "Could not start the room. Check the connection and try again.";
}

export function roomJoinUrl(roomId: string, token: string): string {
  const config = getApiConfig();
  const base = config?.baseUrl || location.origin;
  return `${base.replace(/\/+$/, "")}/room/${encodeURIComponent(roomId)}#token=${encodeURIComponent(token)}`;
}
