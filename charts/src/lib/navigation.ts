// Navigation compiler: turns a chart's roadmap (Chart.arrangement) into classic
// navigation notation  -  repeat barlines, 1st/2nd-ending voltas, D.C./D.S. with
// segno, To Coda / Coda, Fine  -  so a traditionally-literate reader following the
// engraved page plays exactly the roadmap sequence.
//
// The design is verification-first. `compileNavigation` builds a few candidate
// plans by heuristics, then runs each through `playbackOf` (a real reading-rules
// simulator) and only CLAIMS the prefix of the roadmap that provably round-trips.
// That makes it impossible to emit a plan whose playback contradicts the roadmap:
// worst case we encode a shorter classical prefix and report the rest as leftover.
//
// Pure TypeScript, no React/DOM. Types only from ../types.

import type { Chart } from '../types'

/** One volta (ending): a page-order run of sections taken on the given passes. */
export interface Ending {
  /** page-order section indices that make up this ending */
  sections: number[]
  /** 1-based pass numbers on which this ending is taken (e.g. [1] = 1st ending) */
  passes: number[]
}

/** A repeat span over a PAGE-ORDER range of sections, with optional voltas. */
export interface RepeatSpan {
  /** first page-order section index of the span */
  from: number
  /** last page-order section index of the span (includes all endings) */
  to: number
  /** total passes through the span */
  times: number
  /** ordered voltas; when present, the shared body is from..(first ending start-1) */
  endings?: Ending[]
}

/** A D.C./D.S. directive engraved at the end of a section. */
export interface NavDirective {
  /** e.g. "D.S. al Coda", "D.C. al Fine", "D.S.", "D.C." */
  text: string
  /** page-order section index whose end carries the directive */
  afterSection: number
}

export interface NavPlan {
  /** true when the ENTIRE step sequence is encoded by the annotations below */
  representable: boolean
  /** arrangement step indices that could not be encoded (empty when representable) */
  leftoverSteps: number[]
  /** in-place repeat barlines around a single section: sectionId -> times played */
  plays: Map<string, number>
  /** repeat spans over page-order section ranges, with optional voltas */
  repeats: RepeatSpan[]
  segnoAtSection?: number
  fineAfterSection?: number
  toCodaAfterSection?: number
  codaAtSection?: number
  /** the single D.C./D.S. directive, if any */
  directive?: NavDirective
}

// ---------------------------------------------------------------------------
// Roadmap expansion
// ---------------------------------------------------------------------------

/**
 * Expand the roadmap into the section-id sequence a listener actually hears,
 * respecting per-step repeats. A step's `open` (vamp till cue) counts as one
 * occurrence; `solos` annotate a pass and never change the id sequence. A
 * section's own Section.repeats is part of what the section IS and is NOT
 * expanded here  -  one roadmap step through a section is one occurrence.
 *
 * When the arrangement is absent/empty the sections play top-to-bottom as
 * written, so the sequence is the page order, each once.
 */
export function roadmapSequence(chart: Chart): { seq: string[]; counts: number[] } {
  const steps = chart.arrangement && chart.arrangement.length ? chart.arrangement : null
  if (!steps) {
    return { seq: chart.sections.map((s) => s.id), counts: chart.sections.map(() => 1) }
  }
  const seq: string[] = []
  const counts: number[] = []
  for (const step of steps) {
    const n = step.open ? 1 : Math.max(1, step.repeats ?? 1)
    counts.push(n)
    for (let k = 0; k < n; k++) seq.push(step.sectionId)
  }
  return { seq, counts }
}

// ---------------------------------------------------------------------------
// Reader simulator
// ---------------------------------------------------------------------------

/**
 * Walk the engraved page under real reading conventions and return the section-id
 * sequence performed. This is the authority the compiler verifies against.
 *
 * Conventions implemented (these are law):
 *  - Repeat barlines / plays send you back for the marked number of passes.
 *  - Voltas: pass N takes ending N; on the D.S./D.C. return pass take the LAST ending.
 *  - On the D.S./D.C. return pass, repeats are NOT taken (play straight through).
 *  - D.S. jumps to the segno; D.C. jumps to the top of the page.
 *  - To Coda / Fine are honored ONLY on the return pass.
 *  - al Coda: play from the jump target until To Coda, then jump to the coda.
 *  - al Fine: play until Fine and stop.
 */
export function playbackOf(plan: NavPlan, chart: Chart): string[] {
  const N = chart.sections.length
  const out: string[] = []
  if (N === 0) return out
  const id = (i: number) => chart.sections[i].id

  const spans = [...plan.repeats].sort((a, b) => a.from - b.from)
  const spanAt = (i: number) => spans.find((s) => i >= s.from && i <= s.to)
  const endingAt = (span: RepeatSpan, i: number) =>
    span.endings?.find((e) => e.sections.includes(i))

  // 1-based pass counter per span (first-pass reading only).
  const passOf = new Map<RepeatSpan, number>()
  const jumpTarget = () => plan.segnoAtSection ?? 0 // D.S. -> segno, D.C. -> top

  let i = 0
  let returnPass = false
  let guard = 0
  const MAX = 500000

  while (i >= 0 && i < N) {
    if (++guard > MAX) throw new Error('navigation playback runaway (malformed plan)')
    const span = spanAt(i)

    if (span && !returnPass) {
      const pass = passOf.get(span) ?? (passOf.set(span, 1), 1)
      const end = endingAt(span, i)
      // Skip endings that don't belong to this pass.
      if (end && !end.passes.includes(pass)) {
        i = Math.max(...end.sections) + 1
        continue
      }
      out.push(id(i))
      // Loop-back point: end of this pass's ending, or (no voltas) the span end.
      const loopPoint = span.endings
        ? !!end && i === Math.max(...end.sections)
        : i === span.to
      if (loopPoint && pass < span.times) {
        passOf.set(span, pass + 1)
        i = span.from
        continue
      }
      // Directive fires only when leaving this section for good (repeats done).
      if (plan.directive && plan.directive.afterSection === i) {
        returnPass = true
        i = jumpTarget()
        continue
      }
      i++
      continue
    }

    if (span && returnPass) {
      // Return pass: no repeats; take only the last ending.
      const end = endingAt(span, i)
      const last = span.endings?.[span.endings.length - 1]
      if (end && last && end !== last) {
        i = Math.max(...end.sections) + 1
        continue
      }
      out.push(id(i))
      if (plan.toCodaAfterSection === i && plan.codaAtSection != null) {
        i = plan.codaAtSection
        continue
      }
      if (plan.fineAfterSection === i) break
      i++
      continue
    }

    // Standalone section (may carry in-place repeat barlines via `plays`).
    const times = returnPass ? 1 : plan.plays.get(id(i)) ?? 1
    for (let k = 0; k < times; k++) out.push(id(i))

    if (!returnPass && plan.directive && plan.directive.afterSection === i) {
      returnPass = true
      i = jumpTarget()
      continue
    }
    if (returnPass && plan.toCodaAfterSection === i && plan.codaAtSection != null) {
      i = plan.codaAtSection
      continue
    }
    if (returnPass && plan.fineAfterSection === i) break
    i++
  }

  return out
}

// ---------------------------------------------------------------------------
// Structural detection (page-linear prefix: plays + repeat spans + voltas)
// ---------------------------------------------------------------------------

type IdxAt = (k: number) => number

function range(a: number, b: number): number[] {
  const out: number[] = []
  for (let x = a; x <= b; x++) out.push(x)
  return out
}

/**
 * Detect a multi-section repeat span (>= 2 sections) starting at seq[pos]. Handles
 * a plain repeat ([A,B,A,B] -> A..B x2) and a two-ending volta ([A,B,A,C] with B,C
 * contiguous on the page -> repeat A with 1st ending B, 2nd ending C). Returns null
 * when there is no clean span (e.g. the endings aren't page-adjacent -> degrade).
 */
function detectSpanAt(
  seq: string[],
  pos: number,
  idxAt: IdxAt,
): { span: RepeatSpan; nextPos: number } | null {
  const start = idxAt(pos)
  // Ascending run of the first pass (pass1 = shared body + 1st ending, all contiguous).
  let ar = 1
  while (pos + ar < seq.length && idxAt(pos + ar) === start + ar) ar++
  if (ar < 2) return null // single-section repeats are handled as `plays`, not spans
  // A repeat requires the next pass to return to the body start.
  if (pos + ar >= seq.length || idxAt(pos + ar) !== start) return null

  // Plain repeat: count consecutive full copies of the body [start..start+ar-1].
  const bodyLen = ar
  let times = 0
  let p = pos
  for (;;) {
    let full = true
    for (let k = 0; k < bodyLen; k++) {
      if (p + k >= seq.length || idxAt(p + k) !== start + k) {
        full = false
        break
      }
    }
    if (!full) break
    times++
    p += bodyLen
    if (times > 100000) break
  }
  if (times >= 2) {
    return { span: { from: start, to: start + bodyLen - 1, times }, nextPos: p }
  }

  // Two-ending volta: pass2 shares a shorter body, then jumps to the 2nd ending.
  let s = 1
  while (pos + ar + s < seq.length && idxAt(pos + ar + s) === start + s) s++
  if (s >= ar) return null // pass2 not shorter -> not a volta
  const e2start = pos + ar + s
  if (e2start >= seq.length) return null
  // 2nd ending must be page-contiguous right after the 1st ending.
  if (idxAt(e2start) !== start + ar) return null
  let e2 = 1
  while (e2start + e2 < seq.length && idxAt(e2start + e2) === start + ar + e2) e2++
  const ending1 = range(start + s, start + ar - 1)
  const ending2 = range(start + ar, start + ar + e2 - 1)
  return {
    span: {
      from: start,
      to: start + ar + e2 - 1,
      times: 2,
      endings: [
        { sections: ending1, passes: [1] },
        { sections: ending2, passes: [2] },
      ],
    },
    nextPos: e2start + e2,
  }
}

/**
 * Consume the longest page-linear prefix of `seq`: sections read in ascending page
 * order, with in-place single-section repeats folded into `plays` and contiguous
 * repeated runs folded into repeat spans (with voltas). Stops at the first point
 * the reading would have to jump backward/forward off the linear path.
 */
function parseLinear(
  seq: string[],
  idxAt: IdxAt,
  useSpans: boolean,
): { plays: Map<string, number>; repeats: RepeatSpan[]; consumed: number } {
  const plays = new Map<string, number>()
  const repeats: RepeatSpan[] = []
  let pos = 0
  let pageCursor = -1

  while (pos < seq.length) {
    const idx = idxAt(pos)
    const expected = pageCursor < 0 ? idx : pageCursor + 1
    if (idx !== expected) break

    if (useSpans) {
      const hit = detectSpanAt(seq, pos, idxAt)
      if (hit) {
        repeats.push(hit.span)
        pageCursor = hit.span.to
        pos = hit.nextPos
        continue
      }
    }

    let runLen = 1
    while (pos + runLen < seq.length && seq[pos + runLen] === seq[pos]) runLen++
    if (runLen > 1) plays.set(seq[pos], runLen)
    pageCursor = idx
    pos += runLen
  }

  return { plays, repeats, consumed: pos }
}

/**
 * Decode the remaining suffix (after the linear prefix) as a SINGLE return-jump:
 * D.C. (back to the top) or D.S. (back to a segno), optionally al Coda (play to
 * To Coda then jump to the coda) or al Fine (play to Fine and stop). Returns null
 * when the suffix needs more than one classic return-jump  -  the caller then leaves
 * the tail as leftover.
 */
function decodeDirective(
  seq: string[],
  from: number,
  idxAt: IdxAt,
  N: number,
): {
  directive: NavDirective
  segnoAtSection?: number
  toCodaAfterSection?: number
  codaAtSection?: number
  fineAfterSection?: number
} | null {
  if (from <= 0 || from >= seq.length) return null
  const remaining = seq.length - from
  const rt = idxAt(from) // return target page index
  if (rt < 0 || rt >= N) return null
  const isDC = rt === 0
  const afterSection = idxAt(from - 1)

  // Match the forward run from the return target.
  let i = rt
  let j = 0
  while (j < remaining && i < N && idxAt(from + j) === i) {
    j++
    i++
  }

  const base = isDC ? 'D.C.' : 'D.S.'
  const segnoAtSection = isDC ? undefined : rt

  if (j === remaining) {
    if (i === N) {
      // Plays to the final barline.
      return { directive: { text: base, afterSection }, segnoAtSection }
    }
    // Stops before the page ends -> Fine.
    return {
      directive: { text: `${base} al Fine`, afterSection },
      segnoAtSection,
      fineAfterSection: i - 1,
    }
  }

  // Otherwise the reader must jump forward past a tail -> To Coda / Coda.
  const cd = idxAt(from + j)
  if (cd <= i - 1) return null // coda must be forward of the pre-coda run
  let k = cd
  let jj = j
  while (jj < remaining && k < N && idxAt(from + jj) === k) {
    jj++
    k++
  }
  if (jj !== remaining) return null // coda tail doesn't cleanly reach the end
  return {
    directive: { text: `${base} al Coda`, afterSection },
    segnoAtSection,
    toCodaAfterSection: i - 1,
    codaAtSection: cd,
  }
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

function commonPrefixLen(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/** How many leading STEPS fit inside `matchLen` ids (steps expand to id runs). */
function stepsWithin(counts: number[], matchLen: number): { steps: number; idLen: number } {
  let acc = 0
  let steps = 0
  for (let s = 0; s < counts.length; s++) {
    if (acc + counts[s] <= matchLen) {
      acc += counts[s]
      steps++
    } else break
  }
  return { steps, idLen: acc }
}

function emptyPlan(): NavPlan {
  return { representable: false, leftoverSteps: [], plays: new Map(), repeats: [] }
}

/**
 * Compile the roadmap into classic navigation. Guaranteed: for every step the
 * returned plan claims to encode, playbackOf(plan) reproduces that step's slice of
 * the roadmap exactly. When `representable` is true the whole roadmap round-trips.
 */
export function compileNavigation(chart: Chart): NavPlan {
  const { seq, counts } = roadmapSequence(chart)
  if (seq.length === 0) {
    return { representable: true, leftoverSteps: [], plays: new Map(), repeats: [] }
  }

  const secIdx = new Map<string, number>()
  chart.sections.forEach((s, i) => secIdx.set(s.id, i))
  // Dangling section reference -> cannot encode anything; report all leftover.
  if (seq.some((sid) => !secIdx.has(sid))) {
    const plan = emptyPlan()
    plan.leftoverSteps = counts.map((_, s) => s)
    return plan
  }
  const idxAt: IdxAt = (k) => secIdx.get(seq[k])!
  const N = chart.sections.length

  // Assemble candidate plans, simplest first (ties prefer the simpler encoding).
  const candidates: NavPlan[] = [emptyPlan()]

  const linear = parseLinear(seq, idxAt, false)
  candidates.push({ ...emptyPlan(), plays: linear.plays, repeats: linear.repeats })

  const spans = parseLinear(seq, idxAt, true)
  candidates.push({ ...emptyPlan(), plays: spans.plays, repeats: spans.repeats })

  for (const parse of [spans, linear]) {
    const dir = decodeDirective(seq, parse.consumed, idxAt, N)
    if (dir) {
      candidates.push({
        ...emptyPlan(),
        plays: parse.plays,
        repeats: parse.repeats,
        directive: dir.directive,
        segnoAtSection: dir.segnoAtSection,
        toCodaAfterSection: dir.toCodaAfterSection,
        codaAtSection: dir.codaAtSection,
        fineAfterSection: dir.fineAfterSection,
      })
    }
  }

  // Score every candidate by how much of the roadmap it provably encodes.
  let best = candidates[0]
  let bestScore = { representable: false, idLen: -1, overshoot: Infinity }
  for (const cand of candidates) {
    const played = playbackOf(cand, chart)
    const matchLen = commonPrefixLen(played, seq)
    const { idLen } = stepsWithin(counts, matchLen)
    const representable = matchLen === seq.length && played.length === seq.length
    const overshoot = Math.max(0, played.length - idLen)
    const better =
      representable !== bestScore.representable
        ? representable
        : idLen !== bestScore.idLen
          ? idLen > bestScore.idLen
          : overshoot < bestScore.overshoot
    if (better) {
      best = cand
      bestScore = { representable, idLen, overshoot }
    }
  }

  // Finalize claim from the verified prefix.
  const played = playbackOf(best, chart)
  const matchLen = commonPrefixLen(played, seq)
  const { steps } = stepsWithin(counts, matchLen)
  const representable = matchLen === seq.length && played.length === seq.length
  const leftoverSteps = representable ? [] : range(steps, counts.length - 1)
  return { ...best, representable, leftoverSteps }
}

// ---------------------------------------------------------------------------
// Human-readable summary
// ---------------------------------------------------------------------------

/** e.g. "Repeat A-B ×2 · segno at B · D.S. al Coda after C · Coda = OUT". */
export function describeNavPlan(plan: NavPlan, chart: Chart): string {
  const label = (i: number) => chart.sections[i]?.label || chart.sections[i]?.id || `§${i}`
  const parts: string[] = []

  for (const [id, n] of plan.plays) {
    const idx = chart.sections.findIndex((s) => s.id === id)
    parts.push(`${idx >= 0 ? label(idx) : id} ×${n}`)
  }

  for (const span of plan.repeats) {
    let text = `Repeat ${label(span.from)}-${label(span.to)} ×${span.times}`
    if (span.endings && span.endings.length) {
      const voltas = span.endings
        .map((e, k) => `${k + 1}. ${e.sections.map(label).join('/')}`)
        .join(', ')
      text += ` (${voltas})`
    }
    parts.push(text)
  }

  if (plan.segnoAtSection != null) parts.push(`segno at ${label(plan.segnoAtSection)}`)
  if (plan.directive) parts.push(`${plan.directive.text} after ${label(plan.directive.afterSection)}`)
  if (plan.toCodaAfterSection != null) parts.push(`To Coda after ${label(plan.toCodaAfterSection)}`)
  if (plan.codaAtSection != null) parts.push(`Coda = ${label(plan.codaAtSection)}`)
  if (plan.fineAfterSection != null) parts.push(`Fine after ${label(plan.fineAfterSection)}`)

  if (!parts.length) parts.push('Play top to bottom')
  let summary = parts.join(' · ')
  if (!plan.representable && plan.leftoverSteps.length) {
    summary += ` · (+${plan.leftoverSteps.length} step${plan.leftoverSteps.length > 1 ? 's' : ''} not notatable)`
  }
  return summary
}
