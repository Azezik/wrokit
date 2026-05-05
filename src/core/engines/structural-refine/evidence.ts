/**
 * Evidence extraction.
 *
 * Pure, read-only collapse of a single document's runtime artifacts into a
 * bounded, mergeable per-document record. The aggregator folds these records
 * into running statistics and immediately drops them — no raw `StructuralModel`,
 * `TransformationModel`, or `PredictedGeometryFile` is retained beyond the
 * call to `extractEvidence`.
 */
import type { GeometryFile } from '../../contracts/geometry';
import type {
  PredictedGeometryFile,
  RuntimeAnchorTier
} from '../../contracts/predicted-geometry-file';
import type {
  StructuralModel,
  StructuralNormalizedRect
} from '../../contracts/structural-model';
import type {
  TransformationAffine,
  TransformationConsensusOutlier,
  TransformationModel
} from '../../contracts/transformation-model';

export type DocumentEvidenceAnchorTier = 'A' | 'B' | 'C' | 'refined' | 'border';

export interface DocumentEvidenceObjectMatch {
  configObjectId: string;
  runtimeObjectId: string;
  matchConfidence: number;
  impliedAffine: TransformationAffine;
  /** Runtime-side rect of the matched object (for runtime-position-drift Welford). */
  runtimeRectNorm: StructuralNormalizedRect;
  /** Config-side rect of the matched object (cached so the aggregator can compute drift = runtime - config). */
  configRectNorm: StructuralNormalizedRect;
  /** IoU of the projected config rect against the runtime rect. Defaults to 0 when not computable. */
  projectionIou: number;
  isOutlierVsConsensus: boolean;
}

export interface DocumentEvidenceObjectPair {
  fromObjectId: string;
  toObjectId: string;
  /**
   * Center delta (`dxCenter`, `dyCenter`) and size ratio (`wRatio`, `hRatio`)
   * of the runtime "to" rect expressed relative to the runtime "from" rect.
   */
  dxCenter: number;
  dyCenter: number;
  wRatio: number;
  hRatio: number;
}

export interface DocumentEvidenceField {
  fieldId: string;
  anchorTier: DocumentEvidenceAnchorTier;
  predictedRectNorm: StructuralNormalizedRect;
  /** IoU of the predicted rect against the matched object's runtime rect; 0 when not applicable. */
  projectionIou: number;
  matchedObjectId: string | null;
}

export interface DocumentEvidencePage {
  pageIndex: number;
  pageSurface: { surfaceWidth: number; surfaceHeight: number };
  consensusAffine: TransformationAffine | null;
  consensusConfidence: number;
  consensusContributingMatchCount: number;
  refinedBorderDelta: TransformationAffine | null;
  objectMatches: DocumentEvidenceObjectMatch[];
  objectPairs: DocumentEvidenceObjectPair[];
  fields: DocumentEvidenceField[];
}

export interface DocumentEvidence {
  pages: DocumentEvidencePage[];
}

export interface ExtractEvidenceInput {
  runtimeStructure: StructuralModel;
  transformationModel: TransformationModel;
  predicted: PredictedGeometryFile;
  configStructural: StructuralModel;
  /**
   * Saved field BBOXes, used to scope evidence extraction to config-side
   * fields the wizard cares about. Pure — never mutated.
   */
  configGeometry: GeometryFile;
}

const EPS = 1e-9;

const rectArea = (rect: StructuralNormalizedRect): number => rect.wNorm * rect.hNorm;

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

const rectCenter = (rect: StructuralNormalizedRect): { x: number; y: number } => ({
  x: rect.xNorm + rect.wNorm / 2,
  y: rect.yNorm + rect.hNorm / 2
});

const applyAffineToRect = (
  rect: StructuralNormalizedRect,
  affine: TransformationAffine
): StructuralNormalizedRect => ({
  xNorm: rect.xNorm * affine.scaleX + affine.translateX,
  yNorm: rect.yNorm * affine.scaleY + affine.translateY,
  wNorm: rect.wNorm * affine.scaleX,
  hNorm: rect.hNorm * affine.scaleY
});

const anchorTierFromRuntime = (tier: RuntimeAnchorTier): DocumentEvidenceAnchorTier => {
  if (tier === 'field-object-a') return 'A';
  if (tier === 'field-object-b') return 'B';
  if (tier === 'field-object-c') return 'C';
  if (tier === 'refined-border') return 'refined';
  if (tier === 'border') return 'border';
  // 'page-consensus' — bucket under 'refined' for histogram purposes since
  // it is the page-level-level fallback used when no per-field anchor resolved.
  // The compose model never reads the histogram for projection truth, only as
  // a per-field reliability signal, so collapsing here is honest about
  // "this field did not pin to a specific object".
  return 'refined';
};

const isNearIdentity = (affine: TransformationAffine): boolean => {
  return (
    Math.abs(affine.scaleX - 1) < 0.01 &&
    Math.abs(affine.scaleY - 1) < 0.01 &&
    Math.abs(affine.translateX) < 0.005 &&
    Math.abs(affine.translateY) < 0.005
  );
};

/**
 * Per-document evidence extractor.
 *
 * Reads from the four read-only inputs and returns a bounded record. Touches
 * none of them; never retains a reference to any of the source artifacts in
 * its return value (rects are copied by value).
 */
export const extractEvidence = (input: ExtractEvidenceInput): DocumentEvidence => {
  const configObjectsByPage = new Map<
    number,
    Map<string, StructuralNormalizedRect>
  >();
  for (const page of input.configStructural.pages) {
    const ids = new Map<string, StructuralNormalizedRect>();
    for (const object of page.objectHierarchy.objects) {
      ids.set(object.objectId, { ...object.objectRectNorm });
    }
    configObjectsByPage.set(page.pageIndex, ids);
  }

  const runtimeObjectsByPage = new Map<
    number,
    Map<string, StructuralNormalizedRect>
  >();
  for (const page of input.runtimeStructure.pages) {
    const ids = new Map<string, StructuralNormalizedRect>();
    for (const object of page.objectHierarchy.objects) {
      ids.set(object.objectId, { ...object.objectRectNorm });
    }
    runtimeObjectsByPage.set(page.pageIndex, ids);
  }

  const fieldsByPage = new Map<number, Set<string>>();
  for (const field of input.configGeometry.fields) {
    if (!fieldsByPage.has(field.pageIndex)) {
      fieldsByPage.set(field.pageIndex, new Set<string>());
    }
    fieldsByPage.get(field.pageIndex)!.add(field.fieldId);
  }

  const predictedFieldsByPage = new Map<number, typeof input.predicted.fields>();
  for (const field of input.predicted.fields) {
    if (!predictedFieldsByPage.has(field.pageIndex)) {
      predictedFieldsByPage.set(field.pageIndex, []);
    }
    predictedFieldsByPage.get(field.pageIndex)!.push(field);
  }

  const pages: DocumentEvidencePage[] = input.transformationModel.pages.map((page) => {
    const configObjects = configObjectsByPage.get(page.pageIndex) ?? new Map();
    const runtimeObjects = runtimeObjectsByPage.get(page.pageIndex) ?? new Map();
    const runtimePage = input.runtimeStructure.pages.find(
      (p) => p.pageIndex === page.pageIndex
    );
    const configPage = input.configStructural.pages.find(
      (p) => p.pageIndex === page.pageIndex
    );

    const consensusTransform = page.consensus.transform ?? null;
    const consensusOutliersById = new Map<string, TransformationConsensusOutlier>();
    for (const outlier of page.consensus.outliers) {
      consensusOutliersById.set(outlier.configObjectId, outlier);
    }

    const refinedBorderSummary = page.levelSummaries.find(
      (summary) => summary.level === 'refined-border'
    );
    const refinedBorderDelta: TransformationAffine | null =
      refinedBorderSummary?.transform ?? null;

    const objectMatches: DocumentEvidenceObjectMatch[] = [];
    for (const match of page.objectMatches) {
      const configRect = configObjects.get(match.configObjectId);
      const runtimeRect = runtimeObjects.get(match.runtimeObjectId);
      if (!configRect || !runtimeRect) {
        continue;
      }
      const projectedConfig = applyAffineToRect(configRect, match.transform);
      const iou = rectIou(projectedConfig, runtimeRect);
      objectMatches.push({
        configObjectId: match.configObjectId,
        runtimeObjectId: match.runtimeObjectId,
        matchConfidence: match.confidence,
        impliedAffine: { ...match.transform },
        runtimeRectNorm: { ...runtimeRect },
        configRectNorm: { ...configRect },
        projectionIou: iou,
        isOutlierVsConsensus: consensusOutliersById.has(match.configObjectId)
      });
    }

    const objectPairs: DocumentEvidenceObjectPair[] = [];
    for (let i = 0; i < objectMatches.length; i += 1) {
      const from = objectMatches[i];
      const fromCenter = rectCenter(from.runtimeRectNorm);
      const fromW = Math.max(from.runtimeRectNorm.wNorm, EPS);
      const fromH = Math.max(from.runtimeRectNorm.hNorm, EPS);
      for (let j = 0; j < objectMatches.length; j += 1) {
        if (i === j) {
          continue;
        }
        const to = objectMatches[j];
        const toCenter = rectCenter(to.runtimeRectNorm);
        objectPairs.push({
          fromObjectId: from.configObjectId,
          toObjectId: to.configObjectId,
          dxCenter: (toCenter.x - fromCenter.x) / fromW,
          dyCenter: (toCenter.y - fromCenter.y) / fromH,
          wRatio: to.runtimeRectNorm.wNorm / fromW,
          hRatio: to.runtimeRectNorm.hNorm / fromH
        });
      }
    }

    const fields: DocumentEvidenceField[] = [];
    const configFieldIds = fieldsByPage.get(page.pageIndex) ?? new Set<string>();
    const predictedFields = predictedFieldsByPage.get(page.pageIndex) ?? [];
    for (const predicted of predictedFields) {
      if (!configFieldIds.has(predicted.fieldId)) {
        continue;
      }
      const matchedConfigObjectId = predicted.transform.configObjectId ?? null;
      const matchedRuntimeObjectId = predicted.transform.runtimeObjectId ?? null;
      let projectionIou = 0;
      if (matchedRuntimeObjectId) {
        const runtimeRect = runtimeObjects.get(matchedRuntimeObjectId);
        if (runtimeRect) {
          projectionIou = rectIou(predicted.bbox, runtimeRect);
        }
      }
      fields.push({
        fieldId: predicted.fieldId,
        anchorTier: anchorTierFromRuntime(predicted.anchorTierUsed),
        predictedRectNorm: { ...predicted.bbox },
        projectionIou,
        matchedObjectId: matchedConfigObjectId
      });
    }

    // Even when the transformation page produced no consensus outliers, treat
    // matches whose implied affine is far from the page consensus as outliers.
    // This keeps the outlier-vs-consensus signal honest when the transformation
    // runner has not yet populated `consensus.outliers` (e.g. early-stage
    // implementations) without overriding its decision when it has.
    if (consensusTransform && consensusOutliersById.size === 0) {
      for (const match of objectMatches) {
        const delta: TransformationAffine = {
          scaleX: match.impliedAffine.scaleX - consensusTransform.scaleX,
          scaleY: match.impliedAffine.scaleY - consensusTransform.scaleY,
          translateX: match.impliedAffine.translateX - consensusTransform.translateX,
          translateY: match.impliedAffine.translateY - consensusTransform.translateY
        };
        if (!isNearIdentity(delta)) {
          match.isOutlierVsConsensus = true;
        }
      }
    }

    const pageSurface = runtimePage?.pageSurface ?? configPage?.pageSurface ?? {
      pageIndex: page.pageIndex,
      surfaceWidth: 0,
      surfaceHeight: 0
    };

    return {
      pageIndex: page.pageIndex,
      pageSurface: {
        surfaceWidth: pageSurface.surfaceWidth,
        surfaceHeight: pageSurface.surfaceHeight
      },
      consensusAffine: consensusTransform ? { ...consensusTransform } : null,
      consensusConfidence: page.consensus.confidence,
      consensusContributingMatchCount: page.consensus.contributingMatchCount,
      refinedBorderDelta: refinedBorderDelta ? { ...refinedBorderDelta } : null,
      objectMatches,
      objectPairs,
      fields
    };
  });

  return { pages };
};
