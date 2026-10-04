import type { ReactNode } from "react";

import { Bonito } from "./Bonito";
import { loadOutfit } from "../lib/bonito";
import { Sparkle } from "./Kawaii";

export function EmptyState({ title, hint }: { title: string; hint: ReactNode }) {
  return (
    <div className="empty-state">
      {/* Bonito himself naps under the dressing-room blush — in whatever outfit is hung
          on him in Settings. A couple of sparkles float around the spotlight. */}
      <div className="stage-spot">
        <span className="spark tw stray a" aria-hidden><Sparkle /></span>
        <span className="spark tw stray b" aria-hidden><Sparkle /></span>
        <Bonito expression="sleepy" outfit={loadOutfit()} size={188} bob className="bonito-empty" />
      </div>
      <h2>
        <span className="spark tw" style={{ width: 18, height: 18, marginRight: 8, verticalAlign: "-2px" }}>
          <Sparkle />
        </span>
        {title}
      </h2>
      <p>{hint}</p>
    </div>
  );
}
