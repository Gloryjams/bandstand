/**
 * What a failed room request means, as one word the guest page can act on.
 * 410: the host closed the room. 404: the server has rooms switched off.
 * 429: this guest posted more songs than the server allows in a minute.
 * 409 on join: the room has as many guests as the server allows.
 */
export type RoomProblem = "closed" | "off" | "slow" | "full" | "request";

export function roomProblem(status: number): RoomProblem {
  if (status === 410) return "closed";
  if (status === 404) return "off";
  if (status === 429) return "slow";
  if (status === 409) return "full";
  return "request";
}

export const SLOW_DOWN_TEXT = "That is a lot of songs at once. Wait a moment, then post again.";
export const ROOM_FULL_TEXT = "This room is full. Ask the host to make space, then try again.";
export const ROOMS_OFF_TITLE = "Rehearsal rooms are switched off";
export const ROOMS_OFF_TEXT = "The person who runs this Bandstand server has switched rooms off.";
