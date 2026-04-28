import type {
  FieldGeometry,
  GeometryFile,
  NormalizedBoundingBox,
  PixelBoundingBox
} from '../contracts/geometry';
import type { NormalizedPage } from '../contracts/normalized-page';
import {
  type PredictedFieldGeometry,
  type PredictedGeometryFile,
  type RuntimeAnchorTier,
  type RuntimeObjectMatchStrategy,
  type RuntimeStructuralTransform
} from '../contracts/predicted-geometry-file';
import type {
  StructuralFieldRelationship,
  StructuralModel,
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralPage,
  StructuralRelativeAnchorRect,
  StructuralStableFieldAnchorLabel
} from '../contracts/structural-model';
import { getPageSurface } from '../page-surface/page-surface';

export type {
  PredictedFieldGeometry,
  PredictedGeometryFile,
  RuntimeAnchorTier,
  RuntimeObjectMatchStrategy,
  RuntimeStructuralTransform
};

export interface LocalizationRunnerInput {
  wizardId: string;
  configGeometry: GeometryFile;
  configStructuralModel: StructuralModel;
  runtimeStructuralModel: StructuralModel;
  runtimePages: NormalizedPage[];
  predictedId?: string;
  nowIso?: string;
}

export interface LocalizationRunner {
  run(input: LocalizationRunnerInput): Promise<PredictedGeometryFile>;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const generateId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pred_${crypto.randomUUID()}`;
  }
  return `pred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const getStructuralPage = (model: StructuralModel, pageIndex: number): StructuralPage => {
  const page = model.pages.find((entry) => entry.pageIndex === pageIndex);
  if (!page) {
    throw new Error(`StructuralModel ${model.id} missing page ${pageIndex}.`);
  }
  return page;
};

const getFieldRelationship = (
  page: StructuralPage,
  fieldId: string
): StructuralFieldRelationship | undefined =>
  page.fieldRelationships.find((relationship) => relationship.fieldId === fieldId);

const stableAnchorLabelRank = (label: StructuralStableFieldAnchorLabel): number =>
  label === 'A' ? 0 : label === 'B' ? 1 : 2;

const getObjectById = (
  page: StructuralPage,
  objectId: string | null | undefined
): StructuralObjectNode | undefined => {
  if (!objectId) {
    return undefined;
  }
  return page.objectHierarchy.objects.find((object) => object.objectId === objectId);
};

const getObjectDepth = (page: StructuralPage, objectId: string): number => {
  let depth = 0;
  let cursor = getObjectById(page, objectId);
  const seen = new Set<string>();

  while (cursor?.parentObjectId) {
    if (seen.has(cursor.objectId)) {
      break;
    }
    seen.add(cursor.objectId);
    depth += 1;
    cursor = getObjectById(page, cursor.parentObjectId);
  }

  return depth;
};

const getAncestorIds = (page: StructuralPage, objectId: string): Set<string> => {
  const ancestors = new Set<string>();
  let cursor = getObjectById(page, objectId);
  const seen = new Set<string>();

  while (cursor?.parentObjectId) {
    if (seen.has(cursor.objectId)) {
      break;
    }
    seen.add(cursor.objectId);
    ancestors.add(cursor.parentObjectId);
    cursor = getObjectById(page, cursor.parentObjectId);
  }

  return ancestors;
};

const resolveAnchorPriority = (
  page: StructuralPage,
  relationship: StructuralFieldRelationship,
  anchorObjectId: string
): number => {
  const containingObjectId = relationship.containedBy;
  if (!containingObjectId) {
    return 4;
  }

  if (anchorObjectId === containingObjectId) {
    return 0;
  }

  const containingObject = getObjectById(page, containingObjectId);
  if (!containingObject) {
    return 4;
  }

  const containingAncestors = getAncestorIds(page, containingObjectId);
  if (containingAncestors.has(anchorObjectId)) {
    return 1;
  }

  const anchorObject = getObjectById(page, anchorObjectId);
  if (anchorObject && containingObject.parentObjectId && anchorObject.parentObjectId === containingObject.parentObjectId) {
    return 2;
  }

  const relation = page.pageAnchorRelations.objectToObject.find(
    (item) => item.fromObjectId === containingObjectId && item.toObjectId === anchorObjectId
  );
  if (relation?.relationKind === 'adjacent') {
    return 3;
  }

  return 4;
};

const sortStableAnchors = (
  page: StructuralPage,
  relationship: StructuralFieldRelationship
): StructuralFieldRelationship['fieldAnchors']['stableObjectAnchors'] =>
  [...relationship.fieldAnchors.stableObjectAnchors].sort((left, right) => {
    const leftPriority = resolveAnchorPriority(page, relationship, left.objectId);
    const rightPriority = resolveAnchorPriority(page, relationship, right.objectId);
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return stableAnchorLabelRank(left.label) - stableAnchorLabelRank(right.label);
  });

const toPixelBbox = (bbox: NormalizedBoundingBox, page: NormalizedPage): PixelBoundingBox => ({
  x: bbox.xNorm * page.width,
  y: bbox.yNorm * page.height,
  width: bbox.wNorm * page.width,
  height: bbox.hNorm * page.height
});

const solveRectTransform = (
  pageIndex: number,
  basis: RuntimeAnchorTier,
  sourceConfigRectNorm: StructuralNormalizedRect,
  sourceRuntimeRectNorm: StructuralNormalizedRect,
  details?: Pick<RuntimeStructuralTransform, 'configObjectId' | 'runtimeObjectId' | 'objectMatchStrategy'>
): RuntimeStructuralTransform => {
  const configWidth = Math.max(sourceConfigRectNorm.wNorm, 1e-9);
  const configHeight = Math.max(sourceConfigRectNorm.hNorm, 1e-9);
  const scaleX = sourceRuntimeRectNorm.wNorm / configWidth;
  const scaleY = sourceRuntimeRectNorm.hNorm / configHeight;
  const translateX = sourceRuntimeRectNorm.xNorm - sourceConfigRectNorm.xNorm * scaleX;
  const translateY = sourceRuntimeRectNorm.yNorm - sourceConfigRectNorm.yNorm * scaleY;

  return {
    pageIndex,
    basis,
    sourceConfigRectNorm: { ...sourceConfigRectNorm },
    sourceRuntimeRectNorm: { ...sourceRuntimeRectNorm },
    scaleX,
    scaleY,
    translateX,
    translateY,
    ...details
  };
};

const applyTransformToBox = (
  sourceBox: NormalizedBoundingBox,
  transform: RuntimeStructuralTransform
): NormalizedBoundingBox => {
  const left = sourceBox.xNorm * transform.scaleX + transform.translateX;
  const top = sourceBox.yNorm * transform.scaleY + transform.translateY;
  const width = sourceBox.wNorm * transform.scaleX;
  const height = sourceBox.hNorm * transform.scaleY;

  const clampedLeft = clamp01(left);
  const clampedTop = clamp01(top);
  const clampedRight = clamp01(left + width);
  const clampedBottom = clamp01(top + height);

  return {
    xNorm: clampedLeft,
    yNorm: clampedTop,
    wNorm: clamp01(clampedRight - clampedLeft),
    hNorm: clamp01(clampedBottom - clampedTop)
  };
};

const projectRelativeRect = (
  relativeRect: StructuralRelativeAnchorRect,
  anchorRect: StructuralNormalizedRect
): NormalizedBoundingBox => {
  const xNorm = anchorRect.xNorm + relativeRect.xRatio * anchorRect.wNorm;
  const yNorm = anchorRect.yNorm + relativeRect.yRatio * anchorRect.hNorm;
  const wNorm = relativeRect.wRatio * anchorRect.wNorm;
  const hNorm = relativeRect.hRatio * anchorRect.hNorm;

  return {
    xNorm: clamp01(xNorm),
    yNorm: clamp01(yNorm),
    wNorm: clamp01(wNorm),
    hNorm: clamp01(hNorm)
  };
};

const geometryDistance = (a: StructuralNormalizedRect, b: StructuralNormalizedRect): number => {
  const aCenterX = a.xNorm + a.wNorm / 2;
  const aCenterY = a.yNorm + a.hNorm / 2;
  const bCenterX = b.xNorm + b.wNorm / 2;
  const bCenterY = b.yNorm + b.hNorm / 2;

  return (
    Math.abs(aCenterX - bCenterX) +
    Math.abs(aCenterY - bCenterY) +
    Math.abs(a.wNorm - b.wNorm) +
    Math.abs(a.hNorm - b.hNorm)
  );
};

const getAncestorTypeChain = (
  page: StructuralPage,
  objectId: string
): StructuralObjectNode['type'][] => {
  const chain: StructuralObjectNode['type'][] = [];
  const seen = new Set<string>();
  let cursor = getObjectById(page, objectId);
  while (cursor?.parentObjectId) {
    if (seen.has(cursor.objectId)) {
      break;
    }
    seen.add(cursor.objectId);
    const parent = getObjectById(page, cursor.parentObjectId);
    if (!parent) {
      break;
    }
    chain.push(parent.type);
    cursor = parent;
  }
  return chain;
};

const ancestorChainMismatchCount = (
  configChain: StructuralObjectNode['type'][],
  runtimeChain: StructuralObjectNode['type'][]
): number => {
  const length = Math.min(configChain.length, runtimeChain.length);
  let mismatches = 0;
  for (let i = 0; i < length; i += 1) {
    if (configChain[i] !== runtimeChain[i]) {
      mismatches += 1;
    }
  }
  // Penalize chain-length deltas too — a runtime object missing an ancestor is
  // structurally weaker than one whose chain matches end-to-end.
  return mismatches + Math.abs(configChain.length - runtimeChain.length);
};

const hierarchyRoleDistance = (
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  configObject: StructuralObjectNode,
  runtimeObject: StructuralObjectNode
): [number, number, number, number] => {
  const configParent = getObjectById(configPage, configObject.parentObjectId);
  const runtimeParent = getObjectById(runtimePage, runtimeObject.parentObjectId);

  const childPresencePenalty = Number((configObject.childObjectIds.length > 0) !== (runtimeObject.childObjectIds.length > 0));
  const depthPenalty = Math.abs(getObjectDepth(configPage, configObject.objectId) - getObjectDepth(runtimePage, runtimeObject.objectId));
  const parentTypePenalty = Number(Boolean(configParent?.type) !== Boolean(runtimeParent?.type) || (configParent?.type && runtimeParent?.type && configParent.type !== runtimeParent.type));
  const ancestorChainPenalty = ancestorChainMismatchCount(
    getAncestorTypeChain(configPage, configObject.objectId),
    getAncestorTypeChain(runtimePage, runtimeObject.objectId)
  );

  // Ancestor chain mismatch is the strongest structural signal — a runtime
  // object whose full ancestry matches is far more trustworthy than one that
  // only happens to share an immediate parent type.
  return [ancestorChainPenalty, childPresencePenalty, depthPenalty, parentTypePenalty];
};

const resolveRuntimeObject = (
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  configObjectId: string
): { object: StructuralObjectNode; strategy: RuntimeObjectMatchStrategy } | null => {
  const configObject = configPage.objectHierarchy.objects.find((object) => object.objectId === configObjectId);

  const runtimeById = runtimePage.objectHierarchy.objects.find((object) => object.objectId === configObjectId);
  if (runtimeById && (!configObject || runtimeById.type === configObject.type)) {
    return {
      object: runtimeById,
      strategy: 'id'
    };
  }

  if (!configObject) {
    return null;
  }

  const sameType = runtimePage.objectHierarchy.objects
    .filter((object) => object.type === configObject.type)
    .map((object) => ({
      object,
      hierarchyRole: hierarchyRoleDistance(configPage, runtimePage, configObject, object),
      distance: geometryDistance(configObject.objectRectNorm, object.objectRectNorm)
    }))
    .sort((left, right) => {
      for (let i = 0; i < left.hierarchyRole.length; i += 1) {
        if (left.hierarchyRole[i] !== right.hierarchyRole[i]) {
          return left.hierarchyRole[i] - right.hierarchyRole[i];
        }
      }
      if (left.distance !== right.distance) {
        return left.distance - right.distance;
      }
      return left.object.objectId.localeCompare(right.object.objectId);
    });

  if (sameType.length === 0) {
    return null;
  }

  return {
    object: sameType[0].object,
    strategy: 'type-hierarchy-geometry'
  };
};

interface AnchorResolution {
  tier: RuntimeAnchorTier;
  transform: RuntimeStructuralTransform;
  predictedBox: NormalizedBoundingBox;
}

const resolveFieldAnchor = (
  source: FieldGeometry,
  configPage: StructuralPage,
  runtimePage: StructuralPage
): AnchorResolution => {
  const relationship = getFieldRelationship(configPage, source.fieldId);

  if (relationship) {
    const stableAnchorOrder = sortStableAnchors(configPage, relationship);

    for (const stableAnchor of stableAnchorOrder) {
      const tier: RuntimeAnchorTier =
        stableAnchor.label === 'A'
          ? 'field-object-a'
          : stableAnchor.label === 'B'
            ? 'field-object-b'
            : 'field-object-c';

      const configObject = configPage.objectHierarchy.objects.find(
        (object) => object.objectId === stableAnchor.objectId
      );
      if (!configObject) {
        continue;
      }

      const runtimeMatch = resolveRuntimeObject(configPage, runtimePage, stableAnchor.objectId);
      if (!runtimeMatch) {
        continue;
      }

      const predictedBox = projectRelativeRect(stableAnchor.relativeFieldRect, runtimeMatch.object.objectRectNorm);
      return {
        tier,
        transform: solveRectTransform(
          source.pageIndex,
          tier,
          configObject.objectRectNorm,
          runtimeMatch.object.objectRectNorm,
          {
            configObjectId: configObject.objectId,
            runtimeObjectId: runtimeMatch.object.objectId,
            objectMatchStrategy: runtimeMatch.strategy
          }
        ),
        predictedBox
      };
    }

    const refinedBorderAnchor = relationship.fieldAnchors.refinedBorderAnchor;
    if (refinedBorderAnchor) {
      const predictedBox = projectRelativeRect(refinedBorderAnchor.relativeFieldRect, runtimePage.refinedBorder.rectNorm);
      return {
        tier: 'refined-border',
        transform: solveRectTransform(
          source.pageIndex,
          'refined-border',
          configPage.refinedBorder.rectNorm,
          runtimePage.refinedBorder.rectNorm
        ),
        predictedBox
      };
    }

    const borderAnchor = relationship.fieldAnchors.borderAnchor;
    if (borderAnchor) {
      const predictedBox = projectRelativeRect(borderAnchor.relativeFieldRect, runtimePage.border.rectNorm);
      return {
        tier: 'border',
        transform: solveRectTransform(
          source.pageIndex,
          'border',
          configPage.border.rectNorm,
          runtimePage.border.rectNorm
        ),
        predictedBox
      };
    }
  }

  const transform = solveRectTransform(
    source.pageIndex,
    'refined-border',
    configPage.refinedBorder.rectNorm,
    runtimePage.refinedBorder.rectNorm
  );
  return {
    tier: 'refined-border',
    transform,
    predictedBox: applyTransformToBox(source.bbox, transform)
  };
};

const buildPredictedField = (
  source: FieldGeometry,
  runtimePage: NormalizedPage,
  resolution: AnchorResolution
): PredictedFieldGeometry => {
  const runtimeSurface = getPageSurface(runtimePage);

  return {
    fieldId: source.fieldId,
    pageIndex: source.pageIndex,
    bbox: resolution.predictedBox,
    pixelBbox: toPixelBbox(resolution.predictedBox, runtimePage),
    pageSurface: {
      pageIndex: runtimeSurface.pageIndex,
      surfaceWidth: runtimeSurface.surfaceWidth,
      surfaceHeight: runtimeSurface.surfaceHeight
    },
    sourceGeometryConfirmedAtIso: source.confirmedAtIso,
    sourceGeometryConfirmedBy: source.confirmedBy,
    anchorTierUsed: resolution.tier,
    transform: resolution.transform
  };
};

export const createLocalizationRunner = (): LocalizationRunner => ({
  run: async (input) => {
    const runtimePagesByIndex = new Map(input.runtimePages.map((page) => [page.pageIndex, page]));

    const fields = input.configGeometry.fields
      .filter((field) => runtimePagesByIndex.has(field.pageIndex))
      .map((field) => {
        const runtimePage = runtimePagesByIndex.get(field.pageIndex);
        if (!runtimePage) {
          throw new Error(`Runtime page ${field.pageIndex} missing while building predicted geometry.`);
        }

        const configStructuralPage = getStructuralPage(input.configStructuralModel, field.pageIndex);
        const runtimeStructuralPage = getStructuralPage(input.runtimeStructuralModel, field.pageIndex);
        const resolution = resolveFieldAnchor(field, configStructuralPage, runtimeStructuralPage);

        return buildPredictedField(field, runtimePage, resolution);
      });

    return {
      schema: 'wrokit/predicted-geometry-file',
      version: '1.0',
      geometryFileVersion: 'wrokit/geometry/v1',
      structureVersion: 'wrokit/structure/v2',
      id: input.predictedId ?? generateId(),
      wizardId: input.wizardId,
      sourceGeometryFileId: input.configGeometry.id,
      sourceStructuralModelId: input.configStructuralModel.id,
      runtimeDocumentFingerprint: input.runtimeStructuralModel.documentFingerprint,
      predictedAtIso: input.nowIso ?? new Date().toISOString(),
      fields
    };
  }
});

export const __testing = {
  solveRectTransform,
  applyTransformToBox,
  projectRelativeRect,
  resolveRuntimeObject,
  resolveFieldAnchor
};
