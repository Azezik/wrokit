import { describe, expect, it } from 'vitest';

import { detectAlignmentCells } from '../../src/core/engines/structure/cv/alignment-cell-detector';

const buildMask = (
  width: number,
  height: number,
  paint: (x: number, y: number) => boolean
): Uint8Array => {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      mask[y * width + x] = paint(x, y) ? 1 : 0;
    }
  }
  return mask;
};

describe('detectAlignmentCells', () => {
  it('splits a 2x2 label/value grid by its column gutter and row gutter', () => {
    // 200x200 surface; the region of interest is a 160x120 card at (20, 20).
    // Inside it, 2 column bands separated by a 16px-wide whitespace gutter,
    // and 2 row bands separated by a 16px-tall whitespace gutter.
    const w = 200;
    const h = 200;
    const region = { left: 20, top: 20, right: 180, bottom: 140 };
    const mask = buildMask(w, h, (x, y) => {
      // Column 1: x in [30, 90), column 2: x in [110, 170). Gutter at 90..110.
      // Row 1: y in [30, 70), row 2: y in [86, 130). Gutter at 70..86.
      const inCol = (x >= 30 && x < 90) || (x >= 110 && x < 170);
      const inRow = (y >= 30 && y < 70) || (y >= 86 && y < 130);
      return inCol && inRow;
    });

    const cells = detectAlignmentCells(mask, {
      region,
      surfaceWidth: w,
      surfaceHeight: h
    });

    // 2 columns × 2 rows = 4 cells.
    expect(cells.length).toBe(4);
    // The 4 cells together must cover all 4 quadrants.
    const has = (
      left: number,
      top: number,
      right: number,
      bottom: number
    ): boolean =>
      cells.some(
        (c) =>
          Math.abs(c.left - left) <= 2 &&
          Math.abs(c.top - top) <= 2 &&
          Math.abs(c.right - right) <= 2 &&
          Math.abs(c.bottom - bottom) <= 2
      );
    expect(has(30, 30, 90, 70)).toBe(true);
    expect(has(110, 30, 170, 70)).toBe(true);
    expect(has(30, 86, 90, 130)).toBe(true);
    expect(has(110, 86, 170, 130)).toBe(true);
  });

  it('returns no cells when the region is empty', () => {
    const w = 100;
    const h = 100;
    const region = { left: 10, top: 10, right: 90, bottom: 90 };
    const mask = buildMask(w, h, () => false);

    const cells = detectAlignmentCells(mask, {
      region,
      surfaceWidth: w,
      surfaceHeight: h
    });

    expect(cells).toEqual([]);
  });

  it('treats whitespace narrower than the min gutter as a single band', () => {
    // Two 30-px text bands separated by a 3-px whitespace stripe. The
    // default min-gutter (~2% of 100px region = 2px) makes 3px qualify, so
    // we should see two row bands. With min-gutter explicitly set to 6,
    // the 3px gap is below the floor and the two bands fuse into one.
    const w = 120;
    const h = 120;
    const region = { left: 10, top: 10, right: 110, bottom: 110 };
    const mask = buildMask(w, h, (x, y) => {
      if (x < 20 || x >= 100) return false;
      if (y >= 20 && y < 50) return true; // band 1
      if (y >= 53 && y < 90) return true; // band 2 (3-px gap)
      return false;
    });

    const fused = detectAlignmentCells(mask, {
      region,
      surfaceWidth: w,
      surfaceHeight: h,
      minGutterPx: 6
    });
    // Single row band, single column band → 1 cell.
    expect(fused.length).toBe(1);
  });
});
