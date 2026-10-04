import { fetchManifestAndMirror } from "./sync";
import { CLIENT_ID } from "./client-id";

// Live push. The server streams events over SSE: piece_changed / piece_deleted as
// charts are added/removed on disk, and data_changed when ANOTHER device edits data
// (setlists, annotations, …) via /api/sync. EventSource can't set the X-Bandstand-Key
// header, so the key used to ride in the address, where every proxy and access log
// could record it. Now we first ask the server for a stream ticket (a normal POST
// with the header) and open the stream with that. A ticket lives about a minute and
// opens one stream, so a reconnect always asks for a fresh one: the browser's own
// retry would reuse the spent address and be refused. We pass our client id so the
// server doesn't echo our own writes back to us. On any change we mirror the
// manifest once and fire a window event; views reload from Dexie.

export const DATA_CHANGED_EVENT = "bandstand:data-changed";

/** How long the browser waits before asking for a new ticket, by failed attempt. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

let es: EventSource | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let reconnect: ReturnType<typeof setTimeout> | null = null;
// Bumped by every start/stop, so a ticket request that finishes after a stop (or
// after the pairing changed) does not open a stream for the wrong session.
let generation = 0;

function scheduleMirror(): void {
  // A multi-file drop emits several events in quick succession; coalesce them
  // into a single mirror so we don't clear-and-rebuild Dexie repeatedly.
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(async () => {
    debounce = null;
    try {
      await fetchManifestAndMirror();
      window.dispatchEvent(new Event(DATA_CHANGED_EVENT));
    } catch {
      /* offline, or a queued write is blocking the mirror: manual Sync still works */
    }
  }, 500);
}

/** Ask the server for a one-minute, single-use ticket that opens the stream.
 *  Returns null on a server from before tickets (404), so the caller can fall back. */
export async function fetchStreamTicket(base: string, key: string): Promise<string | null> {
  const res = await fetch(`${base}/api/events/ticket`, {
    method: "POST",
    headers: { "X-Bandstand-Key": key },
  });
  if (res.status === 404 || res.status === 405) return null;
  if (!res.ok) throw new Error(`POST /api/events/ticket -> ${res.status}`);
  const body = (await res.json()) as { ticket?: unknown };
  if (typeof body.ticket !== "string" || !body.ticket) throw new Error("No ticket in reply");
  return body.ticket;
}

/** The address that opens the stream: with a ticket, or, for an old server, the key. */
export function streamUrl(base: string, key: string, ticket: string | null): string {
  const credential = ticket === null
    ? `key=${encodeURIComponent(key)}`
    : `ticket=${encodeURIComponent(ticket)}`;
  return `${base}/api/events?${credential}&client=${encodeURIComponent(CLIENT_ID)}`;
}

function scheduleReconnect(base: string, key: string, gen: number, attempt: number): void {
  if (reconnect) clearTimeout(reconnect);
  const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
  reconnect = setTimeout(() => {
    reconnect = null;
    void connect(base, key, gen, attempt);
  }, delay);
}

async function connect(base: string, key: string, gen: number, attempt: number): Promise<void> {
  let ticket: string | null;
  try {
    ticket = await fetchStreamTicket(base, key);
  } catch {
    // Offline, or the server is restarting. Try again later; manual Sync still works.
    if (gen === generation) scheduleReconnect(base, key, gen, attempt + 1);
    return;
  }
  if (gen !== generation) return; // stopped, or re-paired, while we waited
  const stream = new EventSource(streamUrl(base, key, ticket));
  es = stream;
  let opened = false;
  stream.onopen = () => { opened = true; };
  stream.addEventListener("piece_changed", scheduleMirror);
  stream.addEventListener("piece_deleted", scheduleMirror);
  stream.addEventListener("data_changed", scheduleMirror);
  stream.onerror = () => {
    // Whatever went wrong (a dropped connection, a refused address), the browser
    // would retry with the same, now spent, ticket. Close and start over with a
    // fresh one. A connection that had opened resets the backoff.
    stream.close();
    if (es === stream) es = null;
    if (gen !== generation) return;
    scheduleReconnect(base, key, gen, opened ? 0 : attempt + 1);
  };
}

/** Open the authenticated SSE stream and mirror whenever the server's data changes. */
export function startLivePush(baseUrl: string, key: string): void {
  stopLivePush();
  if (typeof EventSource === "undefined") return; // unsupported (ancient webview)
  const base = baseUrl.replace(/\/+$/, "");
  void connect(base, key, generation, 0);
}

/** Close the stream and cancel any pending mirror or reconnect. */
export function stopLivePush(): void {
  generation += 1;
  if (debounce) { clearTimeout(debounce); debounce = null; }
  if (reconnect) { clearTimeout(reconnect); reconnect = null; }
  if (es) { es.close(); es = null; }
}
