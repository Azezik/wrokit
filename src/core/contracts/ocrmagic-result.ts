/**
 * OCRMagic result — output of the OCRMagic post-processing engine.
 *
 * OCRMagic is an isolated cleanup layer that runs over a finalized
 * `MasterDbTable`. It NEVER reads NormalizedPage pixels, never runs OCR, and
 * never modifies the raw `MasterDbTable`, `WizardFile`, `GeometryFile`,
 * `StructuralModel`, `TransformationModel`, `PredictedGeometryFile`, or
 * `OcrBoxResult`. It emits its own versioned, type-guarded artifact
 * alongside the raw MasterDB so the user can choose to download either.
 *
 * It performs exactly two stages, in order, per cell:
 *   - Stage 1:  field-type-aware character substitutions
 *               (any → no-op, numeric → letters→digits, text → digits→letters).
 *   - Stage 1B: small per-field-type edge / whitespace cleanup
 *               (applies to any, numeric, and text — independently configurable).
 */

import type { MasterDbTable } from './masterdb-table';
import type { WizardFieldType } from './wizard';

export type OcrMagicChangeType =
  | 'unchanged'
  | 'stage-1'
  | 'stage-1b'
  | 'stage-1-and-1b';

export interface OcrMagicCellAudit {
  documentId: string;
  fieldId: string;
  fieldType: WizardFieldType;
  rawValue: string;
  cleanValue: string;
  changeType: OcrMagicChangeType;
  reasonCodes: string[];
}

export interface OcrMagicResult {
  schema: 'wrokit/ocrmagic-result';
  version: '1.1';
  wizardId: string;
  generatedAtIso: string;
  cleanedTable: MasterDbTable;
  audits: OcrMagicCellAudit[];
  changeCounts: Record<OcrMagicChangeType, number>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isFieldType = (value: unknown): value is WizardFieldType =>
  value === 'any' || value === 'text' || value === 'numeric';

const isChangeType = (value: unknown): value is OcrMagicChangeType =>
  value === 'unchanged' ||
  value === 'stage-1' ||
  value === 'stage-1b' ||
  value === 'stage-1-and-1b';

const isCellAudit = (value: unknown): value is OcrMagicCellAudit => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.documentId === 'string' &&
    typeof value.fieldId === 'string' &&
    isFieldType(value.fieldType) &&
    typeof value.rawValue === 'string' &&
    typeof value.cleanValue === 'string' &&
    isChangeType(value.changeType) &&
    isStringArray(value.reasonCodes)
  );
};

export const isOcrMagicResult = (value: unknown): value is OcrMagicResult => {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.schema !== 'wrokit/ocrmagic-result' ||
    value.version !== '1.1' ||
    typeof value.wizardId !== 'string' ||
    typeof value.generatedAtIso !== 'string' ||
    !isRecord(value.cleanedTable) ||
    !Array.isArray(value.audits) ||
    !isRecord(value.changeCounts)
  ) {
    return false;
  }
  return value.audits.every(isCellAudit);
};
