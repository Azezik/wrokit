export interface ExtractedFieldValue {
  fieldId: string;
  value: string | number | boolean | null;
  confidence: number;
  source: 'localized-ocr';
}

export interface ExtractionResult {
  id: string;
  wizardId: string;
  documentFingerprint: string;
  fields: ExtractedFieldValue[];
  generatedAtIso: string;
}
