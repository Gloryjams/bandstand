import { describe, expect, it } from 'vitest'
import type { ArrangementStep, Chart, Section } from '../types'
import {
  compileNavigation,
  describeNavPlan,
  playbackOf,
  roadmapSequence,
  type NavPlan,
} from './navigation'

// --- fixtures -------------------------------------------------------------

/** Build a chart from a page (section ids, in page order) and a roadmap. Each
    roadmap entry is `"A"` (once) or `["A", 3]` (repeats:3) or `["A", "open"]`. */
function chart(
  pageIds: string[],
  roadmap: Array<string | [string, number | 'open']>,
): Chart {
  const sections: Section[] = pageIds.map((id) => ({ id, label: id, bars: [] }))
  const arrangement: ArrangementStep[] = roadmap.map((entry, i) => {
    const [sectionId, mod] = Array.isArray(entry) ? entry : [entry, undefined]
    const step: ArrangementStep = { id: `step_${i}`, sectionId }
    if (mod === 'open') step.open = true
    else if (typeof mod === 'number') step.repeats = mod
    return step
  })
  return {
    id: 'test',
    title: '',
    artist: '',
    key: 'C',
    time: '4/4',
    bpm: '',
    style: '',
    capo: '',
    sections,
    arrangement,
    settings: { barsPerRow: 4, fontSize: 'medium', showLyrics: false, onePage: true },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

/** Ids of the first `n` encoded steps' worth of playback (n derived from leftovers). */
function encodedIdLen(plan: NavPlan, c: Chart): number {
  const { counts } = roadmapSequence(c)
  const firstLeftover = plan.leftoverSteps.length ? Math.min(...plan.leftoverSteps) : counts.length
  return counts.slice(0, firstLeftover).reduce((a, b) => a + b, 0)
}

/** The central invariant: playback matches the roadmap for every encoded step. */
function assertRoundTrip(c: Chart): NavPlan {
  const plan = compileNavigation(c)
  const { seq } = roadmapSequence(c)
  const played = playbackOf(plan, c)
  const enc = encodedIdLen(plan, c)
  expect(played.slice(0, enc)).toEqual(seq.slice(0, enc))
  if (plan.representable) {
    expect(plan.leftoverSteps).toEqual([])
    expect(played).toEqual(seq)
  }
  return plan
}

// --- roadmap expansion ----------------------------------------------------

describe('roadmapSequence', () => {
  it('absent arrangement plays top to bottom, once each', () => {
    const c = chart(['A', 'B', 'C'], [])
    expect(roadmapSequence(c).seq).toEqual(['A', 'B', 'C'])
  })
  it('expands step repeats but not open/solos into extra occurrences', () => {
    const c = chart(['A', 'B'], [['A', 3], ['B', 'open']])
    expect(roadmapSequence(c).seq).toEqual(['A', 'A', 'A', 'B'])
  })
})

// --- pure linear ----------------------------------------------------------

describe('pure-linear charts', () => {
  it('encodes with no annotations', () => {
    const c = chart(['IN', 'A', 'B', 'OUT'], ['IN', 'A', 'B', 'OUT'])
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(true)
    expect(plan.plays.size).toBe(0)
    expect(plan.repeats).toEqual([])
    expect(plan.directive).toBeUndefined()
  })
  it('absent arrangement is trivially representable', () => {
    const c = chart(['A', 'B', 'C'], [])
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(true)
    expect(describeNavPlan(plan, c)).toBe('Play top to bottom')
  })
  it('empty chart (no sections) is representable', () => {
    const c = chart([], [])
    const plan = compileNavigation(c)
    expect(plan.representable).toBe(true)
    expect(playbackOf(plan, c)).toEqual([])
  })
})

// --- single-section vamp --------------------------------------------------

describe('single section vamped', () => {
  it('[A,A,A,A] compiles to plays ×4', () => {
    const c = chart(['A'], [['A', 4]])
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(true)
    expect(plan.plays.get('A')).toBe(4)
    expect(plan.repeats).toEqual([])
  })
  it('folds four separate single steps identically', () => {
    const c = chart(['A'], ['A', 'A', 'A', 'A'])
    const plan = assertRoundTrip(c)
    expect(plan.plays.get('A')).toBe(4)
  })
})

// --- AABA / D.C. al Fine --------------------------------------------------

describe('AABA head (D.C. al Fine)', () => {
  // Page [A, B]; roadmap A A B A. Play A twice, B, then D.C. al Fine back to the
  // top with Fine after the first A.
  const c = chart(['A', 'B'], ['A', 'A', 'B', 'A'])

  it('round-trips fully', () => {
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(true)
  })
  it('emits plays ×2, D.C. al Fine, and Fine at A', () => {
    const plan = compileNavigation(c)
    expect(plan.plays.get('A')).toBe(2)
    expect(plan.directive?.text).toBe('D.C. al Fine')
    expect(plan.directive?.afterSection).toBe(1) // after B
    expect(plan.fineAfterSection).toBe(0) // Fine at A
    expect(plan.segnoAtSection).toBeUndefined() // D.C. has no segno
  })
})

// --- repeat span + D.S. al Coda ------------------------------------------

describe('[IN,A,B,A,B,C,B,OUT]  -  repeat span + D.S. al Coda', () => {
  const c = chart(['IN', 'A', 'B', 'C', 'OUT'], ['IN', 'A', 'B', 'A', 'B', 'C', 'B', 'OUT'])

  it('round-trips fully', () => {
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(true)
  })
  it('emits the expected classic structure', () => {
    const plan = compileNavigation(c)
    expect(plan.repeats).toEqual([{ from: 1, to: 2, times: 2 }]) // Repeat A-B ×2
    expect(plan.segnoAtSection).toBe(2) // segno at B
    expect(plan.toCodaAfterSection).toBe(2) // To Coda after B
    expect(plan.codaAtSection).toBe(4) // Coda = OUT
    expect(plan.directive?.text).toBe('D.S. al Coda')
    expect(plan.directive?.afterSection).toBe(3) // after C
  })
  it('describes readably', () => {
    const plan = compileNavigation(c)
    expect(describeNavPlan(plan, c)).toContain('Repeat A-B ×2')
    expect(describeNavPlan(plan, c)).toContain('D.S. al Coda after C')
    expect(describeNavPlan(plan, c)).toContain('Coda = OUT')
  })
})

// --- voltas ---------------------------------------------------------------

describe('volta [A,B,A,C] with B and C page-adjacent', () => {
  const c = chart(['A', 'B', 'C'], ['A', 'B', 'A', 'C'])

  it('round-trips fully via 1st/2nd endings', () => {
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(true)
  })
  it('emits a repeat span with two endings', () => {
    const plan = compileNavigation(c)
    expect(plan.repeats).toHaveLength(1)
    const span = plan.repeats[0]
    expect(span.from).toBe(0)
    expect(span.to).toBe(2)
    expect(span.times).toBe(2)
    expect(span.endings).toEqual([
      { sections: [1], passes: [1] },
      { sections: [2], passes: [2] },
    ])
  })
})

describe('volta [A,B,A,C] where the endings are NOT page-orderable', () => {
  // Page order [A, C, B]: the 2nd ending (C) sits BEFORE the 1st (B) on the page,
  // so neither a volta nor a forward al-Coda can encode it. Must degrade, never
  // emit a wrong volta.
  const c = chart(['A', 'C', 'B'], ['A', 'B', 'A', 'C'])

  it('degrades gracefully (partial, correct)', () => {
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(false)
    expect(plan.repeats).toEqual([]) // no bogus volta
    expect(plan.leftoverSteps.length).toBeGreaterThan(0)
  })
})

describe('non-adjacent endings rescued by al Coda', () => {
  // Page [A, B, M, C]: a section M sits between the endings, but the 2nd ending C
  // is still forward of the shared body, so D.C. al Coda linearizes it.
  const c = chart(['A', 'B', 'M', 'C'], ['A', 'B', 'A', 'C'])
  it('round-trips fully through a coda jump', () => {
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(true)
    expect(plan.codaAtSection).toBe(3)
  })
})

// --- Love Celebration: partial encoding -----------------------------------

describe('Love Celebration [IN,A,B,A,B,C,A,A,B]  -  partial encoding', () => {
  const c = chart(['IN', 'A', 'B', 'C'], ['IN', 'A', 'B', 'A', 'B', 'C', 'A', 'A', 'B'])

  it('encodes the IN + repeat-AB + C prefix, leaves the A×2 return as leftover', () => {
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(false)
    expect(plan.repeats).toEqual([{ from: 1, to: 2, times: 2 }])
    // Steps 6,7,8 (the return A, A, B) can't be classically notated.
    expect(plan.leftoverSteps).toEqual([6, 7, 8])
  })
  it('playback matches exactly what is encoded', () => {
    const plan = compileNavigation(c)
    const played = playbackOf(plan, c)
    expect(played).toEqual(['IN', 'A', 'B', 'A', 'B', 'C'])
  })
})

// --- Cold-Sweat-like long form -------------------------------------------

describe('long form with intro vamp, repeat span, and D.S. al Coda skipping a section', () => {
  // Page [IN,A,B,C,D,E,OUT]. Vamp IN ×2, repeat A-B ×2, through C,D, then D.S. back
  // to A, play A B C D, To Coda after D, jump to OUT (skipping E).
  const c = chart(
    ['IN', 'A', 'B', 'C', 'D', 'E', 'OUT'],
    [['IN', 2], 'A', 'B', 'A', 'B', 'C', 'D', 'A', 'B', 'C', 'D', 'OUT'],
  )

  it('round-trips fully', () => {
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(true)
    expect(plan.plays.get('IN')).toBe(2)
    expect(plan.repeats).toEqual([{ from: 1, to: 2, times: 2 }])
    expect(plan.directive?.text).toBe('D.S. al Coda')
    expect(plan.segnoAtSection).toBe(1) // segno at A
    expect(plan.toCodaAfterSection).toBe(4) // To Coda after D
    expect(plan.codaAtSection).toBe(6) // Coda = OUT (skips E)
  })
})

// --- plain D.C. / D.S. (no coda, no fine) --------------------------------

describe('plain D.C. and D.S. to the final barline', () => {
  it('D.C. replays the whole page', () => {
    // A B, then D.C. back to top playing A B to the end.
    const c = chart(['A', 'B'], ['A', 'B', 'A', 'B'])
    // Note: the compiler may prefer a repeat span here (also correct). Either way
    // it must round-trip.
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(true)
  })
  it('D.S. to a segno then to the end', () => {
    // IN A B, then D.S. to A, play A B to the end.
    const c = chart(['IN', 'A', 'B'], ['IN', 'A', 'B', 'A', 'B'])
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(true)
  })
})

// --- open / solos are pass annotations -----------------------------------

describe('open and solos never change the encoded id sequence', () => {
  it('open vamp counts as one occurrence inside a structure', () => {
    const c = chart(['IN', 'A', 'B'], ['IN', ['A', 'open'], 'B', 'A', 'B'])
    const plan = assertRoundTrip(c)
    expect(plan.representable).toBe(true)
  })
  it('solos on a step do not add occurrences', () => {
    const c = chart(['A', 'B'], ['A', 'B'])
    c.arrangement![0].solos = ['gtr', 'keys', 'bass']
    const plan = assertRoundTrip(c)
    expect(roadmapSequence(c).seq).toEqual(['A', 'B'])
    expect(plan.representable).toBe(true)
  })
})

// --- dangling reference ---------------------------------------------------

describe('malformed roadmap', () => {
  it('a section id not on the page degrades to all-leftover', () => {
    const c = chart(['A', 'B'], ['A', 'GHOST', 'B'])
    const plan = compileNavigation(c)
    expect(plan.representable).toBe(false)
    expect(plan.leftoverSteps).toEqual([0, 1, 2])
  })
})

// --- property sweep: correctness fuzz -------------------------------------

// Deterministic PRNG so any failure reproduces.
function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('property sweep  -  playback never contradicts the encoded prefix', () => {
  it('holds for 300 random small roadmaps', () => {
    const rand = mulberry32(0x5a17c0de)
    const pick = (n: number) => Math.floor(rand() * n)
    for (let trial = 0; trial < 300; trial++) {
      const nSections = 3 + pick(3) // 3..5
      const pageIds = Array.from({ length: nSections }, (_, i) => `S${i}`)
      const roadmapLen = 2 + pick(8) // 2..9
      const roadmap: Array<string | [string, number]> = []
      for (let s = 0; s < roadmapLen; s++) {
        const sid = pageIds[pick(nSections)]
        const rep = pick(4) === 0 ? 2 + pick(2) : 1 // occasional in-place repeat
        roadmap.push(rep > 1 ? [sid, rep] : sid)
      }
      const c = chart(pageIds, roadmap)
      const plan = compileNavigation(c)
      const { seq } = roadmapSequence(c)
      const played = playbackOf(plan, c)
      const enc = encodedIdLen(plan, c)
      // The encoded prefix must round-trip, and the claim must be internally sound.
      expect(played.slice(0, enc)).toEqual(seq.slice(0, enc))
      if (plan.representable) {
        expect(played).toEqual(seq)
        expect(plan.leftoverSteps).toEqual([])
      }
    }
  })
})
