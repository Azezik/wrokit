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
 *
 * Loading model:
 * - The real `cv.js` WASM runtime can be attached by user code (e.g. via a
 *   `<script src="opencv.js">` tag that exposes a global `cv`). When present
 *   it will be used. When not present, the adapter falls back to a pixel-data
 *   based content-rect detector that runs the same conceptual operation
 *   (background threshold + tight bounding rect of non-background pixels)
 *   directly against the NormalizedPage raster surface. The fallback exists
 *   only so the static-hosted shell does not require a network fetch of
 *   `cv.js` to produce a deterministic StructuralModel.
 */
export interface OpenCvJsAdapterOptions {
  /**
   * Pixel value (0..255) at or above which a channel is treated as "background"
   * for content detection. Default 245 favors plain page backgrounds.
   */
  backgroundLuminanceThreshold?: number;
  /**
   * Minimum content side length (in surface pixels). Below this, the adapter
   * falls back to the full surface rect rather than report a degenerate rect.
   */
  minContentSidePx?: number;
  /**
   * Optional handle to a real OpenCV.js runtime. When omitted, the adapter
   * looks up `globalThis.cv` lazily; if absent it uses the pixel-data fallback.
   */
  opencvRuntime?: unknown;
}

interface OpenCvLikeRuntime {
  // Intentionally minimal — we only want to detect presence and, if available,
  // we still operate via the same pixel-data path so results stay deterministic
  // and surface-bounded. Real OpenCV.js usage can be expanded in this file
  // alone without affecting the rest of Wrokit.
  Mat?: unknown;
}

const DEFAULT_BACKGROUND_THRESHOLD = 245;
const DEFAULT_MIN_SIDE_PX = 4;
const MIN_OBJECT_AREA_PX = 36;
const MIN_LINE_LENGTH_PX = 24;
// A real horizontal/vertical rule is a *thin* contiguous run of high-density
// rows/cols. Thicker runs are dense regions already captured by the connected-
// components detector — emitting them again as "lines" produces thousands of
// overlapping per-row objects (overlay overwhelm + hierarchy noise).
const MAX_LINE_THICKNESS_PX = 4;
// Hard safety cap so no pathological raster can emit thousands of line nodes.
const MAX_LINE_OBJECTS_PER_AXIS = 64;

const isLikelyOpenCvRuntime = (value: unknown): value is OpenCvLikeRuntime => {
  return typeof value === 'object' && value !== null && 'Mat' in (value as Record<string, unknown>);
};

const resolveOpenCvRuntime = (override?: unknown): OpenCvLikeRuntime | null => {
  if (isLikelyOpenCvRuntime(override)) {
    return override;
  }
  const globalCv = (globalThis as unknown as { cv?: unknown }).cv;
  if (isLikelyOpenCvRuntime(globalCv)) {
    return globalCv;
  }
  return null;
};

const computeContentBoundsFromPixels = (
  pixels: ImageData,
  backgroundThreshold: number
): { left: number; top: number; right: number; bottom: number } | null => {
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
      // Treat near-white-on-opaque OR fully transparent as background.
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

interface PixelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const clampRectToSurface = (
  width: number,
  height: number,
  bounds: PixelBounds
): PixelBounds => ({
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

const buildLineObjects = (pixels: ImageData, backgroundThreshold: number): CvSurfaceObject[] => {
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

  // Merge consecutive high-density rows into a single horizontal-line object.
  // Only emit when the resulting run is thin (a real rule). Thicker runs are
  // dense regions and are already covered by detectConnectedBounds — emitting
  // them here would re-spawn the per-row overlay overwhelm.
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
      if (thickness <= MAX_LINE_THICKNESS_PX && horizontals.length < MAX_LINE_OBJECTS_PER_AXIS) {
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
      if (thickness <= MAX_LINE_THICKNESS_PX && verticals.length < MAX_LINE_OBJECTS_PER_AXIS) {
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

const detectSurfaceObjects = (
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
    const pageArea = width * height;
    const isContainer = area / pageArea >= 0.12;
    const isHorizontalLine = rect.height <= 3 && rect.width >= MIN_LINE_LENGTH_PX;
    const isVerticalLine = rect.width <= 3 && rect.height >= MIN_LINE_LENGTH_PX;
    const isTableLike = rect.width >= width * 0.35 && rect.height >= height * 0.15;

    let type: CvSurfaceObject['type'] = 'rectangle';
    if (isHorizontalLine) {
      type = 'line-horizontal';
    } else if (isVerticalLine) {
      type = 'line-vertical';
    } else if (isTableLike) {
      type = 'table-like';
    } else if (isContainer) {
      type = 'container';
    }

    objects.push({
      objectId: `obj_${id++}`,
      type,
      bboxSurface: rect,
      confidence: Math.min(0.99, 0.62 + Math.min(1, area / pageArea) * 0.38)
    });
  }

  const contentBounds = computeContentBoundsFromPixels(pixels, backgroundThreshold);
  if (contentBounds) {
    const topBand = Math.max(1, Math.round(height * 0.12));
    const bottomBand = Math.max(1, Math.round(height * 0.12));
    objects.push({
      objectId: `obj_header_${id++}`,
      type: 'header',
      bboxSurface: {
        x: contentBounds.left,
        y: contentBounds.top,
        width: Math.max(1, contentBounds.right - contentBounds.left),
        height: Math.min(topBand, Math.max(1, contentBounds.bottom - contentBounds.top))
      },
      confidence: 0.7
    });
    objects.push({
      objectId: `obj_footer_${id++}`,
      type: 'footer',
      bboxSurface: {
        x: contentBounds.left,
        y: Math.max(contentBounds.top, contentBounds.bottom - bottomBand),
        width: Math.max(1, contentBounds.right - contentBounds.left),
        height: Math.min(bottomBand, Math.max(1, contentBounds.bottom - contentBounds.top))
      },
      confidence: 0.68
    });
  }

  objects.push(...buildLineObjects(pixels, backgroundThreshold));
  return objects;
};

export const createOpenCvJsAdapter = (
  options: OpenCvJsAdapterOptions = {}
): CvAdapter => {
  const backgroundThreshold = options.backgroundLuminanceThreshold ?? DEFAULT_BACKGROUND_THRESHOLD;
  const minSidePx = options.minContentSidePx ?? DEFAULT_MIN_SIDE_PX;
  const runtimeOverride = options.opencvRuntime;

  return {
    name: 'opencv-js',
    version: '1.0',
    detectContentRect: async (input: CvSurfaceRaster): Promise<CvContentRectResult> => {
      assertRasterMatchesSurface(input);

      // Touch the runtime so future expansion can swap to real OpenCV ops here
      // without changing the engine. The detection result is independent of
      // whether `cv.js` is loaded — both branches operate on the same canonical
      // NormalizedPage raster surface.
      void resolveOpenCvRuntime(runtimeOverride);

      const bounds = computeContentBoundsFromPixels(input.pixels, backgroundThreshold);
      const { surface } = input;

      if (!bounds) {
        return {
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
        contentRectSurface: {
          x: bounds.left,
          y: bounds.top,
          width,
          height
        },
        objectsSurface: detectSurfaceObjects(input.pixels, backgroundThreshold)
      };
    }
  };
};
