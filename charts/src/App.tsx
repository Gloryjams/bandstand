import { useEffect, useState } from 'react'
import { useStore } from '@/store/useStore'
import { servedByBandstand } from '@/lib/bandstand'
import { initSync, isSyncActive } from '@/lib/sync'
import { Library } from '@/features/Library'
import { Editor } from '@/features/Editor'
import { SetlistView } from '@/features/SetlistView'
import { Performer } from '@/features/Performer'
import { ImportDialog } from '@/features/ImportDialog'
import { MomentStack } from '@/ui/moments'
import {
  IconLibrary,
  IconPlus,
  IconImport,
  IconChevronLeft,
  IconPlay,
  IconCopy,
  IconTrash,
} from '@/ui/Icon'

export type View = 'library' | 'editor' | 'setlist' | 'perform'
export interface NavState {
  view: View
  chartId?: string
  setlistId?: string
  perfIndex?: number
}
export interface Nav {
  state: NavState
  go: (s: NavState) => void
  back: () => void
}

export default function App() {
  const [stack, setStack] = useState<NavState[]>([{ view: 'library' }])
  const [importing, setImporting] = useState(false)
  const state = stack[stack.length - 1]

  const charts = useStore((s) => s.charts)
  const createChart = useStore((s) => s.createChart)
  const deleteChart = useStore((s) => s.deleteChart)
  const duplicateChart = useStore((s) => s.duplicateChart)
  const deleteSetlist = useStore((s) => s.deleteSetlist)
  const setlists = useStore((s) => s.setlists)
  const ensureSeeded = useStore((s) => s.ensureSeeded)

  useEffect(() => {
    // With sync active the server library is the truth: seeding a fresh origin
    // would push the sample charts into the real library. The first pull fills
    // the library instead.
    if (!isSyncActive()) ensureSeeded()
    initSync()
  }, [ensureSeeded])

  const nav: Nav = {
    state,
    go: (s) => setStack((cur) => [...cur, s]),
    back: () => setStack((cur) => (cur.length > 1 ? cur.slice(0, -1) : cur)),
  }
  const goRoot = () => setStack([{ view: 'library' }])

  // ---- Performance mode is a full-screen takeover ----
  if (state.view === 'perform') {
    let chartIds: string[] = []
    let title: string | undefined
    if (state.setlistId && setlists[state.setlistId]) {
      chartIds = setlists[state.setlistId].chartIds
      title = setlists[state.setlistId].name
    } else if (state.chartId) {
      chartIds = [state.chartId]
    }
    return (
      <>
        <Performer chartIds={chartIds} startIndex={state.perfIndex ?? 0} title={title} onClose={nav.back} />
        <MomentStack />
      </>
    )
  }

  const chart = state.chartId ? charts[state.chartId] : undefined

  return (
    <div className="app">
      <div className="topbar">
        {state.view === 'library' ? (
          <h1>
            <span className="brand-mark">
              <SaltLogo />
            </span>
            Saltycharts
          </h1>
        ) : (
          <button className="btn icon ghost" onClick={nav.back}>
            <IconChevronLeft size={22} />
          </button>
        )}
        <div className="spacer" />

        {state.view === 'editor' && chart && (
          <div className="row">
            <button className="btn icon ghost" onClick={() => duplicateChart(chart.id)}><IconCopy size={18} /></button>
            <button className="btn icon ghost danger" onClick={() => { if (confirm('Delete this chart?')) { deleteChart(chart.id); goRoot() } }}><IconTrash size={18} /></button>
            <button className="btn primary sm" onClick={() => nav.go({ view: 'perform', chartId: chart.id, perfIndex: 0 })}><IconPlay size={15} /> Perform</button>
          </div>
        )}
        {state.view === 'setlist' && state.setlistId && (
          <button className="btn icon ghost danger" onClick={() => { if (confirm('Delete this setlist?')) { deleteSetlist(state.setlistId!); goRoot() } }}><IconTrash size={18} /></button>
        )}
      </div>

      <div className="view">
        {state.view === 'library' && <Library nav={nav} onImport={() => setImporting(true)} />}
        {state.view === 'editor' && state.chartId && <Editor chartId={state.chartId} />}
        {state.view === 'setlist' && state.setlistId && <SetlistView setlistId={state.setlistId} nav={nav} />}
      </div>

      <nav className="tabbar">
        <div className="inner">
          <button className={`tab ${state.view === 'library' ? 'active' : ''}`} onClick={goRoot}>
            <span className="tab-ico"><IconLibrary size={20} /></span>
            Library
          </button>
          <button className="tab fab" onClick={() => nav.go({ view: 'editor', chartId: createChart() })}>
            <span className="tab-ico"><IconPlus size={22} /></span>
          </button>
          <button className="tab" onClick={() => setImporting(true)}>
            <span className="tab-ico"><IconImport size={20} /></span>
            Import
          </button>
          {servedByBandstand() && (
            <a className="tab tab-bonito" href="/app/">
              <span className="tab-ico"><BonitoHead /></span>
              Bandstand
            </a>
          )}
        </div>
      </nav>

      {importing && <ImportDialog nav={nav} onClose={() => setImporting(false)} />}
      <MomentStack />
    </div>
  )
}

/* Bonito's head, cropped from the canonical mascot: colors and shapes per
   design/assets/bonito.svg (fur gradient ffc98a→e88a3a, conductor hat
   2a3a6b→101a3a, gold band C9B46A, outline 6B4A18). He is the one colorful
   thing on the salt/pepper surface: the portal back to Bandstand. */
function BonitoHead() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
      <defs>
        <linearGradient id="bo-fur" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffc98a" />
          <stop offset="1" stopColor="#e88a3a" />
        </linearGradient>
        <linearGradient id="bo-hat" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a3a6b" />
          <stop offset="1" stopColor="#101a3a" />
        </linearGradient>
      </defs>
      {/* ears */}
      <path d="M10 16 L15 5 L22 13 Z" fill="url(#bo-fur)" stroke="#6B4A18" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M38 16 L33 5 L26 13 Z" fill="url(#bo-fur)" stroke="#6B4A18" strokeWidth="1.6" strokeLinejoin="round" />
      {/* head */}
      <circle cx="24" cy="26" r="16" fill="url(#bo-fur)" stroke="#6B4A18" strokeWidth="1.8" />
      {/* conductor hat */}
      <path d="M11 15 Q24 4 37 15 L36 19 Q24 13 12 19 Z" fill="url(#bo-hat)" stroke="#101a3a" strokeWidth="1" />
      <rect x="12" y="16.5" width="24" height="2.6" rx="1.3" fill="#C9B46A" />
      {/* face */}
      <circle cx="18.5" cy="28" r="1.9" fill="#3A2A10" />
      <circle cx="29.5" cy="28" r="1.9" fill="#3A2A10" />
      <path d="M21.5 33 Q24 35.4 26.5 33" fill="none" stroke="#3A2A10" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M23 31.2 L25 31.2 L24 32.6 Z" fill="#3A2A10" />
    </svg>
  )
}

function SaltLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M7 9 q0-2 2-2 l6 0 q2 0 2 2 l0 10 q0 2-2 2 l-6 0 q-2 0-2-2 z" fill="currentColor" opacity="0.18" />
      <path d="M7 9 q0-2 2-2 l6 0 q2 0 2 2 l0 10 q0 2-2 2 l-6 0 q-2 0-2-2 z" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 9 q-1-4 4-4 q5 0 4 4 z" fill="currentColor" />
      <circle cx="10" cy="14" r="0.9" fill="currentColor" />
      <circle cx="13" cy="17" r="0.9" fill="currentColor" />
    </svg>
  )
}
