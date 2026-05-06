import { useRef, useState, type ChangeEvent } from 'react';

import type { GeometryFile } from '../../../core/contracts/geometry';
import type { PredictedGeometryFile } from '../../../core/contracts/predicted-geometry-file';
import type { StructuralModel } from '../../../core/contracts/structural-model';
import type { StructuralRefineAnalytics } from '../../../core/contracts/structural-refine-analytics';
import type { TransformationModel } from '../../../core/contracts/transformation-model';
import type { WizardFile } from '../../../core/contracts/wizard';
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
import {
  createStructuralRefineRunner,
  type StructuralRefineRunner
} from '../../../core/runtime/structural-refine-runner';
import { Button } from '../../../core/ui/components/Button';

import { StructuralRefineBuildingState } from './StructuralRefineBuildingState';
import './structural-refine.css';

export interface StructuralRefineObservationInput {
  runtimeStructure: StructuralModel;
  transformationModel: TransformationModel;
  predicted: PredictedGeometryFile;
}

export interface StructuralRefineDebugPanelProps {
  wizard: WizardFile | null;
  geometry: GeometryFile | null;
  configStructural: StructuralModel | null;
  /**
   * Whether the user wants the refined model (uploaded prior or just-finalized)
   * substituted for the config model when predicting and when projecting the
   * config overlay. When false, the original config StructuralModel is used.
   */
  useRefinedAsConfig: boolean;
  onUseRefinedAsConfigChange: (value: boolean) => void;
  /**
   * Optional last observation. When set, the panel exposes an "Observe latest
   * prediction" button so the user can fold the most recent runtime result
   * into the running batch state without auto-coupling to prediction. We make
   * the observation explicit so the debug screen does not silently mutate
   * runner state on every prediction click.
   */
  latestObservation: StructuralRefineObservationInput | null;
  /**
   * Surfaces the effective "refined" structural model (uploaded prior, OR the
   * last finalize output) so the parent can pipe it into prediction + overlay
   * paths when `useRefinedAsConfig` is true. Returns null when none is
   * available — the parent should then fall back to the original config.
   */
  onEffectiveRefinedModelChange?: (model: StructuralModel | null) => void;
}

interface FinalizeOutputs {
  analytics: StructuralRefineAnalytics;
  refinedModel: StructuralModel;
}

export function StructuralRefineDebugPanel({
  wizard,
  geometry,
  configStructural,
  useRefinedAsConfig,
  onUseRefinedAsConfigChange,
  latestObservation,
  onEffectiveRefinedModelChange
}: StructuralRefineDebugPanelProps) {
  const [enabled, setEnabled] = useState(false);
  const [priorAnalytics, setPriorAnalytics] = useState<StructuralRefineAnalytics | null>(null);
  const [priorRefineModel, setPriorRefineModel] = useState<StructuralModel | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [observeError, setObserveError] = useState<string | null>(null);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [observedCount, setObservedCount] = useState(0);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [lastOutputs, setLastOutputs] = useState<FinalizeOutputs | null>(null);

  // Snapshots of the inputs the current runner instance was constructed with.
  // Required so the user can see when a runner is "stale" (e.g. they swapped
  // wizard/geometry mid-batch) without us silently rebuilding the runner and
  // dropping accumulated observations.
  const [runnerInputs, setRunnerInputs] = useState<{
    wizardId: string;
    geometryId: string;
    configStructuralId: string;
    priorAnalyticsId: string | null;
  } | null>(null);

  const runnerRef = useRef<StructuralRefineRunner | null>(null);
  const analyticsInputRef = useRef<HTMLInputElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);

  const inputsReady = Boolean(wizard && geometry && configStructural);
  const runnerActive = enabled && runnerRef.current !== null;

  const effectiveRefined = lastOutputs?.refinedModel ?? priorRefineModel ?? null;
  const previousEffectiveRefRef = useRef<StructuralModel | null>(null);
  if (previousEffectiveRefRef.current !== effectiveRefined) {
    previousEffectiveRefRef.current = effectiveRefined;
    onEffectiveRefinedModelChange?.(effectiveRefined);
  }

  const handleStart = () => {
    if (!wizard || !geometry || !configStructural) {
      setObserveError('Load WizardFile, GeometryFile, and Config StructuralModel before starting a refine batch.');
      return;
    }
    runnerRef.current = createStructuralRefineRunner({
      wizard,
      geometry,
      configStructural,
      priorAnalytics: priorAnalytics ?? null
    });
    setRunnerInputs({
      wizardId: wizard.wizardName,
      geometryId: geometry.id,
      configStructuralId: configStructural.id,
      priorAnalyticsId: priorAnalytics?.id ?? null
    });
    setObservedCount(0);
    setObserveError(null);
    setFinalizeError(null);
    setLastOutputs(null);
  };

  const handleStop = () => {
    runnerRef.current = null;
    setRunnerInputs(null);
    setObservedCount(0);
    setObserveError(null);
  };

  const handleToggle = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.checked;
    setEnabled(next);
    if (!next) {
      runnerRef.current = null;
      setRunnerInputs(null);
      setObservedCount(0);
      setPriorAnalytics(null);
      setPriorRefineModel(null);
      setAnalyticsError(null);
      setModelError(null);
      setObserveError(null);
      setFinalizeError(null);
      setLastOutputs(null);
    }
  };

  const handleAnalyticsUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    setAnalyticsError(null);
    try {
      setPriorAnalytics(parseStructuralRefineAnalytics(await file.text()));
    } catch (error) {
      setPriorAnalytics(null);
      setAnalyticsError(
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
    setModelError(null);
    try {
      setPriorRefineModel(parseStructuralModel(await file.text()));
    } catch (error) {
      setPriorRefineModel(null);
      setModelError(
        error instanceof StructuralModelParseError
          ? error.message
          : 'Could not parse refined StructuralModel JSON.'
      );
    }
  };

  const handleObserve = () => {
    if (!runnerRef.current) {
      setObserveError('Start a refine batch before observing.');
      return;
    }
    if (!latestObservation) {
      setObserveError('Run a prediction first — the refine observer needs runtime structure, transformation, and predicted geometry.');
      return;
    }
    try {
      runnerRef.current.observe(latestObservation);
      setObservedCount((prev) => prev + 1);
      setObserveError(null);
    } catch (error) {
      setObserveError(
        error instanceof Error ? error.message : 'Refine observation failed.'
      );
    }
  };

  const handleFinalize = async () => {
    if (!runnerRef.current) {
      setFinalizeError('Start a refine batch before finalizing.');
      return;
    }
    if (observedCount === 0) {
      setFinalizeError('Observe at least one prediction before finalizing.');
      return;
    }
    setIsFinalizing(true);
    setFinalizeError(null);
    try {
      const batchId = `debug-${Date.now()}`;
      const outputs = await runnerRef.current.finalize({ batchId });
      setLastOutputs(outputs);
      // Treat finalize as the close of this batch — drop the runner so the
      // user explicitly starts a new batch before observing again.
      runnerRef.current = null;
      setRunnerInputs(null);
      setObservedCount(0);
    } catch (error) {
      setFinalizeError(
        error instanceof Error ? error.message : 'Refine finalize failed.'
      );
    } finally {
      setIsFinalizing(false);
    }
  };

  const handlePromoteToPrior = () => {
    if (!lastOutputs) {
      return;
    }
    setPriorAnalytics(lastOutputs.analytics);
    setPriorRefineModel(lastOutputs.refinedModel);
  };

  const handleClearAnalytics = () => {
    setPriorAnalytics(null);
    setAnalyticsError(null);
  };

  const handleClearModel = () => {
    setPriorRefineModel(null);
    setModelError(null);
  };

  return (
    <div className="sr-toggle">
      <label className="sr-toggle__label">
        <input
          type="checkbox"
          checked={enabled}
          onChange={handleToggle}
          className="sr-toggle__checkbox"
        />
        <span>Enable Structural Refine (debug)</span>
        <span className="sr-toggle__badge">beta</span>
      </label>

      {enabled ? (
        <div className="sr-toggle__prior">
          <p className="sr-toggle__hint">
            Same engine + runner the polished wizard uses. Observation is explicit here so
            you can step through individual documents and inspect runner state. Uploaded
            priors mirror the polished pipeline: analytics is folded into finalize output;
            a refined model can stand in for the config model during prediction and overlay
            projection.
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
            >
              {priorAnalytics
                ? `Prior analytics loaded (${priorAnalytics.documentCount} doc${priorAnalytics.documentCount !== 1 ? 's' : ''})`
                : 'Upload prior analytics…'}
            </button>
            {priorAnalytics ? (
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
            >
              {priorRefineModel ? 'Refined model loaded' : 'Upload prior refined model…'}
            </button>
            {priorRefineModel ? (
              <button type="button" className="sr-toggle__clear-btn" onClick={handleClearModel}>
                Clear
              </button>
            ) : null}
          </div>
          {modelError ? <p className="sr-toggle__error">{modelError}</p> : null}

          {effectiveRefined ? (
            <label className="sr-toggle__label" style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                className="sr-toggle__checkbox"
                checked={useRefinedAsConfig}
                onChange={(event) => onUseRefinedAsConfigChange(event.target.checked)}
              />
              <span>Use refined model in place of config (prediction + overlay projection)</span>
            </label>
          ) : null}

          <div className="sr-toggle__upload">
            {runnerActive ? (
              <button type="button" className="sr-toggle__clear-btn" onClick={handleStop}>
                Stop refine batch
              </button>
            ) : (
              <button
                type="button"
                className="sr-toggle__upload-btn"
                onClick={handleStart}
                disabled={!inputsReady}
              >
                Start refine batch
              </button>
            )}
            <button
              type="button"
              className="sr-toggle__upload-btn"
              onClick={handleObserve}
              disabled={!runnerActive || !latestObservation}
            >
              Observe latest prediction
            </button>
            <button
              type="button"
              className="sr-toggle__upload-btn"
              onClick={() => {
                void handleFinalize();
              }}
              disabled={!runnerActive || observedCount === 0 || isFinalizing}
            >
              {isFinalizing ? 'Finalizing…' : 'Finalize batch'}
            </button>
          </div>

          <p className="sr-toggle__hint">
            {runnerActive
              ? `Runner active · observed ${observedCount} doc${observedCount !== 1 ? 's' : ''} this batch${
                  runnerInputs
                    ? ` · keyed on wizard "${runnerInputs.wizardId}", geometry ${runnerInputs.geometryId}`
                    : ''
                }`
              : inputsReady
                ? 'Runner idle. Press "Start refine batch" to begin observing.'
                : 'Load WizardFile, GeometryFile, and Config StructuralModel to enable refine.'}
          </p>

          {observeError ? <p className="sr-toggle__error">{observeError}</p> : null}
          {finalizeError ? <p className="sr-toggle__error">{finalizeError}</p> : null}

          {isFinalizing ? <StructuralRefineBuildingState /> : null}

          {lastOutputs ? (
            <div className="sr-toggle__upload" style={{ flexWrap: 'wrap' }}>
              <span className="sr-toggle__hint" style={{ width: '100%' }}>
                Last finalize output — analytics id <code>{lastOutputs.analytics.id}</code>,
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
              <Button type="button" onClick={handlePromoteToPrior}>
                Use as prior for next batch
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
