import { describe, expect, it } from 'vitest';

import type { GeometryFile } from '../../src/core/contracts/geometry';
import type { NormalizedPage } from '../../src/core/contracts/normalized-page';
import { isStructuralModel } from '../../src/core/contracts/structural-model';
import type { CvAdapter } from '../../src/core/engines/structure/cv';
import { createStructuralEngine } from '../../src/core/engines/structure/structural-engine';
import type { PageSurface, PixelRect } from '../../src/core/page-surface/page-surface';

const makePage = (overrides: Partial<NormalizedPage> = {}): NormalizedPage => ({
  schema: 'wrokit/normalized-page',
  version: '2.0',
  pageIndex: 0,
  width: 1000,
  height: 2000,
  aspectRatio: 0.5,
  imageDataUrl: 'data:image/png;base64,xxx',
  sourceName: 'doc.pdf',
  normalization: {
    normalizedAtIso: '2026-01-01T00:00:00Z',
    boundary: 'intake-raster-only',
    pipelineVersion: '1.0'
  },
  ...overrides
});

const stubLoader = async (
  _page: NormalizedPage,
  surface: PageSurface
): Promise<ImageData> => {
  return {
    width: surface.surfaceWidth,
    height: surface.surfaceHeight,
    data: new Uint8ClampedArray(surface.surfaceWidth * surface.surfaceHeight * 4),
    colorSpace: 'srgb'
  } as unknown as ImageData;
};

const cvAdapterReturning = (rect: PixelRect): CvAdapter => ({
  name: 'mock-cv',
  version: '0.0',
  detectContentRect: async () => ({ executionMode: 'heuristic-fallback', contentRectSurface: rect, objectsSurface: [] })
});

describe('createStructuralEngine', () => {
  it('emits a Border + Refined Border as a valid StructuralModel v2', async () => {
    const engine = createStructuralEngine({
      cvAdapter: cvAdapterReturning({ x: 100, y: 200, width: 800, height: 1600 }),
      rasterLoader: stubLoader
    });

    const model = await engine.run({
      pages: [makePage()],
      documentFingerprint: 'surface:test#0:1000x2000',
      nowIso: '2026-04-26T00:00:00Z'
    });

    expect(isStructuralModel(model)).toBe(true);
    expect(model.structureVersion).toBe('wrokit/structure/v2');
    expect(model.cvAdapter).toEqual({ name: 'mock-cv', version: '0.0' });
    expect(model.pages).toHaveLength(1);
    const page = model.pages[0];
    expect(page.cvExecutionMode).toBe('heuristic-fallback');
    expect(page.border.rectNorm).toEqual({ xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 });
    expect(page.refinedBorder.source).toBe('cv-content');
    expect(page.refinedBorder.rectNorm).toEqual({
      xNorm: 0.1,
      yNorm: 0.1,
      wNorm: 0.8,
      hNorm: 0.8
    });
    expect(page.refinedBorder.containsAllSavedBBoxes).toBe(true);
    expect(page.refinedBorder.influencedByBBoxCount).toBe(0);
    expect(page.objectHierarchy.objects).toEqual([]);
    expect(page.pageAnchorRelations.objectToObject).toEqual([]);
    expect(page.pageAnchorRelations.objectToRefinedBorder).toEqual([]);
    expect(page.pageAnchorRelations.refinedBorderToBorder.relativeRect).toEqual({
      xRatio: 0.1,
      yRatio: 0.1,
      wRatio: 0.8,
      hRatio: 0.8
    });
    expect(page.fieldRelationships).toEqual([]);
  });

  it('falls back to full-page when CV reports a degenerate rect and no BBOXes exist', async () => {
    const engine = createStructuralEngine({
      cvAdapter: cvAdapterReturning({ x: 0, y: 0, width: 0, height: 0 }),
      rasterLoader: stubLoader
    });

    const model = await engine.run({
      pages: [makePage()],
      documentFingerprint: 'surface:test#0:1000x2000'
    });

    expect(model.pages[0].refinedBorder.source).toBe('full-page-fallback');
    expect(model.pages[0].refinedBorder.rectNorm).toEqual({
      xNorm: 0,
      yNorm: 0,
      wNorm: 1,
      hNorm: 1
    });
  });

  it('expands Refined Border to include every saved BBOX (ground truth invariant)', async () => {
    const geometry: GeometryFile = {
      schema: 'wrokit/geometry-file',
      version: '1.1',
      geometryFileVersion: 'wrokit/geometry/v1',
      id: 'g1',
      wizardId: 'w1',
      documentFingerprint: 'surface:test#0:1000x2000',
      fields: [
        {
          fieldId: 'header',
          pageIndex: 0,
          // BBOX outside CV content rect on top-left
          bbox: { xNorm: 0.02, yNorm: 0.02, wNorm: 0.05, hNorm: 0.05 },
          pixelBbox: { x: 20, y: 40, width: 50, height: 100 },
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
          confirmedAtIso: '2026-04-26T00:00:00Z',
          confirmedBy: 'user'
        },
        {
          fieldId: 'footer',
          pageIndex: 0,
          // BBOX outside CV content rect on bottom-right
          bbox: { xNorm: 0.92, yNorm: 0.92, wNorm: 0.05, hNorm: 0.05 },
          pixelBbox: { x: 920, y: 1840, width: 50, height: 100 },
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
          confirmedAtIso: '2026-04-26T00:00:00Z',
          confirmedBy: 'user'
        }
      ]
    };

    const engine = createStructuralEngine({
      cvAdapter: cvAdapterReturning({ x: 200, y: 400, width: 600, height: 1200 }),
      rasterLoader: stubLoader
    });

    const model = await engine.run({
      pages: [makePage()],
      geometry,
      documentFingerprint: geometry.documentFingerprint
    });

    const refined = model.pages[0].refinedBorder;
    expect(refined.containsAllSavedBBoxes).toBe(true);
    expect(refined.influencedByBBoxCount).toBe(2);
    expect(refined.source).toBe('cv-and-bbox-union');
    // Refined border must span from top-left BBOX origin to bottom-right BBOX corner
    expect(refined.rectNorm.xNorm).toBeCloseTo(0.02, 6);
    expect(refined.rectNorm.yNorm).toBeCloseTo(0.02, 6);
    expect(refined.rectNorm.xNorm + refined.rectNorm.wNorm).toBeCloseTo(0.97, 6);
    expect(refined.rectNorm.yNorm + refined.rectNorm.hNorm).toBeCloseTo(0.97, 6);
  });

  it('uses a pure bbox union when CV result is unusable but BBOXes exist', async () => {
    const geometry: GeometryFile = {
      schema: 'wrokit/geometry-file',
      version: '1.1',
      geometryFileVersion: 'wrokit/geometry/v1',
      id: 'g1',
      wizardId: 'w1',
      documentFingerprint: 'surface:test#0:1000x2000',
      fields: [
        {
          fieldId: 'a',
          pageIndex: 0,
          bbox: { xNorm: 0.1, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
          pixelBbox: { x: 100, y: 400, width: 200, height: 200 },
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
          confirmedAtIso: '2026-04-26T00:00:00Z',
          confirmedBy: 'user'
        }
      ]
    };

    const engine = createStructuralEngine({
      cvAdapter: cvAdapterReturning({ x: 0, y: 0, width: 0, height: 0 }),
      rasterLoader: stubLoader
    });

    const model = await engine.run({
      pages: [makePage()],
      geometry,
      documentFingerprint: geometry.documentFingerprint
    });

    const refined = model.pages[0].refinedBorder;
    expect(refined.source).toBe('bbox-union');
    expect(refined.containsAllSavedBBoxes).toBe(true);
  });

  it('respects the pageIndexes filter so per-page recompute is possible', async () => {
    const engine = createStructuralEngine({
      cvAdapter: cvAdapterReturning({ x: 50, y: 50, width: 900, height: 1900 }),
      rasterLoader: stubLoader
    });

    const model = await engine.run({
      pages: [makePage({ pageIndex: 0 }), makePage({ pageIndex: 1 })],
      documentFingerprint: 'fp',
      pageIndexes: [1]
    });

    expect(model.pages).toHaveLength(1);
    expect(model.pages[0].pageIndex).toBe(1);
  });

  it('enriches StructuralModel with object hierarchy and field relationships', async () => {
    const geometry: GeometryFile = {
      schema: 'wrokit/geometry-file',
      version: '1.1',
      geometryFileVersion: 'wrokit/geometry/v1',
      id: 'g2',
      wizardId: 'w2',
      documentFingerprint: 'surface:test#0:1000x2000',
      fields: [
        {
          fieldId: 'amount',
          pageIndex: 0,
          bbox: { xNorm: 0.2, yNorm: 0.25, wNorm: 0.1, hNorm: 0.06 },
          pixelBbox: { x: 200, y: 500, width: 100, height: 120 },
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
          confirmedAtIso: '2026-04-26T00:00:00Z',
          confirmedBy: 'user'
        }
      ]
    };

    const engine = createStructuralEngine({
      cvAdapter: {
        name: 'mock-cv',
        version: '0.1',
        detectContentRect: async () => ({
          executionMode: 'opencv-runtime',
          contentRectSurface: { x: 100, y: 200, width: 800, height: 1600 },
          objectsSurface: [
            {
              objectId: 'obj_container',
              type: 'container',
              bboxSurface: { x: 150, y: 300, width: 500, height: 900 },
              confidence: 0.88
            },
            {
              objectId: 'obj_line_h',
              type: 'line-horizontal',
              bboxSurface: { x: 150, y: 450, width: 500, height: 2 },
              confidence: 0.8
            }
          ]
        })
      },
      rasterLoader: stubLoader
    });

    const model = await engine.run({
      pages: [makePage()],
      geometry,
      documentFingerprint: geometry.documentFingerprint
    });

    const page = model.pages[0];
    expect(page.objectHierarchy.objects).toHaveLength(2);
    expect(page.objectHierarchy.objects[0].objectRectNorm.xNorm).toBeCloseTo(0.15, 6);
    expect(page.fieldRelationships).toHaveLength(1);
    expect(page.fieldRelationships[0].fieldId).toBe('amount');
    expect(page.fieldRelationships[0].fieldAnchors.objectAnchors[0].rank).toBe('primary');
    expect(page.pageAnchorRelations.objectToObject.length).toBeGreaterThan(0);
    expect(page.pageAnchorRelations.objectToObject.some((relation) => relation.relationKind === 'container')).toBe(true);
    expect(page.fieldRelationships[0].fieldAnchors.stableObjectAnchors[0].label).toBe('A');
    expect(page.fieldRelationships[0].nearestObjects.length).toBeGreaterThan(0);
  });

  it('stores multi-anchor field relationships (A/B/C and primary/secondary/tertiary) per field', async () => {
    const geometry: GeometryFile = {
      schema: 'wrokit/geometry-file',
      version: '1.1',
      geometryFileVersion: 'wrokit/geometry/v1',
      id: 'g3',
      wizardId: 'w3',
      documentFingerprint: 'surface:test#0:1000x2000',
      fields: [
        {
          fieldId: 'invoice_total',
          pageIndex: 0,
          bbox: { xNorm: 0.43, yNorm: 0.44, wNorm: 0.06, hNorm: 0.04 },
          pixelBbox: { x: 430, y: 880, width: 60, height: 80 },
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
          confirmedAtIso: '2026-04-27T00:00:00Z',
          confirmedBy: 'user'
        }
      ]
    };

    const engine = createStructuralEngine({
      cvAdapter: {
        name: 'mock-cv',
        version: '0.2',
        detectContentRect: async () => ({
          executionMode: 'opencv-runtime',
          contentRectSurface: { x: 100, y: 200, width: 800, height: 1600 },
          objectsSurface: [
            {
              objectId: 'obj_a',
              type: 'container',
              bboxSurface: { x: 350, y: 760, width: 220, height: 260 },
              confidence: 0.94
            },
            {
              objectId: 'obj_b',
              type: 'container',
              bboxSurface: { x: 580, y: 760, width: 180, height: 260 },
              confidence: 0.91
            },
            {
              objectId: 'obj_c',
              type: 'rectangle',
              bboxSurface: { x: 350, y: 1040, width: 220, height: 220 },
              confidence: 0.89
            }
          ]
        })
      },
      rasterLoader: stubLoader
    });

    const model = await engine.run({
      pages: [makePage()],
      geometry,
      documentFingerprint: geometry.documentFingerprint
    });

    const anchors = model.pages[0].fieldRelationships[0].fieldAnchors;
    expect(anchors.objectAnchors).toHaveLength(3);
    expect(anchors.stableObjectAnchors).toHaveLength(3);
    expect(anchors.objectAnchors.map((anchor) => anchor.rank)).toEqual([
      'primary',
      'secondary',
      'tertiary'
    ]);
    expect(anchors.stableObjectAnchors.map((anchor) => anchor.label)).toEqual(['A', 'B', 'C']);
    expect(new Set(anchors.stableObjectAnchors.map((anchor) => anchor.objectId)).size).toBe(3);
    expect(anchors.refinedBorderAnchor.distanceToEdge).toBeGreaterThan(0);
    expect(anchors.borderAnchor.distanceToEdge).toBeGreaterThan(0);
  });
});
