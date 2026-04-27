/**
 * Single shared status-text builder for the structural overlay controls.
 *
 * Config Capture and Run Mode both surface a one-line summary of "what does
 * the engine currently know about this page?". Each previously hand-rolled
 * its own template string, which drifted: Config showed CV adapter + page CV
 * mode + OpenCV runtime status, while Run showed only TransformationModel
 * confidence. This helper unifies the format so both screens read like one
 * monitor of the same engine in two states.
 *
 * The function is pure — the same input always produces the same string.
 */
import type { NormalizedPage } from '../../contracts/normalized-page';
import type { StructuralModel, StructuralPage } from '../../contracts/structural-model';
import type { TransformationModel } from '../../contracts/transformation-model';
import type { OpenCvRuntimeLoadResult } from '../../engines/structure/cv';

export interface BuildStructuralStatusTextInput {
  /** Pages currently held by the canonical NormalizedPage session for this feature. */
  pages: ReadonlyArray<NormalizedPage>;
  /** True while the structural runner is actively computing. */
  isComputing?: boolean;
  /** Active StructuralModel for the loaded session, or null while pending. */
  structuralModel: StructuralModel | null;
  /** Currently selected page within the active StructuralModel, if any. */
  structuralPage: StructuralPage | null;
  /** Last reported OpenCV runtime load status from the structural runner. */
  runtimeLoadStatus: OpenCvRuntimeLoadResult | null;
  /**
   * TransformationModel availability:
   *  - omit (undefined) when the feature has no concept of a transform
   *    (Config Mode never has one);
   *  - pass `null` when the feature *can* have one but it has not been
   *    computed yet (Run Mode after a runtime structural build but before
   *    matching);
   *  - pass the model when one exists.
   */
  transformationModel?: TransformationModel | null;
  /** Custom label when the structural runner is computing. */
  computingLabel?: string;
  /** Custom label when pages are loaded but no StructuralModel yet. */
  pendingLabel?: string;
  /** Custom label when no pages are loaded at all. */
  emptyLabel?: string;
}

const formatRuntimeLoadStatus = (status: OpenCvRuntimeLoadResult): string => {
  const reasonSuffix = status.reason ? ` (${status.reason})` : '';
  return `OpenCV runtime ${status.status}${reasonSuffix}`;
};

const formatTransformationStatus = (
  transformationModel: TransformationModel | null | undefined
): string | null => {
  if (transformationModel === undefined) {
    return null;
  }
  if (transformationModel === null) {
    return 'Transform pending';
  }
  return `Transform conf ${transformationModel.overallConfidence.toFixed(3)}`;
};

export const buildStructuralStatusText = (input: BuildStructuralStatusTextInput): string => {
  if (input.isComputing) {
    return input.computingLabel ?? 'Computing StructuralModel…';
  }

  if (!input.structuralModel) {
    if (input.pages.length === 0) {
      return input.emptyLabel ?? 'No NormalizedPage loaded.';
    }
    return input.pendingLabel ?? 'StructuralModel pending.';
  }

  const cvMode = input.structuralPage?.cvExecutionMode ?? 'n/a';
  const segments: string[] = [
    `Structural: ${input.structuralModel.cvAdapter.name} v${input.structuralModel.cvAdapter.version}`,
    `${input.structuralModel.pages.length} page(s)`,
    `page CV ${cvMode}`
  ];

  if (input.runtimeLoadStatus) {
    segments.push(formatRuntimeLoadStatus(input.runtimeLoadStatus));
  }

  const transformSegment = formatTransformationStatus(input.transformationModel);
  if (transformSegment) {
    segments.push(transformSegment);
  }

  return segments.join(' · ');
};
