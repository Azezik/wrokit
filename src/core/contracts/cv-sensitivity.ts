/**
 * Sensitivity profile contract — three pre-contour-detection knobs that
 * control how the OpenCV adapter behaves on low-contrast UI surfaces.
 *
 * Lives in the contracts layer (rather than next to the OpenCV adapter)
 * because the StructuralModel persists the values that produced it: a
 * config saved with hi-res sensitivity must replay with the same values
 * at runtime even if the engine's profile defaults change later.
 *
 * Lowering `adaptiveThresholdC` makes the adaptive threshold pick up
 * fainter borders. Raising `cannyAutoSigma` widens the Canny hysteresis
 * band so weaker gradients survive. Lowering
 * `darkPageNormalizedThresholdFloor` releases the dark-page background-
 * threshold clamp so very-low-contrast foreground (e.g. a card a few
 * luminance units brighter than the page background) is not forced into
 * background by the safety floor.
 */
export interface CvSensitivityProfile {
  adaptiveThresholdC: number;
  cannyAutoSigma: number;
  darkPageNormalizedThresholdFloor: number;
}

export const isCvSensitivityProfile = (value: unknown): value is CvSensitivityProfile => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.adaptiveThresholdC === 'number' &&
    Number.isFinite(v.adaptiveThresholdC) &&
    typeof v.cannyAutoSigma === 'number' &&
    Number.isFinite(v.cannyAutoSigma) &&
    typeof v.darkPageNormalizedThresholdFloor === 'number' &&
    Number.isFinite(v.darkPageNormalizedThresholdFloor)
  );
};
