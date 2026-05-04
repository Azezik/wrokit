import type { NormalizedBoundingBox } from '../../contracts/geometry';
import type { NormalizedPage } from '../../contracts/normalized-page';
import type {
  OcrBoxBboxSource,
  OcrBoxFieldResult,
  OcrBoxResult
} from '../../contracts/ocrbox-result';

/**
 * One field box that the OCRBOX engine should read.
 * The bbox is in canonical NormalizedPage normalized [0, 1] coordinates.
 * The engine never modifies this bbox; it may apply a small symmetric
 * padding (`paddingNorm`) at crop time to recover characters that hug the
 * edge, but it always reports the exact padded bbox it actually used.
 */
export interface OcrBoxFieldRequest {
  fieldId: string;
  pageIndex: number;
  bbox: NormalizedBoundingBox;
}

export interface OcrBoxEngineInput {
  wizardId: string;
  documentFingerprint: string;
  bboxSource: OcrBoxBboxSource;
  sourceArtifactId: string;
  pages: NormalizedPage[];
  fields: OcrBoxFieldRequest[];
  /**
   * Symmetric normalized padding applied at crop time only.
   * Must be small (<= 0.02). The persisted Field BBOX is never changed.
   */
  paddingNorm?: number;
  /**
   * Optional override for the underlying OCR adapter. Tests use this to
   * inject a deterministic adapter; production wires Tesseract.js.
   */
  ocrAdapter?: OcrTextAdapter;
}

export type OcrBoxEngineOutput = OcrBoxResult;

export interface OcrCropImage {
  /** PNG data URL of the cropped region (already padded). */
  imageDataUrl: string;
  /** Crop dimensions in NormalizedPage surface pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** The bbox actually cropped (post-padding, clamped to [0,1]). */
  bboxUsed: NormalizedBoundingBox;
}

export interface OcrTextResult {
  text: string;
  confidence: number;
}

export interface OcrTextAdapter {
  readonly name: string;
  readonly version: string;
  recognize(crop: OcrCropImage): Promise<OcrTextResult>;
  /** Optional teardown for adapters that hold workers. */
  dispose?(): Promise<void>;
}

export type { OcrBoxFieldResult };
