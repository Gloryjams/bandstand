// Band orchestration: sign in / switch / sign out. meta.ts owns the persisted
// registry (pure); this module wires a change through the live app — swap the
// active Dexie DB, repoint the API, update the store (which retriggers the SSE
// and whoami effects in App.tsx), and let mounted views reload.

import Dexie from "dexie";

import { api, configureApi, getApiConfig } from "./api";
import { setActiveDb, LEGACY_DB_NAME } from "./db";
import { requestPersistentStorage, shouldShowHomeScreenHint } from "./device-storage";
import { checkIdentity } from "./identity";
import { forgetLinkedChartEditor } from "./chart-editor";
import { DATA_CHANGED_EVENT } from "./live";
import {
  loadBandsState, migrateLegacyPairing, removeBand, saveBandsState, upsertBand,
  type BandPairing, type BandsState,
} from "./meta";
import { hydrateRecents } from "./recents";
import { useUi } from "./store";
import { fetchManifestAndMirror } from "./sync";

function publish(state: BandsState): void {
  const s = useUi.getState();
  s.setBands(state.bands, state.activeId);
}

function activate(band: BandPairing): void {
  setActiveDb(band.dbName);
  configureApi({ baseUrl: band.url, key: band.key });
  // setPairing drives the App effects: SSE live-push reconnect + whoami refresh.
  useUi.getState().setPairing({ url: band.url, key: band.key });
}

/** Boot: migrate the pre-switcher pairing if needed, then activate the active band.
 *  Returns the active band, or null (never signed in → sign-in screen). */
export async function bootBands(): Promise<BandPairing | null> {
  await migrateLegacyPairing();
  const state = await loadBandsState();
  publish(state);
  const band = state.bands.find((b) => b.id === state.activeId) ?? null;
  if (band) activate(band);
  else useUi.getState().setPairing(null);
  if (state.bands.length > 0) {
    void requestPersistentStorage();
    // A browser tab on an iPhone loses its data after a week unused: keep saying so.
    useUi.getState().setHomeScreenHint(shouldShowHomeScreenHint());
  }
  return band;
}

/** Sign in to a server (new band, or key rotation for a known one) and activate it. */
export async function signIn(url: string, key: string): Promise<BandPairing> {
  // Probe health for the band's display name, then verify the key with whoami.
  // The API is pointed at the link's server for the probe; if anything fails before
  // the band is saved, point it back where it was, so a failed sign-in (a dead link,
  // a 503) never leaves a signed-in device talking to the wrong server with the wrong key.
  const before = getApiConfig();
  configureApi({ baseUrl: url.replace(/\/+$/, ""), key });
  try {
    const health = await api.get<{ ok: boolean; name?: string }>("/api/health");
    if (!health.ok) throw new Error("Health check failed");
    const identity = await checkIdentity();
    const state = await loadBandsState();
    const { state: next, band } = upsertBand(state, url, key, health.name);
    await saveBandsState(next);
    publish(next);
    activate(band);
    void requestPersistentStorage();
    useUi.getState().setHomeScreenHint(shouldShowHomeScreenHint());
    useUi.getState().setIdentity(identity);
    // Home can mount as soon as activate publishes pairing. Notify it once the
    // mirror is ready, just as when switching bands or receiving live updates.
    try {
      await fetchManifestAndMirror();
      window.dispatchEvent(new Event(DATA_CHANGED_EVENT));
    } catch { /* offline after sign-in: keep the active band and its local mirror */ }
    return band;
  } catch (e) {
    if (before) configureApi(before);
    throw e;
  }
}

/** Switch the app to another signed-in band. */
export async function switchBand(id: string): Promise<void> {
  const state = await loadBandsState();
  const band = state.bands.find((b) => b.id === id);
  if (!band) return;
  const next = { ...state, activeId: id };
  await saveBandsState(next);
  publish(next);
  activate(band);
  void hydrateRecents(); // quick-find recency is per band
  // Freshen the new band's mirror opportunistically; views hear the event.
  try {
    await fetchManifestAndMirror();
    window.dispatchEvent(new Event(DATA_CHANGED_EVENT));
  } catch { /* offline — the band renders from its local mirror */ }
  // Refresh the label from the server when reachable (names can change).
  try {
    const health = await api.get<{ name?: string }>("/api/health");
    if (health.name && health.name !== band.label) {
      const cur = await loadBandsState();
      await saveBandsState({
        ...cur,
        bands: cur.bands.map((b) => (b.id === id ? { ...b, label: health.name! } : b)),
      });
      publish(await loadBandsState());
    }
  } catch { /* offline */ }
}

/** Sign out of one band: forget the pairing AND delete its local mirror. */
export async function signOut(id: string): Promise<void> {
  const state = await loadBandsState();
  const band = state.bands.find((b) => b.id === id);
  const next = removeBand(state, id);
  await saveBandsState(next);
  publish(next);
  forgetLinkedChartEditor(id);
  const remaining = next.bands.find((b) => b.id === next.activeId) ?? null;
  if (band && remaining) {
    // Point the active handle at the surviving band FIRST (this closes the departing
    // band's handle if it was active), then its local data can be dropped safely.
    setActiveDb(remaining.dbName);
    if (band.dbName !== remaining.dbName) {
      await Dexie.delete(band.dbName).catch(() => undefined);
    }
    activate(remaining);
    try {
      await fetchManifestAndMirror();
      window.dispatchEvent(new Event(DATA_CHANGED_EVENT));
    } catch { /* offline */ }
  } else if (band) {
    // Last band: delete via the OPEN instance (instance.delete() closes itself first;
    // the static Dexie.delete would block on our own open connection). The handle
    // auto-reopens as a fresh empty DB if the sign-in flow touches it again.
    const inst = setActiveDb(band.dbName);
    await inst.delete().catch(() => undefined);
    setActiveDb(LEGACY_DB_NAME);
    useUi.getState().setPairing(null);
    useUi.getState().setIdentity(null);
  }
}
