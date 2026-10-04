// Music-theory engine — ported verbatim (and typed) from the proven
// chord-chart-maker/index.html. This is the hard-won part; do not reinvent.

export const NOTES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
export const NOTES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const

const ENHARMONIC: Record<string, string> = {
  'C#': 'Db', Db: 'C#', 'D#': 'Eb', Eb: 'D#', 'F#': 'Gb', Gb: 'F#',
  'G#': 'Ab', Ab: 'G#', 'A#': 'Bb', Bb: 'A#', Cb: 'B', 'B#': 'C', 'E#': 'F', Fb: 'E',
}

/** Keys that conventionally spell accidentals as flats. */
export const FLAT_KEYS = new Set([
  'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm',
])

/** All keys offered in the key picker. */
export const ALL_KEYS = [
  'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F',
  'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm',
]

// Canonical key spelling per pitch class — minimizes accidentals and matches
// common usage (Gb not F# enharmonic surprises, Bbm not A#m, etc.).
const CANONICAL_MAJOR = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const CANONICAL_MINOR = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']

/** Canonical key name for a pitch class (0-11), major or minor. */
export function keyForPitchClass(pc: number, isMinor: boolean): string {
  const i = ((pc % 12) + 12) % 12
  return (isMinor ? CANONICAL_MINOR[i] : CANONICAL_MAJOR[i])!
}

/** Transpose a key by semitones, returning its canonical spelling. */
export function transposeKey(key: string, semitones: number): string {
  const isMinor = key.endsWith('m')
  const rootIdx = noteIndex(key.replace('m', ''))
  if (rootIdx === -1) return key
  return keyForPitchClass(rootIdx + semitones, isMinor)
}

export function preferFlats(key: string): boolean {
  if (!key) return false
  return FLAT_KEYS.has(key)
}

export function noteIndex(note: string): number {
  const n = note.charAt(0).toUpperCase() + note.slice(1)
  let idx: number = (NOTES_SHARP as readonly string[]).indexOf(n)
  if (idx === -1) idx = (NOTES_FLAT as readonly string[]).indexOf(n)
  if (idx === -1 && ENHARMONIC[n]) {
    idx = (NOTES_SHARP as readonly string[]).indexOf(ENHARMONIC[n])
    if (idx === -1) idx = (NOTES_FLAT as readonly string[]).indexOf(ENHARMONIC[n])
  }
  return idx
}

export function transposedNote(note: string, semitones: number, useFlats: boolean): string {
  const idx = noteIndex(note)
  if (idx === -1) return note
  const arr = useFlats ? NOTES_FLAT : NOTES_SHARP
  return arr[(((idx + semitones) % 12) + 12) % 12]!
}

const CHORD_RE = /^([A-G][b#]?)(.*?)(?:\/([A-G][b#]?))?$/

export interface ParsedChord {
  raw: string
  root: string
  quality: string
  bass: string
  nashville?: boolean
}

const NON_CHORD = new Set(['', '%', '/', '-', 'N.C.'])

export function parseChord(str: string): ParsedChord {
  str = str.trim()
  if (!str || str === '%' || str === '/' || str === '-') return { raw: str, root: '', quality: '', bass: '' }
  if (/^[#b]*[ivIV1-7]/.test(str)) return { raw: str, root: '', quality: '', bass: '', nashville: true }
  const m = str.match(CHORD_RE)
  if (!m) return { raw: str, root: '', quality: '', bass: '' }
  return { raw: str, root: m[1]!, quality: m[2] || '', bass: m[3] || '' }
}

/** Normalize hand-typed chord text: uppercase note letters at token starts and
    after a slash bass, leaving flat 'b' suffixes and quality text untouched.
    "eb7/bb" → "Eb7/Bb", "f#-7b5" keeps its b5. */
export function normalizeChordInput(raw: string): string {
  return raw.replace(/(^|[\s/])([a-g])/g, (_, pre: string, note: string) => pre + note.toUpperCase())
}

const BEAT_TOKEN = /^([1-9])(e|&|a|\+)?$/

/** Punch-in shorthand: beat tokens typed among the chords ("% 4 4+") peel off
    into a hit figure ("4 4&"), leaving the chords clean. '+' is the push — an
    alias for '&'. Only fires when at least one token carries a subdivision
    suffix, so bare Nashville numbers ("1 4 5") stay chords. */
export function extractHitsFromChords(input: string): { chords: string; hits?: string } {
  const tokens = input.split(/\s+/).filter(Boolean)
  if (!tokens.some((t) => /^[1-9](e|&|a|\+)$/.test(t))) return { chords: input }
  const chords: string[] = []
  const hits: string[] = []
  for (const t of tokens) {
    const m = t.match(BEAT_TOKEN)
    if (m) hits.push(m[1] + (m[2] === '+' ? '&' : m[2] ?? ''))
    else chords.push(t)
  }
  return { chords: chords.join(' '), hits: hits.length ? hits.join(' ') : undefined }
}

export function transposeChordStr(chordStr: string, semitones: number, useFlats: boolean): string {
  if (NON_CHORD.has(chordStr)) return chordStr
  const parsed = parseChord(chordStr)
  if (!parsed.root) return chordStr
  const newRoot = transposedNote(parsed.root, semitones, useFlats)
  const newBass = parsed.bass ? transposedNote(parsed.bass, semitones, useFlats) : ''
  return newRoot + parsed.quality + (newBass ? '/' + newBass : '')
}

/** Transpose every chord token in a bar string (tokens separated by spaces). */
export function transposeBar(barChords: string, semitones: number, useFlats: boolean): string {
  if (!barChords) return barChords
  return barChords
    .split(/\s+/)
    .map((tok) => transposeChordStr(tok, semitones, useFlats))
    .join(' ')
}

const NASHVILLE_NUMBERS = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7']

export function chordToNashville(chordStr: string, key: string): string {
  if (!key || NON_CHORD.has(chordStr)) return chordStr
  const parsed = parseChord(chordStr)
  if (!parsed.root) return chordStr
  const keyRoot = key.replace('m', '')
  const keyIdx = noteIndex(keyRoot)
  const chordIdx = noteIndex(parsed.root)
  if (keyIdx === -1 || chordIdx === -1) return chordStr
  const degree = (((chordIdx - keyIdx) % 12) + 12) % 12
  const num = NASHVILLE_NUMBERS[degree]

  const q = parsed.quality.toLowerCase()
  const isMinor = q.startsWith('m') && !q.startsWith('maj')

  let display: string
  if (isMinor) {
    const qualDisplay = parsed.quality.slice(1)
    display = num + 'm' + qualDisplay
  } else {
    display = num + parsed.quality
  }

  if (parsed.bass) {
    const bassIdx = noteIndex(parsed.bass)
    if (bassIdx !== -1) {
      const bassDeg = (((bassIdx - keyIdx) % 12) + 12) % 12
      display += '/' + NASHVILLE_NUMBERS[bassDeg]
    }
  }
  return display
}

export function barToNashville(barChords: string, key: string): string {
  if (!barChords) return barChords
  return barChords
    .split(/\s+/)
    .map((tok) => chordToNashville(tok, key))
    .join(' ')
}

export function getDiatonicChords(key: string): string[] {
  if (!key) return []
  const isMinor = key.endsWith('m')
  const root = key.replace('m', '')
  const rootIdx = noteIndex(root)
  if (rootIdx === -1) return []
  const arr = preferFlats(key) ? NOTES_FLAT : NOTES_SHARP

  if (isMinor) {
    const intervals = [0, 2, 3, 5, 7, 8, 10]
    const suffixes = ['m', 'dim', '', 'm', 'm', '', '']
    return intervals.map((iv, i) => arr[(rootIdx + iv) % 12]! + suffixes[i]!)
  }
  const intervals = [0, 2, 4, 5, 7, 9, 11]
  const suffixes = ['', 'm', 'm', '', '', 'm', 'dim']
  return intervals.map((iv, i) => arr[(rootIdx + iv) % 12]! + suffixes[i]!)
}

const QUALITY_INTERVALS: Record<string, number[]> = {
  '': [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7],
  m: [0, 3, 7], min: [0, 3, 7], '-': [0, 3, 7],
  '7': [0, 4, 7, 10], dom7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], '^': [0, 4, 7, 11], '^7': [0, 4, 7, 11],
  m7: [0, 3, 7, 10], min7: [0, 3, 7, 10], '-7': [0, 3, 7, 10],
  dim: [0, 3, 6], o: [0, 3, 6], dim7: [0, 3, 6, 9], o7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10], 'half-dim': [0, 3, 6, 10],
  aug: [0, 4, 8], '+': [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7],
  '6': [0, 4, 7, 9], m6: [0, 3, 7, 9],
  '9': [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], '^9': [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14],
  '11': [0, 4, 7, 10, 14, 17], m11: [0, 3, 7, 10, 14, 17],
  '13': [0, 4, 7, 10, 14, 17, 21], maj13: [0, 4, 7, 11, 14, 17, 21], '^13': [0, 4, 7, 11, 14, 17, 21], m13: [0, 3, 7, 10, 14, 17, 21],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  '7#9': [0, 4, 7, 10, 15], '7b9': [0, 4, 7, 10, 13],
  '7#11': [0, 4, 7, 10, 18], 'maj7#11': [0, 4, 7, 11, 18], '^7#11': [0, 4, 7, 11, 18],
  '7b13': [0, 4, 7, 10, 20],
}

export interface ChordNotes {
  name: string
  notes: string[]
  intervals: number[]
}

export function getChordNotes(chordStr: string): ChordNotes | null {
  const parsed = parseChord(chordStr)
  if (!parsed.root) return null
  const rootIdx = noteIndex(parsed.root)
  if (rootIdx === -1) return null

  const q = parsed.quality
  let intervals = QUALITY_INTERVALS[q]
  if (!intervals) {
    for (const key of Object.keys(QUALITY_INTERVALS)) {
      if (key.length > 0 && q.startsWith(key)) {
        intervals = QUALITY_INTERVALS[key]
        break
      }
    }
  }
  if (!intervals) intervals = QUALITY_INTERVALS['']!

  const arr = preferFlats(chordStr) ? NOTES_FLAT : NOTES_SHARP
  const notes = intervals.map((iv) => arr[(rootIdx + iv) % 12]!)
  return { name: chordStr, notes, intervals: intervals.map((iv) => iv % 12) }
}

/** Semitone distance to move FROM key A to key B (shortest signed direction not enforced). */
export function semitonesBetween(fromKey: string, toKey: string): number {
  const a = noteIndex(fromKey.replace('m', ''))
  const b = noteIndex(toKey.replace('m', ''))
  if (a === -1 || b === -1) return 0
  return (((b - a) % 12) + 12) % 12
}
