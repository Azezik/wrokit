export interface NormalizationMetadata {
  normalizedAtIso: string;
  boundary: 'intake-raster-only';
  pipelineVersion: '1.0';
}

export interface NormalizedPage {
  schema: 'wrokit/normalized-page';
  version: '2.0';
  pageIndex: number;
  width: number;
  height: number;
  aspectRatio: number;
  imageDataUrl?: string;
  imageBlobUrl?: string;
  sourceName: string; // display-only metadata; must not drive downstream logic
  normalization: NormalizationMetadata;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNormalizationMetadata = (value: unknown): value is NormalizationMetadata => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.normalizedAtIso === 'string' &&
    value.boundary === 'intake-raster-only' &&
    value.pipelineVersion === '1.0'
  );
};

export const isNormalizedPage = (value: unknown): value is NormalizedPage => {
  if (!isRecord(value)) {
    return false;
  }

  const hasImageSurface =
    typeof value.imageDataUrl === 'string' || typeof value.imageBlobUrl === 'string';

  return (
    value.schema === 'wrokit/normalized-page' &&
    value.version === '2.0' &&
    typeof value.pageIndex === 'number' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    typeof value.aspectRatio === 'number' &&
    hasImageSurface &&
    typeof value.sourceName === 'string' &&
    isNormalizationMetadata(value.normalization)
  );
};
