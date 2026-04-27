import { describe, expect, it } from 'vitest';

import type { GeometryFile } from '../../src/core/contracts/geometry';
import type { NormalizedPage } from '../../src/core/contracts/normalized-page';
import type { StructuralModel } from '../../src/core/contracts/structural-model';
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
});
