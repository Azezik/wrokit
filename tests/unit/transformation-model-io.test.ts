import { describe, expect, it } from 'vitest';

import type { StructuralModel } from '../../src/core/contracts/structural-model';
import {
  createEmptyTransformationModel,
  isTransformationModel,
  type TransformationModel
} from '../../src/core/contracts/transformation-model';
import {
  parseTransformationModel,
  serializeTransformationModel,
  TransformationModelParseError,
  transformationModelDownloadName
} from '../../src/core/io/transformation-model-io';
import { createTransformationRunner } from '../../src/core/runtime/transformation-runner';

const buildStructuralModel = (overrides: {
  id: string;
  documentFingerprint: string;
}): StructuralModel => ({
  schema: 'wrokit/structural-model',
  version: '3.0',
  structureVersion: 'wrokit/structure/v2',
  id: overrides.id,
  documentFingerprint: overrides.documentFingerprint,
  cvAdapter: { name: 'opencv-js', version: '1.0' },
  pages: [
    {
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
            objectId: 'obj_1',
            type: 'container',
            objectRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
            bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
            parentObjectId: null,
            childObjectIds: [],
            confidence: 0.9
          }
        ]
      },
      pageAnchorRelations: {
        objectToObject: [],
        objectToRefinedBorder: [
          {
            objectId: 'obj_1',
            relativeRect: {
              xRatio: 0.0555555556,
              yRatio: 0.0555555556,
              wRatio: 0.8888888889,
              hRatio: 0.8888888889
            }
          }
        ],
        refinedBorderToBorder: {
          relativeRect: { xRatio: 0.05, yRatio: 0.05, wRatio: 0.9, hRatio: 0.9 }
        }
      },
      fieldRelationships: []
    }
  ],
  createdAtIso: '2026-04-26T00:00:00Z'
});

const configModel = buildStructuralModel({
  id: 'str_config',
  documentFingerprint: 'surface:config.pdf#0:1000x2000'
});

const runtimeModel = buildStructuralModel({
  id: 'str_runtime',
  documentFingerprint: 'surface:runtime.pdf#0:1000x2000'
});

const validModel: TransformationModel = createEmptyTransformationModel({
  id: 'xform_abc',
  config: configModel,
  runtime: runtimeModel,
  createdAtIso: '2026-04-27T00:00:00Z'
});

describe('transformation-model contract', () => {
  it('createEmptyTransformationModel produces a valid model', () => {
    expect(isTransformationModel(validModel)).toBe(true);
  });

  it('seeds unmatchedConfigObjectIds with every config object on each page', () => {
    expect(validModel.pages[0].unmatchedConfigObjectIds).toEqual(['obj_1']);
    expect(validModel.pages[0].unmatchedRuntimeObjectIds).toEqual([]);
  });

  it('seeds the four base level summaries with null transforms', () => {
    const levels = validModel.pages[0].levelSummaries.map((l) => l.level);
    expect(levels).toEqual(['border', 'refined-border', 'object', 'parent-chain']);
    expect(validModel.pages[0].levelSummaries.every((l) => l.transform === null)).toBe(true);
  });

  it('references both source models without copying their full contents', () => {
    expect(validModel.config).toEqual({
      id: 'str_config',
      documentFingerprint: 'surface:config.pdf#0:1000x2000'
    });
    expect(validModel.runtime).toEqual({
      id: 'str_runtime',
      documentFingerprint: 'surface:runtime.pdf#0:1000x2000'
    });
  });
});

describe('transformation-model-io', () => {
  it('round-trips a TransformationModel through serialize/parse', () => {
    const text = serializeTransformationModel(validModel);
    const parsed = parseTransformationModel(text);
    expect(parsed).toEqual(validModel);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseTransformationModel('{not json')).toThrow(TransformationModelParseError);
  });

  it('rejects JSON that fails the contract guard', () => {
    expect(() => parseTransformationModel(JSON.stringify({ schema: 'wrong' }))).toThrow(
      TransformationModelParseError
    );
  });

  it('rejects a model with the wrong transformVersion', () => {
    const bad = { ...validModel, transformVersion: 'wrokit/transformation/v0' };
    expect(() => parseTransformationModel(JSON.stringify(bad))).toThrow(
      TransformationModelParseError
    );
  });

  it('produces a deterministic download filename based on runtime fingerprint', () => {
    expect(transformationModelDownloadName(validModel)).toMatch(/\.transformation\.json$/);
    expect(transformationModelDownloadName(validModel)).toContain('runtime');
  });
});

describe('transformation-runner (stub)', () => {
  it('returns an empty TransformationModel passing the contract guard', () => {
    const runner = createTransformationRunner({
      generateId: () => 'xform_test',
      now: () => '2026-04-27T12:00:00Z'
    });
    const model = runner.compute({ config: configModel, runtime: runtimeModel });
    expect(isTransformationModel(model)).toBe(true);
    expect(model.id).toBe('xform_test');
    expect(model.createdAtIso).toBe('2026-04-27T12:00:00Z');
  });

  it('does not mutate the input StructuralModels', () => {
    const configBefore = JSON.parse(JSON.stringify(configModel));
    const runtimeBefore = JSON.parse(JSON.stringify(runtimeModel));
    const runner = createTransformationRunner();
    runner.compute({ config: configModel, runtime: runtimeModel });
    expect(configModel).toEqual(configBefore);
    expect(runtimeModel).toEqual(runtimeBefore);
  });

  it('honors caller-provided id and nowIso', () => {
    const runner = createTransformationRunner();
    const model = runner.compute({
      config: configModel,
      runtime: runtimeModel,
      id: 'xform_custom',
      nowIso: '2026-05-01T00:00:00Z'
    });
    expect(model.id).toBe('xform_custom');
    expect(model.createdAtIso).toBe('2026-05-01T00:00:00Z');
  });
});
