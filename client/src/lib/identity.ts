// Who is this device paired as? A member's key IS their account: /api/whoami maps
// the stored key to {id, name, role}. Role gates AUTHOR AFFORDANCES ONLY — the server
// 403s member writes regardless, this just keeps the UI honest about what will work.

import { api } from "./api";
import { db } from "./db";

export type Role = "director" | "member";
export type Identity = { id: string; name: string; role: Role };

// Pre-members servers have no /api/whoami; a 404 there means the old single-user
// world where the one key IS the director. Same fallback when offline with no cache.
export const DIRECTOR_FALLBACK: Identity = { id: "root", name: "Director", role: "director" };

export function canAuthor(identity: Identity | null): boolean {
  // Unknown-yet (still resolving) errs on showing author UI: the flash is harmless
  // for a member because every write is server-gated, and hiding-then-revealing
  // would flicker for the director on every cold start.
  return identity === null || identity.role !== "member";
}

export class KeyRejectedError extends Error {
  constructor() {
    super("That key was not accepted by this server. Check it and try again.");
  }
}

/** Check the current key without using an offline identity cache. */
export async function checkIdentity(): Promise<Identity> {
  const res = await api.raw("/api/whoami");
  if (res.status === 401 || res.status === 403) throw new KeyRejectedError();
  if (res.status === 404) return DIRECTOR_FALLBACK;
  if (!res.ok) throw new Error("Could not check this key with the server. Try again.");
  return (await res.json()) as Identity;
}

export async function refreshIdentity(): Promise<Identity | null> {
  try {
    const ident = await checkIdentity();
    await db.kv.put({ key: "identity", value: ident });
    return ident;
  } catch (error) {
    if (error instanceof KeyRejectedError) {
      await db.kv.delete("identity");
      return null;
    }
    // Offline. Prefer what this device last knew.
    const cached = (await db.kv.get("identity"))?.value as Identity | undefined;
    return cached ?? DIRECTOR_FALLBACK;
  }
}
