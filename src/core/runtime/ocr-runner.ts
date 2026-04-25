export interface OcrRunner {
  run(): Promise<void>;
}

export const createOcrRunner = (): OcrRunner => ({
  run: async () => {
    throw new Error('OCR runtime is not implemented in foundation phase.');
  }
});
