// Theme (device-local). Light is Bonito's daytime pop-art look; dark is the kawaii
// night stage. Applied as data-theme on <html>; the Viewer scopes itself to dark so the
// chart-reading surface stays dark in either theme.

export type Theme = "light" | "dark";

const KEY = "bandstand-theme";

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch { /* ignore */ }
  return "light";
}

export function saveTheme(t: Theme): void {
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
}

export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
}

/** Apply the stored theme before React mounts, so there's no flash of the wrong theme. */
export function applyStoredTheme(): void {
  applyTheme(loadTheme());
}
