import { describe, expect, it } from 'vitest';

import {
  createOpenCvJsAdapter,
  type CvSurfaceRaster
} from '../../src/core/engines/structure/cv';

const makeGmailBillRaster = (): CvSurfaceRaster => {
  // 600x500 page mimicking the Gmail bill summary card layout:
  //  - white page (lum 255)
  //  - light-grey card at lum 246 from (60, 80)..(540, 320), Δ = 9
  //  - 2x2 grid of dark text bands inside the card, with column gutter
  //    around x = 300 and row gutter around y = 200.
  const w = 600;
  const h = 500;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  // Card surface.
  for (let y = 80; y < 320; y += 1) {
    for (let x = 60; x < 540; x += 1) {
      const i = (y * w + x) * 4;
      data[i] = 246;
      data[i + 1] = 246;
      data[i + 2] = 246;
    }
  }

  // Text rows inside each quadrant of the 2x2 grid.
  // Quadrants: TL (80,100..280,180), TR (320,100..520,180),
  //            BL (80, 220..280, 300), BR (320, 220..520, 300).
  const paintTextBand = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * w + x) * 4;
        data[i] = 24;
        data[i + 1] = 24;
        data[i + 2] = 24;
      }
    }
  };
  // Two rows per quadrant: a label line and a value line.
  paintTextBand(100, 260, 110, 124); // TL label
  paintTextBand(100, 260, 138, 152); // TL value
  paintTextBand(340, 500, 110, 124); // TR label
  paintTextBand(340, 500, 138, 152); // TR value
  paintTextBand(100, 260, 230, 244); // BL label
  paintTextBand(100, 260, 258, 272); // BL value
  paintTextBand(340, 500, 230, 244); // BR label
  paintTextBand(340, 500, 258, 272); // BR value

  return {
    surface: { pageIndex: 0, surfaceWidth: w, surfaceHeight: h },
    pixels: { width: w, height: h, data, colorSpace: 'srgb' } as unknown as ImageData
  };
};

describe('createOpenCvJsAdapter — Gmail-style bill summary card', () => {
  it('detects a stroke-less card defined only by a 9-luminance fill step', async () => {
    // Regression: previously, screenshots like Gmail bill summaries dropped
    // the card surface entirely because the line-grid pipeline saw no lines
    // and the contour pipeline's Canny / adaptiveThreshold did not fire on
    // a 9-unit fill step. The new fill-bounded rect primitive must catch it.
    const adapter = createOpenCvJsAdapter();
    const result = await adapter.detectContentRect(makeGmailBillRaster());
    expect(result.executionMode).toBe('heuristic-fallback');

    const cardMatch = result.objectsSurface.find((o) => {
      const b = o.bboxSurface;
      return (
        Math.abs(b.x - 60) <= 4 &&
        Math.abs(b.y - 80) <= 4 &&
        Math.abs(b.width - 480) <= 8 &&
        Math.abs(b.height - 240) <= 8
      );
    });
    expect(cardMatch).toBeDefined();
  });

  it('emits alignment cells inside the bill summary card grid', async () => {
    // Inside the card, the 2x2 grid of label/value pairs has a column gutter
    // around x = 300 and a row gutter around y = 200. The alignment-cell
    // pass projects foreground pixels and recovers cells from the gutters.
    const adapter = createOpenCvJsAdapter();
    const result = await adapter.detectContentRect(makeGmailBillRaster());

    const alignmentObjects = result.objectsSurface.filter((o) =>
      o.objectId.startsWith('obj_align_')
    );
    // Each grid quadrant should produce at least one alignment cell — we
    // assert presence in each quadrant rather than an exact count, because
    // the projection-band split may emit slightly more than 4 cells when
    // the label and value rows are separated by a small inter-row gutter.
    expect(alignmentObjects.length).toBeGreaterThanOrEqual(4);

    const inQuadrant = (
      bbox: { x: number; y: number; width: number; height: number },
      qx0: number,
      qy0: number,
      qx1: number,
      qy1: number
    ) =>
      bbox.x >= qx0 - 4 &&
      bbox.y >= qy0 - 4 &&
      bbox.x + bbox.width <= qx1 + 4 &&
      bbox.y + bbox.height <= qy1 + 4;

    expect(
      alignmentObjects.some((o) => inQuadrant(o.bboxSurface, 60, 80, 300, 200))
    ).toBe(true);
    expect(
      alignmentObjects.some((o) => inQuadrant(o.bboxSurface, 300, 80, 540, 200))
    ).toBe(true);
    expect(
      alignmentObjects.some((o) => inQuadrant(o.bboxSurface, 60, 200, 300, 320))
    ).toBe(true);
    expect(
      alignmentObjects.some((o) => inQuadrant(o.bboxSurface, 300, 200, 540, 320))
    ).toBe(true);
  });
});
