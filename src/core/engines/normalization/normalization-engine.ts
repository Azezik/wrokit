import type { NormalizedPage } from '../../contracts/normalized-page';

import { rasterizeImageFile } from './image-rasterizer';
import { rasterizePdfFile } from './pdf-rasterizer';
import type { NormalizationEngine, NormalizationResult, RasterizedPageSurface } from './types';

const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PDF_MIME_TYPE = 'application/pdf';

const assertSupportedFile = (file: File) => {
  if (file.type === PDF_MIME_TYPE || ACCEPTED_IMAGE_TYPES.has(file.type)) {
    return;
  }

  throw new Error('Unsupported file type. Upload PDF, PNG, JPG/JPEG, or WebP.');
};

const toNormalizedPage = (surface: RasterizedPageSurface, sourceName: string): NormalizedPage => ({
  schema: 'wrokit/normalized-page',
  version: '2.0',
  pageIndex: surface.pageIndex,
  width: surface.width,
  height: surface.height,
  aspectRatio: surface.width / surface.height,
  imageDataUrl: surface.imageDataUrl,
  sourceName,
  normalization: {
    normalizedAtIso: new Date().toISOString(),
    boundary: 'intake-raster-only',
    pipelineVersion: '1.0'
  }
});

export const createNormalizationEngine = (): NormalizationEngine => ({
  normalize: async (file: File): Promise<NormalizationResult> => {
    assertSupportedFile(file);

    const rasterized =
      file.type === PDF_MIME_TYPE ? await rasterizePdfFile(file) : await rasterizeImageFile(file);

    const pages = rasterized.map((surface) => toNormalizedPage(surface, file.name));

    return {
      sourceName: file.name,
      pageCount: pages.length,
      pages
    };
  }
});
