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
  /**
   * If set, populated with detection diagnostics (raw rect count and number
   * of sub-block unions dropped by the leaf-or-outermost filter). Lets the
   * worker emit a single combined log line covering the line-grid and
   * contour pipelines.
   */
  diagnostics?: LineBoundedRectsDiagnostics;
  /**
   * If true, skip the leaf-or-outermost filter and return every line-bounded
   * quadruple. Used by tests that pin the raw enumeration behavior; production
   * callers should leave this off.
   */
  skipLeafOrOutermostFilter?: boolean;
}

export interface LineBoundedRectsDiagnostics {
  /** Rect count before the leaf-or-outermost filter. */
  rectsBeforeFilter: number;
  /** Sub-block unions dropped by the leaf-or-outermost filter. */
  subblocksDropped: number;
}

const DEFAULT_MAX_QUADRUPLE_EVALUATIONS = 2_000_000;
const DEFAULT_MAX_AXIS_SEGMENTS = 80;
const DEFAULT_MAX_RECTS = 800;
const FULL_WIDTH_RATIO = 0.5;

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
   * been allowed to happen. Combined with per-axis clustering, the
   * `maxAxisSegments` cap below, and the subset-suppression pass that
   * collapses chain-of-nested-rects fans (a 13-row table produces O(rows²)
   * raw rects per column-pair which suppression collapses to single cells),
   * the 800 cap should almost never fire — it is retained purely as a safety
   * net against unforeseen pathological inputs.
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

  // Hard cap per axis with a two-pass selection.
  //
  // Pass 1 admits every segment whose length is ≥ FULL_WIDTH_RATIO × the
  //   longest segment on its axis. These are the page-spanning rules — page
  //   perimeter, full-width header / footer, full-width grid frame — and
  //   they MUST survive the cap, otherwise outer containers like HEADER /
  //   SIDEBAR / FOOTER lose one of their four bounding rules and silently
  //   disappear from the overlay.
  // Pass 2 fills the remaining budget with the longest of the leftover
  //   segments. Length is still the right ranking for filler — short
  //   segments inside a dense glyph cluster contribute little structural
  //   value.
  // The pure length sort that this replaces could starve full-width rules
  //   on a noisy capture where dozens of dense grid rules and a long legend
  //   row crowded out slightly-shorter HEADER/SIDEBAR/FOOTER rules.
  const cappedH = selectAxisSegments(clusteredH, maxAxisSegments);
  const cappedV = selectAxisSegments(clusteredV, maxAxisSegments);

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

  // Order: leaf-or-outermost FIRST, then chain-endpoints subset suppression.
  //
  // Leaf-tile decomposition is the high-recall pass: when every interior cell
  // is detected (clean synthetic grids, well-imaged forms) it reduces a 1365-
  // rect 13-row × 5-col raw enumeration to 65 cells + 1 outer with no chain
  // residue, and chain-endpoints suppression has nothing left to do.
  //
  // The pathology subset suppression targets is the case where SOME interior
  // cell rules go missing on real documents (glyph noise erasing a stretch of
  // a horizontal rule, anti-aliasing fragmenting a vertical), leaving a
  // partial tiling that the leaf filter cannot fully decompose. The
  // intermediate chain rects then survive as "leaves" and stack into 22+
  // deep parent chains. Suppression on the leaf-filtered residue collapses
  // the chain interior while preserving both endpoints (smallest tightest
  // rect AND largest outer container) in every shared-3-edge group.
  //
  // Running suppression after the filter (rather than before) avoids
  // starving the filter's `canCover` traversal of the boundary positions it
  // needs to bridge near-coincident edges across cells.
  const rectsBeforeFilter = rects.length;
  const filtered = options.skipLeafOrOutermostFilter
    ? rects
    : applySubsetSuppression(
        filterToLeavesAndOutermost(rects, positionTolerance)
      );

  if (options.diagnostics) {
    options.diagnostics.rectsBeforeFilter = rectsBeforeFilter;
    options.diagnostics.subblocksDropped = rectsBeforeFilter - filtered.length;
  }

  // eslint-disable-next-line no-console
  console.warn(
    `[line-grid-detector] H_count=${sortedH.length} V_count=${sortedV.length} ` +
      `quadruples_evaluated=${evaluations} rects_pre_filter=${rectsBeforeFilter} ` +
      `rects_emitted=${filtered.length} subblocks_dropped=${rectsBeforeFilter - filtered.length}` +
      (budgetExceeded ? ` (budget_exceeded=${maxQuadrupleEvaluations})` : '') +
      ` raw_H=${horizontals.length} raw_V=${verticals.length}`
  );

  return filtered;
};

/**
 * Drop interior chain members from groups of rects that share three of four
 * edges. For every (3 fixed edges, 1 varying edge) grouping we keep the chain
 * endpoints — the tightest rect AND the loosest rect — and drop only the
 * intermediate variants.
 *
 * Worked examples
 *  - 13-row × 5-col table: per (column-pair, top) the raw enumeration emits
 *    a fan of 13 rects with bottoms at every horizontal rule. Endpoints rule
 *    keeps the row-1 strip (smallest) and the table-outer strip (largest);
 *    the 11 cumulative row strips in between are dropped.
 *  - HEADER + 1 internal full-width divider: chain length 2 (HEADER, sub-row).
 *    Both endpoints. No interior, no drop.
 *  - OUTER PAGE with HEADER and FOOTER full-width borders: chain length ≥ 3
 *    (page top→header bottom; page top→footer top; page top→footer bottom;
 *    page top→page bottom). Endpoints keeps the smallest strip and the page
 *    outer; the intermediate strips are dropped, but the page outer is
 *    preserved.
 *
 * Why endpoints, not just smallest:
 *  The simpler "keep smallest" variant (drop R if any smaller R' shares 3
 *  edges) destroys any container that happens to have a full-width internal
 *  rule, because the upper sub-strip becomes a smaller 3-edge-shared sibling
 *  and the container is collapsed to that strip. Endpoints preserves the
 *  container while still collapsing the chain interior, which is the
 *  pathology that drives 22+ deep parent chains on dense tables.
 *
 * The existing `filterToLeavesAndOutermost` pass handles sub-block unions
 * when the underlying leaf tiling is fully detected. Real documents routinely
 * lose a handful of interior cell rules to glyph noise, which lets the leaf
 * filter's tile-decomposition fail and the chain rects survive as leaves.
 * Subset suppression catches the chain directly without depending on a
 * complete tiling.
 */
const applySubsetSuppression = (
  rects: PixelBounds[]
): PixelBounds[] => {
  if (rects.length <= 1) {
    return rects.slice();
  }
  // Chain edge equality must be exact: rect coordinates derive from
  // axis-clustered line segment axisPos values, so two rects whose 3 fixed
  // edges came from the same physical segments will have identical values.
  // A loose (positionTolerance) equality here would group rects that share
  // a NEAR edge (e.g. an outer page rule and an inner container rule
  // separated by a 10 px inset) as a chain, falsely marking the inner
  // container as chain interior. Using exact equality keeps the rule
  // restricted to real cumulative-union chains.
  const eq = (a: number, b: number): boolean => a === b;
  const strictlyLess = (a: number, b: number): boolean => a < b;

  const drop = new Uint8Array(rects.length);
  for (let i = 0; i < rects.length; i += 1) {
    const R = rects[i];
    let lrt_smaller = 0; // same (left, right, top); count with R'.bottom < R.bottom
    let lrt_larger = 0; //                            count with R'.bottom > R.bottom
    let lrb_smaller = 0; // same (left, right, bottom); count with R'.top > R.top
    let lrb_larger = 0; //                              count with R'.top < R.top
    let tbl_smaller = 0; // same (top, bottom, left); count with R'.right < R.right
    let tbl_larger = 0; //                            count with R'.right > R.right
    let tbr_smaller = 0; // same (top, bottom, right); count with R'.left > R.left
    let tbr_larger = 0; //                             count with R'.left < R.left
    for (let j = 0; j < rects.length; j += 1) {
      if (i === j) {
        continue;
      }
      const Rp = rects[j];
      if (eq(R.left, Rp.left) && eq(R.right, Rp.right) && eq(R.top, Rp.top)) {
        if (strictlyLess(Rp.bottom, R.bottom)) {
          lrt_smaller += 1;
        } else if (strictlyLess(R.bottom, Rp.bottom)) {
          lrt_larger += 1;
        }
      }
      if (eq(R.left, Rp.left) && eq(R.right, Rp.right) && eq(R.bottom, Rp.bottom)) {
        if (strictlyLess(R.top, Rp.top)) {
          lrb_smaller += 1;
        } else if (strictlyLess(Rp.top, R.top)) {
          lrb_larger += 1;
        }
      }
      if (eq(R.top, Rp.top) && eq(R.bottom, Rp.bottom) && eq(R.left, Rp.left)) {
        if (strictlyLess(Rp.right, R.right)) {
          tbl_smaller += 1;
        } else if (strictlyLess(R.right, Rp.right)) {
          tbl_larger += 1;
        }
      }
      if (eq(R.top, Rp.top) && eq(R.bottom, Rp.bottom) && eq(R.right, Rp.right)) {
        if (strictlyLess(R.left, Rp.left)) {
          tbr_smaller += 1;
        } else if (strictlyLess(Rp.left, R.left)) {
          tbr_larger += 1;
        }
      }
    }
    // Chain-interior predicate: at least one neighbor on EACH side AND a
    // total chain length ≥ 5 (i.e. R has ≥ 4 other shared-3-edges siblings).
    // The leaf-or-outermost filter (run before this pass) handles synthetic
    // complete grids; this floor leaves modest-size chains (4-element
    // coincidences from outer/container/inner-label edge alignment) alone
    // while still catching real-document chain pathologies. The user's
    // 13-row × 5-col items table column-fan has chain length 13 — well
    // above the floor — and 22+ deep parent chains in the structural
    // model collapse to two endpoints per group.
    const chainInterior = (smaller: number, larger: number): boolean =>
      smaller >= 1 && larger >= 1 && smaller + larger >= 4;
    if (
      chainInterior(lrt_smaller, lrt_larger) ||
      chainInterior(lrb_smaller, lrb_larger) ||
      chainInterior(tbl_smaller, tbl_larger) ||
      chainInterior(tbr_smaller, tbr_larger)
    ) {
      drop[i] = 1;
    }
  }

  const out: PixelBounds[] = [];
  for (let i = 0; i < rects.length; i += 1) {
    if (!drop[i]) {
      out.push(rects[i]);
    }
  }
  return out;
};

/**
 * Threshold for "near-duplicate strictly contained" — the area-ratio above
 * which we treat the larger rect as a gap-tolerance "extension" of the
 * smaller rect rather than as a meaningfully larger container.
 *
 * Gap-tolerated row scans (with maxGap ≈ maxLineThicknessPx) routinely
 * fuse a header rule's pixel run with the adjacent page-edge strokes,
 * producing a parallel y=60 line segment whose extent reaches the page
 * border. The resulting line-bounded rect is a slightly-larger twin of
 * the real header. The outermost-composite pass must NOT use such
 * extensions to drop the real container, otherwise every isolated
 * container with adjacent page-edge artifacts disappears from the model.
 */
const NEAR_DUPLICATE_AREA_RATIO_MIN = 0.85;

const segmentLength = (s: LineSegment): number => s.end - s.start;

/**
 * Two-pass per-axis cap selection. Page-spanning rules (length ≥
 * `FULL_WIDTH_RATIO` × longest) are admitted unconditionally; remaining
 * budget is filled with the longest of the leftover segments.
 */
const selectAxisSegments = (
  segments: LineSegment[],
  cap: number
): LineSegment[] => {
  if (segments.length <= cap) {
    return segments;
  }
  let longest = 0;
  for (const seg of segments) {
    const len = segmentLength(seg);
    if (len > longest) {
      longest = len;
    }
  }
  const halfThreshold = longest * FULL_WIDTH_RATIO;
  const pageSpanning: LineSegment[] = [];
  const remainder: LineSegment[] = [];
  for (const seg of segments) {
    if (segmentLength(seg) >= halfThreshold) {
      pageSpanning.push(seg);
    } else {
      remainder.push(seg);
    }
  }
  if (pageSpanning.length >= cap) {
    return [...pageSpanning].sort((a, b) => segmentLength(b) - segmentLength(a)).slice(0, cap);
  }
  const slotsRemaining = cap - pageSpanning.length;
  const filler = [...remainder]
    .sort((a, b) => segmentLength(b) - segmentLength(a))
    .slice(0, slotsRemaining);
  return [...pageSpanning, ...filler];
};

/**
 * Drop sub-block unions from a line-bounded rect set.
 *
 * For an N×M ruled grid with shared boundaries the raw enumeration emits
 * C(N+1,2)·C(M+1,2) rects: every (top, bottom, left, right) quadruple is
 * line-bounded but only N·M of them are visually distinct cells, plus one
 * outer container. The remaining unions of adjacent cells are valid
 * line-bounded rectangles but they are not visually distinct objects —
 * rendering them in the overlay produces the dense "shadow" stack of
 * partial-grid rectangles that the user sees when looking at RIGHT GRID,
 * WIDE GRID, or DETAILS BOX.
 *
 * Algorithm (smallest-area first, leaves-only tilings):
 *  1. Process rects in ascending area order. A rect that has not been
 *     marked composite by the time it is processed is a LEAF and is added
 *     to the leaf set (the only set used for tiling-membership tests).
 *  2. A rect R is COMPOSITE iff there is a horizontal or vertical cut
 *     splitting R into two sub-rects that each are tileable by leaves.
 *     "Tileable by leaves" is checked recursively via guillotine cuts —
 *     each leaf is a base case, every non-leaf sub-rect must itself be
 *     guillotine-tileable by leaves. Critically, COMPOSITES THEMSELVES
 *     ARE NOT BUILDING BLOCKS for tilings: only leaves are. This is
 *     what prevents a real container like HEADER from being mis-classified
 *     as composite when its interior contains a small label box plus the
 *     sub-block unions emitted around that label — the label area's
 *     sub-block unions tile the label region (so date_pill becomes
 *     composite), but they do not tile the HEADER's empty interior, so
 *     HEADER stays a leaf.
 *  3. Composite rects are dropped UNLESS no strictly larger composite
 *     strictly contains them — i.e. they are the outermost composite of
 *     their tile group. The outermost composite is the visually meaningful
 *     container; all interior unions are redundant.
 *
 * Outcome on the benchmark layouts:
 *  - 5×3 shared-boundary grid: 90 raw rects → 15 leaf cells + 1 outer = 16.
 *  - 3×6 wide grid: 126 raw rects → 18 leaf cells + 1 outer = 19.
 *  - HEADER + DATE pair (no shared boundaries): both leaves, 2 rects.
 */
const filterToLeavesAndOutermost = (
  rects: PixelBounds[],
  positionTolerance: number
): PixelBounds[] => {
  if (rects.length <= 2) {
    return rects.slice();
  }

  const tol = Math.max(1, positionTolerance);
  const bin = (n: number): number => Math.round(n / tol);
  const rectKey = (l: number, t: number, r: number, b: number): string =>
    `${bin(l)},${bin(t)},${bin(r)},${bin(b)}`;

  // Distinct boundary positions across all input rects. Cuts can only land
  // on a boundary that some accepted rect supplies — every other cut would
  // leave at least one half whose extent doesn't match any leaf.
  const xBoundsSet = new Set<number>();
  const yBoundsSet = new Set<number>();
  for (const rect of rects) {
    xBoundsSet.add(rect.left);
    xBoundsSet.add(rect.right);
    yBoundsSet.add(rect.top);
    yBoundsSet.add(rect.bottom);
  }
  const xBounds = [...xBoundsSet].sort((a, b) => a - b);
  const yBounds = [...yBoundsSet].sort((a, b) => a - b);

  const buildCanCover = (
    leafKeys: ReadonlySet<string>
  ): ((l: number, t: number, r: number, b: number) => boolean) => {
    const memo = new Map<string, boolean>();
    const canCover = (l: number, t: number, r: number, b: number): boolean => {
      if (r - l <= tol || b - t <= tol) {
        return false;
      }
      const key = rectKey(l, t, r, b);
      const cached = memo.get(key);
      if (cached !== undefined) {
        return cached;
      }
      if (leafKeys.has(key)) {
        memo.set(key, true);
        return true;
      }
      for (const y of yBounds) {
        if (y <= t + tol || y >= b - tol) {
          continue;
        }
        if (canCover(l, t, r, y) && canCover(l, y, r, b)) {
          memo.set(key, true);
          return true;
        }
      }
      for (const x of xBounds) {
        if (x <= l + tol || x >= r - tol) {
          continue;
        }
        if (canCover(l, t, x, b) && canCover(x, t, r, b)) {
          memo.set(key, true);
          return true;
        }
      }
      memo.set(key, false);
      return false;
    };
    return canCover;
  };

  const isCompositeAgainstLeaves = (
    rect: PixelBounds,
    canCover: (l: number, t: number, r: number, b: number) => boolean
  ): boolean => {
    const { left: l, top: t, right: r, bottom: b } = rect;
    for (const y of yBounds) {
      if (y <= t + tol || y >= b - tol) {
        continue;
      }
      if (canCover(l, t, r, y) && canCover(l, y, r, b)) {
        return true;
      }
    }
    for (const x of xBounds) {
      if (x <= l + tol || x >= r - tol) {
        continue;
      }
      if (canCover(l, t, x, b) && canCover(x, t, r, b)) {
        return true;
      }
    }
    return false;
  };

  const indexed = rects.map((rect, originalIndex) => ({
    rect,
    originalIndex,
    area: Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top)
  }));

  // A rect is an "extension" if it strictly contains a smaller rect whose
  // area is ≥ NEAR_DUPLICATE_AREA_RATIO_MIN of its own. Such rects are
  // products of gap-tolerance fusing a real container's rule with an
  // adjacent edge, and must not be used as outer composites that drop
  // the real container they enclose.
  const isExtensionOfSmaller = new Array<boolean>(indexed.length).fill(false);
  for (let i = 0; i < indexed.length; i += 1) {
    if (indexed[i].area <= 0) {
      continue;
    }
    for (let j = 0; j < indexed.length; j += 1) {
      if (j === i || indexed[j].area <= 0 || indexed[j].area >= indexed[i].area) {
        continue;
      }
      const outer = indexed[i].rect;
      const inner = indexed[j].rect;
      if (
        outer.left <= inner.left + tol &&
        outer.top <= inner.top + tol &&
        outer.right + tol >= inner.right &&
        outer.bottom + tol >= inner.bottom &&
        indexed[j].area / indexed[i].area >= NEAR_DUPLICATE_AREA_RATIO_MIN
      ) {
        isExtensionOfSmaller[i] = true;
        break;
      }
    }
  }

  const sortedAsc = [...indexed].sort((a, b) => a.area - b.area);
  const composite = new Array<boolean>(indexed.length).fill(false);
  const leafKeys = new Set<string>();

  for (const entry of sortedAsc) {
    const canCover = buildCanCover(leafKeys);
    const isComp = isCompositeAgainstLeaves(entry.rect, canCover);
    composite[entry.originalIndex] = isComp;
    if (!isComp) {
      leafKeys.add(rectKey(entry.rect.left, entry.rect.top, entry.rect.right, entry.rect.bottom));
    }
  }

  // After all composites are classified, the leaf set is final. Reuse one
  // canCover instance for the outermost-tile pass below.
  const canCoverFinal = buildCanCover(leafKeys);

  // Drop composite R only when some larger composite L contains R AND the
  // strips of L around R (L minus R) can be tiled by leaves alone — i.e.
  // R sits inside L's tile group as a sub-block. This keeps siblings like
  // sidebar_anchor and date_pill that live INSIDE a larger composite (the
  // page-spanning horizontal strip stack that incidentally tiles the page
  // boundary) but are not themselves tiles of that decomposition.
  const tileableInside = (
    outer: PixelBounds,
    outerArea: number,
    inner: PixelBounds,
    innerArea: number
  ): boolean => {
    if (
      !(outer.left <= inner.left + tol &&
        outer.top <= inner.top + tol &&
        outer.right + tol >= inner.right &&
        outer.bottom + tol >= inner.bottom)
    ) {
      return false;
    }
    if (outerArea < innerArea * 1.05) {
      return false;
    }
    const strips: PixelBounds[] = [];
    if (inner.top - outer.top > tol) {
      strips.push({ left: outer.left, top: outer.top, right: outer.right, bottom: inner.top });
    }
    if (outer.bottom - inner.bottom > tol) {
      strips.push({ left: outer.left, top: inner.bottom, right: outer.right, bottom: outer.bottom });
    }
    if (inner.left - outer.left > tol) {
      strips.push({ left: outer.left, top: inner.top, right: inner.left, bottom: inner.bottom });
    }
    if (outer.right - inner.right > tol) {
      strips.push({ left: inner.right, top: inner.top, right: outer.right, bottom: inner.bottom });
    }
    for (const strip of strips) {
      if (!canCoverFinal(strip.left, strip.top, strip.right, strip.bottom)) {
        return false;
      }
    }
    return true;
  };

  const result: PixelBounds[] = [];
  for (let i = 0; i < indexed.length; i += 1) {
    const entry = indexed[i];
    if (!composite[i]) {
      result.push(entry.rect);
      continue;
    }
    let dropped = false;
    for (let j = 0; j < indexed.length; j += 1) {
      if (j === i || !composite[j]) {
        continue;
      }
      if (indexed[j].area <= entry.area) {
        continue;
      }
      // Skip outer L's that are themselves gap-tolerance extensions of a
      // smaller rect — they're not meaningfully larger than the real
      // container they enclose, so dropping the real container via L would
      // be a false-positive driven by the artifact rule, not the geometry.
      if (isExtensionOfSmaller[j]) {
        continue;
      }
      if (tileableInside(indexed[j].rect, indexed[j].area, entry.rect, entry.area)) {
        dropped = true;
        break;
      }
    }
    if (!dropped) {
      result.push(entry.rect);
    }
  }
  return result;
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
