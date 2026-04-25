export interface LocalizationRunner {
  run(): Promise<void>;
}

export const createLocalizationRunner = (): LocalizationRunner => ({
  run: async () => {
    throw new Error('Localization runtime is not implemented in foundation phase.');
  }
});
