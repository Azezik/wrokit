import {
  isPredictedGeometryFile,
  type PredictedGeometryFile
} from '../contracts/predicted-geometry-file';

export class PredictedGeometryFileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PredictedGeometryFileParseError';
  }
}

export const serializePredictedGeometryFile = (file: PredictedGeometryFile): string =>
  JSON.stringify(file, null, 2);

export const parsePredictedGeometryFile = (text: string): PredictedGeometryFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PredictedGeometryFileParseError('Could not parse JSON file.');
  }

  if (!isPredictedGeometryFile(parsed)) {
    throw new PredictedGeometryFileParseError('Invalid PredictedGeometryFile JSON schema.');
  }

  return parsed;
};

export const predictedGeometryFileDownloadName = (file: PredictedGeometryFile): string => {
  const safeWizard = (file.wizardId || 'wizard').replace(/\s+/g, '-').toLowerCase();
  return `${safeWizard}.predicted-geometry.json`;
};

export interface PredictedGeometryFileDownloadEnv {
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  triggerAnchor: (url: string, fileName: string) => void;
}

const browserDownloadEnv = (): PredictedGeometryFileDownloadEnv => ({
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  triggerAnchor: (url, fileName) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  }
});

export const downloadPredictedGeometryFile = (
  file: PredictedGeometryFile,
  env: PredictedGeometryFileDownloadEnv = browserDownloadEnv()
): void => {
  const blob = new Blob([serializePredictedGeometryFile(file)], { type: 'application/json' });
  const url = env.createObjectUrl(blob);
  try {
    env.triggerAnchor(url, predictedGeometryFileDownloadName(file));
  } finally {
    env.revokeObjectUrl(url);
  }
};
