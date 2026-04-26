import type { WizardField, WizardFieldType, WizardFile } from '../contracts/wizard';
import type { ObservableStore, StoreListener } from './observable-store';

export interface WizardBuilderField extends WizardField {
  internalId: string;
}

export interface WizardBuilderState {
  wizardName: string;
  fields: WizardBuilderField[];
}

export interface WizardBuilderStore extends ObservableStore<WizardBuilderState> {
  setWizardName(name: string): Promise<void>;
  addField(): Promise<void>;
  removeField(index: number): Promise<void>;
  moveField(index: number, direction: -1 | 1): Promise<void>;
  updateField(index: number, field: Partial<WizardField>): Promise<void>;
  replaceFromWizardFile(wizardFile: WizardFile): Promise<void>;
  toWizardFile(): WizardFile;
}

let fieldInternalIdCounter = 0;

const createInternalId = (): string => {
  fieldInternalIdCounter += 1;
  return `wb_field_${fieldInternalIdCounter}`;
};

const createField = (index: number): WizardBuilderField => ({
  internalId: createInternalId(),
  fieldId: `field_${index + 1}`,
  label: `Field ${index + 1}`,
  type: 'text',
  required: false
});

const normalizeFieldForFile = (field: WizardField, index: number): WizardField => ({
  fieldId: field.fieldId.trim() || `field_${index + 1}`,
  label: field.label.trim() || `Field ${index + 1}`,
  type: field.type,
  required: field.required
});

const cloneField = (field: WizardField): WizardBuilderField => ({
  internalId: createInternalId(),
  ...field
});

export const createEmptyWizardFile = (): WizardFile => ({
  schema: 'wrokit/wizard-file',
  version: '1.0',
  wizardName: '',
  fields: []
});

export const createWizardBuilderStore = (
  initial: WizardBuilderState = { wizardName: '', fields: [] }
): WizardBuilderStore => {
  let state: WizardBuilderState = {
    wizardName: initial.wizardName,
    fields: initial.fields.map(cloneField)
  };

  const listeners = new Set<StoreListener>();

  const commit = (next: WizardBuilderState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  return {
    getSnapshot: () => state,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setWizardName: async (name) => {
      commit({ ...state, wizardName: name });
    },

    addField: async () => {
      commit({
        ...state,
        fields: [...state.fields, createField(state.fields.length)]
      });
    },

    removeField: async (index) => {
      commit({
        ...state,
        fields: state.fields.filter((_, fieldIndex) => fieldIndex !== index)
      });
    },

    moveField: async (index, direction) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= state.fields.length) {
        return;
      }

      const reordered = [...state.fields];
      const [field] = reordered.splice(index, 1);
      reordered.splice(nextIndex, 0, field);

      commit({ ...state, fields: reordered });
    },

    updateField: async (index, field) => {
      commit({
        ...state,
        fields: state.fields.map((currentField, fieldIndex) =>
          fieldIndex === index
            ? {
                ...currentField,
                ...field,
                type: (field.type as WizardFieldType | undefined) ?? currentField.type
              }
            : currentField
        )
      });
    },

    replaceFromWizardFile: async (wizardFile) => {
      commit({
        wizardName: wizardFile.wizardName,
        fields: wizardFile.fields.map(cloneField)
      });
    },

    toWizardFile: () => ({
      schema: 'wrokit/wizard-file',
      version: '1.0',
      wizardName: state.wizardName.trim(),
      fields: state.fields.map(({ internalId: _internalId, ...field }, index) =>
        normalizeFieldForFile(field, index)
      )
    })
  };
};
