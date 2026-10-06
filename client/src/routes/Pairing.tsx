import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { signIn } from "../lib/bands";

export function Pairing() {
  const nav = useNavigate();
  // The server serves both the PWA (/app) and the API (/api) on one origin,
  // so default to our own origin. This makes signing in work over the HTTPS
  // tunnel URL (secure context) as well as the plain-HTTP LAN URL, without
  // the old hardcoded `http://host:7800` mixed-content / wrong-port failure.
  const [url, setUrl] = useState(
    typeof window !== "undefined" ? window.location.origin : "",
  );
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function trySignIn(links: { url: string; key: string }[]) {
    setBusy(true);
    setError(null);
    try {
      // A sign-in link can carry several bands (crossover members); the FIRST one
      // ends up active, so sign in to the others first and the primary last.
      for (const l of [...links].reverse()) {
        await signIn(l.url, l.key);
      }
      nav("/");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A sign-in link or QR never lands here on its own: App.tsx shows the confirm
  // screen for it first, and only a confirmed link signs the device in. This form is
  // the typed-in path.

  return (
    <form className="pairing" onSubmit={(e) => {
      e.preventDefault();
      if (!busy && url && key) void trySignIn([{ url, key }]);
    }}>
      <h1>Sign in</h1>
      <p className="pairing-hint">
        Your bandleader gives you a key, or a sign-in link that carries it. With a
        link, you see which band it is for and confirm before this device is signed
        in. With a key, or on your own server, enter the details below.
      </p>
      <p className="pairing-hint">
        Lost your sign-in? Open the sign-in link your bandleader sent you again, or ask them for a new one.
      </p>
      <label>
        Server URL
        <input value={url} onChange={(e) => setUrl(e.target.value)}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" />
      </label>
      <label>
        Key (your sign-in key, or <code>.key</code> from the server&apos;s data folder)
        <input value={key} onChange={(e) => setKey(e.target.value)}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </label>
      <button type="submit" disabled={busy || !url || !key}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
