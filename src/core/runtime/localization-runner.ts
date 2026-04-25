import type { NormalizedPage } from '../contracts/normalized-page';

export interface LocalizationRunnerInput {
  pages: NormalizedPage[];
}

export interface LocalizationRunner {
  run(input: LocalizationRunnerInput): Promise<void>;
}

export const createLocalizationRunner = (): LocalizationRunner => ({
  run: async () => {
    throw new Error('Localization runtime is not implemented in foundation phase.');
  }
});
