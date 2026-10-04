// Artwork: not covered by the AGPL. See NOTICE.
// Bonito canon from the "Bonito x Bandstand" claude.ai/design handoff
// (project "Bonito Expression Sheet"). Pure data + the player-state -> mood mapping;
// the SVG cat itself lives in components/Bonito.tsx.

export type BonitoExpression =
  | "happy" | "in-love" | "star-struck" | "wink" | "sleepy" | "surprised" | "curious";

export const EXPRESSIONS: readonly { key: BonitoExpression; label: string }[] = [
  { key: "happy", label: "Happy" },
  { key: "in-love", label: "In Love" },
  { key: "star-struck", label: "Star-struck" },
  { key: "wink", label: "Wink" },
  { key: "sleepy", label: "Sleepy" },
  { key: "surprised", label: "Surprised" },
  { key: "curious", label: "Curious" },
];

export type BonitoOutfit = "conductor" | "starman" | "duke" | "thriller" | "moonwalk";

/** The five Stage Wardrobe outfits, era metadata straight from the design. */
export const OUTFITS: readonly {
  key: BonitoOutfit; label: string; era: string; sub: string; dot: string; accent: string;
}[] = [
  { key: "conductor", label: "Conductor", era: "The Conductor", sub: "JR LIMITED EXPRESS", dot: "#1B3A5C", accent: "#FF6B9D" },
  { key: "starman", label: "Starman", era: "Starman", sub: "GLAM ROCK · 1972", dot: "#FF3B5C", accent: "#2BB3FF" },
  { key: "duke", label: "White Duke", era: "The Thin White Duke", sub: "ART POP · 1976", dot: "#E7E0CC", accent: "#B79235" },
  { key: "thriller", label: "Thriller", era: "Thriller", sub: "POP KING · 1983", dot: "#E01B2E", accent: "#E01B2E" },
  { key: "moonwalk", label: "Moonwalk", era: "Smooth Criminal", sub: "MOONWALK · 1988", dot: "#2B6CB0", accent: "#2B6CB0" },
];

export function isOutfit(v: unknown): v is BonitoOutfit {
  return typeof v === "string" && OUTFITS.some((o) => o.key === v);
}

const OUTFIT_KEY = "bandstand-bonito-outfit";

/** Dressing-room pick, device-local (never synced; wardrobe is per tablet). */
export function loadOutfit(): BonitoOutfit {
  try {
    const v = localStorage.getItem(OUTFIT_KEY);
    if (isOutfit(v)) return v;
  } catch { /* ignore */ }
  return "conductor";
}
export function saveOutfit(o: BonitoOutfit): void {
  try { localStorage.setItem(OUTFIT_KEY, o); } catch { /* ignore */ }
}

export interface PlayerMoodState {
  playing: boolean;
  /** A mark set, B not yet: mid-way through framing a loop. */
  loopArmed: boolean;
  /** A-B window active. */
  looping: boolean;
  /** Playhead ran off the end of the track. */
  ended: boolean;
}

/**
 * The design README's "controlled mode" contract: Bandstand events drive the
 * expression. Priority: ended > looping > loop-armed > playing > napping.
 */
export function moodFor(s: PlayerMoodState): BonitoExpression {
  if (s.ended) return "surprised";
  if (s.looping) return "wink";
  if (s.loopArmed) return "curious";
  if (s.playing) return "happy";
  return "sleepy";
}
