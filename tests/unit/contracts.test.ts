import { describe, expect, it } from 'vitest';

import { isExtractionResult } from '../../src/core/contracts/extraction-result';
import { isGeometryFile } from '../../src/core/contracts/geometry';
import { isMasterDbTable } from '../../src/core/contracts/masterdb-table';
import { isNormalizedPage } from '../../src/core/contracts/normalized-page';
import { isOcrBoxResult } from '../../src/core/contracts/ocrbox-result';
import { isOcrMagicResult } from '../../src/core/contracts/ocrmagic-result';
import { isPredictedGeometryFile } from '../../src/core/contracts/predicted-geometry-file';
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
        version: '4.0',
        structureVersion: 'wrokit/structure/v3',
        id: 's1',
        documentFingerprint: 'sha256:abc',
        cvAdapter: { name: 'opencv-js', version: '1.0' },
        pages: [
          {
            pageIndex: 0,
            pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1400 },
            cvExecutionMode: 'heuristic-fallback',
            border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
            refinedBorder: {
              rectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
              cvContentRectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
              source: 'cv-content',
              influencedByBBoxCount: 0,
              containsAllSavedBBoxes: true
            },
            objectHierarchy: {
              objects: [
                {
                  objectId: 'obj_1',
                  objectRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
                  bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
                  parentObjectId: null,
                  childObjectIds: [],
                  confidence: 0.9,
                  depth: 0
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
        version: '4.0',
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
        version: '4.0',
        structureVersion: 'wrokit/structure/v3',
        id: 's1',
        documentFingerprint: 'sha256:abc',
        cvAdapter: { name: 'opencv-js', version: '1.0' },
        pages: [
          {
            pageIndex: 0,
            pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1400 },
            cvExecutionMode: 'heuristic-fallback',
            border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
            refinedBorder: {
              rectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
              cvContentRectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
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
      version: '4.0',
      structureVersion: 'wrokit/structure/v3',
      id: 's2',
      documentFingerprint: 'sha256:abc',
      cvAdapter: { name: 'opencv-js', version: '1.0' },
      pages: [
        {
          pageIndex: 0,
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1400 },
          cvExecutionMode: 'heuristic-fallback',
          border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
          refinedBorder: {
            rectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
            cvContentRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
            source: 'cv-content',
            influencedByBBoxCount: 0,
            containsAllSavedBBoxes: true
          },
          objectHierarchy: {
            objects: [
              {
                objectId: 'obj_a',
                objectRectNorm: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.4 },
                bbox: { xNorm: 0.2, yNorm: 0.2, wNorm: 0.4, hNorm: 0.4 },
                parentObjectId: null,
                childObjectIds: [],
                confidence: 0.9,
                depth: 0
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
      version: '4.0',
      structureVersion: 'wrokit/structure/v3',
      id: 's3',
      documentFingerprint: 'sha256:abc',
      cvAdapter: { name: 'opencv-js', version: '1.0' },
      pages: [
        {
          pageIndex: 0,
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 1400 },
          cvExecutionMode: 'heuristic-fallback',
          border: { rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 } },
          refinedBorder: {
            rectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
            cvContentRectNorm: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.8, hNorm: 0.8 },
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

describe('isPredictedGeometryFile', () => {
  const validPredicted = {
    schema: 'wrokit/predicted-geometry-file',
    version: '1.0',
    geometryFileVersion: 'wrokit/geometry/v1',
    structureVersion: 'wrokit/structure/v3',
    id: 'pred_1',
    wizardId: 'Invoice Wizard',
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

  it('accepts a valid PredictedGeometryFile', () => {
    expect(isPredictedGeometryFile(validPredicted)).toBe(true);
  });

  it('accepts a valid file when optional transform fields are omitted', () => {
    const noOptionals = {
      ...validPredicted,
      fields: [
        {
          ...validPredicted.fields[0],
          transform: {
            pageIndex: 0,
            basis: 'refined-border',
            sourceConfigRectNorm: { xNorm: 0.05, yNorm: 0.05, wNorm: 0.9, hNorm: 0.9 },
            sourceRuntimeRectNorm: { xNorm: 0.06, yNorm: 0.05, wNorm: 0.88, hNorm: 0.9 },
            scaleX: 1,
            scaleY: 1,
            translateX: 0,
            translateY: 0
          }
        }
      ]
    };
    expect(isPredictedGeometryFile(noOptionals)).toBe(true);
  });

  it('rejects wrong schema, version, or sub-version markers', () => {
    expect(isPredictedGeometryFile(null)).toBe(false);
    expect(
      isPredictedGeometryFile({ ...validPredicted, schema: 'other' })
    ).toBe(false);
    expect(
      isPredictedGeometryFile({ ...validPredicted, version: '0.9' })
    ).toBe(false);
    expect(
      isPredictedGeometryFile({ ...validPredicted, geometryFileVersion: 'wrokit/geometry/v0' })
    ).toBe(false);
    expect(
      isPredictedGeometryFile({ ...validPredicted, structureVersion: 'wrokit/structure/v1' })
    ).toBe(false);
  });

  it('rejects unknown anchor tier or match strategy', () => {
    const badTier = {
      ...validPredicted,
      fields: [{ ...validPredicted.fields[0], anchorTierUsed: 'guessing' }]
    };
    expect(isPredictedGeometryFile(badTier)).toBe(false);

    const badStrategy = {
      ...validPredicted,
      fields: [
        {
          ...validPredicted.fields[0],
          transform: { ...validPredicted.fields[0].transform, objectMatchStrategy: 'magic' }
        }
      ]
    };
    expect(isPredictedGeometryFile(badStrategy)).toBe(false);
  });

  it('accepts page-consensus transforms only when source rect pair is omitted', () => {
    const validConsensus = {
      ...validPredicted,
      fields: [
        {
          ...validPredicted.fields[0],
          anchorTierUsed: 'page-consensus',
          transform: {
            pageIndex: 0,
            basis: 'page-consensus',
            scaleX: 1,
            scaleY: 1,
            translateX: 0.1,
            translateY: 0.05
          }
        }
      ]
    };
    expect(isPredictedGeometryFile(validConsensus)).toBe(true);

    const consensusWithSourceRects = {
      ...validConsensus,
      fields: [
        {
          ...validConsensus.fields[0],
          transform: {
            ...validConsensus.fields[0].transform,
            sourceConfigRectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 },
            sourceRuntimeRectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 }
          }
        }
      ]
    };
    expect(isPredictedGeometryFile(consensusWithSourceRects)).toBe(false);

    const refinedBorderMissingSourceRects = {
      ...validPredicted,
      fields: [
        {
          ...validPredicted.fields[0],
          anchorTierUsed: 'refined-border',
          transform: {
            pageIndex: 0,
            basis: 'refined-border',
            scaleX: 1,
            scaleY: 1,
            translateX: 0,
            translateY: 0
          }
        }
      ]
    };
    expect(isPredictedGeometryFile(refinedBorderMissingSourceRects)).toBe(false);
  });

  it('rejects a malformed transform rect or non-finite scalar', () => {
    const badRect = {
      ...validPredicted,
      fields: [
        {
          ...validPredicted.fields[0],
          transform: {
            ...validPredicted.fields[0].transform,
            sourceRuntimeRectNorm: { xNorm: 'oops', yNorm: 0, wNorm: 1, hNorm: 1 }
          }
        }
      ]
    };
    expect(isPredictedGeometryFile(badRect)).toBe(false);

    const badScale = {
      ...validPredicted,
      fields: [
        {
          ...validPredicted.fields[0],
          transform: { ...validPredicted.fields[0].transform, scaleX: Number.NaN }
        }
      ]
    };
    expect(isPredictedGeometryFile(badScale)).toBe(false);
  });
});

describe('isOcrBoxResult', () => {
  it('accepts a valid OCRBOX result', () => {
    expect(
      isOcrBoxResult({
        schema: 'wrokit/ocrbox-result',
        version: '1.0',
        id: 'ocrbox_1',
        wizardId: 'Invoice Wizard',
        documentFingerprint: 'sha256:abc',
        bboxSource: 'predicted-geometry-file',
        sourceArtifactId: 'pred_1',
        engineName: 'ocrbox/tesseract-js',
        engineVersion: '1.0',
        generatedAtIso: '2026-04-29T00:00:00Z',
        fields: [
          {
            fieldId: 'invoice_number',
            pageIndex: 0,
            text: '104882',
            confidence: 0.93,
            status: 'ok',
            bboxUsed: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.2, hNorm: 0.05 },
            bboxPaddingNorm: 0.004
          }
        ]
      })
    ).toBe(true);
  });

  it('rejects unknown bbox source or status', () => {
    const base = {
      schema: 'wrokit/ocrbox-result',
      version: '1.0',
      id: 'x',
      wizardId: 'w',
      documentFingerprint: 'fp',
      bboxSource: 'guessing',
      sourceArtifactId: 'src',
      engineName: 'e',
      engineVersion: '1',
      generatedAtIso: 't',
      fields: []
    };
    expect(isOcrBoxResult(base)).toBe(false);
  });
});

describe('isMasterDbTable', () => {
  it('accepts a valid MasterDB table', () => {
    expect(
      isMasterDbTable({
        schema: 'wrokit/masterdb-table',
        version: '1.0',
        wizardId: 'Invoice Wizard',
        fieldOrder: ['invoice_number', 'total'],
        rows: [
          {
            documentId: 'INV-1',
            sourceName: 'inv1.pdf',
            extractedAtIso: '2026-04-29T00:00:00Z',
            values: { invoice_number: '104882', total: '135.60' }
          }
        ]
      })
    ).toBe(true);
  });

  it('rejects malformed rows or wrong schema', () => {
    expect(isMasterDbTable(null)).toBe(false);
    expect(
      isMasterDbTable({
        schema: 'wrokit/masterdb-table',
        version: '1.0',
        wizardId: 'w',
        fieldOrder: ['f1'],
        rows: [{ documentId: 'd', sourceName: 's', extractedAtIso: 't', values: { f1: 1 } }]
      })
    ).toBe(false);
  });
});

describe('isOcrMagicResult', () => {
  const baseTable = {
    schema: 'wrokit/masterdb-table',
    version: '1.0',
    wizardId: 'Invoice Wizard',
    fieldOrder: ['invoice_number'],
    rows: [
      {
        documentId: 'INV-1',
        sourceName: 'inv1.pdf',
        extractedAtIso: '2026-04-29T00:00:00Z',
        values: { invoice_number: '104882' }
      }
    ]
  };

  const validResult = {
    schema: 'wrokit/ocrmagic-result',
    version: '1.0',
    wizardId: 'Invoice Wizard',
    generatedAtIso: '2026-04-29T00:00:00Z',
    cleanedTable: baseTable,
    profiles: {
      invoice_number: {
        fieldId: 'invoice_number',
        declaredType: 'numeric',
        inferredKind: 'numeric',
        sampleCount: 1,
        nonEmptySampleCount: 1,
        length: { min: 6, max: 6, mode: 6, mean: 6 },
        charClassByPosition: ['digit', 'digit', 'digit', 'digit', 'digit', 'digit'],
        commonPrefixes: [],
        commonSuffixes: [],
        separators: [],
        repeatedValues: []
      }
    },
    audits: [
      {
        documentId: 'INV-1',
        fieldId: 'invoice_number',
        rawValue: '104882',
        cleanValue: '104882',
        changeType: 'unchanged',
        confidenceBefore: 0.6,
        confidenceAfter: 0.6,
        reasonCodes: []
      }
    ],
    changeCounts: {
      unchanged: 1,
      'edge-cleaned': 0,
      'whitespace-normalized': 0,
      'type-substituted': 0,
      'pattern-corrected': 0,
      flagged: 0
    }
  };

  it('accepts a valid OCRMagic result', () => {
    expect(isOcrMagicResult(validResult)).toBe(true);
  });

  it('rejects wrong schema or unknown char class in profile', () => {
    expect(isOcrMagicResult(null)).toBe(false);
    expect(isOcrMagicResult({ ...validResult, schema: 'other' })).toBe(false);
    const badProfile = {
      ...validResult,
      profiles: {
        invoice_number: {
          ...validResult.profiles.invoice_number,
          charClassByPosition: ['digit', 'unknown']
        }
      }
    };
    expect(isOcrMagicResult(badProfile)).toBe(false);
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
