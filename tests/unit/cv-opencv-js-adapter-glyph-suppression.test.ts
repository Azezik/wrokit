import { describe, expect, it } from 'vitest';

import {
  createOpenCvJsAdapter,
  type CvSurfaceRaster
} from '../../src/core/engines/structure/cv';

const SURFACE_W = 200;
const SURFACE_H = 200;

const fillBackground = (data: Uint8ClampedArray): void => {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
};

const paintPx = (data: Uint8ClampedArray, x: number, y: number): void => {
  if (x < 0 || y < 0 || x >= SURFACE_W || y >= SURFACE_H) {
    return;
  }
  const i = (y * SURFACE_W + x) * 4;
  data[i] = 0;
  data[i + 1] = 0;
  data[i + 2] = 0;
  data[i + 3] = 255;
};

const paintFilledRect = (
  data: Uint8ClampedArray,
  rect: { left: number; top: number; right: number; bottom: number }
): void => {
  for (let y = rect.top; y < rect.bottom; y += 1) {
    for (let x = rect.left; x < rect.right; x += 1) {
      paintPx(data, x, y);
    }
  }
};

/**
 * Hand-drawn digit "8" at 12×18 px — a stylized stroked figure-8 (two stacked
 * rounded rectangles sharing a middle bar). Width/height match the bounds of
 * a typical 18 px-tall rendered numeral. The shape is deliberately
 * outline-only with hollow bowls, giving it the bbox fill ratio that real
 * glyph contours produce on a typical page (≈0.25–0.35 of bbox).
 */
const paintEightDigit = (
  data: Uint8ClampedArray,
  originX: number,
  originY: number
): void => {
  const w = 12;
  const h = 18;
  // top bowl: rectangle outline rows 0..8
  for (let x = 1; x < w - 1; x += 1) {
    paintPx(data, originX + x, originY + 0);
    paintPx(data, originX + x, originY + 8);
  }
  for (let y = 1; y < 8; y += 1) {
    paintPx(data, originX + 1, originY + y);
    paintPx(data, originX + w - 2, originY + y);
  }
  // bottom bowl: rectangle outline rows 8..17
  for (let x = 1; x < w - 1; x += 1) {
    paintPx(data, originX + x, originY + h - 1);
  }
  for (let y = 9; y < h - 1; y += 1) {
    paintPx(data, originX + 1, originY + y);
    paintPx(data, originX + w - 2, originY + y);
  }
};

const makeRaster = (paint: (data: Uint8ClampedArray) => void): CvSurfaceRaster => {
  const data = new Uint8ClampedArray(SURFACE_W * SURFACE_H * 4);
  fillBackground(data);
  paint(data);
  return {
    surface: { pageIndex: 0, surfaceWidth: SURFACE_W, surfaceHeight: SURFACE_H },
    pixels: {
      width: SURFACE_W,
      height: SURFACE_H,
      data,
      colorSpace: 'srgb'
    } as unknown as ImageData
  };
};

describe('createOpenCvJsAdapter — glyph suppression', () => {
  it('emits exactly one object for a rectangle paired with an 18 px digit "8"', async () => {
    // A filled 120×120 panel rect on the left, and a stroked digit "8"
    // (12×18 px, ≈0.3 bbox fill ratio) on the right with a wide gap so the
    // two are distinct connected components. The fill-ratio gate (<0.55)
    // must reject the figure-8 component while the panel — presumed
    // rectangular by its size — survives, so the adapter emits ONE object.
    const adapter = createOpenCvJsAdapter();
    const raster = makeRaster((data) => {
      paintFilledRect(data, { left: 10, top: 10, right: 130, bottom: 130 });
      paintEightDigit(data, 160, 60);
    });

    const result = await adapter.detectContentRect(raster);
    expect(result.executionMode).toBe('heuristic-fallback');
    expect(result.objectsSurface).toHaveLength(1);

    const [only] = result.objectsSurface;
    // Bounding box matches the rectangle within ±1 px on each side (the
    // gradient-augmented foreground mask adds a 1-px Sobel halo around
    // sharp edges, slightly inflating the connected-component bbox).
    const { x, y, width, height } = only.bboxSurface;
    expect(Math.abs(x - 10)).toBeLessThanOrEqual(1);
    expect(Math.abs(y - 10)).toBeLessThanOrEqual(1);
    expect(Math.abs(width - 120)).toBeLessThanOrEqual(2);
    expect(Math.abs(height - 120)).toBeLessThanOrEqual(2);
  });
});
