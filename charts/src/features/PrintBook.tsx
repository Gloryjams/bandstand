import { useEffect } from 'react'
import type { Chart, Setlist } from '@/types'
import { ChartGrid } from '@/components/ChartGrid'
import { writtenKey } from '@/lib/theory'

/** Print-clean book for one instrument: every chart in the set, in order,
    one page per tune, at the part's written transposition. Mounts, fires
    the print dialog, closes after printing. */
export function PrintBook({
  setlist,
  charts,
  semis,
  label,
  onClose,
}: {
  setlist: Setlist
  charts: Chart[]
  semis: number
  label: string
  onClose: () => void
}) {
  useEffect(() => {
    const done = () => onClose()
    window.addEventListener('afterprint', done)
    const t = setTimeout(() => window.print(), 150)
    return () => {
      window.removeEventListener('afterprint', done)
      clearTimeout(t)
    }
  }, [onClose])

  return (
    <div className="print-sheet">
      {charts.map((c, i) => (
        <div className="pb-chart" key={c.id}>
          <div className="ps-head">
            <div>
              <h1>{c.title || 'Untitled'}</h1>
              <div className="ps-sub">
                {[c.artist, c.style, c.time, c.bpm ? `${c.bpm} bpm` : ''].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="ps-right">
              <div className="ps-part">{label}</div>
              <div className="ps-key">in {writtenKey(c.key, semis)}</div>
              <div className="ps-set">
                {[setlist.name, `${i + 1} of ${charts.length}`].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
          <ChartGrid chart={c} transpose={semis} />
        </div>
      ))}
      <div className="row no-print" style={{ gap: 8, marginTop: 24 }}>
        <button className="btn" onClick={() => window.print()}>Print again</button>
        <button className="btn primary" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}
