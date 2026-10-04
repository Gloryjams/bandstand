// Scans the BUILT guest bundle for em-dashes and en-dashes.
//
// Why the built artifact and not the source: minification strips comments (which use
// em-dashes freely and legitimately), so anything left is a string that can actually
// reach a guest's screen. It also catches copy on code paths no test fixture happens
// to execute, which is exactly how the hits.ts parse-error message survived two
// earlier passes. Grep is not usable here: a byte-oriented [—–] class matches single
// bytes of unrelated multi-byte glyphs (Δ, ∞, ×, −) and buries the real hits.
//
// Run after a guest build: node scripts/check-guest-copy.mjs
import { readFileSync, existsSync } from "node:fs";

// Relative to this file (client/scripts/), so up two to the repo root.
const FILES = ["../../server/static/guest/guest.js", "../../server/static/guest/guest.css"];
const EM = 0x2014;
const EN = 0x2013;

let found = 0;
let missing = 0;

for (const rel of FILES) {
  const path = new URL(rel, import.meta.url);
  if (!existsSync(path)) {
    console.error(`MISSING  ${rel} (run: npm run build:guest)`);
    missing++;
    continue;
  }
  const text = readFileSync(path, "utf8");
  let hits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i);
    if (c === EM || c === EN) {
      hits++;
      found++;
      const near = text.slice(Math.max(0, i - 60), i + 60).replace(/\n/g, " ");
      console.error(`FOUND    ${rel}  U+${c.toString(16)}  ...${near}...`);
    }
  }
  if (hits === 0) console.log(`OK       ${rel}`);
}

if (missing > 0) process.exit(2);
if (found > 0) {
  console.error(`\n${found} em/en-dash in guest copy. Site-wide rule: hyphens, commas, periods or middots instead.`);
  process.exit(1);
}
console.log("\nGuest copy clean: no em-dashes or en-dashes reach a share page.");
