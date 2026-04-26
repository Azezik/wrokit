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
  });

  it('falls back to the full surface rect when no content is found', async () => {
    const adapter = createOpenCvJsAdapter();
    const raster = makeRaster(10, 10, () => {});
    const result = await adapter.detectContentRect(raster);
    expect(result.contentRectSurface).toEqual({ x: 0, y: 0, width: 10, height: 10 });
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
});
