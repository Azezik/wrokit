/**
 * Structural Refine runner — the single boundary the batch coordinator calls
 * into. Composes evidence extraction + aggregator + merge + compose-model.
 *
 * Pure orchestration: no IO, no stores, no UI. Every input is read-only;
 * every output is a self-described JSON artifact that round-trips through the
 * corresponding IO modules.
 */
import type { GeometryFile } from '../contracts/geometry';
import type { PredictedGeometryFile } from '../contracts/predicted-geometry-file';
import type { StructuralModel } from '../contracts/structural-model';
import type { StructuralRefineAnalytics } from '../contracts/structural-refine-analytics';
import type { TransformationModel } from '../contracts/transformation-model';
import type { WizardFile } from '../contracts/wizard';
import { createAggregator } from '../engines/structural-refine/aggregator';
import { composeRefinedStructuralModel } from '../engines/structural-refine/compose-model';
import { extractEvidence } from '../engines/structural-refine/evidence';
import {
  aggregatorStateToAnalytics,
  mergeAnalytics
} from '../engines/structural-refine/merge-analytics';
import { buildRefineCompatibilitySignature } from '../engines/structural-refine/signature';

export interface StructuralRefineRunnerObserveInput {
  runtimeStructure: StructuralModel;
  transformationModel: TransformationModel;
  predicted: PredictedGeometryFile;
}

export interface StructuralRefineRunnerFinalizeInput {
  batchId: string;
}

export interface StructuralRefineRunnerFinalizeOutput {
  analytics: StructuralRefineAnalytics;
  refinedModel: StructuralModel;
}

export interface StructuralRefineRunner {
  observe(input: StructuralRefineRunnerObserveInput): void;
  finalize(input: StructuralRefineRunnerFinalizeInput): Promise<StructuralRefineRunnerFinalizeOutput>;
}

export interface CreateStructuralRefineRunnerInput {
  wizard: WizardFile;
  geometry: GeometryFile;
  configStructural: StructuralModel;
  priorAnalytics: StructuralRefineAnalytics | null;
}

export const createStructuralRefineRunner = (
  runnerInput: CreateStructuralRefineRunnerInput
): StructuralRefineRunner => {
  const { wizard, geometry, configStructural, priorAnalytics } = runnerInput;
  const aggregator = createAggregator(configStructural);

  const observe = (observeInput: StructuralRefineRunnerObserveInput): void => {
    const evidence = extractEvidence({
      runtimeStructure: observeInput.runtimeStructure,
      transformationModel: observeInput.transformationModel,
      predicted: observeInput.predicted,
      configStructural,
      configGeometry: geometry
    });
    aggregator.observe(evidence);
  };

  const finalize = async (
    finalizeInput: StructuralRefineRunnerFinalizeInput
  ): Promise<StructuralRefineRunnerFinalizeOutput> => {
    const nowIso = new Date().toISOString();
    const id = `refine-${finalizeInput.batchId}`;

    const compatibility = await buildRefineCompatibilitySignature({
      wizard,
      geometry,
      configStructural,
      nowIso
    });

    const batchAnalytics = aggregatorStateToAnalytics({
      state: aggregator.snapshot(),
      compatibility,
      batchId: finalizeInput.batchId,
      id,
      nowIso
    });

    const analytics = priorAnalytics
      ? mergeAnalytics(priorAnalytics, batchAnalytics, { id, nowIso })
      : batchAnalytics;

    const refinedModel = composeRefinedStructuralModel(analytics, configStructural, { nowIso });

    return { analytics, refinedModel };
  };

  return { observe, finalize };
};
