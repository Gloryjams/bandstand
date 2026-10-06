import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultBandstandUrl, loadBandstandConfig, resolveBase, servedByBandstand } from './bandstand'

const at = (pathname: string, protocol: string, hostname = '') => ({ pathname, protocol, hostname })

describe('servedByBandstand', () => {
  // The bundle Bandstand serves is built with `--mode bandstand`, which sets
  // VITE_SERVED_BY_BANDSTAND=1. Without this case the whole public-https band
  // instance path is untested and would stay green if the build flag vanished.
  afterEach(() => vi.unstubAllEnvs())

  it('is same-origin on a public https band host when built by Bandstand', () => {
    vi.stubEnv('VITE_SERVED_BY_BANDSTAND', '1')
    const loc = at('/charts/', 'https:', 'band.example')
    expect(servedByBandstand(loc)).toBe(true)
    expect(defaultBandstandUrl(loc)).toBe('')
  })

  it('still ignores a public deploy host when NOT built by Bandstand', () => {
    const loc = at('/charts/', 'https:', 'editor.example')
    expect(servedByBandstand(loc)).toBe(false)
  })

  it('is true when Bandstand serves the app at /charts/ over plain http', () => {
    expect(servedByBandstand(at('/charts/', 'http:'))).toBe(true)
    expect(servedByBandstand(at('/charts', 'http:'))).toBe(true)
    expect(servedByBandstand(at('/charts/editor', 'http:'))).toBe(true)
  })

  it('is true through the Tailscale Serve https proxy (…ts.net)', () => {
    expect(servedByBandstand(at('/charts/', 'https:', 'band.example.ts.net'))).toBe(true)
    expect(servedByBandstand(at('/charts/editor', 'https:', 'band.example.ts.net'))).toBe(true)
  })

  it('is false on every public https deploy  -  editor.example AND its firebase mirrors', () => {
    expect(servedByBandstand(at('/charts/', 'https:', 'editor.example'))).toBe(false)
    expect(servedByBandstand(at('/charts', 'https:', 'example.web.app'))).toBe(false)
    expect(servedByBandstand(at('/charts/', 'https:'))).toBe(false)
  })

  it('is false in dev (served at /) and on lookalike paths', () => {
    expect(servedByBandstand(at('/', 'http:'))).toBe(false)
    expect(servedByBandstand(at('/chartsfoo', 'http:'))).toBe(false)
  })
})

describe('defaultBandstandUrl', () => {
  it('defaults to same-origin under Bandstand, localhost elsewhere', () => {
    expect(defaultBandstandUrl(at('/charts/', 'http:'))).toBe('')
    expect(defaultBandstandUrl(at('/', 'http:'))).toBe('http://localhost:7800')
    expect(defaultBandstandUrl(at('/charts/', 'https:'))).toBe('http://localhost:7800')
  })

  it('is same-origin through the Tailscale Serve proxy too', () => {
    expect(defaultBandstandUrl(at('/charts/', 'https:', 'band.example.ts.net'))).toBe('')
  })
})

describe('loadBandstandConfig migration', () => {
  const stub = (loc: ReturnType<typeof at>, stored: string | null) => {
    const store = new Map<string, string>()
    if (stored !== null) store.set('saltycharts.bandstand.v1', stored)
    vi.stubGlobal('location', loc)
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
  }
  afterEach(() => vi.unstubAllGlobals())

  it('rewrites a stored LAN default to same-origin when Bandstand serves the app', () => {
    stub(at('/charts/', 'http:', 'localhost'), JSON.stringify({ url: 'http://localhost:7800', key: 'k' }))
    expect(loadBandstandConfig().url).toBe('')
  })

  it('rewrites the stored LAN default on the ts.net origin (mixed content would block it)', () => {
    stub(at('/charts/', 'https:', 'band.example.ts.net'), JSON.stringify({ url: 'http://localhost:7800', key: 'k' }))
    expect(loadBandstandConfig().url).toBe('')
  })

  it('never touches a custom URL', () => {
    stub(at('/charts/', 'http:', 'localhost'), JSON.stringify({ url: 'http://other-box:7800', key: 'k' }))
    expect(loadBandstandConfig().url).toBe('http://other-box:7800')
  })
})

describe('resolveBase', () => {
  it('trims trailing slashes from an explicit URL', () => {
    expect(resolveBase({ url: 'http://x:7800///', key: 'k' }, at('/', 'http:'))).toBe('http://x:7800')
  })

  it('allows empty base only when served by Bandstand', () => {
    expect(resolveBase({ url: '', key: 'k' }, at('/charts/', 'http:'))).toBe('')
    expect(resolveBase({ url: '', key: 'k' }, at('/charts/', 'https:', 'band.example.ts.net'))).toBe('')
    expect(() => resolveBase({ url: '', key: 'k' }, at('/', 'http:'))).toThrow(
      'No Bandstand URL configured',
    )
    expect(() => resolveBase({ url: '  ', key: 'k' }, at('/charts/', 'https:'))).toThrow(
      'No Bandstand URL configured',
    )
  })
})
