export type ExtractedFieldSource = 'localized-ocr';

export interface ExtractedFieldValue {
  fieldId: string;
  value: string | number | boolean | null;
  confidence: number;
  source: ExtractedFieldSource;
}

export interface ExtractionResult {
  schema: 'wrokit/extraction-result';
  version: '1.0';
  id: string;
  wizardId: string;
  documentFingerprint: string;
  fields: ExtractedFieldValue[];
  generatedAtIso: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isExtractedFieldSource = (value: unknown): value is ExtractedFieldSource =>
  value === 'localized-ocr';

const isExtractedFieldValue = (value: unknown): value is ExtractedFieldValue => {
  if (!isRecord(value)) {
    return false;
  }
  const valueField = value.value;
  const valueOk =
    typeof valueField === 'string' ||
    typeof valueField === 'number' ||
    typeof valueField === 'boolean' ||
    valueField === null;
  return (
    typeof value.fieldId === 'string' &&
    valueOk &&
    typeof value.confidence === 'number' &&
    isExtractedFieldSource(value.source)
  );
};

export const isExtractionResult = (value: unknown): value is ExtractionResult => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.schema !== 'wrokit/extraction-result' ||
    value.version !== '1.0' ||
    typeof value.id !== 'string' ||
    typeof value.wizardId !== 'string' ||
    typeof value.documentFingerprint !== 'string' ||
    typeof value.generatedAtIso !== 'string' ||
    !Array.isArray(value.fields)
  ) {
    return false;
  }

  return value.fields.every(isExtractedFieldValue);
};
