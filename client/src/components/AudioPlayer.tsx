/**
 * Practice bar — the audio mini-player for the Viewer. A↔B loop + tempo, with Bonito
 * as the practice buddy (his mood tracks the player state — the design handoff's
 * "controlled mode": README said tie him to app events, so here he is).
 *
 * The API is header-authenticated, so <audio src> can't point at it directly: bytes come
 * OPFS-first (same content-hash convention pre-cache writes), else an authed fetch, and
 * play from an object URL. No writes anywhere — this is read-only chrome.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import type { AudioTrack } from "../lib/db";
import { readFile } from "../lib/opfs";
import { fmtTime, loopSeek, nextRate, normalizeLoop, type LoopRange } from "../lib/audio-loop";
import { loadOutfit, moodFor } from "../lib/bonito";
import { Bonito } from "./Bonito";

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i) : "";
}

// Session-scoped bytes cache so reopening the bar doesn't refetch (LAN HTTP has no
// OPFS). Caching the PROMISE dedupes concurrent misses — two callers racing the same
// hash would otherwise each mint an object URL and orphan one. Failures uncache so a
// retry actually refetches.
const urlCache = new Map<string, Promise<string>>();

function trackUrl(t: AudioTrack): Promise<string> {
  const hit = urlCache.get(t.content_hash);
  if (hit) return hit;
  const p = (async () => {
    const cached = await readFile("audio", t.content_hash, extOf(t.filename));
    const blob = cached ?? await (async () => {
      const r = await api.raw(`/api/audio/${t.piece_id}/${t.id}`);
      if (!r.ok) throw new Error(`audio ${r.status}`);
      return r.blob();
    })();
    return URL.createObjectURL(blob);
  })();
  urlCache.set(t.content_hash, p);
  p.catch(() => urlCache.delete(t.content_hash));
  return p;
}

const PlayIcon = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
);
const PauseIcon = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
);
const CloseIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export function AudioPlayer({
  tracks,
  hidden = false,
  onClose,
}: {
  tracks: AudioTrack[];
  /** Keep mounted (audio alive) while other bottom chrome takes the space. */
  hidden?: boolean;
  onClose: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1);
  const [markA, setMarkA] = useState<number | null>(null);
  const [loop, setLoop] = useState<LoopRange | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const track = useMemo(
    () => tracks.find((t) => t.id === trackId) ?? tracks[0] ?? null,
    [tracks, trackId],
  );
  const outfit = useMemo(loadOutfit, []);

  // Resolve bytes whenever the track changes; loop/marks are per-take. Pause the
  // element up front — removing the src attribute alone does NOT stop the old take,
  // and a failed fetch would otherwise leave it playing behind disabled controls.
  useEffect(() => {
    let alive = true;
    audioRef.current?.pause();
    setSrc(null); setLoadErr(false); setPlaying(false); setEnded(false);
    setTime(0); setDur(track?.duration_ms ? track.duration_ms / 1000 : 0);
    setMarkA(null); setLoop(null);
    if (!track) return;
    trackUrl(track)
      .then((u) => { if (alive) setSrc(u); })
      .catch(() => { if (alive) setLoadErr(true); });
    return () => { alive = false; };
  }, [track, retryTick]);

  // A detached <audio> keeps playing until GC'd — closing the bar mid-take (or leaving
  // the piece) must stop the sound, not orphan it with no controls on screen.
  useEffect(() => {
    const el = audioRef.current;
    return () => { el?.pause(); };
  }, []);

  // Element wiring: rate survives track swaps; pitch is preserved while slowed.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !src) return;
    el.playbackRate = rate;
    // preservesPitch is standard in modern engines; harmless where it isn't.
    (el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
  }, [src, rate]);

  // A↔B enforcement, checked every frame while playing (timeupdate is too coarse).
  useEffect(() => {
    if (!playing || !loop) return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el) {
        const target = loopSeek(el.currentTime, loop);
        if (target != null) el.currentTime = target;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, loop]);

  function toggle() {
    const el = audioRef.current;
    if (!el || !src) return;
    // play() rejects when a pause lands mid-start (e.g. the bar closes right after a
    // tap) — an expected AbortError, not a failure worth surfacing.
    if (el.paused) { setEnded(false); el.play().catch(() => {}); } else { el.pause(); }
  }
  function seekTo(t: number) {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = t;
    setTime(t);
    setEnded(false);
  }
  function setA() {
    const el = audioRef.current;
    if (!el) return;
    setLoop(null);
    setMarkA(el.currentTime);
  }
  function setB() {
    const el = audioRef.current;
    if (!el || markA == null) return;
    const knownDur = dur || (Number.isFinite(el.duration) ? el.duration : 0);
    const l = normalizeLoop(markA, el.currentTime, knownDur);
    if (!l) return; // duration unknown (metadata not in yet) — stay armed, retry later
    setLoop(l);
    setMarkA(null);
    if (el.currentTime < l.a || el.currentTime >= l.b) el.currentTime = l.a;
  }
  function clearLoop() {
    setLoop(null);
    setMarkA(null);
  }

  const mood = moodFor({ playing, loopArmed: markA != null, looping: loop != null, ended });
  const loopPct = loop && dur > 0
    ? { a: (loop.a / dur) * 100, b: (loop.b / dur) * 100 }
    : null;

  return (
    <div className={`audio-bar ${hidden ? "audio-bar-hidden" : ""}`} data-mood={mood}>
      <audio
        ref={audioRef}
        src={src ?? undefined}
        onPlay={() => { setPlaying(true); setEnded(false); }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          // a loop whose B sits at the very end wraps instead of stopping
          const el = audioRef.current;
          if (loop && el) { el.currentTime = loop.a; el.play().catch(() => {}); return; }
          setPlaying(false); setEnded(true);
        }}
        onTimeUpdate={(e) => {
          // coarse loop fallback: rAF is throttled/paused in background tabs, and a
          // loop that silently degrades to "A to end" would be baffling mid-practice
          const el = e.currentTarget;
          const target = loopSeek(el.currentTime, loop);
          if (target != null) { el.currentTime = target; setTime(target); return; }
          setTime(el.currentTime);
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDur(d); // streams can report Infinity — bad range max
        }}
        onError={() => { setLoadErr(true); setPlaying(false); }}
      />

      <div className="ap-cat" aria-hidden>
        <Bonito size={46} outfit={outfit} expression={mood} bob={playing} />
      </div>

      <div className="ap-main">
        <div className="ap-top-row">
          {tracks.length > 1 ? (
            <select
              className="ap-track"
              value={track?.id ?? ""}
              onChange={(e) => setTrackId(e.target.value)}
              aria-label="Practice track"
            >
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>{t.label ?? t.filename}</option>
              ))}
            </select>
          ) : (
            <span className="ap-track-name">{track ? track.label ?? track.filename : "No track"}</span>
          )}
          {loadErr ? (
            <button className="ap-retry" onClick={() => { setLoadErr(false); setRetryTick((n) => n + 1); }}>
              couldn&rsquo;t load. Tap to retry
            </button>
          ) : (
            <span className="ap-time">{`${fmtTime(time)} / ${fmtTime(dur)}`}</span>
          )}
        </div>

        <input
          className="ap-seek"
          type="range"
          min={0}
          max={Math.max(dur, 0.01)}
          step={0.05}
          value={Math.min(time, dur || 0)}
          onChange={(e) => seekTo(Number(e.target.value))}
          disabled={!src}
          aria-label="Seek"
          style={loopPct ? {
            background: `linear-gradient(to right, var(--surface-2) ${loopPct.a}%, var(--accent-wash) ${loopPct.a}%, var(--accent-wash) ${loopPct.b}%, var(--surface-2) ${loopPct.b}%)`,
          } : undefined}
        />

        <div className="ap-controls">
          <button className="ap-play" onClick={toggle} disabled={!src}
                  aria-label={playing ? "Pause" : "Play"}>
            {playing ? PauseIcon : PlayIcon}
          </button>
          <button className={`ap-chip ${markA != null || loop ? "on" : ""}`} onClick={setA}
                  disabled={!src} aria-label="Set loop start">A</button>
          <button className={`ap-chip ${loop ? "on" : ""}`} onClick={setB}
                  disabled={!src || markA == null} aria-label="Set loop end">B</button>
          {(loop || markA != null) && (
            <button className="ap-chip" onClick={clearLoop} aria-label="Clear loop">{CloseIcon}</button>
          )}
          <span className="ap-loop-label">
            {loop ? `${fmtTime(loop.a)}-${fmtTime(loop.b)}`
              : markA != null ? `A ${fmtTime(markA)}…` : ""}
          </span>
          <div className="ap-rate">
            <button className="ap-chip" onClick={() => setRate((r) => nextRate(r, -1))}
                    disabled={!src} aria-label="Slower">−</button>
            <span className={`ap-rate-val ${rate !== 1 ? "on" : ""}`}>
              {rate.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×
            </span>
            <button className="ap-chip" onClick={() => setRate((r) => nextRate(r, +1))}
                    disabled={!src} aria-label="Faster">+</button>
          </div>
          <button className="ap-close" onClick={onClose} aria-label="Close player">{CloseIcon}</button>
        </div>
      </div>
    </div>
  );
}
