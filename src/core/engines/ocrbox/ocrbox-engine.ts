import type { Engine } from '../engine';
import type { OcrBoxFieldResult, OcrBoxResult } from '../../contracts/ocrbox-result';

import { cropNormalizedPageBbox } from './bbox-cropper';
import type { OcrBoxEngineInput, OcrBoxEngineOutput, OcrTextAdapter } from './types';

const DEFAULT_PADDING_NORM = 0.004;

const cleanText = (raw: string): string => {
  // OCR commonly inserts trailing newlines and stray whitespace at the
  // crop edges. Collapse runs of whitespace, drop leading/trailing
  // whitespace, but preserve internal single spaces and per-line breaks
  // so multi-line fields (addresses, notes) stay readable.
  const normalizedLines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
  return normalizedLines.join('\n');
};

const idFor = (input: OcrBoxEngineInput): string => {
  const safeWizard = (input.wizardId || 'wizard').replace(/\s+/g, '-').toLowerCase();
  return `ocrbox_${safeWizard}_${Date.now()}`;
};

export const createOcrBoxEngine = (
  defaultAdapter?: OcrTextAdapter
): Engine<OcrBoxEngineInput, OcrBoxEngineOutput> => {
  return {
    name: 'ocrbox-engine',
    version: '1.0',
    run: async (input: OcrBoxEngineInput): Promise<OcrBoxResult> => {
      const adapter = input.ocrAdapter ?? defaultAdapter;
      if (!adapter) {
        throw new Error('OCRBOX engine requires an OCR adapter (none provided).');
      }
      const padding = input.paddingNorm ?? DEFAULT_PADDING_NORM;
      const fieldResults: OcrBoxFieldResult[] = [];

      for (const request of input.fields) {
        const page = input.pages.find((candidate) => candidate.pageIndex === request.pageIndex);
        if (!page) {
          fieldResults.push({
            fieldId: request.fieldId,
            pageIndex: request.pageIndex,
            text: '',
            confidence: 0,
            status: 'error',
            errorMessage: `No NormalizedPage for pageIndex ${request.pageIndex}.`,
            bboxUsed: request.bbox,
            bboxPaddingNorm: padding
          });
          continue;
        }

        let crop;
        try {
          crop = await cropNormalizedPageBbox(page, request.bbox, padding);
        } catch (error) {
          fieldResults.push({
            fieldId: request.fieldId,
            pageIndex: request.pageIndex,
            text: '',
            confidence: 0,
            status: 'error',
            errorMessage: error instanceof Error ? error.message : 'Crop failed.',
            bboxUsed: request.bbox,
            bboxPaddingNorm: padding
          });
          continue;
        }

        if (!crop) {
          fieldResults.push({
            fieldId: request.fieldId,
            pageIndex: request.pageIndex,
            text: '',
            confidence: 0,
            status: 'empty',
            bboxUsed: request.bbox,
            bboxPaddingNorm: padding
          });
          continue;
        }

        try {
          const recognized = await adapter.recognize(crop);
          const cleaned = cleanText(recognized.text);
          fieldResults.push({
            fieldId: request.fieldId,
            pageIndex: request.pageIndex,
            text: cleaned,
            confidence: recognized.confidence,
            status: cleaned.length > 0 ? 'ok' : 'empty',
            bboxUsed: crop.bboxUsed,
            bboxPaddingNorm: padding
          });
        } catch (error) {
          fieldResults.push({
            fieldId: request.fieldId,
            pageIndex: request.pageIndex,
            text: '',
            confidence: 0,
            status: 'error',
            errorMessage: error instanceof Error ? error.message : 'OCR adapter failed.',
            bboxUsed: crop.bboxUsed,
            bboxPaddingNorm: padding
          });
        }
      }

      return {
        schema: 'wrokit/ocrbox-result',
        version: '1.0',
        id: idFor(input),
        wizardId: input.wizardId,
        documentFingerprint: input.documentFingerprint,
        bboxSource: input.bboxSource,
        sourceArtifactId: input.sourceArtifactId,
        engineName: adapter.name,
        engineVersion: adapter.version,
        generatedAtIso: new Date().toISOString(),
        fields: fieldResults
      };
    }
  };
};
