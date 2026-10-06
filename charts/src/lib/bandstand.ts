import type { Chart } from '@/types'

// Send charts to this band's server. The director key stays on this device;
// it is never included in a build or a chart backup.

export interface BandstandConfig {
  /** Bandstand origin, or '' = same origin (when Bandstand itself serves this app). */
  url: string
  key: string
  /** Present only when the editor inherited the reader's active sign-in. */
  readerBandId?: string
}

const LS_KEY = 'saltycharts.bandstand.v1'

export interface Loc {
  pathname: string
  protocol: string
  hostname?: string
}

const LOCAL_DEFAULT = 'http://localhost:7800'

/** A bundled editor uses this server on any HTTP or HTTPS host.
    The protocol and Tailscale checks retain compatibility with older builds. */
export function servedByBandstand(loc: Loc = location): boolean {
  const onChartsPath = loc.pathname === '/charts' || loc.pathname.startsWith('/charts/')
  if (!onChartsPath) return false
  // Bundles produced by `npm run build:bandstand` are served BY Bandstand
  // itself, so same-origin holds on ANY origin - including a public https
  // band instance behind a tunnel (a band host), which the
  // protocol / ts.net tells below cannot recognise. Public deploys, built
  // with plain `npm run build`, never set this.
  if (import.meta.env.VITE_SERVED_BY_BANDSTAND === '1') return true
  if (loc.protocol === 'http:') return true
  return loc.protocol === 'https:' && (loc.hostname ?? '').endsWith('.ts.net')
}

export function defaultBandstandUrl(loc?: Loc): string {
  return servedByBandstand(loc) ? '' : LOCAL_DEFAULT
}

export function loadBandstandConfig(): BandstandConfig {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const cfg = { url: defaultBandstandUrl(), key: '', ...JSON.parse(raw) }
      // Migrate configs saved before absorption: a stored LAN default is this
      // very server when Bandstand serves the app  -  same origin, blank URL
      // (otherwise a Tailscale-hostname visit keeps POSTing to an unreachable IP).
      if (servedByBandstand() && cfg.url === LOCAL_DEFAULT) cfg.url = ''
      return cfg
    }
  } catch {
    /* fall through to defaults */
  }
  return { url: defaultBandstandUrl(), key: '' }
}

export function saveBandstandConfig(cfg: BandstandConfig): void {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg))
}

/** '' means same-origin  -  legal only when Bandstand serves this app. */
export function resolveBase(cfg: BandstandConfig, loc?: Loc): string {
  const base = cfg.url.trim().replace(/\/+$/, '')
  if (!base && !servedByBandstand(loc)) throw new Error('No Bandstand URL configured')
  return base
}

/** POST the live chart JSON to Bandstand. Upserts by chart.id server-side,
    so re-sending after an edit updates the piece instead of duplicating. */
export async function sendToBandstand(chart: Chart, cfg: BandstandConfig): Promise<void> {
  const base = resolveBase(cfg)
  if (!cfg.key.trim()) throw new Error('No Bandstand key configured')
  const res = await fetch(`${base}/api/upload-chart`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bandstand-Key': cfg.key.trim(),
    },
    body: JSON.stringify({ chart }),
  })
  if (!res.ok) throw new Error(`Bandstand said ${res.status}`)
}

/** POST an entire ordered set: upserts every chart AND a matching Bandstand
    setlist in one request. Re-sending follows Saltycharts as source of truth
    (name + order). */
export async function sendSetToBandstand(
  setlist: { id: string; name: string },
  charts: Chart[],
  cfg: BandstandConfig,
): Promise<void> {
  const base = resolveBase(cfg)
  if (!cfg.key.trim()) throw new Error('No Bandstand key configured')
  const res = await fetch(`${base}/api/upload-setlist`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bandstand-Key': cfg.key.trim(),
    },
    body: JSON.stringify({ setlist: { id: setlist.id, name: setlist.name || 'Untitled set', charts } }),
  })
  if (!res.ok) throw new Error(`Bandstand said ${res.status}`)
}
