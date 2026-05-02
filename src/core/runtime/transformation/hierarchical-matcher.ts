/**
 * Hierarchical structural matcher.
 *
 * Strategy:
 *   1. Pair Border (always 1:1, full page boundary).
 *   2. Pair Refined Border (always 1:1, the inferred content area).
 *   3. Match top-level (parentObjectId === null) objects by similarity.
 *   4. For each matched parent pair, match its children only against children
 *      of the matched runtime parent. Recurse.
 *   5. Match remaining unmatched config objects against remaining unmatched
 *      runtime objects globally with a stricter threshold.
 *   6. Recovery pass: re-run the still-unmatched global pool through the
 *      assignment solver with a slightly relaxed threshold but a tight
 *      score-margin requirement, to recover "obviously correct" leftovers
 *      without the ambiguity-flag explosion.
 *
 * For small candidate pools the matcher uses a greedy max-score 1:1 pick.
 * For larger pools (≥ 4 candidates on each side) it switches to a Hungarian
 * (Kuhn-Munkres) assignment solver that maximizes total score across the
 * bipartite graph instead of locally maximizing each pick. Greedy is correct
 * when scores are well-separated but degrades on cell-rich layouts (table
 * cells, repeated rows) where many near-identical pairs differ by < 0.02 —
 * picking the locally best winner can leave later cells stranded.
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
  CROSS_DOCUMENT_SIMILARITY_WEIGHTS,
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
  /**
   * True when the config and runtime structural models came from distinct
   * documents (different `documentFingerprint`). When true and `weights` is
   * not explicitly provided, the matcher uses the cross-document weight
   * profile, which de-emphasizes absolute position in favor of position
   * relative to the refined border. This is the typical Run Mode case
   * (relocating saved geometry onto a new but similar document).
   */
  crossDocument?: boolean;
  /**
   * Config object IDs that have been explicitly named as a field's primary or
   * secondary anchor. Field anchors are the system's most consequential
   * matches, so their pairwise scores receive a small {@link PRIORITY_SCORE_BONUS}
   * bump to ensure they get matched when there's any reasonable runtime
   * counterpart, even against a slightly-better non-priority rival.
   *
   * A bonus is applied only to pairs whose config endpoint is in this set; the
   * threshold check is applied AFTER the bonus, so a borderline priority pair
   * can clear the bar where it otherwise wouldn't.
   */
  priorityObjectIds?: ReadonlySet<string>;
}

/**
 * Minimum aggregate similarity required to emit a hierarchical match.
 *
 * Raised from 0.55 to 0.75 in tandem with the per-component floors added in
 * similarity.ts (`SIMILARITY_COMPONENT_FLOORS`). The floors do the real
 * "near-perfect" gating; this aggregate threshold keeps the system from
 * accepting a pair that nominally clears every individual floor but whose
 * weighted blend is still mediocre. Together they enforce: a match must be
 * geometrically plausible per-component AND its overall score must be high.
 */
export const DEFAULT_MATCHER_OPTIONS: Required<
  Omit<MatcherOptions, 'crossDocument' | 'priorityObjectIds'>
> = {
  minHierarchicalConfidence: 0.75,
  minGlobalConfidence: 0.8,
  weights: DEFAULT_SIMILARITY_WEIGHTS
};

const resolveWeights = (options: MatcherOptions): SimilarityWeights => {
  if (options.weights) {
    return options.weights;
  }
  return options.crossDocument
    ? CROSS_DOCUMENT_SIMILARITY_WEIGHTS
    : DEFAULT_SIMILARITY_WEIGHTS;
};

/**
 * Score gap below which a runner-up pair is considered to "tie" the chosen
 * pair. When repeated / near-duplicate objects are present (table cells,
 * repeated headers, identical row stripes) the assignment can pick a winner
 * whose score is within rounding of several alternatives — there is no actual
 * reason to prefer it. We don't reject those matches (the IoU multi-anchor
 * warning is the safety net for that), but we mark them as ambiguous so
 * downstream consumers can see how thin the win was.
 */
export const AMBIGUITY_SCORE_MARGIN = 0.05;

/**
 * Confidence multiplier applied to a match flagged as ambiguous. The match is
 * still emitted (downstream consensus / multi-anchor checks decide whether to
 * keep using it), but its reported confidence is lowered so weak-match
 * detection downstream can react appropriately.
 */
export const AMBIGUITY_CONFIDENCE_PENALTY = 0.85;

/**
 * Pool size at which the matcher switches from greedy 1:1 assignment to a
 * Hungarian (Kuhn-Munkres) solver. Below this size greedy is correct (and
 * cheaper); at or above it the locally-greedy "highest score wins, repeat"
 * pick can leave later candidates stranded against already-claimed partners.
 */
export const HUNGARIAN_POOL_THRESHOLD = 4;

/**
 * Score added to a pairwise score when its config endpoint appears in
 * `priorityObjectIds`. Small enough that wildly better non-priority rivals
 * still win, but enough to flip a near-tie in favor of named field anchors.
 */
export const PRIORITY_SCORE_BONUS = 0.05;

/**
 * Recovery pass amount: the second global pass relaxes the global threshold
 * by this much.
 */
export const RECOVERY_THRESHOLD_RELAXATION = 0.05;

/**
 * Score-margin a recovery pass match must clear over its best alternative
 * before being emitted. Tight enough that the recovery pass only picks up
 * obviously correct leftovers, not ambiguous near-ties.
 */
export const RECOVERY_REQUIRED_MARGIN = 0.02;

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

export interface CandidatePair {
  configId: string;
  runtimeId: string;
  score: number;
}

export interface PoolAssignment {
  configId: string;
  runtimeId: string;
  score: number;
  ambiguity: AmbiguityInfo | null;
  /**
   * Best alternative score sharing one endpoint with the chosen pair, used by
   * the recovery pass to enforce a margin requirement.
   */
  bestRivalScore: number;
}

/**
 * Inspect the candidate set for a chosen pair and return the highest-scoring
 * rival that shares one endpoint with it (not the assigned partner of either
 * already-matched endpoint). The caller decides what to do with the
 * information — flag ambiguity, enforce a margin, or both.
 */
const findBestRival = (
  chosen: CandidatePair,
  candidates: ReadonlyArray<CandidatePair>,
  usedConfig: ReadonlySet<string>,
  usedRuntime: ReadonlySet<string>
): CandidatePair | null => {
  let best: CandidatePair | null = null;
  for (const rival of candidates) {
    if (rival.configId === chosen.configId && rival.runtimeId === chosen.runtimeId) {
      continue;
    }
    const sharesConfig =
      rival.configId === chosen.configId && rival.runtimeId !== chosen.runtimeId;
    const sharesRuntime =
      rival.runtimeId === chosen.runtimeId && rival.configId !== chosen.configId;
    if (!sharesConfig && !sharesRuntime) {
      continue;
    }
    // A rival whose other endpoint has already been claimed by some other
    // match couldn't have been picked anyway, so it isn't a real challenge.
    if (sharesConfig && usedRuntime.has(rival.runtimeId)) {
      continue;
    }
    if (sharesRuntime && usedConfig.has(rival.configId)) {
      continue;
    }
    if (best === null || rival.score > best.score) {
      best = rival;
    }
  }
  return best;
};

const ambiguityFromRival = (
  chosen: CandidatePair,
  rival: CandidatePair | null,
  margin: number
): AmbiguityInfo | null => {
  if (!rival) {
    return null;
  }
  if (chosen.score - rival.score > margin) {
    return null;
  }
  const sharesConfig = rival.configId === chosen.configId;
  return {
    chosenScore: chosen.score,
    rivalScore: rival.score,
    ...(sharesConfig ? { rivalRuntimeId: rival.runtimeId } : { rivalConfigId: rival.configId })
  };
};

/**
 * Greedy max-score 1:1 assignment within a candidate pool. We pick the
 * highest-scoring pair, remove both endpoints, repeat until the pool is empty
 * or no pair clears the threshold.
 *
 * Exported for tests; production code should call the matcher entry points.
 */
export const greedyAssign = (
  candidates: ReadonlyArray<CandidatePair>,
  threshold: number,
  ambiguityMargin: number = AMBIGUITY_SCORE_MARGIN
): PoolAssignment[] => {
  const eligible = [...candidates]
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score);
  const usedConfig = new Set<string>();
  const usedRuntime = new Set<string>();
  const assignments: PoolAssignment[] = [];
  for (const pair of eligible) {
    if (usedConfig.has(pair.configId) || usedRuntime.has(pair.runtimeId)) {
      continue;
    }
    const rival = findBestRival(pair, eligible, usedConfig, usedRuntime);
    const ambiguity = ambiguityFromRival(pair, rival, ambiguityMargin);
    assignments.push({
      configId: pair.configId,
      runtimeId: pair.runtimeId,
      score: pair.score,
      ambiguity,
      bestRivalScore: rival ? rival.score : -Infinity
    });
    usedConfig.add(pair.configId);
    usedRuntime.add(pair.runtimeId);
  }
  return assignments;
};

/**
 * Hungarian (Kuhn-Munkres) min-cost assignment for an n×m cost matrix where
 * n ≤ m. Returns a length-n array where `assignment[i]` is the column matched
 * to row i. Implementation follows the classical O(n²m) potential-based
 * algorithm; numerically stable for our score range (cost = -score, in roughly
 * [-1.05, 0]).
 */
const hungarianMinCost = (cost: ReadonlyArray<ReadonlyArray<number>>): number[] => {
  const n = cost.length;
  if (n === 0) {
    return [];
  }
  const m = cost[0].length;
  const INF = Number.POSITIVE_INFINITY;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j += 1) {
        if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }
      for (let j = 0; j <= m; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j += 1) {
    if (p[j] !== 0) {
      assignment[p[j] - 1] = j - 1;
    }
  }
  return assignment;
};

/**
 * Hungarian-based 1:1 assignment over a candidate pool, maximizing total
 * score. Pairs whose score is below `threshold` are made effectively
 * unassignable; if the optimal assignment ends up putting a row against an
 * unassignable column it is dropped from the result.
 */
export const hungarianAssign = (
  configIds: ReadonlyArray<string>,
  runtimeIds: ReadonlyArray<string>,
  candidates: ReadonlyArray<CandidatePair>,
  threshold: number,
  ambiguityMargin: number = AMBIGUITY_SCORE_MARGIN
): PoolAssignment[] => {
  const n = configIds.length;
  const m = runtimeIds.length;
  if (n === 0 || m === 0) {
    return [];
  }
  const scoreOf = new Map<string, number>();
  for (const p of candidates) {
    scoreOf.set(`${p.configId} ${p.runtimeId}`, p.score);
  }
  // Cost = -score so the min-cost solver maximizes total score. Cells whose
  // score is below the acceptance threshold get a large positive sentinel
  // cost so the solver avoids them when any feasible alternative exists; we
  // drop any such "fallback" placements at the end.
  const SENTINEL = 1e6;
  const buildCost = (rows: ReadonlyArray<string>, cols: ReadonlyArray<string>): number[][] => {
    const cost: number[][] = [];
    for (const ci of rows) {
      const row: number[] = [];
      for (const rj of cols) {
        const s = scoreOf.get(`${ci} ${rj}`) ?? 0;
        row.push(s < threshold ? SENTINEL : -s);
      }
      cost.push(row);
    }
    return cost;
  };

  let rowToCol: number[];
  if (n <= m) {
    rowToCol = hungarianMinCost(buildCost(configIds, runtimeIds));
  } else {
    // Algorithm requires rows ≤ cols; transpose then invert the assignment.
    const transposed = hungarianMinCost(buildCost(runtimeIds, configIds));
    rowToCol = new Array<number>(n).fill(-1);
    for (let j = 0; j < m; j += 1) {
      const i = transposed[j];
      if (i !== -1 && i !== undefined) {
        rowToCol[i] = j;
      }
    }
  }

  const usedConfig = new Set<string>();
  const usedRuntime = new Set<string>();
  const accepted: { i: number; j: number; score: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    const j = rowToCol[i];
    if (j === -1 || j === undefined) {
      continue;
    }
    const score = scoreOf.get(`${configIds[i]} ${runtimeIds[j]}`) ?? 0;
    if (score < threshold) {
      continue;
    }
    usedConfig.add(configIds[i]);
    usedRuntime.add(runtimeIds[j]);
    accepted.push({ i, j, score });
  }

  const assignments: PoolAssignment[] = [];
  for (const { i, j, score } of accepted) {
    const chosen: CandidatePair = {
      configId: configIds[i],
      runtimeId: runtimeIds[j],
      score
    };
    const rival = findBestRival(chosen, candidates, usedConfig, usedRuntime);
    const ambiguity = ambiguityFromRival(chosen, rival, ambiguityMargin);
    assignments.push({
      configId: chosen.configId,
      runtimeId: chosen.runtimeId,
      score,
      ambiguity,
      bestRivalScore: rival ? rival.score : -Infinity
    });
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
): StructuralObjectNode[] =>
  pool.filter((o) => o.parentObjectId === parentId && unmatched.has(o.objectId));

export const matchPage = (
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  options: MatcherOptions = {}
): PageMatchResult => {
  const opts = {
    minHierarchicalConfidence:
      options.minHierarchicalConfidence ?? DEFAULT_MATCHER_OPTIONS.minHierarchicalConfidence,
    minGlobalConfidence:
      options.minGlobalConfidence ?? DEFAULT_MATCHER_OPTIONS.minGlobalConfidence,
    weights: resolveWeights(options),
    priorityObjectIds: options.priorityObjectIds ?? new Set<string>()
  };

  const configObjects = configPage.objectHierarchy.objects;
  const runtimeObjects = runtimePage.objectHierarchy.objects;

  const runtimeObjectParent = new Map<string, string | null>(
    runtimeObjects.map((o) => [o.objectId, o.parentObjectId])
  );
  const configObjectParent = new Map<string, string | null>(
    configObjects.map((o) => [o.objectId, o.parentObjectId])
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
    configObjectParent,
    weights: opts.weights
  });

  const buildPairs = (
    configCandidates: ReadonlyArray<StructuralObjectNode>,
    runtimeCandidates: ReadonlyArray<StructuralObjectNode>
  ): CandidatePair[] => {
    const ctx = baseContext(parentMatches);
    const pairs: CandidatePair[] = [];
    for (const c of configCandidates) {
      const bonus = opts.priorityObjectIds.has(c.objectId) ? PRIORITY_SCORE_BONUS : 0;
      for (const r of runtimeCandidates) {
        const sim = computeObjectSimilarity(c, r, ctx);
        pairs.push({
          configId: c.objectId,
          runtimeId: r.objectId,
          score: sim.score + bonus
        });
      }
    }
    return pairs;
  };

  const assignPool = (
    configCandidates: ReadonlyArray<StructuralObjectNode>,
    runtimeCandidates: ReadonlyArray<StructuralObjectNode>,
    threshold: number
  ): PoolAssignment[] => {
    if (configCandidates.length === 0 || runtimeCandidates.length === 0) {
      return [];
    }
    const pairs = buildPairs(configCandidates, runtimeCandidates);
    const useHungarian =
      Math.min(configCandidates.length, runtimeCandidates.length) >= HUNGARIAN_POOL_THRESHOLD;
    if (useHungarian) {
      return hungarianAssign(
        configCandidates.map((o) => o.objectId),
        runtimeCandidates.map((o) => o.objectId),
        pairs,
        threshold
      );
    }
    return greedyAssign(pairs, threshold);
  };

  const emitAssignments = (
    configCandidates: ReadonlyArray<StructuralObjectNode>,
    runtimeCandidates: ReadonlyArray<StructuralObjectNode>,
    assignments: ReadonlyArray<PoolAssignment>
  ): void => {
    for (const assignment of assignments) {
      const cNode = configCandidates.find((o) => o.objectId === assignment.configId);
      const rNode = runtimeCandidates.find((o) => o.objectId === assignment.runtimeId);
      if (!cNode || !rNode) {
        continue;
      }
      const match = buildMatch(cNode, rNode, baseContext(parentMatches), assignment.ambiguity);
      matches.push(match);
      if (assignment.ambiguity) {
        warnings.push(match.warnings[0]);
      }
      parentMatches.set(assignment.configId, assignment.runtimeId);
      unmatchedConfig.delete(assignment.configId);
      unmatchedRuntime.delete(assignment.runtimeId);
    }
  };

  const matchPool = (
    configCandidates: ReadonlyArray<StructuralObjectNode>,
    runtimeCandidates: ReadonlyArray<StructuralObjectNode>,
    threshold: number
  ): void => {
    emitAssignments(
      configCandidates,
      runtimeCandidates,
      assignPool(configCandidates, runtimeCandidates, threshold)
    );
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

  // 3. Final global pass over remaining unmatched objects with the strict
  //    global threshold. Useful when a config parent did not match but a
  //    child object is highly distinctive and finds a confident runtime
  //    match anyway.
  const remainingConfigPrimary = configObjects.filter((o) => unmatchedConfig.has(o.objectId));
  const remainingRuntimePrimary = runtimeObjects.filter((o) => unmatchedRuntime.has(o.objectId));
  if (remainingConfigPrimary.length > 0 && remainingRuntimePrimary.length > 0) {
    matchPool(remainingConfigPrimary, remainingRuntimePrimary, opts.minGlobalConfidence);
  }

  // 4. Recovery pass: relax the global threshold by RECOVERY_THRESHOLD_RELAXATION
  //    but only emit pairs whose score-margin over the best alternative is
  //    above RECOVERY_REQUIRED_MARGIN. This recovers the obviously-correct
  //    leftovers (one config object with one clearly-best runtime survivor)
  //    without admitting genuinely ambiguous near-ties.
  const recoveryThreshold = Math.max(
    0,
    opts.minGlobalConfidence - RECOVERY_THRESHOLD_RELAXATION
  );
  if (recoveryThreshold < opts.minGlobalConfidence) {
    const remainingConfigRecovery = configObjects.filter((o) => unmatchedConfig.has(o.objectId));
    const remainingRuntimeRecovery = runtimeObjects.filter((o) =>
      unmatchedRuntime.has(o.objectId)
    );
    if (remainingConfigRecovery.length > 0 && remainingRuntimeRecovery.length > 0) {
      const recoveryAssignments = assignPool(
        remainingConfigRecovery,
        remainingRuntimeRecovery,
        recoveryThreshold
      ).filter((a) => a.score - a.bestRivalScore > RECOVERY_REQUIRED_MARGIN);
      if (recoveryAssignments.length > 0) {
        notes.push(
          `recovery pass admitted ${recoveryAssignments.length} match(es) ` +
            `at relaxed threshold ${recoveryThreshold.toFixed(2)} ` +
            `(margin > ${RECOVERY_REQUIRED_MARGIN.toFixed(2)})`
        );
        emitAssignments(
          remainingConfigRecovery,
          remainingRuntimeRecovery,
          recoveryAssignments
        );
      }
    }
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
