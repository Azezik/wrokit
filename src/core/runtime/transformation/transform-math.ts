/**
 * Pure transform math used by the Transformation Model. No I/O, no mutation,
 * no awareness of the matcher or the runner. Affine transforms here are the
 * v1 simple form (scaleX, scaleY, translateX, translateY) applied to
 * normalized rects as: x' = x * scaleX + translateX (similarly for y), and
 * w' = w * scaleX, h' = h * scaleY.
 */

import type { StructuralNormalizedRect } from '../../contracts/structural-model';
import type { TransformationAffine } from '../../contracts/transformation-model';

export const IDENTITY_AFFINE: TransformationAffine = {
  scaleX: 1,
  scaleY: 1,
  translateX: 0,
  translateY: 0
};

/**
 * Derive the affine that maps the config rect onto the runtime rect.
 * Falls back to scale=1 when the source dimension is degenerate.
 */
export const affineFromRects = (
  config: StructuralNormalizedRect,
  runtime: StructuralNormalizedRect
): TransformationAffine => {
  const scaleX = config.wNorm > 1e-9 ? runtime.wNorm / config.wNorm : 1;
  const scaleY = config.hNorm > 1e-9 ? runtime.hNorm / config.hNorm : 1;
  return {
    scaleX,
    scaleY,
    translateX: runtime.xNorm - config.xNorm * scaleX,
    translateY: runtime.yNorm - config.yNorm * scaleY
  };
};

export const applyAffineToRect = (
  rect: StructuralNormalizedRect,
  affine: TransformationAffine
): StructuralNormalizedRect => ({
  xNorm: rect.xNorm * affine.scaleX + affine.translateX,
  yNorm: rect.yNorm * affine.scaleY + affine.translateY,
  wNorm: rect.wNorm * affine.scaleX,
  hNorm: rect.hNorm * affine.scaleY
});

export const rectArea = (rect: StructuralNormalizedRect): number =>
  Math.max(0, rect.wNorm) * Math.max(0, rect.hNorm);

export const iouOfRects = (
  a: StructuralNormalizedRect,
  b: StructuralNormalizedRect
): number => {
  const ax2 = a.xNorm + a.wNorm;
  const ay2 = a.yNorm + a.hNorm;
  const bx2 = b.xNorm + b.wNorm;
  const by2 = b.yNorm + b.hNorm;
  const ix1 = Math.max(a.xNorm, b.xNorm);
  const iy1 = Math.max(a.yNorm, b.yNorm);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = rectArea(a) + rectArea(b) - inter;
  return union > 1e-9 ? inter / union : 0;
};

export const subtractAffine = (
  a: TransformationAffine,
  b: TransformationAffine
): TransformationAffine => ({
  scaleX: a.scaleX - b.scaleX,
  scaleY: a.scaleY - b.scaleY,
  translateX: a.translateX - b.translateX,
  translateY: a.translateY - b.translateY
});

/**
 * Loose distance metric between two affines used to flag outliers and to
 * report deviation from consensus.
 */
export const affineDistance = (
  a: TransformationAffine,
  b: TransformationAffine
): { scaleDelta: number; translateDelta: number } => ({
  scaleDelta: Math.max(Math.abs(a.scaleX - b.scaleX), Math.abs(a.scaleY - b.scaleY)),
  translateDelta: Math.max(
    Math.abs(a.translateX - b.translateX),
    Math.abs(a.translateY - b.translateY)
  )
});
