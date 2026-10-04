import { useEffect } from "react";

export function useHardwareBack(active: boolean, handler: () => void) {
  useEffect(() => {
    if (!active) return;
    history.pushState({ overlay: true }, "");
    const onPop = (_e: PopStateEvent) => {
      handler();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (history.state?.overlay) history.back();
    };
  }, [active, handler]);
}
