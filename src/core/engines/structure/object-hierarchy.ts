import type { NormalizedBoundingBox } from '../../contracts/geometry';
import type {
  StructuralFieldObjectAnchorRank,
  StructuralFieldRelationship,
  StructuralNormalizedRect,
  StructuralObjectHierarchy,
  StructuralObjectNode,
  StructuralObjectToObjectAnchorRelation,
  StructuralObjectType,
  StructuralPageAnchorRelations,
  StructuralRelativeAnchorRect,
  StructuralStableFieldAnchorLabel
} from '../../contracts/structural-model';

interface RawObjectInput {
  objectId: string;
  type: StructuralObjectType;
  bbox: StructuralNormalizedRect;
  confidence: number;
}

const EPS = 1e-6;
const MAX_FIELD_ANCHORS = 3;
const MAX_RELATION_GRAPH_OBJECTS = 12;
const NEAR_DISTANCE_THRESHOLD = 0.35;
const ADJACENT_GAP_THRESHOLD = 0.04;

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

const overlapSpan = (aStart: number, aEnd: number, bStart: number, bEnd: number): number =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

const gapSpan = (aStart: number, aEnd: number, bStart: number, bEnd: number): number => {
  if (aEnd < bStart) {
    return bStart - aEnd;
  }
  if (bEnd < aStart) {
    return aStart - bEnd;
  }
  return 0;
};

const areAdjacent = (a: StructuralNormalizedRect, b: StructuralNormalizedRect): boolean => {
  const xOverlap = overlapSpan(a.xNorm, a.xNorm + a.wNorm, b.xNorm, b.xNorm + b.wNorm);
  const yOverlap = overlapSpan(a.yNorm, a.yNorm + a.hNorm, b.yNorm, b.yNorm + b.hNorm);
  const xGap = gapSpan(a.xNorm, a.xNorm + a.wNorm, b.xNorm, b.xNorm + b.wNorm);
  const yGap = gapSpan(a.yNorm, a.yNorm + a.hNorm, b.yNorm, b.yNorm + b.hNorm);

  const horizontalAdjacency = yOverlap > EPS && xGap > EPS && xGap <= ADJACENT_GAP_THRESHOLD;
  const verticalAdjacency = xOverlap > EPS && yGap > EPS && yGap <= ADJACENT_GAP_THRESHOLD;

  return horizontalAdjacency || verticalAdjacency;
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
  limit = MAX_FIELD_ANCHORS
): { objectId: string; distance: number }[] => {
  const fieldRect = toRect(field);
  return objects
    .map((object) => ({ objectId: object.objectId, distance: rectDistance(fieldRect, object.objectRectNorm) }))
    .sort((a, b) => a.distance - b.distance || a.objectId.localeCompare(b.objectId))
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

const sortedTopRankedObjects = (objects: StructuralObjectNode[]): StructuralObjectNode[] => {
  return [...objects]
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        rectArea(b.objectRectNorm) - rectArea(a.objectRectNorm) ||
        a.objectId.localeCompare(b.objectId)
    )
    .slice(0, MAX_RELATION_GRAPH_OBJECTS);
};

const buildObjectRelationGraph = (
  objects: StructuralObjectNode[]
): StructuralObjectToObjectAnchorRelation[] => {
  const rankedObjects = sortedTopRankedObjects(objects);
  const relations: Omit<StructuralObjectToObjectAnchorRelation, 'fallbackOrder'>[] = [];

  for (let i = 0; i < rankedObjects.length; i += 1) {
    for (let j = 0; j < rankedObjects.length; j += 1) {
      if (i === j) {
        continue;
      }

      const source = rankedObjects[i];
      const target = rankedObjects[j];
      const distance = rectDistance(source.objectRectNorm, target.objectRectNorm);

      let relationKind: StructuralObjectToObjectAnchorRelation['relationKind'] | null = null;

      if (rectContains(source.objectRectNorm, target.objectRectNorm, EPS)) {
        relationKind = 'container';
      } else if (source.parentObjectId && source.parentObjectId === target.parentObjectId) {
        relationKind = 'sibling';
      } else if (areAdjacent(source.objectRectNorm, target.objectRectNorm)) {
        relationKind = 'adjacent';
      } else if (distance <= NEAR_DISTANCE_THRESHOLD) {
        relationKind = 'near';
      }

      if (!relationKind) {
        continue;
      }

      relations.push({
        fromObjectId: source.objectId,
        toObjectId: target.objectId,
        relationKind,
        relativeRect: relativeRect(target.objectRectNorm, source.objectRectNorm),
        distance
      });
    }
  }

  const relationPriority = {
    container: 0,
    sibling: 1,
    adjacent: 2,
    near: 3
  } as const;

  return relations
    .sort(
      (a, b) =>
        relationPriority[a.relationKind] - relationPriority[b.relationKind] ||
        a.distance - b.distance ||
        a.fromObjectId.localeCompare(b.fromObjectId) ||
        a.toObjectId.localeCompare(b.toObjectId)
    )
    .map((relation, index) => ({
      ...relation,
      fallbackOrder: index
    }));
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
  const objectToObject = buildObjectRelationGraph(objects);

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

const objectAnchorRank = (index: number): StructuralFieldObjectAnchorRank =>
  index === 0 ? 'primary' : index === 1 ? 'secondary' : 'tertiary';

const stableAnchorLabel = (index: number): StructuralStableFieldAnchorLabel =>
  index === 0 ? 'A' : index === 1 ? 'B' : 'C';

export const buildFieldRelationships = (input: {
  fields: Array<{ fieldId: string; bbox: NormalizedBoundingBox }>;
  borderRect: StructuralNormalizedRect;
  refinedBorderRect: StructuralNormalizedRect;
  hierarchy: StructuralObjectHierarchy;
}): StructuralFieldRelationship[] => {
  const objects = input.hierarchy.objects;
  const relations = buildObjectRelationGraph(objects);

  return input.fields.map((field) => {
    const fieldRect = toRect(field.bbox);
    const parent = findContainingObject(field.bbox, objects);
    const nearest = nearestObjects(field.bbox, objects, MAX_FIELD_ANCHORS);

    const stableAnchors = nearest.map((object, index) => {
      const anchorObject = objects.find((candidate) => candidate.objectId === object.objectId);
      const anchorRect = anchorObject?.objectRectNorm ?? input.refinedBorderRect;
      return {
        label: stableAnchorLabel(index),
        objectId: object.objectId,
        distance: object.distance,
        relativeFieldRect: relativeRect(fieldRect, anchorRect)
      };
    });

    const anchorByObjectId = new Map(stableAnchors.map((anchor) => [anchor.objectId, anchor]));

    const objectAnchorGraph = relations
      .filter(
        (relation) => anchorByObjectId.has(relation.fromObjectId) && anchorByObjectId.has(relation.toObjectId)
      )
      .map((relation) => ({
        fromAnchor: anchorByObjectId.get(relation.fromObjectId)?.label ?? 'A',
        toAnchor: anchorByObjectId.get(relation.toObjectId)?.label ?? 'A',
        fromObjectId: relation.fromObjectId,
        toObjectId: relation.toObjectId,
        relationKind: relation.relationKind,
        fallbackOrder: relation.fallbackOrder,
        relativeRect: relation.relativeRect
      }));

    const fieldAnchors = {
      objectAnchors: stableAnchors.map((anchor, index) => ({
        rank: objectAnchorRank(index),
        objectId: anchor.objectId,
        relativeFieldRect: anchor.relativeFieldRect
      })),
      stableObjectAnchors: stableAnchors,
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
      objectAnchorGraph,
      // Legacy fields kept for compatibility while consumers migrate.
      containedBy: parent?.objectId ?? null,
      nearestObjects: nearest,
      relativePositionWithinParent: relativePositionWithinParent(field.bbox, parent),
      distanceToBorder: fieldAnchors.borderAnchor.distanceToEdge,
      distanceToRefinedBorder: fieldAnchors.refinedBorderAnchor.distanceToEdge
    };
  });
};
