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
import { affineDistance, IDENTITY_AFFINE } from './transform-math';

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

/**
 * Minimum raw `match.confidence` an object-anchor source must carry before it
 * is allowed to become a field candidate.
 *
 * Rationale: the user-facing rule is "only use near-perfect matched objects."
 * The matcher's own threshold (`minHierarchicalConfidence`) gates whether a
 * match is *emitted*; this floor gates whether an emitted match is *trusted*
 * as a field anchor. We do not "morph" a marginal match into a usable anchor —
 * if the match isn't strong, the field falls through to the next rung
 * (parent-object, refined-border, border) instead.
 *
 * Applied to:
 *   - matched-object candidates: drop when `match.confidence` is below the floor.
 *   - parent-object candidates: drop when the ancestor's own `match.confidence`
 *     is below the floor (re-validated independent of the `PARENT_INDIRECTION_PENALTY`
 *     applied to the emitted candidate confidence).
 *
 * The floor is set just below the matcher's `minHierarchicalConfidence` so an
 * ambiguity-demoted (×0.85) match can still slip through if it was originally
 * strong, but a low-quality match that only barely cleared the matcher cannot.
 */
const MIN_OBJECT_ANCHOR_MATCH_CONFIDENCE = 0.7;

/**
 * Thresholds for the "object candidate is degenerate vs refined-border"
 * detection. When a matched-object or parent-object candidate's transform is
 * within these tolerances of the refined-border level summary, AND the
 * refined-border summary itself is well-supported (>= NEAR_IDENTITY_REFINED_BORDER_MIN_CONFIDENCE),
 * we treat the object-rung evidence as redundant. The refined border draws on
 * the full page rather than a single object's identity-ish match, so we let
 * it win the "pick first" race by demoting the redundant object candidate
 * below it in fallbackOrder. The candidate is still emitted for inspection.
 */
const NEAR_IDENTITY_SCALE_DELTA = 0.01;
const NEAR_IDENTITY_TRANSLATE_DELTA = 0.01;
const NEAR_IDENTITY_REFINED_BORDER_MIN_CONFIDENCE = 0.7;

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

  // 1. Matched-object candidates, in objectAnchor rank order. We only emit a
  //    candidate when the underlying match is near-perfect (raw confidence
  //    above MIN_OBJECT_ANCHOR_MATCH_CONFIDENCE). A marginal match is dropped
  //    here so the field falls through to the next rung instead of anchoring
  //    on weak data.
  for (const anchor of input.field.fieldAnchors.objectAnchors) {
    const match = input.matchesByConfigId.get(anchor.objectId);
    if (!match) {
      continue;
    }
    if (match.confidence < MIN_OBJECT_ANCHOR_MATCH_CONFIDENCE) {
      warnings.push(
        `${anchor.rank} object anchor ${anchor.objectId} matched ${match.runtimeObjectId} ` +
          `but match confidence ${match.confidence.toFixed(3)} is below the near-perfect floor ` +
          `${MIN_OBJECT_ANCHOR_MATCH_CONFIDENCE.toFixed(2)} — candidate not emitted`
      );
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
      // Re-validate the ancestor's OWN match confidence against the same
      // near-perfect floor that gates matched-object candidates. The
      // PARENT_INDIRECTION_PENALTY (0.85x) applied below softens the emitted
      // candidate confidence, but it does NOT compensate for an ancestor
      // whose underlying match is itself marginal — if the parent match is
      // weak, the field should not be reconstructed through it.
      if (match.confidence < MIN_OBJECT_ANCHOR_MATCH_CONFIDENCE) {
        warnings.push(
          `parent-object fallback ancestor ${ancestor.objectId} matched ${match.runtimeObjectId} ` +
            `but match confidence ${match.confidence.toFixed(3)} is below the near-perfect floor ` +
            `${MIN_OBJECT_ANCHOR_MATCH_CONFIDENCE.toFixed(2)} — ancestor candidate not emitted`
        );
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

  // Demote object-rung candidates whose transform is essentially identical to
  // a well-supported refined-border level summary. The matched/parent object
  // is still emitted (so it shows up for inspection) but moved below the
  // refined-border candidate in fallbackOrder, so the localization runner's
  // "pick first" lands on the better-cross-validated refined-border signal
  // instead of a degenerate identity-ish match that happens to share a rank.
  const refinedSummary = input.refinedBorderSummary;
  const refinedTransform = refinedSummary?.transform ?? null;
  const refinedConfidence = refinedSummary?.confidence ?? 0;
  const refinedReliable =
    refinedTransform !== null &&
    refinedConfidence >= NEAR_IDENTITY_REFINED_BORDER_MIN_CONFIDENCE;

  const isDegenerateObjectCandidate = (c: TransformationFieldCandidate): boolean => {
    if (!refinedReliable || !refinedTransform) {
      return false;
    }
    if (c.source !== 'matched-object' && c.source !== 'parent-object') {
      return false;
    }
    const { scaleDelta, translateDelta } = affineDistance(c.transform, refinedTransform);
    return (
      scaleDelta < NEAR_IDENTITY_SCALE_DELTA &&
      translateDelta < NEAR_IDENTITY_TRANSLATE_DELTA
    );
  };

  const objectCandidates = candidates.filter(
    (c) => c.source === 'matched-object' || c.source === 'parent-object'
  );
  const refinedBorderCandidate = candidates.find((c) => c.source === 'refined-border');
  const borderCandidate = candidates.find((c) => c.source === 'border');

  const objectKept: TransformationFieldCandidate[] = [];
  const objectDemoted: TransformationFieldCandidate[] = [];
  for (const c of objectCandidates) {
    if (isDegenerateObjectCandidate(c)) {
      objectDemoted.push({
        ...c,
        notes: [
          ...c.notes,
          `transform within ±${NEAR_IDENTITY_SCALE_DELTA}/±${NEAR_IDENTITY_TRANSLATE_DELTA} of refined-border ` +
            `(refined-border confidence ${refinedConfidence.toFixed(3)} ≥ ` +
            `${NEAR_IDENTITY_REFINED_BORDER_MIN_CONFIDENCE.toFixed(2)}) — demoted below refined-border`
        ]
      });
    } else {
      objectKept.push(c);
    }
  }

  if (objectDemoted.length > 0 && refinedBorderCandidate) {
    warnings.push(
      `${objectDemoted.length} object-rung candidate(s) demoted below refined-border ` +
        'as their transform was within the near-identity tolerance of a confident refined-border summary'
    );
  }

  const reordered: TransformationFieldCandidate[] = [];
  reordered.push(...objectKept);
  if (refinedBorderCandidate) {
    reordered.push(refinedBorderCandidate);
  }
  reordered.push(...objectDemoted);
  if (borderCandidate) {
    reordered.push(borderCandidate);
  }

  const final = reordered.map((c, index) => ({ ...c, fallbackOrder: index }));

  return { candidates: final, warnings };
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
