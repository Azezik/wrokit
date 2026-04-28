import type { CvSurfaceObject } from './cv-adapter';
import type { StructuralObjectType } from '../../../contracts/structural-model';

/**
 * Shared structural primitive: line-bounded rectangle detection.
 *
 * Both the heuristic fallback and the OpenCV runtime path delegate cell
 * detection to this module so that identical documents produce comparable
 * structure regardless of CV mode (`Make sure config and run use the same
 * detection logic`).
 *
 * Why "lines first, then rectangles" instead of contour-first:
 *  - A ruled form is *defined* by its straight rules. Cell interiors are
 *    background pixels, so connected-component flood fill cannot find them
 *    directly — it finds the text inside, not the cells.
 *  - Internal contours (`RETR_EXTERNAL`) are silently discarded. We instead
 *    reconstruct line-bounded rectangles from line segments, which gives us
 *    every nested cell, every grid block, and the table outline in a single
 *    pass.
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

interface RowRun {
  start: number;
  end: number; // exclusive
}

/**
 * Find the longest horizontal run of foreground pixels in row `y`. Small gaps
 * (<= maxGap pixels) within a run are tolerated to handle anti-aliased lines.
 * Returns null when the longest run is shorter than minLineLengthPx.
 */
const longestForegroundRunInRow = (
  data: Uint8ClampedArray,
  width: number,
  y: number,
  threshold: number,
  minLineLengthPx: number,
  maxGap: number
): RowRun | null => {
  const rowBase = y * width * 4;
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curEnd = -1; // exclusive position last fg pixel +1
  let gap = 0;
  for (let x = 0; x < width; x += 1) {
    const fg = !isBgAt(data, rowBase + x * 4, threshold);
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
        if (len > bestLen) {
          bestLen = len;
          bestStart = curStart;
        }
        curStart = -1;
        curEnd = -1;
        gap = 0;
      }
    }
  }
  if (curStart >= 0) {
    const len = curEnd - curStart;
    if (len > bestLen) {
      bestLen = len;
      bestStart = curStart;
    }
  }
  if (bestStart < 0 || bestLen < minLineLengthPx) {
    return null;
  }
  return { start: bestStart, end: bestStart + bestLen };
};

const longestForegroundRunInColumn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  threshold: number,
  minLineLengthPx: number,
  maxGap: number
): RowRun | null => {
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curEnd = -1;
  let gap = 0;
  for (let y = 0; y < height; y += 1) {
    const fg = !isBgAt(data, (y * width + x) * 4, threshold);
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
        if (len > bestLen) {
          bestLen = len;
          bestStart = curStart;
        }
        curStart = -1;
        curEnd = -1;
        gap = 0;
      }
    }
  }
  if (curStart >= 0) {
    const len = curEnd - curStart;
    if (len > bestLen) {
      bestLen = len;
      bestStart = curStart;
    }
  }
  if (bestStart < 0 || bestLen < minLineLengthPx) {
    return null;
  }
  return { start: bestStart, end: bestStart + bestLen };
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

/**
 * Detect horizontal/vertical line segments by sweeping rows then columns and
 * grouping runs of foreground pixels with similar x/y extents into stripes.
 */
export const detectLineSegments = (
  pixels: ImageData,
  backgroundThreshold: number,
  thresholds: SizeRelativeThresholds
): LineSegments => {
  const { width, height, data } = pixels;
  const maxGap = Math.max(2, Math.round(thresholds.maxLineThicknessPx));

  // --- horizontals ---
  const horizontals: LineSegment[] = [];
  const rowRuns: (RowRun | null)[] = new Array(height);
  for (let y = 0; y < height; y += 1) {
    rowRuns[y] = longestForegroundRunInRow(
      data,
      width,
      y,
      backgroundThreshold,
      thresholds.minLineLengthPx,
      maxGap
    );
  }

  let stripeStartY = -1;
  let stripeRun: RowRun | null = null;
  for (let y = 0; y <= height; y += 1) {
    const run = y < height ? rowRuns[y] : null;
    if (run && stripeRun && overlapFraction(run, stripeRun) >= 0.6) {
      stripeRun = {
        start: Math.min(stripeRun.start, run.start),
        end: Math.max(stripeRun.end, run.end)
      };
    } else if (run && !stripeRun) {
      stripeStartY = y;
      stripeRun = run;
    } else {
      if (stripeRun) {
        const thickness = y - stripeStartY;
        if (thickness <= thresholds.maxLineThicknessPx) {
          horizontals.push({
            axisPos: stripeStartY + Math.floor(thickness / 2),
            thickness,
            start: stripeRun.start,
            end: stripeRun.end
          });
        }
        stripeRun = null;
        stripeStartY = -1;
      }
      if (run) {
        stripeStartY = y;
        stripeRun = run;
      }
    }
  }

  // --- verticals ---
  const verticals: LineSegment[] = [];
  const colRuns: (RowRun | null)[] = new Array(width);
  for (let x = 0; x < width; x += 1) {
    colRuns[x] = longestForegroundRunInColumn(
      data,
      width,
      height,
      x,
      backgroundThreshold,
      thresholds.minLineLengthPx,
      maxGap
    );
  }

  let stripeStartX = -1;
  let stripeColRun: RowRun | null = null;
  for (let x = 0; x <= width; x += 1) {
    const run = x < width ? colRuns[x] : null;
    if (run && stripeColRun && overlapFraction(run, stripeColRun) >= 0.6) {
      stripeColRun = {
        start: Math.min(stripeColRun.start, run.start),
        end: Math.max(stripeColRun.end, run.end)
      };
    } else if (run && !stripeColRun) {
      stripeStartX = x;
      stripeColRun = run;
    } else {
      if (stripeColRun) {
        const thickness = x - stripeStartX;
        if (thickness <= thresholds.maxLineThicknessPx) {
          verticals.push({
            axisPos: stripeStartX + Math.floor(thickness / 2),
            thickness,
            start: stripeColRun.start,
            end: stripeColRun.end
          });
        }
        stripeColRun = null;
        stripeStartX = -1;
      }
      if (run) {
        stripeStartX = x;
        stripeColRun = run;
      }
    }
  }

  return { horizontals, verticals };
};

const segmentSpansAxis = (segment: LineSegment, from: number, to: number, tolerance: number): boolean => {
  return segment.start - tolerance <= from && segment.end + tolerance >= to;
};

interface BuildLineBoundedRectsOptions {
  surfaceWidth: number;
  surfaceHeight: number;
  /** Maximum number of rects to emit. Caps combinatorial blow-up on dense forms. */
  maxRects?: number;
  /** Snap horizontal lines into bins of this many pixels (handles minor offsets). */
  positionToleranceFraction?: number;
}

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
  const maxRects = options.maxRects ?? 1200;

  const sortedH = [...horizontals].sort((a, b) => a.axisPos - b.axisPos);
  const sortedV = [...verticals].sort((a, b) => a.axisPos - b.axisPos);

  const rects: PixelBounds[] = [];
  const seen = new Set<string>();

  const dedupeKey = (left: number, top: number, right: number, bottom: number): string => {
    const bin = (n: number) => Math.round(n / Math.max(1, positionTolerance));
    return `${bin(left)},${bin(top)},${bin(right)},${bin(bottom)}`;
  };

  outer: for (let i = 0; i < sortedH.length; i += 1) {
    const top = sortedH[i];
    for (let j = i + 1; j < sortedH.length; j += 1) {
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

        for (let b = a + 1; b < sortedV.length; b += 1) {
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

  return rects;
};

export const lineSegmentsToObjects = (
  segments: LineSegments,
  idPrefix: string,
  baseConfidence = 0.85
): CvSurfaceObject[] => {
  const out: CvSurfaceObject[] = [];
  segments.horizontals.forEach((line, idx) => {
    const length = Math.max(0, line.end - line.start);
    const top = line.axisPos - Math.floor(line.thickness / 2);
    out.push({
      objectId: `${idPrefix}_hline_${idx}`,
      type: 'line-horizontal',
      bboxSurface: {
        x: line.start,
        y: Math.max(0, top),
        width: length,
        height: Math.max(1, line.thickness)
      },
      confidence: Math.min(0.99, baseConfidence + Math.min(0.14, length / 4000))
    });
  });
  segments.verticals.forEach((line, idx) => {
    const length = Math.max(0, line.end - line.start);
    const left = line.axisPos - Math.floor(line.thickness / 2);
    out.push({
      objectId: `${idPrefix}_vline_${idx}`,
      type: 'line-vertical',
      bboxSurface: {
        x: Math.max(0, left),
        y: line.start,
        width: Math.max(1, line.thickness),
        height: length
      },
      confidence: Math.min(0.99, baseConfidence + Math.min(0.14, length / 4000))
    });
  });
  return out;
};

interface RectsToObjectsOptions {
  idPrefix: string;
  baseConfidence?: number;
  surfaceWidth: number;
  surfaceHeight: number;
}

/**
 * Convert line-bounded rects into CV surface objects. Initial type is always
 * `rectangle`; the structural hierarchy pass later promotes parents to
 * `container` / `table-like` based on what they actually contain.
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
    // Concrete type is decided by the hierarchy pass, but starting label is
    // always "rectangle" (a leaf line-bounded box). This is intentionally
    // structure-driven — not a size guess.
    const type: StructuralObjectType = 'rectangle';
    out.push({
      objectId: `${options.idPrefix}_rect_${index}`,
      type,
      bboxSurface: { x: rect.left, y: rect.top, width, height },
      confidence: Math.min(0.99, baseConfidence + fillBoost)
    });
  });
  return out;
};
