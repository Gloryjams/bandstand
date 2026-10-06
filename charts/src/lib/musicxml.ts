import type { Chart, Section } from '@/types'
import { parseChord } from './theory'
import { engraveBar, parseHits, type EngravedBar, type NoteEvent, type RhythmEvent } from './hits'
import { navDecorations, afterText, type SectionNavDecor } from './navdecor'
import { sectionMarks } from '@/components/ChartGrid'

// Chart → MusicXML (score-partwise 3.1). The formatting decisions here ARE the
// house style: chord symbols over slash notation on a single rhythm staff,
// rehearsal marks per section, auto repeat barlines with ×N, voltas, signs,
// and hit figures engraved as real notated rhythms (values/dots/ties from
// lib/hits.ts). MuseScore is today's renderer; the target is our own engine,
// so keep everything explicit and deliberate.

const DIV = 4 // divisions per quarter → 16th resolution, matches hits.ts ticks

/** Map a chord quality string to a MusicXML harmony kind (+ display text). */
function kindOf(quality: string): { kind: string; text: string } {
  const q = quality.replace(/\^/g, 'Δ')
  const table: [RegExp, string][] = [
    [/^(Δ13)/, 'major-13th'],
    [/^(Δ9)/, 'major-ninth'],
    [/^(Δ7?|maj7|M7)/, 'major-seventh'],
    [/^(m13|-13|min13)/, 'minor-13th'],
    [/^(m11|-11|min11)/, 'minor-11th'],
    [/^(m9|-9|min9)/, 'minor-ninth'],
    [/^(m7b5|-7b5)/, 'half-diminished'],
    [/^(m7|-7|min7)/, 'minor-seventh'],
    [/^(m6|-6)/, 'minor-sixth'],
    [/^(madd9|-add9)/, 'minor'],
    [/^(m|-|min)(?![a-z])/, 'minor'],
    [/^13/, 'dominant-13th'],
    [/^11/, 'dominant-11th'],
    [/^9/, 'dominant-ninth'],
    [/^7sus/, 'suspended-fourth'],
    [/^7/, 'dominant'],
    [/^6/, 'major-sixth'],
    [/^dim7|^o7/, 'diminished-seventh'],
    [/^dim|^o/, 'diminished'],
    [/^aug|^\+/, 'augmented'],
    [/^sus2/, 'suspended-second'],
    [/^sus4?/, 'suspended-fourth'],
    [/^add9/, 'major'],
    [/^$/, 'major'],
  ]
  for (const [re, kind] of table) if (re.test(q)) return { kind, text: q }
  return { kind: 'other', text: q }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function splitNote(note: string): { step: string; alter: number } {
  const step = note.charAt(0).toUpperCase()
  const alter = note.includes('#') ? 1 : note.includes('b') ? -1 : 0
  return { step, alter }
}

/** Circle-of-fifths position for the key signature. */
function fifthsOf(key: string): number {
  const majors: Record<string, number> = {
    C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
    F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
  }
  const minors: Record<string, number> = {
    Am: 0, Em: 1, Bm: 2, 'F#m': 3, 'C#m': 4, 'G#m': 5, 'D#m': 6,
    Dm: -1, Gm: -2, Cm: -3, Fm: -4, Bbm: -5, Ebm: -6, Abm: -7,
  }
  return key.endsWith('m') ? (minors[key] ?? 0) : (majors[key] ?? 0)
}

function harmonyXml(token: string, offsetDiv: number): string {
  const p = parseChord(token)
  if (!p.root) return ''
  const { step, alter } = splitNote(p.root)
  const { kind, text } = kindOf(p.quality)
  const bass = p.bass
    ? (() => {
        const b = splitNote(p.bass)
        return `<bass><bass-step>${b.step}</bass-step>${b.alter ? `<bass-alter>${b.alter}</bass-alter>` : ''}</bass>`
      })()
    : ''
  return `<harmony placement="above">
  <root><root-step>${step}</root-step>${alter ? `<root-alter>${alter}</root-alter>` : ''}</root>
  <kind text="${esc(text)}">${kind}</kind>
  ${bass}${offsetDiv > 0 ? `\n  <offset>${offsetDiv}</offset>` : ''}
</harmony>`
}

const BASE_TYPE: Record<string, string> = {
  whole: 'whole', half: 'half', quarter: 'quarter', eighth: 'eighth', sixteenth: '16th',
}

/** Middle-line slash pitch that agrees with the key signature: in flat keys the
    middle line is Bb, so alter -1  -  otherwise every slash grows a natural sign. */
function slashPitch(fifths: number): string {
  return `<pitch><step>B</step>${fifths <= -1 ? '<alter>-1</alter>' : ''}<octave>4</octave></pitch>`
}

/** A slash-notehead note on the middle line. */
function noteXml(ev: RhythmEvent, fifths: number, opts: { slash: boolean } = { slash: true }): string {
  const dur = ev.dur * (DIV / 4) // hits.ts ticks are 16ths; DIV=4 → same number
  const dot = ev.dotted ? '<dot/>' : ''
  if (ev.kind === 'rest') {
    return `<note><rest/><duration>${dur}</duration><type>${BASE_TYPE[ev.base]}</type>${dot}</note>`
  }
  const n = ev as NoteEvent
  const ties = `${n.tieStart ? '<tie type="start"/>' : ''}${n.tieEnd ? '<tie type="stop"/>' : ''}`
  const tied = `${n.tieEnd ? '<tied type="stop"/>' : ''}${n.tieStart ? '<tied type="start"/>' : ''}`
  const notations = tied ? `<notations>${tied}</notations>` : ''
  return `<note>
  ${slashPitch(fifths)}
  <duration>${dur}</duration>${ties}
  <type>${BASE_TYPE[n.base]}</type>${dot}
  ${opts.slash ? '<notehead>slash</notehead>' : ''}
  ${notations}
</note>`
}

/** Whole-bar comping: one beat-slash per beat (the standard rhythm-section bar). */
function compingXml(beats: number, fifths: number): string {
  return Array.from({ length: beats }, () =>
    `<note>${slashPitch(fifths)}<duration>${DIV}</duration><type>quarter</type><notehead>slash</notehead><stem>none</stem></note>`,
  ).join('\n')
}

function direction(words: string, opts: { italic?: boolean; placement?: string } = {}): string {
  return `<direction placement="${opts.placement ?? 'above'}"><direction-type><words${opts.italic ? ' font-style="italic"' : ''}>${esc(words)}</words></direction-type></direction>`
}

/** One section's measures. */
function sectionXml(
  section: Section,
  mark: string,
  beats: number,
  measureNo: { n: number },
  isFirst: boolean,
  chart: Chart,
  decor?: SectionNavDecor,
): string {
  const out: string[] = []
  const reps = section.repeats ?? 1
  const bars = section.bars.length > 0 ? section.bars : [{ chords: '', lyrics: '', barline: 'normal' as const }]
  // layout rulebook: rehearsal marks own their line; systems break on phrase
  // boundaries (the chart's bars-per-row IS the tune's phrasing)
  const bpr = typeof section.barsPerRow === 'number' ? section.barsPerRow : chart.settings.barsPerRow

  bars.forEach((bar, bi) => {
    const attrs: string[] = []
    const breakHere = !isFirst || bi > 0 ? (bi === 0 || (bpr > 0 && bi % bpr === 0)) : false
    if (isFirst && bi === 0) {
      attrs.push(`<attributes>
  <divisions>${DIV}</divisions>
  <key><fifths>${fifthsOf(chart.key)}</fifths><mode>${chart.key.endsWith('m') ? 'minor' : 'major'}</mode></key>
  <time><beats>${beats}</beats><beat-type>${parseInt(chart.time.split('/')[1] ?? '4', 10) || 4}</beat-type></time>
  <clef><sign>G</sign><line>2</line></clef>
</attributes>`)
      if (chart.bpm) {
        attrs.push(
          `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${esc(chart.bpm)}</per-minute></metronome></direction-type></direction>`,
        )
      }
      if (chart.style) attrs.push(direction(chart.style, { italic: true }))
    }

    const pieces: string[] = [`<measure number="${measureNo.n++}">`]
    if (breakHere) pieces.push('<print new-system="yes"/>')

    // barlines: explicit bar barlines win; section repeats and derived
    // navigation (roadmap compiler) auto-wrap
    const plain = !bar.barline || bar.barline === 'normal'
    const lastBar = bi === bars.length - 1
    const openRepeat =
      bar.barline === 'repeat-start' || (bi === 0 && plain && (reps > 1 || decor?.repeatStart === true))
    const closeRepeat =
      bar.barline === 'repeat-end' || (lastBar && plain && (reps > 1 || (decor?.repeatEnd ?? 0) > 1))
    const closeTimes = reps > 1 ? reps : decor?.repeatEnd ?? 2

    const voltaNum = decor?.volta ? decor.volta.label.replace(/\D+/g, ' ').trim().split(/\s+/).join(',') || '1' : ''
    if (decor?.volta?.first && bi === 0) {
      pieces.push(`<barline location="left"><ending number="${voltaNum}" type="start">${esc(decor.volta.label)}</ending></barline>`)
    }
    if (openRepeat) pieces.push('<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>')
    pieces.push(...attrs)
    if (bi === 0 && decor?.segno) pieces.push('<direction placement="above"><direction-type><segno/></direction-type></direction>')
    if (bi === 0 && decor?.coda) pieces.push('<direction placement="above"><direction-type><coda/></direction-type></direction>')

    if (bi === 0) {
      // rehearsal mark + section label
      pieces.push(
        `<direction placement="above"><direction-type><rehearsal>${esc(mark)}</rehearsal></direction-type></direction>`,
      )
      if (section.label && !/^[A-Z]$/.test(mark)) {
        // functional sections (IN/OUT/CODA) keep their word as the mark itself
      } else if (section.label) {
        pieces.push(direction(section.label, { italic: true }))
      }
      if (section.description) pieces.push(direction(section.description, { italic: true }))
      if (section.hits) pieces.push(direction(`hits: ${section.hits}`, { italic: true }))
    }

    // navigation engravings on the bar
    if (bar.sign === 'segno') pieces.push('<direction placement="above"><direction-type><segno/></direction-type></direction>')
    if (bar.sign === 'coda') pieces.push('<direction placement="above"><direction-type><coda/></direction-type></direction>')
    if (bar.direction) pieces.push(direction(bar.direction, { italic: true, placement: 'above' }))
    if (bar.ending) pieces.push(`<barline location="left"><ending number="${esc(bar.ending.replace(/\D/g, '') || '1')}" type="start">${esc(bar.ending)}</ending></barline>`)

    // harmony: chords spread across the bar (n chords → even beat offsets)
    const tokens = (bar.chords || '').split(/\s+/).filter((t) => t && t !== '%')
    tokens.forEach((tok, ti) => {
      const offset = Math.floor((ti * beats) / Math.max(1, tokens.length)) * DIV
      const h = harmonyXml(tok, offset)
      if (h) pieces.push(h)
    })

    // rhythm content: engraved hits if present, else beat slashes
    const fifths = fifthsOf(chart.key)
    if (bar.hits) {
      const parsed = parseHits(bar.hits, beats)
      const eng: EngravedBar | null = parsed.bars.length > 0 ? engraveBar(parsed.bars[0], beats) : null
      if (eng) pieces.push(...eng.events.map((ev) => noteXml(ev, fifths)))
      else pieces.push(compingXml(beats, fifths))
    } else {
      pieces.push(compingXml(beats, fifths))
    }

    const endTxt = lastBar ? afterText(decor) : ''
    if (endTxt) pieces.push(direction(endTxt, { italic: true }))

    const endBits: string[] = []
    if (bar.ending && (bar.barline === 'repeat-end' || closeRepeat)) {
      endBits.push(`<ending number="${esc(bar.ending.replace(/\D/g, '') || '1')}" type="stop"/>`)
    }
    if (decor?.volta?.last && lastBar) {
      endBits.push(`<ending number="${voltaNum}" type="stop"/>`)
    }
    if (closeRepeat) {
      if (closeTimes > 2) pieces.push(direction(`×${closeTimes}`, { placement: 'above' }))
      pieces.push(
        `<barline location="right"><bar-style>light-heavy</bar-style>${endBits.join('')}<repeat direction="backward"${closeTimes > 2 ? ` times="${closeTimes}"` : ''}/></barline>`,
      )
    } else if (decor?.volta?.last && lastBar) {
      pieces.push(`<barline location="right"><bar-style>light-light</bar-style>${endBits.join('')}</barline>`)
    } else if (bar.barline === 'double') {
      pieces.push('<barline location="right"><bar-style>light-light</bar-style></barline>')
    } else if (bar.barline === 'final') {
      pieces.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>')
    } else if (bi === bars.length - 1) {
      pieces.push('<barline location="right"><bar-style>light-light</bar-style></barline>')
    }

    pieces.push('</measure>')
    out.push(pieces.join('\n'))
  })
  return out.join('\n')
}

/** Serialize a chart as a complete MusicXML score-partwise document. */
export function chartToMusicXML(chart: Chart, opts: { partLabel?: string } = {}): string {
  const beats = parseInt(chart.time, 10) || 4
  const marks = sectionMarks(chart.sections)
  const measureNo = { n: 1 }
  const nav = chart.settings.classicNav !== false ? navDecorations(chart) : null
  const body = chart.sections
    .map((sec, si) => sectionXml(sec, marks[si] ?? '?', beats, measureNo, si === 0, chart, nav?.decors[si]))
    .join('\n')

  const form =
    chart.arrangement && chart.arrangement.length > 0
      ? chart.arrangement
          .map((st) => {
            const i = chart.sections.findIndex((s) => s.id === st.sectionId)
            const letter = i >= 0 ? marks[i] : '?'
            const x = st.open ? '(till cue)' : (st.repeats ?? 1) > 1 ? `x${st.repeats}` : ''
            const extra = [x, st.solos?.length ? `solos: ${st.solos.join(', ')}` : '', st.note ?? '']
              .filter(Boolean)
              .join(' ')
            return extra ? `${letter} ${extra}` : letter
          })
          .join('  ·  ')
      : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>${esc(chart.title || 'Untitled')}</work-title></work>
  <identification>
    <creator type="composer">${esc(chart.artist || '')}</creator>
    <encoding><software>Saltycharts</software></encoding>
  </identification>
  <defaults>
    <scaling><millimeters>7.05556</millimeters><tenths>40</tenths></scaling>
    <page-layout>
      <page-height>1697.14</page-height><page-width>1200</page-width>
      <page-margins type="both">
        <left-margin>85.72</left-margin><right-margin>85.72</right-margin>
        <top-margin>85.72</top-margin><bottom-margin>85.72</bottom-margin>
      </page-margins>
    </page-layout>
  </defaults>
  <credit page="1"><credit-words default-x="600" default-y="1611" justify="center" valign="top" font-size="22" font-weight="bold">${esc(chart.title || 'Untitled')}</credit-words></credit>
  ${chart.artist ? `<credit page="1"><credit-words default-x="1114" default-y="1500" justify="right" valign="top" font-size="11">${esc(chart.artist)}</credit-words></credit>` : ''}
  ${opts.partLabel ? `<credit page="1"><credit-words default-x="86" default-y="1500" justify="left" valign="top" font-size="12" font-weight="bold">${esc(opts.partLabel)}</credit-words></credit>` : ''}
  ${form ? `<credit page="1"><credit-words default-x="86" default-y="45" justify="left" valign="bottom" font-size="8">Form: ${esc(form)}</credit-words></credit>` : ''}
  <part-list>
    <score-part id="P1"><part-name print-object="no">Rhythm</part-name></score-part>
  </part-list>
  <part id="P1">
${body}
  </part>
</score-partwise>`
}
