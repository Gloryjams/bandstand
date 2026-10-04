// Band members, as the bandleader sees them on the People page. A member's key IS
// their account: the server hands the plaintext key back exactly once, when the
// link is minted, and stores only its hash. So the sign-in link is built here, on
// the device that minted it, and shown once. There is no "show it again" call.

import { api } from "./api";
import { buildPairLink } from "./pair-link";

export type MemberRow = {
  id: string;
  name: string;
  role: "director" | "member";
  created_at: number;
  revoked_at: number | null;
};

/** What the server returns when it mints a member's key. `key` never comes back again. */
export type MintedInvite = { id: string; name: string; role: "member"; key: string };

export const NAME_MAX = 100;

/** Same rule the server applies (422 otherwise): non-empty, at most 100 characters,
    no control characters. Checked here too so the button is honest before a round trip. */
export function cleanMemberName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.length > NAME_MAX) return null;
  for (const ch of raw) if (ch.charCodeAt(0) < 32) return null;
  return name;
}

export async function listMembers(): Promise<MemberRow[]> {
  const res = await api.get<{ members: MemberRow[] }>("/api/member-invites");
  return res.members;
}

export function inviteMember(name: string): Promise<MintedInvite> {
  return api.post<MintedInvite>("/api/member-invites", { name });
}

/** Switch the old key off and mint a fresh one for the same person (lost phone). */
export function replaceInvite(memberId: string): Promise<MintedInvite> {
  return api.post<MintedInvite>(`/api/member-invites/${memberId}/replace`);
}

/** The link a player taps to join: the server address plus their key, in the URL
    fragment so it never reaches a server log. Same shape as the device-pairing QR. */
export function buildSignInLink(serverUrl: string, key: string): string {
  return buildPairLink(serverUrl, key);
}

export const INVITE_TAKEN =
  "Someone in the band already has that name. Use a different name, or make a new link for them from the list below.";
export const INVITE_FAILED = "Could not make the link. Check the server is running and try again.";

export function inviteErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : "";
  if (/->\s*409$/.test(text)) return INVITE_TAKEN;
  if (/->\s*422$/.test(text)) return "Enter a name.";
  return INVITE_FAILED;
}
