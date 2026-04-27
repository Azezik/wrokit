import { describe, expect, it } from 'vitest';

import type { NormalizedPage } from '../../src/core/contracts/normalized-page';
import {
  buildSurfaceTransform,
  getPageSurface,
  normalizedRectToScreen,
  normalizeRectFromCorners,
  screenToSurface,
  surfaceRectToNormalized
} from '../../src/core/page-surface/page-surface';
import {
  overlayPlaneStyle,
  pointerToImageRect
} from '../../src/core/page-surface/ui/NormalizedPageViewport';

const page: NormalizedPage = {
  schema: 'wrokit/normalized-page',
  version: '2.0',
  pageIndex: 0,
  width: 1000,
  height: 1500,
  aspectRatio: 1000 / 1500,
  imageDataUrl: 'data:image/png;base64,xxx',
  sourceName: 'doc.pdf',
  normalization: {
    normalizedAtIso: '2026-01-01T00:00:00Z',
    boundary: 'intake-raster-only',
    pipelineVersion: '1.0'
  }
};

const fakeImage = (rect: { x: number; y: number; width: number; height: number }) => ({
  getBoundingClientRect: () => ({
    x: rect.x,
    y: rect.y,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON() {
      return rect;
    }
  })
});

describe('NormalizedPageViewport — image plane = overlay plane invariant', () => {
  it('overlay plane style pins to (0,0,width,height) of the rendered image rect', () => {
    const display = { width: 640, height: 960 };
    expect(overlayPlaneStyle(display)).toEqual({
      position: 'absolute',
      left: 0,
      top: 0,
      width: '640px',
      height: '960px'
    });
  });

  it('normalized rect 0,0,1,1 maps exactly to the displayed image bounds', () => {
    const transform = buildSurfaceTransform(getPageSurface(page), { width: 640, height: 960 });
    const fullScreen = normalizedRectToScreen(transform, {
      xNorm: 0,
      yNorm: 0,
      wNorm: 1,
      hNorm: 1
    });
    expect(fullScreen).toEqual({ x: 0, y: 0, width: 640, height: 960 });
  });

  it('a saved BBOX maps back to the same screen location after a draw round-trip', () => {
    const display = { width: 800, height: 1200 };
    const surface = getPageSurface(page);
    const transform = buildSurfaceTransform(surface, display);

    // Simulate a user-drawn rect on screen (pointerdown + pointerup).
    const startScreen = { x: 120, y: 240 };
    const endScreen = { x: 360, y: 720 };

    // Capture: screen -> surface -> normalized.
    const startSurface = screenToSurface(transform, startScreen);
    const endSurface = screenToSurface(transform, endScreen);
    const pixelRect = normalizeRectFromCorners(startSurface, endSurface, surface);
    const normalized = surfaceRectToNormalized(surface, pixelRect);

    // Render: normalized -> screen, on the same transform, must reproduce the
    // original screen rect.
    const reproduced = normalizedRectToScreen(transform, normalized);
    expect(reproduced).toEqual({
      x: 120,
      y: 240,
      width: 240,
      height: 480
    });
  });

  it('saved normalized coordinates do not change when the displayed image is resized', () => {
    // The same visual location on the page must map to the same normalized
    // BBOX regardless of browser zoom, window width, or layout reflow.
    const surface = getPageSurface(page);
    const smallTransform = buildSurfaceTransform(surface, { width: 400, height: 600 });
    const largeTransform = buildSurfaceTransform(surface, { width: 1600, height: 2400 });

    // 25% from the left, 50% from the top, 50%×25% sized rect — same visual
    // rect on either display, in their own screen pixels.
    const screenRectSmall = { x: 100, y: 300, width: 200, height: 150 };
    const screenRectLarge = { x: 400, y: 1200, width: 800, height: 600 };

    const fromSmall = surfaceRectToNormalized(
      surface,
      normalizeRectFromCorners(
        screenToSurface(smallTransform, { x: screenRectSmall.x, y: screenRectSmall.y }),
        screenToSurface(smallTransform, {
          x: screenRectSmall.x + screenRectSmall.width,
          y: screenRectSmall.y + screenRectSmall.height
        }),
        surface
      )
    );
    const fromLarge = surfaceRectToNormalized(
      surface,
      normalizeRectFromCorners(
        screenToSurface(largeTransform, { x: screenRectLarge.x, y: screenRectLarge.y }),
        screenToSurface(largeTransform, {
          x: screenRectLarge.x + screenRectLarge.width,
          y: screenRectLarge.y + screenRectLarge.height
        }),
        surface
      )
    );

    expect(fromSmall).toEqual(fromLarge);
    expect(fromSmall).toEqual({
      xNorm: 0.25,
      yNorm: 0.5,
      wNorm: 0.5,
      hNorm: 0.25
    });
  });

  it('pointerToImageRect resolves clientX/Y against the rendered image, not its container', () => {
    // The bug from Wrokit 1: a wider container rect was being used as the
    // overlay coordinate plane, so pointer math drifted relative to the
    // actual rendered image. pointerToImageRect must always use the image's
    // own bounding rect, regardless of where the image sits on the page.
    const image = fakeImage({ x: 50, y: 80, width: 400, height: 600 });
    expect(pointerToImageRect(image, { clientX: 250, clientY: 380 })).toEqual({
      x: 200,
      y: 300
    });
  });

  it('pointerToImageRect clamps to the image rect (no off-image coordinates)', () => {
    const image = fakeImage({ x: 0, y: 0, width: 400, height: 600 });
    expect(pointerToImageRect(image, { clientX: -10, clientY: -10 })).toEqual({ x: 0, y: 0 });
    expect(pointerToImageRect(image, { clientX: 9999, clientY: 9999 })).toEqual({
      x: 400,
      y: 600
    });
  });

  it('returns null when no image element is present (no transform until rendered)', () => {
    expect(pointerToImageRect(null, { clientX: 0, clientY: 0 })).toBeNull();
  });
});
