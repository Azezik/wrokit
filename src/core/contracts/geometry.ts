export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FieldGeometry {
  fieldId: string;
  pageIndex: number;
  bbox: BoundingBox;
  confirmedAtIso: string;
  confirmedBy: string;
}

export interface GeometryFile {
  id: string;
  wizardId: string;
  documentFingerprint: string;
  fields: FieldGeometry[];
  metadata?: Record<string, string>;
}
