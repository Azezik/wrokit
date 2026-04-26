import type { NormalizedPage } from '../contracts/normalized-page';

export interface PageSurface {
  pageIndex: number;
  surfaceWidth: number;
  surfaceHeight: number;
}

export interface DisplayRect {
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface SurfacePoint {
  x: number;
  y: number;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NormalizedRect {
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
}

export interface SurfaceTransform {
  surface: PageSurface;
  display: DisplayRect;
  scaleX: number;
  scaleY: number;
}

export class SurfaceAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceAuthorityError';
  }
}

export const getPageSurface = (page: NormalizedPage): PageSurface => {
  if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) {
    throw new SurfaceAuthorityError('NormalizedPage has invalid surface dimensions.');
  }
  return {
    pageIndex: page.pageIndex,
    surfaceWidth: page.width,
    surfaceHeight: page.height
  };
};

export const buildSurfaceTransform = (surface: PageSurface, display: DisplayRect): SurfaceTransform => {
  if (display.width <= 0 || display.height <= 0) {
    throw new SurfaceAuthorityError('Display rect must have positive width and height.');
  }
  return {
    surface,
    display,
    scaleX: surface.surfaceWidth / display.width,
    scaleY: surface.surfaceHeight / display.height
  };
};

export const screenToSurface = (
  transform: SurfaceTransform,
  screenPoint: ScreenPoint
): SurfacePoint => ({
  x: screenPoint.x * transform.scaleX,
  y: screenPoint.y * transform.scaleY
});

export const surfaceToScreen = (
  transform: SurfaceTransform,
  surfacePoint: SurfacePoint
): ScreenPoint => ({
  x: surfacePoint.x / transform.scaleX,
  y: surfacePoint.y / transform.scaleY
});

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export const surfaceRectToNormalized = (
  surface: PageSurface,
  rect: PixelRect
): NormalizedRect => ({
  xNorm: clamp01(rect.x / surface.surfaceWidth),
  yNorm: clamp01(rect.y / surface.surfaceHeight),
  wNorm: clamp01(rect.width / surface.surfaceWidth),
  hNorm: clamp01(rect.height / surface.surfaceHeight)
});

export const normalizedRectToSurface = (
  surface: PageSurface,
  rect: NormalizedRect
): PixelRect => ({
  x: rect.xNorm * surface.surfaceWidth,
  y: rect.yNorm * surface.surfaceHeight,
  width: rect.wNorm * surface.surfaceWidth,
  height: rect.hNorm * surface.surfaceHeight
});

export const normalizedRectToScreen = (
  transform: SurfaceTransform,
  rect: NormalizedRect
): PixelRect => {
  const surfaceRect = normalizedRectToSurface(transform.surface, rect);
  return {
    x: surfaceRect.x / transform.scaleX,
    y: surfaceRect.y / transform.scaleY,
    width: surfaceRect.width / transform.scaleX,
    height: surfaceRect.height / transform.scaleY
  };
};

export const isNormalizedRectInBounds = (rect: NormalizedRect): boolean => {
  const valid = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
  if (!valid(rect.xNorm) || !valid(rect.yNorm) || !valid(rect.wNorm) || !valid(rect.hNorm)) {
    return false;
  }
  if (rect.wNorm <= 0 || rect.hNorm <= 0) {
    return false;
  }
  return rect.xNorm + rect.wNorm <= 1 + Number.EPSILON && rect.yNorm + rect.hNorm <= 1 + Number.EPSILON;
};

export const assertSurfaceMatches = (a: PageSurface, b: PageSurface): void => {
  if (
    a.pageIndex !== b.pageIndex ||
    a.surfaceWidth !== b.surfaceWidth ||
    a.surfaceHeight !== b.surfaceHeight
  ) {
    throw new SurfaceAuthorityError('Surface mismatch: geometry does not refer to the same NormalizedPage surface.');
  }
};

export const normalizeRectFromCorners = (
  a: SurfacePoint,
  b: SurfacePoint,
  surface: PageSurface
): PixelRect => {
  const x = Math.max(0, Math.min(a.x, b.x));
  const y = Math.max(0, Math.min(a.y, b.y));
  const right = Math.min(surface.surfaceWidth, Math.max(a.x, b.x));
  const bottom = Math.min(surface.surfaceHeight, Math.max(a.y, b.y));
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y)
  };
};
