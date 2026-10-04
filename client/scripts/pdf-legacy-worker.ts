import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Plugin } from "vite";

// Keep the upstream LEGACY worker, with the same compatibility shim as the page.
// Emitting an .mjs asset preserves the PWA precache and a same-origin module worker.
export function pdfLegacyWorker(): Plugin {
  const workerPath = createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
  const source = readFileSync(new URL("../src/lib/promise-with-resolvers.mjs", import.meta.url), "utf8")
    + "\n" + readFileSync(workerPath, "utf8");
  let build = false;
  let devUrl = "";
  return {
    name: "pdf-legacy-worker",
    enforce: "pre",
    configResolved(config) {
      build = config.command === "build";
      devUrl = `${config.base}pdf.worker.compat.mjs`;
    },
    load(id) {
      if (id !== `${workerPath}?url`) return;
      if (!build) return `export default ${JSON.stringify(devUrl)};`;
      const ref = this.emitFile({ type: "asset", name: "pdf.worker.min.mjs", source });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== devUrl) return next();
        res.setHeader("Content-Type", "text/javascript");
        res.end(source);
      });
    },
  };
}
