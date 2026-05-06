import { describe, expect, it } from 'vitest';

import type { GeometryFile } from '../../src/core/contracts/geometry';
import type {
  StructuralModel,
  StructuralObjectNode,
  StructuralPage
} from '../../src/core/contracts/structural-model';
import {
  MIN_OBJECT_CONFIDENCE,
  MIN_OBJECTS_NEAR_BBOX,
  RADIUS_FACTOR,
  acceptHighResModel,
  evaluateStructuralDensity
} from '../../src/core/engines/structural-refine/sensitivity-density-check';

const makeObject = (
  id: string,
  rect: { x: number; y: number; w: number; h: number },
  confidence: number
): StructuralObjectNode => ({
  objectId: id,
  objectRectNorm: { xNorm: rect.x, yNorm: rect.y, wNorm: rect.w, hNorm: rect.h },
  bbox: { xNorm: rect.x, yNorm: rect.y, wNorm: rect.w, hNorm: rect.h },
  parentObjectId: null,
  childObjectIds: [],
  confidence,
  depth: 0
});

const makePage = (pageIndex: number, objects: StructuralObjectNode[]): StructuralPage => ({
  pageIndex,
  pageSurface: { pageIndex, surfaceWidth: 1000, surfaceHeight: 1000 },
  cvExecutionMode: 'opencv-runtime',
  border: {
    rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 },
    containsAllSavedBBoxes: true
  },
  refinedBorder: {
    rectNorm: { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 },
    source: 'border-fallback',
    containsAllSavedBBoxes: true
  },
  objectHierarchy: { objects },
  pageAnchorRelations: {
    objectToObject: [],
    objectToRefinedBorder: [],
    refinedBorderToBorder: { relativeRect: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 } }
  },
  fieldRelationships: []
});

const makeModel = (pages: StructuralPage[]): StructuralModel => ({
  schema: 'wrokit/structural-model',
  version: '4.0',
  structureVersion: 'wrokit/structure/v3',
  id: 'test-model',
  documentFingerprint: 'fp',
  cvAdapter: { name: 'opencv-js', version: '1.0' },
  pages,
  createdAtIso: '2026-05-06T00:00:00.000Z'
});

const makeGeometry = (
  fields: { fieldId: string; pageIndex: number; bbox: { x: number; y: number; w: number; h: number } }[]
): GeometryFile => ({
  schema: 'wrokit/geometry-file',
  version: '1.1',
  geometryFileVersion: 'wrokit/geometry/v1',
  id: 'test-geom',
  wizardId: 'test-wizard',
  documentFingerprint: 'fp',
  fields: fields.map((f) => ({
    fieldId: f.fieldId,
    pageIndex: f.pageIndex,
    bbox: { xNorm: f.bbox.x, yNorm: f.bbox.y, wNorm: f.bbox.w, hNorm: f.bbox.h },
    pixelBbox: { x: 0, y: 0, width: 0, height: 0 },
    pageSurface: { pageIndex: f.pageIndex, surfaceWidth: 1000, surfaceHeight: 1000 },
    confirmedAtIso: '2026-05-06T00:00:00.000Z',
    confirmedBy: 'test'
  }))
});

describe('sensitivity-density-check', () => {
  describe('evaluateStructuralDensity', () => {
    it('passes when at least MIN_OBJECTS_NEAR_BBOX qualifying objects are within radius', () => {
      // Field at (0.5, 0.5) with size 0.05x0.05 → radius = 2 * 0.05 = 0.1
      // around center (0.525, 0.525). Two objects near, both confidence >=0.7.
      const model = makeModel([
        makePage(0, [
          makeObject('obj1', { x: 0.5, y: 0.55, w: 0.02, h: 0.02 }, 0.9),
          makeObject('obj2', { x: 0.55, y: 0.5, w: 0.02, h: 0.02 }, 0.8)
        ])
      ]);
      const geometry = makeGeometry([
        { fieldId: 'f1', pageIndex: 0, bbox: { x: 0.5, y: 0.5, w: 0.05, h: 0.05 } }
      ]);

      const result = evaluateStructuralDensity(model, geometry);

      expect(result.satisfiesDensity).toBe(true);
      expect(result.failingFields).toHaveLength(0);
      expect(result.passingFields[0].qualifyingObjectCount).toBe(MIN_OBJECTS_NEAR_BBOX);
    });

    it('fails when fewer than MIN_OBJECTS_NEAR_BBOX qualifying objects are within radius', () => {
      // Only one nearby object with adequate confidence; everything else is
      // far away or low-confidence. Should fail the density check.
      const model = makeModel([
        makePage(0, [
          makeObject('near-good', { x: 0.5, y: 0.55, w: 0.02, h: 0.02 }, 0.9),
          makeObject('far', { x: 0.05, y: 0.05, w: 0.02, h: 0.02 }, 0.95),
          makeObject('near-low-conf', { x: 0.55, y: 0.5, w: 0.02, h: 0.02 }, 0.4)
        ])
      ]);
      const geometry = makeGeometry([
        { fieldId: 'f1', pageIndex: 0, bbox: { x: 0.5, y: 0.5, w: 0.05, h: 0.05 } }
      ]);

      const result = evaluateStructuralDensity(model, geometry);

      expect(result.satisfiesDensity).toBe(false);
      expect(result.failingFields).toHaveLength(1);
      expect(result.failingFields[0].fieldId).toBe('f1');
      expect(result.failingFields[0].qualifyingObjectCount).toBe(1);
    });

    it('rejects objects below MIN_OBJECT_CONFIDENCE even if they are within radius', () => {
      const model = makeModel([
        makePage(0, [
          makeObject('low1', { x: 0.51, y: 0.51, w: 0.01, h: 0.01 }, MIN_OBJECT_CONFIDENCE - 0.01),
          makeObject('low2', { x: 0.52, y: 0.52, w: 0.01, h: 0.01 }, MIN_OBJECT_CONFIDENCE - 0.01)
        ])
      ]);
      const geometry = makeGeometry([
        { fieldId: 'f1', pageIndex: 0, bbox: { x: 0.5, y: 0.5, w: 0.05, h: 0.05 } }
      ]);

      const result = evaluateStructuralDensity(model, geometry);

      expect(result.satisfiesDensity).toBe(false);
      expect(result.failingFields[0].qualifyingObjectCount).toBe(0);
    });

    it('uses RADIUS_FACTOR × max(wNorm, hNorm) for the proximity radius', () => {
      // Field is 0.05 wide. Radius = RADIUS_FACTOR * 0.05 = 0.1.
      // An object at distance 0.09 from the center should qualify; at 0.11 should not.
      const fieldCenter = { x: 0.525, y: 0.525 };
      const inside = { x: fieldCenter.x + 0.09 - 0.005, y: fieldCenter.y - 0.005 };
      const outside = { x: fieldCenter.x + RADIUS_FACTOR * 0.05 + 0.01, y: fieldCenter.y - 0.005 };
      const model = makeModel([
        makePage(0, [
          makeObject('inside1', { x: inside.x, y: inside.y, w: 0.01, h: 0.01 }, 0.9),
          makeObject('inside2', { x: inside.x + 0.01, y: inside.y, w: 0.01, h: 0.01 }, 0.9),
          makeObject('outside', { x: outside.x, y: outside.y, w: 0.01, h: 0.01 }, 0.9)
        ])
      ]);
      const geometry = makeGeometry([
        { fieldId: 'f1', pageIndex: 0, bbox: { x: 0.5, y: 0.5, w: 0.05, h: 0.05 } }
      ]);

      const result = evaluateStructuralDensity(model, geometry);

      expect(result.satisfiesDensity).toBe(true);
    });

    it('treats a missing structural page as zero objects', () => {
      const model = makeModel([]);
      const geometry = makeGeometry([
        { fieldId: 'f1', pageIndex: 0, bbox: { x: 0.5, y: 0.5, w: 0.05, h: 0.05 } }
      ]);

      const result = evaluateStructuralDensity(model, geometry);

      expect(result.satisfiesDensity).toBe(false);
      expect(result.failingFields[0].qualifyingObjectCount).toBe(0);
    });

    it('marks the whole result failing when ANY field fails', () => {
      const model = makeModel([
        makePage(0, [
          makeObject('o1', { x: 0.51, y: 0.51, w: 0.01, h: 0.01 }, 0.9),
          makeObject('o2', { x: 0.52, y: 0.52, w: 0.01, h: 0.01 }, 0.9)
        ])
      ]);
      const geometry = makeGeometry([
        { fieldId: 'f1', pageIndex: 0, bbox: { x: 0.5, y: 0.5, w: 0.05, h: 0.05 } },
        { fieldId: 'f2', pageIndex: 0, bbox: { x: 0.05, y: 0.05, w: 0.05, h: 0.05 } }
      ]);

      const result = evaluateStructuralDensity(model, geometry);

      expect(result.satisfiesDensity).toBe(false);
      expect(result.passingFields.map((v) => v.fieldId)).toEqual(['f1']);
      expect(result.failingFields.map((v) => v.fieldId)).toEqual(['f2']);
    });
  });

  describe('acceptHighResModel', () => {
    it('accepts hi-res when it converts at least one previously-failing field to passing', () => {
      const normalCheck = {
        fieldsEvaluated: 2,
        failingFields: [{ fieldId: 'f1', pageIndex: 0, qualifyingObjectCount: 0, satisfiesDensity: false }],
        passingFields: [{ fieldId: 'f2', pageIndex: 0, qualifyingObjectCount: 3, satisfiesDensity: true }],
        satisfiesDensity: false
      };
      const highResCheck = {
        fieldsEvaluated: 2,
        failingFields: [],
        passingFields: [
          { fieldId: 'f1', pageIndex: 0, qualifyingObjectCount: 4, satisfiesDensity: true },
          { fieldId: 'f2', pageIndex: 0, qualifyingObjectCount: 5, satisfiesDensity: true }
        ],
        satisfiesDensity: true
      };

      expect(acceptHighResModel(normalCheck, highResCheck)).toBe(true);
    });

    it('rejects hi-res when it does not help any previously-failing field', () => {
      // Hi-res produces more passing fields globally, but none of them are
      // the field that was actually failing before. This is the "structurally
      // simple document" carve-out.
      const normalCheck = {
        fieldsEvaluated: 2,
        failingFields: [{ fieldId: 'f1', pageIndex: 0, qualifyingObjectCount: 0, satisfiesDensity: false }],
        passingFields: [{ fieldId: 'f2', pageIndex: 0, qualifyingObjectCount: 3, satisfiesDensity: true }],
        satisfiesDensity: false
      };
      const highResCheck = {
        fieldsEvaluated: 2,
        failingFields: [{ fieldId: 'f1', pageIndex: 0, qualifyingObjectCount: 1, satisfiesDensity: false }],
        passingFields: [{ fieldId: 'f2', pageIndex: 0, qualifyingObjectCount: 9, satisfiesDensity: true }],
        satisfiesDensity: false
      };

      expect(acceptHighResModel(normalCheck, highResCheck)).toBe(false);
    });

    it('returns false when normal already passed (no reason to swap)', () => {
      const normalCheck = {
        fieldsEvaluated: 1,
        failingFields: [],
        passingFields: [{ fieldId: 'f1', pageIndex: 0, qualifyingObjectCount: 5, satisfiesDensity: true }],
        satisfiesDensity: true
      };
      const highResCheck = {
        fieldsEvaluated: 1,
        failingFields: [],
        passingFields: [{ fieldId: 'f1', pageIndex: 0, qualifyingObjectCount: 12, satisfiesDensity: true }],
        satisfiesDensity: true
      };

      expect(acceptHighResModel(normalCheck, highResCheck)).toBe(false);
    });
  });
});
