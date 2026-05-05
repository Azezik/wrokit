import { describe, expect, it } from 'vitest';

import {
  isStructuralRefineAnalytics,
  type StructuralRefineAnalytics
} from '../../src/core/contracts/structural-refine-analytics';
import {
  parseStructuralRefineAnalytics,
  serializeStructuralRefineAnalytics,
  StructuralRefineAnalyticsParseError
} from '../../src/core/io/structural-refine-analytics-io';

import { analyticsFixture, objectAnalyticsFixture, pageAnalyticsFixture } from './structural-refine-fixtures';

describe('isStructuralRefineAnalytics', () => {
  it('accepts a minimal valid analytics file', () => {
    expect(isStructuralRefineAnalytics(analyticsFixture())).toBe(true);
  });

  it('accepts an analytics file with populated pages', () => {
    const fixture = analyticsFixture({
      documentCount: 3,
      pages: [
        pageAnalyticsFixture(0, {
          objects: [
            objectAnalyticsFixture('obj_panel', { appearanceCount: 3, reliability: 0.7 })
          ]
        })
      ]
    });
    expect(isStructuralRefineAnalytics(fixture)).toBe(true);
  });

  it('rejects null and non-objects', () => {
    expect(isStructuralRefineAnalytics(null)).toBe(false);
    expect(isStructuralRefineAnalytics(undefined)).toBe(false);
    expect(isStructuralRefineAnalytics('hello')).toBe(false);
    expect(isStructuralRefineAnalytics(42)).toBe(false);
  });

  it('rejects wrong schema or version markers', () => {
    expect(
      isStructuralRefineAnalytics({ ...analyticsFixture(), schema: 'other' })
    ).toBe(false);
    expect(
      isStructuralRefineAnalytics({ ...analyticsFixture(), version: '0.9' })
    ).toBe(false);
    expect(
      isStructuralRefineAnalytics({
        ...analyticsFixture(),
        refineVersion: 'wrokit/structural-refine/v0'
      })
    ).toBe(false);
  });

  it('rejects when a Welford accumulator is missing a field', () => {
    const broken = analyticsFixture();
    // delete one of the four scalars on the affine
    (broken.pages[0].consensusAffine as unknown as Record<string, unknown>).scaleX = {
      count: 0,
      mean: 0,
      m2: 0
      // missing totalWeight
    };
    expect(isStructuralRefineAnalytics(broken)).toBe(false);
  });

  it('rejects when compatibility signature is malformed', () => {
    const broken = analyticsFixture();
    (broken.compatibility as unknown as Record<string, unknown>).pageSurfaceSignatures = 'oops';
    expect(isStructuralRefineAnalytics(broken)).toBe(false);
  });

  it('rejects when a histogram bucket is non-finite', () => {
    const broken = analyticsFixture();
    (broken.globals.anchorTierGlobal as Record<string, number>).A = Number.NaN;
    expect(isStructuralRefineAnalytics(broken)).toBe(false);
  });
});

describe('structural-refine-analytics-io', () => {
  const valid: StructuralRefineAnalytics = analyticsFixture({
    documentCount: 7,
    mergeHistory: [
      { batchId: 'batch_1', addedDocumentCount: 7, mergedAtIso: '2026-04-02T00:00:00Z' }
    ]
  });

  it('round-trips a valid analytics file through serialize/parse', () => {
    const text = serializeStructuralRefineAnalytics(valid);
    const parsed = parseStructuralRefineAnalytics(text);
    expect(parsed).toEqual(valid);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseStructuralRefineAnalytics('{not json')).toThrow(
      StructuralRefineAnalyticsParseError
    );
  });

  it('rejects JSON that fails the contract guard', () => {
    expect(() => parseStructuralRefineAnalytics(JSON.stringify({ schema: 'wrong' }))).toThrow(
      StructuralRefineAnalyticsParseError
    );
  });
});
