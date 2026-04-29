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
  /** Optional raw byte view (real OpenCV.js exposes this on single-channel mats). */
  data?: Uint8Array;
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

interface OpenCvClahe {
  apply(src: OpenCvMat, dst: OpenCvMat): void;
  delete?(): void;
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
  /** Optional pre-Canny blur. Skipped if the runtime does not expose it. */
  GaussianBlur?(
    src: OpenCvMat,
    dst: OpenCvMat,
    ksize: unknown,
    sigmaX: number,
    sigmaY?: number
  ): void;
  /** Optional dilation primitive used to close fragmented edges. */
  dilate?(src: OpenCvMat, dst: OpenCvMat, kernel: OpenCvMat): void;
  /**
   * Optional CLAHE constructor. CLAHE (Contrast Limited Adaptive Histogram
   * Equalization) is the single biggest sensitivity win on dark / low-contrast
   * UIs where panel boundaries are only 5–15 luminance units apart.
   */
  CLAHE?: new (clipLimit?: number, tileGridSize?: unknown) => OpenCvClahe;
  /**
   * Optional polygon approximation. Used to detect contours that are
   * shape-rectangular (4 vertices, convex, ~90° corners) so they can be
   * scored higher and protected from NMS suppression by larger
   * non-rectangular contours.
   */
  approxPolyDP?(curve: OpenCvMat, approx: OpenCvMat, epsilon: number, closed: boolean): void;
  arcLength?(curve: OpenCvMat, closed: boolean): number;
  contourArea?(contour: OpenCvMat): number;
  isContourConvex?(contour: OpenCvMat): boolean;
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
 * keep blobs at >= 1.2% so small UI elements (number tiles, icon buttons,
 * single-row sidebar items) survive on large rasters. The previous 2% cutoff
 * killed ~40 px elements on a 2000-wide screenshot, where every secondary
 * Reddit/dashboard control lives. Lines are exempt — they go through the
 * line-segment pipeline.
 */
const MIN_BLOB_MIN_SIDE_FRAC = 0.012;

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

/**
 * Background-profile detection: a hard-coded "white = background" assumption
 * collapses on dark UIs (every pixel becomes foreground, the heuristic
 * fallback flood-fills the entire page as one blob, and identical inputs
 * produce inconsistent partial detections from run to run). We sample the
 * page perimeter — corners plus a small inset border — and use the median
 * luminance to decide whether the page is light- or dark-themed.
 *
 * The downstream detectors are written to expect "light bg, dark content".
 * For dark-themed pages we normalize by inverting RGB so the same predicate
 * (and the same `backgroundLuminanceThreshold = 245`) applies in either
 * polarity. The returned `normalizedThreshold` is what callers should pass
 * to the line-grid detector and connected-component flood fill.
 */
interface BackgroundProfile {
  isDark: boolean;
  /** Median perimeter luminance (0..255) before normalization. */
  perimeterMedian: number;
  /** Threshold to apply on the post-normalization (always light-bg) raster. */
  normalizedThreshold: number;
}

const luminanceAt = (data: Uint8ClampedArray, i: number): number =>
  0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

const detectBackgroundProfile = (
  pixels: ImageData,
  baseThreshold: number
): BackgroundProfile => {
  const { width, height, data } = pixels;
  const samples: number[] = [];
  const inset = Math.max(2, Math.min(8, Math.floor(Math.min(width, height) / 32)));

  const sampleAt = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return;
    }
    const i = (y * width + x) * 4;
    if (data[i + 3] < 8) {
      return;
    }
    samples.push(luminanceAt(data, i));
  };

  for (let dy = 0; dy < inset; dy += 1) {
    for (let dx = 0; dx < inset; dx += 1) {
      sampleAt(dx, dy);
      sampleAt(width - 1 - dx, dy);
      sampleAt(dx, height - 1 - dy);
      sampleAt(width - 1 - dx, height - 1 - dy);
    }
  }

  // Light raster (no opaque pixels at all) — fall back to the supplied
  // threshold so existing tests with synthetic transparent rasters continue
  // to behave the same way.
  if (samples.length === 0) {
    return { isDark: false, perimeterMedian: 255, normalizedThreshold: baseThreshold };
  }

  samples.sort((a, b) => a - b);
  const perimeterMedian = samples[Math.floor(samples.length / 2)];
  const isDark = perimeterMedian < 128;

  if (!isDark) {
    // Light page — keep the caller-supplied threshold so existing
    // light-background calibrations and tests stay unchanged.
    return { isDark, perimeterMedian, normalizedThreshold: baseThreshold };
  }

  // Dark page — after RGB inversion, background pixels land at
  // `255 - perimeterMedian`, which is rarely as bright as 245. Pin the
  // threshold a small distance below the inverted background luminance so
  // all dark-page panels still register as background while their content
  // (grey panels, near-white text, light grid rules) registers as
  // foreground. Floor at 180 so heavy dark themes (perimeter ≈ 0) still
  // admit reasonable foreground variation.
  const invertedBg = 255 - perimeterMedian;
  const tolerance = 16;
  const normalizedThreshold = Math.max(180, Math.min(baseThreshold, invertedBg - tolerance));
  return { isDark, perimeterMedian, normalizedThreshold };
};

/**
 * If the page is dark-themed, return a new ImageData with RGB inverted so the
 * downstream detectors see "light bg, dark content". Alpha is preserved. For
 * light pages this returns the input unchanged (no allocation).
 */
const normalizeRasterForLightBackground = (
  pixels: ImageData,
  profile: BackgroundProfile
): ImageData => {
  if (!profile.isDark) {
    return pixels;
  }
  const { width, height, data } = pixels;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = 255 - data[i];
    out[i + 1] = 255 - data[i + 1];
    out[i + 2] = 255 - data[i + 2];
    out[i + 3] = data[i + 3];
  }
  return { width, height, data: out, colorSpace: pixels.colorSpace ?? 'srgb' } as unknown as ImageData;
};

/**
 * Auto-tune Canny thresholds via the standard "median ± sigma" rule. A fixed
 * (50, 150) pair is too tight for low-contrast UIs and is not adaptive to
 * brightness, which means the same panel border passes Canny in one capture
 * and fragments into broken edges in the next. Computing the median once per
 * page and deriving (lo, hi) keeps detection consistent across captures of
 * the same content.
 */
const computeAutoCannyThresholds = (pixels: ImageData): { lo: number; hi: number } => {
  const { data } = pixels;
  const stride = 16;
  const samples: number[] = [];
  for (let i = 0; i < data.length; i += 4 * stride) {
    if (data[i + 3] < 8) {
      continue;
    }
    samples.push(luminanceAt(data, i));
  }
  if (samples.length === 0) {
    return { lo: 50, hi: 150 };
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const sigma = 0.33;
  const lo = Math.max(0, Math.floor((1 - sigma) * median));
  const hi = Math.min(255, Math.floor((1 + sigma) * median));
  // Guarantee a non-trivial hysteresis band even when the page has very low
  // luminance variance (e.g. a uniform dark UI).
  if (hi - lo < 20) {
    return { lo: Math.max(0, lo - 10), hi: Math.min(255, hi + 10) };
  }
  return { lo, hi };
};

const intersectionOverUnion = (a: PixelBounds, b: PixelBounds): number => {
  const interLeft = Math.max(a.left, b.left);
  const interTop = Math.max(a.top, b.top);
  const interRight = Math.min(a.right, b.right);
  const interBottom = Math.min(a.bottom, b.bottom);
  if (interRight <= interLeft || interBottom <= interTop) {
    return 0;
  }
  const inter = (interRight - interLeft) * (interBottom - interTop);
  const areaA = Math.max(0, a.right - a.left) * Math.max(0, a.bottom - a.top);
  const areaB = Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
};

interface ScoredRect {
  rect: PixelBounds;
  /**
   * Priority bucket: higher wins. Rects flagged as `confirmed` (passed the
   * polygon-approximation rectangularity test) take precedence over
   * non-confirmed rects of similar IoU, so a noisy non-rectangular contour
   * cannot silently displace a clean panel rect during NMS.
   */
  confirmed: boolean;
}

/**
 * Suppress near-duplicate rects produced by anti-aliased edges that fragment
 * differently between captures. Without this step, a single panel border can
 * produce two sub-pixel-offset boxes that look identical visually but differ
 * in the structural model — the dominant source of cross-run inconsistency.
 *
 * When the input carries `confirmed` flags (from the polygon-approximation
 * rectangularity test), confirmed rects sort ahead of non-confirmed ones in
 * the suppression order so that "this is shape-evidence-confirmed a
 * rectangle" wins ties against "this is just a contour bounding box".
 */
const mergeNearDuplicateRects = (
  rects: ScoredRect[] | PixelBounds[],
  iouThreshold = 0.85
): PixelBounds[] => {
  if (rects.length <= 1) {
    return rects.map((entry) => ('rect' in entry ? entry.rect : entry));
  }
  const scored: ScoredRect[] = (rects as Array<ScoredRect | PixelBounds>).map((entry) => {
    if ('rect' in entry) {
      return entry;
    }
    return { rect: entry, confirmed: false };
  });
  const sorted = scored
    .map((entry) => ({
      ...entry,
      area:
        Math.max(0, entry.rect.right - entry.rect.left) *
        Math.max(0, entry.rect.bottom - entry.rect.top)
    }))
    .sort((a, b) => {
      if (a.confirmed !== b.confirmed) {
        return a.confirmed ? -1 : 1;
      }
      return b.area - a.area;
    });
  const kept: PixelBounds[] = [];
  for (const { rect } of sorted) {
    let suppressed = false;
    for (const accepted of kept) {
      if (intersectionOverUnion(rect, accepted) >= iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) {
      kept.push(rect);
    }
  }
  return kept;
};

/**
 * Decide whether a contour is "shape-evidence rectangular": polygon
 * approximation collapses to 4 vertices, the polygon is convex, all four
 * interior angles are within 12° of 90°, and the polygon area fills at least
 * 85% of the axis-aligned bounding rect (the canonical "rectangularity"
 * ratio).
 *
 * Pure boundingRect detection misses this evidence — a low-contrast UI panel
 * whose Canny edges are barely above the noise floor still has the geometry
 * of a rectangle, and that geometry alone should let it survive NMS against a
 * noisier nearby contour. When the runtime does not expose any of the
 * required ops, the helper returns false (fall back to existing behavior).
 */
const isShapeRectangle = (
  cv: OpenCvLikeRuntime,
  contour: OpenCvMat,
  rect: OpenCvRect
): boolean => {
  if (
    typeof cv.approxPolyDP !== 'function' ||
    typeof cv.arcLength !== 'function'
  ) {
    return false;
  }

  const approx = new cv.Mat();
  try {
    const perimeter = cv.arcLength(contour, true);
    if (!Number.isFinite(perimeter) || perimeter <= 0) {
      return false;
    }
    cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);
    const polyData = approx.data32S;
    if (!polyData || polyData.length !== 8) {
      return false;
    }

    if (typeof cv.isContourConvex === 'function') {
      try {
        if (!cv.isContourConvex(approx)) {
          return false;
        }
      } catch {
        // Treat a thrown convexity check as non-rectangular rather than
        // crashing the pipeline — better to fall through to bounding-rect
        // behavior than to lose the contour entirely.
        return false;
      }
    }

    // Corner-angle test: every interior angle of a rectangle is 90°. Allow
    // ±12° to admit anti-aliased corners that round subtly under JPEG-style
    // capture noise.
    for (let v = 0; v < 4; v += 1) {
      const ax = polyData[(v * 2 + 6) % 8];
      const ay = polyData[(v * 2 + 7) % 8];
      const bx = polyData[v * 2];
      const by = polyData[v * 2 + 1];
      const cx = polyData[(v * 2 + 2) % 8];
      const cy = polyData[(v * 2 + 3) % 8];
      const v1x = ax - bx;
      const v1y = ay - by;
      const v2x = cx - bx;
      const v2y = cy - by;
      const lenA = Math.hypot(v1x, v1y);
      const lenB = Math.hypot(v2x, v2y);
      if (lenA === 0 || lenB === 0) {
        return false;
      }
      const cos = (v1x * v2x + v1y * v2y) / (lenA * lenB);
      const angleDeg = Math.acos(Math.max(-1, Math.min(1, cos))) * (180 / Math.PI);
      if (Math.abs(angleDeg - 90) > 12) {
        return false;
      }
    }

    if (typeof cv.contourArea === 'function') {
      const polyArea = Math.abs(cv.contourArea(approx));
      const boxArea = Math.max(1, rect.width * rect.height);
      if (polyArea / boxArea < 0.85) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  } finally {
    approx.delete();
  }
};

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
  const equalized = new cv.Mat();
  const blurred = new cv.Mat();
  const binary = new cv.Mat();
  const opened = new cv.Mat();
  const cleaned = new cv.Mat();
  const edges = new cv.Mat();
  const dilatedEdges = new cv.Mat();
  const closedEdges = new cv.Mat();
  const contourMask = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  let openKernel: OpenCvMat | null = null;
  let closeKernel: OpenCvMat | null = null;
  let dilateKernel: OpenCvMat | null = null;
  let edgeCloseKernel: OpenCvMat | null = null;
  let clahe: OpenCvClahe | null = null;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // CLAHE (Contrast Limited Adaptive Histogram Equalization) — local
    // contrast equalization that lifts ~10-luminance-unit panel boundaries
    // (typical of dark Reddit/dashboard cards on slightly-darker page
    // backgrounds) into the dynamic range Canny can see. This is the
    // single biggest sensitivity win for low-contrast UIs and runs before
    // every downstream edge / threshold stage. When the runtime does not
    // expose CLAHE (stripped builds, mocks), the equalization step is
    // skipped and the rest of the pipeline is unchanged.
    let preprocessed: OpenCvMat = gray;
    if (typeof cv.CLAHE === 'function') {
      try {
        clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
        clahe.apply(gray, equalized);
        preprocessed = equalized;
      } catch {
        preprocessed = gray;
      }
    }

    // Pre-blur stabilizes Canny against capture-to-capture noise on
    // anti-aliased UI borders. When the runtime does not expose
    // GaussianBlur (mock or stripped build), we feed the equalized mat
    // straight into Canny.
    let cannyInput: OpenCvMat = preprocessed;
    if (typeof cv.GaussianBlur === 'function') {
      cv.GaussianBlur(preprocessed, blurred, new cv.Size(3, 3), 0);
      cannyInput = blurred;
    }

    const adaptiveBlockSize = Math.max(3, Math.floor(Math.min(pixels.width, pixels.height) / 24) * 2 + 1);
    cv.adaptiveThreshold(
      preprocessed,
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

    // Auto-tune Canny: median±sigma adapts to overall page brightness so
    // identical content produces identical edge masks across captures, even
    // on low-contrast (dark UI / muted theme) surfaces.
    const cannyThresholds = computeAutoCannyThresholds(pixels);
    cv.Canny(cannyInput, edges, cannyThresholds.lo, cannyThresholds.hi);

    // Morphologically close the Canny edge mask before contour detection.
    // The previous 2×2 dilate sealed only one-pixel gaps, but UI corners
    // routinely fragment into 4 separate edge pieces (a soft drop-shadow on
    // one side, a 1-px border on another, anti-aliased seams in between).
    // A proper 3×3 close (dilate→erode) seals those into closed contours
    // that findContours can then recover as a single panel rect. We
    // preserve the dedicated dilate path as a fallback for runtimes that
    // expose `dilate` but not `morphologyEx` semantics for edge masks.
    edgeCloseKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    let edgeMaskForContours: OpenCvMat = edges;
    let edgeMaskReady = false;
    try {
      cv.morphologyEx(edges, closedEdges, cv.MORPH_CLOSE, edgeCloseKernel);
      edgeMaskForContours = closedEdges;
      edgeMaskReady = true;
    } catch {
      edgeMaskReady = false;
    }
    if (!edgeMaskReady && typeof cv.dilate === 'function') {
      dilateKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
      try {
        cv.dilate(edges, dilatedEdges, dilateKernel);
        edgeMaskForContours = dilatedEdges;
      } catch {
        edgeMaskForContours = edges;
      }
    }
    cv.bitwise_or(cleaned, edgeMaskForContours, contourMask);

    // RETR_TREE / RETR_LIST surface NESTED contours, which is required so that
    // boxes-inside-boxes (e.g. table cells inside a table) become structural
    // objects instead of being silently discarded the way RETR_EXTERNAL did.
    // We fall back through TREE -> LIST -> EXTERNAL because the runtime might
    // expose a subset of the constants depending on its build.
    const retrieveMode = cv.RETR_TREE ?? cv.RETR_LIST ?? cv.RETR_EXTERNAL;
    cv.findContours(contourMask, contours, hierarchy, retrieveMode, cv.CHAIN_APPROX_SIMPLE);

    const contourRects: ScoredRect[] = [];
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      try {
        const rect = cv.boundingRect(contour);
        // Polygon-evidence rectangularity: 4 vertices, convex, ~90° corners,
        // ≥85% bounding-box fill. When this passes, the contour is treated
        // as a high-confidence rectangle and protected from NMS suppression
        // by larger non-rectangular contours that overlap it.
        const confirmed = isShapeRectangle(cv, contour, rect);
        contourRects.push({
          rect: {
            left: rect.x,
            top: rect.y,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height
          },
          confirmed
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

    // NMS-merge near-duplicate rects so that anti-aliased borders fragmenting
    // into slightly different sub-pixel offsets produce the SAME bounding
    // box on every run. Polygon-confirmed rectangles take precedence over
    // non-confirmed ones in the suppression order so a noisy non-rectangular
    // contour cannot displace a clean panel rect.
    const mergedContourRects = mergeNearDuplicateRects(contourRects);

    // Contour rects: 2D shapes. Line-shaped rects are dropped because they
    // are 1D primitives that belong to the line-grid pipeline.
    const objectsFromContours = buildObjectsFromContourRects(
      mergedContourRects,
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
      unionBounds([...mergedContourRects, ...lineRects]) ??
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
    if (clahe && typeof clahe.delete === 'function') {
      try {
        clahe.delete();
      } catch {
        // CLAHE handles in some OpenCV.js builds throw on a second delete;
        // swallow so that downstream cleanup still runs.
      }
    }
    if (openKernel) {
      openKernel.delete();
    }
    if (closeKernel) {
      closeKernel.delete();
    }
    if (dilateKernel) {
      dilateKernel.delete();
    }
    if (edgeCloseKernel) {
      edgeCloseKernel.delete();
    }

    hierarchy.delete();
    contours.delete();
    contourMask.delete();
    closedEdges.delete();
    dilatedEdges.delete();
    edges.delete();
    cleaned.delete();
    opened.delete();
    binary.delete();
    blurred.delete();
    equalized.delete();
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

      // Decide light vs dark page from perimeter samples and, if dark,
      // hand all downstream detectors an inverted "light bg, dark content"
      // raster so the same predicates apply uniformly. The line-grid
      // detector and the heuristic flood fill are agnostic to this — they
      // only ever see normalized pixels and a normalized threshold.
      const profile = detectBackgroundProfile(input.pixels, backgroundThreshold);
      const normalizedPixels = normalizeRasterForLightBackground(input.pixels, profile);
      const normalizedInput: CvSurfaceRaster =
        normalizedPixels === input.pixels ? input : { surface: input.surface, pixels: normalizedPixels };
      const effectiveThreshold = profile.normalizedThreshold;

      const runtime = resolveOpenCvRuntime(runtimeOverride);
      if (!runtime) {
        return detectWithHeuristicFallback(
          normalizedInput,
          effectiveThreshold,
          minSidePx,
          thresholds
        );
      }

      try {
        return detectWithOpenCvRuntime(
          runtime,
          normalizedInput,
          effectiveThreshold,
          minSidePx,
          thresholds
        );
      } catch {
        return detectWithHeuristicFallback(
          normalizedInput,
          effectiveThreshold,
          minSidePx,
          thresholds
        );
      }
    }
  };
};
