/**
 * OCRBOX result — output of the isolated, BBOX-only OCR engine.
 *
 * Authority rules:
 * - OCRBOX never adjusts a Field BBOX. It only reads the pixels strictly
 *   inside the (optionally lightly padded) crop.
 * - The source bbox is recorded so consumers can verify which exact region
 *   produced each value without re-running the engine.
 * - Confidence is the OCR engine's own per-field confidence in [0, 1].
 * - The artifact only references its source GeometryFile / PredictedGeometryFile
 *   by id; it does not embed or mutate either.
 */
import type { NormalizedBoundingBox } from './geometry';

export type OcrBoxFieldStatus = 'ok' | 'empty' | 'error';

export type OcrBoxBboxSource = 'geometry-file' | 'predicted-geometry-file';

export interface OcrBoxFieldResult {
  fieldId: string;
  pageIndex: number;
  text: string;
  confidence: number;
  status: OcrBoxFieldStatus;
  errorMessage?: string;
  bboxUsed: NormalizedBoundingBox;
  bboxPaddingNorm: number;
}

export interface OcrBoxResult {
  schema: 'wrokit/ocrbox-result';
  version: '1.0';
  id: string;
  wizardId: string;
  documentFingerprint: string;
  bboxSource: OcrBoxBboxSource;
  sourceArtifactId: string;
  engineName: string;
  engineVersion: string;
  generatedAtIso: string;
  fields: OcrBoxFieldResult[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isNormalizedBoundingBox = (value: unknown): value is NormalizedBoundingBox => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.xNorm) &&
    isFiniteNumber(value.yNorm) &&
    isFiniteNumber(value.wNorm) &&
    isFiniteNumber(value.hNorm)
  );
};

const isStatus = (value: unknown): value is OcrBoxFieldStatus =>
  value === 'ok' || value === 'empty' || value === 'error';

const isBboxSource = (value: unknown): value is OcrBoxBboxSource =>
  value === 'geometry-file' || value === 'predicted-geometry-file';

const isField = (value: unknown): value is OcrBoxFieldResult => {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.fieldId !== 'string' ||
    !isFiniteNumber(value.pageIndex) ||
    typeof value.text !== 'string' ||
    !isFiniteNumber(value.confidence) ||
    !isStatus(value.status) ||
    !isNormalizedBoundingBox(value.bboxUsed) ||
    !isFiniteNumber(value.bboxPaddingNorm)
  ) {
    return false;
  }
  if (value.errorMessage !== undefined && typeof value.errorMessage !== 'string') {
    return false;
  }
  return true;
};

export const isOcrBoxResult = (value: unknown): value is OcrBoxResult => {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.schema !== 'wrokit/ocrbox-result' ||
    value.version !== '1.0' ||
    typeof value.id !== 'string' ||
    typeof value.wizardId !== 'string' ||
    typeof value.documentFingerprint !== 'string' ||
    !isBboxSource(value.bboxSource) ||
    typeof value.sourceArtifactId !== 'string' ||
    typeof value.engineName !== 'string' ||
    typeof value.engineVersion !== 'string' ||
    typeof value.generatedAtIso !== 'string' ||
    !Array.isArray(value.fields)
  ) {
    return false;
  }
  return value.fields.every(isField);
};
