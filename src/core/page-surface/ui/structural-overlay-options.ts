/**
 * Shared overlay option contract used by both Config Capture and Run Mode.
 *
 * Both features render through `StructuralDebugOverlay` and configure it via
 * `StructuralOverlayOptions`. Keeping the option type, the presets, and the
 * pure filter/derivation helpers in this module guarantees the two features
 * stay behaviorally aligned. UI controls live in
 * `StructuralOverlayControls.tsx` and consume only this contract.
 *
 * The overlay treats every structural detection as just an "object" with a
 * depth in the hierarchy. Nesting, opacity, and stroke weight convey
 * parent/child relationships — there is no semantic-class styling.
 */

import type { StructuralObjectNode } from '../../contracts/structural-model';

export type StructuralOverlayMode = 'simple' | 'advanced';

export interface StructuralOverlayOptions {
  mode: StructuralOverlayMode;
  showStructuralObjects: boolean;
  showLabels: boolean;
  showContainmentChains: boolean;
  showAllObjects: boolean;
  showFieldAnchors: boolean;
  showTransformationMatches: boolean;
  /**
   * Debug: project the Config StructuralModel onto the runtime page using the
   * config rects directly (no transformation applied). Rendered in red — this
   * is the "before correction" view, showing where the config thinks each
   * structural element sits before the runtime alignment math runs.
   */
  showConfigProjectionRaw: boolean;
  /**
   * Debug: project the Config StructuralModel onto the runtime page after the
   * TransformationModel is applied per-object (matched-object → matched
   * ancestor → page consensus → refined-border level → border level). Rendered
   * in green — this is the "after correction" view that mirrors the same
   * transform ladder the localization runner uses.
   */
  showConfigProjectionTransformed: boolean;
  /**
   * Minimum object confidence to render. Top-level (depth 0) parent objects
   * always pass so the page skeleton stays readable; deeper objects respect
   * this threshold unless `showAllObjects` is on.
   */
  minObjectConfidence: number;
}

export const SIMPLE_OVERLAY_OPTIONS: StructuralOverlayOptions = {
  mode: 'simple',
  showStructuralObjects: true,
  showLabels: false,
  showContainmentChains: false,
  showAllObjects: false,
  showFieldAnchors: false,
  showTransformationMatches: false,
  showConfigProjectionRaw: false,
  showConfigProjectionTransformed: false,
  minObjectConfidence: 0.75
};

export const ADVANCED_OVERLAY_OPTIONS: StructuralOverlayOptions = {
  mode: 'advanced',
  showStructuralObjects: true,
  showLabels: true,
  showContainmentChains: true,
  showAllObjects: true,
  showFieldAnchors: true,
  showTransformationMatches: true,
  showConfigProjectionRaw: false,
  showConfigProjectionTransformed: false,
  minObjectConfidence: 0
};

/**
 * Backwards-compatible alias for callers that still import the original
 * default. The Simple preset is the friendlier first-paint experience.
 */
export const DEFAULT_STRUCTURAL_OVERLAY_OPTIONS = SIMPLE_OVERLAY_OPTIONS;

export const overlayPresetForMode = (mode: StructuralOverlayMode): StructuralOverlayOptions =>
  mode === 'simple' ? SIMPLE_OVERLAY_OPTIONS : ADVANCED_OVERLAY_OPTIONS;

export const objectPassesOverlayFilter = (
  object: StructuralObjectNode,
  options: StructuralOverlayOptions
): boolean => {
  if (options.showAllObjects) {
    return true;
  }
  // Top-level (depth 0) objects are the page skeleton; keep them visible
  // even at low confidence so the hierarchy is intelligible.
  if (object.depth === 0) {
    return true;
  }
  return object.confidence >= options.minObjectConfidence;
};

export const filterStructuralObjects = (
  objects: ReadonlyArray<StructuralObjectNode>,
  options: StructuralOverlayOptions
): StructuralObjectNode[] => objects.filter((o) => objectPassesOverlayFilter(o, options));

/**
 * Returns true when the given options exactly match the named preset. Useful
 * for surfacing a "Custom" badge in the controls UI when the user has tweaked
 * sub-toggles away from a preset.
 */
export const optionsMatchPreset = (
  options: StructuralOverlayOptions,
  mode: StructuralOverlayMode
): boolean => {
  const preset = overlayPresetForMode(mode);
  return (
    options.showStructuralObjects === preset.showStructuralObjects &&
    options.showLabels === preset.showLabels &&
    options.showContainmentChains === preset.showContainmentChains &&
    options.showAllObjects === preset.showAllObjects &&
    options.showFieldAnchors === preset.showFieldAnchors &&
    options.showTransformationMatches === preset.showTransformationMatches &&
    options.showConfigProjectionRaw === preset.showConfigProjectionRaw &&
    options.showConfigProjectionTransformed === preset.showConfigProjectionTransformed &&
    options.minObjectConfidence === preset.minObjectConfidence
  );
};
