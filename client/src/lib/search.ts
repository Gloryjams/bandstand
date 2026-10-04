import Fuse from "fuse.js";

export interface SearchablePiece {
  id: string;
  title: string;
  composer: string | null;
  music_key: string | null;
  tags: string[];
  notes: string | null;
}

export function rankResults(
  pieces: SearchablePiece[],
  query: string,
  recentIds: string[],
): SearchablePiece[] {
  const recentSet = new Set(recentIds);
  if (!query.trim()) {
    const ordered = recentIds
      .map((id) => pieces.find((p) => p.id === id))
      .filter((p): p is SearchablePiece => !!p);
    const others = pieces.filter((p) => !recentSet.has(p.id));
    return [...ordered, ...others];
  }

  const q = query.toLowerCase();
  const exactPrefix = pieces.filter((p) =>
    p.title.toLowerCase().startsWith(q));
  const fuse = new Fuse(pieces, {
    keys: ["title", "composer", "music_key", "tags", "notes"],
    threshold: 0.3,
    ignoreLocation: true,
  });
  const fuzzy = fuse.search(query).map((r) => r.item);

  const seen = new Set<string>();
  const ordered: SearchablePiece[] = [];

  for (const id of recentIds) {
    const p = pieces.find((p) => p.id === id);
    if (p && (exactPrefix.includes(p) || fuzzy.includes(p)) && !seen.has(p.id)) {
      ordered.push(p);
      seen.add(p.id);
    }
  }
  for (const p of exactPrefix) {
    if (!seen.has(p.id)) {
      ordered.push(p);
      seen.add(p.id);
    }
  }
  for (const p of fuzzy) {
    if (!seen.has(p.id)) {
      ordered.push(p);
      seen.add(p.id);
    }
  }
  return ordered;
}
