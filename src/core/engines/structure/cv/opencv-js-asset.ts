/**
 * Single source of truth for the OpenCV.js asset URL.
 *
 * The build is vendored via the `@techstark/opencv-js` npm dependency. Vite's
 * `?url` query resolves to a same-origin asset URL at build time (hashed under
 * the configured base path, e.g. `/wrokit/assets/opencv-<hash>.js`). The same
 * URL is consumed by:
 *   - the main-thread loader (`opencv-js-runtime-loader.ts`), via a `<script>`
 *     tag, and
 *   - the structural worker (`structural-worker.ts`), via fetch + scoped eval
 *     (module workers cannot use `importScripts`).
 *
 * No CDN, no remote fetch, no fallback URL: if this asset cannot be served the
 * app fails loudly rather than silently falling back to a remote.
 */
import opencvJsAssetUrl from '@techstark/opencv-js/dist/opencv.js?url';

export const OPENCV_JS_ASSET_URL: string = opencvJsAssetUrl;
