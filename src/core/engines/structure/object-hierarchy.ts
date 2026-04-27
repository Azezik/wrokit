import type { NormalizedBoundingBox } from '../../contracts/geometry';
import type {
  StructuralFieldRelationship,
  StructuralNormalizedRect,
  StructuralObjectHierarchy,
  StructuralObjectNode,
  StructuralObjectType
} from '../../contracts/structural-model';

interface RawObjectInput {
  objectId: string;
  type: StructuralObjectType;
  bbox: StructuralNormalizedRect;
  confidence: number;
}

const EPS = 1e-6;

const rectArea = (rect: StructuralNormalizedRect): number => rect.wNorm * rect.hNorm;

const rectContains = (
  outer: StructuralNormalizedRect,
  inner: StructuralNormalizedRect,
  epsilon = EPS
): boolean => {
  return (
    inner.xNorm + epsilon >= outer.xNorm &&
    inner.yNorm + epsilon >= outer.yNorm &&
    inner.xNorm + inner.wNorm <= outer.xNorm + outer.wNorm + epsilon &&
    inner.yNorm + inner.hNorm <= outer.yNorm + outer.hNorm + epsilon
  );
};

const rectCenter = (rect: StructuralNormalizedRect) => ({
  x: rect.xNorm + rect.wNorm / 2,
  y: rect.yNorm + rect.hNorm / 2
});

const rectDistance = (a: StructuralNormalizedRect, b: StructuralNormalizedRect): number => {
  const ac = rectCenter(a);
  const bc = rectCenter(b);
  const dx = ac.x - bc.x;
  const dy = ac.y - bc.y;
  return Math.hypot(dx, dy);
};

const shortestDistanceToRectEdge = (
  rect: StructuralNormalizedRect,
  bbox: NormalizedBoundingBox
): number => {
  const left = bbox.xNorm - rect.xNorm;
  const top = bbox.yNorm - rect.yNorm;
  const right = rect.xNorm + rect.wNorm - (bbox.xNorm + bbox.wNorm);
  const bottom = rect.yNorm + rect.hNorm - (bbox.yNorm + bbox.hNorm);
  return Math.min(left, top, right, bottom);
};

const bboxContainsField = (bbox: StructuralNormalizedRect, field: NormalizedBoundingBox): boolean =>
  rectContains(bbox, field, EPS);

const toRect = (bbox: NormalizedBoundingBox): StructuralNormalizedRect => ({
  xNorm: bbox.xNorm,
  yNorm: bbox.yNorm,
  wNorm: bbox.wNorm,
  hNorm: bbox.hNorm
});

const nearestObjects = (
  field: NormalizedBoundingBox,
  objects: StructuralObjectNode[],
  limit = 3
): { objectId: string; distance: number }[] => {
  const fieldRect = toRect(field);
  return objects
    .map((object) => ({ objectId: object.objectId, distance: rectDistance(fieldRect, object.bbox) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
};

const findContainingObject = (
  field: NormalizedBoundingBox,
  objects: StructuralObjectNode[]
): StructuralObjectNode | null => {
  const containing = objects
    .filter((obj) => bboxContainsField(obj.bbox, field))
    .sort((a, b) => rectArea(a.bbox) - rectArea(b.bbox));
  return containing[0] ?? null;
};

const relativePositionWithinParent = (
  field: NormalizedBoundingBox,
  parent: StructuralObjectNode | null
): StructuralFieldRelationship['relativePositionWithinParent'] => {
  if (!parent) {
    return null;
  }

  const safeW = Math.max(parent.bbox.wNorm, EPS);
  const safeH = Math.max(parent.bbox.hNorm, EPS);

  return {
    xRatio: (field.xNorm - parent.bbox.xNorm) / safeW,
    yRatio: (field.yNorm - parent.bbox.yNorm) / safeH,
    widthRatio: field.wNorm / safeW,
    heightRatio: field.hNorm / safeH
  };
};

export const buildObjectHierarchy = (rawObjects: RawObjectInput[]): StructuralObjectHierarchy => {
  const nodes: StructuralObjectNode[] = rawObjects.map((obj) => ({
    objectId: obj.objectId,
    type: obj.type,
    bbox: obj.bbox,
    parentObjectId: null,
    childObjectIds: [],
    confidence: obj.confidence
  }));

  for (const node of nodes) {
    const possibleParents = nodes
      .filter((candidate) => candidate.objectId !== node.objectId)
      .filter((candidate) => rectContains(candidate.bbox, node.bbox, EPS))
      .sort((a, b) => rectArea(a.bbox) - rectArea(b.bbox));

    const parent = possibleParents[0] ?? null;
    if (parent) {
      node.parentObjectId = parent.objectId;
      parent.childObjectIds.push(node.objectId);
      if (node.type === 'container') {
        node.type = 'nested-region';
      }
    }
  }

  for (const node of nodes) {
    if (node.childObjectIds.length > 0 && node.type === 'rectangle') {
      node.type = 'group-region';
    }
  }

  return { objects: nodes };
};

export const buildFieldRelationships = (input: {
  fields: Array<{ fieldId: string; bbox: NormalizedBoundingBox }>;
  borderRect: StructuralNormalizedRect;
  refinedBorderRect: StructuralNormalizedRect;
  hierarchy: StructuralObjectHierarchy;
}): StructuralFieldRelationship[] => {
  const objects = input.hierarchy.objects;
  return input.fields.map((field) => {
    const parent = findContainingObject(field.bbox, objects);
    return {
      fieldId: field.fieldId,
      containedBy: parent?.objectId ?? null,
      nearestObjects: nearestObjects(field.bbox, objects),
      relativePositionWithinParent: relativePositionWithinParent(field.bbox, parent),
      distanceToBorder: shortestDistanceToRectEdge(input.borderRect, field.bbox),
      distanceToRefinedBorder: shortestDistanceToRectEdge(input.refinedBorderRect, field.bbox)
    };
  });
};
