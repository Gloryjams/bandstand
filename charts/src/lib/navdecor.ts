import type { Chart } from '@/types'
import { compileNavigation, describeNavPlan, type NavPlan } from './navigation'

// Folds a compiled NavPlan into per-section display decorations, shared by the
// on-screen renderer (ChartGrid) and the MusicXML export so the screen, the
// prints, and the engraved scores always agree.

export interface SectionNavDecor {
  /** open a repeat span (forward repeat barline on the section's first bar) */
  repeatStart?: boolean
  /** close a repeat span: backward repeat on the last bar, played N times */
  repeatEnd?: number
  /** volta bracket over this whole section; label displayed on first section
      only, but carried on all spans so exporters know the ending number */
  volta?: { label: string; first: boolean; last: boolean }
  segno?: boolean
  coda?: boolean
  toCodaAfter?: boolean
  fineAfter?: boolean
  directiveAfter?: string
}

export interface NavDecorResult {
  plan: NavPlan
  decors: SectionNavDecor[]
  summary: string
}

/** Compile the roadmap and fold it into per-section decorations.
    Returns null when there is no arrangement (nothing to derive). */
export function navDecorations(chart: Chart): NavDecorResult | null {
  if (!chart.arrangement || chart.arrangement.length === 0) return null
  const plan = compileNavigation(chart)
  const decors: SectionNavDecor[] = chart.sections.map(() => ({}))

  plan.plays.forEach((times, sectionId) => {
    const i = chart.sections.findIndex((s) => s.id === sectionId)
    if (i >= 0 && times > 1) {
      decors[i].repeatStart = true
      decors[i].repeatEnd = times
    }
  })

  for (const span of plan.repeats) {
    if (decors[span.from]) decors[span.from].repeatStart = true
    if (decors[span.to]) decors[span.to].repeatEnd = span.times
    span.endings?.forEach((e) => {
      const label = e.passes.map((p) => `${p}.`).join(' ')
      e.sections.forEach((si, k) => {
        if (decors[si]) {
          decors[si].volta = { label, first: k === 0, last: k === e.sections.length - 1 }
        }
      })
    })
  }

  if (plan.segnoAtSection != null && decors[plan.segnoAtSection]) decors[plan.segnoAtSection].segno = true
  if (plan.codaAtSection != null && decors[plan.codaAtSection]) decors[plan.codaAtSection].coda = true
  if (plan.toCodaAfterSection != null && decors[plan.toCodaAfterSection]) decors[plan.toCodaAfterSection].toCodaAfter = true
  if (plan.fineAfterSection != null && decors[plan.fineAfterSection]) decors[plan.fineAfterSection].fineAfter = true
  if (plan.directive && decors[plan.directive.afterSection]) decors[plan.directive.afterSection].directiveAfter = plan.directive.text

  return { plan, decors, summary: describeNavPlan(plan, chart) }
}

/** Text engraved at a section's end (To Coda · D.S. al Coda · Fine). */
export function afterText(d: SectionNavDecor | undefined): string {
  if (!d) return ''
  return [d.toCodaAfter ? 'To Coda' : null, d.directiveAfter ?? null, d.fineAfter ? 'Fine' : null]
    .filter(Boolean)
    .join('  ·  ')
}
