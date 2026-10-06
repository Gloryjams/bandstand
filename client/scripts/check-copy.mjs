// Scans every BUILT bundle (app, guest, room) for em-dashes and en-dashes.
//
// The rule is for copy a person can read, so the built files are checked and not the
// source: minification removes comments (which may use any punctuation they like) and
// what is left is what can reach a screen. check-guest-copy.mjs does the same for
// the share pages alone; this one covers everything the server ships.
//
// Run after a build: node scripts/check-copy.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const STATIC = fileURLToPath(new URL("../../server/static/", import.meta.url));
const BUNDLES = process.argv.indexOf("--with-charts") >= 0 ? ["app", "guest", "room", "charts"] : ["app", "guest", "room"];
const EXTENSIONS = [".js", ".css", ".html", ".json", ".webmanifest"];
const EM = 0x2014;
const EN = 0x2013;
// Third-party code generated into the app bundle. Not our copy, never shown.
const SKIP = [/^workbox-[0-9a-f]+\.js$/, /^sw\.js$/];
// The legacy PDF.js polyfills keep this exact core-js metadata in the bundle.
// It is not displayed copy. Preserve its attribution and check all other strings.
const CORE_JS_METADATA = /copyright:(["'`])© 2013\u20132025 Denis Pushkarev \(zloirock\.ru\), 2025\u20132026 CoreJS Company \(core-js\.io\)\. All rights reserved\.\1/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (EXTENSIONS.some((e) => name.endsWith(e)) && !SKIP.some((r) => r.test(name))) out.push(path);
  }
  return out;
}

let found = 0;
let missing = 0;
let scanned = 0;

for (const bundle of BUNDLES) {
  const root = join(STATIC, bundle);
  if (!existsSync(root)) {
    console.error(`MISSING  ${bundle} bundle (run: npm run build)`);
    missing++;
    continue;
  }
  for (const path of walk(root)) {
    const text = readFileSync(path, "utf8").replace(CORE_JS_METADATA, "");
    const rel = relative(STATIC, path);
    let hits = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.codePointAt(i);
      if (c === EM || c === EN) {
        hits++;
        const near = text.slice(Math.max(0, i - 60), i + 60).replace(/\n/g, " ");
        console.error(`FOUND    ${rel}  U+${c.toString(16)}  ...${near}...`);
      }
    }
    found += hits;
    scanned++;
  }
}

if (missing > 0) process.exit(2);
if (found > 0) {
  console.error(`\n${found} em-dash or en-dash in shipped copy. Use a hyphen, comma, period, colon or middle dot.`);
  process.exit(1);
}
console.log(`Copy clean: ${scanned} built files in ${BUNDLES.join(", ")}, no em-dashes or en-dashes.`);
