import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { pdfLegacyWorker } from "./scripts/pdf-legacy-worker";

export default defineConfig({
  base: "/app/",
  plugins: [
    pdfLegacyWorker(),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      strategies: "generateSW",
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,woff2}"],
        navigateFallback: "/app/index.html",
        runtimeCaching: [
          {
            urlPattern: /\/api\/thumb\//,
            handler: "CacheFirst",
            options: { cacheName: "thumbs" },
          },
        ],
      },
      manifest: false, // we ship our own manifest.json
    }),
  ],
  build: {
    outDir: "../server/static/app",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7800",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/tests/setup.ts"],
  },
});
