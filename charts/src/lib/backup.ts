import type { Chart, LibraryBackup, Setlist } from '@/types'

// Restore-file validation. importBackup writes straight into the persisted
// store, so a malformed element would crash the Library render on every
// reload after (no error boundary)  -  reject the whole file up front instead.

const BAD_IDS = new Set(['__proto__', 'constructor', 'prototype'])

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !BAD_IDS.has(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function isChart(c: unknown): c is Chart {
  if (typeof c !== 'object' || c === null) return false
  const x = c as Record<string, unknown>
  return (
    isId(x.id) &&
    isStr(x.title) &&
    isStr(x.artist) &&
    isStr(x.key) &&
    Array.isArray(x.sections) &&
    Array.isArray(x.tags) &&
    typeof x.settings === 'object' &&
    x.settings !== null &&
    isNum(x.createdAt) &&
    isNum(x.updatedAt)
  )
}

function isSetlist(sl: unknown): sl is Setlist {
  if (typeof sl !== 'object' || sl === null) return false
  const x = sl as Record<string, unknown>
  return (
    isId(x.id) &&
    isStr(x.name) &&
    Array.isArray(x.chartIds) &&
    x.chartIds.every((id) => typeof id === 'string') &&
    isNum(x.createdAt) &&
    isNum(x.updatedAt)
  )
}

/** Parse + validate a backup file's text. Throws with a human message on anything off. */
export function parseBackup(text: string): LibraryBackup {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("That file isn't valid JSON")
  }
  const b = parsed as Partial<LibraryBackup>
  if (b?.app !== 'saltycharts' || !Array.isArray(b.charts) || !Array.isArray(b.setlists)) {
    throw new Error("That file isn't a Saltycharts backup")
  }
  if (b.version !== 1) {
    throw new Error(`Backup version ${String(b.version)} isn't supported here`)
  }
  const badCharts = b.charts.filter((c) => !isChart(c)).length
  const badSets = b.setlists.filter((sl) => !isSetlist(sl)).length
  if (badCharts || badSets) {
    throw new Error(`Backup is damaged (${badCharts} bad charts, ${badSets} bad sets)`)
  }
  return b as LibraryBackup
}
