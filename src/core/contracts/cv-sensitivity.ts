/**
 * Sensitivity profile contract — pre-contour-detection knobs that control how
 * the OpenCV adapter behaves on low-contrast UI surfaces.
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
 *
 * `acceptRoundedRectanglesAsConfirmed` (optional, hi-res only): when true,
 * contour rects whose polygon approximation is convex with a high bbox-fill
 * ratio but more than 4 vertices (i.e. rounded-corner UI buttons / cards)
 * are treated as shape-evidence confirmed. This bumps their base confidence
 * to the same level as exact 4-vertex rectangles, so small rounded UI
 * elements clear the simple-overlay confidence floor instead of being
 * filtered as low-confidence noise. Off by default so structured-form
 * behavior is unchanged.
 */
export interface CvSensitivityProfile {
  adaptiveThresholdC: number;
  cannyAutoSigma: number;
  darkPageNormalizedThresholdFloor: number;
  acceptRoundedRectanglesAsConfirmed?: boolean;
}

export const isCvSensitivityProfile = (value: unknown): value is CvSensitivityProfile => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (
    v.acceptRoundedRectanglesAsConfirmed !== undefined &&
    typeof v.acceptRoundedRectanglesAsConfirmed !== 'boolean'
  ) {
    return false;
  }
  return (
    typeof v.adaptiveThresholdC === 'number' &&
    Number.isFinite(v.adaptiveThresholdC) &&
    typeof v.cannyAutoSigma === 'number' &&
    Number.isFinite(v.cannyAutoSigma) &&
    typeof v.darkPageNormalizedThresholdFloor === 'number' &&
    Number.isFinite(v.darkPageNormalizedThresholdFloor)
  );
};
