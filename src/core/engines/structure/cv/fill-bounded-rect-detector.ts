/**
 * Fill-bounded rectangle detection via histogram-peak quantization.
 *
 * The line-grid pipeline finds rectangles whose four sides are all visible as
 * line segments. Modern UI captures (Gmail bill cards, Reddit profile cards,
 * dashboard panels) routinely encode hierarchy with NO visible stroke at all
 * — the card is just a fill color a few luminance units away from the page
 * background, with rounded corners. There are no lines for the line-grid
 * detector to find, no strong gradients for Canny to fire on, and no
 * connected component large enough to survive the heuristic flood fill in a
 * useful shape (every non-background pixel on the page joins through text).
 *
 * This module finds those cards directly. The earlier version of this file
 * used a single "mid-fill" delta band [3, 60) and ran 4-connected components
 * on every pixel in that band — which fused the Gmail header, sidebar, body
 * shading, bookmarks bar, card, and dock all into ONE giant component
 * because they sit within ~10 luminance units of each other and were
 * 4-connected through narrow whitespace strips.
 *
 * The current version quantizes by luminance HISTOGRAM peaks instead:
 * 1. Build a luminance histogram, smooth it, find local-maxima peaks above
 *    a count floor.
 * 2. Cluster peaks within `peakSeparation` so noise sub-peaks merge but
 *    distinct surfaces (Δ ≥ peakSeparation apart) stay separate.
 * 3. Filter to "fill peaks" — peaks whose distance from the page background
 *    is in [bgTolerance, fillUpperDelta). The page-bg peak is excluded;
 *    text peaks (very far from bg) are excluded.
 * 4. Assign each pixel to the nearest fill peak within a window. Pixels
 *    between peaks are unassigned (they're transition / anti-alias smear,
 *    not part of any surface body).
 * 5. Run CC per peak. Each surface's body forms its own component.
 *
 * Inputs are normalized to "light page, dark content" upstream by the
 * adapter's `normalizeRasterForLightBackground` pass, so we can assume the
 * page background sits near the top of the luminance scale.
 */

export interface FillBoundedRectsPixelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FillBoundedRectsOptions {
  surfaceWidth: number;
  surfaceHeight: number;
  /**
   * Page-background luminance reference. Typically the perimeter median that
   * the adapter already computes for `BackgroundProfile`. Pixels within
   * `bgTolerance` of this value are background.
   */
  pageBackgroundLuminance: number;
  /** Peaks within this distance from page bg are treated as background. */
  bgTolerance?: number;
  /**
   * Peaks farther than this from page bg are treated as high-contrast (text /
   * icon) and excluded — their pixels are NOT used to form fill components.
   * Inside a card surface those pixels become "holes" the surrounding fill
   * flows around, which is the behavior we want.
   */
  fillUpperDelta?: number;
  /** Min component pixel area. */
  minComponentAreaPx?: number;
  /**
   * Min ratio (component pixels / bbox area). A real card with sparse text
   * sits at 0.7–0.95; long horizontal banners at 0.95+; a fragmented noisy
   * region at 0.2. The default 0.5 admits text-dense panels while still
   * rejecting incidental L-shaped or sliver fills.
   */
  minRectangularity?: number;
  /** Min side length (px). Below this a component is treated as glyph-noise. */
  minSidePx?: number;
  /**
   * Cluster raw peaks within this many luminance bins into a single
   * representative. With smoothing this almost always collapses one
   * surface's quantization noise into one canonical peak. Default 2 means
   * peaks 1 bin apart merge but peaks ≥ 2 bins apart stay distinct, which
   * preserves separation between e.g. a card at 246 and a sidebar at 248.
   */
  peakSeparation?: number;
  /**
   * Minimum number of pixels a peak must contain to be considered a real
   * surface. An absolute pixel floor is more honest than a fraction-of-page
   * floor: a button-class object is ~1500–3000 px regardless of capture
   * size, so the same threshold should apply on a 600×500 test raster and a
   * 2600×1700 real screenshot. The previous fraction-based default (0.1%)
   * filtered button-sized peaks out of large screenshots while admitting
   * stray noise on small synthetic test rasters.
   */
  minPeakAreaPx?: number;
}

const DEFAULT_BG_TOLERANCE = 3;
const DEFAULT_FILL_UPPER_DELTA = 60;
const DEFAULT_MIN_COMPONENT_AREA_PX = 600;
const DEFAULT_MIN_RECTANGULARITY = 0.5;
const DEFAULT_MIN_SIDE_PX = 24;
const DEFAULT_PEAK_SEPARATION = 2;
/**
 * Default ~600 px floor — same as `DEFAULT_MIN_COMPONENT_AREA_PX`. A peak
 * with fewer pixels cannot produce a single component that meets the
 * component-area floor, so admitting it is wasted work. On a 36×36 emoji
 * button the body luminance bin holds ~800 pixels after anti-aliasing trims
 * the corners, which clears this floor with ~25% margin.
 */
const DEFAULT_MIN_PEAK_AREA_PX = 600;

const luminanceAt = (data: Uint8ClampedArray, i: number): number =>
  0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

interface FillComponent extends FillBoundedRectsPixelBounds {
  pixelArea: number;
}

interface PeakAssignment {
  /** Per-pixel peak index, or 255 if unassigned. */
  pixelToPeak: Uint8Array;
  /** Number of fill peaks. Valid peak indices are 0..fillPeakCount−1. */
  fillPeakCount: number;
}

/**
 * Build a histogram-peak assignment over the raster's luminance. Pixels are
 * tagged with the index of the nearest fill peak (0..N−1), or 255 when no
 * fill peak is within the assignment window.
 */
const buildPeakAssignment = (
  pixels: ImageData,
  pageBg: number,
  bgTolerance: number,
  fillUpperDelta: number,
  peakSeparation: number,
  minPeakAreaPx: number
): PeakAssignment | null => {
  const { width, height, data } = pixels;
  const histogram = new Uint32Array(256);
  let totalSampled = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) {
      continue;
    }
    const lum = luminanceAt(data, i) | 0;
    histogram[lum] += 1;
    totalSampled += 1;
  }
  if (totalSampled === 0) {
    return null;
  }

  // 3-tap moving average smooths out single-bin quantization noise without
  // erasing genuine 2-bin-apart peaks.
  const smoothed = new Float64Array(256);
  for (let b = 0; b < 256; b += 1) {
    let sum = histogram[b];
    let count = 1;
    if (b > 0) {
      sum += histogram[b - 1];
      count += 1;
    }
    if (b < 255) {
      sum += histogram[b + 1];
      count += 1;
    }
    smoothed[b] = sum / count;
  }

  // A bin is a raw peak iff it is a (non-strict) local maximum AND its
  // smoothed count clears the absolute min-peak floor. Non-strict equality
  // lets a flat plateau register as one peak (we'll deduplicate with the
  // peakSeparation clustering step below).
  const minPeakCount = Math.max(1, minPeakAreaPx);
  const rawPeaks: number[] = [];
  for (let b = 0; b < 256; b += 1) {
    if (smoothed[b] < minPeakCount) {
      continue;
    }
    const left = b > 0 ? smoothed[b - 1] : -1;
    const right = b < 255 ? smoothed[b + 1] : -1;
    if (smoothed[b] >= left && smoothed[b] >= right) {
      rawPeaks.push(b);
    }
  }
  if (rawPeaks.length === 0) {
    return null;
  }

  // Greedy peak clustering by descending strength. The strongest peak claims
  // every bin within `peakSeparation` of itself; weaker neighbors lose. This
  // is how a single anti-aliased plateau collapses to one representative.
  const sortedByStrength = [...rawPeaks].sort((a, b) => smoothed[b] - smoothed[a]);
  const claimed: number[] = [];
  for (const p of sortedByStrength) {
    let conflict = false;
    for (const q of claimed) {
      if (Math.abs(q - p) <= peakSeparation) {
        conflict = true;
        break;
      }
    }
    if (!conflict) {
      claimed.push(p);
    }
  }

  // Fill peaks: distance from pageBg in [bgTolerance, fillUpperDelta).
  const fillPeaks = claimed
    .filter((p) => {
      const d = Math.abs(p - pageBg);
      return d >= bgTolerance && d < fillUpperDelta;
    })
    .sort((a, b) => a - b);
  if (fillPeaks.length === 0) {
    return null;
  }
  if (fillPeaks.length > 254) {
    // Reserve 255 for "unassigned." If a pathological histogram has > 254
    // distinct fill peaks, drop the weakest extras.
    const ranked = [...fillPeaks].sort((a, b) => smoothed[b] - smoothed[a]).slice(0, 254);
    fillPeaks.length = 0;
    fillPeaks.push(...ranked.sort((a, b) => a - b));
  }

  // Per-luminance lookup: for each lum in 0..255, which fill peak (if any)
  // claims it? Window radius is half the peak separation so adjacent peaks
  // tile the axis without overlap.
  const windowRadius = Math.max(1, Math.floor(peakSeparation / 2));
  const lumToPeakIdx = new Uint8Array(256).fill(255);
  for (let lum = 0; lum < 256; lum += 1) {
    let bestIdx = 255;
    let bestDist = Infinity;
    for (let i = 0; i < fillPeaks.length; i += 1) {
      const d = Math.abs(lum - fillPeaks[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestDist <= windowRadius) {
      lumToPeakIdx[lum] = bestIdx;
    }
  }

  const pixelToPeak = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 8) {
        continue;
      }
      const lum = luminanceAt(data, i) | 0;
      pixelToPeak[y * width + x] = lumToPeakIdx[lum];
    }
  }

  return { pixelToPeak, fillPeakCount: fillPeaks.length };
};

const findComponentsForPeak = (
  pixelToPeak: Uint8Array,
  targetPeak: number,
  width: number,
  height: number,
  minAreaPx: number,
  scratchVisited: Uint8Array,
  scratchQueue: Int32Array
): FillComponent[] => {
  // We share `scratchVisited` across peaks but mark visits per peak by
  // setting bit 0; callers must clear it between peaks. (Done by the
  // top-level loop below — cheaper than allocating a fresh Uint8Array per
  // peak on a multi-megapixel raster.)
  const components: FillComponent[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const seed = y * width + x;
      if (scratchVisited[seed] === 1) {
        continue;
      }
      if (pixelToPeak[seed] !== targetPeak) {
        scratchVisited[seed] = 1;
        continue;
      }

      let head = 0;
      let tail = 0;
      scratchQueue[tail++] = seed;
      scratchVisited[seed] = 1;

      let left = x;
      let right = x;
      let top = y;
      let bottom = y;
      let area = 0;

      while (head < tail) {
        const idx = scratchQueue[head++];
        const qx = idx % width;
        const qy = (idx / width) | 0;
        area += 1;
        if (qx < left) left = qx;
        if (qx > right) right = qx;
        if (qy < top) top = qy;
        if (qy > bottom) bottom = qy;

        if (qx > 0) {
          const n = idx - 1;
          if (scratchVisited[n] === 0) {
            scratchVisited[n] = 1;
            if (pixelToPeak[n] === targetPeak) scratchQueue[tail++] = n;
          }
        }
        if (qx < width - 1) {
          const n = idx + 1;
          if (scratchVisited[n] === 0) {
            scratchVisited[n] = 1;
            if (pixelToPeak[n] === targetPeak) scratchQueue[tail++] = n;
          }
        }
        if (qy > 0) {
          const n = idx - width;
          if (scratchVisited[n] === 0) {
            scratchVisited[n] = 1;
            if (pixelToPeak[n] === targetPeak) scratchQueue[tail++] = n;
          }
        }
        if (qy < height - 1) {
          const n = idx + width;
          if (scratchVisited[n] === 0) {
            scratchVisited[n] = 1;
            if (pixelToPeak[n] === targetPeak) scratchQueue[tail++] = n;
          }
        }
      }

      if (area >= minAreaPx) {
        components.push({
          left,
          top,
          right: right + 1,
          bottom: bottom + 1,
          pixelArea: area
        });
      }
    }
  }
  return components;
};

/**
 * Detect fill-bounded rectangles via histogram-peak quantization. Each
 * distinct fill peak's connected components are tested independently, so
 * surfaces whose luminance differs by ≥ `peakSeparation` bins do NOT fuse
 * into one giant blob via 4-connected adjacency the way the previous single-
 * band approach did.
 */
export const detectFillBoundedRects = (
  pixels: ImageData,
  options: FillBoundedRectsOptions
): FillBoundedRectsPixelBounds[] => {
  const { width, height } = pixels;
  if (width <= 0 || height <= 0) {
    return [];
  }
  const bgTolerance = options.bgTolerance ?? DEFAULT_BG_TOLERANCE;
  const fillUpperDelta = options.fillUpperDelta ?? DEFAULT_FILL_UPPER_DELTA;
  const minAreaPx = options.minComponentAreaPx ?? DEFAULT_MIN_COMPONENT_AREA_PX;
  const minRectangularity = options.minRectangularity ?? DEFAULT_MIN_RECTANGULARITY;
  const minSidePx = options.minSidePx ?? DEFAULT_MIN_SIDE_PX;
  const peakSeparation = options.peakSeparation ?? DEFAULT_PEAK_SEPARATION;
  const minPeakAreaPx = options.minPeakAreaPx ?? DEFAULT_MIN_PEAK_AREA_PX;

  const assignment = buildPeakAssignment(
    pixels,
    options.pageBackgroundLuminance,
    bgTolerance,
    fillUpperDelta,
    peakSeparation,
    minPeakAreaPx
  );
  if (!assignment) {
    return [];
  }

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const out: FillBoundedRectsPixelBounds[] = [];
  for (let peakIdx = 0; peakIdx < assignment.fillPeakCount; peakIdx += 1) {
    visited.fill(0);
    const components = findComponentsForPeak(
      assignment.pixelToPeak,
      peakIdx,
      width,
      height,
      minAreaPx,
      visited,
      queue
    );
    for (const c of components) {
      const w = c.right - c.left;
      const h = c.bottom - c.top;
      if (w < minSidePx || h < minSidePx) {
        continue;
      }
      const bboxArea = w * h;
      if (bboxArea <= 0) {
        continue;
      }
      if (c.pixelArea / bboxArea < minRectangularity) {
        continue;
      }
      out.push({ left: c.left, top: c.top, right: c.right, bottom: c.bottom });
    }
  }
  return out;
};
