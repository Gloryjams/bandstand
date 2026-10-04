import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../lib/api";
import { signOut } from "../lib/bands";
import { checkIdentity, KeyRejectedError } from "../lib/identity";
import { clearResume } from "../lib/resume-store";
import { loadAutocrop, saveAutocrop } from "../lib/autocrop";
import { loadHalfPage, saveHalfPage } from "../lib/half-turn";
import { loadTwoUp, saveTwoUp } from "../lib/two-up";
import { loadTheme, saveTheme, applyTheme, type Theme } from "../lib/theme";
import { useUi } from "../lib/store";
import { expiryLabel, listShares, revokeShare, type ShareRow } from "../lib/shares";
import { PairQr } from "../components/PairQr";
import { Bonito } from "../components/Bonito";
import {
  EXPRESSIONS, OUTFITS, loadOutfit, saveOutfit,
  type BonitoExpression, type BonitoOutfit,
} from "../lib/bonito";

type Health = { ok: boolean; version: string; piece_count: number } | null;

export function Settings() {
  const pairing = useUi((s) => s.pairing);
  const setPairing = useUi((s) => s.setPairing);
  const identity = useUi((s) => s.identity);
  const bands = useUi((s) => s.bands);
  const activeBandId = useUi((s) => s.activeBandId);
  const activeBand = bands.find((b) => b.id === activeBandId);
  const online = useUi((s) => s.online);
  const nav = useNavigate();
  const [health, setHealth] = useState<Health>(null);
  const [checking, setChecking] = useState(true);
  const [connectionProblem, setConnectionProblem] = useState<string | null>(null);
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null);
  const [showQr, setShowQr] = useState(false);

  async function ping() {
    setChecking(true);
    setConnectionProblem(null);
    try {
      await checkIdentity();
      setHealth(await api.get<NonNullable<Health>>("/api/health"));
    } catch (error) {
      setHealth(null);
      if (error instanceof KeyRejectedError) setConnectionProblem(error.message);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => { ping(); }, []);
  useEffect(() => {
    navigator.storage?.estimate?.().then((e) =>
      setStorage({ used: e.usage ?? 0, quota: e.quota ?? 0 }),
    ).catch(() => {});
  }, []);

  const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

  // Half-page turns (device-local; the Viewer reads it when a chart opens).
  const [halfPage, setHalfPage] = useState(loadHalfPage);
  const [autocrop, setAutocrop] = useState(loadAutocrop);
  function toggleAutocrop() {
    const next = !autocrop;
    saveAutocrop(next);
    setAutocrop(next);
  }
  const [twoUp, setTwoUp] = useState(loadTwoUp);
  function toggleTwoUp() {
    const next = !twoUp;
    saveTwoUp(next);
    setTwoUp(next);
  }
  function toggleHalfPage() {
    const next = !halfPage; // side effect outside the updater (StrictMode replays those)
    saveHalfPage(next);
    setHalfPage(next);
  }

  // Theme (device-local). Light = Bonito's daytime look; dark = the night stage.
  const [theme, setThemeState] = useState<Theme>(loadTheme);
  function pickTheme(t: Theme) {
    saveTheme(t);
    applyTheme(t);
    setThemeState(t);
  }

  // Bonito's dressing room — outfit is device-local; tap the cat to change his mood.
  const [outfit, setOutfit] = useState<BonitoOutfit>(loadOutfit);
  const [exprIdx, setExprIdx] = useState(0);
  const expr: BonitoExpression = EXPRESSIONS[exprIdx % EXPRESSIONS.length]?.key ?? "happy";
  const era = OUTFITS.find((o) => o.key === outfit) ?? OUTFITS[0]!;
  function pickOutfit(o: BonitoOutfit) {
    setOutfit(o);
    saveOutfit(o);
  }

  // Shared links. Deliberately never mirrored to Dexie: a stale offline list would
  // show links as live that are already revoked (or the reverse), and revoking is
  // only meaningful against the server anyway.
  const [shares, setShares] = useState<ShareRow[] | null>(null);
  // Expiry countdowns are measured from the fetch, not a fresh Date.now() each
  // render — the list only changes when it is refetched.
  const [fetchedAt, setFetchedAt] = useState(0);
  const [sharesBusy, setSharesBusy] = useState(false);
  const [sharesError, setSharesError] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [revokeFailed, setRevokeFailed] = useState(false);

  async function loadShares() {
    setSharesBusy(true);
    setSharesError(false);
    try {
      setShares(await listShares());
      setFetchedAt(Date.now());
    } catch {
      setShares(null);
      setSharesError(true);
    } finally {
      setSharesBusy(false);
    }
  }

  const isMember = identity?.role === "member";
  useEffect(() => { if (online && !isMember) loadShares(); }, [online, isMember]);

  // A revoke that fails must say so: the refetch below would otherwise just redraw
  // the link as active, which reads like nothing happened.
  async function revoke(id: string) {
    setRevokeId(null);
    setRevokeFailed(false);
    setSharesBusy(true);
    let failed = false;
    try {
      await revokeShare(id);
    } catch {
      failed = true;
    } finally {
      setSharesBusy(false);
    }
    await loadShares();
    setRevokeFailed(failed);
  }

  // Sign out of the ACTIVE band only: forgets its sign-in and deletes its local
  // mirror; other bands on this device are untouched. With none left, back to
  // the sign-in screen.
  async function signOutActive() {
    if (!activeBandId) { setPairing(null); nav("/pair"); return; }
    await signOut(activeBandId);
    const left = useUi.getState().bands;
    if (left.length === 0) nav("/pair");
    else nav("/");
  }

  return (
    <div className="settings">
      <div className="app-top">
        <h1 className="screen-title">Settings</h1>
      </div>

      <div className="settings-list">
        <section className="settings-group">
          <h3>Connection</h3>
          <div className="settings-card">
            <div className="settings-row">
              <span className="k">Status</span>
              <span className={`v ${checking ? "" : health ? "ok" : "bad"}`}>
                {checking ? "Checking…" : health ? "Connected" : connectionProblem ? "Key not accepted" : "Unreachable"}
              </span>
            </div>
            <div className="settings-row">
              <span className="k">Server</span>
              <span className="v">{pairing?.url ?? "not set"}</span>
            </div>
            {activeBand && (
              <div className="settings-row">
                <span className="k">Band</span>
                <span className="v">{activeBand.label}</span>
              </div>
            )}
            {identity && (
              <div className="settings-row">
                <span className="k">Signed in as</span>
                <span className="v">
                  {identity.name}{identity.role === "member" ? " · band member" : ""}
                </span>
              </div>
            )}
            {health && (
              <div className="settings-row">
                <span className="k">Library</span>
                <span className="v">{health.piece_count} pieces</span>
              </div>
            )}
            <button className="btn" onClick={ping} disabled={checking}>Test connection</button>
            {connectionProblem && <p className="error">{connectionProblem}</p>}
          </div>
        </section>

        <section className="settings-group">
          <h3>Storage</h3>
          <div className="settings-card">
            <div className="settings-row">
              <span className="k">Cached on this device</span>
              <span className="v">{storage ? `${mb(storage.used)} / ${mb(storage.quota)}` : "unknown"}</span>
            </div>
          </div>
        </section>

        <section className="settings-group">
          <h3>Sign in another device</h3>
          <div className="settings-card">
            {!pairing ? (
              <p className="settings-hint">Sign this device in first.</p>
            ) : showQr ? (
              <>
                <PairQr url={pairing.url} pairKey={pairing.key} />
                <button className="btn" onClick={() => setShowQr(false)}>Hide QR</button>
              </>
            ) : (
              <>
                <p className="settings-hint">Show a QR another phone or tablet can scan to sign in as you: same band, same account, no typing.</p>
                <button className="btn" onClick={() => setShowQr(true)}>Show sign-in QR</button>
              </>
            )}
          </div>
        </section>

        {/* Share management is director-only (the server 403s a member's /api/shares). */}
        {identity?.role !== "member" && (
        <section className="settings-group">
          <h3>Shared links</h3>
          <div className="settings-card">
            {!online ? (
              <p className="settings-hint">Connect to manage shares.</p>
            ) : sharesError ? (
              <>
                <p className="settings-hint">Couldn&rsquo;t load your shared links.</p>
                <button className="btn" onClick={loadShares} disabled={sharesBusy}>Try again</button>
              </>
            ) : shares == null ? (
              <p className="settings-hint">Loading&hellip;</p>
            ) : shares.length === 0 ? (
              <p className="settings-hint">No links yet. Share a chart or a setlist and it shows up here.</p>
            ) : (
              <>
                {revokeFailed && (
                  <p className="share-error">
                    That link was not revoked. It is still live. Try again.
                  </p>
                )}
                <ul className="share-rows">
                  {shares.map((s) => (
                    <li key={s.id} className="share-row">
                      <span className="share-row-main">
                        <span className="share-row-label">{s.label}</span>
                        <span className="share-row-sub">
                          {s.target_kind === "setlist" ? "Setlist" : "Chart"} · {expiryLabel(s, fetchedAt)}
                        </span>
                      </span>
                      <span className={`share-chip ${s.state}`}>{s.state}</span>
                      {s.state === "active" && (revokeId === s.id ? (
                        <span className="row-confirm">
                          <span className="row-confirm-q">Revoke?</span>
                          <button className="danger" onClick={() => revoke(s.id)}>Yes</button>
                          <button onClick={() => setRevokeId(null)}>Cancel</button>
                        </span>
                      ) : (
                        <button
                          className="row-del"
                          onClick={() => setRevokeId(s.id)}
                          aria-label={`Revoke link for ${s.label}`}
                        >
                          Revoke
                        </button>
                      ))}
                    </li>
                  ))}
                </ul>
                <button className="btn" onClick={loadShares} disabled={sharesBusy}>
                  {sharesBusy ? "Refreshing…" : "Refresh"}
                </button>
              </>
            )}
          </div>
        </section>
        )}

        <section className="settings-group">
          <h3>Appearance</h3>
          <div className="settings-card">
            <div className="settings-row">
              <span className="k">Theme</span>
              <div className="seg" role="group" aria-label="Theme">
                <button className={`seg-btn ${theme === "light" ? "on" : ""}`}
                        onClick={() => pickTheme("light")} aria-pressed={theme === "light"}>Light</button>
                <button className={`seg-btn ${theme === "dark" ? "on" : ""}`}
                        onClick={() => pickTheme("dark")} aria-pressed={theme === "dark"}>Dark</button>
              </div>
            </div>
            <p className="settings-hint">
              Light is Bonito&rsquo;s daytime look; dark keeps things easy on the eyes.
              The chart view stays dark either way, so it&rsquo;s always stage-ready.
            </p>
          </div>
        </section>

        <section className="settings-group">
          <h3>Viewer</h3>
          <div className="settings-card">
            <div className="settings-row">
              <span className="k">Half-page turns</span>
              <button
                className={`toggle half-toggle ${halfPage ? "on" : ""}`}
                onClick={toggleHalfPage}
                role="switch"
                aria-checked={halfPage}
                aria-label="Half-page turns"
              >
                <span className="toggle-knob" />
              </button>
            </div>
            <p className="settings-hint">
              Advance in half steps: the top of the next page appears over the top half
              while you finish the bottom of this one, forScore-style. Takes effect the
              next time a chart opens.
            </p>
            <div className="settings-row">
              <span className="k">Auto-crop margins</span>
              <button
                className={`toggle autocrop-toggle ${autocrop ? "on" : ""}`}
                onClick={toggleAutocrop}
                role="switch"
                aria-checked={autocrop}
                aria-label="Auto-crop margins"
              >
                <span className="toggle-knob" />
              </button>
            </div>
            <p className="settings-hint">
              Zoom the music past scanned white margins so it fills the screen.
              Reading mode only: annotating shows the full page. Takes effect the
              next time a chart opens.
            </p>
            <div className="settings-row">
              <span className="k">Two-up in landscape</span>
              <button
                className={`toggle twoup-toggle ${twoUp ? "on" : ""}`}
                onClick={toggleTwoUp}
                role="switch"
                aria-checked={twoUp}
                aria-label="Two-up in landscape"
              >
                <span className="toggle-knob" />
              </button>
            </div>
            <p className="settings-hint">
              Landscape shows this page and the next side by side, like an open
              book. Turns still move one page. Takes effect the next time a
              chart opens.
            </p>
          </div>
        </section>

        <section className="settings-group">
          <h3>Session</h3>
          <div className="settings-card">
            <button className="btn" onClick={() => clearResume()}>Forget last session</button>
            <button className="btn btn-danger" onClick={signOutActive}>
              {bands.length > 1 ? "Sign out of this band" : "Sign out"}
            </button>
          </div>
        </section>

        <section className="settings-group">
          <h3>Bonito&rsquo;s dressing room</h3>
          <div className="settings-card dressing-room">
            <button
              className="dr-stage"
              onClick={() => setExprIdx((i) => i + 1)}
              aria-label="Change Bonito's mood"
            >
              <Bonito size={168} outfit={outfit} expression={expr} />
            </button>
            <div className="dr-era">
              <div className="dr-era-name" style={{ color: era.accent }}>{era.era}</div>
              <div className="dr-era-sub">{era.sub}</div>
            </div>
            <div className="dr-chips">
              {OUTFITS.map((o) => (
                <button
                  key={o.key}
                  className={`dr-chip ${o.key === outfit ? "on" : ""}`}
                  onClick={() => pickOutfit(o.key)}
                >
                  <span className="dr-dot" style={{ background: o.dot }} />
                  {o.label}
                </button>
              ))}
            </div>
            <p className="settings-hint">
              Tap Bonito to change his mood. He joins the practice player in whatever
              outfit you hang on him here.
            </p>
          </div>
        </section>

        <section className="settings-group">
          <h3>About</h3>
          <div className="settings-card">
            <div className="settings-row">
              <span className="k">Bandstand</span>
              <span className="v">{health?.version ? `v${health.version}` : "unknown"}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
