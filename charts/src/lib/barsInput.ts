import { normalizeChordInput } from '@/lib/theory'

/**
 * Split inline-editor text containing barlines into per-bar chord strings:
 * "C | Am | F G | C" -> ['C', 'Am', 'F G', 'C']. Empty segments ("C || G")
 * become blank bars; '%' stays a repeat token. Returns null when the text has
 * no barline, i.e. it is ordinary single-bar input.
 *
 * This is the PASTE half of barline-as-a-delimiter: a typed `|` never reaches
 * the input on desktop (the keydown advances instead), but pasted phrases and
 * Android keyboards (whose keydown for `|` is unreliable) land here.
 */
export function splitBarsInput(raw: string): string[] | null {
  if (!raw.includes('|')) return null
  return raw.split('|').map((s) => normalizeChordInput(s.trim()))
}
