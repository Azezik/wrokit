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
  version: '3.0',
  structureVersion: 'wrokit/structure/v2',
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

  it('clamps transformed geometry to normalized bounds', () => {
    const transformed = __testing.applyTransformToBox(
      { xNorm: 0.9, yNorm: 0.92, wNorm: 0.3, hNorm: 0.2 },
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

    expect(transformed.xNorm).toBe(1);
    expect(transformed.yNorm).toBe(0.9700000000000001);
    expect(transformed.wNorm).toBe(0);
    expect(transformed.hNorm).toBeCloseTo(0.029999999999999916);
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
          type: 'container',
          objectRectNorm: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.5, hNorm: 0.4 },
          bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.5, hNorm: 0.4 },
          parentObjectId: null,
          childObjectIds: ['obj_child'],
          confidence: 0.9
        },
        {
          objectId: 'obj_child',
          type: 'rectangle',
          objectRectNorm: { xNorm: 0.25, yNorm: 0.25, wNorm: 0.1, hNorm: 0.1 },
          bbox: { xNorm: 0.25, yNorm: 0.25, wNorm: 0.1, hNorm: 0.1 },
          parentObjectId: 'obj_container',
          childObjectIds: [],
          confidence: 0.8
        },
        {
          objectId: 'obj_sibling',
          type: 'container',
          objectRectNorm: { xNorm: 0.72, yNorm: 0.2, wNorm: 0.2, hNorm: 0.2 },
          bbox: { xNorm: 0.72, yNorm: 0.2, wNorm: 0.2, hNorm: 0.2 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.8
        },
        {
          objectId: 'obj_adjacent',
          type: 'container',
          objectRectNorm: { xNorm: 0.2, yNorm: 0.62, wNorm: 0.2, hNorm: 0.2 },
          bbox: { xNorm: 0.2, yNorm: 0.62, wNorm: 0.2, hNorm: 0.2 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.8
        }
      ],
      'obj_container'
    );

    const runtimePageStructural = buildPage(
      [
        {
          objectId: 'obj_runtime_container',
          type: 'container',
          objectRectNorm: { xNorm: 0.3, yNorm: 0.25, wNorm: 0.45, hNorm: 0.4 },
          bbox: { xNorm: 0.3, yNorm: 0.25, wNorm: 0.45, hNorm: 0.4 },
          parentObjectId: null,
          childObjectIds: ['obj_runtime_child'],
          confidence: 0.9
        },
        {
          objectId: 'obj_runtime_child',
          type: 'rectangle',
          objectRectNorm: { xNorm: 0.35, yNorm: 0.3, wNorm: 0.08, hNorm: 0.08 },
          bbox: { xNorm: 0.35, yNorm: 0.3, wNorm: 0.08, hNorm: 0.08 },
          parentObjectId: 'obj_runtime_container',
          childObjectIds: [],
          confidence: 0.7
        },
        {
          objectId: 'obj_sibling',
          type: 'container',
          objectRectNorm: { xNorm: 0.7, yNorm: 0.18, wNorm: 0.2, hNorm: 0.2 },
          bbox: { xNorm: 0.7, yNorm: 0.18, wNorm: 0.2, hNorm: 0.2 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.8
        },
        {
          objectId: 'obj_adjacent',
          type: 'container',
          objectRectNorm: { xNorm: 0.22, yNorm: 0.64, wNorm: 0.2, hNorm: 0.2 },
          bbox: { xNorm: 0.22, yNorm: 0.64, wNorm: 0.2, hNorm: 0.2 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.8
        }
      ],
      'obj_runtime_container'
    );

    const resolution = __testing.resolveFieldAnchor(field, configPage, runtimePageStructural);
    expect(resolution.tier).toBe('field-object-c');
    expect(resolution.transform.configObjectId).toBe('obj_container');
    expect(resolution.transform.runtimeObjectId).toBe('obj_runtime_container');
    expect(resolution.transform.objectMatchStrategy).toBe('type-hierarchy-geometry');
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
          type: 'header',
          objectRectNorm: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.3, hNorm: 0.3 },
          bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.3, hNorm: 0.3 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.9
        },
        {
          objectId: 'obj_b',
          type: 'container',
          objectRectNorm: { xNorm: 0.55, yNorm: 0.2, wNorm: 0.2, hNorm: 0.3 },
          bbox: { xNorm: 0.55, yNorm: 0.2, wNorm: 0.2, hNorm: 0.3 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.85
        },
        {
          objectId: 'obj_c',
          type: 'rectangle',
          objectRectNorm: { xNorm: 0.2, yNorm: 0.55, wNorm: 0.25, hNorm: 0.2 },
          bbox: { xNorm: 0.2, yNorm: 0.55, wNorm: 0.25, hNorm: 0.2 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.8
        }
      ],
      ['obj_a', 'obj_b', 'obj_c']
    );

    const runtimeAll = buildPage(
      [
        {
          objectId: 'obj_a',
          type: 'header',
          objectRectNorm: { xNorm: 0.21, yNorm: 0.22, wNorm: 0.3, hNorm: 0.3 },
          bbox: { xNorm: 0.21, yNorm: 0.22, wNorm: 0.3, hNorm: 0.3 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.9
        },
        {
          objectId: 'obj_b',
          type: 'container',
          objectRectNorm: { xNorm: 0.56, yNorm: 0.22, wNorm: 0.2, hNorm: 0.3 },
          bbox: { xNorm: 0.56, yNorm: 0.22, wNorm: 0.2, hNorm: 0.3 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.85
        },
        {
          objectId: 'obj_c',
          type: 'rectangle',
          objectRectNorm: { xNorm: 0.22, yNorm: 0.56, wNorm: 0.25, hNorm: 0.2 },
          bbox: { xNorm: 0.22, yNorm: 0.56, wNorm: 0.25, hNorm: 0.2 },
          parentObjectId: null,
          childObjectIds: [],
          confidence: 0.8
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
          type: 'container',
          objectRectNorm: counter,
          bbox: counter,
          parentObjectId: null,
          childObjectIds: ['obj_drawer'],
          confidence: 0.9
        },
        {
          objectId: 'obj_drawer',
          type: 'container',
          objectRectNorm: drawer,
          bbox: drawer,
          parentObjectId: 'obj_counter',
          childObjectIds: ['obj_tray'],
          confidence: 0.88
        },
        {
          objectId: 'obj_tray',
          type: 'container',
          objectRectNorm: tray,
          bbox: tray,
          parentObjectId: 'obj_drawer',
          childObjectIds: [],
          confidence: 0.86
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
        version: '3.0',
        structureVersion: 'wrokit/structure/v2',
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
        type: 'container',
        objectRectNorm: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.6, hNorm: 0.5 },
        bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.6, hNorm: 0.5 },
        parentObjectId: null,
        childObjectIds: ['cfg_drawer'],
        confidence: 0.9
      },
      {
        objectId: 'cfg_drawer',
        type: 'container',
        objectRectNorm: { xNorm: 0.3, yNorm: 0.4, wNorm: 0.2, hNorm: 0.15 },
        bbox: { xNorm: 0.3, yNorm: 0.4, wNorm: 0.2, hNorm: 0.15 },
        parentObjectId: 'cfg_counter',
        childObjectIds: ['cfg_tray'],
        confidence: 0.88
      },
      {
        objectId: 'cfg_tray',
        type: 'container',
        objectRectNorm: { xNorm: 0.31, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 },
        bbox: { xNorm: 0.31, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 },
        parentObjectId: 'cfg_drawer',
        childObjectIds: [],
        confidence: 0.86
      }
    ]);

    // Runtime: a "decoy" container with no parent and a real tray nested
    // inside drawer inside counter. Even though the decoy is geometrically
    // closer to the config tray, the ancestor chain match must win.
    const runtimePageStructural = buildPage([
      {
        objectId: 'runtime_decoy_tray',
        type: 'container',
        objectRectNorm: { xNorm: 0.33, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 },
        bbox: { xNorm: 0.33, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 },
        parentObjectId: null,
        childObjectIds: [],
        confidence: 0.86
      },
      {
        objectId: 'runtime_counter',
        type: 'container',
        objectRectNorm: { xNorm: 0.4, yNorm: 0.2, wNorm: 0.55, hNorm: 0.5 },
        bbox: { xNorm: 0.4, yNorm: 0.2, wNorm: 0.55, hNorm: 0.5 },
        parentObjectId: null,
        childObjectIds: ['runtime_drawer'],
        confidence: 0.9
      },
      {
        objectId: 'runtime_drawer',
        type: 'container',
        objectRectNorm: { xNorm: 0.5, yNorm: 0.4, wNorm: 0.2, hNorm: 0.15 },
        bbox: { xNorm: 0.5, yNorm: 0.4, wNorm: 0.2, hNorm: 0.15 },
        parentObjectId: 'runtime_counter',
        childObjectIds: ['runtime_real_tray'],
        confidence: 0.88
      },
      {
        objectId: 'runtime_real_tray',
        type: 'container',
        objectRectNorm: { xNorm: 0.51, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 },
        bbox: { xNorm: 0.51, yNorm: 0.41, wNorm: 0.08, hNorm: 0.03 },
        parentObjectId: 'runtime_drawer',
        childObjectIds: [],
        confidence: 0.86
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
      version: '3.0',
      structureVersion: 'wrokit/structure/v2',
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
            source: 'cv-content',
            influencedByBBoxCount: 0,
            containsAllSavedBBoxes: true
          },
          objectHierarchy: {
            objects: [
              {
                objectId: 'cfg_box',
                type: 'rectangle',
                objectRectNorm: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.4 },
                bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.4 },
                parentObjectId: null,
                childObjectIds: [],
                confidence: 0.9
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
                type: 'rectangle',
                objectRectNorm: { xNorm: 0.4, yNorm: 0.5, wNorm: 0.4, hNorm: 0.4 },
                bbox: { xNorm: 0.4, yNorm: 0.5, wNorm: 0.4, hNorm: 0.4 },
                parentObjectId: null,
                childObjectIds: [],
                confidence: 0.9
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
                  type: 'container',
                  objectRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.5, hNorm: 0.5 },
                  bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.5, hNorm: 0.5 },
                  parentObjectId: null,
                  childObjectIds: ['cfg_child'],
                  confidence: 0.9
                },
                {
                  objectId: 'cfg_child',
                  type: 'rectangle',
                  objectRectNorm: { xNorm: 0.25, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
                  bbox: { xNorm: 0.25, yNorm: 0.2, wNorm: 0.2, hNorm: 0.1 },
                  parentObjectId: 'cfg_parent',
                  childObjectIds: [],
                  confidence: 0.85
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
                  type: 'container',
                  objectRectNorm: { xNorm: 0.3, yNorm: 0.2, wNorm: 0.5, hNorm: 0.5 },
                  bbox: { xNorm: 0.3, yNorm: 0.2, wNorm: 0.5, hNorm: 0.5 },
                  parentObjectId: null,
                  childObjectIds: [],
                  confidence: 0.9
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

    it('does not consult the consensus rescue when an object anchor already resolved', async () => {
      const runner = createLocalizationRunner();
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
          // High-confidence consensus pointing somewhere else; must be ignored
          // because the object anchor already resolved.
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
        predictedId: 'pred_tm_consensus_unused',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      expect(predicted.anchorTierUsed).toBe('field-object-a');
      // Used the matched-object affine, not the consensus affine.
      expect(predicted.bbox.xNorm).toBeCloseTo(0.45, 6);
      expect(predicted.bbox.yNorm).toBeCloseTo(0.5, 6);
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
                type: 'container',
                objectRectNorm: { xNorm: 0.10, yNorm: 0.10, wNorm: 0.50, hNorm: 0.50 },
                bbox: { xNorm: 0.10, yNorm: 0.10, wNorm: 0.50, hNorm: 0.50 },
                parentObjectId: null,
                childObjectIds: ['cfg_child'],
                confidence: 0.9
              },
              {
                objectId: 'cfg_child',
                type: 'rectangle',
                objectRectNorm: { xNorm: 0.25, yNorm: 0.20, wNorm: 0.20, hNorm: 0.10 },
                bbox: { xNorm: 0.25, yNorm: 0.20, wNorm: 0.20, hNorm: 0.10 },
                parentObjectId: 'cfg_parent',
                childObjectIds: [],
                confidence: 0.85
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

    it('rescues a missing matched-object candidate via the parent in the TM-driven path', async () => {
      const runner = createLocalizationRunner();
      const chainConfigModel = buildChainConfigModel();

      // Runtime: cfg_child is missing entirely (no rectangles), but the
      // parent is present with the same id (id-match → unambiguous rescuer).
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
                  type: 'container',
                  objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.50, hNorm: 0.50 },
                  bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.50, hNorm: 0.50 },
                  parentObjectId: null,
                  childObjectIds: [],
                  confidence: 0.9
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
                    // matched-object pointing at the missing child — fails.
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
                    // parent-object that *would* resolve directly. The
                    // rescue must take priority over this so the artifact
                    // reports the rescued tier-A rather than dropping to
                    // tier-B.
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
        predictedId: 'pred_tm_rescue',
        nowIso: '2026-04-27T00:00:00Z'
      });

      const predicted = result.fields[0];
      // Rescue path was taken — tier reflects the missing direct anchor (A),
      // not the surviving parent (B).
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
                  type: 'container',
                  objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.50, hNorm: 0.50 },
                  bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.50, hNorm: 0.50 },
                  parentObjectId: null,
                  childObjectIds: [],
                  confidence: 0.9
                },
                {
                  objectId: 'rt_alt_b',
                  type: 'container',
                  objectRectNorm: { xNorm: 0.05, yNorm: 0.55, wNorm: 0.40, hNorm: 0.40 },
                  bbox: { xNorm: 0.05, yNorm: 0.55, wNorm: 0.40, hNorm: 0.40 },
                  parentObjectId: null,
                  childObjectIds: [],
                  confidence: 0.85
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
        source: 'cv-content',
        influencedByBBoxCount: 0,
        containsAllSavedBBoxes: true
      },
      objectHierarchy: {
        objects: [
          {
            objectId: 'obj_outer',
            type: 'container',
            objectRectNorm: { xNorm: 0.10, yNorm: 0.10, wNorm: 0.50, hNorm: 0.50 },
            bbox: { xNorm: 0.10, yNorm: 0.10, wNorm: 0.50, hNorm: 0.50 },
            parentObjectId: null,
            childObjectIds: ['obj_inner'],
            confidence: 0.9
          },
          {
            objectId: 'obj_inner',
            type: 'rectangle',
            objectRectNorm: { xNorm: 0.25, yNorm: 0.25, wNorm: 0.20, hNorm: 0.20 },
            bbox: { xNorm: 0.25, yNorm: 0.25, wNorm: 0.20, hNorm: 0.20 },
            parentObjectId: 'obj_outer',
            childObjectIds: [],
            confidence: 0.85
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
              type: 'container',
              objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9
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
              type: 'container',
              objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9
            },
            {
              objectId: 'rt_container_right',
              type: 'container',
              objectRectNorm: { xNorm: 0.55, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              bbox: { xNorm: 0.55, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9
            }
          ]
        },
        fieldRelationships: []
      };

      const resolution = __testing.resolveFieldAnchor(fieldRel, configPage, runtimePageStructural);

      // Rescue rejected → direct B path takes over.
      expect(resolution.tier).toBe('field-object-b');
      // The lenient direct picker selects one of the two same-type runtime
      // candidates and exposes it explicitly.
      expect(resolution.transform.runtimeObjectId).toBeDefined();
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
              type: 'container',
              objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9
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
              type: 'container',
              objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9
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
              type: 'container',
              objectRectNorm: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              bbox: { xNorm: 0.30, yNorm: 0.20, wNorm: 0.40, hNorm: 0.40 },
              parentObjectId: null,
              childObjectIds: [],
              confidence: 0.9
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
});
