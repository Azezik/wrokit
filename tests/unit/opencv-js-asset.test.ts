import { describe, expect, it } from 'vitest';

import { OPENCV_JS_ASSET_URL } from '../../src/core/engines/structure/cv/opencv-js-asset';

/**
 * Guards the local-only OpenCV.js install. The asset URL must come from the
 * vendored `@techstark/opencv-js` package (resolved via Vite's `?url`); any
 * regression that points it at a CDN or absolute remote URL would silently
 * resurrect the cross-origin failure mode that masked the OpenCV pipeline as
 * "loaded" while the heuristic fallback did all the work.
 */
describe('OPENCV_JS_ASSET_URL', () => {
  it('resolves to a non-empty string', () => {
    expect(typeof OPENCV_JS_ASSET_URL).toBe('string');
    expect(OPENCV_JS_ASSET_URL.length).toBeGreaterThan(0);
  });

  it('does not point at a remote/CDN host', () => {
    expect(OPENCV_JS_ASSET_URL).not.toMatch(/^https?:\/\//i);
    expect(OPENCV_JS_ASSET_URL).not.toMatch(/jsdelivr|unpkg|docs\.opencv\.org|cdnjs/i);
  });

  it('references the vendored opencv.js asset', () => {
    expect(OPENCV_JS_ASSET_URL).toMatch(/opencv.*\.js$/);
  });
});
