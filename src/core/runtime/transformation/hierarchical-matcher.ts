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
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralPage
} from '../../contracts/structural-model';
import type {
  TransformationAffine,
  TransformationObjectMatch
} from '../../contracts/transformation-model';
import {
  computeObjectSimilarity,
  DEFAULT_SIMILARITY_WEIGHTS,
  type SimilarityContext,
  type SimilarityWeights
} from './similarity';

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

export interface PageMatchResult {
  matches: TransformationObjectMatch[];
  unmatchedConfigObjectIds: string[];
  unmatchedRuntimeObjectIds: string[];
  notes: string[];
  warnings: string[];
}

const affineFromRects = (
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

interface CandidatePair {
  configId: string;
  runtimeId: string;
  score: number;
}

/**
 * Greedy max-score 1:1 assignment within a candidate pool. We pick the
 * highest-scoring pair, remove both endpoints, repeat until the pool is empty
 * or no pair clears the threshold.
 */
const greedyAssign = (
  candidates: CandidatePair[],
  threshold: number
): Map<string, string> => {
  const sorted = [...candidates]
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score);
  const usedConfig = new Set<string>();
  const usedRuntime = new Set<string>();
  const assignments = new Map<string, string>();
  for (const pair of sorted) {
    if (usedConfig.has(pair.configId) || usedRuntime.has(pair.runtimeId)) {
      continue;
    }
    assignments.set(pair.configId, pair.runtimeId);
    usedConfig.add(pair.configId);
    usedRuntime.add(pair.runtimeId);
  }
  return assignments;
};

const buildMatch = (
  config: StructuralObjectNode,
  runtime: StructuralObjectNode,
  context: SimilarityContext
): TransformationObjectMatch => {
  const sim = computeObjectSimilarity(config, runtime, context);
  return {
    configObjectId: config.objectId,
    runtimeObjectId: runtime.objectId,
    configType: config.type,
    runtimeType: runtime.type,
    confidence: sim.score,
    basis: sim.basis,
    transform: affineFromRects(config.objectRectNorm, runtime.objectRectNorm),
    notes: sim.notes,
    warnings: []
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
    for (const [configId, runtimeId] of assignments) {
      const cNode = configCandidates.find((o) => o.objectId === configId);
      const rNode = runtimeCandidates.find((o) => o.objectId === runtimeId);
      if (!cNode || !rNode) {
        continue;
      }
      matches.push(buildMatch(cNode, rNode, baseContext(parentMatches)));
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
