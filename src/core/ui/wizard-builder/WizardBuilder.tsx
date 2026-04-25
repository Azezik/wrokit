import { useMemo, useRef, useState, type ChangeEvent } from 'react';

import { isWizardFile, type WizardFieldType } from '../../contracts/wizard';
import {
  createWizardBuilderStore,
  type WizardBuilderState
} from '../../storage/wizard-builder-store';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Panel } from '../components/Panel';

import './wizard-builder.css';

const fieldTypes: WizardFieldType[] = ['text', 'numeric', 'any'];

export function WizardBuilder() {
  const storeRef = useRef(createWizardBuilderStore());
  const [state, setState] = useState<WizardBuilderState>(storeRef.current.getState());
  const [importError, setImportError] = useState<string | null>(null);

  const wizardFilePreview = useMemo(
    () => JSON.stringify(storeRef.current.toWizardFile(), null, 2),
    [state]
  );

  const applyState = (nextState: WizardBuilderState) => {
    setState(nextState);
  };

  const handleDownload = () => {
    const wizardFile = storeRef.current.toWizardFile();
    const blob = new Blob([JSON.stringify(wizardFile, null, 2)], { type: 'application/json' });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = (wizardFile.wizardName || 'wizard').replace(/\s+/g, '-').toLowerCase();

    link.href = downloadUrl;
    link.download = `${safeName}.wizard.json`;
    link.click();

    URL.revokeObjectURL(downloadUrl);
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);

      if (!isWizardFile(parsed)) {
        setImportError('Invalid WizardFile JSON schema.');
        return;
      }

      setImportError(null);
      applyState(storeRef.current.replaceFromWizardFile(parsed));
    } catch {
      setImportError('Could not parse JSON file.');
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
            onChange={(event) => applyState(storeRef.current.setWizardName(event.target.value))}
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
                  <Button type="button" onClick={() => applyState(storeRef.current.moveField(index, -1))}>
                    Move Up
                  </Button>
                  <Button type="button" onClick={() => applyState(storeRef.current.moveField(index, 1))}>
                    Move Down
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => applyState(storeRef.current.removeField(index))}
                  >
                    Remove
                  </Button>
                </div>

                <label className="wizard-builder-label">
                  Field ID
                  <Input
                    type="text"
                    value={field.fieldId}
                    onChange={(event) =>
                      applyState(
                        storeRef.current.updateField(index, {
                          fieldId: event.target.value
                        })
                      )
                    }
                  />
                </label>

                <label className="wizard-builder-label">
                  Label
                  <Input
                    type="text"
                    value={field.label}
                    onChange={(event) =>
                      applyState(
                        storeRef.current.updateField(index, {
                          label: event.target.value
                        })
                      )
                    }
                  />
                </label>

                <label className="wizard-builder-label">
                  Type
                  <select
                    className="ui-select"
                    value={field.type}
                    onChange={(event) =>
                      applyState(
                        storeRef.current.updateField(index, {
                          type: event.target.value as WizardFieldType
                        })
                      )
                    }
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
                    onChange={(event) =>
                      applyState(
                        storeRef.current.updateField(index, {
                          required: event.target.checked
                        })
                      )
                    }
                  />{' '}
                  Required
                </label>
              </Panel>
            ))
          )}
        </div>

        <div className="wizard-builder-actions">
          <Button type="button" variant="primary" onClick={() => applyState(storeRef.current.addField())}>
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
