import type { StructuralModel } from '../contracts/structural-model';

export interface StructuralStore {
  save(model: StructuralModel): void;
  getById(id: string): StructuralModel | undefined;
}

export const createStructuralStore = (): StructuralStore => {
  const memory = new Map<string, StructuralModel>();

  return {
    save: (model) => {
      memory.set(model.id, model);
    },
    getById: (id) => memory.get(id)
  };
};
