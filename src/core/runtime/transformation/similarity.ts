/**
 * Similarity scoring between a Config StructuralObjectNode and a Runtime
 * StructuralObjectNode. Pure functions — no I/O, no mutation, no awareness of
 * matcher state. Returns a score in [0, 1] and the basis tags that contributed.
 *
 * The scorer is intentionally tolerant. It is meant to surface candidate matches
 * for the hierarchical matcher to choose between, not to make final decisions.
 *
 * Object scoring uses geometry, parent chain, and refined-border relation.
 * There is no semantic type-matching component — every structural detection
 * is just an "object", and matching is purely structural.
 */

import type {
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralRefinedBorder
} from '../../contracts/structural-model';
import type { TransformationMatchBasis } from '../../contracts/transformation-model';

export interface SimilarityWeights {
  position: number;
  size: number;
  aspect: number;
  parentChain: number;
  refinedBorderRelation: number;
}

export const DEFAULT_SIMILARITY_WEIGHTS: SimilarityWeights = {
  position: 0.3,
  size: 0.2,
  aspect: 0.1,
  parentChain: 0.25,
  refinedBorderRelation: 0.15
};

/**
 * Weight profile used when the matcher knows it is comparing two structural
 * models built from DIFFERENT documents (different `documentFingerprint`).
 *
 * Across-document matching has a different reliability profile:
 *   - Absolute normalized position (`position`) is fragile — even
 *     instances of the same template shift their objects by a few percent
 *     because content widths (4-digit vs 5-digit values, longer names,
 *     different counts of repeating elements) move the line-grid cells the
 *     CV adapter detects.
 *   - Relative position INSIDE the refined border (`refinedBorderRelation`)
 *     is the strongest cross-document signal: the refined border is the
 *     content-area summary, so an object sitting "in the top-left of the
 *     right-sidebar card" stays in the top-left of that card on a similar
 *     document even if the card's outer bounds shift.
 *   - Parent-chain stays critical (an object inside the same matched
 *     ancestor is far more likely to be the correct counterpart).
 *   - Size and aspect remain useful as sanity checks but should not dominate.
 *
 * Within-document matching (Config Capture re-loaded into Run Mode against
 * the same NormalizedPage) keeps the original profile because absolute
 * position IS reliable in that case — there is no content drift.
 */
export const CROSS_DOCUMENT_SIMILARITY_WEIGHTS: SimilarityWeights = {
  position: 0.15,
  size: 0.2,
  aspect: 0.1,
  parentChain: 0.25,
  refinedBorderRelation: 0.3
};

export interface SimilarityContext {
  /**
   * Refined border rect for the page each object lives on. Used so the scorer
   * can compute the object's relation to its refined border (a strong signal
   * across documents).
   */
  configRefinedBorder: StructuralRefinedBorder;
  runtimeRefinedBorder: StructuralRefinedBorder;
  /**
   * Already-known parent pairings, keyed by configObjectId → runtimeObjectId.
   * If the config object's parent has been matched, and the runtime object is
   * a child of that match, parentChain similarity gets full credit. When a
   * top-level (null parent) pair is being scored, both must have null parent.
   */
  parentMatches: ReadonlyMap<string, string>;
  /**
   * Map from runtime objectId to its parent objectId for parent-chain checks.
   */
  runtimeObjectParent: ReadonlyMap<string, string | null>;
  weights?: SimilarityWeights;
}

export interface SimilarityResult {
  score: number;
  basis: TransformationMatchBasis[];
  /**
   * Per-component scores in [0, 1], for diagnostics and tests.
   */
  components: {
    position: number;
    size: number;
    aspect: number;
    parentChain: number;
    refinedBorderRelation: number;
  };
  notes: string[];
}

/**
 * Per-component floors a candidate pair must clear before it is treated as a
 * real match. The aggregate weighted score is fragile — a high parent-chain or
 * refined-border-relation contribution can paper over a wildly mismatched
 * size/aspect/location pair. The floors enforce the user-facing intuition that
 * a match must look like the same object: similar shape, similar size, and
 * similar position (either absolute or relative to the refined border).
 *
 * If ANY of these floors is missed, `computeObjectSimilarity` returns
 * `score: 0`, which means the pair never reaches downstream consensus,
 * field-candidate emission, or localization-runner selection — regardless of
 * how many other components scored well. We do not "morph" partial matches
 * into usable ones: we drop them.
 *
 * Tunings:
 *   - `size`: linear penalty `1 - max(dw, dh) / max(w)`; floor 0.5 admits a
 *     ~50% size delta (matches a uniform 1.5x scale; user-stated "10x10 vs
 *     8x8 should be fine" lands at 0.8, well above the floor).
 *   - `aspect`: ratio of the smaller-aspect to the larger-aspect; floor 0.7
 *     rejects pairs whose aspect ratios differ by more than ~30%.
 *   - `positionOrRefinedBorder`: at least ONE of the position signals must be
 *     reasonably strong. Cross-document matching deliberately weakens
 *     absolute position (CROSS_DOCUMENT_SIMILARITY_WEIGHTS) — the
 *     refined-border-relation IS the strong cross-document position signal.
 *     We accept a pair when either is ≥ 0.55, but reject when BOTH are weak,
 *     since that means the runtime object isn't sitting where the config
 *     object should be in any frame of reference.
 */
export const SIMILARITY_COMPONENT_FLOORS = {
  size: 0.5,
  aspect: 0.7,
  positionOrRefinedBorder: 0.55
} as const;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const rectCenter = (r: StructuralNormalizedRect): { x: number; y: number } => ({
  x: r.xNorm + r.wNorm / 2,
  y: r.yNorm + r.hNorm / 2
});

const safeDiv = (n: number, d: number, fallback: number): number =>
  d > 1e-9 || d < -1e-9 ? n / d : fallback;

const positionScore = (
  a: StructuralNormalizedRect,
  b: StructuralNormalizedRect
): number => {
  const ca = rectCenter(a);
  const cb = rectCenter(b);
  const dx = ca.x - cb.x;
  const dy = ca.y - cb.y;
  const distance = Math.hypot(dx, dy);
  // Page diagonal in normalized space is sqrt(2) ≈ 1.414. Half of that as the
  // "fully unrelated" threshold is intentionally tolerant.
  return clamp01(1 - distance / 0.7);
};

const sizeScore = (
  a: StructuralNormalizedRect,
  b: StructuralNormalizedRect
): number => {
  const dw = Math.abs(a.wNorm - b.wNorm) / Math.max(a.wNorm, b.wNorm, 1e-6);
  const dh = Math.abs(a.hNorm - b.hNorm) / Math.max(a.hNorm, b.hNorm, 1e-6);
  return clamp01(1 - Math.max(dw, dh));
};

const aspectScore = (
  a: StructuralNormalizedRect,
  b: StructuralNormalizedRect
): number => {
  const arA = safeDiv(a.wNorm, a.hNorm, 1);
  const arB = safeDiv(b.wNorm, b.hNorm, 1);
  const ratio = Math.min(arA, arB) / Math.max(arA, arB, 1e-6);
  return clamp01(ratio);
};

/**
 * Score the relation an object has to its refined border. Two objects on
 * different documents but in the same template should sit at similar relative
 * positions inside their refined borders even if the borders themselves differ.
 */
const refinedBorderRelationScore = (
  configRect: StructuralNormalizedRect,
  configRefined: StructuralRefinedBorder,
  runtimeRect: StructuralNormalizedRect,
  runtimeRefined: StructuralRefinedBorder
): number => {
  const cr = configRefined.rectNorm;
  const rr = runtimeRefined.rectNorm;
  if (cr.wNorm < 1e-6 || cr.hNorm < 1e-6 || rr.wNorm < 1e-6 || rr.hNorm < 1e-6) {
    return 0;
  }
  const configRel = {
    x: (configRect.xNorm - cr.xNorm) / cr.wNorm,
    y: (configRect.yNorm - cr.yNorm) / cr.hNorm,
    w: configRect.wNorm / cr.wNorm,
    h: configRect.hNorm / cr.hNorm
  };
  const runtimeRel = {
    x: (runtimeRect.xNorm - rr.xNorm) / rr.wNorm,
    y: (runtimeRect.yNorm - rr.yNorm) / rr.hNorm,
    w: runtimeRect.wNorm / rr.wNorm,
    h: runtimeRect.hNorm / rr.hNorm
  };
  const dx = Math.abs(configRel.x - runtimeRel.x);
  const dy = Math.abs(configRel.y - runtimeRel.y);
  const dw = Math.abs(configRel.w - runtimeRel.w);
  const dh = Math.abs(configRel.h - runtimeRel.h);
  const drift = (dx + dy + dw + dh) / 4;
  return clamp01(1 - drift);
};

/**
 * Parent-chain similarity using already-known matches. When both parents are
 * null we award full credit (both are top-level). When the config parent has
 * been matched and the runtime object is a child of that matched parent, full
 * credit. Otherwise zero.
 */
const parentChainScore = (
  config: StructuralObjectNode,
  runtime: StructuralObjectNode,
  parentMatches: ReadonlyMap<string, string>,
  runtimeObjectParent: ReadonlyMap<string, string | null>
): number => {
  if (config.parentObjectId === null && runtime.parentObjectId === null) {
    return 1;
  }
  if (config.parentObjectId === null || runtime.parentObjectId === null) {
    return 0;
  }
  const expectedRuntimeParent = parentMatches.get(config.parentObjectId);
  if (!expectedRuntimeParent) {
    return 0;
  }
  const actualRuntimeParent = runtimeObjectParent.get(runtime.objectId) ?? null;
  return expectedRuntimeParent === actualRuntimeParent ? 1 : 0;
};

export const computeObjectSimilarity = (
  config: StructuralObjectNode,
  runtime: StructuralObjectNode,
  context: SimilarityContext
): SimilarityResult => {
  const weights = context.weights ?? DEFAULT_SIMILARITY_WEIGHTS;

  const components = {
    position: positionScore(config.objectRectNorm, runtime.objectRectNorm),
    size: sizeScore(config.objectRectNorm, runtime.objectRectNorm),
    aspect: aspectScore(config.objectRectNorm, runtime.objectRectNorm),
    parentChain: parentChainScore(
      config,
      runtime,
      context.parentMatches,
      context.runtimeObjectParent
    ),
    refinedBorderRelation: refinedBorderRelationScore(
      config.objectRectNorm,
      context.configRefinedBorder,
      runtime.objectRectNorm,
      context.runtimeRefinedBorder
    )
  };

  const notes: string[] = [];

  // Per-component floors (see SIMILARITY_COMPONENT_FLOORS for rationale).
  // Any miss collapses the score to 0 so the pair is treated as a non-match
  // everywhere downstream (matcher threshold, consensus weighting, candidate
  // emission, localization selection). We still return the components so
  // diagnostics can see why the pair was rejected.
  const sizeMissed = components.size < SIMILARITY_COMPONENT_FLOORS.size;
  const aspectMissed = components.aspect < SIMILARITY_COMPONENT_FLOORS.aspect;
  const positionSignalMissed =
    Math.max(components.position, components.refinedBorderRelation) <
    SIMILARITY_COMPONENT_FLOORS.positionOrRefinedBorder;

  if (sizeMissed || aspectMissed || positionSignalMissed) {
    if (sizeMissed) {
      notes.push(
        `size component ${components.size.toFixed(3)} below floor ` +
          `${SIMILARITY_COMPONENT_FLOORS.size.toFixed(2)} — pair rejected as non-match`
      );
    }
    if (aspectMissed) {
      notes.push(
        `aspect component ${components.aspect.toFixed(3)} below floor ` +
          `${SIMILARITY_COMPONENT_FLOORS.aspect.toFixed(2)} — pair rejected as non-match`
      );
    }
    if (positionSignalMissed) {
      notes.push(
        `neither position (${components.position.toFixed(3)}) nor ` +
          `refined-border-relation (${components.refinedBorderRelation.toFixed(3)}) ` +
          `cleared floor ${SIMILARITY_COMPONENT_FLOORS.positionOrRefinedBorder.toFixed(2)} — pair rejected as non-match`
      );
    }
    return { score: 0, basis: [], components, notes };
  }

  const score = clamp01(
    weights.position * components.position +
      weights.size * components.size +
      weights.aspect * components.aspect +
      weights.parentChain * components.parentChain +
      weights.refinedBorderRelation * components.refinedBorderRelation
  );

  const basis: TransformationMatchBasis[] = [];
  if (components.position >= 0.5 || components.size >= 0.5 || components.aspect >= 0.5) {
    basis.push('object-similarity');
  }
  if (components.parentChain > 0) {
    basis.push('parent-chain');
  }
  if (components.refinedBorderRelation >= 0.5) {
    basis.push('refined-border-relation');
  }

  if (components.position < 0.4) {
    notes.push('center-of-mass differs noticeably');
  }
  if (components.size < 0.4) {
    notes.push('width/height differ noticeably');
  }

  return { score, basis, components, notes };
};
