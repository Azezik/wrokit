import type { GeometryFile } from '../../../core/contracts/geometry';
import type { MasterDbTable } from '../../../core/contracts/masterdb-table';
import type { StructuralModel } from '../../../core/contracts/structural-model';
import type { StructuralRefineAnalytics } from '../../../core/contracts/structural-refine-analytics';
import type { WizardFile } from '../../../core/contracts/wizard';
import { createNormalizationEngine } from '../../../core/engines/normalization';
import { buildDocumentFingerprint } from '../../../core/page-surface/page-surface-fingerprint';
import { createLocalizationRunner } from '../../../core/runtime/localization-runner';
import { createMasterDbRunner } from '../../../core/runtime/masterdb-runner';
import { createOcrBoxRunner } from '../../../core/runtime/ocrbox-runner';
import {
  createStructuralRefineRunner
} from '../../../core/runtime/structural-refine-runner';
import { createStructuralRunner } from '../../../core/runtime/structural-runner';
import { createTransformationRunner } from '../../../core/runtime/transformation-runner';
import type { BatchProgress } from '../orchestrator/types';

export interface BatchCoordinatorRunInput {
  wizard: WizardFile;
  configGeometry: GeometryFile;
  configStructuralModel: StructuralModel;
  files: File[];
  startingTable?: MasterDbTable | null;
  /** When true, runs the Structural Refine observer after each document and composes a refined model after the loop. */
  refineEnabled?: boolean;
  /** Optional prior analytics to fold into this batch's refine output via mergeAnalytics. */
  priorAnalytics?: StructuralRefineAnalytics | null;
  onProgress?: (progress: BatchProgress) => void;
}

export interface BatchCoordinatorRunResult {
  table: MasterDbTable;
  successCount: number;
  failureCount: number;
  failures: Array<{ name: string; reason: string }>;
  /** Present only when refineEnabled was true and finalize succeeded. */
  refineOutputs?: { analytics: StructuralRefineAnalytics; refinedModel: StructuralModel };
}

export interface BatchCoordinator {
  run(input: BatchCoordinatorRunInput): Promise<BatchCoordinatorRunResult>;
}

export const createBatchCoordinator = (): BatchCoordinator => {
  const normalizationEngine = createNormalizationEngine();
  const structuralRunner = createStructuralRunner();
  const transformationRunner = createTransformationRunner();
  const localizationRunner = createLocalizationRunner();
  const masterDbRunner = createMasterDbRunner();

  return {
    run: async ({
      wizard,
      configGeometry,
      configStructuralModel,
      files,
      startingTable = null,
      refineEnabled = false,
      priorAnalytics = null,
      onProgress
    }) => {
      const total = files.length;
      let table: MasterDbTable | null = startingTable;
      const failures: Array<{ name: string; reason: string }> = [];
      let successCount = 0;

      const refineRunner = refineEnabled
        ? createStructuralRefineRunner({
            wizard,
            geometry: configGeometry,
            configStructural: configStructuralModel,
            priorAnalytics: priorAnalytics ?? null
          })
        : null;

      for (let i = 0; i < total; i += 1) {
        const file = files[i];
        const ocrRunner = createOcrBoxRunner();

        const emit = (phase: BatchProgress['phase']) => {
          onProgress?.({
            currentIndex: i,
            total,
            currentName: file.name,
            phase
          });
        };

        try {
          emit('normalizing');
          const normalized = await normalizationEngine.normalize(file);
          const fingerprint = buildDocumentFingerprint({
            sourceName: normalized.sourceName,
            pages: normalized.pages
          });

          emit('structuring');
          const runtimeStructure = await structuralRunner.compute({
            pages: normalized.pages,
            documentFingerprint: fingerprint,
            geometry: null
          });

          const transformationModel = transformationRunner.compute({
            config: configStructuralModel,
            runtime: runtimeStructure
          });

          emit('localizing');
          const predicted = await localizationRunner.run({
            wizardId: wizard.wizardName,
            configGeometry,
            configStructuralModel,
            runtimeStructuralModel: runtimeStructure,
            runtimePages: normalized.pages,
            transformationModel
          });

          emit('extracting');
          const ocrResult = await ocrRunner.extractFromPredicted({
            predicted,
            pages: normalized.pages
          });

          emit('appending');
          const applied = await masterDbRunner.apply({
            wizard,
            existing: table,
            results: [ocrResult]
          });
          table = applied.table;
          successCount += 1;

          // Structural Refine observer — isolated, never throws into the main batch loop.
          if (refineRunner) {
            try {
              refineRunner.observe({ runtimeStructure, transformationModel, predicted });
            } catch {
              // Refine observe failures are silently swallowed — they must
              // never interrupt the existing batch or corrupt the MasterDB.
            }
          }
        } catch (error) {
          failures.push({
            name: file.name,
            reason: error instanceof Error ? error.message : 'Unknown error.'
          });
        } finally {
          await ocrRunner.dispose();
        }
      }

      onProgress?.({
        currentIndex: total,
        total,
        currentName: '',
        phase: 'done'
      });

      if (!table) {
        // No documents succeeded — produce an empty wizard-locked table by
        // running masterdb with no results.
        const empty = await masterDbRunner.apply({
          wizard,
          existing: null,
          results: []
        });
        table = empty.table;
      }

      // Structural Refine finalize — runs after the loop, isolated from main result.
      let refineOutputs:
        | { analytics: StructuralRefineAnalytics; refinedModel: StructuralModel }
        | undefined;

      if (refineRunner) {
        onProgress?.({ currentIndex: total, total, currentName: '', phase: 'refining' });
        try {
          const batchId = `batch-${Date.now()}`;
          refineOutputs = await refineRunner.finalize({ batchId });
        } catch {
          // Refine finalize failures are silently swallowed — analytics is
          // optional and must never break an otherwise-successful batch.
        }
      }

      return {
        table,
        successCount,
        failureCount: failures.length,
        failures,
        ...(refineOutputs !== undefined ? { refineOutputs } : {})
      };
    }
  };
};
