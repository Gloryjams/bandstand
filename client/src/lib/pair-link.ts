// Device-pairing deep link. A paired device shows a QR of this link; a fresh device
// opens it (camera scan) and auto-pairs — no key typing. The url + secret key ride in
// the URL *fragment* (#...), which browsers never send to the server or write to access
// logs, and which Pairing.tsx strips from the address bar right after reading it.

export function buildPairLink(url: string, key: string): string {
  const base = url.replace(/\/+$/, "");
  const params = new URLSearchParams({ url, key });
  return `${base}/app/#${params.toString()}`;
}

export function parsePairLink(hash: string): { url: string; key: string } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const url = params.get("url");
  const key = params.get("key");
  if (!url || !key) return null;
  return { url, key };
}

/** A sign-in link may carry MULTIPLE bands (repeated url/key pairs, zipped in order)
 *  so one tap signs a crossover member into every band they belong to. */
export function parsePairLinkMulti(hash: string): { url: string; key: string }[] {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return [];
  const params = new URLSearchParams(raw);
  const urls = params.getAll("url");
  const keys = params.getAll("key");
  const n = Math.min(urls.length, keys.length);
  const out: { url: string; key: string }[] = [];
  for (let i = 0; i < n; i++) out.push({ url: urls[i]!, key: keys[i]! });
  return out;
}

// The router replaces the URL (unpaired → /pair) before Pairing mounts, which drops the
// fragment. So main.tsx snapshots the entry hash first thing; Pairing consumes it once.
let capturedHash: string | null = null;
export function captureInitialPairHash(hash: string): void {
  if (capturedHash === null) capturedHash = hash;
}
export function takeInitialPairLink(): { url: string; key: string } | null {
  const link = capturedHash ? parsePairLink(capturedHash) : null;
  capturedHash = ""; // consumed — don't re-fire on a later mount
  return link;
}

export function takeInitialPairLinks(): { url: string; key: string }[] {
  const links = capturedHash ? parsePairLinkMulti(capturedHash) : [];
  capturedHash = ""; // consumed — don't re-fire on a later mount
  return links;
}
