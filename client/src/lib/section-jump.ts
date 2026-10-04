// Section links drive a chart's navigation gymnastics (D.S. al Coda, repeats):
// "from this page, jump to a bookmark, N times." A per-session in-memory counter
// tracks how many fires each link has left; -1 means unlimited (always fires).
// Counters reset every time the piece is reopened, so a D.S. works again next play.

export interface LinkLike {
  id: string;
  from_file_id: string;
  from_page_index: number;
  to_bookmark_id: string;
  initial_triggers: number; // -1 = unlimited
  active: number; // 1 = active, 0 = disabled
}

export interface BookmarkTarget {
  id: string;
  file_id: string;
  page_index: number;
}

export type JumpDecision =
  | { jump: true; linkId: string; toFileId: string; toPageIndex: number; remaining: number }
  | { jump: false };

/**
 * Decide whether a forward page-turn from (fromFileId, fromPageIndex) should jump
 * to a bookmarked section instead. `counters` holds each link's remaining fires for
 * this play-through; a link absent from the map still has its `initial_triggers`.
 */
export function sectionJump(
  links: LinkLike[],
  bookmarks: BookmarkTarget[],
  counters: Map<string, number>,
  fromFileId: string,
  fromPageIndex: number,
): JumpDecision {
  const link = links.find(
    (l) => l.active === 1 && l.from_file_id === fromFileId && l.from_page_index === fromPageIndex,
  );
  if (!link) return { jump: false };

  const remaining = counters.has(link.id) ? (counters.get(link.id) as number) : link.initial_triggers;
  if (remaining === 0) return { jump: false }; // exhausted this session

  const target = bookmarks.find((b) => b.id === link.to_bookmark_id);
  if (!target) return { jump: false };

  const next = remaining < 0 ? remaining : remaining - 1; // -1 stays unlimited
  return {
    jump: true,
    linkId: link.id,
    toFileId: target.file_id,
    toPageIndex: target.page_index,
    remaining: next,
  };
}
