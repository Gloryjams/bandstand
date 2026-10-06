// Core data model for Saltycharts. Kept deliberately flat & JSON-serializable so
// charts round-trip cleanly through localStorage, backups, and the AI import path.

export type Barline =
  | 'normal'
  | 'double'
  | 'final'
  | 'repeat-start'
  | 'repeat-end'

export interface Bar {
  /** Space-separated chord tokens within the bar, e.g. "Cmaj7 A7". '' = empty, '%' = repeat prev. */
  chords: string
  lyrics?: string
  barline?: Barline
  /** Volta / ending marker: set on the FIRST bar of the ending ("1.", "2.");
      the bracket extends until a repeat/double/final barline closes it. */
  ending?: string
  /** Navigation sign engraved at the top-left of the bar. */
  sign?: 'segno' | 'coda'
  /** Navigation directive engraved top-right, e.g. "D.S. al Coda", "Fine". */
  direction?: string
  /** Hit figure for THIS measure, rendered as compact slash notation in the cell.
      One bar of beat talk ("2& 4") or #x-grid. See lib/hits.ts. */
  hits?: string
}

export interface Section {
  id: string
  /** Intro, Verse, Chorus, Bridge, Solo, Outro... */
  label: string
  bars: Bar[]
  /** Optional per-section override of bars-per-row (number or pattern like [2,4,4]). */
  barsPerRow?: number | number[]
  /** What happens here, e.g. "E7 vamp, drums only" or "riff x4, hits on 2&".
      A section with a description and zero bars renders as a pocket-chart row. */
  description?: string
  /** Hit figure rendered as slash notation. Beat talk ("2& 4", bars split on |)
      or x-grid with leading # ("#..x. .x.. x... ..x."). See lib/hits.ts. */
  hits?: string
  /** Played N times as written  -  renders repeat barlines around the section
      with ×N over the closing barline. Composes with roadmap step repeats. */
  repeats?: number
}

/** One step in a chart's order of operations (the roadmap). */
export interface ArrangementStep {
  id: string
  sectionId: string
  /** Times through; omitted = once. */
  repeats?: number
  /** Vamp/solo until cue  -  displayed as ∞, trumps repeats. */
  open?: boolean
  /** Ordered soloists over this section; each name is one pass ("gtr", "keys", "trade 4s"). */
  solos?: string[]
  /** Hit figure for THIS pass only (same beat-talk syntax as Section.hits).
      Section hits fire every pass; step hits hang on this step of the roadmap. */
  hits?: string
  /** Inline performance note, e.g. "last x ritard" or "drums in". */
  note?: string
}

export type FontSize = 'small' | 'medium' | 'large' | 'xl'

export interface ChartSettings {
  barsPerRow: number
  fontSize: FontSize
  showLyrics: boolean
  onePage: boolean
  /** Derive classic navigation (repeats, voltas, D.S./coda) from the roadmap
      and engrave it on the chart. Default on; roadmap stays source of truth. */
  classicNav?: boolean
  /** Lyric chart mode: lyrics render as the primary line in each bar, chords
      shrink to cues. Bars remain the structural truth. */
  lyricMode?: boolean
}

export interface Chart {
  id: string
  title: string
  artist: string
  key: string
  time: string
  bpm: string
  style: string
  capo: string
  sections: Section[]
  /** Order of operations. Absent/empty = sections play top-to-bottom as written. */
  arrangement?: ArrangementStep[]
  settings: ChartSettings
  tags: string[]
  createdAt: number
  updatedAt: number
}

/** One instrument's written transposition in a set's band. */
export interface BandPart {
  id: string
  /** e.g. "Concert", "Bass", "B♭ Part", "E♭ Part" */
  label: string
  /** written transposition in semitones up from concert */
  semis: number
}

export interface Setlist {
  id: string
  name: string
  date?: string
  venue?: string
  chartIds: string[]
  /** The set's instrumentation  -  drives one-tap per-part book printing. */
  band?: BandPart[]
  createdAt: number
  updatedAt: number
}

export interface LibraryBackup {
  app: 'saltycharts'
  version: 1
  exportedAt: number
  charts: Chart[]
  setlists: Setlist[]
}
