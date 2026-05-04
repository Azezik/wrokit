import type { MasterDbTable } from '../contracts/masterdb-table';
import type { OcrMagicResult } from '../contracts/ocrmagic-result';
import type { WizardFile } from '../contracts/wizard';
import { createOcrMagicEngine } from '../engines/ocrmagic';

/**
 * OCRMagic runner — the only place the OCRMagic engine is composed.
 *
 * The runner is a thin boundary around the engine. It accepts only the
 * `WizardFile` (for field-type metadata) and the `MasterDbTable` (the source
 * data). It does not read NormalizedPage pixels, run OCR, or touch any
 * other engine's contracts.
 */
export interface OcrMagicRunnerCleanInput {
  wizard: WizardFile;
  masterDb: MasterDbTable;
}

export interface OcrMagicRunnerCleanOutput {
  result: OcrMagicResult;
}

export interface OcrMagicRunner {
  clean(input: OcrMagicRunnerCleanInput): Promise<OcrMagicRunnerCleanOutput>;
}

export const createOcrMagicRunner = (): OcrMagicRunner => {
  const engine = createOcrMagicEngine();
  return {
    clean: async (input) => engine.run(input)
  };
};
