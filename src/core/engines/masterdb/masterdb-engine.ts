import type { Engine } from '../engine';
import type { MasterDbRow, MasterDbTable } from '../../contracts/masterdb-table';
import type { OcrBoxResult } from '../../contracts/ocrbox-result';
import type { WizardFile } from '../../contracts/wizard';

import type { MasterDbApplyInput, MasterDbApplyOutput } from './types';

const wizardFieldOrder = (wizard: WizardFile): string[] =>
  wizard.fields.map((field) => field.fieldId);

const reconcileFieldOrder = (
  wizard: WizardFile,
  existing: MasterDbTable | null
): string[] => {
  const wizardOrder = wizardFieldOrder(wizard);
  if (!existing) {
    return wizardOrder;
  }
  // Preserve existing order. Append (never reorder) wizard fields the
  // existing table is missing — that lets a previously-uploaded MasterDB
  // continue to work after a wizard is extended without rewriting headers
  // on the rows that already exist.
  const merged = [...existing.fieldOrder];
  for (const fieldId of wizardOrder) {
    if (!merged.includes(fieldId)) {
      merged.push(fieldId);
    }
  }
  return merged;
};

const documentIdFromOcrResult = (result: OcrBoxResult): string => {
  // Prefer the runtime/source artifact id so re-extraction of the same
  // upload always lands on the same row. Fall back to the documentFingerprint
  // when the artifact id is empty.
  return result.sourceArtifactId || result.documentFingerprint || result.id;
};

const sourceNameFromOcrResult = (result: OcrBoxResult): string =>
  // Mirror the human-readable identity we already persist on the run.
  result.documentFingerprint || result.sourceArtifactId || result.id;

const buildRow = (result: OcrBoxResult, fieldOrder: string[]): MasterDbRow => {
  const values: Record<string, string> = {};
  for (const fieldId of fieldOrder) {
    values[fieldId] = '';
  }
  for (const field of result.fields) {
    if (fieldOrder.includes(field.fieldId)) {
      values[field.fieldId] = field.text;
    }
  }
  return {
    documentId: documentIdFromOcrResult(result),
    sourceName: sourceNameFromOcrResult(result),
    extractedAtIso: result.generatedAtIso,
    values
  };
};

export const createMasterDbEngine = (): Engine<MasterDbApplyInput, MasterDbApplyOutput> => ({
  name: 'masterdb-engine',
  version: '1.0',
  run: async (input: MasterDbApplyInput): Promise<MasterDbApplyOutput> => {
    const fieldOrder = reconcileFieldOrder(input.wizard, input.existing);
    const startingRows: MasterDbRow[] = input.existing
      ? input.existing.rows.map((row) => ({
          ...row,
          values: { ...row.values }
        }))
      : [];

    // Backfill any newly-added fieldOrder columns onto existing rows so the
    // table stays rectangular without rewriting historical OCR values.
    for (const row of startingRows) {
      for (const fieldId of fieldOrder) {
        if (!(fieldId in row.values)) {
          row.values[fieldId] = '';
        }
      }
    }

    const indexByDocumentId = new Map<string, number>();
    startingRows.forEach((row, idx) => indexByDocumentId.set(row.documentId, idx));

    const appendedRowIds: string[] = [];
    const replacedRowIds: string[] = [];

    for (const result of input.results) {
      const newRow = buildRow(result, fieldOrder);
      const existingIdx = indexByDocumentId.get(newRow.documentId);
      if (existingIdx !== undefined) {
        startingRows[existingIdx] = newRow;
        replacedRowIds.push(newRow.documentId);
      } else {
        startingRows.push(newRow);
        indexByDocumentId.set(newRow.documentId, startingRows.length - 1);
        appendedRowIds.push(newRow.documentId);
      }
    }

    const table: MasterDbTable = {
      schema: 'wrokit/masterdb-table',
      version: '1.0',
      wizardId: input.wizard.wizardName,
      fieldOrder,
      rows: startingRows
    };

    return { table, appendedRowIds, replacedRowIds };
  }
});

export const seedMasterDbTable = (wizard: WizardFile): MasterDbTable => ({
  schema: 'wrokit/masterdb-table',
  version: '1.0',
  wizardId: wizard.wizardName,
  fieldOrder: wizardFieldOrder(wizard),
  rows: []
});
