/**
 * Sensitivity density check — post-geometry pass that decides whether the
 * config-time structural model has enough usable structure near each user
 * BBOX to localize them at runtime.
 *
 * For each FieldGeometry on its page, we look for at least
 * `MIN_OBJECTS_NEAR_BBOX` structural objects whose center sits within
 * `RADIUS_FACTOR × max(bbox.wNorm, bbox.hNorm)` of the BBOX center and whose
 * per-object confidence is at least `MIN_OBJECT_CONFIDENCE`. If any field
 * fails the check, the model is "sparse near at least one BBOX" and the
 * caller may rerun structural detection with a hi-res sensitivity profile.
 *
 * The check is intentionally narrow: it does not require objects to contain
 * the BBOX, does not look at object size diversity, and does not consider
 * relationship-resolver tier. Those would be acceptance-gate concerns when
 * comparing two outputs.
 */

import type { GeometryFile } from '../../contracts/geometry';
import type {
  StructuralModel,
  StructuralObjectNode,
  StructuralPage
} from '../../contracts/structural-model';

export const MIN_OBJECTS_NEAR_BBOX = 2;
export const RADIUS_FACTOR = 2;
export const MIN_OBJECT_CONFIDENCE = 0.7;

export interface FieldDensityVerdict {
  fieldId: string;
  pageIndex: number;
  qualifyingObjectCount: number;
  satisfiesDensity: boolean;
}

export interface SensitivityDensityCheckResult {
  fieldsEvaluated: number;
  failingFields: FieldDensityVerdict[];
  passingFields: FieldDensityVerdict[];
  /**
   * `true` when the model has enough structure near every field. `false`
   * when at least one field BBOX has fewer than `MIN_OBJECTS_NEAR_BBOX`
   * qualifying objects within the radius — i.e. the model is "sparse near
   * the user's geometry" and a hi-res rerun is warranted.
   */
  satisfiesDensity: boolean;
}

const objectCenter = (obj: StructuralObjectNode): { x: number; y: number } => ({
  x: obj.objectRectNorm.xNorm + obj.objectRectNorm.wNorm / 2,
  y: obj.objectRectNorm.yNorm + obj.objectRectNorm.hNorm / 2
});

const distance = (
  a: { x: number; y: number },
  b: { x: number; y: number }
): number => Math.hypot(a.x - b.x, a.y - b.y);

const evaluateFieldDensity = (
  fieldId: string,
  pageIndex: number,
  bboxCenter: { x: number; y: number },
  radius: number,
  objects: StructuralObjectNode[]
): FieldDensityVerdict => {
  let qualifyingObjectCount = 0;
  for (const obj of objects) {
    if (obj.confidence < MIN_OBJECT_CONFIDENCE) {
      continue;
    }
    if (distance(bboxCenter, objectCenter(obj)) > radius) {
      continue;
    }
    qualifyingObjectCount += 1;
    if (qualifyingObjectCount >= MIN_OBJECTS_NEAR_BBOX) {
      break;
    }
  }
  return {
    fieldId,
    pageIndex,
    qualifyingObjectCount,
    satisfiesDensity: qualifyingObjectCount >= MIN_OBJECTS_NEAR_BBOX
  };
};

export const evaluateStructuralDensity = (
  structuralModel: StructuralModel,
  geometry: GeometryFile
): SensitivityDensityCheckResult => {
  const pageByIndex = new Map<number, StructuralPage>();
  for (const page of structuralModel.pages) {
    pageByIndex.set(page.pageIndex, page);
  }

  const failingFields: FieldDensityVerdict[] = [];
  const passingFields: FieldDensityVerdict[] = [];

  for (const field of geometry.fields) {
    const page = pageByIndex.get(field.pageIndex);
    const objects = page?.objectHierarchy.objects ?? [];

    const bboxCenter = {
      x: field.bbox.xNorm + field.bbox.wNorm / 2,
      y: field.bbox.yNorm + field.bbox.hNorm / 2
    };
    const radius = RADIUS_FACTOR * Math.max(field.bbox.wNorm, field.bbox.hNorm);

    const verdict = evaluateFieldDensity(
      field.fieldId,
      field.pageIndex,
      bboxCenter,
      radius,
      objects
    );
    if (verdict.satisfiesDensity) {
      passingFields.push(verdict);
    } else {
      failingFields.push(verdict);
    }
  }

  return {
    fieldsEvaluated: geometry.fields.length,
    failingFields,
    passingFields,
    satisfiesDensity: failingFields.length === 0
  };
};

/**
 * Acceptance gate for hi-res rerun output. Hi-res is accepted only when it
 * converts at least one previously-failing field neighborhood from "sparse"
 * to "satisfies the density check". This rules out the case where hi-res
 * produces more objects globally but none of them help the fields the user
 * actually drew (the "structurally simple document" carve-out).
 */
export const acceptHighResModel = (
  normalCheck: SensitivityDensityCheckResult,
  highResCheck: SensitivityDensityCheckResult
): boolean => {
  if (normalCheck.failingFields.length === 0) {
    return false;
  }
  const previouslyFailingIds = new Set(
    normalCheck.failingFields.map((verdict) => verdict.fieldId)
  );
  for (const verdict of highResCheck.passingFields) {
    if (previouslyFailingIds.has(verdict.fieldId)) {
      return true;
    }
  }
  return false;
};
