// Library browse view: sort + filters (roadmap #3, chosen over books/collections).
// Pure logic — the Library route persists the choice and renders the controls.

export type LibrarySort = "recent" | "title" | "played";

export interface LibView {
  sort: LibrarySort;
  tag: string | null;
  audioOnly: boolean;
}

export const DEFAULT_VIEW: LibView = { sort: "recent", tag: null, audioOnly: false };

const SORTS: readonly LibrarySort[] = ["recent", "title", "played"];
const LS_KEY = "bandstand.libview.v1";

/** Per-field validation: stored junk (old release, manual edit) degrades to
    defaults instead of smuggling in a truthy-string audioOnly or numeric tag. */
export function loadView(): LibView {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Record<string, unknown>;
      return {
        sort: SORTS.includes(v.sort as LibrarySort) ? (v.sort as LibrarySort) : DEFAULT_VIEW.sort,
        tag: typeof v.tag === "string" && v.tag.trim() ? v.tag : null,
        audioOnly: v.audioOnly === true,
      };
    }
  } catch { /* corrupt or private mode: fall through */ }
  return { ...DEFAULT_VIEW };
}

export function saveView(v: LibView): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch { /* private mode */ }
}

/** The one safe decoder for Piece.tags (a JSON-encoded string[] in SQLite).
    Tolerates non-string input, junk JSON, non-arrays, and non-string entries;
    trims and dedupes so " funk " and "funk" are one tag, once per piece. */
export function decodeTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(
    parsed
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter(Boolean),
  )];
}

interface TaggedPiece { tags: string; }

/** Union of all tags across the library, most-used first, then alphabetical. */
export function collectTags(pieces: TaggedPiece[]): string[] {
  const freq = new Map<string, number>();
  for (const p of pieces) {
    for (const t of decodeTags(p.tags)) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

interface ViewablePiece extends TaggedPiece {
  id: string;
  title: string;
  added_at: number;
  last_opened_at: number | null;
  play_count: number;
}

/** Filter then order the browse grid. Search ranking is a separate concern:
    when a query is active the caller filters here, then ranks with rankResults. */
export function applyLibraryView<T extends ViewablePiece>(
  pieces: T[],
  hasAudio: Set<string>,
  view: LibView,
): T[] {
  let out = pieces;
  if (view.tag) out = out.filter((p) => decodeTags(p.tags).includes(view.tag!));
  if (view.audioOnly) out = out.filter((p) => hasAudio.has(p.id));
  const sorted = [...out];
  switch (view.sort) {
    case "title":
      sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
      break;
    case "played":
      sorted.sort((a, b) => b.play_count - a.play_count || a.title.localeCompare(b.title));
      break;
    case "recent":
    default:
      sorted.sort((a, b) => (b.last_opened_at ?? b.added_at) - (a.last_opened_at ?? a.added_at));
      break;
  }
  return sorted;
}
