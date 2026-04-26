import { describe, expect, it } from 'vitest';

import type { StructuralModel } from '../../src/core/contracts/structural-model';
import {
  parseStructuralModel,
  serializeStructuralModel,
  StructuralModelParseError,
  structuralModelDownloadName
} from '../../src/core/io/structural-model-io';

const validModel: StructuralModel = {
  schema: 'wrokit/structural-model',
  version: '2.0',
  structureVersion: 'wrokit/structure/v1',
  id: 'str_abc',
  documentFingerprint: 'surface:doc.pdf#0:1000x2000',
  cvAdapter: { name: 'opencv-js', version: '1.0' },
  pages: [
    {
      pageIndex: 0,
      pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
      border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
      refinedBorder: {
        rectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
        source: 'cv-content',
        influencedByBBoxCount: 0,
        containsAllSavedBBoxes: true
      }
    }
  ],
  createdAtIso: '2026-04-26T00:00:00Z'
};

describe('structural-model-io', () => {
  it('round-trips a StructuralModel through serialize/parse', () => {
    const text = serializeStructuralModel(validModel);
    const parsed = parseStructuralModel(text);
    expect(parsed).toEqual(validModel);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseStructuralModel('{not json')).toThrow(StructuralModelParseError);
  });

  it('rejects JSON that fails the contract guard', () => {
    expect(() => parseStructuralModel(JSON.stringify({ schema: 'wrong' }))).toThrow(
      StructuralModelParseError
    );
  });

  it('produces a deterministic download filename', () => {
    expect(structuralModelDownloadName(validModel)).toMatch(/\.structural\.json$/);
  });
});
