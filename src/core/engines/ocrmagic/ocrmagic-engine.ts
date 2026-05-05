/**
 * OCRMagic engine — modular, field-type-aware MasterDB cleanup.
 *
 * Pipeline (per cell):
 *   1.  Stage 1:  field-type-aware character substitutions.
 *                 - any:     no-op
 *                 - numeric: letter→digit OCR-mistake corrections
 *                 - text:    digit→letter OCR-mistake corrections
 *   2.  Stage 1B: small per-field-type edge / whitespace cleanup
 *                 (applies to any, numeric, and text — independently
 *                 configurable per type).
 *
 * The engine is pure: it never reads NormalizedPage pixels, never calls OCR,
 * never inspects geometry / structure / OpenCV, and never mutates its inputs.
 * The raw `MasterDbTable` is preserved verbatim; the cleaned table is a
 * parallel artifact.
 */

import type { Engine } from '../engine';
import type { MasterDbRow, MasterDbTable } from '../../contracts/masterdb-table';
import type {
  OcrMagicCellAudit,
  OcrMagicChangeType,
  OcrMagicResult
} from '../../contracts/ocrmagic-result';
import type { WizardField, WizardFile } from '../../contracts/wizard';

import { runStage1 } from './stage-1';
import { runStage1b } from './stage-1b';
import type { OcrMagicCleanInput, OcrMagicCleanOutput } from './types';

const fieldTypeOf = (wizard: WizardFile, fieldId: string): WizardField['type'] => {
  const field = wizard.fields.find((entry) => entry.fieldId === fieldId);
  return field?.type ?? 'any';
};

const cloneTableSkeleton = (table: MasterDbTable): MasterDbTable => ({
  schema: 'wrokit/masterdb-table',
  version: '1.0',
  wizardId: table.wizardId,
  fieldOrder: [...table.fieldOrder],
  rows: table.rows.map((row) => ({
    documentId: row.documentId,
    sourceName: row.sourceName,
    extractedAtIso: row.extractedAtIso,
    values: { ...row.values }
  }))
});

const summarizeChangeType = (
  stage1Changed: boolean,
  stage1bChanged: boolean
): OcrMagicChangeType => {
  if (stage1Changed && stage1bChanged) {
    return 'stage-1-and-1b';
  }
  if (stage1Changed) {
    return 'stage-1';
  }
  if (stage1bChanged) {
    return 'stage-1b';
  }
  return 'unchanged';
};

const emptyChangeCounts = (): Record<OcrMagicChangeType, number> => ({
  unchanged: 0,
  'stage-1': 0,
  'stage-1b': 0,
  'stage-1-and-1b': 0
});

export const createOcrMagicEngine = (): Engine<OcrMagicCleanInput, OcrMagicCleanOutput> => ({
  name: 'ocrmagic-engine',
  version: '1.1',
  run: async (input: OcrMagicCleanInput): Promise<OcrMagicCleanOutput> => {
    const { wizard, masterDb } = input;
    const cleanedTable = cloneTableSkeleton(masterDb);

    const audits: OcrMagicCellAudit[] = [];
    const changeCounts = emptyChangeCounts();

    for (const row of cleanedTable.rows) {
      for (const fieldId of cleanedTable.fieldOrder) {
        const fieldType = fieldTypeOf(wizard, fieldId);
        const rawValue = row.values[fieldId] ?? '';

        const stage1 = runStage1(rawValue, fieldType);
        const stage1b = runStage1b(stage1.value, fieldType);

        const cleanValue = stage1b.value;
        row.values[fieldId] = cleanValue;

        const changeType = summarizeChangeType(stage1.changed, stage1b.changed);
        changeCounts[changeType] += 1;

        audits.push({
          documentId: row.documentId,
          fieldId,
          fieldType,
          rawValue,
          cleanValue,
          changeType,
          reasonCodes: [...stage1.reasonCodes, ...stage1b.reasonCodes]
        });
      }
    }

    const result: OcrMagicResult = {
      schema: 'wrokit/ocrmagic-result',
      version: '1.1',
      wizardId: masterDb.wizardId,
      generatedAtIso: new Date().toISOString(),
      cleanedTable,
      audits,
      changeCounts
    };

    return { result };
  }
});

export type { OcrMagicCleanInput, OcrMagicCleanOutput, MasterDbRow };
