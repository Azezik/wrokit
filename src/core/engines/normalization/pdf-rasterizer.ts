import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import type { RasterizedPageSurface } from './types';

const PDF_RENDER_SCALE = 1.5;

let workerConfigured = false;

const ensureWorkerConfigured = () => {
  if (workerConfigured) {
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  workerConfigured = true;
};

export const rasterizePdfFile = async (file: File): Promise<RasterizedPageSurface[]> => {
  ensureWorkerConfigured();

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data: fileBytes });
  const pdf = await loadingTask.promise;

  try {
    const surfaces: RasterizedPageSurface[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);

        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('Could not create 2d canvas context for PDF normalization.');
        }

        await page.render({ canvasContext: context, viewport }).promise;

        surfaces.push({
          pageIndex: pageNumber - 1,
          width: canvas.width,
          height: canvas.height,
          imageDataUrl: canvas.toDataURL('image/png')
        });
      } finally {
        page.cleanup();
      }
    }

    return surfaces;
  } finally {
    await pdf.cleanup();
    await pdf.destroy();
  }
};
