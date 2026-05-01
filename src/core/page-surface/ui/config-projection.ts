/**
 * Pure helper for the Run Mode debug overlay: project the Config StructuralModel
 * onto the runtime page surface, optionally applying the TransformationModel.
 *
 * The "transformed" path mirrors the per-object transform ladder used by the
 * localization runner's field-candidate logic
 * (`src/core/runtime/transformation/field-candidates.ts`):
 *
 *   1. matched-object        — per-object affine when the object itself matched
 *   2. parent-object         — first matched ancestor's affine (parent-chain)
 *   3. page consensus        — page-level consensus affine
 *   4. refined-border level  — refined-border level summary affine
 *   5. border level          — border level summary affine
 *   6. identity              — last-resort no-op
 *
 * Border / refinedBorder use their own dedicated level summaries directly. The
 * helper never mutates the inputs; it returns plain projected rects suitable
 * for `normalizedRectToScreen`.
 */

import type {
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralPage
} from '../../contracts/structural-model';
import type {
  TransformationAffine,
  TransformationLevelSummary,
  TransformationPage
} from '../../contracts/transformation-model';
import {
  applyAffineToRect,
  IDENTITY_AFFINE
} from '../../runtime/transformation/transform-math';

export type ConfigProjectionTransformSource =
  | 'identity'
  | 'matched-object'
  | 'parent-object'
  | 'consensus'
  | 'refined-border'
  | 'border';

export interface ProjectedConfigObject {
  objectId: string;
  parentObjectId: string | null;
  childObjectIds: string[];
  depth: number;
  /** Confidence carried by the underlying config object (not the transform). */
  confidence: number;
  /** Projected normalized rect on the runtime page surface. */
  rectNorm: StructuralNormalizedRect;
  /** Which rung of the transform ladder produced this projection. */
  transformSource: ConfigProjectionTransformSource;
  /** Confidence attributed to the chosen transform (0 when identity / unknown). */
  transformConfidence: number;
  /**
   * True iff the underlying config object had a direct runtime match
   * (transformSource === 'matched-object'). Falls back via the parent /
   * consensus / border ladder render as `false` so the overlay can style
   * "phantom" projections distinctly from real matches.
   */
  matched: boolean;
}

export interface ProjectedConfigPage {
  border: StructuralNormalizedRect;
  borderTransformSource: ConfigProjectionTransformSource;
  refinedBorder: StructuralNormalizedRect;
  refinedBorderTransformSource: ConfigProjectionTransformSource;
  objects: ProjectedConfigObject[];
}

const findLevelSummary = (
  transformationPage: TransformationPage | null,
  level: TransformationLevelSummary['level']
): TransformationLevelSummary | undefined =>
  transformationPage?.levelSummaries.find((s) => s.level === level);

const indexConfigObjects = (
  configPage: StructuralPage
): Map<string, StructuralObjectNode> =>
  new Map(configPage.objectHierarchy.objects.map((o) => [o.objectId, o]));

const indexMatchTransforms = (
  transformationPage: TransformationPage | null
): Map<string, { transform: TransformationAffine; confidence: number }> => {
  const map = new Map<string, { transform: TransformationAffine; confidence: number }>();
  if (!transformationPage) {
    return map;
  }
  for (const m of transformationPage.objectMatches) {
    map.set(m.configObjectId, { transform: m.transform, confidence: m.confidence });
  }
  return map;
};

interface LadderResult {
  transform: TransformationAffine;
  source: ConfigProjectionTransformSource;
  confidence: number;
}

const resolveObjectTransform = (
  object: StructuralObjectNode,
  matchTransforms: ReadonlyMap<string, { transform: TransformationAffine; confidence: number }>,
  configObjectsById: ReadonlyMap<string, StructuralObjectNode>,
  consensus: TransformationAffine | null,
  consensusConfidence: number,
  refinedBorderSummary: TransformationLevelSummary | undefined,
  borderSummary: TransformationLevelSummary | undefined
): LadderResult => {
  const direct = matchTransforms.get(object.objectId);
  if (direct) {
    return {
      transform: direct.transform,
      source: 'matched-object',
      confidence: direct.confidence
    };
  }

  let cursor = object.parentObjectId;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const ancestorMatch = matchTransforms.get(cursor);
    if (ancestorMatch) {
      return {
        transform: ancestorMatch.transform,
        source: 'parent-object',
        confidence: ancestorMatch.confidence
      };
    }
    cursor = configObjectsById.get(cursor)?.parentObjectId ?? null;
  }

  if (consensus) {
    return { transform: consensus, source: 'consensus', confidence: consensusConfidence };
  }

  if (refinedBorderSummary?.transform) {
    return {
      transform: refinedBorderSummary.transform,
      source: 'refined-border',
      confidence: refinedBorderSummary.confidence
    };
  }

  if (borderSummary?.transform) {
    return {
      transform: borderSummary.transform,
      source: 'border',
      confidence: borderSummary.confidence
    };
  }

  return { transform: IDENTITY_AFFINE, source: 'identity', confidence: 0 };
};

/**
 * Build a raw projection of the config page (no transforms applied). Each rect
 * is the config rect drawn directly on the runtime page surface, so callers
 * can visualize "what the config expected" before any alignment correction.
 */
export const projectConfigPageRaw = (configPage: StructuralPage): ProjectedConfigPage => ({
  border: configPage.border.rectNorm,
  borderTransformSource: 'identity',
  refinedBorder: configPage.refinedBorder.rectNorm,
  refinedBorderTransformSource: 'identity',
  objects: configPage.objectHierarchy.objects.map((object) => ({
    objectId: object.objectId,
    parentObjectId: object.parentObjectId,
    childObjectIds: object.childObjectIds,
    depth: object.depth,
    confidence: object.confidence,
    rectNorm: object.objectRectNorm,
    transformSource: 'identity',
    transformConfidence: 0,
    matched: false
  }))
});

/**
 * Build a transformed projection by walking the per-object fallback ladder
 * (matched-object → matched ancestor → page consensus → refined-border level
 * → border level → identity). When `transformationPage` is null the result
 * collapses to the raw projection.
 */
export const projectConfigPageTransformed = (
  configPage: StructuralPage,
  transformationPage: TransformationPage | null
): ProjectedConfigPage => {
  if (!transformationPage) {
    return projectConfigPageRaw(configPage);
  }

  const configObjectsById = indexConfigObjects(configPage);
  const matchTransforms = indexMatchTransforms(transformationPage);
  const borderSummary = findLevelSummary(transformationPage, 'border');
  const refinedBorderSummary = findLevelSummary(transformationPage, 'refined-border');
  const consensus = transformationPage.consensus.transform;
  const consensusConfidence = transformationPage.consensus.confidence;

  const borderTransform = borderSummary?.transform ?? null;
  const refinedBorderTransform = refinedBorderSummary?.transform ?? null;

  return {
    border: borderTransform
      ? applyAffineToRect(configPage.border.rectNorm, borderTransform)
      : configPage.border.rectNorm,
    borderTransformSource: borderTransform ? 'border' : 'identity',
    refinedBorder: refinedBorderTransform
      ? applyAffineToRect(configPage.refinedBorder.rectNorm, refinedBorderTransform)
      : configPage.refinedBorder.rectNorm,
    refinedBorderTransformSource: refinedBorderTransform ? 'refined-border' : 'identity',
    objects: configPage.objectHierarchy.objects.map((object) => {
      const ladder = resolveObjectTransform(
        object,
        matchTransforms,
        configObjectsById,
        consensus,
        consensusConfidence,
        refinedBorderSummary,
        borderSummary
      );
      return {
        objectId: object.objectId,
        parentObjectId: object.parentObjectId,
        childObjectIds: object.childObjectIds,
        depth: object.depth,
        confidence: object.confidence,
        rectNorm: applyAffineToRect(object.objectRectNorm, ladder.transform),
        transformSource: ladder.source,
        transformConfidence: ladder.confidence,
        matched: ladder.source === 'matched-object'
      };
    })
  };
};
