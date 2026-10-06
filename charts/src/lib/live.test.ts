import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startEditorLive, stopEditorLive } from './live'

class FakeStream {
  static instances: FakeStream[] = []
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  addEventListener = vi.fn()
  constructor(public url: string) { FakeStream.instances.push(this) }
  close() { this.closed = true }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const response = (ticket = 'single-use-ticket') => new Response(JSON.stringify({ ticket }))

beforeEach(() => {
  stopEditorLive()
  vi.useFakeTimers()
  FakeStream.instances = []
  vi.stubGlobal('EventSource', FakeStream)
})
afterEach(() => { stopEditorLive(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('editor stream tickets', () => {
  it('keeps the director credential in a header and opens with a ticket', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response())
    vi.stubGlobal('fetch', fetchMock)
    const changed = vi.fn()
    startEditorLive('https://band.example', 'test-director', changed)
    await flush()
    expect(fetchMock).toHaveBeenCalledWith('https://band.example/api/events/ticket', {
      method: 'POST', headers: { 'X-Bandstand-Key': 'test-director' },
    })
    expect(FakeStream.instances[0]?.url).toBe('https://band.example/api/events?ticket=single-use-ticket')
    expect(FakeStream.instances[0]?.url).not.toContain('test-director')
    expect(FakeStream.instances[0]?.addEventListener).toHaveBeenCalledWith('piece_changed', changed)
  })

  it('asks for a fresh ticket after a connection drops', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response('first')).mockResolvedValueOnce(response('second'))
    vi.stubGlobal('fetch', fetchMock)
    startEditorLive('', 'test-director', vi.fn())
    await flush()
    const first = FakeStream.instances[0]!
    first.onopen?.(); first.onerror?.()
    expect(first.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeStream.instances[1]?.url).toBe('/api/events?ticket=second')
  })

  it('does not fall back to a raw credential when tickets are refused', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))
    startEditorLive('', 'test-director', vi.fn())
    await flush()
    expect(FakeStream.instances).toHaveLength(0)
  })

  it('does not open a late ticket after disconnecting', async () => {
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { finish = resolve })))
    startEditorLive('', 'test-director', vi.fn())
    stopEditorLive()
    finish(response())
    await flush()
    expect(FakeStream.instances).toHaveLength(0)
  })

  it('replaces an old stream when the configured band changes', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    startEditorLive('https://a.example', 'test-a', vi.fn())
    await flush()
    startEditorLive('https://b.example', 'test-b', vi.fn())
    await flush()
    expect(FakeStream.instances[0]?.closed).toBe(true)
    expect(FakeStream.instances[1]?.url).toContain('https://b.example/')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
