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
