import type { OcrCropImage, OcrTextAdapter, OcrTextResult } from './types';

/**
 * Lazy Tesseract.js adapter. The library is only imported on first use so
 * static-hosted pages do not pay the bundle cost until the user actually
 * runs OCR. The adapter holds a single worker for the session and disposes
 * it on `dispose()`.
 *
 * This is the only OCR-specific code in Wrokit. Any future swap (e.g. a
 * WASM-only backend or a server-side API) replaces just this file.
 */

interface TesseractWorkerLike {
  recognize(image: string): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<void>;
}

interface TesseractModuleLike {
  createWorker(language: string): Promise<TesseractWorkerLike>;
}

const ENGINE_NAME = 'ocrbox/tesseract-js';
const ENGINE_VERSION = '1.0';
const DEFAULT_LANGUAGE = 'eng';

export interface TesseractOcrAdapterOptions {
  language?: string;
}

export const createTesseractOcrAdapter = (
  options: TesseractOcrAdapterOptions = {}
): OcrTextAdapter => {
  const language = options.language ?? DEFAULT_LANGUAGE;
  let workerPromise: Promise<TesseractWorkerLike> | null = null;

  const ensureWorker = async (): Promise<TesseractWorkerLike> => {
    if (!workerPromise) {
      workerPromise = (async () => {
        const mod = (await import('tesseract.js')) as unknown as TesseractModuleLike;
        return mod.createWorker(language);
      })();
    }
    return workerPromise;
  };

  return {
    name: ENGINE_NAME,
    version: ENGINE_VERSION,
    recognize: async (crop: OcrCropImage): Promise<OcrTextResult> => {
      const worker = await ensureWorker();
      const result = await worker.recognize(crop.imageDataUrl);
      const rawConfidence = Number(result.data.confidence);
      const confidence = Number.isFinite(rawConfidence)
        ? Math.max(0, Math.min(1, rawConfidence / 100))
        : 0;
      return {
        text: typeof result.data.text === 'string' ? result.data.text : '',
        confidence
      };
    },
    dispose: async () => {
      if (!workerPromise) {
        return;
      }
      const worker = await workerPromise;
      workerPromise = null;
      await worker.terminate();
    }
  };
};
