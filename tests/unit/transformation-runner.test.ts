import { describe, expect, it } from 'vitest';

import type {
  StructuralFieldRelationship,
  StructuralModel,
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralObjectType,
  StructuralPage,
  StructuralRefinedBorder,
  StructuralRelativeAnchorRect
} from '../../src/core/contracts/structural-model';
import {
  isTransformationModel,
  type TransformationFieldCandidate
} from '../../src/core/contracts/transformation-model';
import { computeFieldAlignments } from '../../src/core/runtime/transformation/field-candidates';
import { matchPage } from '../../src/core/runtime/transformation/hierarchical-matcher';
import {
  computeBorderLevelSummary,
  computeRefinedBorderLevelSummary
} from '../../src/core/runtime/transformation/consensus';
import { createTransformationRunner } from '../../src/core/runtime/transformation-runner';

const rect = (x: number, y: number, w: number, h: number): StructuralNormalizedRect => ({
  xNorm: x,
  yNorm: y,
  wNorm: w,
  hNorm: h
});

const ratio = (
  xRatio: number,
  yRatio: number,
  wRatio: number,
  hRatio: number
): StructuralRelativeAnchorRect => ({ xRatio, yRatio, wRatio, hRatio });

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

const buildField = (
  fieldId: string,
  primaryObjectId: string,
  primaryRel: StructuralRelativeAnchorRect = ratio(0.1, 0.1, 0.2, 0.1)
): StructuralFieldRelationship => ({
  fieldId,
  fieldAnchors: {
    objectAnchors: [{ rank: 'primary', objectId: primaryObjectId, relativeFieldRect: primaryRel }],
    stableObjectAnchors: [
      {
        label: 'A',
        objectId: primaryObjectId,
        distance: 0,
        relativeFieldRect: primaryRel
      }
    ],
    refinedBorderAnchor: { relativeFieldRect: ratio(0.2, 0.2, 0.1, 0.05), distanceToEdge: 0.2 },
    borderAnchor: { relativeFieldRect: ratio(0.2, 0.2, 0.1, 0.05), distanceToEdge: 0.2 }
  },
  objectAnchorGraph: [],
  containedBy: primaryObjectId,
  nearestObjects: [],
  relativePositionWithinParent: null,
  distanceToBorder: 0,
  distanceToRefinedBorder: 0
});

const buildPage = (
  objects: StructuralObjectNode[],
  fields: StructuralFieldRelationship[] = [],
  refinedBorder: StructuralRefinedBorder = refinedFullPage
): StructuralPage => ({
  pageIndex: 0,
  pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1000 },
  cvExecutionMode: 'heuristic-fallback',
  border: { rectNorm: rect(0, 0, 1, 1) },
  refinedBorder,
  objectHierarchy: { objects },
  pageAnchorRelations: {
    objectToObject: [],
    objectToRefinedBorder: [],
    refinedBorderToBorder: { relativeRect: ratio(0, 0, 1, 1) }
  },
  fieldRelationships: fields
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

const sortByOrder = (cands: TransformationFieldCandidate[]): TransformationFieldCandidate[] =>
  [...cands].sort((a, b) => a.fallbackOrder - b.fallbackOrder);

describe('computeFieldAlignments — fallback chain', () => {
  it('matched object yields a high-confidence matched-object candidate first', () => {
    const objects = [node('o1', 'container', rect(0.1, 0.1, 0.4, 0.4))];
    const fields = [buildField('f1', 'o1')];
    const config = buildPage(objects, fields);
    const runtime = buildPage(objects);
    const matchResult = matchPage(config, runtime);
    const summaries = [
      computeBorderLevelSummary(config, runtime),
      computeRefinedBorderLevelSummary(config, runtime)
    ];
    const alignments = computeFieldAlignments(config, matchResult.matches, summaries);
    expect(alignments).toHaveLength(1);
    const candidates = sortByOrder(alignments[0].candidates);
    expect(candidates[0].source).toBe('matched-object');
    expect(candidates[0].configObjectId).toBe('o1');
    expect(candidates[0].confidence).toBeGreaterThan(0.8);
    expect(candidates.map((c) => c.source)).toEqual([
      'matched-object',
      'refined-border',
      'border'
    ]);
  });

  it('falls back to parent-object when the primary anchor is not matched', () => {
    const configObjects = [
      node('parent', 'container', rect(0.0, 0.0, 0.6, 0.6), null, ['child']),
      node('child', 'rectangle', rect(0.1, 0.1, 0.1, 0.1), 'parent')
    ];
    // Runtime missing the child entirely — only the parent matches.
    const runtimeObjects = [
      node('rParent', 'container', rect(0.0, 0.0, 0.6, 0.6), null, [])
    ];
    const fields = [buildField('f1', 'child')];
    const config = buildPage(configObjects, fields);
    const runtime = buildPage(runtimeObjects);

    // Tweak the matcher so 'child' has no chance of being matched against the
    // single runtime object; only 'parent' should match.
    const matchResult = matchPage(config, runtime);
    expect(matchResult.matches.map((m) => m.configObjectId)).toContain('parent');
    expect(matchResult.matches.map((m) => m.configObjectId)).not.toContain('child');

    const summaries = [
      computeBorderLevelSummary(config, runtime),
      computeRefinedBorderLevelSummary(config, runtime)
    ];
    const alignments = computeFieldAlignments(config, matchResult.matches, summaries);
    const candidates = sortByOrder(alignments[0].candidates);
    expect(candidates[0].source).toBe('parent-object');
    expect(candidates[0].configObjectId).toBe('parent');
    expect(candidates.map((c) => c.source)).toEqual([
      'parent-object',
      'refined-border',
      'border'
    ]);
  });

  it('uses refined-border + border when no anchor and no ancestor match', () => {
    const configObjects = [node('orphan', 'rectangle', rect(0.4, 0.4, 0.1, 0.1))];
    const runtimeObjects = [node('completelyDifferent', 'header', rect(0.0, 0.0, 0.05, 0.02))];
    const fields = [buildField('f1', 'orphan')];
    const config = buildPage(configObjects, fields);
    const runtime = buildPage(runtimeObjects);
    const matchResult = matchPage(config, runtime);
    expect(matchResult.matches).toHaveLength(0);

    const summaries = [
      computeBorderLevelSummary(config, runtime),
      computeRefinedBorderLevelSummary(config, runtime)
    ];
    const alignments = computeFieldAlignments(config, matchResult.matches, summaries);
    const sources = sortByOrder(alignments[0].candidates).map((c) => c.source);
    expect(sources).toEqual(['refined-border', 'border']);
    expect(alignments[0].warnings.join(' ')).toContain('no object-level candidate');
  });

  it('emits the matched-object candidate with the anchor relativeFieldRect', () => {
    const objects = [node('o1', 'container', rect(0.1, 0.1, 0.4, 0.4))];
    const customRel = ratio(0.25, 0.25, 0.5, 0.1);
    const fields = [buildField('f1', 'o1', customRel)];
    const config = buildPage(objects, fields);
    const runtime = buildPage(objects);
    const matchResult = matchPage(config, runtime);
    const summaries = [
      computeBorderLevelSummary(config, runtime),
      computeRefinedBorderLevelSummary(config, runtime)
    ];
    const alignments = computeFieldAlignments(config, matchResult.matches, summaries);
    const matchedCandidate = alignments[0].candidates.find((c) => c.source === 'matched-object');
    expect(matchedCandidate?.relativeFieldRect).toEqual(customRel);
  });

  it('fallbackOrder is strictly increasing', () => {
    const objects = [node('o1', 'container', rect(0.1, 0.1, 0.4, 0.4))];
    const fields = [buildField('f1', 'o1')];
    const config = buildPage(objects, fields);
    const runtime = buildPage(objects);
    const matchResult = matchPage(config, runtime);
    const summaries = [
      computeBorderLevelSummary(config, runtime),
      computeRefinedBorderLevelSummary(config, runtime)
    ];
    const alignments = computeFieldAlignments(config, matchResult.matches, summaries);
    const orders = alignments[0].candidates.map((c) => c.fallbackOrder);
    for (let i = 1; i < orders.length; i += 1) {
      expect(orders[i]).toBeGreaterThan(orders[i - 1]);
    }
  });
});

describe('transformation-runner — end-to-end', () => {
  it('identical Config+Runtime yields identity transforms and matched-object candidates first', () => {
    const objects = [
      node('o1', 'container', rect(0.1, 0.1, 0.4, 0.4)),
      node('o2', 'rectangle', rect(0.6, 0.1, 0.3, 0.3))
    ];
    const fields = [buildField('f1', 'o1')];
    const configModel = buildModel('cfg', 'cfg-fp', buildPage(objects, fields));
    const runtimeModel = buildModel('rt', 'rt-fp', buildPage(objects, fields));

    const runner = createTransformationRunner({
      generateId: () => 'xform_test',
      now: () => '2026-04-27T12:00:00Z'
    });
    const model = runner.compute({ config: configModel, runtime: runtimeModel });

    expect(isTransformationModel(model)).toBe(true);
    const page = model.pages[0];
    for (const m of page.objectMatches) {
      expect(m.transform.scaleX).toBeCloseTo(1, 6);
      expect(m.transform.scaleY).toBeCloseTo(1, 6);
      expect(m.transform.translateX).toBeCloseTo(0, 6);
      expect(m.transform.translateY).toBeCloseTo(0, 6);
    }
    expect(page.consensus.transform).not.toBeNull();
    expect(page.consensus.transform!.scaleX).toBeCloseTo(1, 5);
    const firstCandidate = page.fieldAlignments[0].candidates.find((c) => c.fallbackOrder === 0);
    expect(firstCandidate?.source).toBe('matched-object');
    expect(model.overallConfidence).toBeGreaterThan(0.7);
  });

  it('uniformly shifted+scaled runtime is recovered in the consensus transform within tolerance', () => {
    const configObjects = [
      node('c1', 'container', rect(0.0, 0.0, 0.3, 0.3)),
      node('c2', 'rectangle', rect(0.5, 0.0, 0.3, 0.3)),
      node('c3', 'rectangle', rect(0.0, 0.5, 0.3, 0.3))
    ];
    // Runtime: scaled to 1.1x and shifted by (+0.05, -0.02).
    const runtimeObjects = configObjects.map((o, i) =>
      node(
        `r${i + 1}`,
        o.type,
        rect(
          o.objectRectNorm.xNorm * 1.1 + 0.05,
          o.objectRectNorm.yNorm * 1.1 - 0.02,
          o.objectRectNorm.wNorm * 1.1,
          o.objectRectNorm.hNorm * 1.1
        )
      )
    );
    const configModel = buildModel('cfg', 'cfg-fp', buildPage(configObjects));
    const runtimeModel = buildModel('rt', 'rt-fp', buildPage(runtimeObjects));

    const runner = createTransformationRunner();
    const model = runner.compute({ config: configModel, runtime: runtimeModel });

    const page = model.pages[0];
    expect(page.objectMatches.length).toBe(3);
    expect(page.consensus.transform).not.toBeNull();
    expect(page.consensus.transform!.scaleX).toBeCloseTo(1.1, 4);
    expect(page.consensus.transform!.scaleY).toBeCloseTo(1.1, 4);
    expect(page.consensus.transform!.translateX).toBeCloseTo(0.05, 4);
    expect(page.consensus.transform!.translateY).toBeCloseTo(-0.02, 4);
  });

  it('reports unmatched config and runtime objects honestly', () => {
    const configObjects = [
      node('shared', 'container', rect(0.1, 0.1, 0.3, 0.3)),
      node('configOnly', 'rectangle', rect(0.7, 0.7, 0.1, 0.1))
    ];
    const runtimeObjects = [
      node('shared', 'container', rect(0.1, 0.1, 0.3, 0.3)),
      node('runtimeOnly', 'header', rect(0.0, 0.0, 0.05, 0.02))
    ];
    const configModel = buildModel('cfg', 'cfg-fp', buildPage(configObjects));
    const runtimeModel = buildModel('rt', 'rt-fp', buildPage(runtimeObjects));

    const runner = createTransformationRunner();
    const model = runner.compute({ config: configModel, runtime: runtimeModel });
    const page = model.pages[0];
    expect(page.unmatchedConfigObjectIds).toContain('configOnly');
    expect(page.unmatchedRuntimeObjectIds).toContain('runtimeOnly');
  });

  it('produces no field alignments when the config page declares no fields', () => {
    const configModel = buildModel(
      'cfg',
      'cfg-fp',
      buildPage([node('o1', 'container', rect(0.1, 0.1, 0.4, 0.4))])
    );
    const runtimeModel = buildModel('rt', 'rt-fp', buildPage([]));
    const runner = createTransformationRunner();
    const model = runner.compute({ config: configModel, runtime: runtimeModel });
    expect(model.pages[0].fieldAlignments).toEqual([]);
  });
});
