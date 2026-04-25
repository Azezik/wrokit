import type { BoundingBox } from './geometry';

export type StructuralRegionKind =
  | 'text-block'
  | 'table'
  | 'line-item'
  | 'header'
  | 'footer'
  | 'unknown';

export interface StructuralRegion {
  id: string;
  kind: StructuralRegionKind;
  pageIndex: number;
  bbox: BoundingBox;
}

export interface StructuralModel {
  schema: 'wrokit/structural-model';
  version: '1.0';
  id: string;
  documentFingerprint: string;
  regions: StructuralRegion[];
  createdAtIso: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isStructuralRegionKind = (value: unknown): value is StructuralRegionKind =>
  value === 'text-block' ||
  value === 'table' ||
  value === 'line-item' ||
  value === 'header' ||
  value === 'footer' ||
  value === 'unknown';

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

const isStructuralRegion = (value: unknown): value is StructuralRegion => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    isStructuralRegionKind(value.kind) &&
    typeof value.pageIndex === 'number' &&
    isBoundingBox(value.bbox)
  );
};

export const isStructuralModel = (value: unknown): value is StructuralModel => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.schema !== 'wrokit/structural-model' ||
    value.version !== '1.0' ||
    typeof value.id !== 'string' ||
    typeof value.documentFingerprint !== 'string' ||
    typeof value.createdAtIso !== 'string' ||
    !Array.isArray(value.regions)
  ) {
    return false;
  }

  return value.regions.every(isStructuralRegion);
};
