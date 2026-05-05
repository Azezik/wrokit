/**
 * Structural Refine end-to-end integration test.
 *
 * Exercises the full Phase 1+2 pipeline with synthetic fixtures:
 *   1. 5-document batch → analytics + refinedModel.
 *   2. RefinedModel re-used as config in a second 3-document batch (verifying
 *      plug-and-play parity with a plain StructuralModel).
 *   3. Field BBOX byte-parity: the refined model's field BBOXes are identical
 *      to the originals, confirming geometry truth is sacred end-to-end.
 *   4. Incremental merge: a prior analytics file is folded in by the runner,
 *      and the merged document count is the arithmetic sum.
 *
 * No real PDFs, no real OCR, no real CV — purely synthetic evidence so the
 * test suite stays deterministic and fast.
 */
import { describe, expect, it } from 'vitest';

import { isStructuralModel } from '../../src/core/contracts/structural-model';
import { isStructuralRefineAnalytics } from '../../src/core/contracts/structural-refine-analytics';
import { aggregatorStateToAnalytics } from '../../src/core/engines/structural-refine/merge-analytics';
import { createAggregator } from '../../src/core/engines/structural-refine/aggregator';
import { extractEvidence } from '../../src/core/engines/structural-refine/evidence';
import {
  parseStructuralRefineAnalytics,
  serializeStructuralRefineAnalytics
} from '../../src/core/io/structural-refine-analytics-io';
import {
  parseStructuralModel,
  serializeStructuralModel
} from '../../src/core/io/structural-model-io';
import {
  createStructuralRefineRunner
} from '../../src/core/runtime/structural-refine-runner';
import {
  buildSyntheticRuntimeStructure,
  compatibilityFixture,
  configStructuralFixture,
  geometryFixture,
  predictedGeometryFixture,
  transformationModelFixture,
  wizardFixture
} from '../unit/structural-refine-fixtures';

const buildSyntheticObservation = (configStructural: ReturnType<typeof configStructuralFixture>, driftDx = 0.01) => {
  const runtime = buildSyntheticRuntimeStructure(configStructural, { dx: driftDx, dy: 0.005 });
  const transformation = transformationModelFixture({
    configObjectIds: ['obj_panel', 'obj_cell'],
    runtimeObjectIds: ['obj_panel', 'obj_cell'],
    matches: [
      { configObjectId: 'obj_panel', runtimeObjectId: 'obj_panel' },
      { configObjectId: 'obj_cell', runtimeObjectId: 'obj_cell' }
    ]
  });
  const predicted = predictedGeometryFixture({
    fields: [
      {
        fieldId: 'invoice_number',
        bbox: { xNorm: 0.2 + driftDx, yNorm: 0.2, wNorm: 0.15, hNorm: 0.05 },
        anchorTier: 'field-object-a',
        matchedConfigObjectId: 'obj_cell',
        matchedRuntimeObjectId: 'obj_cell'
      },
      {
        fieldId: 'invoice_date',
        bbox: { xNorm: 0.5 + driftDx, yNorm: 0.2, wNorm: 0.18, hNorm: 0.05 },
        anchorTier: 'field-object-b',
        matchedConfigObjectId: 'obj_panel',
        matchedRuntimeObjectId: 'obj_panel'
      }
    ]
  });
  return { runtimeStructure: runtime, transformationModel: transformation, predicted };
};

describe('structural-refine end-to-end', () => {
  it('5-document batch produces valid analytics and refined model', async () => {
    const wizard = wizardFixture();
    const geometry = geometryFixture();
    const configStructural = configStructuralFixture();

    const runner = createStructuralRefineRunner({
      wizard,
      geometry,
      configStructural,
      priorAnalytics: null
    });

    for (let i = 0; i < 5; i += 1) {
      runner.observe(buildSyntheticObservation(configStructural, 0.005 * i));
    }

    const { analytics, refinedModel } = await runner.finalize({ batchId: 'e2e-batch-1' });

    expect(analytics.documentCount).toBe(5);
    expect(isStructuralRefineAnalytics(analytics)).toBe(true);
    expect(analytics.mergeHistory).toHaveLength(1);
    expect(analytics.mergeHistory[0].addedDocumentCount).toBe(5);

    expect(isStructuralModel(refinedModel)).toBe(true);
    expect(refinedModel.cvAdapter.name).toBe('structural-refine');
    expect(refinedModel.documentFingerprint).toMatch(/^refined:/);
    expect(refinedModel.pages).toHaveLength(1);
  });

  it('refined model round-trips through structural-model-io', async () => {
    const wizard = wizardFixture();
    const geometry = geometryFixture();
    const configStructural = configStructuralFixture();
    const runner = createStructuralRefineRunner({ wizard, geometry, configStructural, priorAnalytics: null });

    runner.observe(buildSyntheticObservation(configStructural));

    const { refinedModel } = await runner.finalize({ batchId: 'e2e-roundtrip' });

    const serialized = serializeStructuralModel(refinedModel);
    const reparsed = parseStructuralModel(serialized);

    expect(isStructuralModel(reparsed)).toBe(true);
    expect(reparsed.id).toBe(refinedModel.id);
    expect(reparsed.pages[0].objectHierarchy.objects.map((o) => o.objectId))
      .toEqual(refinedModel.pages[0].objectHierarchy.objects.map((o) => o.objectId));
  });

  it('refined model is usable as config in a second batch (plug-and-play)', async () => {
    const wizard = wizardFixture();
    const geometry = geometryFixture();
    const configStructural = configStructuralFixture();

    // Batch 1: 5 documents against the original config
    const runner1 = createStructuralRefineRunner({
      wizard, geometry, configStructural, priorAnalytics: null
    });
    for (let i = 0; i < 5; i += 1) {
      runner1.observe(buildSyntheticObservation(configStructural));
    }
    const { refinedModel } = await runner1.finalize({ batchId: 'e2e-batch-2a' });

    // Batch 2: 3 documents against the refined model as config
    const runner2 = createStructuralRefineRunner({
      wizard,
      geometry,
      configStructural: refinedModel,
      priorAnalytics: null
    });

    const runtime2 = buildSyntheticRuntimeStructure(refinedModel, { dx: 0.005, dy: 0 });
    // Build a transformation against the refined model's object IDs
    const objectIds = refinedModel.pages[0].objectHierarchy.objects.map((o) => o.objectId);
    const transformation2 = transformationModelFixture({
      configObjectIds: objectIds,
      runtimeObjectIds: objectIds,
      matches: objectIds.map((id) => ({ configObjectId: id, runtimeObjectId: id }))
    });
    const predicted2 = predictedGeometryFixture({
      fields: [
        {
          fieldId: 'invoice_number',
          bbox: { xNorm: 0.205, yNorm: 0.2, wNorm: 0.15, hNorm: 0.05 },
          anchorTier: 'field-object-a',
          matchedConfigObjectId: objectIds[0] ?? null,
          matchedRuntimeObjectId: objectIds[0] ?? null
        },
        {
          fieldId: 'invoice_date',
          bbox: { xNorm: 0.505, yNorm: 0.2, wNorm: 0.18, hNorm: 0.05 },
          anchorTier: 'field-object-b',
          matchedConfigObjectId: objectIds[1] ?? null,
          matchedRuntimeObjectId: objectIds[1] ?? null
        }
      ]
    });

    for (let i = 0; i < 3; i += 1) {
      runner2.observe({
        runtimeStructure: runtime2,
        transformationModel: transformation2,
        predicted: predicted2
      });
    }

    const { analytics: analytics2, refinedModel: refinedModel2 } =
      await runner2.finalize({ batchId: 'e2e-batch-2b' });

    expect(analytics2.documentCount).toBe(3);
    expect(isStructuralModel(refinedModel2)).toBe(true);
    // Object IDs must survive through the second refinement
    const ids2 = refinedModel2.pages[0].objectHierarchy.objects.map((o) => o.objectId);
    expect(ids2).toEqual(objectIds);
  });

  it('field BBOX geometry is byte-identical to the config — geometry truth is sacred', async () => {
    const wizard = wizardFixture();
    const geometry = geometryFixture();
    const configStructural = configStructuralFixture();

    const runner = createStructuralRefineRunner({
      wizard, geometry, configStructural, priorAnalytics: null
    });

    for (let i = 0; i < 10; i += 1) {
      // Deliberately vary drift so object rects shift, but saved field BBOXes must NOT
      runner.observe(buildSyntheticObservation(configStructural, 0.02 * i));
    }

    const { refinedModel } = await runner.finalize({ batchId: 'e2e-bbox-parity' });

    // Extract field BBOXes from config and refined model via borderAnchor.relativeFieldRect
    const configFieldBboxes = configStructural.pages[0].fieldRelationships.map((field) => {
      const r = field.fieldAnchors.borderAnchor.relativeFieldRect;
      return { fieldId: field.fieldId, xNorm: r.xRatio, yNorm: r.yRatio, wNorm: r.wRatio, hNorm: r.hRatio };
    });
    const refinedFieldBboxes = refinedModel.pages[0].fieldRelationships.map((field) => {
      const r = field.fieldAnchors.borderAnchor.relativeFieldRect;
      return { fieldId: field.fieldId, xNorm: r.xRatio, yNorm: r.yRatio, wNorm: r.wRatio, hNorm: r.hRatio };
    });

    expect(refinedFieldBboxes).toEqual(configFieldBboxes);
  });

  it('analytics round-trips through structural-refine-analytics-io', async () => {
    const wizard = wizardFixture();
    const geometry = geometryFixture();
    const configStructural = configStructuralFixture();
    const runner = createStructuralRefineRunner({ wizard, geometry, configStructural, priorAnalytics: null });

    runner.observe(buildSyntheticObservation(configStructural));
    const { analytics } = await runner.finalize({ batchId: 'e2e-io-roundtrip' });

    const serialized = serializeStructuralRefineAnalytics(analytics);
    const reparsed = parseStructuralRefineAnalytics(serialized);

    expect(isStructuralRefineAnalytics(reparsed)).toBe(true);
    expect(reparsed.documentCount).toBe(analytics.documentCount);
    expect(reparsed.id).toBe(analytics.id);
  });

  it('incremental accumulation: two separate runners sum to the same document count', async () => {
    const wizard = wizardFixture();
    const geometry = geometryFixture();
    const configStructural = configStructuralFixture();

    // Runner A: 4 documents
    const runnerA = createStructuralRefineRunner({ wizard, geometry, configStructural, priorAnalytics: null });
    for (let i = 0; i < 4; i += 1) {
      runnerA.observe(buildSyntheticObservation(configStructural));
    }
    const { analytics: analyticsA } = await runnerA.finalize({ batchId: 'e2e-incremental-a' });

    // Runner B: 6 documents using analyticsA as prior
    const runnerB = createStructuralRefineRunner({
      wizard, geometry, configStructural, priorAnalytics: analyticsA
    });
    for (let i = 0; i < 6; i += 1) {
      runnerB.observe(buildSyntheticObservation(configStructural));
    }
    const { analytics: analyticsAB } = await runnerB.finalize({ batchId: 'e2e-incremental-b' });

    expect(analyticsAB.documentCount).toBe(10);
    expect(analyticsAB.mergeHistory).toHaveLength(2);
    expect(isStructuralRefineAnalytics(analyticsAB)).toBe(true);
  });
});
