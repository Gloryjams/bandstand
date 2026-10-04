import Dexie, { type Table } from "dexie";

export interface Piece {
  id: string;
  title: string;
  composer: string | null;
  music_key: string | null;
  time_sig: string | null;
  tempo: number | null;
  genre: string | null;
  tags: string;
  notes: string | null;
  page_count: number;
  added_at: number;
  updated_at: number;
  last_opened_at: number | null;
  play_count: number;
  preferred_orientation: "portrait" | "landscape" | null;
  default_half_page_turns: number;
  deleted_at: number | null;
  // Native chord charts: kind 'chart' pieces carry their whole content as opaque
  // Saltycharts JSON in chart_json (no files row). Default 'pdf' for every other piece.
  // These are not indexed, so no Dexie schema bump is needed — the mirror bulkPuts them.
  kind?: "pdf" | "chart";
  chart_json?: string | null;
  chart_source_id?: string | null;
  chart_file?: string | null;
}

export interface FileRow {
  id: string;
  piece_id: string;
  kind: "pdf" | "image" | "chordpro";
  filename: string;
  page_count: number;
  ordinal: number;
  content_hash: string;
  bytes: number;
  added_at: number;
  deleted_at: number | null;
}

export interface AudioTrack {
  id: string;
  piece_id: string;
  filename: string;
  label: string | null;
  duration_ms: number | null;
  content_hash: string;
  bytes: number;
  added_at: number;
  ordinal: number;
  deleted_at: number | null;
}

export interface Annotation {
  piece_id: string;
  file_id: string;
  page_index: number;
  svg_paths: string;
  updated_at: number;
}

export interface Bookmark {
  id: string;
  piece_id: string;
  file_id: string;
  page_index: number;
  label: string;
  ordinal: number;
}

export interface SectionLink {
  id: string;
  piece_id: string;
  from_file_id: string;
  from_page_index: number;
  to_bookmark_id: string;
  initial_triggers: number;
  active: number;
}

export interface Setlist {
  id: string;
  name: string;
  date: string | null;
  venue: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface SetlistItem {
  id: string;
  setlist_id: string;
  kind: "piece" | "break";
  piece_id: string | null;
  break_label: string | null;
  ordinal: number;
}

export interface SyncOp {
  id?: number;
  op: "upsert" | "delete" | "replace";
  entity: string;
  payload: unknown;
  created_at: number;
}

export interface AppState {
  id: "current";
  piece_id: string | null;
  file_id: string | null;
  page_index: number;
  mode: "reading" | "annotate";
  zoom: number;
  setlist_id: string | null;
  setlist_position: number | null;
  updated_at: number;
}

export interface KV {
  key: string;
  value: unknown;
}

// One database PER BAND. The pre-switcher app used the single name "bandstand";
// the migrated first band keeps that name so its mirror and offline queue survive.
export const LEGACY_DB_NAME = "bandstand";

export class BandstandDB extends Dexie {
  pieces!: Table<Piece, string>;
  files!: Table<FileRow, string>;
  audio_tracks!: Table<AudioTrack, string>;
  annotations!: Table<Annotation, [string, string, number]>;
  bookmarks!: Table<Bookmark, string>;
  section_links!: Table<SectionLink, string>;
  setlists!: Table<Setlist, string>;
  setlist_items!: Table<SetlistItem, string>;
  sync_queue!: Table<SyncOp, number>;
  app_state!: Table<AppState, "current">;
  kv!: Table<KV, string>;

  constructor(name: string = LEGACY_DB_NAME) {
    super(name);
    this.version(1).stores({
      pieces: "id, title, composer, last_opened_at, deleted_at, *tags",
      files: "id, piece_id, content_hash, deleted_at",
      audio_tracks: "id, piece_id, content_hash, deleted_at",
      annotations: "[piece_id+file_id+page_index], piece_id",
      bookmarks: "id, piece_id",
      section_links: "id, [piece_id+from_file_id+from_page_index]",
      setlists: "id, updated_at",
      setlist_items: "id, [setlist_id+ordinal], setlist_id, piece_id",
      sync_queue: "++id, created_at",
      app_state: "id",
      kv: "key",
    });
  }
}

// The ACTIVE band's database, behind a stable `db` reference so every existing
// `db.pieces...` call site keeps working. Switching bands swaps the target;
// the proxy resolves per property access, and function props are bound so
// `db.transaction(...)` and friends keep their `this`.
let active = new BandstandDB();

export function setActiveDb(name: string): BandstandDB {
  if (name === active.name) return active;
  const prev = active;
  active = new BandstandDB(name);
  prev.close();
  return active;
}

export function activeDbName(): string {
  return active.name;
}

export const db = new Proxy({} as BandstandDB, {
  get(_t, prop) {
    const v = (active as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(active) : v;
  },
});
