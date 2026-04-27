/**
 * StructuralModel — machine-readable interpretation of NormalizedPage structure.
 *
 * Schema authority rules:
 * - All rects on a structural page are normalized [0, 1] over the same NormalizedPage
 *   surface authority used by Geometry. There is no separate structural pixel space.
 * - StructuralModel is interpretation only. Human-confirmed Field BBOX geometry remains
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
   * NormalizedPage surface. Must contain every saved Field BBOX on the page when any
   * exist. When uncertain, the Structural Engine expands rather than crops.
   */
  rectNorm: StructuralNormalizedRect;
  source: StructuralRefinedBorderSource;
  /**
   * Number of saved Field BBOXes on this page that influenced the refined border. Zero
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
  pageAnchorRelations: StructuralPageAnchorRelations;
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
  /**
   * Machine-detected structural object rect, normalized over the page surface.
   */
  objectRectNorm: StructuralNormalizedRect;
  /**
   * @deprecated Temporary compatibility alias. Prefer `objectRectNorm`.
   */
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

/**
 * Canonical relative anchor geometry using normalized x/y/w/h ratios.
 */
export interface StructuralRelativeAnchorRect {
  xRatio: number;
  yRatio: number;
  wRatio: number;
  hRatio: number;
}

export type StructuralFieldObjectAnchorRank = 'primary' | 'secondary' | 'tertiary';

export type StructuralStableFieldAnchorLabel = 'A' | 'B' | 'C';

export interface StructuralFieldObjectAnchor {
  rank: StructuralFieldObjectAnchorRank;
  objectId: string;
  relativeFieldRect: StructuralRelativeAnchorRect;
}

export interface StructuralFieldStableObjectAnchor {
  label: StructuralStableFieldAnchorLabel;
  objectId: string;
  distance: number;
  relativeFieldRect: StructuralRelativeAnchorRect;
}

export interface StructuralFieldBorderAnchor {
  relativeFieldRect: StructuralRelativeAnchorRect;
  distanceToEdge: number;
}

export interface StructuralFieldAnchors {
  objectAnchors: StructuralFieldObjectAnchor[];
  stableObjectAnchors: StructuralFieldStableObjectAnchor[];
  refinedBorderAnchor: StructuralFieldBorderAnchor;
  borderAnchor: StructuralFieldBorderAnchor;
}

export type StructuralObjectRelationKind = 'container' | 'sibling' | 'adjacent' | 'near';

export interface StructuralObjectToObjectAnchorRelation {
  fromObjectId: string;
  toObjectId: string;
  relationKind: StructuralObjectRelationKind;
  relativeRect: StructuralRelativeAnchorRect;
  fallbackOrder: number;
  distance: number;
}

export interface StructuralObjectToRefinedBorderAnchorRelation {
  objectId: string;
  relativeRect: StructuralRelativeAnchorRect;
}

export interface StructuralRefinedBorderToBorderAnchorRelation {
  relativeRect: StructuralRelativeAnchorRect;
}

export interface StructuralFieldAnchorGraphRelation {
  fromAnchor: StructuralStableFieldAnchorLabel;
  toAnchor: StructuralStableFieldAnchorLabel;
  fromObjectId: string;
  toObjectId: string;
  relationKind: StructuralObjectRelationKind;
  fallbackOrder: number;
  relativeRect: StructuralRelativeAnchorRect;
}

export interface StructuralPageAnchorRelations {
  objectToObject: StructuralObjectToObjectAnchorRelation[];
  objectToRefinedBorder: StructuralObjectToRefinedBorderAnchorRelation[];
  refinedBorderToBorder: StructuralRefinedBorderToBorderAnchorRelation;
}

export interface StructuralFieldRelationship {
  fieldId: string;
  fieldAnchors: StructuralFieldAnchors;
  objectAnchorGraph: StructuralFieldAnchorGraphRelation[];
  /**
   * @deprecated Temporary compatibility fields. Prefer `fieldAnchors`.
   */
  containedBy: string | null;
  /**
   * @deprecated Temporary compatibility fields. Prefer `fieldAnchors.objectAnchors`.
   */
  nearestObjects: StructuralFieldNearestObject[];
  /**
   * @deprecated Temporary compatibility fields. Prefer `fieldAnchors.objectAnchors[0].relativeFieldRect`.
   */
  relativePositionWithinParent: StructuralFieldRelativePosition | null;
  /**
   * @deprecated Temporary compatibility fields. Prefer `fieldAnchors.borderAnchor.distanceToEdge`.
   */
  distanceToBorder: number;
  /**
   * @deprecated Temporary compatibility fields. Prefer `fieldAnchors.refinedBorderAnchor.distanceToEdge`.
   */
  distanceToRefinedBorder: number;
}

/**
 * @deprecated Temporary compatibility alias. Prefer `StructuralRelativeAnchorRect`.
 */
export interface StructuralFieldRelativePosition {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
}

export interface StructuralCvAdapterRef {
  name: string;
  version: string;
}

export interface StructuralModel {
  schema: 'wrokit/structural-model';
  version: '3.0';
  structureVersion: 'wrokit/structure/v2';
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

  const objectRectNorm = value.objectRectNorm;
  const bbox = value.bbox;
  if (!isStructuralNormalizedRect(objectRectNorm) || !isStructuralNormalizedRect(bbox)) {
    return false;
  }

  return (
    typeof value.objectId === 'string' &&
    isStructuralObjectType(value.type) &&
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

const isStructuralRelativeAnchorRect = (value: unknown): value is StructuralRelativeAnchorRect => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.xRatio) &&
    isFiniteNumber(value.yRatio) &&
    isFiniteNumber(value.wRatio) &&
    isFiniteNumber(value.hRatio)
  );
};

const isStructuralFieldObjectAnchorRank = (value: unknown): value is StructuralFieldObjectAnchorRank =>
  value === 'primary' || value === 'secondary' || value === 'tertiary';

const isStructuralStableFieldAnchorLabel = (value: unknown): value is StructuralStableFieldAnchorLabel =>
  value === 'A' || value === 'B' || value === 'C';

const isStructuralFieldObjectAnchor = (value: unknown): value is StructuralFieldObjectAnchor => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isStructuralFieldObjectAnchorRank(value.rank) &&
    typeof value.objectId === 'string' &&
    isStructuralRelativeAnchorRect(value.relativeFieldRect)
  );
};

const isStructuralFieldStableObjectAnchor = (
  value: unknown
): value is StructuralFieldStableObjectAnchor => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isStructuralStableFieldAnchorLabel(value.label) &&
    typeof value.objectId === 'string' &&
    isFiniteNumber(value.distance) &&
    isStructuralRelativeAnchorRect(value.relativeFieldRect)
  );
};

const isStructuralFieldBorderAnchor = (value: unknown): value is StructuralFieldBorderAnchor => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isStructuralRelativeAnchorRect(value.relativeFieldRect) && isFiniteNumber(value.distanceToEdge)
  );
};

const isStructuralFieldAnchors = (value: unknown): value is StructuralFieldAnchors => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !Array.isArray(value.objectAnchors) ||
    value.objectAnchors.length === 0 ||
    value.objectAnchors.length > 3 ||
    !value.objectAnchors.every(isStructuralFieldObjectAnchor)
  ) {
    return false;
  }

  const expectedRanks: StructuralFieldObjectAnchorRank[] = ['primary', 'secondary', 'tertiary'];
  for (let i = 0; i < value.objectAnchors.length; i += 1) {
    if (value.objectAnchors[i].rank !== expectedRanks[i]) {
      return false;
    }
  }

  if (
    !Array.isArray(value.stableObjectAnchors) ||
    value.stableObjectAnchors.length === 0 ||
    value.stableObjectAnchors.length > 3 ||
    !value.stableObjectAnchors.every(isStructuralFieldStableObjectAnchor)
  ) {
    return false;
  }

  const expectedStableLabels: StructuralStableFieldAnchorLabel[] = ['A', 'B', 'C'];
  for (let i = 0; i < value.stableObjectAnchors.length; i += 1) {
    if (value.stableObjectAnchors[i].label !== expectedStableLabels[i]) {
      return false;
    }
  }

  return (
    isStructuralFieldBorderAnchor(value.refinedBorderAnchor) &&
    isStructuralFieldBorderAnchor(value.borderAnchor)
  );
};

const isStructuralObjectRelationKind = (value: unknown): value is StructuralObjectRelationKind =>
  value === 'container' || value === 'sibling' || value === 'adjacent' || value === 'near';

const isStructuralObjectToObjectAnchorRelation = (
  value: unknown
): value is StructuralObjectToObjectAnchorRelation => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.fromObjectId === 'string' &&
    typeof value.toObjectId === 'string' &&
    isStructuralObjectRelationKind(value.relationKind) &&
    isStructuralRelativeAnchorRect(value.relativeRect) &&
    isFiniteNumber(value.fallbackOrder) &&
    isFiniteNumber(value.distance)
  );
};

const isStructuralObjectToRefinedBorderAnchorRelation = (
  value: unknown
): value is StructuralObjectToRefinedBorderAnchorRelation => {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.objectId === 'string' && isStructuralRelativeAnchorRect(value.relativeRect);
};

const isStructuralRefinedBorderToBorderAnchorRelation = (
  value: unknown
): value is StructuralRefinedBorderToBorderAnchorRelation => {
  if (!isRecord(value)) {
    return false;
  }
  return isStructuralRelativeAnchorRect(value.relativeRect);
};

const isStructuralFieldAnchorGraphRelation = (
  value: unknown
): value is StructuralFieldAnchorGraphRelation => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isStructuralStableFieldAnchorLabel(value.fromAnchor) &&
    isStructuralStableFieldAnchorLabel(value.toAnchor) &&
    typeof value.fromObjectId === 'string' &&
    typeof value.toObjectId === 'string' &&
    isStructuralObjectRelationKind(value.relationKind) &&
    isFiniteNumber(value.fallbackOrder) &&
    isStructuralRelativeAnchorRect(value.relativeRect)
  );
};

const isStructuralPageAnchorRelations = (value: unknown): value is StructuralPageAnchorRelations => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Array.isArray(value.objectToObject) &&
    value.objectToObject.every(isStructuralObjectToObjectAnchorRelation) &&
    Array.isArray(value.objectToRefinedBorder) &&
    value.objectToRefinedBorder.every(isStructuralObjectToRefinedBorderAnchorRelation) &&
    isStructuralRefinedBorderToBorderAnchorRelation(value.refinedBorderToBorder)
  );
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

  const hasLegacyShape =
    (value.containedBy === null || typeof value.containedBy === 'string') &&
    Array.isArray(value.nearestObjects) &&
    value.nearestObjects.every(isStructuralFieldNearestObject) &&
    (value.relativePositionWithinParent === null ||
      isStructuralFieldRelativePosition(value.relativePositionWithinParent)) &&
    isFiniteNumber(value.distanceToBorder) &&
    isFiniteNumber(value.distanceToRefinedBorder);

  return (
    typeof value.fieldId === 'string' &&
    isStructuralFieldAnchors(value.fieldAnchors) &&
    Array.isArray(value.objectAnchorGraph) &&
    value.objectAnchorGraph.every(isStructuralFieldAnchorGraphRelation) &&
    // Legacy properties are retained temporarily and still required for compatibility.
    hasLegacyShape
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
    isStructuralPageAnchorRelations(value.pageAnchorRelations) &&
    Array.isArray(value.fieldRelationships) &&
    value.fieldRelationships.every(isStructuralFieldRelationship)
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
    value.version !== '3.0' ||
    value.structureVersion !== 'wrokit/structure/v2' ||
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
