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
  type LineBoundedRectsDiagnostics,
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
 * Glyph-suppression gates applied uniformly across the contour, line-bounded
 * cell, and heuristic blob pipelines. Text-heavy pages produce thousands of
 * digit/letter contours (0, 6, 8, 9, B, D, O) whose bounding boxes are
 * indistinguishable in size from small UI controls; without these gates they
 * dominate detection and drown out the structural model.
 *
 * - Aspect-ratio gate: glyph contours fit roughly inside a 1:2 box; the 1/12
 *   .. 12 window is permissive enough to admit thin progress bars and tall
 *   sidebar items while still cutting wide horizontal rule fragments.
 * - Fill-ratio gate: contour-area / bounding-rect-area for typical glyphs
 *   sits at 0.25–0.45 (a hollow 8 fills about 0.3 of its bbox), while panel
 *   borders and filled UI tiles fill ≈1.0. The 0.55 floor cuts glyph hulls
 *   without touching real panels.
 *
 * Confirmed rectangles (those that pass `isShapeRectangle`) bypass both
 * gates because polygon-approximation already proved they are convex 4-vertex
 * shapes; the only floor that still applies to them is the min-side gate.
 */
const GLYPH_ASPECT_RATIO_MAX = 12;
const GLYPH_ASPECT_RATIO_MIN = 1 / GLYPH_ASPECT_RATIO_MAX;
const GLYPH_FILL_RATIO_MIN = 0.55;

const computeGlyphMinSidePx = (surfaceWidth: number, surfaceHeight: number): number =>
  Math.max(8, Math.round(Math.min(surfaceWidth, surfaceHeight) * MIN_BLOB_MIN_SIDE_FRAC));

const passesGlyphSuppression = (
  rect: { width: number; height: number },
  confirmed: boolean,
  fillRatio: number,
  minSidePx: number
): boolean => {
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  if (Math.min(rect.width, rect.height) < minSidePx) {
    return false;
  }
  if (confirmed) {
    return true;
  }
  const aspectRatio = rect.width / rect.height;
  if (aspectRatio < GLYPH_ASPECT_RATIO_MIN || aspectRatio > GLYPH_ASPECT_RATIO_MAX) {
    return false;
  }
  if (fillRatio < GLYPH_FILL_RATIO_MIN) {
    return false;
  }
  return true;
};

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
/**
 * Min line-length floor: small UI boxes (a 30 px-tall sidebar item, a 28 px
 * tall date / note pill) only contribute ~30 px-long vertical edges. Holding
 * this at 4% of min-side meant the vertical edges of every such box were
 * culled before they reached the line-grid reconstructor, so the box was
 * silently lost. 2.5% admits ~30 px edges on typical 1000 px-min-side
 * captures while still sitting above text-stroke length, and the absolute
 * `MIN_LINE_LENGTH_PX = 24` floor protects small synthetic test rasters.
 * Word-shaped glyph strokes never form lines anyway because they exceed
 * `maxLineThicknessPx`, so the lower length floor is safe.
 */
const MIN_LINE_LENGTH_FRAC_OF_MIN_SIDE = 0.025;
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
  /**
   * Contour fill ratio (contour area / bounding-rect area) when the rect
   * came from a real contour. `1` for rects synthesized from 4 line segments
   * (line-bounded cells) and unset for callers that have not measured it.
   */
  fillRatio?: number;
}

const DUPLICATE_IOU_MIN = 0.85;
const DUPLICATE_AREA_RATIO_MIN = 0.85;
const DUPLICATE_ASPECT_RATIO_MIN = 0.85;
const DUPLICATE_CONTAINMENT_EPS = 1e-6;

const boundsArea = (bounds: PixelBounds): number =>
  Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);

const boundsContains = (outer: PixelBounds, inner: PixelBounds): boolean =>
  inner.left + DUPLICATE_CONTAINMENT_EPS >= outer.left &&
  inner.top + DUPLICATE_CONTAINMENT_EPS >= outer.top &&
  inner.right <= outer.right + DUPLICATE_CONTAINMENT_EPS &&
  inner.bottom <= outer.bottom + DUPLICATE_CONTAINMENT_EPS;

/**
 * Predicate for "these two rects are near-duplicate detections of the same
 * visual object". Requires high IoU, similar area, similar aspect ratio, and
 * neither rect strictly containing the other. The area-ratio gate alone rules
 * out every nested-containment case (a child fully inside a parent has area
 * ratio < 1.0 unless the rects are the same size), so valid nested or
 * segmented structure is preserved.
 */
const isDuplicateOf = (a: PixelBounds, b: PixelBounds): boolean => {
  const areaA = boundsArea(a);
  const areaB = boundsArea(b);
  if (areaA <= 0 || areaB <= 0) {
    return false;
  }
  if (intersectionOverUnion(a, b) < DUPLICATE_IOU_MIN) {
    return false;
  }
  const areaRatio = Math.min(areaA, areaB) / Math.max(areaA, areaB);
  if (areaRatio < DUPLICATE_AREA_RATIO_MIN) {
    return false;
  }
  const wA = Math.max(1e-9, a.right - a.left);
  const hA = Math.max(1e-9, a.bottom - a.top);
  const wB = Math.max(1e-9, b.right - b.left);
  const hB = Math.max(1e-9, b.bottom - b.top);
  const arA = wA / hA;
  const arB = wB / hB;
  const arRatio = Math.min(arA, arB) / Math.max(arA, arB);
  if (arRatio < DUPLICATE_ASPECT_RATIO_MIN) {
    return false;
  }
  if (boundsContains(a, b) || boundsContains(b, a)) {
    return false;
  }
  return true;
};

const objectBounds = (object: CvSurfaceObject): PixelBounds => ({
  left: object.bboxSurface.x,
  top: object.bboxSurface.y,
  right: object.bboxSurface.x + object.bboxSurface.width,
  bottom: object.bboxSurface.y + object.bboxSurface.height
});

/**
 * Cross-pipeline dedup: fold the contour, line-grid, and heuristic blob
 * pipelines through a single duplicate-removal pass. Only rects that satisfy
 * `isDuplicateOf` (high IoU + similar area + similar aspect ratio + neither
 * contains the other) are removed. Valid nested or segmented structure
 * survives because containment fails the area-ratio test.
 *
 * Tiebreak when a duplicate pair is found:
 *   1. Polygon-confirmed rectangles (those that passed `isShapeRectangle`)
 *      win over non-confirmed rects.
 *   2. Larger-area rect wins.
 *   3. Smaller objectId wins (lexicographic) for determinism.
 */
const dedupAcrossPipelines = (
  objects: CvSurfaceObject[],
  confirmedIds: ReadonlySet<string>
): CvSurfaceObject[] => {
  if (objects.length <= 1) {
    return objects.slice();
  }
  const sorted = objects
    .map((object) => ({
      object,
      bounds: objectBounds(object),
      area: object.bboxSurface.width * object.bboxSurface.height,
      confirmed: confirmedIds.has(object.objectId)
    }))
    .sort((a, b) => {
      if (a.confirmed !== b.confirmed) {
        return a.confirmed ? -1 : 1;
      }
      if (a.area !== b.area) {
        return b.area - a.area;
      }
      return a.object.objectId.localeCompare(b.object.objectId);
    });

  const kept: { object: CvSurfaceObject; bounds: PixelBounds }[] = [];
  for (const candidate of sorted) {
    let isDup = false;
    for (const winner of kept) {
      if (isDuplicateOf(candidate.bounds, winner.bounds)) {
        isDup = true;
        break;
      }
    }
    if (!isDup) {
      kept.push({ object: candidate.object, bounds: candidate.bounds });
    }
  }
  return kept.map((entry) => entry.object);
};

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
): ScoredRect[] => {
  const scored: ScoredRect[] = (rects as Array<ScoredRect | PixelBounds>).map((entry) =>
    'rect' in entry ? entry : { rect: entry, confirmed: false }
  );
  if (scored.length <= 1) {
    return scored;
  }
  const sorted = scored
    .map((entry) => ({
      entry,
      area:
        Math.max(0, entry.rect.right - entry.rect.left) *
        Math.max(0, entry.rect.bottom - entry.rect.top)
    }))
    .sort((a, b) => {
      if (a.entry.confirmed !== b.entry.confirmed) {
        return a.entry.confirmed ? -1 : 1;
      }
      return b.area - a.area;
    });
  const kept: ScoredRect[] = [];
  for (const { entry } of sorted) {
    let suppressed = false;
    for (const accepted of kept) {
      if (intersectionOverUnion(entry.rect, accepted.rect) >= iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) {
      kept.push(entry);
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
  backgroundThreshold: number,
  foregroundMask: Uint8Array | null = null
): PixelBounds | null => {
  const { width, height, data } = pixels;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * 4;
    const pixelRow = y * width;
    let rowHasContent = false;
    for (let x = 0; x < width; x += 1) {
      let isForeground: boolean;
      if (foregroundMask) {
        isForeground = foregroundMask[pixelRow + x] === 1;
      } else {
        const i = rowStart + x * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        isForeground =
          !(a < 8 ||
            (r >= backgroundThreshold && g >= backgroundThreshold && b >= backgroundThreshold));
      }
      if (isForeground) {
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

/**
 * Sobel-like gradient threshold above which a pixel counts as "edge evidence".
 *
 * The kernel used here is the standard 3×3 Sobel (Gx = [[-1,0,1],[-2,0,2],
 * [-1,0,1]], Gy transposed). For a clean axis-aligned step of magnitude Δ in
 * luminance, |Gx| or |Gy| ≈ 4·Δ. Capture noise on anti-aliased UI strokes
 * sits at roughly |Gx|+|Gy| ≈ 12–16. A floor of 24 admits panel borders
 * whose contrast against the page is Δ ≈ 6 luminance units while staying
 * above ambient noise — the rounded-corner Reddit profile card (Δ ≈ 13)
 * produces gradients of ~52, well above this floor.
 *
 * The floor is intentionally conservative: lowering it further would start
 * marking text-anti-aliasing seams as foreground and re-introduce the noise
 * the global luminance threshold was tuned to suppress.
 */
const GRADIENT_FOREGROUND_FLOOR = 24;

/**
 * Build a per-pixel foreground mask from BOTH the existing global luminance
 * threshold AND a Sobel-equivalent local gradient magnitude pass. A pixel is
 * foreground if (a) the global threshold marks it OR (b) its 3×3 Sobel
 * response exceeds the gradient floor.
 *
 * Why this is needed:
 *   The heuristic fallback classifies pixels with a single global luminance
 *   threshold derived from the page perimeter median. On a dark page (lum ≈ 12)
 *   with a Reddit-style profile card (lum ≈ 25), the inverted threshold lands
 *   at ~225 and the inverted panel pixel at ~230 — the panel reads as
 *   background, while only its high-contrast contents (white text, blue
 *   buttons) survive. A global widen would pull glyph noise back in. Local
 *   gradient evidence catches the panel border (Δ ≈ 13 produces |Gx|≈52,
 *   well above the floor) without disturbing the global tolerance band, so
 *   the rounded-corner outline forms a closed connected component whose
 *   bounding box is the panel rect.
 */
const computeForegroundMask = (
  pixels: ImageData,
  backgroundThreshold: number
): Uint8Array => {
  const { width, height, data } = pixels;
  const mask = new Uint8Array(width * height);

  // Pre-compute luminance once per pixel — Sobel needs neighborhood reads
  // and recomputing 0.299·r + 0.587·g + 0.114·b nine times per pixel is the
  // hottest path in the heuristic detector on a 2000-wide raster.
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    if (data[i + 3] < 8) {
      lum[p] = 255; // transparent → treat as background-bright for gradient purposes
    } else {
      lum[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
    }
  }

  // 1) Global-threshold foreground: same predicate as detectConnectedBounds
  //    used pre-fix. Kept verbatim so the existing dark-UI / ruled-form tests
  //    classify pixels exactly the way they did before.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      const isBg =
        a < 8 ||
        (r >= backgroundThreshold && g >= backgroundThreshold && b >= backgroundThreshold);
      if (!isBg) {
        mask[y * width + x] = 1;
      }
    }
  }

  // 2) Gradient-evidence foreground: 3×3 Sobel on the luminance grid. Skipped
  //    on the 1-pixel border (insufficient neighborhood) — those edge pixels
  //    keep whatever the global threshold assigned them.
  for (let y = 1; y < height - 1; y += 1) {
    const rowAbove = (y - 1) * width;
    const row = y * width;
    const rowBelow = (y + 1) * width;
    for (let x = 1; x < width - 1; x += 1) {
      const tl = lum[rowAbove + x - 1];
      const tc = lum[rowAbove + x];
      const tr = lum[rowAbove + x + 1];
      const ml = lum[row + x - 1];
      const mr = lum[row + x + 1];
      const bl = lum[rowBelow + x - 1];
      const bc = lum[rowBelow + x];
      const br = lum[rowBelow + x + 1];
      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const magnitude = (gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy);
      if (magnitude >= GRADIENT_FOREGROUND_FLOOR) {
        mask[row + x] = 1;
      }
    }
  }

  return mask;
};

interface ConnectedComponent extends PixelBounds {
  /** Count of foreground pixels in the connected component (the "filled" area). */
  pixelArea: number;
}

/**
 * Count luminance-only foreground pixels inside a bounding box. This is the
 * "ink core" measurement used by the heuristic blob fill-ratio gate: it
 * counts only pixels that pass the global luminance threshold, ignoring
 * gradient-only foreground that came from Sobel halo. Without this distinction
 * the Sobel halo around a 1-px ink stroke fills hollow glyphs (a figure-8
 * bbox-fill rises from 0.28 → 0.72) and the fill-ratio gate stops
 * distinguishing glyphs from real shapes.
 */
const countLuminanceForegroundInBbox = (
  pixels: ImageData,
  backgroundThreshold: number,
  bbox: PixelBounds
): number => {
  const { width, data } = pixels;
  let count = 0;
  for (let y = bbox.top; y < bbox.bottom; y += 1) {
    for (let x = bbox.left; x < bbox.right; x += 1) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      const isBg =
        a < 8 ||
        (r >= backgroundThreshold && g >= backgroundThreshold && b >= backgroundThreshold);
      if (!isBg) {
        count += 1;
      }
    }
  }
  return count;
};

const detectConnectedBounds = (
  pixels: ImageData,
  backgroundThreshold: number,
  minObjectAreaPx: number,
  foregroundMask: Uint8Array | null = null
): ConnectedComponent[] => {
  const { width, height, data } = pixels;
  const visited = new Uint8Array(width * height);
  const components: ConnectedComponent[] = [];
  const queue = new Int32Array(width * height);

  const isForeground = (x: number, y: number): boolean => {
    if (foregroundMask) {
      return foregroundMask[y * width + x] === 1;
    }
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
        components.push({ left, top, right: right + 1, bottom: bottom + 1, pixelArea: area });
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

/**
 * Apply the shared glyph-suppression gates to line-bounded cell rects. Cells
 * are by construction rectangles bounded by 4 detected line segments, so the
 * aspect-ratio and fill-ratio gates are vacuous (`confirmed=true`,
 * `fillRatio=1`). The min-side floor is the only test that can drop a cell,
 * which protects against degenerate sliver cells produced when two parallel
 * lines sit a couple of pixels apart.
 */
const filterCellRectsForGlyphs = (
  rects: SharedPixelBounds[],
  surfaceWidth: number,
  surfaceHeight: number
): SharedPixelBounds[] => {
  const minSidePx = computeGlyphMinSidePx(surfaceWidth, surfaceHeight);
  return rects.filter((bounds) => {
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    return passesGlyphSuppression({ width, height }, true, 1, minSidePx);
  });
};

const detectHeuristicSurfaceObjects = (
  pixels: ImageData,
  backgroundThreshold: number,
  thresholds: SizeRelativeThresholds,
  foregroundMask: Uint8Array
): CvSurfaceObject[] => {
  const { width, height } = pixels;
  const objects: CvSurfaceObject[] = [];
  const minSidePx = computeGlyphMinSidePx(width, height);

  // 1. Connected components — kept for non-line-bounded shapes (logos, signatures).
  //    Glyph-shaped noise is rejected via the shared glyph-suppression gate
  //    (min-side floor + bbox fill-ratio), and line-shaped blobs are skipped
  //    because they belong to the line-grid pipeline.
  const components = detectConnectedBounds(
    pixels,
    backgroundThreshold,
    thresholds.minObjectAreaPx,
    foregroundMask
  );
  // Heuristic equivalent of `isShapeRectangle`: a connected component large
  // enough that it cannot plausibly be a glyph is presumed rectangular and
  // bypasses the fill-ratio / aspect-ratio gates. This keeps outline-only
  // panels (whose connected pixels are just the 1-px border ring, ~2% of
  // bbox) from being falsely culled by the fill-ratio gate. The 4×
  // multiplier sits above realistic glyph heights (a 24-pt cap letter on a
  // 4K capture is still ~3× minSidePx) while admitting the smallest UI
  // tiles we want to keep.
  const presumedRectangleThreshold = 4 * minSidePx;
  let id = 0;
  for (const component of components) {
    const bounds = clampRectToSurface(width, height, component);
    const rect = boundsToRect(bounds);
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    if (isLineShaped(rect, thresholds)) {
      continue; // a 1D line is a primitive, not an object
    }
    const bboxArea = Math.max(1, rect.width * rect.height);
    // Glyph fill-ratio is measured against the LUMINANCE-only foreground
    // count, not the gradient-augmented mask, because Sobel response
    // produces a 1-px halo around every black ink stroke and that halo
    // alone is enough to push a hollow 12×18 figure-8 above 0.55. For
    // gradient-only components (low-Δ panel borders whose pixels are
    // background under the luminance test), no luminance core exists and
    // the fill-ratio gate is bypassed so the panel survives — its size
    // already triggers the `presumedRectangular` bypass anyway.
    const luminanceCore = countLuminanceForegroundInBbox(
      pixels,
      backgroundThreshold,
      bounds
    );
    const fillRatio = luminanceCore > 0 ? luminanceCore / bboxArea : 1;
    const presumedRectangular = Math.min(rect.width, rect.height) >= presumedRectangleThreshold;
    if (!passesGlyphSuppression(rect, presumedRectangular, fillRatio, minSidePx)) {
      continue;
    }
    const pageArea = Math.max(1, width * height);
    objects.push({
      objectId: `obj_blob_${id++}`,
      bboxSurface: rect,
      confidence: Math.min(0.99, 0.62 + Math.min(1, bboxArea / pageArea) * 0.38)
    });
  }

  // 2. Shared line-grid pipeline: line-bounded rects only. Cells are by
  //    construction rectangles — they automatically pass the aspect/fill
  //    gates and only the min-side floor is meaningful here.
  const segments = detectLineSegments(pixels, backgroundThreshold, thresholds, foregroundMask);
  const cellRects = filterCellRectsForGlyphs(
    buildLineBoundedRects(segments, {
      surfaceWidth: width,
      surfaceHeight: height
    }),
    width,
    height
  );
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
  // Compute the gradient-augmented foreground mask once and reuse it for
  // surface-object detection. The mask combines the existing global
  // luminance test with a 3×3 Sobel pass so a Δ ≈ 13 panel border survives
  // a global threshold tuned to suppress text anti-aliasing.
  //
  // For content-bounds we first try the luminance-only predicate so the
  // canonical "black rect on white page" test continues to report the exact
  // ink rectangle (Sobel response leaks 1 px into surrounding background and
  // would inflate the rect). Only if that predicate finds nothing — the
  // dark-page-low-Δ-panel case where every pixel reads as background under
  // the global threshold — do we fall back to the gradient-augmented mask
  // so the panel border has a chance to drive the bounds.
  const foregroundMask = computeForegroundMask(input.pixels, backgroundThreshold);
  let bounds = computeContentBoundsFromPixels(input.pixels, backgroundThreshold);
  if (!bounds) {
    bounds = computeContentBoundsFromPixels(input.pixels, backgroundThreshold, foregroundMask);
  }
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
    objectsSurface: detectHeuristicSurfaceObjects(
      input.pixels,
      backgroundThreshold,
      thresholds,
      foregroundMask
    )
  };
};

const buildObjectsFromContourRects = (
  rects: ScoredRect[],
  surfaceWidth: number,
  surfaceHeight: number,
  idPrefix: string,
  confidenceBase: number,
  thresholds: SizeRelativeThresholds,
  options: { skipLineShaped?: boolean } = {}
): CvSurfaceObject[] => {
  const pageArea = Math.max(1, surfaceWidth * surfaceHeight);
  const minSidePx = computeGlyphMinSidePx(surfaceWidth, surfaceHeight);

  return rects
    .map((scored, index) => {
      const rect = boundsToRect(clampRectToSurface(surfaceWidth, surfaceHeight, scored.rect));
      const area = rect.width * rect.height;
      if (rect.width <= 0 || rect.height <= 0 || area < thresholds.minObjectAreaPx) {
        return null;
      }
      if (options.skipLineShaped && isLineShaped(rect, thresholds)) {
        return null;
      }
      // Glyph-suppression gates: min-side floor, then aspect-ratio and
      // fill-ratio gates that confirmed rectangles bypass.
      const fillRatio = scored.fillRatio ?? (scored.confirmed ? 1 : 0);
      if (!passesGlyphSuppression(rect, scored.confirmed, fillRatio, minSidePx)) {
        return null;
      }

      // Polygon-confirmed contours (4 vertices, convex, ~90° corners,
      // ≥85% bbox fill) are shape-evidence rectangles — they deserve the
      // same baseline as a 4-line-bounded cell so simple boxes (HEADER,
      // SIDEBAR, FOOTER, page boundary) clear the SIMPLE-overlay
      // confidence floor (0.75) instead of being filtered out at render
      // time. Non-confirmed contour rects keep the lower 0.62 base.
      const effectiveBase = scored.confirmed ? 0.78 : confidenceBase;
      return {
        objectId: `${idPrefix}_${index}`,
        bboxSurface: rect,
        confidence: Math.min(0.99, effectiveBase + Math.min(1, area / pageArea) * (1 - effectiveBase))
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
        // Bounding-rect fill ratio = contourArea / (rect.width * rect.height).
        // Glyph contours fill 0.25–0.45 of their bbox (a hollow 8 ≈ 0.30); UI
        // panel borders fill ≈1.0. The downstream gate uses this to reject
        // text-shaped contours without inspecting individual pixels. When the
        // runtime does not expose contourArea (mocks, stripped builds), we
        // default to 1 so the gate is a no-op rather than a silent culling.
        let fillRatio = 1;
        if (typeof cv.contourArea === 'function') {
          try {
            const contourArea = Math.abs(cv.contourArea(contour));
            const bboxArea = Math.max(1, rect.width * rect.height);
            fillRatio = contourArea / bboxArea;
          } catch {
            fillRatio = 1;
          }
        }
        contourRects.push({
          rect: {
            left: rect.x,
            top: rect.y,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height
          },
          confirmed,
          fillRatio
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
    const contourIdPrefix = 'obj_cv';
    const objectsFromContours = buildObjectsFromContourRects(
      mergedContourRects,
      surface.surfaceWidth,
      surface.surfaceHeight,
      contourIdPrefix,
      0.62,
      thresholds,
      { skipLineShaped: true }
    );
    // Track which surface objects came from polygon-confirmed contours so the
    // cross-pipeline dedup tiebreak can prefer them over non-confirmed
    // duplicates. Cell rects are bounded by 4 detected line segments and are
    // treated as confirmed by construction.
    const confirmedIds = new Set<string>();
    mergedContourRects.forEach((scored, index) => {
      if (scored.confirmed) {
        confirmedIds.add(`${contourIdPrefix}_${index}`);
      }
    });
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
    const lineGridDiagnostics: LineBoundedRectsDiagnostics = {
      rectsBeforeFilter: 0,
      subblocksDropped: 0
    };
    const cellRects = filterCellRectsForGlyphs(
      buildLineBoundedRects(sharedSegments, {
        surfaceWidth: surface.surfaceWidth,
        surfaceHeight: surface.surfaceHeight,
        diagnostics: lineGridDiagnostics
      }) as SharedPixelBounds[],
      surface.surfaceWidth,
      surface.surfaceHeight
    );
    const objectsFromCells: CvSurfaceObject[] = lineBoundedRectsToObjects(
      cellRects,
      {
        idPrefix: 'obj_cv_cell',
        surfaceWidth: surface.surfaceWidth,
        surfaceHeight: surface.surfaceHeight
      }
    );
    for (const cellObject of objectsFromCells) {
      confirmedIds.add(cellObject.objectId);
    }

    const dedupedObjects = dedupAcrossPipelines(
      [...objectsFromContours, ...objectsFromLines, ...objectsFromCells],
      confirmedIds
    );

    // Single-line worker-side diagnostic so the next iteration can verify
    // the (a)/(b)/(c) impact empirically against the benchmark layout.
    //  - objects_after_a: line-bounded rects surviving the leaf-or-outermost filter.
    //  - objects_after_b: contour rects emitted after the confidence boost
    //    (count is unchanged; the boost only affects the confidence value).
    //  - simple_boxes_detected: confirmed contour rects whose footprint
    //    is ≥2% of the page area — the simple HEADER/SIDEBAR/FOOTER class.
    //  - grid_subblocks_dropped: sub-block unions removed by step (a).
    const pageArea = Math.max(1, surface.surfaceWidth * surface.surfaceHeight);
    const simpleBoxesDetected = mergedContourRects.reduce((count, scored) => {
      if (!scored.confirmed) {
        return count;
      }
      const w = Math.max(0, scored.rect.right - scored.rect.left);
      const h = Math.max(0, scored.rect.bottom - scored.rect.top);
      return (w * h) / pageArea >= 0.02 ? count + 1 : count;
    }, 0);
    // eslint-disable-next-line no-console
    console.warn(
      `[structural-worker] objects_after_a=${objectsFromCells.length} ` +
        `objects_after_b=${objectsFromContours.length} ` +
        `simple_boxes_detected=${simpleBoxesDetected} ` +
        `grid_subblocks_dropped=${lineGridDiagnostics.subblocksDropped}`
    );

    const contentBounds =
      unionBounds([...mergedContourRects.map((entry) => entry.rect), ...lineRects]) ??
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
        objectsSurface: dedupedObjects
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
        objectsSurface: dedupedObjects
      };
    }

    return {
      executionMode: 'opencv-runtime',
      contentRectSurface,
      objectsSurface: dedupedObjects
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
