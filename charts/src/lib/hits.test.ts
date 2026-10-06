import { describe, expect, it } from 'vitest'
import { engraveBar, noteValueAt, parseHits, type EngravedBar } from './hits'

// Compact readout of an engraved bar, one token per written event:
//   r/<value>            a rest (e.g. r/quarter)
//   n/<value>            a note; prefix d = dotted, suffix < tied-from / > tied-to,
//                        (label) present only on the first segment of an attack
// e.g. "n/deighth>(1&)" = dotted-eighth attack "1&" tied into the next note.
function readout(eng: EngravedBar): string[] {
  return eng.events.map((e) => {
    const val = `${e.dotted ? 'd' : ''}${e.base}`
    if (e.kind === 'rest') return `r/${val}`
    return `n/${val}${e.tieEnd ? '<' : ''}${e.tieStart ? '>' : ''}${e.label ? `(${e.label})` : ''}`
  })
}

const engrave = (input: string, beatsPerBar = 4) => engraveBar(parseHits(input, beatsPerBar).bars[0], beatsPerBar)

describe('parseHits  -  beat talk', () => {
  it('parses plain beats', () => {
    expect(parseHits('1 3').bars).toEqual([{ slots: [0, 8] }])
  })
  it('parses subdivisions e & a and + alias', () => {
    expect(parseHits('2e 2& 2a 4+').bars).toEqual([{ slots: [5, 6, 7, 14] }])
  })
  it('splits bars on |', () => {
    expect(parseHits('1 1& 2 | 3 4&').bars).toEqual([{ slots: [0, 2, 4] }, { slots: [8, 14] }])
  })
  it('dedupes and sorts', () => {
    expect(parseHits('4 2 2').bars).toEqual([{ slots: [4, 12] }])
  })
  it('flags junk tokens but keeps good ones', () => {
    const p = parseHits('2& banana 4')
    expect(p.bars).toEqual([{ slots: [6, 12] }])
    expect(p.error).toContain('banana')
  })
  it('rejects out-of-range beats', () => {
    expect(parseHits('5').error).toContain('outside')
  })
  it('empty input → no bars, no error', () => {
    expect(parseHits('  ')).toEqual({ bars: [] })
  })
  it('trailing | does not add a bar', () => {
    expect(parseHits('2& 4 |').bars).toHaveLength(1)
  })
})

describe('parseHits  -  x-grid', () => {
  it('parses with or without spaces', () => {
    expect(parseHits('#..x. .x.. x... ..x.').bars).toEqual([{ slots: [2, 5, 8, 14] }])
    expect(parseHits('#..x..x..x......x').bars).toEqual([{ slots: [2, 5, 8, 15] }])
  })
  it('accepts - as empty and X as hit', () => {
    expect(parseHits('#X--- ---- X--- ----').bars).toEqual([{ slots: [0, 8] }])
  })
  it('splits bars on |', () => {
    expect(parseHits('#x...|..x.').bars).toEqual([{ slots: [0] }, { slots: [2] }])
  })
  it('flags bad cells', () => {
    expect(parseHits('#..q.').error).toContain('"q"')
  })
})

describe('noteValueAt', () => {
  it('on-beat hit with a beat of space = quarter', () => {
    const bar = { slots: [0, 8] }
    expect(noteValueAt(bar, 0)).toBe('quarter')
    expect(noteValueAt(bar, 1)).toBe('quarter')
  })
  it('offbeat or tight spacing = eighth / sixteenth', () => {
    const bar = { slots: [6, 8, 9] } // 2&, 3, 3e
    expect(noteValueAt(bar, 0)).toBe('eighth')     // 2& → next at 8
    expect(noteValueAt(bar, 1)).toBe('sixteenth')  // 3 → next at 9
    expect(noteValueAt(bar, 2)).toBe('eighth')     // 3e → bar end far away but 16th-pos... gap 7 ≥ 2
  })
})

describe('engraveBar  -  note values, rests, ties', () => {
  it('four downbeats = four quarter notes, no rests, no beams', () => {
    const eng = engrave('1 2 3 4')
    expect(readout(eng)).toEqual(['n/quarter(1)', 'n/quarter(2)', 'n/quarter(3)', 'n/quarter(4)'])
    expect(eng.beams).toEqual([])
  })

  it('"2& 4": the and-of-2 held to beat 4 is eighth tied to quarter (never a dotted value across the midpoint)', () => {
    const eng = engrave('2& 4')
    expect(readout(eng)).toEqual([
      'r/quarter', // beat 1
      'r/eighth', // and-of-1... the "e/&" of beat 2 leading in
      'n/eighth>(2&)', // attack on 2&, tied over the barline midpoint
      'n/quarter<', // continuation into beat 3 (no label)
      'n/quarter(4)',
    ])
    // only the lone eighth is beamable and it is isolated → it keeps a flag
    expect(eng.beams).toEqual([])
  })

  it('empty bar = a single whole rest', () => {
    const eng = engraveBar({ slots: [] })
    expect(readout(eng)).toEqual(['r/whole'])
  })

  it('leading rest reveals beat 3 (half rest for beats 1-2, then quarter rest)', () => {
    const eng = engrave('4') // lone hit on beat 4
    expect(readout(eng)).toEqual(['r/half', 'r/quarter', 'n/quarter(4)'])
  })

  it('on-beat 3-beat note = a single dotted half note', () => {
    const eng = engrave('1 4') // beat 1 rings through beat 3, then beat 4
    expect(readout(eng)).toEqual(['n/dhalf(1)', 'n/quarter(4)'])
  })

  it('"+" is an alias for "&": "4 4+" engraves like "4 4&" and labels read "&", not "+"', () => {
    expect(readout(engrave('4 4+'))).toEqual(readout(engrave('4 4&')))
    expect(readout(engrave('4 4+'))).toEqual(['r/half', 'r/quarter', 'n/eighth(4)', 'n/eighth(4&)'])
  })
})

describe('engraveBar  -  beaming', () => {
  it('offbeat eighths "1& 2& 3& 4&" beam per half, tied across each beat, never across the midpoint', () => {
    const eng = engrave('1& 2& 3& 4&')
    expect(readout(eng)).toEqual([
      'r/eighth',
      'n/eighth>(1&)',
      'n/eighth<',
      'n/eighth>(2&)',
      'n/eighth<',
      'n/eighth>(3&)',
      'n/eighth<',
      'n/eighth(4&)',
    ])
    // two beams: eighths of the first half (3 members), eighths of the second half (4)
    expect(eng.beams.map((b) => b.members.length)).toEqual([3, 4])
    // no beam spans the 4/4 midpoint
    for (const b of eng.beams) {
      const halves = new Set(b.members.map((i) => Math.floor(eng.events[i].onset / 8)))
      expect(halves.size).toBe(1)
    }
  })

  it('x-grid "& of each beat" engraves identically to the beat-talk version', () => {
    expect(parseHits('#..x. ..x. ..x. ..x.').bars).toEqual([{ slots: [2, 6, 10, 14] }])
    expect(readout(engrave('#..x. ..x. ..x. ..x.'))).toEqual(readout(engrave('1& 2& 3& 4&')))
  })

  it('16th figure "#..x. .x.. x... ..x." mixes ties, a dotted quarter, and a partial-beamed group', () => {
    const eng = engrave('#..x. .x.. x... ..x.') // slots 2, 5, 8, 14
    expect(readout(eng)).toEqual([
      'r/eighth',
      'n/eighth>(1&)',
      'n/sixteenth<',
      'n/sixteenth>(2e)',
      'n/eighth<',
      'n/dquarter(3)', // beat 3 rings to the and-of-4 → dotted quarter
      'n/eighth(4&)',
    ])
    // the 16th+16th+8th inside beat 2 form one beam (secondary beam over the two 16ths)
    expect(eng.beams.map((b) => b.members.length)).toEqual([3])
  })

  it('straight eighths across beats 1-2 share one beam (spanning the beat boundary, not the midpoint)', () => {
    const eng = engrave('1 1& 2 2&') // slots 0,2,4,6  -  four eighths; the last rings on to bar end
    expect(readout(eng)).toEqual(['n/eighth(1)', 'n/eighth(1&)', 'n/eighth(2)', 'n/eighth>(2&)', 'n/half<'])
    // the four eighths of the first half beam together; the tied half (beats 3-4) is not beamable
    expect(eng.beams.map((b) => b.members.length)).toEqual([4])
    const halves = new Set(eng.beams[0].members.map((i) => Math.floor(eng.events[i].onset / 8)))
    expect(halves.size).toBe(1)
  })
})

describe('engraveBar  -  3/4', () => {
  it('no midpoint rule: a dotted quarter on beat 1 is allowed, beams stay per beat', () => {
    const eng = engrave('1 2& 3', 3) // slots 0, 6, 8
    expect(readout(eng)).toEqual(['n/dquarter(1)', 'n/eighth(2&)', 'n/quarter(3)'])
    // the lone eighth is isolated → flag, no beam
    expect(eng.beams).toEqual([])
  })

  it('a whole bar of straight eighths beams per beat (three beams of two), not across beats', () => {
    const eng = engrave('1 1& 2 2& 3 3&', 3) // slots 0,2,4,6,8,10
    expect(eng.beams.map((b) => b.members.length)).toEqual([2, 2, 2])
  })
})
