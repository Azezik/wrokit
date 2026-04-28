import { describe, expect, it } from 'vitest';

import {
  buildLineBoundedRects,
  detectLineSegments,
  lineBoundedRectsToObjects,
  lineSegmentsToObjects,
  type SizeRelativeThresholds
} from '../../src/core/engines/structure/cv/line-grid-detector';

const fillBackground = (data: Uint8ClampedArray) => {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
};

const paintRect = (
  data: Uint8ClampedArray,
  width: number,
  rect: { left: number; top: number; right: number; bottom: number }
) => {
  for (let y = rect.top; y < rect.bottom; y += 1) {
    for (let x = rect.left; x < rect.right; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
};

const makeImageData = (
  width: number,
  height: number,
  paint: (data: Uint8ClampedArray) => void
): ImageData => {
  const data = new Uint8ClampedArray(width * height * 4);
  fillBackground(data);
  paint(data);
  return { width, height, data, colorSpace: 'srgb' } as unknown as ImageData;
};

const baselineThresholds = (width: number, height: number): SizeRelativeThresholds => {
  const minSide = Math.max(1, Math.min(width, height));
  return {
    minObjectAreaPx: 36,
    minLineLengthPx: Math.max(24, Math.round(minSide * 0.04)),
    maxLineThicknessPx: Math.max(6, Math.round(minSide * 0.01))
  };
};

describe('detectLineSegments', () => {
  it('extracts horizontal and vertical line segments with their actual extents', () => {
    const w = 200;
    const h = 200;
    const pixels = makeImageData(w, h, (data) => {
      // top horizontal
      paintRect(data, w, { left: 20, top: 30, right: 180, bottom: 32 });
      // bottom horizontal
      paintRect(data, w, { left: 20, top: 170, right: 180, bottom: 172 });
      // left vertical
      paintRect(data, w, { left: 20, top: 30, right: 22, bottom: 172 });
      // right vertical
      paintRect(data, w, { left: 178, top: 30, right: 180, bottom: 172 });
      // partial inner horizontal — half-width
      paintRect(data, w, { left: 20, top: 100, right: 100, bottom: 102 });
      // partial inner vertical
      paintRect(data, w, { left: 100, top: 30, right: 102, bottom: 172 });
    });

    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    expect(segments.horizontals.length).toBeGreaterThanOrEqual(3);
    expect(segments.verticals.length).toBeGreaterThanOrEqual(3);

    // The leftmost vertical is at axis x=20..21 → axisPos around 20.
    expect(segments.verticals.some((line) => Math.abs(line.axisPos - 20) <= 1)).toBe(true);
    expect(segments.verticals.some((line) => Math.abs(line.axisPos - 178) <= 1)).toBe(true);
    expect(segments.verticals.some((line) => Math.abs(line.axisPos - 100) <= 1)).toBe(true);

    // Inner horizontal only spans left half (x=20..100). It must be detected
    // with its actual extent, NOT extended to the full page width.
    const innerH = segments.horizontals.find((line) => Math.abs(line.axisPos - 100) <= 1);
    expect(innerH).toBeDefined();
    expect(innerH!.start).toBeLessThanOrEqual(22);
    expect(innerH!.end).toBeLessThanOrEqual(110);
  });

  it('does not emit lines for word-shaped short runs', () => {
    const w = 600;
    const h = 600;
    const pixels = makeImageData(w, h, (data) => {
      // Six small "glyph" rectangles in a row — none reach the min line length.
      for (let i = 0; i < 6; i += 1) {
        paintRect(data, w, { left: 100 + i * 10, top: 200, right: 105 + i * 10, bottom: 210 });
      }
    });
    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    expect(segments.horizontals).toEqual([]);
    expect(segments.verticals).toEqual([]);
  });
});

describe('buildLineBoundedRects', () => {
  it('reconstructs every nested cell of a 2x2 grid plus the outer border', () => {
    // 4-cell grid: 3 horizontals × 3 verticals → outer + 4 cells + 2 row-spans + 2 col-spans = 9
    const w = 240;
    const h = 240;
    const pixels = makeImageData(w, h, (data) => {
      // Horizontals at y=20, y=120, y=220 (each spans x=20..220)
      for (const y of [20, 120, 220]) {
        paintRect(data, w, { left: 20, top: y, right: 221, bottom: y + 2 });
      }
      // Verticals at x=20, x=120, x=220 (each spans y=20..220)
      for (const x of [20, 120, 220]) {
        paintRect(data, w, { left: x, top: 20, right: x + 2, bottom: 221 });
      }
    });

    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    const rects = buildLineBoundedRects(segments, { surfaceWidth: w, surfaceHeight: h });

    // Must include the four leaf cells. Tolerate ±2 px slop.
    const cellMatches = (rect: { left: number; top: number; right: number; bottom: number }, [l, t, r, b]: number[]) =>
      Math.abs(rect.left - l) <= 2 &&
      Math.abs(rect.top - t) <= 2 &&
      Math.abs(rect.right - r) <= 2 &&
      Math.abs(rect.bottom - b) <= 2;

    const expectedCells = [
      [20, 20, 120, 120], // top-left cell
      [120, 20, 220, 120], // top-right cell
      [20, 120, 120, 220], // bottom-left cell
      [120, 120, 220, 220], // bottom-right cell
      [20, 20, 220, 220] // outer border
    ];
    for (const expected of expectedCells) {
      expect(rects.some((rect) => cellMatches(rect, expected))).toBe(true);
    }

    // Each rect must be unique (deduplication invariant).
    const keys = rects.map((r) => `${r.left},${r.top},${r.right},${r.bottom}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('returns no rects when fewer than 2 lines per axis are detected', () => {
    const w = 80;
    const h = 80;
    const pixels = makeImageData(w, h, (data) => {
      paintRect(data, w, { left: 5, top: 40, right: 75, bottom: 41 });
    });
    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    expect(buildLineBoundedRects(segments, { surfaceWidth: w, surfaceHeight: h })).toEqual([]);
  });
});

describe('lineSegmentsToObjects + lineBoundedRectsToObjects', () => {
  it('emits stable structural object types with non-empty bounding boxes', () => {
    const segments = {
      horizontals: [{ axisPos: 10, thickness: 2, start: 0, end: 100 }],
      verticals: [{ axisPos: 50, thickness: 1, start: 0, end: 100 }]
    };
    const objects = lineSegmentsToObjects(segments, 'obj');
    expect(objects).toHaveLength(2);
    expect(objects[0].type).toBe('line-horizontal');
    expect(objects[0].bboxSurface.width).toBe(100);
    expect(objects[1].type).toBe('line-vertical');
    expect(objects[1].bboxSurface.height).toBe(100);

    const cells = lineBoundedRectsToObjects(
      [{ left: 10, top: 20, right: 30, bottom: 40 }],
      { idPrefix: 'obj', surfaceWidth: 100, surfaceHeight: 100 }
    );
    expect(cells).toHaveLength(1);
    expect(cells[0].type).toBe('rectangle');
    expect(cells[0].bboxSurface).toEqual({ x: 10, y: 20, width: 20, height: 20 });
  });
});
