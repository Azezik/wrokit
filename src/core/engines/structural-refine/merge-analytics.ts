/**
 * Merge analytics.
 *
 * Two pure functions:
 *   - `aggregatorStateToAnalytics` collapses an `AggregatorState` snapshot
 *     into a fresh `StructuralRefineAnalytics` artifact.
 *   - `mergeAnalytics(prior, incoming)` merges two analytics files using the
 *     standard parallel-Welford formula. Histograms and counts are summed,
 *     `mergeHistory` is concatenated, `reliability` is re-derived, and
 *     compatibility is enforced.
 *
 * Associativity (proven in `tests/unit/structural-refine-merge.test.ts`) is
 * what the "10 docs + 50 docs ≡ 60 docs" requirement depends on.
 */
import type {
  RefineCompatibilitySignature,
  StructuralRefineAnalytics,
  StructuralRefineAnalyticsField,
  StructuralRefineAnalyticsGlobals,
  StructuralRefineAnalyticsMergeHistoryEntry,
  StructuralRefineAnalyticsObject,
  StructuralRefineAnalyticsObjectPair,
  StructuralRefineAnalyticsPage,
  WelfordScalar
} from '../../contracts/structural-refine-analytics';

import type { AggregatorState } from './aggregator';
import { areRefineSignaturesCompatible } from './signature';
import {
  cloneWelfordAffine,
  cloneWelfordRect,
  cloneWelfordRelative,
  cloneWelfordScalar,
  emptyWelfordAffine,
  emptyWelfordRect,
  emptyWelfordRelative,
  emptyWelfordScalar,
  mergeWelford,
  mergeWelfordAffine,
  mergeWelfordRect,
  mergeWelfordRelative
} from './welford';

export class StructuralRefineAnalyticsCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuralRefineAnalyticsCompatibilityError';
  }
}

export interface AggregatorStateToAnalyticsInput {
  state: AggregatorState;
  compatibility: RefineCompatibilitySignature;
  batchId: string;
  id: string;
  nowIso: string;
}

const cloneFieldHistogram = (h: {
  A: number;
  B: number;
  C: number;
  refined: number;
  border: number;
}): { A: number; B: number; C: number; refined: number; border: number } => ({ ...h });

const sumFieldHistogram = (
  a: { A: number; B: number; C: number; refined: number; border: number },
  b: { A: number; B: number; C: number; refined: number; border: number }
): { A: number; B: number; C: number; refined: number; border: number } => ({
  A: a.A + b.A,
  B: a.B + b.B,
  C: a.C + b.C,
  refined: a.refined + b.refined,
  border: a.border + b.border
});

const sumAnchorTierUsage = (
  a: { A: number; B: number; C: number },
  b: { A: number; B: number; C: number }
): { A: number; B: number; C: number } => ({ A: a.A + b.A, B: a.B + b.B, C: a.C + b.C });

const mergeAnchorWelfordTriple = (
  a: { A: WelfordScalar; B: WelfordScalar; C: WelfordScalar },
  b: { A: WelfordScalar; B: WelfordScalar; C: WelfordScalar }
): { A: WelfordScalar; B: WelfordScalar; C: WelfordScalar } => ({
  A: mergeWelford(a.A, b.A),
  B: mergeWelford(a.B, b.B),
  C: mergeWelford(a.C, b.C)
});

const cloneAnchorWelfordTriple = (a: {
  A: WelfordScalar;
  B: WelfordScalar;
  C: WelfordScalar;
}): { A: WelfordScalar; B: WelfordScalar; C: WelfordScalar } => ({
  A: cloneWelfordScalar(a.A),
  B: cloneWelfordScalar(a.B),
  C: cloneWelfordScalar(a.C)
});

/**
 * Reliability formula: weighted blend of appearance frequency, mean projection
 * IoU, and (1 - outlier rate). Bounded to [0, 1]. Documented as a subjective
 * derived signal — Phase 2 may tune the weights without affecting any
 * stored Welford accumulator.
 */
const computeObjectReliability = (
  object: {
    appearanceCount: number;
    projectionIou: WelfordScalar;
    outlierVsConsensusCount: number;
  },
  documentCount: number
): number => {
  if (documentCount <= 0) {
    return 0;
  }
  const appearanceFrequency = Math.min(1, object.appearanceCount / documentCount);
  const iouMean = object.projectionIou.totalWeight > 0 ? clamp01(object.projectionIou.mean) : 0;
  const outlierRate =
    object.appearanceCount > 0
      ? Math.min(1, object.outlierVsConsensusCount / object.appearanceCount)
      : 0;
  const score = 0.4 * appearanceFrequency + 0.4 * iouMean + 0.2 * (1 - outlierRate);
  return clamp01(score);
};

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const consensusConfidenceMeanFromGlobals = (acc: WelfordScalar): number => {
  return acc.totalWeight > 0 ? acc.mean : 0;
};

export const aggregatorStateToAnalytics = (
  input: AggregatorStateToAnalyticsInput
): StructuralRefineAnalytics => {
  const documentCount = input.state.documentCount;

  const pages: StructuralRefineAnalyticsPage[] = [];
  const sortedPages = Array.from(input.state.pages.values()).sort(
    (a, b) => a.pageIndex - b.pageIndex
  );

  for (const pageState of sortedPages) {
    const objects: StructuralRefineAnalyticsObject[] = [];
    const sortedObjects = Array.from(pageState.objects.values()).sort((a, b) =>
      a.configObjectId.localeCompare(b.configObjectId)
    );
    for (const object of sortedObjects) {
      const reliability = computeObjectReliability(object, documentCount);
      objects.push({
        configObjectId: object.configObjectId,
        appearanceCount: object.appearanceCount,
        matchConfidence: cloneWelfordScalar(object.matchConfidence),
        impliedAffine: cloneWelfordAffine(object.impliedAffine),
        projectionIou: cloneWelfordScalar(object.projectionIou),
        outlierVsConsensusCount: object.outlierVsConsensusCount,
        runtimePositionDrift: cloneWelfordRect(object.runtimePositionDrift),
        anchorTierUsage: { ...object.anchorTierUsage },
        anchorProjectionIou: cloneAnchorWelfordTriple(object.anchorProjectionIou),
        reliability
      });
    }

    const objectPairs: StructuralRefineAnalyticsObjectPair[] = [];
    const sortedPairs = Array.from(pageState.objectPairs.values()).sort((a, b) => {
      const fromCmp = a.fromObjectId.localeCompare(b.fromObjectId);
      if (fromCmp !== 0) return fromCmp;
      return a.toObjectId.localeCompare(b.toObjectId);
    });
    for (const pair of sortedPairs) {
      objectPairs.push({
        fromObjectId: pair.fromObjectId,
        toObjectId: pair.toObjectId,
        coOccurrenceCount: pair.coOccurrenceCount,
        relativeGeometry: cloneWelfordRelative(pair.relativeGeometry)
      });
    }

    const fields: StructuralRefineAnalyticsField[] = [];
    const sortedFields = Array.from(pageState.fields.values()).sort((a, b) =>
      a.fieldId.localeCompare(b.fieldId)
    );
    for (const field of sortedFields) {
      fields.push({
        fieldId: field.fieldId,
        anchorTierHistogram: cloneFieldHistogram(field.anchorTierHistogram),
        reprojectedRectDrift: cloneWelfordRect(field.reprojectedRectDrift),
        perAnchorIou: cloneAnchorWelfordTriple(field.perAnchorIou)
      });
    }

    pages.push({
      pageIndex: pageState.pageIndex,
      pageSurface: { ...pageState.pageSurface },
      consensusAffine: cloneWelfordAffine(pageState.consensusAffine),
      refinedBorderDelta: cloneWelfordAffine(pageState.refinedBorderDelta),
      shiftDirection: { ...pageState.shiftDirection },
      objects,
      objectPairs,
      fields
    });
  }

  const globals: StructuralRefineAnalyticsGlobals = {
    anchorTierGlobal: cloneFieldHistogram(input.state.globals.anchorTierGlobal),
    consensusConfidenceMean: consensusConfidenceMeanFromGlobals(
      input.state.globals.consensusConfidenceMean
    )
  };

  const mergeHistory: StructuralRefineAnalyticsMergeHistoryEntry[] =
    documentCount > 0
      ? [
          {
            batchId: input.batchId,
            addedDocumentCount: documentCount,
            mergedAtIso: input.nowIso
          }
        ]
      : [];

  return {
    schema: 'wrokit/structural-refine-analytics',
    version: '1.0',
    refineVersion: 'wrokit/structural-refine/v1',
    id: input.id,
    compatibility: { ...input.compatibility },
    documentCount,
    mergeHistory,
    pages,
    globals,
    createdAtIso: input.nowIso,
    updatedAtIso: input.nowIso
  };
};

export interface MergeAnalyticsOptions {
  /** Identifier for the merged artifact. */
  id: string;
  /** Stamp written into `updatedAtIso` on the merged artifact. */
  nowIso: string;
}

const mergeShiftDirection = (
  a: { meanTx: number; meanTy: number; sampleCount: number },
  b: { meanTx: number; meanTy: number; sampleCount: number }
): { meanTx: number; meanTy: number; sampleCount: number } => {
  const total = a.sampleCount + b.sampleCount;
  if (total <= 0) {
    return { meanTx: 0, meanTy: 0, sampleCount: 0 };
  }
  return {
    meanTx: (a.meanTx * a.sampleCount + b.meanTx * b.sampleCount) / total,
    meanTy: (a.meanTy * a.sampleCount + b.meanTy * b.sampleCount) / total,
    sampleCount: total
  };
};

const mergeObjectStates = (
  a: StructuralRefineAnalyticsObject,
  b: StructuralRefineAnalyticsObject,
  documentCount: number
): StructuralRefineAnalyticsObject => {
  const merged: StructuralRefineAnalyticsObject = {
    configObjectId: a.configObjectId,
    appearanceCount: a.appearanceCount + b.appearanceCount,
    matchConfidence: mergeWelford(a.matchConfidence, b.matchConfidence),
    impliedAffine: mergeWelfordAffine(a.impliedAffine, b.impliedAffine),
    projectionIou: mergeWelford(a.projectionIou, b.projectionIou),
    outlierVsConsensusCount: a.outlierVsConsensusCount + b.outlierVsConsensusCount,
    runtimePositionDrift: mergeWelfordRect(a.runtimePositionDrift, b.runtimePositionDrift),
    anchorTierUsage: sumAnchorTierUsage(a.anchorTierUsage, b.anchorTierUsage),
    anchorProjectionIou: mergeAnchorWelfordTriple(a.anchorProjectionIou, b.anchorProjectionIou),
    reliability: 0
  };
  merged.reliability = computeObjectReliability(merged, documentCount);
  return merged;
};

const mergeObjectPairStates = (
  a: StructuralRefineAnalyticsObjectPair,
  b: StructuralRefineAnalyticsObjectPair
): StructuralRefineAnalyticsObjectPair => ({
  fromObjectId: a.fromObjectId,
  toObjectId: a.toObjectId,
  coOccurrenceCount: a.coOccurrenceCount + b.coOccurrenceCount,
  relativeGeometry: mergeWelfordRelative(a.relativeGeometry, b.relativeGeometry)
});

const mergeFieldStates = (
  a: StructuralRefineAnalyticsField,
  b: StructuralRefineAnalyticsField
): StructuralRefineAnalyticsField => ({
  fieldId: a.fieldId,
  anchorTierHistogram: sumFieldHistogram(a.anchorTierHistogram, b.anchorTierHistogram),
  reprojectedRectDrift: mergeWelfordRect(a.reprojectedRectDrift, b.reprojectedRectDrift),
  perAnchorIou: mergeAnchorWelfordTriple(a.perAnchorIou, b.perAnchorIou)
});

const cloneObjectWithReliability = (
  object: StructuralRefineAnalyticsObject,
  documentCount: number
): StructuralRefineAnalyticsObject => {
  const clone: StructuralRefineAnalyticsObject = {
    configObjectId: object.configObjectId,
    appearanceCount: object.appearanceCount,
    matchConfidence: cloneWelfordScalar(object.matchConfidence),
    impliedAffine: cloneWelfordAffine(object.impliedAffine),
    projectionIou: cloneWelfordScalar(object.projectionIou),
    outlierVsConsensusCount: object.outlierVsConsensusCount,
    runtimePositionDrift: cloneWelfordRect(object.runtimePositionDrift),
    anchorTierUsage: { ...object.anchorTierUsage },
    anchorProjectionIou: cloneAnchorWelfordTriple(object.anchorProjectionIou),
    reliability: 0
  };
  clone.reliability = computeObjectReliability(clone, documentCount);
  return clone;
};

const cloneFieldShallow = (
  field: StructuralRefineAnalyticsField
): StructuralRefineAnalyticsField => ({
  fieldId: field.fieldId,
  anchorTierHistogram: cloneFieldHistogram(field.anchorTierHistogram),
  reprojectedRectDrift: cloneWelfordRect(field.reprojectedRectDrift),
  perAnchorIou: cloneAnchorWelfordTriple(field.perAnchorIou)
});

const clonePairShallow = (
  pair: StructuralRefineAnalyticsObjectPair
): StructuralRefineAnalyticsObjectPair => ({
  fromObjectId: pair.fromObjectId,
  toObjectId: pair.toObjectId,
  coOccurrenceCount: pair.coOccurrenceCount,
  relativeGeometry: cloneWelfordRelative(pair.relativeGeometry)
});

const mergePageState = (
  a: StructuralRefineAnalyticsPage,
  b: StructuralRefineAnalyticsPage,
  documentCount: number
): StructuralRefineAnalyticsPage => {
  const objectsById = new Map<string, StructuralRefineAnalyticsObject>();
  for (const object of a.objects) {
    objectsById.set(object.configObjectId, cloneObjectWithReliability(object, documentCount));
  }
  for (const object of b.objects) {
    const existing = objectsById.get(object.configObjectId);
    if (existing) {
      objectsById.set(
        object.configObjectId,
        mergeObjectStates(existing, object, documentCount)
      );
    } else {
      objectsById.set(object.configObjectId, cloneObjectWithReliability(object, documentCount));
    }
  }
  const objects = Array.from(objectsById.values()).sort((x, y) =>
    x.configObjectId.localeCompare(y.configObjectId)
  );

  const pairsByKey = new Map<string, StructuralRefineAnalyticsObjectPair>();
  const pairKey = (p: StructuralRefineAnalyticsObjectPair): string =>
    `${p.fromObjectId}|${p.toObjectId}`;
  for (const pair of a.objectPairs) {
    pairsByKey.set(pairKey(pair), clonePairShallow(pair));
  }
  for (const pair of b.objectPairs) {
    const key = pairKey(pair);
    const existing = pairsByKey.get(key);
    pairsByKey.set(key, existing ? mergeObjectPairStates(existing, pair) : clonePairShallow(pair));
  }
  const objectPairs = Array.from(pairsByKey.values()).sort((x, y) => {
    const fromCmp = x.fromObjectId.localeCompare(y.fromObjectId);
    if (fromCmp !== 0) return fromCmp;
    return x.toObjectId.localeCompare(y.toObjectId);
  });

  const fieldsById = new Map<string, StructuralRefineAnalyticsField>();
  for (const field of a.fields) {
    fieldsById.set(field.fieldId, cloneFieldShallow(field));
  }
  for (const field of b.fields) {
    const existing = fieldsById.get(field.fieldId);
    fieldsById.set(field.fieldId, existing ? mergeFieldStates(existing, field) : cloneFieldShallow(field));
  }
  const fields = Array.from(fieldsById.values()).sort((x, y) => x.fieldId.localeCompare(y.fieldId));

  return {
    pageIndex: a.pageIndex,
    pageSurface: { ...a.pageSurface },
    consensusAffine: mergeWelfordAffine(a.consensusAffine, b.consensusAffine),
    refinedBorderDelta: mergeWelfordAffine(a.refinedBorderDelta, b.refinedBorderDelta),
    shiftDirection: mergeShiftDirection(a.shiftDirection, b.shiftDirection),
    objects,
    objectPairs,
    fields
  };
};

const clonePageWithReliability = (
  page: StructuralRefineAnalyticsPage,
  documentCount: number
): StructuralRefineAnalyticsPage => ({
  pageIndex: page.pageIndex,
  pageSurface: { ...page.pageSurface },
  consensusAffine: cloneWelfordAffine(page.consensusAffine),
  refinedBorderDelta: cloneWelfordAffine(page.refinedBorderDelta),
  shiftDirection: { ...page.shiftDirection },
  objects: page.objects.map((object) => cloneObjectWithReliability(object, documentCount)),
  objectPairs: page.objectPairs.map((pair) => clonePairShallow(pair)),
  fields: page.fields.map((field) => cloneFieldShallow(field))
});

const mergeGlobalConsensusConfidenceMean = (
  a: { mean: number; documentCount: number },
  b: { mean: number; documentCount: number }
): number => {
  const total = a.documentCount + b.documentCount;
  if (total <= 0) {
    return 0;
  }
  return (a.mean * a.documentCount + b.mean * b.documentCount) / total;
};

/**
 * Merges two analytics files. Throws `StructuralRefineAnalyticsCompatibilityError`
 * when the compatibility signatures disagree.
 *
 * The merge is associative — see the corresponding test.
 */
export const mergeAnalytics = (
  prior: StructuralRefineAnalytics,
  incoming: StructuralRefineAnalytics,
  options: MergeAnalyticsOptions
): StructuralRefineAnalytics => {
  if (!areRefineSignaturesCompatible(prior.compatibility, incoming.compatibility)) {
    throw new StructuralRefineAnalyticsCompatibilityError(
      'Incompatible refine analytics: wizard / config / page-surface signatures disagree.'
    );
  }

  const documentCount = prior.documentCount + incoming.documentCount;

  const pagesByIndex = new Map<number, StructuralRefineAnalyticsPage>();
  for (const page of prior.pages) {
    pagesByIndex.set(page.pageIndex, clonePageWithReliability(page, documentCount));
  }
  for (const page of incoming.pages) {
    const existing = pagesByIndex.get(page.pageIndex);
    if (existing) {
      pagesByIndex.set(page.pageIndex, mergePageState(existing, page, documentCount));
    } else {
      pagesByIndex.set(page.pageIndex, clonePageWithReliability(page, documentCount));
    }
  }
  const pages = Array.from(pagesByIndex.values()).sort((a, b) => a.pageIndex - b.pageIndex);

  const globals: StructuralRefineAnalyticsGlobals = {
    anchorTierGlobal: sumFieldHistogram(
      prior.globals.anchorTierGlobal,
      incoming.globals.anchorTierGlobal
    ),
    consensusConfidenceMean: mergeGlobalConsensusConfidenceMean(
      { mean: prior.globals.consensusConfidenceMean, documentCount: prior.documentCount },
      { mean: incoming.globals.consensusConfidenceMean, documentCount: incoming.documentCount }
    )
  };

  const mergeHistory = [...prior.mergeHistory, ...incoming.mergeHistory];

  return {
    schema: 'wrokit/structural-refine-analytics',
    version: '1.0',
    refineVersion: 'wrokit/structural-refine/v1',
    id: options.id,
    compatibility: { ...prior.compatibility },
    documentCount,
    mergeHistory,
    pages,
    globals,
    createdAtIso: prior.createdAtIso,
    updatedAtIso: options.nowIso
  };
};

/**
 * Builds a fresh analytics shell with `documentCount === 0`. Useful as the
 * identity element when threading merges through code that may or may not
 * have produced its own analytics yet.
 */
export const emptyAnalytics = (
  compatibility: RefineCompatibilitySignature,
  options: { id: string; nowIso: string }
): StructuralRefineAnalytics => ({
  schema: 'wrokit/structural-refine-analytics',
  version: '1.0',
  refineVersion: 'wrokit/structural-refine/v1',
  id: options.id,
  compatibility: { ...compatibility },
  documentCount: 0,
  mergeHistory: [],
  pages: [],
  globals: {
    anchorTierGlobal: { A: 0, B: 0, C: 0, refined: 0, border: 0 },
    consensusConfidenceMean: 0
  },
  createdAtIso: options.nowIso,
  updatedAtIso: options.nowIso
});

/**
 * Re-export the empty Welford helpers so consumers can build synthetic
 * analytics in tests without reaching across module boundaries to internal
 * utilities.
 */
export {
  emptyWelfordAffine,
  emptyWelfordRect,
  emptyWelfordRelative,
  emptyWelfordScalar
};
