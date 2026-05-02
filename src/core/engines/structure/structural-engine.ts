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

import type { CvAdapter, CvSurfaceObject, CvSurfaceRaster } from './cv/cv-adapter';
import {
  buildLineBoundedRects,
  detectLineSegments,
  type SizeRelativeThresholds
} from './cv/line-grid-detector';
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

/**
 * Re-run line/text-row detection scoped to each blob-shaped CV object that
 * carries no contained child object and whose normalized footprint is large
 * enough to plausibly contain interior structure (rows, cells).
 *
 * Blob detections (`obj_blob_*` from the heuristic path and non-cell contour
 * rects `obj_cv_*` from the OpenCV path) fire on line-sparse regions like
 * notes / signature panels — boxes whose interior is text rows separated by
 * baselines but no full-width horizontal rules. The first-pass detector
 * doesn't see line-bounded cells inside such boxes and emits a single flat
 * blob with no children. This decomposition relaxes the first-pass thresholds
 * (a row baseline doesn't need to span the full panel, just enough of a row
 * boundary to define a cell) and emits any sub-rects it finds as additional
 * objects, translated back into surface coordinates so the hierarchy pass
 * picks them up as children of the original blob.
 *
 * The minimum-size gate keeps small blobs (icons, short labels, glyphs that
 * survived the suppression floor) out of the decomposition; their interior
 * cannot reasonably contain meaningful sub-objects.
 */
const BLOB_DECOMPOSITION_MIN_AREA_NORM = 0.01;
const BLOB_DECOMPOSITION_THRESHOLD = 200;

const isBlobShapedObject = (objectId: string): boolean => {
  if (objectId.startsWith('obj_blob_')) {
    return true;
  }
  // OpenCV runtime contour rects use the `obj_cv_` prefix; cell rects from the
  // shared line-grid pipeline use `obj_cv_cell_` and do NOT need
  // decomposition (the line-grid path already exposed their interior).
  if (objectId.startsWith('obj_cv_') && !objectId.startsWith('obj_cv_cell_')) {
    return true;
  }
  return false;
};

const surfaceRectContains = (
  outer: PixelRect,
  inner: PixelRect,
  epsilon = 1
): boolean => {
  return (
    inner.x + epsilon >= outer.x &&
    inner.y + epsilon >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width + epsilon &&
    inner.y + inner.height <= outer.y + outer.height + epsilon
  );
};

const cropImageData = (src: ImageData, rect: PixelRect): ImageData => {
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const dst = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const srcY = y + y0;
    if (srcY >= src.height) break;
    const srcRowBase = srcY * src.width * 4;
    const dstRowBase = y * w * 4;
    for (let x = 0; x < w; x += 1) {
      const srcX = x + x0;
      if (srcX >= src.width) break;
      const srcIdx = srcRowBase + srcX * 4;
      const dstIdx = dstRowBase + x * 4;
      dst[dstIdx] = src.data[srcIdx];
      dst[dstIdx + 1] = src.data[srcIdx + 1];
      dst[dstIdx + 2] = src.data[srcIdx + 2];
      dst[dstIdx + 3] = src.data[srcIdx + 3];
    }
  }
  return { width: w, height: h, data: dst, colorSpace: src.colorSpace ?? 'srgb' } as unknown as ImageData;
};

const decomposeBlobsSecondPass = (
  pixels: ImageData,
  surface: PageSurface,
  objects: readonly CvSurfaceObject[]
): CvSurfaceObject[] => {
  if (objects.length === 0) {
    return [];
  }
  const surfaceArea = Math.max(1, surface.surfaceWidth * surface.surfaceHeight);
  const additions: CvSurfaceObject[] = [];

  for (const blob of objects) {
    if (!isBlobShapedObject(blob.objectId)) {
      continue;
    }
    const w = blob.bboxSurface.width;
    const h = blob.bboxSurface.height;
    if (w <= 0 || h <= 0) {
      continue;
    }
    const normArea = (w * h) / surfaceArea;
    if (normArea < BLOB_DECOMPOSITION_MIN_AREA_NORM) {
      continue;
    }
    // Skip blobs that already have at least one structurally contained child:
    // the first-pass detector already represented their interior structure.
    const hasChild = objects.some(
      (other) => other !== blob && surfaceRectContains(blob.bboxSurface, other.bboxSurface)
    );
    if (hasChild) {
      continue;
    }

    const cropped = cropImageData(pixels, blob.bboxSurface);
    const minSide = Math.max(1, Math.min(cropped.width, cropped.height));
    // Looser thresholds than the first pass: a row baseline inside a
    // signature box doesn't reach the panel edges, so minLineLengthPx must
    // shrink to ~20% of the panel side. The line-thickness ceiling stays
    // proportional so anti-aliased baselines (~2 px) still classify as
    // lines, not blobs.
    const subThresholds: SizeRelativeThresholds = {
      minObjectAreaPx: 16,
      minLineLengthPx: Math.max(8, Math.round(minSide * 0.2)),
      maxLineThicknessPx: Math.max(3, Math.round(minSide * 0.04))
    };
    const segments = detectLineSegments(cropped, BLOB_DECOMPOSITION_THRESHOLD, subThresholds);
    const subRects = buildLineBoundedRects(segments, {
      surfaceWidth: cropped.width,
      surfaceHeight: cropped.height
    });

    let subIndex = 0;
    for (const subRect of subRects) {
      const subW = subRect.right - subRect.left;
      const subH = subRect.bottom - subRect.top;
      if (subW <= 4 || subH <= 4) {
        continue;
      }
      // A sub-rect spanning the entire blob is just a re-emission of the
      // blob itself — drop it so we don't introduce a near-duplicate that
      // the trivial-containment dedup would have to clean up later.
      if (subW >= cropped.width - 2 && subH >= cropped.height - 2) {
        continue;
      }
      additions.push({
        objectId: `${blob.objectId}_sub_${subIndex}`,
        bboxSurface: {
          x: blob.bboxSurface.x + subRect.left,
          y: blob.bboxSurface.y + subRect.top,
          width: subW,
          height: subH
        },
        // Children inherit a slightly reduced confidence — they were derived
        // by relaxing the detection threshold, so they are softer evidence
        // than first-pass detections.
        confidence: Math.max(0.5, blob.confidence * 0.85)
      });
      subIndex += 1;
    }
  }

  return additions;
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

    const decomposedSubObjects = decomposeBlobsSecondPass(
      pixels,
      surface,
      cvResult.objectsSurface
    );
    const allSurfaceObjects: CvSurfaceObject[] = [
      ...cvResult.objectsSurface,
      ...decomposedSubObjects
    ];

    const hierarchy = buildObjectHierarchy(
      allSurfaceObjects.map((object) => ({
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
  decomposeBlobsSecondPass,
  FULL_PAGE_RECT
};
