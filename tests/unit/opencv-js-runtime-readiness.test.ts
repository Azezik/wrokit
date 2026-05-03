import { describe, expect, it } from 'vitest';

import {
  awaitOpenCvRuntimeInitialization,
  isOpenCvRuntimeFullyInitialized,
  isOpenCvRuntimeObject,
  type OpenCvRuntimeLike
} from '../../src/core/engines/structure/cv/opencv-js-runtime-readiness';

/**
 * Regression coverage for the readiness sequence used by both the main-thread
 * `<script>` loader and the structural worker's fetch+eval loader. The bug
 * being guarded against: gating on Mat/MatVector/matFromImageData being
 * functions *before* awaiting `onRuntimeInitialized`. The Emscripten Module
 * is attached to `globalThis.cv` synchronously, but the WASM-backed entry
 * points only land on it after the runtime finishes booting — so the early
 * gate always reported "globalThis.cv is missing" and the structural pipeline
 * fell back to the heuristic.
 */
describe('opencv-js-runtime-readiness', () => {
  it('isOpenCvRuntimeObject accepts any non-null object (mirrors post-eval state)', () => {
    expect(isOpenCvRuntimeObject({})).toBe(true);
    expect(isOpenCvRuntimeObject({ unrelated: 1 })).toBe(true);
    expect(isOpenCvRuntimeObject(null)).toBe(false);
    expect(isOpenCvRuntimeObject(undefined)).toBe(false);
    expect(isOpenCvRuntimeObject('cv')).toBe(false);
  });

  it('isOpenCvRuntimeFullyInitialized requires Mat/MatVector/matFromImageData functions', () => {
    expect(isOpenCvRuntimeFullyInitialized({})).toBe(false);
    expect(isOpenCvRuntimeFullyInitialized({ Mat: () => null })).toBe(false);
    expect(
      isOpenCvRuntimeFullyInitialized({
        Mat: () => null,
        MatVector: () => null,
        matFromImageData: () => null
      })
    ).toBe(true);
  });

  it('resolves when onRuntimeInitialized fires after Mat/MatVector/matFromImageData attach', async () => {
    const cv: OpenCvRuntimeLike = {};
    const pending = awaitOpenCvRuntimeInitialization(cv, { timeoutMs: 5_000 });

    // Simulate Emscripten finishing WASM compile a tick later: it attaches
    // the entry points and then invokes Module.onRuntimeInitialized.
    await Promise.resolve();
    (cv as Record<string, unknown>).Mat = () => null;
    (cv as Record<string, unknown>).MatVector = () => null;
    (cv as Record<string, unknown>).matFromImageData = () => null;
    cv.onRuntimeInitialized?.();

    const result = await pending;
    expect(result).toEqual({ ok: true });
    expect(cv.ready).toBe(true);
  });

  it('resolves immediately when the runtime is already fully initialized', async () => {
    const cv: OpenCvRuntimeLike = {
      Mat: () => null,
      MatVector: () => null,
      matFromImageData: () => null
    };
    const result = await awaitOpenCvRuntimeInitialization(cv, { timeoutMs: 5_000 });
    expect(result).toEqual({ ok: true });
    expect(cv.ready).toBe(true);
  });

  it('preserves any pre-existing onRuntimeInitialized handler', async () => {
    let originalCalled = false;
    const cv: OpenCvRuntimeLike = {
      onRuntimeInitialized: () => {
        originalCalled = true;
      }
    };
    const pending = awaitOpenCvRuntimeInitialization(cv, { timeoutMs: 5_000 });

    (cv as Record<string, unknown>).Mat = () => null;
    (cv as Record<string, unknown>).MatVector = () => null;
    (cv as Record<string, unknown>).matFromImageData = () => null;
    cv.onRuntimeInitialized?.();

    const result = await pending;
    expect(result).toEqual({ ok: true });
    expect(originalCalled).toBe(true);
  });

  it('returns a clear failure when onRuntimeInitialized fires but entry points are still missing', async () => {
    const cv: OpenCvRuntimeLike = {};
    const pending = awaitOpenCvRuntimeInitialization(cv, { timeoutMs: 5_000 });

    await Promise.resolve();
    cv.onRuntimeInitialized?.();

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not-initialized');
      expect(result.detail).toMatch(/Mat/);
    }
  });

  it('times out cleanly when the runtime never finishes booting', async () => {
    const cv: OpenCvRuntimeLike = {};
    const result = await awaitOpenCvRuntimeInitialization(cv, { timeoutMs: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
      expect(result.detail).toMatch(/20ms/);
    }
  });

  it('settles successfully if the runtime finishes booting between existence check and handler install (race)', async () => {
    // Construct a cv whose `onRuntimeInitialized` setter eagerly attaches
    // Mat/MatVector/matFromImageData — emulating the case where WASM init
    // resolved between the existence check and our handler install.
    const cv: Record<string, unknown> & OpenCvRuntimeLike = {};
    Object.defineProperty(cv, 'onRuntimeInitialized', {
      configurable: true,
      set(_value: (() => void) | null | undefined) {
        cv.Mat = () => null;
        cv.MatVector = () => null;
        cv.matFromImageData = () => null;
      },
      get() {
        return undefined;
      }
    });

    const result = await awaitOpenCvRuntimeInitialization(cv as OpenCvRuntimeLike, {
      timeoutMs: 5_000
    });
    expect(result).toEqual({ ok: true });
  });
});
