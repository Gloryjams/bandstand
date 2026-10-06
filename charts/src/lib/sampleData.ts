import type { Chart, Setlist } from '@/types'
import { newChart, newBar } from './factory'

// Original practice material supplied with Bandstand, not arrangements of songs.
// Stable seed IDs let sync discard untouched examples instead of uploading them.
export function seedCharts(): Chart[] {
  const timestamp = 1
  return [newChart({
    id: 'seed_turnaround', title: 'Four-bar turnaround', artist: 'Practice exercise',
    style: 'Swing', bpm: '100', createdAt: timestamp, updatedAt: timestamp,
    sections: [{ id: 'seed_turnaround_a', label: 'Practice', repeats: 4,
      bars: ['Cmaj7', 'Am7', 'Dm7', 'G7'].map((chords) => newBar({ chords })) }],
    tags: ['practice'],
  }), newChart({
    id: 'seed_minor_vamp', title: 'Minor vamp', artist: 'Practice exercise',
    key: 'Am', style: 'Even eighths', bpm: '90', createdAt: timestamp, updatedAt: timestamp,
    sections: [{ id: 'seed_minor_vamp_a', label: 'Vamp', description: 'Repeat until the cue',
      bars: ['Am7', 'Dm7', 'Am7', 'E7'].map((chords) => newBar({ chords })) }],
    tags: ['practice'],
  })]
}

export function seedSetlists(): Setlist[] {
  return [{ id: 'seed_practice_set', name: 'Practice set',
    chartIds: ['seed_turnaround', 'seed_minor_vamp'], createdAt: 1, updatedAt: 1 }]
}
