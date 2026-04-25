import type { WizardField, WizardFieldType, WizardFile } from '../contracts/wizard';

export interface WizardBuilderState {
  wizardName: string;
  fields: WizardField[];
}

export interface WizardBuilderStore {
  setWizardName(name: string): WizardBuilderState;
  addField(): WizardBuilderState;
  removeField(index: number): WizardBuilderState;
  moveField(index: number, direction: -1 | 1): WizardBuilderState;
  updateField(index: number, field: Partial<WizardField>): WizardBuilderState;
  replaceFromWizardFile(wizardFile: WizardFile): WizardBuilderState;
  toWizardFile(): WizardFile;
  getState(): WizardBuilderState;
}

const createField = (index: number): WizardField => ({
  fieldId: `field_${index + 1}`,
  label: `Field ${index + 1}`,
  type: 'text',
  required: false
});

const normalizeField = (field: WizardField, index: number): WizardField => ({
  fieldId: field.fieldId.trim() || `field_${index + 1}`,
  label: field.label.trim() || `Field ${index + 1}`,
  type: field.type,
  required: field.required
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
    fields: initial.fields.map((field, index) => normalizeField(field, index))
  };

  const setState = (next: WizardBuilderState): WizardBuilderState => {
    state = next;
    return state;
  };

  return {
    setWizardName: (name) =>
      setState({
        ...state,
        wizardName: name
      }),

    addField: () =>
      setState({
        ...state,
        fields: [...state.fields, createField(state.fields.length)]
      }),

    removeField: (index) =>
      setState({
        ...state,
        fields: state.fields.filter((_, fieldIndex) => fieldIndex !== index)
      }),

    moveField: (index, direction) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= state.fields.length) {
        return state;
      }

      const reordered = [...state.fields];
      const [field] = reordered.splice(index, 1);
      reordered.splice(nextIndex, 0, field);

      return setState({
        ...state,
        fields: reordered
      });
    },

    updateField: (index, field) =>
      setState({
        ...state,
        fields: state.fields.map((currentField, fieldIndex) =>
          fieldIndex === index
            ? normalizeField(
                {
                  ...currentField,
                  ...field,
                  type: (field.type as WizardFieldType | undefined) ?? currentField.type
                },
                fieldIndex
              )
            : currentField
        )
      }),

    replaceFromWizardFile: (wizardFile) =>
      setState({
        wizardName: wizardFile.wizardName,
        fields: wizardFile.fields.map((field, index) => normalizeField(field, index))
      }),

    toWizardFile: () => ({
      schema: 'wrokit/wizard-file',
      version: '1.0',
      wizardName: state.wizardName.trim(),
      fields: state.fields.map((field, index) => normalizeField(field, index))
    }),

    getState: () => state
  };
};
