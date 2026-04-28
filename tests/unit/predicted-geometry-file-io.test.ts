import { describe, expect, it } from 'vitest';

import type { PredictedGeometryFile } from '../../src/core/contracts/predicted-geometry-file';
import {
  PredictedGeometryFileParseError,
  parsePredictedGeometryFile,
  predictedGeometryFileDownloadName,
  serializePredictedGeometryFile
} from '../../src/core/io/predicted-geometry-file-io';

const sample: PredictedGeometryFile = {
  schema: 'wrokit/predicted-geometry-file',
  version: '1.0',
  geometryFileVersion: 'wrokit/geometry/v1',
  structureVersion: 'wrokit/structure/v2',
  id: 'pred_round_trip',
  wizardId: 'My Wizard',
  sourceGeometryFileId: 'geo_1',
  sourceStructuralModelId: 'sm_1',
  runtimeDocumentFingerprint: 'surface:runtime.pdf#0:1000x1400',
  predictedAtIso: '2026-04-28T00:00:00Z',
  fields: [
    {
      fieldId: 'invoice_number',
      pageIndex: 0,
      bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.2, hNorm: 0.05 },
      pixelBbox: { x: 100, y: 140, width: 200, height: 70 },
      pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1400 },
      sourceGeometryConfirmedAtIso: '2026-04-25T00:00:00Z',
      sourceGeometryConfirmedBy: 'user',
      anchorTierUsed: 'field-object-a',
      transform: {
        pageIndex: 0,
        basis: 'field-object-a',
        sourceConfigRectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
        sourceRuntimeRectNorm: { xNorm: 0.06, yNorm: 0.05, wNorm: 0.88, hNorm: 0.9 },
        scaleX: 0.978,
        scaleY: 1.0,
        translateX: 0.01,
        translateY: 0,
        configObjectId: 'obj_1',
        runtimeObjectId: 'obj_42',
        objectMatchStrategy: 'type-hierarchy-geometry'
      }
    }
  ]
};

describe('predicted-geometry-file-io', () => {
  it('round-trips serialize/parse', () => {
    const text = serializePredictedGeometryFile(sample);
    expect(parsePredictedGeometryFile(text)).toEqual(sample);
  });

  it('throws PredictedGeometryFileParseError on invalid JSON', () => {
    expect(() => parsePredictedGeometryFile('not json')).toThrow(
      PredictedGeometryFileParseError
    );
  });

  it('throws PredictedGeometryFileParseError on schema mismatch', () => {
    expect(() =>
      parsePredictedGeometryFile(JSON.stringify({ ...sample, version: '0.1' }))
    ).toThrow(PredictedGeometryFileParseError);
  });

  it('builds a safe download filename from wizardId', () => {
    expect(predictedGeometryFileDownloadName(sample)).toBe(
      'my-wizard.predicted-geometry.json'
    );
  });

  it('falls back to "wizard" when wizardId is empty', () => {
    expect(
      predictedGeometryFileDownloadName({ ...sample, wizardId: '' })
    ).toBe('wizard.predicted-geometry.json');
  });
});
