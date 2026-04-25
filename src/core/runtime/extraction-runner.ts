import type { ExtractionResult } from '../contracts/extraction-result';
import type { NormalizedPage } from '../contracts/normalized-page';

export interface ExtractionRunnerInput {
  pages: NormalizedPage[];
}

export interface ExtractionRunner {
  run(input: ExtractionRunnerInput): Promise<ExtractionResult>;
}

export const createExtractionRunner = (): ExtractionRunner => ({
  run: async () => {
    throw new Error('Extraction runtime is not implemented in foundation phase.');
  }
});
