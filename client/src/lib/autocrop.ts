// Auto-crop margins (forScore steal-next): find the content bounding box of a
// rendered page so the viewer can zoom the music past its scanned margins.
// Pure pixel math — rendering/wiring lives in pdf.ts and the Viewer.
//
// Contract: bbox is in PAGE FRACTIONS (0..1), so it survives any render scale
// and maps cleanly onto both the pdf.js viewport (render crop) and the
// AnnotationLayer viewBox (ink stays full-page-normalized on disk).

export interface BBoxFrac {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Device-local setting (Settings toggle, same contract as half-page turns:
// takes effect the next time a chart opens).
const LS_KEY = "autocrop_margins";
export function loadAutocrop(): boolean {
  try { return localStorage.getItem(LS_KEY) === "1"; } catch { return false; }
}
export function saveAutocrop(on: boolean): void {
  try { localStorage.setItem(LS_KEY, on ? "1" : "0"); } catch { /* private mode */ }
}

interface CropOpts {
  /** Luminance above this counts as background. Scans tolerate off-white paper. */
  whiteThreshold?: number;
  /** A row/col needs at least this many ink pixels to count — kills dust specks. */
  minRunPx?: number;
  /** Breathing room added around the detected box, as a fraction of the page. */
  paddingFrac?: number;
}

const DEFAULTS: Required<CropOpts> = { whiteThreshold: 245, minRunPx: 2, paddingFrac: 0.02 };

/**
 * Content bounding box of an RGBA buffer, or null when cropping is pointless:
 * blank page, content too small to be real (< 1% area — a speck or stamp), or
 * margins already too thin to be worth reframing (< 3% gain on both axes).
 */
export function contentBBox(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  opts: CropOpts = {},
): BBoxFrac | null {
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4) return null;
  const { whiteThreshold, minRunPx, paddingFrac } = { ...DEFAULTS, ...opts };

  const rowInk = new Uint32Array(height);
  const colInk = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowOff + x * 4;
      const a = pixels[i + 3]!;
      if (a < 32) continue; // transparent = background
      // integer luminance approximation (BT.601)
      const lum = (pixels[i]! * 299 + pixels[i + 1]! * 587 + pixels[i + 2]! * 114) / 1000;
      if (lum < whiteThreshold) {
        rowInk[y]!++;
        colInk[x]!++;
      }
    }
  }

  let top = 0, bottom = height - 1, left = 0, right = width - 1;
  while (top < height && rowInk[top]! < minRunPx) top++;
  while (bottom > top && rowInk[bottom]! < minRunPx) bottom--;
  while (left < width && colInk[left]! < minRunPx) left++;
  while (right > left && colInk[right]! < minRunPx) right--;
  if (top >= bottom || left >= right) return null; // blank page

  const w = (right - left + 1) / width;
  const h = (bottom - top + 1) / height;
  if (w * h < 0.01) return null; // a speck is not content

  const box: BBoxFrac = {
    x0: Math.max(0, left / width - paddingFrac),
    y0: Math.max(0, top / height - paddingFrac),
    x1: Math.min(1, (right + 1) / width + paddingFrac),
    y1: Math.min(1, (bottom + 1) / height + paddingFrac),
  };

  // Already tight? Reframing for < 3% on BOTH axes just makes pages jiggle.
  if (box.x1 - box.x0 > 0.97 && box.y1 - box.y0 > 0.97) return null;
  return box;
}

/**
 * SVG viewBox string that shows only the crop of a full-page coordinate system.
 * The AnnotationLayer keeps drawing in full-page pixels; this reframes it.
 */
export function cropViewBox(box: BBoxFrac, pageW: number, pageH: number): string {
  const r = (v: number) => Math.round(v * 100) / 100; // svg needs no fp dust
  return `${r(box.x0 * pageW)} ${r(box.y0 * pageH)} ${r((box.x1 - box.x0) * pageW)} ${r((box.y1 - box.y0) * pageH)}`;
}

/**
 * Map a pointer position normalized to the CROPPED canvas back to full-page
 * normalized coords (the on-disk annotation contract), and the inverse for
 * displaying full-page coords inside a cropped frame.
 */
export function croppedToPage(box: BBoxFrac, nx: number, ny: number): [number, number] {
  return [box.x0 + nx * (box.x1 - box.x0), box.y0 + ny * (box.y1 - box.y0)];
}
export function pageToCropped(box: BBoxFrac, nx: number, ny: number): [number, number] {
  return [(nx - box.x0) / (box.x1 - box.x0), (ny - box.y0) / (box.y1 - box.y0)];
}

/**
 * pdf.js render parameters for a cropped page fitted into a container:
 * scale chosen so the crop fills the box, offsets shift the crop's origin to
 * the canvas origin. All in CSS pixels — multiply by dpr at the call site.
 */
export function cropRenderParams(
  box: BBoxFrac,
  page: { width: number; height: number },
  container: { width: number; height: number },
): { scale: number; offsetX: number; offsetY: number; cssW: number; cssH: number } {
  const cropW = (box.x1 - box.x0) * page.width;
  const cropH = (box.y1 - box.y0) * page.height;
  const scale = Math.min(container.width / cropW, container.height / cropH);
  return {
    scale,
    offsetX: -box.x0 * page.width * scale,
    offsetY: -box.y0 * page.height * scale,
    cssW: cropW * scale,
    cssH: cropH * scale,
  };
}
