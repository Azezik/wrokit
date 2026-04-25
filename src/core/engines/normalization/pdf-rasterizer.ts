import type { RasterizedPageSurface } from './types';

const PDF_RENDER_SCALE = 1.5;
const PDF_JS_CDN_URL =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.mjs';

export const rasterizePdfFile = async (file: File): Promise<RasterizedPageSurface[]> => {
  const pdfJs = await import(/* @vite-ignore */ PDF_JS_CDN_URL);
  pdfJs.GlobalWorkerOptions.workerSrc = '';

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfJs.getDocument({ data: fileBytes, disableWorker: true });
  const pdf = await loadingTask.promise;

  const surfaces: RasterizedPageSurface[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
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
  }

  return surfaces;
};
