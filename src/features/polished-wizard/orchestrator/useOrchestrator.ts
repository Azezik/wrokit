import { useCallback, useEffect, useRef, useState } from 'react';

import type { GeometryFile } from '../../../core/contracts/geometry';
import type { MasterDbTable } from '../../../core/contracts/masterdb-table';
import type { StructuralModel } from '../../../core/contracts/structural-model';
import type { WizardFile } from '../../../core/contracts/wizard';
import { createNormalizationEngine } from '../../../core/engines/normalization';
import { buildDocumentFingerprint } from '../../../core/page-surface/page-surface-fingerprint';
import { createStructuralRunner } from '../../../core/runtime/structural-runner';
import { createBatchCoordinator } from '../batch-coordinator/batch-coordinator';
import type { BatchProgress, OrchestratorState, OrchestratorStep } from './types';

const initialState = (): OrchestratorState => ({
  step: 'configure',
  wizard: null,
  configPages: [],
  configFingerprint: '',
  configStructuralModel: null,
  geometry: null,
  masterDb: null,
  batchProgress: null,
  error: null
});

export interface OrchestratorApi {
  state: OrchestratorState;
  goTo(step: OrchestratorStep): void;
  saveWizard(wizard: WizardFile): void;
  loadConfigDocument(file: File): Promise<void>;
  setGeometry(geometry: GeometryFile): void;
  setMasterDb(table: MasterDbTable): void;
  runBatch(files: File[]): Promise<void>;
  reset(): void;
}

export const useOrchestrator = (): OrchestratorApi => {
  const [state, setState] = useState<OrchestratorState>(initialState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const normalizationEngineRef = useRef(createNormalizationEngine());
  const structuralRunnerRef = useRef(createStructuralRunner());
  const batchCoordinatorRef = useRef(createBatchCoordinator());

  const goTo = useCallback((step: OrchestratorStep) => {
    setState((prev) => ({ ...prev, step, error: null }));
  }, []);

  const saveWizard = useCallback((wizard: WizardFile) => {
    setState((prev) => ({ ...prev, wizard, step: 'draw', error: null }));
  }, []);

  const loadConfigDocument = useCallback(async (file: File) => {
    setState((prev) => ({ ...prev, error: null }));
    try {
      const result = await normalizationEngineRef.current.normalize(file);
      const fingerprint = buildDocumentFingerprint({
        sourceName: result.sourceName,
        pages: result.pages
      });
      const structural: StructuralModel = await structuralRunnerRef.current.compute({
        pages: result.pages,
        documentFingerprint: fingerprint,
        geometry: null
      });
      setState((prev) => ({
        ...prev,
        configPages: result.pages,
        configFingerprint: fingerprint,
        configStructuralModel: structural,
        error: null
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Could not normalize document.'
      }));
    }
  }, []);

  const setGeometry = useCallback((geometry: GeometryFile) => {
    setState((prev) => ({ ...prev, geometry }));
  }, []);

  const setMasterDb = useCallback((table: MasterDbTable) => {
    setState((prev) => ({ ...prev, masterDb: table }));
  }, []);

  const runBatch = useCallback(async (files: File[]) => {
    const snapshot = stateRef.current;
    if (!snapshot.wizard || !snapshot.geometry || !snapshot.configStructuralModel) {
      setState((prev) => ({
        ...prev,
        error: 'Cannot run batch — missing wizard, geometry, or structural model.'
      }));
      return;
    }

    setState((prev) => ({
      ...prev,
      step: 'processing',
      batchProgress: {
        currentIndex: 0,
        total: files.length,
        currentName: files[0]?.name ?? '',
        phase: 'normalizing'
      },
      error: null
    }));

    try {
      const result = await batchCoordinatorRef.current.run({
        wizard: snapshot.wizard,
        configGeometry: snapshot.geometry,
        configStructuralModel: snapshot.configStructuralModel,
        files,
        startingTable: snapshot.masterDb,
        onProgress: (progress: BatchProgress) => {
          setState((prev) => ({ ...prev, batchProgress: progress }));
        }
      });

      setState((prev) => ({
        ...prev,
        masterDb: result.table,
        step: 'review',
        batchProgress: null,
        error:
          result.failures.length > 0
            ? `${result.failures.length} document(s) failed: ${result.failures
                .map((f) => `${f.name} (${f.reason})`)
                .join('; ')}`
            : null
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Batch processing failed.',
        batchProgress: null,
        step: 'upload'
      }));
    }
  }, []);

  const reset = useCallback(() => {
    setState(initialState());
  }, []);

  return {
    state,
    goTo,
    saveWizard,
    loadConfigDocument,
    setGeometry,
    setMasterDb,
    runBatch,
    reset
  };
};
