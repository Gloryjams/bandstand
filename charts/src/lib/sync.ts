/**
 * Server-side library sync: Bandstand is the library of record, this device's
 * localStorage is the offline cache and working set.
 *
 * Design (docs/specs/2026-08-20-saltycharts-server-library-design.md in bandstand):
 * per-entity last-write-wins on updatedAt, both directions. Outbound: a store
 * subscriber diffs every state change into an op queue (so EVERY mutation path is
 * captured  -  editor saves, undo, imports  -  with no per-action wiring) and flushes it
 * debounced. Inbound: pull the full server snapshot on app start, window focus,
 * coming online, and after each flush, then merge. A dead or asleep server never
 * blocks anything: the queue keeps, the library stays local, stage mode doesn't care.
 *
 * The server drops stale pushes silently (stored copy strictly newer), so a
 * long-offline device can neither clobber newer edits nor wedge its own queue.
 */
import type { Chart, Setlist } from '@/types'
import {
  loadBandstandConfig,
  resolveBase,
  servedByBandstand,
  type BandstandConfig,
} from '@/lib/bandstand'
import { useStore } from '@/store/useStore'
import { startEditorLive, stopEditorLive } from './live'

const QUEUE_KEY = 'saltycharts.sync.queue.v1'

export type SyncStatus = 'off' | 'synced' | 'pending' | 'offline' | 'error'

export interface SyncOp {
  kind: 'chart' | 'setlist'
  op: 'upsert' | 'delete'
  id: string
}

interface QueueState {
  pending: SyncOp[]
  /** 0 = this device has never completed a pull; the first pull merges instead of
      trusting absence (see planPull). */
  lastPullAt: number
}

export interface ServerChartRow {
  source_id: string
  chart: Chart | null
  updated_at: number
  deleted_at: number | null
}

export interface ServerSetlistRow {
  source_id: string
  name: string
  chart_source_ids: string[]
  updated_at: number
}

// ---------------------------------------------------------------------------
// Pure planning (unit-tested; no IO, no store access)
// ---------------------------------------------------------------------------

export interface PullPlan {
  putCharts: Chart[]
  deleteChartIds: string[]
  putSetlists: Setlist[]
  deleteSetlistIds: string[]
  /** Local-only or locally-newer entities the server should receive. */
  enqueue: SyncOp[]
  /** Untouched sample data dropped instead of pushed (first pull only). */
  dropSeedIds: string[]
}

/** An untouched seed never syncs: it would multiply the sample data into the real
    library from every fresh origin. An EDITED seed is real work and syncs normally. */
function isUntouchedSeed(e: { id: string; createdAt: number; updatedAt: number }): boolean {
  return e.id.startsWith('seed_') && e.updatedAt === e.createdAt
}

export function planPull(
  localCharts: Record<string, Chart>,
  localSetlists: Record<string, Setlist>,
  serverCharts: ServerChartRow[],
  serverSetlists: ServerSetlistRow[],
  opts: { firstPull: boolean; pendingKeys: Set<string> },
): PullPlan {
  const plan: PullPlan = {
    putCharts: [], deleteChartIds: [], putSetlists: [], deleteSetlistIds: [],
    enqueue: [], dropSeedIds: [],
  }
  const key = (kind: string, id: string) => `${kind}:${id}`
  const seenChartIds = new Set<string>()

  for (const row of serverCharts) {
    seenChartIds.add(row.source_id)
    // A pending local op is an unflushed local decision  -  local wins until it lands.
    if (opts.pendingKeys.has(key('chart', row.source_id))) continue
    const local = localCharts[row.source_id]
    if (row.deleted_at != null) {
      if (!local) continue
      if (local.updatedAt > row.deleted_at) {
        // Edited after the delete: the edit survives and revives the server copy.
        plan.enqueue.push({ kind: 'chart', op: 'upsert', id: row.source_id })
      } else {
        plan.deleteChartIds.push(row.source_id)
      }
      continue
    }
    if (!row.chart) continue // unparseable server body; nothing to compare, skip
    if (local && isUntouchedSeed(local)) {
      // A freshly seeded sample carries today's birth timestamp, which would beat
      // any real server copy on plain LWW and clobber the user's library (observed
      // live 2026-08-20: a new device's seeds overwrote two real charts). An
      // untouched seed never wins and never pushes; the server copy IS the library.
      plan.putCharts.push(row.chart)
      continue
    }
    if (!local || row.chart.updatedAt > local.updatedAt) {
      plan.putCharts.push(row.chart)
    } else if (local.updatedAt > row.chart.updatedAt) {
      plan.enqueue.push({ kind: 'chart', op: 'upsert', id: row.source_id })
    }
  }

  // Local charts the server has never seen (not even as a tombstone): push them.
  // Pushing is never destructive, so this is safe on every pull, not just the first.
  for (const c of Object.values(localCharts)) {
    if (seenChartIds.has(c.id)) continue
    if (opts.pendingKeys.has(key('chart', c.id))) continue
    if (isUntouchedSeed(c)) {
      if (opts.firstPull) plan.dropSeedIds.push(c.id)
      continue
    }
    plan.enqueue.push({ kind: 'chart', op: 'upsert', id: c.id })
  }

  const seenSetlistIds = new Set<string>()
  for (const row of serverSetlists) {
    seenSetlistIds.add(row.source_id)
    if (opts.pendingKeys.has(key('setlist', row.source_id))) continue
    const local = localSetlists[row.source_id]
    // Same seed rule as charts: an untouched sample setlist never outranks the
    // server's copy on its fresh birth timestamp.
    if (!local || isUntouchedSeed(local) || row.updated_at > local.updatedAt) {
      plan.putSetlists.push({
        // Keep fields the server doesn't carry (band parts, venue, date) from the
        // local copy when there is one; the server owns name + order + freshness.
        ...(local ?? { id: row.source_id, chartIds: [], createdAt: row.updated_at }),
        id: row.source_id,
        name: row.name,
        chartIds: row.chart_source_ids,
        updatedAt: row.updated_at,
      })
    } else if (local.updatedAt > row.updated_at) {
      plan.enqueue.push({ kind: 'setlist', op: 'upsert', id: row.source_id })
    }
  }

  // Setlists have no tombstones (hard deletes server-side), so absence from the full
  // snapshot IS the delete signal  -  but only once this device has synced before, and
  // never for something it hasn't pushed yet.
  for (const sl of Object.values(localSetlists)) {
    if (seenSetlistIds.has(sl.id)) continue
    if (opts.pendingKeys.has(key('setlist', sl.id))) continue
    if (isUntouchedSeed(sl)) {
      if (opts.firstPull) plan.dropSeedIds.push(sl.id)
      continue
    }
    if (opts.firstPull) {
      plan.enqueue.push({ kind: 'setlist', op: 'upsert', id: sl.id })
    } else {
      plan.deleteSetlistIds.push(sl.id)
    }
  }

  return plan
}

/** Diff two store snapshots into ops. Reference equality is enough: the store is
    immutable-by-convention (every mutation replaces the entity object). */
export function diffStates(
  prev: { charts: Record<string, Chart>; setlists: Record<string, Setlist> },
  next: { charts: Record<string, Chart>; setlists: Record<string, Setlist> },
  opts: { captureDeletes: boolean },
): SyncOp[] {
  const ops: SyncOp[] = []
  for (const [id, c] of Object.entries(next.charts)) {
    if (prev.charts[id] !== c) ops.push({ kind: 'chart', op: 'upsert', id })
  }
  for (const [id, sl] of Object.entries(next.setlists)) {
    if (prev.setlists[id] !== sl) ops.push({ kind: 'setlist', op: 'upsert', id })
  }
  if (opts.captureDeletes) {
    for (const id of Object.keys(prev.charts)) {
      if (!(id in next.charts)) ops.push({ kind: 'chart', op: 'delete', id })
    }
    for (const id of Object.keys(prev.setlists)) {
      if (!(id in next.setlists)) ops.push({ kind: 'setlist', op: 'delete', id })
    }
  }
  return ops
}

// ---------------------------------------------------------------------------
// Queue persistence
// ---------------------------------------------------------------------------

function loadQueue(): QueueState {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    if (raw) {
      const q = JSON.parse(raw)
      if (Array.isArray(q.pending)) {
        return { pending: q.pending, lastPullAt: Number(q.lastPullAt) || 0 }
      }
    }
  } catch {
    /* corrupted queue -> start clean; the next pull reconciles */
  }
  return { pending: [], lastPullAt: 0 }
}

function saveQueue(q: QueueState): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q))
  } catch {
    /* quota/private mode: the queue lives in memory for this session */
  }
}

/** One op per (kind, id); the newest intent wins (an upsert after a delete replaces
    the delete  -  the entity exists again and its latest body is what should land). */
export function enqueueOps(pending: SyncOp[], ops: SyncOp[]): SyncOp[] {
  if (ops.length === 0) return pending
  const out = pending.filter(
    (p) => !ops.some((o) => o.kind === p.kind && o.id === p.id),
  )
  out.push(...ops)
  return out
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

let queue: QueueState = { pending: [], lastPullAt: 0 }
let status: SyncStatus = 'off'
let statusDetail = ''
let listeners: Array<() => void> = []
let applyingRemote = false
let captureDeletes = true
let flushTimer: ReturnType<typeof setTimeout> | null = null
let running = false
let inited = false

function setStatus(s: SyncStatus, detail = ''): void {
  if (s === status && detail === statusDetail) return
  status = s
  statusDetail = detail
  for (const l of listeners) l()
}

export function getSyncStatus(): SyncStatus {
  return status
}

export function getSyncDetail(): string {
  return statusDetail
}

export function subscribeSync(cb: () => void): () => void {
  listeners.push(cb)
  return () => {
    listeners = listeners.filter((l) => l !== cb)
  }
}

/** Sync runs only with a device key, and a base URL it can reach (same-origin when
    Bandstand serves this app, else a configured one). No key = standalone app,
    seeds and all, exactly as before. */
export function isSyncActive(cfg: BandstandConfig = loadBandstandConfig()): boolean {
  return Boolean(cfg.key.trim() && (servedByBandstand() || cfg.url.trim()))
}

function headers(cfg: BandstandConfig): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Bandstand-Key': cfg.key.trim() }
}

/** Backup Restore(Replace) swaps the whole local library; the disappearance of
    every chart not in the backup must NOT become a server delete (an old backup
    would silently destroy newer work everywhere). Inside this wrapper, removals
    are not captured; the next pull re-merges whatever the server still has. */
export function runWithoutDeleteCapture<T>(fn: () => T): T {
  captureDeletes = false
  try {
    return fn()
  } finally {
    captureDeletes = true
  }
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    void syncNow()
  }, 1500)
}

async function flushOps(cfg: BandstandConfig, base: string): Promise<void> {
  // Snapshot: ops enqueued while a flush is in flight stay for the next one.
  const batch = [...queue.pending]
  const state = useStore.getState()
  for (const op of batch) {
    let res: Response
    try {
      if (op.kind === 'chart' && op.op === 'upsert') {
        const chart = state.charts[op.id]
        if (!chart) {
          // Deleted (or replaced away) since it was queued; the delete op, if any,
          // rides this same batch.
          queue.pending = queue.pending.filter((p) => p !== op)
          continue
        }
        res = await fetch(`${base}/api/upload-chart`, {
          method: 'POST', headers: headers(cfg), body: JSON.stringify({ chart }),
        })
      } else if (op.kind === 'chart') {
        res = await fetch(`${base}/api/charts/${encodeURIComponent(op.id)}`, {
          method: 'DELETE', headers: headers(cfg),
        })
        // 404 = already gone server-side; that IS the desired end state.
        if (res.status === 404) res = new Response(null, { status: 200 })
      } else if (op.op === 'upsert') {
        const sl = state.setlists[op.id]
        if (!sl) {
          queue.pending = queue.pending.filter((p) => p !== op)
          continue
        }
        const charts = sl.chartIds
          .map((cid) => state.charts[cid])
          .filter((c): c is Chart => Boolean(c))
        res = await fetch(`${base}/api/upload-setlist`, {
          method: 'POST',
          headers: headers(cfg),
          body: JSON.stringify({
            setlist: {
              id: sl.id,
              name: sl.name || 'Untitled set',
              updatedAt: sl.updatedAt,
              charts,
            },
          }),
        })
      } else {
        res = await fetch(`${base}/api/saltycharts-setlists/${encodeURIComponent(op.id)}`, {
          method: 'DELETE', headers: headers(cfg),
        })
      }
    } catch {
      // Network down: keep everything still queued and stop this flush.
      setStatus('offline')
      saveQueue(queue)
      return
    }
    if (res.ok) {
      queue.pending = queue.pending.filter((p) => p !== op)
    } else if (res.status === 400 || res.status === 422) {
      // Invalid payloads cannot be retried unchanged. Authentication failures,
      // rate limits and conflicts must keep the user's edits for a later retry.
      console.warn(`[sync] dropped ${op.kind} ${op.op} ${op.id}: HTTP ${res.status}`)
      queue.pending = queue.pending.filter((p) => p !== op)
    } else {
      setStatus('error', `HTTP ${res.status}`)
      saveQueue(queue)
      return
    }
  }
  saveQueue(queue)
}

async function pullAndMerge(cfg: BandstandConfig, base: string): Promise<void> {
  let chartsRes: Response
  let setsRes: Response
  try {
    ;[chartsRes, setsRes] = await Promise.all([
      fetch(`${base}/api/charts`, { headers: headers(cfg) }),
      fetch(`${base}/api/saltycharts-setlists`, { headers: headers(cfg) }),
    ])
  } catch {
    setStatus('offline')
    return
  }
  if (!chartsRes.ok || !setsRes.ok) {
    setStatus('error', `HTTP ${chartsRes.ok ? setsRes.status : chartsRes.status}`)
    return
  }
  const serverCharts: ServerChartRow[] = (await chartsRes.json()).charts ?? []
  const serverSetlists: ServerSetlistRow[] = (await setsRes.json()).setlists ?? []

  const state = useStore.getState()
  const pendingKeys = new Set(queue.pending.map((p) => `${p.kind}:${p.id}`))
  const plan = planPull(state.charts, state.setlists, serverCharts, serverSetlists, {
    firstPull: queue.lastPullAt === 0,
    pendingKeys,
  })

  if (
    plan.putCharts.length || plan.deleteChartIds.length || plan.dropSeedIds.length ||
    plan.putSetlists.length || plan.deleteSetlistIds.length
  ) {
    applyingRemote = true
    try {
      useStore.setState((s) => {
        const charts = { ...s.charts }
        const setlists = { ...s.setlists }
        for (const c of plan.putCharts) charts[c.id] = c
        for (const id of [...plan.deleteChartIds, ...plan.dropSeedIds]) delete charts[id]
        for (const sl of plan.putSetlists) setlists[sl.id] = sl
        for (const id of [...plan.deleteSetlistIds, ...plan.dropSeedIds]) delete setlists[id]
        return { charts, setlists }
      })
    } finally {
      applyingRemote = false
    }
  }

  queue.lastPullAt = Date.now()
  if (plan.enqueue.length) {
    queue.pending = enqueueOps(queue.pending, plan.enqueue)
    saveQueue(queue)
    scheduleFlush()
  } else {
    saveQueue(queue)
  }
}

/** Flush the queue, then pull + merge. Safe to call any time; overlapping calls
    coalesce (the running pass finishes, the next tick starts fresh). */
export async function syncNow(): Promise<void> {
  const cfg = loadBandstandConfig()
  if (!isSyncActive(cfg)) {
    stopEditorLive()
    setStatus('off')
    return
  }
  connectLive(cfg)
  if (running) return
  running = true
  try {
    const base = resolveBase(cfg)
    setStatus(queue.pending.length ? 'pending' : status === 'off' ? 'synced' : status)
    await flushOps(cfg, base)
    if (queue.pending.length === 0) {
      await pullAndMerge(cfg, base)
    }
    if (queue.pending.length) {
      if (status !== 'offline' && status !== 'error') setStatus('pending')
    } else if (status !== 'offline' && status !== 'error') {
      setStatus('synced')
    }
  } finally {
    running = false
  }
}

// ---------------------------------------------------------------------------
// Live-push: /api/events SSE. Pull-on-focus already converges; this makes a
// change on one device appear on the others in ~a second while both are open
// (the "stage tablet updates while the desktop edits" case). Best-effort: any
// error just falls back to the focus/online pulls.
// ---------------------------------------------------------------------------

let ssePullTimer: ReturnType<typeof setTimeout> | null = null

function connectLive(cfg: BandstandConfig): void {
  let base: string
  try {
    base = resolveBase(cfg)
  } catch {
    return
  }
  const onChange = () => {
    // A burst (our own flush publishes once per uploaded chart) coalesces into
    // one trailing pull.
    if (ssePullTimer) clearTimeout(ssePullTimer)
    ssePullTimer = setTimeout(() => {
      ssePullTimer = null
      void syncNow()
    }, 1000)
  }
  startEditorLive(base, cfg.key.trim(), onChange)
}

/** Wire the engine: store subscriber, focus/online triggers, initial sync.
    Call once from App mount. Inert (status 'off') until a key is configured. */
export function initSync(): void {
  if (inited) return
  inited = true
  queue = loadQueue()

  useStore.subscribe((state, prevState) => {
    if (applyingRemote) return
    if (state.charts === prevState.charts && state.setlists === prevState.setlists) return
    const ops = diffStates(prevState, state, { captureDeletes })
    if (ops.length === 0) return
    if (!isSyncActive()) return
    queue.pending = enqueueOps(queue.pending, ops)
    saveQueue(queue)
    setStatus('pending')
    scheduleFlush()
  })

  window.addEventListener('focus', () => void syncNow())
  window.addEventListener('online', () => void syncNow())
  window.addEventListener('storage', (event) => {
    if (event.key === 'saltycharts.bandstand.v1') void syncNow()
  })
  void syncNow()
}
