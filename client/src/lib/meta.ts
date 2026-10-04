// Device-level band registry: which servers this device is signed in to, and which is
// active. Lives in its own tiny Dexie DB ("bandstand-meta") so it survives any band's
// mirror rebuild. Each band's actual data lives in a per-band DB (see db.ts) named by
// the pairing's dbName. Pure functions here (no store/api imports) — orchestration is
// in bands.ts; keeping meta dependency-free keeps it unit-testable.

import Dexie, { type Table } from "dexie";

import { LEGACY_DB_NAME, BandstandDB } from "./db";
import { newUlid } from "./ulid";

export interface BandPairing {
  id: string;      // local record id: fresh ULID, or a preserved legacy FNV id
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
  const trimmed = url.trim();
  try {
    // URL canonicalizes the host, scheme and default port, preserving path case.
    const canonical = new URL(trimmed).href;
    const suffixAt = canonical.search(/[?#]/);
    const base = suffixAt < 0 ? canonical : canonical.slice(0, suffixAt);
    const suffix = suffixAt < 0 ? "" : canonical.slice(suffixAt);
    return base.replace(/\/+$/, "") + suffix;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/** Historical FNV id, only for migrating a pre-switcher pairing. Never an identity. */
export function legacyBandId(url: string): string {
  const s = url.trim().replace(/\/+$/, "").toLowerCase();
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

function freshBandStorage(bands: BandPairing[]): Pick<BandPairing, "id" | "dbName"> {
  let id: string;
  let dbName: string;
  do {
    // getRandomValues works on plain HTTP too; no subtle or randomUUID required.
    id = newUlid();
    dbName = `bandstand-${id}`;
  } while (bands.some((b) => b.id === id || b.dbName === dbName));
  return { id, dbName };
}

/** Registry order is insertion order. Preserve old storage, except later duplicate
 *  ids get a fresh, empty mirror. Never copy credentials or mirror data across URLs. */
function migrateBandsState(state: BandsState): BandsState {
  const seenIds = new Set<string>();
  const bands: BandPairing[] = [];
  let changed = false;
  for (const stored of state.bands) {
    const url = normalizeUrl(stored.url);
    const storage = seenIds.has(stored.id) ? freshBandStorage([...state.bands, ...bands]) : null;
    const band = storage || url !== stored.url ? { ...stored, ...storage, url } : stored;
    seenIds.add(band.id);
    bands.push(band);
    if (band !== stored) changed = true;
  }
  // An ambiguous active id still selects the first entry, just as before migration.
  return changed ? { ...state, bands } : state;
}

export async function loadBandsState(): Promise<BandsState> {
  return meta.transaction("rw", meta.kv, async () => {
    const bands = ((await meta.kv.get("bands"))?.value as BandPairing[] | undefined) ?? [];
    const activeId = ((await meta.kv.get("active_band"))?.value as string | undefined) ?? null;
    const stored = { bands, activeId };
    const state = migrateBandsState(stored);
    if (state !== stored) await saveBandsState(state);
    return state;
  });
}

export async function saveBandsState(state: BandsState): Promise<void> {
  await meta.kv.bulkPut([
    { key: "bands", value: state.bands },
    { key: "active_band", value: state.activeId },
  ]);
}

/**
 * Pure add-or-replace: a new url appends a band; a known url replaces its key (that's
 * re-sign-in / rotation). Either way the band becomes active. Returns the new state
 * plus the affected band.
 */
export function upsertBand(
  state: BandsState, url: string, key: string, label?: string,
): { state: BandsState; band: BandPairing; added: boolean } {
  state = migrateBandsState(state);
  const norm = normalizeUrl(url);
  const existingIndex = state.bands.findIndex((b) => b.url === norm);
  const existing = state.bands[existingIndex];
  if (existing) {
    const band: BandPairing = { ...existing, key, label: label ?? existing.label };
    return {
      state: { bands: state.bands.map((b, i) => (i === existingIndex ? band : b)), activeId: band.id },
      band,
      added: false,
    };
  }
  const band: BandPairing = {
    ...freshBandStorage(state.bands), url: norm, key,
    label: label ?? "Bandstand",
  };
  return { state: { bands: [...state.bands, band], activeId: band.id }, band, added: true };
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
    const band: BandPairing = {
      id: legacyBandId(url), url: normalizeUrl(url), key, label: "Bandstand", dbName: LEGACY_DB_NAME,
    };
    await saveBandsState({ bands: [band], activeId: band.id });
    await legacy.kv.delete("server_url");
    await legacy.kv.delete("server_key");
  } finally {
    legacy.close();
  }
}
