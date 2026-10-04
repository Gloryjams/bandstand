import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { iconAssets } from "./scripts/icon-assets";

/**
 * Guest chart bundle — a second, separate build from the PWA in vite.config.ts.
 * Separate on purpose: no PWA plugin and no service worker (a stranger's phone must
 * never end up with an offline cache of the gig book), its own base, and its own
 * outDir. emptyOutDir only ever clears server/static/guest, so the two builds can
 * run back to back without deleting each other.
 *
 * Filenames are a CONTRACT: the public app's HTML shell hard-references
 * /guest/guest.js and /guest/guest.css, so the hashed defaults are overridden.
 */
export default defineConfig({
  base: "/guest/",
  plugins: [react(), iconAssets()],
  // publicDir off: client/public is the APP's payload (vendored fonts, PWA manifest,
  // icons). Only the favicon and Apple icon are copied by iconAssets; a manifest
  // under /guest/ would offer a stranger an install prompt for the gig book.
  publicDir: false,
  build: {
    outDir: "../server/static/guest",
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./guest.html", import.meta.url)),
      output: {
        entryFileNames: "guest.js",
        chunkFileNames: "guest-[name].js",
        assetFileNames: "guest.[ext]",
      },
    },
  },
});
