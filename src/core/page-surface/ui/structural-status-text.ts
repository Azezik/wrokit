import type { StructuralModel, StructuralPage } from '../../contracts/structural-model';
import type { TransformationModel } from '../../contracts/transformation-model';
import type { OpenCvRuntimeLoadResult } from '../../engines/structure';

export interface StructuralStatusTextInput {
  /** True while a structural compute is in flight. */
  isComputing?: boolean;
  /** The currently active structural model for the stage, or null if none yet. */
  structuralModel: StructuralModel | null;
  /** The currently selected structural page within `structuralModel`, or null. */
  structuralPage: StructuralPage | null;
  /** The OpenCV.js runtime load status from the structural runner, or null if unknown. */
  runtimeLoadStatus: OpenCvRuntimeLoadResult | null;
  /** Whether the stage currently has at least one normalized page loaded. */
  hasNormalizedPages: boolean;
  /** Optional transformation model (Run Mode only). */
  transformationModel?: TransformationModel | null;
  /** Override copy for the "computing" state. */
  computingLabel?: string;
  /** Override copy for the "pages loaded but no structural model yet" state. */
  pendingLabel?: string;
  /** Override copy for the "no normalized page loaded" state. */
  emptyLabel?: string;
}

const DEFAULT_COMPUTING_LABEL = 'Computing StructuralModel…';
const DEFAULT_PENDING_LABEL = 'StructuralModel pending.';
const DEFAULT_EMPTY_LABEL = 'No NormalizedPage loaded.';

/**
 * Pure helper that composes the status string shown on `StructuralOverlayControls`.
 * Both Config Capture and Run Mode use this so the structural-status formatting is
 * defined in one place. The helper has no shared state; each stage passes its own
 * structural model, page, runtime status, and (optionally) transformation model.
 */
export const buildStructuralStatusText = (input: StructuralStatusTextInput): string => {
  if (input.isComputing) {
    return input.computingLabel ?? DEFAULT_COMPUTING_LABEL;
  }

  if (input.structuralModel) {
    const model = input.structuralModel;
    const pageCv = input.structuralPage?.cvExecutionMode ?? 'n/a';
    let text =
      `Structural: ${model.cvAdapter.name} v${model.cvAdapter.version}` +
      ` · ${model.pages.length} page(s)` +
      ` · page CV ${pageCv}`;

    if (input.runtimeLoadStatus) {
      text += ` · OpenCV runtime ${input.runtimeLoadStatus.status}`;
      if (input.runtimeLoadStatus.reason) {
        text += ` (${input.runtimeLoadStatus.reason})`;
      }
    }

    if (input.transformationModel) {
      text += ` · TransformationModel · overall confidence ${input.transformationModel.overallConfidence.toFixed(3)}`;
    }

    return text;
  }

  if (input.hasNormalizedPages) {
    return input.pendingLabel ?? DEFAULT_PENDING_LABEL;
  }

  return input.emptyLabel ?? DEFAULT_EMPTY_LABEL;
};
