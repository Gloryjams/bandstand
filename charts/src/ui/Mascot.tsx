// "Pinch"  -  the Saltycharts guide. A friendly salt shaker. Bonito-Express flavor:
// a small character that appears in empty states and fires encouraging "moments".

type Mood = 'happy' | 'wink' | 'wave' | 'sing'

export function Mascot({ size = 64, mood = 'happy' }: { size?: number; mood?: Mood }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" className="bob" aria-hidden>
      {/* shaker body */}
      <defs>
        <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a3242" />
          <stop offset="1" stopColor="#1b2030" />
        </linearGradient>
      </defs>
      <path d="M22 30 q0 -6 6 -7 l24 0 q6 1 6 7 l0 34 q0 6 -6 6 l-24 0 q-6 0 -6 -6 z"
            fill="url(#glass)" stroke="#3a4256" strokeWidth="2" />
      {/* metal cap */}
      <path d="M24 30 q-3 -10 16 -10 q19 0 16 10 z" fill="#ff8a3d" stroke="#e8762c" strokeWidth="1.5" />
      {/* cap holes */}
      <circle cx="34" cy="24" r="1.5" fill="#a3501a" />
      <circle cx="40" cy="22" r="1.5" fill="#a3501a" />
      <circle cx="46" cy="24" r="1.5" fill="#a3501a" />
      {/* salt grains */}
      <circle cx="32" cy="52" r="2" fill="#eef1f7" opacity="0.9" />
      <circle cx="44" cy="58" r="1.6" fill="#eef1f7" opacity="0.7" />
      <circle cx="38" cy="46" r="1.3" fill="#eef1f7" opacity="0.6" />
      {/* face */}
      {mood === 'wink' ? (
        <path d="M30 40 q2 2 4 0" stroke="#eef1f7" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      ) : (
        <circle cx="32" cy="40" r="2.4" fill="#eef1f7" />
      )}
      <circle cx="46" cy="40" r="2.4" fill="#eef1f7" />
      {mood === 'sing' ? (
        <ellipse cx="39" cy="48" rx="3.4" ry="4.2" fill="#ff8a3d" />
      ) : (
        <path d="M33 47 q6 5 12 0" stroke="#eef1f7" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      )}
      {/* cheeks */}
      <circle cx="29" cy="45" r="2.4" fill="#ff8a3d" opacity="0.35" />
      <circle cx="49" cy="45" r="2.4" fill="#ff8a3d" opacity="0.35" />
      {/* little wave note */}
      {mood === 'wave' && (
        <g stroke="#34d6c4" strokeWidth="2" fill="none" strokeLinecap="round">
          <path d="M62 30 v10" /><circle cx="59" cy="40" r="3" fill="#34d6c4" stroke="none" />
        </g>
      )}
    </svg>
  )
}

export function MascotGuide({ children, mood = 'happy' }: { children: React.ReactNode; mood?: Mood }) {
  return (
    <div className="mascot-guide">
      <Mascot size={52} mood={mood} />
      <div className="bubble">{children}</div>
    </div>
  )
}
