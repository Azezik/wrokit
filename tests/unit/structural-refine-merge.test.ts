import { describe, expect, it } from 'vitest';

import { isStructuralRefineAnalytics } from '../../src/core/contracts/structural-refine-analytics';
import {
  aggregatorStateToAnalytics,
  buildRefineCompatibilitySignature,
  createAggregator,
  extractEvidence,
  mergeAnalytics,
  StructuralRefineAnalyticsCompatibilityError
} from '../../src/core/engines/structural-refine';

import {
  buildSyntheticRuntimeStructure,
  configStructuralFixture,
  geometryFixture,
  predictedGeometryFixture,
  transformationModelFixture,
  wizardFixture
} from './structural-refine-fixtures';

const synthesizeDocAnalytics = async (input: {
  drift: { dx: number; dy: number };
  documentCount: number;
  batchId: string;
  matchConfidence?: number;
}) => {
  const config = configStructuralFixture();
  const wizard = wizardFixture();
  const geometry = geometryFixture();
  const compatibility = await buildRefineCompatibilitySignature({
    wizard,
    geometry,
    configStructural: config,
    nowIso: '2026-04-01T00:00:00Z'
  });
  const aggregator = createAggregator(config, { minPairCoOccurrence: 1 });

  for (let i = 0; i < input.documentCount; i += 1) {
    const runtime = buildSyntheticRuntimeStructure(config, input.drift);
    const transformation = transformationModelFixture({
      configObjectIds: ['obj_panel', 'obj_cell'],
      runtimeObjectIds: ['obj_panel', 'obj_cell'],
      matches: [
        {
          configObjectId: 'obj_panel',
          runtimeObjectId: 'obj_panel',
          confidence: input.matchConfidence ?? 0.92
        },
        {
          configObjectId: 'obj_cell',
          runtimeObjectId: 'obj_cell',
          confidence: input.matchConfidence ?? 0.88
        }
      ]
    });
    const predicted = predictedGeometryFixture({
      fields: [
        {
          fieldId: 'invoice_number',
          bbox: { xNorm: 0.2 + input.drift.dx, yNorm: 0.2 + input.drift.dy, wNorm: 0.15, hNorm: 0.05 },
          anchorTier: 'field-object-a',
          matchedConfigObjectId: 'obj_cell',
          matchedRuntimeObjectId: 'obj_cell'
        },
        {
          fieldId: 'invoice_date',
          bbox: { xNorm: 0.5 + input.drift.dx, yNorm: 0.2 + input.drift.dy, wNorm: 0.18, hNorm: 0.05 },
          anchorTier: 'field-object-b',
          matchedConfigObjectId: 'obj_panel',
          matchedRuntimeObjectId: 'obj_panel'
        }
      ]
    });

    const evidence = extractEvidence({
      runtimeStructure: runtime,
      transformationModel: transformation,
      predicted,
      configStructural: config,
      configGeometry: geometry
    });
    aggregator.observe(evidence);
  }

  return aggregatorStateToAnalytics({
    state: aggregator.snapshot(),
    compatibility,
    batchId: input.batchId,
    id: `an_${input.batchId}`,
    nowIso: '2026-04-02T00:00:00Z'
  });
};

const closeTo = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

const expectAnalyticsClose = (
  actual: ReturnType<typeof aggregatorStateToAnalytics>,
  expected: ReturnType<typeof aggregatorStateToAnalytics>
) => {
  expect(actual.documentCount).toBe(expected.documentCount);
  expect(actual.pages.length).toBe(expected.pages.length);
  for (let i = 0; i < actual.pages.length; i += 1) {
    const ap = actual.pages[i];
    const ep = expected.pages[i];
    expect(ap.objects.length).toBe(ep.objects.length);
    for (let j = 0; j < ap.objects.length; j += 1) {
      const ao = ap.objects[j];
      const eo = ep.objects[j];
      expect(ao.configObjectId).toBe(eo.configObjectId);
      expect(ao.appearanceCount).toBe(eo.appearanceCount);
      expect(ao.outlierVsConsensusCount).toBe(eo.outlierVsConsensusCount);
      // Welford merge produces the same mean and m2 (within float epsilon).
      expect(closeTo(ao.matchConfidence.mean, eo.matchConfidence.mean, 1e-9)).toBe(true);
      expect(closeTo(ao.matchConfidence.m2, eo.matchConfidence.m2, 1e-9)).toBe(true);
      expect(closeTo(ao.runtimePositionDrift.xNorm.mean, eo.runtimePositionDrift.xNorm.mean, 1e-9)).toBe(true);
      expect(closeTo(ao.runtimePositionDrift.xNorm.m2, eo.runtimePositionDrift.xNorm.m2, 1e-9)).toBe(true);
      expect(closeTo(ao.runtimePositionDrift.yNorm.mean, eo.runtimePositionDrift.yNorm.mean, 1e-9)).toBe(true);
      expect(closeTo(ao.runtimePositionDrift.yNorm.m2, eo.runtimePositionDrift.yNorm.m2, 1e-9)).toBe(true);
      expect(closeTo(ao.reliability, eo.reliability, 1e-9)).toBe(true);
    }
  }
  expect(actual.globals.anchorTierGlobal).toEqual(expected.globals.anchorTierGlobal);
};

describe('mergeAnalytics — Welford parallel merge correctness', () => {
  it('produces a guard-passing artifact', async () => {
    const a = await synthesizeDocAnalytics({
      drift: { dx: 0.01, dy: -0.005 },
      documentCount: 4,
      batchId: 'b_a',
      matchConfidence: 0.9
    });
    const b = await synthesizeDocAnalytics({
      drift: { dx: 0.02, dy: 0.01 },
      documentCount: 6,
      batchId: 'b_b',
      matchConfidence: 0.85
    });
    const merged = mergeAnalytics(a, b, { id: 'an_merged', nowIso: '2026-04-03T00:00:00Z' });
    expect(isStructuralRefineAnalytics(merged)).toBe(true);
    expect(merged.documentCount).toBe(10);
    expect(merged.mergeHistory.length).toBe(2);
  });

  it('matches the one-shot 60-doc analytics: 10 + 50 ≡ 60', async () => {
    const fewDocs = 10;
    const moreDocs = 50;

    const tenDocs = await synthesizeDocAnalytics({
      drift: { dx: 0.01, dy: -0.002 },
      documentCount: fewDocs,
      batchId: 'b_ten',
      matchConfidence: 0.9
    });
    const fiftyDocs = await synthesizeDocAnalytics({
      drift: { dx: 0.01, dy: -0.002 },
      documentCount: moreDocs,
      batchId: 'b_fifty',
      matchConfidence: 0.9
    });
    const merged = mergeAnalytics(tenDocs, fiftyDocs, {
      id: 'an_merged',
      nowIso: '2026-04-03T00:00:00Z'
    });

    const oneShot = await synthesizeDocAnalytics({
      drift: { dx: 0.01, dy: -0.002 },
      documentCount: fewDocs + moreDocs,
      batchId: 'b_oneshot',
      matchConfidence: 0.9
    });

    expectAnalyticsClose(merged, oneShot);
  });

  it('is associative: mergeAnalytics(A, mergeAnalytics(B, C)) ≡ mergeAnalytics(mergeAnalytics(A, B), C)', async () => {
    const a = await synthesizeDocAnalytics({
      drift: { dx: 0.01, dy: 0.0 },
      documentCount: 3,
      batchId: 'b_a',
      matchConfidence: 0.92
    });
    const b = await synthesizeDocAnalytics({
      drift: { dx: 0.02, dy: 0.01 },
      documentCount: 5,
      batchId: 'b_b',
      matchConfidence: 0.85
    });
    const c = await synthesizeDocAnalytics({
      drift: { dx: -0.01, dy: 0.005 },
      documentCount: 7,
      batchId: 'b_c',
      matchConfidence: 0.78
    });

    const left = mergeAnalytics(a, mergeAnalytics(b, c, { id: 'bc', nowIso: '2026-04-03T00:00:00Z' }), {
      id: 'a_bc',
      nowIso: '2026-04-04T00:00:00Z'
    });
    const right = mergeAnalytics(
      mergeAnalytics(a, b, { id: 'ab', nowIso: '2026-04-03T00:00:00Z' }),
      c,
      { id: 'ab_c', nowIso: '2026-04-04T00:00:00Z' }
    );

    expectAnalyticsClose(left, right);
  });

  it('rejects merging analytics produced from incompatible configs', async () => {
    const a = await synthesizeDocAnalytics({
      drift: { dx: 0.01, dy: 0.0 },
      documentCount: 2,
      batchId: 'b_a'
    });
    const b = await synthesizeDocAnalytics({
      drift: { dx: 0.01, dy: 0.0 },
      documentCount: 2,
      batchId: 'b_b'
    });
    // Tamper with the compatibility signature on `b` so the wizard fields
    // disagree.
    b.compatibility.wizardFieldSignature = '0'.repeat(64);
    expect(() =>
      mergeAnalytics(a, b, { id: 'an_merged', nowIso: '2026-04-03T00:00:00Z' })
    ).toThrow(StructuralRefineAnalyticsCompatibilityError);
  });
});
