import { Section } from '../../core/ui/components/Section';
import { WizardBuilder } from '../../core/ui/wizard-builder/WizardBuilder';

export function WizardBuilderPage() {
  return (
    <Section
      title="Wizard Builder"
      description="Define wizard fields and export/import WizardFile JSON without coupling to extraction runtime."
    >
      <WizardBuilder />
    </Section>
  );
}
