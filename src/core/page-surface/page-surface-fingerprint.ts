import type { NormalizedPage } from '../contracts/normalized-page';

export interface DocumentFingerprintInput {
  sourceName: string;
  pages: NormalizedPage[];
}

/**
 * Pure helper that derives a `documentFingerprint` for a set of NormalizedPages
 * produced from a single uploaded source. The format intentionally mirrors what
 * the per-stage NormalizedPage session store records, so any stage (Config
 * Capture, Run Mode, future runtimes) computes the same fingerprint for the
 * same input regardless of which stage owns the live session.
 *
 * No live state is shared; every stage calls this helper on its own pages
 * array.
 */
export const buildDocumentFingerprint = ({
  sourceName,
  pages
}: DocumentFingerprintInput): string => {
  const surfaceSignature = pages
    .map((page) => `${page.pageIndex}:${Math.round(page.width)}x${Math.round(page.height)}`)
    .join('|');

  return `surface:${sourceName}#${surfaceSignature}`;
};
