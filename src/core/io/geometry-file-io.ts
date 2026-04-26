import { isGeometryFile, type GeometryFile } from '../contracts/geometry';

export class GeometryFileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeometryFileParseError';
  }
}

export const serializeGeometryFile = (geometryFile: GeometryFile): string =>
  JSON.stringify(geometryFile, null, 2);

export const parseGeometryFile = (text: string): GeometryFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeometryFileParseError('Could not parse JSON file.');
  }

  if (!isGeometryFile(parsed)) {
    throw new GeometryFileParseError('Invalid GeometryFile JSON schema.');
  }

  return parsed;
};

export const geometryFileDownloadName = (geometryFile: GeometryFile): string => {
  const safeWizard = (geometryFile.wizardId || 'wizard').replace(/\s+/g, '-').toLowerCase();
  return `${safeWizard}.geometry.json`;
};

export interface GeometryFileDownloadEnv {
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  triggerAnchor: (url: string, fileName: string) => void;
}

const browserDownloadEnv = (): GeometryFileDownloadEnv => ({
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  triggerAnchor: (url, fileName) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  }
});

export const downloadGeometryFile = (
  geometryFile: GeometryFile,
  env: GeometryFileDownloadEnv = browserDownloadEnv()
): void => {
  const blob = new Blob([serializeGeometryFile(geometryFile)], { type: 'application/json' });
  const url = env.createObjectUrl(blob);
  try {
    env.triggerAnchor(url, geometryFileDownloadName(geometryFile));
  } finally {
    env.revokeObjectUrl(url);
  }
};
