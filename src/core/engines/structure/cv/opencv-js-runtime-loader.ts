import { OPENCV_JS_ASSET_URL } from './opencv-js-asset';
import {
  awaitOpenCvRuntimeInitialization,
  isOpenCvRuntimeFullyInitialized,
  isOpenCvRuntimeObject,
  type OpenCvRuntimeLike
} from './opencv-js-runtime-readiness';

export interface OpenCvRuntimeLoadResult {
  status: 'loaded' | 'already-available' | 'unavailable';
  reason?: string;
}

const SCRIPT_ATTR = 'data-wrokit-opencv-runtime';
const SCRIPT_LOAD_TIMEOUT_MS = 12_000;
const RUNTIME_INIT_TIMEOUT_MS = 15_000;

const hasDocument = (): boolean =>
  typeof document !== 'undefined' && typeof window !== 'undefined';

const readGlobalCv = (): unknown => (globalThis as { cv?: unknown }).cv;

let pendingLoad: Promise<OpenCvRuntimeLoadResult> | null = null;

/**
 * Load the locally vendored OpenCV.js build into the main thread.
 *
 * The asset URL comes from `OPENCV_JS_ASSET_URL` (Vite `?url` import of
 * `@techstark/opencv-js/dist/opencv.js`); it is served same-origin under the
 * app's base path. There is no CDN fallback — if the asset is missing or
 * fails to evaluate the result is `{ status: 'unavailable', reason: ... }`
 * and the caller surfaces it.
 *
 * Readiness sequence (shared with the structural worker via
 * `opencv-js-runtime-readiness`):
 *   1. Confirm `globalThis.cv` is a non-null object (the UMD bundle attaches
 *      the bare Emscripten Module synchronously at eval time).
 *   2. Await `onRuntimeInitialized` so the WASM runtime finishes booting.
 *   3. Validate Mat/MatVector/matFromImageData are functions before
 *      reporting `loaded`.
 */
export const ensureOpenCvJsRuntime = async (): Promise<OpenCvRuntimeLoadResult> => {
  const existing = readGlobalCv();
  if (isOpenCvRuntimeFullyInitialized(existing)) {
    return { status: 'already-available' };
  }

  if (!hasDocument()) {
    return {
      status: 'unavailable',
      reason: 'No browser DOM available to load OpenCV.js runtime.'
    };
  }

  if (pendingLoad) {
    return pendingLoad;
  }

  pendingLoad = new Promise<OpenCvRuntimeLoadResult>((resolve) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[${SCRIPT_ATTR}="true"]`
    );
    const script =
      existingScript ??
      (() => {
        const created = document.createElement('script');
        created.async = true;
        created.src = OPENCV_JS_ASSET_URL;
        created.setAttribute(SCRIPT_ATTR, 'true');
        document.head.appendChild(created);
        return created;
      })();

    let timeoutId: number | null = window.setTimeout(() => {
      timeoutId = null;
      resolve({
        status: 'unavailable',
        reason: `Timed out waiting for OpenCV.js script to load (${OPENCV_JS_ASSET_URL}).`
      });
    }, SCRIPT_LOAD_TIMEOUT_MS);

    const finalize = (result: OpenCvRuntimeLoadResult) => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      resolve(result);
    };

    const handleScriptReady = async () => {
      const cv = readGlobalCv();
      if (!isOpenCvRuntimeObject(cv)) {
        finalize({
          status: 'unavailable',
          reason: `OpenCV.js script evaluated but globalThis.cv is ${cv === null ? 'null' : typeof cv}.`
        });
        return;
      }

      const initResult = await awaitOpenCvRuntimeInitialization(cv as OpenCvRuntimeLike, {
        timeoutMs: RUNTIME_INIT_TIMEOUT_MS
      });
      if (!initResult.ok) {
        finalize({
          status: 'unavailable',
          reason: initResult.detail
        });
        return;
      }

      finalize({ status: 'loaded' });
    };

    script.addEventListener('load', () => void handleScriptReady(), { once: true });
    script.addEventListener(
      'error',
      () =>
        finalize({
          status: 'unavailable',
          reason: `OpenCV.js script failed to load from ${OPENCV_JS_ASSET_URL}.`
        }),
      { once: true }
    );

    if ((script as { readyState?: string }).readyState === 'complete') {
      void handleScriptReady();
      return;
    }

    if (isOpenCvRuntimeObject(readGlobalCv())) {
      void handleScriptReady();
    }
  }).finally(() => {
    pendingLoad = null;
  });

  return pendingLoad;
};
