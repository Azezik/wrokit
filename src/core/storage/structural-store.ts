import type { StructuralModel } from '../contracts/structural-model';
import type { ObservableStore, StoreListener } from './observable-store';

export interface StructuralStoreSnapshot {
  models: StructuralModel[];
}

export interface StructuralStore extends ObservableStore<StructuralStoreSnapshot> {
  save(model: StructuralModel): Promise<void>;
  getById(id: string): Promise<StructuralModel | undefined>;
}

export const createStructuralStore = (): StructuralStore => {
  const memory = new Map<string, StructuralModel>();
  const listeners = new Set<StoreListener>();

  const buildSnapshot = (): StructuralStoreSnapshot => ({
    models: Array.from(memory.values())
  });

  let snapshot: StructuralStoreSnapshot = buildSnapshot();

  const notify = () => {
    snapshot = buildSnapshot();
    listeners.forEach((listener) => listener());
  };

  return {
    save: async (model) => {
      memory.set(model.id, model);
      notify();
    },
    getById: async (id) => memory.get(id),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
};
