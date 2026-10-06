// Tickets keep the director key out of stream addresses and proxy logs.
// EventSource retries would reuse a consumed ticket, so reconnect explicitly.
let stream: EventSource | null = null
let retry: ReturnType<typeof setTimeout> | null = null
let identity = ''
let generation = 0
const delays = [1000, 2000, 4000, 8000, 16000, 30000]

export function stopEditorLive(): void {
  generation += 1
  identity = ''
  if (retry) clearTimeout(retry)
  retry = null
  stream?.close()
  stream = null
}

export function startEditorLive(base: string, key: string, onChange: () => void): void {
  const nextIdentity = JSON.stringify([base, key])
  if (identity === nextIdentity || typeof EventSource === 'undefined') return
  stopEditorLive()
  identity = nextIdentity
  const gen = generation
  const reconnect = (attempt: number) => {
    if (gen !== generation) return
    if (retry) clearTimeout(retry)
    retry = setTimeout(() => {
      retry = null
      void connect(attempt)
    }, delays[Math.min(attempt, delays.length - 1)])
  }
  const connect = async (attempt: number): Promise<void> => {
    let ticket: string
    try {
      const response = await fetch(`${base}/api/events/ticket`, {
        method: 'POST', headers: { 'X-Bandstand-Key': key },
      })
      if (!response.ok) throw new Error('Stream unavailable')
      const body = await response.json() as { ticket?: unknown }
      if (typeof body.ticket !== 'string' || !body.ticket) throw new Error('No stream ticket')
      ticket = body.ticket
    } catch {
      reconnect(attempt + 1)
      return
    }
    if (gen !== generation) return
    const es = new EventSource(`${base}/api/events?ticket=${encodeURIComponent(ticket)}`)
    stream = es
    let opened = false
    es.onopen = () => { opened = true }
    for (const event of ['piece_changed', 'piece_deleted', 'data_changed']) {
      es.addEventListener(event, onChange)
    }
    es.onerror = () => {
      es.close()
      if (stream === es) stream = null
      reconnect(opened ? 0 : attempt + 1)
    }
  }
  void connect(0)
}
