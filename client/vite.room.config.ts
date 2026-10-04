import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { iconAssets } from "./scripts/icon-assets";

export default defineConfig({
  base: "/room/",
  plugins: [react(), iconAssets()],
  publicDir: false,
  build: {
    outDir: "../server/static/room",
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./room.html", import.meta.url)),
      output: {
        entryFileNames: "room.js",
        chunkFileNames: "room-[name].js",
        assetFileNames: "room.[ext]",
      },
    },
  },
});
