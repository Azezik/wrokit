import { describe, expect, it } from 'vitest';

import { isExtractionResult } from '../../src/core/contracts/extraction-result';
import { isGeometryFile } from '../../src/core/contracts/geometry';
import { isNormalizedPage } from '../../src/core/contracts/normalized-page';
import { isStructuralModel } from '../../src/core/contracts/structural-model';
import { isWizardFile } from '../../src/core/contracts/wizard';

describe('isWizardFile', () => {
  it('accepts a valid WizardFile', () => {
    expect(
      isWizardFile({
        schema: 'wrokit/wizard-file',
        version: '1.0',
        wizardName: 'Test',
        fields: [{ fieldId: 'f1', label: 'F', type: 'text', required: false }]
      })
    ).toBe(true);
  });

  it('rejects wrong schema, version, or field shape', () => {
    expect(isWizardFile(null)).toBe(false);
    expect(isWizardFile({ schema: 'other', version: '1.0', wizardName: '', fields: [] })).toBe(false);
    expect(
      isWizardFile({ schema: 'wrokit/wizard-file', version: '0.9', wizardName: '', fields: [] })
    ).toBe(false);
    expect(
      isWizardFile({
        schema: 'wrokit/wizard-file',
        version: '1.0',
        wizardName: 'Test',
        fields: [{ fieldId: 'f1', label: 'F', type: 'invalid', required: false }]
      })
    ).toBe(false);
  });
});

describe('isNormalizedPage', () => {
  it('accepts a valid NormalizedPage', () => {
    expect(
      isNormalizedPage({
        schema: 'wrokit/normalized-page',
        version: '1.0',
        pageIndex: 0,
        width: 1000,
        height: 1400,
        imageDataUrl: 'data:image/png;base64,xxx',
        dpi: 300,
        colorMode: 'rgb'
      })
    ).toBe(true);
  });

  it('rejects bad schema and unknown color mode', () => {
    expect(isNormalizedPage(null)).toBe(false);
    expect(
      isNormalizedPage({
        schema: 'wrokit/normalized-page',
        version: '1.0',
        pageIndex: 0,
        width: 1,
        height: 1,
        imageDataUrl: '',
        dpi: 1,
        colorMode: 'cmyk'
      })
    ).toBe(false);
  });
});

describe('isGeometryFile', () => {
  it('accepts a valid GeometryFile', () => {
    expect(
      isGeometryFile({
        schema: 'wrokit/geometry-file',
        version: '1.0',
        id: 'g1',
        wizardId: 'w1',
        documentFingerprint: 'sha256:abc',
        fields: [
          {
            fieldId: 'f1',
            pageIndex: 0,
            bbox: { x: 0, y: 0, width: 10, height: 10 },
            confirmedAtIso: '2026-01-01T00:00:00Z',
            confirmedBy: 'user'
          }
        ]
      })
    ).toBe(true);
  });

  it('rejects malformed bbox', () => {
    expect(isGeometryFile(null)).toBe(false);
    expect(
      isGeometryFile({
        schema: 'wrokit/geometry-file',
        version: '1.0',
        id: 'g1',
        wizardId: 'w1',
        documentFingerprint: 'sha256:abc',
        fields: [
          {
            fieldId: 'f1',
            pageIndex: 0,
            bbox: { x: 0, y: 0, width: 'wide', height: 10 },
            confirmedAtIso: '2026-01-01T00:00:00Z',
            confirmedBy: 'user'
          }
        ]
      })
    ).toBe(false);
  });
});

describe('isStructuralModel', () => {
  it('accepts a valid StructuralModel', () => {
    expect(
      isStructuralModel({
        schema: 'wrokit/structural-model',
        version: '1.0',
        id: 's1',
        documentFingerprint: 'sha256:abc',
        regions: [
          {
            id: 'r1',
            kind: 'text-block',
            pageIndex: 0,
            bbox: { x: 0, y: 0, width: 10, height: 10 }
          }
        ],
        createdAtIso: '2026-01-01T00:00:00Z'
      })
    ).toBe(true);
  });

  it('rejects unknown region kind', () => {
    expect(isStructuralModel(null)).toBe(false);
    expect(
      isStructuralModel({
        schema: 'wrokit/structural-model',
        version: '1.0',
        id: 's1',
        documentFingerprint: 'sha256:abc',
        regions: [
          {
            id: 'r1',
            kind: 'mystery',
            pageIndex: 0,
            bbox: { x: 0, y: 0, width: 10, height: 10 }
          }
        ],
        createdAtIso: '2026-01-01T00:00:00Z'
      })
    ).toBe(false);
  });
});

describe('isExtractionResult', () => {
  it('accepts a valid ExtractionResult', () => {
    expect(
      isExtractionResult({
        schema: 'wrokit/extraction-result',
        version: '1.0',
        id: 'e1',
        wizardId: 'w1',
        documentFingerprint: 'sha256:abc',
        fields: [
          { fieldId: 'f1', value: 'INV-001', confidence: 0.97, source: 'localized-ocr' }
        ],
        generatedAtIso: '2026-01-01T00:00:00Z'
      })
    ).toBe(true);
  });

  it('rejects unknown source', () => {
    expect(isExtractionResult(null)).toBe(false);
    expect(
      isExtractionResult({
        schema: 'wrokit/extraction-result',
        version: '1.0',
        id: 'e1',
        wizardId: 'w1',
        documentFingerprint: 'sha256:abc',
        fields: [
          { fieldId: 'f1', value: 1, confidence: 1, source: 'guess' }
        ],
        generatedAtIso: '2026-01-01T00:00:00Z'
      })
    ).toBe(false);
  });
});
