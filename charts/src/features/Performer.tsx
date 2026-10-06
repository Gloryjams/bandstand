import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/store/useStore'
import { ChartGrid } from '@/components/ChartGrid'
import { IconClose, IconChevronLeft, IconChevronRight, IconMinus, IconMoon, IconPlus, IconScroll } from '@/ui/Icon'

/* Stage theme is a per-device choice (dim rooms want pepper ground, salt ink). */
const LS_STAGE_DARK = 'saltycharts.stagedark.v1'

interface Props {
  chartIds: string[]
  startIndex: number
  title?: string
  onClose: () => void
}

export function Performer({ chartIds, startIndex, title, onClose }: Props) {
  const charts = useStore((s) => s.charts)
  const [idx, setIdx] = useState(Math.min(startIndex, Math.max(0, chartIds.length - 1)))
  const [transpose, setTranspose] = useState(0)
  const [nashville, setNashville] = useState(false)
  const [autoScroll, setAutoScroll] = useState(false)
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem(LS_STAGE_DARK) === '1' } catch { return false }
  })
  const toggleDark = () => setDark((v) => {
    const next = !v
    try { localStorage.setItem(LS_STAGE_DARK, next ? '1' : '0') } catch { /* private mode */ }
    return next
  })
  const bodyRef = useRef<HTMLDivElement>(null)
  const touchX = useRef<number | null>(null)

  // minimal stage: chrome fades away, the chart owns the screen; a center tap
  // brings the controls back for a few seconds
  const [chrome, setChrome] = useState(true)
  const chromeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showChrome = () => {
    setChrome(true)
    if (chromeTimer.current) clearTimeout(chromeTimer.current)
    chromeTimer.current = setTimeout(() => setChrome(false), 3500)
  }
  useEffect(() => {
    showChrome()
    return () => {
      if (chromeTimer.current) clearTimeout(chromeTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chart = charts[chartIds[idx]]

  const go = (d: -1 | 1) => {
    const n = idx + d
    if (n < 0 || n >= chartIds.length) return
    setIdx(n)
    setTranspose(0)
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }

  // reset scroll on song change
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [idx])

  // auto-scroll loop
  useEffect(() => {
    if (!autoScroll) return
    const el = bodyRef.current
    if (!el) return
    const t = setInterval(() => {
      if (!el) return
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
        setAutoScroll(false)
        return
      }
      el.scrollTop += 1
    }, 40)
    return () => clearInterval(t)
  }, [autoScroll, idx])

  // keyboard nav (Bluetooth page-turn pedals emit arrows / page keys)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1)
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1)
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!chart) {
    return (
      <div className={`stage${dark ? ' dark' : ''}`}>
        <div className="empty" style={{ margin: 'auto' }}>
          <p>Song not found.</p>
          <button className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    )
  }

  const displayKey = chart.key
  const sizeClass = chart.settings.fontSize === 'xl' ? 'xl' : chart.settings.fontSize === 'large' ? 'large' : ''

  return (
    <div className={`stage${dark ? ' dark' : ''}`}>
      <div className={`stage-head${chrome ? '' : ' faded'}`}>
        <button className="btn icon ghost" onClick={onClose}><IconClose size={20} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{chart.title || 'Untitled'}</div>
          <div className="s">{[chart.artist, title].filter(Boolean).join(' · ') || displayKey}</div>
        </div>
        <div className="transpose-pill">
          <button className="btn icon ghost" onClick={() => setTranspose((t) => t - 1)}><IconMinus size={15} /></button>
          <span className="val" style={{ minWidth: 42 }}>{transposeLabel(chart.key, transpose)}</span>
          <button className="btn icon ghost" onClick={() => setTranspose((t) => t + 1)}><IconPlus size={15} /></button>
        </div>
        <button className={`btn icon ghost ${nashville ? 'primary' : ''}`} onClick={() => setNashville((v) => !v)} style={{ fontWeight: 800, fontSize: 12 }}>#</button>
        <button className={`btn icon ghost ${dark ? 'primary' : ''}`} onClick={toggleDark} aria-label="Dark stage"><IconMoon size={18} /></button>
        <button className={`btn icon ghost ${autoScroll ? 'primary' : ''}`} onClick={() => setAutoScroll((v) => !v)}><IconScroll size={18} /></button>
      </div>

      {/* tap zones: sides turn pages, center summons the controls */}
      <div className="stage-nav-zone left" onClick={() => go(-1)} />
      <div className="stage-nav-zone right" onClick={() => go(1)} />
      <div className="stage-nav-zone center" onClick={() => (chrome ? setChrome(false) : showChrome())} />

      <div
        className={`stage-body ${sizeClass}`}
        ref={bodyRef}
        onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touchX.current === null) return
          const dx = e.changedTouches[0].clientX - touchX.current
          if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1)
          touchX.current = null
        }}
      >
        <ChartGrid chart={chart} transpose={transpose} nashville={nashville} roadmapRail />
        <div style={{ height: 40 }} />
      </div>

      {chartIds.length > 1 && (
        <div className={`stage-foot${chrome ? '' : ' faded'}`}>
          <button className="btn ghost" onClick={() => go(-1)} disabled={idx === 0}><IconChevronLeft size={18} /></button>
          <div className="stage-progress">
            {chartIds.map((id, i) => (
              <span key={id} className={`stage-dot ${i === idx ? 'active' : ''}`} onClick={() => setIdx(i)} />
            ))}
          </div>
          <div className="s">{idx + 1} / {chartIds.length}</div>
          <button className="btn ghost" onClick={() => go(1)} disabled={idx === chartIds.length - 1}><IconChevronRight size={18} /></button>
        </div>
      )}
    </div>
  )
}

function transposeLabel(key: string, t: number): string {
  if (t === 0) return key
  return (t > 0 ? '+' : '') + t
}
