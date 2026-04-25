import type { WizardFile } from '../contracts/wizard';

export interface ConfigRunner {
  loadWizard(wizard: WizardFile): void;
}

export const createConfigRunner = (): ConfigRunner => ({
  loadWizard: (_wizard) => {
    // Placeholder: runtime configuration pipeline will be added incrementally.
  }
});
