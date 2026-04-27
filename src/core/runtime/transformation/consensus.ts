/**
 * Consensus and level-summary computation for the Transformation Model.
 *
 * Inputs: a list of object matches plus the source StructuralPages. Outputs:
 * level summaries (border, refined-border, object, parent-chain) and a single
 * page-level consensus block.
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
  rectArea,
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
  scaleOutlierTolerance: 0.15,
  translateOutlierTolerance: 0.08,
  minMatchesForConsensus: 1
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

interface WeightedMatch {
  match: TransformationObjectMatch;
  configRect: { xNorm: number; yNorm: number; wNorm: number; hNorm: number };
  runtimeRect: { xNorm: number; yNorm: number; wNorm: number; hNorm: number };
  weight: number;
}

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
    const area = rectArea(c.objectRectNorm);
    const weight = Math.max(1e-6, match.confidence * Math.sqrt(area));
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

const splitOutliers = (
  entries: WeightedMatch[],
  reference: TransformationAffine,
  options: Required<ConsensusOptions>
): { kept: WeightedMatch[]; outliers: { entry: WeightedMatch; reason: string }[] } => {
  const kept: WeightedMatch[] = [];
  const outliers: { entry: WeightedMatch; reason: string }[] = [];
  for (const entry of entries) {
    const { scaleDelta, translateDelta } = affineDistance(entry.match.transform, reference);
    if (scaleDelta > options.scaleOutlierTolerance) {
      outliers.push({
        entry,
        reason: `scale deviation ${scaleDelta.toFixed(3)} exceeds tolerance ${options.scaleOutlierTolerance.toFixed(
          3
        )}`
      });
      continue;
    }
    if (translateDelta > options.translateOutlierTolerance) {
      outliers.push({
        entry,
        reason: `translate deviation ${translateDelta.toFixed(3)} exceeds tolerance ${options.translateOutlierTolerance.toFixed(
          3
        )}`
      });
      continue;
    }
    kept.push(entry);
  }
  return { kept, outliers };
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

  const initialMean = weightedMeanAffine(entries);
  if (!initialMean) {
    return {
      level,
      transform: null,
      confidence: 0,
      contributingMatchCount: 0,
      notes: [],
      warnings: [`could not compute weighted mean for ${level} level`]
    };
  }

  const { kept } = splitOutliers(entries, initialMean, options);
  const refined = kept.length > 0 ? weightedMeanAffine(kept) ?? initialMean : initialMean;
  const contributing = kept.length > 0 ? kept : entries;
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

  if (entries.length === 0) {
    return {
      transform: null,
      confidence: 0,
      contributingMatchCount: 0,
      outliers: [],
      notes: ['no object matches available for consensus'],
      warnings: []
    };
  }

  const initialMean = weightedMeanAffine(entries);
  if (!initialMean) {
    return {
      transform: null,
      confidence: 0,
      contributingMatchCount: 0,
      outliers: [],
      notes: [],
      warnings: ['could not compute initial weighted-mean consensus']
    };
  }

  const { kept, outliers } = splitOutliers(entries, initialMean, opts);
  const consensus = kept.length > 0 ? weightedMeanAffine(kept) ?? initialMean : initialMean;
  const contributing = kept.length > 0 ? kept : entries;

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
    `weight coverage: ${coverage.toFixed(3)}`,
    `projection agreement (avg IoU): ${projection.toFixed(3)}`
  ];
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
    notes,
    warnings
  };
};
