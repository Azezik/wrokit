import type { NormalizedBoundingBox } from '../../contracts/geometry';
import type { NormalizedPage } from '../../contracts/normalized-page';

import type { OcrCropImage } from './types';

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export const padBboxNormalized = (
  bbox: NormalizedBoundingBox,
  paddingNorm: number
): NormalizedBoundingBox => {
  const safePadding = Math.max(0, Math.min(0.02, paddingNorm));
  const xNorm = clamp01(bbox.xNorm - safePadding);
  const yNorm = clamp01(bbox.yNorm - safePadding);
  const right = clamp01(bbox.xNorm + bbox.wNorm + safePadding);
  const bottom = clamp01(bbox.yNorm + bbox.hNorm + safePadding);
  return {
    xNorm,
    yNorm,
    wNorm: Math.max(0, right - xNorm),
    hNorm: Math.max(0, bottom - yNorm)
  };
};

const loadImage = (dataUrl: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load NormalizedPage image for OCRBOX crop.'));
    image.src = dataUrl;
  });

/**
 * Crop the canonical NormalizedPage raster to the (padded) bbox region.
 * The crop is rendered at NormalizedPage surface pixel scale — no DPR
 * scaling, no extra resampling beyond what the canvas does at draw time.
 * Returns null when the bbox collapses to zero pixels after padding.
 */
export const cropNormalizedPageBbox = async (
  page: NormalizedPage,
  bbox: NormalizedBoundingBox,
  paddingNorm: number
): Promise<OcrCropImage | null> => {
  const padded = padBboxNormalized(bbox, paddingNorm);
  const sx = padded.xNorm * page.width;
  const sy = padded.yNorm * page.height;
  const sw = padded.wNorm * page.width;
  const sh = padded.hNorm * page.height;
  const pixelWidth = Math.max(1, Math.round(sw));
  const pixelHeight = Math.max(1, Math.round(sh));
  if (sw <= 0.5 || sh <= 0.5) {
    return null;
  }

  const image = await loadImage(page.imageDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create 2d canvas context for OCRBOX crop.');
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, pixelWidth, pixelHeight);

  return {
    imageDataUrl: canvas.toDataURL('image/png'),
    pixelWidth,
    pixelHeight,
    bboxUsed: padded
  };
};
