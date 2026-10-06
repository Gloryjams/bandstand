// AI import  -  turns pasted text (Ultimate-Guitar style chord sheets, or freeform
// notes) into a Saltycharts Chart.
//
// Two layers:
//   1. parseChordSheet()   -  deterministic, offline, no API key. Primary path.
//   2. enhanceWithLLM()     -  optional, model-agnostic. Bar-accurate structuring,
//                            section labeling, key detection. Configurable endpoint
//                            (local Ollama, or any OpenAI-/Anthropic-compatible API).
//
// Why this is better than the old approach: the old pipeline scraped Songsterr,
// which exposes NO real chord data via its API (confirmed dead end). Here the user
// pastes the chords they already have, we parse them deterministically so it works
// with zero setup, and the LLM is a pure enhancement layer that never blocks import.

import type { Bar, Chart, Section } from '@/types'
import { newBar, newChart, newSection } from './factory'
import { parseChord, noteIndex } from './theory'

const SECTION_WORDS =
  /^(intro|verse|chorus|pre-?chorus|bridge|solo|outro|hook|interlude|tag|vamp|head|turnaround|coda|refrain|breakdown|ending|instrumental)\b/i

function isChordToken(tok: string): boolean {
  if (!tok) return false
  if (tok === '%' || tok === '/' || tok === 'N.C.') return true
  const p = parseChord(tok)
  return p.root !== '' && noteIndex(p.root) !== -1
}

function classifyLine(line: string): 'blank' | 'section' | 'meta' | 'chords' | 'lyric' {
  const t = line.trim()
  if (!t) return 'blank'
  if (/^\[.+\]$/.test(t)) return 'section'
  if (/^(key|tempo|bpm|time|capo|artist|title|by)\s*[:=]/i.test(t)) return 'meta'
  if (SECTION_WORDS.test(t) && t.length < 24 && !/\s\s/.test(t.replace(/[:#\d.\-]/g, ''))) {
    // short line starting with a section word, e.g. "Verse 1", "Chorus:"
    const stripped = t.replace(/[:#\d.\-\s]/g, '')
    if (stripped.length <= 16) return 'section'
  }
  const tokens = t.split(/\s+/)
  const chordCount = tokens.filter(isChordToken).length
  if (chordCount > 0 && chordCount / tokens.length >= 0.6) return 'chords'
  return 'lyric'
}

function sectionLabel(line: string): string {
  const t = line.trim()
  const m = t.match(/^\[(.+)\]$/)
  if (m) return titleCase(m[1])
  return titleCase(t.replace(/[:]+$/, ''))
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

export interface ParseResult {
  chart: Chart
  warnings: string[]
}

/** Deterministic parse of a pasted chord sheet into a Chart. Never throws. */
export function parseChordSheet(text: string, meta: Partial<Chart> = {}): ParseResult {
  const warnings: string[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')

  const detectedMeta: Partial<Chart> = {}
  const sections: Section[] = []
  let current: Section | null = null

  const ensureSection = () => {
    if (!current) {
      current = newSection('Verse', 0)
      sections.push(current)
    }
    return current
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const kind = classifyLine(line)

    if (kind === 'blank') continue

    if (kind === 'meta') {
      const [rawKey, ...rest] = line.split(/[:=]/)
      const k = rawKey.trim().toLowerCase()
      const v = rest.join(':').trim()
      if (k === 'key') detectedMeta.key = v
      else if (k === 'tempo' || k === 'bpm') detectedMeta.bpm = v.replace(/[^\d]/g, '')
      else if (k === 'time') detectedMeta.time = v
      else if (k === 'capo') detectedMeta.capo = v.replace(/[^\d]/g, '')
      else if (k === 'title') detectedMeta.title = v
      else if (k === 'artist' || k === 'by') detectedMeta.artist = v
      continue
    }

    if (kind === 'section') {
      current = newSection(sectionLabel(line), 0)
      sections.push(current)
      continue
    }

    if (kind === 'chords') {
      const sec = ensureSection()
      const tokens = line.trim().split(/\s+/).filter(Boolean)
      const newBars: Bar[] = tokens.map((tok) => newBar({ chords: tok === '/' ? '' : tok }))
      // Attach an immediately-following lyric line to the first new bar.
      if (i + 1 < lines.length && classifyLine(lines[i + 1]) === 'lyric') {
        if (newBars[0]) newBars[0].lyrics = lines[i + 1].trim()
        i++
      }
      sec.bars.push(...newBars)
      continue
    }

    // lyric line with no chords above  -  keep as a lyric-only bar so nothing is lost
    if (kind === 'lyric') {
      const sec = ensureSection()
      sec.bars.push(newBar({ lyrics: line.trim() }))
    }
  }

  if (sections.length === 0) {
    warnings.push('No chords or sections detected  -  created an empty chart.')
    sections.push(newSection('Intro'))
  }

  // Drop sections that ended up empty
  const cleaned = sections.filter((s) => s.bars.length > 0)
  const totalChordBars = cleaned.reduce(
    (n, s) => n + s.bars.filter((b) => b.chords).length,
    0,
  )
  if (totalChordBars === 0) warnings.push('Parsed text but found no chords  -  check the formatting.')

  const chart = newChart({
    ...detectedMeta,
    ...meta,
    sections: cleaned,
  })
  return { chart, warnings }
}

// ---------------------------------------------------------------------------
// LLM enhancement (optional)
// ---------------------------------------------------------------------------

export type LLMProvider = 'ollama' | 'openai' | 'anthropic'

export interface LLMConfig {
  provider: LLMProvider
  endpoint: string
  model: string
  apiKey?: string
}

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  // Migrated off Ollama (:11434) to local llama-swap (OpenAI-compat) on 2026-06-15.
  provider: 'openai',
  endpoint: 'http://localhost:11500/v1/chat/completions',
  model: 'gemma4-deep',
}

const SYSTEM_PROMPT = `You are a professional music copyist. Convert the user's pasted song into a clean chord chart as STRICT JSON only  -  no prose, no markdown fences.

Schema:
{
  "title": string, "artist": string, "key": string (e.g. "C", "Bbm"),
  "time": string (e.g. "4/4"), "bpm": string, "style": string,
  "sections": [
    { "label": string, "bars": [ { "chords": string, "lyrics": string } ] }
  ]
}

Rules:
- One measure per bar. "chords" holds chord symbols for that measure (e.g. "Cmaj7", "G/B", or "Cmaj7 A7" for two changes in one bar). Use "%" to repeat the previous bar, "" for an empty bar.
- Infer sensible section labels (Intro, Verse, Chorus, Bridge, Solo, Outro).
- Detect the key from the harmony if not stated.
- Preserve any lyrics, aligned to the bar where they begin. Omit lyrics if none.
- Output ONLY the JSON object.`

export function buildImportMessages(text: string) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: text },
  ]
}

function extractJSON(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON object found in model response.')
  return JSON.parse(candidate.slice(start, end + 1))
}

/** Coerce an arbitrary parsed object into a valid Chart, dropping junk. */
export function coerceChart(obj: unknown, fallbackMeta: Partial<Chart> = {}): Chart {
  const o = (obj ?? {}) as Record<string, unknown>
  const rawSections = Array.isArray(o.sections) ? o.sections : []
  const sections: Section[] = rawSections.map((rs) => {
    const s = (rs ?? {}) as Record<string, unknown>
    const rawBars = Array.isArray(s.bars) ? s.bars : []
    const bars: Bar[] = rawBars.map((rb) => {
      const b = (rb ?? {}) as Record<string, unknown>
      return newBar({
        chords: typeof b.chords === 'string' ? b.chords : '',
        lyrics: typeof b.lyrics === 'string' ? b.lyrics : '',
      })
    })
    const section = newSection(typeof s.label === 'string' ? s.label : 'Section', 0)
    section.bars = bars.length ? bars : [newBar()]
    return section
  })

  return newChart({
    title: str(o.title) ?? fallbackMeta.title ?? '',
    artist: str(o.artist) ?? fallbackMeta.artist ?? '',
    key: str(o.key) ?? fallbackMeta.key ?? 'C',
    time: str(o.time) ?? '4/4',
    bpm: str(o.bpm) ?? '',
    style: str(o.style) ?? '',
    sections: sections.length ? sections : [newSection('Intro')],
  })
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** Call a configurable LLM endpoint to produce a structured chart. Throws on failure. */
export async function enhanceWithLLM(
  text: string,
  config: LLMConfig,
  fallbackMeta: Partial<Chart> = {},
): Promise<Chart> {
  const messages = buildImportMessages(text)
  let content = ''

  if (config.provider === 'ollama') {
    const res = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages, stream: false, format: 'json' }),
    })
    if (!res.ok) throw new Error(`Ollama error ${res.status}`)
    const data = await res.json()
    content = data?.message?.content ?? ''
  } else if (config.provider === 'openai') {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      response_format: { type: 'json_object' },
    }
    // Local llama.cpp/llama-swap models (e.g. Gemma 4) need thinking-mode off or
    // the content comes back empty. Real OpenAI rejects unknown params, so only
    // send this to a localhost endpoint.
    if (/localhost|127\.0\.0\.1/.test(config.endpoint)) {
      body.chat_template_kwargs = { enable_thinking: false }
    }
    const res = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`OpenAI-compatible error ${res.status}`)
    const data = await res.json()
    content = data?.choices?.[0]?.message?.content ?? ''
  } else {
    // anthropic
    const res = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
      }),
    })
    if (!res.ok) throw new Error(`Anthropic error ${res.status}`)
    const data = await res.json()
    content = data?.content?.[0]?.text ?? ''
  }

  if (!content) throw new Error('Empty response from model.')
  return coerceChart(extractJSON(content), fallbackMeta)
}
