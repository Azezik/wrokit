/**
 * PredictedGeometryFile — runtime localization output.
 *
 * Schema authority rules:
 * - Predicted bboxes are the projection of saved Field BBOX geometry onto a
 *   runtime NormalizedPage surface using the per-stage Transformation chain.
 *   They are interpretation only; they never overwrite the human-confirmed
 *   `GeometryFile`.
 * - All bboxes are normalized [0, 1] over the runtime NormalizedPage surface.
 *   The `pixelBbox` field is a derived snapshot in surface pixels for display.
 * - The persisted shape carries `geometryFileVersion` and `structureVersion`
 *   so consumers can verify it is compatible with their loaded GeometryFile +
 *   StructuralModel.
 */

import type { NormalizedBoundingBox, PixelBoundingBox } from './geometry';
import type { StructuralNormalizedRect } from './structural-model';

export type RuntimeAnchorTier =
  | 'field-object-a'
  | 'field-object-b'
  | 'field-object-c'
  | 'refined-border'
  | 'border';

export type RuntimeObjectMatchStrategy = 'id' | 'type-hierarchy-geometry';

export interface RuntimeStructuralTransform {
  pageIndex: number;
  basis: RuntimeAnchorTier;
  sourceConfigRectNorm: StructuralNormalizedRect;
  sourceRuntimeRectNorm: StructuralNormalizedRect;
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
  configObjectId?: string;
  runtimeObjectId?: string;
  objectMatchStrategy?: RuntimeObjectMatchStrategy;
}

export interface PredictedFieldGeometry {
  fieldId: string;
  pageIndex: number;
  bbox: NormalizedBoundingBox;
  pixelBbox: PixelBoundingBox;
  pageSurface: {
    pageIndex: number;
    surfaceWidth: number;
    surfaceHeight: number;
  };
  sourceGeometryConfirmedAtIso: string;
  sourceGeometryConfirmedBy: string;
  anchorTierUsed: RuntimeAnchorTier;
  transform: RuntimeStructuralTransform;
}

export interface PredictedGeometryFile {
  schema: 'wrokit/predicted-geometry-file';
  version: '1.0';
  geometryFileVersion: 'wrokit/geometry/v1';
  structureVersion: 'wrokit/structure/v2';
  id: string;
  wizardId: string;
  sourceGeometryFileId: string;
  sourceStructuralModelId: string;
  runtimeDocumentFingerprint: string;
  predictedAtIso: string;
  fields: PredictedFieldGeometry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const RUNTIME_ANCHOR_TIERS: ReadonlySet<RuntimeAnchorTier> = new Set<RuntimeAnchorTier>([
  'field-object-a',
  'field-object-b',
  'field-object-c',
  'refined-border',
  'border'
]);

const RUNTIME_OBJECT_MATCH_STRATEGIES: ReadonlySet<RuntimeObjectMatchStrategy> = new Set<RuntimeObjectMatchStrategy>([
  'id',
  'type-hierarchy-geometry'
]);

const isNormalizedBoundingBox = (value: unknown): value is NormalizedBoundingBox => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.xNorm) &&
    isFiniteNumber(value.yNorm) &&
    isFiniteNumber(value.wNorm) &&
    isFiniteNumber(value.hNorm)
  );
};

const isPixelBoundingBox = (value: unknown): value is PixelBoundingBox => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height)
  );
};

const isStructuralNormalizedRect = (value: unknown): value is StructuralNormalizedRect => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.xNorm) &&
    isFiniteNumber(value.yNorm) &&
    isFiniteNumber(value.wNorm) &&
    isFiniteNumber(value.hNorm)
  );
};

const isPageSurfaceRef = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.pageIndex) &&
    isFiniteNumber(value.surfaceWidth) &&
    isFiniteNumber(value.surfaceHeight)
  );
};

const isRuntimeStructuralTransform = (value: unknown): value is RuntimeStructuralTransform => {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !isFiniteNumber(value.pageIndex) ||
    !isFiniteNumber(value.scaleX) ||
    !isFiniteNumber(value.scaleY) ||
    !isFiniteNumber(value.translateX) ||
    !isFiniteNumber(value.translateY)
  ) {
    return false;
  }
  if (typeof value.basis !== 'string' || !RUNTIME_ANCHOR_TIERS.has(value.basis as RuntimeAnchorTier)) {
    return false;
  }
  if (
    !isStructuralNormalizedRect(value.sourceConfigRectNorm) ||
    !isStructuralNormalizedRect(value.sourceRuntimeRectNorm)
  ) {
    return false;
  }
  if (value.configObjectId !== undefined && typeof value.configObjectId !== 'string') {
    return false;
  }
  if (value.runtimeObjectId !== undefined && typeof value.runtimeObjectId !== 'string') {
    return false;
  }
  if (
    value.objectMatchStrategy !== undefined &&
    (typeof value.objectMatchStrategy !== 'string' ||
      !RUNTIME_OBJECT_MATCH_STRATEGIES.has(value.objectMatchStrategy as RuntimeObjectMatchStrategy))
  ) {
    return false;
  }
  return true;
};

const isPredictedFieldGeometry = (value: unknown): value is PredictedFieldGeometry => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.fieldId === 'string' &&
    isFiniteNumber(value.pageIndex) &&
    isNormalizedBoundingBox(value.bbox) &&
    isPixelBoundingBox(value.pixelBbox) &&
    isPageSurfaceRef(value.pageSurface) &&
    typeof value.sourceGeometryConfirmedAtIso === 'string' &&
    typeof value.sourceGeometryConfirmedBy === 'string' &&
    typeof value.anchorTierUsed === 'string' &&
    RUNTIME_ANCHOR_TIERS.has(value.anchorTierUsed as RuntimeAnchorTier) &&
    isRuntimeStructuralTransform(value.transform)
  );
};

export const isPredictedGeometryFile = (value: unknown): value is PredictedGeometryFile => {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.schema !== 'wrokit/predicted-geometry-file' ||
    value.version !== '1.0' ||
    value.geometryFileVersion !== 'wrokit/geometry/v1' ||
    value.structureVersion !== 'wrokit/structure/v2' ||
    typeof value.id !== 'string' ||
    typeof value.wizardId !== 'string' ||
    typeof value.sourceGeometryFileId !== 'string' ||
    typeof value.sourceStructuralModelId !== 'string' ||
    typeof value.runtimeDocumentFingerprint !== 'string' ||
    typeof value.predictedAtIso !== 'string' ||
    !Array.isArray(value.fields)
  ) {
    return false;
  }
  return value.fields.every(isPredictedFieldGeometry);
};
