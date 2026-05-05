/**
 * StructuralRefineAnalytics — bounded streaming statistics about a batch of
 * documents that share a single config StructuralModel + GeometryFile + WizardFile.
 *
 * Schema authority rules:
 * - This artifact never carries raw `StructuralModel`, `TransformationModel`,
 *   or `PredictedGeometryFile` instances. It is a fully-described JSON
 *   summary of how a batch behaved relative to the config side. Nothing
 *   downstream is ever expected to recover the raw inputs from it.
 * - All Welford accumulators are stored as `{ count, totalWeight, mean, m2 }`
 *   so two analytics files can be merged via the standard parallel-Welford
 *   formula. `totalWeight === count` for unweighted observations; `m2` is
 *   the sum-of-squares-of-residuals (population variance is `m2 / totalWeight`,
 *   sample variance is `m2 / (totalWeight - 1)`). Storing `m2` instead of a
 *   pre-divided variance is what makes mergeability associative.
 * - Refine analytics is interpretation only; it does not authorize geometry
 *   changes by itself. The refined `StructuralModel` produced from it is the
 *   plug-and-play artifact downstream code consumes.
 *
 * `refineVersion` identifies the human-readable refine contract family.
 * `version` is the object schema version. Both must match exactly to be a
 * valid analytics file.
 */
import type { StructuralPageSurfaceRef } from './structural-model';

/**
 * Single-scalar Welford accumulator. Supports weighted observations.
 *
 * - `count` is the number of raw observations folded in (integer).
 * - `totalWeight` is the sum of weights (`>= count` for weighted streams,
 *   `=== count` for unweighted ones).
 * - `mean` is the running weighted mean.
 * - `m2` is the running weighted sum-of-squares-of-residuals.
 *
 * An accumulator with `count === 0` represents "no observations yet" —
 * `mean` and `m2` should be ignored for that case.
 */
export interface WelfordScalar {
  count: number;
  totalWeight: number;
  mean: number;
  m2: number;
}

/**
 * Per-component Welford accumulator over an affine transform.
 * Each component is a fully independent `WelfordScalar`; counts can diverge
 * across components in principle, but the aggregator always observes them
 * together so they typically share counts.
 */
export interface WelfordAffine {
  scaleX: WelfordScalar;
  scaleY: WelfordScalar;
  translateX: WelfordScalar;
  translateY: WelfordScalar;
}

/**
 * Per-component Welford accumulator over a normalized rect's `xNorm/yNorm/wNorm/hNorm`.
 */
export interface WelfordRect {
  xNorm: WelfordScalar;
  yNorm: WelfordScalar;
  wNorm: WelfordScalar;
  hNorm: WelfordScalar;
}

/**
 * Per-component Welford accumulator over the relative geometry between two
 * objects: center delta (`dxCenter`, `dyCenter`) and size ratio
 * (`wRatio`, `hRatio`) of the runtime "to" rect expressed in the runtime
 * "from" rect's coordinate frame.
 */
export interface WelfordRelative {
  dxCenter: WelfordScalar;
  dyCenter: WelfordScalar;
  wRatio: WelfordScalar;
  hRatio: WelfordScalar;
}

/**
 * Compatibility signature that ties an analytics file to a specific
 * (wizard, geometry, config structural model) trio. Used by `mergeAnalytics`
 * and the upload accept-handler to refuse merges across mismatched configs.
 */
export interface RefineCompatibilitySignature {
  wizardName: string;
  wizardFieldCount: number;
  /** sha256-hex of canonical JSON of `fields[]: {fieldId,label,type,required}`, sorted by `fieldId`. */
  wizardFieldSignature: string;
  configStructuralPageCount: number;
  /** sha256-hex of sorted objectIds across all config pages. */
  configStructuralObjectIdSignature: string;
  /** sha256-hex of rounded refinedBorder rects per page (deterministic ordering). */
  configRefinedBorderSignature: string;
  pageSurfaceSignatures: Array<{ pageIndex: number; surfaceWidth: number; surfaceHeight: number }>;
  /** sha256-hex of sorted GeometryFile field ids. */
  geometryFieldIdSignature: string;
  createdAtIso: string;
}

export interface StructuralRefineAnalyticsObject {
  configObjectId: string;
  appearanceCount: number;
  matchConfidence: WelfordScalar;
  impliedAffine: WelfordAffine;
  projectionIou: WelfordScalar;
  outlierVsConsensusCount: number;
  /**
   * Welford accumulator over the per-document delta `(runtime rect) - (config rect)`
   * in normalized space, component-wise. The mean of this accumulator is the
   * batch-learned refined-position drift applied during compose.
   */
  runtimePositionDrift: WelfordRect;
  anchorTierUsage: { A: number; B: number; C: number };
  anchorProjectionIou: { A: WelfordScalar; B: WelfordScalar; C: WelfordScalar };
  /** Derived in finalize / re-derived on merge. Range `[0, 1]`. */
  reliability: number;
}

export interface StructuralRefineAnalyticsObjectPair {
  fromObjectId: string;
  toObjectId: string;
  coOccurrenceCount: number;
  relativeGeometry: WelfordRelative;
}

export interface StructuralRefineAnalyticsField {
  fieldId: string;
  anchorTierHistogram: { A: number; B: number; C: number; refined: number; border: number };
  reprojectedRectDrift: WelfordRect;
  perAnchorIou: { A: WelfordScalar; B: WelfordScalar; C: WelfordScalar };
}

export interface StructuralRefineAnalyticsPage {
  pageIndex: number;
  pageSurface: StructuralPageSurfaceRef;
  consensusAffine: WelfordAffine;
  refinedBorderDelta: WelfordAffine;
  shiftDirection: { meanTx: number; meanTy: number; sampleCount: number };
  objects: StructuralRefineAnalyticsObject[];
  objectPairs: StructuralRefineAnalyticsObjectPair[];
  fields: StructuralRefineAnalyticsField[];
}

export interface StructuralRefineAnalyticsGlobals {
  anchorTierGlobal: { A: number; B: number; C: number; refined: number; border: number };
  consensusConfidenceMean: number;
}

export interface StructuralRefineAnalyticsMergeHistoryEntry {
  batchId: string;
  addedDocumentCount: number;
  mergedAtIso: string;
}

export interface StructuralRefineAnalytics {
  schema: 'wrokit/structural-refine-analytics';
  version: '1.0';
  refineVersion: 'wrokit/structural-refine/v1';
  id: string;
  compatibility: RefineCompatibilitySignature;
  documentCount: number;
  mergeHistory: StructuralRefineAnalyticsMergeHistoryEntry[];
  pages: StructuralRefineAnalyticsPage[];
  globals: StructuralRefineAnalyticsGlobals;
  createdAtIso: string;
  updatedAtIso: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isWelfordScalar = (value: unknown): value is WelfordScalar => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.count) &&
    isFiniteNumber(value.totalWeight) &&
    isFiniteNumber(value.mean) &&
    isFiniteNumber(value.m2)
  );
};

const isWelfordAffine = (value: unknown): value is WelfordAffine => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isWelfordScalar(value.scaleX) &&
    isWelfordScalar(value.scaleY) &&
    isWelfordScalar(value.translateX) &&
    isWelfordScalar(value.translateY)
  );
};

const isWelfordRect = (value: unknown): value is WelfordRect => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isWelfordScalar(value.xNorm) &&
    isWelfordScalar(value.yNorm) &&
    isWelfordScalar(value.wNorm) &&
    isWelfordScalar(value.hNorm)
  );
};

const isWelfordRelative = (value: unknown): value is WelfordRelative => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isWelfordScalar(value.dxCenter) &&
    isWelfordScalar(value.dyCenter) &&
    isWelfordScalar(value.wRatio) &&
    isWelfordScalar(value.hRatio)
  );
};

const isAnchorTierUsage = (value: unknown): value is { A: number; B: number; C: number } => {
  if (!isRecord(value)) {
    return false;
  }
  return isFiniteNumber(value.A) && isFiniteNumber(value.B) && isFiniteNumber(value.C);
};

const isFieldAnchorTierHistogram = (
  value: unknown
): value is { A: number; B: number; C: number; refined: number; border: number } => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.A) &&
    isFiniteNumber(value.B) &&
    isFiniteNumber(value.C) &&
    isFiniteNumber(value.refined) &&
    isFiniteNumber(value.border)
  );
};

const isAnchorWelfordTriple = (
  value: unknown
): value is { A: WelfordScalar; B: WelfordScalar; C: WelfordScalar } => {
  if (!isRecord(value)) {
    return false;
  }
  return isWelfordScalar(value.A) && isWelfordScalar(value.B) && isWelfordScalar(value.C);
};

const isPageSurfaceSignature = (
  value: unknown
): value is { pageIndex: number; surfaceWidth: number; surfaceHeight: number } => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.pageIndex) &&
    isFiniteNumber(value.surfaceWidth) &&
    isFiniteNumber(value.surfaceHeight)
  );
};

const isRefineCompatibilitySignature = (
  value: unknown
): value is RefineCompatibilitySignature => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.wizardName === 'string' &&
    isFiniteNumber(value.wizardFieldCount) &&
    typeof value.wizardFieldSignature === 'string' &&
    isFiniteNumber(value.configStructuralPageCount) &&
    typeof value.configStructuralObjectIdSignature === 'string' &&
    typeof value.configRefinedBorderSignature === 'string' &&
    Array.isArray(value.pageSurfaceSignatures) &&
    value.pageSurfaceSignatures.every(isPageSurfaceSignature) &&
    typeof value.geometryFieldIdSignature === 'string' &&
    typeof value.createdAtIso === 'string'
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

const isShiftDirection = (
  value: unknown
): value is { meanTx: number; meanTy: number; sampleCount: number } => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.meanTx) &&
    isFiniteNumber(value.meanTy) &&
    isFiniteNumber(value.sampleCount)
  );
};

const isStructuralRefineAnalyticsObject = (
  value: unknown
): value is StructuralRefineAnalyticsObject => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.configObjectId === 'string' &&
    isFiniteNumber(value.appearanceCount) &&
    isWelfordScalar(value.matchConfidence) &&
    isWelfordAffine(value.impliedAffine) &&
    isWelfordScalar(value.projectionIou) &&
    isFiniteNumber(value.outlierVsConsensusCount) &&
    isWelfordRect(value.runtimePositionDrift) &&
    isAnchorTierUsage(value.anchorTierUsage) &&
    isAnchorWelfordTriple(value.anchorProjectionIou) &&
    isFiniteNumber(value.reliability)
  );
};

const isStructuralRefineAnalyticsObjectPair = (
  value: unknown
): value is StructuralRefineAnalyticsObjectPair => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.fromObjectId === 'string' &&
    typeof value.toObjectId === 'string' &&
    isFiniteNumber(value.coOccurrenceCount) &&
    isWelfordRelative(value.relativeGeometry)
  );
};

const isStructuralRefineAnalyticsField = (
  value: unknown
): value is StructuralRefineAnalyticsField => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.fieldId === 'string' &&
    isFieldAnchorTierHistogram(value.anchorTierHistogram) &&
    isWelfordRect(value.reprojectedRectDrift) &&
    isAnchorWelfordTriple(value.perAnchorIou)
  );
};

const isStructuralRefineAnalyticsPage = (
  value: unknown
): value is StructuralRefineAnalyticsPage => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.pageIndex) &&
    isStructuralPageSurfaceRef(value.pageSurface) &&
    isWelfordAffine(value.consensusAffine) &&
    isWelfordAffine(value.refinedBorderDelta) &&
    isShiftDirection(value.shiftDirection) &&
    Array.isArray(value.objects) &&
    value.objects.every(isStructuralRefineAnalyticsObject) &&
    Array.isArray(value.objectPairs) &&
    value.objectPairs.every(isStructuralRefineAnalyticsObjectPair) &&
    Array.isArray(value.fields) &&
    value.fields.every(isStructuralRefineAnalyticsField)
  );
};

const isStructuralRefineAnalyticsGlobals = (
  value: unknown
): value is StructuralRefineAnalyticsGlobals => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFieldAnchorTierHistogram(value.anchorTierGlobal) &&
    isFiniteNumber(value.consensusConfidenceMean)
  );
};

const isStructuralRefineAnalyticsMergeHistoryEntry = (
  value: unknown
): value is StructuralRefineAnalyticsMergeHistoryEntry => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.batchId === 'string' &&
    isFiniteNumber(value.addedDocumentCount) &&
    typeof value.mergedAtIso === 'string'
  );
};

export const isStructuralRefineAnalytics = (
  value: unknown
): value is StructuralRefineAnalytics => {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.schema !== 'wrokit/structural-refine-analytics' ||
    value.version !== '1.0' ||
    value.refineVersion !== 'wrokit/structural-refine/v1' ||
    typeof value.id !== 'string' ||
    !isRefineCompatibilitySignature(value.compatibility) ||
    !isFiniteNumber(value.documentCount) ||
    !Array.isArray(value.mergeHistory) ||
    !value.mergeHistory.every(isStructuralRefineAnalyticsMergeHistoryEntry) ||
    !Array.isArray(value.pages) ||
    !value.pages.every(isStructuralRefineAnalyticsPage) ||
    !isStructuralRefineAnalyticsGlobals(value.globals) ||
    typeof value.createdAtIso !== 'string' ||
    typeof value.updatedAtIso !== 'string'
  ) {
    return false;
  }
  return true;
};
