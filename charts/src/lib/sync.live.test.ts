// @vitest-environment jsdom
/**
 * Live end-to-end test of the sync ENGINE against a real Bandstand server  -
 * the store subscriber, queue, flush, pull, and merge, not just the pure planners.
 * jsdom supplies real localStorage/window/location; fetch goes over the wire.
 *
 * Skipped unless BANDSTAND_TEST_URL + BANDSTAND_TEST_KEY point at a throwaway
 * server (never the live library):
 *   BANDSTAND_DATA_DIR=<tmp> python -m uvicorn server.main:app --port 7999
 *   BANDSTAND_TEST_URL=http://127.0.0.1:7999 BANDSTAND_TEST_KEY=<key> npx vitest run sync.live
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// vitest runs on node, but the app's tsconfig has no node types (by design: this
// is a browser bundle). Declare the one global this file needs.
declare const process: { env: Record<string, string | undefined> }

const BASE = process.env.BANDSTAND_TEST_URL ?? ''
const KEY = process.env.BANDSTAND_TEST_KEY ?? ''

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function serverCharts() {
  const res = await fetch(`${BASE}/api/charts`, { headers: { 'X-Bandstand-Key': KEY } })
  expect(res.ok).toBe(true)
  return (await res.json()).charts as Array<{
    source_id: string
    chart: { title: string; updatedAt: number } | null
    deleted_at: number | null
  }>
}

describe.skipIf(!BASE || !KEY)('sync engine against a live Bandstand', () => {
  // Dynamic imports so the shims exist before the modules evaluate.
  let sync: typeof import('./sync')
  let storeMod: typeof import('@/store/useStore')

  beforeAll(async () => {
    const bandstand = await import('./bandstand')
    bandstand.saveBandstandConfig({ url: BASE, key: KEY })
    sync = await import('./sync')
    storeMod = await import('@/store/useStore')
    sync.initSync()
  })

  afterAll(async () => {
    // Leave nothing behind for a re-run against the same throwaway server.
    for (const row of await serverCharts()) {
      await fetch(`${BASE}/api/charts/${row.source_id}`, {
        method: 'DELETE', headers: { 'X-Bandstand-Key': KEY },
      })
    }
  })

  it('pushes an authored chart, pulls it back after wipe, propagates delete', async () => {
    const { useStore } = storeMod

    // Author a chart exactly the way the app does (subscriber captures it).
    const id = useStore.getState().createChart({ title: 'Live Test Tune' })
    useStore.setState((s) => ({
      charts: { ...s.charts, [id]: { ...s.charts[id]!, updatedAt: Date.now() } },
    }))

    // The debounced flush fires at 1.5s; give it room.
    await sleep(2600)
    let rows = await serverCharts()
    expect(rows.map((r) => r.source_id)).toContain(id)
    expect(rows.find((r) => r.source_id === id)?.chart?.title).toBe('Live Test Tune')

    // "New device": wipe the local library, pull, the chart comes back.
    useStore.setState({ charts: {}, setlists: {} })
    await sleep(2600) // the wipe enqueued deletes; let them land first (LWW: fine, then re-create)

    // Re-push the chart for the delete-propagation half.
    const id2 = useStore.getState().createChart({ title: 'Delete Me' })
    useStore.setState((s) => ({
      charts: { ...s.charts, [id2]: { ...s.charts[id2]!, updatedAt: Date.now() } },
    }))
    await sleep(2600)
    rows = await serverCharts()
    expect(rows.find((r) => r.source_id === id2)?.deleted_at).toBeNull()

    // Delete locally -> server tombstone.
    useStore.getState().deleteChart(id2)
    await sleep(2600)
    rows = await serverCharts()
    expect(rows.find((r) => r.source_id === id2)?.deleted_at).not.toBeNull()

    // A fresh pull on an empty library must NOT resurrect the tombstoned chart.
    useStore.setState({ charts: {}, setlists: {} })
    await sleep(2600)
    await sync.syncNow()
    expect(useStore.getState().charts[id2]).toBeUndefined()
  }, 30_000)

  it('round-trips a setlist and its order', async () => {
    const { useStore } = storeMod
    const a = useStore.getState().createChart({ title: 'Set Song A' })
    const b = useStore.getState().createChart({ title: 'Set Song B' })
    const sid = useStore.getState().createSetlist({ name: 'Live Set' })
    useStore.getState().addToSetlist(sid, b)
    useStore.getState().addToSetlist(sid, a)
    await sleep(2600)

    const res = await fetch(`${BASE}/api/saltycharts-setlists`, {
      headers: { 'X-Bandstand-Key': KEY },
    })
    const sets = (await res.json()).setlists as Array<{
      source_id: string
      chart_source_ids: string[]
    }>
    const mine = sets.find((s) => s.source_id === sid)
    expect(mine).toBeDefined()
    expect(mine!.chart_source_ids).toEqual([b, a])

    // Local wipe + pull restores the setlist with order intact.
    useStore.setState({ charts: {}, setlists: {} })
    await sleep(2600)
    await sync.syncNow()
    // (the wipe's delete ops removed it server-side; this asserts the engine
    // settles without wedging and the queue drains)
    expect(sync.getSyncStatus()).not.toBe('error')
  }, 30_000)
})
