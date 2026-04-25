export type NormalizedPageColorMode = 'grayscale' | 'rgb' | 'rgba';

export interface NormalizedPage {
  schema: 'wrokit/normalized-page';
  version: '1.0';
  pageIndex: number;
  width: number;
  height: number;
  imageDataUrl: string;
  dpi: number;
  colorMode: NormalizedPageColorMode;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isColorMode = (value: unknown): value is NormalizedPageColorMode =>
  value === 'grayscale' || value === 'rgb' || value === 'rgba';

export const isNormalizedPage = (value: unknown): value is NormalizedPage => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.schema === 'wrokit/normalized-page' &&
    value.version === '1.0' &&
    typeof value.pageIndex === 'number' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    typeof value.imageDataUrl === 'string' &&
    typeof value.dpi === 'number' &&
    isColorMode(value.colorMode)
  );
};
