import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/store/useStore'
import type { ArrangementStep, Bar, Chart, Barline, Section } from '@/types'
import { ChartGrid, isLetterMark, sectionMarks } from '@/components/ChartGrid'
import { HitStaff } from '@/components/HitStaff'
import { newArrangementStep, newBar, newSection } from '@/lib/factory'
import { uid } from '@/lib/id'
import { PrintView } from '@/features/PrintView'
import { loadBandstandConfig, saveBandstandConfig, sendToBandstand, servedByBandstand, type BandstandConfig } from '@/lib/bandstand'
import { chartToMusicXML } from '@/lib/musicxml'
import { navDecorations } from '@/lib/navdecor'
import {
  ALL_KEYS,
  extractHitsFromChords,
  getDiatonicChords,
  normalizeChordInput,
  preferFlats,
  transposeBar,
  transposeKey,
  semitonesBetween,
} from '@/lib/theory'
import { splitBarsInput } from '@/lib/barsInput'
import {
  IconPlus,
  IconMinus,
  IconTrash,
  IconCopy,
  IconImport,
  IconSettings,
  IconChevronLeft,
  IconChevronRight,
} from '@/ui/Icon'
import { fireMoment } from '@/ui/moments'

type Sel = { si: number; bi: number } | null

const BARLINES: { v: Barline; label: string }[] = [
  { v: 'normal', label: 'Normal' },
  { v: 'repeat-start', label: 'Repeat ‖:' },
  { v: 'repeat-end', label: 'Repeat :‖' },
  { v: 'double', label: 'Double' },
  { v: 'final', label: 'Final' },
]

export function Editor({ chartId }: { chartId: string }) {
  const chart = useStore((s) => s.charts[chartId])
  const saveChart = useStore((s) => s.saveChart)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)

  const [sel, setSel] = useState<Sel>(null)
  // bar whose full details sheet (barline, volta, hits, lyric) is open  -
  // separate from `sel`, which is the fast inline chord editor
  const [sheetSel, setSheetSel] = useState<Sel>(null)
  // multi-measure selection for copy/paste: anchored at sel, extended with shift+arrows
  const [range, setRange] = useState<{ si: number; from: number; to: number } | null>(null)
  // section drag-to-reorder (grip handle); letters are positional so moving a
  // section re-letters everything  -  the roadmap follows by section identity
  const secWrapRef = useRef<HTMLDivElement>(null)
  const secDrag = useRef<{ from: number; startY: number; moved: boolean } | null>(null)
  const [secDrop, setSecDrop] = useState<number | null>(null)
  // key change: ask whether to transpose the chords or just relabel the key
  const [keyChange, setKeyChange] = useState<string | null>(null)
  // parts export: pick a transposition, get a print-clean page
  const [partsOpen, setPartsOpen] = useState(false)
  const [printPart, setPrintPart] = useState<{ semis: number; label: string } | null>(null)
  // send-to-Bandstand (gig book) config + state
  const [bsCfg, setBsCfg] = useState<BandstandConfig>(loadBandstandConfig)
  const [sending, setSending] = useState(false)
  const patchBs = (p: Partial<BandstandConfig>) => {
    const next = { ...bsCfg, ...p }
    setBsCfg(next)
    saveBandstandConfig(next)
  }
  const exportMusicXML = () => {
    const xml = chartToMusicXML(chart)
    const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(chart.title || 'untitled').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase()}.musicxml`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(a.href)
    fireMoment('Engraving... PDF lands in Downloads in a few seconds', {})
  }

  const doSendToBandstand = async () => {
    setSending(true)
    try {
      await sendToBandstand(chart, bsCfg)
      fireMoment('Sent to Bandstand', {})
      setPartsOpen(false)
    } catch (err) {
      fireMoment(`Bandstand: ${err instanceof Error ? err.message : 'send failed'}`, {})
    } finally {
      setSending(false)
    }
  }
  const [nashville, setNashville] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [secSheet, setSecSheet] = useState<number | null>(null)

  if (!chart) return <div className="empty">Chart not found.</div>

  const update = (mut: (c: Chart) => void) => {
    const next = structuredClone(chart)
    mut(next)
    saveChart(next)
  }
  const meta = (patch: Partial<Chart>) => update((c) => Object.assign(c, patch))

  const doTranspose = (semis: number) =>
    update((c) => {
      const newKey = transposeKey(c.key, semis)
      const flats = preferFlats(newKey)
      c.sections.forEach((s) => s.bars.forEach((b) => (b.chords = transposeBar(b.chords, semis, flats))))
      c.key = newKey
    })

  // transpose to an explicitly chosen key, preserving its enharmonic spelling
  const transposeToKey = (target: string) =>
    update((c) => {
      const semis = semitonesBetween(c.key, target)
      const flats = preferFlats(target)
      c.sections.forEach((s) => s.bars.forEach((b) => (b.chords = transposeBar(b.chords, semis, flats))))
      c.key = target
    })

  // matches the chart's character: all-pocket charts grow pocket sections
  const addSection = () =>
    update((c) => {
      const pocket = c.sections.every((s) => s.bars.length === 0)
      const sec = newSection('', pocket ? 0 : 4)
      if (pocket) sec.description = ''
      c.sections.push(sec)
    })

  // ×N on any section header: tap cycles the common counts
  const cycleRepeats = (si: number) =>
    update((c) => {
      const s = c.sections[si]
      const cycle = [1, 2, 3, 4, 5, 6, 8]
      const cur = s.repeats ?? 1
      const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length] ?? 2
      s.repeats = next === 1 ? undefined : next
    })

  const copySection = (si: number) =>
    update((c) => {
      const src = c.sections[si]
      const clone: Section = structuredClone(src)
      clone.id = uid('sec')
      const m = clone.label.match(/^(.*?)(\d+)$/)
      clone.label = m ? `${m[1]}${parseInt(m[2], 10) + 1}` : clone.label ? `${clone.label} 2` : ''
      c.sections.splice(si + 1, 0, clone)
    })

  const diatonic = getDiatonicChords(chart.key)

  // Barline-as-delimiter, paste half: "C | Am | F G | C" pasted into the inline
  // editor writes forward from the selected bar (a multi-bar paste is an
  // intentional bulk write), growing the section as needed, and lands the
  // selection on the last written bar. One update - see insertChordPalette.
  const writeBarsFrom = (segs: string[]) => {
    if (!sel) return
    update((c) => {
      const bars = c.sections[sel.si].bars
      while (bars.length < sel.bi + segs.length) bars.push(newBar())
      segs.forEach((chords, i) => {
        bars[sel.bi + i].chords = chords
      })
    })
    setRange(null)
    setSel({ si: sel.si, bi: sel.bi + segs.length - 1 })
    // A lone trailing barline is Android typing "advance", not a paste.
    if (segs.length > 2 || (segs[1] ?? '') !== '') fireMoment(`${segs.length} bars written`, {})
  }

  const insertChordPalette = (chord: string) => {
    if (!sel) {
      fireMoment('Tap a bar first', {})
      return
    }
    // One tap per bar: filling an EMPTY bar advances the selection (growing the
    // section off the end, same punch-in flow as Enter). Adding a second chord
    // to a non-empty bar stays put, and the palette's back arrow is the one-tap
    // remedy when a bar needs two chords. Everything rides ONE update: `update`
    // clones the closure chart, so a second update in the same tick would lose
    // the first (the chord insert).
    const wasEmpty = !chart.sections[sel.si].bars[sel.bi].chords
    const atEnd = wasEmpty && !stepSel(sel, 1)
    update((c) => {
      const bar = c.sections[sel.si].bars[sel.bi]
      bar.chords = bar.chords ? `${bar.chords} ${chord}` : chord
      if (atEnd) c.sections[sel.si].bars.push(newBar())
    })
    if (wasEmpty) {
      setRange(null)
      const n = stepSel(sel, 1)
      setSel(n ?? { si: sel.si, bi: sel.bi + 1 })
    }
  }

  const anyBars = chart.sections.some((s) => s.bars.length > 0)
  const marks = sectionMarks(chart.sections)
  // derived classic navigation (repeats/voltas/D.S./coda) from the roadmap
  const nav = chart.settings.classicNav !== false ? navDecorations(chart) : null

  // Punch-in shorthand: on leaving a bar, beat tokens typed among the chords
  // ("% 4 4+") peel off into that bar's hit figure.
  const commitPunch = (s: NonNullable<Sel>) => {
    const b = chart.sections[s.si]?.bars[s.bi]
    if (!b) return
    const ex = extractHitsFromChords(b.chords)
    if (ex.hits) {
      update((c) => {
        const bb = c.sections[s.si].bars[s.bi]
        bb.chords = ex.chords
        bb.hits = ex.hits
      })
    }
  }

  /* ---- measure clipboard (module-level so it survives navigation) ---- */
  const extendRange = (dir: -1 | 1) => {
    if (!sel) return
    const bars = chart.sections[sel.si].bars
    const cur = range && range.si === sel.si ? range : { si: sel.si, from: sel.bi, to: sel.bi }
    const to = Math.max(0, Math.min(bars.length - 1, cur.to + dir))
    setRange({ ...cur, to })
  }
  const selSpan = (): { si: number; a: number; b: number } | null => {
    if (!sel) return null
    const r = range && range.si === sel.si ? range : { si: sel.si, from: sel.bi, to: sel.bi }
    return { si: r.si, a: Math.min(r.from, r.to), b: Math.max(r.from, r.to) }
  }
  const copyBars = () => {
    const s = selSpan()
    if (!s) return
    barClipboard = chart.sections[s.si].bars.slice(s.a, s.b + 1).map((x) => structuredClone(x))
    fireMoment(`Copied ${barClipboard.length} bar${barClipboard.length === 1 ? '' : 's'}`, {})
  }
  const cutBars = () => {
    const s = selSpan()
    if (!s) return
    copyBars()
    update((c) => {
      const bars = c.sections[s.si].bars
      bars.splice(s.a, s.b - s.a + 1)
      if (bars.length === 0) bars.push(newBar())
    })
    const newLen = Math.max(1, chart.sections[s.si].bars.length - (s.b - s.a + 1))
    setRange(null)
    setSel({ si: s.si, bi: Math.min(s.a, newLen - 1) })
  }
  const pasteBars = () => {
    if (!sel || barClipboard.length === 0) return
    const at = sel
    update((c) => {
      const bars = c.sections[at.si].bars
      while (bars.length < at.bi + barClipboard.length) bars.push(newBar())
      barClipboard.forEach((b, i) => {
        bars[at.bi + i] = structuredClone(b)
      })
    })
    setRange(null)
    setSel({ si: at.si, bi: at.bi + barClipboard.length - 1 })
    fireMoment(`Pasted ${barClipboard.length} bar${barClipboard.length === 1 ? '' : 's'}`, {})
  }

  /* ---- section drag-to-reorder ---- */
  const secIndexFromY = (y: number): number => {
    const rows = secWrapRef.current?.querySelectorAll<HTMLElement>('.sec-row') ?? []
    let idx = rows.length
    rows.forEach((row, i) => {
      const r = row.getBoundingClientRect()
      if (idx === rows.length && y < r.top + r.height / 2) idx = i
    })
    return idx
  }
  const onSecGripDown = (e: React.PointerEvent, si: number) => {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    secDrag.current = { from: si, startY: e.clientY, moved: false }
  }
  const onSecGripMove = (e: React.PointerEvent) => {
    const d = secDrag.current
    if (!d) return
    if (!d.moved && Math.abs(e.clientY - d.startY) < 10) return
    d.moved = true
    setSecDrop(secIndexFromY(e.clientY))
  }
  const onSecGripUp = () => {
    const d = secDrag.current
    secDrag.current = null
    const drop = secDrop
    setSecDrop(null)
    if (!d || !d.moved || drop == null) return
    const to = d.from < drop ? drop - 1 : drop
    if (to === d.from) return
    update((c) => {
      const [m] = c.sections.splice(d.from, 1)
      c.sections.splice(to, 0, m)
    })
    setSel(null)
    setRange(null)
    setSheetSel(null)
    setSecSheet(null)
    fireMoment('Moved  -  sections re-lettered', {})
  }

  const advanceSel = () => {
    if (!sel) return
    setRange(null)
    commitPunch(sel)
    const n = stepSel(sel, 1)
    if (n) setSel(n)
    else {
      // typing off the end grows the section  -  punch-in flow
      update((c) => c.sections[sel.si].bars.push(newBar()))
      setSel({ si: sel.si, bi: sel.bi + 1 })
    }
  }
  const insertBarAfterSel = () => {
    if (!sel) return
    commitPunch(sel)
    update((c) => c.sections[sel.si].bars.splice(sel.bi + 1, 0, newBar()))
    setSel({ si: sel.si, bi: sel.bi + 1 })
  }
  const stepFrom = (dir: -1 | 1 | 'up' | 'down') => {
    if (!sel) return
    setRange(null)
    commitPunch(sel)
    if (dir === 'up' || dir === 'down') {
      const sec = chart.sections[sel.si]
      const bpr = typeof sec.barsPerRow === 'number' ? sec.barsPerRow : chart.settings.barsPerRow
      const bi = sel.bi + (dir === 'down' ? bpr : -bpr)
      if (bi >= 0 && bi < sec.bars.length) setSel({ si: sel.si, bi })
      return
    }
    moveSel(dir)
  }

  return (
    <>
      {/* metadata */}
      <div className="meta-grid">
        <input className="input full" placeholder="Song Title" value={chart.title} onChange={(e) => meta({ title: e.target.value })} style={{ fontWeight: 700, fontSize: 17 }} />
        <input className="input full" placeholder="Artist / Composer" value={chart.artist} onChange={(e) => meta({ artist: e.target.value })} />
        <select className="select" value={chart.key} onChange={(e) => setKeyChange(e.target.value)}>
          {ALL_KEYS.map((k) => (<option key={k} value={k}>{k}</option>))}
        </select>
        <input className="input" placeholder="Time (4/4)" value={chart.time} onChange={(e) => meta({ time: e.target.value })} />
        <input className="input" placeholder="BPM" value={chart.bpm} onChange={(e) => meta({ bpm: e.target.value })} inputMode="numeric" />
        <input className="input" placeholder="Feel / Style" value={chart.style} onChange={(e) => meta({ style: e.target.value })} />
      </div>

      {/* toolbar */}
      <div className="toolbar">
        <div className="transpose-pill">
          <button className="btn icon ghost" onClick={() => doTranspose(-1)} aria-label="Transpose down"><IconMinus size={16} /></button>
          <span className="val">{chart.key}</span>
          <button className="btn icon ghost" onClick={() => doTranspose(1)} aria-label="Transpose up"><IconPlus size={16} /></button>
        </div>
        <button className={`btn sm ${nashville ? 'primary' : ''}`} onClick={() => setNashville((v) => !v)}>Nashville</button>
        <button className="btn sm ghost" onClick={() => undo(chartId)}>Undo</button>
        <button className="btn sm ghost" onClick={() => redo(chartId)}>Redo</button>
        <button className="btn sm ghost" onClick={() => setPartsOpen(true)}>Parts</button>
        <div style={{ flex: 1 }} />
        <button className="btn icon ghost" onClick={() => setShowSettings(true)} aria-label="Layout settings"><IconSettings size={18} /></button>
      </div>

      {/* diatonic chord palette (only useful once bars exist). Back arrow undoes
          an auto-advance in one tap (two-chord bars); % is "same as last bar",
          which with auto-advance makes comping through repeats one tap per bar. */}
      {anyBars && (
        <div className="palette">
          <button className="pal-chord pal-nav" aria-label="Back one bar" onClick={() => stepFrom(-1)}>←</button>
          {diatonic.map((ch, i) => (
            <button key={i} className="pal-chord" onClick={() => insertChordPalette(ch)}>{ch}</button>
          ))}
          <button className="pal-chord" aria-label="Repeat previous bar" onClick={() => insertChordPalette('%')}>%</button>
        </div>
      )}

      {/* sections: pocket rows edit inline; barred sections keep the grid.
          Each row gets a grip  -  drag to reorder, letters re-flow. */}
      <div ref={secWrapRef}>
      {chart.sections.map((section, si) => (
        <div key={section.id} className={`sec-row${secDrag.current?.from === si && secDrop != null ? ' dragging' : ''}`}>
          {secDrop === si && <div className="sec-drop" />}
          <span
            className="sec-grip"
            onPointerDown={(e) => onSecGripDown(e, si)}
            onPointerMove={onSecGripMove}
            onPointerUp={onSecGripUp}
            aria-label={`Drag section ${marks[si]}`}
          >
            <GripIcon />
          </span>
          {section.bars.length === 0 ? (
            <PocketRow chart={chart} si={si} update={update} onCopy={() => copySection(si)} />
          ) : (
          <div className="barred-slice">
            <ChartGrid
              chart={{ ...chart, sections: [section], arrangement: undefined }}
              marks={[marks[si]]}
              nashville={nashville}
              selected={sel?.si === si ? { sectionIdx: 0, barIdx: sel.bi } : null}
              onBarClick={(_zero, bi) => setSel({ si, bi })}
              onSectionClick={() => setSecSheet(si)}
              onRepeatCycle={() => cycleRepeats(si)}
              onRepeatHold={() => setSecSheet(si)}
              navDecor={nav?.decors[si] ?? {}}
              selectedRange={range && range.si === si ? { sectionIdx: 0, from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) } : null}
              barEditor={sel?.si === si ? (
                <InlineBarEditor
                  key={`${sel.si}:${sel.bi}`}
                  chart={chart}
                  sel={sel}
                  update={update}
                  onStep={stepFrom}
                  onAdvance={advanceSel}
                  onInsertAfter={insertBarAfterSel}
                  onDetails={() => setSheetSel(sel)}
                  onClose={() => { commitPunch(sel); setRange(null); setSel(null) }}
                  onCopy={copyBars}
                  onCut={cutBars}
                  onPaste={pasteBars}
                  onExtend={extendRange}
                  onWriteBars={writeBarsFrom}
                />
              ) : undefined}
            />
          </div>
          )}
        </div>
      ))}
      {secDrop === chart.sections.length && <div className="sec-drop" />}
      </div>

      <RoadmapEditor chart={chart} update={update} onAddSection={addSection} />
      {nav && (
        <p className="hint nav-summary">
          {nav.summary}
          {!nav.plan.representable && '  ·  (partial: the rest stays on the roadmap)'}
        </p>
      )}

      {/* Section editor sheet (barred sections; pocket rows edit inline) */}
      {secSheet !== null && chart.sections[secSheet] && (
        <SectionSheet chart={chart} si={secSheet} onClose={() => setSecSheet(null)} update={update} onCopy={() => copySection(secSheet)} />
      )}

      {/* Bar details sheet (barline, volta, hits, lyric)  -  opened from the inline editor */}
      {sheetSel && (
        <BarSheet
          chart={chart}
          sel={sheetSel}
          onClose={() => setSheetSel(null)}
          onMove={(d) => { const n = stepSel(sheetSel, d); if (n) setSheetSel(n) }}
          update={update}
        />
      )}

      {/* Key change: transpose or relabel */}
      {keyChange && keyChange !== chart.key && (
        <div className="sheet-backdrop" onClick={() => setKeyChange(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="grab" />
            <h2>Change key: {chart.key} → {keyChange}</h2>
            <div className="center-col" style={{ marginTop: 8 }}>
              <button
                className="btn primary"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => {
                  transposeToKey(keyChange)
                  setKeyChange(null)
                  fireMoment(`Transposed to ${keyChange}`, {})
                }}
              >
                Transpose the chords
              </button>
              <button
                className="btn"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => {
                  meta({ key: keyChange })
                  setKeyChange(null)
                  fireMoment(`Key relabeled ${keyChange}, chords untouched`, {})
                }}
              >
                Just fix the key label
              </button>
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              Transpose rewrites every chord into the new key. Fixing the label leaves the
              chords exactly as written and re-reads Nashville numbers and the palette
              against the corrected key.
            </p>
          </div>
        </div>
      )}

      {/* Parts export: one tap per transcription */}
      {partsOpen && (
        <div className="sheet-backdrop" onClick={() => setPartsOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="grab" />
            <h2>Export a part</h2>
            <p className="hint" style={{ marginBottom: 12 }}>
              Opens a print-clean page at the written transposition  -  print it or save as PDF.
            </p>
            <div className="center-col">
              {[
                { semis: 0, label: 'Concert', desc: 'piano, guitar, bass, voice' },
                { semis: -1, label: '−½ Step', desc: 'standard tuning reading an Eb-tuning chart' },
                { semis: 1, label: '+½ Step', desc: 'Eb-tuned guitar reading a concert chart' },
                { semis: 2, label: 'B♭ Part', desc: 'tenor & soprano sax, trumpet, clarinet' },
                { semis: 9, label: 'E♭ Part', desc: 'alto & bari sax' },
              ].map((p) => (
                <button
                  key={p.label}
                  className="btn"
                  style={{ justifyContent: 'space-between', width: '100%' }}
                  onClick={() => {
                    setPartsOpen(false)
                    setPrintPart({ semis: p.semis, label: p.label })
                  }}
                >
                  <span style={{ fontWeight: 700 }}>{p.label}</span>
                  <span className="hint">{p.desc}</span>
                </button>
              ))}
            </div>
            <div className="divider" />
            <button
              className="btn"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={exportMusicXML}
            >
              Engraved chart (MusicXML + auto PDF)
            </button>
            <p className="hint" style={{ marginTop: 6, marginBottom: 10 }}>
              Publisher-style score: the desktop engraver turns it into a PDF in Downloads
              automatically. The .musicxml also opens in MuseScore or any notation app.
            </p>
            <div className="field">
              <label>Bandstand (gig book)</label>
              <input
                className="input"
                placeholder={servedByBandstand() ? 'same origin  -  leave empty' : 'http://localhost:7800'}
                value={bsCfg.url}
                onChange={(e) => patchBs({ url: e.target.value })}
                spellCheck={false}
              />
            </div>
            <div className="field" style={{ marginTop: 8 }}>
              <label>Key</label>
              <input
                className="input"
                type="password"
                value={bsCfg.key}
                onChange={(e) => patchBs({ key: e.target.value })}
                autoComplete="off"
              />
            </div>
            <button
              className="btn primary"
              style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
              disabled={sending || !bsCfg.key.trim()}
              onClick={doSendToBandstand}
            >
              {sending ? 'Sending...' : 'Send chart to Bandstand'}
            </button>
            <p className="hint" style={{ marginTop: 6 }}>
              Sends the live chart to your gig book over LAN or Tailscale. Re-sending after
              edits updates the same piece. The key stays on this device.
            </p>
          </div>
        </div>
      )}
      {printPart && (
        <PrintView chart={chart} semis={printPart.semis} label={printPart.label} onClose={() => setPrintPart(null)} />
      )}

      {/* Layout settings sheet */}
      {showSettings && (
        <div className="sheet-backdrop" onClick={() => setShowSettings(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="grab" />
            <h2>Layout</h2>
            <div className="field">
              <label>Bars per row</label>
              <div className="row">
                {[2, 4, 8].map((n) => (
                  <button key={n} className={`btn sm ${chart.settings.barsPerRow === n ? 'primary' : ''}`} onClick={() => meta({ settings: { ...chart.settings, barsPerRow: n } })}>{n}</button>
                ))}
              </div>
            </div>
            <div className="field" style={{ marginTop: 14 }}>
              <label>Chart text size</label>
              <div className="row">
                {(['small', 'medium', 'large', 'xl'] as const).map((sz) => (
                  <button key={sz} className={`btn sm ${chart.settings.fontSize === sz ? 'primary' : ''}`} onClick={() => meta({ settings: { ...chart.settings, fontSize: sz } })}>{sz}</button>
                ))}
              </div>
            </div>
            <div className="field" style={{ marginTop: 14 }}>
              <label>Lyrics</label>
              <button className={`btn sm ${chart.settings.showLyrics ? 'primary' : ''}`} onClick={() => meta({ settings: { ...chart.settings, showLyrics: !chart.settings.showLyrics } })}>{chart.settings.showLyrics ? 'Shown' : 'Hidden'}</button>
            </div>
            <div className="field" style={{ marginTop: 14 }}>
              <label>Lyric chart (lyrics lead, chords become cues)</label>
              <button
                className={`btn sm ${chart.settings.lyricMode ? 'primary' : ''}`}
                onClick={() => meta({ settings: { ...chart.settings, lyricMode: !chart.settings.lyricMode, showLyrics: true } })}
              >
                {chart.settings.lyricMode ? 'On' : 'Off'}
              </button>
            </div>
            <div className="field" style={{ marginTop: 14 }}>
              <label>Classic navigation (auto D.S., repeats, voltas from the roadmap)</label>
              <button
                className={`btn sm ${chart.settings.classicNav !== false ? 'primary' : ''}`}
                onClick={() => meta({ settings: { ...chart.settings, classicNav: chart.settings.classicNav === false ? true : false } })}
              >
                {chart.settings.classicNav !== false ? 'On' : 'Off'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  // Walk one bar in either direction, skipping pocket (zero-bar) sections.
  function stepSel(cur: NonNullable<Sel>, dir: -1 | 1): Sel {
    let si = cur.si
    let bi = cur.bi + dir
    for (;;) {
      if (si < 0 || si >= chart.sections.length) return null
      const bars = chart.sections[si].bars
      if (bi < 0) {
        si -= 1
        bi = si >= 0 ? chart.sections[si].bars.length - 1 : 0
        continue
      }
      if (bi >= bars.length) {
        si += 1
        bi = 0
        continue
      }
      return { si, bi }
    }
  }
  function moveSel(dir: -1 | 1) {
    if (!sel) return
    const n = stepSel(sel, dir)
    if (n) setSel(n)
  }
}

/** Measure clipboard  -  module scope so a copied phrase survives switching
    bars, sections, even charts within the session. Never persisted. */
let barClipboard: Bar[] = []

function GripIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="4.5" cy="3" r="1.3" fill="currentColor" />
      <circle cx="9.5" cy="3" r="1.3" fill="currentColor" />
      <circle cx="4.5" cy="7" r="1.3" fill="currentColor" />
      <circle cx="9.5" cy="7" r="1.3" fill="currentColor" />
      <circle cx="4.5" cy="11" r="1.3" fill="currentColor" />
      <circle cx="9.5" cy="11" r="1.3" fill="currentColor" />
    </svg>
  )
}

/* ---------------- inline bar editor: type chords straight into the grid ---------------- */

function InlineBarEditor({
  chart,
  sel,
  update,
  onStep,
  onAdvance,
  onInsertAfter,
  onDetails,
  onClose,
  onCopy,
  onCut,
  onPaste,
  onExtend,
  onWriteBars,
}: {
  chart: Chart
  sel: { si: number; bi: number }
  update: (mut: (c: Chart) => void) => void
  onStep: (dir: -1 | 1 | 'up' | 'down') => void
  onAdvance: () => void
  onInsertAfter: () => void
  onDetails: () => void
  onClose: () => void
  onCopy: () => void
  onCut: () => void
  onPaste: () => void
  onExtend: (dir: -1 | 1) => void
  onWriteBars: (segs: string[]) => void
}) {
  const bar = chart.sections[sel.si]?.bars[sel.bi]
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [sel.si, sel.bi])
  if (!bar) return null

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault()
      onCopy()
      return
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
      e.preventDefault()
      onCut()
      return
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault()
      onPaste()
      return
    }
    if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      // grow/shrink the multi-measure selection
      e.preventDefault()
      onExtend(e.key === 'ArrowRight' ? 1 : -1)
      return
    }
    if (e.key === '|' || e.key === 'Enter') {
      // punch-in: commit this bar and move on (grows the section at the end)
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) onInsertAfter()
      else onAdvance()
    } else if (e.key === 'ArrowRight' && atEnd) {
      e.preventDefault()
      onStep(1)
    } else if (e.key === 'ArrowLeft' && atStart) {
      e.preventDefault()
      onStep(-1)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      onStep('down')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      onStep('up')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <span className="bar-inline">
      <input
        ref={ref}
        className="bar-inline-input"
        value={bar.chords}
        spellCheck={false}
        autoComplete="off"
        placeholder="C^7  A-7"
        onChange={(e) => {
          // A barline in the text means multiple bars: pasted phrases, and
          // Android keyboards whose `|` keydown is unreliable and lands here
          // instead of advancing. Desktop-typed `|` never reaches this path
          // (onKey advances first).
          const segs = splitBarsInput(e.target.value)
          if (segs) {
            onWriteBars(segs)
            return
          }
          const v = normalizeChordInput(e.target.value)
          update((c) => (c.sections[sel.si].bars[sel.bi].chords = v))
        }}
        onKeyDown={onKey}
      />
      <button
        className="bar-more"
        type="button"
        tabIndex={-1}
        aria-label="Bar details"
        onPointerDown={(e) => { e.preventDefault(); onDetails() }}
      >
        …
      </button>
    </span>
  )
}

/* ---------------- pocket row: type straight into the chart ---------------- */

function PocketRow({
  chart,
  si,
  update,
  onCopy,
}: {
  chart: Chart
  si: number
  update: (mut: (c: Chart) => void) => void
  onCopy: () => void
}) {
  const section = chart.sections[si]
  const set = (patch: Partial<Section>) => update((c) => Object.assign(c.sections[si], patch))
  // ×N chip: tap cycles common counts, hold 400ms to type any number
  const [repEdit, setRepEdit] = useState(false)
  const repHold = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repHeld = useRef(false)
  const remove = () => {
    if (chart.sections.length <= 1) {
      fireMoment('A chart needs at least one section', {})
      return
    }
    update((c) => {
      const [gone] = c.sections.splice(si, 1)
      if (c.arrangement) c.arrangement = c.arrangement.filter((st) => st.sectionId !== gone.id)
    })
  }

  return (
    <div className="pkt-row">
      <div className="pkt-head">
        <span className="pkt-letter">{sectionMarks(chart.sections)[si]}</span>
        <input
          className="pkt-name"
          placeholder="name (optional)"
          value={section.label}
          onChange={(e) => set({ label: e.target.value })}
        />
        {repEdit ? (
          <input
            className="rep-input"
            inputMode="numeric"
            autoFocus
            defaultValue={section.repeats ?? 1}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
            }}
            onBlur={(e) => {
              const n = parseInt(e.currentTarget.value, 10)
              set({ repeats: !n || n <= 1 ? undefined : Math.min(99, n) })
              setRepEdit(false)
            }}
          />
        ) : (
          <button
            className={`rep-chip${(section.repeats ?? 1) > 1 ? ' on' : ''}`}
            type="button"
            aria-label="Times played - tap to cycle, hold to type"
            onPointerDown={() => {
              repHeld.current = false
              repHold.current = setTimeout(() => {
                repHeld.current = true
                setRepEdit(true)
              }, 400)
            }}
            onPointerUp={() => { if (repHold.current) clearTimeout(repHold.current) }}
            onPointerLeave={() => { if (repHold.current) clearTimeout(repHold.current) }}
            onClick={() => {
              if (repHeld.current) return
              const cycle = [1, 2, 3, 4, 5, 6, 8]
              const cur = section.repeats ?? 1
              const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length] ?? 2
              set({ repeats: next === 1 ? undefined : next })
            }}
          >
            ×{section.repeats ?? 1}
          </button>
        )}
        <button className="btn icon ghost" onClick={onCopy} aria-label="Duplicate section"><IconCopy size={15} /></button>
        <button className="btn icon ghost" onClick={remove} aria-label="Delete section"><IconTrash size={15} /></button>
      </div>
      <input
        className="pkt-desc"
        placeholder="what happens here..."
        value={section.description ?? ''}
        onChange={(e) => set({ description: e.target.value })}
      />
      <input
        className="pkt-hits"
        placeholder="hits: 2& 4  ·  or grid: #..x. .x.. x... ..x."
        value={section.hits ?? ''}
        onChange={(e) => set({ hits: e.target.value })}
        spellCheck={false}
        autoCapitalize="off"
      />
      {section.hits && <HitStaff value={section.hits} />}
    </div>
  )
}

/* ---------------- roadmap: tap or drag section chips into the order ---------------- */

function RoadmapEditor({
  chart,
  update,
  onAddSection,
}: {
  chart: Chart
  update: (mut: (c: Chart) => void) => void
  onAddSection: () => void
}) {
  const steps = chart.arrangement ?? []
  const marks = sectionMarks(chart.sections)
  const [stepSheet, setStepSheet] = useState<number | null>(null)
  const orderRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    payload: { kind: 'tray'; sectionId: string } | { kind: 'step'; index: number }
    startX: number
    startY: number
    moved: boolean
  } | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)

  const appendOrCoalesce = (sectionId: string) =>
    update((c) => {
      if (!c.arrangement) c.arrangement = []
      const last = c.arrangement[c.arrangement.length - 1]
      if (last && last.sectionId === sectionId) last.repeats = Math.min(16, (last.repeats ?? 1) + 1)
      else c.arrangement.push(newArrangementStep(sectionId))
    })

  const insertAt = (idx: number, payload: NonNullable<typeof drag.current>['payload']) =>
    update((c) => {
      if (!c.arrangement) c.arrangement = []
      if (payload.kind === 'tray') {
        c.arrangement.splice(idx, 0, newArrangementStep(payload.sectionId))
      } else {
        const [moved] = c.arrangement.splice(payload.index, 1)
        c.arrangement.splice(payload.index < idx ? idx - 1 : idx, 0, moved)
      }
    })

  // pointer-based tap/drag so it works with a thumb: tap = append (tray) or
  // edit (step); move past the slop threshold = drag with a drop marker
  const onChipPointerDown = (
    e: React.PointerEvent,
    payload: NonNullable<typeof drag.current>['payload'],
  ) => {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    drag.current = { payload, startX: e.clientX, startY: e.clientY, moved: false }
  }
  const onChipPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 10) return
    d.moved = true
    setDropIdx(indexFromX(e.clientX))
  }
  const onChipPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    setDropIdx(null)
    if (!d) return
    if (d.moved) {
      insertAt(indexFromX(e.clientX), d.payload)
    } else if (d.payload.kind === 'tray') {
      appendOrCoalesce(d.payload.sectionId)
    } else {
      setStepSheet(d.payload.index)
    }
  }
  const indexFromX = (x: number): number => {
    const chips = orderRef.current?.querySelectorAll<HTMLElement>('.ord-chip') ?? []
    let idx = chips.length
    chips.forEach((chip, i) => {
      const r = chip.getBoundingClientRect()
      if (idx === chips.length && x < r.left + r.width / 2) idx = i
    })
    return idx
  }

  // Spell the form by typing: letters append steps ("A B C D A B C D"), the
  // next unused letter creates its section on the spot, a digit sets xN on the
  // last step (1 clears), backspace pops. Chars arrive via onInput so soft
  // keyboards (GBoard sends no real letter keydowns) work the same as desktop.
  const spellChar = (ch: string) => {
    if (ch === '*') {
      update((c) => {
        const last = c.arrangement?.[c.arrangement.length - 1]
        if (last) last.open = last.open ? undefined : true
      })
      return
    }
    if (/[1-9]/.test(ch)) {
      const n = parseInt(ch, 10)
      update((c) => {
        const last = c.arrangement?.[c.arrangement.length - 1]
        if (last) last.repeats = n > 1 ? Math.min(16, n) : undefined
      })
      return
    }
    if (!/[a-zA-Z]/.test(ch)) return // space, comma, etc. = separators
    // letters address LETTERED sections only  -  intro/outro/coda marks don't count
    const letteredIdx = marks.map((m, i) => (isLetterMark(m) ? i : -1)).filter((i) => i >= 0)
    const li = ch.toUpperCase().charCodeAt(0) - 65
    if (li > letteredIdx.length) {
      fireMoment(`No section ${ch.toUpperCase()} yet  -  next is ${String.fromCharCode(65 + letteredIdx.length)}`, {})
      return
    }
    update((c) => {
      let sectionId: string
      if (li === letteredIdx.length) {
        const pocket = c.sections.every((s) => s.bars.length === 0)
        const sec = newSection('', pocket ? 0 : 4)
        if (pocket) sec.description = ''
        c.sections.push(sec)
        sectionId = sec.id
      } else {
        sectionId = c.sections[letteredIdx[li]].id
      }
      if (!c.arrangement) c.arrangement = []
      c.arrangement.push(newArrangementStep(sectionId))
    })
  }
  const onSpellInput = (e: React.FormEvent<HTMLInputElement>) => {
    const typed = e.currentTarget.value
    e.currentTarget.value = ''
    for (const ch of typed) spellChar(ch)
  }
  const onSpellKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
    else if (e.key === 'Backspace') {
      e.preventDefault()
      update((c) => { c.arrangement?.pop() })
    }
  }

  const byId = new Map(chart.sections.map((s, i) => [s.id, { section: s, letter: marks[i] }]))

  return (
    <div className="arr-panel">
      <div className="section-title" style={{ marginTop: 20 }}>
        Order of operations <span className="line" />
      </div>

      <div className="ord-line" ref={orderRef}>
        {steps.length === 0 && <span className="hint">tap a section below to build the order</span>}
        {steps.map((step, i) => {
          const info = byId.get(step.sectionId)
          if (!info) return null
          return (
            <span key={step.id}>
              {dropIdx === i && <span className="drop-mark" />}
              <button
                className="ord-chip"
                onPointerDown={(e) => onChipPointerDown(e, { kind: 'step', index: i })}
                onPointerMove={onChipPointerMove}
                onPointerUp={onChipPointerUp}
              >
                <span className="oc-letter">{info.letter}</span>
                {info.section.label && <span className="oc-name">{info.section.label}</span>}
                {step.open ? (
                  <span className="oc-x">∞</span>
                ) : (
                  (step.repeats ?? 1) > 1 && <span className="oc-x">×{step.repeats}</span>
                )}
                {step.solos && step.solos.length > 0 && <span className="oc-solo">{step.solos.join(' · ')}</span>}
                {step.hits && <span className="oc-hit">hits</span>}
                {step.note && <span className="oc-note">{step.note}</span>}
              </button>
            </span>
          )
        })}
        {dropIdx === steps.length && <span className="drop-mark" />}
      </div>

      <input
        className="input form-pad"
        placeholder="spell it  -  A B C D A B C D · digit = ×N · * = till cue · backspace undoes"
        onInput={onSpellInput}
        onKeyDown={onSpellKey}
        autoComplete="off"
        autoCapitalize="characters"
        aria-label="Spell the arrangement by typing section letters"
      />

      <div className="tray">
        {chart.sections.map((s, i) => (
          <button
            key={s.id}
            className="tray-chip"
            onPointerDown={(e) => onChipPointerDown(e, { kind: 'tray', sectionId: s.id })}
            onPointerMove={onChipPointerMove}
            onPointerUp={onChipPointerUp}
          >
            <span className="oc-letter">{marks[i]}</span>
            {s.label && <span className="oc-name">{s.label}</span>}
          </button>
        ))}
        <button className="tray-chip add" onClick={onAddSection}>
          <IconPlus size={14} /> section
        </button>
      </div>

      {stepSheet !== null && steps[stepSheet] && (
        <StepSheet
          step={steps[stepSheet]}
          sections={chart.sections.map((s, i) => ({ id: s.id, letter: marks[i], label: s.label }))}
          sectionName={(() => { const info = byId.get(steps[stepSheet].sectionId); return info ? `${info.letter}${info.section.label ? ' · ' + info.section.label : ''}` : '' })()}
          onClose={() => setStepSheet(null)}
          onPatch={(patch) => update((c) => Object.assign(c.arrangement![stepSheet], patch))}
          onRemove={() => { update((c) => c.arrangement!.splice(stepSheet, 1)); setStepSheet(null) }}
        />
      )}
    </div>
  )
}

/** Bandleader vocabulary  -  one tap appends to the step note. */
const CUE_WORDS = ['on cue', 'drums only', 'band in', 'break', 'stop time', 'ritard', 'tag', 'big ending']

function StepSheet({
  step,
  sections,
  sectionName,
  onClose,
  onPatch,
  onRemove,
}: {
  step: ArrangementStep
  sections: { id: string; letter: string; label: string }[]
  sectionName: string
  onClose: () => void
  onPatch: (patch: Partial<ArrangementStep>) => void
  onRemove: () => void
}) {
  // raw text so commas type naturally; parsed list goes to the model
  const [soloText, setSoloText] = useState((step.solos ?? []).join(', '))
  const bump = (d: -1 | 1) => {
    const next = Math.max(1, Math.min(16, (step.repeats ?? 1) + d))
    onPatch({ repeats: next === 1 ? undefined : next })
  }
  const setSolos = (raw: string) => {
    setSoloText(raw)
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
    onPatch({ solos: list.length ? list : undefined })
  }
  const addCue = (w: string) => onPatch({ note: step.note ? `${step.note}, ${w}` : w })
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <h2>{sectionName}</h2>
        <div className="field">
          <label>Letter  -  change which section this step plays</label>
          <div className="row wrap">
            {sections.map((s) => (
              <button
                key={s.id}
                className={`btn sm ${s.id === step.sectionId ? 'primary' : ''}`}
                onClick={() => onPatch({ sectionId: s.id })}
              >
                {s.letter}{s.label ? ` · ${s.label}` : ''}
              </button>
            ))}
          </div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Times through</label>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <div className="transpose-pill" style={{ width: 'fit-content', opacity: step.open ? 0.35 : 1 }}>
              <button className="btn icon ghost" onClick={() => bump(-1)} disabled={step.open}><IconMinus size={15} /></button>
              <span className="val" style={{ minWidth: 40 }}>×{step.repeats ?? 1}</span>
              <button className="btn icon ghost" onClick={() => bump(1)} disabled={step.open}><IconPlus size={15} /></button>
            </div>
            <button
              className={`btn${step.open ? ' primary' : ''}`}
              onClick={() => onPatch({ open: step.open ? undefined : true })}
            >
              ∞ till cue
            </button>
          </div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Solos  -  in order, one pass each</label>
          <input className="input" placeholder="gtr, keys, trade 4s" value={soloText} onChange={(e) => setSolos(e.target.value)} />
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Hits  -  this pass only</label>
          <input className="input" placeholder="2& 4 | 1 2& (or #x-grid)" value={step.hits ?? ''} onChange={(e) => onPatch({ hits: e.target.value || undefined })} />
          {step.hits && <HitStaff value={step.hits} />}
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Note</label>
          <input className="input" placeholder="last x ritard, drums in..." value={step.note ?? ''} onChange={(e) => onPatch({ note: e.target.value || undefined })} />
          <div className="vocab">
            {CUE_WORDS.map((w) => (
              <button key={w} className="vocab-chip" onClick={() => addCue(w)} type="button">{w}</button>
            ))}
          </div>
        </div>
        <div className="divider" />
        <div className="row" style={{ gap: 8 }}>
          <button className="btn danger" onClick={onRemove}><IconTrash size={16} /> Remove step</button>
          <button className="btn primary" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Done</button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- sheets for barred sections ---------------- */

function SectionSheet({
  chart,
  si,
  onClose,
  update,
  onCopy,
}: {
  chart: Chart
  si: number
  onClose: () => void
  update: (mut: (c: Chart) => void) => void
  onCopy: () => void
}) {
  const section = chart.sections[si]

  const deleteSection = () => {
    if (chart.sections.length <= 1) {
      fireMoment('A chart needs at least one section', {})
      return
    }
    update((c) => {
      const [gone] = c.sections.splice(si, 1)
      if (c.arrangement) c.arrangement = c.arrangement.filter((st) => st.sectionId !== gone.id)
    })
    onClose()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <h2>Section {sectionMarks(chart.sections)[si]}</h2>
        <div className="field">
          <label>Label</label>
          <input className="input" autoFocus value={section.label} onChange={(e) => update((c) => (c.sections[si].label = e.target.value))} style={{ fontWeight: 700 }} />
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Description (what happens here)</label>
          <input className="input" placeholder="e.g. E7 vamp, drums only" value={section.description ?? ''} onChange={(e) => update((c) => (c.sections[si].description = e.target.value))} />
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Plays (repeat barlines + ×N on the chart)  -  type any number</label>
          <div className="transpose-pill" style={{ width: 'fit-content' }}>
            <button
              className="btn icon ghost"
              onClick={() => update((c) => {
                const s = c.sections[si]
                const next = Math.max(1, (s.repeats ?? 1) - 1)
                s.repeats = next === 1 ? undefined : next
              })}
            >
              <IconMinus size={15} />
            </button>
            <span className="val" style={{ minWidth: 46 }}>
              ×
              <input
                key={section.repeats ?? 1}
                className="rep-val"
                inputMode="numeric"
                defaultValue={section.repeats ?? 1}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                }}
                onBlur={(e) => {
                  const n = parseInt(e.currentTarget.value, 10)
                  update((c) => {
                    c.sections[si].repeats = !n || n <= 1 ? undefined : Math.min(99, n)
                  })
                }}
              />
            </span>
            <button
              className="btn icon ghost"
              onClick={() => update((c) => {
                const s = c.sections[si]
                s.repeats = Math.min(99, (s.repeats ?? 1) + 1)
              })}
            >
              <IconPlus size={15} />
            </button>
          </div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Hits (2& 4 · or #x-grid)</label>
          <input className="input" spellCheck={false} value={section.hits ?? ''} onChange={(e) => update((c) => (c.sections[si].hits = e.target.value))} />
          {section.hits && <HitStaff value={section.hits} />}
        </div>
        {section.bars.length > 0 && (
          <div className="field" style={{ marginTop: 12 }}>
            <label>Lyrics  -  one line per bar, in order ({section.bars.length} bars)</label>
            <textarea
              className="textarea"
              style={{ minHeight: 90 }}
              spellCheck={false}
              value={section.bars.map((b) => b.lyrics ?? '').join('\n')}
              onChange={(e) => {
                const lines = e.target.value.split('\n')
                update((c) => {
                  c.sections[si].bars.forEach((b, bi) => {
                    b.lyrics = lines[bi] ?? ''
                  })
                })
              }}
            />
          </div>
        )}
        <div className="divider" />
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={() => { onCopy(); onClose() }}><IconCopy size={15} /> Duplicate</button>
          <button className="btn danger" onClick={deleteSection}><IconTrash size={16} /></button>
          <button className="btn primary" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Done</button>
        </div>
      </div>
    </div>
  )
}

function BarSheet({
  chart,
  sel,
  onClose,
  onMove,
  update,
}: {
  chart: Chart
  sel: { si: number; bi: number }
  onClose: () => void
  onMove: (d: -1 | 1) => void
  update: (mut: (c: Chart) => void) => void
}) {
  const bar = chart.sections[sel.si]?.bars[sel.bi]
  if (!bar) return null

  const setBar = (patch: Partial<typeof bar>) =>
    update((c) => Object.assign(c.sections[sel.si].bars[sel.bi], patch))

  const insertAfter = () =>
    update((c) => c.sections[sel.si].bars.splice(sel.bi + 1, 0, newBar()))
  const deleteBar = () =>
    update((c) => {
      if (c.sections[sel.si].bars.length > 1) c.sections[sel.si].bars.splice(sel.bi, 1)
    })

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{chart.sections[sel.si].label} · bar {sel.bi + 1}</h2>
          <div className="row">
            <button className="btn icon ghost" onClick={() => onMove(-1)}><IconChevronLeft size={18} /></button>
            <button className="btn icon ghost" onClick={() => onMove(1)}><IconChevronRight size={18} /></button>
          </div>
        </div>

        <div className="field">
          <label>Chords (space-separated, % = repeat)</label>
          <input className="input" autoFocus value={bar.chords} placeholder="e.g. C^7  A-7" onChange={(e) => setBar({ chords: normalizeChordInput(e.target.value) })} style={{ fontSize: 18, fontWeight: 700 }} />
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label>Lyric (optional)</label>
          <input className="input" value={bar.lyrics ?? ''} onChange={(e) => setBar({ lyrics: e.target.value })} />
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label>Barline</label>
          <div className="row wrap">
            {BARLINES.map((b) => (
              <button key={b.v} className={`btn sm ${(bar.barline ?? 'normal') === b.v ? 'primary' : ''}`} onClick={() => setBar({ barline: b.v })}>{b.label}</button>
            ))}
          </div>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label>Hits in this bar (2& 4 · or #x-grid)</label>
          <input className="input" spellCheck={false} value={bar.hits ?? ''} placeholder="blank for none" onChange={(e) => setBar({ hits: e.target.value || undefined })} />
          {bar.hits && <HitStaff value={bar.hits} beatsPerBar={parseInt(chart.time, 10) || 4} compact />}
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label>Ending / Volta  -  set on the FIRST bar of the ending (1. 2.)</label>
          <input className="input" value={bar.ending ?? ''} placeholder="blank for none" onChange={(e) => setBar({ ending: e.target.value })} />
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label>Sign</label>
          <div className="row wrap">
            {(['none', 'segno', 'coda'] as const).map((v) => (
              <button
                key={v}
                className={`btn sm ${(bar.sign ?? 'none') === v ? 'primary' : ''}`}
                onClick={() => setBar({ sign: v === 'none' ? undefined : v })}
              >
                {v === 'none' ? 'None' : v === 'segno' ? 'Segno' : 'Coda'}
              </button>
            ))}
          </div>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label>Direction (engraved top-right)</label>
          <input className="input" value={bar.direction ?? ''} placeholder="D.S. al Coda, Fine..." onChange={(e) => setBar({ direction: e.target.value || undefined })} />
          <div className="vocab">
            {['D.C.', 'D.C. al Fine', 'D.S.', 'D.S. al Coda', 'D.S. al Fine', 'To Coda', 'Fine'].map((w) => (
              <button key={w} className="vocab-chip" type="button" onClick={() => setBar({ direction: w })}>{w}</button>
            ))}
          </div>
        </div>

        <div className="divider" />
        <div className="row" style={{ gap: 8, marginBottom: 8 }}>
          <button
            className="btn"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => {
              barClipboard = [structuredClone(bar)]
              fireMoment('Copied 1 bar', {})
            }}
          >
            <IconCopy size={15} /> Copy
          </button>
          <button
            className="btn"
            style={{ flex: 1, justifyContent: 'center' }}
            disabled={barClipboard.length === 0}
            onClick={() => {
              update((c) => {
                const bars = c.sections[sel.si].bars
                while (bars.length < sel.bi + barClipboard.length) bars.push(newBar())
                barClipboard.forEach((b, i) => {
                  bars[sel.bi + i] = structuredClone(b)
                })
              })
              fireMoment(`Pasted ${barClipboard.length} bar${barClipboard.length === 1 ? '' : 's'}`, {})
            }}
          >
            <IconImport size={15} /> Paste
          </button>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={insertAfter} style={{ flex: 1, justifyContent: 'center' }}><IconPlus size={16} /> Bar after</button>
          <button className="btn" onClick={() => { update((c) => c.sections[sel.si].bars.splice(sel.bi + 1, 0, structuredClone(bar))) }} style={{ flex: 1, justifyContent: 'center' }}><IconCopy size={16} /> Duplicate</button>
          <button className="btn danger" onClick={deleteBar}><IconTrash size={16} /></button>
        </div>
        <button className="btn primary" onClick={onClose} style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}>Done</button>
      </div>
    </div>
  )
}
