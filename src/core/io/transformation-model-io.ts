import {
  isTransformationModel,
  type TransformationModel
} from '../contracts/transformation-model';

export class TransformationModelParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransformationModelParseError';
  }
}

export const serializeTransformationModel = (model: TransformationModel): string =>
  JSON.stringify(model, null, 2);

export const parseTransformationModel = (text: string): TransformationModel => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TransformationModelParseError('Could not parse JSON file.');
  }

  if (!isTransformationModel(parsed)) {
    throw new TransformationModelParseError('Invalid TransformationModel JSON schema.');
  }

  return parsed;
};

export const transformationModelDownloadName = (model: TransformationModel): string => {
  const safeFingerprint = (model.runtime.documentFingerprint || 'document')
    .replace(/[^a-z0-9-]+/gi, '-')
    .toLowerCase()
    .slice(0, 48) || 'document';
  return `${safeFingerprint}.transformation.json`;
};

export interface TransformationModelDownloadEnv {
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  triggerAnchor: (url: string, fileName: string) => void;
}

const browserDownloadEnv = (): TransformationModelDownloadEnv => ({
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  triggerAnchor: (url, fileName) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  }
});

export const downloadTransformationModel = (
  model: TransformationModel,
  env: TransformationModelDownloadEnv = browserDownloadEnv()
): void => {
  const blob = new Blob([serializeTransformationModel(model)], { type: 'application/json' });
  const url = env.createObjectUrl(blob);
  try {
    env.triggerAnchor(url, transformationModelDownloadName(model));
  } finally {
    env.revokeObjectUrl(url);
  }
};
