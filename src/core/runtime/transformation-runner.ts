import type { StructuralModel } from '../contracts/structural-model';
import {
  createEmptyTransformationModel,
  type TransformationModel
} from '../contracts/transformation-model';

export interface TransformationRunnerInput {
  config: StructuralModel;
  runtime: StructuralModel;
  id?: string;
  nowIso?: string;
}

export interface TransformationRunner {
  compute(input: TransformationRunnerInput): TransformationModel;
}

export interface CreateTransformationRunnerOptions {
  /**
   * Optional id factory. Defaults to a timestamped identifier.
   */
  generateId?: () => string;
  /**
   * Optional clock. Defaults to `new Date().toISOString()`.
   */
  now?: () => string;
}

const defaultGenerateId = (): string =>
  `xform_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const defaultNow = (): string => new Date().toISOString();

/**
 * The Transformation Runner produces a TransformationModel that compares a
 * Config StructuralModel against a Runtime StructuralModel. It does not mutate
 * either input. In Phase 1 it returns the canonical empty/identity model;
 * later phases populate matches, transforms, consensus, and field candidates.
 */
export const createTransformationRunner = (
  options: CreateTransformationRunnerOptions = {}
): TransformationRunner => {
  const generateId = options.generateId ?? defaultGenerateId;
  const now = options.now ?? defaultNow;

  return {
    compute: ({ config, runtime, id, nowIso }) => {
      return createEmptyTransformationModel({
        id: id ?? generateId(),
        config,
        runtime,
        createdAtIso: nowIso ?? now()
      });
    }
  };
};
