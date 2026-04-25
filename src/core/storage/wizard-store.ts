import type { WizardFile } from '../contracts/wizard';

export interface WizardStore {
  save(wizard: WizardFile): void;
  getByName(name: string): WizardFile | undefined;
  list(): WizardFile[];
}

export const createWizardStore = (): WizardStore => {
  const memory = new Map<string, WizardFile>();

  return {
    save: (wizard) => {
      memory.set(wizard.wizardName, wizard);
    },
    getByName: (name) => memory.get(name),
    list: () => Array.from(memory.values())
  };
};
