import { Section } from '../../core/ui/components/Section';
import { WizardBuilder } from '../../features/wizard-builder/ui/WizardBuilder';

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
