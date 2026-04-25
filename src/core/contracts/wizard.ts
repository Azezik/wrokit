export type WizardFieldType = 'text' | 'numeric' | 'any';

export interface WizardField {
  fieldId: string;
  label: string;
  type: WizardFieldType;
  required: boolean;
}

export interface WizardFile {
  schema: 'wrokit/wizard-file';
  version: '1.0';
  wizardName: string;
  fields: WizardField[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isWizardFieldType = (value: unknown): value is WizardFieldType =>
  value === 'text' || value === 'numeric' || value === 'any';

export const isWizardFile = (value: unknown): value is WizardFile => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.schema !== 'wrokit/wizard-file' ||
    value.version !== '1.0' ||
    typeof value.wizardName !== 'string' ||
    !Array.isArray(value.fields)
  ) {
    return false;
  }

  return value.fields.every((field) => {
    if (!isRecord(field)) {
      return false;
    }

    return (
      typeof field.fieldId === 'string' &&
      typeof field.label === 'string' &&
      isWizardFieldType(field.type) &&
      typeof field.required === 'boolean'
    );
  });
};
