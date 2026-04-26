import { describe, expect, it } from 'vitest';

import type { NormalizedPage } from '../../src/core/contracts/normalized-page';
import {
  buildSurfaceTransform,
  getPageSurface,
  isNormalizedRectInBounds,
  normalizedRectToScreen,
  normalizedRectToSurface,
  normalizeRectFromCorners,
  screenToSurface,
  surfaceRectToNormalized,
  SurfaceAuthorityError
} from '../../src/core/page-surface/page-surface';

const page: NormalizedPage = {
  schema: 'wrokit/normalized-page',
  version: '2.0',
  pageIndex: 0,
  width: 1000,
  height: 2000,
  aspectRatio: 0.5,
  imageDataUrl: 'data:image/png;base64,xxx',
  sourceName: 'doc.pdf',
  normalization: {
    normalizedAtIso: '2026-01-01T00:00:00Z',
    boundary: 'intake-raster-only',
    pipelineVersion: '1.0'
  }
};

describe('page-surface', () => {
  it('derives a PageSurface from a NormalizedPage', () => {
    const surface = getPageSurface(page);
    expect(surface).toEqual({ pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 });
  });

  it('throws when surface dimensions are invalid', () => {
    expect(() => getPageSurface({ ...page, width: 0 })).toThrow(SurfaceAuthorityError);
  });

  it('maps screen points into surface coordinates via display transform', () => {
    const surface = getPageSurface(page);
    const transform = buildSurfaceTransform(surface, { width: 500, height: 1000 });
    expect(screenToSurface(transform, { x: 250, y: 500 })).toEqual({ x: 500, y: 1000 });
  });

  it('round-trips a normalized rect through surface -> screen -> normalized', () => {
    const surface = getPageSurface(page);
    const transform = buildSurfaceTransform(surface, { width: 500, height: 1000 });
    const normalized = { xNorm: 0.1, yNorm: 0.2, wNorm: 0.3, hNorm: 0.4 };
    const screenRect = normalizedRectToScreen(transform, normalized);
    expect(screenRect).toEqual({ x: 50, y: 200, width: 150, height: 400 });
    const back = surfaceRectToNormalized(surface, normalizedRectToSurface(surface, normalized));
    expect(back).toEqual(normalized);
  });

  it('clamps and rejects out-of-bounds normalized rects', () => {
    expect(isNormalizedRectInBounds({ xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 })).toBe(true);
    expect(isNormalizedRectInBounds({ xNorm: 0.9, yNorm: 0, wNorm: 0.2, hNorm: 0.2 })).toBe(false);
    expect(isNormalizedRectInBounds({ xNorm: 0, yNorm: 0, wNorm: 0, hNorm: 0.1 })).toBe(false);
    expect(isNormalizedRectInBounds({ xNorm: -0.1, yNorm: 0, wNorm: 0.5, hNorm: 0.5 })).toBe(false);
  });

  it('normalizes corner-drawn rects and clips them to the surface', () => {
    const surface = getPageSurface(page);
    const rect = normalizeRectFromCorners({ x: 1100, y: -10 }, { x: 200, y: 1500 }, surface);
    expect(rect.x).toBe(200);
    expect(rect.y).toBe(0);
    expect(rect.width).toBe(800);
    expect(rect.height).toBe(1500);
  });
});
