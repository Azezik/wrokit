import { describe, expect, it } from 'vitest';

import { isStructuralModel } from '../../src/core/contracts/structural-model';
import {
  parseStructuralModel,
  serializeStructuralModel
} from '../../src/core/io/structural-model-io';
import {
  composeRefinedStructuralModel
} from '../../src/core/engines/structural-refine';

import {
  analyticsFixture,
  configStructuralFixture,
  emptyAffine,
  emptyRect,
  emptyScalar,
  objectAnalyticsFixture,
  pageAnalyticsFixture,
  populatedScalar
} from './structural-refine-fixtures';

const buildAnalyticsForConfig = () => {
  const config = configStructuralFixture();

  return analyticsFixture({
    documentCount: 4,
    pages: [
      pageAnalyticsFixture(0, {
        consensusAffine: emptyAffine(),
        refinedBorderDelta: emptyAffine(),
        objects: [
          objectAnalyticsFixture('obj_panel', {
            appearanceCount: 4,
            matchConfidence: populatedScalar({ count: 4, mean: 0.9, m2: 0.001 }),
            projectionIou: populatedScalar({ count: 4, mean: 0.95, m2: 0.0005 }),
            runtimePositionDrift: {
              xNorm: populatedScalar({ count: 4, mean: 0.01, m2: 0.0001 }),
              yNorm: populatedScalar({ count: 4, mean: -0.005, m2: 0.0001 }),
              wNorm: emptyScalar(),
              hNorm: emptyScalar()
            },
            anchorTierUsage: { A: 1, B: 0, C: 0 },
            anchorProjectionIou: { A: emptyScalar(), B: emptyScalar(), C: emptyScalar() },
            reliability: 0.78
          }),
          objectAnalyticsFixture('obj_cell', {
            appearanceCount: 4,
            matchConfidence: populatedScalar({ count: 4, mean: 0.85, m2: 0.001 }),
            projectionIou: populatedScalar({ count: 4, mean: 0.92, m2: 0.0005 }),
            runtimePositionDrift: {
              xNorm: populatedScalar({ count: 4, mean: 0.01, m2: 0.0001 }),
              yNorm: populatedScalar({ count: 4, mean: -0.005, m2: 0.0001 }),
              wNorm: emptyScalar(),
              hNorm: emptyScalar()
            },
            anchorTierUsage: { A: 4, B: 0, C: 0 },
            anchorProjectionIou: { A: emptyScalar(), B: emptyScalar(), C: emptyScalar() },
            reliability: 0.82
          })
        ],
        objectPairs: [],
        fields: []
      })
    ]
  });
};

describe('composeRefinedStructuralModel', () => {
  it('produces a model that passes isStructuralModel', () => {
    const config = configStructuralFixture();
    const analytics = buildAnalyticsForConfig();
    const refined = composeRefinedStructuralModel(analytics, config, {
      nowIso: '2026-04-15T00:00:00Z'
    });
    expect(isStructuralModel(refined)).toBe(true);
  });

  it('preserves the config object IDs in the same order', () => {
    const config = configStructuralFixture();
    const analytics = buildAnalyticsForConfig();
    const refined = composeRefinedStructuralModel(analytics, config);
    expect(refined.pages[0].objectHierarchy.objects.map((o) => o.objectId)).toEqual(
      config.pages[0].objectHierarchy.objects.map((o) => o.objectId)
    );
  });

  it('preserves parent/child links from the config', () => {
    const config = configStructuralFixture();
    const analytics = buildAnalyticsForConfig();
    const refined = composeRefinedStructuralModel(analytics, config);

    const cellNode = refined.pages[0].objectHierarchy.objects.find((o) => o.objectId === 'obj_cell');
    const panelNode = refined.pages[0].objectHierarchy.objects.find((o) => o.objectId === 'obj_panel');
    expect(cellNode?.parentObjectId).toBe('obj_panel');
    expect(panelNode?.childObjectIds).toContain('obj_cell');
  });

  it('shifts each refined object rect by the analytics drift mean', () => {
    const config = configStructuralFixture();
    const analytics = buildAnalyticsForConfig();
    const refined = composeRefinedStructuralModel(analytics, config);

    const refinedPanel = refined.pages[0].objectHierarchy.objects.find(
      (o) => o.objectId === 'obj_panel'
    )!;
    const configPanel = config.pages[0].objectHierarchy.objects.find(
      (o) => o.objectId === 'obj_panel'
    )!;
    expect(refinedPanel.objectRectNorm.xNorm).toBeCloseTo(configPanel.objectRectNorm.xNorm + 0.01, 9);
    expect(refinedPanel.objectRectNorm.yNorm).toBeCloseTo(configPanel.objectRectNorm.yNorm - 0.005, 9);
  });

  it('keeps every saved field BBOX byte-identical to the config', () => {
    const config = configStructuralFixture();
    const analytics = buildAnalyticsForConfig();
    const refined = composeRefinedStructuralModel(analytics, config);

    const configFieldsById = new Map(
      config.pages[0].fieldRelationships.map((field) => [field.fieldId, field])
    );
    for (const refinedField of refined.pages[0].fieldRelationships) {
      const configField = configFieldsById.get(refinedField.fieldId)!;
      // borderAnchor.relativeFieldRect = (field bbox), and border = {0,0,1,1} in
      // both config and refined, so equality of this rect is equality of the
      // saved BBOX itself.
      expect(refinedField.fieldAnchors.borderAnchor.relativeFieldRect).toEqual(
        configField.fieldAnchors.borderAnchor.relativeFieldRect
      );
    }
  });

  it('contains every saved field BBOX inside refinedBorder.rectNorm', () => {
    const config = configStructuralFixture();
    const analytics = buildAnalyticsForConfig();
    const refined = composeRefinedStructuralModel(analytics, config);

    const refinedBorderRect = refined.pages[0].refinedBorder.rectNorm;
    expect(refined.pages[0].refinedBorder.containsAllSavedBBoxes).toBe(true);
    for (const field of refined.pages[0].fieldRelationships) {
      const r = field.fieldAnchors.borderAnchor.relativeFieldRect;
      const eps = 1e-9;
      expect(r.xRatio + eps >= refinedBorderRect.xNorm).toBe(true);
      expect(r.yRatio + eps >= refinedBorderRect.yNorm).toBe(true);
      expect(r.xRatio + r.wRatio).toBeLessThanOrEqual(
        refinedBorderRect.xNorm + refinedBorderRect.wNorm + eps
      );
      expect(r.yRatio + r.hRatio).toBeLessThanOrEqual(
        refinedBorderRect.yNorm + refinedBorderRect.hNorm + eps
      );
    }
  });

  it('round-trips the refined model through structural-model-io', () => {
    const config = configStructuralFixture();
    const analytics = buildAnalyticsForConfig();
    const refined = composeRefinedStructuralModel(analytics, config, {
      nowIso: '2026-04-15T00:00:00Z'
    });

    const serialized = serializeStructuralModel(refined);
    const parsed = parseStructuralModel(serialized);
    expect(parsed).toEqual(refined);
  });

  it('does not mutate the input config StructuralModel', () => {
    const config = configStructuralFixture();
    const analytics = buildAnalyticsForConfig();
    const before = JSON.parse(JSON.stringify(config));
    composeRefinedStructuralModel(analytics, config);
    expect(config).toEqual(before);
  });

  it('keeps the cvAdapter honest (refine provenance) and tags the refined documentFingerprint', () => {
    const config = configStructuralFixture();
    const analytics = buildAnalyticsForConfig();
    const refined = composeRefinedStructuralModel(analytics, config);

    expect(refined.cvAdapter).toEqual({ name: 'structural-refine', version: '1.0' });
    expect(refined.documentFingerprint).toBe(`refined:${analytics.id}`);
  });

  it('preserves config rect for objects with no observations and floors confidence', () => {
    const config = configStructuralFixture();
    const analytics = analyticsFixture({
      documentCount: 4,
      pages: [
        pageAnalyticsFixture(0, {
          objects: [
            objectAnalyticsFixture('obj_panel', {
              appearanceCount: 0,
              reliability: 0
            }),
            objectAnalyticsFixture('obj_cell', {
              appearanceCount: 0,
              reliability: 0
            })
          ]
        })
      ]
    });
    const refined = composeRefinedStructuralModel(analytics, config);
    const configCell = config.pages[0].objectHierarchy.objects.find((o) => o.objectId === 'obj_cell')!;
    const refinedCell = refined.pages[0].objectHierarchy.objects.find((o) => o.objectId === 'obj_cell')!;
    expect(refinedCell.objectRectNorm).toEqual(configCell.objectRectNorm);
    expect(refinedCell.confidence).toBeLessThanOrEqual(0.05);
  });

  it('uses cv-and-bbox-union as the source when fields are present on the page', () => {
    const config = configStructuralFixture();
    const analytics = buildAnalyticsForConfig();
    const refined = composeRefinedStructuralModel(analytics, config);
    expect(refined.pages[0].refinedBorder.source).toBe('cv-and-bbox-union');
    expect(refined.pages[0].refinedBorder.influencedByBBoxCount).toBe(
      config.pages[0].fieldRelationships.length
    );
  });
});
