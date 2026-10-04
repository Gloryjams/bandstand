import { api } from "./api";

/**
 * Read-only share links. Create/revoke are DIRECT authenticated calls, never
 * `queueWrite` — an offline-queued revoke would tell the director a link is dead while it
 * is still serving pages, which is worse than refusing to revoke at all. Shares are
 * also not mirrored to Dexie: the list is online-only (see Settings).
 */

export type ShareTargetKind = "piece" | "setlist";
export type ShareState = "active" | "expired" | "revoked";

/** A row from GET /api/shares. `state` is computed server-side: expiry is judged
    against server time, never a device clock. Timestamps are epoch milliseconds. */
export interface ShareRow {
  id: string;
  target_kind: ShareTargetKind;
  target_id: string;
  label: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  state: ShareState;
}

/** POST /api/shares response. `url` is the full public link handed to the guest. */
export interface CreatedShare {
  id: string;
  token: string;
  url: string;
}

export interface ShareDuration {
  label: string;
  /** null = no expiry; the link lives until it is revoked. */
  ttlHours: number | null;
}

/** First entry is the default: a gig link should die on its own, and the longer
    options are opt-in. */
export const SHARE_DURATIONS: readonly ShareDuration[] = [
  { label: "24 hours", ttlHours: 24 },
  { label: "7 days", ttlHours: 168 },
  { label: "30 days", ttlHours: 720 },
  { label: "Until revoked", ttlHours: null },
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Human expiry line for a share row: "Expires in 6 days", "No expiry", "Revoked". */
export function expiryLabel(row: ShareRow, now: number): string {
  if (row.state === "revoked") return "Revoked";
  if (row.expires_at == null) return "No expiry";
  const left = row.expires_at - now;
  if (left <= 0 || row.state === "expired") return "Expired";
  if (left >= DAY) return `Expires in ${plural(Math.round(left / DAY), "day")}`;
  if (left >= HOUR) return `Expires in ${plural(Math.round(left / HOUR), "hour")}`;
  return `Expires in ${plural(Math.max(1, Math.round(left / MINUTE)), "minute")}`;
}

/** The one line the share sheet owes the sharer: a link is a bearer credential, and
    a setlist link keeps tracking the setlist. Only setlist shares are live, so only
    they carry that sentence. */
export function shareNote(kind: ShareTargetKind): string {
  const base = "Anyone with this link can view until it expires or you revoke it.";
  return kind === "setlist" ? `${base} Setlist edits show up live.` : base;
}

export const SHARE_FAILED = "Couldn't make the link. Check the connection and try again.";
export const SHARE_NOT_SET_UP =
  "Share pages are not set up on this server yet. Whoever runs the server can switch them on. " +
  "The self-hosting guide explains how, under Share links.";

/** What to tell the sharer when no link came back. A server without share pages
    answers 503 on purpose: it used to hand out a link nobody could open. Trying
    again will not help there, so it gets its own sentence. */
export function shareErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : "";
  return /->\s*503$/.test(text) ? SHARE_NOT_SET_UP : SHARE_FAILED;
}

export function createShare(
  targetKind: ShareTargetKind,
  targetId: string,
  ttlHours: number | null,
): Promise<CreatedShare> {
  return api.post<CreatedShare>("/api/shares", {
    target_kind: targetKind,
    target_id: targetId,
    ttl_hours: ttlHours,
  });
}

export function listShares(): Promise<ShareRow[]> {
  return api.get<ShareRow[]>("/api/shares");
}

export function revokeShare(id: string): Promise<unknown> {
  return api.post(`/api/shares/${id}/revoke`);
}
