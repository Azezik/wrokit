import { WizardBuilder } from '../../core/ui/wizard-builder/WizardBuilder';

export function WizardBuilderPage() {
  return (
    <main style={{ fontFamily: 'Arial, sans-serif', padding: '1.5rem', lineHeight: 1.5 }}>
      <h1>Wrokit V2</h1>
      <WizardBuilder />
    </main>
  );
}
