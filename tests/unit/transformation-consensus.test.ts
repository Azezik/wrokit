import { describe, expect, it } from 'vitest';

import type {
  StructuralModel,
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralPage,
  StructuralRefinedBorder
} from '../../src/core/contracts/structural-model';
import { isTransformationModel } from '../../src/core/contracts/transformation-model';
import {
  computeBorderLevelSummary,
  computeConsensus,
  computeObjectLevelSummary,
  computeParentChainLevelSummary,
  computeRefinedBorderLevelSummary
} from '../../src/core/runtime/transformation/consensus';
import { matchPage } from '../../src/core/runtime/transformation/hierarchical-matcher';
import {
  affineFromRects,
  applyAffineToRect,
  IDENTITY_AFFINE,
  iouOfRects
} from '../../src/core/runtime/transformation/transform-math';
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

const refinedCv = (r: StructuralNormalizedRect): StructuralRefinedBorder => ({
  rectNorm: r,
  source: 'cv-content',
  influencedByBBoxCount: 0,
  containsAllSavedBBoxes: true
});

const buildPage = (
  objects: StructuralObjectNode[],
  refinedBorder: StructuralRefinedBorder = refinedFullPage,
  border: StructuralNormalizedRect = rect(0, 0, 1, 1)
): StructuralPage => ({
  pageIndex: 0,
  pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1000 },
  cvExecutionMode: 'heuristic-fallback',
  border: { rectNorm: border },
  refinedBorder,
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

describe('transform-math', () => {
  it('affineFromRects recovers a uniform shift+scale', () => {
    const c = rect(0.1, 0.1, 0.4, 0.4);
    const r = rect(0.15, 0.05, 0.6, 0.6);
    const t = affineFromRects(c, r);
    expect(t.scaleX).toBeCloseTo(1.5, 6);
    expect(t.scaleY).toBeCloseTo(1.5, 6);
    expect(applyAffineToRect(c, t)).toEqual(r);
  });

  it('iou is 1 for identical rects and 0 for disjoint rects', () => {
    expect(iouOfRects(rect(0, 0, 0.2, 0.2), rect(0, 0, 0.2, 0.2))).toBe(1);
    expect(iouOfRects(rect(0, 0, 0.1, 0.1), rect(0.5, 0.5, 0.1, 0.1))).toBe(0);
  });

  it('IDENTITY_AFFINE leaves a rect unchanged', () => {
    const r = rect(0.3, 0.3, 0.2, 0.2);
    expect(applyAffineToRect(r, IDENTITY_AFFINE)).toEqual(r);
  });
});

describe('border + refined-border level summaries', () => {
  it('border summary is identity with full confidence on equal borders', () => {
    const page = buildPage([]);
    const summary = computeBorderLevelSummary(page, page);
    expect(summary.transform).toEqual(IDENTITY_AFFINE);
    expect(summary.confidence).toBe(1);
    expect(summary.contributingMatchCount).toBe(1);
  });

  it('refined-border summary downgrades confidence on full-page fallback', () => {
    const cvPage = buildPage([], refinedCv(rect(0.05, 0.05, 0.9, 0.9)));
    const fallbackPage = buildPage([]);
    const summary = computeRefinedBorderLevelSummary(cvPage, fallbackPage);
    expect(summary.transform).not.toBeNull();
    expect(summary.confidence).toBeLessThan(0.5);
    expect(summary.warnings.join(' ')).toContain('full-page fallback');
  });

  it('refined-border summary is high confidence when both sides are cv-content', () => {
    const cvPage = buildPage([], refinedCv(rect(0.05, 0.05, 0.9, 0.9)));
    const summary = computeRefinedBorderLevelSummary(cvPage, cvPage);
    expect(summary.confidence).toBeGreaterThanOrEqual(0.9);
    expect(summary.warnings).toEqual([]);
  });
});

describe('object + parent-chain level summaries', () => {
  it('produces a non-null transform when matches exist', () => {
    const config = buildPage([
      node('c1', rect(0.1, 0.1, 0.3, 0.3)),
      node('c2', rect(0.5, 0.5, 0.2, 0.2))
    ]);
    const runtime = buildPage([
      node('r1', rect(0.12, 0.07, 0.3, 0.3)),
      node('r2', rect(0.52, 0.47, 0.2, 0.2))
    ]);
    const matchResult = matchPage(config, runtime);
    const summary = computeObjectLevelSummary(matchResult.matches, config, runtime);
    expect(summary.transform).not.toBeNull();
    expect(summary.transform!.translateX).toBeCloseTo(0.02, 4);
    expect(summary.transform!.translateY).toBeCloseTo(-0.03, 4);
    expect(summary.contributingMatchCount).toBe(2);
  });

  it('parent-chain summary is empty when no matches use parent-chain basis', () => {
    const config = buildPage([node('c1', rect(0.1, 0.1, 0.3, 0.3))]);
    const runtime = buildPage([node('r1', rect(0.1, 0.1, 0.3, 0.3))]);
    const matchResult = matchPage(config, runtime);
    const summary = computeParentChainLevelSummary(matchResult.matches, config, runtime);
    expect(summary.transform).not.toBeNull();
    expect(summary.contributingMatchCount).toBeGreaterThan(0);
  });

  it('parent-chain summary aggregates only matches anchored under matched parents', () => {
    const config = buildPage([
      node('cP', rect(0.0, 0.0, 0.5, 1.0), null, ['cChild']),
      node('cChild', rect(0.1, 0.1, 0.1, 0.1), 'cP'),
      node('cLoose', rect(0.7, 0.7, 0.1, 0.1))
    ]);
    const runtime = buildPage([
      node('rP', rect(0.0, 0.0, 0.5, 1.0), null, ['rChild']),
      node('rChild', rect(0.12, 0.1, 0.1, 0.1), 'rP'),
      node('rLoose', rect(0.7, 0.7, 0.1, 0.1))
    ]);
    const matchResult = matchPage(config, runtime);
    const parentChain = computeParentChainLevelSummary(matchResult.matches, config, runtime);
    expect(parentChain.transform).not.toBeNull();
    // Only the child match (and possibly the parent itself if it includes
    // parent-chain basis from its null/null root) contributes.
    const contributing = matchResult.matches.filter((m) => m.basis.includes('parent-chain'));
    expect(parentChain.contributingMatchCount).toBe(contributing.length);
  });
});

describe('computeConsensus', () => {
  it('returns no transform when there are no matches', () => {
    const page = buildPage([]);
    const consensus = computeConsensus([], page, page);
    expect(consensus.transform).toBeNull();
    expect(consensus.confidence).toBe(0);
    expect(consensus.contributingMatchCount).toBe(0);
  });

  it('returns the shared transform when all matches agree', () => {
    const config = buildPage([
      node('c1', rect(0.0, 0.0, 0.3, 0.3)),
      node('c2', rect(0.5, 0.0, 0.3, 0.3)),
      node('c3', rect(0.0, 0.5, 0.3, 0.3))
    ]);
    const runtime = buildPage([
      // All shifted by (+0.05, -0.02), no scale change.
      node('r1', rect(0.05, -0.02, 0.3, 0.3)),
      node('r2', rect(0.55, -0.02, 0.3, 0.3)),
      node('r3', rect(0.05, 0.48, 0.3, 0.3))
    ]);
    const matchResult = matchPage(config, runtime);
    const consensus = computeConsensus(matchResult.matches, config, runtime);
    expect(consensus.transform).not.toBeNull();
    expect(consensus.transform!.translateX).toBeCloseTo(0.05, 5);
    expect(consensus.transform!.translateY).toBeCloseTo(-0.02, 5);
    expect(consensus.transform!.scaleX).toBeCloseTo(1, 5);
    expect(consensus.outliers).toHaveLength(0);
    expect(consensus.confidence).toBeGreaterThan(0.7);
  });

  it('flags an outlier match and excludes it from consensus', () => {
    const config = buildPage([
      node('c1', rect(0.0, 0.0, 0.3, 0.3), null, [], 0.95),
      node('c2', rect(0.5, 0.0, 0.3, 0.3), null, [], 0.95),
      node('c3', rect(0.0, 0.5, 0.3, 0.3), null, [], 0.95),
      // tiny rogue object in the bottom-right with a divergent runtime offset
      node('cBad', rect(0.85, 0.85, 0.05, 0.05), null, [], 0.6)
    ]);
    const runtime = buildPage([
      node('r1', rect(0.05, -0.02, 0.3, 0.3)),
      node('r2', rect(0.55, -0.02, 0.3, 0.3)),
      node('r3', rect(0.05, 0.48, 0.3, 0.3)),
      // wildly different translation
      node('rBad', rect(0.55, 0.55, 0.05, 0.05))
    ]);
    const matchResult = matchPage(config, runtime, { minHierarchicalConfidence: 0.0 });
    expect(matchResult.matches.length).toBeGreaterThanOrEqual(4);
    const consensus = computeConsensus(matchResult.matches, config, runtime, {
      scaleOutlierTolerance: 0.1,
      translateOutlierTolerance: 0.05
    });
    expect(consensus.outliers.map((o) => o.configObjectId)).toContain('cBad');
    expect(consensus.transform!.translateX).toBeCloseTo(0.05, 2);
    expect(consensus.transform!.translateY).toBeCloseTo(-0.02, 2);
    expect(consensus.warnings.join(' ')).toContain('outlier');
  });

  it('warns when consensus is formed from a single match', () => {
    const config = buildPage([node('c1', rect(0.1, 0.1, 0.4, 0.4))]);
    const runtime = buildPage([node('r1', rect(0.15, 0.05, 0.4, 0.4))]);
    const matchResult = matchPage(config, runtime);
    const consensus = computeConsensus(matchResult.matches, config, runtime);
    expect(consensus.contributingMatchCount).toBe(1);
    expect(consensus.warnings.some((w) => w.includes('single match'))).toBe(true);
  });

  it('virtual-projection cross-check raises confidence when projections agree', () => {
    const config = buildPage([
      node('c1', rect(0.0, 0.0, 0.3, 0.3)),
      node('c2', rect(0.5, 0.0, 0.3, 0.3))
    ]);
    const sameTransformRuntime = buildPage([
      node('r1', rect(0.1, 0.1, 0.3, 0.3)),
      node('r2', rect(0.6, 0.1, 0.3, 0.3))
    ]);
    const divergentRuntime = buildPage([
      node('r1', rect(0.1, 0.1, 0.3, 0.3)),
      // incoherent extra match: +0.4 translate vs +0.1 expected
      node('r2', rect(0.9, 0.0, 0.3, 0.3))
    ]);
    const agreeMatches = matchPage(config, sameTransformRuntime).matches;
    const disagreeMatches = matchPage(config, divergentRuntime, {
      minHierarchicalConfidence: 0.0
    }).matches;
    const agreeConsensus = computeConsensus(agreeMatches, config, sameTransformRuntime, {
      scaleOutlierTolerance: 1,
      translateOutlierTolerance: 1
    });
    const disagreeConsensus = computeConsensus(disagreeMatches, config, divergentRuntime, {
      scaleOutlierTolerance: 1,
      translateOutlierTolerance: 1
    });
    expect(agreeConsensus.confidence).toBeGreaterThan(disagreeConsensus.confidence);
  });
});

describe('runner with consensus + summaries', () => {
  it('emits four level summaries and a consensus block per page', () => {
    const objects = [
      node('o1', rect(0.1, 0.1, 0.3, 0.3)),
      node('o2', rect(0.5, 0.5, 0.2, 0.2))
    ];
    const config = buildModel('cfg', 'cfg', buildPage(objects));
    const runtime = buildModel('rt', 'rt', buildPage(objects));
    const runner = createTransformationRunner({
      generateId: () => 'xform_test',
      now: () => '2026-04-27T12:00:00Z'
    });
    const model = runner.compute({ config, runtime });
    expect(isTransformationModel(model)).toBe(true);
    const page = model.pages[0];
    expect(page.levelSummaries.map((l) => l.level)).toEqual([
      'border',
      'refined-border',
      'object',
      'parent-chain'
    ]);
    expect(page.levelSummaries[0].transform).not.toBeNull();
    expect(page.levelSummaries[2].transform).not.toBeNull();
    expect(page.consensus.transform).not.toBeNull();
    expect(model.overallConfidence).toBeGreaterThan(0);
  });

  it('overallConfidence is 0 when no page produced a consensus', () => {
    const config = buildModel('cfg', 'cfg', buildPage([]));
    const runtime = buildModel('rt', 'rt', buildPage([]));
    const runner = createTransformationRunner();
    const model = runner.compute({ config, runtime });
    expect(model.pages[0].consensus.transform).toBeNull();
    expect(model.overallConfidence).toBe(0);
  });
});
