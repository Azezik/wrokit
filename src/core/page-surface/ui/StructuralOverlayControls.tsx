import { useMemo } from 'react';

import {
  optionsMatchPreset,
  overlayPresetForMode,
  type StructuralOverlayMode,
  type StructuralOverlayOptions
} from './structural-overlay-options';

import './structural-overlay-controls.css';

export interface StructuralOverlayControlsProps {
  visible: boolean;
  onVisibleChange: (next: boolean) => void;
  options: StructuralOverlayOptions;
  onOptionsChange: (next: StructuralOverlayOptions) => void;
  /**
   * When false the "Show Transformation Matches" toggle is hidden — Config
   * Mode never has a TransformationModel to show. Defaults to true.
   */
  transformationAvailable?: boolean;
  /**
   * Optional caller-supplied right-aligned status text (e.g. CV adapter info,
   * structural readiness messages). Rendered next to the controls so each
   * feature keeps its own status line in one place.
   */
  statusText?: string;
}

const updateOption = <K extends keyof StructuralOverlayOptions>(
  current: StructuralOverlayOptions,
  key: K,
  value: StructuralOverlayOptions[K]
): StructuralOverlayOptions => ({
  ...current,
  [key]: value,
  // Touching any sub-toggle implicitly leaves preset territory; the active-mode
  // pill becomes "Custom" while the underlying mode value is preserved so the
  // user can re-apply the same preset.
  mode: current.mode
});

export function StructuralOverlayControls({
  visible,
  onVisibleChange,
  options,
  onOptionsChange,
  transformationAvailable = true,
  statusText
}: StructuralOverlayControlsProps) {
  const matchesActiveMode = useMemo(
    () => optionsMatchPreset(options, options.mode),
    [options]
  );

  const applyPreset = (mode: StructuralOverlayMode) => {
    onOptionsChange(overlayPresetForMode(mode));
  };

  const setOption = <K extends keyof StructuralOverlayOptions>(
    key: K,
    value: StructuralOverlayOptions[K]
  ) => {
    onOptionsChange(updateOption(options, key, value));
  };

  return (
    <div className="structural-overlay-controls" role="group" aria-label="Structural overlay controls">
      <div className="structural-overlay-controls__row">
        <label className="structural-overlay-controls__toggle">
          <input
            type="checkbox"
            checked={visible}
            onChange={(event) => onVisibleChange(event.target.checked)}
          />
          Show Overlay
        </label>

        <div
          className="structural-overlay-controls__mode"
          role="radiogroup"
          aria-label="Overlay preset"
        >
          <span className="structural-overlay-controls__mode-label">View:</span>
          <button
            type="button"
            role="radio"
            aria-checked={options.mode === 'simple' && matchesActiveMode}
            data-active={options.mode === 'simple' && matchesActiveMode ? 'true' : 'false'}
            className="structural-overlay-controls__mode-button"
            onClick={() => applyPreset('simple')}
            disabled={!visible}
          >
            Simple
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={options.mode === 'advanced' && matchesActiveMode}
            data-active={options.mode === 'advanced' && matchesActiveMode ? 'true' : 'false'}
            className="structural-overlay-controls__mode-button"
            onClick={() => applyPreset('advanced')}
            disabled={!visible}
          >
            Advanced
          </button>
          {!matchesActiveMode ? (
            <span className="structural-overlay-controls__custom-pill" aria-live="polite">
              Custom
            </span>
          ) : null}
        </div>

        {statusText ? (
          <span className="structural-overlay-controls__status">{statusText}</span>
        ) : null}
      </div>

      <fieldset className="structural-overlay-controls__row" disabled={!visible}>
        <label className="structural-overlay-controls__toggle">
          <input
            type="checkbox"
            checked={options.showStructuralObjects}
            onChange={(event) => setOption('showStructuralObjects', event.target.checked)}
          />
          Objects
        </label>
        <label className="structural-overlay-controls__toggle">
          <input
            type="checkbox"
            checked={options.showAllObjects}
            onChange={(event) => setOption('showAllObjects', event.target.checked)}
          />
          Show All (no confidence filter)
        </label>
        <label className="structural-overlay-controls__toggle">
          <input
            type="checkbox"
            checked={options.showLabels}
            onChange={(event) => setOption('showLabels', event.target.checked)}
          />
          Labels
        </label>
        <label className="structural-overlay-controls__toggle">
          <input
            type="checkbox"
            checked={options.showContainmentChains}
            onChange={(event) => setOption('showContainmentChains', event.target.checked)}
          />
          Chains
        </label>
        <label className="structural-overlay-controls__toggle">
          <input
            type="checkbox"
            checked={options.showFieldAnchors}
            onChange={(event) => setOption('showFieldAnchors', event.target.checked)}
          />
          Field Anchors
        </label>
        {transformationAvailable ? (
          <label className="structural-overlay-controls__toggle">
            <input
              type="checkbox"
              checked={options.showTransformationMatches}
              onChange={(event) => setOption('showTransformationMatches', event.target.checked)}
            />
            Transformation Matches
          </label>
        ) : null}
      </fieldset>

      {transformationAvailable ? (
        <fieldset
          className="structural-overlay-controls__row structural-overlay-controls__row--debug"
          disabled={!visible}
          aria-label="Config projection debug toggles"
        >
          <span className="structural-overlay-controls__row-label">Config projection:</span>
          <label className="structural-overlay-controls__toggle structural-overlay-controls__toggle--config-raw">
            <input
              type="checkbox"
              checked={options.showConfigProjectionRaw}
              onChange={(event) => setOption('showConfigProjectionRaw', event.target.checked)}
            />
            Raw (before correction)
          </label>
          <label className="structural-overlay-controls__toggle structural-overlay-controls__toggle--config-transformed">
            <input
              type="checkbox"
              checked={options.showConfigProjectionTransformed}
              onChange={(event) => setOption('showConfigProjectionTransformed', event.target.checked)}
            />
            Transformed (after correction)
          </label>
        </fieldset>
      ) : null}

      <fieldset className="structural-overlay-controls__row" disabled={!visible}>
        <label className="structural-overlay-controls__slider">
          Min object confidence
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={options.minObjectConfidence}
            onChange={(event) =>
              setOption('minObjectConfidence', Number(event.target.value))
            }
            aria-valuetext={options.minObjectConfidence.toFixed(2)}
          />
          <span className="structural-overlay-controls__slider-value">
            {options.minObjectConfidence.toFixed(2)}
          </span>
        </label>
      </fieldset>

      <div className="structural-overlay-controls__legend" aria-label="Overlay legend">
        <span className="structural-overlay-controls__legend-item" data-swatch="border">Border</span>
        <span className="structural-overlay-controls__legend-item" data-swatch="refined">Refined Border</span>
        <span className="structural-overlay-controls__legend-item" data-swatch="object-top">Object (top)</span>
        <span className="structural-overlay-controls__legend-item" data-swatch="object-child">Child Object</span>
        <span className="structural-overlay-controls__legend-item" data-swatch="saved">Saved BBOX</span>
        <span className="structural-overlay-controls__legend-item" data-swatch="predicted">Predicted BBOX</span>
        <span className="structural-overlay-controls__legend-item" data-swatch="anchor">Anchor</span>
        {transformationAvailable ? (
          <span className="structural-overlay-controls__legend-item" data-swatch="match">Match</span>
        ) : null}
        {transformationAvailable ? (
          <span className="structural-overlay-controls__legend-item" data-swatch="config-raw">
            Config Raw
          </span>
        ) : null}
        {transformationAvailable ? (
          <span className="structural-overlay-controls__legend-item" data-swatch="config-transformed">
            Config Transformed
          </span>
        ) : null}
      </div>
    </div>
  );
}
