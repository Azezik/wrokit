/**
 * Consensus and level-summary computation for the Transformation Model.
 *
 * Inputs: a list of object matches plus the source StructuralPages. Outputs:
 * level summaries (border, refined-border, object, parent-chain) and a single
 * page-level consensus block.
 *
 * Consensus strategy: maximum inlier set (RANSAC-style). For each match's
 * implied affine, count how many other matches' affines agree within
 * tolerance; the affine with the largest agreeing subset (with weighted total
 * as tiebreaker) seeds the consensus, and the agreeing subset is then averaged
 * via weighted mean to refine the seed. Disagreeing matches become outliers.
 *
 * This implements the object-hierarchy intuition that the highest authority
 * is the largest subset of objects whose pairwise relative geometry is
 * preserved across config and runtime, even when other (heavier-weighted)
 * objects move inconsistently. The earlier "weighted-mean → reject outliers
 * from the mean" approach was fragile in exactly that scenario, because a
 * single high-weight bad match could drag the mean far enough to make the
 * truly-agreeing subset look like outliers.
 *
 * Honesty rules:
 * - Never invents an object. Operates only on the matches the matcher emitted.
 * - Outliers are reported, not removed silently.
 * - When data is insufficient, transforms are null and confidence is 0.
 */

import type {
  StructuralObjectNode,
  StructuralPage
} from '../../contracts/structural-model';
import type {
  TransformationAffine,
  TransformationConsensus,
  TransformationConsensusOutlier,
  TransformationLevelSummary,
  TransformationMatchLevel,
  TransformationObjectMatch
} from '../../contracts/transformation-model';
import {
  affineDistance,
  affineFromRects,
  applyAffineToRect,
  iouOfRects,
  subtractAffine
} from './transform-math';

export interface ConsensusOptions {
  /**
   * Maximum allowed per-axis scale deviation from the weighted mean before a
   * match is flagged as an outlier.
   */
  scaleOutlierTolerance?: number;
  /**
   * Maximum allowed per-axis translate deviation from the weighted mean before
   * a match is flagged as an outlier.
   */
  translateOutlierTolerance?: number;
  /**
   * Minimum non-outlier match count required to emit a non-null consensus
   * transform on a page.
   */
  minMatchesForConsensus?: number;
}

const DEFAULTS: Required<ConsensusOptions> = {
  // Widened from 0.05 / 0.03 so that matches participating in a coherent
  // regional shift (e.g. a row of cells that all moved by ~0.04 normalized
  // units) cluster together in a secondary inlier set instead of each
  // becoming a one-off outlier. The earlier tight values caused the RANSAC
  // search to lock onto an identity-like background of unmoved objects and
  // discard the real shift signal entirely.
  scaleOutlierTolerance: 0.1,
  translateOutlierTolerance: 0.06,
  minMatchesForConsensus: 1
};

/**
 * Maximum per-parameter deviation from identity for an affine to be
 * considered "near-identity". Used to detect the case where the largest
 * inlier set is essentially "nothing moved" and a smaller-but-coherent
 * regional shift is the actually-interesting signal.
 */
const NEAR_IDENTITY_THRESHOLD = 0.005;

const isNearIdentityAffine = (t: TransformationAffine, threshold = NEAR_IDENTITY_THRESHOLD): boolean =>
  Math.abs(t.scaleX - 1) <= threshold &&
  Math.abs(t.scaleY - 1) <= threshold &&
  Math.abs(t.translateX) <= threshold &&
  Math.abs(t.translateY) <= threshold;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

interface WeightedMatch {
  match: TransformationObjectMatch;
  configRect: { xNorm: number; yNorm: number; wNorm: number; hNorm: number };
  runtimeRect: { xNorm: number; yNorm: number; wNorm: number; hNorm: number };
  weight: number;
}

/**
 * Build per-match weights for consensus.
 *
 * Trust-weighted (confidence²), NOT area-weighted. The earlier
 * `confidence × √area` formula let a single large-but-mediocre rectangle
 * dominate the consensus mean even after RANSAC had identified a clean
 * inlier set: the largest rect's vote could outweigh several smaller-but-
 * tighter agreers. After RANSAC has confirmed that a subset of matches
 * agree on geometry, the relevant question is "which of these do we trust
 * most?" — and the answer is confidence, not size. Squaring amplifies the
 * gap between a 0.95-confidence match and a 0.70-confidence match (0.90 vs
 * 0.49) so the refined mean leans on the strongest matches inside the
 * inlier set.
 *
 * `rectArea` is no longer imported here — this file used to import it solely
 * for the area-weight calculation.
 */
const buildWeightedMatches = (
  matches: ReadonlyArray<TransformationObjectMatch>,
  configObjects: ReadonlyMap<string, StructuralObjectNode>,
  runtimeObjects: ReadonlyMap<string, StructuralObjectNode>
): WeightedMatch[] => {
  const result: WeightedMatch[] = [];
  for (const match of matches) {
    const c = configObjects.get(match.configObjectId);
    const r = runtimeObjects.get(match.runtimeObjectId);
    if (!c || !r) {
      continue;
    }
    const weight = Math.max(1e-6, match.confidence * match.confidence);
    result.push({
      match,
      configRect: c.objectRectNorm,
      runtimeRect: r.objectRectNorm,
      weight
    });
  }
  return result;
};

const weightedMeanAffine = (entries: WeightedMatch[]): TransformationAffine | null => {
  if (entries.length === 0) {
    return null;
  }
  let totalWeight = 0;
  let sx = 0;
  let sy = 0;
  let tx = 0;
  let ty = 0;
  for (const { match, weight } of entries) {
    totalWeight += weight;
    sx += match.transform.scaleX * weight;
    sy += match.transform.scaleY * weight;
    tx += match.transform.translateX * weight;
    ty += match.transform.translateY * weight;
  }
  if (totalWeight < 1e-9) {
    return null;
  }
  return {
    scaleX: sx / totalWeight,
    scaleY: sy / totalWeight,
    translateX: tx / totalWeight,
    translateY: ty / totalWeight
  };
};

const weightedMeanConfidence = (entries: WeightedMatch[]): number => {
  if (entries.length === 0) {
    return 0;
  }
  let totalWeight = 0;
  let sum = 0;
  for (const { match, weight } of entries) {
    totalWeight += weight;
    sum += match.confidence * weight;
  }
  return totalWeight > 1e-9 ? sum / totalWeight : 0;
};

interface InlierPartition {
  /**
   * The match whose own affine was used as the seed hypothesis. The "winning"
   * inlier set is the set of matches whose transforms agree (within tolerance)
   * with this hypothesis.
   */
  seedTransform: TransformationAffine;
  seedConfigObjectId: string;
  kept: WeightedMatch[];
  outliers: { entry: WeightedMatch; reason: string }[];
}

const partitionAgainstHypothesis = (
  entries: WeightedMatch[],
  hypothesis: TransformationAffine,
  options: Required<ConsensusOptions>,
  seedLabel: string
): { kept: WeightedMatch[]; outliers: { entry: WeightedMatch; reason: string }[]; weight: number } => {
  const kept: WeightedMatch[] = [];
  const outliers: { entry: WeightedMatch; reason: string }[] = [];
  let weight = 0;
  for (const entry of entries) {
    const { scaleDelta, translateDelta } = affineDistance(entry.match.transform, hypothesis);
    if (scaleDelta > options.scaleOutlierTolerance) {
      outliers.push({
        entry,
        reason: `scale deviation ${scaleDelta.toFixed(3)} exceeds tolerance ${options.scaleOutlierTolerance.toFixed(
          3
        )} from inlier set seeded by ${seedLabel}`
      });
      continue;
    }
    if (translateDelta > options.translateOutlierTolerance) {
      outliers.push({
        entry,
        reason: `translate deviation ${translateDelta.toFixed(3)} exceeds tolerance ${options.translateOutlierTolerance.toFixed(
          3
        )} from inlier set seeded by ${seedLabel}`
      });
      continue;
    }
    kept.push(entry);
    weight += entry.weight;
  }
  return { kept, outliers, weight };
};

interface InlierSearchResult {
  /**
   * The largest mutually-consistent subset of matches — the global background
   * consensus. This is what feeds the page-level transform.
   */
  primary: InlierPartition;
  /**
   * Competing inlier sets that disagree with the primary and carry a
   * non-near-identity affine. Populated only when the primary is itself
   * near-identity (i.e. the page-wide background didn't move) and a coherent
   * regional shift exists in a smaller subset of size ≥ 2. Empty otherwise.
   */
  regionals: InlierPartition[];
}

/**
 * Find the largest mutually-consistent subset of matches (RANSAC-style maximum
 * inlier search). For each match's own implied affine we count how many other
 * matches' affines agree within tolerance; the affine with the most agreeing
 * matches (with weighted total as tiebreaker) is the seed. The remainder are
 * outliers — matches whose transforms disagree with the dominant subset.
 *
 * This replaces the old "weighted-mean → reject outliers from the mean" path,
 * which was fragile when a single high-weight bad match dragged the mean far
 * enough to make the truly-agreeing matches look like outliers. The user-facing
 * intuition this captures: when several objects keep the same relative
 * positions / sizes / spacing across config and runtime, that subset is the
 * authoritative reference even if other (heavier-weighted) objects move
 * inconsistently.
 *
 * Two-tier reporting: when the largest inlier set is near-identity AND a
 * competing inlier set of size ≥ 2 has a non-trivial transform, both are
 * surfaced. The primary still seeds the page consensus (most of the page
 * really didn't move), but the secondary "regional" sets carry the real shift
 * signal for the cells that did move — without that, a coherent group of
 * shifted matches gets silently discarded as outliers and downstream BBOXes
 * are misplaced.
 *
 * Falls back to the trivial single-entry case when only one match exists.
 */
const findMaxInlierSet = (
  entries: WeightedMatch[],
  options: Required<ConsensusOptions>
): InlierSearchResult | null => {
  if (entries.length === 0) {
    return null;
  }
  if (entries.length === 1) {
    const only = entries[0];
    return {
      primary: {
        seedTransform: only.match.transform,
        seedConfigObjectId: only.match.configObjectId,
        kept: [only],
        outliers: []
      },
      regionals: []
    };
  }

  const candidates: Array<{
    seedTransform: TransformationAffine;
    seedConfigObjectId: string;
    kept: WeightedMatch[];
    outliers: { entry: WeightedMatch; reason: string }[];
    weight: number;
  }> = entries.map((candidate) => {
    const partition = partitionAgainstHypothesis(
      entries,
      candidate.match.transform,
      options,
      candidate.match.configObjectId
    );
    return {
      seedTransform: candidate.match.transform,
      seedConfigObjectId: candidate.match.configObjectId,
      kept: partition.kept,
      outliers: partition.outliers,
      weight: partition.weight
    };
  });

  // Rank: largest agreeing subset by count, then by weighted total
  // (area×confidence) so that, when two subsets tie on count, the one
  // covering more of the page wins. Deterministic id ordering breaks the
  // last tie so test runs are stable.
  candidates.sort((a, b) => {
    if (b.kept.length !== a.kept.length) {
      return b.kept.length - a.kept.length;
    }
    if (b.weight !== a.weight) {
      return b.weight - a.weight;
    }
    return a.seedConfigObjectId.localeCompare(b.seedConfigObjectId);
  });

  const best = candidates[0];
  const primary: InlierPartition = {
    seedTransform: best.seedTransform,
    seedConfigObjectId: best.seedConfigObjectId,
    kept: best.kept,
    outliers: best.outliers
  };

  const regionals: InlierPartition[] = [];
  const refinedPrimary = weightedMeanAffine(best.kept) ?? best.seedTransform;
  if (isNearIdentityAffine(refinedPrimary)) {
    // Primary is "nothing moved". Look for coherent regional shifts: a
    // competing inlier set of size ≥ 2 whose refined transform is not
    // near-identity. Dedupe so multiple seeds within the same regional
    // cluster don't each surface as a separate alternate.
    const reported = new Set<string>();
    for (const c of candidates) {
      if (c === best) {
        continue;
      }
      if (c.kept.length < 2) {
        continue;
      }
      const refined = weightedMeanAffine(c.kept) ?? c.seedTransform;
      if (isNearIdentityAffine(refined)) {
        continue;
      }
      if (reported.has(c.seedConfigObjectId)) {
        continue;
      }
      regionals.push({
        seedTransform: c.seedTransform,
        seedConfigObjectId: c.seedConfigObjectId,
        kept: c.kept,
        outliers: c.outliers
      });
      for (const k of c.kept) {
        reported.add(k.match.configObjectId);
      }
    }
  }

  return { primary, regionals };
};

const projectionAgreement = (
  consensus: TransformationAffine,
  entries: WeightedMatch[]
): number => {
  if (entries.length === 0) {
    return 0;
  }
  let totalWeight = 0;
  let weightedSum = 0;
  for (const entry of entries) {
    const projected = applyAffineToRect(entry.configRect, consensus);
    const iou = iouOfRects(projected, entry.runtimeRect);
    totalWeight += entry.weight;
    weightedSum += iou * entry.weight;
  }
  return totalWeight > 1e-9 ? weightedSum / totalWeight : 0;
};

const summarizeFromMatches = (
  level: TransformationMatchLevel,
  entries: WeightedMatch[],
  options: Required<ConsensusOptions>
): TransformationLevelSummary => {
  if (entries.length === 0) {
    return {
      level,
      transform: null,
      confidence: 0,
      contributingMatchCount: 0,
      notes: [`no matches available for ${level} level`],
      warnings: []
    };
  }

  const inlierResult = findMaxInlierSet(entries, options);
  if (!inlierResult) {
    return {
      level,
      transform: null,
      confidence: 0,
      contributingMatchCount: 0,
      notes: [],
      warnings: [`could not find an inlier subset for ${level} level`]
    };
  }

  const inlier = inlierResult.primary;
  const refined = weightedMeanAffine(inlier.kept) ?? inlier.seedTransform;
  const contributing = inlier.kept;
  const meanConfidence = weightedMeanConfidence(contributing);
  const projection = projectionAgreement(refined, contributing);
  const confidence = clamp01(meanConfidence * (0.5 + 0.5 * projection));

  const notes: string[] = [
    `${contributing.length} of ${entries.length} match(es) contributed to ${level} summary`,
    `projection agreement (avg IoU): ${projection.toFixed(3)}`
  ];
  const warnings: string[] = [];
  if (contributing.length === 1) {
    warnings.push(`${level} summary derived from a single match — limited cross-validation`);
  }
  if (projection < 0.5 && contributing.length > 0) {
    warnings.push(
      `${level} consensus projects config rects to runtime with low IoU (${projection.toFixed(3)})`
    );
  }

  return {
    level,
    transform: refined,
    confidence,
    contributingMatchCount: contributing.length,
    notes,
    warnings
  };
};

const trivialPairTransform = (
  config: { rectNorm: { xNorm: number; yNorm: number; wNorm: number; hNorm: number } },
  runtime: { rectNorm: { xNorm: number; yNorm: number; wNorm: number; hNorm: number } }
): TransformationAffine => affineFromRects(config.rectNorm, runtime.rectNorm);

export const computeBorderLevelSummary = (
  configPage: StructuralPage,
  runtimePage: StructuralPage
): TransformationLevelSummary => {
  const transform = trivialPairTransform(configPage.border, runtimePage.border);
  return {
    level: 'border',
    transform,
    confidence: 1,
    contributingMatchCount: 1,
    notes: ['border is always a trivial 1:1 pair (full normalized page)'],
    warnings: []
  };
};

const refinedBorderConfidence = (
  source: StructuralPage['refinedBorder']['source']
): number => {
  switch (source) {
    case 'cv-content':
      return 0.95;
    case 'cv-and-bbox-union':
      return 0.85;
    case 'bbox-union':
      return 0.7;
    case 'full-page-fallback':
      return 0.4;
  }
};

export const computeRefinedBorderLevelSummary = (
  configPage: StructuralPage,
  runtimePage: StructuralPage
): TransformationLevelSummary => {
  const transform = trivialPairTransform(configPage.refinedBorder, runtimePage.refinedBorder);
  const confidence = clamp01(
    Math.min(
      refinedBorderConfidence(configPage.refinedBorder.source),
      refinedBorderConfidence(runtimePage.refinedBorder.source)
    )
  );
  const notes: string[] = [
    `config refined border source: ${configPage.refinedBorder.source}`,
    `runtime refined border source: ${runtimePage.refinedBorder.source}`
  ];
  const warnings: string[] = [];
  if (
    configPage.refinedBorder.source === 'full-page-fallback' ||
    runtimePage.refinedBorder.source === 'full-page-fallback'
  ) {
    warnings.push('refined border was a full-page fallback on at least one side');
  }
  return {
    level: 'refined-border',
    transform,
    confidence,
    contributingMatchCount: 1,
    notes,
    warnings
  };
};

const indexObjects = (page: StructuralPage): Map<string, StructuralObjectNode> =>
  new Map(page.objectHierarchy.objects.map((o) => [o.objectId, o]));

export const computeObjectLevelSummary = (
  matches: ReadonlyArray<TransformationObjectMatch>,
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  options: ConsensusOptions = {}
): TransformationLevelSummary => {
  const opts = { ...DEFAULTS, ...options };
  const entries = buildWeightedMatches(matches, indexObjects(configPage), indexObjects(runtimePage));
  return summarizeFromMatches('object', entries, opts);
};

export const computeParentChainLevelSummary = (
  matches: ReadonlyArray<TransformationObjectMatch>,
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  options: ConsensusOptions = {}
): TransformationLevelSummary => {
  const opts = { ...DEFAULTS, ...options };
  const filtered = matches.filter((m) => m.basis.includes('parent-chain'));
  const entries = buildWeightedMatches(
    filtered,
    indexObjects(configPage),
    indexObjects(runtimePage)
  );
  return summarizeFromMatches('parent-chain', entries, opts);
};

export const __testing = {
  findMaxInlierSet
};

export const computeConsensus = (
  matches: ReadonlyArray<TransformationObjectMatch>,
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  options: ConsensusOptions = {}
): TransformationConsensus => {
  const opts = { ...DEFAULTS, ...options };
  const entries = buildWeightedMatches(
    matches,
    indexObjects(configPage),
    indexObjects(runtimePage)
  );

  // Per-match local transforms — exposed so downstream consumers can ask
  // "what transform was actually recorded for THIS object?" without going
  // through the page-wide consensus. Built from every weighted match,
  // independent of inlier-set membership; outliers are still included here
  // because their individual signal may matter even when they disagree with
  // the page background.
  const localTransforms: Record<string, TransformationAffine> = {};
  for (const entry of entries) {
    localTransforms[entry.match.configObjectId] = entry.match.transform;
  }

  if (entries.length === 0) {
    return {
      transform: null,
      confidence: 0,
      contributingMatchCount: 0,
      outliers: [],
      localTransforms,
      regionalTransforms: [],
      notes: ['no object matches available for consensus'],
      warnings: []
    };
  }

  const inlierResult = findMaxInlierSet(entries, opts);
  if (!inlierResult) {
    return {
      transform: null,
      confidence: 0,
      contributingMatchCount: 0,
      outliers: [],
      localTransforms,
      regionalTransforms: [],
      notes: [],
      warnings: ['could not find an inlier subset for consensus']
    };
  }

  const inlier = inlierResult.primary;
  const consensus = weightedMeanAffine(inlier.kept) ?? inlier.seedTransform;
  const contributing = inlier.kept;
  const outliers = inlier.outliers;

  const regionalTransforms: TransformationAffine[] = inlierResult.regionals.map(
    (r) => weightedMeanAffine(r.kept) ?? r.seedTransform
  );

  const reportedOutliers: TransformationConsensusOutlier[] = outliers.map((o) => ({
    configObjectId: o.entry.match.configObjectId,
    runtimeObjectId: o.entry.match.runtimeObjectId,
    reason: o.reason,
    deltaFromConsensus: subtractAffine(o.entry.match.transform, consensus)
  }));

  if (contributing.length < opts.minMatchesForConsensus) {
    return {
      transform: null,
      confidence: 0,
      contributingMatchCount: contributing.length,
      outliers: reportedOutliers,
      localTransforms,
      regionalTransforms,
      notes: [
        `only ${contributing.length} match(es) survived outlier rejection (minimum ${opts.minMatchesForConsensus})`
      ],
      warnings: ['insufficient agreement to form a consensus transform']
    };
  }

  const totalWeight = entries.reduce((acc, e) => acc + e.weight, 0);
  const keptWeight = contributing.reduce((acc, e) => acc + e.weight, 0);
  const coverage = totalWeight > 1e-9 ? keptWeight / totalWeight : 0;
  const meanConfidence = weightedMeanConfidence(contributing);
  const projection = projectionAgreement(consensus, contributing);
  const confidence = clamp01(meanConfidence * (0.4 + 0.3 * coverage + 0.3 * projection));

  const notes: string[] = [
    `${contributing.length} of ${entries.length} match(es) contributed to consensus`,
    `inlier set seeded by ${inlier.seedConfigObjectId}`,
    `weight coverage: ${coverage.toFixed(3)}`,
    `projection agreement (avg IoU): ${projection.toFixed(3)}`
  ];
  if (regionalTransforms.length > 0) {
    notes.push(
      `surfaced ${regionalTransforms.length} regional shift(s) that disagree with the near-identity primary`
    );
  }
  const warnings: string[] = [];
  if (reportedOutliers.length > 0) {
    warnings.push(`${reportedOutliers.length} outlier match(es) excluded from consensus`);
  }
  if (contributing.length === 1) {
    warnings.push('consensus formed from a single match — no cross-validation possible');
  }
  if (projection < 0.5) {
    warnings.push(
      `consensus transform projects config rects to runtime with low IoU (${projection.toFixed(3)})`
    );
  }

  return {
    transform: consensus,
    confidence,
    contributingMatchCount: contributing.length,
    outliers: reportedOutliers,
    localTransforms,
    regionalTransforms,
    notes,
    warnings
  };
};
