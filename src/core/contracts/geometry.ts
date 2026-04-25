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
  schema: 'wrokit/geometry-file';
  version: '1.0';
  id: string;
  wizardId: string;
  documentFingerprint: string;
  fields: FieldGeometry[];
  metadata?: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isBoundingBox = (value: unknown): value is BoundingBox => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number'
  );
};

const isFieldGeometry = (value: unknown): value is FieldGeometry => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.fieldId === 'string' &&
    typeof value.pageIndex === 'number' &&
    isBoundingBox(value.bbox) &&
    typeof value.confirmedAtIso === 'string' &&
    typeof value.confirmedBy === 'string'
  );
};

export const isGeometryFile = (value: unknown): value is GeometryFile => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.schema !== 'wrokit/geometry-file' ||
    value.version !== '1.0' ||
    typeof value.id !== 'string' ||
    typeof value.wizardId !== 'string' ||
    typeof value.documentFingerprint !== 'string' ||
    !Array.isArray(value.fields)
  ) {
    return false;
  }

  return value.fields.every(isFieldGeometry);
};
