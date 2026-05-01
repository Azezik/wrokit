/**
 * Targeted tests for the consensus engine's "real shift signal vs background
 * inertia" behavior.
 *
 * The earlier RANSAC max-inlier search collapsed two distinct cases into one
 * answer: (a) most of the page didn't move, a few cells did → consensus
 * should be identity; (b) most of the page actually shifted by a coherent
 * amount → consensus should reflect that shift. With tight tolerances and a
 * single primary inlier set, the search would lock onto the bigger near-zero
 * cluster of unchanged objects and discard the genuinely-shifted minority as
 * outliers. Downstream BBOXes then projected through identity and missed
 * their cells.
 *
 * The fix surfaces the dominant background as `transform` AND, when the
 * dominant set is near-identity, surfaces coherent regional shifts in
 * `regionalTransforms`. Each match's own implied affine is also exposed via
 * `localTransforms` so consumers can ask "what transform was actually
 * recorded for THIS object?" without going through the page-wide consensus.
 */

import { describe, expect, it } from 'vitest';

import type {
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralPage,
  StructuralRefinedBorder
} from '../../../src/core/contracts/structural-model';
import type {
  TransformationAffine,
  TransformationObjectMatch
} from '../../../src/core/contracts/transformation-model';
import { computeConsensus } from '../../../src/core/runtime/transformation/consensus';

const rect = (
  xNorm: number,
  yNorm: number,
  wNorm: number,
  hNorm: number
): StructuralNormalizedRect => ({ xNorm, yNorm, wNorm, hNorm });

const node = (
  objectId: string,
  r: StructuralNormalizedRect = rect(0.1, 0.1, 0.1, 0.1)
): StructuralObjectNode => ({
  objectId,
  objectRectNorm: r,
  bbox: r,
  parentObjectId: null,
  childObjectIds: [],
  confidence: 0.9,
  depth: 0
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

const buildMatch = (
  id: string,
  transform: TransformationAffine,
  confidence = 0.9
): TransformationObjectMatch => ({
  configObjectId: `c_${id}`,
  runtimeObjectId: `r_${id}`,
  confidence,
  basis: ['object-similarity'],
  transform,
  notes: [],
  warnings: []
});

const pagesForMatches = (
  matches: TransformationObjectMatch[]
): { config: StructuralPage; runtime: StructuralPage } => {
  const config = buildPage(matches.map((m, i) => node(m.configObjectId, rect(0.05 + 0.07 * i, 0.05, 0.05, 0.05))));
  const runtime = buildPage(matches.map((m, i) => node(m.runtimeObjectId, rect(0.05 + 0.07 * i, 0.05, 0.05, 0.05))));
  return { config, runtime };
};

const identity = (): TransformationAffine => ({
  scaleX: 1,
  scaleY: 1,
  translateX: 0,
  translateY: 0
});

describe('computeConsensus — regional shift signal', () => {
  it('9 identity + 3 coherent-shift matches: identity wins as primary, shift surfaces in regionalTransforms', () => {
    // Background: 9 objects barely moved (translateY ≈ 0.0015, essentially noise).
    const identityNoise: TransformationObjectMatch[] = Array.from({ length: 9 }, (_, i) =>
      buildMatch(`bg${i}`, {
        scaleX: 1,
        scaleY: 1,
        translateX: 0,
        translateY: 0.0015
      })
    );
    // Foreground: 3 coherent matches with real document movement
    // (scaleY ≈ 0.89, translateY ≈ 0.03–0.05).
    const shifted: TransformationObjectMatch[] = [
      buildMatch('shift0', { scaleX: 1, scaleY: 0.89, translateX: 0, translateY: 0.03 }),
      buildMatch('shift1', { scaleX: 1, scaleY: 0.89, translateX: 0, translateY: 0.04 }),
      buildMatch('shift2', { scaleX: 1, scaleY: 0.89, translateX: 0, translateY: 0.05 })
    ];
    const matches = [...identityNoise, ...shifted];
    const { config, runtime } = pagesForMatches(matches);

    const consensus = computeConsensus(matches, config, runtime);

    // Primary: the 9-strong identity background. translateY rounded ~0.0015.
    expect(consensus.transform).not.toBeNull();
    expect(consensus.transform!.scaleY).toBeCloseTo(1, 3);
    expect(consensus.transform!.translateY).toBeCloseTo(0.0015, 4);
    expect(consensus.contributingMatchCount).toBe(9);

    // Regional shift surfaced — earlier code dropped this entirely.
    expect(consensus.regionalTransforms.length).toBeGreaterThanOrEqual(1);
    const shiftRegional = consensus.regionalTransforms.find(
      (t) => Math.abs(t.scaleY - 0.89) < 0.02 && Math.abs(t.translateY - 0.04) < 0.02
    );
    expect(shiftRegional).toBeDefined();

    // localTransforms exposes per-object affines for every match — including
    // the shifted ones that didn't make the primary inlier set.
    expect(Object.keys(consensus.localTransforms)).toHaveLength(12);
    expect(consensus.localTransforms.c_shift1.scaleY).toBeCloseTo(0.89, 6);
    expect(consensus.localTransforms.c_shift1.translateY).toBeCloseTo(0.04, 6);
    expect(consensus.localTransforms.c_bg0.translateY).toBeCloseTo(0.0015, 6);
  });

  it('3 coherent-shift matches with no identity competitors: shift becomes primary, no regionals', () => {
    const matches: TransformationObjectMatch[] = [
      buildMatch('s0', { scaleX: 1, scaleY: 0.89, translateX: 0, translateY: 0.03 }),
      buildMatch('s1', { scaleX: 1, scaleY: 0.89, translateX: 0, translateY: 0.04 }),
      buildMatch('s2', { scaleX: 1, scaleY: 0.89, translateX: 0, translateY: 0.05 })
    ];
    const { config, runtime } = pagesForMatches(matches);

    const consensus = computeConsensus(matches, config, runtime);

    expect(consensus.transform).not.toBeNull();
    expect(consensus.transform!.scaleY).toBeCloseTo(0.89, 3);
    expect(consensus.transform!.translateY).toBeCloseTo(0.04, 3);
    expect(consensus.contributingMatchCount).toBe(3);
    // Primary is the shift itself — not near-identity — so no regionals are
    // surfaced; downstream consumers can rely on `transform` directly.
    expect(consensus.regionalTransforms).toEqual([]);
  });

  it('3 incoherent random transforms: no consensus when minMatchesForConsensus is enforced', () => {
    // Three transforms with no two within tolerance of each other. The RANSAC
    // search returns a 1-element primary inlier set; with a 2-match minimum
    // the consensus is rejected as insufficient agreement.
    const matches: TransformationObjectMatch[] = [
      buildMatch('a', { scaleX: 1.2, scaleY: 1.05, translateX: 0.18, translateY: -0.12 }),
      buildMatch('b', { scaleX: 0.85, scaleY: 1.3, translateX: -0.2, translateY: 0.25 }),
      buildMatch('c', { scaleX: 1.0, scaleY: 0.7, translateX: 0.05, translateY: 0.4 })
    ];
    const { config, runtime } = pagesForMatches(matches);

    const consensus = computeConsensus(matches, config, runtime, { minMatchesForConsensus: 2 });

    expect(consensus.transform).toBeNull();
    expect(consensus.contributingMatchCount).toBeLessThan(2);
    expect(consensus.regionalTransforms).toEqual([]);
    expect(consensus.warnings.join(' ')).toContain('insufficient agreement');
    // localTransforms always carries the raw per-match record, even when no
    // page-wide consensus could be formed.
    expect(Object.keys(consensus.localTransforms).sort()).toEqual(['c_a', 'c_b', 'c_c']);
  });
});
