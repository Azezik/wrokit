import type { NormalizedBoundingBox } from '../../contracts/geometry';
import type {
  StructuralFieldObjectAnchorRank,
  StructuralFieldRelationship,
  StructuralNormalizedRect,
  StructuralObjectHierarchy,
  StructuralObjectNode,
  StructuralObjectToObjectAnchorRelation,
  StructuralPageAnchorRelations,
  StructuralRelativeAnchorRect,
  StructuralStableFieldAnchorLabel
} from '../../contracts/structural-model';

interface RawObjectInput {
  objectId: string;
  bbox: StructuralNormalizedRect;
  confidence: number;
}

const EPS = 1e-6;
const MAX_FIELD_ANCHORS = 3;
const MAX_RELATION_GRAPH_OBJECTS = 12;
const NEAR_DISTANCE_THRESHOLD = 0.35;
const ADJACENT_GAP_THRESHOLD = 0.04;

const DUPLICATE_IOU_MIN = 0.85;
const DUPLICATE_AREA_RATIO_MIN = 0.85;
const DUPLICATE_ASPECT_RATIO_MIN = 0.85;

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

const rectIou = (a: StructuralNormalizedRect, b: StructuralNormalizedRect): number => {
  const interLeft = Math.max(a.xNorm, b.xNorm);
  const interTop = Math.max(a.yNorm, b.yNorm);
  const interRight = Math.min(a.xNorm + a.wNorm, b.xNorm + b.wNorm);
  const interBottom = Math.min(a.yNorm + a.hNorm, b.yNorm + b.hNorm);
  if (interRight <= interLeft || interBottom <= interTop) {
    return 0;
  }
  const inter = (interRight - interLeft) * (interBottom - interTop);
  const union = rectArea(a) + rectArea(b) - inter;
  return union <= 0 ? 0 : inter / union;
};

/**
 * Predicate for "these two rects are near-duplicate detections of the same
 * visual object". Mirrors the cross-pipeline predicate in the CV adapter:
 * high IoU + similar area + similar aspect ratio + neither rect strictly
 * containing the other. The area-ratio gate alone preserves valid nesting,
 * because a child fully inside a parent has area ratio < 1.0 unless the
 * rects are the same size — at which point the containment exclusion is the
 * final guard.
 */
const isDuplicateOf = (
  a: StructuralNormalizedRect,
  b: StructuralNormalizedRect
): boolean => {
  const areaA = rectArea(a);
  const areaB = rectArea(b);
  if (areaA <= 0 || areaB <= 0) {
    return false;
  }
  if (rectIou(a, b) < DUPLICATE_IOU_MIN) {
    return false;
  }
  const areaRatio = Math.min(areaA, areaB) / Math.max(areaA, areaB);
  if (areaRatio < DUPLICATE_AREA_RATIO_MIN) {
    return false;
  }
  const arA = a.wNorm / Math.max(EPS, a.hNorm);
  const arB = b.wNorm / Math.max(EPS, b.hNorm);
  const arRatio = Math.min(arA, arB) / Math.max(arA, arB);
  if (arRatio < DUPLICATE_ASPECT_RATIO_MIN) {
    return false;
  }
  if (rectContains(a, b, EPS) || rectContains(b, a, EPS)) {
    return false;
  }
  return true;
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

/**
 * Walk the structural containment chain from the smallest object that contains the
 * field outward through its parents. The first chain entry is the direct container
 * (smallest enclosing object), the next is its structural parent, and so on. This
 * mirrors the mental model `field → container → parent → grandparent → …` that
 * Run Mode relocation depends on.
 *
 * The chain is the AUTHORITY for stable anchors. Center-distance ranking is only
 * used as contingency to fill anchor slots when the chain is shorter than the
 * requested limit.
 */
const buildContainmentChain = (
  field: NormalizedBoundingBox,
  objects: StructuralObjectNode[],
  limit = MAX_FIELD_ANCHORS
): StructuralObjectNode[] => {
  const direct = findContainingObject(field, objects);
  if (!direct) {
    return [];
  }

  const objectsById = new Map<string, StructuralObjectNode>(
    objects.map((object) => [object.objectId, object])
  );
  const chain: StructuralObjectNode[] = [direct];
  const seen = new Set<string>([direct.objectId]);

  let cursor: StructuralObjectNode | null = direct;
  while (chain.length < limit && cursor?.parentObjectId) {
    if (seen.has(cursor.parentObjectId)) {
      break;
    }
    const parent: StructuralObjectNode | null = objectsById.get(cursor.parentObjectId) ?? null;
    if (!parent) {
      break;
    }
    chain.push(parent);
    seen.add(parent.objectId);
    cursor = parent;
  }

  return chain;
};

/**
 * Pick supplemental anchor objects when the containment chain has fewer than
 * `limit` entries. Preference order:
 *   1. other objects that fully contain the field (different chain branches),
 *   2. objects that overlap the field (partial structural support),
 *   3. nearest objects by center distance (final contingency only).
 *
 * Anchors already in the chain are excluded so each anchor slot points at a
 * distinct structural object.
 */
const selectFallbackAnchorObjects = (
  field: NormalizedBoundingBox,
  objects: StructuralObjectNode[],
  excludeIds: Set<string>,
  needed: number
): StructuralObjectNode[] => {
  if (needed <= 0) {
    return [];
  }
  const fieldRect = toRect(field);
  const candidates = objects.filter((object) => !excludeIds.has(object.objectId));

  const containers = candidates
    .filter((object) => bboxContainsField(object.objectRectNorm, field))
    .sort((a, b) => rectArea(a.objectRectNorm) - rectArea(b.objectRectNorm));

  const overlappers = candidates
    .filter((object) => !bboxContainsField(object.objectRectNorm, field))
    .filter((object) => {
      const xOverlap = overlapSpan(
        object.objectRectNorm.xNorm,
        object.objectRectNorm.xNorm + object.objectRectNorm.wNorm,
        fieldRect.xNorm,
        fieldRect.xNorm + fieldRect.wNorm
      );
      const yOverlap = overlapSpan(
        object.objectRectNorm.yNorm,
        object.objectRectNorm.yNorm + object.objectRectNorm.hNorm,
        fieldRect.yNorm,
        fieldRect.yNorm + fieldRect.hNorm
      );
      return xOverlap > EPS && yOverlap > EPS;
    })
    .sort((a, b) => rectDistance(fieldRect, a.objectRectNorm) - rectDistance(fieldRect, b.objectRectNorm));

  const nearest = candidates
    .slice()
    .sort(
      (a, b) =>
        rectDistance(fieldRect, a.objectRectNorm) - rectDistance(fieldRect, b.objectRectNorm) ||
        a.objectId.localeCompare(b.objectId)
    );

  const ordered: StructuralObjectNode[] = [];
  const taken = new Set<string>();
  for (const pool of [containers, overlappers, nearest]) {
    for (const object of pool) {
      if (ordered.length >= needed) {
        return ordered;
      }
      if (taken.has(object.objectId)) {
        continue;
      }
      taken.add(object.objectId);
      ordered.push(object);
    }
  }
  return ordered;
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

/**
 * Build the object hierarchy from raw, unclassified rects.
 *
 * Every input is just an object. The hierarchy is determined purely by
 * geometric containment: the smallest enclosing rect becomes the parent.
 * No object is treated as semantically special — a ruled grid is simply a
 * parent object with many child objects, a form section is just an object
 * with child objects, a standalone box is an object with no children.
 */
export const buildObjectHierarchy = (rawObjects: RawObjectInput[]): StructuralObjectHierarchy => {
  const nodes: StructuralObjectNode[] = rawObjects.map((obj) => ({
    objectId: obj.objectId,
    objectRectNorm: obj.bbox,
    bbox: obj.bbox,
    parentObjectId: null,
    childObjectIds: [],
    confidence: obj.confidence,
    depth: 0
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
    }
  }

  // Sibling dedup: within each parent group (including rootless nodes), drop
  // near-duplicate detections of the same visual object. Containment is
  // preserved because a contained child is never a sibling of its parent —
  // they live in different parent groups. Tiebreak: larger area wins, ties
  // broken by objectId for determinism.
  const survivingNodes = applySiblingDedup(nodes);

  // Compute depth by walking up to a parentless ancestor. Done after parent
  // links are established so cycles (which shouldn't happen, but guard anyway)
  // do not infinite-loop the walk.
  const nodeById = new Map(survivingNodes.map((node) => [node.objectId, node]));
  for (const node of survivingNodes) {
    let depth = 0;
    let cursor = node.parentObjectId ? nodeById.get(node.parentObjectId) ?? null : null;
    const seen = new Set<string>([node.objectId]);
    while (cursor && !seen.has(cursor.objectId)) {
      seen.add(cursor.objectId);
      depth += 1;
      cursor = cursor.parentObjectId ? nodeById.get(cursor.parentObjectId) ?? null : null;
    }
    node.depth = depth;
  }

  return { objects: survivingNodes };
};

const applySiblingDedup = (nodes: StructuralObjectNode[]): StructuralObjectNode[] => {
  if (nodes.length <= 1) {
    return nodes;
  }

  const groups = new Map<string | null, StructuralObjectNode[]>();
  for (const node of nodes) {
    const key = node.parentObjectId;
    const list = groups.get(key);
    if (list) {
      list.push(node);
    } else {
      groups.set(key, [node]);
    }
  }

  const removedIds = new Set<string>();
  const replacements = new Map<string, string>();

  for (const siblings of groups.values()) {
    if (siblings.length < 2) {
      continue;
    }
    const sorted = [...siblings].sort((a, b) => {
      const areaA = rectArea(a.objectRectNorm);
      const areaB = rectArea(b.objectRectNorm);
      if (areaA !== areaB) {
        return areaB - areaA;
      }
      return a.objectId.localeCompare(b.objectId);
    });
    const kept: StructuralObjectNode[] = [];
    for (const candidate of sorted) {
      let dupOf: StructuralObjectNode | null = null;
      for (const winner of kept) {
        if (isDuplicateOf(candidate.objectRectNorm, winner.objectRectNorm)) {
          dupOf = winner;
          break;
        }
      }
      if (dupOf) {
        removedIds.add(candidate.objectId);
        replacements.set(candidate.objectId, dupOf.objectId);
      } else {
        kept.push(candidate);
      }
    }
  }

  if (removedIds.size === 0) {
    return nodes;
  }

  const resolveReplacement = (id: string): string => {
    let cursor = id;
    const seen = new Set<string>();
    while (replacements.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = replacements.get(cursor) as string;
    }
    return cursor;
  };

  // Reassign children of removed parents to the surviving winner so the
  // hierarchy stays connected.
  for (const node of nodes) {
    if (node.parentObjectId && replacements.has(node.parentObjectId)) {
      node.parentObjectId = resolveReplacement(node.parentObjectId);
    }
  }

  const survivors = nodes.filter((node) => !removedIds.has(node.objectId));

  // Rewrite each survivor's childObjectIds to drop removed nodes and inherit
  // any orphaned children from removed duplicates.
  const childIdsByParent = new Map<string, string[]>();
  for (const survivor of survivors) {
    childIdsByParent.set(survivor.objectId, []);
  }
  for (const survivor of survivors) {
    if (survivor.parentObjectId && childIdsByParent.has(survivor.parentObjectId)) {
      childIdsByParent.get(survivor.parentObjectId)!.push(survivor.objectId);
    }
  }
  for (const survivor of survivors) {
    const updated = childIdsByParent.get(survivor.objectId) ?? [];
    const seen = new Set<string>();
    survivor.childObjectIds = updated.filter((id) => {
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
  }

  return survivors;
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

    // Containment chain authority: A = direct container, B = its parent,
    // C = grandparent. This is the structural map that Run Mode relocation
    // walks: field → containing object → parent object → … → Refined → Border.
    const containmentChain = buildContainmentChain(field.bbox, objects, MAX_FIELD_ANCHORS);
    const directContainer = containmentChain[0] ?? null;

    const usedIds = new Set(containmentChain.map((object) => object.objectId));
    const supplemental =
      containmentChain.length < MAX_FIELD_ANCHORS
        ? selectFallbackAnchorObjects(
            field.bbox,
            objects,
            usedIds,
            MAX_FIELD_ANCHORS - containmentChain.length
          )
        : [];

    const anchorObjects: StructuralObjectNode[] = [...containmentChain, ...supplemental];

    const nearestForLegacy = nearestObjects(field.bbox, objects, MAX_FIELD_ANCHORS);

    const stableAnchors = anchorObjects.map((object, index) => ({
      label: stableAnchorLabel(index),
      objectId: object.objectId,
      distance: rectDistance(fieldRect, object.objectRectNorm),
      relativeFieldRect: relativeRect(fieldRect, object.objectRectNorm)
    }));

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
      // `containedBy` mirrors the direct container (A in the chain) so legacy
      // readers see the same structural authority the new anchors expose.
      containedBy: directContainer?.objectId ?? null,
      nearestObjects: nearestForLegacy,
      relativePositionWithinParent: relativePositionWithinParent(field.bbox, directContainer),
      distanceToBorder: fieldAnchors.borderAnchor.distanceToEdge,
      distanceToRefinedBorder: fieldAnchors.refinedBorderAnchor.distanceToEdge
    };
  });
};

export const __testing = {
  buildContainmentChain,
  selectFallbackAnchorObjects
};
