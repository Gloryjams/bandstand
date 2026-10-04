// Artwork: not covered by the AGPL. See NOTICE.
// Run from any directory: CANDIDATES=/absolute/scratch/path node client/scripts/make-icons.mjs
// Uses existing client dependencies and resvg (RESVG overrides the executable).
// SVG sources and previews go to CANDIDATES; the CHOSEN design also updates public/.
// Design B, Bones on solid pink, chosen 2026-10-03.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { JSDOM } from "jsdom";

const CLIENT = fileURLToPath(new URL("../", import.meta.url));
const REPO = resolve(CLIENT, "..");
const OUTPUT = process.env.CANDIDATES;
if (!OUTPUT || !isAbsolute(OUTPUT)) throw new Error("Set CANDIDATES to an absolute scratch directory outside the repo.");
const rel = relative(REPO, resolve(OUTPUT));
if (rel === "" || (!rel.startsWith("../") && !isAbsolute(rel))) {
  throw new Error("CANDIDATES must be outside the repo.");
}
const RESVG = process.env.RESVG || (process.platform === "darwin" ? "/opt/homebrew/bin/resvg" : "resvg");
const PUBLIC = join(CLIENT, "public");
mkdirSync(OUTPUT, { recursive: true });

// Read the app's actual tokens, including the Bones fills normally supplied by CSS.
const styles = readFileSync(join(CLIENT, "src/styles.css"), "utf8");
const light = styles.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
const dark = styles.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)[1];
const token = (block, name) => {
  const value = block.match(new RegExp(`--${name}:\\s*(#[\\da-f]+)`, "i"))?.[1];
  if (!value) throw new Error(`Missing color token: ${name}`);
  return value;
};
const cream = token(light, "bg");
const ink = token(light, "text");
const fur = token(light, "surface-2");
const accent = token(light, "accent");
const pink = light.match(/--pop:[^;]*(#[\da-f]+)/i)[1];

// Transpile the existing TSX in memory. No generated modules or new dependencies.
function renderComponent(name, props) {
  const filename = join(CLIENT, `src/components/${name}.tsx`);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const exports = {};
  new Function("require", "exports", outputText)(createRequire(filename), exports);
  const markup = renderToStaticMarkup(createElement(exports[name], props));
  return new JSDOM(markup, { contentType: "image/svg+xml" }).window.document.documentElement;
}

function bonesHead() {
  const svg = renderComponent("Bones", { mood: "ready" });
  const children = [...svg.children];
  // In the rendered Bones SVG, the ears through whiskers form the head.
  // Assert the landmarks so a future art change cannot silently select a body.
  if (children[6]?.tagName !== "ellipse" || children[13]?.getAttribute("class") !== "bones-accent") {
    throw new Error("Bones layout changed; review the head crop.");
  }
  children.forEach((node, i) => { if (i < 2 || i >= 13) node.remove(); });
  svg.querySelectorAll(".fur").forEach((node) => node.setAttribute("fill", fur));
  svg.querySelectorAll(".bones-accent").forEach((node) => node.setAttribute("fill", accent));
  // Preserve every art path; increase only the exported outline for small icons.
  svg.setAttribute("stroke-width", "3.6");
  svg.setAttribute("color", ink);
  return `<g fill="none" stroke="${ink}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" color="${ink}">${svg.innerHTML}</g>`;
}

function bonitoHead() {
  const svg = renderComponent("Bonito", { expression: "happy", outfit: "conductor", bob: false });
  const head = svg.lastElementChild;
  if (head.tagName !== "g" || !svg.querySelector("#bnt-fur")) throw new Error("Bonito layout changed; review the head crop.");
  // Remove the tiny hat lettering from this icon export, never from the source art.
  head.querySelectorAll("text").forEach((node) => node.remove());
  const children = [...head.children];
  // Outline copies use the same ear/face paths and sit behind the original art.
  const outlines = [0, 2, 4].map((i) => {
    const path = children[i].cloneNode(true);
    path.setAttribute("stroke", "#2D1B00");
    path.setAttribute("stroke-width", "3");
    path.setAttribute("stroke-linejoin", "round");
    return path.outerHTML;
  }).join("");
  return `${svg.querySelector("defs").outerHTML}<g>${outlines}${head.innerHTML}</g>`;
}

const bones = bonesHead();
const bonito = bonitoHead();
const designs = [
  { id: "a-bones-cream", label: "A / Bones + pop ring", background: cream, head: bones, crop: [23, 7, 74, 82], ring: true },
  { id: "b-bones-pink", label: "B / Bones + pink", background: pink, head: bones, crop: [23, 7, 74, 82] },
  { id: "c-bonito-cream", label: "C / Bonito + cream", background: cream, head: bonito, crop: [5, -2, 88, 73] },
];

const documentSvg = (body, width = 512, height = width) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>\n`;

function iconSvg(design, maskable = false) {
  const [x, y, w, h] = design.crop;
  // Fit the entire head bounding rectangle inside the 80% diameter safe circle.
  // The ring and its hard offset shadow fit there too (outer radius < 204.8).
  const scale = maskable ? 380 / Math.hypot(w, h) : 388 / Math.max(w, h);
  const tx = 256 - (x + w / 2) * scale;
  const ty = (design.ring ? 249 : 256) - (y + h / 2) * scale;
  const radius = maskable ? 182 : 218;
  const ring = design.ring ?
    `<circle cx="266" cy="266" r="${radius}" fill="${pink}"/>
     <circle cx="248" cy="248" r="${radius}" fill="${cream}" stroke="${pink}" stroke-width="12"/>` : "";
  return documentSvg(`<rect width="512" height="512" fill="${design.background}"/>${ring}<g transform="translate(${tx} ${ty}) scale(${scale})">${design.head}</g>`);
}

function rasterize(svgPath, pngPath, width) {
  execFileSync(RESVG, [svgPath, pngPath, "-w", String(width)], { stdio: "pipe" });
}

for (const design of designs) {
  const dir = join(OUTPUT, design.id);
  mkdirSync(dir, { recursive: true });
  const svg = join(dir, "icon.svg");
  writeFileSync(svg, iconSvg(design));
  for (const size of [512, 192, 180, 48]) rasterize(svg, join(dir, `icon-${size}.png`), size);
  const mask = join(dir, "maskable.svg");
  writeFileSync(mask, iconSvg(design, true));
  rasterize(mask, join(dir, "maskable-512.png"), 512);
}

// A single sheet, three columns, with true pixel sizes on both theme backgrounds.
// Embed the rendered PNGs so the sheet reviews exactly what devices receive.
const sheetWidth = 1728;
const panelHeight = 980;
let sheet = "";
for (const [panel, background] of [cream, token(dark, "bg")].entries()) {
  const top = panel * panelHeight;
  const textColor = panel ? token(dark, "text") : ink;
  sheet += `<rect y="${top}" width="${sheetWidth}" height="${panelHeight}" fill="${background}"/>`;
  for (const [col, design] of designs.entries()) {
    const left = col * 568 + 40;
    sheet += `<text x="${left}" y="${top + 42}" font-family="sans-serif" font-size="22" fill="${textColor}">${design.label} / ${panel ? "dark" : "light"}</text>`;
    for (const [size, row] of [[512, 70], [180, 634], [48, 870]]) {
      const png = readFileSync(join(OUTPUT, design.id, `icon-${size}.png`)).toString("base64");
      sheet += `<text x="${left}" y="${top + row - 9}" font-family="sans-serif" font-size="14" fill="${textColor}">${size} px</text>`;
      sheet += `<image x="${left}" y="${top + row}" width="${size}" height="${size}" xlink:href="data:image/png;base64,${png}"/>`;
    }
  }
}
const sheetSvg = join(OUTPUT, "contact-sheet.svg");
writeFileSync(sheetSvg, documentSvg(sheet, sheetWidth, panelHeight * 2));
rasterize(sheetSvg, join(OUTPUT, "contact-sheet.png"), sheetWidth);

mkdirSync(join(PUBLIC, "icons"), { recursive: true });
const CHOSEN = "b-bones-pink";
if (!designs.some((d) => d.id === CHOSEN)) throw new Error(`No design named ${CHOSEN}`);
const chosen = join(OUTPUT, CHOSEN);
for (const file of ["icon-192.png", "icon-512.png", "maskable-512.png"]) {
  copyFileSync(join(chosen, file), join(PUBLIC, "icons", file));
}
copyFileSync(join(chosen, "icon-180.png"), join(PUBLIC, "apple-touch-icon.png"));
copyFileSync(join(chosen, "icon.svg"), join(PUBLIC, "favicon.svg"));
console.log(`Candidates and contact-sheet.png: ${OUTPUT}`);
console.log(`Default icons: ${PUBLIC}`);
