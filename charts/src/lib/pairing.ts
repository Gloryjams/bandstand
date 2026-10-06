import { loadBandstandConfig, saveBandstandConfig, servedByBandstand } from './bandstand'

interface Pairing { id: string; url: string; key: string }

/** Read the reader's active sign-in on this origin without creating a database.
 * Credentials stay on this device, never in links, fragments or log messages. */
export function readActivePairing(): Promise<Pairing | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let finished = false
    let db: IDBDatabase | null = null
    const done = (value: Pairing | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      db?.close()
      resolve(value)
    }
    const timer = setTimeout(() => done(null), 2000)
    const request = indexedDB.open('bandstand-meta')
    request.onupgradeneeded = () => { request.transaction?.abort() }
    request.onerror = () => done(null)
    request.onblocked = () => done(null)
    request.onsuccess = () => {
      db = request.result
      if (finished) { db.close(); return }
      if (!db.objectStoreNames.contains('kv')) { done(null); return }
      const transaction = db.transaction('kv', 'readonly')
      const store = transaction.objectStore('kv')
      const bands = store.get('bands')
      const active = store.get('active_band')
      transaction.onerror = () => done(null)
      transaction.oncomplete = () => {
        const rows: unknown = bands.result?.value
        const activeId: unknown = active.result?.value
        const band = Array.isArray(rows) ? rows.find((row: Pairing) => row?.id === activeId) : null
        done(band && typeof band.url === 'string' && typeof band.key === 'string' ? band : null)
      }
    }
  })
}

/** A signed-in director can open the editor for this band without pairing again.
 * A reader hosted elsewhere still uses the existing explicit Connect flow. */
export async function adoptDirectorPairing(): Promise<void> {
  if (!servedByBandstand()) return
  const band = await readActivePairing()
  const current = loadBandstandConfig()
  const clearLinked = () => {
    if (current.readerBandId) saveBandstandConfig({ url: '', key: '' })
  }
  if (current.readerBandId && band?.id !== current.readerBandId) clearLinked()
  if (!band?.key.trim()) return
  const chartBase = location.pathname.replace(/\/charts(?:\/.*)?$/, '').replace(/\/$/, '')
  let url: URL
  try { url = new URL(band.url || location.origin, location.origin) } catch { return }
  if (url.origin !== location.origin || url.pathname.replace(/\/$/, '') !== chartBase) {
    clearLinked()
    return
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(`${chartBase}/api/whoami`, {
      headers: { 'X-Bandstand-Key': band.key },
      signal: controller.signal,
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) clearLinked()
      return
    }
    const identity = await response.json() as { role?: unknown }
    if (identity.role !== 'director') { clearLinked(); return }
    saveBandstandConfig({ url: chartBase, key: band.key, readerBandId: band.id })
  } catch { /* Offline: keep the existing local library and explicit pairing. */ }
  finally { clearTimeout(timeout) }
}
