import type { GeometryFile, NormalizedBoundingBox } from '../../contracts/geometry';
import type { NormalizedPage } from '../../contracts/normalized-page';
import type {
  StructuralBorder,
  StructuralFieldRelationship,
  StructuralModel,
  StructuralNormalizedRect,
  StructuralPage,
  StructuralRefinedBorder,
  StructuralRefinedBorderSource
} from '../../contracts/structural-model';
import {
  getPageSurface,
  surfaceRectToNormalized,
  type PageSurface,
  type PixelRect
} from '../../page-surface/page-surface';

import type { CvAdapter, CvSurfaceRaster } from './cv/cv-adapter';
import { loadPageSurfaceRaster, type PageRasterLoaderEnv } from './page-raster-loader';
import { buildFieldRelationships, buildObjectHierarchy, buildPageAnchorRelations } from './object-hierarchy';
import type { StructuralEngine, StructuralEngineInput } from './types';

const STRUCTURE_VERSION = 'wrokit/structure/v3' as const;
const SCHEMA_VERSION = '4.0' as const;

const generateId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `str_${crypto.randomUUID()}`;
  }
  return `str_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const FULL_PAGE_RECT: StructuralNormalizedRect = {
  xNorm: 0,
  yNorm: 0,
  wNorm: 1,
  hNorm: 1
};

const buildBorder = (): StructuralBorder => ({ rectNorm: { ...FULL_PAGE_RECT } });

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const unionNormalizedRects = (
  a: StructuralNormalizedRect,
  b: NormalizedBoundingBox
): StructuralNormalizedRect => {
  const aLeft = a.xNorm;
  const aTop = a.yNorm;
  const aRight = a.xNorm + a.wNorm;
  const aBottom = a.yNorm + a.hNorm;

  const bLeft = b.xNorm;
  const bTop = b.yNorm;
  const bRight = b.xNorm + b.wNorm;
  const bBottom = b.yNorm + b.hNorm;

  const left = Math.min(aLeft, bLeft);
  const top = Math.min(aTop, bTop);
  const right = Math.max(aRight, bRight);
  const bottom = Math.max(aBottom, bBottom);

  return {
    xNorm: clamp01(left),
    yNorm: clamp01(top),
    wNorm: clamp01(right - left),
    hNorm: clamp01(bottom - top)
  };
};

const surfaceRectToStructuralNorm = (
  surface: PageSurface,
  rect: PixelRect
): StructuralNormalizedRect => {
  const normalized = surfaceRectToNormalized(surface, rect);
  return {
    xNorm: normalized.xNorm,
    yNorm: normalized.yNorm,
    wNorm: normalized.wNorm,
    hNorm: normalized.hNorm
  };
};

const containsRect = (
  outer: StructuralNormalizedRect,
  inner: NormalizedBoundingBox,
  epsilon = 1e-6
): boolean => {
  return (
    inner.xNorm + epsilon >= outer.xNorm &&
    inner.yNorm + epsilon >= outer.yNorm &&
    inner.xNorm + inner.wNorm <= outer.xNorm + outer.wNorm + epsilon &&
    inner.yNorm + inner.hNorm <= outer.yNorm + outer.hNorm + epsilon
  );
};

const normalizedRectIsValid = (rect: StructuralNormalizedRect): boolean =>
  Number.isFinite(rect.xNorm) &&
  Number.isFinite(rect.yNorm) &&
  Number.isFinite(rect.wNorm) &&
  Number.isFinite(rect.hNorm) &&
  rect.wNorm > 0 &&
  rect.hNorm > 0 &&
  rect.xNorm >= 0 &&
  rect.yNorm >= 0 &&
  rect.xNorm + rect.wNorm <= 1 + 1e-9 &&
  rect.yNorm + rect.hNorm <= 1 + 1e-9;

const collectGeometryForPage = (
  geometry: GeometryFile | null | undefined,
  pageIndex: number
): NormalizedBoundingBox[] => {
  if (!geometry) {
    return [];
  }
  return geometry.fields
    .filter((field) => field.pageIndex === pageIndex)
    .map((field) => field.bbox);
};

const collectGeometryFieldsForPage = (
  geometry: GeometryFile | null | undefined,
  pageIndex: number
): Array<{ fieldId: string; bbox: NormalizedBoundingBox }> => {
  if (!geometry) {
    return [];
  }
  return geometry.fields
    .filter((field) => field.pageIndex === pageIndex)
    .map((field) => ({ fieldId: field.fieldId, bbox: field.bbox }));
};

interface BuildRefinedBorderInput {
  surface: PageSurface;
  cvContentSurfaceRect: PixelRect;
  bboxes: NormalizedBoundingBox[];
}

const buildRefinedBorder = (input: BuildRefinedBorderInput): StructuralRefinedBorder => {
  const cvNorm = surfaceRectToStructuralNorm(input.surface, input.cvContentSurfaceRect);

  const cvUsable = normalizedRectIsValid(cvNorm);
  let rect: StructuralNormalizedRect;
  let source: StructuralRefinedBorderSource;
  // Comparable, unexpanded cv-content rect — produced identically by config and
  // runtime so refined-border projection math sees a symmetric pair regardless
  // of whether saved BBOXes were available at build time. `rectNorm` continues
  // to carry the bbox-union + invariant expansion used for ground-truth
  // containment.
  let cvContentRectNorm: StructuralNormalizedRect;

  if (input.bboxes.length === 0) {
    if (cvUsable) {
      rect = cvNorm;
      source = 'cv-content';
      cvContentRectNorm = cvNorm;
    } else {
      rect = { ...FULL_PAGE_RECT };
      source = 'full-page-fallback';
      cvContentRectNorm = { ...FULL_PAGE_RECT };
    }
  } else if (!cvUsable) {
    rect = input.bboxes.reduce<StructuralNormalizedRect>(
      (acc, bbox) => unionNormalizedRects(acc, bbox),
      {
        xNorm: input.bboxes[0].xNorm,
        yNorm: input.bboxes[0].yNorm,
        wNorm: input.bboxes[0].wNorm,
        hNorm: input.bboxes[0].hNorm
      }
    );
    source = 'bbox-union';
    // No separate cv-only signal exists on this branch; mirror `rectNorm` so
    // downstream consumers always have a finite rect to project against.
    cvContentRectNorm = { ...rect };
  } else {
    rect = input.bboxes.reduce<StructuralNormalizedRect>(
      (acc, bbox) => unionNormalizedRects(acc, bbox),
      cvNorm
    );
    source = 'cv-and-bbox-union';
    cvContentRectNorm = cvNorm;
  }

  // Ground truth invariant: every saved BBOX MUST be inside the refined border.
  // If any bbox escapes (rounding, degenerate cv input), expand to include it.
  // We never crop a bbox; we expand the refined border instead.
  let expandedForBBoxes = false;
  for (const bbox of input.bboxes) {
    if (!containsRect(rect, bbox)) {
      rect = unionNormalizedRects(rect, bbox);
      expandedForBBoxes = true;
    }
  }
  if (expandedForBBoxes && source === 'cv-content') {
    source = 'cv-and-bbox-union';
  }

  return {
    rectNorm: rect,
    cvContentRectNorm,
    source,
    influencedByBBoxCount: input.bboxes.length,
    containsAllSavedBBoxes: input.bboxes.every((bbox) => containsRect(rect, bbox))
  };
};

export interface CreateStructuralEngineOptions {
  cvAdapter: CvAdapter;
  rasterLoader?: typeof loadPageSurfaceRaster;
  rasterLoaderEnv?: PageRasterLoaderEnv;
}

export const createStructuralEngine = (
  options: CreateStructuralEngineOptions
): StructuralEngine => {
  const rasterLoader = options.rasterLoader ?? loadPageSurfaceRaster;

  const computePage = async (
    page: NormalizedPage,
    geometry: GeometryFile | null | undefined
  ): Promise<StructuralPage> => {
    const surface = getPageSurface(page);
    const pixels = await rasterLoader(page, surface, options.rasterLoaderEnv);

    const rasterInput: CvSurfaceRaster = { surface, pixels };
    const cvResult = await options.cvAdapter.detectContentRect(rasterInput);

    const bboxes = collectGeometryForPage(geometry, page.pageIndex);
    const geometryFields = collectGeometryFieldsForPage(geometry, page.pageIndex);

    const refinedBorder = buildRefinedBorder({
      surface,
      cvContentSurfaceRect: cvResult.contentRectSurface,
      bboxes
    });

    const hierarchy = buildObjectHierarchy(
      cvResult.objectsSurface.map((object) => ({
        objectId: object.objectId,
        bbox: surfaceRectToStructuralNorm(surface, object.bboxSurface),
        confidence: object.confidence
      }))
    );

    const fieldRelationships: StructuralFieldRelationship[] = buildFieldRelationships({
      fields: geometryFields,
      borderRect: FULL_PAGE_RECT,
      refinedBorderRect: refinedBorder.cvContentRectNorm,
      hierarchy
    });

    const pageAnchorRelations = buildPageAnchorRelations({
      hierarchy,
      refinedBorderRect: refinedBorder.rectNorm,
      borderRect: FULL_PAGE_RECT
    });

    return {
      pageIndex: page.pageIndex,
      pageSurface: {
        pageIndex: surface.pageIndex,
        surfaceWidth: surface.surfaceWidth,
        surfaceHeight: surface.surfaceHeight
      },
      cvExecutionMode: cvResult.executionMode,
      border: buildBorder(),
      refinedBorder,
      objectHierarchy: hierarchy,
      pageAnchorRelations,
      fieldRelationships
    };
  };

  return {
    name: 'structural-engine',
    version: STRUCTURE_VERSION,
    run: async (input: StructuralEngineInput): Promise<StructuralModel> => {
      const filter = input.pageIndexes ? new Set(input.pageIndexes) : null;
      const targetPages = filter
        ? input.pages.filter((page) => filter.has(page.pageIndex))
        : input.pages;

      const pages: StructuralPage[] = [];
      for (const page of targetPages) {
        const structuralPage = await computePage(page, input.geometry ?? null);
        pages.push(structuralPage);
      }

      return {
        schema: 'wrokit/structural-model',
        version: SCHEMA_VERSION,
        structureVersion: STRUCTURE_VERSION,
        id: input.id ?? generateId(),
        documentFingerprint: input.documentFingerprint,
        cvAdapter: {
          name: options.cvAdapter.name,
          version: options.cvAdapter.version
        },
        pages,
        createdAtIso: input.nowIso ?? new Date().toISOString()
      };
    }
  };
};

export const __testing = {
  buildRefinedBorder,
  unionNormalizedRects,
  containsRect,
  surfaceRectToStructuralNorm,
  FULL_PAGE_RECT
};
