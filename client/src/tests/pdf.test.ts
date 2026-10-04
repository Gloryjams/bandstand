import { beforeEach, afterEach, expect, test, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";

const pdf = vi.hoisted(() => ({ getDocument: vi.fn(), GlobalWorkerOptions: { workerSrc: "" } }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => pdf);
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/app/assets/pdf.worker.min.mjs" }));

import { analyzeContentBBox, dropDoc, loadDoc, renderPage } from "../lib/pdf";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

function documentWithPages() {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const getViewport = vi.fn(({ scale, offsetX = 0, offsetY = 0 }: { scale: number; offsetX?: number; offsetY?: number }) => (
    { width: 800 * scale, height: 1000 * scale, scale, offsetX, offsetY }
  ));
  const getPage = vi.fn().mockResolvedValue({ getViewport, render });
  const doc = { getPage } as unknown as PDFDocumentProxy;
  return { doc, getPage, getViewport, render };
}

test("loads binary data with eval disabled and uses the legacy worker", async () => {
  const doc = documentWithPages().doc;
  pdf.getDocument.mockReturnValue({ promise: Promise.resolve(doc) });
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const blob = { arrayBuffer: async () => bytes.buffer } as Blob;
  dropDoc("secure-load");
  expect(await loadDoc("secure-load", blob)).toBe(doc);
  expect(pdf.getDocument).toHaveBeenCalledWith({ data: bytes, isEvalSupported: false });
  expect(pdf.GlobalWorkerOptions.workerSrc).toBe("/app/assets/pdf.worker.min.mjs");
  expect(await loadDoc("secure-load", blob)).toBe(doc);
  expect(pdf.getDocument).toHaveBeenCalledTimes(1);
  dropDoc("secure-load");
});

test("renders base and half-turn overlay canvases with the v6 canvas API", async () => {
  const { doc, getPage, render } = documentWithPages();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  const base = document.createElement("canvas");
  const overlay = document.createElement("canvas");
  await Promise.all([
    renderPage(doc, 0, base, { width: 400, height: 500 }, 2),
    renderPage(doc, 1, overlay, { width: 400, height: 500 }, 2),
  ]);
  expect(getPage.mock.calls).toEqual([[1], [2]]);
  for (const canvas of [base, overlay]) {
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(1000);
    expect(canvas.style.width).toBe("400px");
    expect(render).toHaveBeenCalledWith({ canvas, viewport: expect.objectContaining({ scale: 1 }) });
  }
});

test("keeps crop offsets and canvas sizing at device pixel resolution", async () => {
  const { doc, render } = documentWithPages();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  const canvas = document.createElement("canvas");
  await renderPage(doc, 0, canvas, { width: 400, height: 500 }, 2,
    { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 });
  expect(canvas.width).toBe(800);
  expect(canvas.height).toBe(1000);
  expect(render).toHaveBeenCalledWith({ canvas, viewport: expect.objectContaining({ scale: 2, offsetX: -400, offsetY: -500 }) });
});

test("auto-crop scans a v6 render and caches only completed analysis", async () => {
  const { doc, render } = documentWithPages();
  const context = { fillRect: vi.fn(), getImageData: vi.fn() };
  const pixels = new Uint8ClampedArray(150 * 188 * 4).fill(255);
  for (let y = 60; y < 120; y++) {
    for (let x = 40; x < 110; x++) {
      const i = (y * 150 + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
    }
  }
  context.getImageData.mockReturnValue({ data: pixels });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  render.mockImplementationOnce(() => ({ promise: Promise.reject(new Error("transient")), cancel: vi.fn() }));
  expect(await analyzeContentBBox(doc, 0, "retry-crop")).toBeNull();
  const box = await analyzeContentBBox(doc, 0, "retry-crop");
  expect(box?.x0).toBeCloseTo(40 / 150 - 0.02);
  expect(box?.y0).toBeCloseTo(60 / 188 - 0.02);
  expect(await analyzeContentBBox(doc, 0, "retry-crop")).toBe(box);
  expect(render).toHaveBeenCalledTimes(2);
  expect(render).toHaveBeenLastCalledWith({ canvas: expect.any(HTMLCanvasElement), viewport: expect.objectContaining({ scale: 150 / 800 }) });
});
