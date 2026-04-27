import type { GeometryFile } from '../contracts/geometry';
import type { NormalizedPage } from '../contracts/normalized-page';
import type { StructuralModel } from '../contracts/structural-model';
import {
  createOpenCvJsAdapter,
  ensureOpenCvJsRuntime,
  createStructuralEngine,
  type CvAdapter,
  type OpenCvRuntimeLoadResult,
  type StructuralEngine
} from '../engines/structure';

export interface StructuralRunnerInput {
  pages: NormalizedPage[];
  geometry?: GeometryFile | null;
  documentFingerprint: string;
  pageIndexes?: number[];
  id?: string;
  nowIso?: string;
}

export interface StructuralRunner {
  readonly cvAdapter: CvAdapter;
  readonly runtimeLoadStatus: OpenCvRuntimeLoadResult | null;
  compute(input: StructuralRunnerInput): Promise<StructuralModel>;
}

export interface CreateStructuralRunnerOptions {
  cvAdapter?: CvAdapter;
  engineFactory?: (cvAdapter: CvAdapter) => StructuralEngine;
  ensureRuntime?: () => Promise<OpenCvRuntimeLoadResult>;
}

/**
 * The Structural Runner is the only place engines are composed for structural
 * detection. It owns the CV adapter selection (OpenCV.js by default) so the
 * rest of the app — UI, stores, contracts — depends only on the abstract
 * `StructuralModel` contract and the runner interface.
 */
export const createStructuralRunner = (
  options: CreateStructuralRunnerOptions = {}
): StructuralRunner => {
  const cvAdapter = options.cvAdapter ?? createOpenCvJsAdapter();
  const engine =
    options.engineFactory?.(cvAdapter) ??
    createStructuralEngine({ cvAdapter });
  let runtimeLoadStatus: OpenCvRuntimeLoadResult | null = null;

  return {
    cvAdapter,
    get runtimeLoadStatus() {
      return runtimeLoadStatus;
    },
    compute: async (input) => {
      runtimeLoadStatus =
        (await (options.ensureRuntime?.() ?? ensureOpenCvJsRuntime())) ?? null;
      return engine.run({
        pages: input.pages,
        geometry: input.geometry ?? null,
        documentFingerprint: input.documentFingerprint,
        pageIndexes: input.pageIndexes,
        id: input.id,
        nowIso: input.nowIso
      });
    }
  };
};
