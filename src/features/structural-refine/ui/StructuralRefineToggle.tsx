import { useRef, useState, type ChangeEvent } from 'react';

import { parseStructuralModel } from '../../../core/io/structural-model-io';
import { parseStructuralRefineAnalytics } from '../../../core/io/structural-refine-analytics-io';
import type { OrchestratorApi } from '../../polished-wizard/orchestrator/useOrchestrator';
import './structural-refine.css';

interface StructuralRefineToggleProps {
  orchestrator: OrchestratorApi;
}

export function StructuralRefineToggle({ orchestrator }: StructuralRefineToggleProps) {
  const { structuralRefineEnabled, priorRefineAnalytics, priorRefineModel } = orchestrator.state;
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const analyticsInputRef = useRef<HTMLInputElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);

  const handleToggle = (event: ChangeEvent<HTMLInputElement>) => {
    orchestrator.setStructuralRefineEnabled(event.target.checked);
    if (!event.target.checked) {
      orchestrator.setPriorRefineAnalytics(null);
      orchestrator.setPriorRefineModel(null);
      setAnalyticsError(null);
      setModelError(null);
    }
  };

  const handleAnalyticsChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    event.target.value = '';
    setAnalyticsError(null);
    try {
      const text = await file.text();
      const analytics = parseStructuralRefineAnalytics(text);
      orchestrator.setPriorRefineAnalytics(analytics);
    } catch (error) {
      setAnalyticsError(
        error instanceof Error
          ? error.message
          : 'Could not load analytics file — it may belong to a different wizard or config.'
      );
      orchestrator.setPriorRefineAnalytics(null);
    }
  };

  const handleModelChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    event.target.value = '';
    setModelError(null);
    try {
      const text = await file.text();
      const model = parseStructuralModel(text);
      orchestrator.setPriorRefineModel(model);
    } catch (error) {
      setModelError(
        error instanceof Error
          ? error.message
          : 'Could not load refined structural model — file may be invalid.'
      );
      orchestrator.setPriorRefineModel(null);
    }
  };

  const handleClearAnalytics = () => {
    orchestrator.setPriorRefineAnalytics(null);
    setAnalyticsError(null);
  };

  const handleClearModel = () => {
    orchestrator.setPriorRefineModel(null);
    setModelError(null);
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
            prior analytics file to extend across multiple batches, and/or a refined model from a
            previous batch to use in place of the configured structural model.
          </p>
          <div className="sr-toggle__upload">
            <input
              ref={analyticsInputRef}
              type="file"
              accept=".json"
              onChange={(e) => { void handleAnalyticsChange(e); }}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="sr-toggle__upload-btn"
              onClick={() => analyticsInputRef.current?.click()}
            >
              {priorRefineAnalytics
                ? `Prior analytics loaded (${priorRefineAnalytics.documentCount} doc${priorRefineAnalytics.documentCount !== 1 ? 's' : ''})`
                : 'Upload prior analytics…'}
            </button>
            {priorRefineAnalytics ? (
              <button type="button" className="sr-toggle__clear-btn" onClick={handleClearAnalytics}>
                Clear
              </button>
            ) : null}
          </div>
          {analyticsError ? <p className="sr-toggle__error">{analyticsError}</p> : null}
          <div className="sr-toggle__upload">
            <input
              ref={modelInputRef}
              type="file"
              accept=".json"
              onChange={(e) => { void handleModelChange(e); }}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="sr-toggle__upload-btn"
              onClick={() => modelInputRef.current?.click()}
            >
              {priorRefineModel
                ? 'Refined model loaded'
                : 'Upload refined model…'}
            </button>
            {priorRefineModel ? (
              <button type="button" className="sr-toggle__clear-btn" onClick={handleClearModel}>
                Clear
              </button>
            ) : null}
          </div>
          {modelError ? <p className="sr-toggle__error">{modelError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
