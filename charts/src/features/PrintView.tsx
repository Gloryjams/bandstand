import { useEffect } from 'react'
import type { Chart } from '@/types'
import { ChartGrid } from '@/components/ChartGrid'
import { preferFlats, transposedNote } from '@/lib/theory'

/** Print-clean part: white page, monochrome chart, written transposition.
    Mounts, fires the print dialog, closes itself after printing. */
export function PrintView({
  chart,
  semis,
  label,
  onClose,
}: {
  chart: Chart
  semis: number
  label: string
  onClose: () => void
}) {
  useEffect(() => {
    const done = () => onClose()
    window.addEventListener('afterprint', done)
    const t = setTimeout(() => window.print(), 120)
    return () => {
      window.removeEventListener('afterprint', done)
      clearTimeout(t)
    }
  }, [onClose])

  const minor = chart.key.endsWith('m')
  const writtenKey = semis
    ? transposedNote(chart.key.replace('m', ''), semis, preferFlats(chart.key)) + (minor ? 'm' : '')
    : chart.key

  return (
    <div className="print-sheet">
      <div className="ps-head">
        <div>
          <h1>{chart.title || 'Untitled'}</h1>
          <div className="ps-sub">
            {[chart.artist, chart.style, chart.time, chart.bpm ? `${chart.bpm} bpm` : '']
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div className="ps-right">
          <div className="ps-part">{label}</div>
          <div className="ps-key">in {writtenKey}</div>
        </div>
      </div>
      <ChartGrid chart={chart} transpose={semis} />
      <div className="row no-print" style={{ gap: 8, marginTop: 24 }}>
        <button className="btn" onClick={() => window.print()}>Print again</button>
        <button className="btn primary" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}
