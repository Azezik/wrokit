import { describe, expect, it } from 'vitest';

import type { GeometryFile } from '../../src/core/contracts/geometry';
import type { NormalizedPage } from '../../src/core/contracts/normalized-page';
import { isStructuralModel } from '../../src/core/contracts/structural-model';
import type { CvAdapter } from '../../src/core/engines/structure/cv';
import { __testing, createStructuralEngine } from '../../src/core/engines/structure/structural-engine';
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
    expect(model.structureVersion).toBe('wrokit/structure/v3');
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
              bboxSurface: { x: 150, y: 300, width: 500, height: 900 },
              confidence: 0.88
            },
            {
              objectId: 'obj_line_h',
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
              bboxSurface: { x: 350, y: 760, width: 220, height: 260 },
              confidence: 0.94
            },
            {
              objectId: 'obj_b',
              bboxSurface: { x: 580, y: 760, width: 180, height: 260 },
              confidence: 0.91
            },
            {
              objectId: 'obj_c',
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

  it('builds field anchors A/B/C from the containment chain (deepest container first)', async () => {
    // Mental model: knife sits inside tray inside drawer inside counter.
    // After this engine pass, A must be the deepest container, B its parent,
    // C its grandparent — not whichever 3 objects happen to be closest by
    // center distance.
    const geometry: GeometryFile = {
      schema: 'wrokit/geometry-file',
      version: '1.1',
      geometryFileVersion: 'wrokit/geometry/v1',
      id: 'g_chain',
      wizardId: 'w_chain',
      documentFingerprint: 'surface:test#0:1000x2000',
      fields: [
        {
          fieldId: 'knife',
          pageIndex: 0,
          bbox: { xNorm: 0.32, yNorm: 0.42, wNorm: 0.04, hNorm: 0.02 },
          pixelBbox: { x: 320, y: 840, width: 40, height: 40 },
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
          confirmedAtIso: '2026-04-27T00:00:00Z',
          confirmedBy: 'user'
        }
      ]
    };

    // Surface is 1000x2000.
    // counter (huge): (200, 400) 600x1000      → norm (0.20, 0.20, 0.60, 0.50)
    // drawer (inside counter): (300, 800) 200x300 → norm (0.30, 0.40, 0.20, 0.15)
    // tray (inside drawer):    (310, 820) 80x60   → norm (0.31, 0.41, 0.08, 0.03)
    // distractor sibling far away with closer center than counter:
    // sibling near knife but does not contain it: (340, 836) 8x4 → norm (0.34, 0.418, 0.008, 0.002)
    const engine = createStructuralEngine({
      cvAdapter: {
        name: 'mock-cv',
        version: '0.3',
        detectContentRect: async () => ({
          executionMode: 'opencv-runtime',
          contentRectSurface: { x: 100, y: 200, width: 800, height: 1600 },
          objectsSurface: [
            {
              objectId: 'obj_counter',
              bboxSurface: { x: 200, y: 400, width: 600, height: 1000 },
              confidence: 0.9
            },
            {
              objectId: 'obj_drawer',
              bboxSurface: { x: 300, y: 800, width: 200, height: 300 },
              confidence: 0.88
            },
            {
              objectId: 'obj_tray',
              bboxSurface: { x: 310, y: 820, width: 80, height: 60 },
              confidence: 0.86
            },
            {
              objectId: 'obj_distractor',
              bboxSurface: { x: 340, y: 836, width: 8, height: 4 },
              confidence: 0.7
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

    const relationship = model.pages[0].fieldRelationships[0];
    expect(relationship.fieldId).toBe('knife');
    expect(relationship.containedBy).toBe('obj_tray');
    expect(relationship.fieldAnchors.stableObjectAnchors.map((a) => a.objectId)).toEqual([
      'obj_tray',
      'obj_drawer',
      'obj_counter'
    ]);
    expect(relationship.fieldAnchors.objectAnchors.map((a) => a.objectId)).toEqual([
      'obj_tray',
      'obj_drawer',
      'obj_counter'
    ]);

    // A's relativeFieldRect must place the field strictly inside [0,1] of A.
    const anchorA = relationship.fieldAnchors.stableObjectAnchors[0];
    expect(anchorA.relativeFieldRect.xRatio).toBeGreaterThanOrEqual(0);
    expect(anchorA.relativeFieldRect.yRatio).toBeGreaterThanOrEqual(0);
    expect(anchorA.relativeFieldRect.xRatio + anchorA.relativeFieldRect.wRatio).toBeLessThanOrEqual(1 + 1e-6);
    expect(anchorA.relativeFieldRect.yRatio + anchorA.relativeFieldRect.hRatio).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('falls back to nearest objects only when the containment chain is shorter than 3', async () => {
    // Field has only ONE genuine container; engine must fill remaining anchor
    // slots with supplemental nearby objects (without ever putting non-containers
    // in the A slot).
    const geometry: GeometryFile = {
      schema: 'wrokit/geometry-file',
      version: '1.1',
      geometryFileVersion: 'wrokit/geometry/v1',
      id: 'g_short_chain',
      wizardId: 'w_short_chain',
      documentFingerprint: 'surface:test#0:1000x2000',
      fields: [
        {
          fieldId: 'lonely',
          pageIndex: 0,
          bbox: { xNorm: 0.42, yNorm: 0.5, wNorm: 0.05, hNorm: 0.04 },
          pixelBbox: { x: 420, y: 1000, width: 50, height: 80 },
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
          confirmedAtIso: '2026-04-27T00:00:00Z',
          confirmedBy: 'user'
        }
      ]
    };

    const engine = createStructuralEngine({
      cvAdapter: {
        name: 'mock-cv',
        version: '0.4',
        detectContentRect: async () => ({
          executionMode: 'opencv-runtime',
          contentRectSurface: { x: 100, y: 200, width: 800, height: 1600 },
          objectsSurface: [
            {
              objectId: 'obj_only_container',
              bboxSurface: { x: 400, y: 980, width: 200, height: 200 },
              confidence: 0.9
            },
            {
              objectId: 'obj_nearby_sibling',
              bboxSurface: { x: 650, y: 980, width: 150, height: 150 },
              confidence: 0.85
            },
            {
              objectId: 'obj_far_block',
              bboxSurface: { x: 100, y: 200, width: 80, height: 80 },
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

    const relationship = model.pages[0].fieldRelationships[0];
    const anchors = relationship.fieldAnchors.stableObjectAnchors;
    expect(anchors[0].objectId).toBe('obj_only_container');
    expect(relationship.containedBy).toBe('obj_only_container');
    expect(anchors).toHaveLength(3);
    expect(new Set(anchors.map((a) => a.objectId)).size).toBe(3);
  });
});

describe('decomposeBlobsSecondPass', () => {
  // Helper to fabricate a small ImageData with a few row-baseline horizontals
  // inside a panel so the relaxed line-grid pass can find sub-rects.
  const makePixelsWithRows = (
    surfaceWidth: number,
    surfaceHeight: number,
    panel: { left: number; top: number; right: number; bottom: number },
    rowBaselines: number[]
  ): ImageData => {
    const data = new Uint8ClampedArray(surfaceWidth * surfaceHeight * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
    const paint = (left: number, top: number, right: number, bottom: number) => {
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const idx = (y * surfaceWidth + x) * 4;
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
          data[idx + 3] = 255;
        }
      }
    };
    // Panel border (4 sides).
    paint(panel.left, panel.top, panel.right, panel.top + 2);
    paint(panel.left, panel.bottom - 2, panel.right, panel.bottom);
    paint(panel.left, panel.top, panel.left + 2, panel.bottom);
    paint(panel.right - 2, panel.top, panel.right, panel.bottom);
    // Internal row baselines spanning ALMOST the panel width (a real
    // signature box has row underlines that don't reach the panel edges).
    for (const y of rowBaselines) {
      paint(panel.left + 6, y, panel.right - 6, y + 2);
    }
    return { width: surfaceWidth, height: surfaceHeight, data, colorSpace: 'srgb' } as unknown as ImageData;
  };

  const surface: PageSurface = { pageIndex: 0, surfaceWidth: 800, surfaceHeight: 600 };

  it('emits sub-objects when a leaf blob has internal row baselines', () => {
    const panel = { left: 100, top: 100, right: 700, bottom: 500 };
    const pixels = makePixelsWithRows(surface.surfaceWidth, surface.surfaceHeight, panel, [
      // Four equally-spaced row baselines across the panel interior.
      180,
      260,
      340,
      420
    ]);

    const blob = {
      objectId: 'obj_blob_0',
      bboxSurface: {
        x: panel.left,
        y: panel.top,
        width: panel.right - panel.left,
        height: panel.bottom - panel.top
      },
      confidence: 0.78
    };

    const subObjects = __testing.decomposeBlobsSecondPass(pixels, surface, [blob]);

    // The relaxed line-grid pass should find at least a couple of row-bounded
    // sub-rects inside the panel.
    expect(subObjects.length).toBeGreaterThan(0);
    // Every sub-object's bbox is contained in the parent blob.
    for (const sub of subObjects) {
      expect(sub.bboxSurface.x).toBeGreaterThanOrEqual(blob.bboxSurface.x);
      expect(sub.bboxSurface.y).toBeGreaterThanOrEqual(blob.bboxSurface.y);
      expect(sub.bboxSurface.x + sub.bboxSurface.width).toBeLessThanOrEqual(
        blob.bboxSurface.x + blob.bboxSurface.width + 1
      );
      expect(sub.bboxSurface.y + sub.bboxSurface.height).toBeLessThanOrEqual(
        blob.bboxSurface.y + blob.bboxSurface.height + 1
      );
      // ID is namespaced under the parent blob so the hierarchy pass can
      // attribute it back.
      expect(sub.objectId).toMatch(/^obj_blob_0_sub_\d+$/);
    }
  });

  it('skips blobs that already have a contained child object (first pass already represented structure)', () => {
    const panel = { left: 100, top: 100, right: 700, bottom: 500 };
    const pixels = makePixelsWithRows(surface.surfaceWidth, surface.surfaceHeight, panel, [180, 260, 340, 420]);

    const blob = {
      objectId: 'obj_blob_0',
      bboxSurface: {
        x: panel.left,
        y: panel.top,
        width: panel.right - panel.left,
        height: panel.bottom - panel.top
      },
      confidence: 0.78
    };
    // A first-pass child rect inside the blob — decomposition must NOT fire.
    const child = {
      objectId: 'obj_cv_cell_0',
      bboxSurface: { x: 200, y: 150, width: 200, height: 100 },
      confidence: 0.85
    };

    const subObjects = __testing.decomposeBlobsSecondPass(pixels, surface, [blob, child]);
    expect(subObjects).toEqual([]);
  });

  it('skips blobs whose normalized footprint is below the decomposition floor', () => {
    const tinyPanel = { left: 10, top: 10, right: 50, bottom: 50 };
    const pixels = makePixelsWithRows(surface.surfaceWidth, surface.surfaceHeight, tinyPanel, [25, 35]);

    const blob = {
      objectId: 'obj_blob_0',
      bboxSurface: {
        x: tinyPanel.left,
        y: tinyPanel.top,
        width: tinyPanel.right - tinyPanel.left,
        height: tinyPanel.bottom - tinyPanel.top
      },
      confidence: 0.78
    };

    const subObjects = __testing.decomposeBlobsSecondPass(pixels, surface, [blob]);
    expect(subObjects).toEqual([]);
  });

  it('does not decompose line-grid cells (obj_cv_cell_*)', () => {
    const panel = { left: 100, top: 100, right: 700, bottom: 500 };
    const pixels = makePixelsWithRows(surface.surfaceWidth, surface.surfaceHeight, panel, [180, 260, 340, 420]);

    const cell = {
      objectId: 'obj_cv_cell_0',
      bboxSurface: {
        x: panel.left,
        y: panel.top,
        width: panel.right - panel.left,
        height: panel.bottom - panel.top
      },
      confidence: 0.78
    };

    const subObjects = __testing.decomposeBlobsSecondPass(pixels, surface, [cell]);
    expect(subObjects).toEqual([]);
  });
});
