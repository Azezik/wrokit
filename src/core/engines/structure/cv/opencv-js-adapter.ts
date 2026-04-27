import {
  assertRasterMatchesSurface,
  type CvAdapter,
  type CvSurfaceObject,
  type CvContentRectResult,
  type CvSurfaceRaster
} from './cv-adapter';

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
  CHAIN_APPROX_SIMPLE: number;
}

const DEFAULT_BACKGROUND_THRESHOLD = 245;
const DEFAULT_MIN_SIDE_PX = 4;
const MIN_OBJECT_AREA_PX = 36;
const MIN_LINE_LENGTH_PX = 24;
const MAX_LINE_THICKNESS_PX = 6;

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
  backgroundThreshold: number
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

      if (area >= MIN_OBJECT_AREA_PX) {
        components.push({ left, top, right: right + 1, bottom: bottom + 1 });
      }
    }
  }

  return components;
};

const buildHeuristicLineObjects = (
  pixels: ImageData,
  backgroundThreshold: number
): CvSurfaceObject[] => {
  const { width, height, data } = pixels;
  const densityCutoff = 0.95;

  const isBgAt = (i: number): boolean =>
    data[i + 3] < 8 ||
    (data[i] >= backgroundThreshold &&
      data[i + 1] >= backgroundThreshold &&
      data[i + 2] >= backgroundThreshold);

  const rowForeground = new Uint32Array(height);
  for (let y = 0; y < height; y += 1) {
    let count = 0;
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (!isBgAt(rowBase + x * 4)) count += 1;
    }
    rowForeground[y] = count;
  }

  const colForeground = new Uint32Array(width);
  for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let y = 0; y < height; y += 1) {
      if (!isBgAt((y * width + x) * 4)) count += 1;
    }
    colForeground[x] = count;
  }

  const horizontals: CvSurfaceObject[] = [];
  const verticals: CvSurfaceObject[] = [];

  let runStart = -1;
  let runMaxCount = 0;
  let hLineId = 0;
  for (let y = 0; y <= height; y += 1) {
    const isHigh =
      y < height &&
      rowForeground[y] >= MIN_LINE_LENGTH_PX &&
      rowForeground[y] / width >= densityCutoff;
    if (isHigh) {
      if (runStart < 0) {
        runStart = y;
        runMaxCount = rowForeground[y];
      } else if (rowForeground[y] > runMaxCount) {
        runMaxCount = rowForeground[y];
      }
    } else if (runStart >= 0) {
      const thickness = y - runStart;
      if (thickness <= MAX_LINE_THICKNESS_PX) {
        horizontals.push({
          objectId: `obj_hline_${hLineId++}`,
          type: 'line-horizontal',
          bboxSurface: { x: 0, y: runStart, width, height: thickness },
          confidence: Math.min(1, 0.75 + (runMaxCount / width) * 0.25)
        });
      }
      runStart = -1;
      runMaxCount = 0;
    }
  }

  runStart = -1;
  runMaxCount = 0;
  let vLineId = 0;
  for (let x = 0; x <= width; x += 1) {
    const isHigh =
      x < width &&
      colForeground[x] >= MIN_LINE_LENGTH_PX &&
      colForeground[x] / height >= densityCutoff;
    if (isHigh) {
      if (runStart < 0) {
        runStart = x;
        runMaxCount = colForeground[x];
      } else if (colForeground[x] > runMaxCount) {
        runMaxCount = colForeground[x];
      }
    } else if (runStart >= 0) {
      const thickness = x - runStart;
      if (thickness <= MAX_LINE_THICKNESS_PX) {
        verticals.push({
          objectId: `obj_vline_${vLineId++}`,
          type: 'line-vertical',
          bboxSurface: { x: runStart, y: 0, width: thickness, height },
          confidence: Math.min(1, 0.75 + (runMaxCount / height) * 0.25)
        });
      }
      runStart = -1;
      runMaxCount = 0;
    }
  }

  return [...horizontals, ...verticals];
};

const detectHeuristicSurfaceObjects = (
  pixels: ImageData,
  backgroundThreshold: number
): CvSurfaceObject[] => {
  const objects: CvSurfaceObject[] = [];
  const { width, height } = pixels;
  const components = detectConnectedBounds(pixels, backgroundThreshold);
  let id = 0;

  for (const component of components) {
    const bounds = clampRectToSurface(width, height, component);
    const rect = boundsToRect(bounds);
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    const area = rect.width * rect.height;
    const pageArea = Math.max(1, width * height);
    objects.push({
      objectId: `obj_${id++}`,
      type: classifyObjectType(rect, width, height),
      bboxSurface: rect,
      confidence: Math.min(0.99, 0.62 + Math.min(1, area / pageArea) * 0.38)
    });
  }

  objects.push(...buildHeuristicLineObjects(pixels, backgroundThreshold));
  return objects;
};

const classifyObjectType = (
  rect: { width: number; height: number },
  surfaceWidth: number,
  surfaceHeight: number
): CvSurfaceObject['type'] => {
  const area = rect.width * rect.height;
  const pageArea = Math.max(1, surfaceWidth * surfaceHeight);
  const isContainer = area / pageArea >= 0.12;
  const isHorizontalLine = rect.height <= MAX_LINE_THICKNESS_PX && rect.width >= MIN_LINE_LENGTH_PX;
  const isVerticalLine = rect.width <= MAX_LINE_THICKNESS_PX && rect.height >= MIN_LINE_LENGTH_PX;
  const isTableLike = rect.width >= surfaceWidth * 0.35 && rect.height >= surfaceHeight * 0.15;

  if (isHorizontalLine) {
    return 'line-horizontal';
  }
  if (isVerticalLine) {
    return 'line-vertical';
  }
  if (isTableLike) {
    return 'table-like';
  }
  if (isContainer) {
    return 'container';
  }
  return 'rectangle';
};

const detectWithHeuristicFallback = (
  input: CvSurfaceRaster,
  backgroundThreshold: number,
  minSidePx: number
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
    objectsSurface: detectHeuristicSurfaceObjects(input.pixels, backgroundThreshold)
  };
};

const buildObjectsFromContourRects = (
  rects: PixelBounds[],
  surfaceWidth: number,
  surfaceHeight: number,
  idPrefix: string,
  confidenceBase: number
): CvSurfaceObject[] => {
  const pageArea = Math.max(1, surfaceWidth * surfaceHeight);

  return rects
    .map((bounds, index) => {
      const rect = boundsToRect(clampRectToSurface(surfaceWidth, surfaceHeight, bounds));
      const area = rect.width * rect.height;
      if (rect.width <= 0 || rect.height <= 0 || area < MIN_OBJECT_AREA_PX) {
        return null;
      }

      return {
        objectId: `${idPrefix}_${index}`,
        type: classifyObjectType(rect, surfaceWidth, surfaceHeight),
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
  y2: number
): PixelBounds | null => {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);

  if (Math.max(dx, dy) < MIN_LINE_LENGTH_PX) {
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

const detectLineRectsWithHough = (cv: OpenCvLikeRuntime, edgeMask: OpenCvMat): PixelBounds[] => {
  const lines = new cv.Mat();
  try {
    cv.HoughLinesP(edgeMask, lines, 1, Math.PI / 180, 36, MIN_LINE_LENGTH_PX, 8);
    const data = lines.data32S;
    if (!data || data.length < 4) {
      return [];
    }

    const lineRects: PixelBounds[] = [];
    for (let i = 0; i + 3 < data.length; i += 4) {
      const candidate = lineRectFromSegment(data[i], data[i + 1], data[i + 2], data[i + 3]);
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
  minSidePx: number
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

    cv.findContours(contourMask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

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
      lineRects = detectLineRectsWithHough(cv, edges);
    } catch {
      lineRects = [];
    }

    const objectsFromContours = buildObjectsFromContourRects(
      contourRects,
      surface.surfaceWidth,
      surface.surfaceHeight,
      'obj_cv',
      0.62
    );
    const objectsFromLines = buildObjectsFromContourRects(
      lineRects,
      surface.surfaceWidth,
      surface.surfaceHeight,
      'obj_cv_line',
      0.72
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
        objectsSurface: [...objectsFromContours, ...objectsFromLines]
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
        objectsSurface: [...objectsFromContours, ...objectsFromLines]
      };
    }

    return {
      executionMode: 'opencv-runtime',
      contentRectSurface,
      objectsSurface: [...objectsFromContours, ...objectsFromLines]
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

      const runtime = resolveOpenCvRuntime(runtimeOverride);
      if (!runtime) {
        return detectWithHeuristicFallback(input, backgroundThreshold, minSidePx);
      }

      try {
        return detectWithOpenCvRuntime(runtime, input, backgroundThreshold, minSidePx);
      } catch {
        return detectWithHeuristicFallback(input, backgroundThreshold, minSidePx);
      }
    }
  };
};
