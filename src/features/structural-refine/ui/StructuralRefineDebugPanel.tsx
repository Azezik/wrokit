import { useRef, type ChangeEvent } from 'react';

import type { StructuralModel } from '../../../core/contracts/structural-model';
import type { StructuralRefineAnalytics } from '../../../core/contracts/structural-refine-analytics';
import {
  downloadStructuralRefineAnalytics,
  parseStructuralRefineAnalytics,
  StructuralRefineAnalyticsParseError
} from '../../../core/io/structural-refine-analytics-io';
import {
  downloadStructuralModel,
  parseStructuralModel,
  StructuralModelParseError
} from '../../../core/io/structural-model-io';
import { Button } from '../../../core/ui/components/Button';

import { StructuralRefineBuildingState } from './StructuralRefineBuildingState';
import './structural-refine.css';

export interface StructuralRefineDebugPanelProps {
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  priorAnalytics: StructuralRefineAnalytics | null;
  onPriorAnalyticsChange: (analytics: StructuralRefineAnalytics | null) => void;
  priorRefineModel: StructuralModel | null;
  onPriorRefineModelChange: (model: StructuralModel | null) => void;
  /**
   * Output from the most recent batch's refine finalize step. Surfaced for
   * download + promote-to-prior. Mirrors the polished wizard's
   * `lastRefineOutputs` orchestrator slot.
   */
  lastOutputs: { analytics: StructuralRefineAnalytics; refinedModel: StructuralModel } | null;
  /**
   * Substitute prior or last-output refined model for the config model when
   * predicting and projecting the config overlay. Default true mirrors the
   * polished wizard's behavior (a loaded prior is always used). The toggle
   * exists for debug A/B comparison and is otherwise a no-op when no refined
   * model is loaded.
   */
  useRefinedAsConfig: boolean;
  onUseRefinedAsConfigChange: (value: boolean) => void;
  /**
   * Currently-effective refined model — `lastOutputs?.refinedModel ?? priorRefineModel`.
   * Computed by the parent so the panel can show its id and gate the
   * "Use refined model" toggle on whether one is actually available.
   */
  effectiveRefinedModel: StructuralModel | null;
  /** Active batch state — disables uploads/toggle while a batch is running. */
  isBatchRunning: boolean;
  /**
   * Optional doc count from the most recent finalized batch. Surfaces how
   * many documents contributed to the analytics' running statistics.
   */
  lastBatchDocumentCount?: number;
}

export function StructuralRefineDebugPanel({
  enabled,
  onEnabledChange,
  priorAnalytics,
  onPriorAnalyticsChange,
  priorRefineModel,
  onPriorRefineModelChange,
  lastOutputs,
  useRefinedAsConfig,
  onUseRefinedAsConfigChange,
  effectiveRefinedModel,
  isBatchRunning,
  lastBatchDocumentCount
}: StructuralRefineDebugPanelProps) {
  const analyticsInputRef = useRef<HTMLInputElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);

  const handleToggle = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.checked;
    onEnabledChange(next);
    if (!next) {
      onPriorAnalyticsChange(null);
      onPriorRefineModelChange(null);
    }
  };

  const handleAnalyticsUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    try {
      onPriorAnalyticsChange(parseStructuralRefineAnalytics(await file.text()));
    } catch (error) {
      onPriorAnalyticsChange(null);
      // eslint-disable-next-line no-console
      console.warn(
        error instanceof StructuralRefineAnalyticsParseError
          ? error.message
          : 'Could not parse refine analytics JSON.'
      );
    }
  };

  const handleModelUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    try {
      onPriorRefineModelChange(parseStructuralModel(await file.text()));
    } catch (error) {
      onPriorRefineModelChange(null);
      // eslint-disable-next-line no-console
      console.warn(
        error instanceof StructuralModelParseError
          ? error.message
          : 'Could not parse refined StructuralModel JSON.'
      );
    }
  };

  const handlePromoteToPrior = () => {
    if (!lastOutputs) {
      return;
    }
    onPriorAnalyticsChange(lastOutputs.analytics);
    onPriorRefineModelChange(lastOutputs.refinedModel);
  };

  return (
    <div className="sr-toggle">
      <label className="sr-toggle__label">
        <input
          type="checkbox"
          checked={enabled}
          onChange={handleToggle}
          disabled={isBatchRunning}
          className="sr-toggle__checkbox"
        />
        <span>Enable Structural Refine (debug)</span>
        <span className="sr-toggle__badge">beta</span>
      </label>

      {enabled ? (
        <div className="sr-toggle__prior">
          <p className="sr-toggle__hint">
            Same engine + runner the polished wizard uses. When enabled, the batch run below
            invokes the same <code>createBatchCoordinator</code> the polished wizard does:
            it observes every document internally and finalizes after the loop. Uploaded
            priors are folded into finalize output (analytics) or substituted for the config
            model (refined model).
          </p>

          <div className="sr-toggle__upload">
            <input
              ref={analyticsInputRef}
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                void handleAnalyticsUpload(event);
              }}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="sr-toggle__upload-btn"
              onClick={() => analyticsInputRef.current?.click()}
              disabled={isBatchRunning}
            >
              {priorAnalytics
                ? `Prior analytics loaded (${priorAnalytics.documentCount} doc${priorAnalytics.documentCount !== 1 ? 's' : ''})`
                : 'Upload prior analytics…'}
            </button>
            {priorAnalytics ? (
              <button
                type="button"
                className="sr-toggle__clear-btn"
                onClick={() => onPriorAnalyticsChange(null)}
                disabled={isBatchRunning}
              >
                Clear
              </button>
            ) : null}
          </div>

          <div className="sr-toggle__upload">
            <input
              ref={modelInputRef}
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                void handleModelUpload(event);
              }}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="sr-toggle__upload-btn"
              onClick={() => modelInputRef.current?.click()}
              disabled={isBatchRunning}
            >
              {priorRefineModel ? 'Refined model loaded' : 'Upload prior refined model…'}
            </button>
            {priorRefineModel ? (
              <button
                type="button"
                className="sr-toggle__clear-btn"
                onClick={() => onPriorRefineModelChange(null)}
                disabled={isBatchRunning}
              >
                Clear
              </button>
            ) : null}
          </div>

          {effectiveRefinedModel ? (
            <label className="sr-toggle__label" style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                className="sr-toggle__checkbox"
                checked={useRefinedAsConfig}
                onChange={(event) => onUseRefinedAsConfigChange(event.target.checked)}
                disabled={isBatchRunning}
              />
              <span>
                Use refined model in place of config (prediction + overlay projection · current id <code>{effectiveRefinedModel.id}</code>)
              </span>
            </label>
          ) : null}

          {isBatchRunning ? <StructuralRefineBuildingState /> : null}

          {lastOutputs ? (
            <div className="sr-toggle__upload" style={{ flexWrap: 'wrap' }}>
              <span className="sr-toggle__hint" style={{ width: '100%' }}>
                Last batch refine output — analytics id <code>{lastOutputs.analytics.id}</code>{' '}
                ({lastBatchDocumentCount ?? lastOutputs.analytics.documentCount} doc
                {(lastBatchDocumentCount ?? lastOutputs.analytics.documentCount) !== 1 ? 's' : ''}),
                refined model id <code>{lastOutputs.refinedModel.id}</code>.
              </span>
              <Button
                type="button"
                onClick={() => {
                  downloadStructuralRefineAnalytics(lastOutputs.analytics);
                }}
              >
                Download refine analytics
              </Button>
              <Button
                type="button"
                onClick={() => {
                  downloadStructuralModel(lastOutputs.refinedModel);
                }}
              >
                Download refined model
              </Button>
              <Button type="button" onClick={handlePromoteToPrior} disabled={isBatchRunning}>
                Use as prior for next batch
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
