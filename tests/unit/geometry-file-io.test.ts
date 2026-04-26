import { describe, expect, it } from 'vitest';

import type { GeometryFile } from '../../src/core/contracts/geometry';
import {
  GeometryFileParseError,
  geometryFileDownloadName,
  parseGeometryFile,
  serializeGeometryFile
} from '../../src/core/io/geometry-file-io';

const sample: GeometryFile = {
  schema: 'wrokit/geometry-file',
  version: '1.1',
  geometryFileVersion: 'wrokit/geometry/v1',
  id: 'g1',
  wizardId: 'My Wizard',
  documentFingerprint: 'surface:doc.pdf#0:1000x2000',
  fields: [
    {
      fieldId: 'invoice_number',
      pageIndex: 0,
      bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.3, hNorm: 0.05 },
      pixelBbox: { x: 100, y: 200, width: 300, height: 100 },
      pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
      confirmedAtIso: '2026-01-01T00:00:00Z',
      confirmedBy: 'user'
    }
  ]
};

describe('geometry-file-io', () => {
  it('round-trips serialize/parse', () => {
    const text = serializeGeometryFile(sample);
    expect(parseGeometryFile(text)).toEqual(sample);
  });

  it('throws GeometryFileParseError on invalid JSON', () => {
    expect(() => parseGeometryFile('not json')).toThrow(GeometryFileParseError);
  });

  it('throws GeometryFileParseError on schema mismatch', () => {
    expect(() => parseGeometryFile(JSON.stringify({ ...sample, version: '0.1' }))).toThrow(
      GeometryFileParseError
    );
  });

  it('builds a safe download filename from wizardId', () => {
    expect(geometryFileDownloadName(sample)).toBe('my-wizard.geometry.json');
  });
});
