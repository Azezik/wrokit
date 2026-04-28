import type {
  StructuralModel,
  StructuralPage
} from '../../contracts/structural-model';
import type { TransformationModel } from '../../contracts/transformation-model';
import type { OpenCvRuntimeLoadResult } from '../../engines/structure/cv/opencv-js-runtime-loader';

export interface StructuralStatusTextInput {
  hasPages: boolean;
  isComputing?: boolean;
  structuralModel: StructuralModel | null;
  structuralPage: StructuralPage | null;
  runtimeLoadStatus: OpenCvRuntimeLoadResult | null;
  /**
   * Optional. When supplied (Run Mode), the helper appends a Transformation
   * confidence segment so both screens share one status-line shape.
   */
  transformationModel?: TransformationModel | null;
}

const formatRuntimeLoadStatus = (
  status: OpenCvRuntimeLoadResult | null
): string => {
  if (!status) {
    return '';
  }
  const reason = status.reason ? ` (${status.reason})` : '';
  return ` · OpenCV runtime ${status.status}${reason}`;
};

const formatTransformation = (model: TransformationModel | null | undefined): string => {
  if (model === undefined) {
    return '';
  }
  if (!model) {
    return ' · TransformationModel not computed';
  }
  return ` · TransformationModel confidence ${model.overallConfidence.toFixed(3)}`;
};

/**
 * Single canonical status-text composer used by Config Capture and Run Mode.
 * Both screens render the same StructuralModel/StructuralPage contracts; this
 * helper guarantees they describe that state with one wording shape.
 */
export const buildStructuralStatusText = ({
  hasPages,
  isComputing = false,
  structuralModel,
  structuralPage,
  runtimeLoadStatus,
  transformationModel
}: StructuralStatusTextInput): string => {
  if (isComputing) {
    return 'Computing StructuralModel…';
  }

  if (!hasPages) {
    return 'No NormalizedPage loaded.';
  }

  if (!structuralModel) {
    return 'StructuralModel pending.';
  }

  const adapter = structuralModel.cvAdapter;
  const pageCv = structuralPage?.cvExecutionMode ?? 'n/a';
  const pageCount = structuralModel.pages.length;

  return (
    `Structural: ${adapter.name} v${adapter.version}` +
    ` · ${pageCount} page(s)` +
    ` · page CV ${pageCv}` +
    formatRuntimeLoadStatus(runtimeLoadStatus) +
    formatTransformation(transformationModel)
  );
};
