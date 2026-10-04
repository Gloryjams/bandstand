// Device-level band registry: which servers this device is signed in to, and which is
// active. Lives in its own tiny Dexie DB ("bandstand-meta") so it survives any band's
// mirror rebuild. Each band's actual data lives in a per-band DB (see db.ts) named by
// the pairing's dbName. Pure functions here (no store/api imports) — orchestration is
// in bands.ts; keeping meta dependency-free keeps it unit-testable.

import Dexie, { type Table } from "dexie";

import { LEGACY_DB_NAME, BandstandDB } from "./db";

export interface BandPairing {
  id: string;      // stable hash of the normalized server url
  url: string;     // normalized (no trailing slash)
  key: string;     // this device's sign-in key for that band
  label: string;   // display name (refreshed from /api/health `name` when online)
  dbName: string;  // per-band Dexie database name
}

interface MetaKV { key: string; value: unknown }

class MetaDB extends Dexie {
  kv!: Table<MetaKV, string>;
  constructor() {
    super("bandstand-meta");
    this.version(1).stores({ kv: "key" });
  }
}

const meta = new MetaDB();

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Stable id for a server url (FNV-1a 32-bit, hex). Drives the per-band DB name. */
export function bandId(url: string): string {
  const s = normalizeUrl(url).toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface BandsState {
  bands: BandPairing[];
  activeId: string | null;
}

export async function loadBandsState(): Promise<BandsState> {
  const bands = ((await meta.kv.get("bands"))?.value as BandPairing[] | undefined) ?? [];
  const activeId = ((await meta.kv.get("active_band"))?.value as string | undefined) ?? null;
  return { bands, activeId };
}

export async function saveBandsState(state: BandsState): Promise<void> {
  await meta.kv.put({ key: "bands", value: state.bands });
  await meta.kv.put({ key: "active_band", value: state.activeId });
}

/**
 * Pure add-or-replace: a new url appends a band; a known url replaces its key (that's
 * re-sign-in / rotation). Either way the band becomes active. Returns the new state
 * plus the affected band.
 */
export function upsertBand(
  state: BandsState, url: string, key: string, label?: string,
): { state: BandsState; band: BandPairing; added: boolean } {
  const norm = normalizeUrl(url);
  const id = bandId(norm);
  const existing = state.bands.find((b) => b.id === id);
  if (existing) {
    const band: BandPairing = { ...existing, key, label: label ?? existing.label };
    return {
      state: { bands: state.bands.map((b) => (b.id === id ? band : b)), activeId: id },
      band,
      added: false,
    };
  }
  const band: BandPairing = {
    id, url: norm, key,
    label: label ?? "Bandstand",
    dbName: state.bands.length === 0 ? LEGACY_DB_NAME : `bandstand-${id}`,
  };
  return { state: { bands: [...state.bands, band], activeId: id }, band, added: true };
}

/** Pure remove (sign out of one band). The next remaining band becomes active. */
export function removeBand(state: BandsState, id: string): BandsState {
  const bands = state.bands.filter((b) => b.id !== id);
  const activeId = state.activeId === id ? (bands[0]?.id ?? null) : state.activeId;
  return { bands, activeId };
}

/**
 * One-time migration from the pre-switcher world: the single pairing lived as
 * server_url/server_key kv rows inside the legacy band DB. Wrap it as the first
 * band (KEEPING the legacy DB name, so mirror + offline queue survive untouched)
 * and clear the old rows. No-op when meta already has bands or no legacy pairing.
 */
export async function migrateLegacyPairing(): Promise<void> {
  const { bands } = await loadBandsState();
  if (bands.length > 0) return;
  const legacy = new BandstandDB(LEGACY_DB_NAME);
  try {
    const url = (await legacy.kv.get("server_url"))?.value as string | undefined;
    const key = (await legacy.kv.get("server_key"))?.value as string | undefined;
    if (!url || !key) return;
    const { state } = upsertBand({ bands: [], activeId: null }, url, key);
    await saveBandsState(state);
    await legacy.kv.delete("server_url");
    await legacy.kv.delete("server_key");
  } finally {
    legacy.close();
  }
}
