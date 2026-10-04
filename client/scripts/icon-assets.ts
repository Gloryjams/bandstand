import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

// Guest and room disable publicDir so they do not ship the app's PWA manifest.
// Give each standalone bundle only the shared artwork its HTML references.
export function iconAssets(): Plugin {
  return {
    name: "bandstand-icon-assets",
    generateBundle() {
      for (const fileName of ["favicon.svg", "apple-touch-icon.png"]) {
        this.emitFile({
          type: "asset",
          fileName,
          source: readFileSync(new URL(`../public/${fileName}`, import.meta.url)),
        });
      }
    },
  };
}
