import type { Bar, Barline, Chart, Section } from '@/types'
import { newChart, newSection } from '@/lib/factory'

// iReal Pro import: irealb:// (current, scrambled) and irealbook:// (legacy,
// plain) playlist URLs, straight from the HTML export or a pasted link.
//
// We parse the VISUAL form  -  sections, barlines, repeats, voltas, signs  -
// not a playback unroll: Saltycharts' Bar model engraves all of that natively.
// Format knowledge: pianosnake/ireal-reader + ironss/accompaniser docs.

export interface IRealImportResult {
  charts: Chart[]
  playlistName?: string
  warnings: string[]
}

const MUSIC_PREFIX = '1r34LbKcu7'

/** The scramble is an involution: 50-char chunks swap [0..4]<->[45..49] and
    [10..23]<->[26..39]; a trailing remainder passes through untouched. */
export function unscramble(s: string): string {
  let r = ''
  while (s.length > 50) {
    const p = s.slice(0, 50)
    s = s.slice(50)
    r += s.length < 2 ? p : swap50(p)
  }
  return r + s
}

function swap50(s: string): string {
  const out = s.split('')
  for (let i = 0; i < 5; i++) {
    out[49 - i] = s[i]!
    out[i] = s[49 - i]!
  }
  for (let i = 10; i < 24; i++) {
    out[49 - i] = s[i]!
    out[i] = s[49 - i]!
  }
  return out.join('')
}

const TIME_SIGS: Record<string, string> = {
  '44': '4/4', '34': '3/4', '24': '2/4', '54': '5/4', '64': '6/4', '74': '7/4',
  '22': '2/2', '32': '3/2', '58': '5/8', '68': '6/8', '78': '7/8', '98': '9/8',
  '12': '12/8',
}

const SECTION_LABELS: Record<string, string> = { i: 'Intro', v: 'Verse' }

/** iReal chord → Saltycharts chord. The theory engine already speaks '-', '^',
    'o', '+', sus...; only half-diminished 'h' needs a spelling it knows. */
export function convertChord(tok: string, lastChord: string | null): string | null {
  const m = /^([A-GW][#b]?)([+\-^\dhob#suadlt]*)(\/[A-G][#b]?)?$/.exec(tok)
  if (!m) return null
  const root = m[1]!
  const quality = (m[2] ?? '').replace(/^h7?/, 'm7b5')
  const bass = m[3] ?? ''
  if (root === 'W') {
    // invisible root: previous harmony carries over the new bass note
    if (!bass) return null
    return lastChord ? `${lastChord}${bass}` : bass.slice(1)
  }
  return `${root}${quality}${bass}`
}

interface RawSong {
  title: string
  composer: string
  style: string
  key: string
  music: string
  bpm: string | undefined
  scrambled: boolean
}

function splitSongs(text: string): { raws: RawSong[]; playlistName?: string; warnings: string[] } {
  const warnings: string[] = []
  const m = /ireal(book|b):\/\/([^"'\s]*)/.exec(text)
  if (!m) return { raws: [], warnings: ['No irealb:// link found in that text'] }
  const legacy = m[1] === 'book'
  const decoded = decodeURIComponent(m[2]!)
  const chunks = decoded.split('===')
  // a trailing chunk with no music payload is the playlist name
  let playlistName: string | undefined
  if (chunks.length > 1 && !chunks[chunks.length - 1]!.includes(legacy ? '=' : MUSIC_PREFIX)) {
    playlistName = chunks.pop()!.trim() || undefined
  }
  const raws: RawSong[] = []
  for (const chunk of chunks) {
    const parts = chunk.split(/=+/).filter((x) => x !== '')
    if (legacy) {
      // irealbook: title=composer=style=key=n=music (music not scrambled)
      if (parts.length < 6) {
        warnings.push('Skipped a malformed legacy song entry')
        continue
      }
      raws.push({
        title: parts[0]!, composer: parts[1]!, style: parts[2]!, key: parts[3]!,
        music: parts[5]!, bpm: undefined, scrambled: false,
      })
      continue
    }
    // irealb layouts (7-9 fields): title=composer=style=key=[transpose]=music=[compStyle]=bpm=repeats
    const musicIdx = parts.findIndex((p) => p.startsWith(MUSIC_PREFIX))
    if (musicIdx === -1) {
      warnings.push(`Skipped an entry with no chart data ("${(parts[0] ?? '?').slice(0, 40)}")`)
      continue
    }
    // after music: [bpm, repeats] or [compStyle, bpm, repeats]
    const rem = parts.slice(musicIdx + 1)
    const bpmField = rem.length >= 3 ? rem[1] : rem[0]
    const bpm = bpmField && /^\d+$/.test(bpmField) && parseInt(bpmField) > 0 ? bpmField : undefined
    raws.push({
      title: parts[0]!, composer: parts[1]!, style: parts[2]!, key: parts[3]!,
      music: parts[musicIdx]!.slice(MUSIC_PREFIX.length),
      bpm, scrambled: true,
    })
  }
  return { raws, playlistName, warnings }
}

const DIRECTIONS: Record<string, string> = {
  'd.c. al coda': 'D.C. al Coda',
  'd.c. al fine': 'D.C. al Fine',
  'd.s. al coda': 'D.S. al Coda',
  'd.s. al fine': 'D.S. al Fine',
  fine: 'Fine',
  'd.c. al 1st end.': 'D.C. al 1st Ending',
  'd.c. al 2nd end.': 'D.C. al 2nd Ending',
  'd.c. al 3rd end.': 'D.C. al 3rd Ending',
}

interface PendingFlags {
  barline?: Barline
  ending?: string
  sign?: Bar['sign']
}

function buildChart(raw: RawSong, warnings: string[]): Chart {
  const music = raw.scrambled ? unscramble(raw.music) : raw.music
  const sections: Section[] = []
  let bars: Bar[] = []
  let label: string | null = null
  let tokens: string[] = []
  let pending: PendingFlags = {}
  let time: string | null = null
  let lastChord: string | null = null
  let alternatesSkipped = 0

  /** Close the in-progress bar. A closing-barline style ('repeat-end' etc.)
      with nothing accumulated retro-applies to the previous bar instead. */
  const closeBar = (barline?: Barline) => {
    const hasFlags = Boolean(pending.barline || pending.ending || pending.sign)
    if (tokens.length === 0 && !hasFlags) {
      if (barline && bars.length > 0) bars[bars.length - 1]!.barline = barline
      return
    }
    const bar: Bar = { chords: tokens.join(' ') }
    if (pending.barline) bar.barline = pending.barline
    if (barline) bar.barline = barline
    if (pending.ending) bar.ending = pending.ending
    if (pending.sign) bar.sign = pending.sign
    bars.push(bar)
    tokens = []
    pending = {}
  }

  /** Start a new section. Pending next-bar flags (e.g. the '{' in "{*A")
      survive the boundary and land on the new section's first bar. */
  const flushSection = () => {
    if (tokens.length > 0) closeBar()
    if (bars.length > 0 || label !== null) {
      const s = newSection(label ?? 'A', 0)
      s.bars = bars
      sections.push(s)
    }
    bars = []
    label = null
  }

  const setDirectionOnLastBar = (d: string) => {
    if (tokens.length > 0) closeBar()
    if (bars.length > 0) bars[bars.length - 1]!.direction = d
  }

  let s = music
  const eat = (n: number) => (s = s.slice(n))
  while (s.length > 0) {
    let m: RegExpExecArray | null
    if (s.startsWith('XyQ')) { eat(3); continue }
    if ((m = /^\*(\w)/.exec(s))) {
      flushSection()
      label = SECTION_LABELS[m[1]!] ?? m[1]!.toUpperCase()
      eat(m[0].length)
      continue
    }
    if ((m = /^<(.*?)>/.exec(s))) {
      const d = DIRECTIONS[m[1]!.trim().toLowerCase()]
      if (d) setDirectionOnLastBar(d)
      eat(m[0].length)
      continue
    }
    if ((m = /^T(\d\d?)/.exec(s))) {
      const t = TIME_SIGS[m[1]!]
      if (t && time === null) time = t
      else if (t && time !== null && t !== time) {
        warnings.push(`"${raw.title}": time changes mid-chart (${time} → ${t}); kept ${time}`)
      }
      eat(m[0].length)
      continue
    }
    if (s.startsWith('r|XyQ') || s[0] === 'r') {
      // two-bar repeat sign → two '%' bars
      closeBar()
      tokens = ['%']
      closeBar()
      tokens = ['%']
      closeBar()
      eat(s.startsWith('r|XyQ') ? 5 : 1)
      continue
    }
    if (s.startsWith('Kcl')) { closeBar(); tokens = ['%']; closeBar(); eat(3); continue }
    if (s[0] === 'x') { tokens = ['%']; eat(1); continue }
    if ((m = /^Y+/.exec(s))) { eat(m[0].length); continue }
    if (s[0] === 'n') { tokens.push('N.C.'); eat(1); continue }
    if (s[0] === 'p' || s[0] === 'U' || s[0] === ',' || s[0] === 's' || s[0] === 'l' || s[0] === 'f') { eat(1); continue }
    if (s[0] === 'S') { if (tokens.length > 0) closeBar(); pending.sign = 'segno'; eat(1); continue }
    if (s[0] === 'Q') { if (tokens.length > 0) closeBar(); pending.sign = 'coda'; eat(1); continue }
    if (s[0] === '{') { closeBar(); pending.barline = 'repeat-start'; eat(1); continue }
    if (s[0] === '}') { closeBar('repeat-end'); eat(1); continue }
    if (s.startsWith('LZ|')) { closeBar(); eat(3); continue }
    if (s.startsWith('LZ')) { closeBar(); eat(2); continue }
    if (s[0] === '|') { closeBar(); eat(1); continue }
    if (s[0] === '[') { closeBar(); eat(1); continue }
    if (s[0] === ']') { closeBar('double'); eat(1); continue }
    if ((m = /^N(\d)/.exec(s))) { pending.ending = `${m[1]}.`; eat(m[0].length); continue }
    if (s[0] === 'Z') { closeBar('final'); eat(1); continue }
    if ((m = /^\((.*?)\)/.exec(s))) { alternatesSkipped++; eat(m[0].length); continue }
    if ((m = /^[A-GW][#b]?[+\-^\dhob#suadlt]*(\/[A-G][#b]?)?/.exec(s))) {
      const chord = convertChord(m[0], lastChord)
      if (chord) {
        tokens.push(chord)
        lastChord = chord.split('/')[0] || lastChord
      }
      eat(m[0].length)
      continue
    }
    eat(1) // unknown character  -  skip
  }
  flushSection()

  if (alternatesSkipped > 0) {
    warnings.push(`"${raw.title}": ${alternatesSkipped} small alternate chord(s) skipped`)
  }

  return newChart({
    title: raw.title.trim(),
    artist: raw.composer.trim(),
    key: raw.key.replace(/-$/, 'm'),
    time: time ?? '4/4',
    bpm: raw.bpm ?? '',
    style: raw.style.trim(),
    sections: sections.length > 0 ? sections : [newSection('A', 0)],
    tags: ['ireal'],
  })
}

export function parseIReal(text: string): IRealImportResult {
  const { raws, playlistName, warnings } = splitSongs(text)
  const charts = raws.map((raw) => buildChart(raw, warnings))
  return { charts, playlistName, warnings }
}

export function looksLikeIReal(text: string): boolean {
  return /ireal(book|b):\/\//.test(text)
}
