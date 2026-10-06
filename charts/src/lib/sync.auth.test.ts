// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('sync credential failures', () => {
  it.each([401, 403, 429])('keeps edits after HTTP %i and retries after recovery', async (status) => {
    vi.resetModules()
    localStorage.clear()
    vi.useFakeTimers()
    const { saveBandstandConfig } = await import('./bandstand')
    saveBandstandConfig({ url: 'https://band.example', key: 'test-director' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('', { status })))
    const sync = await import('./sync')
    const { useStore } = await import('@/store/useStore')
    sync.initSync()
    await vi.advanceTimersByTimeAsync(1)
    const id = useStore.getState().createChart({ title: 'Pending exercise' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(sync.getSyncStatus()).toBe('error')
    expect(JSON.parse(localStorage.getItem('saltycharts.sync.queue.v1')!).pending)
      .toContainEqual({ kind: 'chart', op: 'upsert', id })

    const chart = useStore.getState().charts[id]
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const body = url.endsWith('/api/charts')
        ? { charts: [{ source_id: id, chart, updated_at: chart.updatedAt, deleted_at: null }] }
        : url.endsWith('/api/saltycharts-setlists') ? { setlists: [] } : { id }
      return new Response(JSON.stringify(body))
    }))
    await sync.syncNow()
    expect(JSON.parse(localStorage.getItem('saltycharts.sync.queue.v1')!).pending).toEqual([])
    expect(useStore.getState().charts[id]?.title).toBe('Pending exercise')
    expect(sync.getSyncStatus()).toBe('synced')
  })
})
