import { useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';

import type { WizardFieldType } from '../../../../core/contracts/wizard';
import {
  downloadWizardFile,
  parseWizardFile,
  WizardFileParseError
} from '../../../../core/io/wizard-file-io';
import { createWizardBuilderStore } from '../../../../core/storage/wizard-builder-store';
import { Button } from '../../../../core/ui/components/Button';
import { Input } from '../../../../core/ui/components/Input';
import type { OrchestratorApi } from '../../orchestrator/useOrchestrator';

interface ConfigureWizardSlideProps {
  orchestrator: OrchestratorApi;
}

export function ConfigureWizardSlide({ orchestrator }: ConfigureWizardSlideProps) {
  const storeRef = useRef(createWizardBuilderStore());
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const [optionsOpen, setOptionsOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const handleSave = () => {
    const file = store.toWizardFile();
    if (!file.wizardName.trim()) {
      setImportError('Please provide a wizard name before continuing.');
      return;
    }
    if (file.fields.length === 0) {
      setImportError('Add at least one field before continuing.');
      return;
    }
    orchestrator.saveWizard(file);
  };

  const handleDownload = () => {
    setOptionsOpen(false);
    downloadWizardFile(store.toWizardFile());
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setOptionsOpen(false);
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const wizardFile = parseWizardFile(text);
      await store.replaceFromWizardFile(wizardFile);
      setImportError(null);
    } catch (error) {
      setImportError(
        error instanceof WizardFileParseError ? error.message : 'Could not import WizardFile.'
      );
    }
  };

  return (
    <>
      <div className="polished-wizard__slide">
        <h2 className="polished-wizard__title">Configure your wizard</h2>
        <p className="polished-wizard__subtitle">
          Name your wizard and add the fields you want to capture from each document.
        </p>

        <label>
          <strong>Wizard name</strong>
          <Input
            type="text"
            value={state.wizardName}
            placeholder="Example: Vendor Invoice"
            onChange={(event) => {
              void store.setWizardName(event.target.value);
            }}
          />
        </label>

        <strong>Fields</strong>
        <div className="polished-wizard__field-list">
          {state.fields.length === 0 ? (
            <p className="polished-wizard__hint">No fields yet. Add your first field below.</p>
          ) : (
            state.fields.map((field, index) => (
              <div key={field.internalId} className="polished-wizard__field-row">
                <span className="polished-wizard__field-tag">Field {index + 1}</span>
                <Input
                  type="text"
                  value={field.label}
                  placeholder={`Label for field ${index + 1}`}
                  onChange={(event) => {
                    void store.updateField(index, { label: event.target.value });
                  }}
                />
                <select
                  className="polished-wizard__field-type"
                  value={field.type}
                  aria-label={`Data type for field ${index + 1}`}
                  onChange={(event) => {
                    void store.updateField(index, {
                      type: event.target.value as WizardFieldType
                    });
                  }}
                >
                  <option value="any">Any</option>
                  <option value="text">Text</option>
                  <option value="numeric">Numeric</option>
                </select>
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => {
                    void store.removeField(index);
                  }}
                  aria-label={`Remove field ${index + 1}`}
                >
                  Remove
                </Button>
              </div>
            ))
          )}
        </div>

        <div>
          <Button
            type="button"
            onClick={() => {
              void store.addField();
            }}
          >
            + Add field
          </Button>
        </div>

        {importError ? <p className="polished-wizard__error">{importError}</p> : null}
      </div>

      <footer className="polished-wizard__footer">
        <div className="polished-wizard__options">
          <Button
            type="button"
            onClick={() => setOptionsOpen((open) => !open)}
            aria-expanded={optionsOpen}
          >
            Options
          </Button>
          {optionsOpen ? (
            <div className="polished-wizard__options-menu" role="menu">
              <button
                type="button"
                onClick={handleDownload}
                disabled={state.fields.length === 0 || state.wizardName.trim() === ''}
              >
                Download wizard file
              </button>
              <label>
                Upload wizard file
                <input
                  type="file"
                  accept="application/json"
                  onChange={handleImport}
                />
              </label>
            </div>
          ) : null}
        </div>
        <div className="polished-wizard__footer-actions">
          <Button type="button" variant="primary" onClick={handleSave}>
            Save & continue
          </Button>
        </div>
      </footer>
    </>
  );
}
