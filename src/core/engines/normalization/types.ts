import type { NormalizedPage } from '../../contracts/normalized-page';

export interface RasterizedPageSurface {
  pageIndex: number;
  width: number;
  height: number;
  imageDataUrl: string;
}

export interface NormalizationResult {
  sourceName: string;
  pageCount: number;
  pages: NormalizedPage[];
}

export interface NormalizationEngine {
  normalize(file: File): Promise<NormalizationResult>;
}
