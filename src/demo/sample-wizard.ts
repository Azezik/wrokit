import type { WizardFile } from '../core/contracts/wizard';

export const sampleWizard: WizardFile = {
  id: 'wizard-paystub-v1',
  name: 'Pay Stub Starter',
  version: '1.0.0',
  documentType: 'pay-stub',
  fields: [
    {
      id: 'employee-name',
      key: 'employeeName',
      label: 'Employee Name',
      required: true,
      valueType: 'string'
    },
    {
      id: 'gross-pay',
      key: 'grossPay',
      label: 'Gross Pay',
      required: true,
      valueType: 'currency'
    }
  ]
};
