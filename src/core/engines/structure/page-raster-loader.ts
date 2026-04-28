import type { NormalizedPage } from '../../contracts/normalized-page';
import type { PageSurface } from '../../page-surface/page-surface';

/**
 * Loads a NormalizedPage's image into RGBA pixel data ALIGNED to the canonical
 * NormalizedPage surface dimensions.
 *
 * Surface authority rules enforced here:
 * - The output ImageData has `width === surface.surfaceWidth` and
 *   `height === surface.surfaceHeight`. There is no separate CV-only image
 *   space; the raster the CV adapter sees is the same surface Geometry is
 *   captured against.
 * - No display scaling, no DPR scaling, no canvas-only coordinate space.
 */

export interface PageRasterLoaderEnv {
  createCanvas: (width: number, height: number) => HTMLCanvasElement;
  loadImage: (src: string) => Promise<HTMLImageElement | ImageBitmap>;
}

const browserEnv: PageRasterLoaderEnv = {
  createCanvas: (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  loadImage: async (src) => {
    if (typeof createImageBitmap === 'function') {
      const response = await fetch(src);
      const blob = await response.blob();
      return createImageBitmap(blob);
    }
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Could not load NormalizedPage raster.'));
      image.src = src;
    });
  }
};

export const loadPageSurfaceRaster = async (
  page: NormalizedPage,
  surface: PageSurface,
  env: PageRasterLoaderEnv = browserEnv
): Promise<ImageData> => {
  const surfaceWidth = Math.round(surface.surfaceWidth);
  const surfaceHeight = Math.round(surface.surfaceHeight);

  const canvas = env.createCanvas(surfaceWidth, surfaceHeight);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not create 2d canvas context for structural raster read.');
  }

  const image = await env.loadImage(page.imageDataUrl);
  try {
    context.drawImage(image as CanvasImageSource, 0, 0, surfaceWidth, surfaceHeight);
  } finally {
    if (typeof (image as ImageBitmap).close === 'function') {
      (image as ImageBitmap).close();
    }
  }

  return context.getImageData(0, 0, surfaceWidth, surfaceHeight);
};
