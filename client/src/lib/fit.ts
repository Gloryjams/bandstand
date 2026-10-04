// Pure fit-to-viewport math, kept free of pdfjs so it is unit-testable.

export interface Size {
  width: number;
  height: number;
}

/** Scale so the page fits entirely within the container (contain). */
export function fitScale(page: Size, container: Size): number {
  if (page.width <= 0 || page.height <= 0) return 1;
  return Math.min(container.width / page.width, container.height / page.height);
}
