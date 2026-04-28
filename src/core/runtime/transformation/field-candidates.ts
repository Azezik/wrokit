/**
 * Field-anchor candidate generation.
 *
 * For each StructuralFieldRelationship on a config page, walk the explicit
 * fallback chain — matched object → parent object → refined border → border —
 * and emit one TransformationFieldCandidate per usable rung. Each candidate
 * carries the transform that would apply, the relativeFieldRect appropriate
 * for that source (so downstream localization does not need to recompute
 * anchors), and a confidence derived from the underlying signal.
 *
 * This module never mutates StructuralModels and never invents anchors that
 * the StructuralModel did not already record.
 */

import type {
  StructuralFieldRelationship,
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralPage,
  StructuralRelativeAnchorRect
} from '../../contracts/structural-model';
import type {
  TransformationFieldAlignment,
  TransformationFieldCandidate,
  TransformationLevelSummary,
  TransformationObjectMatch
} from '../../contracts/transformation-model';
import { IDENTITY_AFFINE } from './transform-math';

const REL_RECT_EPS = 1e-9;

/**
 * Re-express a `relativeFieldRect` (originally relative to `primaryAnchorRect`)
 * as relative to a different `targetRect`. Used to derive an honest
 * `relativeFieldRect` for parent-object candidates: the StructuralModel only
 * records the field rect against its primary anchor, so we project that anchor-
 * local rect into page-absolute coordinates and re-express it against the
 * ancestor whose transform the candidate is actually carrying.
 */
const reExpressRelativeFieldRect = (
  primaryRelative: StructuralRelativeAnchorRect,
  primaryAnchorRect: StructuralNormalizedRect,
  targetRect: StructuralNormalizedRect
): StructuralRelativeAnchorRect => {
  const absX = primaryAnchorRect.xNorm + primaryRelative.xRatio * primaryAnchorRect.wNorm;
  const absY = primaryAnchorRect.yNorm + primaryRelative.yRatio * primaryAnchorRect.hNorm;
  const absW = primaryRelative.wRatio * primaryAnchorRect.wNorm;
  const absH = primaryRelative.hRatio * primaryAnchorRect.hNorm;

  const safeW = Math.max(targetRect.wNorm, REL_RECT_EPS);
  const safeH = Math.max(targetRect.hNorm, REL_RECT_EPS);

  return {
    xRatio: (absX - targetRect.xNorm) / safeW,
    yRatio: (absY - targetRect.yNorm) / safeH,
    wRatio: absW / safeW,
    hRatio: absH / safeH
  };
};

const RANK_CONFIDENCE_FACTOR: Record<'primary' | 'secondary' | 'tertiary', number> = {
  primary: 1,
  secondary: 0.85,
  tertiary: 0.7
};

const PARENT_INDIRECTION_PENALTY = 0.85;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const findLevelSummary = (
  summaries: ReadonlyArray<TransformationLevelSummary>,
  level: TransformationLevelSummary['level']
): TransformationLevelSummary | undefined => summaries.find((s) => s.level === level);

const indexObjects = (page: StructuralPage): Map<string, StructuralObjectNode> =>
  new Map(page.objectHierarchy.objects.map((o) => [o.objectId, o]));

const indexMatchesByConfigId = (
  matches: ReadonlyArray<TransformationObjectMatch>
): Map<string, TransformationObjectMatch> =>
  new Map(matches.map((m) => [m.configObjectId, m]));

const walkAncestors = (
  startObjectId: string,
  configObjects: ReadonlyMap<string, StructuralObjectNode>
): StructuralObjectNode[] => {
  const chain: StructuralObjectNode[] = [];
  let current = configObjects.get(startObjectId);
  while (current && current.parentObjectId) {
    const parent = configObjects.get(current.parentObjectId);
    if (!parent) {
      break;
    }
    chain.push(parent);
    current = parent;
  }
  return chain;
};

interface BuildCandidateInputs {
  field: StructuralFieldRelationship;
  matchesByConfigId: ReadonlyMap<string, TransformationObjectMatch>;
  configObjects: ReadonlyMap<string, StructuralObjectNode>;
  refinedBorderSummary: TransformationLevelSummary | undefined;
  borderSummary: TransformationLevelSummary | undefined;
}

const buildFieldCandidates = (input: BuildCandidateInputs): {
  candidates: TransformationFieldCandidate[];
  warnings: string[];
} => {
  const candidates: TransformationFieldCandidate[] = [];
  const warnings: string[] = [];
  let order = 0;

  // 1. Matched-object candidates, in objectAnchor rank order.
  for (const anchor of input.field.fieldAnchors.objectAnchors) {
    const match = input.matchesByConfigId.get(anchor.objectId);
    if (!match) {
      continue;
    }
    const factor = RANK_CONFIDENCE_FACTOR[anchor.rank];
    candidates.push({
      source: 'matched-object',
      fallbackOrder: order++,
      configObjectId: anchor.objectId,
      runtimeObjectId: match.runtimeObjectId,
      transform: match.transform,
      relativeFieldRect: anchor.relativeFieldRect,
      confidence: clamp01(match.confidence * factor),
      notes: [
        `${anchor.rank} object anchor matched runtime object ${match.runtimeObjectId}`,
        `match confidence ${match.confidence.toFixed(3)} x rank factor ${factor.toFixed(2)}`
      ]
    });
  }

  // 2. Parent-object fallback. Walk ancestors of the primary anchor and emit
  //    the first matched ancestor as a candidate.
  const primaryAnchor = input.field.fieldAnchors.objectAnchors.find((a) => a.rank === 'primary');
  if (primaryAnchor) {
    const primaryConfigObject = input.configObjects.get(primaryAnchor.objectId);
    const ancestors = walkAncestors(primaryAnchor.objectId, input.configObjects);
    for (const ancestor of ancestors) {
      const match = input.matchesByConfigId.get(ancestor.objectId);
      if (!match) {
        continue;
      }
      // The StructuralModel only records the field's rect relative to its
      // primary anchor. For a parent-object candidate the source rect pair is
      // the ancestor — not the primary anchor — so we re-express the primary-
      // relative rect against the ancestor's rect. This keeps
      // `relativeFieldRect` honest with respect to the candidate's source and
      // avoids misleading downstream consumers (which previously saw a
      // primary-anchor-relative rect on a candidate whose transform is
      // ancestor-relative).
      const ancestorRelativeFieldRect = primaryConfigObject
        ? reExpressRelativeFieldRect(
            primaryAnchor.relativeFieldRect,
            primaryConfigObject.objectRectNorm,
            ancestor.objectRectNorm
          )
        : primaryAnchor.relativeFieldRect;
      candidates.push({
        source: 'parent-object',
        fallbackOrder: order++,
        configObjectId: ancestor.objectId,
        runtimeObjectId: match.runtimeObjectId,
        transform: match.transform,
        relativeFieldRect: ancestorRelativeFieldRect,
        confidence: clamp01(match.confidence * PARENT_INDIRECTION_PENALTY),
        notes: [
          `primary anchor ${primaryAnchor.objectId} did not match — falling back to ancestor ${ancestor.objectId}`,
          `ancestor match confidence ${match.confidence.toFixed(3)} x parent penalty ${PARENT_INDIRECTION_PENALTY.toFixed(
            2
          )}`
        ]
      });
      break;
    }
  }

  // 3. Refined-border fallback (always available — refined border is paired 1:1).
  if (input.refinedBorderSummary && input.refinedBorderSummary.transform) {
    candidates.push({
      source: 'refined-border',
      fallbackOrder: order++,
      configObjectId: null,
      runtimeObjectId: null,
      transform: input.refinedBorderSummary.transform,
      relativeFieldRect: input.field.fieldAnchors.refinedBorderAnchor.relativeFieldRect,
      confidence: input.refinedBorderSummary.confidence,
      notes: [
        `refined-border level confidence ${input.refinedBorderSummary.confidence.toFixed(3)}`,
        ...input.refinedBorderSummary.warnings.map((w) => `refined-border warning: ${w}`)
      ]
    });
  } else {
    warnings.push('refined-border fallback unavailable for this page');
  }

  // 4. Border fallback (always available — border is the full normalized page).
  if (input.borderSummary && input.borderSummary.transform) {
    candidates.push({
      source: 'border',
      fallbackOrder: order++,
      configObjectId: null,
      runtimeObjectId: null,
      transform: input.borderSummary.transform,
      relativeFieldRect: input.field.fieldAnchors.borderAnchor.relativeFieldRect,
      confidence: input.borderSummary.confidence,
      notes: [`border level confidence ${input.borderSummary.confidence.toFixed(3)}`]
    });
  } else {
    // Border is a trivial pair; the absence of a summary is itself a problem
    // worth surfacing, but we still emit an identity-transform fallback so the
    // candidate list is never empty.
    candidates.push({
      source: 'border',
      fallbackOrder: order++,
      configObjectId: null,
      runtimeObjectId: null,
      transform: IDENTITY_AFFINE,
      relativeFieldRect: input.field.fieldAnchors.borderAnchor.relativeFieldRect,
      confidence: 0.4,
      notes: ['border level summary missing — using identity transform as last-resort fallback']
    });
    warnings.push('border level summary missing — emitted identity fallback');
  }

  if (candidates.length === 0) {
    warnings.push('no field candidates could be built (no anchors and no level summaries)');
  } else if (!candidates.some((c) => c.source === 'matched-object' || c.source === 'parent-object')) {
    warnings.push(
      'no object-level candidate available — relying on refined-border/border fallbacks only'
    );
  }

  return { candidates, warnings };
};

export const computeFieldAlignments = (
  configPage: StructuralPage,
  matches: ReadonlyArray<TransformationObjectMatch>,
  levelSummaries: ReadonlyArray<TransformationLevelSummary>
): TransformationFieldAlignment[] => {
  const matchesByConfigId = indexMatchesByConfigId(matches);
  const configObjects = indexObjects(configPage);
  const refinedBorderSummary = findLevelSummary(levelSummaries, 'refined-border');
  const borderSummary = findLevelSummary(levelSummaries, 'border');

  return configPage.fieldRelationships.map((field) => {
    const { candidates, warnings } = buildFieldCandidates({
      field,
      matchesByConfigId,
      configObjects,
      refinedBorderSummary,
      borderSummary
    });
    return {
      fieldId: field.fieldId,
      candidates,
      warnings
    };
  });
};
