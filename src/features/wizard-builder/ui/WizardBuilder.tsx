import { useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';

import type { WizardFieldType } from '../../../core/contracts/wizard';
import {
  downloadWizardFile,
  parseWizardFile,
  serializeWizardFile,
  WizardFileParseError
} from '../../../core/io/wizard-file-io';
import { createWizardBuilderStore } from '../../../core/storage/wizard-builder-store';
import { Button } from '../../../core/ui/components/Button';
import { Input } from '../../../core/ui/components/Input';
import { Panel } from '../../../core/ui/components/Panel';

import './wizard-builder.css';

const fieldTypes: WizardFieldType[] = ['text', 'numeric', 'any'];

export function WizardBuilder() {
  const storeRef = useRef(createWizardBuilderStore());
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [importError, setImportError] = useState<string | null>(null);

  const wizardFilePreview = useMemo(() => serializeWizardFile(store.toWizardFile()), [state, store]);

  const handleDownload = () => {
    downloadWizardFile(store.toWizardFile());
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const wizardFile = parseWizardFile(text);
      setImportError(null);
      await store.replaceFromWizardFile(wizardFile);
    } catch (error) {
      setImportError(
        error instanceof WizardFileParseError ? error.message : 'Could not import WizardFile.'
      );
    }
  };

  return (
    <div className="wizard-builder-grid" aria-label="Wizard Builder">
      <Panel>
        <label className="wizard-builder-label">
          <strong>Wizard Name</strong>
          <Input
            type="text"
            value={state.wizardName}
            onChange={(event) => {
              void store.setWizardName(event.target.value);
            }}
            placeholder="Example: Vendor Invoice"
          />
        </label>

        <strong>Fields</strong>
        <div className="wizard-builder-field-list">
          {state.fields.length === 0 ? (
            <p>No fields yet. Add your first field.</p>
          ) : (
            state.fields.map((field, index) => (
              <Panel key={`${field.fieldId}-${index}`} className="wizard-builder-field-card">
                <div className="wizard-builder-actions">
                  <Button
                    type="button"
                    onClick={() => {
                      void store.moveField(index, -1);
                    }}
                  >
                    Move Up
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      void store.moveField(index, 1);
                    }}
                  >
                    Move Down
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => {
                      void store.removeField(index);
                    }}
                  >
                    Remove
                  </Button>
                </div>

                <label className="wizard-builder-label">
                  Field ID
                  <Input
                    type="text"
                    value={field.fieldId}
                    onChange={(event) => {
                      void store.updateField(index, { fieldId: event.target.value });
                    }}
                  />
                </label>

                <label className="wizard-builder-label">
                  Label
                  <Input
                    type="text"
                    value={field.label}
                    onChange={(event) => {
                      void store.updateField(index, { label: event.target.value });
                    }}
                  />
                </label>

                <label className="wizard-builder-label">
                  Type
                  <select
                    className="ui-select"
                    value={field.type}
                    onChange={(event) => {
                      void store.updateField(index, {
                        type: event.target.value as WizardFieldType
                      });
                    }}
                  >
                    {fieldTypes.map((fieldType) => (
                      <option key={fieldType} value={fieldType}>
                        {fieldType}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <input
                    type="checkbox"
                    checked={field.required}
                    onChange={(event) => {
                      void store.updateField(index, { required: event.target.checked });
                    }}
                  />{' '}
                  Required
                </label>
              </Panel>
            ))
          )}
        </div>

        <div className="wizard-builder-actions">
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              void store.addField();
            }}
          >
            Add Field
          </Button>
          <Button type="button" onClick={handleDownload}>
            Download WizardFile JSON
          </Button>
          <label>
            <Input type="file" accept="application/json" onChange={handleImport} />
          </label>
        </div>

        {importError ? (
          <p role="alert" className="wizard-builder-error">
            {importError}
          </p>
        ) : null}
      </Panel>

      <Panel as="aside">
        <h3 style={{ marginTop: 0 }}>Live WizardFile JSON</h3>
        <pre className="wizard-builder-json">{wizardFilePreview}</pre>
      </Panel>
    </div>
  );
}
