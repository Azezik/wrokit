import type { FieldGeometry, GeometryFile, NormalizedBoundingBox, PixelBoundingBox } from '../contracts/geometry';
import type { NormalizedPage } from '../contracts/normalized-page';
import type { StructuralModel, StructuralNormalizedRect, StructuralPage } from '../contracts/structural-model';
import { getPageSurface } from '../page-surface/page-surface';

export interface RuntimeStructuralTransform {
  pageIndex: number;
  basis: 'refined-border';
  sourceConfigRectNorm: StructuralNormalizedRect;
  sourceRuntimeRectNorm: StructuralNormalizedRect;
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
}

export interface PredictedFieldGeometry {
  fieldId: string;
  pageIndex: number;
  bbox: NormalizedBoundingBox;
  pixelBbox: PixelBoundingBox;
  pageSurface: {
    pageIndex: number;
    surfaceWidth: number;
    surfaceHeight: number;
  };
  sourceGeometryConfirmedAtIso: string;
  sourceGeometryConfirmedBy: string;
  transform: RuntimeStructuralTransform;
}

export interface PredictedGeometryFile {
  schema: 'wrokit/predicted-geometry-file';
  version: '1.0';
  geometryFileVersion: 'wrokit/geometry/v1';
  structureVersion: 'wrokit/structure/v2';
  id: string;
  wizardId: string;
  sourceGeometryFileId: string;
  sourceStructuralModelId: string;
  runtimeDocumentFingerprint: string;
  predictedAtIso: string;
  fields: PredictedFieldGeometry[];
}

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

const isUsableDimension = (value: number): boolean => Number.isFinite(value) && value > 1e-9;

const solveTransform = (
  configPage: StructuralPage,
  runtimePage: StructuralPage,
  pageIndex: number
): RuntimeStructuralTransform => {
  const configRect = configPage.refinedBorder.rectNorm;
  const runtimeRect = runtimePage.refinedBorder.rectNorm;

  if (!isUsableDimension(configRect.wNorm) || !isUsableDimension(configRect.hNorm)) {
    throw new Error(`Config StructuralModel page ${pageIndex} refined border is not usable.`);
  }

  const scaleX = runtimeRect.wNorm / configRect.wNorm;
  const scaleY = runtimeRect.hNorm / configRect.hNorm;
  const translateX = runtimeRect.xNorm - configRect.xNorm * scaleX;
  const translateY = runtimeRect.yNorm - configRect.yNorm * scaleY;

  return {
    pageIndex,
    basis: 'refined-border',
    sourceConfigRectNorm: { ...configRect },
    sourceRuntimeRectNorm: { ...runtimeRect },
    scaleX,
    scaleY,
    translateX,
    translateY
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

const toPixelBbox = (bbox: NormalizedBoundingBox, page: NormalizedPage): PixelBoundingBox => ({
  x: bbox.xNorm * page.width,
  y: bbox.yNorm * page.height,
  width: bbox.wNorm * page.width,
  height: bbox.hNorm * page.height
});

const buildPredictedField = (
  source: FieldGeometry,
  runtimePage: NormalizedPage,
  transform: RuntimeStructuralTransform
): PredictedFieldGeometry => {
  const predictedBox = applyTransformToBox(source.bbox, transform);
  const runtimeSurface = getPageSurface(runtimePage);

  return {
    fieldId: source.fieldId,
    pageIndex: source.pageIndex,
    bbox: predictedBox,
    pixelBbox: toPixelBbox(predictedBox, runtimePage),
    pageSurface: {
      pageIndex: runtimeSurface.pageIndex,
      surfaceWidth: runtimeSurface.surfaceWidth,
      surfaceHeight: runtimeSurface.surfaceHeight
    },
    sourceGeometryConfirmedAtIso: source.confirmedAtIso,
    sourceGeometryConfirmedBy: source.confirmedBy,
    transform
  };
};

export const createLocalizationRunner = (): LocalizationRunner => ({
  run: async (input) => {
    const transformsByPage = new Map<number, RuntimeStructuralTransform>();

    for (const runtimePage of input.runtimePages) {
      const pageIndex = runtimePage.pageIndex;
      const configStructuralPage = getStructuralPage(input.configStructuralModel, pageIndex);
      const runtimeStructuralPage = getStructuralPage(input.runtimeStructuralModel, pageIndex);
      transformsByPage.set(pageIndex, solveTransform(configStructuralPage, runtimeStructuralPage, pageIndex));
    }

    const runtimePagesByIndex = new Map(input.runtimePages.map((page) => [page.pageIndex, page]));

    const fields = input.configGeometry.fields
      .filter((field) => runtimePagesByIndex.has(field.pageIndex))
      .map((field) => {
        const runtimePage = runtimePagesByIndex.get(field.pageIndex);
        const transform = transformsByPage.get(field.pageIndex);
        if (!runtimePage || !transform) {
          throw new Error(`Runtime page ${field.pageIndex} missing while building predicted geometry.`);
        }
        return buildPredictedField(field, runtimePage, transform);
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
  solveTransform,
  applyTransformToBox
};
