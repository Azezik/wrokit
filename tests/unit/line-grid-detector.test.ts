import { describe, expect, it } from 'vitest';

import {
  buildLineBoundedRects,
  clusterSegmentsByAxisPos,
  detectLineSegments,
  lineBoundedRectsToObjects,
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

  it('detects every parallel horizontal that shares a row with a longer one', () => {
    // Three side-by-side boxes whose top edges land on the same row. The
    // pre-fix detector returned only the longest run per row, so the two
    // shorter top edges were silently dropped — which is exactly why the
    // benchmark image's sidebar / target / right-grid containers all
    // collapsed onto a single visible overlay (only the rightmost grid was
    // detected, the boxes left of it shared its top row but lost the run
    // contest).
    const w = 600;
    const h = 200;
    const pixels = makeImageData(w, h, (data) => {
      // Top edges of three boxes at y=30, with very different lengths.
      paintRect(data, w, { left: 20, top: 30, right: 100, bottom: 32 }); // short
      paintRect(data, w, { left: 200, top: 30, right: 350, bottom: 32 }); // medium
      paintRect(data, w, { left: 400, top: 30, right: 580, bottom: 32 }); // long
      // Bottom edges of the same three boxes at y=160.
      paintRect(data, w, { left: 20, top: 160, right: 100, bottom: 162 });
      paintRect(data, w, { left: 200, top: 160, right: 350, bottom: 162 });
      paintRect(data, w, { left: 400, top: 160, right: 580, bottom: 162 });
      // Vertical edges of all three boxes.
      for (const x of [20, 100, 200, 350, 400, 580]) {
        paintRect(data, w, { left: x, top: 30, right: x + 2, bottom: 162 });
      }
    });

    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    // We must see every short horizontal that shares y=30 with the long one.
    // The fix's invariant is "all qualifying parallel runs survive".
    const topRowHorizontals = segments.horizontals.filter(
      (line) => Math.abs(line.axisPos - 30) <= 1
    );
    expect(topRowHorizontals.length).toBeGreaterThanOrEqual(3);
    expect(topRowHorizontals.some((l) => l.start <= 22 && l.end >= 98)).toBe(true);
    expect(topRowHorizontals.some((l) => l.start <= 202 && l.end >= 348)).toBe(true);
    expect(topRowHorizontals.some((l) => l.start <= 402 && l.end >= 578)).toBe(true);

    // And the corresponding line-bounded rects must reconstruct all three boxes.
    const rects = buildLineBoundedRects(segments, { surfaceWidth: w, surfaceHeight: h });
    const has = (l: number, t: number, r: number, b: number) =>
      rects.some(
        (rect) =>
          Math.abs(rect.left - l) <= 2 &&
          Math.abs(rect.top - t) <= 2 &&
          Math.abs(rect.right - r) <= 2 &&
          Math.abs(rect.bottom - b) <= 2
      );
    expect(has(20, 30, 100, 162)).toBe(true);
    expect(has(200, 30, 350, 162)).toBe(true);
    expect(has(400, 30, 580, 162)).toBe(true);
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

  it('drops sub-block unions on a 5x3 ruled grid: 15 leaves + 1 outer = 16 rects', () => {
    // 5 columns × 3 rows formed by SHARED rules. Six verticals, four
    // horizontals → C(6,2)·C(4,2) = 90 line-bounded quadruples in the raw
    // enumeration. Only 15 leaf cells and 1 outer container are visually
    // distinct objects; the remaining 74 rects are sub-block unions of
    // adjacent cells and must be dropped.
    const w = 700;
    const h = 400;
    const xs = [40, 160, 280, 400, 520, 640];
    const ys = [40, 160, 280, 360];
    const pixels = makeImageData(w, h, (data) => {
      for (const y of ys) {
        paintRect(data, w, { left: xs[0], top: y, right: xs[xs.length - 1] + 2, bottom: y + 2 });
      }
      for (const x of xs) {
        paintRect(data, w, { left: x, top: ys[0], right: x + 2, bottom: ys[ys.length - 1] + 2 });
      }
    });

    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    const rects = buildLineBoundedRects(segments, { surfaceWidth: w, surfaceHeight: h });

    expect(rects).toHaveLength(16);

    // Outer container is present.
    const matches = (rect: { left: number; top: number; right: number; bottom: number }, [l, t, r, b]: number[]) =>
      Math.abs(rect.left - l) <= 2 &&
      Math.abs(rect.top - t) <= 2 &&
      Math.abs(rect.right - r) <= 2 &&
      Math.abs(rect.bottom - b) <= 2;
    expect(rects.some((rect) => matches(rect, [40, 40, 642, 362]))).toBe(true);

    // All 15 leaf cells are present.
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const expected = [xs[col], ys[row], xs[col + 1] + 2, ys[row + 1] + 2];
        expect(rects.some((rect) => matches(rect, expected))).toBe(true);
      }
    }
  });

  it('subset suppression: 4-row × 3-col table emits 4*3 cells + 1 outer = 13 rects (no chain interior)', () => {
    // Without subset suppression the raw enumeration of a 4-row × 3-col
    // shared-rule grid is C(5,2)·C(4,2) = 60 line-bounded rects: every
    // cumulative-row strip and cumulative-column strip is line-bounded by
    // construction and they fan out into a deep chain of nested rects all
    // sharing 3 of 4 edges with one another. After the leaf-or-outermost
    // filter and chain-endpoints subset suppression, only the 12 leaf cells
    // and the 1 outer table frame survive.
    const w = 700;
    const h = 400;
    const xs = [60, 220, 380, 540];
    const ys = [40, 120, 200, 280, 360];
    const pixels = makeImageData(w, h, (data) => {
      for (const y of ys) {
        paintRect(data, w, {
          left: xs[0],
          top: y,
          right: xs[xs.length - 1] + 2,
          bottom: y + 2
        });
      }
      for (const x of xs) {
        paintRect(data, w, {
          left: x,
          top: ys[0],
          right: x + 2,
          bottom: ys[ys.length - 1] + 2
        });
      }
    });

    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    const rects = buildLineBoundedRects(segments, { surfaceWidth: w, surfaceHeight: h });

    expect(rects).toHaveLength(13);

    const matches = (rect: { left: number; top: number; right: number; bottom: number }, [l, t, r, b]: number[]) =>
      Math.abs(rect.left - l) <= 2 &&
      Math.abs(rect.top - t) <= 2 &&
      Math.abs(rect.right - r) <= 2 &&
      Math.abs(rect.bottom - b) <= 2;

    // 12 leaf cells.
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        const expected = [xs[col], ys[row], xs[col + 1] + 2, ys[row + 1] + 2];
        expect(rects.some((rect) => matches(rect, expected))).toBe(true);
      }
    }
    // Outer table frame survives — it is the largest composite of the tile
    // decomposition and no larger composite contains it.
    expect(
      rects.some((rect) =>
        matches(rect, [xs[0], ys[0], xs[xs.length - 1] + 2, ys[ys.length - 1] + 2])
      )
    ).toBe(true);
  });

  it('subset suppression: a partial leaf tiling collapses chain rects via chain-endpoints rule', () => {
    // Targets the real-document pathology: when a few interior cell rules go
    // missing on a dense table, the leaf-or-outermost filter cannot fully
    // decompose the cumulative-row/column unions and the chain rects survive
    // as "leaves" — driving 22+ deep parent chains in the hierarchy.
    //
    // We construct the failure mode synthetically by passing
    // `skipLeafOrOutermostFilter: true` to surface every line-bounded
    // quadruple (the case where no decomposition runs at all is a strict
    // upper bound on what residual the partial-decomposition case can leave
    // behind). On a 5-row × 3-col chain the raw enumeration emits
    // C(6,2)·C(4,2) = 90 rects; the chain-endpoints rule must collapse this
    // to far fewer than the O(rows²·cols²) explosion.
    const w = 700;
    const h = 400;
    const xs = [60, 220, 380, 540];
    const ys = [40, 100, 160, 220, 280, 360];
    const pixels = makeImageData(w, h, (data) => {
      for (const y of ys) {
        paintRect(data, w, {
          left: xs[0],
          top: y,
          right: xs[xs.length - 1] + 2,
          bottom: y + 2
        });
      }
      for (const x of xs) {
        paintRect(data, w, {
          left: x,
          top: ys[0],
          right: x + 2,
          bottom: ys[ys.length - 1] + 2
        });
      }
    });

    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    const rawCount = buildLineBoundedRects(segments, {
      surfaceWidth: w,
      surfaceHeight: h,
      skipLeafOrOutermostFilter: true
    }).length;
    const filtered = buildLineBoundedRects(segments, { surfaceWidth: w, surfaceHeight: h });

    // Raw enumeration is the O(rows²·cols²) fan; after suppression + leaf
    // filter the count must be a small multiple of the visually distinct
    // objects (15 cells + 1 outer for this 5×3 grid).
    expect(rawCount).toBeGreaterThanOrEqual(90);
    expect(filtered.length).toBeLessThanOrEqual(20);
  });

  it('keeps a HEADER + interior DATE pair as exactly 2 rects (no sub-block union)', () => {
    // HEADER and DATE drawn as independent boxes — DATE sits inside HEADER
    // but does not share any of HEADER's borders. The raw enumeration
    // emits 2 rects (HEADER + DATE); no synthetic "HEADER text region
    // minus DATE" rectangle is line-bounded because DATE's borders do
    // not extend across HEADER's interior.
    const w = 800;
    const h = 200;
    const pixels = makeImageData(w, h, (data) => {
      paintRect(data, w, { left: 30, top: 30, right: 770, bottom: 32 }); // HEADER top
      paintRect(data, w, { left: 30, top: 158, right: 770, bottom: 160 }); // HEADER bottom
      paintRect(data, w, { left: 30, top: 30, right: 32, bottom: 160 }); // HEADER left
      paintRect(data, w, { left: 768, top: 30, right: 770, bottom: 160 }); // HEADER right
      // DATE box, fully interior, no shared rule with HEADER.
      paintRect(data, w, { left: 600, top: 60, right: 740, bottom: 62 });
      paintRect(data, w, { left: 600, top: 128, right: 740, bottom: 130 });
      paintRect(data, w, { left: 600, top: 60, right: 602, bottom: 130 });
      paintRect(data, w, { left: 738, top: 60, right: 740, bottom: 130 });
    });

    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    const rects = buildLineBoundedRects(segments, { surfaceWidth: w, surfaceHeight: h });

    expect(rects).toHaveLength(2);

    const matches = (rect: { left: number; top: number; right: number; bottom: number }, [l, t, r, b]: number[]) =>
      Math.abs(rect.left - l) <= 2 &&
      Math.abs(rect.top - t) <= 2 &&
      Math.abs(rect.right - r) <= 2 &&
      Math.abs(rect.bottom - b) <= 2;
    expect(rects.some((rect) => matches(rect, [30, 30, 770, 160]))).toBe(true); // HEADER
    expect(rects.some((rect) => matches(rect, [600, 60, 740, 130]))).toBe(true); // DATE
  });

  it('exposes diagnostics: pre-filter count and dropped sub-block count', () => {
    const w = 240;
    const h = 240;
    const pixels = makeImageData(w, h, (data) => {
      for (const y of [20, 120, 220]) {
        paintRect(data, w, { left: 20, top: y, right: 221, bottom: y + 2 });
      }
      for (const x of [20, 120, 220]) {
        paintRect(data, w, { left: x, top: 20, right: x + 2, bottom: 221 });
      }
    });

    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    const diagnostics = { rectsBeforeFilter: 0, subblocksDropped: 0 };
    const rects = buildLineBoundedRects(segments, {
      surfaceWidth: w,
      surfaceHeight: h,
      diagnostics
    });
    // 2x2 ruled grid → C(3,2)² = 9 raw rects. The chain-endpoints subset
    // suppression doesn't fire on this 2-element-chain layout (there are no
    // interior chain members to drop), so all 9 enter the leaf filter and
    // reduce to 4 leaves + 1 outer = 5.
    expect(diagnostics.rectsBeforeFilter).toBe(9);
    expect(rects.length).toBe(5);
    expect(diagnostics.subblocksDropped).toBe(4);
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

describe('clusterSegmentsByAxisPos', () => {
  it('collapses 5 horizontal segments at y = 100..104 with overlapping x-extents into 1 canonical segment', () => {
    // Anti-aliasing on a single physical rule emits one segment per scanline.
    // Without clustering, every (top × bottom × left × right) quadruple search
    // multiplies these out into a fan of near-identical rects. After clustering,
    // they collapse to a single canonical segment whose axisPos is the median.
    const segments = [
      { axisPos: 100, thickness: 1, start: 20, end: 200 },
      { axisPos: 101, thickness: 1, start: 25, end: 195 },
      { axisPos: 102, thickness: 1, start: 22, end: 205 },
      { axisPos: 103, thickness: 2, start: 18, end: 198 },
      { axisPos: 104, thickness: 1, start: 21, end: 199 }
    ];
    const clustered = clusterSegmentsByAxisPos(segments, /* positionTolerance = */ 6);
    expect(clustered).toHaveLength(1);
    // Median of 100..104 is 102.
    expect(clustered[0].axisPos).toBe(102);
    // start = min, end = max, thickness = max.
    expect(clustered[0].start).toBe(18);
    expect(clustered[0].end).toBe(205);
    expect(clustered[0].thickness).toBe(2);
  });

  it('keeps segments separated by more than positionTolerance distinct', () => {
    const segments = [
      { axisPos: 100, thickness: 1, start: 0, end: 100 },
      { axisPos: 200, thickness: 1, start: 0, end: 100 }
    ];
    const clustered = clusterSegmentsByAxisPos(segments, /* positionTolerance = */ 6);
    expect(clustered).toHaveLength(2);
  });
});

describe('lineBoundedRectsToObjects', () => {
  it('emits unclassified objects (no semantic type) with non-empty bounding boxes', () => {
    const cells = lineBoundedRectsToObjects(
      [{ left: 10, top: 20, right: 30, bottom: 40 }],
      { idPrefix: 'obj', surfaceWidth: 100, surfaceHeight: 100 }
    );
    expect(cells).toHaveLength(1);
    expect(cells[0].bboxSurface).toEqual({ x: 10, y: 20, width: 20, height: 20 });
    // Object-only model: no semantic `type` field on emitted objects.
    expect((cells[0] as Record<string, unknown>).type).toBeUndefined();
  });
});
