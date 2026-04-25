import type { GeometryFile } from '../contracts/geometry';
import type { ObservableStore, StoreListener } from './observable-store';

export interface GeometryStoreSnapshot {
  geometries: GeometryFile[];
}

export interface GeometryStore extends ObservableStore<GeometryStoreSnapshot> {
  save(file: GeometryFile): Promise<void>;
  getById(id: string): Promise<GeometryFile | undefined>;
}

export const createGeometryStore = (): GeometryStore => {
  const memory = new Map<string, GeometryFile>();
  const listeners = new Set<StoreListener>();

  const buildSnapshot = (): GeometryStoreSnapshot => ({
    geometries: Array.from(memory.values())
  });

  let snapshot: GeometryStoreSnapshot = buildSnapshot();

  const notify = () => {
    snapshot = buildSnapshot();
    listeners.forEach((listener) => listener());
  };

  return {
    save: async (file) => {
      memory.set(file.id, file);
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
