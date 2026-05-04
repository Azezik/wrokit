import type { MasterDbTable } from '../contracts/masterdb-table';
import type { OcrBoxResult } from '../contracts/ocrbox-result';
import type { WizardFile } from '../contracts/wizard';
import { createMasterDbEngine } from '../engines/masterdb';

/**
 * MasterDB runner — the only place the MasterDB engine is composed.
 * The engine reads other engines' outputs (OcrBoxResult + WizardFile) and
 * never modifies them.
 */
export interface MasterDbRunnerApplyInput {
  wizard: WizardFile;
  existing: MasterDbTable | null;
  results: OcrBoxResult[];
}

export interface MasterDbRunnerApplyOutput {
  table: MasterDbTable;
  appendedRowIds: string[];
  replacedRowIds: string[];
}

export interface MasterDbRunner {
  apply(input: MasterDbRunnerApplyInput): Promise<MasterDbRunnerApplyOutput>;
}

export const createMasterDbRunner = (): MasterDbRunner => {
  const engine = createMasterDbEngine();
  return {
    apply: async (input) => engine.run(input)
  };
};
