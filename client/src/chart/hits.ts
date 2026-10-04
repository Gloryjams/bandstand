// Hit-figure parsing for pocket charts. Two entry grammars, one normalized form:
// each bar is a sorted list of 16th-note slots (0..15 in 4/4).
//
//   Beat talk (default): "2& 4"  "1 1& 2 | 3 4&"  — beats 1..N, suffix e/&/a,
//     bars separated by |. This is how you'd say the figure to the band.
//   X-grid (leading #):  "#..x. .x.. x... ..x."  — 16 slots per 4/4 bar,
//     x = hit, . or - = empty, spaces optional, | for bars.

export interface HitBar {
  /** sorted 16th-note slot indices, 0..(beats*4 - 1) */
  slots: number[]
}

export interface ParsedHits {
  bars: HitBar[]
  /** set when input doesn't parse; bars then holds whatever did */
  error?: string
}

const SUFFIX_SLOT: Record<string, number> = { '': 0, e: 1, '&': 2, '+': 2, a: 3 }

export function parseHits(input: string, beatsPerBar = 4): ParsedHits {
  const text = input.trim()
  if (!text) return { bars: [] }
  return text.startsWith('#') ? parseGrid(text.slice(1), beatsPerBar) : parseBeatTalk(text, beatsPerBar)
}

function parseBeatTalk(text: string, beatsPerBar: number): ParsedHits {
  const bars: HitBar[] = []
  let error: string | undefined
  for (const barText of text.split('|')) {
    const slots: number[] = []
    for (const tok of barText.trim().split(/\s+/).filter(Boolean)) {
      const m = tok.match(/^(\d+)(e|&|\+|a)?$/i)
      if (!m) {
        error = `can't read "${tok}". Use beats like 2, 2e, 2&, 2a`
        continue
      }
      const beat = parseInt(m[1]!, 10)
      if (beat < 1 || beat > beatsPerBar) {
        error = `beat ${beat} is outside this bar`
        continue
      }
      slots.push((beat - 1) * 4 + (SUFFIX_SLOT[(m[2] ?? '').toLowerCase()] ?? 0))
    }
    bars.push({ slots: [...new Set(slots)].sort((a, b) => a - b) })
  }
  return trim({ bars, error })
}

function parseGrid(text: string, beatsPerBar: number): ParsedHits {
  const perBar = beatsPerBar * 4
  const bars: HitBar[] = []
  let error: string | undefined
  for (const barText of text.split('|')) {
    const cells = barText.replace(/\s+/g, '')
    const slots: number[] = []
    for (let i = 0; i < cells.length; i++) {
      const ch = cells[i]
      if (ch === 'x' || ch === 'X') slots.push(i)
      else if (ch !== '.' && ch !== '-') error = `grid cells are x . or - (saw "${ch}")`
    }
    if (cells.length > perBar) error = `bar has ${cells.length} cells; max ${perBar}`
    bars.push({ slots: slots.filter((s) => s < perBar) })
  }
  return trim({ bars, error })
}

/** Drop empty trailing bars (typing "2& 4 |" shouldn't render a spare bar). */
function trim(parsed: ParsedHits): ParsedHits {
  const bars = [...parsed.bars]
  while (bars.length > 1 && bars[bars.length - 1]!.slots.length === 0) bars.pop()
  if (bars.length === 1 && bars[0]!.slots.length === 0) return { bars: [], error: parsed.error }
  return { bars, error: parsed.error }
}

export type NoteValue = 'quarter' | 'eighth' | 'sixteenth'

/** Display duration for the hit at slots[i]: gap to the next hit (or bar end), capped at a beat. */
export function noteValueAt(bar: HitBar, i: number, beatsPerBar = 4): NoteValue {
  const end = beatsPerBar * 4
  const gap = (bar.slots[i + 1] ?? end) - bar.slots[i]!
  if (gap >= 4 && bar.slots[i]! % 4 === 0) return 'quarter'
  if (gap >= 2) return 'eighth'
  return 'sixteenth'
}

// ─────────────────────────────────────────────────────────────────────────────
// Engraving: slots → a properly notated one-voice rhythm cue.
//
// Model: each attack SUSTAINS to the next attack (or bar end) — the way a
// copyist writes an ensemble/kick figure. The sustained span is split across
// metric boundaries into tied note-segments (a note may not cross a boundary
// stronger than its onset warrants), adjacent value+half-value pairs collapse
// into dotted values, and the region before the first attack is filled with
// beat-clarity rests. Beaming groups eighths/sixteenths within a beat, with the
// standard straight-eighth exception that lets a beam span two beats inside a
// half (never across the 4/4 midpoint).
// ─────────────────────────────────────────────────────────────────────────────

/** Base note/rest value; `dotted` on the event carries the augmentation dot. */
export type BaseValue = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth'

export interface NoteEvent {
  kind: 'note'
  onset: number
  dur: number
  base: BaseValue
  dotted: boolean
  /** originating attack slot (all tied segments of one attack share it) */
  slot: number
  /** first written segment of an attack — the only one that carries a label */
  isAttack: boolean
  tieStart: boolean
  tieEnd: boolean
  label?: string
}

export interface RestEvent {
  kind: 'rest'
  onset: number
  dur: number
  base: BaseValue
  dotted: boolean
}

export type RhythmEvent = NoteEvent | RestEvent

/** Indices (into `events`) of beamable notes that share one beam. */
export interface BeamGroup {
  members: number[]
}

export interface EngravedBar {
  events: RhythmEvent[]
  beams: BeamGroup[]
}

const SUB = ['', 'e', '&', 'a']

/** Count-off label for a slot, e.g. 6 → "2&", 12 → "4". */
function spoken(slot: number): string {
  return `${Math.floor(slot / 4) + 1}${SUB[slot % 4]}`
}

interface Seg {
  onset: number
  dur: number
}

interface Cell {
  start: number
  end: number
  children?: Cell[]
}

/** Metric tree: 4/4 subdivides binary (bar→halves→beats→8ths→16ths); other
 *  meters split the bar into `beatsPerBar` beat-cells, each then binary. */
function makeCell(start: number, end: number, isBar: boolean, beatsPerBar: number): Cell {
  if (end - start <= 1) return { start, end }
  let children: Cell[]
  if (isBar && beatsPerBar !== 4) {
    children = []
    for (let t = start; t < end; t += 4) children.push(makeCell(t, Math.min(t + 4, end), false, beatsPerBar))
  } else {
    const mid = (start + end) / 2
    children = [makeCell(start, mid, false, beatsPerBar), makeCell(mid, end, false, beatsPerBar)]
  }
  return { start, end, children }
}

/** Split [a,b) along the metric tree into power-of-two segments that never
 *  cross a boundary stronger than themselves. Segments come out onset-ascending. */
function splitTree(cell: Cell, a: number, b: number): Seg[] {
  const s = Math.max(a, cell.start)
  const e = Math.min(b, cell.end)
  if (s >= e) return []
  if (s === cell.start && e === cell.end) return [{ onset: s, dur: e - s }]
  if (!cell.children) return [{ onset: s, dur: e - s }]
  let out: Seg[] = []
  for (const ch of cell.children) out = out.concat(splitTree(ch, s, e))
  return out
}

/** Can a value of `v` ticks at `onset` wear a dot (i.e. absorb the following v/2)? */
function dottedLegal(onset: number, v: number, beatsPerBar: number): boolean {
  if (v === 2) return onset % 2 === 0 && Math.floor(onset / 4) === Math.floor((onset + 2) / 4) // within a beat
  if (v === 4) {
    if (onset % 4 !== 0) return false
    return beatsPerBar === 4
      ? Math.floor(onset / 8) === Math.floor((onset + 5) / 8) // within a half (no midpoint crossing)
      : onset + 6 <= beatsPerBar * 4
  }
  if (v === 8) return onset === 0 && onset + 12 <= beatsPerBar * 4 // dotted half on beat 1 only
  return false
}

/** Collapse each value immediately followed by exactly half its length into a
 *  dotted value, where metrically legal. One dot max (never double-dotted). */
function mergeDots(segs: Seg[], beatsPerBar: number): Seg[] {
  const out = segs.slice()
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i]!
    const b = out[i + 1]!
    if (b.onset === a.onset + a.dur && b.dur * 2 === a.dur && dottedLegal(a.onset, a.dur, beatsPerBar)) {
      out.splice(i, 2, { onset: a.onset, dur: a.dur + b.dur })
      // fall through to i++ so the merged (already-dotted) value is not re-merged
    }
  }
  return out
}

function describeDur(dur: number): { base: BaseValue; dotted: boolean } {
  switch (dur) {
    case 16:
      return { base: 'whole', dotted: false }
    case 12:
      return { base: 'half', dotted: true }
    case 8:
      return { base: 'half', dotted: false }
    case 6:
      return { base: 'quarter', dotted: true }
    case 4:
      return { base: 'quarter', dotted: false }
    case 3:
      return { base: 'eighth', dotted: true }
    case 2:
      return { base: 'eighth', dotted: false }
    default:
      return { base: 'sixteenth', dotted: false }
  }
}

const isBeamable = (e: RhythmEvent): e is NoteEvent =>
  e.kind === 'note' && (e.base === 'eighth' || e.base === 'sixteenth')

/** Group beamable notes: per beat, then merge two adjacent beat-groups inside a
 *  half when every member is a straight eighth (the beats-1-2 / 3-4 exception).
 *  Groups of one stay ungrouped (the caller flags them). */
function computeBeams(events: RhythmEvent[], beatsPerBar: number): BeamGroup[] {
  const groups: number[][] = []
  let cur: number[] = []
  let curBeat = -1
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    if (isBeamable(e)) {
      const beat = Math.floor(e.onset / 4)
      if (cur.length === 0) {
        cur = [i]
        curBeat = beat
      } else if (beat === curBeat) {
        cur.push(i)
      } else {
        groups.push(cur)
        cur = [i]
        curBeat = beat
      }
    } else if (cur.length) {
      groups.push(cur)
      cur = []
      curBeat = -1
    }
  }
  if (cur.length) groups.push(cur)

  const merged: number[][] = []
  for (const g of groups) {
    const prev = merged[merged.length - 1]
    if (prev) {
      const contiguous = prev[prev.length - 1] === g[0]! - 1
      const allEighth = [...prev, ...g].every((idx) => events[idx]!.dur === 2)
      const sameHalf =
        beatsPerBar === 4 && Math.floor(events[prev[0]!]!.onset / 8) === Math.floor(events[g[g.length - 1]!]!.onset / 8)
      if (contiguous && allEighth && sameHalf) {
        merged[merged.length - 1] = [...prev, ...g]
        continue
      }
    }
    merged.push(g)
  }
  return merged.filter((g) => g.length >= 2).map((members) => ({ members }))
}

/** Derive a fully engraved rhythm (tied notes, rests, beam groups) for one bar. */
export function engraveBar(bar: HitBar, beatsPerBar = 4): EngravedBar {
  const T = beatsPerBar * 4
  const events: RhythmEvent[] = []
  if (bar.slots.length === 0) {
    events.push({ kind: 'rest', onset: 0, dur: T, base: 'whole', dotted: false })
    return { events, beams: [] }
  }

  const tree = makeCell(0, T, true, beatsPerBar)

  // Rests before the first attack, broken for beat clarity (no dotted rests).
  const first = bar.slots[0]!
  if (first > 0) {
    for (const seg of splitTree(tree, 0, first)) {
      const d = describeDur(seg.dur)
      events.push({ kind: 'rest', onset: seg.onset, dur: seg.dur, base: d.base, dotted: d.dotted })
    }
  }

  // Each attack sustains to the next attack (or bar end).
  for (let i = 0; i < bar.slots.length; i++) {
    const onset = bar.slots[i]!
    const next = bar.slots[i + 1] ?? T
    const segs = mergeDots(splitTree(tree, onset, next), beatsPerBar)
    for (let j = 0; j < segs.length; j++) {
      const s = segs[j]!
      const d = describeDur(s.dur)
      events.push({
        kind: 'note',
        onset: s.onset,
        dur: s.dur,
        base: d.base,
        dotted: d.dotted,
        slot: onset,
        isAttack: j === 0,
        tieStart: j < segs.length - 1,
        tieEnd: j > 0,
        label: j === 0 ? spoken(onset) : undefined,
      })
    }
  }

  return { events, beams: computeBeams(events, beatsPerBar) }
}

/** Beams per written note value: 2 for a sixteenth, 1 for an eighth, else 0. */
export function beamCount(base: BaseValue): number {
  return base === 'sixteenth' ? 2 : base === 'eighth' ? 1 : 0
}
