import type { GeometryFile } from '../contracts/geometry';

export interface GeometryStore {
  save(file: GeometryFile): void;
  getById(id: string): GeometryFile | undefined;
}

export const createGeometryStore = (): GeometryStore => {
  const memory = new Map<string, GeometryFile>();

  return {
    save: (file) => {
      memory.set(file.id, file);
    },
    getById: (id) => memory.get(id)
  };
};
