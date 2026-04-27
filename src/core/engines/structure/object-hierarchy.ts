import type { NormalizedBoundingBox } from '../../contracts/geometry';
import type {
  StructuralFieldRelationship,
  StructuralNormalizedRect,
  StructuralObjectHierarchy,
  StructuralObjectNode,
  StructuralObjectType,
  StructuralPageAnchorRelations,
  StructuralRelativeAnchorRect
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

const relativeRect = (
  subject: StructuralNormalizedRect,
  anchor: StructuralNormalizedRect
): StructuralRelativeAnchorRect => {
  const safeW = Math.max(anchor.wNorm, EPS);
  const safeH = Math.max(anchor.hNorm, EPS);

  return {
    xRatio: (subject.xNorm - anchor.xNorm) / safeW,
    yRatio: (subject.yNorm - anchor.yNorm) / safeH,
    wRatio: subject.wNorm / safeW,
    hRatio: subject.hNorm / safeH
  };
};

const nearestObjects = (
  field: NormalizedBoundingBox,
  objects: StructuralObjectNode[],
  limit = 3
): { objectId: string; distance: number }[] => {
  const fieldRect = toRect(field);
  return objects
    .map((object) => ({ objectId: object.objectId, distance: rectDistance(fieldRect, object.objectRectNorm) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
};

const findContainingObject = (
  field: NormalizedBoundingBox,
  objects: StructuralObjectNode[]
): StructuralObjectNode | null => {
  const containing = objects
    .filter((obj) => bboxContainsField(obj.objectRectNorm, field))
    .sort((a, b) => rectArea(a.objectRectNorm) - rectArea(b.objectRectNorm));
  return containing[0] ?? null;
};

const relativePositionWithinParent = (
  field: NormalizedBoundingBox,
  parent: StructuralObjectNode | null
): StructuralFieldRelationship['relativePositionWithinParent'] => {
  if (!parent) {
    return null;
  }

  const safeW = Math.max(parent.objectRectNorm.wNorm, EPS);
  const safeH = Math.max(parent.objectRectNorm.hNorm, EPS);

  return {
    xRatio: (field.xNorm - parent.objectRectNorm.xNorm) / safeW,
    yRatio: (field.yNorm - parent.objectRectNorm.yNorm) / safeH,
    widthRatio: field.wNorm / safeW,
    heightRatio: field.hNorm / safeH
  };
};

export const buildObjectHierarchy = (rawObjects: RawObjectInput[]): StructuralObjectHierarchy => {
  const nodes: StructuralObjectNode[] = rawObjects.map((obj) => ({
    objectId: obj.objectId,
    type: obj.type,
    objectRectNorm: obj.bbox,
    // Compatibility mirror of machine object rect.
    bbox: obj.bbox,
    parentObjectId: null,
    childObjectIds: [],
    confidence: obj.confidence
  }));

  for (const node of nodes) {
    const possibleParents = nodes
      .filter((candidate) => candidate.objectId !== node.objectId)
      .filter((candidate) => rectContains(candidate.objectRectNorm, node.objectRectNorm, EPS))
      .sort((a, b) => rectArea(a.objectRectNorm) - rectArea(b.objectRectNorm));

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

export const buildPageAnchorRelations = (input: {
  hierarchy: StructuralObjectHierarchy;
  refinedBorderRect: StructuralNormalizedRect;
  borderRect: StructuralNormalizedRect;
}): StructuralPageAnchorRelations => {
  const objects = input.hierarchy.objects;
  const objectToObject = objects
    .flatMap((object) =>
      object.childObjectIds.map((childObjectId) => {
        const child = objects.find((candidate) => candidate.objectId === childObjectId);
        if (!child) {
          return null;
        }
        return {
          fromObjectId: object.objectId,
          toObjectId: child.objectId,
          relativeRect: relativeRect(child.objectRectNorm, object.objectRectNorm)
        };
      })
    )
    .filter((relation): relation is NonNullable<typeof relation> => relation !== null);

  return {
    objectToObject,
    objectToRefinedBorder: objects.map((object) => ({
      objectId: object.objectId,
      relativeRect: relativeRect(object.objectRectNorm, input.refinedBorderRect)
    })),
    refinedBorderToBorder: {
      relativeRect: relativeRect(input.refinedBorderRect, input.borderRect)
    }
  };
};

export const buildFieldRelationships = (input: {
  fields: Array<{ fieldId: string; bbox: NormalizedBoundingBox }>;
  borderRect: StructuralNormalizedRect;
  refinedBorderRect: StructuralNormalizedRect;
  hierarchy: StructuralObjectHierarchy;
}): StructuralFieldRelationship[] => {
  const objects = input.hierarchy.objects;
  return input.fields.map((field) => {
    const fieldRect = toRect(field.bbox);
    const parent = findContainingObject(field.bbox, objects);
    const nearest = nearestObjects(field.bbox, objects);

    const fieldAnchors = {
      objectAnchors: nearest.map((object, index) => ({
        rank: (index === 0 ? 'primary' : index === 1 ? 'secondary' : 'tertiary') as
          | 'primary'
          | 'secondary'
          | 'tertiary',
        objectId: object.objectId,
        relativeFieldRect: relativeRect(
          fieldRect,
          objects.find((candidate) => candidate.objectId === object.objectId)?.objectRectNorm ??
            input.refinedBorderRect
        )
      })),
      refinedBorderAnchor: {
        relativeFieldRect: relativeRect(fieldRect, input.refinedBorderRect),
        distanceToEdge: shortestDistanceToRectEdge(input.refinedBorderRect, field.bbox)
      },
      borderAnchor: {
        relativeFieldRect: relativeRect(fieldRect, input.borderRect),
        distanceToEdge: shortestDistanceToRectEdge(input.borderRect, field.bbox)
      }
    };

    return {
      fieldId: field.fieldId,
      fieldAnchors,
      // Legacy fields kept for compatibility while consumers migrate.
      containedBy: parent?.objectId ?? null,
      nearestObjects: nearest,
      relativePositionWithinParent: relativePositionWithinParent(field.bbox, parent),
      distanceToBorder: fieldAnchors.borderAnchor.distanceToEdge,
      distanceToRefinedBorder: fieldAnchors.refinedBorderAnchor.distanceToEdge
    };
  });
};
