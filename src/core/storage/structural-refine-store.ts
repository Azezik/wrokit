import type { StructuralModel } from '../contracts/structural-model';
import type { StructuralRefineAnalytics } from '../contracts/structural-refine-analytics';
import type { ObservableStore, StoreListener } from './observable-store';

export interface StructuralRefineStoreOutputs {
  analytics: StructuralRefineAnalytics;
  refinedModel: StructuralModel;
}

export interface StructuralRefineStoreSnapshot {
  enabled: boolean;
  priorAnalytics: StructuralRefineAnalytics | null;
  lastOutputs: StructuralRefineStoreOutputs | null;
}

export interface StructuralRefineStore extends ObservableStore<StructuralRefineStoreSnapshot> {
  setEnabled(enabled: boolean): Promise<void>;
  setPriorAnalytics(analytics: StructuralRefineAnalytics | null): Promise<void>;
  setLastOutputs(outputs: StructuralRefineStoreOutputs | null): Promise<void>;
  clear(): Promise<void>;
}

export const createStructuralRefineStore = (): StructuralRefineStore => {
  let enabled = false;
  let priorAnalytics: StructuralRefineAnalytics | null = null;
  let lastOutputs: StructuralRefineStoreOutputs | null = null;
  const listeners = new Set<StoreListener>();

  const buildSnapshot = (): StructuralRefineStoreSnapshot => ({
    enabled,
    priorAnalytics,
    lastOutputs
  });

  let snapshot: StructuralRefineStoreSnapshot = buildSnapshot();

  const notify = () => {
    snapshot = buildSnapshot();
    listeners.forEach((listener) => listener());
  };

  return {
    setEnabled: async (value) => {
      enabled = value;
      notify();
    },
    setPriorAnalytics: async (analytics) => {
      priorAnalytics = analytics;
      notify();
    },
    setLastOutputs: async (outputs) => {
      lastOutputs = outputs;
      notify();
    },
    clear: async () => {
      enabled = false;
      priorAnalytics = null;
      lastOutputs = null;
      notify();
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
};
