import { describe, expect, it } from 'vitest'
import { parseBackup } from './backup'
import type { Chart, Setlist } from '@/types'

const chart = (over: Partial<Chart> = {}): Chart => ({
  id: 'c1',
  title: 'Love Celebration',
  artist: 'Practice',
  key: 'Bbm',
  time: '4/4',
  bpm: '96',
  style: 'funk',
  capo: '',
  sections: [],
  settings: { barsPerRow: 4, fontSize: 'md' as Chart['settings']['fontSize'], showLyrics: true, onePage: false },
  tags: [],
  createdAt: 1,
  updatedAt: 2,
  ...over,
})

const setlist = (over: Partial<Setlist> = {}): Setlist => ({
  id: 's1',
  name: 'Practice Thursday',
  chartIds: ['c1'],
  createdAt: 1,
  updatedAt: 2,
  ...over,
})

const wrap = (charts: unknown[], setlists: unknown[] = [], version: unknown = 1) =>
  JSON.stringify({ app: 'saltycharts', version, exportedAt: 3, charts, setlists })

describe('parseBackup', () => {
  it('round-trips a valid backup', () => {
    const b = parseBackup(wrap([chart()], [setlist()]))
    expect(b.charts).toHaveLength(1)
    expect(b.setlists[0].name).toBe('Practice Thursday')
  })

  it('rejects non-JSON and non-backup JSON', () => {
    expect(() => parseBackup('not json')).toThrow("isn't valid JSON")
    expect(() => parseBackup('{"app":"other","charts":[],"setlists":[]}')).toThrow(
      "isn't a Saltycharts backup",
    )
  })

  it('rejects unknown versions instead of silently eating them', () => {
    expect(() => parseBackup(wrap([], [], 2))).toThrow("version 2 isn't supported")
  })

  it('rejects malformed elements  -  a bad restore must never reach the persisted store', () => {
    // missing tags would crash Library render on every reload after persist
    const noTags = { ...chart(), tags: undefined }
    expect(() => parseBackup(wrap([noTags]))).toThrow('1 bad charts')
    expect(() => parseBackup(wrap([chart()], [{ id: 's1' }]))).toThrow('1 bad sets')
    expect(() => parseBackup(wrap([{ ...chart(), id: '' }]))).toThrow('bad charts')
  })

  it('rejects prototype-clobbering ids', () => {
    expect(() => parseBackup(wrap([chart({ id: '__proto__' })]))).toThrow('bad charts')
    expect(() => parseBackup(wrap([chart()], [setlist({ id: 'constructor' })]))).toThrow('bad sets')
  })
})
