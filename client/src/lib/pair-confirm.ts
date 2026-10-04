// What a sign-in link WOULD do to this device, worked out before anything is written.
// A link opened by accident (a stale QR, a link meant for somebody else) used to sign
// the device straight in: replacing the key for a band the player was already in, or
// adding a stranger's server. The confirm screen shows this plan and waits for a tap.
// Pure: no store, no api, no Dexie, so it is unit-testable and cannot write anything.

import { bandId, normalizeUrl, type BandPairing, type BandsState } from "./meta";

export interface PairLink { url: string; key: string }

export type PairAction =
  | "add"       // a server this device has never signed in to
  | "replace"   // a known server: the link's key replaces the one stored here
  | "same";     // a known server and the very key already stored: nothing changes

export interface PairPlanItem {
  url: string;                 // normalized (no trailing slash)
  key: string;
  action: PairAction;
  existing: BandPairing | null; // the band on this device the link would touch
}

/** Decide add / replace / same for every band a link carries, against what this
 *  device already holds. Duplicate servers inside one link keep the first entry. */
export function planPairLinks(state: BandsState, links: PairLink[]): PairPlanItem[] {
  const out: PairPlanItem[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    const url = normalizeUrl(l.url);
    if (!url || !l.key) continue;
    const id = bandId(url);
    if (seen.has(id)) continue;
    seen.add(id);
    const existing = state.bands.find((b) => b.id === id) ?? null;
    const action: PairAction = !existing ? "add" : existing.key === l.key ? "same" : "replace";
    out.push({ url, key: l.key, action, existing });
  }
  return out;
}

/** The one word on the confirm button. Anything that replaces a sign-in says so. */
export function confirmLabel(plan: PairPlanItem[]): string {
  if (plan.length === 0) return "Continue";
  if (plan.some((p) => p.action === "replace")) return "Replace sign-in";
  if (plan.every((p) => p.action === "same")) return "Open";
  const adds = plan.filter((p) => p.action === "add").length;
  return adds > 1 ? "Add bands" : "Add band";
}
