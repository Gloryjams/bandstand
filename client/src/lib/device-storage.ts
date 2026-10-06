import { useUi } from "./store";

const HOME_SCREEN_DISMISSED = "bandstand-home-screen-dismissed";

/** Best effort: storage permission must never hold up sign-in or boot. */
export async function requestPersistentStorage(): Promise<void> {
  let kept = false;
  try {
    const storage = navigator.storage;
    if (typeof storage?.persisted === "function") {
      kept = await storage.persisted();
      if (!kept && typeof storage.persist === "function") kept = await storage.persist();
    }
  } catch { /* unavailable or refused */ }
  useUi.getState().setStoragePersisted(kept);
}

export function shouldShowHomeScreenHint(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || ((/Mac/.test(navigator.userAgent) || /Mac/.test(navigator.platform)) && navigator.maxTouchPoints > 1);
  const installed = (navigator as Navigator & { standalone?: boolean }).standalone
    || window.matchMedia?.("(display-mode: standalone)").matches
    || window.matchMedia?.("(display-mode: fullscreen)").matches;
  if (!ios || installed) return false;
  try { return localStorage.getItem(HOME_SCREEN_DISMISSED) !== "1"; }
  catch { return true; }
}

export function dismissHomeScreenHint(): void {
  try { localStorage.setItem(HOME_SCREEN_DISMISSED, "1"); } catch { /* private mode */ }
  useUi.getState().setHomeScreenHint(false);
}
