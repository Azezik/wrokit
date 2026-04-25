import type { WizardFile } from '../contracts/wizard';

export interface WizardStore {
  save(wizard: WizardFile): void;
  getById(id: string): WizardFile | undefined;
}

export const createWizardStore = (): WizardStore => {
  const memory = new Map<string, WizardFile>();

  return {
    save: (wizard) => {
      memory.set(wizard.id, wizard);
    },
    getById: (id) => memory.get(id)
  };
};
