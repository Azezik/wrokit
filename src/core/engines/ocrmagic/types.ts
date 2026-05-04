import type { MasterDbTable } from '../../contracts/masterdb-table';
import type { OcrMagicResult } from '../../contracts/ocrmagic-result';
import type { WizardFile } from '../../contracts/wizard';

/**
 * OCRMagic engine input — a finalized `MasterDbTable` plus the `WizardFile`
 * the table was built from. The engine reads only `WizardFile.fields[].type`;
 * it never touches NormalizedPage pixels, OCR, geometry, or structure.
 */
export interface OcrMagicCleanInput {
  wizard: WizardFile;
  masterDb: MasterDbTable;
}

export interface OcrMagicCleanOutput {
  result: OcrMagicResult;
}
