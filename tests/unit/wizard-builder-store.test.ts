import { describe, expect, it } from 'vitest';

import { createWizardBuilderStore } from '../../src/core/storage/wizard-builder-store';

describe('wizard-builder-store input behavior', () => {
  it('keeps stable internal row identity when editing field ID', async () => {
    const store = createWizardBuilderStore();

    await store.addField();
    const initialInternalId = store.getSnapshot().fields[0].internalId;

    await store.updateField(0, { fieldId: 'v' });
    await store.updateField(0, { fieldId: 've' });
    await store.updateField(0, { fieldId: 'ven' });

    const state = store.getSnapshot();
    expect(state.fields[0].internalId).toBe(initialInternalId);
    expect(state.fields[0].fieldId).toBe('ven');
  });

  it('keeps stable internal row identity when editing label', async () => {
    const store = createWizardBuilderStore();

    await store.addField();
    const initialInternalId = store.getSnapshot().fields[0].internalId;

    await store.updateField(0, { label: 'I' });
    await store.updateField(0, { label: 'In' });
    await store.updateField(0, { label: 'Inv' });

    const state = store.getSnapshot();
    expect(state.fields[0].internalId).toBe(initialInternalId);
    expect(state.fields[0].label).toBe('Inv');
  });

  it('keeps in-progress field edits without resetting to defaults', async () => {
    const store = createWizardBuilderStore();

    await store.addField();
    await store.updateField(0, { fieldId: '' });
    await store.updateField(0, { label: '' });

    const editingState = store.getSnapshot();
    expect(editingState.fields[0].fieldId).toBe('');
    expect(editingState.fields[0].label).toBe('');

    const serialized = store.toWizardFile();
    expect(serialized.fields[0].fieldId).toBe('field_1');
    expect(serialized.fields[0].label).toBe('Field 1');
  });

  it('preserves imported empty values in editing state until export', async () => {
    const store = createWizardBuilderStore();

    await store.replaceFromWizardFile({
      schema: 'wrokit/wizard-file',
      version: '1.0',
      wizardName: 'Imported',
      fields: [{ fieldId: '', label: '', type: 'text', required: false }]
    });

    const editingState = store.getSnapshot();
    expect(editingState.fields[0].fieldId).toBe('');
    expect(editingState.fields[0].label).toBe('');

    const serialized = store.toWizardFile();
    expect(serialized.fields[0].fieldId).toBe('field_1');
    expect(serialized.fields[0].label).toBe('Field 1');
  });

  it('applies wizardName fallback only at export boundary', async () => {
    const store = createWizardBuilderStore();

    await store.setWizardName('   ');

    const editingState = store.getSnapshot();
    expect(editingState.wizardName).toBe('   ');

    const serialized = store.toWizardFile();
    expect(serialized.wizardName).toBe('');
  });
});
