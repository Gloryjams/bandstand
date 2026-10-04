import { useEffect, useState } from "react";

export interface BatteryInfo {
  level: number | null; // 0..1, or null when unsupported
  charging: boolean;
}

interface BatteryManagerLike extends EventTarget {
  level: number;
  charging: boolean;
}

/** Battery level/charging via the Battery Status API; null level when unavailable. */
export function useBattery(): BatteryInfo {
  const [info, setInfo] = useState<BatteryInfo>({ level: null, charging: false });

  useEffect(() => {
    const getBattery = (navigator as unknown as {
      getBattery?: () => Promise<BatteryManagerLike>;
    }).getBattery;
    if (!getBattery) return;

    let battery: BatteryManagerLike | null = null;
    let alive = true;
    const update = () => {
      if (alive && battery) setInfo({ level: battery.level, charging: battery.charging });
    };

    getBattery.call(navigator).then((b) => {
      if (!alive) return;
      battery = b;
      update();
      b.addEventListener("levelchange", update);
      b.addEventListener("chargingchange", update);
    });

    return () => {
      alive = false;
      if (battery) {
        battery.removeEventListener("levelchange", update);
        battery.removeEventListener("chargingchange", update);
      }
    };
  }, []);

  return info;
}
