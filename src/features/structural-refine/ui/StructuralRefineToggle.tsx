import { useRef, useState, type ChangeEvent } from 'react';

import { parseStructuralRefineAnalytics } from '../../../core/io/structural-refine-analytics-io';
import type { OrchestratorApi } from '../../polished-wizard/orchestrator/useOrchestrator';
import './structural-refine.css';

interface StructuralRefineToggleProps {
  orchestrator: OrchestratorApi;
}

export function StructuralRefineToggle({ orchestrator }: StructuralRefineToggleProps) {
  const { structuralRefineEnabled, priorRefineAnalytics } = orchestrator.state;
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleToggle = (event: ChangeEvent<HTMLInputElement>) => {
    orchestrator.setStructuralRefineEnabled(event.target.checked);
    if (!event.target.checked) {
      orchestrator.setPriorRefineAnalytics(null);
      setUploadError(null);
    }
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    event.target.value = '';
    setUploadError(null);
    try {
      const text = await file.text();
      const analytics = parseStructuralRefineAnalytics(text);
      orchestrator.setPriorRefineAnalytics(analytics);
    } catch (error) {
      setUploadError(
        error instanceof Error
          ? error.message
          : 'Could not load analytics file — it may belong to a different wizard or config.'
      );
      orchestrator.setPriorRefineAnalytics(null);
    }
  };

  const handleClearPrior = () => {
    orchestrator.setPriorRefineAnalytics(null);
    setUploadError(null);
  };

  return (
    <div className="sr-toggle">
      <label className="sr-toggle__label">
        <input
          type="checkbox"
          checked={structuralRefineEnabled}
          onChange={handleToggle}
          className="sr-toggle__checkbox"
        />
        <span>Enable Structural Refine</span>
        <span className="sr-toggle__badge">beta</span>
      </label>

      {structuralRefineEnabled ? (
        <div className="sr-toggle__prior">
          <p className="sr-toggle__hint">
            Accumulates batch statistics to produce a refined config model. Optionally upload a
            prior analytics file to extend across multiple batches.
          </p>
          <div className="sr-toggle__upload">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={(e) => { void handleFileChange(e); }}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="sr-toggle__upload-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              {priorRefineAnalytics
                ? `Prior loaded (${priorRefineAnalytics.documentCount} doc${priorRefineAnalytics.documentCount !== 1 ? 's' : ''})`
                : 'Upload prior analytics…'}
            </button>
            {priorRefineAnalytics ? (
              <button type="button" className="sr-toggle__clear-btn" onClick={handleClearPrior}>
                Clear
              </button>
            ) : null}
          </div>
          {uploadError ? <p className="sr-toggle__error">{uploadError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
