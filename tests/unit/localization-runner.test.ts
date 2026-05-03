import { describe, expect, it } from 'vitest';

import type { GeometryFile } from '../../src/core/contracts/geometry';
import type { NormalizedPage } from '../../src/core/contracts/normalized-page';
import type {
  StructuralModel,
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralPage
} from '../../src/core/contracts/structural-model';
import type { TransformationModel } from '../../src/core/contracts/transformation-model';
import { createLocalizationRunner, __testing } from '../../src/core/runtime/localization-runner';

const runtimePage: NormalizedPage = {
  schema: 'wrokit/normalized-page',
  version: '2.0',
  pageIndex: 0,
  width: 1000,
  height: 2000,
  aspectRatio: 0.5,
  imageDataUrl: 'data:image/png;base64,AAA',
  sourceName: 'runtime.png',
  normalization: {
    normalizedAtIso: '2026-01-01T00:00:00Z',
    boundary: 'intake-raster-only',
    pipelineVersion: '1.0'
  }
};

const configGeometry: GeometryFile = {
  schema: 'wrokit/geometry-file',
  version: '1.1',
  geometryFileVersion: 'wrokit/geometry/v1',
  id: 'geo_1',
  wizardId: 'Invoice Wizard',
  documentFingerprint: 'surface:config#0:1000x2000',
  fields: [
    {
      fieldId: 'invoice_number',
      pageIndex: 0,
      bbox: { xNorm: 0.25, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
      pixelBbox: { x: 250, y: 400, width: 200, height: 200 },
      pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
      confirmedAtIso: '2026-01-01T00:00:00Z',
      confirmedBy: 'user'
    }
  ]
};

const createModel = (id: string, xNorm: number, yNorm: number, wNorm: number, hNorm: number): StructuralModel => ({
  schema: 'wrokit/structural-model',
  version: '4.0',
  structureVersion: 'wrokit/structure/v3',
  id,
  documentFingerprint: `${id}-fingerprint`,
  cvAdapter: { name: 'opencv-js', version: '1.0' },
  pages: [
    {
      pageIndex: 0,
      pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
      cvExecutionMode: 'heuristic-fallback',
      border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
      refinedBorder: {
        rectNorm: { xNorm, yNorm, wNorm, hNorm },
        cvContentRectNorm: { xNorm, yNorm, wNorm, hNorm },
        source: 'cv-content',
        influencedByBBoxCount: 0,
        containsAllSavedBBoxes: true
      },
      objectHierarchy: { objects: [] },
      pageAnchorRelations: {
        objectToObject: [],
        objectToRefinedBorder: [],
        refinedBorderToBorder: {
          relativeRect: { xRatio: xNorm, yRatio: yNorm, wRatio: wNorm, hRatio: hNorm }
        }
      },
      fieldRelationships: []
    }
  ],
  createdAtIso: '2026-01-01T00:00:00Z'
});

describe('localization-runner', () => {
  it('solves a refined-border transform and relocates saved geometry', async () => {
    const runner = createLocalizationRunner();
    const configModel = createModel('config_struct', 0.1, 0.1, 0.5, 0.5);
    const runtimeModel = createModel('runtime_struct', 0.2, 0.3, 0.4, 0.3);

    const result = await runner.run({
      wizardId: 'Invoice Wizard',
      configGeometry,
      configStructuralModel: configModel,
      runtimeStructuralModel: runtimeModel,
      runtimePages: [runtimePage],
      predictedId: 'pred_1',
      nowIso: '2026-03-01T00:00:00Z'
    });

    expect(result.id).toBe('pred_1');
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].bbox).toEqual({
      xNorm: 0.32,
      yNorm: 0.36,
      wNorm: 0.16000000000000003,
      hNorm: 0.06
    });
    expect(result.fields[0].transform).toMatchObject({
      scaleX: 0.8,
      scaleY: 0.6,
      translateX: 0.12,
      translateY: 0.24
    });
  });

  describe('off-page clipping', () => {
    it('preserves width/height when a partially off-page transformed box can be shifted to fit', () => {
      const transformed = __testing.applyTransformToBox(
        { xNorm: 0.9, yNorm: 0.92, wNorm: 0.3, hNorm: 0.05 },
        {
          pageIndex: 0,
          basis: 'refined-border',
          sourceConfigRectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 },
          sourceRuntimeRectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 },
          scaleX: 1,
          scaleY: 1,
          translateX: 0.1,
          translateY: 0.05
        }
      );

      // Width fits in [0,1], so the box is shifted left to fit instead of
      // independently clamping each side and silently shrinking it.
      expect(transformed.box.wNorm).toBeCloseTo(0.3);
      expect(transformed.box.hNorm).toBeCloseTo(0.05);
      expect(transformed.box.xNorm).toBeCloseTo(0.7);
      expect(transformed.box.yNorm).toBeCloseTo(0.95);
      expect(transformed.clipWarning).toBeDefined();
      expect(transformed.clipWarning).toMatch(/width\/height preserved/);
      expect(transformed.clipWarning).toMatch(/right/);
      expect(transformed.clipWarning).toMatch(/bottom/);
    });

    it('clamps and warns when a transformed box is larger than the page in a dimension', () => {
      const transformed = __testing.applyTransformToBox(
        { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 },
        {
          pageIndex: 0,
          basis: 'refined-border',
          sourceConfigRectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 },
          sourceRuntimeRectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 },
          scaleX: 1.5,
          scaleY: 1,
          translateX: 0,
          translateY: 0
        }
      );

      expect(transformed.box.wNorm).toBe(1);
      expect(transformed.box.xNorm).toBe(0);
      expect(transformed.box.hNorm).toBeCloseTo(1);
      expect(transformed.clipWarning).toBeDefined();
      expect(transformed.clipWarning).toMatch(/exceeds page in width/);
    });

    it('does not emit a clip warning when the transformed box already fits within [0,1]', () => {
      const transformed = __testing.applyTransformToBox(
        { xNorm: 0.1, yNorm: 0.1, wNorm: 0.2, hNorm: 0.2 },
        {
          pageIndex: 0,
          basis: 'refined-border',
          sourceConfigRectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 },
          sourceRuntimeRectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 },
          scaleX: 1,
          scaleY: 1,
          translateX: 0.1,
          translateY: 0.1
        }
      );

      expect(transformed.box).toEqual({
        xNorm: 0.2,
        yNorm: 0.2,
        wNorm: 0.2,
        hNorm: 0.2
      });
      expect(transformed.clipWarning).toBeUndefined();
    });

    it('preserves width/height when projectRelativeRect lands partially off-page', () => {
      const projected = __testing.projectRelativeRect(
        { xRatio: 0.9, yRatio: 0.0, wRatio: 0.5, hRatio: 0.2 },
        { xNorm: 0.5, yNorm: 0.5, wNorm: 0.5, hNorm: 0.5 }
      );

      expect(projected.box.wNorm).toBeCloseTo(0.25);
      expect(projected.box.hNorm).toBeCloseTo(0.1);
      // Box shifted back inside [0,1] rather than each side independently clamped.
      expect(projected.box.xNorm).toBeCloseTo(0.75);
      expect(projected.box.yNorm).toBeCloseTo(0.5);
      expect(projected.clipWarning).toBeDefined();
      expect(projected.clipWarning).toMatch(/projected/);
    });

    it('surfaces clip warnings on the predicted field when the projected box overflows', async () => {
      const runner = createLocalizationRunner();
      // Choose refined-border rects that yield a unit translation, so the
      // configured field bbox [0.25,0.2,0.2,0.1] projects to roughly
      // [1.0,0.95,0.2,0.1] — past the right edge — exercising the clip path.
      const configModel = createModel('config_struct_off', 0.1, 0.1, 0.5, 0.5);
      const runtimeModel = createModel('runtime_struct_off', 0.85, 0.85, 0.5, 0.5);

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: configModel,
        runtimeStructuralModel: runtimeModel,
        runtimePages: [runtimePage],
        predictedId: 'pred_off',
        nowIso: '2026-03-01T00:00:00Z'
      });

      const field = result.fields[0];
      expect(field.warnings).toBeDefined();
      expect(field.warnings?.some((w) => /off-page|exceeds page|partially off-page/.test(w))).toBe(true);
      // Width/height should not have collapsed to zero (the old clamp bug).
      expect(field.bbox.wNorm).toBeGreaterThan(0);
      expect(field.bbox.hNorm).toBeGreaterThan(0);
    });
  });

  describe('artifact cross-reference validation', () => {
    it('rejects a configGeometry whose wizardId does not match the expected wizardId', async () => {
      const runner = createLocalizationRunner();
      const configModel = createModel('config_struct', 0.1, 0.1, 0.5, 0.5);
      const runtimeModel = createModel('runtime_struct', 0.2, 0.3, 0.4, 0.3);

      await expect(
        runner.run({
          wizardId: 'Other Wizard',
          configGeometry,
          configStructuralModel: configModel,
          runtimeStructuralModel: runtimeModel,
          runtimePages: [runtimePage]
        })
      ).rejects.toThrow(/configGeometry\.wizardId.*does not match expected wizardId/);
    });

    it('rejects a TransformationModel whose config.id does not match configStructuralModel.id', async () => {
      const runner = createLocalizationRunner();
      const configModel = createModel('config_struct', 0.1, 0.1, 0.5, 0.5);
      const runtimeModel = createModel('runtime_struct', 0.2, 0.3, 0.4, 0.3);
      const transformationModel: TransformationModel = {
        schema: 'wrokit/transformation-model',
        version: '1.0',
        transformVersion: 'wrokit/transformation/v1',
        id: 'tm_mismatch',
        config: { id: 'some_other_struct', documentFingerprint: 'whatever' },
        runtime: { id: runtimeModel.id, documentFingerprint: runtimeModel.documentFingerprint },
        pages: [],
        overallConfidence: 0,
        notes: [],
        warnings: [],
        createdAtIso: '2026-02-01T00:00:00Z'
      };

      await expect(
        runner.run({
          wizardId: 'Invoice Wizard',
          configGeometry,
          configStructuralModel: configModel,
          runtimeStructuralModel: runtimeModel,
          runtimePages: [runtimePage],
          transformationModel
        })
      ).rejects.toThrow(/transformationModel\.config\.id.*does not match configStructuralModel\.id/);
    });

    it('rejects a TransformationModel whose runtime.id does not match runtimeStructuralModel.id', async () => {
      const runner = createLocalizationRunner();
      const configModel = createModel('config_struct', 0.1, 0.1, 0.5, 0.5);
      const runtimeModel = createModel('runtime_struct', 0.2, 0.3, 0.4, 0.3);
      const transformationModel: TransformationModel = {
        schema: 'wrokit/transformation-model',
        version: '1.0',
        transformVersion: 'wrokit/transformation/v1',
        id: 'tm_mismatch',
        config: { id: configModel.id, documentFingerprint: configModel.documentFingerprint },
        runtime: { id: 'some_other_runtime', documentFingerprint: 'whatever' },
        pages: [],
        overallConfidence: 0,
        notes: [],
        warnings: [],
        createdAtIso: '2026-02-01T00:00:00Z'
      };

      await expect(
        runner.run({
          wizardId: 'Invoice Wizard',
          configGeometry,
          configStructuralModel: configModel,
          runtimeStructuralModel: runtimeModel,
          runtimePages: [runtimePage],
          transformationModel
        })
      ).rejects.toThrow(/transformationModel\.runtime\.id.*does not match runtimeStructuralModel\.id/);
    });

    it('accepts artifacts with matching wizardId and structural-model ids', async () => {
      const runner = createLocalizationRunner();
      const configModel = createModel('config_struct', 0.1, 0.1, 0.5, 0.5);
      const runtimeModel = createModel('runtime_struct', 0.2, 0.3, 0.4, 0.3);
      const transformationModel: TransformationModel = {
        schema: 'wrokit/transformation-model',
        version: '1.0',
        transformVersion: 'wrokit/transformation/v1',
        id: 'tm_ok',
        config: { id: configModel.id, documentFingerprint: configModel.documentFingerprint },
        runtime: { id: runtimeModel.id, documentFingerprint: runtimeModel.documentFingerprint },
        pages: [],
        overallConfidence: 0,
        notes: [],
        warnings: [],
        createdAtIso: '2026-02-01T00:00:00Z'
      };

      await expect(
        runner.run({
          wizardId: 'Invoice Wizard',
          configGeometry,
          configStructuralModel: configModel,
          runtimeStructuralModel: runtimeModel,
          runtimePages: [runtimePage],
          transformationModel
        })
      ).resolves.toBeDefined();
    });
  });

  it('prioritizes containment-chain anchor ranking over nearest-label ordering', () => {
    const field = configGeometry.fields[0];

    const buildPage = (objects: StructuralObjectNode[], fieldAnchorObjectId: string): StructuralPage => ({
      pageIndex: 0,
      pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
      cvExecutionMode: 'heuristic-fallback',
      border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
      refinedBorder: {
        rectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
        cvContentRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
        source: 'cv-content',
        influencedByBBoxCount: 0,
        containsAllSavedBBoxes: true
      },
      objectHierarchy: { objects },
      pageAnchorRelations: {
        objectToObject: [
          {
            fromObjectId: 'obj_container',
            toObjectId: 'obj_adjacent',
            relationKind: 'adjacent',
            relativeRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 },
            fallbackOrder: 0,
            distance: 0.1
          }
        ],
        objectToRefinedBorder: objects.map((object) => ({
          objectId: object.objectId,
          relativeRect: { xRatio: object.objectRectNorm.xNorm, yRatio: object.objectRectNorm.yNorm, wRatio: object.objectRectNorm.wNorm, hRatio: object.objectRectNorm.hNorm }
        })),
        refinedBorderToBorder: {
          relativeRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.8, hRatio: 0.8 }
        }
      },
      fieldRelationships: [
        {
          fieldId: field.fieldId,
          fieldAnchors: {
            objectAnchors: [
              { rank: 'primary', objectId: 'obj_sibling', relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } },
              { rank: 'secondary', objectId: 'obj_adjacent', relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } },
              { rank: 'tertiary', objectId: fieldAnchorObjectId, relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } }
            ],
            stableObjectAnchors: [
              { label: 'A', objectId: 'obj_sibling', distance: 0.01, relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } },
              { label: 'B', objectId: 'obj_adjacent', distance: 0.02, relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } },
              { label: 'C', objectId: fieldAnchorObjectId, distance: 0.05, relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } }
            ],
            refinedBorderAnchor: {
              relativeFieldRect: { xRatio: 0.2, yRatio: 0.2, wRatio: 0.2, hRatio: 0.1 },
              distanceToEdge: 0.1
            },
            borderAnchor: {
              relativeFieldRect: { xRatio: 0.2, yRatio: 0.2, wRatio: 0.2, hRatio: 0.1 },
              distanceToEdge: 0.2
            }
          },
          objectAnchorGraph: [],
          containedBy: fieldAnchorObjectId,
          nearestObjects: [
            { objectId: 'obj_sibling', distance: 0.01 },
            { objectId: 'obj_adjacent', distance: 0.02 },
            { objectId: fieldAnchorObjectId, distance: 0.05 }
          ],
          relativePositionWithinParent: null,
          distanceToBorder: 0.2,
          distanceToRefinedBorder: 0.1
        }
      ]
    });

    const configPage = buildPage(
      [
        {
          objectId: 'obj_container',
          objectRectNorm: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.5, hNorm: 0.4 },
          bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.5, hNorm: 0.4 },
          parentObjectId: null,
          childObjectIds: ['obj_child'],
          confidence: 0.9,
          depth: 0
        },
        {
          objectId: 'obj_child',
          objectRectNorm: { xNorm: 0.25, yNorm: 0.25, wNorm: 0.1, hNorm: 0.1 },
          bbox: { xNorm: 0.25, yNorm: 0.25, wNorm: 0.1, hNorm: 0.1 },
          parentObjectId: 'obj_container',
          childObjectIds: [],
          confidence: 0.8,
          depth: 0
        },
        {
          objectId: 'obj_sibling',
          objectRectNorm: { xNorm: 0.72, yNorm: 0.2, wNorm: 0.2, hNorm: 0.2 },
          bbox: { xNorm: 0.72, yNorm: 0.2, wNorm: 0.2, hNorm: 0.2 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.8,
          depth: 0
        },
        {
          objectId: 'obj_adjacent',
          objectRectNorm: { xNorm: 0.2, yNorm: 0.62, wNorm: 0.2, hNorm: 0.2 },
          bbox: { xNorm: 0.2, yNorm: 0.62, wNorm: 0.2, hNorm: 0.2 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.8,
          depth: 0
        }
      ],
      'obj_container'
    );

    // Same-document scenario: object ids match between config and runtime.
    // The test asserts the containment-chain anchor (C = obj_container) is
    // tried before the nearest sibling/adjacent anchors (A/B), so the field
    // resolves through C even though A and B exist in runtime.
    const runtimePageStructural = buildPage(
      [
        {
          objectId: 'obj_container',
          objectRectNorm: { xNorm: 0.3, yNorm: 0.25, wNorm: 0.45, hNorm: 0.4 },
          bbox: { xNorm: 0.3, yNorm: 0.25, wNorm: 0.45, hNorm: 0.4 },
          parentObjectId: null,
          childObjectIds: ['obj_child'],
          confidence: 0.9,
          depth: 0
        },
        {
          objectId: 'obj_child',
          objectRectNorm: { xNorm: 0.35, yNorm: 0.3, wNorm: 0.08, hNorm: 0.08 },
          bbox: { xNorm: 0.35, yNorm: 0.3, wNorm: 0.08, hNorm: 0.08 },
          parentObjectId: 'obj_container',
          childObjectIds: [],
          confidence: 0.7,
          depth: 0
        },
        {
          objectId: 'obj_sibling',
          objectRectNorm: { xNorm: 0.7, yNorm: 0.18, wNorm: 0.2, hNorm: 0.2 },
          bbox: { xNorm: 0.7, yNorm: 0.18, wNorm: 0.2, hNorm: 0.2 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.8,
          depth: 0
        },
        {
          objectId: 'obj_adjacent',
          objectRectNorm: { xNorm: 0.22, yNorm: 0.64, wNorm: 0.2, hNorm: 0.2 },
          bbox: { xNorm: 0.22, yNorm: 0.64, wNorm: 0.2, hNorm: 0.2 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.8,
          depth: 0
        }
      ],
      'obj_container'
    );

    const resolution = __testing.resolveFieldAnchor(field, configPage, runtimePageStructural);
    expect(resolution.tier).toBe('field-object-c');
    expect(resolution.transform.configObjectId).toBe('obj_container');
    expect(resolution.transform.runtimeObjectId).toBe('obj_container');
    expect(resolution.transform.objectMatchStrategy).toBe('id');
  });

  it('uses deterministic fallback order A -> B -> C -> Refined -> Border', () => {
    const sourceField = configGeometry.fields[0];

    const buildPage = (
      objects: StructuralObjectNode[],
      stableObjectIds: [string, string, string]
    ): StructuralPage => ({
      pageIndex: 0,
      pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
      cvExecutionMode: 'heuristic-fallback',
      border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
      refinedBorder: {
        rectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
        cvContentRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
        source: 'cv-content',
        influencedByBBoxCount: 0,
        containsAllSavedBBoxes: true
      },
      objectHierarchy: { objects },
      pageAnchorRelations: {
        objectToObject: [],
        objectToRefinedBorder: [],
        refinedBorderToBorder: {
          relativeRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.8, hRatio: 0.8 }
        }
      },
      fieldRelationships: [
        {
          fieldId: sourceField.fieldId,
          fieldAnchors: {
            objectAnchors: [
              { rank: 'primary', objectId: stableObjectIds[0], relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } },
              { rank: 'secondary', objectId: stableObjectIds[1], relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } },
              { rank: 'tertiary', objectId: stableObjectIds[2], relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } }
            ],
            stableObjectAnchors: [
              { label: 'A', objectId: stableObjectIds[0], distance: 0.1, relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } },
              { label: 'B', objectId: stableObjectIds[1], distance: 0.2, relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } },
              { label: 'C', objectId: stableObjectIds[2], distance: 0.3, relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } }
            ],
            refinedBorderAnchor: {
              relativeFieldRect: { xRatio: 0.2, yRatio: 0.2, wRatio: 0.2, hRatio: 0.1 },
              distanceToEdge: 0.1
            },
            borderAnchor: {
              relativeFieldRect: { xRatio: 0.25, yRatio: 0.25, wRatio: 0.2, hRatio: 0.1 },
              distanceToEdge: 0.2
            }
          },
          objectAnchorGraph: [],
          containedBy: null,
          nearestObjects: [],
          relativePositionWithinParent: null,
          distanceToBorder: 0.2,
          distanceToRefinedBorder: 0.1
        }
      ]
    });

    const configPage = buildPage(
      [
        {
          objectId: 'obj_a',
          objectRectNorm: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.3, hNorm: 0.3 },
          bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.3, hNorm: 0.3 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.9,
          depth: 0
        },
        {
          objectId: 'obj_b',
          objectRectNorm: { xNorm: 0.55, yNorm: 0.2, wNorm: 0.2, hNorm: 0.3 },
          bbox: { xNorm: 0.55, yNorm: 0.2, wNorm: 0.2, hNorm: 0.3 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.85,
          depth: 0
        },
        {
          objectId: 'obj_c',
          objectRectNorm: { xNorm: 0.2, yNorm: 0.55, wNorm: 0.25, hNorm: 0.2 },
          bbox: { xNorm: 0.2, yNorm: 0.55, wNorm: 0.25, hNorm: 0.2 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.8,
          depth: 0
        }
      ],
      ['obj_a', 'obj_b', 'obj_c']
    );

    const runtimeAll = buildPage(
      [
        {
          objectId: 'obj_a',
          objectRectNorm: { xNorm: 0.21, yNorm: 0.22, wNorm: 0.3, hNorm: 0.3 },
          bbox: { xNorm: 0.21, yNorm: 0.22, wNorm: 0.3, hNorm: 0.3 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.9,
          depth: 0
        },
        {
          objectId: 'obj_b',
          objectRectNorm: { xNorm: 0.56, yNorm: 0.22, wNorm: 0.2, hNorm: 0.3 },
          bbox: { xNorm: 0.56, yNorm: 0.22, wNorm: 0.2, hNorm: 0.3 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.85,
          depth: 0
        },
        {
          objectId: 'obj_c',
          objectRectNorm: { xNorm: 0.22, yNorm: 0.56, wNorm: 0.25, hNorm: 0.2 },
          bbox: { xNorm: 0.22, yNorm: 0.56, wNorm: 0.25, hNorm: 0.2 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.8,
          depth: 0
        }
      ],
      ['obj_a', 'obj_b', 'obj_c']
    );

    const runtimeNoA = buildPage(runtimeAll.objectHierarchy.objects.filter((obj) => obj.objectId !== 'obj_a'), ['obj_a', 'obj_b', 'obj_c']);
    const runtimeNoAB = buildPage(runtimeAll.objectHierarchy.objects.filter((obj) => obj.objectId !== 'obj_a' && obj.objectId !== 'obj_b'), ['obj_a', 'obj_b', 'obj_c']);
    const runtimeNoABC = buildPage([], ['obj_a', 'obj_b', 'obj_c']);

    expect(__testing.resolveFieldAnchor(sourceField, configPage, runtimeAll).tier).toBe('field-object-a');
    expect(__testing.resolveFieldAnchor(sourceField, configPage, runtimeNoA).tier).toBe('field-object-b');
    expect(__testing.resolveFieldAnchor(sourceField, configPage, runtimeNoAB).tier).toBe('field-object-c');
    expect(__testing.resolveFieldAnchor(sourceField, configPage, runtimeNoABC).tier).toBe('refined-border');

    const configNoRefined = buildPage(configPage.objectHierarchy.objects, ['obj_a', 'obj_b', 'obj_c']);
    delete (configNoRefined.fieldRelationships[0].fieldAnchors as { refinedBorderAnchor?: unknown }).refinedBorderAnchor;
    const tierBorder = __testing.resolveFieldAnchor(sourceField, configNoRefined as StructuralPage, runtimeNoABC).tier;
    expect(tierBorder).toBe('border');
  });

  it('relocates a deeply nested field through the containment chain into the runtime container', async () => {
    // End-to-end proof: when Config holds counter > drawer > tray > field, and
    // Run Mode sees the same chain but shifted/scaled, the predicted box must
    // land inside the runtime tray (not at some random page-relative location).
    const wizardId = 'Kitchen Wizard';
    const fieldId = 'knife';
    const configGeo: GeometryFile = {
      schema: 'wrokit/geometry-file',
      version: '1.1',
      geometryFileVersion: 'wrokit/geometry/v1',
      id: 'geo_chain',
      wizardId,
      documentFingerprint: 'surface:config#0:1000x2000',
      // Field sits at the top-left quarter of the config tray.
      fields: [
        {
          fieldId,
          pageIndex: 0,
          bbox: { xNorm: 0.31, yNorm: 0.41, wNorm: 0.02, hNorm: 0.0075 },
          pixelBbox: { x: 310, y: 820, width: 20, height: 15 },
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
          confirmedAtIso: '2026-04-27T00:00:00Z',
          confirmedBy: 'user'
        }
      ]
    };

    const buildModel = (
      id: string,
      counter: StructuralNormalizedRect,
      drawer: StructuralNormalizedRect,
      tray: StructuralNormalizedRect
    ): StructuralModel => {
      const objects: StructuralObjectNode[] = [
        {
          objectId: 'obj_counter',
          objectRectNorm: counter,
          bbox: counter,
          parentObjectId: null,
          childObjectIds: ['obj_drawer'],
          confidence: 0.9,
          depth: 0
        },
        {
          objectId: 'obj_drawer',
          objectRectNorm: drawer,
          bbox: drawer,
          parentObjectId: 'obj_counter',
          childObjectIds: ['obj_tray'],
          confidence: 0.88,
          depth: 0
        },
        {
          objectId: 'obj_tray',
          objectRectNorm: tray,
          bbox: tray,
          parentObjectId: 'obj_drawer',
          childObjectIds: [],
          confidence: 0.86,
          depth: 0
        }
      ];

      // Field as it appears in this model (used only to compute relativeFieldRect).
      // For the runtime model we don't need fieldRelationships — the runner reads
      // the *config* relationship and projects it through the runtime anchor.
      const trayRelativeForField = (fieldRect: { xNorm: number; yNorm: number; wNorm: number; hNorm: number }) => ({
        xRatio: (fieldRect.xNorm - tray.xNorm) / tray.wNorm,
        yRatio: (fieldRect.yNorm - tray.yNorm) / tray.hNorm,
        wRatio: fieldRect.wNorm / tray.wNorm,
        hRatio: fieldRect.hNorm / tray.hNorm
      });
      const drawerRelativeForField = (fieldRect: { xNorm: number; yNorm: number; wNorm: number; hNorm: number }) => ({
        xRatio: (fieldRect.xNorm - drawer.xNorm) / drawer.wNorm,
        yRatio: (fieldRect.yNorm - drawer.yNorm) / drawer.hNorm,
        wRatio: fieldRect.wNorm / drawer.wNorm,
        hRatio: fieldRect.hNorm / drawer.hNorm
      });
      const counterRelativeForField = (fieldRect: { xNorm: number; yNorm: number; wNorm: number; hNorm: number }) => ({
        xRatio: (fieldRect.xNorm - counter.xNorm) / counter.wNorm,
        yRatio: (fieldRect.yNorm - counter.yNorm) / counter.hNorm,
        wRatio: fieldRect.wNorm / counter.wNorm,
        hRatio: fieldRect.hNorm / counter.hNorm
      });

      const fieldRect = configGeo.fields[0].bbox;

      return {
        schema: 'wrokit/structural-model',
        version: '4.0',
        structureVersion: 'wrokit/structure/v3',
        id,
        documentFingerprint: `${id}-fingerprint`,
        cvAdapter: { name: 'mock-cv', version: '1.0' },
        pages: [
          {
            pageIndex: 0,
            pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
            cvExecutionMode: 'opencv-runtime',
            border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
            refinedBorder: {
              rectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
              cvContentRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
              source: 'cv-content',
              influencedByBBoxCount: 0,
              containsAllSavedBBoxes: true
            },
            objectHierarchy: { objects },
            pageAnchorRelations: {
              objectToObject: [],
              objectToRefinedBorder: [],
              refinedBorderToBorder: {
                relativeRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.8, hRatio: 0.8 }
              }
            },
            fieldRelationships: [
              {
                fieldId,
                fieldAnchors: {
                  // A=tray (deepest), B=drawer, C=counter — exactly as the
                  // engine now produces from the containment chain.
                  objectAnchors: [
                    { rank: 'primary', objectId: 'obj_tray', relativeFieldRect: trayRelativeForField(fieldRect) },
                    { rank: 'secondary', objectId: 'obj_drawer', relativeFieldRect: drawerRelativeForField(fieldRect) },
                    { rank: 'tertiary', objectId: 'obj_counter', relativeFieldRect: counterRelativeForField(fieldRect) }
                  ],
                  stableObjectAnchors: [
                    { label: 'A', objectId: 'obj_tray', distance: 0, relativeFieldRect: trayRelativeForField(fieldRect) },
                    { label: 'B', objectId: 'obj_drawer', distance: 0, relativeFieldRect: drawerRelativeForField(fieldRect) },
                    { label: 'C', objectId: 'obj_counter', distance: 0, relativeFieldRect: counterRelativeForField(fieldRect) }
                  ],
                  refinedBorderAnchor: {
                    relativeFieldRect: { xRatio: 0.5, yRatio: 0.5, wRatio: 0.1, hRatio: 0.1 },
                    distanceToEdge: 0.1
                  },
                  borderAnchor: {
                    relativeFieldRect: { xRatio: 0.5, yRatio: 0.5, wRatio: 0.1, hRatio: 0.1 },
                    distanceToEdge: 0.1
                  }
                },
                objectAnchorGraph: [],
                containedBy: 'obj_tray',
                nearestObjects: [],
                relativePositionWithinParent: null,
                distanceToBorder: 0.1,
                distanceToRefinedBorder: 0.1
              }
            ]
          }
        ],
        createdAtIso: '2026-04-27T00:00:00Z'
      };
    };

    // Config layout: counter at (0.20,0.20)+0.60×0.50, drawer (0.30,0.40)+0.20×0.15,
    // tray (0.31,0.41)+0.08×0.03.
    const configModel = buildModel(
      'config_chain',
      { xNorm: 0.20, yNorm: 0.20, wNorm: 0.60, hNorm: 0.50 },
      { xNorm: 0.30, yNorm: 0.40, wNorm: 0.20, hNorm: 0.15 },
      { xNorm: 0.31, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 }
    );

    // Runtime layout shifted right + slightly larger.
    const runtimeTray = { xNorm: 0.55, yNorm: 0.43, wNorm: 0.10, hNorm: 0.04 };
    const runtimeModel = buildModel(
      'runtime_chain',
      { xNorm: 0.40, yNorm: 0.20, wNorm: 0.55, hNorm: 0.55 },
      { xNorm: 0.50, yNorm: 0.40, wNorm: 0.25, hNorm: 0.20 },
      runtimeTray
    );

    const runner = createLocalizationRunner();
    const result = await runner.run({
      wizardId,
      configGeometry: { ...configGeo, wizardId },
      configStructuralModel: configModel,
      runtimeStructuralModel: runtimeModel,
      runtimePages: [runtimePage],
      predictedId: 'pred_chain',
      nowIso: '2026-04-27T00:00:00Z'
    });

    expect(result.fields).toHaveLength(1);
    const predicted = result.fields[0];

    // Anchor tier must be A (the direct container = tray).
    expect(predicted.anchorTierUsed).toBe('field-object-a');
    expect(predicted.transform.configObjectId).toBe('obj_tray');
    expect(predicted.transform.runtimeObjectId).toBe('obj_tray');

    // Predicted box must land INSIDE the runtime tray rect.
    const predictedRight = predicted.bbox.xNorm + predicted.bbox.wNorm;
    const predictedBottom = predicted.bbox.yNorm + predicted.bbox.hNorm;
    const trayRight = runtimeTray.xNorm + runtimeTray.wNorm;
    const trayBottom = runtimeTray.yNorm + runtimeTray.hNorm;
    expect(predicted.bbox.xNorm).toBeGreaterThanOrEqual(runtimeTray.xNorm - 1e-6);
    expect(predicted.bbox.yNorm).toBeGreaterThanOrEqual(runtimeTray.yNorm - 1e-6);
    expect(predictedRight).toBeLessThanOrEqual(trayRight + 1e-6);
    expect(predictedBottom).toBeLessThanOrEqual(trayBottom + 1e-6);
  });

  it('matches runtime objects by ancestor chain when ID matching fails', () => {
    // Two runtime objects share the config object's type, but only one shares
    // the full ancestor chain. Run Mode must pick the one whose ancestors
    // structurally match.
    const fieldRel = configGeometry.fields[0];

    const buildPage = (objects: StructuralObjectNode[]): StructuralPage => ({
      pageIndex: 0,
      pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
      cvExecutionMode: 'heuristic-fallback',
      border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
      refinedBorder: {
        rectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
        cvContentRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
        source: 'cv-content',
        influencedByBBoxCount: 0,
        containsAllSavedBBoxes: true
      },
      objectHierarchy: { objects },
      pageAnchorRelations: {
        objectToObject: [],
        objectToRefinedBorder: [],
        refinedBorderToBorder: {
          relativeRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.8, hRatio: 0.8 }
        }
      },
      fieldRelationships: [
        {
          fieldId: fieldRel.fieldId,
          fieldAnchors: {
            objectAnchors: [
              { rank: 'primary', objectId: 'cfg_tray', relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } }
            ],
            stableObjectAnchors: [
              { label: 'A', objectId: 'cfg_tray', distance: 0, relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 } }
            ],
            refinedBorderAnchor: {
              relativeFieldRect: { xRatio: 0.2, yRatio: 0.2, wRatio: 0.2, hRatio: 0.1 },
              distanceToEdge: 0.1
            },
            borderAnchor: {
              relativeFieldRect: { xRatio: 0.2, yRatio: 0.2, wRatio: 0.2, hRatio: 0.1 },
              distanceToEdge: 0.2
            }
          },
          objectAnchorGraph: [],
          containedBy: 'cfg_tray',
          nearestObjects: [],
          relativePositionWithinParent: null,
          distanceToBorder: 0.2,
          distanceToRefinedBorder: 0.1
        }
      ]
    });

    // Config: tray inside drawer inside counter (container types throughout).
    const configPage = buildPage([
      {
        objectId: 'cfg_counter',
        objectRectNorm: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.6, hNorm: 0.5 },
        bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.6, hNorm: 0.5 },
        parentObjectId: null,
        childObjectIds: ['cfg_drawer'],
        confidence: 0.9,
          depth: 0
      },
      {
        objectId: 'cfg_drawer',
        objectRectNorm: { xNorm: 0.3, yNorm: 0.4, wNorm: 0.2, hNorm: 0.15 },
        bbox: { xNorm: 0.3, yNorm: 0.4, wNorm: 0.2, hNorm: 0.15 },
        parentObjectId: 'cfg_counter',
        childObjectIds: ['cfg_tray'],
        confidence: 0.88,
          depth: 0
      },
      {
        objectId: 'cfg_tray',
        objectRectNorm: { xNorm: 0.31, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 },
        bbox: { xNorm: 0.31, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 },
        parentObjectId: 'cfg_drawer',
        childObjectIds: [],
        confidence: 0.86,
          depth: 0
      }
    ]);

    // Runtime: a "decoy" container with no parent and a real tray nested
    // inside drawer inside counter. Even though the decoy is geometrically
    // closer to the config tray, the ancestor chain match must win.
    const runtimePageStructural = buildPage([
      {
        objectId: 'runtime_decoy_tray',
        objectRectNorm: { xNorm: 0.33, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 },
        bbox: { xNorm: 0.33, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 },
        parentObjectId: null,
        childObjectIds: [],
        confidence: 0.86,
          depth: 0
      },
      {
        objectId: 'runtime_counter',
        objectRectNorm: { xNorm: 0.4, yNorm: 0.2, wNorm: 0.55, hNorm: 0.5 },
        bbox: { xNorm: 0.4, yNorm: 0.2, wNorm: 0.55, hNorm: 0.5 },
        parentObjectId: null,
        childObjectIds: ['runtime_drawer'],
        confidence: 0.9,
          depth: 0
      },
      {
        objectId: 'runtime_drawer',
        objectRectNorm: { xNorm: 0.5, yNorm: 0.4, wNorm: 0.2, hNorm: 0.15 },
        bbox: { xNorm: 0.5, yNorm: 0.4, wNorm: 0.2, hNorm: 0.15 },
        parentObjectId: 'runtime_counter',
        childObjectIds: ['runtime_real_tray'],
        confidence: 0.88,
          depth: 0
      },
      {
        objectId: 'runtime_real_tray',
        objectRectNorm: { xNorm: 0.51, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 },
        bbox: { xNorm: 0.51, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 },
        parentObjectId: 'runtime_drawer',
        childObjectIds: [],
        confidence: 0.86,
          depth: 0
      }
    ]);

    const resolution = __testing.resolveFieldAnchor(fieldRel, configPage, runtimePageStructural);
    expect(resolution.tier).toBe('field-object-a');
    expect(resolution.transform.configObjectId).toBe('cfg_tray');
    expect(resolution.transform.runtimeObjectId).toBe('runtime_real_tray');
    expect(resolution.transform.objectMatchStrategy).toBe('type-hierarchy-geometry');
  });

  describe('TransformationModel-driven localization', () => {
    const baseConfigModel: StructuralModel = {
      schema: 'wrokit/structural-model',
      version: '4.0',
      structureVersion: 'wrokit/structure/v3',
      id: 'config_tm',
      documentFingerprint: 'config_tm-fingerprint',
      cvAdapter: { name: 'mock-cv', version: '1.0' },
      pages: [
        {
          pageIndex: 0,
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
          cvExecutionMode: 'opencv-runtime',
          border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
          refinedBorder: {
            rectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
            cvContentRectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
            source: 'cv-content',
            influencedByBBoxCount: 0,
            containsAllSavedBBoxes: true
          },
          objectHierarchy: {
            objects: [
              {
                objectId: 'cfg_box',
                objectRectNorm: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.4 },
                bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.4 },
                parentObjectId: null,
                childObjectIds: [],
                confidence: 0.9,
          depth: 0
              }
            ]
          },
          pageAnchorRelations: {
            objectToObject: [],
            objectToRefinedBorder: [],
            refinedBorderToBorder: {
              relativeRect: { xRatio: 0.05, yRatio: 0.05, wRatio: 0.9, hRatio: 0.9 }
            }
          },
          fieldRelationships: []
        }
      ],
      createdAtIso: '2026-04-27T00:00:00Z'
    };

    const baseRuntimeModel: StructuralModel = {
      ...baseConfigModel,
      id: 'runtime_tm',
      documentFingerprint: 'runtime_tm-fingerprint',
      pages: [
        {
          ...baseConfigModel.pages[0],
          objectHierarchy: {
            objects: [
              {
                objectId: 'rt_box',
                objectRectNorm: { xNorm: 0.4, yNorm: 0.5, wNorm: 0.4, hNorm: 0.4 },
                bbox: { xNorm: 0.4, yNorm: 0.5, wNorm: 0.4, hNorm: 0.4 },
                parentObjectId: null,
                childObjectIds: [],
                confidence: 0.9,
          depth: 0
              }
            ]
          }
        }
      ]
    };

    const buildTransformationModel = (
      candidates: TransformationModel['pages'][number]['fieldAlignments'][number]['candidates']
    ): TransformationModel => ({
      schema: 'wrokit/transformation-model',
      version: '1.0',
      transformVersion: 'wrokit/transformation/v1',
      id: 'xform_tm',
      config: { id: baseConfigModel.id, documentFingerprint: baseConfigModel.documentFingerprint },
      runtime: { id: baseRuntimeModel.id, documentFingerprint: baseRuntimeModel.documentFingerprint },
      pages: [
        {
          pageIndex: 0,
          levelSummaries: [],
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
          fieldAlignments: [
            {
              fieldId: 'invoice_number',
              candidates,
              warnings: []
            }
          ],
          notes: [],
          warnings: []
        }
      ],
      overallConfidence: 0,
      notes: [],
      warnings: [],
      createdAtIso: '2026-04-27T00:00:00Z'
    });

    it('uses the strongest TransformationModel field candidate to project the predicted bbox', async () => {
      const runner = createLocalizationRunner();
      // Affine maps cfg_box (0.2,0.2,0.4,0.4) -> rt_box (0.4,0.5,0.4,0.4):
      // scaleX=1, scaleY=1, translateX=0.2, translateY=0.3.
      const transformationModel = buildTransformationModel([
        {
          source: 'matched-object',
          fallbackOrder: 0,
          configObjectId: 'cfg_box',
          runtimeObjectId: 'rt_box',
          transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
          relativeFieldRect: { xRatio: 0.125, yRatio: 0, wRatio: 0.5, hRatio: 0.25 },
          confidence: 0.95,
          notes: []
        }
      ]);

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: baseRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm',
        nowIso: '2026-04-27T00:00:00Z'
      });

      expect(result.fields).toHaveLength(1);
      const predicted = result.fields[0];
      // Field bbox (0.25,0.20,0.20,0.10) under affine (1,1,0.2,0.3) ->
      // (0.45,0.50,0.20,0.10).
      expect(predicted.bbox.xNorm).toBeCloseTo(0.45, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.5, 6);
      expect(predicted.bbox.wNorm).toBeCloseTo(0.2, 6);
      expect(predicted.bbox.hNorm).toBeCloseTo(0.1, 6);
      expect(predicted.anchorTierUsed).toBe('field-object-a');
      expect(predicted.transform.configObjectId).toBe('cfg_box');
      expect(predicted.transform.runtimeObjectId).toBe('rt_box');
      expect(predicted.transform.scaleX).toBe(1);
      expect(predicted.transform.translateX).toBeCloseTo(0.2, 6);
      expect(predicted.transform.translateY).toBeCloseTo(0.3, 6);
      expect(predicted.transform.sourceConfigRectNorm).toEqual(
        baseConfigModel.pages[0].objectHierarchy.objects[0].objectRectNorm
      );
      expect(predicted.transform.sourceRuntimeRectNorm).toEqual(
        baseRuntimeModel.pages[0].objectHierarchy.objects[0].objectRectNorm
      );
    });

    it('orders TransformationModel candidates by fallbackOrder (lower wins)', async () => {
      const runner = createLocalizationRunner();
      // Provide a refined-border candidate with fallbackOrder=2 first in the
      // array, then a matched-object with fallbackOrder=0. The matched-object
      // candidate must win because of fallbackOrder, regardless of array order.
      const transformationModel = buildTransformationModel([
        {
          source: 'refined-border',
          fallbackOrder: 2,
          configObjectId: null,
          runtimeObjectId: null,
          transform: { scaleX: 1, scaleY: 1, translateX: 0.9, translateY: 0.9 },
          relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 0.1, hRatio: 0.1 },
          confidence: 0.5,
          notes: []
        },
        {
          source: 'matched-object',
          fallbackOrder: 0,
          configObjectId: 'cfg_box',
          runtimeObjectId: 'rt_box',
          transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
          relativeFieldRect: { xRatio: 0.125, yRatio: 0, wRatio: 0.5, hRatio: 0.25 },
          confidence: 0.95,
          notes: []
        }
      ]);

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: baseRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_order',
        nowIso: '2026-04-27T00:00:00Z'
      });

      expect(result.fields[0].anchorTierUsed).toBe('field-object-a');
      expect(result.fields[0].bbox.xNorm).toBeCloseTo(0.45, 6);
    });

    it('skips candidates whose object ids no longer exist and tries the next one', async () => {
      const runner = createLocalizationRunner();
      const transformationModel = buildTransformationModel([
        {
          source: 'matched-object',
          fallbackOrder: 0,
          configObjectId: 'cfg_box',
          runtimeObjectId: 'rt_missing', // no such runtime object
          transform: { scaleX: 1, scaleY: 1, translateX: 9, translateY: 9 },
          relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 0.1, hRatio: 0.1 },
          confidence: 0.95,
          notes: []
        },
        {
          source: 'refined-border',
          fallbackOrder: 1,
          configObjectId: null,
          runtimeObjectId: null,
          transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 },
          relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 0.1, hRatio: 0.1 },
          confidence: 0.6,
          notes: []
        }
      ]);

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: baseRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_skip',
        nowIso: '2026-04-27T00:00:00Z'
      });

      expect(result.fields[0].anchorTierUsed).toBe('refined-border');
      // Identity transform applied to (0.25,0.2,0.2,0.1) -> same rect.
      expect(result.fields[0].bbox.xNorm).toBeCloseTo(0.25, 6);
      expect(result.fields[0].bbox.yNorm).toBeCloseTo(0.2, 6);
    });

    it('uses a parent-object candidate when matched-object is unavailable, sourcing the parent rects', async () => {
      const runner = createLocalizationRunner();

      // Config model has a parent container and a (notional) primary anchor
      // child. Only the parent gets a runtime match; the parent-object
      // candidate carries the parent's affine.
      const parentConfigModel: StructuralModel = {
        ...baseConfigModel,
        id: 'config_parent',
        documentFingerprint: 'config_parent-fingerprint',
        pages: [
          {
            ...baseConfigModel.pages[0],
            objectHierarchy: {
              objects: [
                {
                  objectId: 'cfg_parent',
                  objectRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.5, hNorm: 0.5 },
                  bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.5, hNorm: 0.5 },
                  parentObjectId: null,
                  childObjectIds: ['cfg_child'],
                  confidence: 0.9,
          depth: 0
                },
                {
                  objectId: 'cfg_child',
                  objectRectNorm: { xNorm: 0.25, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
                  bbox: { xNorm: 0.25, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
                  parentObjectId: 'cfg_parent',
                  childObjectIds: [],
                  confidence: 0.85,
          depth: 0
                }
              ]
            }
          }
        ]
      };

      const parentRuntimeModel: StructuralModel = {
        ...baseRuntimeModel,
        id: 'runtime_parent',
        documentFingerprint: 'runtime_parent-fingerprint',
        pages: [
          {
            ...baseRuntimeModel.pages[0],
            objectHierarchy: {
              objects: [
                {
                  objectId: 'rt_parent',
                  objectRectNorm: { xNorm: 0.3, yNorm: 0.2, wNorm: 0.5, hNorm: 0.5 },
                  bbox: { xNorm: 0.3, yNorm: 0.2, wNorm: 0.5, hNorm: 0.5 },
                  parentObjectId: null,
                  childObjectIds: [],
                  confidence: 0.9,
          depth: 0
                }
              ]
            }
          }
        ]
      };

      // Affine maps cfg_parent (0.1,0.1,0.5,0.5) -> rt_parent (0.3,0.2,0.5,0.5):
      // scaleX=1, scaleY=1, translateX=0.2, translateY=0.1.
      const transformationModel: TransformationModel = {
        schema: 'wrokit/transformation-model',
        version: '1.0',
        transformVersion: 'wrokit/transformation/v1',
        id: 'xform_parent',
        config: {
          id: parentConfigModel.id,
          documentFingerprint: parentConfigModel.documentFingerprint
        },
        runtime: {
          id: parentRuntimeModel.id,
          documentFingerprint: parentRuntimeModel.documentFingerprint
        },
        pages: [
          {
            pageIndex: 0,
            levelSummaries: [],
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
            fieldAlignments: [
              {
                fieldId: 'invoice_number',
                candidates: [
                  {
                    source: 'parent-object',
                    fallbackOrder: 0,
                    configObjectId: 'cfg_parent',
                    runtimeObjectId: 'rt_parent',
                    transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.1 },
                    relativeFieldRect: { xRatio: 0.3, yRatio: 0.2, wRatio: 0.4, hRatio: 0.2 },
                    confidence: 0.78,
                    notes: []
                  }
                ],
                warnings: []
              }
            ],
            notes: [],
            warnings: []
          }
        ],
        overallConfidence: 0,
        notes: [],
        warnings: [],
        createdAtIso: '2026-04-27T00:00:00Z'
      };

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: parentConfigModel,
        runtimeStructuralModel: parentRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_parent',
        nowIso: '2026-04-27T00:00:00Z'
      });

      expect(result.fields).toHaveLength(1);
      const predicted = result.fields[0];
      expect(predicted.anchorTierUsed).toBe('field-object-b');
      // sourceConfigRectNorm must be the *parent* config rect, not the child's
      // primary-anchor rect.
      expect(predicted.transform.sourceConfigRectNorm).toEqual(
        parentConfigModel.pages[0].objectHierarchy.objects[0].objectRectNorm
      );
      expect(predicted.transform.sourceRuntimeRectNorm).toEqual(
        parentRuntimeModel.pages[0].objectHierarchy.objects[0].objectRectNorm
      );
      expect(predicted.transform.configObjectId).toBe('cfg_parent');
      expect(predicted.transform.runtimeObjectId).toBe('rt_parent');
      expect(predicted.transform.objectMatchStrategy).toBe('type-hierarchy-geometry');
      // Field bbox (0.25,0.20,0.20,0.10) under affine (1,1,0.2,0.1) ->
      // (0.45,0.30,0.20,0.10).
      expect(predicted.bbox.xNorm).toBeCloseTo(0.45, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.3, 6);
      expect(predicted.bbox.wNorm).toBeCloseTo(0.2, 6);
      expect(predicted.bbox.hNorm).toBeCloseTo(0.1, 6);
    });

    it('prefers the highest-confidence object-anchor candidate, not the first by fallbackOrder (cross-document)', async () => {
      // Cross-document scenario: Field 2 on a Reddit profile lives inside a
      // small "stat tile" cell (matched-object) AND inside the larger right-
      // sidebar card (parent-object). Across two profiles with different
      // content widths, the small cell is reshaped (4-digit vs 5-digit
      // karma) and the matcher pairs it weakly with a structurally adjacent
      // wrong cell — confidence 0.30 — while the larger card pairs robustly
      // — confidence 0.78. Picking the first to resolve (matched-object,
      // fallbackOrder 0) lands the field on the wrong cell. Picking by
      // confidence anchors it to the stable parent.
      const runner = createLocalizationRunner();
      const configWithChild: StructuralModel = {
        ...baseConfigModel,
        id: 'config_xd',
        documentFingerprint: 'config_xd-fp',
        pages: [
          {
            ...baseConfigModel.pages[0],
            objectHierarchy: {
              objects: [
                {
                  objectId: 'cfg_parent',
                  objectRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.5, hNorm: 0.5 },
                  bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.5, hNorm: 0.5 },
                  parentObjectId: null,
                  childObjectIds: ['cfg_child'],
                  confidence: 0.9,
                  depth: 0
                },
                {
                  objectId: 'cfg_child',
                  objectRectNorm: { xNorm: 0.25, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
                  bbox: { xNorm: 0.25, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
                  parentObjectId: 'cfg_parent',
                  childObjectIds: [],
                  confidence: 0.85,
                  depth: 1
                }
              ]
            }
          }
        ]
      };
      const runtimeWithBoth: StructuralModel = {
        ...baseRuntimeModel,
        id: 'runtime_xd',
        documentFingerprint: 'runtime_xd-fp',
        pages: [
          {
            ...baseRuntimeModel.pages[0],
            objectHierarchy: {
              objects: [
                {
                  objectId: 'rt_parent',
                  objectRectNorm: { xNorm: 0.3, yNorm: 0.2, wNorm: 0.5, hNorm: 0.5 },
                  bbox: { xNorm: 0.3, yNorm: 0.2, wNorm: 0.5, hNorm: 0.5 },
                  parentObjectId: null,
                  childObjectIds: ['rt_wrong_cell'],
                  confidence: 0.9,
                  depth: 0
                },
                {
                  // Wrong runtime cell: similar size and shape as cfg_child,
                  // but at a different relative location inside the parent
                  // (a content-width shift moved it by 0.10 in y).
                  objectId: 'rt_wrong_cell',
                  objectRectNorm: { xNorm: 0.45, yNorm: 0.4, wNorm: 0.2, hNorm: 0.1 },
                  bbox: { xNorm: 0.45, yNorm: 0.4, wNorm: 0.2, hNorm: 0.1 },
                  parentObjectId: 'rt_parent',
                  childObjectIds: [],
                  confidence: 0.85,
                  depth: 1
                }
              ]
            }
          }
        ]
      };

      const transformationModel: TransformationModel = {
        schema: 'wrokit/transformation-model',
        version: '1.0',
        transformVersion: 'wrokit/transformation/v1',
        id: 'xform_xd',
        config: {
          id: configWithChild.id,
          documentFingerprint: configWithChild.documentFingerprint
        },
        runtime: {
          id: runtimeWithBoth.id,
          documentFingerprint: runtimeWithBoth.documentFingerprint
        },
        pages: [
          {
            pageIndex: 0,
            levelSummaries: [],
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
            fieldAlignments: [
              {
                fieldId: 'invoice_number',
                candidates: [
                  {
                    // Low-confidence matched-object (the unstable small cell).
                    // Used to win unconditionally because it had fallbackOrder
                    // 0; now the higher-confidence parent-object beats it.
                    source: 'matched-object',
                    fallbackOrder: 0,
                    configObjectId: 'cfg_child',
                    runtimeObjectId: 'rt_wrong_cell',
                    transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.2 },
                    relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 },
                    confidence: 0.3,
                    notes: []
                  },
                  {
                    // High-confidence parent-object (the stable card).
                    source: 'parent-object',
                    fallbackOrder: 1,
                    configObjectId: 'cfg_parent',
                    runtimeObjectId: 'rt_parent',
                    transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.1 },
                    relativeFieldRect: { xRatio: 0.3, yRatio: 0.2, wRatio: 0.4, hRatio: 0.2 },
                    confidence: 0.78,
                    notes: []
                  }
                ],
                warnings: []
              }
            ],
            notes: [],
            warnings: []
          }
        ],
        overallConfidence: 0,
        notes: [],
        warnings: [],
        createdAtIso: '2026-04-27T00:00:00Z'
      };

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: configWithChild,
        runtimeStructuralModel: runtimeWithBoth,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_confidence_pick',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      // Parent-object wins because its confidence (0.78) beats the
      // matched-object's (0.30), even though matched-object has lower
      // fallbackOrder.
      expect(predicted.anchorTierUsed).toBe('field-object-b');
      expect(predicted.transform.configObjectId).toBe('cfg_parent');
      expect(predicted.transform.runtimeObjectId).toBe('rt_parent');
      // Field (0.25, 0.20, 0.20, 0.10) under parent affine (1,1,0.2,0.1) ->
      // (0.45, 0.30, 0.20, 0.10), NOT (0.45, 0.40, ...) which the
      // wrong-cell match would have produced.
      expect(predicted.bbox.xNorm).toBeCloseTo(0.45, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.3, 6);
    });

    it('still picks matched-object over parent-object when matched-object confidence is higher (within-document)', async () => {
      // Within-document, matched-object's primary rank factor (1.0) is
      // higher than parent-object's parent-indirection penalty (0.85), so
      // matched-object naturally has higher candidate confidence at equal
      // underlying match strength. The new "highest-confidence wins" rule
      // must preserve that — specificity still beats indirection when
      // both anchors match strongly.
      const runner = createLocalizationRunner();
      const configWithChild: StructuralModel = {
        ...baseConfigModel,
        id: 'config_within',
        documentFingerprint: 'config_within-fp',
        pages: [
          {
            ...baseConfigModel.pages[0],
            objectHierarchy: {
              objects: [
                {
                  objectId: 'cfg_parent',
                  objectRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.5, hNorm: 0.5 },
                  bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.5, hNorm: 0.5 },
                  parentObjectId: null,
                  childObjectIds: ['cfg_child'],
                  confidence: 0.9,
                  depth: 0
                },
                {
                  objectId: 'cfg_child',
                  objectRectNorm: { xNorm: 0.25, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
                  bbox: { xNorm: 0.25, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
                  parentObjectId: 'cfg_parent',
                  childObjectIds: [],
                  confidence: 0.85,
                  depth: 1
                }
              ]
            }
          }
        ]
      };
      const runtimeWithChild: StructuralModel = {
        ...baseRuntimeModel,
        id: 'runtime_within',
        documentFingerprint: 'runtime_within-fp',
        pages: [
          {
            ...baseRuntimeModel.pages[0],
            objectHierarchy: {
              objects: [
                {
                  objectId: 'rt_parent',
                  objectRectNorm: { xNorm: 0.3, yNorm: 0.2, wNorm: 0.5, hNorm: 0.5 },
                  bbox: { xNorm: 0.3, yNorm: 0.2, wNorm: 0.5, hNorm: 0.5 },
                  parentObjectId: null,
                  childObjectIds: ['rt_child'],
                  confidence: 0.9,
                  depth: 0
                },
                {
                  objectId: 'rt_child',
                  objectRectNorm: { xNorm: 0.45, yNorm: 0.3, wNorm: 0.2, hNorm: 0.1 },
                  bbox: { xNorm: 0.45, yNorm: 0.3, wNorm: 0.2, hNorm: 0.1 },
                  parentObjectId: 'rt_parent',
                  childObjectIds: [],
                  confidence: 0.85,
                  depth: 1
                }
              ]
            }
          }
        ]
      };
      const transformationModel: TransformationModel = {
        schema: 'wrokit/transformation-model',
        version: '1.0',
        transformVersion: 'wrokit/transformation/v1',
        id: 'xform_within',
        config: {
          id: configWithChild.id,
          documentFingerprint: configWithChild.documentFingerprint
        },
        runtime: {
          id: runtimeWithChild.id,
          documentFingerprint: runtimeWithChild.documentFingerprint
        },
        pages: [
          {
            pageIndex: 0,
            levelSummaries: [],
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
            fieldAlignments: [
              {
                fieldId: 'invoice_number',
                candidates: [
                  {
                    source: 'matched-object',
                    fallbackOrder: 0,
                    configObjectId: 'cfg_child',
                    runtimeObjectId: 'rt_child',
                    transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.1 },
                    relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 },
                    confidence: 0.9,
                    notes: []
                  },
                  {
                    source: 'parent-object',
                    fallbackOrder: 1,
                    configObjectId: 'cfg_parent',
                    runtimeObjectId: 'rt_parent',
                    transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.1 },
                    relativeFieldRect: { xRatio: 0.3, yRatio: 0.2, wRatio: 0.4, hRatio: 0.2 },
                    confidence: 0.765,
                    notes: []
                  }
                ],
                warnings: []
              }
            ],
            notes: [],
            warnings: []
          }
        ],
        overallConfidence: 0,
        notes: [],
        warnings: [],
        createdAtIso: '2026-04-27T00:00:00Z'
      };

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: configWithChild,
        runtimeStructuralModel: runtimeWithChild,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_specificity_wins',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      expect(predicted.anchorTierUsed).toBe('field-object-a');
      expect(predicted.transform.configObjectId).toBe('cfg_child');
      expect(predicted.transform.runtimeObjectId).toBe('rt_child');
    });

    it('uses a TransformationModel refined-border candidate sourced from the page refined-border rects', async () => {
      const runner = createLocalizationRunner();
      const transformationModel = buildTransformationModel([
        {
          source: 'refined-border',
          fallbackOrder: 0,
          configObjectId: null,
          runtimeObjectId: null,
          transform: { scaleX: 1, scaleY: 1, translateX: 0.1, translateY: 0.1 },
          relativeFieldRect: { xRatio: 0.2, yRatio: 0.2, wRatio: 0.2, hRatio: 0.1 },
          confidence: 0.7,
          notes: []
        }
      ]);

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: baseRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_refined',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      expect(predicted.anchorTierUsed).toBe('refined-border');
      expect(predicted.transform.basis).toBe('refined-border');
      expect(predicted.transform.sourceConfigRectNorm).toEqual(
        baseConfigModel.pages[0].refinedBorder.rectNorm
      );
      expect(predicted.transform.sourceRuntimeRectNorm).toEqual(
        baseRuntimeModel.pages[0].refinedBorder.rectNorm
      );
      // refined-border candidates carry no object ids.
      expect(predicted.transform.configObjectId).toBeUndefined();
      expect(predicted.transform.runtimeObjectId).toBeUndefined();
      expect(predicted.transform.objectMatchStrategy).toBeUndefined();
      // Field bbox (0.25,0.20,0.20,0.10) under affine (1,1,0.1,0.1) ->
      // (0.35,0.30,0.20,0.10).
      expect(predicted.bbox.xNorm).toBeCloseTo(0.35, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.3, 6);
      expect(predicted.bbox.wNorm).toBeCloseTo(0.2, 6);
      expect(predicted.bbox.hNorm).toBeCloseTo(0.1, 6);
    });

    it('uses a TransformationModel border candidate sourced from the page border rects', async () => {
      const runner = createLocalizationRunner();
      const transformationModel = buildTransformationModel([
        {
          source: 'border',
          fallbackOrder: 0,
          configObjectId: null,
          runtimeObjectId: null,
          transform: { scaleX: 1, scaleY: 1, translateX: 0.05, translateY: 0.05 },
          relativeFieldRect: { xRatio: 0.25, yRatio: 0.2, wRatio: 0.2, hRatio: 0.1 },
          confidence: 0.4,
          notes: []
        }
      ]);

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: baseRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_border',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      expect(predicted.anchorTierUsed).toBe('border');
      expect(predicted.transform.basis).toBe('border');
      expect(predicted.transform.sourceConfigRectNorm).toEqual(
        baseConfigModel.pages[0].border.rectNorm
      );
      expect(predicted.transform.sourceRuntimeRectNorm).toEqual(
        baseRuntimeModel.pages[0].border.rectNorm
      );
      expect(predicted.transform.configObjectId).toBeUndefined();
      expect(predicted.transform.runtimeObjectId).toBeUndefined();
      expect(predicted.transform.objectMatchStrategy).toBeUndefined();
      // Field bbox (0.25,0.20,0.20,0.10) under affine (1,1,0.05,0.05) ->
      // (0.30,0.25,0.20,0.10).
      expect(predicted.bbox.xNorm).toBeCloseTo(0.3, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.25, 6);
      expect(predicted.bbox.wNorm).toBeCloseTo(0.2, 6);
      expect(predicted.bbox.hNorm).toBeCloseTo(0.1, 6);
    });

    const buildTransformationModelWithConsensus = (
      candidates: TransformationModel['pages'][number]['fieldAlignments'][number]['candidates'],
      consensus: TransformationModel['pages'][number]['consensus']
    ): TransformationModel => ({
      schema: 'wrokit/transformation-model',
      version: '1.0',
      transformVersion: 'wrokit/transformation/v1',
      id: 'xform_consensus',
      config: { id: baseConfigModel.id, documentFingerprint: baseConfigModel.documentFingerprint },
      runtime: { id: baseRuntimeModel.id, documentFingerprint: baseRuntimeModel.documentFingerprint },
      pages: [
        {
          pageIndex: 0,
          levelSummaries: [],
          objectMatches: [],
          unmatchedConfigObjectIds: [],
          unmatchedRuntimeObjectIds: [],
          consensus,
          fieldAlignments: [
            {
              fieldId: 'invoice_number',
              candidates,
              warnings: []
            }
          ],
          notes: [],
          warnings: []
        }
      ],
      overallConfidence: consensus.confidence,
      notes: [],
      warnings: [],
      createdAtIso: '2026-04-27T00:00:00Z'
    });

    it('rescues localization with the page consensus transform when object anchors fail', async () => {
      const runner = createLocalizationRunner();
      // Page-level consistent global shift: scaleX=scaleY=1, translate=(0.1, 0.05).
      // The object-anchor candidate points at a runtime object that no longer
      // exists, so it must fail. Refined-border candidate is also offered as a
      // weaker fallback; the consensus rescue must be chosen instead because
      // its confidence is high.
      const transformationModel = buildTransformationModelWithConsensus(
        [
          {
            source: 'matched-object',
            fallbackOrder: 0,
            configObjectId: 'cfg_box',
            runtimeObjectId: 'rt_missing', // forces object anchor failure
            transform: { scaleX: 1, scaleY: 1, translateX: 9, translateY: 9 },
            relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 0.1, hRatio: 0.1 },
            confidence: 0.9,
            notes: []
          },
          {
            source: 'refined-border',
            fallbackOrder: 1,
            configObjectId: null,
            runtimeObjectId: null,
            transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 },
            relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 0.1, hRatio: 0.1 },
            confidence: 0.5,
            notes: []
          }
        ],
        {
          transform: { scaleX: 1, scaleY: 1, translateX: 0.1, translateY: 0.05 },
          confidence: 0.85,
          contributingMatchCount: 3,
          outliers: [],
          notes: ['3 of 3 match(es) contributed to consensus'],
          warnings: []
        }
      );

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: baseRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_consensus',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      expect(predicted.anchorTierUsed).toBe('page-consensus');
      expect(predicted.transform.basis).toBe('page-consensus');
      // Field bbox (0.25,0.20,0.20,0.10) under affine (1,1,0.1,0.05) ->
      // (0.35,0.25,0.20,0.10).
      expect(predicted.bbox.xNorm).toBeCloseTo(0.35, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.25, 6);
      expect(predicted.bbox.wNorm).toBeCloseTo(0.2, 6);
      expect(predicted.bbox.hNorm).toBeCloseTo(0.1, 6);
      // Page-level consensus is not bound to any single object.
      expect(predicted.transform.configObjectId).toBeUndefined();
      expect(predicted.transform.runtimeObjectId).toBeUndefined();
      expect(predicted.transform.objectMatchStrategy).toBeUndefined();
      // The contract requires source rects to be omitted for page-consensus —
      // the affine is the consensus, not derived from any source rect pair.
      expect(predicted.transform.sourceConfigRectNorm).toBeUndefined();
      expect(predicted.transform.sourceRuntimeRectNorm).toBeUndefined();
    });

    it('skips consensus rescue when its confidence is below the threshold', async () => {
      const runner = createLocalizationRunner();
      const transformationModel = buildTransformationModelWithConsensus(
        [
          {
            source: 'matched-object',
            fallbackOrder: 0,
            configObjectId: 'cfg_box',
            runtimeObjectId: 'rt_missing',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.4, translateY: 0.4 },
            relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 0.1, hRatio: 0.1 },
            confidence: 0.9,
            notes: []
          },
          {
            source: 'refined-border',
            fallbackOrder: 1,
            configObjectId: null,
            runtimeObjectId: null,
            transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 },
            relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 0.1, hRatio: 0.1 },
            confidence: 0.5,
            notes: []
          }
        ],
        {
          // Consensus exists but its confidence is too low to rescue.
          transform: { scaleX: 1, scaleY: 1, translateX: 0.1, translateY: 0.05 },
          confidence: 0.3,
          contributingMatchCount: 1,
          outliers: [],
          notes: [],
          warnings: ['consensus formed from a single match — no cross-validation possible']
        }
      );

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: baseRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_consensus_weak',
        nowIso: '2026-04-27T00:00:00Z'
      });

      expect(result.fields[0].anchorTierUsed).toBe('refined-border');
    });

    it('keeps the resolved object anchor when the page consensus agrees with it', async () => {
      const runner = createLocalizationRunner();
      // Consensus AGREES with the primary anchor (same affine), so the
      // single-anchor pick should be preserved. The override only fires when
      // primary and consensus disagree about where the field lives.
      const transformationModel = buildTransformationModelWithConsensus(
        [
          {
            source: 'matched-object',
            fallbackOrder: 0,
            configObjectId: 'cfg_box',
            runtimeObjectId: 'rt_box',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
            relativeFieldRect: { xRatio: 0.125, yRatio: 0, wRatio: 0.5, hRatio: 0.25 },
            confidence: 0.95,
            notes: []
          }
        ],
        {
          transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
          confidence: 0.95,
          contributingMatchCount: 5,
          outliers: [],
          notes: [],
          warnings: []
        }
      );

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: baseRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_consensus_agrees',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      expect(predicted.anchorTierUsed).toBe('field-object-a');
      // Used the matched-object affine, not the consensus affine.
      expect(predicted.bbox.xNorm).toBeCloseTo(0.45, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.5, 6);
    });

    it('overrides a resolved object anchor with the page consensus when they disagree', async () => {
      const runner = createLocalizationRunner();
      // Primary projects field to (0.45, 0.50). Consensus projects it to
      // (0.75, 0.70). A field of size (0.20, 0.10) at those two positions has
      // zero IoU, well below CONSENSUS_OVERRIDE_MAX_IOU. With the consensus
      // backed by 5 matches at 0.95 confidence, the override fires and
      // consensus wins — exactly the cross-document case where a single
      // primary anchor disagrees with the page-level movement trend.
      // Primary confidence is held just below
      // CONSENSUS_OVERRIDE_LOCAL_EVIDENCE_MIN_CONFIDENCE so the strong-local-
      // evidence guard does not suppress the override.
      const transformationModel = buildTransformationModelWithConsensus(
        [
          {
            source: 'matched-object',
            fallbackOrder: 0,
            configObjectId: 'cfg_box',
            runtimeObjectId: 'rt_box',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
            relativeFieldRect: { xRatio: 0.125, yRatio: 0, wRatio: 0.5, hRatio: 0.25 },
            confidence: 0.7,
            notes: []
          }
        ],
        {
          transform: { scaleX: 1, scaleY: 1, translateX: 0.5, translateY: 0.5 },
          confidence: 0.95,
          contributingMatchCount: 5,
          outliers: [],
          notes: [],
          warnings: []
        }
      );

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: baseRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_consensus_override',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      expect(predicted.anchorTierUsed).toBe('page-consensus');
      expect(predicted.transform.basis).toBe('page-consensus');
      // Field (0.25, 0.20, 0.20, 0.10) under consensus (1, 1, 0.5, 0.5) ->
      // (0.75, 0.70, 0.20, 0.10).
      expect(predicted.bbox.xNorm).toBeCloseTo(0.75, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.7, 6);
      expect(predicted.warnings ?? []).toEqual(
        expect.arrayContaining([expect.stringContaining('consensus override')])
      );
    });

    it('retains the primary anchor projection when the config object contains the field and confidence is near-perfect', async () => {
      const runner = createLocalizationRunner();
      // cfg_box at (0.2, 0.2, 0.4, 0.4) contains the field bbox
      // (0.25, 0.20, 0.20, 0.10). Primary projects to (0.45, 0.50);
      // consensus projects to (0.75, 0.70) — IoU ≈ 0, below
      // CONSENSUS_OVERRIDE_MAX_IOU. With primary confidence 0.9 (≥
      // CONSENSUS_OVERRIDE_LOCAL_EVIDENCE_MIN_CONFIDENCE) and the source
      // config object actually containing the field, the strong-local-
      // evidence guard fires and the override is suppressed.
      const transformationModel = buildTransformationModelWithConsensus(
        [
          {
            source: 'matched-object',
            fallbackOrder: 0,
            configObjectId: 'cfg_box',
            runtimeObjectId: 'rt_box',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
            relativeFieldRect: { xRatio: 0.125, yRatio: 0, wRatio: 0.5, hRatio: 0.25 },
            confidence: 0.9,
            notes: []
          }
        ],
        {
          transform: { scaleX: 1, scaleY: 1, translateX: 0.5, translateY: 0.5 },
          confidence: 0.95,
          contributingMatchCount: 5,
          outliers: [],
          notes: [],
          warnings: []
        }
      );

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: baseRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_strong_local',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      expect(predicted.anchorTierUsed).not.toBe('page-consensus');
      expect(predicted.transform.basis).not.toBe('page-consensus');
      // Field projected by primary affine (1, 1, 0.2, 0.3): (0.45, 0.50).
      expect(predicted.bbox.xNorm).toBeCloseTo(0.45, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.5, 6);
      expect(predicted.warnings ?? []).toEqual(
        expect.arrayContaining([
          expect.stringContaining('local anchor projection retained over consensus')
        ])
      );
    });

    it('still overrides when the config object does NOT contain the field, even at near-perfect confidence', async () => {
      const runner = createLocalizationRunner();
      // Same disagreement setup as the override-fires test, but here the
      // config object's rect is constructed so it does NOT contain the
      // field bbox. The strong-local-evidence guard should be skipped (one
      // of its two conditions fails) and the existing override behavior is
      // preserved.
      const noContainConfig: StructuralModel = {
        ...baseConfigModel,
        pages: [
          {
            ...baseConfigModel.pages[0],
            objectHierarchy: {
              objects: [
                {
                  // Sits well outside the field bbox at (0.25, 0.2, 0.2, 0.1).
                  objectId: 'cfg_box',
                  objectRectNorm: { xNorm: 0.7, yNorm: 0.7, wNorm: 0.2, hNorm: 0.2 },
                  bbox: { xNorm: 0.7, yNorm: 0.7, wNorm: 0.2, hNorm: 0.2 },
                  parentObjectId: null,
                  childObjectIds: [],
                  confidence: 0.9,
                  depth: 0
                }
              ]
            }
          }
        ]
      };
      const transformationModel = buildTransformationModelWithConsensus(
        [
          {
            source: 'matched-object',
            fallbackOrder: 0,
            configObjectId: 'cfg_box',
            runtimeObjectId: 'rt_box',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
            relativeFieldRect: { xRatio: 0.125, yRatio: 0, wRatio: 0.5, hRatio: 0.25 },
            confidence: 0.95,
            notes: []
          }
        ],
        {
          transform: { scaleX: 1, scaleY: 1, translateX: 0.5, translateY: 0.5 },
          confidence: 0.95,
          contributingMatchCount: 5,
          outliers: [],
          notes: [],
          warnings: []
        }
      );

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: noContainConfig,
        runtimeStructuralModel: baseRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_no_contain',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      expect(predicted.anchorTierUsed).toBe('page-consensus');
      expect(predicted.transform.basis).toBe('page-consensus');
      expect(predicted.warnings ?? []).toEqual(
        expect.arrayContaining([expect.stringContaining('consensus override')])
      );
    });

    it('exposes a unit-level consensus-rescue helper that respects the confidence threshold', () => {
      const sourceField = configGeometry.fields[0];

      const aboveThreshold = __testing.resolveFromConsensusRescue(
        sourceField,
        {
          transform: { scaleX: 1, scaleY: 1, translateX: 0.1, translateY: 0.05 },
          confidence: __testing.CONSENSUS_RESCUE_MIN_CONFIDENCE,
          contributingMatchCount: 2,
          outliers: [],
          notes: [],
          warnings: []
        },
        __testing.CONSENSUS_RESCUE_MIN_CONFIDENCE
      );
      expect(aboveThreshold).not.toBeNull();
      expect(aboveThreshold?.tier).toBe('page-consensus');
      // Honest representation: no source rect pair on page-consensus.
      expect(aboveThreshold?.transform.sourceConfigRectNorm).toBeUndefined();
      expect(aboveThreshold?.transform.sourceRuntimeRectNorm).toBeUndefined();

      const belowThreshold = __testing.resolveFromConsensusRescue(
        sourceField,
        {
          transform: { scaleX: 1, scaleY: 1, translateX: 0.1, translateY: 0.05 },
          confidence: __testing.CONSENSUS_RESCUE_MIN_CONFIDENCE - 0.01,
          contributingMatchCount: 2,
          outliers: [],
          notes: [],
          warnings: []
        },
        __testing.CONSENSUS_RESCUE_MIN_CONFIDENCE
      );
      expect(belowThreshold).toBeNull();

      const nullTransform = __testing.resolveFromConsensusRescue(
        sourceField,
        {
          transform: null,
          confidence: 1,
          contributingMatchCount: 0,
          outliers: [],
          notes: [],
          warnings: []
        },
        __testing.CONSENSUS_RESCUE_MIN_CONFIDENCE
      );
      expect(nullTransform).toBeNull();
    });

    it('falls back to the legacy stable-anchor path when no field candidates are emitted', async () => {
      const runner = createLocalizationRunner();
      // Empty candidate list for this field — runner must use legacy resolution.
      const transformationModel = buildTransformationModel([]);

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: baseRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_fallback',
        nowIso: '2026-04-27T00:00:00Z'
      });

      // No fieldRelationship was emitted and no candidates exist, so the
      // legacy path falls all the way to the refined-border tier.
      expect(result.fields[0].anchorTierUsed).toBe('refined-border');
    });

    // The field rect from configGeometry is (0.25, 0.20, 0.20, 0.10).
    // We construct a chain config model where:
    //   cfg_child (A): (0.25, 0.20, 0.20, 0.10) — field-rel-A = (0,0,1,1)
    //   cfg_parent (B): (0.10, 0.10, 0.50, 0.50)
    //   A-rel-B (container): (0.3, 0.2, 0.4, 0.2)
    //   field-rel-B: (0.3, 0.2, 0.4, 0.2)
    const buildChainConfigModel = (): StructuralModel => ({
      ...baseConfigModel,
      id: 'config_chain_tm',
      documentFingerprint: 'config_chain_tm-fingerprint',
      pages: [
        {
          ...baseConfigModel.pages[0],
          objectHierarchy: {
            objects: [
              {
                objectId: 'cfg_parent',
                objectRectNorm: { xNorm: 0.10, yNorm: 0.10, wNorm: 0.50, hNorm: 0.50 },
                bbox: { xNorm: 0.10, yNorm: 0.10, wNorm: 0.50, hNorm: 0.50 },
                parentObjectId: null,
                childObjectIds: ['cfg_child'],
                confidence: 0.9,
          depth: 0
              },
              {
                objectId: 'cfg_child',
                objectRectNorm: { xNorm: 0.25, yNorm: 0.20, wNorm: 0.20, hNorm: 0.10 },
                bbox: { xNorm: 0.25, yNorm: 0.20, wNorm: 0.20, hNorm: 0.10 },
                parentObjectId: 'cfg_parent',
                childObjectIds: [],
                confidence: 0.85,
          depth: 0
              }
            ]
          },
          pageAnchorRelations: {
            objectToObject: [
              {
                fromObjectId: 'cfg_parent',
                toObjectId: 'cfg_child',
                relationKind: 'container',
                relativeRect: { xRatio: 0.3, yRatio: 0.2, wRatio: 0.4, hRatio: 0.2 },
                fallbackOrder: 0,
                distance: 0
              }
            ],
            objectToRefinedBorder: [],
            refinedBorderToBorder: {
              relativeRect: { xRatio: 0.05, yRatio: 0.05, wRatio: 0.9, hRatio: 0.9 }
            }
          },
          fieldRelationships: [
            {
              fieldId: 'invoice_number',
              fieldAnchors: {
                objectAnchors: [
                  { rank: 'primary', objectId: 'cfg_child', relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 } },
                  { rank: 'secondary', objectId: 'cfg_parent', relativeFieldRect: { xRatio: 0.3, yRatio: 0.2, wRatio: 0.4, hRatio: 0.2 } }
                ],
                stableObjectAnchors: [
                  { label: 'A', objectId: 'cfg_child', distance: 0, relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 } },
                  { label: 'B', objectId: 'cfg_parent', distance: 0, relativeFieldRect: { xRatio: 0.3, yRatio: 0.2, wRatio: 0.4, hRatio: 0.2 } }
                ],
                refinedBorderAnchor: {
                  relativeFieldRect: { xRatio: 0.22222, yRatio: 0.16667, wRatio: 0.22222, hRatio: 0.11111 },
                  distanceToEdge: 0.05
                },
                borderAnchor: {
                  relativeFieldRect: { xRatio: 0.25, yRatio: 0.20, wRatio: 0.20, hRatio: 0.10 },
                  distanceToEdge: 0.20
                }
              },
              objectAnchorGraph: [],
              containedBy: 'cfg_child',
              nearestObjects: [],
              relativePositionWithinParent: null,
              distanceToBorder: 0.20,
              distanceToRefinedBorder: 0.05
            }
          ]
        }
      ]
    });

    it('prefers a direct parent-object candidate over rescuing a missing matched-object (direct B beats rescued A)', async () => {
      const runner = createLocalizationRunner();
      const chainConfigModel = buildChainConfigModel();

      // Runtime: cfg_child is missing entirely (no rectangles), but the
      // parent is present with the same id (id-match → would also be an
      // unambiguous rescuer for the missing child). The point of this test
      // is that the runner must NOT rescue candidate A when candidate B
      // resolves directly: a direct match is stronger than a virtual one
      // reconstructed from the config containment graph.
      const chainRuntimeModel: StructuralModel = {
        ...baseRuntimeModel,
        id: 'runtime_chain_tm',
        documentFingerprint: 'runtime_chain_tm-fingerprint',
        pages: [
          {
            ...baseRuntimeModel.pages[0],
            objectHierarchy: {
              objects: [
                {
                  objectId: 'cfg_parent',
                  objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.50, hNorm: 0.50 },
                  bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.50, hNorm: 0.50 },
                  parentObjectId: null,
                  childObjectIds: [],
                  confidence: 0.9,
          depth: 0
                }
              ]
            }
          }
        ]
      };

      const transformationModel: TransformationModel = {
        schema: 'wrokit/transformation-model',
        version: '1.0',
        transformVersion: 'wrokit/transformation/v1',
        id: 'xform_chain_tm',
        config: { id: chainConfigModel.id, documentFingerprint: chainConfigModel.documentFingerprint },
        runtime: { id: chainRuntimeModel.id, documentFingerprint: chainRuntimeModel.documentFingerprint },
        pages: [
          {
            pageIndex: 0,
            levelSummaries: [],
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
            fieldAlignments: [
              {
                fieldId: 'invoice_number',
                candidates: [
                  {
                    // matched-object pointing at the missing child — fails
                    // direct. Rescue would succeed via cfg_parent (same id
                    // present in runtime), but the runner must defer the
                    // rescue pass until *all* direct candidates have been
                    // tried.
                    source: 'matched-object',
                    fallbackOrder: 0,
                    configObjectId: 'cfg_child',
                    runtimeObjectId: 'rt_missing_child',
                    transform: { scaleX: 1, scaleY: 1, translateX: 9, translateY: 9 },
                    relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 },
                    confidence: 0.9,
                    notes: []
                  },
                  {
                    // parent-object that resolves directly — this is the
                    // "clean direct B" the audit calls out. It must win
                    // over rescuing the missing child.
                    source: 'parent-object',
                    fallbackOrder: 1,
                    configObjectId: 'cfg_parent',
                    runtimeObjectId: 'cfg_parent',
                    transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.1 },
                    relativeFieldRect: { xRatio: 0.3, yRatio: 0.2, wRatio: 0.4, hRatio: 0.2 },
                    confidence: 0.78,
                    notes: []
                  }
                ],
                warnings: []
              }
            ],
            notes: [],
            warnings: []
          }
        ],
        overallConfidence: 0,
        notes: [],
        warnings: [],
        createdAtIso: '2026-04-27T00:00:00Z'
      };

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: chainConfigModel,
        runtimeStructuralModel: chainRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_direct_b_beats_rescued_a',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      // Direct parent-object wins — tier B, real runtime object id, and the
      // resolution comes from the candidate's own affine, not a rescue
      // reconstruction.
      expect(predicted.anchorTierUsed).toBe('field-object-b');
      expect(predicted.transform.basis).toBe('field-object-b');
      expect(predicted.transform.configObjectId).toBe('cfg_parent');
      expect(predicted.transform.runtimeObjectId).toBe('cfg_parent');
      // Field bbox (0.25,0.20,0.20,0.10) under affine (1,1,0.2,0.1) ->
      // (0.45,0.30,0.20,0.10).
      expect(predicted.bbox.xNorm).toBeCloseTo(0.45, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.30, 6);
      expect(predicted.bbox.wNorm).toBeCloseTo(0.20, 6);
      expect(predicted.bbox.hNorm).toBeCloseTo(0.10, 6);
    });

    it('rescues a missing matched-object via the parent when no direct object-anchor candidate is viable', async () => {
      const runner = createLocalizationRunner();
      const chainConfigModel = buildChainConfigModel();

      // Runtime: cfg_child is missing, cfg_parent is present (id-match →
      // unambiguous rescuer). The TransformationModel only carries the
      // matched-object candidate (no parent-object candidate), so rescue is
      // the only object-level path. This guards the rescue rung itself
      // against being reordered or weakened by the audit's first-direct fix.
      const chainRuntimeModel: StructuralModel = {
        ...baseRuntimeModel,
        id: 'runtime_chain_tm_rescue_only',
        documentFingerprint: 'runtime_chain_tm_rescue_only-fingerprint',
        pages: [
          {
            ...baseRuntimeModel.pages[0],
            objectHierarchy: {
              objects: [
                {
                  objectId: 'cfg_parent',
                  objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.50, hNorm: 0.50 },
                  bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.50, hNorm: 0.50 },
                  parentObjectId: null,
                  childObjectIds: [],
                  confidence: 0.9,
          depth: 0
                }
              ]
            }
          }
        ]
      };

      const transformationModel: TransformationModel = {
        schema: 'wrokit/transformation-model',
        version: '1.0',
        transformVersion: 'wrokit/transformation/v1',
        id: 'xform_chain_tm_rescue_only',
        config: { id: chainConfigModel.id, documentFingerprint: chainConfigModel.documentFingerprint },
        runtime: { id: chainRuntimeModel.id, documentFingerprint: chainRuntimeModel.documentFingerprint },
        pages: [
          {
            pageIndex: 0,
            levelSummaries: [],
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
            fieldAlignments: [
              {
                fieldId: 'invoice_number',
                candidates: [
                  {
                    source: 'matched-object',
                    fallbackOrder: 0,
                    configObjectId: 'cfg_child',
                    runtimeObjectId: 'rt_missing_child',
                    transform: { scaleX: 1, scaleY: 1, translateX: 9, translateY: 9 },
                    relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 },
                    confidence: 0.9,
                    notes: []
                  }
                ],
                warnings: []
              }
            ],
            notes: [],
            warnings: []
          }
        ],
        overallConfidence: 0,
        notes: [],
        warnings: [],
        createdAtIso: '2026-04-27T00:00:00Z'
      };

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: chainConfigModel,
        runtimeStructuralModel: chainRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_rescue_only',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      // Rescue path was taken — tier reflects the missing direct anchor (A),
      // not the surviving parent (B), because no direct object-anchor
      // candidate was available.
      expect(predicted.anchorTierUsed).toBe('field-object-a');
      expect(predicted.transform.basis).toBe('field-object-a');
      expect(predicted.transform.configObjectId).toBe('cfg_child');
      // No real runtime object backs the virtual reconstruction.
      expect(predicted.transform.runtimeObjectId).toBeUndefined();
      expect(predicted.transform.objectMatchStrategy).toBe('id');

      // virtualA = (0.30 + 0.3*0.50, 0.20 + 0.2*0.50, 0.4*0.50, 0.2*0.50)
      //         = (0.45, 0.30, 0.20, 0.10)
      // field-rel-A is identity-like (0,0,1,1) so predicted == virtualA.
      expect(predicted.bbox.xNorm).toBeCloseTo(0.45, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.30, 6);
      expect(predicted.bbox.wNorm).toBeCloseTo(0.20, 6);
      expect(predicted.bbox.hNorm).toBeCloseTo(0.10, 6);
    });

    it('falls through to parent-object candidate when matched-object missing and rescuer is ambiguous', async () => {
      const runner = createLocalizationRunner();
      const chainConfigModel = buildChainConfigModel();

      // Runtime: cfg_child is missing, AND there is no `cfg_parent` id.
      // Two same-type containers exist instead — an ambiguous rescuer pool.
      // Strict rescue must reject; the runner must continue to the
      // parent-object TM candidate, which resolves directly because its
      // stored runtimeObjectId names one of the two containers.
      const chainRuntimeModel: StructuralModel = {
        ...baseRuntimeModel,
        id: 'runtime_chain_tm_ambig',
        documentFingerprint: 'runtime_chain_tm_ambig-fingerprint',
        pages: [
          {
            ...baseRuntimeModel.pages[0],
            objectHierarchy: {
              objects: [
                {
                  objectId: 'rt_alt_a',
                  objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.50, hNorm: 0.50 },
                  bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.50, hNorm: 0.50 },
                  parentObjectId: null,
                  childObjectIds: [],
                  confidence: 0.9,
          depth: 0
                },
                {
                  objectId: 'rt_alt_b',
                  objectRectNorm: { xNorm: 0.05, yNorm: 0.55, wNorm: 0.40, hNorm: 0.40 },
                  bbox: { xNorm: 0.05, yNorm: 0.55, wNorm: 0.40, hNorm: 0.40 },
                  parentObjectId: null,
                  childObjectIds: [],
                  confidence: 0.85,
          depth: 0
                }
              ]
            }
          }
        ]
      };

      const transformationModel: TransformationModel = {
        schema: 'wrokit/transformation-model',
        version: '1.0',
        transformVersion: 'wrokit/transformation/v1',
        id: 'xform_chain_tm_ambig',
        config: { id: chainConfigModel.id, documentFingerprint: chainConfigModel.documentFingerprint },
        runtime: { id: chainRuntimeModel.id, documentFingerprint: chainRuntimeModel.documentFingerprint },
        pages: [
          {
            pageIndex: 0,
            levelSummaries: [],
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
            fieldAlignments: [
              {
                fieldId: 'invoice_number',
                candidates: [
                  {
                    source: 'matched-object',
                    fallbackOrder: 0,
                    configObjectId: 'cfg_child',
                    runtimeObjectId: 'rt_missing_child',
                    transform: { scaleX: 1, scaleY: 1, translateX: 9, translateY: 9 },
                    relativeFieldRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 },
                    confidence: 0.9,
                    notes: []
                  },
                  {
                    // parent-object names a runtime object that *does* exist
                    // — the matcher already chose rt_alt_a as the parent
                    // counterpart. The rescue must reject before we get
                    // here, but this candidate must then resolve.
                    source: 'parent-object',
                    fallbackOrder: 1,
                    configObjectId: 'cfg_parent',
                    runtimeObjectId: 'rt_alt_a',
                    transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.1 },
                    relativeFieldRect: { xRatio: 0.3, yRatio: 0.2, wRatio: 0.4, hRatio: 0.2 },
                    confidence: 0.6,
                    notes: []
                  }
                ],
                warnings: []
              }
            ],
            notes: [],
            warnings: []
          }
        ],
        overallConfidence: 0,
        notes: [],
        warnings: [],
        createdAtIso: '2026-04-27T00:00:00Z'
      };

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: chainConfigModel,
        runtimeStructuralModel: chainRuntimeModel,
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_tm_rescue_ambig',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      // Rescue rejected (ambiguous parent), parent-object candidate wins.
      expect(predicted.anchorTierUsed).toBe('field-object-b');
      expect(predicted.transform.configObjectId).toBe('cfg_parent');
      expect(predicted.transform.runtimeObjectId).toBe('rt_alt_a');
      // Field bbox (0.25, 0.20, 0.20, 0.10) under affine (1,1,0.2,0.1) ->
      // (0.45, 0.30, 0.20, 0.10).
      expect(predicted.bbox.xNorm).toBeCloseTo(0.45, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.30, 6);
      expect(predicted.bbox.wNorm).toBeCloseTo(0.20, 6);
      expect(predicted.bbox.hNorm).toBeCloseTo(0.10, 6);
    });
  });

  describe('relational rescue (chained anchor reconstruction)', () => {
    // Field at (0.30, 0.30, 0.05, 0.05) in config.
    // obj_inner (A) at (0.25, 0.25, 0.20, 0.20) — field-rel-A = (0.25, 0.25, 0.25, 0.25).
    // obj_outer (B) at (0.10, 0.10, 0.50, 0.50) — field-rel-B = (0.4, 0.4, 0.1, 0.1).
    // A-rel-B (container relation) = (0.3, 0.3, 0.4, 0.4).
    const fieldRel = configGeometry.fields[0];

    const buildChainConfigPage = (extraObjectToObject: StructuralPage['pageAnchorRelations']['objectToObject'] = []): StructuralPage => ({
      pageIndex: 0,
      pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
      cvExecutionMode: 'heuristic-fallback',
      border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
      refinedBorder: {
        rectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
        cvContentRectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
        source: 'cv-content',
        influencedByBBoxCount: 0,
        containsAllSavedBBoxes: true
      },
      objectHierarchy: {
        objects: [
          {
            objectId: 'obj_outer',
            objectRectNorm: { xNorm: 0.10, yNorm: 0.10, wNorm: 0.50, hNorm: 0.50 },
            bbox: { xNorm: 0.10, yNorm: 0.10, wNorm: 0.50, hNorm: 0.50 },
            parentObjectId: null,
            childObjectIds: ['obj_inner'],
            confidence: 0.9,
          depth: 0
          },
          {
            objectId: 'obj_inner',
            objectRectNorm: { xNorm: 0.25, yNorm: 0.25, wNorm: 0.20, hNorm: 0.20 },
            bbox: { xNorm: 0.25, yNorm: 0.25, wNorm: 0.20, hNorm: 0.20 },
            parentObjectId: 'obj_outer',
            childObjectIds: [],
            confidence: 0.85,
          depth: 0
          }
        ]
      },
      pageAnchorRelations: {
        objectToObject: [
          {
            fromObjectId: 'obj_outer',
            toObjectId: 'obj_inner',
            relationKind: 'container',
            relativeRect: { xRatio: 0.3, yRatio: 0.3, wRatio: 0.4, hRatio: 0.4 },
            fallbackOrder: 0,
            distance: 0
          },
          ...extraObjectToObject
        ],
        objectToRefinedBorder: [],
        refinedBorderToBorder: {
          relativeRect: { xRatio: 0.05, yRatio: 0.05, wRatio: 0.9, hRatio: 0.9 }
        }
      },
      fieldRelationships: [
        {
          fieldId: fieldRel.fieldId,
          fieldAnchors: {
            objectAnchors: [
              { rank: 'primary', objectId: 'obj_inner', relativeFieldRect: { xRatio: 0.25, yRatio: 0.25, wRatio: 0.25, hRatio: 0.25 } },
              { rank: 'secondary', objectId: 'obj_outer', relativeFieldRect: { xRatio: 0.4, yRatio: 0.4, wRatio: 0.1, hRatio: 0.1 } }
            ],
            stableObjectAnchors: [
              { label: 'A', objectId: 'obj_inner', distance: 0, relativeFieldRect: { xRatio: 0.25, yRatio: 0.25, wRatio: 0.25, hRatio: 0.25 } },
              { label: 'B', objectId: 'obj_outer', distance: 0, relativeFieldRect: { xRatio: 0.4, yRatio: 0.4, wRatio: 0.1, hRatio: 0.1 } }
            ],
            refinedBorderAnchor: {
              relativeFieldRect: { xRatio: 0.27778, yRatio: 0.27778, wRatio: 0.05556, hRatio: 0.05556 },
              distanceToEdge: 0.05
            },
            borderAnchor: {
              relativeFieldRect: { xRatio: 0.3, yRatio: 0.3, wRatio: 0.05, hRatio: 0.05 },
              distanceToEdge: 0.3
            }
          },
          objectAnchorGraph: [],
          containedBy: 'obj_inner',
          nearestObjects: [],
          relativePositionWithinParent: null,
          distanceToBorder: 0.3,
          distanceToRefinedBorder: 0.05
        }
      ]
    });

    it('reconstructs a virtual A inside a resolved B when A is missing in runtime', () => {
      const configPage = buildChainConfigPage();

      // Runtime: A (rectangle) missing entirely; only B (container) survives,
      // shifted/scaled. There is no rectangle anywhere, so direct A cannot
      // resolve.
      const runtimePageStructural: StructuralPage = {
        ...configPage,
        objectHierarchy: {
          objects: [
            {
              objectId: 'obj_outer',
              objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9,
          depth: 0
            }
          ]
        },
        fieldRelationships: []
      };

      const resolution = __testing.resolveFieldAnchor(fieldRel, configPage, runtimePageStructural);

      // The rescue path keeps the *missing* anchor's tier — the prediction
      // reflects the field's relationship to its direct anchor (A),
      // reconstructed through the surviving parent.
      expect(resolution.tier).toBe('field-object-a');
      expect(resolution.transform.configObjectId).toBe('obj_inner');
      // No real runtime object backs the virtual reconstruction.
      expect(resolution.transform.runtimeObjectId).toBeUndefined();
      expect(resolution.transform.objectMatchStrategy).toBe('id');

      // virtualA = (0.30 + 0.3*0.40, 0.20 + 0.3*0.40, 0.4*0.40, 0.4*0.40)
      //         = (0.42, 0.32, 0.16, 0.16)
      // field   = (0.42 + 0.25*0.16, 0.32 + 0.25*0.16, 0.25*0.16, 0.25*0.16)
      //         = (0.46, 0.36, 0.04, 0.04)
      expect(resolution.predictedBox.xNorm).toBeCloseTo(0.46, 6);
      expect(resolution.predictedBox.yNorm).toBeCloseTo(0.36, 6);
      expect(resolution.predictedBox.wNorm).toBeCloseTo(0.04, 6);
      expect(resolution.predictedBox.hNorm).toBeCloseTo(0.04, 6);

      // The transform's runtime source rect must be the virtual A — not the
      // rescuer's own rect — so consumers reading the artifact see the
      // reconstructed anchor explicitly.
      expect(resolution.transform.sourceRuntimeRectNorm).toEqual({
        xNorm: 0.42,
        yNorm: 0.32,
        wNorm: 0.16000000000000003,
        hNorm: 0.16000000000000003
      });
      expect(resolution.transform.sourceConfigRectNorm).toEqual(
        configPage.objectHierarchy.objects.find((o) => o.objectId === 'obj_inner')?.objectRectNorm
      );
    });

    it('does not chain through an ambiguous parent (multiple same-type candidates, no id match)', () => {
      const configPage = buildChainConfigPage();

      // Runtime has TWO containers with non-matching ids. Direct A (rectangle)
      // cannot resolve. Strict rescuer match for obj_outer fails because the
      // id is absent and there are multiple same-type candidates. The runner
      // must therefore fall back to a *direct* B match (lenient picker), not
      // perform a rescue.
      const runtimePageStructural: StructuralPage = {
        ...configPage,
        objectHierarchy: {
          objects: [
            {
              objectId: 'rt_container_left',
              objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9,
          depth: 0
            },
            {
              objectId: 'rt_container_right',
              objectRectNorm: { xNorm: 0.55, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              bbox: { xNorm: 0.55, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9,
          depth: 0
            }
          ]
        },
        fieldRelationships: []
      };

      const resolution = __testing.resolveFieldAnchor(fieldRel, configPage, runtimePageStructural);

      // Rescue rejected (ambiguous parent) AND the direct B picker also
      // refuses both runtime candidates because their geometry is too far
      // off the config B (config 0.50×0.50 at (0.10, 0.10) vs runtime
      // 0.40×0.40 at (0.30, 0.20) / (0.55, 0.20) — total normalized
      // geometry distance 0.40 / 0.65, exceeding the near-perfect floor).
      // Falls through to refined-border, which is the correct "filter for
      // good data" behavior: when no object anchor passes the bar, the
      // page-level fallback is used instead of force-fitting a marginal one.
      expect(resolution.tier).toBe('refined-border');
    });

    it('does not chain when no container relation between B and A exists in config', () => {
      // Build a config page where the objectToObject graph is empty —
      // there is no container relation FROM obj_outer TO obj_inner.
      const configPage = buildChainConfigPage();
      configPage.pageAnchorRelations.objectToObject = [];

      const runtimePageStructural: StructuralPage = {
        ...configPage,
        objectHierarchy: {
          objects: [
            {
              objectId: 'obj_outer',
              objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9,
          depth: 0
            }
          ]
        },
        fieldRelationships: []
      };

      const resolution = __testing.resolveFieldAnchor(fieldRel, configPage, runtimePageStructural);

      // Without a container relation we never trust the chain — fall through
      // to the next direct stable anchor.
      expect(resolution.tier).toBe('field-object-b');
      expect(resolution.transform.runtimeObjectId).toBe('obj_outer');
    });

    it('does not chain through a non-container relation (sibling / adjacent)', () => {
      // Provide a sibling relation between B and A; the rescuer must still
      // be rejected because non-container relations are not geometrically
      // strong enough to reconstruct a missing child.
      const configPage = buildChainConfigPage();
      configPage.pageAnchorRelations.objectToObject = [
        {
          fromObjectId: 'obj_outer',
          toObjectId: 'obj_inner',
          relationKind: 'sibling',
          relativeRect: { xRatio: 0.3, yRatio: 0.3, wRatio: 0.4, hRatio: 0.4 },
          fallbackOrder: 0,
          distance: 0.1
        }
      ];

      const runtimePageStructural: StructuralPage = {
        ...configPage,
        objectHierarchy: {
          objects: [
            {
              objectId: 'obj_outer',
              objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9,
          depth: 0
            }
          ]
        },
        fieldRelationships: []
      };

      const resolution = __testing.resolveFieldAnchor(fieldRel, configPage, runtimePageStructural);
      expect(resolution.tier).toBe('field-object-b');
      expect(resolution.transform.runtimeObjectId).toBe('obj_outer');
    });

    it('exposes a unit-level resolveFromRelationalRescue helper', () => {
      const configPage = buildChainConfigPage();
      const runtimePageStructural: StructuralPage = {
        ...configPage,
        objectHierarchy: {
          objects: [
            {
              objectId: 'obj_outer',
              objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9,
          depth: 0
            }
          ]
        },
        fieldRelationships: []
      };

      const stableAnchors = configPage.fieldRelationships[0].fieldAnchors.stableObjectAnchors;
      const missingAnchor = stableAnchors[0]; // A
      const rescue = __testing.resolveFromRelationalRescue(
        fieldRel,
        configPage,
        runtimePageStructural,
        missingAnchor,
        stableAnchors
      );

      expect(rescue).not.toBeNull();
      expect(rescue?.tier).toBe('field-object-a');
      expect(rescue?.transform.configObjectId).toBe('obj_inner');
      expect(rescue?.transform.runtimeObjectId).toBeUndefined();

      // No-rescuer-available: an empty candidate list returns null.
      const noRescue = __testing.resolveFromRelationalRescue(
        fieldRel,
        configPage,
        runtimePageStructural,
        missingAnchor,
        []
      );
      expect(noRescue).toBeNull();
    });
  });

  describe('multi-anchor validation and robustness checks', () => {
    const baseConfigModel: StructuralModel = {
      schema: 'wrokit/structural-model',
      version: '4.0',
      structureVersion: 'wrokit/structure/v3',
      id: 'config_audit',
      documentFingerprint: 'config_audit-fingerprint',
      cvAdapter: { name: 'mock-cv', version: '1.0' },
      pages: [
        {
          pageIndex: 0,
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
          cvExecutionMode: 'opencv-runtime',
          border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
          refinedBorder: {
            rectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
            cvContentRectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
            source: 'cv-content',
            influencedByBBoxCount: 0,
            containsAllSavedBBoxes: true
          },
          objectHierarchy: {
            objects: [
              {
                objectId: 'cfg_a',
                objectRectNorm: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.4 },
                bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.4 },
                parentObjectId: null,
                childObjectIds: [],
                confidence: 0.9,
          depth: 0
              },
              {
                objectId: 'cfg_b',
                objectRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.5, hNorm: 0.5 },
                bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.5, hNorm: 0.5 },
                parentObjectId: null,
                childObjectIds: [],
                confidence: 0.85,
          depth: 0
              }
            ]
          },
          pageAnchorRelations: {
            objectToObject: [],
            objectToRefinedBorder: [],
            refinedBorderToBorder: {
              relativeRect: { xRatio: 0.05, yRatio: 0.05, wRatio: 0.9, hRatio: 0.9 }
            }
          },
          fieldRelationships: []
        }
      ],
      createdAtIso: '2026-04-27T00:00:00Z'
    };

    const buildRuntimeModel = (
      cvExecutionMode: 'opencv-runtime' | 'heuristic-fallback'
    ): StructuralModel => ({
      ...baseConfigModel,
      id: 'runtime_audit',
      documentFingerprint: 'runtime_audit-fingerprint',
      pages: [
        {
          ...baseConfigModel.pages[0],
          cvExecutionMode,
          objectHierarchy: {
            objects: [
              {
                objectId: 'rt_a',
                objectRectNorm: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.4 },
                bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.4 },
                parentObjectId: null,
                childObjectIds: [],
                confidence: 0.9,
          depth: 0
              },
              {
                objectId: 'rt_b',
                objectRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.5, hNorm: 0.5 },
                bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.5, hNorm: 0.5 },
                parentObjectId: null,
                childObjectIds: [],
                confidence: 0.85,
          depth: 0
              }
            ]
          }
        }
      ]
    });

    const buildAuditTransformationModel = (input: {
      candidates: TransformationModel['pages'][number]['fieldAlignments'][number]['candidates'];
      consensus?: TransformationModel['pages'][number]['consensus'];
    }): TransformationModel => ({
      schema: 'wrokit/transformation-model',
      version: '1.0',
      transformVersion: 'wrokit/transformation/v1',
      id: 'xform_audit',
      config: { id: baseConfigModel.id, documentFingerprint: baseConfigModel.documentFingerprint },
      runtime: { id: 'runtime_audit', documentFingerprint: 'runtime_audit-fingerprint' },
      pages: [
        {
          pageIndex: 0,
          levelSummaries: [],
          objectMatches: [],
          unmatchedConfigObjectIds: [],
          unmatchedRuntimeObjectIds: [],
          consensus: input.consensus ?? {
            transform: null,
            confidence: 0,
            contributingMatchCount: 0,
            outliers: [],
            notes: [],
            warnings: []
          },
          fieldAlignments: [
            {
              fieldId: 'invoice_number',
              candidates: input.candidates,
              warnings: []
            }
          ],
          notes: [],
          warnings: []
        }
      ],
      overallConfidence: 0,
      notes: [],
      warnings: [],
      createdAtIso: '2026-04-27T00:00:00Z'
    });

    it('warns when two object-anchor candidates project to disagreeing boxes (A vs B)', async () => {
      const runner = createLocalizationRunner();
      // matched-object (A) projects field to (0.45, 0.50, 0.20, 0.10).
      // parent-object (B) projects to (0.85, 0.80, 0.20, 0.10) — far away.
      // IoU between the two projections is 0, well below 0.5 threshold.
      const transformationModel = buildAuditTransformationModel({
        candidates: [
          {
            source: 'matched-object',
            fallbackOrder: 0,
            configObjectId: 'cfg_a',
            runtimeObjectId: 'rt_a',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
            relativeFieldRect: { xRatio: 0.125, yRatio: 0, wRatio: 0.5, hRatio: 0.25 },
            confidence: 0.9,
            notes: []
          },
          {
            source: 'parent-object',
            fallbackOrder: 1,
            configObjectId: 'cfg_b',
            runtimeObjectId: 'rt_b',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.6, translateY: 0.6 },
            relativeFieldRect: { xRatio: 0.3, yRatio: 0.2, wRatio: 0.4, hRatio: 0.2 },
            confidence: 0.7,
            notes: []
          }
        ]
      });

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: buildRuntimeModel('opencv-runtime'),
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_audit_disagree',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      // Primary still wins — multi-anchor validation never silently mutates
      // the chosen anchor (preserves working refined-border / border
      // semantics).
      expect(predicted.anchorTierUsed).toBe('field-object-a');
      expect(predicted.warnings).toBeDefined();
      expect(predicted.warnings?.some((w) => w.startsWith('anchor disagreement'))).toBe(true);
      // The warning must name the disagreeing alternative.
      expect(predicted.warnings?.some((w) => w.includes('parent-object(cfg_b)'))).toBe(true);
    });

    it('does not warn when the chosen anchor agrees with at least one alternative', async () => {
      const runner = createLocalizationRunner();
      // Both candidates produce the same projection.
      const transformationModel = buildAuditTransformationModel({
        candidates: [
          {
            source: 'matched-object',
            fallbackOrder: 0,
            configObjectId: 'cfg_a',
            runtimeObjectId: 'rt_a',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
            relativeFieldRect: { xRatio: 0.125, yRatio: 0, wRatio: 0.5, hRatio: 0.25 },
            confidence: 0.9,
            notes: []
          },
          {
            source: 'parent-object',
            fallbackOrder: 1,
            configObjectId: 'cfg_b',
            runtimeObjectId: 'rt_b',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
            relativeFieldRect: { xRatio: 0.3, yRatio: 0.2, wRatio: 0.4, hRatio: 0.2 },
            confidence: 0.7,
            notes: []
          }
        ]
      });

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: buildRuntimeModel('opencv-runtime'),
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_audit_agree',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      const disagreeWarnings = (predicted.warnings ?? []).filter((w) =>
        w.startsWith('anchor disagreement')
      );
      expect(disagreeWarnings).toHaveLength(0);
    });

    it('warns about a weak object match with no agreeing alternative', async () => {
      const runner = createLocalizationRunner();
      // Single low-confidence matched-object candidate, no other alternatives,
      // no consensus — the runner cannot cross-check it.
      const transformationModel = buildAuditTransformationModel({
        candidates: [
          {
            source: 'matched-object',
            fallbackOrder: 0,
            configObjectId: 'cfg_a',
            runtimeObjectId: 'rt_a',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
            relativeFieldRect: { xRatio: 0.125, yRatio: 0, wRatio: 0.5, hRatio: 0.25 },
            confidence: 0.3,
            notes: []
          }
        ]
      });

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: buildRuntimeModel('opencv-runtime'),
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_audit_weak',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      expect(predicted.warnings?.some((w) => w.startsWith('weak object match'))).toBe(true);
    });

    it('does not warn about a weak object match when a confident consensus is present', async () => {
      const runner = createLocalizationRunner();
      const transformationModel = buildAuditTransformationModel({
        candidates: [
          {
            source: 'matched-object',
            fallbackOrder: 0,
            configObjectId: 'cfg_a',
            runtimeObjectId: 'rt_a',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
            relativeFieldRect: { xRatio: 0.125, yRatio: 0, wRatio: 0.5, hRatio: 0.25 },
            confidence: 0.3,
            notes: []
          }
        ],
        consensus: {
          transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
          confidence: 0.9,
          contributingMatchCount: 4,
          outliers: [],
          notes: [],
          warnings: []
        }
      });

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: buildRuntimeModel('opencv-runtime'),
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_audit_weak_with_consensus',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      const weakWarnings = (predicted.warnings ?? []).filter((w) =>
        w.startsWith('weak object match')
      );
      // Consensus agrees with the chosen anchor (same affine), so neither a
      // disagreement warning nor a weak-match warning should fire.
      expect(weakWarnings).toHaveLength(0);
    });

    it('surfaces a top-level warning when config and runtime cvExecutionMode disagree', async () => {
      const runner = createLocalizationRunner();
      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel, // opencv-runtime
        runtimeStructuralModel: buildRuntimeModel('heuristic-fallback'),
        runtimePages: [runtimePage],
        predictedId: 'pred_audit_cv_mismatch',
        nowIso: '2026-04-27T00:00:00Z'
      });

      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some((w) => w.includes('cvExecutionMode mismatch'))).toBe(true);
      // Per-field warning is also surfaced so consumers can attribute the
      // mismatch to the specific page that produced this prediction.
      expect(result.fields[0].warnings?.some((w) => w.includes('cvExecutionMode mismatch'))).toBe(
        true
      );
    });

    it('does not emit cv-mismatch warnings when modes agree', async () => {
      const runner = createLocalizationRunner();
      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: buildRuntimeModel('opencv-runtime'),
        runtimePages: [runtimePage],
        predictedId: 'pred_audit_cv_match',
        nowIso: '2026-04-27T00:00:00Z'
      });

      expect((result.warnings ?? []).some((w) => w.includes('cvExecutionMode mismatch'))).toBe(false);
      expect(
        (result.fields[0].warnings ?? []).some((w) => w.includes('cvExecutionMode mismatch'))
      ).toBe(false);
    });

    it('exposes a unit-level evaluateAnchorAgreement helper', () => {
      const chosen = {
        tier: 'field-object-a' as const,
        transform: {
          pageIndex: 0,
          basis: 'field-object-a' as const,
          sourceConfigRectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 },
          sourceRuntimeRectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 },
          scaleX: 1,
          scaleY: 1,
          translateX: 0,
          translateY: 0
        },
        predictedBox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.1, hNorm: 0.1 }
      };

      const noAlternatives = __testing.evaluateAnchorAgreement({
        chosen,
        chosenLabel: 'matched-object(cfg_a)',
        alternatives: [],
        primaryCandidate: undefined,
        hasConsensusAlternative: false
      });
      expect(noAlternatives).toEqual([]);

      const agreeing = __testing.evaluateAnchorAgreement({
        chosen,
        chosenLabel: 'matched-object(cfg_a)',
        alternatives: [
          {
            label: 'parent-object(cfg_b)',
            predictedBox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.1, hNorm: 0.1 }
          }
        ],
        primaryCandidate: undefined,
        hasConsensusAlternative: false
      });
      expect(agreeing).toEqual([]);

      const disagreeing = __testing.evaluateAnchorAgreement({
        chosen,
        chosenLabel: 'matched-object(cfg_a)',
        alternatives: [
          {
            label: 'parent-object(cfg_b)',
            predictedBox: { xNorm: 0.8, yNorm: 0.8, wNorm: 0.1, hNorm: 0.1 }
          }
        ],
        primaryCandidate: undefined,
        hasConsensusAlternative: false
      });
      expect(disagreeing).toHaveLength(1);
      expect(disagreeing[0]).toMatch(/anchor disagreement/);
    });

    it('exposes a unit-level collectCvModeMismatchWarnings helper', () => {
      const config = baseConfigModel; // opencv-runtime on page 0
      const runtimeMatch = buildRuntimeModel('opencv-runtime');
      const runtimeMismatch = buildRuntimeModel('heuristic-fallback');

      const matchResult = __testing.collectCvModeMismatchWarnings(config, runtimeMatch);
      expect(matchResult.global).toEqual([]);
      expect(matchResult.perPage.size).toBe(0);

      const mismatchResult = __testing.collectCvModeMismatchWarnings(config, runtimeMismatch);
      expect(mismatchResult.global).toHaveLength(1);
      expect(mismatchResult.perPage.get(0)).toMatch(/cvExecutionMode mismatch/);
    });

    it('escalates the per-field cv-mode warning to record confidence demotion when an object anchor is used', async () => {
      const runner = createLocalizationRunner();
      // 0.45 < WEAK_OBJECT_MATCH_CONFIDENCE (0.5) but no demotion would
      // mention an effective value. With cv-mode mismatch the candidate's
      // confidence is reported alongside its demoted value.
      const transformationModel = buildAuditTransformationModel({
        candidates: [
          {
            source: 'matched-object',
            fallbackOrder: 0,
            configObjectId: 'cfg_a',
            runtimeObjectId: 'rt_a',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
            relativeFieldRect: { xRatio: 0.125, yRatio: 0, wRatio: 0.5, hRatio: 0.25 },
            confidence: 0.6,
            notes: []
          }
        ]
      });

      const result = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel, // opencv-runtime
        runtimeStructuralModel: buildRuntimeModel('heuristic-fallback'),
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_audit_cv_demote',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      const escalated = (predicted.warnings ?? []).find(
        (w) => w.includes('cvExecutionMode mismatch') && w.includes('demoted')
      );
      expect(escalated).toBeDefined();
      // 0.6 × CV_MODE_MISMATCH_CONFIDENCE_PENALTY (0.7) = 0.42
      expect(escalated).toMatch(/0\.60→0\.42/);
    });

    it('demotes weak-match threshold under cv-mode mismatch so a borderline match warns', async () => {
      const runner = createLocalizationRunner();
      // confidence 0.55: above WEAK_OBJECT_MATCH_CONFIDENCE (0.5), so no
      // weak-match warning normally fires. With mismatch demotion ×0.7 the
      // effective value drops to 0.385, below the threshold.
      const transformationModel = buildAuditTransformationModel({
        candidates: [
          {
            source: 'matched-object',
            fallbackOrder: 0,
            configObjectId: 'cfg_a',
            runtimeObjectId: 'rt_a',
            transform: { scaleX: 1, scaleY: 1, translateX: 0.2, translateY: 0.3 },
            relativeFieldRect: { xRatio: 0.125, yRatio: 0, wRatio: 0.5, hRatio: 0.25 },
            confidence: 0.55,
            notes: []
          }
        ]
      });

      const noMismatch = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: buildRuntimeModel('opencv-runtime'),
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_audit_cv_borderline_ok',
        nowIso: '2026-04-27T00:00:00Z'
      });
      expect(
        (noMismatch.fields[0].warnings ?? []).some((w) => w.startsWith('weak object match'))
      ).toBe(false);

      const withMismatch = await runner.run({
        wizardId: 'Invoice Wizard',
        configGeometry,
        configStructuralModel: baseConfigModel,
        runtimeStructuralModel: buildRuntimeModel('heuristic-fallback'),
        runtimePages: [runtimePage],
        transformationModel,
        predictedId: 'pred_audit_cv_borderline_demoted',
        nowIso: '2026-04-27T00:00:00Z'
      });
      const weak = (withMismatch.fields[0].warnings ?? []).find((w) =>
        w.startsWith('weak object match')
      );
      expect(weak).toBeDefined();
      expect(weak).toMatch(/effective 0\.39/);
    });

    it('exposes isPositionalObjectId for adapter-generated id patterns', () => {
      // Detected as positional (auto-generated by detection-order index):
      expect(__testing.isPositionalObjectId('obj_0')).toBe(true);
      expect(__testing.isPositionalObjectId('obj_42')).toBe(true);
      expect(__testing.isPositionalObjectId('obj_hline_3')).toBe(true);
      expect(__testing.isPositionalObjectId('obj_vline_0')).toBe(true);
      expect(__testing.isPositionalObjectId('obj_cv_5')).toBe(true);
      expect(__testing.isPositionalObjectId('obj_cv_line_2')).toBe(true);

      // Non-positional / authored / id-bearing identifiers are not flagged:
      expect(__testing.isPositionalObjectId('obj_outer')).toBe(false);
      expect(__testing.isPositionalObjectId('obj_inner')).toBe(false);
      expect(__testing.isPositionalObjectId('cfg_a')).toBe(false);
      expect(__testing.isPositionalObjectId('header_main')).toBe(false);
    });

    it('demotes a positional id-only match to type-hierarchy-geometry across distinct documents', () => {
      // Two pages backed by completely different documents — the runtime
      // page just happens to have an `obj_0` of the same type as the config
      // page's `obj_0`. Within a single document this would be a real `id`
      // match; across documents it is a positional coincidence.
      const buildPage = (objectRect: StructuralNormalizedRect): StructuralPage => ({
        pageIndex: 0,
        pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
        cvExecutionMode: 'opencv-runtime',
        border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
        refinedBorder: {
          rectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
          cvContentRectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
          source: 'cv-content',
          influencedByBBoxCount: 0,
          containsAllSavedBBoxes: true
        },
        objectHierarchy: {
          objects: [
            {
              objectId: 'obj_0',
              objectRectNorm: objectRect,
              bbox: objectRect,
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9,
          depth: 0
            }
          ]
        },
        pageAnchorRelations: {
          objectToObject: [],
          objectToRefinedBorder: [],
          refinedBorderToBorder: {
            relativeRect: { xRatio: 0.05, yRatio: 0.05, wRatio: 0.9, hRatio: 0.9 }
          }
        },
        fieldRelationships: []
      });

      const configPage = buildPage({ xNorm: 0.1, yNorm: 0.1, wNorm: 0.4, hNorm: 0.4 });
      const runtimePageDifferent = buildPage({ xNorm: 0.2, yNorm: 0.3, wNorm: 0.4, hNorm: 0.4 });

      // crossDocument=false: id strategy stands.
      const sameDocResolution = __testing.resolveRuntimeObject(
        configPage,
        runtimePageDifferent,
        'obj_0',
        { crossDocument: false }
      );
      expect(sameDocResolution?.strategy).toBe('id');

      // crossDocument=true: positional id is no longer claimed; resolver falls
      // through to type-hierarchy-geometry, which still picks the only same-
      // type runtime object — but now with an honest strategy label.
      const crossDocResolution = __testing.resolveRuntimeObject(
        configPage,
        runtimePageDifferent,
        'obj_0',
        { crossDocument: true }
      );
      expect(crossDocResolution?.strategy).toBe('type-hierarchy-geometry');
      expect(crossDocResolution?.object.objectId).toBe('obj_0');

      // Non-positional ids keep `id` strategy even across documents.
      const buildAuthoredPage = (rect: StructuralNormalizedRect): StructuralPage => ({
        ...configPage,
        objectHierarchy: {
          objects: [
            {
              objectId: 'header_main',
              objectRectNorm: rect,
              bbox: rect,
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9,
          depth: 0
            }
          ]
        }
      });
      const authoredCross = __testing.resolveRuntimeObject(
        buildAuthoredPage({ xNorm: 0.1, yNorm: 0.1, wNorm: 0.4, hNorm: 0.4 }),
        buildAuthoredPage({ xNorm: 0.2, yNorm: 0.3, wNorm: 0.4, hNorm: 0.4 }),
        'header_main',
        { crossDocument: true }
      );
      expect(authoredCross?.strategy).toBe('id');
    });

    it('rejects a degenerate single-match consensus rescue when confidence is borderline', () => {
      // Just barely clearing CONSENSUS_RESCUE_MIN_CONFIDENCE (0.6) is exactly
      // the audit's "1-match consensus that just clears the floor" — the
      // single-match guard should refuse to rescue.
      const borderline = __testing.resolveFromConsensusRescue(
        configGeometry.fields[0],
        {
          transform: { scaleX: 1, scaleY: 1, translateX: 0.1, translateY: 0.1 },
          confidence: 0.61,
          contributingMatchCount: 1,
          outliers: [],
          notes: [],
          warnings: []
        },
        __testing.CONSENSUS_RESCUE_MIN_CONFIDENCE
      );
      expect(borderline).toBeNull();

      // A confident single-match consensus is allowed but emits a warning so
      // the degeneracy is visible downstream.
      const strong = __testing.resolveFromConsensusRescue(
        configGeometry.fields[0],
        {
          transform: { scaleX: 1, scaleY: 1, translateX: 0.1, translateY: 0.1 },
          confidence: 0.9,
          contributingMatchCount: 1,
          outliers: [],
          notes: [],
          warnings: []
        },
        __testing.CONSENSUS_RESCUE_MIN_CONFIDENCE
      );
      expect(strong).not.toBeNull();
      expect(strong?.warnings?.some((w) => w.startsWith('weak consensus rescue'))).toBe(true);

      // A multi-match consensus near the regular floor is fine — no warning,
      // no rejection.
      const multi = __testing.resolveFromConsensusRescue(
        configGeometry.fields[0],
        {
          transform: { scaleX: 1, scaleY: 1, translateX: 0.1, translateY: 0.1 },
          confidence: 0.65,
          contributingMatchCount: 4,
          outliers: [],
          notes: [],
          warnings: []
        },
        __testing.CONSENSUS_RESCUE_MIN_CONFIDENCE
      );
      expect(multi).not.toBeNull();
      // No warnings array at all — the multi-match path returns a clean result
      // when the projection also fits within [0,1].
      expect(
        (multi?.warnings ?? []).some((w) => w.startsWith('weak consensus rescue'))
      ).toBe(false);
    });
  });
});
