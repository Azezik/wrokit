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
import type { NormalizedPage } from '../contracts/normalized-page';
import type { StructuralModel } from '../contracts/structural-model';
import type { PageSurface } from '../page-surface/page-surface';

const OPENCV_SCRIPT_URL = 'https://docs.opencv.org/4.x/opencv.js';

declare const self: DedicatedWorkerGlobalScope;

interface OpenCvLikeReady {
  ready?: boolean;
  onRuntimeInitialized?: () => void;
}

const isOpenCvLike = (value: unknown): value is OpenCvLikeReady & Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const cv = value as Record<string, unknown>;
  return (
    typeof cv.Mat === 'function' &&
    typeof cv.MatVector === 'function' &&
    typeof cv.matFromImageData === 'function'
  );
};

let runtimePromise: Promise<OpenCvRuntimeLoadResult> | null = null;

const ensureWorkerOpenCvRuntime = (): Promise<OpenCvRuntimeLoadResult> => {
  if (runtimePromise) {
    return runtimePromise;
  }
  runtimePromise = (async (): Promise<OpenCvRuntimeLoadResult> => {
    const existing = (self as unknown as { cv?: unknown }).cv;
    if (isOpenCvLike(existing)) {
      return { status: 'already-available' };
    }

    // The structural worker is a module worker (see structural-runner.ts:
    // `new Worker(..., { type: 'module' })`). Module workers do not expose
    // `importScripts`, so we fetch the OpenCV.js source and evaluate it with
    // `self`/`globalThis` bound — equivalent to what `importScripts` would
    // have done in a classic worker. OpenCV.js attaches itself to the worker
    // global (`self.cv`).
    let source: string;
    try {
      const response = await fetch(OPENCV_SCRIPT_URL);
      if (!response.ok) {
        return {
          status: 'unavailable',
          reason: `OpenCV.js fetch failed: HTTP ${response.status} ${response.statusText}`
        };
      }
      source = await response.text();
    } catch (error) {
      return {
        status: 'unavailable',
        reason: `OpenCV.js fetch failed: ${error instanceof Error ? error.message : String(error)}`
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

    const cv = (self as unknown as { cv?: unknown }).cv;
    if (!isOpenCvLike(cv)) {
      return {
        status: 'unavailable',
        reason: 'OpenCV.js script loaded in worker but globalThis.cv is missing.'
      };
    }
    if (cv.ready === true) {
      return { status: 'loaded' };
    }
    if (typeof cv.onRuntimeInitialized !== 'function') {
      cv.ready = true;
      return { status: 'loaded' };
    }
    await new Promise<void>((resolve) => {
      const original = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => {
        if (typeof original === 'function') {
          original();
        }
        cv.ready = true;
        resolve();
      };
    });
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
