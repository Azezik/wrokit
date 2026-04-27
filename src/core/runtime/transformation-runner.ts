import type { StructuralModel, StructuralPage } from '../contracts/structural-model';
import {
  createEmptyTransformationModel,
  type TransformationModel,
  type TransformationPage
} from '../contracts/transformation-model';
import { matchPage, type MatcherOptions } from './transformation/hierarchical-matcher';

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
}

const defaultGenerateId = (): string =>
  `xform_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const defaultNow = (): string => new Date().toISOString();

const findRuntimePage = (
  runtime: StructuralModel,
  pageIndex: number
): StructuralPage | undefined => runtime.pages.find((p) => p.pageIndex === pageIndex);

/**
 * The Transformation Runner produces a TransformationModel that compares a
 * Config StructuralModel against a Runtime StructuralModel. It does not mutate
 * either input.
 *
 * Phase 2 wiring: hierarchical matcher populates each page's objectMatches,
 * unmatchedConfigObjectIds, and unmatchedRuntimeObjectIds. Level summaries,
 * consensus, field alignments, and overallConfidence remain at their Phase 1
 * empty defaults until Phase 3.
 */
export const createTransformationRunner = (
  options: CreateTransformationRunnerOptions = {}
): TransformationRunner => {
  const generateId = options.generateId ?? defaultGenerateId;
  const now = options.now ?? defaultNow;
  const matcherOptions = options.matcherOptions;

  return {
    compute: ({ config, runtime, id, nowIso }) => {
      const base = createEmptyTransformationModel({
        id: id ?? generateId(),
        config,
        runtime,
        createdAtIso: nowIso ?? now()
      });

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

        const result = matchPage(configPage, runtimePage, matcherOptions);
        return {
          ...emptyPage,
          objectMatches: result.matches,
          unmatchedConfigObjectIds: result.unmatchedConfigObjectIds,
          unmatchedRuntimeObjectIds: result.unmatchedRuntimeObjectIds,
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

      return {
        ...base,
        pages: populatedPages,
        warnings: [...base.warnings, ...documentWarnings]
      };
    }
  };
};
