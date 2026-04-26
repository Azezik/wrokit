import type { RasterizedPageSurface } from './types';

export const rasterizeImageFile = async (file: File): Promise<RasterizedPageSurface[]> => {
  const bitmap = await createImageBitmap(file);

  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Could not create 2d canvas context for image normalization.');
    }

    context.drawImage(bitmap, 0, 0);

    return [
      {
        pageIndex: 0,
        width: canvas.width,
        height: canvas.height,
        imageDataUrl: canvas.toDataURL('image/png')
      }
    ];
  } finally {
    bitmap.close();
  }
};
