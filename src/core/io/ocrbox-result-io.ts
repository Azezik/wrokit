import { isOcrBoxResult, type OcrBoxResult } from '../contracts/ocrbox-result';

export class OcrBoxResultParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrBoxResultParseError';
  }
}

export const serializeOcrBoxResult = (result: OcrBoxResult): string =>
  JSON.stringify(result, null, 2);

export const parseOcrBoxResult = (text: string): OcrBoxResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OcrBoxResultParseError('Could not parse JSON file.');
  }
  if (!isOcrBoxResult(parsed)) {
    throw new OcrBoxResultParseError('Invalid OcrBoxResult JSON schema.');
  }
  return parsed;
};

export const ocrBoxResultDownloadName = (result: OcrBoxResult): string => {
  const safeWizard = (result.wizardId || 'wizard').replace(/\s+/g, '-').toLowerCase();
  return `${safeWizard}.ocrbox.json`;
};

export interface OcrBoxResultDownloadEnv {
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  triggerAnchor: (url: string, fileName: string) => void;
}

const browserDownloadEnv = (): OcrBoxResultDownloadEnv => ({
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  triggerAnchor: (url, fileName) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  }
});

export const downloadOcrBoxResult = (
  result: OcrBoxResult,
  env: OcrBoxResultDownloadEnv = browserDownloadEnv()
): void => {
  const blob = new Blob([serializeOcrBoxResult(result)], { type: 'application/json' });
  const url = env.createObjectUrl(blob);
  try {
    env.triggerAnchor(url, ocrBoxResultDownloadName(result));
  } finally {
    env.revokeObjectUrl(url);
  }
};
