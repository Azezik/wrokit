import { describe, expect, it } from 'vitest';

import {
  buildLineBoundedRects,
  detectLineSegments,
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

const paintBorder = (
  data: Uint8ClampedArray,
  width: number,
  rect: { left: number; top: number; right: number; bottom: number },
  thickness = 2
) => {
  paintRect(data, width, { left: rect.left, top: rect.top, right: rect.right, bottom: rect.top + thickness });
  paintRect(data, width, { left: rect.left, top: rect.bottom - thickness, right: rect.right, bottom: rect.bottom });
  paintRect(data, width, { left: rect.left, top: rect.top, right: rect.left + thickness, bottom: rect.bottom });
  paintRect(data, width, { left: rect.right - thickness, top: rect.top, right: rect.right, bottom: rect.bottom });
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
    minLineLengthPx: Math.max(24, Math.round(minSide * 0.025)),
    maxLineThicknessPx: Math.max(6, Math.round(minSide * 0.01))
  };
};

const has = (
  rects: { left: number; top: number; right: number; bottom: number }[],
  l: number,
  t: number,
  r: number,
  b: number,
  tol = 3
) =>
  rects.some(
    (rect) =>
      Math.abs(rect.left - l) <= tol &&
      Math.abs(rect.top - t) <= tol &&
      Math.abs(rect.right - r) <= tol &&
      Math.abs(rect.bottom - b) <= tol
  );

describe('benchmark layout: container with corner label tile', () => {
  it('returns BOTH the outer container AND its top-left label tile', () => {
    const w = 600;
    const h = 600;
    const pixels = makeImageData(w, h, (data) => {
      // Outer container at (50, 50)-(550, 550), 2px border
      paintBorder(data, w, { left: 50, top: 50, right: 550, bottom: 550 }, 2);
      // Small label tile in the top-left corner. Inset 6 px from container border.
      paintBorder(data, w, { left: 56, top: 56, right: 86, bottom: 86 }, 2);
    });

    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    const rects = buildLineBoundedRects(segments, { surfaceWidth: w, surfaceHeight: h });

    // Both rectangles are real and must both be reported.
    expect(has(rects, 50, 50, 552, 552)).toBe(true);
    expect(has(rects, 56, 56, 88, 88)).toBe(true);
  });

  it('returns nested containers AND every per-container label tile when many siblings stack', () => {
    // Mimics the benchmark: an outer page boundary, a header row, and several
    // sidebar/section containers, each carrying a small numbered label tile in
    // its top-left corner. The pre-fix detector found the small label tiles
    // (their borders are crisp short lines) but lost the outer containers
    // because the rect-emission cap or the segment-span tolerance starved
    // them of valid quadruples. This test pins both behaviors.
    const w = 800;
    const h = 1000;
    const pixels = makeImageData(w, h, (data) => {
      // Outer page boundary at (10, 10)-(790, 990)
      paintBorder(data, w, { left: 10, top: 10, right: 790, bottom: 990 }, 2);

      // Header row at (20, 20)-(780, 80)
      paintBorder(data, w, { left: 20, top: 20, right: 780, bottom: 80 }, 2);
      paintBorder(data, w, { left: 24, top: 24, right: 54, bottom: 54 }, 2); // header label

      // Sidebar column with 6 stacked items at left side
      for (let i = 0; i < 6; i += 1) {
        const top = 100 + i * 50;
        paintBorder(data, w, { left: 20, top, right: 200, bottom: top + 40 }, 2);
        paintBorder(data, w, { left: 24, top: top + 4, right: 54, bottom: top + 34 }, 2);
      }

      // Right-hand section containers
      for (let i = 0; i < 4; i += 1) {
        const top = 100 + i * 100;
        paintBorder(data, w, { left: 220, top, right: 780, bottom: top + 90 }, 2);
        paintBorder(data, w, { left: 224, top: top + 4, right: 254, bottom: top + 34 }, 2);
      }

      // Footer
      paintBorder(data, w, { left: 20, top: 920, right: 780, bottom: 970 }, 2);
      paintBorder(data, w, { left: 24, top: 924, right: 54, bottom: 954 }, 2);
    });

    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    const rects = buildLineBoundedRects(segments, { surfaceWidth: w, surfaceHeight: h });

    // Outer page boundary (the user explicitly called out that the page
    // boundary "1" was being missed).
    expect(has(rects, 10, 10, 792, 992)).toBe(true);

    // Header container AND its label tile.
    expect(has(rects, 20, 20, 782, 82)).toBe(true);
    expect(has(rects, 24, 24, 56, 56)).toBe(true);

    // Each sidebar item AND its label tile.
    for (let i = 0; i < 6; i += 1) {
      const top = 100 + i * 50;
      expect(has(rects, 20, top, 202, top + 42)).toBe(true);
      expect(has(rects, 24, top + 4, 56, top + 36)).toBe(true);
    }

    // Each right-hand section AND its label.
    for (let i = 0; i < 4; i += 1) {
      const top = 100 + i * 100;
      expect(has(rects, 220, top, 782, top + 92)).toBe(true);
      expect(has(rects, 224, top + 4, 256, top + 36)).toBe(true);
    }

    // Footer.
    expect(has(rects, 20, 920, 782, 972)).toBe(true);
    expect(has(rects, 24, 924, 56, 956)).toBe(true);
  });

  it('handles a benchmark-density layout (~65 nested rects, each with a corner label)', () => {
    // The real benchmark has 65 numbered rectangles; my smaller repro of 22
    // succeeded, so push harder. Build 65 containers (some nested) and put a
    // tiny label tile in every container's top-left corner. This is dense
    // enough to potentially exhaust the maxRects cap and starve outer
    // containers of detection.
    const w = 1200;
    const h = 1600;
    const pixels = makeImageData(w, h, (data) => {
      // 1: page boundary
      paintBorder(data, w, { left: 8, top: 8, right: 1192, bottom: 1592 }, 2);
      paintBorder(data, w, { left: 14, top: 14, right: 44, bottom: 44 }, 2); // label "1"

      // 2: header
      paintBorder(data, w, { left: 20, top: 60, right: 1180, bottom: 130 }, 2);
      paintBorder(data, w, { left: 26, top: 66, right: 56, bottom: 96 }, 2);

      // 3: date pill (inside header)
      paintBorder(data, w, { left: 1000, top: 75, right: 1170, bottom: 115 }, 2);
      paintBorder(data, w, { left: 1006, top: 81, right: 1036, bottom: 111 }, 2);

      // 4: sidebar anchor
      paintBorder(data, w, { left: 20, top: 150, right: 280, bottom: 200 }, 2);
      paintBorder(data, w, { left: 26, top: 156, right: 56, bottom: 186 }, 2);

      // 5-9: sidebar items
      for (let i = 0; i < 5; i += 1) {
        const top = 220 + i * 60;
        paintBorder(data, w, { left: 20, top, right: 280, bottom: top + 50 }, 2);
        paintBorder(data, w, { left: 26, top: top + 6, right: 56, bottom: top + 36 }, 2);
      }

      // 10: target
      paintBorder(data, w, { left: 300, top: 150, right: 700, bottom: 350 }, 2);
      paintBorder(data, w, { left: 306, top: 156, right: 336, bottom: 186 }, 2);

      // 11: target inner
      paintBorder(data, w, { left: 320, top: 200, right: 680, bottom: 330 }, 2);
      paintBorder(data, w, { left: 326, top: 206, right: 356, bottom: 236 }, 2);

      // 12-14: fields inside target inner
      for (let i = 0; i < 3; i += 1) {
        const top = 250 + i * 22;
        paintBorder(data, w, { left: 340, top, right: 660, bottom: top + 20 }, 2);
      }

      // 15: spacer / right grid frame
      paintBorder(data, w, { left: 720, top: 150, right: 1180, bottom: 600 }, 2);
      paintBorder(data, w, { left: 726, top: 156, right: 756, bottom: 186 }, 2);

      // 16-30: right grid (3 cols × 5 rows of cells)
      for (let row = 0; row < 5; row += 1) {
        for (let col = 0; col < 3; col += 1) {
          const left = 730 + col * 150;
          const top = 200 + row * 75;
          paintBorder(data, w, { left, top, right: left + 140, bottom: top + 65 }, 2);
        }
      }

      // 31: info box
      paintBorder(data, w, { left: 300, top: 380, right: 700, bottom: 480 }, 2);
      paintBorder(data, w, { left: 306, top: 386, right: 336, bottom: 416 }, 2);

      // 32, 33: info lines
      paintBorder(data, w, { left: 320, top: 420, right: 680, bottom: 440 }, 2);
      paintBorder(data, w, { left: 320, top: 450, right: 680, bottom: 470 }, 2);

      // 34: details box
      paintBorder(data, w, { left: 300, top: 500, right: 700, bottom: 600 }, 2);
      paintBorder(data, w, { left: 306, top: 506, right: 336, bottom: 536 }, 2);

      // 35: section A
      paintBorder(data, w, { left: 20, top: 620, right: 580, bottom: 900 }, 2);
      paintBorder(data, w, { left: 26, top: 626, right: 56, bottom: 656 }, 2);

      // 36, 37: A1, A2
      paintBorder(data, w, { left: 40, top: 670, right: 280, bottom: 880 }, 2);
      paintBorder(data, w, { left: 46, top: 676, right: 76, bottom: 706 }, 2);
      paintBorder(data, w, { left: 300, top: 670, right: 560, bottom: 880 }, 2);
      paintBorder(data, w, { left: 306, top: 676, right: 336, bottom: 706 }, 2);

      // 38: section B
      paintBorder(data, w, { left: 600, top: 620, right: 1180, bottom: 900 }, 2);
      paintBorder(data, w, { left: 606, top: 626, right: 636, bottom: 656 }, 2);

      // 39, 40: B1, B2
      paintBorder(data, w, { left: 620, top: 670, right: 880, bottom: 880 }, 2);
      paintBorder(data, w, { left: 626, top: 676, right: 656, bottom: 706 }, 2);
      paintBorder(data, w, { left: 900, top: 670, right: 1160, bottom: 880 }, 2);
      paintBorder(data, w, { left: 906, top: 676, right: 936, bottom: 706 }, 2);

      // 41: wide grid
      paintBorder(data, w, { left: 20, top: 920, right: 1180, bottom: 1100 }, 2);
      paintBorder(data, w, { left: 26, top: 926, right: 56, bottom: 956 }, 2);

      // 42-59: 18 cells in wide grid (6 cols × 3 rows)
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 6; col += 1) {
          const left = 40 + col * 190;
          const top = 970 + row * 40;
          paintBorder(data, w, { left, top, right: left + 180, bottom: top + 35 }, 2);
        }
      }

      // 60: notes box
      paintBorder(data, w, { left: 20, top: 1120, right: 580, bottom: 1400 }, 2);
      paintBorder(data, w, { left: 26, top: 1126, right: 56, bottom: 1156 }, 2);

      // 61, 62, 63: notes
      for (let i = 0; i < 3; i += 1) {
        const top = 1170 + i * 70;
        paintBorder(data, w, { left: 40, top, right: 560, bottom: top + 60 }, 2);
        paintBorder(data, w, { left: 46, top: top + 6, right: 76, bottom: top + 36 }, 2);
      }

      // 64: footer
      paintBorder(data, w, { left: 600, top: 1120, right: 1180, bottom: 1500 }, 2);
      paintBorder(data, w, { left: 606, top: 1126, right: 636, bottom: 1156 }, 2);

      // 65: page-number box (inside footer)
      paintBorder(data, w, { left: 1080, top: 1450, right: 1170, bottom: 1490 }, 2);
      paintBorder(data, w, { left: 1086, top: 1456, right: 1116, bottom: 1486 }, 2);
    });

    const segments = detectLineSegments(pixels, 245, baselineThresholds(w, h));
    const rects = buildLineBoundedRects(segments, { surfaceWidth: w, surfaceHeight: h });

    // Spot-checks for the specific containers the user reported as missing.
    const containerChecks: Array<[string, number, number, number, number]> = [
      ['1 outer page', 8, 8, 1194, 1594],
      ['2 header', 20, 60, 1182, 132],
      ['3 date pill', 1000, 75, 1172, 117],
      ['4 sidebar anchor', 20, 150, 282, 202],
      ['5 sidebar item 0', 20, 220, 282, 272],
      ['9 sidebar item 4', 20, 460, 282, 512],
      ['31 info box', 300, 380, 702, 482],
      ['32 info line 1', 320, 420, 682, 442],
      ['33 info line 2', 320, 450, 682, 472],
      ['34 details box', 300, 500, 702, 602],
      ['35 section A', 20, 620, 582, 902],
      ['36 A1', 40, 670, 282, 882],
      ['37 A2', 300, 670, 562, 882],
      ['38 section B', 600, 620, 1182, 902],
      ['39 B1', 620, 670, 882, 882],
      ['40 B2', 900, 670, 1162, 882],
      ['12 field 1', 340, 250, 662, 272],
      ['60 notes box', 20, 1120, 582, 1402],
      ['61 note 1', 40, 1170, 562, 1232],
      ['64 footer', 600, 1120, 1182, 1502],
      ['65 page-number', 1080, 1450, 1172, 1492]
    ];

    const missing: string[] = [];
    for (const [name, l, t, r, b] of containerChecks) {
      if (!has(rects, l, t, r, b)) {
        missing.push(name);
      }
    }
    expect(missing, `missing containers: ${missing.join(', ')}`).toEqual([]);
  });
});
