import { describe, expect, it } from 'vitest'
import { splitBarsInput } from './barsInput'

describe('splitBarsInput', () => {
  it('returns null for ordinary single-bar text', () => {
    expect(splitBarsInput('Cmaj7 A-7')).toBeNull()
    expect(splitBarsInput('')).toBeNull()
  })

  it('splits a pasted phrase into per-bar strings', () => {
    expect(splitBarsInput('C | Am | F G | C')).toEqual(['C', 'Am', 'F G', 'C'])
  })

  it('keeps empty segments as blank bars and % as a repeat', () => {
    expect(splitBarsInput('C || %')).toEqual(['C', '', '%'])
  })

  it('a lone trailing barline (typed on Android) means advance', () => {
    expect(splitBarsInput('C|')).toEqual(['C', ''])
  })
})
