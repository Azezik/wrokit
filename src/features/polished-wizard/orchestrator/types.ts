import type { GeometryFile } from '../../../core/contracts/geometry';
import type { MasterDbTable } from '../../../core/contracts/masterdb-table';
import type { NormalizedPage } from '../../../core/contracts/normalized-page';
import type { StructuralModel } from '../../../core/contracts/structural-model';
import type { StructuralRefineAnalytics } from '../../../core/contracts/structural-refine-analytics';
import type { WizardFile } from '../../../core/contracts/wizard';

export type OrchestratorStep =
  | 'configure'
  | 'draw'
  | 'upload'
  | 'processing'
  | 'review';

export interface BatchProgress {
  currentIndex: number;
  total: number;
  currentName: string;
  phase: 'normalizing' | 'structuring' | 'localizing' | 'extracting' | 'appending' | 'refining' | 'done';
}

export interface OrchestratorState {
  step: OrchestratorStep;
  wizard: WizardFile | null;
  configPages: NormalizedPage[];
  configFingerprint: string;
  configStructuralModel: StructuralModel | null;
  geometry: GeometryFile | null;
  masterDb: MasterDbTable | null;
  batchProgress: BatchProgress | null;
  error: string | null;
  /** Toggle for the Structural Refine feature. Default false — no behavior change when off. */
  structuralRefineEnabled: boolean;
  /** Optional prior analytics file to fold into this batch's output. */
  priorRefineAnalytics: StructuralRefineAnalytics | null;
  /** Optional refined structural model from a previous batch, used in place of the config model. */
  priorRefineModel: StructuralModel | null;
  /** Outputs produced by the most recent refine step (null when toggle was off). */
  lastRefineOutputs: { analytics: StructuralRefineAnalytics; refinedModel: StructuralModel } | null;
}
