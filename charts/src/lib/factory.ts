import type { ArrangementStep, Bar, Chart, Section } from '@/types'
import { uid } from './id'

export function newBar(overrides: Partial<Bar> = {}): Bar {
  return { chords: '', lyrics: '', barline: 'normal', ending: '', ...overrides }
}

export function newSection(label = 'Intro', barCount = 4): Section {
  return {
    id: uid('sec'),
    label,
    bars: Array.from({ length: barCount }, () => newBar()),
  }
}

export function newArrangementStep(sectionId: string, overrides: Partial<ArrangementStep> = {}): ArrangementStep {
  return { id: uid('step'), sectionId, ...overrides }
}

/** A pocket chart: labeled/described sections with no bar grids, plus a starter roadmap. */
export function newPocketChart(overrides: Partial<Chart> = {}): Chart {
  const intro = { ...newSection('Intro', 0), description: '' }
  const verse = { ...newSection('Verse', 0), description: '' }
  const chorus = { ...newSection('Chorus', 0), description: '' }
  const outro = { ...newSection('Outro', 0), description: '' }
  return newChart({
    sections: [intro, verse, chorus, outro],
    arrangement: [
      newArrangementStep(intro.id),
      newArrangementStep(verse.id, { repeats: 2 }),
      newArrangementStep(chorus.id),
      newArrangementStep(outro.id),
    ],
    ...overrides,
  })
}

export function newChart(overrides: Partial<Chart> = {}): Chart {
  const now = Date.now()
  return {
    id: uid('chart'),
    title: '',
    artist: '',
    key: 'C',
    time: '4/4',
    bpm: '',
    style: '',
    capo: '',
    sections: [newSection('Intro')],
    settings: { barsPerRow: 4, fontSize: 'medium', showLyrics: true, onePage: false },
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}
