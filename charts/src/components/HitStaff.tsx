import { beamCount, engraveBar, parseHits, type EngravedBar, type RhythmEvent } from '@/lib/hits'

// Renders a hit figure as an engraved slash-rhythm cue on a five-line staff.
// Pure SVG, sized by viewBox so it scales with its container and prints crisp.
// `compact` drops the staff lines and shrinks the layout for use inside a bar
// cell. The rhythm itself (note values, dots, rests, beams, ties) is derived in
// src/lib/hits.ts  -  this component only draws the events it is handed.

const BAR_W = 170
const PAD = 16
const GAP = 6.5 // staff line spacing
const STEM = 24
const HEAD_DX = 4.2
const HEAD_DY = 3.6
const BEAM_GAP = 3.2 // vertical spacing between primary and secondary beams
const PARTIAL = 6 // length of a fractional (partial) beam stub

/** Horizontal position of a tick onset within its bar. */
function xAt(bi: number, onset: number, T: number): number {
  return bi * BAR_W + PAD + (onset / T) * (BAR_W - PAD * 1.6)
}

/** SVG glyph for a rest of the given value, centred on (x, ry). */
function restGlyph(x: number, ry: number, base: RhythmEvent['base'], key: string) {
  switch (base) {
    case 'whole':
      return <rect key={key} x={x - 5} y={ry - 8} width={10} height={3.4} className="hs-rest-solid" />
    case 'half':
      return <rect key={key} x={x - 5} y={ry - 3.6} width={10} height={3.4} className="hs-rest-solid" />
    case 'quarter':
      return (
        <path
          key={key}
          d={`M ${x - 2.5} ${ry - 8} L ${x + 2.5} ${ry - 3.5} L ${x - 2} ${ry + 0.5} L ${x + 2.5} ${ry + 5} q -4 1 -1.5 4`}
          className="hs-rest"
        />
      )
    case 'eighth':
      return (
        <g key={key}>
          <circle cx={x - 2.2} cy={ry - 3.4} r={1.7} className="hs-rest-solid" />
          <line x1={x - 1} y1={ry - 3} x2={x + 2.4} y2={ry + 6} className="hs-rest" />
        </g>
      )
    default: // sixteenth
      return (
        <g key={key}>
          <circle cx={x - 2.6} cy={ry - 4.6} r={1.6} className="hs-rest-solid" />
          <circle cx={x - 0.9} cy={ry - 0.6} r={1.6} className="hs-rest-solid" />
          <line x1={x - 1.4} y1={ry - 4.2} x2={x + 2.6} y2={ry + 6.5} className="hs-rest" />
        </g>
      )
  }
}

export function HitStaff({
  value,
  beatsPerBar = 4,
  compact = false,
}: {
  value: string
  beatsPerBar?: number
  compact?: boolean
}) {
  const parsed = parseHits(value, beatsPerBar)
  if (parsed.bars.length === 0) {
    return parsed.error ? <div className="hits-error">{parsed.error}</div> : null
  }
  const width = parsed.bars.length * BAR_W
  const T = beatsPerBar * 4

  // Vertical layout: slash heads on MID, stems reach up to a shared beam line.
  const top = compact ? 2 : 18
  const mid = compact ? top + STEM + 8 : top + GAP * 2
  const labelY = compact ? mid + 16 : top + GAP * 4 + 15
  const height = labelY + 7
  const stemTop = mid - HEAD_DY - STEM
  const tieY = mid + 5.5

  return (
    <div className={`hit-staff${compact ? ' compact' : ''}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ maxWidth: width * (compact ? 1 : 1.4) }}
        role="img"
        aria-label={`hits: ${value}`}
      >
        {/* staff lines (full mode only) */}
        {!compact &&
          [0, 1, 2, 3, 4].map((i) => (
            <line key={i} x1={0} x2={width} y1={top + i * GAP} y2={top + i * GAP} className="hs-line" />
          ))}
        {/* barlines: full mode draws leading/between/final; compact only between bars */}
        {Array.from({ length: parsed.bars.length + 1 }, (_, i) => {
          if (compact && (i === 0 || i === parsed.bars.length)) return null
          const bx = i === parsed.bars.length ? i * BAR_W - 1.2 : i * BAR_W + (i === 0 ? 1.2 : 0)
          return (
            <line
              key={i}
              x1={bx}
              x2={bx}
              y1={compact ? mid - STEM - 4 : top}
              y2={compact ? mid + 4 : top + GAP * 4}
              className={!compact && i === parsed.bars.length ? 'hs-bar final' : 'hs-bar'}
            />
          )
        })}

        {parsed.bars.map((bar, bi) => {
          const eng: EngravedBar = engraveBar(bar, beatsPerBar)
          const beamed = new Set<number>(eng.beams.flatMap((b) => b.members))

          return (
            <g key={bi}>
              {/* ties: arc below the heads (stems point up) */}
              {eng.events.map((e, i) => {
                if (e.kind !== 'note' || !e.tieStart) return null
                const nxt = eng.events[i + 1]
                if (!nxt || nxt.kind !== 'note') return null
                const x1 = xAt(bi, e.onset, T)
                const x2 = xAt(bi, nxt.onset, T)
                return (
                  <path
                    key={`tie-${i}`}
                    d={`M ${x1} ${tieY} Q ${(x1 + x2) / 2} ${tieY + 6} ${x2} ${tieY}`}
                    className="hs-tie"
                  />
                )
              })}

              {/* beams: primary across the group, secondary/partial for sixteenths */}
              {eng.beams.map((bg, gi) => {
                const ms = bg.members.map((idx) => ({
                  x: xAt(bi, eng.events[idx].onset, T),
                  base: eng.events[idx].base,
                }))
                const parts = [
                  <line
                    key="p"
                    x1={ms[0].x + HEAD_DX}
                    x2={ms[ms.length - 1].x + HEAD_DX}
                    y1={stemTop}
                    y2={stemTop}
                    className="hs-beam"
                  />,
                ]
                for (let k = 0; k < ms.length; ) {
                  if (ms[k].base !== 'sixteenth') {
                    k++
                    continue
                  }
                  let j = k
                  while (j + 1 < ms.length && ms[j + 1].base === 'sixteenth') j++
                  const y = stemTop + BEAM_GAP
                  if (j > k) {
                    parts.push(
                      <line key={`s${k}`} x1={ms[k].x + HEAD_DX} x2={ms[j].x + HEAD_DX} y1={y} y2={y} className="hs-beam" />,
                    )
                  } else {
                    const dir = k > 0 ? -1 : 1 // partial stub points inward toward the beat
                    parts.push(
                      <line
                        key={`s${k}`}
                        x1={ms[k].x + HEAD_DX}
                        x2={ms[k].x + HEAD_DX + dir * PARTIAL}
                        y1={y}
                        y2={y}
                        className="hs-beam"
                      />,
                    )
                  }
                  k = j + 1
                }
                return <g key={`beam-${gi}`}>{parts}</g>
              })}

              {/* notes and rests */}
              {eng.events.map((e, i) => {
                if (e.kind === 'rest') {
                  const rx = e.base === 'whole' ? bi * BAR_W + BAR_W / 2 : xAt(bi, e.onset, T)
                  return restGlyph(rx, mid, e.base, `rest-${i}`)
                }
                const x = xAt(bi, e.onset, T)
                const open = e.base === 'half' || e.base === 'whole'
                const hasStem = e.base !== 'whole'
                const flags = beamed.has(i) ? 0 : beamCount(e.base)
                return (
                  <g key={`note-${i}`}>
                    {/* slash notehead  -  filled for quarter-and-shorter, open for half/whole */}
                    {open ? (
                      <path
                        d={`M ${x - 5} ${mid + 4} L ${x + 2} ${mid + 4} L ${x + 5} ${mid - 4} L ${x - 2} ${mid - 4} Z`}
                        className="hs-head-open"
                      />
                    ) : (
                      <line x1={x - HEAD_DX} y1={mid + HEAD_DY} x2={x + HEAD_DX} y2={mid - HEAD_DY} className="hs-head" />
                    )}
                    {/* augmentation dot */}
                    {e.dotted && <circle cx={x + 8} cy={mid - 1.5} r={1.2} className="hs-dot" />}
                    {/* stem */}
                    {hasStem && (
                      <line x1={x + HEAD_DX} y1={mid - HEAD_DY} x2={x + HEAD_DX} y2={stemTop} className="hs-stem" />
                    )}
                    {/* flags (only when not beamed) */}
                    {flags >= 1 && <path d={`M ${x + HEAD_DX} ${stemTop} c 7 3, 9 8, 5 15`} className="hs-flag" />}
                    {flags >= 2 && <path d={`M ${x + HEAD_DX} ${stemTop + 6} c 7 3, 9 8, 5 15`} className="hs-flag" />}
                    {/* spoken label under the attack */}
                    {e.label && (
                      <text x={x} y={labelY} className="hs-say" textAnchor="middle">
                        {e.label}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
      {parsed.error && <div className="hits-error">{parsed.error}</div>}
    </div>
  )
}
