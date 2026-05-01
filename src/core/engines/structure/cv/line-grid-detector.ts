import type { CvSurfaceObject } from './cv-adapter';

/**
 * Shared structural primitive: line-bounded rectangle detection.
 *
 * Both the heuristic fallback and the OpenCV runtime path delegate
 * line-bounded rect detection to this module so that identical documents
 * produce comparable structure regardless of CV mode (config and run use
 * the same detection logic).
 *
 * Why "lines first, then rectangles" instead of contour-first:
 *  - A ruled form is *defined* by its straight rules. The interiors are
 *    background pixels, so connected-component flood fill cannot find them
 *    directly — it finds the text inside, not the bounded regions.
 *  - Internal contours (`RETR_EXTERNAL`) are silently discarded. We instead
 *    reconstruct line-bounded rectangles from line segments, which gives us
 *    every nested child object and the outermost outline in a single pass.
 *
 * Line segments themselves are NOT emitted as objects. They are an internal
 * primitive used to discover line-bounded objects. Only the bounded rects
 * become structural objects; everything in the model is just an object.
 */

export interface PixelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SizeRelativeThresholds {
  /** Minimum area (px^2) below which contour blobs are dropped as word-noise. */
  minObjectAreaPx: number;
  /** Minimum length (px) for a stripe to qualify as a line. */
  minLineLengthPx: number;
  /** Maximum thickness (px) for a stripe to be classified as a line, not a blob. */
  maxLineThicknessPx: number;
}

export interface LineSegment {
  /** y for horizontals, x for verticals — the axis-perpendicular position. */
  axisPos: number;
  thickness: number;
  /** primary axis start (x for h, y for v). */
  start: number;
  /** primary axis end (x for h, y for v), exclusive. */
  end: number;
}

export interface LineSegments {
  horizontals: LineSegment[];
  verticals: LineSegment[];
}

const isBgAt = (data: Uint8ClampedArray, i: number, threshold: number): boolean =>
  data[i + 3] < 8 ||
  (data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold);

/**
 * Foreground predicate for a single pixel. When `foregroundMask` is provided,
 * it overrides the per-channel luminance test — this is how the gradient-aware
 * predicate from `opencv-js-adapter` plugs in extra foreground evidence
 * (panel borders whose luminance is within the global tolerance band but
 * whose local gradient is above the noise floor).
 */
const isFgAt = (
  data: Uint8ClampedArray,
  i: number,
  threshold: number,
  foregroundMask: Uint8Array | null,
  pixelIndex: number
): boolean => {
  if (foregroundMask) {
    return foregroundMask[pixelIndex] === 1;
  }
  return !isBgAt(data, i, threshold);
};

interface RowRun {
  start: number;
  end: number; // exclusive
}

/**
 * Find ALL qualifying horizontal runs of foreground pixels in row `y`. Small
 * gaps (<= maxGap pixels) within a run are tolerated to handle anti-aliased
 * lines. Returns every run whose length >= minLineLengthPx.
 *
 * Why "all" instead of "longest": a complex UI layout has multiple parallel
 * boxes whose top/bottom borders share rows. The previous "longest only"
 * scan silently dropped every shorter parallel border, which is why the
 * detector found the right grid (whose lines are the longest in their rows)
 * but missed the sidebar, target, info box, details box, notes box, and
 * every nested sub-element that shared a y-coordinate with a longer line.
 */
const allForegroundRunsInRow = (
  data: Uint8ClampedArray,
  width: number,
  y: number,
  threshold: number,
  minLineLengthPx: number,
  maxGap: number,
  foregroundMask: Uint8Array | null
): RowRun[] => {
  const rowBase = y * width * 4;
  const pixelRowBase = y * width;
  const runs: RowRun[] = [];
  let curStart = -1;
  let curEnd = -1;
  let gap = 0;
  for (let x = 0; x < width; x += 1) {
    const fg = isFgAt(data, rowBase + x * 4, threshold, foregroundMask, pixelRowBase + x);
    if (fg) {
      if (curStart < 0) {
        curStart = x;
      }
      curEnd = x + 1;
      gap = 0;
    } else if (curStart >= 0) {
      gap += 1;
      if (gap > maxGap) {
        const len = curEnd - curStart;
        if (len >= minLineLengthPx) {
          runs.push({ start: curStart, end: curEnd });
        }
        curStart = -1;
        curEnd = -1;
        gap = 0;
      }
    }
  }
  if (curStart >= 0) {
    const len = curEnd - curStart;
    if (len >= minLineLengthPx) {
      runs.push({ start: curStart, end: curEnd });
    }
  }
  return runs;
};

const allForegroundRunsInColumn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  threshold: number,
  minLineLengthPx: number,
  maxGap: number,
  foregroundMask: Uint8Array | null
): RowRun[] => {
  const runs: RowRun[] = [];
  let curStart = -1;
  let curEnd = -1;
  let gap = 0;
  for (let y = 0; y < height; y += 1) {
    const pixelIndex = y * width + x;
    const fg = isFgAt(data, pixelIndex * 4, threshold, foregroundMask, pixelIndex);
    if (fg) {
      if (curStart < 0) {
        curStart = y;
      }
      curEnd = y + 1;
      gap = 0;
    } else if (curStart >= 0) {
      gap += 1;
      if (gap > maxGap) {
        const len = curEnd - curStart;
        if (len >= minLineLengthPx) {
          runs.push({ start: curStart, end: curEnd });
        }
        curStart = -1;
        curEnd = -1;
        gap = 0;
      }
    }
  }
  if (curStart >= 0) {
    const len = curEnd - curStart;
    if (len >= minLineLengthPx) {
      runs.push({ start: curStart, end: curEnd });
    }
  }
  return runs;
};

const overlapFraction = (a: RowRun, b: RowRun): number => {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  if (end <= start) {
    return 0;
  }
  const overlap = end - start;
  const denom = Math.max(a.end - a.start, b.end - b.start, 1);
  return overlap / denom;
};

interface ActiveStripe {
  startScan: number;
  current: RowRun;
}

const STRIPE_OVERLAP_THRESHOLD = 0.6;

/**
 * Build line segments from a per-scanline list of qualifying foreground runs.
 * Multiple stripes can be active concurrently — when a row carries N runs that
 * line up with N different already-active stripes, every stripe gets extended.
 *
 * The pre-multi-run version assumed at most one stripe was alive at any time,
 * which is fine for synthetic test rasters but collapsed the moment a real UI
 * had two parallel borders sharing a row. Greedy best-overlap matching pairs
 * each active stripe with the run that overlaps it most; unpaired runs spawn
 * fresh stripes; unpaired stripes close out and are emitted if their thickness
 * stays under `maxLineThicknessPx` (i.e. they really are line-shaped, not
 * 2D blocks).
 */
const buildStripeSegments = (
  runsPerScan: RowRun[][],
  scanLength: number,
  maxLineThicknessPx: number
): LineSegment[] => {
  const segments: LineSegment[] = [];
  let active: ActiveStripe[] = [];

  for (let s = 0; s <= scanLength; s += 1) {
    const runs = s < scanLength ? runsPerScan[s] : [];
    const usedRunIdx = new Uint8Array(runs.length);
    const nextActive: ActiveStripe[] = [];

    for (const stripe of active) {
      let bestIdx = -1;
      let bestOverlap = 0;
      for (let r = 0; r < runs.length; r += 1) {
        if (usedRunIdx[r] === 1) {
          continue;
        }
        const o = overlapFraction(runs[r], stripe.current);
        if (o >= STRIPE_OVERLAP_THRESHOLD && o > bestOverlap) {
          bestOverlap = o;
          bestIdx = r;
        }
      }
      if (bestIdx >= 0) {
        usedRunIdx[bestIdx] = 1;
        const run = runs[bestIdx];
        nextActive.push({
          startScan: stripe.startScan,
          current: {
            start: Math.min(stripe.current.start, run.start),
            end: Math.max(stripe.current.end, run.end)
          }
        });
      } else {
        const thickness = s - stripe.startScan;
        if (thickness <= maxLineThicknessPx) {
          segments.push({
            axisPos: stripe.startScan + Math.floor(thickness / 2),
            thickness,
            start: stripe.current.start,
            end: stripe.current.end
          });
        }
      }
    }

    for (let r = 0; r < runs.length; r += 1) {
      if (usedRunIdx[r] === 1) {
        continue;
      }
      nextActive.push({ startScan: s, current: runs[r] });
    }

    active = nextActive;
  }

  return segments;
};

/**
 * Detect horizontal/vertical line segments by sweeping rows then columns and
 * grouping runs of foreground pixels with similar x/y extents into stripes.
 */
export const detectLineSegments = (
  pixels: ImageData,
  backgroundThreshold: number,
  thresholds: SizeRelativeThresholds,
  foregroundMask: Uint8Array | null = null
): LineSegments => {
  const { width, height, data } = pixels;
  const maxGap = Math.max(2, Math.round(thresholds.maxLineThicknessPx));

  // --- horizontals ---
  const rowRuns: RowRun[][] = new Array(height);
  for (let y = 0; y < height; y += 1) {
    rowRuns[y] = allForegroundRunsInRow(
      data,
      width,
      y,
      backgroundThreshold,
      thresholds.minLineLengthPx,
      maxGap,
      foregroundMask
    );
  }
  const horizontals = buildStripeSegments(rowRuns, height, thresholds.maxLineThicknessPx);

  // --- verticals ---
  const colRuns: RowRun[][] = new Array(width);
  for (let x = 0; x < width; x += 1) {
    colRuns[x] = allForegroundRunsInColumn(
      data,
      width,
      height,
      x,
      backgroundThreshold,
      thresholds.minLineLengthPx,
      maxGap,
      foregroundMask
    );
  }
  const verticals = buildStripeSegments(colRuns, width, thresholds.maxLineThicknessPx);

  return { horizontals, verticals };
};

const segmentSpansAxis = (segment: LineSegment, from: number, to: number, tolerance: number): boolean => {
  return segment.start - tolerance <= from && segment.end + tolerance >= to;
};

/**
 * Cluster segments whose `axisPos` differ by less than `positionTolerance`
 * into a single canonical segment. Anti-aliasing, glyphs sitting on a rule,
 * and capture noise all fragment one physical line into N stripe segments at
 * y, y+1, y+2, … with overlapping x-extents. Without clustering, every such
 * variant feeds the (top × bottom × left × right) quadruple search and the
 * fan-out is the dominant source of near-identical rects in the overlay.
 *
 * Two segments only merge when their x-extents (start..end) actually overlap
 * (or touch within positionTolerance). Two physically separate parallel lines
 * that happen to share a y-coordinate are NOT fragments of the same rule and
 * must remain distinct — merging them would produce a spanning canonical
 * segment that fabricates rect candidates between unrelated boxes.
 *
 * Canonicalization rule: median axisPos, min start, max end, max thickness.
 */
export const clusterSegmentsByAxisPos = (
  segments: LineSegment[],
  positionTolerance: number
): LineSegment[] => {
  if (segments.length <= 1) {
    return segments.slice();
  }
  const sorted = [...segments].sort((a, b) => a.axisPos - b.axisPos);
  const claimed = new Uint8Array(sorted.length);
  const clustered: LineSegment[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    if (claimed[i] === 1) {
      continue;
    }
    const bucket: LineSegment[] = [sorted[i]];
    let bucketStart = sorted[i].start;
    let bucketEnd = sorted[i].end;
    claimed[i] = 1;
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (claimed[j] === 1) {
        continue;
      }
      const seg = sorted[j];
      if (seg.axisPos - sorted[i].axisPos >= positionTolerance) {
        break;
      }
      // Overlap (or near-touch within positionTolerance) on the primary axis.
      // Without this gate, parallel-but-disjoint runs at the same y collapse
      // into one wide canonical segment that spans gaps where no physical
      // rule actually exists, fabricating spurious rect candidates.
      const overlapsBucket =
        seg.start <= bucketEnd + positionTolerance &&
        seg.end + positionTolerance >= bucketStart;
      if (!overlapsBucket) {
        continue;
      }
      bucket.push(seg);
      if (seg.start < bucketStart) bucketStart = seg.start;
      if (seg.end > bucketEnd) bucketEnd = seg.end;
      claimed[j] = 1;
    }
    clustered.push(canonicalizeBucket(bucket));
  }

  return clustered;
};

const canonicalizeBucket = (bucket: LineSegment[]): LineSegment => {
  const positions = bucket.map((s) => s.axisPos).sort((a, b) => a - b);
  const median = positions[Math.floor(positions.length / 2)];
  let start = bucket[0].start;
  let end = bucket[0].end;
  let thickness = bucket[0].thickness;
  for (let i = 1; i < bucket.length; i += 1) {
    if (bucket[i].start < start) start = bucket[i].start;
    if (bucket[i].end > end) end = bucket[i].end;
    if (bucket[i].thickness > thickness) thickness = bucket[i].thickness;
  }
  return { axisPos: median, thickness, start, end };
};

interface BuildLineBoundedRectsOptions {
  surfaceWidth: number;
  surfaceHeight: number;
  /** Maximum number of rects to emit. Caps combinatorial blow-up on dense forms. */
  maxRects?: number;
  /** Snap horizontal lines into bins of this many pixels (handles minor offsets). */
  positionToleranceFraction?: number;
  /**
   * Hard ceiling on the number of (top, bottom, left, right) quadruples evaluated.
   * `maxRects` caps emitted rects but every rejected quadruple is still considered
   * — on a complex form with ~150 horizontals × 150 verticals that's >500M
   * comparisons, enough to freeze the main thread for many seconds. Once this
   * budget is hit we break out of the loop and return whatever has been
   * collected so far. Outer-first iteration order keeps the truncated set
   * biased toward outer containers.
   */
  maxQuadrupleEvaluations?: number;
  /**
   * After clustering, keep only the top-N longest segments per axis. Caps the
   * inner loop at N×N×N×N regardless of how noisy the source raster is.
   */
  maxAxisSegments?: number;
}

const DEFAULT_MAX_QUADRUPLE_EVALUATIONS = 2_000_000;
const DEFAULT_MAX_AXIS_SEGMENTS = 80;
const DEFAULT_MAX_RECTS = 800;

/**
 * Build axis-aligned line-bounded rectangles from detected horizontal and
 * vertical segments. A candidate rect (top, bottom, left, right) is emitted
 * iff all four sides are present as line segments that span across the rect.
 * This produces the outer table border AND every nested cell in one pass.
 *
 * Rects are deduplicated within a small tolerance so multi-row stripes do not
 * generate duplicate cells.
 */
export const buildLineBoundedRects = (
  segments: LineSegments,
  options: BuildLineBoundedRectsOptions
): PixelBounds[] => {
  const { horizontals, verticals } = segments;
  if (horizontals.length < 2 || verticals.length < 2) {
    return [];
  }

  const minSide = Math.max(1, Math.min(options.surfaceWidth, options.surfaceHeight));
  const positionTolerance = Math.max(2, Math.round(minSide * (options.positionToleranceFraction ?? 0.005)));
  /**
   * `maxRects` (default 800) bounds emitted rects. A real form has fewer than
   * 200 visually distinct rectangles; the previous 20k cap was protecting a
   * pathological combinatorial expansion that pre-clustering shouldn't have
   * been allowed to happen. Combined with per-axis clustering and the
   * `maxAxisSegments` cap below, 800 leaves comfortable headroom while
   * preventing a frozen overlay on noisy captures.
   */
  const maxRects = options.maxRects ?? DEFAULT_MAX_RECTS;
  const maxQuadrupleEvaluations =
    options.maxQuadrupleEvaluations ?? DEFAULT_MAX_QUADRUPLE_EVALUATIONS;
  const maxAxisSegments = options.maxAxisSegments ?? DEFAULT_MAX_AXIS_SEGMENTS;

  // Cluster fragmented stripes (anti-aliasing / glyph-broken lines emit one
  // physical rule as multiple segments at adjacent axisPos values). One
  // canonical segment per cluster collapses the (top × bottom × left × right)
  // fan-out before it can explode.
  const clusteredH = clusterSegmentsByAxisPos(horizontals, positionTolerance);
  const clusteredV = clusterSegmentsByAxisPos(verticals, positionTolerance);

  // Hard cap per axis: keep the longest N segments. A real form needs at most
  // ~30-50 distinct rules per axis; capping at 80 caps the worst-case quadruple
  // count at 80⁴ ≈ 41M evaluations, which the existing budget then trims
  // further. Length is the right ranking — short segments inside a dense
  // glyph cluster contribute little structural value.
  const segmentLength = (s: LineSegment) => s.end - s.start;
  const cappedH =
    clusteredH.length > maxAxisSegments
      ? [...clusteredH].sort((a, b) => segmentLength(b) - segmentLength(a)).slice(0, maxAxisSegments)
      : clusteredH;
  const cappedV =
    clusteredV.length > maxAxisSegments
      ? [...clusteredV].sort((a, b) => segmentLength(b) - segmentLength(a)).slice(0, maxAxisSegments)
      : clusteredV;

  if (cappedH.length < 2 || cappedV.length < 2) {
    return [];
  }

  const sortedH = [...cappedH].sort((a, b) => a.axisPos - b.axisPos);
  const sortedV = [...cappedV].sort((a, b) => a.axisPos - b.axisPos);

  const rects: PixelBounds[] = [];
  const seen = new Set<string>();
  let evaluations = 0;
  let budgetExceeded = false;

  const dedupeKey = (left: number, top: number, right: number, bottom: number): string => {
    const bin = (n: number) => Math.round(n / Math.max(1, positionTolerance));
    return `${bin(left)},${bin(top)},${bin(right)},${bin(bottom)}`;
  };

  /**
   * Iteration order — outer/largest first.
   *
   * For each top horizontal, walk the bottom horizontals in DESCENDING axis
   * order so the largest-height (top, bottom) pair (the would-be outer
   * container) is tried before any internal sub-row. Same trick on the
   * vertical pair: walk right verticals from rightmost to leftmost. The
   * effect is that if `maxRects` ever does fire on a pathological grid, the
   * surviving rects favor the outermost containers instead of the innermost
   * sub-cells. Reordering does NOT change which rects are considered valid —
   * dedupe is position-keyed, so the set of emitted rects under a generous
   * cap is identical to the ascending-order version. Only the truncation
   * priority changes.
   */
  outer: for (let i = 0; i < sortedH.length; i += 1) {
    const top = sortedH[i];
    for (let j = sortedH.length - 1; j > i; j -= 1) {
      const bottom = sortedH[j];
      if (bottom.axisPos - top.axisPos < positionTolerance) {
        continue;
      }
      // x-range that BOTH horizontals cover.
      const xFrom = Math.max(top.start, bottom.start);
      const xTo = Math.min(top.end, bottom.end);
      if (xTo - xFrom < positionTolerance * 2) {
        continue;
      }

      for (let a = 0; a < sortedV.length; a += 1) {
        const left = sortedV[a];
        if (left.axisPos < xFrom - positionTolerance || left.axisPos > xTo + positionTolerance) {
          continue;
        }
        if (!segmentSpansAxis(left, top.axisPos, bottom.axisPos, positionTolerance)) {
          continue;
        }

        for (let b = sortedV.length - 1; b > a; b -= 1) {
          evaluations += 1;
          if (evaluations >= maxQuadrupleEvaluations) {
            budgetExceeded = true;
            break outer;
          }
          const right = sortedV[b];
          if (right.axisPos < xFrom - positionTolerance || right.axisPos > xTo + positionTolerance) {
            continue;
          }
          if (right.axisPos - left.axisPos < positionTolerance) {
            continue;
          }
          if (!segmentSpansAxis(right, top.axisPos, bottom.axisPos, positionTolerance)) {
            continue;
          }
          if (!segmentSpansAxis(top, left.axisPos, right.axisPos, positionTolerance)) {
            continue;
          }
          if (!segmentSpansAxis(bottom, left.axisPos, right.axisPos, positionTolerance)) {
            continue;
          }

          const rect: PixelBounds = {
            left: left.axisPos,
            top: top.axisPos,
            right: right.axisPos + 1,
            bottom: bottom.axisPos + 1
          };
          const key = dedupeKey(rect.left, rect.top, rect.right, rect.bottom);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          rects.push(rect);
          if (rects.length >= maxRects) {
            break outer;
          }
        }
      }
    }
  }

  // eslint-disable-next-line no-console
  console.warn(
    `[line-grid-detector] H_count=${sortedH.length} V_count=${sortedV.length} ` +
      `quadruples_evaluated=${evaluations} rects_emitted=${rects.length}` +
      (budgetExceeded ? ` (budget_exceeded=${maxQuadrupleEvaluations})` : '') +
      ` raw_H=${horizontals.length} raw_V=${verticals.length}`
  );

  return rects;
};

interface RectsToObjectsOptions {
  idPrefix: string;
  baseConfidence?: number;
  surfaceWidth: number;
  surfaceHeight: number;
}

/**
 * Convert line-bounded rects into CV surface objects. Each line-bounded box
 * is just an object — the hierarchy pass decides parent/child purely by
 * containment, with no semantic classification.
 */
export const lineBoundedRectsToObjects = (
  rects: PixelBounds[],
  options: RectsToObjectsOptions
): CvSurfaceObject[] => {
  const pageArea = Math.max(1, options.surfaceWidth * options.surfaceHeight);
  const baseConfidence = options.baseConfidence ?? 0.78;
  const out: CvSurfaceObject[] = [];
  rects.forEach((rect, index) => {
    const width = Math.max(0, rect.right - rect.left);
    const height = Math.max(0, rect.bottom - rect.top);
    if (width <= 0 || height <= 0) {
      return;
    }
    const area = width * height;
    const fillBoost = Math.min(0.18, area / pageArea);
    out.push({
      objectId: `${options.idPrefix}_rect_${index}`,
      bboxSurface: { x: rect.left, y: rect.top, width, height },
      confidence: Math.min(0.99, baseConfidence + fillBoost)
    });
  });
  return out;
};
