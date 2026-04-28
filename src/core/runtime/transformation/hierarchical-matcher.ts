/**
 * Hierarchical structural matcher.
 *
 * Strategy:
 *   1. Pair Border (always 1:1, full page boundary).
 *   2. Pair Refined Border (always 1:1, the inferred content area).
 *   3. Match top-level (parentObjectId === null) objects greedily by similarity.
 *   4. For each matched parent pair, match its children only against children
 *      of the matched runtime parent. Recurse.
 *   5. Match remaining unmatched config objects against remaining unmatched
 *      runtime objects globally with a stricter threshold.
 *
 * The matcher does not mutate StructuralModels and does not invent objects.
 * Per-match transforms are derived directly from the matched rect deltas; no
 * global page transform is computed here (that is consensus, in Phase 3).
 */

import type {
  StructuralObjectNode,
  StructuralPage
} from '../../contracts/structural-model';
import type { TransformationObjectMatch } from '../../contracts/transformation-model';
import {
  computeObjectSimilarity,
  DEFAULT_SIMILARITY_WEIGHTS,
  type SimilarityContext,
  type SimilarityWeights
} from './similarity';
import { affineFromRects } from './transform-math';

export interface MatcherOptions {
  /**
   * Minimum aggregate similarity required to emit a match in the hierarchical
   * (parent-aware) phases.
   */
  minHierarchicalConfidence?: number;
  /**
   * Stricter threshold for the final global pass over still-unmatched objects.
   */
  minGlobalConfidence?: number;
  weights?: SimilarityWeights;
}

export const DEFAULT_MATCHER_OPTIONS: Required<MatcherOptions> = {
  minHierarchicalConfidence: 0.55,
  minGlobalConfidence: 0.7,
  weights: DEFAULT_SIMILARITY_WEIGHTS
};

/**
 * Score gap below which a runner-up pair is considered to "tie" the chosen
 * pair. When repeated / near-duplicate objects are present (table cells,
 * repeated headers, identical row stripes) the greedy assignment can pick a
 * winner whose score is within rounding of several alternatives — there is
 * no actual reason to prefer it. We don't reject those matches (the IoU
 * multi-anchor warning is the safety net for that), but we mark them as
 * ambiguous so downstream consumers can see how thin the win was.
 */
export const AMBIGUITY_SCORE_MARGIN = 0.05;

/**
 * Confidence multiplier applied to a match flagged as ambiguous. The match is
 * still emitted (downstream consensus / multi-anchor checks decide whether to
 * keep using it), but its reported confidence is lowered so weak-match
 * detection downstream can react appropriately.
 */
export const AMBIGUITY_CONFIDENCE_PENALTY = 0.85;

interface AmbiguityInfo {
  rivalConfigId?: string;
  rivalRuntimeId?: string;
  chosenScore: number;
  rivalScore: number;
}

export interface PageMatchResult {
  matches: TransformationObjectMatch[];
  unmatchedConfigObjectIds: string[];
  unmatchedRuntimeObjectIds: string[];
  notes: string[];
  warnings: string[];
}

interface CandidatePair {
  configId: string;
  runtimeId: string;
  score: number;
}

interface GreedyAssignment {
  configId: string;
  runtimeId: string;
  score: number;
  ambiguity: AmbiguityInfo | null;
}

/**
 * Greedy max-score 1:1 assignment within a candidate pool. We pick the
 * highest-scoring pair, remove both endpoints, repeat until the pool is empty
 * or no pair clears the threshold.
 *
 * Each emitted assignment also reports whether it had a near-tying rival.
 * A "rival" is any unassigned alternative pair that shares one endpoint with
 * the chosen pair (same configId XOR same runtimeId — i.e. an alternative
 * runtime object that wanted this config object, or vice versa) and whose
 * score is within {@link AMBIGUITY_SCORE_MARGIN} of the winner. This catches
 * the repeated-object case (table cells, identical headers) where the
 * matcher's "best" pick is statistically indistinguishable from another.
 */
const greedyAssign = (
  candidates: CandidatePair[],
  threshold: number,
  ambiguityMargin: number = AMBIGUITY_SCORE_MARGIN
): GreedyAssignment[] => {
  const eligible = [...candidates]
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score);
  const usedConfig = new Set<string>();
  const usedRuntime = new Set<string>();
  const assignments: GreedyAssignment[] = [];
  for (let i = 0; i < eligible.length; i += 1) {
    const pair = eligible[i];
    if (usedConfig.has(pair.configId) || usedRuntime.has(pair.runtimeId)) {
      continue;
    }
    let ambiguity: AmbiguityInfo | null = null;
    for (let j = 0; j < eligible.length; j += 1) {
      if (j === i) {
        continue;
      }
      const rival = eligible[j];
      const sharesConfig =
        rival.configId === pair.configId && rival.runtimeId !== pair.runtimeId;
      const sharesRuntime =
        rival.runtimeId === pair.runtimeId && rival.configId !== pair.configId;
      if (!sharesConfig && !sharesRuntime) {
        continue;
      }
      // Don't count rivals whose endpoints have ALREADY been claimed by an
      // earlier (stronger) assignment — those could never have been picked
      // and their score isn't a real challenge to this match.
      if (sharesConfig && usedRuntime.has(rival.runtimeId)) {
        continue;
      }
      if (sharesRuntime && usedConfig.has(rival.configId)) {
        continue;
      }
      if (pair.score - rival.score > ambiguityMargin) {
        continue;
      }
      ambiguity = {
        chosenScore: pair.score,
        rivalScore: rival.score,
        ...(sharesConfig ? { rivalRuntimeId: rival.runtimeId } : {}),
        ...(sharesRuntime ? { rivalConfigId: rival.configId } : {})
      };
      break;
    }
    assignments.push({
      configId: pair.configId,
      runtimeId: pair.runtimeId,
      score: pair.score,
      ambiguity
    });
    usedConfig.add(pair.configId);
    usedRuntime.add(pair.runtimeId);
  }
  return assignments;
};

const buildMatch = (
  config: StructuralObjectNode,
  runtime: StructuralObjectNode,
  context: SimilarityContext,
  ambiguity: AmbiguityInfo | null = null
): TransformationObjectMatch => {
  const sim = computeObjectSimilarity(config, runtime, context);
  const warnings: string[] = [];
  let confidence = sim.score;
  if (ambiguity) {
    const rivalDescription = ambiguity.rivalRuntimeId
      ? `runtime object ${ambiguity.rivalRuntimeId}`
      : ambiguity.rivalConfigId
      ? `config object ${ambiguity.rivalConfigId}`
      : 'an alternative pair';
    warnings.push(
      `ambiguous match: ${config.objectId}↔${runtime.objectId} ` +
        `score ${ambiguity.chosenScore.toFixed(3)} only beats ${rivalDescription} ` +
        `by ${(ambiguity.chosenScore - ambiguity.rivalScore).toFixed(3)} ` +
        `(margin ≤ ${AMBIGUITY_SCORE_MARGIN.toFixed(2)}); ` +
        `confidence demoted ×${AMBIGUITY_CONFIDENCE_PENALTY.toFixed(2)} for inspection`
    );
    confidence = sim.score * AMBIGUITY_CONFIDENCE_PENALTY;
  }
  return {
    configObjectId: config.objectId,
    runtimeObjectId: runtime.objectId,
    configType: config.type,
    runtimeType: runtime.type,
    confidence,
    basis: sim.basis,
    transform: affineFromRects(config.objectRectNorm, runtime.objectRectNorm),
    notes: sim.notes,
    warnings
  };
};

const childrenOf = (
  parentId: string | null,
  pool: ReadonlyArray<StructuralObjectNode>,
  unmatched: ReadonlySet<string>
): StructuralObjectNode[] => pool.filter((o) => o.parentObjectId === parentId && unmatched.has(o.objectId));

export const matchPage = (
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  options: MatcherOptions = {}
): PageMatchResult => {
  const opts: Required<MatcherOptions> = {
    minHierarchicalConfidence:
      options.minHierarchicalConfidence ?? DEFAULT_MATCHER_OPTIONS.minHierarchicalConfidence,
    minGlobalConfidence:
      options.minGlobalConfidence ?? DEFAULT_MATCHER_OPTIONS.minGlobalConfidence,
    weights: options.weights ?? DEFAULT_MATCHER_OPTIONS.weights
  };

  const configObjects = configPage.objectHierarchy.objects;
  const runtimeObjects = runtimePage.objectHierarchy.objects;

  const runtimeObjectParent = new Map<string, string | null>(
    runtimeObjects.map((o) => [o.objectId, o.parentObjectId])
  );

  const matches: TransformationObjectMatch[] = [];
  const parentMatches = new Map<string, string>();
  const unmatchedConfig = new Set(configObjects.map((o) => o.objectId));
  const unmatchedRuntime = new Set(runtimeObjects.map((o) => o.objectId));
  const notes: string[] = [];
  const warnings: string[] = [];

  const baseContext = (parentMatchesSnapshot: ReadonlyMap<string, string>): SimilarityContext => ({
    configRefinedBorder: configPage.refinedBorder,
    runtimeRefinedBorder: runtimePage.refinedBorder,
    parentMatches: parentMatchesSnapshot,
    runtimeObjectParent,
    weights: opts.weights
  });

  const matchPool = (
    configCandidates: ReadonlyArray<StructuralObjectNode>,
    runtimeCandidates: ReadonlyArray<StructuralObjectNode>,
    threshold: number
  ): void => {
    if (configCandidates.length === 0 || runtimeCandidates.length === 0) {
      return;
    }
    const ctx = baseContext(parentMatches);
    const pairs: CandidatePair[] = [];
    for (const c of configCandidates) {
      for (const r of runtimeCandidates) {
        const sim = computeObjectSimilarity(c, r, ctx);
        pairs.push({ configId: c.objectId, runtimeId: r.objectId, score: sim.score });
      }
    }
    const assignments = greedyAssign(pairs, threshold);
    for (const assignment of assignments) {
      const { configId, runtimeId, ambiguity } = assignment;
      const cNode = configCandidates.find((o) => o.objectId === configId);
      const rNode = runtimeCandidates.find((o) => o.objectId === runtimeId);
      if (!cNode || !rNode) {
        continue;
      }
      const match = buildMatch(cNode, rNode, baseContext(parentMatches), ambiguity);
      matches.push(match);
      if (ambiguity) {
        warnings.push(match.warnings[0]);
      }
      parentMatches.set(configId, runtimeId);
      unmatchedConfig.delete(configId);
      unmatchedRuntime.delete(runtimeId);
    }
  };

  // 1. Top-level pass.
  const configTopLevel = configObjects.filter((o) => o.parentObjectId === null);
  const runtimeTopLevel = runtimeObjects.filter((o) => o.parentObjectId === null);
  matchPool(configTopLevel, runtimeTopLevel, opts.minHierarchicalConfidence);

  // 2. Recursive descent within matched parents. We process a queue so newly
  //    matched parents enable their own children to be matched in turn.
  const queue: string[] = Array.from(parentMatches.keys());
  while (queue.length > 0) {
    const configParentId = queue.shift() as string;
    const runtimeParentId = parentMatches.get(configParentId);
    if (!runtimeParentId) {
      continue;
    }
    const configChildren = childrenOf(configParentId, configObjects, unmatchedConfig);
    const runtimeChildren = childrenOf(runtimeParentId, runtimeObjects, unmatchedRuntime);
    if (configChildren.length === 0 || runtimeChildren.length === 0) {
      continue;
    }
    const before = parentMatches.size;
    matchPool(configChildren, runtimeChildren, opts.minHierarchicalConfidence);
    if (parentMatches.size > before) {
      for (const child of configChildren) {
        if (parentMatches.has(child.objectId)) {
          queue.push(child.objectId);
        }
      }
    }
  }

  // 3. Final global pass over remaining unmatched objects with a stricter
  //    threshold. Useful when a config parent did not match but a child object
  //    is highly distinctive and finds a confident runtime match anyway.
  const remainingConfig = configObjects.filter((o) => unmatchedConfig.has(o.objectId));
  const remainingRuntime = runtimeObjects.filter((o) => unmatchedRuntime.has(o.objectId));
  if (remainingConfig.length > 0 && remainingRuntime.length > 0) {
    matchPool(remainingConfig, remainingRuntime, opts.minGlobalConfidence);
  }

  if (configObjects.length > 0 && matches.length === 0) {
    warnings.push('no object matches cleared the confidence threshold');
  } else if (matches.length < configObjects.length / 2) {
    warnings.push(
      `only ${matches.length} of ${configObjects.length} config objects matched a runtime object`
    );
  }

  if (matches.length > 0) {
    notes.push(`hierarchical matcher produced ${matches.length} match(es)`);
  }

  // Stable, deterministic ordering for downstream consumers and tests.
  matches.sort((a, b) => a.configObjectId.localeCompare(b.configObjectId));

  return {
    matches,
    unmatchedConfigObjectIds: Array.from(unmatchedConfig).sort(),
    unmatchedRuntimeObjectIds: Array.from(unmatchedRuntime).sort(),
    notes,
    warnings
  };
};
