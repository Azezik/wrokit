import { isStructuralModel, type StructuralModel } from '../contracts/structural-model';

export class StructuralModelParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuralModelParseError';
  }
}

export const serializeStructuralModel = (model: StructuralModel): string =>
  JSON.stringify(model, null, 2);

export const parseStructuralModel = (text: string): StructuralModel => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StructuralModelParseError('Could not parse JSON file.');
  }

  if (!isStructuralModel(parsed)) {
    throw new StructuralModelParseError('Invalid StructuralModel JSON schema.');
  }

  return parsed;
};

export const structuralModelDownloadName = (model: StructuralModel): string => {
  const safeFingerprint = (model.documentFingerprint || 'document')
    .replace(/[^a-z0-9-]+/gi, '-')
    .toLowerCase()
    .slice(0, 48) || 'document';
  return `${safeFingerprint}.structural.json`;
};

export interface StructuralModelDownloadEnv {
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  triggerAnchor: (url: string, fileName: string) => void;
}

const browserDownloadEnv = (): StructuralModelDownloadEnv => ({
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  triggerAnchor: (url, fileName) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  }
});

export const downloadStructuralModel = (
  model: StructuralModel,
  env: StructuralModelDownloadEnv = browserDownloadEnv()
): void => {
  const blob = new Blob([serializeStructuralModel(model)], { type: 'application/json' });
  const url = env.createObjectUrl(blob);
  try {
    env.triggerAnchor(url, structuralModelDownloadName(model));
  } finally {
    env.revokeObjectUrl(url);
  }
};
