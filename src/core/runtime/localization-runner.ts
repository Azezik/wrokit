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
  StructuralFieldStableObjectAnchor,
  StructuralModel,
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralObjectToObjectAnchorRelation,
  StructuralPage,
  StructuralRelativeAnchorRect,
  StructuralStableFieldAnchorLabel
} from '../contracts/structural-model';
import type {
  TransformationConsensus,
  TransformationFieldCandidate,
  TransformationModel,
  TransformationPage
} from '../contracts/transformation-model';
import { getPageSurface } from '../page-surface/page-surface';
import { iouOfRects } from './transformation/transform-math';

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
  /**
   * Optional precomputed alignment report between the Config and Runtime
   * StructuralModels. When provided, localization consumes the per-field
   * candidate chains it carries (matched-object → parent-object →
   * refined-border → border) instead of re-deriving anchors locally. When
   * omitted, or when a field has no candidates in the model, localization
   * falls back to the legacy stable-anchor resolution path.
   */
  transformationModel?: TransformationModel;
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

/**
 * Tolerance used when deciding whether a projected/transformed box truly
 * extends off-page. Floating-point noise from affine math can put a perfectly
 * in-bounds rect a few ulps outside [0,1]; treating those as off-page would
 * spam clip warnings on completely well-behaved inputs.
 */
const CLIP_TOLERANCE = 1e-6;

interface BoxClipResult {
  box: NormalizedBoundingBox;
  clipWarning?: string;
}

/**
 * Clip a candidate box (described by left/top/width/height in normalized
 * coordinates) into [0,1]x[0,1].
 *
 * The previous implementation clamped each side independently, which silently
 * shrank both width AND height whenever the box landed partially off-page. To
 * preserve box integrity, we instead:
 *   - if the box fits inside [0,1] in a given dimension but is shifted off,
 *     translate it back so width/height are preserved,
 *   - if the box itself is larger than the page in a given dimension, clamp
 *     that dimension to [0,1] (this is the only case where size genuinely
 *     cannot be preserved),
 * and always emit a warning describing what happened.
 */
const clipNormalizedBox = (
  left: number,
  top: number,
  width: number,
  height: number,
  origin: 'transformed' | 'projected'
): BoxClipResult => {
  const right = left + width;
  const bottom = top + height;

  const exceedsLeft = left < -CLIP_TOLERANCE;
  const exceedsTop = top < -CLIP_TOLERANCE;
  const exceedsRight = right > 1 + CLIP_TOLERANCE;
  const exceedsBottom = bottom > 1 + CLIP_TOLERANCE;
  const offPage = exceedsLeft || exceedsTop || exceedsRight || exceedsBottom;

  if (!offPage) {
    return {
      box: {
        xNorm: clamp01(left),
        yNorm: clamp01(top),
        wNorm: clamp01(width),
        hNorm: clamp01(height)
      }
    };
  }

  let adjustedLeft = left;
  let adjustedTop = top;
  let adjustedWidth = Math.max(width, 0);
  let adjustedHeight = Math.max(height, 0);
  let widthShrunk = false;
  let heightShrunk = false;

  if (adjustedWidth > 1) {
    adjustedLeft = 0;
    adjustedWidth = 1;
    widthShrunk = true;
  } else if (adjustedLeft < 0) {
    adjustedLeft = 0;
  } else if (adjustedLeft + adjustedWidth > 1) {
    adjustedLeft = 1 - adjustedWidth;
  }

  if (adjustedHeight > 1) {
    adjustedTop = 0;
    adjustedHeight = 1;
    heightShrunk = true;
  } else if (adjustedTop < 0) {
    adjustedTop = 0;
  } else if (adjustedTop + adjustedHeight > 1) {
    adjustedTop = 1 - adjustedHeight;
  }

  const offPageSides = [
    exceedsLeft ? 'left' : null,
    exceedsRight ? 'right' : null,
    exceedsTop ? 'top' : null,
    exceedsBottom ? 'bottom' : null
  ]
    .filter((side): side is string => side !== null)
    .join(',');

  const shrunkDims = [
    widthShrunk ? 'width' : null,
    heightShrunk ? 'height' : null
  ]
    .filter((dim): dim is string => dim !== null)
    .join('/');

  const integrityNote =
    shrunkDims.length > 0
      ? `${origin} box exceeds page in ${shrunkDims}; clamped (size reduced)`
      : `${origin} box partially off-page; shifted back to fit (width/height preserved)`;

  return {
    box: {
      xNorm: clamp01(adjustedLeft),
      yNorm: clamp01(adjustedTop),
      wNorm: clamp01(adjustedWidth),
      hNorm: clamp01(adjustedHeight)
    },
    clipWarning:
      `${integrityNote}; off-page sides=[${offPageSides}] ` +
      `unclipped=[${left.toFixed(4)},${top.toFixed(4)},` +
      `${(left + Math.max(width, 0)).toFixed(4)},${(top + Math.max(height, 0)).toFixed(4)}]`
  };
};

const applyTransformToBox = (
  sourceBox: NormalizedBoundingBox,
  transform: RuntimeStructuralTransform
): BoxClipResult => {
  const left = sourceBox.xNorm * transform.scaleX + transform.translateX;
  const top = sourceBox.yNorm * transform.scaleY + transform.translateY;
  const width = sourceBox.wNorm * transform.scaleX;
  const height = sourceBox.hNorm * transform.scaleY;
  return clipNormalizedBox(left, top, width, height, 'transformed');
};

const projectRelativeRect = (
  relativeRect: StructuralRelativeAnchorRect,
  anchorRect: StructuralNormalizedRect
): BoxClipResult => {
  const xNorm = anchorRect.xNorm + relativeRect.xRatio * anchorRect.wNorm;
  const yNorm = anchorRect.yNorm + relativeRect.yRatio * anchorRect.hNorm;
  const wNorm = relativeRect.wRatio * anchorRect.wNorm;
  const hNorm = relativeRect.hRatio * anchorRect.hNorm;
  return clipNormalizedBox(xNorm, yNorm, wNorm, hNorm, 'projected');
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

/**
 * Patterns produced by the OpenCV.js adapter (and any heuristic fallback that
 * shares its prefixes) when assigning objectIds purely by detection order:
 * `obj_0`, `obj_hline_3`, `obj_cv_5`, `obj_cv_line_2`, etc.
 *
 * Such ids are positional — they encode the index of the object inside the
 * page's detection pass, not anything about the underlying content. Two
 * unrelated documents will routinely share `obj_0` or `obj_hline_0` for
 * structurally distinct objects, so an id-only match across distinct
 * documents tells us nothing more than "both detectors found at least one
 * object." See {@link ResolveObjectOptions.crossDocument}.
 */
const POSITIONAL_OBJECT_ID_PATTERN = /^obj(?:_[a-z]+)*_\d+$/;

const isPositionalObjectId = (objectId: string): boolean =>
  POSITIONAL_OBJECT_ID_PATTERN.test(objectId);

interface ResolveObjectOptions {
  /**
   * True when the config and runtime pages came from distinct documents
   * (different `StructuralModel.documentFingerprint`). When true, an id-only
   * match against a positional/auto-generated objectId is treated as
   * coincidental: the resolver falls through to the type-hierarchy-geometry
   * pass, which actually examines the structural signal. The resolver still
   * accepts `id` matches when the id is non-positional (e.g. an authored or
   * content-derived id), since those carry real cross-document meaning.
   */
  crossDocument?: boolean;
}

const resolveRuntimeObject = (
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  configObjectId: string,
  options: ResolveObjectOptions = {}
): { object: StructuralObjectNode; strategy: RuntimeObjectMatchStrategy } | null => {
  const configObject = configPage.objectHierarchy.objects.find((object) => object.objectId === configObjectId);

  const runtimeById = runtimePage.objectHierarchy.objects.find((object) => object.objectId === configObjectId);
  if (runtimeById && (!configObject || runtimeById.type === configObject.type)) {
    // Across distinct documents, a positional objectId match is not an
    // identity signal — it just means both detection passes happened to
    // assign the same index. Skip the `id` strategy in that case so the
    // RuntimeStructuralTransform.objectMatchStrategy reflects reality, and
    // let the `type-hierarchy-geometry` pass below pick the same object on
    // its own merits if it deserves to win.
    if (!(options.crossDocument && isPositionalObjectId(runtimeById.objectId))) {
      return {
        object: runtimeById,
        strategy: 'id'
      };
    }
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
  /**
   * Warnings raised while producing this resolution — currently used to
   * surface clip notices from {@link clipNormalizedBox} so off-page projections
   * are visible in the predicted field rather than silently distorted.
   */
  warnings?: string[];
}

const stableAnchorLabelToTier = (
  label: StructuralStableFieldAnchorLabel
): RuntimeAnchorTier =>
  label === 'A' ? 'field-object-a' : label === 'B' ? 'field-object-b' : 'field-object-c';

/**
 * Strict rescuer match: only accept an unambiguous runtime object for the
 * rescuer. A rescuer is unambiguous when:
 *   - the runtime model contains the same object id with the same type, or
 *   - exactly one runtime object shares the rescuer's structural type.
 *
 * Anything else (multiple same-type candidates with no id match) is ambiguous
 * and rejected, so we never reconstruct a child anchor from a guessed parent.
 */
const resolveRescuerObjectStrict = (
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  rescuerObjectId: string,
  options: ResolveObjectOptions = {}
): { object: StructuralObjectNode; strategy: RuntimeObjectMatchStrategy } | null => {
  const configObject = getObjectById(configPage, rescuerObjectId);

  const runtimeById = runtimePage.objectHierarchy.objects.find(
    (object) => object.objectId === rescuerObjectId
  );
  if (runtimeById && (!configObject || runtimeById.type === configObject.type)) {
    if (!(options.crossDocument && isPositionalObjectId(runtimeById.objectId))) {
      return { object: runtimeById, strategy: 'id' };
    }
  }

  if (!configObject) {
    return null;
  }

  const sameType = runtimePage.objectHierarchy.objects.filter(
    (object) => object.type === configObject.type
  );
  if (sameType.length === 1) {
    return { object: sameType[0], strategy: 'type-hierarchy-geometry' };
  }

  return null;
};

const findContainerRelation = (
  configPage: StructuralPage,
  fromObjectId: string,
  toObjectId: string
): StructuralObjectToObjectAnchorRelation | undefined =>
  configPage.pageAnchorRelations.objectToObject.find(
    (relation) =>
      relation.fromObjectId === fromObjectId &&
      relation.toObjectId === toObjectId &&
      relation.relationKind === 'container'
  );

/**
 * Relational (chained) rescue: when the stable anchor `missingAnchor` cannot
 * be resolved directly in the runtime page, attempt to reconstruct a virtual
 * runtime version of it inside an unambiguously-matched rescuer anchor (a
 * surviving parent in the config containment graph). The field is then
 * projected through the missing anchor's own `relativeFieldRect` against the
 * virtual rect.
 *
 * Restrictions enforced here so we don't over-trust ambiguous chains:
 *   - The config relationship must be `container` (parent geometrically holds
 *     the child). Sibling / adjacent / near are not used as rescue baselines.
 *   - The rescuer must resolve unambiguously (id match, or unique same-type
 *     runtime object).
 *
 * The reported anchor tier is the missing anchor's tier (A/B/C) — this is
 * intentional: the predicted box reflects the field's relationship to its
 * direct anchor, just reconstructed through a surviving parent.
 */
const resolveFromRelationalRescue = (
  source: FieldGeometry,
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  missingAnchor: StructuralFieldStableObjectAnchor,
  candidateRescuers: readonly StructuralFieldStableObjectAnchor[],
  options: ResolveObjectOptions = {}
): AnchorResolution | null => {
  const configMissingObject = getObjectById(configPage, missingAnchor.objectId);
  if (!configMissingObject) {
    return null;
  }

  const tier = stableAnchorLabelToTier(missingAnchor.label);

  for (const rescuer of candidateRescuers) {
    if (rescuer.objectId === missingAnchor.objectId) {
      continue;
    }

    const relation = findContainerRelation(
      configPage,
      rescuer.objectId,
      missingAnchor.objectId
    );
    if (!relation) {
      continue;
    }

    const rescuerMatch = resolveRescuerObjectStrict(
      configPage,
      runtimePage,
      rescuer.objectId,
      options
    );
    if (!rescuerMatch) {
      continue;
    }

    const virtualMissingProjection = projectRelativeRect(
      relation.relativeRect,
      rescuerMatch.object.objectRectNorm
    );
    const virtualMissingRect: StructuralNormalizedRect = {
      xNorm: virtualMissingProjection.box.xNorm,
      yNorm: virtualMissingProjection.box.yNorm,
      wNorm: virtualMissingProjection.box.wNorm,
      hNorm: virtualMissingProjection.box.hNorm
    };

    const predictedProjection = projectRelativeRect(
      missingAnchor.relativeFieldRect,
      virtualMissingRect
    );

    const warnings = collectClipWarnings(
      virtualMissingProjection.clipWarning,
      predictedProjection.clipWarning
    );

    const transform = solveRectTransform(
      source.pageIndex,
      tier,
      configMissingObject.objectRectNorm,
      virtualMissingRect,
      {
        configObjectId: missingAnchor.objectId,
        // No real runtime object backs the virtual reconstruction; we
        // intentionally omit `runtimeObjectId` so consumers can see this came
        // from a chain rather than a direct match. The match strategy mirrors
        // the rescuer's strategy because that is the actual ambiguity the
        // rescue inherits.
        objectMatchStrategy: rescuerMatch.strategy
      }
    );

    return {
      tier,
      transform,
      predictedBox: predictedProjection.box,
      ...(warnings.length > 0 ? { warnings } : {})
    };
  }

  return null;
};

const collectClipWarnings = (
  ...warnings: ReadonlyArray<string | undefined>
): string[] => warnings.filter((w): w is string => typeof w === 'string');

const candidateSourceToAnchorTier = (
  source: TransformationFieldCandidate['source']
): RuntimeAnchorTier => {
  switch (source) {
    case 'matched-object':
      return 'field-object-a';
    case 'parent-object':
      return 'field-object-b';
    case 'refined-border':
      return 'refined-border';
    case 'border':
      return 'border';
  }
};

const resolveFromTransformationCandidate = (
  source: FieldGeometry,
  candidate: TransformationFieldCandidate,
  configPage: StructuralPage,
  runtimePage: StructuralPage
): AnchorResolution | null => {
  const tier = candidateSourceToAnchorTier(candidate.source);

  let sourceConfigRectNorm: StructuralNormalizedRect | undefined;
  let sourceRuntimeRectNorm: StructuralNormalizedRect | undefined;

  if (candidate.source === 'matched-object' || candidate.source === 'parent-object') {
    if (!candidate.configObjectId || !candidate.runtimeObjectId) {
      return null;
    }
    const configObject = getObjectById(configPage, candidate.configObjectId);
    const runtimeObject = getObjectById(runtimePage, candidate.runtimeObjectId);
    if (!configObject || !runtimeObject) {
      return null;
    }
    sourceConfigRectNorm = configObject.objectRectNorm;
    sourceRuntimeRectNorm = runtimeObject.objectRectNorm;
  } else if (candidate.source === 'refined-border') {
    sourceConfigRectNorm = configPage.refinedBorder.rectNorm;
    sourceRuntimeRectNorm = runtimePage.refinedBorder.rectNorm;
  } else {
    sourceConfigRectNorm = configPage.border.rectNorm;
    sourceRuntimeRectNorm = runtimePage.border.rectNorm;
  }

  const transform: RuntimeStructuralTransform = {
    pageIndex: source.pageIndex,
    basis: tier,
    sourceConfigRectNorm: { ...sourceConfigRectNorm },
    sourceRuntimeRectNorm: { ...sourceRuntimeRectNorm },
    scaleX: candidate.transform.scaleX,
    scaleY: candidate.transform.scaleY,
    translateX: candidate.transform.translateX,
    translateY: candidate.transform.translateY,
    ...(candidate.configObjectId ? { configObjectId: candidate.configObjectId } : {}),
    ...(candidate.runtimeObjectId ? { runtimeObjectId: candidate.runtimeObjectId } : {}),
    // The TransformationModel is computed by the matcher / consensus chain,
    // which works across hierarchy and geometry rather than by raw object id.
    ...(candidate.source === 'matched-object' || candidate.source === 'parent-object'
      ? { objectMatchStrategy: 'type-hierarchy-geometry' as RuntimeObjectMatchStrategy }
      : {})
  };

  const projection = applyTransformToBox(source.bbox, transform);
  return {
    tier,
    transform,
    predictedBox: projection.box,
    ...(projection.clipWarning ? { warnings: [projection.clipWarning] } : {})
  };
};

/**
 * Minimum TransformationModel consensus confidence required before its global
 * page-level affine is allowed to "rescue" a field whose object anchors all
 * failed. Set conservatively: a confident consensus is worth more than the
 * page-level refined-border fallback, but a weak one is worth less.
 */
const CONSENSUS_RESCUE_MIN_CONFIDENCE = 0.6;

/**
 * Stricter floor used when a consensus has only a SINGLE contributing match.
 * A 1-match consensus is structurally degenerate: it is just that one match's
 * own affine elevated to "page-level" status, with no second match available
 * to cross-check it. Allowing it to rescue a field that just barely clears the
 * regular {@link CONSENSUS_RESCUE_MIN_CONFIDENCE} would amount to laundering a
 * single low-trust object match into a page-wide transform. Demand a stronger
 * signal before letting that happen, and warn whenever a 1-match rescue does
 * fire so consumers can see it.
 */
const SINGLE_MATCH_CONSENSUS_MIN_CONFIDENCE = 0.85;

const findTransformationPage = (
  transformationModel: TransformationModel,
  pageIndex: number
): TransformationPage | undefined =>
  transformationModel.pages.find((entry) => entry.pageIndex === pageIndex);

const isObjectAnchorCandidate = (
  candidate: TransformationFieldCandidate
): boolean =>
  candidate.source === 'matched-object' || candidate.source === 'parent-object';

const resolveFromConsensusRescue = (
  source: FieldGeometry,
  consensus: TransformationConsensus,
  minConfidence: number
): AnchorResolution | null => {
  if (!consensus.transform) {
    return null;
  }
  if (consensus.contributingMatchCount < 1) {
    return null;
  }
  if (!Number.isFinite(consensus.confidence) || consensus.confidence < minConfidence) {
    return null;
  }
  // Degenerate consensus guard: a single-match consensus is just that one
  // object match dressed as a page-level affine. Refuse to rescue with it
  // unless its confidence clears the stricter single-match floor.
  if (
    consensus.contributingMatchCount < 2 &&
    consensus.confidence < SINGLE_MATCH_CONSENSUS_MIN_CONFIDENCE
  ) {
    return null;
  }
  const isSingleMatch = consensus.contributingMatchCount < 2;

  // The consensus is a page-level affine derived from object matches across
  // the page; it is not bound to any single object or source rect pair. The
  // PredictedGeometryFile contract intentionally omits `sourceConfigRectNorm`
  // / `sourceRuntimeRectNorm` for `page-consensus` so downstream consumers
  // are not misled into treating an attributed pair as the basis of the
  // affine.
  const transform: RuntimeStructuralTransform = {
    pageIndex: source.pageIndex,
    basis: 'page-consensus',
    scaleX: consensus.transform.scaleX,
    scaleY: consensus.transform.scaleY,
    translateX: consensus.transform.translateX,
    translateY: consensus.transform.translateY
  };

  const projection = applyTransformToBox(source.bbox, transform);
  const warnings: string[] = [];
  if (projection.clipWarning) {
    warnings.push(projection.clipWarning);
  }
  if (isSingleMatch) {
    warnings.push(
      `weak consensus rescue: page-consensus built from a single contributing ` +
        `match (confidence ${consensus.confidence.toFixed(2)}); cannot be ` +
        `cross-checked against any second match`
    );
  }
  return {
    tier: 'page-consensus',
    transform,
    predictedBox: projection.box,
    ...(warnings.length > 0 ? { warnings } : {})
  };
};

const findFieldCandidates = (
  transformationModel: TransformationModel,
  pageIndex: number,
  fieldId: string
): readonly TransformationFieldCandidate[] => {
  const page: TransformationPage | undefined = transformationModel.pages.find(
    (entry) => entry.pageIndex === pageIndex
  );
  if (!page) {
    return [];
  }
  const alignment = page.fieldAlignments.find((entry) => entry.fieldId === fieldId);
  if (!alignment) {
    return [];
  }
  // Strongest preferred candidate first.
  return [...alignment.candidates].sort((a, b) => a.fallbackOrder - b.fallbackOrder);
};

/**
 * IoU below which two projections are considered to *disagree* about where
 * the field lives. Set conservatively — anchors derived from different
 * structural objects or from a page-level consensus will rarely produce
 * pixel-identical projections, so a moderately loose floor avoids spurious
 * warnings while still flagging projections that genuinely point at
 * different regions.
 */
const ANCHOR_AGREEMENT_IOU_MIN = 0.5;

/**
 * Below this `TransformationFieldCandidate.confidence` an object-anchor
 * candidate is considered weak. A weak primary that can't be cross-checked
 * (no agreeing alternative, no confident consensus) gets a warning so
 * downstream consumers can inspect why the prediction is fragile.
 */
const WEAK_OBJECT_MATCH_CONFIDENCE = 0.5;

/**
 * Multiplier applied to an object-anchor candidate's reported confidence when
 * the page's config and runtime `cvExecutionMode` disagree (i.e. one side ran
 * full OpenCV detection and the other fell back to the heuristic detector).
 * Heuristic-vs-OpenCV object detections aren't strictly comparable — they
 * pick up different shapes and emit different rect bounds — so the matcher's
 * confidence in the resulting object anchor is overstated relative to a
 * within-mode comparison. We don't reject those anchors (predictions are
 * still better than nothing), but we down-weight their confidence for the
 * weak-match check so the warning fires at a more honest threshold.
 */
const CV_MODE_MISMATCH_CONFIDENCE_PENALTY = 0.7;

interface AlternativeProjection {
  label: string;
  predictedBox: NormalizedBoundingBox;
}

const projectCandidateBox = (
  source: FieldGeometry,
  candidate: TransformationFieldCandidate,
  configPage: StructuralPage,
  runtimePage: StructuralPage
): NormalizedBoundingBox | null => {
  const projected = resolveFromTransformationCandidate(source, candidate, configPage, runtimePage);
  return projected ? projected.predictedBox : null;
};



const projectConsensusBox = (
  source: FieldGeometry,
  consensus: TransformationConsensus
): NormalizedBoundingBox | null => {
  if (!consensus.transform || consensus.contributingMatchCount < 1) {
    return null;
  }
  if (!Number.isFinite(consensus.confidence)) {
    return null;
  }
  return applyTransformToBox(source.bbox, {
    pageIndex: source.pageIndex,
    basis: 'page-consensus',
    scaleX: consensus.transform.scaleX,
    scaleY: consensus.transform.scaleY,
    translateX: consensus.transform.translateX,
    translateY: consensus.transform.translateY
  }).box;
};

const labelForCandidate = (candidate: TransformationFieldCandidate): string => {
  switch (candidate.source) {
    case 'matched-object':
      return `matched-object(${candidate.configObjectId ?? '?'})`;
    case 'parent-object':
      return `parent-object(${candidate.configObjectId ?? '?'})`;
    case 'refined-border':
      return 'refined-border';
    case 'border':
      return 'border';
  }
};

/**
 * IoU-based pairwise agreement check between the chosen anchor's projection
 * and every other resolved projection (object anchors not used as primary,
 * refined-border / border candidates, page consensus). Returns warnings —
 * never mutates the chosen anchor — so refined-border and border fallback
 * behavior is preserved.
 */
const evaluateAnchorAgreement = (input: {
  chosen: AnchorResolution;
  chosenLabel: string;
  alternatives: readonly AlternativeProjection[];
  primaryCandidate?: TransformationFieldCandidate;
  hasConsensusAlternative: boolean;
  /**
   * Whether the page's config/runtime `cvExecutionMode` disagree. When true,
   * object-anchor confidences are scaled by
   * {@link CV_MODE_MISMATCH_CONFIDENCE_PENALTY} for the weak-match check, so
   * predictions built from heuristic-vs-OpenCV detections are flagged at a
   * stricter threshold without rewriting the chosen anchor itself.
   */
  cvModeMismatch?: boolean;
}): string[] => {
  const {
    chosen,
    chosenLabel,
    alternatives,
    primaryCandidate,
    hasConsensusAlternative,
    cvModeMismatch = false
  } = input;
  const warnings: string[] = [];

  const effectiveConfidence = (candidate: TransformationFieldCandidate): number =>
    cvModeMismatch
      ? candidate.confidence * CV_MODE_MISMATCH_CONFIDENCE_PENALTY
      : candidate.confidence;

  const formatWeakConfidence = (candidate: TransformationFieldCandidate): string =>
    cvModeMismatch
      ? `confidence ${candidate.confidence.toFixed(2)} (effective ` +
        `${effectiveConfidence(candidate).toFixed(2)} after cv-mode-mismatch penalty)`
      : `confidence ${candidate.confidence.toFixed(2)}`;

  if (alternatives.length === 0) {
    if (
      primaryCandidate &&
      isObjectAnchorCandidate(primaryCandidate) &&
      Number.isFinite(primaryCandidate.confidence) &&
      effectiveConfidence(primaryCandidate) < WEAK_OBJECT_MATCH_CONFIDENCE &&
      !hasConsensusAlternative
    ) {
      warnings.push(
        `weak object match: ${chosenLabel} ${formatWeakConfidence(primaryCandidate)} ` +
          `with no agreeing alternative anchor or page consensus to cross-check`
      );
    }
    return warnings;
  }

  let bestIou = 0;
  let bestLabel: string | null = null;
  for (const alt of alternatives) {
    const iou = iouOfRects(chosen.predictedBox, alt.predictedBox);
    if (iou > bestIou) {
      bestIou = iou;
      bestLabel = alt.label;
    }
  }

  if (bestIou >= ANCHOR_AGREEMENT_IOU_MIN) {
    return warnings;
  }

  const altLabels = alternatives.map((alt) => alt.label).join(', ');
  warnings.push(
    `anchor disagreement: ${chosenLabel} disagrees with ${alternatives.length} alternative ` +
      `projection(s) [${altLabels}]; max IoU ${bestIou.toFixed(2)} < ${ANCHOR_AGREEMENT_IOU_MIN.toFixed(2)} ` +
      `(closest: ${bestLabel ?? 'n/a'})`
  );

  if (
    primaryCandidate &&
    isObjectAnchorCandidate(primaryCandidate) &&
    Number.isFinite(primaryCandidate.confidence) &&
    effectiveConfidence(primaryCandidate) < WEAK_OBJECT_MATCH_CONFIDENCE
  ) {
    warnings.push(
      `weak object match: ${chosenLabel} ${formatWeakConfidence(primaryCandidate)} ` +
        `with disagreeing alternatives`
    );
  }

  return warnings;
};


const resolveFieldAnchor = (
  source: FieldGeometry,
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  options: ResolveObjectOptions = {}
): AnchorResolution => {
  const relationship = getFieldRelationship(configPage, source.fieldId);

  if (relationship) {
    const stableAnchorOrder = sortStableAnchors(configPage, relationship);

    for (const stableAnchor of stableAnchorOrder) {
      const tier = stableAnchorLabelToTier(stableAnchor.label);

      const configObject = configPage.objectHierarchy.objects.find(
        (object) => object.objectId === stableAnchor.objectId
      );
      if (!configObject) {
        continue;
      }

      const runtimeMatch = resolveRuntimeObject(
        configPage,
        runtimePage,
        stableAnchor.objectId,
        options
      );
      if (runtimeMatch) {
        const projection = projectRelativeRect(
          stableAnchor.relativeFieldRect,
          runtimeMatch.object.objectRectNorm
        );
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
          predictedBox: projection.box,
          ...(projection.clipWarning ? { warnings: [projection.clipWarning] } : {})
        };
      }

      // Direct match failed — try relational rescue: reconstruct a virtual
      // runtime version of this anchor inside a surviving parent (other
      // stable anchor of the same field) using the config's `objectToObject`
      // container relation. This recovers the field through a known
      // child-inside-parent chain rather than discarding the anchor.
      const rescued = resolveFromRelationalRescue(
        source,
        configPage,
        runtimePage,
        stableAnchor,
        relationship.fieldAnchors.stableObjectAnchors,
        options
      );
      if (rescued) {
        return rescued;
      }
    }

    const refinedBorderAnchor = relationship.fieldAnchors.refinedBorderAnchor;
    if (refinedBorderAnchor) {
      const projection = projectRelativeRect(
        refinedBorderAnchor.relativeFieldRect,
        runtimePage.refinedBorder.rectNorm
      );
      return {
        tier: 'refined-border',
        transform: solveRectTransform(
          source.pageIndex,
          'refined-border',
          configPage.refinedBorder.rectNorm,
          runtimePage.refinedBorder.rectNorm
        ),
        predictedBox: projection.box,
        ...(projection.clipWarning ? { warnings: [projection.clipWarning] } : {})
      };
    }

    const borderAnchor = relationship.fieldAnchors.borderAnchor;
    if (borderAnchor) {
      const projection = projectRelativeRect(
        borderAnchor.relativeFieldRect,
        runtimePage.border.rectNorm
      );
      return {
        tier: 'border',
        transform: solveRectTransform(
          source.pageIndex,
          'border',
          configPage.border.rectNorm,
          runtimePage.border.rectNorm
        ),
        predictedBox: projection.box,
        ...(projection.clipWarning ? { warnings: [projection.clipWarning] } : {})
      };
    }
  }

  const transform = solveRectTransform(
    source.pageIndex,
    'refined-border',
    configPage.refinedBorder.rectNorm,
    runtimePage.refinedBorder.rectNorm
  );
  const projection = applyTransformToBox(source.bbox, transform);
  return {
    tier: 'refined-border',
    transform,
    predictedBox: projection.box,
    ...(projection.clipWarning ? { warnings: [projection.clipWarning] } : {})
  };
};

const buildPredictedField = (
  source: FieldGeometry,
  runtimePage: NormalizedPage,
  resolution: AnchorResolution,
  warnings: readonly string[] = []
): PredictedFieldGeometry => {
  const runtimeSurface = getPageSurface(runtimePage);

  const result: PredictedFieldGeometry = {
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

  if (warnings.length > 0) {
    result.warnings = [...warnings];
  }
  return result;
};

/**
 * Build the per-page list of cv-mode mismatch warnings, keyed by pageIndex.
 * Config and runtime pages are matched by pageIndex; pages absent from one
 * side are not reported (callers will simply not localize them).
 */
const collectCvModeMismatchWarnings = (
  configModel: StructuralModel,
  runtimeModel: StructuralModel
): {
  perPage: Map<number, string>;
  global: string[];
} => {
  const perPage = new Map<number, string>();
  const global: string[] = [];

  const runtimeByIndex = new Map(runtimeModel.pages.map((page) => [page.pageIndex, page]));
  for (const configPage of configModel.pages) {
    const runtimePage = runtimeByIndex.get(configPage.pageIndex);
    if (!runtimePage) {
      continue;
    }
    if (configPage.cvExecutionMode !== runtimePage.cvExecutionMode) {
      const message =
        `cvExecutionMode mismatch on page ${configPage.pageIndex}: ` +
        `config=${configPage.cvExecutionMode} runtime=${runtimePage.cvExecutionMode} ` +
        `(object detection thresholds may differ between Config and Runtime)`;
      perPage.set(configPage.pageIndex, message);
      global.push(message);
    }
  }

  return { perPage, global };
};

/**
 * Validates that the artifacts handed to the localization-runner refer to
 * each other consistently. The runner is artifact-driven, so silently
 * combining a GeometryFile from one wizard with structural artifacts from
 * another — or pairing a TransformationModel that was computed against
 * different Config/Runtime StructuralModel ids — produces predictions that
 * look plausible but aren't anchored to anything real. We surface these as
 * hard errors so the mismatch is detected at run() entry rather than buried
 * in a downstream consistency report.
 */
const validateArtifactCrossReferences = (input: LocalizationRunnerInput): void => {
  if (input.configGeometry.wizardId !== input.wizardId) {
    throw new Error(
      `Artifact mismatch: configGeometry.wizardId=${JSON.stringify(input.configGeometry.wizardId)} ` +
        `does not match expected wizardId=${JSON.stringify(input.wizardId)}.`
    );
  }

  const tm = input.transformationModel;
  if (tm) {
    if (tm.config.id !== input.configStructuralModel.id) {
      throw new Error(
        `Artifact mismatch: transformationModel.config.id=${JSON.stringify(tm.config.id)} ` +
          `does not match configStructuralModel.id=${JSON.stringify(input.configStructuralModel.id)} ` +
          `(TransformationModel was computed against a different Config StructuralModel).`
      );
    }
    if (tm.runtime.id !== input.runtimeStructuralModel.id) {
      throw new Error(
        `Artifact mismatch: transformationModel.runtime.id=${JSON.stringify(tm.runtime.id)} ` +
          `does not match runtimeStructuralModel.id=${JSON.stringify(input.runtimeStructuralModel.id)} ` +
          `(TransformationModel was computed against a different Runtime StructuralModel).`
      );
    }
  }
};

export const createLocalizationRunner = (): LocalizationRunner => ({
  run: async (input) => {
    validateArtifactCrossReferences(input);

    const runtimePagesByIndex = new Map(input.runtimePages.map((page) => [page.pageIndex, page]));

    const cvMismatchWarnings = collectCvModeMismatchWarnings(
      input.configStructuralModel,
      input.runtimeStructuralModel
    );

    // Detect cross-document localization. Fingerprints are produced at
    // structural-model build time and uniquely identify the surface the
    // model was derived from; when they differ, we are localizing one
    // document onto another, so positional objectId matches no longer
    // carry identity weight (see {@link isPositionalObjectId}).
    const crossDocument =
      input.configStructuralModel.documentFingerprint !==
      input.runtimeStructuralModel.documentFingerprint;
    const resolveOptions: ResolveObjectOptions = { crossDocument };

    const fields = input.configGeometry.fields
      .filter((field) => runtimePagesByIndex.has(field.pageIndex))
      .map((field) => {
        const runtimePage = runtimePagesByIndex.get(field.pageIndex);
        if (!runtimePage) {
          throw new Error(`Runtime page ${field.pageIndex} missing while building predicted geometry.`);
        }

        const configStructuralPage = getStructuralPage(input.configStructuralModel, field.pageIndex);
        const runtimeStructuralPage = getStructuralPage(input.runtimeStructuralModel, field.pageIndex);

        let resolution: AnchorResolution | null = null;
        let primaryCandidate: TransformationFieldCandidate | undefined;
        let chosenLabel = 'legacy-stable-anchor';

        // Multi-anchor validation: collect every alternative projection that
        // would have been viable if the chosen primary had been unavailable.
        // Used after resolution to compare via IoU and surface warnings when
        // anchors disagree — closes the audit gap where the runner blindly
        // trusted the first resolved anchor.
        const alternatives: AlternativeProjection[] = [];
        let hasConsensusAlternative = false;

        if (input.transformationModel) {
          const candidates = findFieldCandidates(
            input.transformationModel,
            field.pageIndex,
            field.fieldId
          );

          // First pass: try every object-anchor candidate (matched-object,
          // parent-object) directly, in fallbackOrder. A direct match — even
          // a parent-object one — beats a rescued match, because rescue
          // reconstructs a virtual runtime rect from the config containment
          // graph rather than observing one in the runtime model. Trying
          // rescue inline (per candidate) was wrong: a rescued candidate A
          // could preempt a clean direct B further down the list.
          for (const candidate of candidates) {
            if (!isObjectAnchorCandidate(candidate)) {
              continue;
            }
            const candidateResolution = resolveFromTransformationCandidate(
              field,
              candidate,
              configStructuralPage,
              runtimeStructuralPage
            );
            if (candidateResolution) {
              resolution = candidateResolution;
              primaryCandidate = candidate;
              chosenLabel = labelForCandidate(candidate);
              break;
            }
          }

          // Second pass — relational rescue rung inside the TM-driven path:
          // only attempted when no direct object-anchor candidate resolved.
          // For each matched-object candidate whose runtime object is missing,
          // try to reconstruct a virtual runtime version of that object inside
          // an unambiguously-matched parent (another stable anchor of the
          // same field) using the config's `objectToObject` container
          // relation. If rescue succeeds we keep the missing anchor's tier —
          // the prediction reflects the field's relationship to its direct
          // anchor, just reconstructed through a surviving parent.
          if (!resolution) {
            for (const candidate of candidates) {
              if (candidate.source !== 'matched-object' || !candidate.configObjectId) {
                continue;
              }
              const fieldRelationship = getFieldRelationship(
                configStructuralPage,
                field.fieldId
              );
              const missingAnchor = fieldRelationship?.fieldAnchors.stableObjectAnchors.find(
                (anchor) => anchor.objectId === candidate.configObjectId
              );
              if (!fieldRelationship || !missingAnchor) {
                continue;
              }
              const rescued = resolveFromRelationalRescue(
                field,
                configStructuralPage,
                runtimeStructuralPage,
                missingAnchor,
                fieldRelationship.fieldAnchors.stableObjectAnchors,
                resolveOptions
              );
              if (rescued) {
                resolution = rescued;
                primaryCandidate = candidate;
                chosenLabel = `relational-rescue(${candidate.configObjectId})`;
                break;
              }
            }
          }

          // Consensus / global-affine rescue rung: when no object anchor
          // resolved but the page has a confident consensus transform, apply
          // it before falling back to refined-border / border. This is what
          // the audit calls out as missing — page-level movement trends were
          // being ignored as soon as object anchors failed.
          if (!resolution) {
            const transformationPage = findTransformationPage(
              input.transformationModel,
              field.pageIndex
            );
            if (transformationPage) {
              resolution = resolveFromConsensusRescue(
                field,
                transformationPage.consensus,
                CONSENSUS_RESCUE_MIN_CONFIDENCE
              );
              if (resolution) {
                chosenLabel = 'page-consensus';
              }
            }
          }

          // Refined-border / border candidates from the TransformationModel,
          // also in fallbackOrder. These keep their existing semantics; they
          // are intentionally tried *after* the consensus rescue.
          if (!resolution) {
            for (const candidate of candidates) {
              if (isObjectAnchorCandidate(candidate)) {
                continue;
              }
              const candidateResolution = resolveFromTransformationCandidate(
                field,
                candidate,
                configStructuralPage,
                runtimeStructuralPage
              );
              if (candidateResolution) {
                resolution = candidateResolution;
                primaryCandidate = candidate;
                chosenLabel = labelForCandidate(candidate);
                break;
              }
            }
          }

          // Build the alternative-projection set used to cross-check the
          // chosen anchor. We deliberately project EVERY viable candidate
          // (object, refined-border, border) and the consensus, except the
          // one that produced `resolution`. This lets the agreement check
          // detect cases where the matcher's first-place pick contradicts
          // the rest of the evidence.
          for (const candidate of candidates) {
            if (primaryCandidate && candidate === primaryCandidate) {
              continue;
            }
            const projected = projectCandidateBox(
              field,
              candidate,
              configStructuralPage,
              runtimeStructuralPage
            );
            if (projected) {
              alternatives.push({
                label: labelForCandidate(candidate),
                predictedBox: projected
              });
            }
          }

          const transformationPage = findTransformationPage(
            input.transformationModel,
            field.pageIndex
          );
          if (transformationPage) {
            const consensusBox = projectConsensusBox(field, transformationPage.consensus);
            if (consensusBox) {
              hasConsensusAlternative = true;
              if (chosenLabel !== 'page-consensus') {
                alternatives.push({
                  label: 'page-consensus',
                  predictedBox: consensusBox
                });
              }
            }
          }
        }

        if (!resolution) {
          resolution = resolveFieldAnchor(
            field,
            configStructuralPage,
            runtimeStructuralPage,
            resolveOptions
          );
          if (chosenLabel === 'legacy-stable-anchor') {
            chosenLabel = `legacy-${resolution.tier}`;
          }
        }

        const cvModeMismatch = cvMismatchWarnings.perPage.has(field.pageIndex);

        const fieldWarnings = evaluateAnchorAgreement({
          chosen: resolution,
          chosenLabel,
          alternatives,
          primaryCandidate,
          hasConsensusAlternative,
          cvModeMismatch
        });

        if (resolution.warnings) {
          fieldWarnings.push(...resolution.warnings);
        }

        const cvWarning = cvMismatchWarnings.perPage.get(field.pageIndex);
        if (cvWarning) {
          // Escalate the message when an object-anchor candidate was actually
          // used: the heuristic-vs-OpenCV detection difference touches THIS
          // prediction, not just the document overall, so the warning records
          // the confidence demotion that was applied.
          if (
            primaryCandidate &&
            isObjectAnchorCandidate(primaryCandidate) &&
            Number.isFinite(primaryCandidate.confidence)
          ) {
            const effective =
              primaryCandidate.confidence * CV_MODE_MISMATCH_CONFIDENCE_PENALTY;
            fieldWarnings.push(
              `${cvWarning}; object-anchor confidence demoted ` +
                `${primaryCandidate.confidence.toFixed(2)}→${effective.toFixed(2)} ` +
                `for weak-match evaluation`
            );
          } else {
            fieldWarnings.push(cvWarning);
          }
        }

        return buildPredictedField(field, runtimePage, resolution, fieldWarnings);
      });

    const result: PredictedGeometryFile = {
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
      fields,
      warnings: cvMismatchWarnings.global
    };

    return result;
  }
});

export const __testing = {
  solveRectTransform,
  applyTransformToBox,
  projectRelativeRect,
  resolveRuntimeObject,
  resolveFieldAnchor,
  resolveFromTransformationCandidate,
  resolveFromConsensusRescue,
  resolveFromRelationalRescue,
  findFieldCandidates,
  evaluateAnchorAgreement,
  collectCvModeMismatchWarnings,
  validateArtifactCrossReferences,
  isPositionalObjectId,
  CONSENSUS_RESCUE_MIN_CONFIDENCE,
  SINGLE_MATCH_CONSENSUS_MIN_CONFIDENCE,
  ANCHOR_AGREEMENT_IOU_MIN,
  WEAK_OBJECT_MATCH_CONFIDENCE,
  CV_MODE_MISMATCH_CONFIDENCE_PENALTY
};
