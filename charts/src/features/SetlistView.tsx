import { useState } from 'react'
import { useStore } from '@/store/useStore'
import type { BandPart } from '@/types'
import { uid } from '@/lib/id'
import { transposeChartForPart } from '@/lib/theory'
import { chartToMusicXML } from '@/lib/musicxml'
import { loadBandstandConfig, sendSetToBandstand } from '@/lib/bandstand'
import { fireMoment } from '@/ui/moments'
import { IconPlay, IconPlus, IconTrash, IconChevronLeft, IconChevronRight, IconClose } from '@/ui/Icon'
import { MascotGuide } from '@/ui/Mascot'
import { PrintBook } from '@/features/PrintBook'
import type { Nav } from '@/App'

/** Standard written transpositions a school/ensemble band actually needs. */
const PART_PALETTE: { label: string; semis: number }[] = [
  { label: 'Concert', semis: 0 },
  { label: 'Bass', semis: 0 },
  { label: '−½ Step', semis: -1 }, // standard-tuning player reading an Eb-tuning book
  { label: '+½ Step', semis: 1 }, // Eb-tuned guitar reading concert charts
  { label: 'B♭ Part', semis: 2 },
  { label: 'E♭ Part', semis: 9 },
  { label: 'F Part', semis: 7 },
]

export function SetlistView({ setlistId, nav }: { setlistId: string; nav: Nav }) {
  const setlist = useStore((s) => s.setlists[setlistId])
  const charts = useStore((s) => s.charts)
  const saveSetlist = useStore((s) => s.saveSetlist)
  const reorder = useStore((s) => s.reorderSetlist)
  const removeFrom = useStore((s) => s.removeFromSetlist)
  const addTo = useStore((s) => s.addToSetlist)
  const [picking, setPicking] = useState(false)
  const [printing, setPrinting] = useState<BandPart | null>(null)
  const [sendingSet, setSendingSet] = useState(false)

  if (!setlist) return <div className="empty">Setlist not found.</div>

  const songs = setlist.chartIds.map((id) => charts[id]).filter(Boolean)
  const band = setlist.band ?? []
  const addPart = (p: { label: string; semis: number }) =>
    saveSetlist({ ...setlist, band: [...band, { id: uid('part'), ...p }] })
  const removePart = (id: string) =>
    saveSetlist({ ...setlist, band: band.filter((b) => b.id !== id) })

  // engraved set: one numbered .musicxml per chart, transposed for the part;
  // the desktop engraver renders each to PDF in Downloads
  const engraveSet = (bp: BandPart) => {
    const slug = (t: string) =>
      (t || 'untitled').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase()
    const partSlug = bp.semis > 0 ? `-${slug(bp.label)}` : ''
    songs.forEach((c, i) => {
      const xml = chartToMusicXML(transposeChartForPart(c, bp.semis), { partLabel: bp.label })
      const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${String(i + 1).padStart(2, '0')}-${slug(c.title)}${partSlug}.musicxml`
      document.body.appendChild(a)
      // stagger so the browser accepts the burst of downloads
      setTimeout(() => {
        a.click()
        a.remove()
        URL.revokeObjectURL(a.href)
      }, i * 350)
    })
    fireMoment(`Engraving ${songs.length} charts for ${bp.label}...`, {})
  }

  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= setlist.chartIds.length) return
    const arr = [...setlist.chartIds]
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
    reorder(setlistId, arr)
  }

  const notInList = Object.values(charts)
    .filter((c) => !setlist.chartIds.includes(c.id))
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''))

  return (
    <>
      <div className="meta-grid">
        <input className="input full" value={setlist.name} placeholder="Setlist name" style={{ fontWeight: 700, fontSize: 18 }} onChange={(e) => saveSetlist({ ...setlist, name: e.target.value })} />
        <input className="input" value={setlist.venue ?? ''} placeholder="Venue" onChange={(e) => saveSetlist({ ...setlist, venue: e.target.value })} />
        <input className="input" value={setlist.date ?? ''} placeholder="Date" onChange={(e) => saveSetlist({ ...setlist, date: e.target.value })} />
      </div>

      {songs.length > 0 ? (
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center', margin: '6px 0 18px' }} onClick={() => nav.go({ view: 'perform', setlistId, perfIndex: 0 })}>
          <IconPlay size={18} /> Perform set
        </button>
      ) : (
        <MascotGuide>
          Empty set. Add songs from your library and I'll line them up for the gig  -  swipe between them on stage.
        </MascotGuide>
      )}

      <div className="section-title">Songs <span className="line" /><span className="hint">{songs.length}</span></div>
      <div className="cards">
        {songs.map((c, i) => (
          <div key={c.id} className="song-card" style={{ cursor: 'default' }}>
            <span className="song-key" style={{ width: 32, height: 32, fontSize: 12 }}>{i + 1}</span>
            <span className="song-meta" onClick={() => nav.go({ view: 'perform', setlistId, perfIndex: i })} style={{ cursor: 'pointer' }}>
              <span className="t">{c.title || 'Untitled'}</span>
              <span className="s">{c.artist || ' - '} · {c.key}</span>
            </span>
            <button className="btn icon ghost" onClick={() => move(i, -1)} disabled={i === 0}><IconChevronLeft size={16} style={{ transform: 'rotate(90deg)' }} /></button>
            <button className="btn icon ghost" onClick={() => move(i, 1)} disabled={i === songs.length - 1}><IconChevronRight size={16} style={{ transform: 'rotate(90deg)' }} /></button>
            <button className="btn icon ghost danger" onClick={() => removeFrom(setlistId, c.id)}><IconTrash size={16} /></button>
          </div>
        ))}
      </div>

      <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 14 }} onClick={() => setPicking(true)}>
        <IconPlus size={16} /> Add songs
      </button>

      {/* the set's instrumentation -> one-tap part books */}
      <div className="section-title">Band <span className="line" /></div>
      {band.length === 0 && (
        <p className="hint" style={{ marginBottom: 8 }}>
          Add the instrumentation once. Then every part prints the whole set, transposed, in one tap.
        </p>
      )}
      {band.length > 0 && (
        <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
          {band.map((bp) => (
            <span key={bp.id} className="chip part-chip">
              {bp.label}
              <button className="part-x" onClick={() => removePart(bp.id)} aria-label={`Remove ${bp.label}`}>
                <IconClose size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="row wrap" style={{ gap: 6 }}>
        {PART_PALETTE.map((p) => (
          <button key={p.label} className="vocab-chip" type="button" onClick={() => addPart(p)}>
            + {p.label}
          </button>
        ))}
      </div>

      {band.length > 0 && songs.length > 0 && (
        <>
          <div className="section-title">Print parts <span className="line" /></div>
          <div className="center-col">
            {band.map((bp) => (
              <div key={bp.id} className="row" style={{ gap: 8 }}>
                <button className="btn" style={{ flex: 1, justifyContent: 'space-between' }} onClick={() => setPrinting(bp)}>
                  <span style={{ fontWeight: 700 }}>{bp.label} book</span>
                  <span className="hint">{songs.length} chart{songs.length === 1 ? '' : 's'}</span>
                </button>
                <button className="btn" onClick={() => engraveSet(bp)}>Engrave</button>
              </div>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 6 }}>
            Print opens the quick book. Engrave exports publisher-style scores, transposed
            for the part; PDFs land in Downloads automatically.
          </p>
        </>
      )}

      {songs.length > 0 && (
        <>
          <div className="section-title">Gig book <span className="line" /></div>
          <button
            className="btn"
            style={{ width: '100%', justifyContent: 'center' }}
            disabled={sendingSet}
            onClick={async () => {
              const cfg = loadBandstandConfig()
              if (!cfg.key.trim()) {
                fireMoment('Set the Bandstand key first (any chart, Parts sheet)', {})
                return
              }
              setSendingSet(true)
              try {
                await sendSetToBandstand(setlist, songs, cfg)
                fireMoment(`Set sent to Bandstand: ${songs.length} charts, in order`, {})
              } catch (err) {
                fireMoment(`Bandstand: ${err instanceof Error ? err.message : 'send failed'}`, {})
              } finally {
                setSendingSet(false)
              }
            }}
          >
            {sendingSet ? 'Sending...' : 'Send set to Bandstand'}
          </button>
          <p className="hint" style={{ marginTop: 6 }}>
            Pushes every chart plus the set order to your tablet. Re-sending updates the
            same setlist.
          </p>
        </>
      )}

      {printing && (
        <PrintBook
          setlist={setlist}
          charts={songs}
          semis={printing.semis}
          label={printing.label}
          onClose={() => setPrinting(null)}
        />
      )}

      {picking && (
        <div className="sheet-backdrop" onClick={() => setPicking(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="grab" />
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>Add songs</h2>
              <button className="btn icon ghost" onClick={() => setPicking(false)}><IconClose size={18} /></button>
            </div>
            {notInList.length === 0 ? (
              <p className="hint">Every song is already in this set.</p>
            ) : (
              <div className="cards">
                {notInList.map((c) => (
                  <button key={c.id} className="song-card" onClick={() => addTo(setlistId, c.id)}>
                    <span className="song-key">{c.key}</span>
                    <span className="song-meta"><span className="t">{c.title || 'Untitled'}</span><span className="s">{c.artist || ' - '}</span></span>
                    <span className="btn icon primary"><IconPlus size={16} /></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
