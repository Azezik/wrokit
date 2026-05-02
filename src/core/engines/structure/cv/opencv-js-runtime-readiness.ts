/**
 * Shared readiness helpers for the locally-vendored OpenCV.js bundle.
 *
 * Why this module exists: the techstark UMD wrapper synchronously assigns
 * `globalThis.cv = factory()` (or `self.cv = factory()` in a worker), but the
 * Emscripten Module that gets returned only attaches `Mat`, `MatVector`,
 * `matFromImageData`, etc. once the WebAssembly runtime finishes compiling and
 * fires `onRuntimeInitialized`. The previous loaders gated on Mat being a
 * function *before* awaiting init, so they always fell through to the
 * "globalThis.cv is missing" branch even though `cv` was an object — the
 * runtime simply hadn't finished booting yet.
 *
 * The correct sequence is: confirm `cv` is an object → await
 * `onRuntimeInitialized` (or short-circuit when the runtime is already
 * initialized) → validate Mat/MatVector/matFromImageData → only then declare
 * the runtime loaded. Both the main-thread script-tag loader and the worker
 * fetch+eval loader share this helper to keep the readiness logic in lockstep.
 */

export interface OpenCvRuntimeLike {
  ready?: boolean;
  onRuntimeInitialized?: (() => void) | null | undefined;
  [key: string]: unknown;
}

/**
 * Loose existence check: was `cv` actually defined (any non-null object)?
 *
 * Distinct from `isOpenCvRuntimeFullyInitialized` because right after the
 * UMD bundle evaluates the global is set to the bare Emscripten Module —
 * the WASM-backed methods land on it later.
 */
export const isOpenCvRuntimeObject = (value: unknown): value is OpenCvRuntimeLike => {
  return typeof value === 'object' && value !== null;
};

/**
 * Strict readiness check: are the WASM-backed entry points the structural
 * adapter actually consumes attached yet?
 */
export const isOpenCvRuntimeFullyInitialized = (
  value: unknown
): value is OpenCvRuntimeLike => {
  if (!isOpenCvRuntimeObject(value)) {
    return false;
  }
  const cv = value as Record<string, unknown>;
  return (
    typeof cv.Mat === 'function' &&
    typeof cv.MatVector === 'function' &&
    typeof cv.matFromImageData === 'function'
  );
};

export interface AwaitOpenCvRuntimeOptions {
  /**
   * Hard cap on how long to wait for `onRuntimeInitialized` to fire after the
   * UMD bundle has been evaluated. The Emscripten runtime should normally
   * resolve in well under a second on a desktop browser; the timeout exists
   * so that a genuinely broken WASM init (e.g. blocked by COOP/COEP headers,
   * or a bundle whose `.wasm` sibling is missing) surfaces as a clear
   * "unavailable" reason instead of hanging the structural pipeline.
   */
  timeoutMs?: number;
}

export interface OpenCvRuntimeAwaitOk {
  ok: true;
}

export interface OpenCvRuntimeAwaitFailure {
  ok: false;
  reason: 'timeout' | 'not-initialized';
  detail: string;
}

export type OpenCvRuntimeAwaitResult = OpenCvRuntimeAwaitOk | OpenCvRuntimeAwaitFailure;

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Resolves once the OpenCV.js runtime has finished booting WASM and the
 * structural-adapter entry points are attached, or with a structured failure
 * if it does not finish in time.
 *
 * Implementation notes:
 *  - If Mat/MatVector/matFromImageData are already functions when this is
 *    called, we resolve immediately (covers re-entry and the "already
 *    available" path).
 *  - Otherwise we install our own `onRuntimeInitialized` callback (preserving
 *    any pre-existing one). Emscripten reads `Module.onRuntimeInitialized`
 *    at the end of `run()`, so installing it after `factory()` returns is
 *    fine: it will still be invoked when the WASM ctors finish.
 *  - Because there is a small race where WASM init could complete between
 *    our existence check and the callback install, we re-check Mat right
 *    after install and resolve synchronously if it's already there.
 */
const hasOpenCvEntryPoints = (cv: OpenCvRuntimeLike): boolean => {
  return (
    typeof cv.Mat === 'function' &&
    typeof cv.MatVector === 'function' &&
    typeof cv.matFromImageData === 'function'
  );
};

export const awaitOpenCvRuntimeInitialization = (
  runtime: OpenCvRuntimeLike,
  options: AwaitOpenCvRuntimeOptions = {}
): Promise<OpenCvRuntimeAwaitResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (hasOpenCvEntryPoints(runtime)) {
    runtime.ready = true;
    return Promise.resolve({ ok: true });
  }

  return new Promise<OpenCvRuntimeAwaitResult>((resolve) => {
    let settled = false;
    const settle = (result: OpenCvRuntimeAwaitResult) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      resolve(result);
    };

    let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timeoutHandle = null;
      if (hasOpenCvEntryPoints(runtime)) {
        runtime.ready = true;
        settle({ ok: true });
        return;
      }
      settle({
        ok: false,
        reason: 'timeout',
        detail: `OpenCV.js runtime did not finish initializing within ${timeoutMs}ms.`
      });
    }, timeoutMs);

    const previous = runtime.onRuntimeInitialized;
    runtime.onRuntimeInitialized = () => {
      if (typeof previous === 'function') {
        try {
          previous();
        } catch {
          // Ignore — we still want to consider the runtime ready below.
        }
      }
      if (hasOpenCvEntryPoints(runtime)) {
        runtime.ready = true;
        settle({ ok: true });
        return;
      }
      settle({
        ok: false,
        reason: 'not-initialized',
        detail:
          'OpenCV.js onRuntimeInitialized fired but Mat/MatVector/matFromImageData are not functions on globalThis.cv.'
      });
    };

    // Cover the race where WASM init resolved between the existence check
    // above and our handler install: if Mat already exists, settle now.
    if (hasOpenCvEntryPoints(runtime)) {
      runtime.ready = true;
      settle({ ok: true });
    }
  });
};
