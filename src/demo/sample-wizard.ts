import type { WizardFile } from '../core/contracts/wizard';

export const sampleWizard: WizardFile = {
  schema: 'wrokit/wizard-file',
  version: '1.0',
  wizardName: 'Sample Invoice Wizard',
  fields: [
    {
      fieldId: 'invoice_number',
      label: 'Invoice Number',
      type: 'text',
      required: true
    },
    {
      fieldId: 'total_amount',
      label: 'Total Amount',
      type: 'numeric',
      required: true
    }
  ]
};
