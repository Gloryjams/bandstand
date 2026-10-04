import { describe, expect, it } from "vitest";
import { contentBBox, cropRenderParams, croppedToPage, cropViewBox, pageToCropped } from "./autocrop";

/** White RGBA page with optional dark rectangles [x, y, w, h]. */
function page(width: number, height: number, rects: Array<[number, number, number, number]> = []): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [rx, ry, rw, rh] of rects) {
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        const i = (y * width + x) * 4;
        px[i] = 20; px[i + 1] = 20; px[i + 2] = 20; px[i + 3] = 255;
      }
    }
  }
  return px;
}

describe("contentBBox", () => {
  it("finds a centered block with padding", () => {
    const box = contentBBox(page(100, 100, [[30, 40, 40, 20]]), 100, 100)!;
    expect(box).not.toBeNull();
    expect(box.x0).toBeCloseTo(0.28, 2); // 0.30 - 0.02 pad
    expect(box.y0).toBeCloseTo(0.38, 2);
    expect(box.x1).toBeCloseTo(0.72, 2); // 0.70 + 0.02 pad
    expect(box.y1).toBeCloseTo(0.62, 2);
  });

  it("returns null for a blank page", () => {
    expect(contentBBox(page(80, 80), 80, 80)).toBeNull();
  });

  it("ignores dust specks (single dark pixels) and tiny content", () => {
    // one isolated pixel: below minRunPx in every row/col
    expect(contentBBox(page(100, 100, [[50, 50, 1, 1]]), 100, 100)).toBeNull();
    // a 2x2 dot passes the run filter but is < 1% area
    expect(contentBBox(page(100, 100, [[50, 50, 2, 2]]), 100, 100)).toBeNull();
  });

  it("returns null when margins are already too thin to matter", () => {
    expect(contentBBox(page(100, 100, [[1, 1, 98, 98]]), 100, 100)).toBeNull();
  });

  it("clamps padding at the page edges", () => {
    const box = contentBBox(page(100, 100, [[0, 0, 60, 60]]), 100, 100)!;
    expect(box.x0).toBe(0);
    expect(box.y0).toBe(0);
  });

  it("rejects malformed buffers", () => {
    expect(contentBBox(new Uint8ClampedArray(8), 100, 100)).toBeNull();
    expect(contentBBox(page(10, 10), 0, 10)).toBeNull();
  });
});

describe("coordinate mapping", () => {
  const box = { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9 };

  it("round-trips cropped <-> page coords", () => {
    const [px, py] = croppedToPage(box, 0.5, 0.5);
    expect(px).toBeCloseTo(0.5);
    expect(py).toBeCloseTo(0.5);
    const [cx, cy] = pageToCropped(box, px, py);
    expect(cx).toBeCloseTo(0.5);
    expect(cy).toBeCloseTo(0.5);
    // corners
    expect(croppedToPage(box, 0, 0)).toEqual([0.2, 0.1]);
    expect(croppedToPage(box, 1, 1)).toEqual([0.8, 0.9]);
  });

  it("viewBox reframes the full-page coordinate system", () => {
    expect(cropViewBox(box, 1000, 500)).toBe("200 50 600 400");
  });
});

describe("cropRenderParams", () => {
  it("fits the crop into the container and shifts the origin", () => {
    const box = { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 };
    const p = cropRenderParams(box, { width: 800, height: 1000 }, { width: 400, height: 500 });
    expect(p.scale).toBeCloseTo(1); // crop is 400x500, exactly the container
    expect(p.offsetX).toBeCloseTo(-200);
    expect(p.offsetY).toBeCloseTo(-250);
    expect(p.cssW).toBeCloseTo(400);
    expect(p.cssH).toBeCloseTo(500);
  });
});
