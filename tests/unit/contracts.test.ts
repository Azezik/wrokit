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
        version: '3.0',
        structureVersion: 'wrokit/structure/v2',
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
                  relativeRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.8, hRatio: 0.8 }
                }
              ],
              refinedBorderToBorder: {
                relativeRect: { xRatio: 0.05, yRatio: 0.05, wRatio: 0.9, hRatio: 0.9 }
              }
            },
            fieldRelationships: [
              {
                fieldId: 'f1',
                fieldAnchors: {
                  objectAnchors: [
                    {
                      rank: 'primary',
                      objectId: 'obj_1',
                      relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 }
                    }
                  ],
                  stableObjectAnchors: [
                    {
                      label: 'A',
                      objectId: 'obj_1',
                      distance: 0.1,
                      relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 }
                    }
                  ],
                  refinedBorderAnchor: {
                    relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 },
                    distanceToEdge: 0.05
                  },
                  borderAnchor: {
                    relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 },
                    distanceToEdge: 0.1
                  }
                },
                objectAnchorGraph: [],
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
        version: '3.0',
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
        version: '3.0',
        structureVersion: 'wrokit/structure/v2',
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
            pageAnchorRelations: {
              objectToObject: [],
              objectToRefinedBorder: [],
              refinedBorderToBorder: {
                relativeRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 }
              }
            },
            fieldRelationships: []
          }
        ],
        createdAtIso: '2026-01-01T00:00:00Z'
      })
    ).toBe(false);
  });

  it('rejects structural field anchors when stable labels are not canonical A->B->C order', () => {
    const invalidLabels = {
      schema: 'wrokit/structural-model',
      version: '3.0',
      structureVersion: 'wrokit/structure/v2',
      id: 's2',
      documentFingerprint: 'sha256:abc',
      cvAdapter: { name: 'opencv-js', version: '1.0' },
      pages: [
        {
          pageIndex: 0,
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1400 },
          border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
          refinedBorder: {
            rectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
            source: 'cv-content',
            influencedByBBoxCount: 0,
            containsAllSavedBBoxes: true
          },
          objectHierarchy: {
            objects: [
              {
                objectId: 'obj_a',
                type: 'container',
                objectRectNorm: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.4 },
                bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.4 },
                parentObjectId: null,
                childObjectIds: [],
                confidence: 0.9
              }
            ]
          },
          pageAnchorRelations: {
            objectToObject: [],
            objectToRefinedBorder: [],
            refinedBorderToBorder: {
              relativeRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.8, hRatio: 0.8 }
            }
          },
          fieldRelationships: [
            {
              fieldId: 'f1',
              fieldAnchors: {
                objectAnchors: [
                  {
                    rank: 'primary',
                    objectId: 'obj_a',
                    relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 }
                  }
                ],
                stableObjectAnchors: [
                  {
                    label: 'B',
                    objectId: 'obj_a',
                    distance: 0.1,
                    relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 }
                  }
                ],
                refinedBorderAnchor: {
                  relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 },
                  distanceToEdge: 0.1
                },
                borderAnchor: {
                  relativeFieldRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.2, hRatio: 0.2 },
                  distanceToEdge: 0.2
                }
              },
              objectAnchorGraph: [],
              containedBy: 'obj_a',
              nearestObjects: [{ objectId: 'obj_a', distance: 0.1 }],
              relativePositionWithinParent: {
                xRatio: 0.1,
                yRatio: 0.1,
                widthRatio: 0.2,
                heightRatio: 0.2
              },
              distanceToBorder: 0.2,
              distanceToRefinedBorder: 0.1
            }
          ]
        }
      ],
      createdAtIso: '2026-01-01T00:00:00Z'
    };

    expect(isStructuralModel(invalidLabels)).toBe(false);
  });

  it('rejects structural field anchors when object anchor rank order is not primary->secondary->tertiary', () => {
    const invalidRanks = {
      schema: 'wrokit/structural-model',
      version: '3.0',
      structureVersion: 'wrokit/structure/v2',
      id: 's3',
      documentFingerprint: 'sha256:abc',
      cvAdapter: { name: 'opencv-js', version: '1.0' },
      pages: [
        {
          pageIndex: 0,
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1400 },
          border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
          refinedBorder: {
            rectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
            source: 'cv-content',
            influencedByBBoxCount: 0,
            containsAllSavedBBoxes: true
          },
          objectHierarchy: { objects: [] },
          pageAnchorRelations: {
            objectToObject: [],
            objectToRefinedBorder: [],
            refinedBorderToBorder: {
              relativeRect: { xRatio: 0.1, yRatio: 0.1, wRatio: 0.8, hRatio: 0.8 }
            }
          },
          fieldRelationships: [
            {
              fieldId: 'f2',
              fieldAnchors: {
                objectAnchors: [
                  {
                    rank: 'secondary',
                    objectId: 'obj_b',
                    relativeFieldRect: { xRatio: 0.2, yRatio: 0.2, wRatio: 0.2, hRatio: 0.2 }
                  }
                ],
                stableObjectAnchors: [
                  {
                    label: 'A',
                    objectId: 'obj_b',
                    distance: 0.2,
                    relativeFieldRect: { xRatio: 0.2, yRatio: 0.2, wRatio: 0.2, hRatio: 0.2 }
                  }
                ],
                refinedBorderAnchor: {
                  relativeFieldRect: { xRatio: 0.2, yRatio: 0.2, wRatio: 0.2, hRatio: 0.2 },
                  distanceToEdge: 0.2
                },
                borderAnchor: {
                  relativeFieldRect: { xRatio: 0.2, yRatio: 0.2, wRatio: 0.2, hRatio: 0.2 },
                  distanceToEdge: 0.25
                }
              },
              objectAnchorGraph: [],
              containedBy: null,
              nearestObjects: [],
              relativePositionWithinParent: null,
              distanceToBorder: 0.25,
              distanceToRefinedBorder: 0.2
            }
          ]
        }
      ],
      createdAtIso: '2026-01-01T00:00:00Z'
    };

    expect(isStructuralModel(invalidRanks)).toBe(false);
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
