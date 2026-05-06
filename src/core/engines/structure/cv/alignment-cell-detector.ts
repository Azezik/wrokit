/**
 * Alignment-based cell detection.
 *
 * Inside a fill-bounded rectangle (typically a UI card surfaced by
 * `fill-bounded-rect-detector`), the cells of the card are usually NOT
 * separated by visible rules. They are encoded by alignment: a column gutter
 * of whitespace between two label/value pairs, a row gutter between two
 * groupings, consistent x-positions for column starts. The line-grid
 * detector cannot find these cells (no segments exist), and contour
 * detection groups their text into one big text blob.
 *
 * This detector projects foreground pixels onto the X and Y axes inside a
 * supplied region, finds "gutter runs" — consecutive scan positions whose
 * foreground projection is below a small epsilon — and emits the cross
 * product of the resulting row/column bands as cell rectangles. For a
 * Gmail bill summary card with a 2×2 grid of label/value pairs, we get
 * 4 cells (or 2 column bands × 2 row bands plus a `View bill` strip below).
 */

export interface AlignmentCellsPixelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface AlignmentCellsOptions {
  /** The region (in surface pixels) inside which to look for cells. */
  region: AlignmentCellsPixelBounds;
  /** The full surface width — needed because `foregroundMask` is page-sized. */
  surfaceWidth: number;
  /** The full surface height. */
  surfaceHeight: number;
  /**
   * Min consecutive scan positions of below-epsilon projection to count as
   * a gutter. Defaults to 2% of the region's perpendicular axis (e.g. for a
   * 200×300 region, 6 px on the X axis and 4 px on the Y axis). Below this,
   * normal inter-glyph whitespace inside a single text line would split a
   * line into pseudo-cells.
   */
  minGutterPx?: number;
  /**
   * Foreground count per scanline at or below which a row/column counts as
   * "empty" for gutter detection. Allows for stray anti-aliased pixels.
   */
  gutterEpsilon?: number;
  /**
   * Min span (px) for a row band or column band to be retained. Prevents
   * sliver cells from picking up a single-pixel residue between gutters.
   */
  minBandPx?: number;
  /**
   * Cap on the number of bands per axis. Pages with very busy alignment
   * (long lists, dense tables) can produce many bands; the cap keeps the
   * cross-product manageable.
   */
  maxBandsPerAxis?: number;
}

const DEFAULT_GUTTER_EPSILON = 0;
const DEFAULT_MIN_BAND_FRACTION = 0.04; // band must span ≥ 4% of region axis
const DEFAULT_MAX_BANDS_PER_AXIS = 12;

interface Band {
  start: number;
  end: number; // exclusive
}

const findBandsFromProjection = (
  projection: Int32Array,
  axisStart: number,
  axisLength: number,
  minGutterPx: number,
  gutterEpsilon: number,
  minBandPx: number,
  maxBands: number
): Band[] => {
  // Sweep for runs of "above-eps" scanlines, separated by ≥ minGutterPx of
  // "below-eps" scanlines.
  const bands: Band[] = [];
  let inBand = false;
  let bandStart = 0;
  let gutterRun = 0;
  let pendingEnd = 0;
  for (let i = 0; i < axisLength; i += 1) {
    const v = projection[i] | 0;
    if (v > gutterEpsilon) {
      if (!inBand) {
        bandStart = i;
        inBand = true;
      }
      gutterRun = 0;
      pendingEnd = i + 1;
    } else if (inBand) {
      gutterRun += 1;
      if (gutterRun >= minGutterPx) {
        const start = axisStart + bandStart;
        const end = axisStart + pendingEnd;
        if (end - start >= minBandPx) {
          bands.push({ start, end });
        }
        inBand = false;
        gutterRun = 0;
      }
    }
  }
  if (inBand) {
    const start = axisStart + bandStart;
    const end = axisStart + pendingEnd;
    if (end - start >= minBandPx) {
      bands.push({ start, end });
    }
  }
  if (bands.length > maxBands) {
    // Keep the longest spans — short residual bands are usually anti-alias
    // tails or icon flecks, not real label/value cells.
    bands.sort((a, b) => b.end - b.start - (a.end - a.start));
    bands.length = maxBands;
    bands.sort((a, b) => a.start - b.start);
  }
  return bands;
};

/**
 * Detect cells inside `region` from foreground-pixel alignment alone. Returns
 * the row × column cross-product as rectangles (pixel-space bounds), each
 * tightened to its row band × column band.
 */
export const detectAlignmentCells = (
  foregroundMask: Uint8Array,
  options: AlignmentCellsOptions
): AlignmentCellsPixelBounds[] => {
  const { region, surfaceWidth, surfaceHeight } = options;
  const left = Math.max(0, region.left);
  const top = Math.max(0, region.top);
  const right = Math.min(surfaceWidth, region.right);
  const bottom = Math.min(surfaceHeight, region.bottom);
  const w = right - left;
  const h = bottom - top;
  if (w < 4 || h < 4) {
    return [];
  }
  const minGutterPx =
    options.minGutterPx !== undefined
      ? Math.max(1, options.minGutterPx)
      : Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const gutterEpsilon = options.gutterEpsilon ?? DEFAULT_GUTTER_EPSILON;
  const minBandPx =
    options.minBandPx !== undefined
      ? Math.max(1, options.minBandPx)
      : Math.max(4, Math.round(Math.min(w, h) * DEFAULT_MIN_BAND_FRACTION));
  const maxBands = options.maxBandsPerAxis ?? DEFAULT_MAX_BANDS_PER_AXIS;

  const rowProjection = new Int32Array(h);
  const colProjection = new Int32Array(w);
  for (let yy = 0; yy < h; yy += 1) {
    const rowBase = (top + yy) * surfaceWidth;
    let rowCount = 0;
    for (let xx = 0; xx < w; xx += 1) {
      const v = foregroundMask[rowBase + left + xx];
      if (v === 1) {
        rowCount += 1;
        colProjection[xx] += 1;
      }
    }
    rowProjection[yy] = rowCount;
  }

  const rowBands = findBandsFromProjection(
    rowProjection,
    top,
    h,
    minGutterPx,
    gutterEpsilon,
    minBandPx,
    maxBands
  );
  const colBands = findBandsFromProjection(
    colProjection,
    left,
    w,
    minGutterPx,
    gutterEpsilon,
    minBandPx,
    maxBands
  );

  if (rowBands.length === 0 || colBands.length === 0) {
    return [];
  }

  const out: AlignmentCellsPixelBounds[] = [];
  for (const r of rowBands) {
    for (const c of colBands) {
      out.push({ left: c.start, top: r.start, right: c.end, bottom: r.end });
    }
  }
  return out;
};
