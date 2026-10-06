import { useState } from 'react'
import { useStore } from '@/store/useStore'
import { parseChordSheet, enhanceWithLLM, DEFAULT_LLM_CONFIG, type LLMConfig } from '@/lib/aiImport'
import { looksLikeIReal, parseIReal } from '@/lib/irealImport'
import { IconClose, IconSparkle, IconImport } from '@/ui/Icon'
import { Mascot } from '@/ui/Mascot'
import { fireMoment } from '@/ui/moments'
import type { Nav } from '@/App'

const SAMPLE = `Title: Sittin' On The Dock
Artist: Otis Redding
Key: G

[Intro]
G  B  C  A

[Verse]
G            B
Sittin in the morning sun
C                 A
I'll be sittin when the evening comes`

const LLM_KEY = 'saltycharts.llm'

function loadLLM(): LLMConfig {
  try {
    const raw = localStorage.getItem(LLM_KEY)
    if (raw) return { ...DEFAULT_LLM_CONFIG, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return DEFAULT_LLM_CONFIG
}

export function ImportDialog({ nav, onClose }: { nav: Nav; onClose: () => void }) {
  const saveChart = useStore((s) => s.saveChart)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [showLLM, setShowLLM] = useState(false)
  const [llm, setLLM] = useState<LLMConfig>(loadLLM)
  const [error, setError] = useState<string | null>(null)

  const persistLLM = (next: LLMConfig) => {
    setLLM(next)
    try {
      localStorage.setItem(LLM_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  const doParse = () => {
    // iReal Pro HTML export or pasted irealb:// link  -  batch-imports the playlist
    if (looksLikeIReal(text)) {
      const { charts, playlistName, warnings } = parseIReal(text)
      if (charts.length === 0) {
        setError(warnings[0] ?? 'No songs found in that iReal link')
        return
      }
      for (const chart of charts) saveChart(chart, { pushUndo: false })
      fireMoment(
        charts.length === 1
          ? `"${charts[0]!.title}" imported from iReal Pro`
          : `${charts.length} charts imported from iReal Pro${playlistName ? ` (${playlistName})` : ''}`,
        { mascot: true },
      )
      if (warnings.length) setError(warnings.join(' · '))
      if (charts.length === 1) {
        nav.go({ view: 'editor', chartId: charts[0]!.id })
      } else {
        onClose()
      }
      return
    }
    const { chart, warnings } = parseChordSheet(text)
    saveChart(chart, { pushUndo: false })
    fireMoment(warnings.length ? warnings[0] : 'Chart imported', { mascot: true })
    nav.go({ view: 'editor', chartId: chart.id })
  }

  const doLLM = async () => {
    setBusy(true)
    setError(null)
    try {
      const chart = await enhanceWithLLM(text, llm)
      saveChart(chart, { pushUndo: false })
      fireMoment('AI chart ready  -  give it a once-over', { mascot: true })
      nav.go({ view: 'editor', chartId: chart.id })
    } catch (e) {
      setError(
        `${(e as Error).message}. The deterministic parser still works offline  -  use "Parse & import".`,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop center" onClick={onClose}>
      <div className="sheet modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Mascot size={32} mood="sing" /> Import a song
          </h2>
          <button className="btn icon ghost" onClick={onClose}><IconClose size={18} /></button>
        </div>
        <p className="hint" style={{ marginBottom: 10 }}>
          Paste chords from anywhere (Ultimate Guitar, your notes, an email). I parse sections, chords,
          and lyrics into an editable chart  -  fully offline. Also takes <b>iReal Pro</b>: share a song
          or playlist as HTML, open the file, and paste its contents (or the irealb:// link) here  -
          the whole book imports at once.
        </p>

        <textarea
          className="textarea"
          placeholder={SAMPLE}
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ minHeight: 180 }}
        />
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn ghost sm" onClick={() => setText(SAMPLE)}>Try sample</button>
          <button className="btn ghost sm" onClick={() => setText('')}>Clear</button>
          <div style={{ flex: 1 }} />
          <span className="hint">{text.trim() ? `${text.trim().split(/\s+/).length} words` : ''}</span>
        </div>

        {error && <p className="hint" style={{ color: 'var(--danger)', marginTop: 10 }}>{error}</p>}

        <div className="divider" />
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" disabled={!text.trim() || busy} onClick={doParse} style={{ flex: 1, justifyContent: 'center' }}>
            <IconImport size={17} /> Parse &amp; import
          </button>
          <button className="btn" disabled={!text.trim() || busy} onClick={doLLM} style={{ flex: 1, justifyContent: 'center' }}>
            {busy ? <span className="spin"><IconSparkle size={17} /></span> : <IconSparkle size={17} />}
            {busy ? 'Thinking…' : 'AI structure'}
          </button>
        </div>

        <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setShowLLM((v) => !v)}>
          {showLLM ? 'Hide' : 'AI'} settings
        </button>
        {showLLM && (
          <div className="center-col" style={{ marginTop: 8 }}>
            <div className="field">
              <label>Provider</label>
              <div className="row">
                {(['ollama', 'openai', 'anthropic'] as const).map((p) => (
                  <button key={p} className={`btn sm ${llm.provider === p ? 'primary' : ''}`} onClick={() => persistLLM({ ...llm, provider: p })}>{p}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>Endpoint</label>
              <input className="input" value={llm.endpoint} onChange={(e) => persistLLM({ ...llm, endpoint: e.target.value })} />
            </div>
            <div className="field">
              <label>Model</label>
              <input className="input" value={llm.model} onChange={(e) => persistLLM({ ...llm, model: e.target.value })} />
            </div>
            {llm.provider !== 'ollama' && (
              <div className="field">
                <label>API key (stored on this device only)</label>
                <input className="input" type="password" value={llm.apiKey ?? ''} onChange={(e) => persistLLM({ ...llm, apiKey: e.target.value })} />
              </div>
            )}
            <p className="hint">Default targets your local llama-swap (Gemma 4) on :11500  -  no key needed. Keys never leave this device or get bundled.</p>
          </div>
        )}
      </div>
    </div>
  )
}
