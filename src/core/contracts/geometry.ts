export interface NormalizedBoundingBox {
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
}

export interface PixelBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSurfaceRef {
  pageIndex: number;
  surfaceWidth: number;
  surfaceHeight: number;
}

export interface FieldGeometry {
  fieldId: string;
  pageIndex: number;
  bbox: NormalizedBoundingBox;
  pixelBbox: PixelBoundingBox;
  pageSurface: PageSurfaceRef;
  confirmedAtIso: string;
  confirmedBy: string;
}

export interface GeometryFile {
  schema: 'wrokit/geometry-file';
  version: '1.1';
  geometryFileVersion: 'wrokit/geometry/v1';
  id: string;
  wizardId: string;
  documentFingerprint: string;
  fields: FieldGeometry[];
  metadata?: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNormalizedBoundingBox = (value: unknown): value is NormalizedBoundingBox => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.xNorm === 'number' &&
    typeof value.yNorm === 'number' &&
    typeof value.wNorm === 'number' &&
    typeof value.hNorm === 'number'
  );
};

const isPixelBoundingBox = (value: unknown): value is PixelBoundingBox => {
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

const isPageSurfaceRef = (value: unknown): value is PageSurfaceRef => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.pageIndex === 'number' &&
    typeof value.surfaceWidth === 'number' &&
    typeof value.surfaceHeight === 'number'
  );
};

const isFieldGeometry = (value: unknown): value is FieldGeometry => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.fieldId === 'string' &&
    typeof value.pageIndex === 'number' &&
    isNormalizedBoundingBox(value.bbox) &&
    isPixelBoundingBox(value.pixelBbox) &&
    isPageSurfaceRef(value.pageSurface) &&
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
    value.version !== '1.1' ||
    value.geometryFileVersion !== 'wrokit/geometry/v1' ||
    typeof value.id !== 'string' ||
    typeof value.wizardId !== 'string' ||
    typeof value.documentFingerprint !== 'string' ||
    !Array.isArray(value.fields)
  ) {
    return false;
  }

  return value.fields.every(isFieldGeometry);
};
