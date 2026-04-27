import type { PageSurface, PixelRect } from '../../../page-surface/page-surface';
import type { StructuralObjectType } from '../../../contracts/structural-model';

/**
 * Surface raster handle accepted by every CV adapter. The Structural Engine hands
 * a CV adapter only:
 *   - the canonical NormalizedPage surface (page authority) and
 *   - a pixel raster aligned to that surface (1:1 with `surface.surfaceWidth/Height`).
 *
 * CV adapters must not introduce a parallel image space, alternate canvas space,
 * or coordinate universe. They must read from the same raster surface that
 * NormalizedPage authors and Geometry capture both consume.
 */
export interface CvSurfaceRaster {
  surface: PageSurface;
  /**
   * RGBA pixel data. `width`/`height` MUST equal `surface.surfaceWidth/Height`,
   * otherwise the adapter is being asked to operate on a non-canonical surface
   * and must reject the input.
   */
  pixels: ImageData;
}

export interface CvContentRectResult {
  /**
   * Detected content rect in NormalizedPage surface coordinates. Always inside
   * `[0, 0, surfaceWidth, surfaceHeight]`. May equal the full surface when the
   * adapter cannot find usable content margins.
   */
  contentRectSurface: PixelRect;
  objectsSurface: CvSurfaceObject[];
}

export interface CvSurfaceObject {
  objectId: string;
  type: StructuralObjectType;
  bboxSurface: PixelRect;
  confidence: number;
}

export interface CvAdapter {
  readonly name: string;
  readonly version: string;
  /**
   * Detect the visible content rect on a single NormalizedPage surface. The
   * adapter must return a rect on the *same* surface it was handed; it must
   * never invent a different page geometry.
   */
  detectContentRect(input: CvSurfaceRaster): Promise<CvContentRectResult>;
}

export class CvAdapterSurfaceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CvAdapterSurfaceMismatchError';
  }
}

export const assertRasterMatchesSurface = (input: CvSurfaceRaster): void => {
  const { surface, pixels } = input;
  if (
    Math.round(pixels.width) !== Math.round(surface.surfaceWidth) ||
    Math.round(pixels.height) !== Math.round(surface.surfaceHeight)
  ) {
    throw new CvAdapterSurfaceMismatchError(
      'CV adapter raster does not match NormalizedPage surface dimensions; refusing to operate on a non-canonical surface.'
    );
  }
};
