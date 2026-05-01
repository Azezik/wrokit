import type { GeometryFile } from '../contracts/geometry';
import type { NormalizedPage } from '../contracts/normalized-page';
import type { StructuralModel } from '../contracts/structural-model';
import {
  createOpenCvJsAdapter,
  ensureOpenCvJsRuntime,
  createStructuralEngine,
  type CvAdapter,
  type OpenCvRuntimeLoadResult,
  type StructuralEngine,
  type StructuralEngineInput
} from '../engines/structure';
import type {
  StructuralWorkerRequest,
  StructuralWorkerResponse
} from './structural-worker';

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
  /**
   * When `true` (default in browser), heavy structural compute runs inside a
   * dedicated Web Worker so the row/column sweeps and the line-grid quadruple
   * loop do not block input on the main thread. Set `false` to force the
   * in-thread path (used by tests and any non-DOM caller). Tests target the
   * engine directly, so this flag does not affect engine-level coverage.
   */
  useWorker?: boolean;
}

const canUseStructuralWorker = (): boolean => {
  return (
    typeof Worker !== 'undefined' &&
    typeof URL !== 'undefined' &&
    // Vite resolves `new URL(..., import.meta.url)` at build time. Skip when
    // import.meta.url is missing (e.g. some test runners).
    typeof import.meta !== 'undefined' &&
    typeof (import.meta as { url?: string }).url === 'string'
  );
};

const createStructuralWorker = (): Worker => {
  return new Worker(new URL('./structural-worker.ts', import.meta.url), {
    type: 'module',
    name: 'wrokit-structural-worker'
  });
};

interface PendingRequest {
  resolve(model: StructuralModel): void;
  reject(error: Error): void;
}

interface WorkerProxyHandle {
  compute(input: StructuralEngineInput): Promise<StructuralModel>;
  getRuntimeLoadStatus(): OpenCvRuntimeLoadResult | null;
}

const createWorkerProxy = (): WorkerProxyHandle => {
  let worker: Worker | null = null;
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let runtimeLoadStatus: OpenCvRuntimeLoadResult | null = null;

  const ensureWorker = (): Worker => {
    if (worker) {
      return worker;
    }
    const w = createStructuralWorker();
    w.onmessage = (event: MessageEvent<StructuralWorkerResponse>) => {
      const message = event.data;
      if (!message || message.type !== 'compute-result') {
        return;
      }
      const handler = pending.get(message.id);
      if (!handler) {
        return;
      }
      pending.delete(message.id);
      if (message.runtimeLoadStatus) {
        runtimeLoadStatus = message.runtimeLoadStatus;
      }
      if (message.ok) {
        handler.resolve(message.model);
      } else {
        handler.reject(new Error(message.error));
      }
    };
    w.onerror = (event) => {
      const error = new Error(event.message || 'Structural worker errored.');
      for (const [, handler] of pending) {
        handler.reject(error);
      }
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    worker = w;
    return w;
  };

  return {
    compute: (input) =>
      new Promise<StructuralModel>((resolve, reject) => {
        const w = ensureWorker();
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const message: StructuralWorkerRequest = { type: 'compute', id, input };
        try {
          w.postMessage(message);
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    getRuntimeLoadStatus: () => runtimeLoadStatus
  };
};

/**
 * The Structural Runner is the only place engines are composed for structural
 * detection. It owns the CV adapter selection (OpenCV.js by default) so the
 * rest of the app — UI, stores, contracts — depends only on the abstract
 * `StructuralModel` contract and the runner interface.
 *
 * In browser environments, structural compute is dispatched to a dedicated
 * Web Worker so the heavy line-grid sweeps and line-bounded-rect search do
 * not block input. The engine's public API and unit tests are unaffected:
 * tests construct the engine directly.
 */
export const createStructuralRunner = (
  options: CreateStructuralRunnerOptions = {}
): StructuralRunner => {
  const cvAdapter = options.cvAdapter ?? createOpenCvJsAdapter();
  const engine =
    options.engineFactory?.(cvAdapter) ??
    createStructuralEngine({ cvAdapter });
  let runtimeLoadStatus: OpenCvRuntimeLoadResult | null = null;

  const useWorker =
    options.useWorker !== undefined ? options.useWorker : canUseStructuralWorker();

  let workerProxy: WorkerProxyHandle | null = null;
  if (useWorker) {
    try {
      workerProxy = createWorkerProxy();
    } catch {
      workerProxy = null;
    }
  }

  return {
    cvAdapter,
    get runtimeLoadStatus() {
      return workerProxy ? workerProxy.getRuntimeLoadStatus() : runtimeLoadStatus;
    },
    compute: async (input) => {
      const engineInput: StructuralEngineInput = {
        pages: input.pages,
        geometry: input.geometry ?? null,
        documentFingerprint: input.documentFingerprint,
        pageIndexes: input.pageIndexes,
        id: input.id,
        nowIso: input.nowIso
      };

      if (workerProxy) {
        return workerProxy.compute(engineInput);
      }

      runtimeLoadStatus =
        (await (options.ensureRuntime?.() ?? ensureOpenCvJsRuntime())) ?? null;
      return engine.run(engineInput);
    }
  };
};
