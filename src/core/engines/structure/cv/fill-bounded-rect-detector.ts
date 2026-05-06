/**
 * Fill-bounded rectangle detection.
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
 * This module finds those cards directly: classify pixels into a small set of
 * luminance bands (page-background, mid-fill, high-contrast), then run a
 * 4-connected component pass on the mid-fill band only. The card surface
 * forms one component bounded by the page-background pixels around it; text
 * and icons inside the card sit in the high-contrast band and form their own
 * holes that the surrounding fill flows around. The component bbox is the
 * card rect.
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
  /** Half-width of the page-bg band. */
  bgTolerance?: number;
  /**
   * Mid-fill band: `Δ ∈ [bgTolerance, fillUpperDelta)`. A card whose fill
   * differs from the page bg by 5–60 luminance units lands here. Above this
   * delta a pixel is treated as "high-contrast" (text / icon) and is excluded
   * from the connected component pass — those pixels are the holes the fill
   * wraps around.
   */
  fillUpperDelta?: number;
  /** Min component pixel area. */
  minComponentAreaPx?: number;
  /**
   * Min ratio (component pixels / bbox area). A real card with sparse text
   * sits at 0.7–0.95; long horizontal banners at 0.95+; a fragmented noisy
   * region at 0.2. The default 0.5 admits text-dense panels while still
   * rejecting incidental L-shaped or sliver fills produced by anti-aliasing
   * around glyph runs.
   */
  minRectangularity?: number;
  /**
   * Min side length (px). Below this a component is treated as glyph-noise.
   */
  minSidePx?: number;
}

const DEFAULT_BG_TOLERANCE = 3;
const DEFAULT_FILL_UPPER_DELTA = 60;
const DEFAULT_MIN_COMPONENT_AREA_PX = 600;
const DEFAULT_MIN_RECTANGULARITY = 0.5;
const DEFAULT_MIN_SIDE_PX = 24;

const luminanceAt = (data: Uint8ClampedArray, i: number): number =>
  0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

interface FillComponent extends FillBoundedRectsPixelBounds {
  pixelArea: number;
}

const buildFillClassMap = (
  pixels: ImageData,
  pageBg: number,
  bgTolerance: number,
  fillUpperDelta: number
): Uint8Array => {
  // 0 = bg, 1 = mid-fill, 2 = high-contrast/text. We only run CC on class 1.
  const { width, height, data } = pixels;
  const map = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a < 8) {
        // Treat transparent as background; matches the rest of the pipeline.
        map[y * width + x] = 0;
        continue;
      }
      const lum = luminanceAt(data, i);
      const delta = Math.abs(lum - pageBg);
      if (delta < bgTolerance) {
        map[y * width + x] = 0;
      } else if (delta < fillUpperDelta) {
        map[y * width + x] = 1;
      } else {
        map[y * width + x] = 2;
      }
    }
  }
  return map;
};

const findFillComponents = (
  classMap: Uint8Array,
  width: number,
  height: number,
  minAreaPx: number
): FillComponent[] => {
  const visited = new Uint8Array(width * height);
  const components: FillComponent[] = [];
  const queue = new Int32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const seed = y * width + x;
      if (visited[seed] === 1) {
        continue;
      }
      if (classMap[seed] !== 1) {
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
        const qy = (idx / width) | 0;
        area += 1;
        if (qx < left) left = qx;
        if (qx > right) right = qx;
        if (qy < top) top = qy;
        if (qy > bottom) bottom = qy;

        if (qx > 0) {
          const n = idx - 1;
          if (visited[n] === 0) {
            visited[n] = 1;
            if (classMap[n] === 1) queue[tail++] = n;
          }
        }
        if (qx < width - 1) {
          const n = idx + 1;
          if (visited[n] === 0) {
            visited[n] = 1;
            if (classMap[n] === 1) queue[tail++] = n;
          }
        }
        if (qy > 0) {
          const n = idx - width;
          if (visited[n] === 0) {
            visited[n] = 1;
            if (classMap[n] === 1) queue[tail++] = n;
          }
        }
        if (qy < height - 1) {
          const n = idx + width;
          if (visited[n] === 0) {
            visited[n] = 1;
            if (classMap[n] === 1) queue[tail++] = n;
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
 * Detect fill-bounded rectangles. Returns one rect per qualifying connected
 * component of mid-fill pixels. Designed to surface card-style UI surfaces
 * (rounded panels, dashboard cards, message bubbles) whose only structural
 * cue is a small luminance step against the page background.
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

  const classMap = buildFillClassMap(pixels, options.pageBackgroundLuminance, bgTolerance, fillUpperDelta);
  const components = findFillComponents(classMap, width, height, minAreaPx);

  const out: FillBoundedRectsPixelBounds[] = [];
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
  return out;
};
