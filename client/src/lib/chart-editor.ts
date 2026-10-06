// Is the optional chart editor (SaltyCharts) built into the paired server? The app
// links to /charts/ from Home and the Library; on an install without the editor
// that link lands on a "not installed" page. /api/health says `chart_editor`
// true or false, so the link can be hidden (Library) or shown switched off with
// a one-line note (Home) instead.

import { api, getApiConfig } from "./api";
import { db } from "./db";

// true: installed. false: not on this server. null: not known yet.
export type ChartEditorState = boolean | null;

const KV_KEY = "chart_editor";

/** Signing out of a band also forgets the editor sign-in inherited from it.
 * Explicitly connected editors and other bands' data remain the user's work. */
export function forgetLinkedChartEditor(bandId: string): void {
  try {
    const config = JSON.parse(localStorage.getItem("saltycharts.bandstand.v1") ?? "null");
    if (config?.readerBandId === bandId) {
      localStorage.setItem("saltycharts.bandstand.v1", JSON.stringify({ url: "", key: "" }));
    }
  } catch { /* no editor sign-in on this browser */ }
}

/** Same-origin address of the editor on the active server. */
export function chartEditorUrl(): string {
  return `${getApiConfig()?.baseUrl ?? ""}/charts/`;
}

/** Should the link render at all? Unknown errs toward showing it: a cold start
 *  resolves async and hiding-then-revealing would flicker for every director on
 *  every launch, and a server too old to say (no `chart_editor` field) is one of
 *  the existing installs, which all carry the editor. */
export function showChartEditorLink(state: ChartEditorState): boolean {
  return state !== false;
}

export async function refreshChartEditor(): Promise<ChartEditorState> {
  try {
    const health = await api.get<{ chart_editor?: unknown }>("/api/health");
    const state: ChartEditorState =
      typeof health.chart_editor === "boolean" ? health.chart_editor : null;
    await db.kv.put({ key: KV_KEY, value: state });
    return state;
  } catch {
    // Offline: prefer what this device last learned about the server.
    const cached = (await db.kv.get(KV_KEY))?.value;
    return typeof cached === "boolean" ? cached : null;
  }
}
