import { describe, expect, it } from 'vitest';

import { detectFillBoundedRects } from '../../src/core/engines/structure/cv/fill-bounded-rect-detector';

const makePixels = (width: number, height: number, fill: (x: number, y: number) => number): ImageData => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const v = fill(x, y);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width, height, data, colorSpace: 'srgb' } as unknown as ImageData;
};

describe('detectFillBoundedRects', () => {
  it('finds a stroke-less card defined only by a small luminance fill step', () => {
    // 200x200 page at lum=255, with a 100x80 card at lum=246 from (50, 60)
    // to (150, 140). Δ = 9 luminance units — well below Canny / adaptive
    // threshold sensitivity, but in the mid-fill band of this detector.
    const pixels = makePixels(200, 200, (x, y) => {
      const inCard = x >= 50 && x < 150 && y >= 60 && y < 140;
      return inCard ? 246 : 255;
    });

    const rects = detectFillBoundedRects(pixels, {
      surfaceWidth: 200,
      surfaceHeight: 200,
      pageBackgroundLuminance: 255
    });

    expect(rects.length).toBeGreaterThan(0);
    const card = rects.find(
      (r) =>
        Math.abs(r.left - 50) <= 2 &&
        Math.abs(r.top - 60) <= 2 &&
        Math.abs(r.right - 150) <= 2 &&
        Math.abs(r.bottom - 140) <= 2
    );
    expect(card).toBeDefined();
  });

  it('keeps the card rect intact when text glyphs sit inside it (high-contrast holes)', () => {
    // Card at lum=246, with a horizontal text band at lum=20 cutting across
    // the middle. Text pixels are classified as "high-contrast" and excluded
    // from the connected component pass; the card fill flows around them.
    const pixels = makePixels(200, 200, (x, y) => {
      const inCard = x >= 50 && x < 150 && y >= 60 && y < 140;
      const inText = inCard && y >= 95 && y < 105 && x >= 60 && x < 140;
      if (inText) return 20;
      if (inCard) return 246;
      return 255;
    });

    const rects = detectFillBoundedRects(pixels, {
      surfaceWidth: 200,
      surfaceHeight: 200,
      pageBackgroundLuminance: 255
    });

    const card = rects.find(
      (r) =>
        Math.abs(r.left - 50) <= 2 &&
        Math.abs(r.top - 60) <= 2 &&
        Math.abs(r.right - 150) <= 2 &&
        Math.abs(r.bottom - 140) <= 2
    );
    expect(card).toBeDefined();
  });

  it('returns no rects on a uniform page (no fill components exist)', () => {
    const pixels = makePixels(200, 200, () => 255);
    const rects = detectFillBoundedRects(pixels, {
      surfaceWidth: 200,
      surfaceHeight: 200,
      pageBackgroundLuminance: 255
    });
    expect(rects).toEqual([]);
  });

  it('keeps distinct fill surfaces separated even when 4-connected through a narrow strip', () => {
    // Two adjacent panels, both faintly off-white (Δ = 9 and Δ = 5 from the
    // page background), separated by a 3-px gap that itself sits in the
    // page-bg band. With the previous single-band approach both panels'
    // mid-fill pixels lived in the same class and 4-connectivity through
    // the narrow strip would have fused them into one component. With
    // histogram-peak quantization their luminances land in different peak
    // bins (246 vs 250), each peak forms its own component, and the two
    // panels remain distinct rectangles.
    const w = 300;
    const h = 200;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
    const paint = (x0: number, x1: number, y0: number, y1: number, lum: number) => {
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * w + x) * 4;
          data[i] = lum;
          data[i + 1] = lum;
          data[i + 2] = lum;
        }
      }
    };
    paint(20, 130, 30, 170, 246); // left panel (Δ = 9)
    paint(170, 280, 30, 170, 250); // right panel (Δ = 5), 40 px gap (page bg)
    const pixels = { width: w, height: h, data, colorSpace: 'srgb' } as unknown as ImageData;

    const rects = detectFillBoundedRects(pixels, {
      surfaceWidth: w,
      surfaceHeight: h,
      pageBackgroundLuminance: 255
    });

    const matches = (
      r: { left: number; top: number; right: number; bottom: number },
      [l, t, rt, bt]: number[]
    ) =>
      Math.abs(r.left - l) <= 2 &&
      Math.abs(r.top - t) <= 2 &&
      Math.abs(r.right - rt) <= 2 &&
      Math.abs(r.bottom - bt) <= 2;

    expect(rects.some((r) => matches(r, [20, 30, 130, 170]))).toBe(true);
    expect(rects.some((r) => matches(r, [170, 30, 280, 170]))).toBe(true);
    // Crucially, no single rect spans BOTH panels (which is what the old
    // single-band fusion would have produced).
    expect(
      rects.some(
        (r) => r.left <= 22 && r.right >= 278 && r.top <= 32 && r.bottom >= 168
      )
    ).toBe(false);
  });

  it('rejects sliver / non-rectangular components', () => {
    // An "L" shape made of mid-fill pixels: low rectangularity, must be
    // dropped because (component pixels / bbox area) falls below the floor.
    const pixels = makePixels(200, 200, (x, y) => {
      const inVertical = x >= 50 && x < 70 && y >= 50 && y < 150;
      const inHorizontal = y >= 130 && y < 150 && x >= 50 && x < 150;
      if (inVertical || inHorizontal) return 246;
      return 255;
    });

    const rects = detectFillBoundedRects(pixels, {
      surfaceWidth: 200,
      surfaceHeight: 200,
      pageBackgroundLuminance: 255,
      minRectangularity: 0.6
    });

    expect(rects).toEqual([]);
  });
});
