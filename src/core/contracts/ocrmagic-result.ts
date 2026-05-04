/**
 * OCRMagic result — output of the OCRMagic post-processing engine.
 *
 * OCRMagic is an **isolated** field-aware, column-aware cleanup layer that
 * runs over a finalized `MasterDbTable`. It NEVER reads NormalizedPage
 * pixels, never runs OCR, and never modifies the raw `MasterDbTable`,
 * `WizardFile`, `GeometryFile`, `StructuralModel`, `TransformationModel`,
 * `PredictedGeometryFile`, or `OcrBoxResult`. It emits its own versioned,
 * type-guarded artifact alongside the raw MasterDB so the user can choose
 * to download either.
 */

import type { MasterDbTable } from './masterdb-table';
import type { WizardFieldType } from './wizard';

export type OcrMagicChangeType =
  | 'unchanged'
  | 'edge-cleaned'
  | 'whitespace-normalized'
  | 'type-substituted'
  | 'pattern-corrected'
  | 'flagged';

export interface OcrMagicCellAudit {
  documentId: string;
  fieldId: string;
  rawValue: string;
  cleanValue: string;
  changeType: OcrMagicChangeType;
  confidenceBefore: number;
  confidenceAfter: number;
  reasonCodes: string[];
}

export type OcrMagicCharClass = 'letter' | 'digit' | 'space' | 'symbol' | 'mixed' | 'empty';

export interface OcrMagicLengthStats {
  min: number;
  max: number;
  mode: number;
  mean: number;
}

export interface OcrMagicFieldProfile {
  fieldId: string;
  /** Field type as declared by the WizardFile. */
  declaredType: WizardFieldType;
  /** Coarse behavior bucket inferred from the column samples. */
  inferredKind: 'text' | 'numeric' | 'mixed' | 'empty';
  sampleCount: number;
  nonEmptySampleCount: number;
  length: OcrMagicLengthStats;
  /** Majority char class at each position (left-aligned). */
  charClassByPosition: OcrMagicCharClass[];
  commonPrefixes: string[];
  commonSuffixes: string[];
  separators: string[];
  /** Values that appear more than once in the column. */
  repeatedValues: string[];
}

export interface OcrMagicResult {
  schema: 'wrokit/ocrmagic-result';
  version: '1.0';
  /** Mirror of the source `MasterDbTable.wizardId` for traceability. */
  wizardId: string;
  generatedAtIso: string;
  /** Cleaned, field-type-aware copy of the source `MasterDbTable`. */
  cleanedTable: MasterDbTable;
  /** Per-field PatternProfile learned from the column samples. */
  profiles: Record<string, OcrMagicFieldProfile>;
  /** One audit entry per cell in the source table (rectangular). */
  audits: OcrMagicCellAudit[];
  /** Aggregate counters keyed by `OcrMagicChangeType`. */
  changeCounts: Record<OcrMagicChangeType, number>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isCharClass = (value: unknown): value is OcrMagicCharClass =>
  value === 'letter' ||
  value === 'digit' ||
  value === 'space' ||
  value === 'symbol' ||
  value === 'mixed' ||
  value === 'empty';

const isCellAudit = (value: unknown): value is OcrMagicCellAudit => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.documentId === 'string' &&
    typeof value.fieldId === 'string' &&
    typeof value.rawValue === 'string' &&
    typeof value.cleanValue === 'string' &&
    typeof value.changeType === 'string' &&
    typeof value.confidenceBefore === 'number' &&
    typeof value.confidenceAfter === 'number' &&
    isStringArray(value.reasonCodes)
  );
};

const isFieldProfile = (value: unknown): value is OcrMagicFieldProfile => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.fieldId === 'string' &&
    typeof value.declaredType === 'string' &&
    typeof value.inferredKind === 'string' &&
    typeof value.sampleCount === 'number' &&
    typeof value.nonEmptySampleCount === 'number' &&
    isRecord(value.length) &&
    Array.isArray(value.charClassByPosition) &&
    value.charClassByPosition.every(isCharClass) &&
    isStringArray(value.commonPrefixes) &&
    isStringArray(value.commonSuffixes) &&
    isStringArray(value.separators) &&
    isStringArray(value.repeatedValues)
  );
};

export const isOcrMagicResult = (value: unknown): value is OcrMagicResult => {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.schema !== 'wrokit/ocrmagic-result' ||
    value.version !== '1.0' ||
    typeof value.wizardId !== 'string' ||
    typeof value.generatedAtIso !== 'string' ||
    !isRecord(value.cleanedTable) ||
    !isRecord(value.profiles) ||
    !Array.isArray(value.audits) ||
    !isRecord(value.changeCounts)
  ) {
    return false;
  }
  if (!Object.values(value.profiles).every(isFieldProfile)) {
    return false;
  }
  return value.audits.every(isCellAudit);
};
