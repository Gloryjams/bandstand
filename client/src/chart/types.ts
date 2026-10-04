// Chart data model — copied verbatim from Saltycharts (apps/saltycharts/src/types.ts).
// Bandstand renders these; it never authors them. Kept flat & JSON-serializable so a
// chart round-trips through the server as opaque JSON and Dexie's chart_json mirror.

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
  /** Hit figure for THIS measure, rendered as compact slash notation in the cell. */
  hits?: string
}

export interface Section {
  id: string
  /** Intro, Verse, Chorus, Bridge, Solo, Outro... */
  label: string
  bars: Bar[]
  /** Optional per-section override of bars-per-row (number or pattern like [2,4,4]). */
  barsPerRow?: number | number[]
  /** What happens here. A section with a description and zero bars renders as a pocket-chart row. */
  description?: string
  /** Hit figure rendered as slash notation. */
  hits?: string
}

/** One step in a chart's order of operations (the roadmap). */
export interface ArrangementStep {
  id: string
  sectionId: string
  /** Times through; omitted = once. */
  repeats?: number
  /** Vamp/solo until cue — displayed as ∞, trumps repeats. */
  open?: boolean
  /** Ordered soloists over this section; each name is one pass. */
  solos?: string[]
  /** Hit figure for THIS pass only. */
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
}

/** What a share link is allowed to expose: the chart minus every field that only
    means something inside the private library (id, tags, createdAt, updatedAt).
    The server builds this allowlist; the renderer accepts it so a guest bundle can
    draw a chart it will never be able to identify or edit. */
export type PublicChart = Pick<
  Chart,
  'title' | 'artist' | 'key' | 'time' | 'bpm' | 'style' | 'capo' | 'sections' | 'arrangement' | 'settings'
>

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
