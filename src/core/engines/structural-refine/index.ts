/**
 * Structural Refine engine — Phase 1 public surface.
 *
 * This module is read-only against the existing pipeline: it never imports
 * a runner, store, or UI module, and its outputs are fully-described JSON
 * artifacts that round-trip through the corresponding IO modules.
 */
export {
  extractEvidence,
  type DocumentEvidence,
  type DocumentEvidenceAnchorTier,
  type DocumentEvidenceField,
  type DocumentEvidenceObjectMatch,
  type DocumentEvidenceObjectPair,
  type DocumentEvidencePage,
  type ExtractEvidenceInput
} from './evidence';

export {
  createAggregator,
  type Aggregator,
  type AggregatorFieldState,
  type AggregatorObjectPairState,
  type AggregatorObjectState,
  type AggregatorPageState,
  type AggregatorState,
  type CreateAggregatorOptions
} from './aggregator';

export {
  aggregatorStateToAnalytics,
  emptyAnalytics,
  mergeAnalytics,
  StructuralRefineAnalyticsCompatibilityError,
  type AggregatorStateToAnalyticsInput,
  type MergeAnalyticsOptions
} from './merge-analytics';

export {
  composeRefinedStructuralModel,
  type ComposeRefinedStructuralModelOptions
} from './compose-model';

export {
  areRefineSignaturesCompatible,
  buildRefineCompatibilitySignature,
  canonicalJsonStringify,
  type BuildRefineCompatibilitySignatureInput
} from './signature';
