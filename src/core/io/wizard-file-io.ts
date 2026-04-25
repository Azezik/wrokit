import { isWizardFile, type WizardFile } from '../contracts/wizard';

export class WizardFileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WizardFileParseError';
  }
}

export const serializeWizardFile = (wizardFile: WizardFile): string =>
  JSON.stringify(wizardFile, null, 2);

export const parseWizardFile = (text: string): WizardFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WizardFileParseError('Could not parse JSON file.');
  }

  if (!isWizardFile(parsed)) {
    throw new WizardFileParseError('Invalid WizardFile JSON schema.');
  }

  return parsed;
};

export const wizardFileDownloadName = (wizardFile: WizardFile): string => {
  const safe = (wizardFile.wizardName || 'wizard').replace(/\s+/g, '-').toLowerCase();
  return `${safe}.wizard.json`;
};

export interface WizardFileDownloadEnv {
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  triggerAnchor: (url: string, fileName: string) => void;
}

const browserDownloadEnv = (): WizardFileDownloadEnv => ({
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  triggerAnchor: (url, fileName) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  }
});

export const downloadWizardFile = (
  wizardFile: WizardFile,
  env: WizardFileDownloadEnv = browserDownloadEnv()
): void => {
  const blob = new Blob([serializeWizardFile(wizardFile)], { type: 'application/json' });
  const url = env.createObjectUrl(blob);
  try {
    env.triggerAnchor(url, wizardFileDownloadName(wizardFile));
  } finally {
    env.revokeObjectUrl(url);
  }
};
