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
        version: '2.0',
        pageIndex: 0,
        width: 1000,
        height: 1400,
        aspectRatio: 1000 / 1400,
        imageDataUrl: 'data:image/png;base64,xxx',
        sourceName: 'upload.pdf',
        normalization: {
          normalizedAtIso: '2026-01-01T00:00:00Z',
          boundary: 'intake-raster-only',
          pipelineVersion: '1.0'
        }
      })
    ).toBe(true);
  });

  it('rejects bad schema and unknown color mode', () => {
    expect(isNormalizedPage(null)).toBe(false);
    expect(
      isNormalizedPage({
        schema: 'wrokit/normalized-page',
        version: '2.0',
        pageIndex: 0,
        width: 1,
        height: 1,
        aspectRatio: 1,
        imageDataUrl: '',
        sourceName: 'upload.png',
        normalization: {
          normalizedAtIso: '2026-01-01T00:00:00Z',
          boundary: 'wrong',
          pipelineVersion: '1.0'
        }
      })
    ).toBe(false);
  });
});

describe('isGeometryFile', () => {
  it('accepts a valid GeometryFile', () => {
    expect(
      isGeometryFile({
        schema: 'wrokit/geometry-file',
        version: '1.1',
        geometryFileVersion: 'wrokit/geometry/v1',
        id: 'g1',
        wizardId: 'w1',
        documentFingerprint: 'sha256:abc',
        fields: [
          {
            fieldId: 'f1',
            pageIndex: 0,
            bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.2, hNorm: 0.2 },
            pixelBbox: { x: 100, y: 100, width: 200, height: 200 },
            pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1000 },
            confirmedAtIso: '2026-01-01T00:00:00Z',
            confirmedBy: 'user'
          }
        ]
      })
    ).toBe(true);
  });

  it('rejects malformed bbox or missing geometryFileVersion', () => {
    expect(isGeometryFile(null)).toBe(false);
    expect(
      isGeometryFile({
        schema: 'wrokit/geometry-file',
        version: '1.1',
        geometryFileVersion: 'wrokit/geometry/v1',
        id: 'g1',
        wizardId: 'w1',
        documentFingerprint: 'sha256:abc',
        fields: [
          {
            fieldId: 'f1',
            pageIndex: 0,
            bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 'wide', hNorm: 0.2 },
            pixelBbox: { x: 100, y: 100, width: 200, height: 200 },
            pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1000 },
            confirmedAtIso: '2026-01-01T00:00:00Z',
            confirmedBy: 'user'
          }
        ]
      })
    ).toBe(false);
    expect(
      isGeometryFile({
        schema: 'wrokit/geometry-file',
        version: '1.1',
        id: 'g1',
        wizardId: 'w1',
        documentFingerprint: 'sha256:abc',
        fields: []
      })
    ).toBe(false);
  });
});

describe('isStructuralModel', () => {
  it('accepts a valid StructuralModel (Border + Refined Border)', () => {
    expect(
      isStructuralModel({
        schema: 'wrokit/structural-model',
        version: '2.0',
        structureVersion: 'wrokit/structure/v1',
        id: 's1',
        documentFingerprint: 'sha256:abc',
        cvAdapter: { name: 'opencv-js', version: '1.0' },
        pages: [
          {
            pageIndex: 0,
            pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1400 },
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
                  bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
                  parentObjectId: null,
                  childObjectIds: [],
                  confidence: 0.9
                }
              ]
            },
            fieldRelationships: [
              {
                fieldId: 'f1',
                containedBy: 'obj_1',
                nearestObjects: [{ objectId: 'obj_1', distance: 0.1 }],
                relativePositionWithinParent: {
                  xRatio: 0.1,
                  yRatio: 0.1,
                  widthRatio: 0.2,
                  heightRatio: 0.2
                },
                distanceToBorder: 0.1,
                distanceToRefinedBorder: 0.05
              }
            ]
          }
        ],
        createdAtIso: '2026-01-01T00:00:00Z'
      })
    ).toBe(true);
  });

  it('rejects missing structureVersion or unknown refined border source', () => {
    expect(isStructuralModel(null)).toBe(false);
    expect(
      isStructuralModel({
        schema: 'wrokit/structural-model',
        version: '2.0',
        id: 's1',
        documentFingerprint: 'sha256:abc',
        cvAdapter: { name: 'opencv-js', version: '1.0' },
        pages: [],
        createdAtIso: '2026-01-01T00:00:00Z'
      })
    ).toBe(false);
    expect(
      isStructuralModel({
        schema: 'wrokit/structural-model',
        version: '2.0',
        structureVersion: 'wrokit/structure/v1',
        id: 's1',
        documentFingerprint: 'sha256:abc',
        cvAdapter: { name: 'opencv-js', version: '1.0' },
        pages: [
          {
            pageIndex: 0,
            pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1400 },
            border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
            refinedBorder: {
              rectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
              source: 'guessing',
              influencedByBBoxCount: 0,
              containsAllSavedBBoxes: true
            },
            objectHierarchy: { objects: [] },
            fieldRelationships: []
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
