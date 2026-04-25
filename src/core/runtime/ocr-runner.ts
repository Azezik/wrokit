import type { NormalizedPage } from '../contracts/normalized-page';

export interface OcrRunnerInput {
  pages: NormalizedPage[];
}

export interface OcrRunner {
  run(input: OcrRunnerInput): Promise<void>;
}

export const createOcrRunner = (): OcrRunner => ({
  run: async () => {
    throw new Error('OCR runtime is not implemented in foundation phase.');
  }
});
