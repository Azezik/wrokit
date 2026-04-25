import type { ExtractionResult } from '../contracts/extraction-result';

export interface ExtractionRunner {
  run(): Promise<ExtractionResult>;
}

export const createExtractionRunner = (): ExtractionRunner => ({
  run: async () => {
    throw new Error('Extraction runtime is not implemented in foundation phase.');
  }
});
