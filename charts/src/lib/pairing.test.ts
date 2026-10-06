// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adoptDirectorPairing, readActivePairing } from './pairing'
import { loadBandstandConfig } from './bandstand'

async function seed(url = 'https://band.example', key = 'test-director') {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('bandstand-meta', 10)
    request.onupgradeneeded = () => request.result.createObjectStore('kv', { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite')
    tx.objectStore('kv').put({ key: 'bands', value: [{ id: 'active', url, key }] })
    tx.objectStore('kv').put({ key: 'active_band', value: 'active' })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('location', { pathname: '/charts/', protocol: 'https:', hostname: 'band.example', origin: 'https://band.example' })
  vi.stubEnv('VITE_SERVED_BY_BANDSTAND', '1')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('reader to editor sign-in', () => {
  it('reads the active band from the existing database without a version change', async () => {
    await seed()
    expect(await readActivePairing()).toMatchObject({ id: 'active', url: 'https://band.example' })
  })
  it('works with a fresh device that has no reader database', async () => {
    expect(await readActivePairing()).toBeNull()
    expect(await indexedDB.databases()).toEqual([])
  })
  it('adopts a verified director sign-in on this server', async () => {
    await seed()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ role: 'director' })))
    vi.stubGlobal('fetch', fetchMock)
    await adoptDirectorPairing()
    expect(loadBandstandConfig()).toEqual({ url: '', key: 'test-director', readerBandId: 'active' })
    expect(fetchMock).toHaveBeenCalledWith('/api/whoami', expect.objectContaining({
      headers: { 'X-Bandstand-Key': 'test-director' },
    }))
  })
  it('refuses a member sign-in', async () => {
    await seed()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ role: 'member' }))))
    await adoptDirectorPairing()
    expect(loadBandstandConfig().key).toBe('')
  })
  it('does not use another origin or another band path', async () => {
    await seed('https://other.example')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await adoptDirectorPairing()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(loadBandstandConfig().key).toBe('')
  })
  it('keeps existing settings when verification fails', async () => {
    await seed()
    localStorage.setItem('saltycharts.bandstand.v1', JSON.stringify({ url: '', key: 'test-existing' }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    await adoptDirectorPairing()
    expect(loadBandstandConfig().key).toBe('test-existing')
  })
  it('forgets inherited credentials when the reader signed out', async () => {
    localStorage.setItem('saltycharts.bandstand.v1', JSON.stringify({ url: '', key: 'test-old', readerBandId: 'gone' }))
    await adoptDirectorPairing()
    expect(loadBandstandConfig().key).toBe('')
  })
  it('forgets inherited director credentials when this sign-in is now a member', async () => {
    await seed()
    localStorage.setItem('saltycharts.bandstand.v1', JSON.stringify({ url: '', key: 'test-old', readerBandId: 'active' }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ role: 'member' }))))
    await adoptDirectorPairing()
    expect(loadBandstandConfig().key).toBe('')
  })
})
