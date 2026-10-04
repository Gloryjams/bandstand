import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

import { contentBBox, cropRenderParams, type BBoxFrac } from "./autocrop";
import { fitScale, type Size } from "./fit";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type Doc = pdfjsLib.PDFDocumentProxy;

const docCache = new Map<string, Promise<Doc>>();
const inflight = new WeakMap<HTMLCanvasElement, { cancel(): void }>();

/**
 * Load a PDF document, cached by content_hash so re-opens are instant but a
 * chart edited on disk (new hash) re-parses instead of serving the stale doc.
 */
export function loadDoc(contentHash: string, blob: Blob): Promise<Doc> {
  let p = docCache.get(contentHash);
  if (!p) {
    p = blob
      .arrayBuffer()
      .then((buf) => pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise);
    docCache.set(contentHash, p);
  }
  return p;
}

/** Forget a cached document (used by re-sync / corrupt-file recovery). */
export function dropDoc(contentHash: string): void {
  docCache.delete(contentHash);
}

/**
 * Render a 0-based page into the canvas, fit to the container at devicePixelRatio.
 * Cancels any in-flight render on the same canvas first so rapid page turns don't race.
 */
export async function renderPage(
  doc: Doc,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  container: Size,
  dpr: number = window.devicePixelRatio || 1,
  crop: BBoxFrac | null = null,
): Promise<void> {
  inflight.get(canvas)?.cancel();

  const page = await doc.getPage(pageIndex + 1); // pdfjs pages are 1-based
  const base = page.getViewport({ scale: 1 });
  let viewport: pdfjsLib.PageViewport;
  let cssW: number, cssH: number;
  if (crop) {
    // Auto-crop: scale so the content box fills the container, offsets pull the
    // crop origin to the canvas origin (cropRenderParams is CSS px; × dpr here).
    const p = cropRenderParams(crop, { width: base.width, height: base.height }, container);
    viewport = page.getViewport({ scale: p.scale * dpr, offsetX: p.offsetX * dpr, offsetY: p.offsetY * dpr });
    cssW = p.cssW; cssH = p.cssH;
  } else {
    const scale = fitScale({ width: base.width, height: base.height }, container);
    viewport = page.getViewport({ scale: scale * dpr });
    cssW = viewport.width / dpr; cssH = viewport.height / dpr;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.width = `${Math.floor(cssW)}px`;
  canvas.style.height = `${Math.floor(cssH)}px`;

  const task = page.render({ canvasContext: ctx, viewport, canvas });
  inflight.set(canvas, task);
  try {
    await task.promise;
  } catch (e) {
    // Expected when a newer turn cancels this render; not an error.
    if ((e as { name?: string })?.name === "RenderingCancelledException") return;
    throw e;
  } finally {
    if (inflight.get(canvas) === task) inflight.delete(canvas);
  }
}

// Auto-crop analysis: render the page tiny (150px wide) offscreen and scan for
// the content box. Cached per content_hash:page — a chart edited on disk gets a
// new hash and re-analyzes; the cache never goes stale.
const bboxCache = new Map<string, BBoxFrac | null>();

export async function analyzeContentBBox(
  doc: Doc,
  pageIndex: number,
  cacheKey: string,
): Promise<BBoxFrac | null> {
  const hit = bboxCache.get(cacheKey);
  if (hit !== undefined) return hit;
  try {
    const page = await doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 150 / base.width });
    const c = document.createElement("canvas");
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null; // transient environment problem — do NOT cache
    // white underlay: vector PDFs can have transparent backgrounds
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const box = contentBBox(data.data, c.width, c.height);
    // Cache only a COMPLETED analysis (null here legitimately means blank/tight
    // page). Exceptions below return uncached so a transient render failure
    // doesn't permanently disable cropping for this page.
    bboxCache.set(cacheKey, box);
    return box;
  } catch {
    return null;
  }
}
