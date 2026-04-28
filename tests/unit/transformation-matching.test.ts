import { describe, expect, it } from 'vitest';

import type {
  StructuralModel,
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralObjectType,
  StructuralPage,
  StructuralRefinedBorder
} from '../../src/core/contracts/structural-model';
import { isTransformationModel } from '../../src/core/contracts/transformation-model';
import { matchPage } from '../../src/core/runtime/transformation/hierarchical-matcher';
import {
  computeObjectSimilarity,
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
  type: StructuralObjectType,
  r: StructuralNormalizedRect,
  parentObjectId: string | null = null,
  childObjectIds: string[] = [],
  confidence = 0.9
): StructuralObjectNode => ({
  objectId,
  type,
  objectRectNorm: r,
  bbox: r,
  parentObjectId,
  childObjectIds,
  confidence
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
  version: '3.0',
  structureVersion: 'wrokit/structure/v2',
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
  it('scores identical objects close to 1.0', () => {
    const a = node('a', 'container', rect(0.1, 0.1, 0.4, 0.4));
    const b = node('b', 'container', rect(0.1, 0.1, 0.4, 0.4));
    const result = computeObjectSimilarity(a, b, baseSimilarityCtx);
    expect(result.score).toBeGreaterThan(0.95);
    expect(result.basis).toContain('type-match');
    expect(result.basis).toContain('object-similarity');
    expect(result.basis).toContain('parent-chain');
    expect(result.basis).toContain('refined-border-relation');
  });

  it('penalises type mismatch but rewards similar geometry', () => {
    const a = node('a', 'container', rect(0.1, 0.1, 0.4, 0.4));
    const b = node('b', 'line-horizontal', rect(0.1, 0.1, 0.4, 0.4));
    const result = computeObjectSimilarity(a, b, baseSimilarityCtx);
    expect(result.score).toBeLessThan(
      computeObjectSimilarity(a, node('c', 'container', rect(0.1, 0.1, 0.4, 0.4)), baseSimilarityCtx).score
    );
    expect(result.notes.join(' ')).toContain('type mismatch');
  });

  it('scales score with positional distance', () => {
    const a = node('a', 'container', rect(0.0, 0.0, 0.2, 0.2));
    const close = node('b', 'container', rect(0.0, 0.05, 0.2, 0.2));
    const far = node('c', 'container', rect(0.7, 0.7, 0.2, 0.2));
    const closeScore = computeObjectSimilarity(a, close, baseSimilarityCtx).score;
    const farScore = computeObjectSimilarity(a, far, baseSimilarityCtx).score;
    expect(closeScore).toBeGreaterThan(farScore);
  });

  it('rewards parent-chain similarity when parents are matched', () => {
    const configChild = node('cc', 'rectangle', rect(0.2, 0.2, 0.1, 0.1), 'cp');
    const runtimeChild = node('rc', 'rectangle', rect(0.2, 0.2, 0.1, 0.1), 'rp');
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
      node('o1', 'container', rect(0.1, 0.1, 0.4, 0.4)),
      node('o2', 'rectangle', rect(0.6, 0.1, 0.3, 0.2))
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
      node('c1', 'container', rect(0.1, 0.1, 0.3, 0.3)),
      node('c2', 'rectangle', rect(0.5, 0.5, 0.2, 0.2))
    ]);
    const runtime = buildPage([
      node('r1', 'container', rect(0.12, 0.07, 0.3, 0.3)),
      node('r2', 'rectangle', rect(0.52, 0.47, 0.2, 0.2))
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
    const config = buildPage([node('c1', 'container', rect(0.1, 0.1, 0.4, 0.4))]);
    const runtime = buildPage([node('r1', 'container', rect(0.1, 0.1, 0.6, 0.6))]);
    const result = matchPage(config, runtime);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].transform.scaleX).toBeCloseTo(1.5, 5);
    expect(result.matches[0].transform.scaleY).toBeCloseTo(1.5, 5);
  });

  it('does not match an extra runtime object that has no config counterpart', () => {
    const config = buildPage([node('c1', 'container', rect(0.1, 0.1, 0.3, 0.3))]);
    const runtime = buildPage([
      node('r1', 'container', rect(0.1, 0.1, 0.3, 0.3)),
      node('rOrphan', 'header', rect(0.8, 0.0, 0.15, 0.05))
    ]);
    const result = matchPage(config, runtime);
    expect(result.matches.map((m) => m.configObjectId)).toEqual(['c1']);
    expect(result.unmatchedRuntimeObjectIds).toContain('rOrphan');
    expect(result.unmatchedConfigObjectIds).toEqual([]);
  });

  it('reports unmatched config objects when the runtime is missing them', () => {
    const config = buildPage([
      node('c1', 'container', rect(0.1, 0.1, 0.3, 0.3)),
      node('cMissing', 'rectangle', rect(0.7, 0.7, 0.1, 0.1))
    ]);
    const runtime = buildPage([node('r1', 'container', rect(0.1, 0.1, 0.3, 0.3))]);
    const result = matchPage(config, runtime);
    expect(result.matches).toHaveLength(1);
    expect(result.unmatchedConfigObjectIds).toContain('cMissing');
    expect(result.unmatchedRuntimeObjectIds).toEqual([]);
  });

  it('only matches a child against children of its matched parent', () => {
    const config = buildPage([
      node('cParentA', 'container', rect(0.0, 0.0, 0.5, 1.0), null, ['cChildA']),
      node('cParentB', 'container', rect(0.5, 0.0, 0.5, 1.0), null, ['cChildB']),
      node('cChildA', 'rectangle', rect(0.05, 0.1, 0.1, 0.1), 'cParentA'),
      node('cChildB', 'rectangle', rect(0.55, 0.1, 0.1, 0.1), 'cParentB')
    ]);
    const runtime = buildPage([
      node('rParentA', 'container', rect(0.0, 0.0, 0.5, 1.0), null, ['rChildA']),
      node('rParentB', 'container', rect(0.5, 0.0, 0.5, 1.0), null, ['rChildB']),
      // Both runtime children have geometry similar to BOTH config children;
      // only the parent-chain anchoring should keep them properly assigned.
      node('rChildA', 'rectangle', rect(0.05, 0.1, 0.1, 0.1), 'rParentA'),
      node('rChildB', 'rectangle', rect(0.55, 0.1, 0.1, 0.1), 'rParentB')
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
    const config = buildPage([node('c_target', 'rectangle', rect(0.10, 0.10, 0.20, 0.10))]);
    const runtime = buildPage([
      node('r_winner', 'rectangle', rect(0.10, 0.10, 0.20, 0.10)),
      // r_twin: nearly identical to r_winner, so its similarity score with
      // c_target lands within the AMBIGUITY_SCORE_MARGIN of r_winner's score.
      node('r_twin', 'rectangle', rect(0.105, 0.10, 0.20, 0.10))
    ]);
    const result = matchPage(config, runtime);
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(match.configObjectId).toBe('c_target');
    expect(match.warnings.some((w) => w.startsWith('ambiguous match'))).toBe(true);
    expect(match.warnings[0]).toMatch(/r_winner/);
    expect(match.warnings[0]).toMatch(/r_twin/);

    // Equivalent setup but only r_winner exists — no rival, no demotion.
    const unambiguous = matchPage(config, buildPage([node('r_winner', 'rectangle', rect(0.10, 0.10, 0.20, 0.10))]));
    expect(unambiguous.matches[0].warnings).toEqual([]);
    expect(match.confidence).toBeLessThan(unambiguous.matches[0].confidence);

    // Page-level warning is also surfaced so consumers can see ambiguity
    // without scanning every match's `warnings`.
    expect(result.warnings.some((w) => w.startsWith('ambiguous match'))).toBe(true);
  });

  it('does not flag ambiguity when the runner-up clearly loses', () => {
    // r_winner is a near-perfect twin of c_target, r_other is far away.
    // The score gap is well above AMBIGUITY_SCORE_MARGIN, so no warning.
    const config = buildPage([node('c_target', 'rectangle', rect(0.10, 0.10, 0.20, 0.10))]);
    const runtime = buildPage([
      node('r_winner', 'rectangle', rect(0.10, 0.10, 0.20, 0.10)),
      node('r_other', 'rectangle', rect(0.80, 0.80, 0.05, 0.05))
    ]);
    const result = matchPage(config, runtime);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].warnings).toEqual([]);
    expect(result.warnings.some((w) => w.startsWith('ambiguous match'))).toBe(false);
  });

  it('respects a custom confidence threshold', () => {
    const config = buildPage([node('c1', 'container', rect(0.0, 0.0, 0.2, 0.2))]);
    const runtime = buildPage([node('r1', 'container', rect(0.7, 0.7, 0.2, 0.2))]);
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
});

describe('transformation-runner with hierarchical matcher', () => {
  const sharedObjects = [
    node('o1', 'container', rect(0.1, 0.1, 0.4, 0.4)),
    node('o2', 'rectangle', rect(0.6, 0.1, 0.3, 0.2))
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
});
