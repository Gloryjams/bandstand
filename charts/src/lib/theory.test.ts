import { describe, expect, it } from 'vitest'
import { chordToNashville, extractHitsFromChords, getChordNotes, normalizeChordInput, parseChord, transposeChartForPart, transposeChordStr, writtenKey } from './theory'

describe('writtenKey (instrument parts)', () => {
  it('computes written keys for standard transpositions', () => {
    expect(writtenKey('Bbm', 9)).toBe('Gm') // Eb alto: Bbm concert reads Gm
    expect(writtenKey('D', 9)).toBe('B') // Eb alto: D concert reads B
    expect(writtenKey('C', 2)).toBe('D') // Bb tenor/trumpet
    expect(writtenKey('Eb', 2)).toBe('F')
    expect(writtenKey('C', 7)).toBe('G') // F horn
    expect(writtenKey('F', 0)).toBe('F') // concert unchanged
  })
})

describe('jazz shorthand qualities', () => {
  it('parses ^7 as a quality on the root', () => {
    expect(parseChord('C^7')).toMatchObject({ root: 'C', quality: '^7', bass: '' })
    expect(parseChord('Bb^')).toMatchObject({ root: 'Bb', quality: '^' })
    expect(parseChord('A-7')).toMatchObject({ root: 'A', quality: '-7' })
  })

  it('resolves chord tones for caret and dash qualities', () => {
    expect(getChordNotes('C^7')?.notes).toEqual(['C', 'E', 'G', 'B'])
    expect(getChordNotes('C^')?.notes).toEqual(['C', 'E', 'G', 'B'])
    expect(getChordNotes('C^9')?.notes).toEqual(['C', 'E', 'G', 'B', 'D'])
    expect(getChordNotes('A-7')?.notes).toEqual(['A', 'C', 'E', 'G'])
  })

  it('transposes shorthand chords preserving the quality as typed', () => {
    expect(transposeChordStr('C^7', 2, false)).toBe('D^7')
    expect(transposeChordStr('A-7', 3, true)).toBe('C-7')
    expect(transposeChordStr('F^7#11/A', 2, false)).toBe('G^7#11/B')
  })

  it('keeps shorthand in Nashville display', () => {
    expect(chordToNashville('C^7', 'C')).toBe('1^7')
    expect(chordToNashville('A-7', 'C')).toBe('6-7')
  })
})

describe('extractHitsFromChords', () => {
  it('peels beat tokens out of the chord stream', () => {
    expect(extractHitsFromChords('% 4 4+')).toEqual({ chords: '%', hits: '4 4&' })
    expect(extractHitsFromChords('Bb^7 2& 4')).toEqual({ chords: 'Bb^7', hits: '2& 4' })
    expect(extractHitsFromChords('4 4+')).toEqual({ chords: '', hits: '4 4&' })
  })
  it('translates + (push) to &', () => {
    expect(extractHitsFromChords('C7 1+ 3+')).toEqual({ chords: 'C7', hits: '1& 3&' })
  })
  it('leaves bare Nashville numbers alone', () => {
    expect(extractHitsFromChords('1 4 5')).toEqual({ chords: '1 4 5' })
    expect(extractHitsFromChords('4')).toEqual({ chords: '4' })
  })
})

describe('transposeChartForPart', () => {
  it('rewrites key and chords for the written part without touching the original', () => {
    const chart = {
      key: 'Bbm',
      sections: [{ bars: [{ chords: 'Bb-7 Eb-7' }, { chords: 'Db^7/Ab' }] }],
    }
    const eb = transposeChartForPart(chart, 9)
    expect(eb.key).toBe('Gm')
    expect(eb.sections[0].bars[0].chords).toBe('G-7 C-7')
    expect(eb.sections[0].bars[1].chords).toBe('Bb^7/F')
    expect(chart.sections[0].bars[0].chords).toBe('Bb-7 Eb-7')
    expect(transposeChartForPart(chart, 0)).toBe(chart)
  })
})

describe('normalizeChordInput', () => {
  it('capitalizes roots but preserves flats and qualities', () => {
    expect(normalizeChordInput('bb7')).toBe('Bb7')
    expect(normalizeChordInput('eb^7')).toBe('Eb^7')
    expect(normalizeChordInput('a-7/g')).toBe('A-7/G')
    expect(normalizeChordInput('f#-7b5')).toBe('F#-7b5')
    expect(normalizeChordInput('c^7 a-7 d-7 g7')).toBe('C^7 A-7 D-7 G7')
    expect(normalizeChordInput('b')).toBe('B')
    expect(normalizeChordInput('gsus')).toBe('Gsus')
  })
})
