import { useEffect } from "react";

interface WakeLockSentinelLike {
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

/**
 * Hold a screen wake lock for the lifetime of the component.
 * Re-acquires on visibility change (Android drops it on focus loss). No-op if unsupported.
 */
export function useWakeLock(): void {
  useEffect(() => {
    const wakeLock = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
    if (!wakeLock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let released = false;

    const acquire = async () => {
      try {
        sentinel = await wakeLock.request("screen");
      } catch {
        /* user gesture required or denied; ignore */
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && !released) acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisible);
      sentinel?.release().catch(() => {});
    };
  }, []);
}
