import type { GeometryFile } from '../contracts/geometry';
import type { NormalizedPage } from '../contracts/normalized-page';
import type { OcrBoxResult } from '../contracts/ocrbox-result';
import type { PredictedGeometryFile } from '../contracts/predicted-geometry-file';
import {
  createOcrBoxEngine,
  createTesseractOcrAdapter,
  type OcrBoxFieldRequest,
  type OcrTextAdapter
} from '../engines/ocrbox';

/**
 * OCRBOX runner — the only place the OCRBOX engine is composed.
 *
 * Reads field bboxes from either a GeometryFile (Config) or a
 * PredictedGeometryFile (Run). It never adjusts those bboxes; it only
 * tells the engine which boxes to read on which NormalizedPage.
 */

export interface OcrBoxRunnerExtractFromGeometryInput {
  geometry: GeometryFile;
  pages: NormalizedPage[];
  paddingNorm?: number;
}

export interface OcrBoxRunnerExtractFromPredictedInput {
  predicted: PredictedGeometryFile;
  pages: NormalizedPage[];
  paddingNorm?: number;
}

export interface OcrBoxRunner {
  extractFromGeometry(input: OcrBoxRunnerExtractFromGeometryInput): Promise<OcrBoxResult>;
  extractFromPredicted(input: OcrBoxRunnerExtractFromPredictedInput): Promise<OcrBoxResult>;
  dispose(): Promise<void>;
}

export interface OcrBoxRunnerOptions {
  /**
   * Inject an alternate adapter (e.g. for tests). When omitted, the runner
   * lazily creates a Tesseract.js adapter on first use.
   */
  adapter?: OcrTextAdapter;
}

const toFieldRequestsFromGeometry = (geometry: GeometryFile): OcrBoxFieldRequest[] =>
  geometry.fields.map((field) => ({
    fieldId: field.fieldId,
    pageIndex: field.pageIndex,
    bbox: field.bbox
  }));

const toFieldRequestsFromPredicted = (
  predicted: PredictedGeometryFile
): OcrBoxFieldRequest[] =>
  predicted.fields.map((field) => ({
    fieldId: field.fieldId,
    pageIndex: field.pageIndex,
    bbox: field.bbox
  }));

const fingerprintFromPages = (pages: NormalizedPage[]): string => {
  const first = pages[0];
  if (!first) {
    return '';
  }
  return `surface:${first.sourceName}#${first.pageIndex}:${first.width}x${first.height}`;
};

export const createOcrBoxRunner = (options: OcrBoxRunnerOptions = {}): OcrBoxRunner => {
  const adapter = options.adapter ?? createTesseractOcrAdapter();
  const engine = createOcrBoxEngine(adapter);

  return {
    extractFromGeometry: async ({ geometry, pages, paddingNorm }) =>
      engine.run({
        wizardId: geometry.wizardId,
        documentFingerprint: geometry.documentFingerprint || fingerprintFromPages(pages),
        bboxSource: 'geometry-file',
        sourceArtifactId: geometry.id,
        pages,
        fields: toFieldRequestsFromGeometry(geometry),
        paddingNorm
      }),
    extractFromPredicted: async ({ predicted, pages, paddingNorm }) =>
      engine.run({
        wizardId: predicted.wizardId,
        documentFingerprint:
          predicted.runtimeDocumentFingerprint || fingerprintFromPages(pages),
        bboxSource: 'predicted-geometry-file',
        sourceArtifactId: predicted.id,
        pages,
        fields: toFieldRequestsFromPredicted(predicted),
        paddingNorm
      }),
    dispose: async () => {
      if (adapter.dispose) {
        await adapter.dispose();
      }
    }
  };
};
