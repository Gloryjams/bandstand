import { describe, expect, it } from 'vitest'
import { convertChord, looksLikeIReal, parseIReal, unscramble } from './irealImport'
describe('unscramble', () => {
  it('is an involution (scramble == unscramble)', () => {
    const plain = 'A'.repeat(37) + 'B'.repeat(50) + 'C'.repeat(23)
    expect(unscramble(unscramble(plain))).toBe(plain)
  })

  it('passes short strings through untouched', () => {
    expect(unscramble('T44C^7|F7|')).toBe('T44C^7|F7|')
  })
})

describe('convertChord', () => {
  it('keeps native jazz shorthand verbatim', () => {
    expect(convertChord('C^7', null)).toBe('C^7')
    expect(convertChord('A-7', null)).toBe('A-7')
    expect(convertChord('G7#9', null)).toBe('G7#9')
    expect(convertChord('Bb7sus', null)).toBe('Bb7sus')
    expect(convertChord('Eo7', null)).toBe('Eo7')
    expect(convertChord('F#/A', null)).toBe('F#/A')
  })

  it('respells half-diminished h as m7b5', () => {
    expect(convertChord('Bh7', null)).toBe('Bm7b5')
    expect(convertChord('Bh', null)).toBe('Bm7b5')
  })

  it('resolves invisible-root W against the previous chord', () => {
    expect(convertChord('W/D', 'E')).toBe('E/D')
    expect(convertChord('W/C', null)).toBe('C')
    expect(convertChord('W', 'E')).toBe(null)
  })
})

describe('parseIReal synthetic playlist', () => {
  const makeSong = (title: string, music: string) =>
    `${title}=Practice Composer=Medium Swing=C=0=1r34LbKcu7${unscramble(music)}=Swing=140=0`
  const url = `irealb://${encodeURIComponent([
    makeSong('Practice A', 'T34C^7XyQ|D-7XyQ|G7XyQZ'),
    makeSong('Practice B', 'T44A-7XyQ|D-7XyQ|E7XyQZ'),
    'Practice playlist',
  ].join('==='))}`
  const result = parseIReal(`<a href="${url}">Practice</a>`)

  it('reads multiple charts, playlist and nine-field metadata', () => {
    expect(result.charts).toHaveLength(2)
    expect(result.playlistName).toBe('Practice playlist')
    expect(result.charts[0]).toMatchObject({
      title: 'Practice A', artist: 'Practice Composer', key: 'C',
      style: 'Medium Swing', bpm: '140', time: '3/4',
    })
    expect(result.charts[0]!.sections[0]!.bars.map((bar) => bar.chords))
      .toEqual(['C^7', 'D-7', 'G7'])
    expect(result.charts.every((chart) => chart.sections.some((section) => section.bars.length)))
      .toBe(true)
  })
})

describe('parseIReal structural tokens (hand-built, scrambled with the involution)', () => {
  const plain =
    '[*AT44C^7XyQ|A-7XyQ|D-7XyQ|G7XyQ]*B{D-7XyQ|G7XyQ|N1C^7XyQ}|N2C^7XyQZ*CSC7XyQ|F7XyQQC^7XyQZ'
  // pad to force at least one full 50-char scrambled chunk
  const padded = plain + 'XyQ'.repeat(20)
  const url = `irealb://${encodeURIComponent(
    `My Tune=Composer Some=Bossa Nova=A-==1r34LbKcu7${unscramble(padded)}=120=0`,
  )}`
  const chart = parseIReal(`<a href="${url}">x</a>`).charts[0]!

  it('maps sections, minor key, and metadata', () => {
    expect(chart.key).toBe('Am')
    expect(chart.time).toBe('4/4')
    expect(chart.sections.map((s) => s.label)).toEqual(['A', 'B', 'C'])
  })

  it('maps repeats, voltas, and signs onto the Bar model', () => {
    const [a, b, c] = chart.sections
    expect(a!.bars.map((x) => x.chords)).toEqual(['C^7', 'A-7', 'D-7', 'G7'])
    expect(a!.bars[3]!.barline).toBe('double')

    expect(b!.bars[0]!.barline).toBe('repeat-start')
    expect(b!.bars[2]!.ending).toBe('1.')
    expect(b!.bars[2]!.barline).toBe('repeat-end')
    expect(b!.bars[3]!.ending).toBe('2.')
    expect(b!.bars[3]!.barline).toBe('final')

    expect(c!.bars[0]!.sign).toBe('segno')
    expect(c!.bars[2]!.sign).toBe('coda')
  })
})

describe('looksLikeIReal', () => {
  it('detects both protocols and rejects plain chord sheets', () => {
    expect(looksLikeIReal('blah irealb://abc')).toBe(true)
    expect(looksLikeIReal('irealbook://abc')).toBe(true)
    expect(looksLikeIReal('Verse:\nC G Am F')).toBe(false)
  })
})
