/**
 * Aggregator.
 *
 * Streaming, bounded accumulator. Folds per-document evidence records into
 * Welford accumulators keyed by stable identity slots (config object id,
 * config field id, page index). Memory is `O(config-objects + config-fields +
 * tracked-pairs)`, independent of batch size.
 *
 * Pure: no IO, no UI, no global state. The only mutable state lives inside
 * the closure returned by `createAggregator` and is exposed only through
 * `observe` and the read-only `snapshot` view.
 */
import type {
  StructuralModel,
  StructuralPageSurfaceRef
} from '../../contracts/structural-model';
import type {
  WelfordAffine,
  WelfordRect,
  WelfordRelative,
  WelfordScalar
} from '../../contracts/structural-refine-analytics';

import type { DocumentEvidence } from './evidence';
import {
  cloneWelfordAffine,
  cloneWelfordRect,
  cloneWelfordRelative,
  cloneWelfordScalar,
  emptyWelfordAffine,
  emptyWelfordRect,
  emptyWelfordRelative,
  emptyWelfordScalar,
  observeWelford,
  observeWelfordAffine,
  observeWelfordRectDelta,
  observeWelfordRelative
} from './welford';

export interface AggregatorObjectState {
  configObjectId: string;
  appearanceCount: number;
  matchConfidence: WelfordScalar;
  impliedAffine: WelfordAffine;
  projectionIou: WelfordScalar;
  outlierVsConsensusCount: number;
  runtimePositionDrift: WelfordRect;
  anchorTierUsage: { A: number; B: number; C: number };
  anchorProjectionIou: { A: WelfordScalar; B: WelfordScalar; C: WelfordScalar };
}

export interface AggregatorObjectPairState {
  fromObjectId: string;
  toObjectId: string;
  coOccurrenceCount: number;
  relativeGeometry: WelfordRelative;
}

export interface AggregatorFieldState {
  fieldId: string;
  anchorTierHistogram: { A: number; B: number; C: number; refined: number; border: number };
  reprojectedRectDrift: WelfordRect;
  perAnchorIou: { A: WelfordScalar; B: WelfordScalar; C: WelfordScalar };
}

export interface AggregatorPageState {
  pageIndex: number;
  pageSurface: StructuralPageSurfaceRef;
  consensusAffine: WelfordAffine;
  refinedBorderDelta: WelfordAffine;
  /**
   * Signed mean of (translateX, translateY) over observed consensus affines.
   * Tracks "documents usually shift slightly in the same direction" without
   * needing the full Welford machinery, since only the running mean is
   * surfaced in analytics.
   */
  shiftDirection: { meanTx: number; meanTy: number; sampleCount: number };
  objects: Map<string, AggregatorObjectState>;
  /** Key format: `from|to`. */
  objectPairs: Map<string, AggregatorObjectPairState>;
  fields: Map<string, AggregatorFieldState>;
}

export interface AggregatorState {
  documentCount: number;
  pages: Map<number, AggregatorPageState>;
  globals: {
    anchorTierGlobal: { A: number; B: number; C: number; refined: number; border: number };
    consensusConfidenceMean: WelfordScalar;
  };
}

const emptyAnchorTierUsage = (): { A: number; B: number; C: number } => ({ A: 0, B: 0, C: 0 });

const emptyFieldHistogram = (): {
  A: number;
  B: number;
  C: number;
  refined: number;
  border: number;
} => ({ A: 0, B: 0, C: 0, refined: 0, border: 0 });

const emptyAnchorWelfordTriple = (): {
  A: WelfordScalar;
  B: WelfordScalar;
  C: WelfordScalar;
} => ({
  A: emptyWelfordScalar(),
  B: emptyWelfordScalar(),
  C: emptyWelfordScalar()
});

const buildEmptyObjectState = (configObjectId: string): AggregatorObjectState => ({
  configObjectId,
  appearanceCount: 0,
  matchConfidence: emptyWelfordScalar(),
  impliedAffine: emptyWelfordAffine(),
  projectionIou: emptyWelfordScalar(),
  outlierVsConsensusCount: 0,
  runtimePositionDrift: emptyWelfordRect(),
  anchorTierUsage: emptyAnchorTierUsage(),
  anchorProjectionIou: emptyAnchorWelfordTriple()
});

const buildEmptyFieldState = (fieldId: string): AggregatorFieldState => ({
  fieldId,
  anchorTierHistogram: emptyFieldHistogram(),
  reprojectedRectDrift: emptyWelfordRect(),
  perAnchorIou: emptyAnchorWelfordTriple()
});

const buildEmptyPairState = (
  fromObjectId: string,
  toObjectId: string
): AggregatorObjectPairState => ({
  fromObjectId,
  toObjectId,
  coOccurrenceCount: 0,
  relativeGeometry: emptyWelfordRelative()
});

export interface CreateAggregatorOptions {
  /**
   * Object pairs are observed sparsely. Pairs that never co-occur this many
   * times get pruned in the snapshot to keep memory bounded on configs with
   * many objects. Default 2 — a pair must co-appear in at least two documents
   * to be retained. Set to 1 to retain all pairs (useful in tests).
   */
  minPairCoOccurrence?: number;
}

export interface Aggregator {
  observe(evidence: DocumentEvidence): void;
  snapshot(): AggregatorState;
}

const PAIR_KEY = (from: string, to: string): string => `${from}|${to}`;

export const createAggregator = (
  configStructural: StructuralModel,
  options: CreateAggregatorOptions = {}
): Aggregator => {
  const minPairCoOccurrence = options.minPairCoOccurrence ?? 2;

  const state: AggregatorState = {
    documentCount: 0,
    pages: new Map<number, AggregatorPageState>(),
    globals: {
      anchorTierGlobal: emptyFieldHistogram(),
      consensusConfidenceMean: emptyWelfordScalar()
    }
  };

  for (const page of configStructural.pages) {
    const pageState: AggregatorPageState = {
      pageIndex: page.pageIndex,
      pageSurface: { ...page.pageSurface },
      consensusAffine: emptyWelfordAffine(),
      refinedBorderDelta: emptyWelfordAffine(),
      shiftDirection: { meanTx: 0, meanTy: 0, sampleCount: 0 },
      objects: new Map<string, AggregatorObjectState>(),
      objectPairs: new Map<string, AggregatorObjectPairState>(),
      fields: new Map<string, AggregatorFieldState>()
    };
    for (const object of page.objectHierarchy.objects) {
      pageState.objects.set(object.objectId, buildEmptyObjectState(object.objectId));
    }
    for (const field of page.fieldRelationships) {
      pageState.fields.set(field.fieldId, buildEmptyFieldState(field.fieldId));
    }
    state.pages.set(page.pageIndex, pageState);
  }

  const observe = (evidence: DocumentEvidence): void => {
    state.documentCount += 1;

    for (const page of evidence.pages) {
      const pageState = state.pages.get(page.pageIndex);
      if (!pageState) {
        // Page not present in config — skip silently. The aggregator's memory
        // bound is keyed off the config side.
        continue;
      }

      if (page.consensusAffine) {
        observeWelfordAffine(pageState.consensusAffine, page.consensusAffine);
        const samples = pageState.shiftDirection.sampleCount + 1;
        pageState.shiftDirection.meanTx =
          (pageState.shiftDirection.meanTx * pageState.shiftDirection.sampleCount +
            page.consensusAffine.translateX) /
          samples;
        pageState.shiftDirection.meanTy =
          (pageState.shiftDirection.meanTy * pageState.shiftDirection.sampleCount +
            page.consensusAffine.translateY) /
          samples;
        pageState.shiftDirection.sampleCount = samples;
        observeWelford(state.globals.consensusConfidenceMean, page.consensusConfidence);
      }

      if (page.refinedBorderDelta) {
        observeWelfordAffine(pageState.refinedBorderDelta, page.refinedBorderDelta);
      }

      for (const match of page.objectMatches) {
        let objectState = pageState.objects.get(match.configObjectId);
        if (!objectState) {
          // Match references an object id outside the config snapshot. Allow
          // it but allocate lazily so the memory bound is still configured by
          // the config side; this only adds a state slot when a match was
          // genuinely produced for that id.
          objectState = buildEmptyObjectState(match.configObjectId);
          pageState.objects.set(match.configObjectId, objectState);
        }
        objectState.appearanceCount += 1;
        observeWelford(objectState.matchConfidence, match.matchConfidence);
        observeWelfordAffine(objectState.impliedAffine, match.impliedAffine);
        observeWelford(objectState.projectionIou, match.projectionIou);
        if (match.isOutlierVsConsensus) {
          objectState.outlierVsConsensusCount += 1;
        }
        observeWelfordRectDelta(objectState.runtimePositionDrift, {
          xNorm: match.runtimeRectNorm.xNorm - match.configRectNorm.xNorm,
          yNorm: match.runtimeRectNorm.yNorm - match.configRectNorm.yNorm,
          wNorm: match.runtimeRectNorm.wNorm - match.configRectNorm.wNorm,
          hNorm: match.runtimeRectNorm.hNorm - match.configRectNorm.hNorm
        });
      }

      for (const pair of page.objectPairs) {
        const key = PAIR_KEY(pair.fromObjectId, pair.toObjectId);
        let pairState = pageState.objectPairs.get(key);
        if (!pairState) {
          pairState = buildEmptyPairState(pair.fromObjectId, pair.toObjectId);
          pageState.objectPairs.set(key, pairState);
        }
        pairState.coOccurrenceCount += 1;
        observeWelfordRelative(pairState.relativeGeometry, pair);
      }

      for (const field of page.fields) {
        let fieldState = pageState.fields.get(field.fieldId);
        if (!fieldState) {
          fieldState = buildEmptyFieldState(field.fieldId);
          pageState.fields.set(field.fieldId, fieldState);
        }
        fieldState.anchorTierHistogram[field.anchorTier] += 1;
        state.globals.anchorTierGlobal[field.anchorTier] += 1;

        // Reprojected rect drift is recorded against the field's observed
        // predicted rect — we cannot compute "delta from config" without the
        // saved field BBOX in scope here, so store the predicted rect itself
        // as the running mean. Compose-model only uses the field histogram
        // and IoU; this Welford is captured for future-phase consumers.
        observeWelfordRectDelta(fieldState.reprojectedRectDrift, field.predictedRectNorm);

        if (field.anchorTier === 'A' || field.anchorTier === 'B' || field.anchorTier === 'C') {
          observeWelford(fieldState.perAnchorIou[field.anchorTier], field.projectionIou);
          if (field.matchedObjectId) {
            const objectState = pageState.objects.get(field.matchedObjectId);
            if (objectState) {
              objectState.anchorTierUsage[field.anchorTier] += 1;
              observeWelford(
                objectState.anchorProjectionIou[field.anchorTier],
                field.projectionIou
              );
            }
          }
        }
      }
    }
  };

  const snapshot = (): AggregatorState => {
    const pages = new Map<number, AggregatorPageState>();
    for (const [pageIndex, pageState] of state.pages.entries()) {
      const objects = new Map<string, AggregatorObjectState>();
      for (const [objectId, objectState] of pageState.objects.entries()) {
        objects.set(objectId, {
          configObjectId: objectState.configObjectId,
          appearanceCount: objectState.appearanceCount,
          matchConfidence: cloneWelfordScalar(objectState.matchConfidence),
          impliedAffine: cloneWelfordAffine(objectState.impliedAffine),
          projectionIou: cloneWelfordScalar(objectState.projectionIou),
          outlierVsConsensusCount: objectState.outlierVsConsensusCount,
          runtimePositionDrift: cloneWelfordRect(objectState.runtimePositionDrift),
          anchorTierUsage: { ...objectState.anchorTierUsage },
          anchorProjectionIou: {
            A: cloneWelfordScalar(objectState.anchorProjectionIou.A),
            B: cloneWelfordScalar(objectState.anchorProjectionIou.B),
            C: cloneWelfordScalar(objectState.anchorProjectionIou.C)
          }
        });
      }

      const objectPairs = new Map<string, AggregatorObjectPairState>();
      for (const [key, pairState] of pageState.objectPairs.entries()) {
        if (pairState.coOccurrenceCount < minPairCoOccurrence) {
          continue;
        }
        objectPairs.set(key, {
          fromObjectId: pairState.fromObjectId,
          toObjectId: pairState.toObjectId,
          coOccurrenceCount: pairState.coOccurrenceCount,
          relativeGeometry: cloneWelfordRelative(pairState.relativeGeometry)
        });
      }

      const fields = new Map<string, AggregatorFieldState>();
      for (const [fieldId, fieldState] of pageState.fields.entries()) {
        fields.set(fieldId, {
          fieldId: fieldState.fieldId,
          anchorTierHistogram: { ...fieldState.anchorTierHistogram },
          reprojectedRectDrift: cloneWelfordRect(fieldState.reprojectedRectDrift),
          perAnchorIou: {
            A: cloneWelfordScalar(fieldState.perAnchorIou.A),
            B: cloneWelfordScalar(fieldState.perAnchorIou.B),
            C: cloneWelfordScalar(fieldState.perAnchorIou.C)
          }
        });
      }

      pages.set(pageIndex, {
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

    return {
      documentCount: state.documentCount,
      pages,
      globals: {
        anchorTierGlobal: { ...state.globals.anchorTierGlobal },
        consensusConfidenceMean: cloneWelfordScalar(state.globals.consensusConfidenceMean)
      }
    };
  };

  return { observe, snapshot };
};
