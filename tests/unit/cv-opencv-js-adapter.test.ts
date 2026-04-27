import { describe, expect, it } from 'vitest';

import {
  CvAdapterSurfaceMismatchError,
  createOpenCvJsAdapter,
  type CvSurfaceRaster
} from '../../src/core/engines/structure/cv';
import type { PageSurface } from '../../src/core/page-surface/page-surface';

const surface: PageSurface = { pageIndex: 0, surfaceWidth: 20, surfaceHeight: 20 };

const fillBackground = (data: Uint8ClampedArray) => {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
};

const paintContentRect = (
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

const makeRaster = (
  width: number,
  height: number,
  paint: (data: Uint8ClampedArray) => void
): CvSurfaceRaster => {
  const data = new Uint8ClampedArray(width * height * 4);
  fillBackground(data);
  paint(data);
  return {
    surface: { pageIndex: 0, surfaceWidth: width, surfaceHeight: height },
    pixels: { width, height, data, colorSpace: 'srgb' } as unknown as ImageData
  };
};

describe('createOpenCvJsAdapter', () => {
  it('detects the bounding rect of non-background pixels on the canonical surface', async () => {
    const adapter = createOpenCvJsAdapter();
    const raster = makeRaster(20, 20, (data) => {
      paintContentRect(data, 20, { left: 4, top: 6, right: 14, bottom: 16 });
    });

    const result = await adapter.detectContentRect(raster);
    expect(result.contentRectSurface).toEqual({ x: 4, y: 6, width: 10, height: 10 });
    expect(Array.isArray(result.objectsSurface)).toBe(true);
  });

  it('falls back to the full surface rect when no content is found', async () => {
    const adapter = createOpenCvJsAdapter();
    const raster = makeRaster(10, 10, () => {});
    const result = await adapter.detectContentRect(raster);
    expect(result.contentRectSurface).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(result.objectsSurface).toEqual([]);
  });

  it('rejects a raster whose dimensions do not match the surface', async () => {
    const adapter = createOpenCvJsAdapter();
    const data = new Uint8ClampedArray(8 * 8 * 4);
    fillBackground(data);
    const raster: CvSurfaceRaster = {
      surface,
      pixels: { width: 8, height: 8, data, colorSpace: 'srgb' } as unknown as ImageData
    };
    await expect(adapter.detectContentRect(raster)).rejects.toBeInstanceOf(
      CvAdapterSurfaceMismatchError
    );
  });

  it('exposes a stable adapter identity for StructuralModel provenance', () => {
    const adapter = createOpenCvJsAdapter();
    expect(adapter.name).toBe('opencv-js');
    expect(adapter.version).toBe('1.0');
  });

  it('merges adjacent dense rows/cols into single line objects (no per-row spam)', async () => {
    // A 64x64 raster with two thin horizontal rules (2 rows thick) and one
    // thin vertical rule (1 col thick). The detector must emit ONE line per
    // rule, not one line per row/column.
    const adapter = createOpenCvJsAdapter();
    const raster = makeRaster(64, 64, (data) => {
      const stripe = (
        x0: number,
        y0: number,
        x1: number,
        y1: number
      ) => paintContentRect(data, 64, { left: x0, top: y0, right: x1, bottom: y1 });
      stripe(0, 10, 64, 12); // horizontal rule rows 10..11
      stripe(0, 40, 64, 42); // horizontal rule rows 40..41
      stripe(31, 0, 32, 64); // vertical rule col 31
    });

    const result = await adapter.detectContentRect(raster);
    const horizontals = result.objectsSurface.filter((o) => o.type === 'line-horizontal');
    const verticals = result.objectsSurface.filter((o) => o.type === 'line-vertical');

    expect(horizontals).toHaveLength(2);
    expect(verticals).toHaveLength(1);
    expect(horizontals[0].bboxSurface).toMatchObject({ x: 0, y: 10, width: 64, height: 2 });
    expect(horizontals[1].bboxSurface).toMatchObject({ x: 0, y: 40, width: 64, height: 2 });
    expect(verticals[0].bboxSurface).toMatchObject({ x: 31, y: 0, width: 1, height: 64 });
  });

  it('does not emit line objects for dense regions (those belong to connected components)', async () => {
    // A fully-dark raster simulates a heavy-ink/teal-mockup page where every
    // row and every column passes the density threshold. Before the fix, this
    // produced one line object per row plus one per column (~width+height
    // overlay nodes that visually fused into a solid blob). The fix collapses
    // the entire run; since it exceeds MAX_LINE_THICKNESS_PX, no lines are
    // emitted — the dense region is captured by detectConnectedBounds instead.
    const adapter = createOpenCvJsAdapter();
    const raster = makeRaster(40, 40, (data) => {
      paintContentRect(data, 40, { left: 0, top: 0, right: 40, bottom: 40 });
    });

    const result = await adapter.detectContentRect(raster);
    const lineObjects = result.objectsSurface.filter(
      (o) => o.type === 'line-horizontal' || o.type === 'line-vertical'
    );
    expect(lineObjects).toHaveLength(0);
  });
});
