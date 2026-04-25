export interface ConfidenceRunner {
  run(): Promise<void>;
}

export const createConfidenceRunner = (): ConfidenceRunner => ({
  run: async () => {
    throw new Error('Confidence runtime is not implemented in foundation phase.');
  }
});
