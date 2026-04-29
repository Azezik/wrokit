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
    expect(result.executionMode).toBe('heuristic-fallback');
    expect(result.contentRectSurface).toEqual({ x: 4, y: 6, width: 10, height: 10 });
    expect(Array.isArray(result.objectsSurface)).toBe(true);
  });

  it('falls back to the full surface rect when no content is found', async () => {
    const adapter = createOpenCvJsAdapter();
    const raster = makeRaster(10, 10, () => {});
    const result = await adapter.detectContentRect(raster);
    expect(result.executionMode).toBe('heuristic-fallback');
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
    expect(result.executionMode).toBe('heuristic-fallback');
    // Line segments are an internal primitive — they are not emitted as
    // structural objects. The detector can still emit one blob covering the
    // intersecting rules (a connected component), but never one object
    // per row/column.
    expect(result.objectsSurface.length).toBeLessThan(8);
  });

  it('does not emit line objects for dense regions (object-only model)', async () => {
    // A fully-dark raster simulates a heavy-ink page. Under the object-only
    // model, no line objects are emitted regardless of density.
    const adapter = createOpenCvJsAdapter();
    const raster = makeRaster(40, 40, (data) => {
      paintContentRect(data, 40, { left: 0, top: 0, right: 40, bottom: 40 });
    });

    const result = await adapter.detectContentRect(raster);
    expect(result.executionMode).toBe('heuristic-fallback');
    // Every emitted object must be a 2D blob/rect, never a thin 1D line.
    for (const object of result.objectsSurface) {
      const minSide = Math.min(object.bboxSurface.width, object.bboxSurface.height);
      expect(minSide).toBeGreaterThan(2);
    }
  });

  it('scales line and area thresholds with raster size (size-relative floors)', async () => {
    // A large 1200x1600 raster paints a thin horizontal rule (1 row thick) at
    // y=400 of length 30 pixels. With purely absolute thresholds (24 px min
    // length) this would qualify as a line, even though 30 px is a tiny
    // fraction of the 1200 px page width. With size-relative floors the
    // adapter ignores it as below 4% of the min side (≈48 px). Either way,
    // line segments are not promoted to structural objects in the new model.
    const adapter = createOpenCvJsAdapter();
    const raster = makeRaster(1200, 1600, (data) => {
      paintContentRect(data, 1200, { left: 100, top: 400, right: 130, bottom: 401 });
    });

    const result = await adapter.detectContentRect(raster);
    expect(result.executionMode).toBe('heuristic-fallback');
    expect(result.objectsSurface).toHaveLength(0);
  });

  it('detects nested line-bounded cells from a ruled form (heuristic path)', async () => {
    // A 240x240 raster with a 2x2 ruled grid. Before the fix, the heuristic
    // fallback only produced text-blob connected components and full-page
    // line objects, so internal cells were silently lost. With the shared
    // line-grid detector, we expect both the lines and the cells.
    const adapter = createOpenCvJsAdapter();
    const raster = makeRaster(240, 240, (data) => {
      // 3 horizontal lines + 3 vertical lines forming a 2x2 grid.
      for (const y of [20, 120, 220]) {
        paintContentRect(data, 240, { left: 20, top: y, right: 221, bottom: y + 2 });
      }
      for (const x of [20, 120, 220]) {
        paintContentRect(data, 240, { left: x, top: 20, right: x + 2, bottom: 221 });
      }
    });

    const result = await adapter.detectContentRect(raster);
    expect(result.executionMode).toBe('heuristic-fallback');

    // Lines are not objects; only line-bounded rects (cells / outer frame)
    // are emitted as objects in the new model.
    const cells = result.objectsSurface;

    // Outer frame + 4 inner cells + 4 row/column spans = 9 line-bounded rects.
    // We just assert that the four leaf cells AND the outer frame are present
    // — the exact total may vary as we tune the detector.
    expect(cells.length).toBeGreaterThanOrEqual(5);

    const matches = (
      bbox: { x: number; y: number; width: number; height: number },
      expected: { x: number; y: number; width: number; height: number }
    ) =>
      Math.abs(bbox.x - expected.x) <= 2 &&
      Math.abs(bbox.y - expected.y) <= 2 &&
      Math.abs(bbox.width - expected.width) <= 2 &&
      Math.abs(bbox.height - expected.height) <= 2;

    const expectedCells = [
      { x: 20, y: 20, width: 100, height: 100 },
      { x: 120, y: 20, width: 100, height: 100 },
      { x: 20, y: 120, width: 100, height: 100 },
      { x: 120, y: 120, width: 100, height: 100 },
      { x: 20, y: 20, width: 200, height: 200 }
    ];
    for (const expected of expectedCells) {
      expect(cells.some((cell) => matches(cell.bboxSurface, expected))).toBe(true);
    }
  });

  it('produces comparable structure for the same ruled form regardless of CV mode', async () => {
    // Identical-document parity: the heuristic fallback and a (mock) OpenCV
    // runtime that runs the same shared cell pipeline must agree on the leaf
    // cell set. This is the contract that allows config-time and run-time to
    // compare structures.
    const paintGrid = (data: Uint8ClampedArray) => {
      for (const y of [20, 120, 220]) {
        paintContentRect(data, 240, { left: 20, top: y, right: 221, bottom: y + 2 });
      }
      for (const x of [20, 120, 220]) {
        paintContentRect(data, 240, { left: x, top: 20, right: x + 2, bottom: 221 });
      }
    };
    const heuristicAdapter = createOpenCvJsAdapter();
    const heuristicResult = await heuristicAdapter.detectContentRect(
      makeRaster(240, 240, paintGrid)
    );

    // Compare only line-bounded rects (id prefix `obj_rect_` in the heuristic
    // path, `obj_cv_cell_` in the OpenCV path). Connected-component blobs are
    // a separate detection family and are not part of the parity contract.
    const heuristicCellSet = new Set(
      heuristicResult.objectsSurface
        .filter((o) => o.objectId.startsWith('obj_rect_'))
        .map((o) => `${o.bboxSurface.x},${o.bboxSurface.y},${o.bboxSurface.width},${o.bboxSurface.height}`)
    );

    // OpenCV path: even an inert mock runtime (no contours) must still emit
    // the same line-bounded cells, because the shared pipeline runs on raw
    // pixels independent of contour discovery.
    const inertRuntime = createMockOpenCvRuntime();
    inertRuntime.findContours = () => {}; // no contour emissions
    inertRuntime.HoughLinesP = (_image, lines) => {
      lines.data32S = new Int32Array([]);
    };
    const cvAdapter = createOpenCvJsAdapter({ opencvRuntime: inertRuntime });
    const cvResult = await cvAdapter.detectContentRect(makeRaster(240, 240, paintGrid));
    const cvCellSet = new Set(
      cvResult.objectsSurface
        .filter((o) => o.objectId.startsWith('obj_cv_cell_'))
        .map((o) => `${o.bboxSurface.x},${o.bboxSurface.y},${o.bboxSurface.width},${o.bboxSurface.height}`)
    );

    // Every heuristic cell must also appear in the OpenCV result.
    for (const key of heuristicCellSet) {
      expect(cvCellSet.has(key)).toBe(true);
    }
  });

  it('detects line-bounded objects on a dark-themed page (background-profile inversion)', async () => {
    // Same 2x2 ruled grid as the heuristic-cells test, but painted as a
    // GREY panel on a near-black page. With the old hard-coded
    // `backgroundLuminanceThreshold = 245` heuristic, every pixel on a dark
    // page counts as foreground and the detector flood-fills the whole
    // raster as one giant blob — internal cells vanish. With the
    // background-profile + inversion normalization, the same 4 leaf cells
    // and the outer frame must be detected on a dark page just as on a
    // light page.
    const adapter = createOpenCvJsAdapter();
    const w = 240;
    const h = 240;
    const data = new Uint8ClampedArray(w * h * 4);
    // Dark page background (near-black)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 12;
      data[i + 1] = 12;
      data[i + 2] = 12;
      data[i + 3] = 255;
    }
    // Light grid lines on the dark page
    const paintLight = (rect: { left: number; top: number; right: number; bottom: number }) => {
      for (let y = rect.top; y < rect.bottom; y += 1) {
        for (let x = rect.left; x < rect.right; x += 1) {
          const i = (y * w + x) * 4;
          data[i] = 220;
          data[i + 1] = 220;
          data[i + 2] = 220;
          data[i + 3] = 255;
        }
      }
    };
    for (const y of [20, 120, 220]) {
      paintLight({ left: 20, top: y, right: 221, bottom: y + 2 });
    }
    for (const x of [20, 120, 220]) {
      paintLight({ left: x, top: 20, right: x + 2, bottom: 221 });
    }
    const raster: CvSurfaceRaster = {
      surface: { pageIndex: 0, surfaceWidth: w, surfaceHeight: h },
      pixels: { width: w, height: h, data, colorSpace: 'srgb' } as unknown as ImageData
    };

    const result = await adapter.detectContentRect(raster);
    expect(result.executionMode).toBe('heuristic-fallback');

    const cells = result.objectsSurface;
    const matches = (
      bbox: { x: number; y: number; width: number; height: number },
      expected: { x: number; y: number; width: number; height: number }
    ) =>
      Math.abs(bbox.x - expected.x) <= 2 &&
      Math.abs(bbox.y - expected.y) <= 2 &&
      Math.abs(bbox.width - expected.width) <= 2 &&
      Math.abs(bbox.height - expected.height) <= 2;

    const expectedCells = [
      { x: 20, y: 20, width: 100, height: 100 },
      { x: 120, y: 20, width: 100, height: 100 },
      { x: 20, y: 120, width: 100, height: 100 },
      { x: 120, y: 120, width: 100, height: 100 },
      { x: 20, y: 20, width: 200, height: 200 }
    ];
    for (const expected of expectedCells) {
      expect(cells.some((cell) => matches(cell.bboxSurface, expected))).toBe(true);
    }
  });

  it('detects a low-contrast filled panel (Δ luminance ≈ 18) on a dark page', async () => {
    // Reddit / dashboard regression: a card whose fill is only ~18 luminance
    // units brighter than the page background. With the previous detector
    // sensitivity, panels in this contrast range were dominated by Canny
    // noise and either fragmented into several mini-rects or dropped under
    // the small-blob floor on large rasters. After the sensitivity boost
    // (CLAHE + edge-mask MORPH_CLOSE + relaxed min-blob fraction), a panel
    // at Δ = 18 must surface as a single rect.
    const adapter = createOpenCvJsAdapter();
    const w = 240;
    const h = 240;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 12;
      data[i + 1] = 12;
      data[i + 2] = 12;
      data[i + 3] = 255;
    }
    const panel = { left: 60, top: 60, right: 180, bottom: 180 };
    for (let y = panel.top; y < panel.bottom; y += 1) {
      for (let x = panel.left; x < panel.right; x += 1) {
        const i = (y * w + x) * 4;
        data[i] = 30;
        data[i + 1] = 30;
        data[i + 2] = 30;
        data[i + 3] = 255;
      }
    }
    const raster: CvSurfaceRaster = {
      surface: { pageIndex: 0, surfaceWidth: w, surfaceHeight: h },
      pixels: { width: w, height: h, data, colorSpace: 'srgb' } as unknown as ImageData
    };

    const result = await adapter.detectContentRect(raster);
    expect(result.executionMode).toBe('heuristic-fallback');

    const matches = (
      bbox: { x: number; y: number; width: number; height: number }
    ) =>
      Math.abs(bbox.x - 60) <= 4 &&
      Math.abs(bbox.y - 60) <= 4 &&
      Math.abs(bbox.width - 120) <= 4 &&
      Math.abs(bbox.height - 120) <= 4;

    expect(result.objectsSurface.some((object) => matches(object.bboxSurface))).toBe(true);
  });

  it('extracts contour objects through the OpenCV runtime boundary, but does not emit line segments as objects', async () => {
    const adapter = createOpenCvJsAdapter({
      opencvRuntime: createMockOpenCvRuntime()
    });
    const raster = makeRaster(60, 60, () => {});

    const result = await adapter.detectContentRect(raster);
    expect(result.executionMode).toBe('opencv-runtime');
    expect(result.contentRectSurface).toEqual({ x: 4, y: 5, width: 49, height: 50 });

    const contourRects = result.objectsSurface
      .filter((item) => item.objectId.startsWith('obj_cv_') && !item.objectId.startsWith('obj_cv_line_'))
      .map((item) => item.bboxSurface);
    expect(contourRects).toEqual(
      expect.arrayContaining([
        { x: 8, y: 9, width: 28, height: 24 },
        { x: 35, y: 6, width: 18, height: 28 }
      ])
    );

    // Line segments emitted by HoughLinesP must not appear as structural
    // objects — they are an internal primitive only.
    const lineObjects = result.objectsSurface.filter((item) =>
      item.objectId.startsWith('obj_cv_line_')
    );
    expect(lineObjects).toHaveLength(0);
  });
});
