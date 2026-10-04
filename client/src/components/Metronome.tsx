import { useEffect, useRef, useState } from "react";

import { clampBpm, Metronome as Engine } from "../lib/metronome";

interface Props {
  /** Seed tempo — piece.tempo when the chart has one, else the 100bpm default. */
  initialBpm: number | null;
  beatsPerBar: number;
  /** Annotate mode stows the bar (matches AudioPlayer) but playback continues. */
  hidden?: boolean;
  onClose: () => void;
}

/** Floating click bar: seeded from piece.tempo, nudge or type the bpm, downbeat
    accented per the piece's time signature, dot pulses on the beat. */
export function MetronomeBar({ initialBpm, beatsPerBar, hidden = false, onClose }: Props) {
  const engineRef = useRef<Engine | null>(null);
  const [bpm, setBpm] = useState(() => clampBpm(initialBpm ?? 100));
  const [running, setRunning] = useState(false);
  const [pulse, setPulse] = useState<number | null>(null);

  if (!engineRef.current) engineRef.current = new Engine();
  const engine = engineRef.current;
  engine.bpm = bpm;
  engine.beatsPerBar = beatsPerBar;

  useEffect(() => {
    engine.onBeat = (b) => {
      setPulse(b);
      // retrigger the CSS pulse even on repeated beats
      setTimeout(() => setPulse(null), 90);
    };
    return () => { engine.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = () => {
    if (engine.running) { engine.stop(); setRunning(false); }
    else { engine.start(); setRunning(true); }
  };
  const nudge = (d: number) => setBpm((b) => clampBpm(b + d));

  return (
    <div className={`metro-bar ${hidden ? "metro-bar-hidden" : ""}`} role="group" aria-label="Metronome">
      <span className={`metro-dot${pulse !== null ? (pulse === 0 ? " down" : " tick") : ""}`} aria-hidden />
      <button className="metro-btn" onClick={() => nudge(-4)} aria-label="Slower">−</button>
      <input
        className="metro-bpm"
        type="number"
        inputMode="numeric"
        min={30}
        max={300}
        value={bpm}
        onChange={(e) => setBpm(clampBpm(Number(e.target.value)))}
        aria-label="Beats per minute"
      />
      <button className="metro-btn" onClick={() => nudge(4)} aria-label="Faster">+</button>
      <button className={`metro-btn metro-play${running ? " on" : ""}`} onClick={toggle}
              aria-pressed={running} aria-label={running ? "Stop" : "Start"}>
        {running ? "Stop" : "Start"}
      </button>
      <button className="metro-btn" onClick={onClose} aria-label="Close metronome">×</button>
    </div>
  );
}
