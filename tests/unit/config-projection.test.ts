import { describe, expect, it } from 'vitest';

import type {
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralPage,
  StructuralRefinedBorder
} from '../../src/core/contracts/structural-model';
import type {
  TransformationAffine,
  TransformationObjectMatch,
  TransformationPage
} from '../../src/core/contracts/transformation-model';
import {
  projectConfigPageRaw,
  projectConfigPageTransformed
} from '../../src/core/page-surface/ui/config-projection';

const rect = (x: number, y: number, w: number, h: number): StructuralNormalizedRect => ({
  xNorm: x,
  yNorm: y,
  wNorm: w,
  hNorm: h
});

const node = (
  objectId: string,
  r: StructuralNormalizedRect,
  parentObjectId: string | null = null,
  childObjectIds: string[] = [],
  depth = 0,
  confidence = 0.9
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
  cvContentRectNorm: rect(0, 0, 1, 1),
  source: 'full-page-fallback',
  influencedByBBoxCount: 0,
  containsAllSavedBBoxes: true
};

const buildPage = (objects: StructuralObjectNode[]): StructuralPage => ({
  pageIndex: 0,
  pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1000 },
  cvExecutionMode: 'opencv-runtime',
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

const affine = (
  scaleX: number,
  scaleY: number,
  translateX: number,
  translateY: number
): TransformationAffine => ({ scaleX, scaleY, translateX, translateY });

const objectMatch = (
  configObjectId: string,
  runtimeObjectId: string,
  transform: TransformationAffine,
  confidence = 0.95
): TransformationObjectMatch => ({
  configObjectId,
  runtimeObjectId,
  confidence,
  basis: ['object-similarity'],
  transform,
  notes: [],
  warnings: []
});

const buildTransformationPage = (overrides: Partial<TransformationPage> = {}): TransformationPage => ({
  pageIndex: 0,
  levelSummaries: [
    { level: 'border', transform: affine(1, 1, 0, 0), confidence: 1, contributingMatchCount: 1, notes: [], warnings: [] },
    { level: 'refined-border', transform: affine(1, 1, 0, 0), confidence: 1, contributingMatchCount: 1, notes: [], warnings: [] },
    { level: 'object', transform: null, confidence: 0, contributingMatchCount: 0, notes: [], warnings: [] },
    { level: 'parent-chain', transform: null, confidence: 0, contributingMatchCount: 0, notes: [], warnings: [] }
  ],
  objectMatches: [],
  unmatchedConfigObjectIds: [],
  unmatchedRuntimeObjectIds: [],
  consensus: {
    transform: null,
    confidence: 0,
    contributingMatchCount: 0,
    outliers: [],
    notes: [],
    warnings: []
  },
  fieldAlignments: [],
  notes: [],
  warnings: [],
  ...overrides
});

describe('projectConfigPageRaw', () => {
  it('returns config rects unchanged with identity transform-source markers', () => {
    const page = buildPage([
      node('a', rect(0.1, 0.1, 0.2, 0.2), null, ['b'], 0),
      node('b', rect(0.12, 0.12, 0.05, 0.05), 'a', [], 1)
    ]);

    const projection = projectConfigPageRaw(page);

    expect(projection.border).toEqual(rect(0, 0, 1, 1));
    expect(projection.borderTransformSource).toBe('identity');
    expect(projection.refinedBorder).toEqual(rect(0, 0, 1, 1));
    expect(projection.objects).toHaveLength(2);
    expect(projection.objects[0].rectNorm).toEqual(rect(0.1, 0.1, 0.2, 0.2));
    expect(projection.objects[0].transformSource).toBe('identity');
    expect(projection.objects[1].rectNorm).toEqual(rect(0.12, 0.12, 0.05, 0.05));
  });
});

describe('projectConfigPageTransformed', () => {
  it('falls back to raw projection when transformationPage is null', () => {
    const page = buildPage([node('a', rect(0.1, 0.1, 0.2, 0.2))]);

    const projection = projectConfigPageTransformed(page, null);

    expect(projection.objects[0].rectNorm).toEqual(rect(0.1, 0.1, 0.2, 0.2));
    expect(projection.objects[0].transformSource).toBe('identity');
  });

  it('applies the per-object match transform when the object is matched', () => {
    const page = buildPage([node('a', rect(0.1, 0.1, 0.2, 0.2))]);
    const tpage = buildTransformationPage({
      objectMatches: [objectMatch('a', 'r-a', affine(2, 2, 0.05, 0.05), 0.91)]
    });

    const projection = projectConfigPageTransformed(page, tpage);

    expect(projection.objects[0].rectNorm.xNorm).toBeCloseTo(0.1 * 2 + 0.05);
    expect(projection.objects[0].rectNorm.wNorm).toBeCloseTo(0.2 * 2);
    expect(projection.objects[0].transformSource).toBe('matched-object');
    expect(projection.objects[0].transformConfidence).toBeCloseTo(0.91);
  });

  it('walks ancestors to find a matched parent transform', () => {
    const page = buildPage([
      node('parent', rect(0, 0, 1, 1), null, ['child'], 0),
      node('child', rect(0.2, 0.2, 0.1, 0.1), 'parent', [], 1)
    ]);
    const tpage = buildTransformationPage({
      objectMatches: [objectMatch('parent', 'r-parent', affine(1, 1, 0.5, 0.5), 0.88)]
    });

    const projection = projectConfigPageTransformed(page, tpage);

    const child = projection.objects.find((o) => o.objectId === 'child')!;
    expect(child.transformSource).toBe('parent-object');
    expect(child.rectNorm.xNorm).toBeCloseTo(0.7);
    expect(child.rectNorm.yNorm).toBeCloseTo(0.7);
  });

  it('falls back to page consensus when neither object nor ancestor matched', () => {
    const page = buildPage([node('isolated', rect(0.3, 0.3, 0.1, 0.1))]);
    const tpage = buildTransformationPage({
      consensus: {
        transform: affine(1, 1, -0.1, -0.1),
        confidence: 0.6,
        contributingMatchCount: 3,
        outliers: [],
        notes: [],
        warnings: []
      }
    });

    const projection = projectConfigPageTransformed(page, tpage);

    expect(projection.objects[0].transformSource).toBe('consensus');
    expect(projection.objects[0].rectNorm.xNorm).toBeCloseTo(0.2);
    expect(projection.objects[0].rectNorm.yNorm).toBeCloseTo(0.2);
  });

  it('falls back to refined-border level summary when no consensus is available', () => {
    const page = buildPage([node('isolated', rect(0.3, 0.3, 0.1, 0.1))]);
    const tpage = buildTransformationPage({
      levelSummaries: [
        { level: 'border', transform: affine(1, 1, 0, 0), confidence: 1, contributingMatchCount: 1, notes: [], warnings: [] },
        { level: 'refined-border', transform: affine(1, 1, 0.2, 0), confidence: 0.5, contributingMatchCount: 1, notes: [], warnings: [] },
        { level: 'object', transform: null, confidence: 0, contributingMatchCount: 0, notes: [], warnings: [] },
        { level: 'parent-chain', transform: null, confidence: 0, contributingMatchCount: 0, notes: [], warnings: [] }
      ]
    });

    const projection = projectConfigPageTransformed(page, tpage);

    expect(projection.objects[0].transformSource).toBe('refined-border');
    expect(projection.objects[0].rectNorm.xNorm).toBeCloseTo(0.5);
  });

  it('uses the border level transform for the projected border rect', () => {
    const page = buildPage([]);
    const tpage = buildTransformationPage({
      levelSummaries: [
        { level: 'border', transform: affine(0.9, 0.9, 0.05, 0.05), confidence: 1, contributingMatchCount: 1, notes: [], warnings: [] },
        { level: 'refined-border', transform: affine(1, 1, 0, 0), confidence: 1, contributingMatchCount: 1, notes: [], warnings: [] },
        { level: 'object', transform: null, confidence: 0, contributingMatchCount: 0, notes: [], warnings: [] },
        { level: 'parent-chain', transform: null, confidence: 0, contributingMatchCount: 0, notes: [], warnings: [] }
      ]
    });

    const projection = projectConfigPageTransformed(page, tpage);

    expect(projection.borderTransformSource).toBe('border');
    expect(projection.border.xNorm).toBeCloseTo(0.05);
    expect(projection.border.wNorm).toBeCloseTo(0.9);
  });
});
