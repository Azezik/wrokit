import { useCallback, useEffect, useRef, useState } from 'react';

import type { GeometryFile } from '../../../core/contracts/geometry';
import type { MasterDbTable } from '../../../core/contracts/masterdb-table';
import type { StructuralModel } from '../../../core/contracts/structural-model';
import type { StructuralRefineAnalytics } from '../../../core/contracts/structural-refine-analytics';
import type { WizardFile } from '../../../core/contracts/wizard';
import { HIGH_RES_CV_SENSITIVITY_PROFILE } from '../../../core/engines/structure';
import { createNormalizationEngine } from '../../../core/engines/normalization';
import {
  acceptHighResModel,
  evaluateStructuralDensity
} from '../../../core/engines/structural-refine/sensitivity-density-check';
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
  error: null,
  hiResPassPending: false,
  structuralRefineEnabled: false,
  priorRefineAnalytics: null,
  priorRefineModel: null,
  lastRefineOutputs: null
});

export interface OrchestratorApi {
  state: OrchestratorState;
  goTo(step: OrchestratorStep): void;
  saveWizard(wizard: WizardFile): void;
  loadConfigDocument(file: File): Promise<void>;
  setGeometry(geometry: GeometryFile): Promise<void>;
  setMasterDb(table: MasterDbTable): void;
  setStructuralRefineEnabled(enabled: boolean): void;
  setPriorRefineAnalytics(analytics: StructuralRefineAnalytics | null): void;
  setPriorRefineModel(model: StructuralModel | null): void;
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

  const setGeometry = useCallback(async (geometry: GeometryFile) => {
    // Capture the geometry immediately so the UI can advance. The hi-res
    // sensitivity post-pass below may swap in a denser structural model
    // produced with HIGH_RES_CV_SENSITIVITY_PROFILE if the normal-pass model
    // is sparse near the user's BBOXes.
    const snapshot = stateRef.current;
    const normalModel = snapshot.configStructuralModel;
    const canRunHiResCheck = Boolean(normalModel) && snapshot.configPages.length > 0;

    setState((prev) => ({
      ...prev,
      geometry,
      hiResPassPending: canRunHiResCheck
    }));

    if (!normalModel || !canRunHiResCheck) {
      return;
    }

    const normalCheck = evaluateStructuralDensity(normalModel, geometry);
    if (normalCheck.satisfiesDensity) {
      setState((prev) => ({ ...prev, hiResPassPending: false }));
      return;
    }

    try {
      const highResModel = await structuralRunnerRef.current.compute({
        pages: snapshot.configPages,
        documentFingerprint: snapshot.configFingerprint,
        geometry,
        sensitivityProfile: HIGH_RES_CV_SENSITIVITY_PROFILE
      });
      const highResCheck = evaluateStructuralDensity(highResModel, geometry);
      if (!acceptHighResModel(normalCheck, highResCheck)) {
        setState((prev) => ({ ...prev, hiResPassPending: false }));
        return;
      }
      const stampedModel: StructuralModel = {
        ...highResModel,
        cvSensitivityValues: HIGH_RES_CV_SENSITIVITY_PROFILE
      };
      setState((prev) => ({
        ...prev,
        configStructuralModel: stampedModel,
        hiResPassPending: false
      }));
    } catch {
      // Hi-res rerun is best-effort. If it fails, leave the normal-pass
      // model in place — the user can still proceed, they just may hit the
      // same localization weakness this pass was trying to fix.
      setState((prev) => ({ ...prev, hiResPassPending: false }));
    }
  }, []);

  const setMasterDb = useCallback((table: MasterDbTable) => {
    setState((prev) => ({ ...prev, masterDb: table }));
  }, []);

  const setStructuralRefineEnabled = useCallback((enabled: boolean) => {
    setState((prev) => ({ ...prev, structuralRefineEnabled: enabled }));
  }, []);

  const setPriorRefineAnalytics = useCallback((analytics: StructuralRefineAnalytics | null) => {
    setState((prev) => ({ ...prev, priorRefineAnalytics: analytics }));
  }, []);

  const setPriorRefineModel = useCallback((model: StructuralModel | null) => {
    setState((prev) => ({ ...prev, priorRefineModel: model }));
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
    if (snapshot.hiResPassPending) {
      setState((prev) => ({
        ...prev,
        error: 'Cannot run batch — hi-res structural pass is still in progress. Wait a moment and retry.'
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
        configStructuralModel: snapshot.priorRefineModel ?? snapshot.configStructuralModel,
        files,
        startingTable: snapshot.masterDb,
        refineEnabled: snapshot.structuralRefineEnabled,
        priorAnalytics: snapshot.priorRefineAnalytics,
        onProgress: (progress: BatchProgress) => {
          setState((prev) => ({ ...prev, batchProgress: progress }));
        }
      });

      setState((prev) => ({
        ...prev,
        masterDb: result.table,
        lastRefineOutputs: result.refineOutputs ?? null,
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
    setStructuralRefineEnabled,
    setPriorRefineAnalytics,
    setPriorRefineModel,
    runBatch,
    reset
  };
};
