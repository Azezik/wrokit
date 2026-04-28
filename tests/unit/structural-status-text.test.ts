import { describe, expect, it } from 'vitest';

import type { StructuralModel, StructuralPage } from '../../src/core/contracts/structural-model';
import type { TransformationModel } from '../../src/core/contracts/transformation-model';
import type { OpenCvRuntimeLoadResult } from '../../src/core/engines/structure';
import { buildStructuralStatusText } from '../../src/core/page-surface/ui/structural-status-text';

const stubStructuralModel = (
  overrides: Partial<StructuralModel> = {}
): StructuralModel => ({
  schema: 'wrokit/structural-model',
  version: '3.0',
  structureVersion: 'wrokit/structure/v2',
  id: 'sm-test',
  documentFingerprint: 'surface:test.pdf#0:1000x1000',
  cvAdapter: { name: 'opencv-js', version: '1.0' },
  pages: [],
  createdAtIso: '2026-04-28T00:00:00.000Z',
  ...overrides
});

const stubStructuralPage = (
  overrides: Partial<StructuralPage> = {}
): StructuralPage =>
  ({
    pageIndex: 0,
    cvExecutionMode: 'opencv-runtime',
    ...overrides
  } as StructuralPage);

const runtimeLoaded: OpenCvRuntimeLoadResult = { status: 'loaded' };
const runtimeUnavailable: OpenCvRuntimeLoadResult = {
  status: 'unavailable',
  reason: 'no global cv'
};

const stubTransformationModel = (
  overallConfidence: number
): TransformationModel =>
  ({
    overallConfidence
  } as unknown as TransformationModel);

describe('buildStructuralStatusText', () => {
  it('returns the empty label when no pages and no model are loaded', () => {
    const text = buildStructuralStatusText({
      structuralModel: null,
      structuralPage: null,
      runtimeLoadStatus: null,
      hasNormalizedPages: false
    });
    expect(text).toBe('No NormalizedPage loaded.');
  });

  it('returns the pending label when pages are loaded but no model exists yet', () => {
    const text = buildStructuralStatusText({
      structuralModel: null,
      structuralPage: null,
      runtimeLoadStatus: null,
      hasNormalizedPages: true
    });
    expect(text).toBe('StructuralModel pending.');
  });

  it('returns the computing label while a structural compute is in flight', () => {
    const text = buildStructuralStatusText({
      isComputing: true,
      structuralModel: null,
      structuralPage: null,
      runtimeLoadStatus: null,
      hasNormalizedPages: true
    });
    expect(text).toBe('Computing StructuralModel…');
  });

  it('honors callback overrides for empty / pending / computing labels', () => {
    expect(
      buildStructuralStatusText({
        isComputing: true,
        structuralModel: null,
        structuralPage: null,
        runtimeLoadStatus: null,
        hasNormalizedPages: true,
        computingLabel: 'Building runtime structure + predictions…'
      })
    ).toBe('Building runtime structure + predictions…');

    expect(
      buildStructuralStatusText({
        structuralModel: null,
        structuralPage: null,
        runtimeLoadStatus: null,
        hasNormalizedPages: true,
        pendingLabel: 'No runtime structure yet.'
      })
    ).toBe('No runtime structure yet.');

    expect(
      buildStructuralStatusText({
        structuralModel: null,
        structuralPage: null,
        runtimeLoadStatus: null,
        hasNormalizedPages: false,
        emptyLabel: 'No runtime structure yet.'
      })
    ).toBe('No runtime structure yet.');
  });

  it('describes an active structural model with adapter name + version + page CV mode', () => {
    const text = buildStructuralStatusText({
      structuralModel: stubStructuralModel({
        pages: [stubStructuralPage(), stubStructuralPage({ pageIndex: 1 })]
      }),
      structuralPage: stubStructuralPage({ cvExecutionMode: 'heuristic-fallback' }),
      runtimeLoadStatus: null,
      hasNormalizedPages: true
    });
    expect(text).toBe(
      'Structural: opencv-js v1.0 · 2 page(s) · page CV heuristic-fallback'
    );
  });

  it('appends the OpenCV runtime status (with reason when present)', () => {
    expect(
      buildStructuralStatusText({
        structuralModel: stubStructuralModel({ pages: [stubStructuralPage()] }),
        structuralPage: stubStructuralPage(),
        runtimeLoadStatus: runtimeLoaded,
        hasNormalizedPages: true
      })
    ).toBe(
      'Structural: opencv-js v1.0 · 1 page(s) · page CV opencv-runtime · OpenCV runtime loaded'
    );

    expect(
      buildStructuralStatusText({
        structuralModel: stubStructuralModel({ pages: [stubStructuralPage()] }),
        structuralPage: stubStructuralPage(),
        runtimeLoadStatus: runtimeUnavailable,
        hasNormalizedPages: true
      })
    ).toBe(
      'Structural: opencv-js v1.0 · 1 page(s) · page CV opencv-runtime · OpenCV runtime unavailable (no global cv)'
    );
  });

  it('appends transformation overall confidence when a transformation model is provided', () => {
    const text = buildStructuralStatusText({
      structuralModel: stubStructuralModel({ pages: [stubStructuralPage()] }),
      structuralPage: stubStructuralPage(),
      runtimeLoadStatus: runtimeLoaded,
      hasNormalizedPages: true,
      transformationModel: stubTransformationModel(0.873)
    });
    expect(text).toBe(
      'Structural: opencv-js v1.0 · 1 page(s) · page CV opencv-runtime · OpenCV runtime loaded · TransformationModel · overall confidence 0.873'
    );
  });

  it('falls back to "n/a" when no structural page is selected', () => {
    const text = buildStructuralStatusText({
      structuralModel: stubStructuralModel({ pages: [stubStructuralPage()] }),
      structuralPage: null,
      runtimeLoadStatus: null,
      hasNormalizedPages: true
    });
    expect(text).toBe('Structural: opencv-js v1.0 · 1 page(s) · page CV n/a');
  });
});
