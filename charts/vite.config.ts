import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// Standalone production uses /charts, served WITHOUT a trailing
// slash (site standard) — relative './' assets resolve to /assets there and the
// app never mounts. Absolute base pins everything to the real home; dev stays /.
// `build:bandstand` builds with --mode bandstand so the bundle can know it is
// served BY Bandstand (see src/lib/bandstand.ts). It is still a production
// build living at /charts/, so every production path decision below must
// treat it as such - keying them on the production mode alone silently
// flipped base to '/' and 404'd every asset.
const servedAtCharts = (mode: string) => mode === 'production' || mode === 'bandstand'

export default defineConfig(({ mode }) => ({
  base: servedAtCharts(mode) ? '/charts/' : '/',
  define: {
    'import.meta.env.VITE_SERVED_BY_BANDSTAND': JSON.stringify(mode === 'bandstand' ? '1' : '0'),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Saltycharts',
        short_name: 'Saltycharts',
        description: 'Chord charts + setlists for the stage.',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        orientation: 'any',
        start_url: servedAtCharts(mode) ? '/charts/' : '/',
        scope: servedAtCharts(mode) ? '/charts/' : '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  server: { port: 5180, host: true },
}))
