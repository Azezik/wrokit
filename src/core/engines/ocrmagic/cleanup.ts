/**
 * Stage 2 of OCRMagic: safe, conservative edge cleanup.
 *
 * Removes obvious OCR artifacts caused by crops grabbing nearby borders,
 * separators, or punctuation. Returns the new value plus the reason codes
 * that explain which artifacts were removed.
 */

const LEADING_JUNK = /^[\s'`"|©®@*•·.,;:_~^\\/-]+/;
const TRAILING_JUNK = /[\s'`"|*•·,;:_~^\\/-]+$/;

const NBSP = / /g;
const ZERO_WIDTH = /[​-‍﻿]/g;
const MULTI_SPACE = /[ \t]{2,}/g;

export interface SafeCleanupResult {
  value: string;
  reasonCodes: string[];
  changed: boolean;
}

export const runSafeCleanup = (raw: string): SafeCleanupResult => {
  const reasonCodes: string[] = [];
  let next = raw;

  if (NBSP.test(next)) {
    next = next.replace(NBSP, ' ');
    reasonCodes.push('replaced-nbsp');
  }
  if (ZERO_WIDTH.test(next)) {
    next = next.replace(ZERO_WIDTH, '');
    reasonCodes.push('stripped-zero-width');
  }

  // Normalize internal whitespace: collapse runs of spaces/tabs but preserve newlines.
  if (MULTI_SPACE.test(next)) {
    next = next.replace(MULTI_SPACE, ' ');
    reasonCodes.push('collapsed-multi-space');
  }

  const trimmedSpace = next.replace(/^\s+|\s+$/g, '');
  if (trimmedSpace !== next) {
    next = trimmedSpace;
    reasonCodes.push('trimmed-whitespace');
  }

  const beforeLeading = next;
  next = next.replace(LEADING_JUNK, '');
  if (next !== beforeLeading) {
    reasonCodes.push('stripped-leading-edge-junk');
  }

  const beforeTrailing = next;
  next = next.replace(TRAILING_JUNK, '');
  if (next !== beforeTrailing) {
    reasonCodes.push('stripped-trailing-edge-junk');
  }

  // After stripping, run trim once more in case junk left bordering whitespace.
  const trimmedAgain = next.replace(/^\s+|\s+$/g, '');
  if (trimmedAgain !== next) {
    next = trimmedAgain;
    if (!reasonCodes.includes('trimmed-whitespace')) {
      reasonCodes.push('trimmed-whitespace');
    }
  }

  return { value: next, reasonCodes, changed: next !== raw };
};
