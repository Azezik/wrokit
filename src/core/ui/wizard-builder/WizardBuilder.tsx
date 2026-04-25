import { useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react';

import { isWizardFile, type WizardFieldType } from '../../contracts/wizard';
import {
  createWizardBuilderStore,
  type WizardBuilderState
} from '../../storage/wizard-builder-store';

const fieldTypes: WizardFieldType[] = ['text', 'numeric', 'any'];

const containerStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.4fr 1fr',
  gap: '1rem',
  alignItems: 'start'
};

const cardStyle: CSSProperties = {
  border: '1px solid #d6d6d6',
  borderRadius: '8px',
  padding: '1rem',
  background: '#fff'
};

const buttonGroupStyle: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  flexWrap: 'wrap'
};

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
    <section aria-label="Wizard Builder">
      <h2>Wizard Builder</h2>
      <p>Define a wizard file by naming fields and selecting field types.</p>

      <div style={containerStyle}>
        <div style={cardStyle}>
          <label style={{ display: 'block', marginBottom: '0.75rem' }}>
            <strong>Wizard Name</strong>
            <input
              type="text"
              value={state.wizardName}
              onChange={(event) => applyState(storeRef.current.setWizardName(event.target.value))}
              placeholder="Example: Vendor Invoice"
              style={{ display: 'block', width: '100%', marginTop: '0.35rem' }}
            />
          </label>

          <div style={{ marginBottom: '1rem' }}>
            <strong>Fields</strong>
            <div style={{ marginTop: '0.5rem' }}>
              {state.fields.length === 0 ? (
                <p>No fields yet. Add your first field.</p>
              ) : (
                state.fields.map((field, index) => (
                  <div
                    key={`${field.fieldId}-${index}`}
                    style={{ ...cardStyle, marginTop: '0.75rem', background: '#fafafa' }}
                  >
                    <div style={buttonGroupStyle}>
                      <button type="button" onClick={() => applyState(storeRef.current.moveField(index, -1))}>
                        Move Up
                      </button>
                      <button type="button" onClick={() => applyState(storeRef.current.moveField(index, 1))}>
                        Move Down
                      </button>
                      <button type="button" onClick={() => applyState(storeRef.current.removeField(index))}>
                        Remove
                      </button>
                    </div>

                    <label style={{ display: 'block', marginTop: '0.75rem' }}>
                      Field ID
                      <input
                        type="text"
                        value={field.fieldId}
                        onChange={(event) =>
                          applyState(
                            storeRef.current.updateField(index, {
                              fieldId: event.target.value
                            })
                          )
                        }
                        style={{ display: 'block', width: '100%' }}
                      />
                    </label>

                    <label style={{ display: 'block', marginTop: '0.5rem' }}>
                      Label
                      <input
                        type="text"
                        value={field.label}
                        onChange={(event) =>
                          applyState(
                            storeRef.current.updateField(index, {
                              label: event.target.value
                            })
                          )
                        }
                        style={{ display: 'block', width: '100%' }}
                      />
                    </label>

                    <label style={{ display: 'block', marginTop: '0.5rem' }}>
                      Type
                      <select
                        value={field.type}
                        onChange={(event) =>
                          applyState(
                            storeRef.current.updateField(index, {
                              type: event.target.value as WizardFieldType
                            })
                          )
                        }
                        style={{ display: 'block', width: '100%' }}
                      >
                        {fieldTypes.map((fieldType) => (
                          <option key={fieldType} value={fieldType}>
                            {fieldType}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label style={{ display: 'block', marginTop: '0.5rem' }}>
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
                  </div>
                ))
              )}
            </div>
          </div>

          <div style={buttonGroupStyle}>
            <button type="button" onClick={() => applyState(storeRef.current.addField())}>
              Add Field
            </button>
            <button type="button" onClick={handleDownload}>
              Download WizardFile JSON
            </button>
            <label style={{ display: 'inline-flex', alignItems: 'center' }}>
              <input type="file" accept="application/json" onChange={handleImport} />
            </label>
          </div>

          {importError ? (
            <p role="alert" style={{ color: '#a80000', marginTop: '0.75rem' }}>
              {importError}
            </p>
          ) : null}
        </div>

        <aside style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>Live WizardFile JSON</h3>
          <pre
            style={{
              margin: 0,
              overflow: 'auto',
              maxHeight: '70vh',
              background: '#101727',
              color: '#ebf0ff',
              padding: '0.75rem',
              borderRadius: '6px'
            }}
          >
            {wizardFilePreview}
          </pre>
        </aside>
      </div>
    </section>
  );
}
