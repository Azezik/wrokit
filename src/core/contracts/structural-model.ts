/**
 * StructuralModel — machine-readable interpretation of NormalizedPage structure.
 *
 * Schema authority rules:
 * - All rects on a structural page are normalized [0, 1] over the same NormalizedPage
 *   surface authority used by Geometry. There is no separate structural pixel space.
 * - StructuralModel is interpretation only. Human-confirmed BBOX geometry remains
 *   authoritative; the structural model never overrides, shrinks, or relocates it.
 * - StructuralModel is persisted separately from GeometryFile.
 *
 * `structureVersion` identifies the human-readable structural contract family
 * (mirrors `geometryFileVersion` on `GeometryFile`). `version` is the object schema
 * version. Both must match exactly to be considered a valid structural model.
 */

export interface StructuralNormalizedRect {
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
}

export interface StructuralPageSurfaceRef {
  pageIndex: number;
  surfaceWidth: number;
  surfaceHeight: number;
}

export interface StructuralBorder {
  /**
   * The full NormalizedPage boundary, expressed in normalized coordinates.
   * For a Border this is always `{ xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 }`.
   */
  rectNorm: StructuralNormalizedRect;
}

export type StructuralRefinedBorderSource =
  | 'cv-content'
  | 'bbox-union'
  | 'cv-and-bbox-union'
  | 'full-page-fallback';

export interface StructuralRefinedBorder {
  /**
   * The main useful content area, expressed in normalized coordinates over the
   * NormalizedPage surface. Must contain every saved BBOX on the page when any
   * exist. When uncertain, the Structural Engine expands rather than crops.
   */
  rectNorm: StructuralNormalizedRect;
  source: StructuralRefinedBorderSource;
  /**
   * Number of saved BBOXes on this page that influenced the refined border. Zero
   * means the refined border is purely visual/CV-derived.
   */
  influencedByBBoxCount: number;
  /**
   * Marker that the refined border was constructed under the BBOX inclusion
   * invariant. Always true on output. Stored explicitly so downstream readers
   * can verify ground-truth protection without recomputing.
   */
  containsAllSavedBBoxes: boolean;
}

export interface StructuralPage {
  pageIndex: number;
  pageSurface: StructuralPageSurfaceRef;
  border: StructuralBorder;
  refinedBorder: StructuralRefinedBorder;
  objectHierarchy: StructuralObjectHierarchy;
  fieldRelationships: StructuralFieldRelationship[];
}

export type StructuralObjectType =
  | 'rectangle'
  | 'container'
  | 'line-horizontal'
  | 'line-vertical'
  | 'table-like'
  | 'header'
  | 'footer'
  | 'group-region'
  | 'nested-region';

export interface StructuralObjectNode {
  objectId: string;
  type: StructuralObjectType;
  bbox: StructuralNormalizedRect;
  parentObjectId: string | null;
  childObjectIds: string[];
  confidence: number;
}

export interface StructuralObjectHierarchy {
  objects: StructuralObjectNode[];
}

export interface StructuralFieldNearestObject {
  objectId: string;
  distance: number;
}

export interface StructuralFieldRelativePosition {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
}

export interface StructuralFieldRelationship {
  fieldId: string;
  containedBy: string | null;
  nearestObjects: StructuralFieldNearestObject[];
  relativePositionWithinParent: StructuralFieldRelativePosition | null;
  distanceToBorder: number;
  distanceToRefinedBorder: number;
}

export interface StructuralCvAdapterRef {
  name: string;
  version: string;
}

export interface StructuralModel {
  schema: 'wrokit/structural-model';
  version: '2.0';
  structureVersion: 'wrokit/structure/v1';
  id: string;
  documentFingerprint: string;
  cvAdapter: StructuralCvAdapterRef;
  pages: StructuralPage[];
  createdAtIso: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

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

const isStructuralPageSurfaceRef = (value: unknown): value is StructuralPageSurfaceRef => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.pageIndex) &&
    isFiniteNumber(value.surfaceWidth) &&
    isFiniteNumber(value.surfaceHeight)
  );
};

const isStructuralBorder = (value: unknown): value is StructuralBorder => {
  if (!isRecord(value)) {
    return false;
  }
  return isStructuralNormalizedRect(value.rectNorm);
};

const isStructuralRefinedBorderSource = (
  value: unknown
): value is StructuralRefinedBorderSource =>
  value === 'cv-content' ||
  value === 'bbox-union' ||
  value === 'cv-and-bbox-union' ||
  value === 'full-page-fallback';

const isStructuralRefinedBorder = (value: unknown): value is StructuralRefinedBorder => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isStructuralNormalizedRect(value.rectNorm) &&
    isStructuralRefinedBorderSource(value.source) &&
    isFiniteNumber(value.influencedByBBoxCount) &&
    typeof value.containsAllSavedBBoxes === 'boolean'
  );
};

const isStructuralPage = (value: unknown): value is StructuralPage => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.pageIndex) &&
    isStructuralPageSurfaceRef(value.pageSurface) &&
    isStructuralBorder(value.border) &&
    isStructuralRefinedBorder(value.refinedBorder) &&
    isStructuralObjectHierarchy(value.objectHierarchy) &&
    Array.isArray(value.fieldRelationships) &&
    value.fieldRelationships.every(isStructuralFieldRelationship)
  );
};

const isStructuralObjectType = (value: unknown): value is StructuralObjectType =>
  value === 'rectangle' ||
  value === 'container' ||
  value === 'line-horizontal' ||
  value === 'line-vertical' ||
  value === 'table-like' ||
  value === 'header' ||
  value === 'footer' ||
  value === 'group-region' ||
  value === 'nested-region';

const isStructuralObjectNode = (value: unknown): value is StructuralObjectNode => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.objectId === 'string' &&
    isStructuralObjectType(value.type) &&
    isStructuralNormalizedRect(value.bbox) &&
    (value.parentObjectId === null || typeof value.parentObjectId === 'string') &&
    Array.isArray(value.childObjectIds) &&
    value.childObjectIds.every((id) => typeof id === 'string') &&
    isFiniteNumber(value.confidence)
  );
};

const isStructuralObjectHierarchy = (value: unknown): value is StructuralObjectHierarchy => {
  if (!isRecord(value)) {
    return false;
  }
  return Array.isArray(value.objects) && value.objects.every(isStructuralObjectNode);
};

const isStructuralFieldNearestObject = (value: unknown): value is StructuralFieldNearestObject => {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.objectId === 'string' && isFiniteNumber(value.distance);
};

const isStructuralFieldRelativePosition = (
  value: unknown
): value is StructuralFieldRelativePosition => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.xRatio) &&
    isFiniteNumber(value.yRatio) &&
    isFiniteNumber(value.widthRatio) &&
    isFiniteNumber(value.heightRatio)
  );
};

const isStructuralFieldRelationship = (value: unknown): value is StructuralFieldRelationship => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.fieldId === 'string' &&
    (value.containedBy === null || typeof value.containedBy === 'string') &&
    Array.isArray(value.nearestObjects) &&
    value.nearestObjects.every(isStructuralFieldNearestObject) &&
    (value.relativePositionWithinParent === null ||
      isStructuralFieldRelativePosition(value.relativePositionWithinParent)) &&
    isFiniteNumber(value.distanceToBorder) &&
    isFiniteNumber(value.distanceToRefinedBorder)
  );
};

const isStructuralCvAdapterRef = (value: unknown): value is StructuralCvAdapterRef => {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.name === 'string' && typeof value.version === 'string';
};

export const isStructuralModel = (value: unknown): value is StructuralModel => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.schema !== 'wrokit/structural-model' ||
    value.version !== '2.0' ||
    value.structureVersion !== 'wrokit/structure/v1' ||
    typeof value.id !== 'string' ||
    typeof value.documentFingerprint !== 'string' ||
    typeof value.createdAtIso !== 'string' ||
    !isStructuralCvAdapterRef(value.cvAdapter) ||
    !Array.isArray(value.pages)
  ) {
    return false;
  }

  return value.pages.every(isStructuralPage);
};
