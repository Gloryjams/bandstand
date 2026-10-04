import { describe, expect, it } from 'vitest'

import { roadmapNote } from './ChartGrid'

describe('roadmapNote', () => {
  it('joins soloists, note and hits without an em-dash', () => {
    const line = roadmapNote({
      id: 'a1', sectionId: 's1', solos: ['gtr', 'keys'], note: 'build it', hits: '1 3',
    })
    expect(line).toBe('solos: gtr, keys · build it · hits')
    // Guests see this line on public share pages; the no-em-dash rule is site-wide.
    expect(line).not.toMatch(/[—–]/)
  })
})
