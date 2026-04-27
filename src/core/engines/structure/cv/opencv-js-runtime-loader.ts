interface OpenCvReadyRuntime {
  onRuntimeInitialized?: () => void;
  [key: string]: unknown;
}

export interface OpenCvRuntimeLoadResult {
  status: 'loaded' | 'already-available' | 'unavailable';
  reason?: string;
}

const DEFAULT_OPENCV_SCRIPT_URL =
  'https://docs.opencv.org/4.x/opencv.js';

const SCRIPT_ATTR = 'data-wrokit-opencv-runtime';
const LOAD_TIMEOUT_MS = 12_000;

const hasDocument = (): boolean =>
  typeof document !== 'undefined' && typeof window !== 'undefined';

const isOpenCvLikeRuntime = (value: unknown): value is OpenCvReadyRuntime => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const cv = value as Partial<OpenCvReadyRuntime>;
  return (
    typeof cv.Mat === 'function' &&
    typeof cv.MatVector === 'function' &&
    typeof cv.matFromImageData === 'function'
  );
};

const runtimeFromGlobal = (): OpenCvReadyRuntime | null => {
  const cv = (globalThis as { cv?: unknown }).cv;
  return isOpenCvLikeRuntime(cv) ? cv : null;
};

const waitForRuntimeInitialization = (
  runtime: OpenCvReadyRuntime
): Promise<void> => {
  if ((runtime as { ready?: boolean }).ready === true) {
    return Promise.resolve();
  }

  if (typeof runtime.onRuntimeInitialized !== 'function') {
    (runtime as { ready?: boolean }).ready = true;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const original = runtime.onRuntimeInitialized;
    runtime.onRuntimeInitialized = () => {
      if (typeof original === 'function') {
        original();
      }
      (runtime as { ready?: boolean }).ready = true;
      resolve();
    };
  });
};

let pendingLoad: Promise<OpenCvRuntimeLoadResult> | null = null;

export const ensureOpenCvJsRuntime = async (
  scriptUrl = DEFAULT_OPENCV_SCRIPT_URL
): Promise<OpenCvRuntimeLoadResult> => {
  const existing = runtimeFromGlobal();
  if (existing) {
    return {
      status: 'already-available'
    };
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
    const existingScript = document.querySelector<HTMLScriptElement>(`script[${SCRIPT_ATTR}="true"]`);
    const script =
      existingScript ??
      (() => {
        const created = document.createElement('script');
        created.async = true;
        created.src = scriptUrl;
        created.setAttribute(SCRIPT_ATTR, 'true');
        document.head.appendChild(created);
        return created;
      })();

    let timeoutId: number | null = window.setTimeout(() => {
      timeoutId = null;
      resolve({
        status: 'unavailable',
        reason: 'Timed out waiting for OpenCV.js runtime.'
      });
    }, LOAD_TIMEOUT_MS);

    const finalize = (result: OpenCvRuntimeLoadResult) => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      resolve(result);
    };

    const handleReady = () => {
      const runtime = runtimeFromGlobal();
      if (!runtime) {
        finalize({
          status: 'unavailable',
          reason: 'OpenCV.js script loaded but runtime is not available on globalThis.cv.'
        });
        return;
      }

      void waitForRuntimeInitialization(runtime).then(() => {
        finalize({
          status: 'loaded'
        });
      });
    };

    script.addEventListener('load', handleReady, { once: true });
    script.addEventListener(
      'error',
      () =>
        finalize({
          status: 'unavailable',
          reason: 'OpenCV.js script failed to load.'
        }),
      { once: true }
    );

    if ((script as { readyState?: string }).readyState === 'complete') {
      handleReady();
      return;
    }

    if (runtimeFromGlobal()) {
      handleReady();
    }
  }).finally(() => {
    pendingLoad = null;
  });

  return pendingLoad;
};
