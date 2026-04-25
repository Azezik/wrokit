export interface WizardField {
  id: string;
  key: string;
  label: string;
  description?: string;
  required: boolean;
  valueType: 'string' | 'number' | 'date' | 'currency' | 'boolean' | 'custom';
  hint?: string;
}

export interface WizardFile {
  id: string;
  name: string;
  version: string;
  documentType: string;
  fields: WizardField[];
  metadata?: Record<string, string>;
}
