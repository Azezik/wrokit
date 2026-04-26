import { describe, expect, it } from 'vitest';

import type { GeometryFile } from '../../src/core/contracts/geometry';
import type { NormalizedPage } from '../../src/core/contracts/normalized-page';
import type { WizardFile } from '../../src/core/contracts/wizard';
import { validateGeometryFile } from '../../src/core/engines/geometry/validation';

const wizard: WizardFile = {
  schema: 'wrokit/wizard-file',
  version: '1.0',
  wizardName: 'Test Wizard',
  fields: [
    { fieldId: 'invoice_number', label: 'Invoice Number', type: 'text', required: true },
    { fieldId: 'total', label: 'Total', type: 'numeric', required: false }
  ]
};

const page: NormalizedPage = {
  schema: 'wrokit/normalized-page',
  version: '2.0',
  pageIndex: 0,
  width: 1000,
  height: 2000,
  aspectRatio: 0.5,
  imageDataUrl: 'data:image/png;base64,xxx',
  sourceName: 'doc.pdf',
  normalization: {
    normalizedAtIso: '2026-01-01T00:00:00Z',
    boundary: 'intake-raster-only',
    pipelineVersion: '1.0'
  }
};

const buildGeometry = (overrides: Partial<GeometryFile> = {}): GeometryFile => ({
  schema: 'wrokit/geometry-file',
  version: '1.1',
  geometryFileVersion: 'wrokit/geometry/v1',
  id: 'g1',
  wizardId: 'Test Wizard',
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
  ],
  ...overrides
});

describe('validateGeometryFile', () => {
  it('passes when required fields are present, page exists, and bbox fits', () => {
    const result = validateGeometryFile(buildGeometry(), { wizard, pages: [page] });
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('flags missing required fields', () => {
    const geometry = buildGeometry({ fields: [] });
    const result = validateGeometryFile(geometry, { wizard, pages: [page] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'missing-required-field')).toBe(true);
  });

  it('flags unknown fieldIds unless tolerated', () => {
    const geometry = buildGeometry({
      fields: [
        {
          fieldId: 'mystery',
          pageIndex: 0,
          bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.2, hNorm: 0.2 },
          pixelBbox: { x: 100, y: 200, width: 200, height: 400 },
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
          confirmedAtIso: '2026-01-01T00:00:00Z',
          confirmedBy: 'user'
        }
      ]
    });
    expect(
      validateGeometryFile(geometry, { wizard, pages: [page] }).issues.some(
        (issue) => issue.code === 'unknown-field-id'
      )
    ).toBe(true);
    expect(
      validateGeometryFile(geometry, {
        wizard,
        pages: [page],
        tolerateUnknownFieldIds: true
      }).issues.some((issue) => issue.code === 'unknown-field-id')
    ).toBe(false);
  });

  it('flags missing page index', () => {
    const geometry = buildGeometry({
      fields: [
        {
          fieldId: 'invoice_number',
          pageIndex: 5,
          bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.2, hNorm: 0.2 },
          pixelBbox: { x: 100, y: 200, width: 200, height: 400 },
          pageSurface: { pageIndex: 5, surfaceWidth: 1000, surfaceHeight: 2000 },
          confirmedAtIso: '2026-01-01T00:00:00Z',
          confirmedBy: 'user'
        }
      ]
    });
    const result = validateGeometryFile(geometry, { wizard, pages: [page] });
    expect(result.issues.some((issue) => issue.code === 'invalid-page-index')).toBe(true);
  });

  it('flags page surface mismatch when geometry was captured against different dimensions', () => {
    const geometry = buildGeometry({
      fields: [
        {
          fieldId: 'invoice_number',
          pageIndex: 0,
          bbox: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.2, hNorm: 0.2 },
          pixelBbox: { x: 50, y: 100, width: 100, height: 200 },
          pageSurface: { pageIndex: 0, surfaceWidth: 500, surfaceHeight: 1000 },
          confirmedAtIso: '2026-01-01T00:00:00Z',
          confirmedBy: 'user'
        }
      ]
    });
    const result = validateGeometryFile(geometry, { wizard, pages: [page] });
    expect(result.issues.some((issue) => issue.code === 'page-surface-mismatch')).toBe(true);
  });

  it('flags out-of-bounds normalized coordinates', () => {
    const geometry = buildGeometry({
      fields: [
        {
          fieldId: 'invoice_number',
          pageIndex: 0,
          bbox: { xNorm: 0.9, yNorm: 0.9, wNorm: 0.5, hNorm: 0.5 },
          pixelBbox: { x: 900, y: 1800, width: 500, height: 1000 },
          pageSurface: { pageIndex: 0, surfaceWidth: 1000, surfaceHeight: 2000 },
          confirmedAtIso: '2026-01-01T00:00:00Z',
          confirmedBy: 'user'
        }
      ]
    });
    const result = validateGeometryFile(geometry, { wizard, pages: [page] });
    expect(result.issues.some((issue) => issue.code === 'out-of-bounds-coordinates')).toBe(true);
  });

  it('flags wizard-id mismatch', () => {
    const geometry = buildGeometry({ wizardId: 'Other Wizard' });
    const result = validateGeometryFile(geometry, { wizard, pages: [page] });
    expect(result.issues.some((issue) => issue.code === 'wizard-id-mismatch')).toBe(true);
  });
});
