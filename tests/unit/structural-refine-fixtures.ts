/**
 * Shared synthetic fixtures for structural-refine unit tests. Not a `.test.ts`
 * file so vitest won't pick it up directly.
 */
import type { GeometryFile } from '../../src/core/contracts/geometry';
import type { PredictedGeometryFile } from '../../src/core/contracts/predicted-geometry-file';
import type {
  StructuralModel,
  StructuralNormalizedRect,
  StructuralPage
} from '../../src/core/contracts/structural-model';
import type {
  RefineCompatibilitySignature,
  StructuralRefineAnalytics,
  StructuralRefineAnalyticsObject,
  StructuralRefineAnalyticsPage,
  WelfordAffine,
  WelfordRect,
  WelfordScalar
} from '../../src/core/contracts/structural-refine-analytics';
import type {
  TransformationAffine,
  TransformationModel,
  TransformationPage
} from '../../src/core/contracts/transformation-model';
import type { WizardFile } from '../../src/core/contracts/wizard';
import { buildFieldRelationships, buildPageAnchorRelations } from '../../src/core/engines/structure/object-hierarchy';

const BORDER_RECT: StructuralNormalizedRect = { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 };

export const wizardFixture = (): WizardFile => ({
  schema: 'wrokit/wizard-file',
  version: '1.0',
  wizardName: 'Test Wizard',
  fields: [
    { fieldId: 'invoice_number', label: 'Invoice #', type: 'numeric', required: true },
    { fieldId: 'invoice_date', label: 'Date', type: 'text', required: false }
  ]
});

export const geometryFixture = (): GeometryFile => ({
  schema: 'wrokit/geometry-file',
  version: '1.1',
  geometryFileVersion: 'wrokit/geometry/v1',
  id: 'geo_1',
  wizardId: 'Test Wizard',
  documentFingerprint: 'sha256:config',
  fields: [
    {
      fieldId: 'invoice_number',
      pageIndex: 0,
      bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.15, hNorm: 0.05 },
      pixelBbox: { x: 200, y: 200, width: 150, height: 50 },
      pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1000 },
      confirmedAtIso: '2026-01-01T00:00:00Z',
      confirmedBy: 'user'
    },
    {
      fieldId: 'invoice_date',
      pageIndex: 0,
      bbox: { xNorm: 0.5, yNorm: 0.2, wNorm: 0.18, hNorm: 0.05 },
      pixelBbox: { x: 500, y: 200, width: 180, height: 50 },
      pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1000 },
      confirmedAtIso: '2026-01-01T00:00:00Z',
      confirmedBy: 'user'
    }
  ]
});

const buildPage = (input: {
  pageIndex: number;
  objects: Array<{ id: string; rect: StructuralNormalizedRect; parent?: string | null }>;
  fieldBboxes: Array<{ fieldId: string; rect: StructuralNormalizedRect }>;
  refinedRect: StructuralNormalizedRect;
}): StructuralPage => {
  const objectsWithLinks = input.objects.map((object) => ({
    objectId: object.id,
    objectRectNorm: object.rect,
    bbox: object.rect,
    parentObjectId: object.parent ?? null,
    childObjectIds: [] as string[],
    confidence: 0.9,
    depth: 0
  }));
  for (const object of objectsWithLinks) {
    if (object.parentObjectId) {
      const parent = objectsWithLinks.find((o) => o.objectId === object.parentObjectId);
      if (parent) {
        parent.childObjectIds.push(object.objectId);
      }
    }
  }
  const hierarchy = { objects: objectsWithLinks };

  const fieldRelationships = buildFieldRelationships({
    fields: input.fieldBboxes.map((f) => ({
      fieldId: f.fieldId,
      bbox: f.rect
    })),
    borderRect: BORDER_RECT,
    refinedBorderRect: input.refinedRect,
    hierarchy
  });

  const pageAnchorRelations = buildPageAnchorRelations({
    hierarchy,
    refinedBorderRect: input.refinedRect,
    borderRect: BORDER_RECT
  });

  return {
    pageIndex: input.pageIndex,
    pageSurface: { pageIndex: input.pageIndex, surfaceWidth: 1000, surfaceHeight: 1000 },
    cvExecutionMode: 'heuristic-fallback',
    border: { rectNorm: { ...BORDER_RECT } },
    refinedBorder: {
      rectNorm: { ...input.refinedRect },
      cvContentRectNorm: { ...input.refinedRect },
      source: 'cv-content',
      influencedByBBoxCount: 0,
      containsAllSavedBBoxes: true
    },
    objectHierarchy: hierarchy,
    pageAnchorRelations,
    fieldRelationships
  };
};

export const configStructuralFixture = (): StructuralModel => {
  const refinedRect: StructuralNormalizedRect = {
    xNorm: 0.05,
    yNorm: 0.05,
    wNorm: 0.9,
    hNorm: 0.9
  };
  return {
    schema: 'wrokit/structural-model',
    version: '4.0',
    structureVersion: 'wrokit/structure/v3',
    id: 'config_1',
    documentFingerprint: 'sha256:config',
    cvAdapter: { name: 'opencv-js', version: '1.0' },
    pages: [
      buildPage({
        pageIndex: 0,
        objects: [
          { id: 'obj_panel', rect: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.7, hNorm: 0.6 } },
          {
            id: 'obj_cell',
            rect: { xNorm: 0.18, yNorm: 0.18, wNorm: 0.2, hNorm: 0.1 },
            parent: 'obj_panel'
          }
        ],
        fieldBboxes: [
          {
            fieldId: 'invoice_number',
            rect: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.15, hNorm: 0.05 }
          },
          {
            fieldId: 'invoice_date',
            rect: { xNorm: 0.5, yNorm: 0.2, wNorm: 0.18, hNorm: 0.05 }
          }
        ],
        refinedRect
      })
    ],
    createdAtIso: '2026-04-01T00:00:00Z'
  };
};

export const compatibilityFixture = (
  overrides: Partial<RefineCompatibilitySignature> = {}
): RefineCompatibilitySignature => ({
  wizardName: 'Test Wizard',
  wizardFieldCount: 2,
  wizardFieldSignature: 'a'.repeat(64),
  configStructuralPageCount: 1,
  configStructuralObjectIdSignature: 'b'.repeat(64),
  configRefinedBorderSignature: 'c'.repeat(64),
  pageSurfaceSignatures: [{ pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1000 }],
  geometryFieldIdSignature: 'd'.repeat(64),
  createdAtIso: '2026-04-01T00:00:00Z',
  ...overrides
});

export const populatedScalar = (input: {
  count: number;
  totalWeight?: number;
  mean: number;
  m2: number;
}): WelfordScalar => ({
  count: input.count,
  totalWeight: input.totalWeight ?? input.count,
  mean: input.mean,
  m2: input.m2
});

export const emptyScalar = (): WelfordScalar => ({
  count: 0,
  totalWeight: 0,
  mean: 0,
  m2: 0
});

export const emptyAffine = (): WelfordAffine => ({
  scaleX: emptyScalar(),
  scaleY: emptyScalar(),
  translateX: emptyScalar(),
  translateY: emptyScalar()
});

export const emptyRect = (): WelfordRect => ({
  xNorm: emptyScalar(),
  yNorm: emptyScalar(),
  wNorm: emptyScalar(),
  hNorm: emptyScalar()
});

export const objectAnalyticsFixture = (
  configObjectId: string,
  overrides: Partial<StructuralRefineAnalyticsObject> = {}
): StructuralRefineAnalyticsObject => ({
  configObjectId,
  appearanceCount: 0,
  matchConfidence: emptyScalar(),
  impliedAffine: emptyAffine(),
  projectionIou: emptyScalar(),
  outlierVsConsensusCount: 0,
  runtimePositionDrift: emptyRect(),
  anchorTierUsage: { A: 0, B: 0, C: 0 },
  anchorProjectionIou: { A: emptyScalar(), B: emptyScalar(), C: emptyScalar() },
  reliability: 0,
  ...overrides
});

export const pageAnalyticsFixture = (
  pageIndex: number,
  overrides: Partial<StructuralRefineAnalyticsPage> = {}
): StructuralRefineAnalyticsPage => ({
  pageIndex,
  pageSurface: { pageIndex, surfaceWidth: 1000, surfaceHeight: 1000 },
  consensusAffine: emptyAffine(),
  refinedBorderDelta: emptyAffine(),
  shiftDirection: { meanTx: 0, meanTy: 0, sampleCount: 0 },
  objects: [],
  objectPairs: [],
  fields: [],
  ...overrides
});

export const analyticsFixture = (
  overrides: Partial<StructuralRefineAnalytics> = {}
): StructuralRefineAnalytics => ({
  schema: 'wrokit/structural-refine-analytics',
  version: '1.0',
  refineVersion: 'wrokit/structural-refine/v1',
  id: 'an_1',
  compatibility: compatibilityFixture(),
  documentCount: 0,
  mergeHistory: [],
  pages: [pageAnalyticsFixture(0)],
  globals: {
    anchorTierGlobal: { A: 0, B: 0, C: 0, refined: 0, border: 0 },
    consensusConfidenceMean: 0
  },
  createdAtIso: '2026-04-01T00:00:00Z',
  updatedAtIso: '2026-04-01T00:00:00Z',
  ...overrides
});

const identityAffine = (): TransformationAffine => ({
  scaleX: 1,
  scaleY: 1,
  translateX: 0,
  translateY: 0
});

const buildTransformationPage = (input: {
  pageIndex: number;
  matches: Array<{
    configObjectId: string;
    runtimeObjectId: string;
    transform: TransformationAffine;
    confidence: number;
  }>;
  consensus: TransformationAffine | null;
  consensusConfidence: number;
  fields: Array<{ fieldId: string }>;
}): TransformationPage => ({
  pageIndex: input.pageIndex,
  levelSummaries: [
    {
      level: 'border',
      transform: null,
      confidence: 0,
      contributingMatchCount: 0,
      notes: [],
      warnings: []
    },
    {
      level: 'refined-border',
      transform: input.consensus ? { ...input.consensus } : null,
      confidence: input.consensusConfidence,
      contributingMatchCount: input.matches.length,
      notes: [],
      warnings: []
    },
    {
      level: 'object',
      transform: input.consensus ? { ...input.consensus } : null,
      confidence: input.consensusConfidence,
      contributingMatchCount: input.matches.length,
      notes: [],
      warnings: []
    },
    {
      level: 'parent-chain',
      transform: null,
      confidence: 0,
      contributingMatchCount: 0,
      notes: [],
      warnings: []
    }
  ],
  objectMatches: input.matches.map((m) => ({
    configObjectId: m.configObjectId,
    runtimeObjectId: m.runtimeObjectId,
    confidence: m.confidence,
    basis: ['object-similarity'],
    transform: { ...m.transform },
    notes: [],
    warnings: []
  })),
  unmatchedConfigObjectIds: [],
  unmatchedRuntimeObjectIds: [],
  consensus: {
    transform: input.consensus ? { ...input.consensus } : null,
    confidence: input.consensusConfidence,
    contributingMatchCount: input.matches.length,
    outliers: [],
    localTransforms: {},
    regionalTransforms: [],
    notes: [],
    warnings: []
  },
  fieldAlignments: input.fields.map((f) => ({
    fieldId: f.fieldId,
    candidates: [],
    warnings: []
  })),
  notes: [],
  warnings: []
});

export const transformationModelFixture = (input: {
  configObjectIds: string[];
  runtimeObjectIds: string[];
  matches: Array<{
    configObjectId: string;
    runtimeObjectId: string;
    transform?: TransformationAffine;
    confidence?: number;
  }>;
  consensus?: TransformationAffine | null;
}): TransformationModel => ({
  schema: 'wrokit/transformation-model',
  version: '1.0',
  transformVersion: 'wrokit/transformation/v1',
  id: 'xform_test',
  config: { id: 'config_1', documentFingerprint: 'sha256:config' },
  runtime: { id: 'runtime_1', documentFingerprint: 'sha256:runtime' },
  pages: [
    buildTransformationPage({
      pageIndex: 0,
      matches: input.matches.map((m) => ({
        configObjectId: m.configObjectId,
        runtimeObjectId: m.runtimeObjectId,
        transform: m.transform ?? identityAffine(),
        confidence: m.confidence ?? 0.9
      })),
      consensus: input.consensus === undefined ? identityAffine() : input.consensus,
      consensusConfidence: input.consensus === null ? 0 : 0.9,
      fields: []
    })
  ],
  overallConfidence: 0.9,
  notes: [],
  warnings: [],
  createdAtIso: '2026-04-01T00:00:00Z'
});

export const predictedGeometryFixture = (input: {
  fields: Array<{
    fieldId: string;
    bbox: StructuralNormalizedRect;
    anchorTier: 'field-object-a' | 'field-object-b' | 'field-object-c' | 'refined-border' | 'border' | 'page-consensus';
    matchedConfigObjectId?: string | null;
    matchedRuntimeObjectId?: string | null;
  }>;
}): PredictedGeometryFile => ({
  schema: 'wrokit/predicted-geometry-file',
  version: '1.0',
  geometryFileVersion: 'wrokit/geometry/v1',
  structureVersion: 'wrokit/structure/v3',
  id: 'pred_1',
  wizardId: 'Test Wizard',
  sourceGeometryFileId: 'geo_1',
  sourceStructuralModelId: 'config_1',
  runtimeDocumentFingerprint: 'sha256:runtime',
  predictedAtIso: '2026-04-01T00:00:00Z',
  fields: input.fields.map((f) => ({
    fieldId: f.fieldId,
    pageIndex: 0,
    bbox: f.bbox,
    pixelBbox: { x: 0, y: 0, width: 0, height: 0 },
    pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1000 },
    sourceGeometryConfirmedAtIso: '2026-01-01T00:00:00Z',
    sourceGeometryConfirmedBy: 'user',
    anchorTierUsed: f.anchorTier,
    transform:
      f.anchorTier === 'page-consensus'
        ? {
            pageIndex: 0,
            basis: 'page-consensus',
            scaleX: 1,
            scaleY: 1,
            translateX: 0,
            translateY: 0
          }
        : {
            pageIndex: 0,
            basis: f.anchorTier,
            sourceConfigRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.7, hNorm: 0.6 },
            sourceRuntimeRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.7, hNorm: 0.6 },
            scaleX: 1,
            scaleY: 1,
            translateX: 0,
            translateY: 0,
            configObjectId: f.matchedConfigObjectId ?? undefined,
            runtimeObjectId: f.matchedRuntimeObjectId ?? undefined
          }
  }))
});

export const buildSyntheticRuntimeStructure = (
  config: StructuralModel,
  drift: { dx: number; dy: number; dw?: number; dh?: number }
): StructuralModel => {
  const driftedPages = config.pages.map((page) =>
    buildPage({
      pageIndex: page.pageIndex,
      objects: page.objectHierarchy.objects.map((node) => ({
        id: node.objectId,
        rect: {
          xNorm: node.objectRectNorm.xNorm + drift.dx,
          yNorm: node.objectRectNorm.yNorm + drift.dy,
          wNorm: node.objectRectNorm.wNorm + (drift.dw ?? 0),
          hNorm: node.objectRectNorm.hNorm + (drift.dh ?? 0)
        },
        parent: node.parentObjectId
      })),
      fieldBboxes: page.fieldRelationships.map((field) => {
        const r = field.fieldAnchors.borderAnchor.relativeFieldRect;
        return {
          fieldId: field.fieldId,
          rect: { xNorm: r.xRatio, yNorm: r.yRatio, wNorm: r.wRatio, hNorm: r.hRatio }
        };
      }),
      refinedRect: page.refinedBorder.rectNorm
    })
  );
  return {
    ...config,
    id: 'runtime_1',
    documentFingerprint: 'sha256:runtime',
    pages: driftedPages
  };
};
