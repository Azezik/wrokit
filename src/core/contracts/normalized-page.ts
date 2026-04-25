export interface NormalizedPage {
  pageIndex: number;
  width: number;
  height: number;
  imageDataUrl: string;
  dpi: number;
  colorMode: 'grayscale' | 'rgb' | 'rgba';
}
