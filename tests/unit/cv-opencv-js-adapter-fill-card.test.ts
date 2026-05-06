import { describe, expect, it } from 'vitest';

import {
  createOpenCvJsAdapter,
  type CvSurfaceRaster
} from '../../src/core/engines/structure/cv';

const makeGmailBillRaster = (): CvSurfaceRaster => {
  // 800x650 page mimicking the Gmail bill summary card layout, with the
  // card occupying ~22% of the page area (representative of real captures
  // where the card is one element among the inbox list, sidebar, header,
  // and chrome):
  //  - white page (lum 255)
  //  - light-grey card at lum 246 from (60, 80)..(540, 320), Δ = 9
  //  - 2x2 grid of dark text bands inside the card, with column gutter
  //    around x = 300 and row gutter around y = 200.
  const w = 800;
  const h = 650;
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

    // Confidence parity check: alignment cells must clear the 0.78 floor
    // that fill rects emit at, so that an overlay confidence filter set at
    // ≥ 0.75 (the typical default) does not silently drop the per-field
    // cells while keeping noisier confirmed-contour rects.
    for (const cell of alignmentObjects) {
      expect(cell.confidence).toBeGreaterThanOrEqual(0.78);
    }
  });

  it('skips alignment cells inside oversized fill regions (no email-body-slab pathology)', async () => {
    // 600x500 page where a single faint fill region covers 60% of the page
    // (a Gmail message reading-pane scenario). Inside it, scattered text
    // bands at multiple y positions would produce ~6 horizontal slabs per
    // text row if alignment cells fired here. The new oversized-parent gate
    // skips alignment-cell detection for fill regions ≥ 30% of page area,
    // so no alignment objects should be emitted from this region.
    const w = 600;
    const h = 500;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
    // Big faint fill: 60% of the page.
    for (let y = 50; y < 450; y += 1) {
      for (let x = 50; x < 500; x += 1) {
        const i = (y * w + x) * 4;
        data[i] = 246;
        data[i + 1] = 246;
        data[i + 2] = 246;
      }
    }
    // Scattered text bands at multiple y positions — would project into
    // ~6 thin row bands if alignment ran on this region.
    const textRows = [80, 130, 180, 230, 280, 330, 380];
    for (const y0 of textRows) {
      for (let y = y0; y < y0 + 14; y += 1) {
        for (let x = 100; x < 450; x += 1) {
          const i = (y * w + x) * 4;
          data[i] = 24;
          data[i + 1] = 24;
          data[i + 2] = 24;
        }
      }
    }

    const adapter = createOpenCvJsAdapter();
    const result = await adapter.detectContentRect({
      surface: { pageIndex: 0, surfaceWidth: w, surfaceHeight: h },
      pixels: { width: w, height: h, data, colorSpace: 'srgb' } as unknown as ImageData
    });

    const alignmentObjects = result.objectsSurface.filter((o) =>
      o.objectId.startsWith('obj_align_')
    );
    expect(alignmentObjects).toEqual([]);

    // The fill rect itself must still be reported — only alignment cells are
    // suppressed, not the parent.
    const fillObjects = result.objectsSurface.filter((o) =>
      o.objectId.startsWith('obj_fill_')
    );
    expect(fillObjects.length).toBeGreaterThan(0);
  });
});
