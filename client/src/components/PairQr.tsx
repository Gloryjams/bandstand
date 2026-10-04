import { useEffect, useState } from "react";
import QRCode from "qrcode";

import { buildPairLink } from "../lib/pair-link";

/**
 * A scannable QR of the device-pairing deep link. Shown on an already-paired device
 * (Settings) so a new phone/tablet can scan it and pair with no key typing. Rendered
 * to a data URL so it works offline (the lib is bundled). NB: prop is `pairKey`, not
 * `key` — `key` is reserved by React.
 */
const DEFAULT_HINT =
  "On the other device, open its camera and scan this. It shows the band name; a tap on Add band signs that device in.";

export function PairQr({ url, pairKey, hint = DEFAULT_HINT }: { url: string; pairKey: string; hint?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const link = buildPairLink(url, pairKey);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(link, { width: 260, margin: 1, color: { dark: "#0a0a0a", light: "#ffffff" } })
      .then((d) => { if (alive) setSrc(d); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [link]);

  if (err) return <p className="error">Couldn’t render the QR code.</p>;

  return (
    <div className="pair-qr">
      {src ? (
        <img className="pair-qr-img" src={src} alt="Pairing QR code" width={260} height={260} />
      ) : (
        <div className="pair-qr-load" aria-label="Generating QR code" />
      )}
      <p className="pair-qr-hint">{hint}</p>
    </div>
  );
}
