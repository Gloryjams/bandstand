import { api } from "./api";
import { drainQueue } from "./sync-queue";
import { db, type Piece, type FileRow, type AudioTrack,
         type Annotation, type Bookmark, type SectionLink, type Setlist,
         type SetlistItem } from "./db";

interface Manifest {
  pieces: Piece[];
  files: FileRow[];
  audio_tracks: AudioTrack[];
  annotations: Annotation[];
  bookmarks: Bookmark[];
  section_links: SectionLink[];
  setlists: Setlist[];
  setlist_items: SetlistItem[];
  server_time_ms: number;
}

export async function fetchManifestAndMirror(): Promise<void> {
  // Flush local writes BEFORE pulling the manifest, so the clear-and-rebuild below can
  // never wipe an un-synced change. If any writes remain queued (offline), bail and keep
  // local state — better a slightly stale mirror than a lost annotation.
  await drainQueue();
  if ((await db.sync_queue.count()) > 0) return;
  const m = await api.get<Manifest>("/api/manifest");
  await db.transaction(
    "rw",
    [db.pieces, db.files, db.audio_tracks, db.annotations, db.bookmarks,
     db.section_links, db.setlists, db.setlist_items],
    async () => {
      await db.pieces.clear();
      await db.pieces.bulkPut(m.pieces);
      await db.files.clear();
      await db.files.bulkPut(m.files);
      await db.audio_tracks.clear();
      await db.audio_tracks.bulkPut(m.audio_tracks);
      await db.annotations.clear();
      await db.annotations.bulkPut(m.annotations ?? []);
      await db.bookmarks.clear();
      await db.bookmarks.bulkPut(m.bookmarks);
      await db.section_links.clear();
      await db.section_links.bulkPut(m.section_links);
      await db.setlists.clear();
      await db.setlists.bulkPut(m.setlists);
      await db.setlist_items.clear();
      await db.setlist_items.bulkPut(m.setlist_items);
    },
  );
}
