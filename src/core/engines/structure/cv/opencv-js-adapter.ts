import {
  assertRasterMatchesSurface,
  type CvAdapter,
  type CvSurfaceObject,
  type CvContentRectResult,
  type CvSurfaceRaster
} from './cv-adapter';
import {
  buildLineBoundedRects,
  detectLineSegments,
  lineBoundedRectsToObjects,
  type PixelBounds as SharedPixelBounds
} from './line-grid-detector';

/**
 * OpenCV.js CV adapter — first CV implementation used by the Structural Engine.
 *
 * Containment rules:
 * - This file is the ONLY place in Wrokit allowed to import or reference
 *   OpenCV.js. The Structural Engine, contracts, runtime, and UI consume the
 *   abstract `CvAdapter` interface only.
 * - The adapter operates on the canonical NormalizedPage raster surface that
 *   was handed to it. It does not allocate an alternate image space, an
 *   alternate canvas space, or an alternate coordinate universe.
 * - Output is reported in NormalizedPage surface pixels so the Structural
 *   Engine can map results into normalized [0, 1] coordinates without the
 *   adapter ever touching the normalization layer.
 */
export interface OpenCvJsAdapterOptions {
  /**
   * Pixel value (0..255) at or above which a channel is treated as "background"
   * for heuristic fallback detection.
   */
  backgroundLuminanceThreshold?: number;
  /**
   * Minimum content side length (in surface pixels). Below this, the adapter
   * falls back to the full surface rect rather than report a degenerate rect.
   */
  minContentSidePx?: number;
  /**
   * Optional handle to a real OpenCV.js runtime. When omitted, the adapter
   * looks up `globalThis.cv` lazily.
   */
  opencvRuntime?: unknown;
}

interface OpenCvMat {
  rows: number;
  cols: number;
  data32S?: Int32Array;
  delete(): void;
}

interface OpenCvContourVector {
  size(): number;
  get(index: number): OpenCvMat;
  delete(): void;
}

interface OpenCvRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OpenCvLikeRuntime {
  Mat: new () => OpenCvMat;
  MatVector: new () => OpenCvContourVector;
  Size: new (width: number, height: number) => unknown;
  matFromImageData(imageData: ImageData): OpenCvMat;
  cvtColor(src: OpenCvMat, dst: OpenCvMat, code: number): void;
  adaptiveThreshold(
    src: OpenCvMat,
    dst: OpenCvMat,
    maxValue: number,
    adaptiveMethod: number,
    thresholdType: number,
    blockSize: number,
    c: number
  ): void;
  threshold(src: OpenCvMat, dst: OpenCvMat, thresh: number, maxVal: number, type: number): void;
  getStructuringElement(shape: number, ksize: unknown): OpenCvMat;
  morphologyEx(src: OpenCvMat, dst: OpenCvMat, op: number, kernel: OpenCvMat): void;
  Canny(src: OpenCvMat, dst: OpenCvMat, threshold1: number, threshold2: number): void;
  bitwise_or(src1: OpenCvMat, src2: OpenCvMat, dst: OpenCvMat): void;
  findContours(
    image: OpenCvMat,
    contours: OpenCvContourVector,
    hierarchy: OpenCvMat,
    mode: number,
    method: number
  ): void;
  boundingRect(contour: OpenCvMat): OpenCvRect;
  HoughLinesP(
    image: OpenCvMat,
    lines: OpenCvMat,
    rho: number,
    theta: number,
    threshold: number,
    minLineLength: number,
    maxLineGap: number
  ): void;
  COLOR_RGBA2GRAY: number;
  ADAPTIVE_THRESH_GAUSSIAN_C: number;
  THRESH_BINARY_INV: number;
  THRESH_BINARY: number;
  MORPH_RECT: number;
  MORPH_OPEN: number;
  MORPH_CLOSE: number;
  RETR_EXTERNAL: number;
  RETR_TREE?: number;
  RETR_LIST?: number;
  CHAIN_APPROX_SIMPLE: number;
}

const DEFAULT_BACKGROUND_THRESHOLD = 245;
const DEFAULT_MIN_SIDE_PX = 4;
const MIN_OBJECT_AREA_PX = 36;
const MIN_LINE_LENGTH_PX = 24;
const MAX_LINE_THICKNESS_PX = 6;
/**
 * Word-noise floor: drop blobs whose minimum side is below this fraction of
 * the page's minimum side. A typical word stroke is ~1% of the page side; we
 * keep blobs at >= 2% so glyph-shaped components don't pollute the structural
 * model. Lines are exempt — they go through the line-segment pipeline.
 */
const MIN_BLOB_MIN_SIDE_FRAC = 0.02;

/**
 * Page-size-relative floors used to keep object detection comparable across
 * different raster sizes. The audit flagged that purely absolute pixel
 * thresholds (`MIN_OBJECT_AREA_PX` etc.) under-detect on large rasters and
 * over-detect on tiny ones.
 *
 * The runtime threshold is `Math.max(absoluteFloor, relativeFloor(page))`,
 * so:
 *   - on small synthetic surfaces (e.g. unit-test rasters), the absolute
 *     floor wins and behavior is unchanged;
 *   - on a 600×800 normalized page, relative ≈ absolute (calibrated below);
 *   - on high-resolution pages the relative floor scales up.
 *
 * Calibrated so that at a ~600×800 reference surface the relative values
 * land near the existing absolute constants.
 */
const MIN_OBJECT_AREA_FRAC_OF_PAGE = 0.0008; // 0.08% of pageArea (filters glyph-noise)
const MIN_LINE_LENGTH_FRAC_OF_MIN_SIDE = 0.04; // 4% of min(W, H)
const MAX_LINE_THICKNESS_FRAC_OF_MIN_SIDE = 0.01; // 1% of min(W, H)

interface SizeRelativeThresholds {
  minObjectAreaPx: number;
  minLineLengthPx: number;
  maxLineThicknessPx: number;
}

const computeSizeRelativeThresholds = (
  surfaceWidth: number,
  surfaceHeight: number
): SizeRelativeThresholds => {
  const pageArea = Math.max(1, surfaceWidth * surfaceHeight);
  const minSide = Math.max(1, Math.min(surfaceWidth, surfaceHeight));
  return {
    minObjectAreaPx: Math.max(MIN_OBJECT_AREA_PX, Math.round(pageArea * MIN_OBJECT_AREA_FRAC_OF_PAGE)),
    minLineLengthPx: Math.max(
      MIN_LINE_LENGTH_PX,
      Math.round(minSide * MIN_LINE_LENGTH_FRAC_OF_MIN_SIDE)
    ),
    maxLineThicknessPx: Math.max(
      MAX_LINE_THICKNESS_PX,
      Math.round(minSide * MAX_LINE_THICKNESS_FRAC_OF_MIN_SIDE)
    )
  };
};

interface PixelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const isLikelyOpenCvRuntime = (value: unknown): value is OpenCvLikeRuntime => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const maybeCv = value as Partial<OpenCvLikeRuntime>;
  return (
    typeof maybeCv.Mat === 'function' &&
    typeof maybeCv.MatVector === 'function' &&
    typeof maybeCv.matFromImageData === 'function' &&
    typeof maybeCv.cvtColor === 'function' &&
    typeof maybeCv.findContours === 'function'
  );
};

const resolveOpenCvRuntime = (override?: unknown): OpenCvLikeRuntime | null => {
  if (isLikelyOpenCvRuntime(override)) {
    return override;
  }
  const globalCv = (globalThis as unknown as { cv?: unknown }).cv;
  return isLikelyOpenCvRuntime(globalCv) ? globalCv : null;
};

const clampRectToSurface = (width: number, height: number, bounds: PixelBounds): PixelBounds => ({
  left: Math.max(0, Math.min(width, bounds.left)),
  top: Math.max(0, Math.min(height, bounds.top)),
  right: Math.max(0, Math.min(width, bounds.right)),
  bottom: Math.max(0, Math.min(height, bounds.bottom))
});

const boundsToRect = (bounds: PixelBounds) => ({
  x: bounds.left,
  y: bounds.top,
  width: Math.max(0, bounds.right - bounds.left),
  height: Math.max(0, bounds.bottom - bounds.top)
});

const computeContentBoundsFromPixels = (
  pixels: ImageData,
  backgroundThreshold: number
): PixelBounds | null => {
  const { width, height, data } = pixels;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * 4;
    let rowHasContent = false;
    for (let x = 0; x < width; x += 1) {
      const i = rowStart + x * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      const isBackground =
        a < 8 ||
        (r >= backgroundThreshold && g >= backgroundThreshold && b >= backgroundThreshold);
      if (!isBackground) {
        if (x < left) left = x;
        if (x > right) right = x;
        rowHasContent = true;
      }
    }
    if (rowHasContent) {
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < 0 || bottom < 0 || left > right || top > bottom) {
    return null;
  }

  return { left, top, right: right + 1, bottom: bottom + 1 };
};

const detectConnectedBounds = (
  pixels: ImageData,
  backgroundThreshold: number,
  minObjectAreaPx: number
): PixelBounds[] => {
  const { width, height, data } = pixels;
  const visited = new Uint8Array(width * height);
  const components: PixelBounds[] = [];
  const queue = new Int32Array(width * height);

  const isForeground = (x: number, y: number): boolean => {
    const i = (y * width + x) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    return !(
      a < 8 ||
      (r >= backgroundThreshold && g >= backgroundThreshold && b >= backgroundThreshold)
    );
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const seed = y * width + x;
      if (visited[seed] === 1 || !isForeground(x, y)) {
        visited[seed] = 1;
        continue;
      }

      let head = 0;
      let tail = 0;
      queue[tail++] = seed;
      visited[seed] = 1;

      let left = x;
      let right = x;
      let top = y;
      let bottom = y;
      let area = 0;

      while (head < tail) {
        const idx = queue[head++];
        const qx = idx % width;
        const qy = Math.floor(idx / width);
        area += 1;
        if (qx < left) left = qx;
        if (qx > right) right = qx;
        if (qy < top) top = qy;
        if (qy > bottom) bottom = qy;

        const neighbors = [
          [qx - 1, qy],
          [qx + 1, qy],
          [qx, qy - 1],
          [qx, qy + 1]
        ] as const;

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue;
          }
          const nIdx = ny * width + nx;
          if (visited[nIdx] === 1) {
            continue;
          }
          visited[nIdx] = 1;
          if (isForeground(nx, ny)) {
            queue[tail++] = nIdx;
          }
        }
      }

      if (area >= minObjectAreaPx) {
        components.push({ left, top, right: right + 1, bottom: bottom + 1 });
      }
    }
  }

  return components;
};


const isLineShaped = (
  rect: { width: number; height: number },
  thresholds: SizeRelativeThresholds
): boolean => {
  const isHorizontalLine =
    rect.height <= thresholds.maxLineThicknessPx && rect.width >= thresholds.minLineLengthPx;
  const isVerticalLine =
    rect.width <= thresholds.maxLineThicknessPx && rect.height >= thresholds.minLineLengthPx;
  return isHorizontalLine || isVerticalLine;
};

const detectHeuristicSurfaceObjects = (
  pixels: ImageData,
  backgroundThreshold: number,
  thresholds: SizeRelativeThresholds
): CvSurfaceObject[] => {
  const { width, height } = pixels;
  const objects: CvSurfaceObject[] = [];
  const minBlobSide = Math.max(8, Math.round(Math.min(width, height) * MIN_BLOB_MIN_SIDE_FRAC));

  // 1. Connected components — kept for non-line-bounded shapes (logos, signatures).
  //    Word-noise is dropped via min-side and area floors. Line-shaped blobs
  //    are skipped because they belong to the line-grid pipeline.
  const components = detectConnectedBounds(pixels, backgroundThreshold, thresholds.minObjectAreaPx);
  let id = 0;
  for (const component of components) {
    const bounds = clampRectToSurface(width, height, component);
    const rect = boundsToRect(bounds);
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    if (Math.min(rect.width, rect.height) < minBlobSide) {
      continue; // glyph-shaped noise
    }
    if (isLineShaped(rect, thresholds)) {
      continue; // a 1D line is a primitive, not an object
    }
    const area = rect.width * rect.height;
    const pageArea = Math.max(1, width * height);
    objects.push({
      objectId: `obj_blob_${id++}`,
      bboxSurface: rect,
      confidence: Math.min(0.99, 0.62 + Math.min(1, area / pageArea) * 0.38)
    });
  }

  // 2. Shared line-grid pipeline: line-bounded rects only. The line segments
  //    themselves are an internal primitive and are not emitted as objects.
  const segments = detectLineSegments(pixels, backgroundThreshold, thresholds);
  const cellRects = buildLineBoundedRects(segments, {
    surfaceWidth: width,
    surfaceHeight: height
  });
  objects.push(
    ...lineBoundedRectsToObjects(cellRects, {
      idPrefix: 'obj',
      surfaceWidth: width,
      surfaceHeight: height
    })
  );

  return objects;
};

const detectWithHeuristicFallback = (
  input: CvSurfaceRaster,
  backgroundThreshold: number,
  minSidePx: number,
  thresholds: SizeRelativeThresholds
): CvContentRectResult => {
  const bounds = computeContentBoundsFromPixels(input.pixels, backgroundThreshold);
  const { surface } = input;

  if (!bounds) {
    return {
      executionMode: 'heuristic-fallback',
      contentRectSurface: {
        x: 0,
        y: 0,
        width: surface.surfaceWidth,
        height: surface.surfaceHeight
      },
      objectsSurface: []
    };
  }

  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;

  if (width < minSidePx || height < minSidePx) {
    return {
      executionMode: 'heuristic-fallback',
      contentRectSurface: {
        x: 0,
        y: 0,
        width: surface.surfaceWidth,
        height: surface.surfaceHeight
      },
      objectsSurface: []
    };
  }

  return {
    executionMode: 'heuristic-fallback',
    contentRectSurface: {
      x: bounds.left,
      y: bounds.top,
      width,
      height
    },
    objectsSurface: detectHeuristicSurfaceObjects(input.pixels, backgroundThreshold, thresholds)
  };
};

const buildObjectsFromContourRects = (
  rects: PixelBounds[],
  surfaceWidth: number,
  surfaceHeight: number,
  idPrefix: string,
  confidenceBase: number,
  thresholds: SizeRelativeThresholds,
  options: { skipLineShaped?: boolean } = {}
): CvSurfaceObject[] => {
  const pageArea = Math.max(1, surfaceWidth * surfaceHeight);

  return rects
    .map((bounds, index) => {
      const rect = boundsToRect(clampRectToSurface(surfaceWidth, surfaceHeight, bounds));
      const area = rect.width * rect.height;
      if (rect.width <= 0 || rect.height <= 0 || area < thresholds.minObjectAreaPx) {
        return null;
      }
      if (options.skipLineShaped && isLineShaped(rect, thresholds)) {
        return null;
      }

      return {
        objectId: `${idPrefix}_${index}`,
        bboxSurface: rect,
        confidence: Math.min(0.99, confidenceBase + Math.min(1, area / pageArea) * (1 - confidenceBase))
      } satisfies CvSurfaceObject;
    })
    .filter((item): item is CvSurfaceObject => item !== null);
};

const lineRectFromSegment = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  minLineLengthPx: number
): PixelBounds | null => {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);

  if (Math.max(dx, dy) < minLineLengthPx) {
    return null;
  }

  if (dx >= dy) {
    const top = Math.min(y1, y2);
    return {
      left: Math.min(x1, x2),
      top,
      right: Math.max(x1, x2) + 1,
      bottom: top + Math.max(1, dy + 1)
    };
  }

  const left = Math.min(x1, x2);
  return {
    left,
    top: Math.min(y1, y2),
    right: left + Math.max(1, dx + 1),
    bottom: Math.max(y1, y2) + 1
  };
};

const detectLineRectsWithHough = (
  cv: OpenCvLikeRuntime,
  edgeMask: OpenCvMat,
  minLineLengthPx: number
): PixelBounds[] => {
  const lines = new cv.Mat();
  try {
    cv.HoughLinesP(edgeMask, lines, 1, Math.PI / 180, 36, minLineLengthPx, 8);
    const data = lines.data32S;
    if (!data || data.length < 4) {
      return [];
    }

    const lineRects: PixelBounds[] = [];
    for (let i = 0; i + 3 < data.length; i += 4) {
      const candidate = lineRectFromSegment(
        data[i],
        data[i + 1],
        data[i + 2],
        data[i + 3],
        minLineLengthPx
      );
      if (candidate) {
        lineRects.push(candidate);
      }
    }

    return lineRects;
  } finally {
    lines.delete();
  }
};

const unionBounds = (boundsList: PixelBounds[]): PixelBounds | null => {
  if (boundsList.length === 0) {
    return null;
  }

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const bounds of boundsList) {
    if (bounds.left < left) left = bounds.left;
    if (bounds.top < top) top = bounds.top;
    if (bounds.right > right) right = bounds.right;
    if (bounds.bottom > bottom) bottom = bounds.bottom;
  }

  return {
    left,
    top,
    right,
    bottom
  };
};

const detectWithOpenCvRuntime = (
  cv: OpenCvLikeRuntime,
  input: CvSurfaceRaster,
  backgroundThreshold: number,
  minSidePx: number,
  thresholds: SizeRelativeThresholds
): CvContentRectResult => {
  const { pixels, surface } = input;
  const src = cv.matFromImageData(pixels);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  const opened = new cv.Mat();
  const cleaned = new cv.Mat();
  const edges = new cv.Mat();
  const contourMask = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  let openKernel: OpenCvMat | null = null;
  let closeKernel: OpenCvMat | null = null;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    const adaptiveBlockSize = Math.max(3, Math.floor(Math.min(pixels.width, pixels.height) / 24) * 2 + 1);
    cv.adaptiveThreshold(
      gray,
      binary,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      adaptiveBlockSize,
      8
    );

    openKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));

    cv.morphologyEx(binary, opened, cv.MORPH_OPEN, openKernel);
    cv.morphologyEx(opened, cleaned, cv.MORPH_CLOSE, closeKernel);

    cv.Canny(cleaned, edges, 50, 150);
    cv.bitwise_or(cleaned, edges, contourMask);

    // RETR_TREE / RETR_LIST surface NESTED contours, which is required so that
    // boxes-inside-boxes (e.g. table cells inside a table) become structural
    // objects instead of being silently discarded the way RETR_EXTERNAL did.
    // We fall back through TREE -> LIST -> EXTERNAL because the runtime might
    // expose a subset of the constants depending on its build.
    const retrieveMode = cv.RETR_TREE ?? cv.RETR_LIST ?? cv.RETR_EXTERNAL;
    cv.findContours(contourMask, contours, hierarchy, retrieveMode, cv.CHAIN_APPROX_SIMPLE);

    const contourRects: PixelBounds[] = [];
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      try {
        const rect = cv.boundingRect(contour);
        contourRects.push({
          left: rect.x,
          top: rect.y,
          right: rect.x + rect.width,
          bottom: rect.y + rect.height
        });
      } finally {
        contour.delete();
      }
    }

    let lineRects: PixelBounds[] = [];
    try {
      lineRects = detectLineRectsWithHough(cv, edges, thresholds.minLineLengthPx);
    } catch {
      lineRects = [];
    }

    // Contour rects: 2D shapes. Line-shaped rects are dropped because they
    // are 1D primitives that belong to the line-grid pipeline.
    const objectsFromContours = buildObjectsFromContourRects(
      contourRects,
      surface.surfaceWidth,
      surface.surfaceHeight,
      'obj_cv',
      0.62,
      thresholds,
      { skipLineShaped: true }
    );
    // HoughLinesP output (`lineRects`) is retained ONLY for content-bounds
    // computation. Line segments themselves are not emitted as structural
    // objects — they are an internal primitive that feeds line-bounded rect
    // detection.
    const objectsFromLines: CvSurfaceObject[] = [];

    // Shared line-grid cell pipeline. The OpenCV path benefits from the same
    // primitive: HoughLinesP gives us crisp segments, but the cell
    // reconstruction step (intersect horizontals × verticals → line-bounded
    // rectangles) is identical to the heuristic fallback. This is what makes
    // config-time and run-time produce comparable structure.
    const sharedSegments = detectLineSegments(pixels, backgroundThreshold, thresholds);
    const cellRects = buildLineBoundedRects(sharedSegments, {
      surfaceWidth: surface.surfaceWidth,
      surfaceHeight: surface.surfaceHeight
    });
    const objectsFromCells: CvSurfaceObject[] = lineBoundedRectsToObjects(
      cellRects as SharedPixelBounds[],
      {
        idPrefix: 'obj_cv_cell',
        surfaceWidth: surface.surfaceWidth,
        surfaceHeight: surface.surfaceHeight
      }
    );

    const contentBounds =
      unionBounds([...contourRects, ...lineRects]) ??
      computeContentBoundsFromPixels(pixels, backgroundThreshold);

    if (!contentBounds) {
      return {
        executionMode: 'opencv-runtime',
        contentRectSurface: {
          x: 0,
          y: 0,
          width: surface.surfaceWidth,
          height: surface.surfaceHeight
        },
        objectsSurface: [...objectsFromContours, ...objectsFromLines, ...objectsFromCells]
      };
    }

    const clamped = clampRectToSurface(surface.surfaceWidth, surface.surfaceHeight, contentBounds);
    const contentRectSurface = boundsToRect(clamped);

    if (contentRectSurface.width < minSidePx || contentRectSurface.height < minSidePx) {
      return {
        executionMode: 'opencv-runtime',
        contentRectSurface: {
          x: 0,
          y: 0,
          width: surface.surfaceWidth,
          height: surface.surfaceHeight
        },
        objectsSurface: [...objectsFromContours, ...objectsFromLines, ...objectsFromCells]
      };
    }

    return {
      executionMode: 'opencv-runtime',
      contentRectSurface,
      objectsSurface: [...objectsFromContours, ...objectsFromLines, ...objectsFromCells]
    };
  } finally {
    if (openKernel) {
      openKernel.delete();
    }
    if (closeKernel) {
      closeKernel.delete();
    }

    hierarchy.delete();
    contours.delete();
    contourMask.delete();
    edges.delete();
    cleaned.delete();
    opened.delete();
    binary.delete();
    gray.delete();
    src.delete();
  }
};

export const createOpenCvJsAdapter = (options: OpenCvJsAdapterOptions = {}): CvAdapter => {
  const backgroundThreshold = options.backgroundLuminanceThreshold ?? DEFAULT_BACKGROUND_THRESHOLD;
  const minSidePx = options.minContentSidePx ?? DEFAULT_MIN_SIDE_PX;
  const runtimeOverride = options.opencvRuntime;

  return {
    name: 'opencv-js',
    version: '1.0',
    detectContentRect: async (input: CvSurfaceRaster): Promise<CvContentRectResult> => {
      assertRasterMatchesSurface(input);

      const thresholds = computeSizeRelativeThresholds(
        input.surface.surfaceWidth,
        input.surface.surfaceHeight
      );

      const runtime = resolveOpenCvRuntime(runtimeOverride);
      if (!runtime) {
        return detectWithHeuristicFallback(input, backgroundThreshold, minSidePx, thresholds);
      }

      try {
        return detectWithOpenCvRuntime(
          runtime,
          input,
          backgroundThreshold,
          minSidePx,
          thresholds
        );
      } catch {
        return detectWithHeuristicFallback(input, backgroundThreshold, minSidePx, thresholds);
      }
    }
  };
};
