// Tiny pub/sub "moment" bus  -  slide-in encouragement toasts (Bonito-Express pattern).
import { useEffect, useState } from 'react'
import { Mascot } from './Mascot'

type Moment = { id: number; text: string; mascot?: boolean }
type Listener = (m: Moment) => void

const listeners = new Set<Listener>()
let counter = 0

export function fireMoment(text: string, opts: { mascot?: boolean } = {}) {
  const m: Moment = { id: ++counter, text, mascot: opts.mascot }
  listeners.forEach((l) => l(m))
}

export function MomentStack() {
  const [moments, setMoments] = useState<Moment[]>([])

  useEffect(() => {
    const listener: Listener = (m) => {
      setMoments((cur) => [...cur, m])
      setTimeout(() => setMoments((cur) => cur.filter((x) => x.id !== m.id)), 2600)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return (
    <div className="moment-stack">
      {moments.map((m) => (
        <div className="moment" key={m.id}>
          {m.mascot && <Mascot size={28} mood="wink" />}
          <span>{m.text}</span>
        </div>
      ))}
    </div>
  )
}
