import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Chart, LibraryBackup, Setlist } from '@/types'
import { newChart, newPocketChart } from '@/lib/factory'
import { uid } from '@/lib/id'
import { seedCharts, seedSetlists } from '@/lib/sampleData'

// In-memory (non-persisted) undo/redo stacks for the active editing session.
const undoStack: string[] = []
const redoStack: string[] = []
const MAX_UNDO = 100

interface AppState {
  charts: Record<string, Chart>
  setlists: Record<string, Setlist>
  seeded: boolean

  // charts
  createChart: (partial?: Partial<Chart>) => string
  createPocketChart: (partial?: Partial<Chart>) => string
  saveChart: (chart: Chart, opts?: { pushUndo?: boolean }) => void
  deleteChart: (id: string) => void
  duplicateChart: (id: string) => string | null

  // undo/redo (operate on the currently edited chart)
  undo: (id: string) => void
  redo: (id: string) => void
  canUndo: () => boolean
  canRedo: () => boolean

  // setlists
  createSetlist: (partial?: Partial<Setlist>) => string
  saveSetlist: (setlist: Setlist) => void
  deleteSetlist: (id: string) => void
  addToSetlist: (setlistId: string, chartId: string) => void
  removeFromSetlist: (setlistId: string, chartId: string) => void
  reorderSetlist: (setlistId: string, chartIds: string[]) => void

  // backup
  exportBackup: () => LibraryBackup
  importBackup: (backup: LibraryBackup, mode: 'merge' | 'replace') => void

  // first-run seeding
  ensureSeeded: () => void
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      charts: {},
      setlists: {},
      seeded: false,

      createChart: (partial) => {
        const chart = newChart(partial)
        set((s) => ({ charts: { ...s.charts, [chart.id]: chart } }))
        return chart.id
      },

      createPocketChart: (partial) => {
        const chart = newPocketChart(partial)
        set((s) => ({ charts: { ...s.charts, [chart.id]: chart } }))
        return chart.id
      },

      saveChart: (chart, opts) => {
        if (opts?.pushUndo !== false) {
          const prev = get().charts[chart.id]
          if (prev) {
            undoStack.push(JSON.stringify(prev))
            if (undoStack.length > MAX_UNDO) undoStack.shift()
            redoStack.length = 0
          }
        }
        set((s) => ({
          charts: { ...s.charts, [chart.id]: { ...chart, updatedAt: Date.now() } },
        }))
      },

      deleteChart: (id) => {
        set((s) => {
          const charts = { ...s.charts }
          delete charts[id]
          // scrub from setlists too
          const setlists = Object.fromEntries(
            Object.entries(s.setlists).map(([sid, sl]) => [
              sid,
              { ...sl, chartIds: sl.chartIds.filter((c) => c !== id) },
            ]),
          )
          return { charts, setlists }
        })
      },

      duplicateChart: (id) => {
        const src = get().charts[id]
        if (!src) return null
        const copy: Chart = {
          ...structuredClone(src),
          id: uid('chart'),
          title: src.title ? `${src.title} (copy)` : 'Untitled (copy)',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        set((s) => ({ charts: { ...s.charts, [copy.id]: copy } }))
        return copy.id
      },

      // Undo/redo stamp a fresh updatedAt: the restored content is a NEW decision.
      // Restoring the old timestamp would make the server's stale-write guard drop
      // the push and the next pull would re-apply exactly what was just undone.
      undo: (id) => {
        if (undoStack.length === 0) return
        const cur = get().charts[id]
        if (cur) redoStack.push(JSON.stringify(cur))
        const prev = JSON.parse(undoStack.pop()!) as Chart
        set((s) => ({ charts: { ...s.charts, [prev.id]: { ...prev, updatedAt: Date.now() } } }))
      },

      redo: (id) => {
        if (redoStack.length === 0) return
        const cur = get().charts[id]
        if (cur) undoStack.push(JSON.stringify(cur))
        const next = JSON.parse(redoStack.pop()!) as Chart
        set((s) => ({ charts: { ...s.charts, [next.id]: { ...next, updatedAt: Date.now() } } }))
      },

      canUndo: () => undoStack.length > 0,
      canRedo: () => redoStack.length > 0,

      createSetlist: (partial) => {
        const now = Date.now()
        const setlist: Setlist = {
          id: uid('set'),
          name: 'New Setlist',
          chartIds: [],
          createdAt: now,
          updatedAt: now,
          ...partial,
        }
        set((s) => ({ setlists: { ...s.setlists, [setlist.id]: setlist } }))
        return setlist.id
      },

      saveSetlist: (setlist) =>
        set((s) => ({
          setlists: { ...s.setlists, [setlist.id]: { ...setlist, updatedAt: Date.now() } },
        })),

      deleteSetlist: (id) =>
        set((s) => {
          const setlists = { ...s.setlists }
          delete setlists[id]
          return { setlists }
        }),

      addToSetlist: (setlistId, chartId) =>
        set((s) => {
          const sl = s.setlists[setlistId]
          if (!sl || sl.chartIds.includes(chartId)) return s
          return {
            setlists: {
              ...s.setlists,
              [setlistId]: { ...sl, chartIds: [...sl.chartIds, chartId], updatedAt: Date.now() },
            },
          }
        }),

      removeFromSetlist: (setlistId, chartId) =>
        set((s) => {
          const sl = s.setlists[setlistId]
          if (!sl) return s
          return {
            setlists: {
              ...s.setlists,
              [setlistId]: {
                ...sl,
                chartIds: sl.chartIds.filter((c) => c !== chartId),
                updatedAt: Date.now(),
              },
            },
          }
        }),

      reorderSetlist: (setlistId, chartIds) =>
        set((s) => {
          const sl = s.setlists[setlistId]
          if (!sl) return s
          return {
            setlists: { ...s.setlists, [setlistId]: { ...sl, chartIds, updatedAt: Date.now() } },
          }
        }),

      exportBackup: () => ({
        app: 'saltycharts',
        version: 1,
        exportedAt: Date.now(),
        charts: Object.values(get().charts),
        setlists: Object.values(get().setlists),
      }),

      importBackup: (backup, mode) =>
        set((s) => {
          const charts = mode === 'replace' ? {} : { ...s.charts }
          const setlists = mode === 'replace' ? {} : { ...s.setlists }
          for (const c of backup.charts) charts[c.id] = c
          for (const sl of backup.setlists) setlists[sl.id] = sl
          return { charts, setlists }
        }),

      ensureSeeded: () => {
        if (get().seeded) return
        set((s) => {
          if (Object.keys(s.charts).length > 0) return { seeded: true }
          const charts = { ...s.charts }
          const setlists = { ...s.setlists }
          for (const c of seedCharts()) charts[c.id] = c
          for (const sl of seedSetlists()) setlists[sl.id] = sl
          return { charts, setlists, seeded: true }
        })
      },
    }),
    { name: 'saltycharts.v1', version: 1 },
  ),
)
