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

const createMockOpenCvRuntime = () => {
  class MockMat {
    rows = 0;
    cols = 0;
    data32S?: Int32Array;
    delete(): void {}
  }

  class MockMatVector {
    private mats: MockMat[] = [];
    size(): number {
      return this.mats.length;
    }
    get(index: number): MockMat {
      return this.mats[index];
    }
    push(mat: MockMat): void {
      this.mats.push(mat);
    }
    delete(): void {}
  }

  return {
    Mat: MockMat,
    MatVector: MockMatVector,
    Size: class MockSize {
      constructor(public width: number, public height: number) {}
    },
    matFromImageData: (_imageData: ImageData) => new MockMat(),
    cvtColor: (_src: MockMat, _dst: MockMat, _code: number) => {},
    adaptiveThreshold: (
      _src: MockMat,
      _dst: MockMat,
      _maxValue: number,
      _adaptiveMethod: number,
      _thresholdType: number,
      _blockSize: number,
      _c: number
    ) => {},
    threshold: (_src: MockMat, _dst: MockMat, _thresh: number, _maxVal: number, _type: number) => {},
    getStructuringElement: (_shape: number, _ksize: unknown) => new MockMat(),
    morphologyEx: (_src: MockMat, _dst: MockMat, _op: number, _kernel: MockMat) => {},
    Canny: (_src: MockMat, _dst: MockMat, _t1: number, _t2: number) => {},
    bitwise_or: (_src1: MockMat, _src2: MockMat, _dst: MockMat) => {},
    findContours: (
      _image: MockMat,
      contours: InstanceType<typeof MockMatVector>,
      _hierarchy: MockMat,
      _mode: number,
      _method: number
    ) => {
      const contourA = new MockMat();
      contourA.data32S = new Int32Array([8, 9, 28, 24]);
      const contourB = new MockMat();
      contourB.data32S = new Int32Array([35, 6, 18, 28]);
      contours.push(contourA);
      contours.push(contourB);
    },
    boundingRect: (contour: MockMat) => ({
      x: contour.data32S?.[0] ?? 0,
      y: contour.data32S?.[1] ?? 0,
      width: contour.data32S?.[2] ?? 0,
      height: contour.data32S?.[3] ?? 0
    }),
    HoughLinesP: (
      _image: MockMat,
      lines: MockMat,
      _rho: number,
      _theta: number,
      _threshold: number,
      _minLineLength: number,
      _maxLineGap: number
    ) => {
      lines.data32S = new Int32Array([4, 40, 52, 40, 12, 5, 12, 54]);
    },
    COLOR_RGBA2GRAY: 0,
    ADAPTIVE_THRESH_GAUSSIAN_C: 0,
    THRESH_BINARY_INV: 0,
    THRESH_BINARY: 0,
    MORPH_RECT: 0,
    MORPH_OPEN: 0,
    MORPH_CLOSE: 0,
    RETR_EXTERNAL: 0,
    CHAIN_APPROX_SIMPLE: 0
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

  it('extracts contour and line objects through the OpenCV runtime boundary when runtime is provided', async () => {
    const adapter = createOpenCvJsAdapter({
      opencvRuntime: createMockOpenCvRuntime()
    });
    const raster = makeRaster(60, 60, () => {});

    const result = await adapter.detectContentRect(raster);
    expect(result.contentRectSurface).toEqual({ x: 4, y: 5, width: 49, height: 50 });

    const contourRects = result.objectsSurface
      .filter((item) => item.objectId.startsWith('obj_cv_'))
      .map((item) => item.bboxSurface);
    expect(contourRects).toEqual(
      expect.arrayContaining([
        { x: 8, y: 9, width: 28, height: 24 },
        { x: 35, y: 6, width: 18, height: 28 }
      ])
    );

    const lineRects = result.objectsSurface
      .filter((item) => item.objectId.startsWith('obj_cv_line_'))
      .map((item) => item.bboxSurface);
    expect(lineRects).toEqual(
      expect.arrayContaining([
        { x: 4, y: 40, width: 49, height: 1 },
        { x: 12, y: 5, width: 1, height: 50 }
      ])
    );
  });
});
