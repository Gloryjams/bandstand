import { useEffect, useState } from "react";

import { signIn } from "../lib/bands";
import { hydrateRecents } from "../lib/recents";
import { confirmLabel, planPairLinks, type PairLink, type PairPlanItem } from "../lib/pair-confirm";
import { useUi } from "../lib/store";

// The confirm step for a sign-in link. Nothing is written until the player taps the
// confirm button: no band is added, no key replaced. Cancel leaves the device exactly
// as it was. The only network call before that tap is a keyless read of /api/health,
// so the device can show which band the link is for; no key leaves the device for it.

type Probe = { state: "checking" } | { state: "ok"; name: string } | { state: "unreachable" };

async function probeName(url: string): Promise<Probe> {
  try {
    const res = await fetch(`${url}/api/health`, { cache: "no-store" });
    const body = (await res.json()) as { name?: string };
    if (typeof body.name === "string" && body.name) return { state: "ok", name: body.name };
    return res.ok ? { state: "ok", name: "Bandstand" } : { state: "unreachable" };
  } catch {
    return { state: "unreachable" };
  }
}

function sentence(item: PairPlanItem, name: string): string {
  switch (item.action) {
    case "add":
      return `This will add ${name} to this device.`;
    case "replace":
      return `This device is already signed in to ${name}. The link carries a different key, so it will replace the sign-in you have now. If the key belongs to another account, you will be signed in as that account instead.`;
    case "same":
      return `This device is already signed in to ${name} with this key. Nothing will change.`;
  }
}

export function PairConfirm({ links, onClose }: { links: PairLink[]; onClose: () => void }) {
  const bands = useUi((s) => s.bands);
  const activeBandId = useUi((s) => s.activeBandId);
  const signedIn = !!useUi((s) => s.pairing);
  // The plan is fixed at mount: the registry cannot change while this screen is up.
  const [plan] = useState(() => planPairLinks({ bands, activeId: activeBandId }, links));
  const [probes, setProbes] = useState<Record<string, Probe>>(() =>
    Object.fromEntries(plan.map((item) => [item.url, { state: "checking" }])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    for (const item of plan) {
      void probeName(item.url).then((r) => {
        if (alive) setProbes((p) => ({ ...p, [item.url]: r }));
      });
    }
    return () => { alive = false; };
  }, [plan]);

  function nameOf(item: PairPlanItem): string {
    const probe = probes[item.url];
    if (probe?.state === "ok") return probe.name;
    return item.existing?.label ?? "this band";
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      // A link can carry several bands (crossover members); the FIRST one ends up
      // active, so sign in to the others first and the primary last.
      for (const item of [...plan].reverse()) {
        await signIn(item.url, item.key);
      }
      void hydrateRecents(); // quick-find recency is per band
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const nothingToDo = plan.length === 0;

  return (
    <div className="pairing pair-confirm">
      <h1>Sign in with this link?</h1>
      {nothingToDo ? (
        <p className="pairing-hint">This link does not carry a band. Nothing will change.</p>
      ) : (
        <p className="pairing-hint">
          Check that this is the band you expect. Nothing is saved on this device until
          you tap {confirmLabel(plan)}.
        </p>
      )}
      <ul className="band-rows" aria-label="Bands in this link">
        {plan.map((item) => {
          const probe = probes[item.url];
          const name = nameOf(item);
          return (
            <li key={item.url} className={`band-row ${item.action === "replace" ? "on" : ""}`}>
              <div className="pair-confirm-band">
                <div className="pair-confirm-head">
                  <span className="band-row-name">{name}</span>
                  <span className="band-row-chip">
                    {item.action === "add" ? "New band" : item.action === "replace" ? "Replaces sign-in" : "Already here"}
                  </span>
                </div>
                <span className="band-row-sub">{item.url}</span>
                <p className="pair-confirm-what">{sentence(item, name)}</p>
                {probe?.state === "checking" && (
                  <p className="pair-confirm-probe">Checking the server...</p>
                )}
                {probe?.state === "unreachable" && (
                  <p className="pair-confirm-probe error">Could not reach this server right now.</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="pair-confirm-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        {!nothingToDo && (
          <button className="btn btn-primary" onClick={confirm} disabled={busy}>
            {busy ? "Signing in..." : confirmLabel(plan)}
          </button>
        )}
      </div>
      {signedIn && !nothingToDo && (
        <p className="pairing-hint">Cancel keeps the bands you are signed in to as they are.</p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
