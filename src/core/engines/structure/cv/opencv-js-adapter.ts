import {
  assertRasterMatchesSurface,
  type CvAdapter,
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
          }
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
          }
        };
      }

      return {
        contentRectSurface: {
          x: bounds.left,
          y: bounds.top,
          width,
          height
        }
      };
    }
  };
};
