import type {
  FieldGeometry,
  GeometryFile,
  NormalizedBoundingBox,
  PageSurfaceRef,
  PixelBoundingBox
} from '../../contracts/geometry';
import type { NormalizedPage } from '../../contracts/normalized-page';
import type { WizardFile } from '../../contracts/wizard';

export interface GeometryFieldDraft {
  fieldId: string;
  pageIndex: number;
  bbox: NormalizedBoundingBox;
  pixelBbox: PixelBoundingBox;
  pageSurface: PageSurfaceRef;
  confirmedBy?: string;
}

export interface BuildGeometryFileInput {
  wizardId: string;
  documentFingerprint: string;
  fields: GeometryFieldDraft[];
  id?: string;
  metadata?: Record<string, string>;
  nowIso?: string;
}

export interface GeometryValidationContext {
  wizard: WizardFile;
  pages: NormalizedPage[];
  tolerateUnknownFieldIds?: boolean;
}

export type GeometryValidationCode =
  | 'missing-required-field'
  | 'unknown-field-id'
  | 'invalid-page-index'
  | 'page-surface-mismatch'
  | 'invalid-normalized-coordinates'
  | 'out-of-bounds-coordinates'
  | 'wizard-id-mismatch';

export interface GeometryValidationIssue {
  code: GeometryValidationCode;
  message: string;
  fieldId?: string;
  pageIndex?: number;
}

export interface GeometryValidationResult {
  ok: boolean;
  issues: GeometryValidationIssue[];
}

export type { FieldGeometry, GeometryFile };
