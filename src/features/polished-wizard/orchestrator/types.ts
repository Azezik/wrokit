import type { GeometryFile } from '../../../core/contracts/geometry';
import type { MasterDbTable } from '../../../core/contracts/masterdb-table';
import type { NormalizedPage } from '../../../core/contracts/normalized-page';
import type { StructuralModel } from '../../../core/contracts/structural-model';
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
  phase: 'normalizing' | 'structuring' | 'localizing' | 'extracting' | 'appending' | 'done';
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
}
