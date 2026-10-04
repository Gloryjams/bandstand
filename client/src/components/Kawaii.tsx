/**
 * Small kawaii SVG accents — the Bonito-universe motifs, drawn (never emoji, per the
 * house rule). `Heart` is the wordmark's beat; `Sparkle` twinkles on hero/active moments.
 */

/** A plump little heart. Fills with currentColor. */
export function Heart({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21s-7.5-4.9-10-9.2C.3 8.6 2 5 5.4 5c2 0 3.4 1.2 4.3 2.6l.3.5.3-.5C11.2 6.2 12.6 5 14.6 5 18 5 19.7 8.6 22 11.8 19.5 16.1 12 21 12 21z" />
    </svg>
  );
}

/** A four-point sparkle. Wrap in <span className="spark tw"> for the twinkle animation. */
export function Sparkle({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 1c.5 4.7 2.3 6.5 7 7-4.7.5-6.5 2.3-7 7-.5-4.7-2.3-6.5-7-7 4.7-.5 6.5-2.3 7-7z" />
    </svg>
  );
}
