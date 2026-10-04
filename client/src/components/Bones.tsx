// Artwork: not covered by the AGPL. See NOTICE.
/**
 * Bones, the Bandstand bandleader. A sitting cat in a bowtie with a raised baton.
 * Line-art in `currentColor` (so it inherits text color); bowtie/baton/nose use the
 * accent. `mood` swaps his expression: "ready" (eyes open, baton up) or "asleep".
 */
export function Bones({
  mood = "ready",
  className = "",
}: {
  mood?: "ready" | "asleep";
  className?: string;
}) {
  const asleep = mood === "asleep";
  return (
    <svg
      className={`bones ${className}`}
      viewBox="0 0 120 140"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* body */}
      <path className="fur" d="M34 132 C26 96 44 86 60 86 C76 86 94 96 86 132 Z" />
      {/* tail curl */}
      <path d="M86 124 C104 122 104 104 92 104" />
      {/* ears */}
      <path className="fur" d="M34 40 L41 12 L62 33 Z" />
      <path className="fur" d="M86 40 L79 12 L58 33 Z" />
      <path className="bones-accent" d="M41 19 L45 32 L53 28 Z" stroke="none" />
      <path className="bones-accent" d="M79 19 L75 32 L67 28 Z" stroke="none" />
      {/* head */}
      <ellipse className="fur" cx="60" cy="56" rx="32" ry="29" />
      {/* eyes */}
      {asleep ? (
        <>
          <path d="M46 55 q6 5 12 0" />
          <path d="M62 55 q6 5 12 0" />
        </>
      ) : (
        <>
          <circle cx="50" cy="54" r="3.4" fill="currentColor" stroke="none" />
          <circle cx="70" cy="54" r="3.4" fill="currentColor" stroke="none" />
        </>
      )}
      {/* nose + mouth */}
      <path className="bones-accent" d="M57 64 L63 64 L60 68 Z" stroke="none" />
      <path d="M60 68 q-5 6 -10 3 M60 68 q5 6 10 3" strokeWidth={2.4} />
      {/* whiskers */}
      <path d="M30 60 L46 62 M30 68 L46 67" strokeWidth={2} />
      <path d="M90 60 L74 62 M90 68 L74 67" strokeWidth={2} />
      {/* bowtie */}
      <path className="bones-accent" d="M52 88 L60 94 L52 100 Z M68 88 L60 94 L68 100 Z" stroke="none" />
      <circle className="bones-accent" cx="60" cy="94" r="2.6" stroke="none" />
      {/* baton (raised in the right paw) */}
      {asleep ? (
        <text x="92" y="34" fontSize="13" fill="currentColor" stroke="none" fontFamily="var(--display)">z</text>
      ) : (
        <>
          <path d="M84 104 L106 72" />
          <circle className="bones-accent" cx="107" cy="70" r="3.6" stroke="none" />
        </>
      )}
    </svg>
  );
}
