import type { ReactNode } from 'react'
import type { ArrangementStep, Bar, PublicChart, Section } from './types'
import { parseChord, transposeChordStr, chordToNashville, preferFlats, transposedNote } from './theory'
import { HitStaff } from './HitStaff'

/** Positional rehearsal letter: A, B, C... (falls back to numbers past Z). */
export function sectionLetter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1)
}

/** Sections that take a functional mark instead of consuming a rehearsal
    letter — standard copyist convention (letters start at the first real
    section of the form). Matched by label. */
const UNLETTERED: [RegExp, string][] = [
  [/^intro/i, 'IN'],
  [/^outro/i, 'OUT'],
  [/^coda/i, 'CODA'],
  [/^tag/i, 'TAG'],
  [/^count/i, 'CT'],
  [/^vamp/i, 'VAMP'],
]

function unletteredMark(label: string): string | null {
  for (const [re, mark] of UNLETTERED) if (re.test(label.trim())) return mark
  return null
}

/** Rehearsal marks for a chart's sections: A/B/C for the form, functional
    marks (IN, OUT, CODA...) for intro-like sections, which letters skip. */
export function sectionMarks(sections: Section[]): string[] {
  let n = 0
  return sections.map((s) => unletteredMark(s.label) ?? sectionLetter(n++))
}

/** True when a mark is a real rehearsal letter (targetable from the spell pad). */
export function isLetterMark(mark: string): boolean {
  return /^[A-Z]$/.test(mark) || /^\d+$/.test(mark)
}

/** Sub-line for one roadmap-rail row: soloists, the inline note, a hits marker.
    Middots separate the parts and commas separate soloists, so the two levels stay
    readable. No em-dashes: this line ships to guests on public share pages. */
export function roadmapNote(step: ArrangementStep): string {
  return [
    step.solos && step.solos.length > 0 ? `solos: ${step.solos.join(', ')}` : null,
    step.note ?? null,
    step.hits ? 'hits' : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

interface Props {
  chart: PublicChart
  /** semitone transpose applied for display only */
  transpose?: number
  nashville?: boolean
  showLyrics?: boolean
  /** Rehearsal marks parallel to chart.sections — pass when rendering a slice
      of a larger chart so marks stay correct; computed internally otherwise. */
  marks?: string[]
  /** Stage mode: render the roadmap as one horizontal sequential rail instead
      of wrapped chips — reads left-to-right like the tune plays. */
  roadmapRail?: boolean
}

/* Navigation signs, drawn as SVG so they render identically on every device. */
function SegnoIcon() {
  return (
    <svg className="sign-svg" width="13" height="15" viewBox="0 0 14 16" aria-label="segno" role="img">
      <text x="7" y="12" textAnchor="middle" fontSize="12" fontStyle="italic" fontWeight="700" fill="currentColor" fontFamily="Georgia, 'Times New Roman', serif">S</text>
      <line x1="2" y1="14" x2="12" y2="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="2.2" cy="5" r="1.2" fill="currentColor" />
      <circle cx="11.8" cy="11" r="1.2" fill="currentColor" />
    </svg>
  )
}
function CodaIcon() {
  return (
    <svg className="sign-svg" width="13" height="15" viewBox="0 0 14 16" aria-label="coda" role="img">
      <ellipse cx="7" cy="8" rx="4" ry="5.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <line x1="7" y1="0.5" x2="7" y2="15.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="0.5" y1="8" x2="13.5" y2="8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

interface VoltaInfo {
  /** Present on the first bar of the span. */
  label?: string
  end: boolean
}

/** Volta bracket spans: an ending starts on its labeled bar and runs until a
    repeat/double/final barline closes it (or another ending / section end). */
function voltaSpans(bars: Bar[]): Map<number, VoltaInfo> {
  const map = new Map<number, VoltaInfo>()
  const closes = (b: Bar) => b.barline === 'repeat-end' || b.barline === 'final' || b.barline === 'double'
  let i = 0
  while (i < bars.length) {
    if (!bars[i]!.ending) {
      i++
      continue
    }
    let len = 1
    while (i + len < bars.length && !bars[i + len]!.ending && !closes(bars[i + len - 1]!)) len++
    for (let k = 0; k < len; k++) map.set(i + k, { label: k === 0 ? bars[i]!.ending : undefined, end: k === len - 1 })
    i += len
  }
  return map
}

/** Jazz shorthand: '^' types easy, 'Δ' reads right on the chart. Display only —
    the stored chord keeps the caret so editing round-trips what was typed.
    A bare '^' (no extension following) reads as Δ7. */
function displayQuality(q: string): string {
  return q.replace(/\^/g, 'Δ').replace(/Δ(?=$|\/)/, 'Δ7')
}

/** Render one chord token with extension as superscript. */
function Chord({ token }: { token: string }) {
  if (!token) return <span className="pct">·</span>
  if (token === '%') return <span className="pct">%</span>
  if (token === 'N.C.') return <span>N.C.</span>
  const p = parseChord(token)
  if (p.nashville) return <span className="nashville">{displayQuality(token)}</span>
  if (!p.root) return <span>{token}</span>
  const bass = p.bass ? '/' + p.bass : ''
  return (
    <span>
      {p.root}
      {p.quality && <span className="ext">{displayQuality(p.quality)}</span>}
      {bass}
    </span>
  )
}

function BarCell({
  bar,
  displayKey,
  transpose,
  nashville,
  showLyrics,
  beatsPerBar,
  volta,
}: {
  bar: Bar
  displayKey: string
  transpose: number
  nashville: boolean
  showLyrics: boolean
  beatsPerBar: number
  volta?: VoltaInfo
}) {
  const useFlats = preferFlats(displayKey)
  const tokens = (bar.chords || '').split(/\s+/).filter(Boolean)

  const rendered: ReactNode[] = tokens.map((tok, i) => {
    let t = tok
    if (transpose) t = transposeChordStr(t, transpose, useFlats)
    if (nashville) t = chordToNashville(t, displayKey)
    return (
      <span key={i} style={{ marginRight: i < tokens.length - 1 ? 7 : 0 }}>
        <Chord token={t} />
      </span>
    )
  })

  const cls = ['bar']
  if (bar.barline && bar.barline !== 'normal') cls.push(bar.barline)

  const engravings = (
    <>
      {volta && (
        <span className={`volta${volta.label ? ' volta-start' : ''}${volta.end ? ' volta-end' : ''}`}>
          {volta.label && <span className="volta-label">{volta.label}</span>}
        </span>
      )}
      {bar.sign && <span className="bar-sign">{bar.sign === 'segno' ? <SegnoIcon /> : <CodaIcon />}</span>}
      {bar.direction && <span className="bar-dir">{bar.direction}</span>}
    </>
  )

  return (
    <div className={cls.join(' ')}>
      {engravings}
      {bar.hits && <HitStaff value={bar.hits} beatsPerBar={beatsPerBar} compact />}
      <span className={`chords${nashville ? ' nashville' : ''}`}>
        {rendered.length ? rendered : <span className="pct">·</span>}
      </span>
      {showLyrics && bar.lyrics && <span className="lyric">{bar.lyrics}</span>}
    </div>
  )
}

/** The order of operations, rendered as a numbered strip above the sections. */
export function Roadmap({ chart, rail = false, marks }: { chart: PublicChart; rail?: boolean; marks?: string[] }) {
  const steps = chart.arrangement ?? []
  if (steps.length === 0) return null
  const mk = marks ?? sectionMarks(chart.sections)
  const byId = new Map(chart.sections.map((s, i) => [s.id, { sec: s, letter: mk[i]! }]))
  if (rail) {
    // stage "flight plan": one step per row, aligned columns, notes never squeezed
    return (
      <ol className="rm-flight">
        {steps.map((step, i) => {
          const info = byId.get(step.sectionId)
          if (!info) return null
          const sub = roadmapNote(step)
          return (
            <li key={step.id} className="rf-row">
              <span className="rf-num">{i + 1}</span>
              <span className={`rf-letter${info.letter.length > 1 ? ' word' : ''}`}>{info.letter}</span>
              <span className="rf-x">
                {step.open ? '∞' : (step.repeats ?? 1) > 1 ? `×${step.repeats}` : ''}
              </span>
              <span className="rf-note">{sub}</span>
            </li>
          )
        })}
      </ol>
    )
  }
  return (
    <div className="roadmap">
      <div className="label">Order of operations</div>
      <ol className="roadmap-steps">
        {steps.map((step) => {
          const info = byId.get(step.sectionId)
          if (!info) return null
          return (
            <li className="roadmap-step" key={step.id}>
              <span className="rm-letter">{info.letter}</span>
              {info.sec.label && <span className="rm-sec">{info.sec.label}</span>}
              {step.open ? (
                <span className="rm-x">∞ till cue</span>
              ) : (
                (step.repeats ?? 1) > 1 && <span className="rm-x">×{step.repeats}</span>
              )}
              {step.solos && step.solos.length > 0 && (
                <span className="rm-solo">solos: {step.solos.join(' · ')}</span>
              )}
              {step.note && <span className="rm-note">{step.note}</span>}
              {step.hits && (
                <span className="rm-hits">
                  <HitStaff value={step.hits} />
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function ChartGrid({ chart, transpose = 0, nashville = false, showLyrics, marks, roadmapRail = false }: Props) {
  const mk = marks ?? sectionMarks(chart.sections)
  const displayKey = transpose
    ? transposedNote(chart.key.replace('m', ''), transpose, preferFlats(chart.key)) + (chart.key.endsWith('m') ? 'm' : '')
    : chart.key
  const lyricsOn = showLyrics ?? chart.settings.showLyrics
  const beatsPerBar = parseInt(chart.time, 10) || 4

  return (
    <div className="chart">
      <Roadmap chart={chart} rail={roadmapRail} marks={mk} />
      {chart.sections.map((section, si) => {
        const bpr = typeof section.barsPerRow === 'number' ? section.barsPerRow : chart.settings.barsPerRow
        const pocket = section.bars.length === 0
        const voltas = voltaSpans(section.bars)
        return (
          <div className={`chart-section${pocket ? ' pocket' : ''}`} key={section.id}>
            <div className="label">
              <span className="sec-letter">{mk[si]}</span>
              {section.label}
            </div>
            {section.description && <div className="section-desc">{section.description}</div>}
            {section.hits && <HitStaff value={section.hits} beatsPerBar={beatsPerBar} />}
            {!pocket && (
              <div className="bar-grid" style={{ ['--bpr' as string]: bpr }}>
                {section.bars.map((bar, bi) => (
                  <BarCell
                    key={bi}
                    bar={bar}
                    displayKey={displayKey}
                    transpose={transpose}
                    nashville={nashville}
                    showLyrics={lyricsOn}
                    beatsPerBar={beatsPerBar}
                    volta={voltas.get(bi)}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
