// Metronome engine: Web Audio lookahead scheduler (25ms tick, 120ms horizon)
// so the click stays steady regardless of React render jank. Pure helpers are
// exported separately for tests.

export function clampBpm(n: number): number {
  if (!Number.isFinite(n)) return 100;
  return Math.min(300, Math.max(30, Math.round(n)));
}

/** Beats per bar from a "N/D" time signature; defaults to 4 when absent/junk. */
export function parseBeatsPerBar(timeSig: string | null | undefined): number {
  const m = /^(\d{1,2})\s*\/\s*\d{1,2}$/.exec((timeSig ?? "").trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 12 ? n : 4;
}

const TICK_MS = 25;
const HORIZON_S = 0.12;

export class Metronome {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextTime = 0;
  private beat = 0;
  bpm = 100;
  beatsPerBar = 4;
  /** Fired near-audibly on each beat (0-indexed within the bar) for a visual pulse. */
  onBeat?: (beatInBar: number) => void;

  get running(): boolean { return this.timer != null; }

  start(): void {
    if (this.timer) return;
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
    this.nextTime = this.ctx.currentTime + 0.08;
    this.beat = 0;
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const secondsPerBeat = 60 / clampBpm(this.bpm);
    while (this.nextTime < ctx.currentTime + HORIZON_S) {
      const beatInBar = this.beat % Math.max(1, this.beatsPerBar);
      this.click(this.nextTime, beatInBar === 0);
      const delay = Math.max(0, (this.nextTime - ctx.currentTime) * 1000);
      setTimeout(() => { if (this.running) this.onBeat?.(beatInBar); }, delay);
      this.beat++;
      this.nextTime += secondsPerBeat;
    }
  }

  private click(t: number, accent: boolean): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1568 : 1046.5; // G6 downbeat, C6 offbeats
    gain.gain.setValueAtTime(accent ? 0.5 : 0.3, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);
  }
}
