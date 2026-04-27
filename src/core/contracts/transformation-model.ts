/**
 * TransformationModel — alignment report between a Config StructuralModel and a
 * Runtime StructuralModel for the same template.
 *
 * Schema authority rules:
 * - The TransformationModel never mutates GeometryFile, the Config StructuralModel,
 *   the Runtime StructuralModel, or OpenCV output. It is a separate alignment layer.
 * - All rects and ratios remain in canonical NormalizedPage [0, 1] coordinates,
 *   the same authority Geometry and StructuralModel use. There is no parallel
 *   coordinate system.
 * - Transforms are simple affine in v1: scaleX, scaleY, translateX, translateY.
 *   They are applied to normalized rects as: x' = x * scaleX + translateX, etc.
 * - This file defines only types + structural guards. Matching, transform math,
 *   and consensus live in subsequent phases.
 *
 * `transformVersion` identifies the human-readable transformation contract family.
 * `version` is the object schema version. Both must match exactly to be a valid
 * TransformationModel.
 */

import type {
  StructuralModel,
  StructuralObjectType,
  StructuralRelativeAnchorRect
} from './structural-model';

export interface TransformationAffine {
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
}

export type TransformationMatchBasis =
  | 'object-similarity'
  | 'parent-chain'
  | 'refined-border-relation'
  | 'border-relation'
  | 'overlap-iou'
  | 'type-match'
  | 'sibling-consistency';

export type TransformationMatchLevel =
  | 'border'
  | 'refined-border'
  | 'object'
  | 'parent-chain'
  | 'field-anchor';

export interface TransformationStructuralModelRef {
  id: string;
  documentFingerprint: string;
}

export interface TransformationObjectMatch {
  configObjectId: string;
  runtimeObjectId: string;
  configType: StructuralObjectType;
  runtimeType: StructuralObjectType;
  /**
   * Aggregate match confidence in [0, 1]. Below the runner's threshold the match
   * is rejected and not emitted.
   */
  confidence: number;
  basis: TransformationMatchBasis[];
  /**
   * Per-match local affine transform that maps the config object's normalized rect
   * to the runtime object's normalized rect.
   */
  transform: TransformationAffine;
  notes: string[];
  warnings: string[];
}

export interface TransformationLevelSummary {
  level: TransformationMatchLevel;
  /**
   * Empty when the level could not be summarized (e.g. no parent chains matched).
   */
  transform: TransformationAffine | null;
  confidence: number;
  contributingMatchCount: number;
  notes: string[];
  warnings: string[];
}

export interface TransformationConsensusOutlier {
  configObjectId: string;
  runtimeObjectId: string;
  reason: string;
  deltaFromConsensus: TransformationAffine;
}

export interface TransformationConsensus {
  /**
   * Aggregate page-level transform produced from multiple independent object
   * matches with weighted averaging and outlier rejection. Null when there
   * are not enough trusted matches to form a consensus.
   */
  transform: TransformationAffine | null;
  confidence: number;
  contributingMatchCount: number;
  outliers: TransformationConsensusOutlier[];
  notes: string[];
  warnings: string[];
}

export type TransformationFieldFallbackSource =
  | 'matched-object'
  | 'parent-object'
  | 'refined-border'
  | 'border';

export interface TransformationFieldCandidate {
  source: TransformationFieldFallbackSource;
  /**
   * Order within the per-field fallback list. 0 is the strongest preferred
   * candidate; higher numbers are progressively weaker fallbacks.
   */
  fallbackOrder: number;
  /**
   * The structural object the candidate is anchored to, when relevant.
   * Null for refined-border / border fallbacks.
   */
  configObjectId: string | null;
  runtimeObjectId: string | null;
  transform: TransformationAffine;
  /**
   * Original config field rect expressed relative to the chosen source. Carried
   * here so localization can later project the field without re-deriving anchors.
   */
  relativeFieldRect: StructuralRelativeAnchorRect;
  confidence: number;
  notes: string[];
}

export interface TransformationFieldAlignment {
  fieldId: string;
  candidates: TransformationFieldCandidate[];
  warnings: string[];
}

export interface TransformationPage {
  pageIndex: number;
  /**
   * Page-level summaries by alignment level. Border and refined-border are
   * always emitted (possibly with null transform when uncertain). Object and
   * parent-chain summaries reflect aggregate signal from their respective
   * matches on this page.
   */
  levelSummaries: TransformationLevelSummary[];
  objectMatches: TransformationObjectMatch[];
  unmatchedConfigObjectIds: string[];
  unmatchedRuntimeObjectIds: string[];
  consensus: TransformationConsensus;
  fieldAlignments: TransformationFieldAlignment[];
  notes: string[];
  warnings: string[];
}

export interface TransformationModel {
  schema: 'wrokit/transformation-model';
  version: '1.0';
  transformVersion: 'wrokit/transformation/v1';
  id: string;
  config: TransformationStructuralModelRef;
  runtime: TransformationStructuralModelRef;
  pages: TransformationPage[];
  /**
   * Page-agnostic confidence summary for the whole document alignment. Derived
   * from per-page consensus. 0 when no pages produced a usable consensus.
   */
  overallConfidence: number;
  notes: string[];
  warnings: string[];
  createdAtIso: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

const isTransformationAffine = (value: unknown): value is TransformationAffine => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.scaleX) &&
    isFiniteNumber(value.scaleY) &&
    isFiniteNumber(value.translateX) &&
    isFiniteNumber(value.translateY)
  );
};

const isTransformationAffineOrNull = (value: unknown): value is TransformationAffine | null =>
  value === null || isTransformationAffine(value);

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

const isStructuralRelativeAnchorRect = (
  value: unknown
): value is StructuralRelativeAnchorRect => {
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

const isTransformationMatchBasis = (value: unknown): value is TransformationMatchBasis =>
  value === 'object-similarity' ||
  value === 'parent-chain' ||
  value === 'refined-border-relation' ||
  value === 'border-relation' ||
  value === 'overlap-iou' ||
  value === 'type-match' ||
  value === 'sibling-consistency';

const isTransformationMatchLevel = (value: unknown): value is TransformationMatchLevel =>
  value === 'border' ||
  value === 'refined-border' ||
  value === 'object' ||
  value === 'parent-chain' ||
  value === 'field-anchor';

const isTransformationFieldFallbackSource = (
  value: unknown
): value is TransformationFieldFallbackSource =>
  value === 'matched-object' ||
  value === 'parent-object' ||
  value === 'refined-border' ||
  value === 'border';

const isTransformationStructuralModelRef = (
  value: unknown
): value is TransformationStructuralModelRef => {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === 'string' && typeof value.documentFingerprint === 'string';
};

const isTransformationObjectMatch = (value: unknown): value is TransformationObjectMatch => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.configObjectId === 'string' &&
    typeof value.runtimeObjectId === 'string' &&
    isStructuralObjectType(value.configType) &&
    isStructuralObjectType(value.runtimeType) &&
    isFiniteNumber(value.confidence) &&
    Array.isArray(value.basis) &&
    value.basis.every(isTransformationMatchBasis) &&
    isTransformationAffine(value.transform) &&
    isStringArray(value.notes) &&
    isStringArray(value.warnings)
  );
};

const isTransformationLevelSummary = (
  value: unknown
): value is TransformationLevelSummary => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isTransformationMatchLevel(value.level) &&
    isTransformationAffineOrNull(value.transform) &&
    isFiniteNumber(value.confidence) &&
    isFiniteNumber(value.contributingMatchCount) &&
    isStringArray(value.notes) &&
    isStringArray(value.warnings)
  );
};

const isTransformationConsensusOutlier = (
  value: unknown
): value is TransformationConsensusOutlier => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.configObjectId === 'string' &&
    typeof value.runtimeObjectId === 'string' &&
    typeof value.reason === 'string' &&
    isTransformationAffine(value.deltaFromConsensus)
  );
};

const isTransformationConsensus = (value: unknown): value is TransformationConsensus => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isTransformationAffineOrNull(value.transform) &&
    isFiniteNumber(value.confidence) &&
    isFiniteNumber(value.contributingMatchCount) &&
    Array.isArray(value.outliers) &&
    value.outliers.every(isTransformationConsensusOutlier) &&
    isStringArray(value.notes) &&
    isStringArray(value.warnings)
  );
};

const isTransformationFieldCandidate = (
  value: unknown
): value is TransformationFieldCandidate => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isTransformationFieldFallbackSource(value.source) &&
    isFiniteNumber(value.fallbackOrder) &&
    (value.configObjectId === null || typeof value.configObjectId === 'string') &&
    (value.runtimeObjectId === null || typeof value.runtimeObjectId === 'string') &&
    isTransformationAffine(value.transform) &&
    isStructuralRelativeAnchorRect(value.relativeFieldRect) &&
    isFiniteNumber(value.confidence) &&
    isStringArray(value.notes)
  );
};

const isTransformationFieldAlignment = (
  value: unknown
): value is TransformationFieldAlignment => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.fieldId === 'string' &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isTransformationFieldCandidate) &&
    isStringArray(value.warnings)
  );
};

const isTransformationPage = (value: unknown): value is TransformationPage => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.pageIndex) &&
    Array.isArray(value.levelSummaries) &&
    value.levelSummaries.every(isTransformationLevelSummary) &&
    Array.isArray(value.objectMatches) &&
    value.objectMatches.every(isTransformationObjectMatch) &&
    isStringArray(value.unmatchedConfigObjectIds) &&
    isStringArray(value.unmatchedRuntimeObjectIds) &&
    isTransformationConsensus(value.consensus) &&
    Array.isArray(value.fieldAlignments) &&
    value.fieldAlignments.every(isTransformationFieldAlignment) &&
    isStringArray(value.notes) &&
    isStringArray(value.warnings)
  );
};

export const isTransformationModel = (value: unknown): value is TransformationModel => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.schema !== 'wrokit/transformation-model' ||
    value.version !== '1.0' ||
    value.transformVersion !== 'wrokit/transformation/v1' ||
    typeof value.id !== 'string' ||
    typeof value.createdAtIso !== 'string' ||
    !isTransformationStructuralModelRef(value.config) ||
    !isTransformationStructuralModelRef(value.runtime) ||
    !isFiniteNumber(value.overallConfidence) ||
    !isStringArray(value.notes) ||
    !isStringArray(value.warnings) ||
    !Array.isArray(value.pages)
  ) {
    return false;
  }

  return value.pages.every(isTransformationPage);
};

/**
 * Build the canonical empty / identity TransformationModel for a given pair of
 * StructuralModels. Produces one TransformationPage per page index that exists
 * in the config model, with empty match arrays and null transforms. The runner
 * fills these in during later phases.
 */
export const createEmptyTransformationModel = (input: {
  id: string;
  config: StructuralModel;
  runtime: StructuralModel;
  createdAtIso: string;
}): TransformationModel => {
  const pages: TransformationPage[] = input.config.pages.map((page) => ({
    pageIndex: page.pageIndex,
    levelSummaries: [
      {
        level: 'border',
        transform: null,
        confidence: 0,
        contributingMatchCount: 0,
        notes: [],
        warnings: []
      },
      {
        level: 'refined-border',
        transform: null,
        confidence: 0,
        contributingMatchCount: 0,
        notes: [],
        warnings: []
      },
      {
        level: 'object',
        transform: null,
        confidence: 0,
        contributingMatchCount: 0,
        notes: [],
        warnings: []
      },
      {
        level: 'parent-chain',
        transform: null,
        confidence: 0,
        contributingMatchCount: 0,
        notes: [],
        warnings: []
      }
    ],
    objectMatches: [],
    unmatchedConfigObjectIds: page.objectHierarchy.objects.map((o) => o.objectId),
    unmatchedRuntimeObjectIds: [],
    consensus: {
      transform: null,
      confidence: 0,
      contributingMatchCount: 0,
      outliers: [],
      notes: [],
      warnings: []
    },
    fieldAlignments: [],
    notes: [],
    warnings: []
  }));

  return {
    schema: 'wrokit/transformation-model',
    version: '1.0',
    transformVersion: 'wrokit/transformation/v1',
    id: input.id,
    config: {
      id: input.config.id,
      documentFingerprint: input.config.documentFingerprint
    },
    runtime: {
      id: input.runtime.id,
      documentFingerprint: input.runtime.documentFingerprint
    },
    pages,
    overallConfidence: 0,
    notes: [],
    warnings: [],
    createdAtIso: input.createdAtIso
  };
};
