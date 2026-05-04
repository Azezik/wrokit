import { describe, expect, it } from 'vitest';

import { isOcrBoxResult } from '../../src/core/contracts/ocrbox-result';
import { padBboxNormalized } from '../../src/core/engines/ocrbox/bbox-cropper';
import { createOcrBoxEngine } from '../../src/core/engines/ocrbox/ocrbox-engine';
import type { OcrTextAdapter } from '../../src/core/engines/ocrbox/types';
import type { NormalizedPage } from '../../src/core/contracts/normalized-page';

const fakePage = (pageIndex: number): NormalizedPage => ({
  schema: 'wrokit/normalized-page',
  version: '2.0',
  pageIndex,
  width: 1000,
  height: 1400,
  aspectRatio: 1000 / 1400,
  imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  sourceName: 'fake.png',
  normalization: {
    normalizedAtIso: '2026-01-01T00:00:00Z',
    boundary: 'intake-raster-only',
    pipelineVersion: '1.0'
  }
});

const fakeAdapter = (text: string, confidence = 0.9): OcrTextAdapter => ({
  name: 'test-adapter',
  version: '0.1',
  recognize: async () => ({ text, confidence })
});

describe('padBboxNormalized', () => {
  it('expands symmetrically and clamps to [0, 1]', () => {
    const padded = padBboxNormalized(
      { xNorm: 0.001, yNorm: 0.5, wNorm: 0.2, hNorm: 0.3 },
      0.01
    );
    expect(padded.xNorm).toBe(0);
    expect(padded.yNorm).toBeCloseTo(0.49, 5);
    expect(padded.wNorm).toBeGreaterThan(0.2);
    expect(padded.hNorm).toBeGreaterThan(0.3);
  });

  it('caps padding at 0.02 to prevent runaway growth', () => {
    const padded = padBboxNormalized(
      { xNorm: 0.4, yNorm: 0.4, wNorm: 0.1, hNorm: 0.1 },
      999
    );
    expect(padded.xNorm).toBeCloseTo(0.38, 5);
    expect(padded.wNorm).toBeCloseTo(0.14, 5);
  });
});

describe('createOcrBoxEngine', () => {
  it('emits an error field when the requested page is missing without throwing', async () => {
    const engine = createOcrBoxEngine(fakeAdapter('IGNORED'));
    const result = await engine.run({
      wizardId: 'Test',
      documentFingerprint: 'sha256:abc',
      bboxSource: 'geometry-file',
      sourceArtifactId: 'geo_1',
      pages: [fakePage(0)],
      fields: [
        {
          fieldId: 'missing-page',
          pageIndex: 5,
          bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.1, hNorm: 0.1 }
        }
      ]
    });
    expect(isOcrBoxResult(result)).toBe(true);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].status).toBe('error');
    expect(result.fields[0].text).toBe('');
  });

  it('refuses to run without an adapter', async () => {
    const engine = createOcrBoxEngine();
    await expect(
      engine.run({
        wizardId: 'Test',
        documentFingerprint: 'fp',
        bboxSource: 'geometry-file',
        sourceArtifactId: 'geo_1',
        pages: [fakePage(0)],
        fields: [
          {
            fieldId: 'f1',
            pageIndex: 0,
            bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.1, hNorm: 0.1 }
          }
        ]
      })
    ).rejects.toThrow(/OCRBOX engine requires an OCR adapter/);
  });
});
