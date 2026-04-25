import type { WizardFile } from '../contracts/wizard';
import type { ObservableStore, StoreListener } from './observable-store';

export interface WizardStoreSnapshot {
  wizards: WizardFile[];
}

export interface WizardStore extends ObservableStore<WizardStoreSnapshot> {
  save(wizard: WizardFile): Promise<void>;
  getByName(name: string): Promise<WizardFile | undefined>;
  list(): Promise<WizardFile[]>;
}

export const createWizardStore = (): WizardStore => {
  const memory = new Map<string, WizardFile>();
  const listeners = new Set<StoreListener>();

  const buildSnapshot = (): WizardStoreSnapshot => ({
    wizards: Array.from(memory.values())
  });

  let snapshot: WizardStoreSnapshot = buildSnapshot();

  const notify = () => {
    snapshot = buildSnapshot();
    listeners.forEach((listener) => listener());
  };

  return {
    save: async (wizard) => {
      memory.set(wizard.wizardName, wizard);
      notify();
    },
    getByName: async (name) => memory.get(name),
    list: async () => Array.from(memory.values()),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
};
