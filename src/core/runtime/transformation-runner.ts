import type { StructuralModel, StructuralPage } from '../contracts/structural-model';
import {
  createEmptyTransformationModel,
  type TransformationLevelSummary,
  type TransformationModel,
  type TransformationPage
} from '../contracts/transformation-model';
import {
  computeBorderLevelSummary,
  computeConsensus,
  computeObjectLevelSummary,
  computeParentChainLevelSummary,
  computeRefinedBorderLevelSummary,
  type ConsensusOptions
} from './transformation/consensus';
import { computeFieldAlignments } from './transformation/field-candidates';
import { matchPage, type MatcherOptions } from './transformation/hierarchical-matcher';

/**
 * Collect every config object ID named as a primary or secondary anchor of
 * any field on the page. These are the matcher's most consequential targets:
 * field localization downstream depends on them, so the matcher gets a small
 * thumb on the scale via `MatcherOptions.priorityObjectIds`. Tertiary anchors
 * are intentionally excluded — they're already a fallback, not a load-bearing
 * input to localization.
 */
const collectPriorityObjectIds = (configPage: StructuralPage): Set<string> => {
  const priority = new Set<string>();
  for (const fr of configPage.fieldRelationships) {
    for (const anchor of fr.fieldAnchors.objectAnchors) {
      if (anchor.rank === 'primary' || anchor.rank === 'secondary') {
        priority.add(anchor.objectId);
      }
    }
  }
  return priority;
};

export interface TransformationRunnerInput {
  config: StructuralModel;
  runtime: StructuralModel;
  id?: string;
  nowIso?: string;
}

export interface TransformationRunner {
  compute(input: TransformationRunnerInput): TransformationModel;
}

export interface CreateTransformationRunnerOptions {
  /**
   * Optional id factory. Defaults to a timestamped identifier.
   */
  generateId?: () => string;
  /**
   * Optional clock. Defaults to `new Date().toISOString()`.
   */
  now?: () => string;
  /**
   * Optional matcher overrides (thresholds, weights). Useful for tests.
   */
  matcherOptions?: MatcherOptions;
  /**
   * Optional consensus tuning (outlier tolerances, min match count). Useful
   * for tests and for stricter alignment regimes.
   */
  consensusOptions?: ConsensusOptions;
}

const defaultGenerateId = (): string =>
  `xform_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const defaultNow = (): string => new Date().toISOString();

const findRuntimePage = (
  runtime: StructuralModel,
  pageIndex: number
): StructuralPage | undefined => runtime.pages.find((p) => p.pageIndex === pageIndex);

const buildLevelSummaries = (
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  matches: TransformationPage['objectMatches'],
  consensusOptions: ConsensusOptions | undefined
): TransformationLevelSummary[] => [
  computeBorderLevelSummary(configPage, runtimePage),
  computeRefinedBorderLevelSummary(configPage, runtimePage),
  computeObjectLevelSummary(matches, configPage, runtimePage, consensusOptions ?? {}),
  computeParentChainLevelSummary(matches, configPage, runtimePage, consensusOptions ?? {})
];

/**
 * The Transformation Runner produces a TransformationModel that compares a
 * Config StructuralModel against a Runtime StructuralModel. It does not mutate
 * either input.
 *
 * Phase 4 wiring: matcher output, level summaries, consensus, and per-field
 * alignment candidates with explicit fallback ordering (matched-object →
 * parent-object → refined-border → border) are all produced. The runner is
 * still a pure read-only report: it never writes back into Geometry, the
 * StructuralModel, or OpenCV output.
 */
export const createTransformationRunner = (
  options: CreateTransformationRunnerOptions = {}
): TransformationRunner => {
  const generateId = options.generateId ?? defaultGenerateId;
  const now = options.now ?? defaultNow;
  const matcherOptions = options.matcherOptions;
  const consensusOptions = options.consensusOptions;

  return {
    compute: ({ config, runtime, id, nowIso }) => {
      const base = createEmptyTransformationModel({
        id: id ?? generateId(),
        config,
        runtime,
        createdAtIso: nowIso ?? now()
      });

      // Cross-document: the structural matcher should de-emphasize absolute
      // position in favor of refined-border-relative position. Detected here
      // (not in the matcher) so the matcher stays a pure pairwise comparison
      // and the document-identity decision lives at the composition layer.
      // An explicit caller-supplied `weights` in `matcherOptions` still wins.
      const crossDocument = config.documentFingerprint !== runtime.documentFingerprint;
      const effectiveMatcherOptions = {
        ...(matcherOptions ?? {}),
        crossDocument:
          matcherOptions?.crossDocument !== undefined
            ? matcherOptions.crossDocument
            : crossDocument
      };

      const populatedPages: TransformationPage[] = base.pages.map((emptyPage) => {
        const configPage = config.pages.find((p) => p.pageIndex === emptyPage.pageIndex);
        if (!configPage) {
          return emptyPage;
        }
        const runtimePage = findRuntimePage(runtime, emptyPage.pageIndex);
        if (!runtimePage) {
          return {
            ...emptyPage,
            warnings: [
              ...emptyPage.warnings,
              `runtime model has no page with pageIndex ${emptyPage.pageIndex}`
            ]
          };
        }

        const priorityObjectIds = collectPriorityObjectIds(configPage);
        const pageMatcherOptions = {
          ...effectiveMatcherOptions,
          priorityObjectIds:
            effectiveMatcherOptions.priorityObjectIds ?? priorityObjectIds
        };
        const result = matchPage(configPage, runtimePage, pageMatcherOptions);
        const levelSummaries = buildLevelSummaries(
          configPage,
          runtimePage,
          result.matches,
          consensusOptions
        );
        const consensus = computeConsensus(
          result.matches,
          configPage,
          runtimePage,
          consensusOptions ?? {}
        );
        const fieldAlignments = computeFieldAlignments(
          configPage,
          result.matches,
          levelSummaries
        );

        return {
          ...emptyPage,
          objectMatches: result.matches,
          unmatchedConfigObjectIds: result.unmatchedConfigObjectIds,
          unmatchedRuntimeObjectIds: result.unmatchedRuntimeObjectIds,
          levelSummaries,
          consensus,
          fieldAlignments,
          notes: [...emptyPage.notes, ...result.notes],
          warnings: [...emptyPage.warnings, ...result.warnings]
        };
      });

      const documentWarnings: string[] = [];
      for (const runtimePage of runtime.pages) {
        if (!config.pages.some((p) => p.pageIndex === runtimePage.pageIndex)) {
          documentWarnings.push(
            `runtime page ${runtimePage.pageIndex} has no matching page in the config model`
          );
        }
      }

      let totalWeight = 0;
      let weightedConfidence = 0;
      for (const page of populatedPages) {
        const weight = page.consensus.contributingMatchCount;
        if (weight > 0) {
          totalWeight += weight;
          weightedConfidence += page.consensus.confidence * weight;
        }
      }
      const overallConfidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

      return {
        ...base,
        pages: populatedPages,
        overallConfidence,
        warnings: [...base.warnings, ...documentWarnings]
      };
    }
  };
};
