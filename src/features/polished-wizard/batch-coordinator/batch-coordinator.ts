import type { GeometryFile } from '../../../core/contracts/geometry';
import type { MasterDbTable } from '../../../core/contracts/masterdb-table';
import type { StructuralModel } from '../../../core/contracts/structural-model';
import type { WizardFile } from '../../../core/contracts/wizard';
import { createNormalizationEngine } from '../../../core/engines/normalization';
import { buildDocumentFingerprint } from '../../../core/page-surface/page-surface-fingerprint';
import { createLocalizationRunner } from '../../../core/runtime/localization-runner';
import { createMasterDbRunner } from '../../../core/runtime/masterdb-runner';
import { createOcrBoxRunner } from '../../../core/runtime/ocrbox-runner';
import { createStructuralRunner } from '../../../core/runtime/structural-runner';
import { createTransformationRunner } from '../../../core/runtime/transformation-runner';
import type { BatchProgress } from '../orchestrator/types';

export interface BatchCoordinatorRunInput {
  wizard: WizardFile;
  configGeometry: GeometryFile;
  configStructuralModel: StructuralModel;
  files: File[];
  startingTable?: MasterDbTable | null;
  onProgress?: (progress: BatchProgress) => void;
}

export interface BatchCoordinatorRunResult {
  table: MasterDbTable;
  successCount: number;
  failureCount: number;
  failures: Array<{ name: string; reason: string }>;
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
      onProgress
    }) => {
      const total = files.length;
      let table: MasterDbTable | null = startingTable;
      const failures: Array<{ name: string; reason: string }> = [];
      let successCount = 0;

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

      return {
        table,
        successCount,
        failureCount: failures.length,
        failures
      };
    }
  };
};
