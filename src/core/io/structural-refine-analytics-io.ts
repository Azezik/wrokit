import {
  isStructuralRefineAnalytics,
  type StructuralRefineAnalytics
} from '../contracts/structural-refine-analytics';

export class StructuralRefineAnalyticsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuralRefineAnalyticsParseError';
  }
}

export const serializeStructuralRefineAnalytics = (
  analytics: StructuralRefineAnalytics
): string => JSON.stringify(analytics, null, 2);

export const parseStructuralRefineAnalytics = (
  text: string
): StructuralRefineAnalytics => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StructuralRefineAnalyticsParseError('Could not parse JSON file.');
  }

  if (!isStructuralRefineAnalytics(parsed)) {
    throw new StructuralRefineAnalyticsParseError(
      'Invalid StructuralRefineAnalytics JSON schema.'
    );
  }

  return parsed;
};

export const structuralRefineAnalyticsDownloadName = (
  analytics: StructuralRefineAnalytics
): string => {
  const safeId = (analytics.id || 'analytics')
    .replace(/[^a-z0-9-]+/gi, '-')
    .toLowerCase()
    .slice(0, 48) || 'analytics';
  return `${safeId}.refine-analytics.json`;
};

export interface StructuralRefineAnalyticsDownloadEnv {
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  triggerAnchor: (url: string, fileName: string) => void;
}

const browserDownloadEnv = (): StructuralRefineAnalyticsDownloadEnv => ({
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  triggerAnchor: (url, fileName) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  }
});

export const downloadStructuralRefineAnalytics = (
  analytics: StructuralRefineAnalytics,
  env: StructuralRefineAnalyticsDownloadEnv = browserDownloadEnv()
): void => {
  const blob = new Blob([serializeStructuralRefineAnalytics(analytics)], {
    type: 'application/json'
  });
  const url = env.createObjectUrl(blob);
  try {
    env.triggerAnchor(url, structuralRefineAnalyticsDownloadName(analytics));
  } finally {
    env.revokeObjectUrl(url);
  }
};
