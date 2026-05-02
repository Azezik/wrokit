/// <reference lib="webworker" />

/**
 * Web Worker host for the Structural Engine.
 *
 * Why a worker:
 *  - `detectLineSegments` sweeps every row and column of the page raster, then
 *    `buildLineBoundedRects` evaluates O(H²·V²) line quadruples. On a complex
 *    form (~150 horizontals × 150 verticals) the quadruple loop alone is half
 *    a billion comparisons. Running on the main thread froze the browser badly
 *    enough that the user could not move the mouse.
 *  - The engine API is unchanged — unit tests still target the engine directly.
 *    Only the production runner tunnels work through this worker.
 *
 * Boundary contract:
 *  - In: a `StructuralWorkerRequest` containing a serializable
 *    `StructuralEngineInput`. Pages carry `imageDataUrl` strings, which are
 *    decoded inside the worker via `fetch` + `createImageBitmap`.
 *  - Out: a `StructuralWorkerResponse` with the resulting `StructuralModel`
 *    (or an error message) plus the OpenCV.js runtime load status observed
 *    inside this worker.
 */

import {
  createOpenCvJsAdapter,
  createStructuralEngine,
  type OpenCvRuntimeLoadResult,
  type StructuralEngineInput
} from '../engines/structure';
import { OPENCV_JS_ASSET_URL } from '../engines/structure/cv/opencv-js-asset';
import {
  awaitOpenCvRuntimeInitialization,
  isOpenCvRuntimeFullyInitialized,
  isOpenCvRuntimeObject,
  type OpenCvRuntimeLike
} from '../engines/structure/cv/opencv-js-runtime-readiness';
import type { NormalizedPage } from '../contracts/normalized-page';
import type { StructuralModel } from '../contracts/structural-model';
import type { PageSurface } from '../page-surface/page-surface';

// OpenCV.js is vendored via `@techstark/opencv-js`; the URL resolves to a
// same-origin asset under the app's base path (e.g. `/wrokit/assets/...`),
// shared with the main-thread loader. No CDN, no remote fetch.

declare const self: DedicatedWorkerGlobalScope;

let runtimePromise: Promise<OpenCvRuntimeLoadResult> | null = null;

const ensureWorkerOpenCvRuntime = (): Promise<OpenCvRuntimeLoadResult> => {
  if (runtimePromise) {
    return runtimePromise;
  }
  runtimePromise = (async (): Promise<OpenCvRuntimeLoadResult> => {
    const existing = (self as unknown as { cv?: unknown }).cv;
    if (isOpenCvRuntimeFullyInitialized(existing)) {
      return { status: 'already-available' };
    }

    // The structural worker is a module worker (see structural-runner.ts:
    // `new Worker(..., { type: 'module' })`). Module workers do not expose
    // `importScripts`, so we fetch the vendored OpenCV.js source and evaluate
    // it with `self`/`globalThis` bound — equivalent to what `importScripts`
    // would have done in a classic worker. OpenCV.js attaches itself to the
    // worker global (`self.cv`).
    let source: string;
    try {
      const response = await fetch(OPENCV_JS_ASSET_URL);
      if (!response.ok) {
        return {
          status: 'unavailable',
          reason: `OpenCV.js asset fetch failed (${OPENCV_JS_ASSET_URL}): HTTP ${response.status} ${response.statusText}`
        };
      }
      source = await response.text();
    } catch (error) {
      return {
        status: 'unavailable',
        reason: `OpenCV.js asset fetch failed (${OPENCV_JS_ASSET_URL}): ${error instanceof Error ? error.message : String(error)}`
      };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const evaluator = new Function('self', 'globalThis', 'window', source);
      evaluator.call(self, self, self, self);
    } catch (error) {
      return {
        status: 'unavailable',
        reason: `OpenCV.js evaluation failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    // The UMD bundle's `factory()` returns the bare Emscripten Module
    // synchronously. `Mat`, `MatVector`, `matFromImageData` only land on it
    // after the WASM runtime finishes compiling and `onRuntimeInitialized`
    // fires. Confirm `cv` is an object first, then await initialization,
    // then validate the entry points the structural adapter consumes.
    const cv = (self as unknown as { cv?: unknown }).cv;
    if (!isOpenCvRuntimeObject(cv)) {
      return {
        status: 'unavailable',
        reason: `OpenCV.js script evaluated in worker but globalThis.cv is ${cv === null ? 'null' : typeof cv}.`
      };
    }

    const initResult = await awaitOpenCvRuntimeInitialization(cv as OpenCvRuntimeLike);
    if (!initResult.ok) {
      return {
        status: 'unavailable',
        reason: initResult.detail
      };
    }
    return { status: 'loaded' };
  })();
  return runtimePromise;
};

const loadPageRasterInWorker = async (
  page: NormalizedPage,
  surface: PageSurface
): Promise<ImageData> => {
  const surfaceWidth = Math.round(surface.surfaceWidth);
  const surfaceHeight = Math.round(surface.surfaceHeight);

  const response = await fetch(page.imageDataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(surfaceWidth, surfaceHeight);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Could not create 2d OffscreenCanvas context for structural raster.');
    }
    context.drawImage(bitmap, 0, 0, surfaceWidth, surfaceHeight);
    return context.getImageData(0, 0, surfaceWidth, surfaceHeight) as ImageData;
  } finally {
    bitmap.close();
  }
};

export interface StructuralWorkerRequest {
  type: 'compute';
  id: number;
  input: StructuralEngineInput;
}

export interface StructuralWorkerSuccess {
  type: 'compute-result';
  id: number;
  ok: true;
  model: StructuralModel;
  runtimeLoadStatus: OpenCvRuntimeLoadResult;
}

export interface StructuralWorkerFailure {
  type: 'compute-result';
  id: number;
  ok: false;
  error: string;
  runtimeLoadStatus: OpenCvRuntimeLoadResult | null;
}

export type StructuralWorkerResponse = StructuralWorkerSuccess | StructuralWorkerFailure;

self.onmessage = async (event: MessageEvent<StructuralWorkerRequest>) => {
  const { id, input } = event.data;
  let runtimeLoadStatus: OpenCvRuntimeLoadResult | null = null;
  try {
    runtimeLoadStatus = await ensureWorkerOpenCvRuntime();
    const cvAdapter = createOpenCvJsAdapter();
    const engine = createStructuralEngine({
      cvAdapter,
      rasterLoader: (page, surface) => loadPageRasterInWorker(page, surface)
    });
    const model = await engine.run(input);
    const response: StructuralWorkerSuccess = {
      type: 'compute-result',
      id,
      ok: true,
      model,
      runtimeLoadStatus
    };
    self.postMessage(response);
  } catch (error) {
    const response: StructuralWorkerFailure = {
      type: 'compute-result',
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      runtimeLoadStatus
    };
    self.postMessage(response);
  }
};
