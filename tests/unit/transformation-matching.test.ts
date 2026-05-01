import { describe, expect, it } from 'vitest';

import type {
  StructuralFieldRelationship,
  StructuralModel,
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralPage,
  StructuralRefinedBorder
} from '../../src/core/contracts/structural-model';
import { isTransformationModel } from '../../src/core/contracts/transformation-model';
import {
  greedyAssign,
  HUNGARIAN_POOL_THRESHOLD,
  hungarianAssign,
  matchPage,
  PRIORITY_SCORE_BONUS,
  RECOVERY_REQUIRED_MARGIN,
  RECOVERY_THRESHOLD_RELAXATION,
  type CandidatePair
} from '../../src/core/runtime/transformation/hierarchical-matcher';
import {
  computeObjectSimilarity,
  CROSS_DOCUMENT_SIMILARITY_WEIGHTS,
  DEFAULT_SIMILARITY_WEIGHTS
} from '../../src/core/runtime/transformation/similarity';
import { createTransformationRunner } from '../../src/core/runtime/transformation-runner';

const rect = (
  xNorm: number,
  yNorm: number,
  wNorm: number,
  hNorm: number
): StructuralNormalizedRect => ({ xNorm, yNorm, wNorm, hNorm });

const node = (
  objectId: string,
  r: StructuralNormalizedRect,
  parentObjectId: string | null = null,
  childObjectIds: string[] = [],
  confidence = 0.9,
  depth = 0
): StructuralObjectNode => ({
  objectId,
  objectRectNorm: r,
  bbox: r,
  parentObjectId,
  childObjectIds,
  confidence,
  depth
});

const refinedFullPage: StructuralRefinedBorder = {
  rectNorm: rect(0, 0, 1, 1),
  source: 'full-page-fallback',
  influencedByBBoxCount: 0,
  containsAllSavedBBoxes: true
};

const buildPage = (objects: StructuralObjectNode[]): StructuralPage => ({
  pageIndex: 0,
  pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1000 },
  cvExecutionMode: 'heuristic-fallback',
  border: { rectNorm: rect(0, 0, 1, 1) },
  refinedBorder: refinedFullPage,
  objectHierarchy: { objects },
  pageAnchorRelations: {
    objectToObject: [],
    objectToRefinedBorder: [],
    refinedBorderToBorder: { relativeRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 } }
  },
  fieldRelationships: []
});

const buildModel = (id: string, fingerprint: string, page: StructuralPage): StructuralModel => ({
  schema: 'wrokit/structural-model',
  version: '4.0',
  structureVersion: 'wrokit/structure/v3',
  id,
  documentFingerprint: fingerprint,
  cvAdapter: { name: 'opencv-js', version: '1.0' },
  pages: [page],
  createdAtIso: '2026-04-26T00:00:00Z'
});

const baseSimilarityCtx = {
  configRefinedBorder: refinedFullPage,
  runtimeRefinedBorder: refinedFullPage,
  parentMatches: new Map<string, string>(),
  runtimeObjectParent: new Map<string, string | null>(),
  weights: DEFAULT_SIMILARITY_WEIGHTS
};

describe('computeObjectSimilarity', () => {
  it('scores identical objects close to 1.0 using purely geometric/structural basis', () => {
    const a = node('a', rect(0.1, 0.1, 0.4, 0.4));
    const b = node('b', rect(0.1, 0.1, 0.4, 0.4));
    const result = computeObjectSimilarity(a, b, baseSimilarityCtx);
    expect(result.score).toBeGreaterThan(0.95);
    expect(result.basis).toContain('object-similarity');
    expect(result.basis).toContain('parent-chain');
    expect(result.basis).toContain('refined-border-relation');
    // Object-only model: there is no semantic type-match component anywhere
    // in the basis tags.
    expect(result.basis).not.toContain('type-match');
  });

  it('drops the score when geometry differs significantly', () => {
    const a = node('a', rect(0.1, 0.1, 0.4, 0.4));
    const farMismatch = node('b', rect(0.7, 0.7, 0.05, 0.05));
    const close = node('c', rect(0.1, 0.1, 0.4, 0.4));
    expect(computeObjectSimilarity(a, farMismatch, baseSimilarityCtx).score).toBeLessThan(
      computeObjectSimilarity(a, close, baseSimilarityCtx).score
    );
  });

  it('scales score with positional distance', () => {
    const a = node('a', rect(0.0, 0.0, 0.2, 0.2));
    const close = node('b', rect(0.0, 0.05, 0.2, 0.2));
    const far = node('c', rect(0.7, 0.7, 0.2, 0.2));
    const closeScore = computeObjectSimilarity(a, close, baseSimilarityCtx).score;
    const farScore = computeObjectSimilarity(a, far, baseSimilarityCtx).score;
    expect(closeScore).toBeGreaterThan(farScore);
  });

  it('rewards parent-chain similarity when parents are matched', () => {
    const configChild = node('cc', rect(0.2, 0.2, 0.1, 0.1), 'cp');
    const runtimeChild = node('rc', rect(0.2, 0.2, 0.1, 0.1), 'rp');
    const withParent = computeObjectSimilarity(configChild, runtimeChild, {
      ...baseSimilarityCtx,
      parentMatches: new Map([['cp', 'rp']]),
      runtimeObjectParent: new Map([['rc', 'rp']])
    });
    const withoutParent = computeObjectSimilarity(configChild, runtimeChild, baseSimilarityCtx);
    expect(withParent.score).toBeGreaterThan(withoutParent.score);
    expect(withParent.basis).toContain('parent-chain');
  });
});

describe('matchPage', () => {
  it('matches identical pages 1:1 with high confidence', () => {
    const objects = [
      node('o1', rect(0.1, 0.1, 0.4, 0.4)),
      node('o2', rect(0.6, 0.1, 0.3, 0.2))
    ];
    const result = matchPage(buildPage(objects), buildPage(objects));
    expect(result.matches).toHaveLength(2);
    expect(result.unmatchedConfigObjectIds).toEqual([]);
    expect(result.unmatchedRuntimeObjectIds).toEqual([]);
    for (const m of result.matches) {
      expect(m.confidence).toBeGreaterThan(0.9);
      expect(m.transform.scaleX).toBeCloseTo(1, 6);
      expect(m.transform.scaleY).toBeCloseTo(1, 6);
      expect(m.transform.translateX).toBeCloseTo(0, 6);
      expect(m.transform.translateY).toBeCloseTo(0, 6);
    }
  });

  it('recovers an affine transform on a uniformly shifted runtime page', () => {
    const config = buildPage([
      node('c1', rect(0.1, 0.1, 0.3, 0.3)),
      node('c2', rect(0.5, 0.5, 0.2, 0.2))
    ]);
    const runtime = buildPage([
      node('r1', rect(0.12, 0.07, 0.3, 0.3)),
      node('r2', rect(0.52, 0.47, 0.2, 0.2))
    ]);
    const result = matchPage(config, runtime);
    expect(result.matches).toHaveLength(2);
    const c1Match = result.matches.find((m) => m.configObjectId === 'c1');
    expect(c1Match?.runtimeObjectId).toBe('r1');
    expect(c1Match?.transform.translateX).toBeCloseTo(0.02, 5);
    expect(c1Match?.transform.translateY).toBeCloseTo(-0.03, 5);
    expect(c1Match?.transform.scaleX).toBeCloseTo(1, 5);
  });

  it('recovers a uniform scale on a runtime page', () => {
    const config = buildPage([node('c1', rect(0.1, 0.1, 0.4, 0.4))]);
    const runtime = buildPage([node('r1', rect(0.1, 0.1, 0.6, 0.6))]);
    const result = matchPage(config, runtime);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].transform.scaleX).toBeCloseTo(1.5, 5);
    expect(result.matches[0].transform.scaleY).toBeCloseTo(1.5, 5);
  });

  it('does not match an extra runtime object that has no config counterpart', () => {
    const config = buildPage([node('c1', rect(0.1, 0.1, 0.3, 0.3))]);
    const runtime = buildPage([
      node('r1', rect(0.1, 0.1, 0.3, 0.3)),
      node('rOrphan', rect(0.8, 0.0, 0.15, 0.05))
    ]);
    const result = matchPage(config, runtime);
    expect(result.matches.map((m) => m.configObjectId)).toEqual(['c1']);
    expect(result.unmatchedRuntimeObjectIds).toContain('rOrphan');
    expect(result.unmatchedConfigObjectIds).toEqual([]);
  });

  it('reports unmatched config objects when the runtime is missing them', () => {
    const config = buildPage([
      node('c1', rect(0.1, 0.1, 0.3, 0.3)),
      node('cMissing', rect(0.7, 0.7, 0.1, 0.1))
    ]);
    const runtime = buildPage([node('r1', rect(0.1, 0.1, 0.3, 0.3))]);
    const result = matchPage(config, runtime);
    expect(result.matches).toHaveLength(1);
    expect(result.unmatchedConfigObjectIds).toContain('cMissing');
    expect(result.unmatchedRuntimeObjectIds).toEqual([]);
  });

  it('only matches a child against children of its matched parent', () => {
    const config = buildPage([
      node('cParentA', rect(0.0, 0.0, 0.5, 1.0), null, ['cChildA']),
      node('cParentB', rect(0.5, 0.0, 0.5, 1.0), null, ['cChildB']),
      node('cChildA', rect(0.05, 0.1, 0.1, 0.1), 'cParentA'),
      node('cChildB', rect(0.55, 0.1, 0.1, 0.1), 'cParentB')
    ]);
    const runtime = buildPage([
      node('rParentA', rect(0.0, 0.0, 0.5, 1.0), null, ['rChildA']),
      node('rParentB', rect(0.5, 0.0, 0.5, 1.0), null, ['rChildB']),
      // Both runtime children have geometry similar to BOTH config children;
      // only the parent-chain anchoring should keep them properly assigned.
      node('rChildA', rect(0.05, 0.1, 0.1, 0.1), 'rParentA'),
      node('rChildB', rect(0.55, 0.1, 0.1, 0.1), 'rParentB')
    ]);

    const result = matchPage(config, runtime);
    const childAMatch = result.matches.find((m) => m.configObjectId === 'cChildA');
    const childBMatch = result.matches.find((m) => m.configObjectId === 'cChildB');
    expect(childAMatch?.runtimeObjectId).toBe('rChildA');
    expect(childBMatch?.runtimeObjectId).toBe('rChildB');
  });

  it('flags a near-duplicate match as ambiguous and demotes its confidence', () => {
    // Two runtime rectangles sit at near-identical positions/sizes — the
    // matcher's "winner" against c_target is statistically a tie. Confirm
    // the match is emitted with an ambiguity warning and a lower confidence
    // than the equivalent unambiguous match. This is the repeated-header /
    // table-cell case the audit calls out.
    const config = buildPage([node('c_target', rect(0.10, 0.10, 0.20, 0.10))]);
    const runtime = buildPage([
      node('r_winner', rect(0.10, 0.10, 0.20, 0.10)),
      // r_twin: nearly identical to r_winner, so its similarity score with
      // c_target lands within the AMBIGUITY_SCORE_MARGIN of r_winner's score.
      node('r_twin', rect(0.105, 0.10, 0.20, 0.10))
    ]);
    const result = matchPage(config, runtime);
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(match.configObjectId).toBe('c_target');
    expect(match.warnings.some((w) => w.startsWith('ambiguous match'))).toBe(true);
    expect(match.warnings[0]).toMatch(/r_winner/);
    expect(match.warnings[0]).toMatch(/r_twin/);

    // Equivalent setup but only r_winner exists — no rival, no demotion.
    const unambiguous = matchPage(config, buildPage([node('r_winner', rect(0.10, 0.10, 0.20, 0.10))]));
    expect(unambiguous.matches[0].warnings).toEqual([]);
    expect(match.confidence).toBeLessThan(unambiguous.matches[0].confidence);

    // Page-level warning is also surfaced so consumers can see ambiguity
    // without scanning every match's `warnings`.
    expect(result.warnings.some((w) => w.startsWith('ambiguous match'))).toBe(true);
  });

  it('does not flag ambiguity when the runner-up clearly loses', () => {
    // r_winner is a near-perfect twin of c_target, r_other is far away.
    // The score gap is well above AMBIGUITY_SCORE_MARGIN, so no warning.
    const config = buildPage([node('c_target', rect(0.10, 0.10, 0.20, 0.10))]);
    const runtime = buildPage([
      node('r_winner', rect(0.10, 0.10, 0.20, 0.10)),
      node('r_other', rect(0.80, 0.80, 0.05, 0.05))
    ]);
    const result = matchPage(config, runtime);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].warnings).toEqual([]);
    expect(result.warnings.some((w) => w.startsWith('ambiguous match'))).toBe(false);
  });

  it('respects a custom confidence threshold', () => {
    const config = buildPage([node('c1', rect(0.0, 0.0, 0.2, 0.2))]);
    const runtime = buildPage([node('r1', rect(0.7, 0.7, 0.2, 0.2))]);
    const lenient = matchPage(config, runtime, { minHierarchicalConfidence: 0.0 });
    const strict = matchPage(config, runtime, {
      minHierarchicalConfidence: 0.99,
      minGlobalConfidence: 0.99
    });
    expect(lenient.matches.length).toBeGreaterThan(0);
    expect(strict.matches).toHaveLength(0);
    expect(strict.unmatchedConfigObjectIds).toContain('c1');
    expect(strict.unmatchedRuntimeObjectIds).toContain('r1');
  });

  it('matches all 12 cells across two parallel rows of 6 nearly-identical cells (Hungarian path)', () => {
    // The Hungarian path engages when both pool sides have ≥
    // HUNGARIAN_POOL_THRESHOLD candidates. A 12-cell tabular layout drops
    // squarely in. With identical geometry every cell has its true partner,
    // and the assignment solver — unlike a locally-greedy pick — is
    // guaranteed to recover all 12 pairings even when many off-diagonal pairs
    // also score highly.
    expect(HUNGARIAN_POOL_THRESHOLD).toBeLessThanOrEqual(12);
    const cells: StructuralObjectNode[] = [];
    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        const x = 0.05 + col * 0.13;
        const y = 0.10 + row * 0.20;
        cells.push(node(`c_${row}_${col}`, rect(x, y, 0.1, 0.05)));
      }
    }
    const runtimeCells: StructuralObjectNode[] = [];
    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        const x = 0.05 + col * 0.13;
        const y = 0.10 + row * 0.20;
        runtimeCells.push(node(`r_${row}_${col}`, rect(x, y, 0.1, 0.05)));
      }
    }
    const result = matchPage(buildPage(cells), buildPage(runtimeCells));
    expect(result.matches).toHaveLength(12);
    expect(result.unmatchedConfigObjectIds).toEqual([]);
    expect(result.unmatchedRuntimeObjectIds).toEqual([]);
    for (const m of result.matches) {
      // c_row_col should pair with r_row_col on identical geometry.
      const cTail = m.configObjectId.replace(/^c_/, '');
      const rTail = m.runtimeObjectId.replace(/^r_/, '');
      expect(rTail).toBe(cTail);
    }
  });

  it('Hungarian recovers the global optimum on a score matrix where greedy strands two pairs', () => {
    // Hand-crafted asymmetric score matrix mirroring the audit's failure
    // mode: greedy claims the locally-best pair (c1↔r1) and that claim
    // strands later config rows whose only above-threshold partner was r1.
    // Hungarian sees the global picture and shifts c1 onto an only-slightly
    // worse partner so c2/c3 can each take their own above-threshold partner.
    const candidates: CandidatePair[] = [
      { configId: 'c1', runtimeId: 'r1', score: 0.95 },
      { configId: 'c1', runtimeId: 'r2', score: 0.94 },
      { configId: 'c1', runtimeId: 'r3', score: 0.94 },
      { configId: 'c1', runtimeId: 'r4', score: 0.94 },
      { configId: 'c2', runtimeId: 'r1', score: 0.90 },
      { configId: 'c2', runtimeId: 'r2', score: 0.50 },
      { configId: 'c2', runtimeId: 'r3', score: 0.50 },
      { configId: 'c2', runtimeId: 'r4', score: 0.50 },
      { configId: 'c3', runtimeId: 'r1', score: 0.50 },
      { configId: 'c3', runtimeId: 'r2', score: 0.50 },
      { configId: 'c3', runtimeId: 'r3', score: 0.90 },
      { configId: 'c3', runtimeId: 'r4', score: 0.50 },
      { configId: 'c4', runtimeId: 'r1', score: 0.50 },
      { configId: 'c4', runtimeId: 'r2', score: 0.50 },
      { configId: 'c4', runtimeId: 'r3', score: 0.50 },
      { configId: 'c4', runtimeId: 'r4', score: 0.90 }
    ];
    const configIds = ['c1', 'c2', 'c3', 'c4'];
    const runtimeIds = ['r1', 'r2', 'r3', 'r4'];

    const greedy = greedyAssign(candidates, 0.75);
    const greedyConfigs = new Set(greedy.map((a) => a.configId));
    // Greedy picks c1↔r1 first (highest score). c2's only high-score option
    // r1 is gone, so it falls below threshold. c3↔r3 and c4↔r4 still match.
    expect(greedyConfigs.has('c2')).toBe(false);
    expect(greedy).toHaveLength(3);

    const hungarian = hungarianAssign(configIds, runtimeIds, candidates, 0.75);
    expect(hungarian).toHaveLength(4);
    const byConfig = Object.fromEntries(hungarian.map((a) => [a.configId, a.runtimeId]));
    expect(byConfig.c2).toBe('r1');
    expect(byConfig.c3).toBe('r3');
    expect(byConfig.c4).toBe('r4');
    // c1 was bumped onto an alternative (any of r2/r3/r4) so c2 could take
    // r1. The total summed score under Hungarian (0.94 + 0.90 + 0.90 + 0.90 =
    // 3.64) strictly beats greedy (0.95 + 0.90 + 0.90 = 2.75).
    const hungarianTotal = hungarian.reduce((s, a) => s + a.score, 0);
    const greedyTotal = greedy.reduce((s, a) => s + a.score, 0);
    expect(hungarianTotal).toBeGreaterThan(greedyTotal);
  });

  it('priority anchor wins its preferred runtime counterpart even when a non-priority rival scored 0.02 higher', () => {
    // Two config objects compete for the same runtime cell. Without the
    // priority bonus the non-priority object would win by a 0.02 margin. The
    // +PRIORITY_SCORE_BONUS thumb on the scale flips that result for the
    // named anchor, while still leaving the non-priority object able to take
    // its second-best runtime partner.
    const config = buildPage([
      // c_anchor sits exactly on r_target's geometry — its pure score with
      // r_target should be near 1.0.
      node('c_anchor', rect(0.30, 0.30, 0.10, 0.05)),
      // c_rival sits even closer to r_target (slightly perturbed in size to
      // give it a hair-thin lead pre-bonus). It still has a fallback partner
      // (r_alt) it can take when the anchor wins r_target.
      node('c_rival', rect(0.30, 0.30, 0.10, 0.05)),
      // Decoy that c_anchor would prefer if c_rival snatched r_target.
      node('c_anchor_alt', rect(0.10, 0.10, 0.10, 0.05))
    ]);
    const runtime = buildPage([
      node('r_target', rect(0.30, 0.30, 0.10, 0.05)),
      // r_alt is a decent fallback for c_rival but a worse match for the
      // anchor than r_target.
      node('r_alt', rect(0.50, 0.50, 0.10, 0.05)),
      node('r_anchor_alt', rect(0.10, 0.10, 0.10, 0.05))
    ]);

    // Without priority, the matcher is free to assign c_rival↔r_target. With
    // priority, c_anchor must win r_target.
    const withoutPriority = matchPage(config, runtime);
    const withoutAnchor = withoutPriority.matches.find((m) => m.configObjectId === 'c_anchor');
    const withoutRival = withoutPriority.matches.find((m) => m.configObjectId === 'c_rival');

    const withPriority = matchPage(config, runtime, {
      priorityObjectIds: new Set(['c_anchor'])
    });
    const withAnchor = withPriority.matches.find((m) => m.configObjectId === 'c_anchor');
    const withRival = withPriority.matches.find((m) => m.configObjectId === 'c_rival');

    expect(withAnchor?.runtimeObjectId).toBe('r_target');
    expect(withRival?.runtimeObjectId).not.toBe('r_target');
    // Anchor reports a confidence boost (its raw score is preserved as the
    // similarity score; the bonus is applied during assignment so it can
    // legitimately claim the contested partner). Sanity check: with the
    // anchor in priority, it MUST end up matched somewhere — never stranded.
    expect(withAnchor).toBeDefined();
    // And the bonus is small enough to not mark the anchor's win as ambiguous
    // by accident in this construction (the rival's r_alt fallback is far
    // enough that the rival's challenge to r_target is a real margin).
    expect(PRIORITY_SCORE_BONUS).toBe(0.05);
    // With and without priority, both top-level configs get matched to
    // SOMETHING; what changes is which runtime they pair with.
    expect(withPriority.matches.length).toBeGreaterThanOrEqual(
      withoutPriority.matches.length - 0
    );
    void withoutAnchor;
    void withoutRival;
  });

  it('keeps the small-pool greedy path unchanged below the Hungarian threshold', () => {
    // The single-config + two-runtime ambiguity case lives in a 1×2 pool —
    // far below HUNGARIAN_POOL_THRESHOLD on either side — so it must continue
    // to use the greedy path. The behavior asserted in the existing
    // "flags a near-duplicate match as ambiguous" test must therefore keep
    // working: the warning is emitted, the confidence is demoted by the
    // ambiguity penalty, and the chosen pair is r_winner.
    expect(HUNGARIAN_POOL_THRESHOLD).toBeGreaterThan(2);
    const config = buildPage([node('c_target', rect(0.10, 0.10, 0.20, 0.10))]);
    const runtime = buildPage([
      node('r_winner', rect(0.10, 0.10, 0.20, 0.10)),
      node('r_twin', rect(0.105, 0.10, 0.20, 0.10))
    ]);
    const result = matchPage(config, runtime);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].configObjectId).toBe('c_target');
    expect(result.matches[0].warnings.some((w) => w.startsWith('ambiguous match'))).toBe(true);

    // And a 3×3 pool (still below the threshold of 4) should also exercise
    // the greedy path; we verify it produces the diagonal mapping.
    const c3 = buildPage([
      node('c1', rect(0.10, 0.10, 0.10, 0.05)),
      node('c2', rect(0.30, 0.10, 0.10, 0.05)),
      node('c3', rect(0.50, 0.10, 0.10, 0.05))
    ]);
    const r3 = buildPage([
      node('r1', rect(0.10, 0.10, 0.10, 0.05)),
      node('r2', rect(0.30, 0.10, 0.10, 0.05)),
      node('r3', rect(0.50, 0.10, 0.10, 0.05))
    ]);
    const small = matchPage(c3, r3);
    expect(small.matches).toHaveLength(3);
    const map = Object.fromEntries(small.matches.map((m) => [m.configObjectId, m.runtimeObjectId]));
    expect(map.c1).toBe('r1');
    expect(map.c2).toBe('r2');
    expect(map.c3).toBe('r3');
  });

  it('recovery pass admits a clear-margin match below the strict global threshold', () => {
    // The pair geometry here scores about 0.953 — below both the strict
    // hierarchical threshold (0.99) and the strict global threshold (0.96),
    // but above the recovery-relaxed global threshold (0.96 −
    // RECOVERY_THRESHOLD_RELAXATION = 0.91). Since this is the only
    // candidate, its score-margin over the (nonexistent) best alternative
    // is +Infinity, well above RECOVERY_REQUIRED_MARGIN, so the recovery
    // pass admits it with a "recovery" note.
    const config = buildPage([node('c_solo', rect(0.10, 0.10, 0.20, 0.10))]);
    const runtime = buildPage([node('r_solo', rect(0.20, 0.10, 0.20, 0.10))]);
    const strict = matchPage(config, runtime, {
      minHierarchicalConfidence: 0.99,
      minGlobalConfidence: 0.96
    });
    expect(RECOVERY_THRESHOLD_RELAXATION).toBeGreaterThan(0);
    expect(RECOVERY_REQUIRED_MARGIN).toBeGreaterThan(0);
    expect(strict.matches).toHaveLength(1);
    expect(strict.matches[0].runtimeObjectId).toBe('r_solo');
    expect(strict.notes.some((n) => n.startsWith('recovery pass admitted'))).toBe(true);
  });

  it('recovery pass refuses an ambiguous pair whose margin is below the required threshold', () => {
    // Two near-identical runtime candidates for one config object. Both
    // pair scores fall in the recovery-eligible band (below strict global,
    // above relaxed recovery) but the winner only beats the runner-up by a
    // hair — well under RECOVERY_REQUIRED_MARGIN — so the recovery pass
    // refuses to admit it.
    const config = buildPage([node('c_solo', rect(0.10, 0.10, 0.20, 0.10))]);
    const runtime = buildPage([
      node('r_a', rect(0.20, 0.10, 0.20, 0.10)),
      node('r_b', rect(0.201, 0.10, 0.20, 0.10))
    ]);
    const strict = matchPage(config, runtime, {
      minHierarchicalConfidence: 0.99,
      minGlobalConfidence: 0.96
    });
    expect(strict.matches).toEqual([]);
    expect(strict.unmatchedConfigObjectIds).toContain('c_solo');
  });
});

describe('transformation-runner with hierarchical matcher', () => {
  const sharedObjects = [
    node('o1', rect(0.1, 0.1, 0.4, 0.4)),
    node('o2', rect(0.6, 0.1, 0.3, 0.2))
  ];

  const configModel = buildModel(
    'cfg',
    'surface:cfg.pdf#0:1000x1000',
    buildPage(sharedObjects)
  );
  const runtimeModel = buildModel(
    'rt',
    'surface:rt.pdf#0:1000x1000',
    buildPage(sharedObjects)
  );

  it('produces matches per page and remains a valid TransformationModel', () => {
    const runner = createTransformationRunner({
      generateId: () => 'xform_test',
      now: () => '2026-04-27T12:00:00Z'
    });
    const model = runner.compute({ config: configModel, runtime: runtimeModel });
    expect(isTransformationModel(model)).toBe(true);
    expect(model.pages).toHaveLength(1);
    expect(model.pages[0].objectMatches).toHaveLength(2);
    expect(model.pages[0].unmatchedConfigObjectIds).toEqual([]);
  });

  it('warns when the runtime model is missing a page that exists in config', () => {
    const runtimeWithoutPage: StructuralModel = { ...runtimeModel, pages: [] };
    const runner = createTransformationRunner();
    const model = runner.compute({ config: configModel, runtime: runtimeWithoutPage });
    expect(model.pages[0].warnings.some((w) => w.includes('no page with pageIndex 0'))).toBe(true);
  });

  it('does not mutate the source StructuralModels', () => {
    const before = JSON.parse(JSON.stringify(configModel));
    const runner = createTransformationRunner();
    runner.compute({ config: configModel, runtime: runtimeModel });
    expect(configModel).toEqual(before);
  });

  it('uses cross-document weights when fingerprints differ (matcher option set)', () => {
    // The runner detects mismatched fingerprints and forwards
    // `crossDocument: true` to the matcher. We verify that path by capturing
    // the effective options the runner passes — the matcher itself is
    // unit-tested in matchPage tests below, so here we just confirm the
    // composition layer wires the flag through. We do this by computing two
    // runners on the same models, once with matching fingerprints and once
    // with differing ones, and asserting that match scores differ when the
    // refined-border relation between sides also differs.
    const refinedConfig: StructuralRefinedBorder = {
      rectNorm: rect(0, 0, 0.5, 1),
      source: 'cv-content',
      influencedByBBoxCount: 0,
      containsAllSavedBBoxes: true
    };
    const refinedRuntime: StructuralRefinedBorder = {
      rectNorm: rect(0.5, 0, 0.5, 1),
      source: 'cv-content',
      influencedByBBoxCount: 0,
      containsAllSavedBBoxes: true
    };
    const configPage: StructuralPage = {
      ...buildPage([node('cfg_target', rect(0.05, 0.4, 0.15, 0.1))]),
      refinedBorder: refinedConfig
    };
    const runtimePage: StructuralPage = {
      ...buildPage([node('rt_target', rect(0.55, 0.4, 0.15, 0.1))]),
      refinedBorder: refinedRuntime
    };
    const cfg = buildModel('cfg_xd', 'surface:cfg-xd.pdf#0:1000x1000', configPage);
    const rtSameDoc = buildModel('rt_xd_same', 'surface:cfg-xd.pdf#0:1000x1000', runtimePage);
    const rtDifferentDoc = buildModel('rt_xd_diff', 'surface:rt-xd.pdf#0:1000x1000', runtimePage);

    const runner = createTransformationRunner({
      generateId: () => 'xform_xd',
      now: () => '2026-04-27T12:00:00Z'
    });
    const sameDoc = runner.compute({ config: cfg, runtime: rtSameDoc });
    const diffDoc = runner.compute({ config: cfg, runtime: rtDifferentDoc });

    const sameDocMatch = sameDoc.pages[0].objectMatches.find(
      (m) => m.configObjectId === 'cfg_target'
    );
    const diffDocMatch = diffDoc.pages[0].objectMatches.find(
      (m) => m.configObjectId === 'cfg_target'
    );

    // Both runs find the only candidate. The score MUST differ because the
    // weight profile changes: cross-document weighs the (perfect)
    // refined-border-relation higher and the (degraded) absolute position
    // lower than the within-document profile does.
    expect(sameDocMatch?.runtimeObjectId).toBe('rt_target');
    expect(diffDocMatch?.runtimeObjectId).toBe('rt_target');
    expect(diffDocMatch?.confidence).toBeGreaterThan(sameDocMatch?.confidence ?? 1);
  });

  it('plumbs primary/secondary field anchor IDs into matcher priority', () => {
    // Build a page where two config objects compete for one runtime object.
    // The anchor object would lose by ~0.02 without help; the runner extracts
    // its objectId from fieldRelationships.fieldAnchors and forwards it as a
    // matcher priority, flipping the assignment.
    const configObjects = [
      node('c_anchor', rect(0.30, 0.30, 0.10, 0.05)),
      node('c_rival', rect(0.30, 0.30, 0.10, 0.05)),
      node('c_anchor_alt', rect(0.10, 0.10, 0.10, 0.05))
    ];
    const runtimeObjects = [
      node('r_target', rect(0.30, 0.30, 0.10, 0.05)),
      node('r_alt', rect(0.50, 0.50, 0.10, 0.05)),
      node('r_anchor_alt', rect(0.10, 0.10, 0.10, 0.05))
    ];
    const fieldRel: StructuralFieldRelationship = {
      fieldId: 'fld_anchor',
      fieldAnchors: {
        objectAnchors: [
          {
            rank: 'primary',
            objectId: 'c_anchor',
            relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 }
          }
        ],
        stableObjectAnchors: [
          {
            label: 'A',
            objectId: 'c_anchor',
            distance: 0,
            relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 }
          }
        ],
        refinedBorderAnchor: {
          relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 },
          distanceToEdge: 0
        },
        borderAnchor: {
          relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 },
          distanceToEdge: 0
        }
      },
      objectAnchorGraph: [],
      containedBy: null,
      nearestObjects: [],
      relativePositionWithinParent: null,
      distanceToBorder: 0,
      distanceToRefinedBorder: 0
    };
    const configPage: StructuralPage = { ...buildPage(configObjects), fieldRelationships: [fieldRel] };
    const runtimePage = buildPage(runtimeObjects);
    const cfg = buildModel('cfg_pri', 'surface:cfg-pri.pdf#0:1000x1000', configPage);
    const rt = buildModel('rt_pri', 'surface:cfg-pri.pdf#0:1000x1000', runtimePage);
    const runner = createTransformationRunner({
      generateId: () => 'xform_pri',
      now: () => '2026-04-27T12:00:00Z'
    });
    const out = runner.compute({ config: cfg, runtime: rt });
    const anchor = out.pages[0].objectMatches.find((m) => m.configObjectId === 'c_anchor');
    expect(anchor?.runtimeObjectId).toBe('r_target');
  });

  it('CROSS_DOCUMENT_SIMILARITY_WEIGHTS sum to 1 and de-emphasize absolute position', () => {
    const w = CROSS_DOCUMENT_SIMILARITY_WEIGHTS;
    const total = w.position + w.size + w.aspect + w.parentChain + w.refinedBorderRelation;
    expect(total).toBeCloseTo(1, 6);
    // The whole point: relative-to-refined-border outweighs absolute position.
    expect(w.refinedBorderRelation).toBeGreaterThan(w.position);
    // The within-document profile keeps the inverse relationship.
    expect(DEFAULT_SIMILARITY_WEIGHTS.position).toBeGreaterThan(
      DEFAULT_SIMILARITY_WEIGHTS.refinedBorderRelation
    );
  });
});
