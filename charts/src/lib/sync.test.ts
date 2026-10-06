import { describe, expect, it } from 'vitest'
import type { Chart, Setlist } from '@/types'
import {
  diffStates,
  enqueueOps,
  planPull,
  type ServerChartRow,
  type ServerSetlistRow,
  type SyncOp,
} from './sync'

function chart(over: Partial<Chart> = {}): Chart {
  return {
    id: 'c1',
    title: 'Tune',
    artist: '',
    key: 'C',
    time: '4/4',
    bpm: '',
    style: '',
    capo: '',
    sections: [],
    settings: { barsPerRow: 4, fontSize: 'large', showLyrics: false, onePage: false },
    tags: [],
    createdAt: 10,
    updatedAt: 100,
    ...over,
  }
}

function setlist(over: Partial<Setlist> = {}): Setlist {
  return { id: 's1', name: 'Set', chartIds: [], createdAt: 10, updatedAt: 100, ...over }
}

function serverChart(over: Partial<ServerChartRow> = {}): ServerChartRow {
  return { source_id: 'c1', chart: chart(), updated_at: 100, deleted_at: null, ...over }
}

const noPending = { firstPull: false, pendingKeys: new Set<string>() }

describe('planPull charts', () => {
  it('puts a server chart this device has never seen', () => {
    const plan = planPull({}, {}, [serverChart()], [], noPending)
    expect(plan.putCharts.map((c) => c.id)).toEqual(['c1'])
    expect(plan.enqueue).toEqual([])
  })

  it('newer server copy wins, newer local copy re-pushes', () => {
    const local = { c1: chart({ updatedAt: 50 }) }
    const newer = planPull(local, {}, [serverChart({ chart: chart({ updatedAt: 200 }) })], [], noPending)
    expect(newer.putCharts[0]?.updatedAt).toBe(200)

    const older = planPull(local, {}, [serverChart({ chart: chart({ updatedAt: 20 }) })], [], noPending)
    expect(older.putCharts).toEqual([])
    expect(older.enqueue).toEqual([{ kind: 'chart', op: 'upsert', id: 'c1' }])
  })

  it('equal timestamps change nothing in either direction', () => {
    const plan = planPull({ c1: chart() }, {}, [serverChart()], [], noPending)
    expect(plan.putCharts).toEqual([])
    expect(plan.enqueue).toEqual([])
  })

  it('tombstone deletes the local copy unless the local edit is newer', () => {
    const dead = serverChart({ chart: null, deleted_at: 500 })
    const stale = planPull({ c1: chart({ updatedAt: 400 }) }, {}, [dead], [], noPending)
    expect(stale.deleteChartIds).toEqual(['c1'])

    const survivor = planPull({ c1: chart({ updatedAt: 600 }) }, {}, [dead], [], noPending)
    expect(survivor.deleteChartIds).toEqual([])
    expect(survivor.enqueue).toEqual([{ kind: 'chart', op: 'upsert', id: 'c1' }])
  })

  it('a pending local op freezes that entity: local wins until the flush lands', () => {
    const pending = { firstPull: false, pendingKeys: new Set(['chart:c1']) }
    const plan = planPull(
      { c1: chart({ updatedAt: 50 }) }, {},
      [serverChart({ chart: chart({ updatedAt: 999 }) })], [], pending,
    )
    expect(plan.putCharts).toEqual([])
    expect(plan.enqueue).toEqual([])
  })

  it('an untouched local seed never beats a server copy on its fresh birth stamp', () => {
    // Fresh seeds are born with updatedAt = now, newer than any real library copy.
    // Plain LWW would push them over the server's version (live incident 08-20).
    const local = { seed_x: chart({ id: 'seed_x', createdAt: 9999, updatedAt: 9999 }) }
    const server = [serverChart({
      source_id: 'seed_x',
      chart: chart({ id: 'seed_x', title: 'Real library copy', updatedAt: 100 }),
    })]
    const plan = planPull(local, {}, server, [], noPending)
    expect(plan.enqueue).toEqual([])
    expect(plan.putCharts[0]?.title).toBe('Real library copy')
  })

  it('an untouched local seed setlist never beats the server row either', () => {
    const local = { seed_s: setlist({ id: 'seed_s', createdAt: 9999, updatedAt: 9999 }) }
    const server: ServerSetlistRow[] = [{
      source_id: 'seed_s', name: 'Server set', chart_source_ids: ['a'], updated_at: 100,
    }]
    const plan = planPull({}, local, [], server, noPending)
    expect(plan.enqueue).toEqual([])
    expect(plan.putSetlists[0]?.name).toBe('Server set')
  })

  it('local-only charts push on any pull; untouched seeds drop on the first', () => {
    const local = {
      real: chart({ id: 'real', createdAt: 1, updatedAt: 9 }),
      seed_x: chart({ id: 'seed_x', createdAt: 5, updatedAt: 5 }),
      seed_edited: chart({ id: 'seed_edited', createdAt: 5, updatedAt: 8 }),
    }
    const first = planPull(local, {}, [], [], { firstPull: true, pendingKeys: new Set() })
    expect(first.dropSeedIds).toEqual(['seed_x'])
    expect(first.enqueue).toEqual(
      expect.arrayContaining([
        { kind: 'chart', op: 'upsert', id: 'real' },
        { kind: 'chart', op: 'upsert', id: 'seed_edited' },
      ]),
    )

    const later = planPull(local, {}, [], [], noPending)
    // Past the first pull an untouched seed is simply ignored, never pushed.
    expect(later.dropSeedIds).toEqual([])
    expect(later.enqueue.some((o) => o.id === 'seed_x')).toBe(false)
    expect(later.enqueue.some((o) => o.id === 'real')).toBe(true)
  })
})

describe('planPull setlists', () => {
  const row: ServerSetlistRow = {
    source_id: 's1', name: 'Friday', chart_source_ids: ['a', 'b'], updated_at: 200,
  }

  it('newer server setlist applies name and order, keeps local-only fields', () => {
    const local = { s1: setlist({ updatedAt: 100, venue: 'Practice', band: [{ id: 'p', label: 'Bass', semis: 0 }] }) }
    const plan = planPull({}, local, [], [row], noPending)
    expect(plan.putSetlists).toHaveLength(1)
    const put = plan.putSetlists[0]!
    expect(put.name).toBe('Friday')
    expect(put.chartIds).toEqual(['a', 'b'])
    expect(put.venue).toBe('Practice')
    expect(put.band?.[0]?.label).toBe('Bass')
  })

  it('newer local setlist re-pushes instead', () => {
    const plan = planPull({}, { s1: setlist({ updatedAt: 900 }) }, [], [row], noPending)
    expect(plan.putSetlists).toEqual([])
    expect(plan.enqueue).toEqual([{ kind: 'setlist', op: 'upsert', id: 's1' }])
  })

  it('absence means deleted once synced before, but means un-pushed on the first pull', () => {
    const local = { s1: setlist() }
    const later = planPull({}, local, [], [], noPending)
    expect(later.deleteSetlistIds).toEqual(['s1'])

    const first = planPull({}, local, [], [], { firstPull: true, pendingKeys: new Set() })
    expect(first.deleteSetlistIds).toEqual([])
    expect(first.enqueue).toEqual([{ kind: 'setlist', op: 'upsert', id: 's1' }])
  })

  it('a pending local op shields a locally deleted setlist from resurrection', () => {
    const pending = { firstPull: false, pendingKeys: new Set(['setlist:s1']) }
    const plan = planPull({}, {}, [], [row], pending)
    expect(plan.putSetlists).toEqual([])
  })
})

describe('diffStates', () => {
  const base = { charts: { c1: chart() }, setlists: { s1: setlist() } }

  it('captures replaced entities as upserts (reference inequality)', () => {
    const next = {
      charts: { c1: chart({ title: 'Edited' }) },
      setlists: base.setlists,
    }
    expect(diffStates(base, next, { captureDeletes: true })).toEqual([
      { kind: 'chart', op: 'upsert', id: 'c1' },
    ])
  })

  it('captures removals as deletes only when asked (Restore Replace must not)', () => {
    const next = { charts: {}, setlists: {} }
    expect(diffStates(base, next, { captureDeletes: true })).toEqual(
      expect.arrayContaining([
        { kind: 'chart', op: 'delete', id: 'c1' },
        { kind: 'setlist', op: 'delete', id: 's1' },
      ]),
    )
    expect(diffStates(base, next, { captureDeletes: false })).toEqual([])
  })
})

describe('enqueueOps', () => {
  it('keeps one op per entity, newest intent replacing older ones', () => {
    let q: SyncOp[] = []
    q = enqueueOps(q, [{ kind: 'chart', op: 'upsert', id: 'c1' }])
    q = enqueueOps(q, [{ kind: 'chart', op: 'delete', id: 'c1' }])
    expect(q).toEqual([{ kind: 'chart', op: 'delete', id: 'c1' }])
    q = enqueueOps(q, [{ kind: 'chart', op: 'upsert', id: 'c1' }])
    expect(q).toEqual([{ kind: 'chart', op: 'upsert', id: 'c1' }])
  })

  it('different entities coexist', () => {
    const q = enqueueOps(
      [{ kind: 'chart', op: 'upsert', id: 'c1' }],
      [{ kind: 'setlist', op: 'upsert', id: 'c1' }],
    )
    expect(q).toHaveLength(2)
  })
})
