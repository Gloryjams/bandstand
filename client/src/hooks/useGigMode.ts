import { useCallback, useEffect, useState } from "react";

const DIM_KEY = "gig_dim";

function initialDim(): number {
  const v = Number(localStorage.getItem(DIM_KEY));
  return Number.isFinite(v) && v > 0 && v <= 0.85 ? v : 0.35;
}

/**
 * Gig mode: immersive performing mode for a dark stage. Dims the screen (a CSS overlay —
 * the web can't touch the real backlight), goes fullscreen to kill accidental browser-
 * chrome taps, and best-effort locks orientation. Wake lock is separate (always on in the
 * viewer). Everything degrades gracefully where fullscreen / orientation lock are refused
 * (e.g. an insecure plain-HTTP LAN context) — the dim still applies, so the mode is useful
 * everywhere.
 */
export function useGigMode() {
  const [active, setActive] = useState(false);
  const [dim, setDim] = useState(initialDim);

  useEffect(() => { localStorage.setItem(DIM_KEY, String(dim)); }, [dim]);

  const enter = useCallback(async () => {
    setActive(true);
    try { await document.documentElement.requestFullscreen?.(); } catch { /* unsupported / refused */ }
    try { await screen.orientation?.lock?.("landscape"); } catch { /* not allowed here */ }
  }, []);

  const exit = useCallback(async () => {
    setActive(false);
    try { screen.orientation?.unlock?.(); } catch { /* noop */ }
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* noop */ }
  }, []);

  const toggle = useCallback(() => { if (active) void exit(); else void enter(); }, [active, enter, exit]);

  // Leaving fullscreen (system back / gesture) drops gig mode too, so the dim doesn't
  // linger after the user has stepped out of the immersive view. Only fires when the
  // fullscreen state actually changes, so on a LAN context that never went fullscreen
  // the dim persists until the explicit Exit.
  useEffect(() => {
    const onFs = () => { if (document.fullscreenElement === null) setActive((a) => (a ? false : a)); };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  return { active, dim, setDim, enter, exit, toggle };
}
