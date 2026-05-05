/**
 * Compose refined StructuralModel.
 *
 * Builds a `StructuralModel` byte-compatible with the existing v4.0 contract
 * from the analytics + the config StructuralModel. Reuses the pure helpers
 * in `src/core/engines/structure/object-hierarchy.ts` for relations so we do
 * not duplicate that logic.
 *
 * Geometry truth is sacred: field BBOXes are read from the config's existing
 * `borderAnchor.relativeFieldRect` (which equals the bbox because the border
 * rect is `{0,0,1,1}`) and never mutated. Object rects are shifted by the
 * batch-learned drift mean; objects that never appeared keep their config rect
 * with a floored confidence so they are never silently relocated to a
 * fabricated position.
 */
import type { NormalizedBoundingBox } from '../../contracts/geometry';
import type {
  StructuralModel,
  StructuralNormalizedRect,
  StructuralObjectHierarchy,
  StructuralObjectNode,
  StructuralPage,
  StructuralPageAnchorRelations,
  StructuralRefinedBorder,
  StructuralRefinedBorderSource
} from '../../contracts/structural-model';
import type {
  StructuralRefineAnalytics,
  StructuralRefineAnalyticsObject,
  StructuralRefineAnalyticsPage,
  WelfordRect
} from '../../contracts/structural-refine-analytics';
import {
  buildFieldRelationships,
  buildPageAnchorRelations
} from '../structure/object-hierarchy';

const BORDER_RECT: StructuralNormalizedRect = { xNorm: 0, yNorm: 0, wNorm: 1, hNorm: 1 };

/**
 * Floor confidence for objects that never appeared in any document. They are
 * preserved in the refined model (so downstream Run Mode still has the slot
 * to align against) but their reliability score must reflect that they
 * contributed no evidence.
 */
const ABSENT_OBJECT_CONFIDENCE_FLOOR = 0.05;

const driftMean = (drift: WelfordRect, fallback = 0): { x: number; y: number; w: number; h: number } => ({
  x: drift.xNorm.totalWeight > 0 ? drift.xNorm.mean : fallback,
  y: drift.yNorm.totalWeight > 0 ? drift.yNorm.mean : fallback,
  w: drift.wNorm.totalWeight > 0 ? drift.wNorm.mean : fallback,
  h: drift.hNorm.totalWeight > 0 ? drift.hNorm.mean : fallback
});

const shiftRectByDrift = (
  rect: StructuralNormalizedRect,
  drift: WelfordRect
): StructuralNormalizedRect => {
  const mean = driftMean(drift);
  return {
    xNorm: rect.xNorm + mean.x,
    yNorm: rect.yNorm + mean.y,
    wNorm: Math.max(0, rect.wNorm + mean.w),
    hNorm: Math.max(0, rect.hNorm + mean.h)
  };
};

const bboxUnion = (
  rects: readonly NormalizedBoundingBox[]
): NormalizedBoundingBox | null => {
  if (rects.length === 0) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    minX = Math.min(minX, rect.xNorm);
    minY = Math.min(minY, rect.yNorm);
    maxX = Math.max(maxX, rect.xNorm + rect.wNorm);
    maxY = Math.max(maxY, rect.yNorm + rect.hNorm);
  }
  return { xNorm: minX, yNorm: minY, wNorm: maxX - minX, hNorm: maxY - minY };
};

const rectUnion = (
  a: StructuralNormalizedRect,
  b: StructuralNormalizedRect
): StructuralNormalizedRect => {
  const minX = Math.min(a.xNorm, b.xNorm);
  const minY = Math.min(a.yNorm, b.yNorm);
  const maxX = Math.max(a.xNorm + a.wNorm, b.xNorm + b.wNorm);
  const maxY = Math.max(a.yNorm + a.hNorm, b.yNorm + b.hNorm);
  return { xNorm: minX, yNorm: minY, wNorm: maxX - minX, hNorm: maxY - minY };
};

const rectContainsRect = (
  outer: StructuralNormalizedRect,
  inner: StructuralNormalizedRect | NormalizedBoundingBox
): boolean => {
  const eps = 1e-9;
  return (
    inner.xNorm + eps >= outer.xNorm &&
    inner.yNorm + eps >= outer.yNorm &&
    inner.xNorm + inner.wNorm <= outer.xNorm + outer.wNorm + eps &&
    inner.yNorm + inner.hNorm <= outer.yNorm + outer.hNorm + eps
  );
};

const fieldBboxFromConfigPage = (
  configPage: StructuralPage
): Array<{ fieldId: string; bbox: NormalizedBoundingBox }> => {
  return configPage.fieldRelationships.map((field) => {
    // borderAnchor.relativeFieldRect uses border = {0,0,1,1}, so the relative
    // rect equals the bbox itself. This is the canonical place to recover the
    // saved field bbox without consulting the GeometryFile.
    const r = field.fieldAnchors.borderAnchor.relativeFieldRect;
    return {
      fieldId: field.fieldId,
      bbox: { xNorm: r.xRatio, yNorm: r.yRatio, wNorm: r.wRatio, hNorm: r.hRatio }
    };
  });
};

const buildRefinedBorder = (
  configRefined: StructuralRefinedBorder,
  fieldBboxes: readonly NormalizedBoundingBox[]
): StructuralRefinedBorder => {
  const fieldsUnion = bboxUnion(fieldBboxes);
  let rectNorm: StructuralNormalizedRect;
  let source: StructuralRefinedBorderSource;
  if (fieldsUnion) {
    rectNorm = rectUnion(configRefined.rectNorm, {
      xNorm: fieldsUnion.xNorm,
      yNorm: fieldsUnion.yNorm,
      wNorm: fieldsUnion.wNorm,
      hNorm: fieldsUnion.hNorm
    });
    source = 'cv-and-bbox-union';
  } else {
    rectNorm = { ...configRefined.rectNorm };
    source = 'cv-content';
  }

  const containsAll = fieldBboxes.every((bbox) => rectContainsRect(rectNorm, bbox));

  return {
    rectNorm,
    cvContentRectNorm: { ...configRefined.cvContentRectNorm },
    source,
    influencedByBBoxCount: fieldBboxes.length,
    containsAllSavedBBoxes: containsAll
  };
};

const buildRefinedHierarchy = (
  configPage: StructuralPage,
  analyticsPage: StructuralRefineAnalyticsPage | null
): StructuralObjectHierarchy => {
  const analyticsByObjectId = new Map<string, StructuralRefineAnalyticsObject>();
  if (analyticsPage) {
    for (const object of analyticsPage.objects) {
      analyticsByObjectId.set(object.configObjectId, object);
    }
  }

  const objects: StructuralObjectNode[] = configPage.objectHierarchy.objects.map((node) => {
    const analyticsObject = analyticsByObjectId.get(node.objectId);
    let refinedRect: StructuralNormalizedRect;
    let confidence: number;
    if (analyticsObject && analyticsObject.appearanceCount > 0) {
      refinedRect = shiftRectByDrift(node.objectRectNorm, analyticsObject.runtimePositionDrift);
      confidence = analyticsObject.reliability;
    } else {
      // Object never appeared — preserve config rect to keep the hierarchy
      // intact; floor confidence so downstream consumers see "no evidence"
      // honestly. Capped against the config confidence to avoid raising it.
      refinedRect = { ...node.objectRectNorm };
      confidence = Math.min(node.confidence, ABSENT_OBJECT_CONFIDENCE_FLOOR);
    }
    return {
      objectId: node.objectId,
      objectRectNorm: refinedRect,
      bbox: refinedRect,
      parentObjectId: node.parentObjectId,
      childObjectIds: [...node.childObjectIds],
      confidence,
      depth: node.depth
    };
  });

  return { objects };
};

const buildAnchorRelations = (
  hierarchy: StructuralObjectHierarchy,
  refinedBorderRect: StructuralNormalizedRect
): StructuralPageAnchorRelations => {
  return buildPageAnchorRelations({
    hierarchy,
    refinedBorderRect,
    borderRect: BORDER_RECT
  });
};

export interface ComposeRefinedStructuralModelOptions {
  /** ID stamped on the refined model. Defaults to a deterministic `refined-<analytics.id>`. */
  id?: string;
  /** ISO timestamp stamped as `createdAtIso`. Defaults to `new Date().toISOString()`. */
  nowIso?: string;
}

/**
 * Compose a refined `StructuralModel` from the analytics + config.
 *
 * Output passes `isStructuralModel`, preserves all object IDs, contains every
 * saved field BBOX inside `refinedBorder.rectNorm`, and round-trips through
 * `structural-model-io`.
 */
export const composeRefinedStructuralModel = (
  analytics: StructuralRefineAnalytics,
  configStructuralModel: StructuralModel,
  options: ComposeRefinedStructuralModelOptions = {}
): StructuralModel => {
  const analyticsByPageIndex = new Map<number, StructuralRefineAnalyticsPage>();
  for (const page of analytics.pages) {
    analyticsByPageIndex.set(page.pageIndex, page);
  }

  const refinedPages: StructuralPage[] = configStructuralModel.pages.map((configPage) => {
    const analyticsPage = analyticsByPageIndex.get(configPage.pageIndex) ?? null;

    const fieldBboxList = fieldBboxFromConfigPage(configPage);
    const fieldBboxes = fieldBboxList.map((entry) => entry.bbox);

    const refinedBorder = buildRefinedBorder(configPage.refinedBorder, fieldBboxes);
    const refinedHierarchy = buildRefinedHierarchy(configPage, analyticsPage);
    const pageAnchorRelations = buildAnchorRelations(refinedHierarchy, refinedBorder.rectNorm);

    const fieldRelationships = buildFieldRelationships({
      fields: fieldBboxList,
      borderRect: BORDER_RECT,
      refinedBorderRect: refinedBorder.rectNorm,
      hierarchy: refinedHierarchy
    });

    return {
      pageIndex: configPage.pageIndex,
      pageSurface: { ...configPage.pageSurface },
      cvExecutionMode: configPage.cvExecutionMode,
      border: { rectNorm: { ...BORDER_RECT } },
      refinedBorder,
      objectHierarchy: refinedHierarchy,
      pageAnchorRelations,
      fieldRelationships
    };
  });

  const id = options.id ?? `refined-${analytics.id}`;
  const nowIso = options.nowIso ?? new Date().toISOString();

  return {
    schema: 'wrokit/structural-model',
    version: '4.0',
    structureVersion: 'wrokit/structure/v3',
    id,
    documentFingerprint: `refined:${analytics.id}`,
    cvAdapter: { name: 'structural-refine', version: '1.0' },
    pages: refinedPages,
    createdAtIso: nowIso
  };
};
