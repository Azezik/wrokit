import type { MasterDbRow, MasterDbTable } from '../../contracts/masterdb-table';
import type { OcrBoxResult } from '../../contracts/ocrbox-result';
import type { WizardFile } from '../../contracts/wizard';

/**
 * MasterDB engine input — apply N freshly-extracted OCRBOX results onto an
 * existing table (or seed a new one from the WizardFile).
 *
 * The engine is pure: it does not read pixels, does not call OCR, and does
 * not mutate the inputs. The wizard governs the locked column order; the
 * incoming OcrBoxResults provide one row each.
 */
export interface MasterDbApplyInput {
  wizard: WizardFile;
  /** Seed table to merge into. Pass `null` to create a fresh table. */
  existing: MasterDbTable | null;
  results: OcrBoxResult[];
}

export interface MasterDbApplyOutput {
  table: MasterDbTable;
  appendedRowIds: string[];
  replacedRowIds: string[];
}

export type { MasterDbRow };
