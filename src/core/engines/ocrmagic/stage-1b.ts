/**
 * Stage 1B — Small cleanup / normalization pass.
 *
 * Stage 1B only removes obvious junk around the actual value. It must not
 * aggressively rewrite the field; it just normalizes obvious edge garbage
 * (leading whitespace, leading apostrophe/quote, leading symbol+space,
 * trailing whitespace, trailing isolated junk separated from the value).
 *
 * Stage 1B applies to all field types: any, numeric, and text. Each field
 * type has its own dedicated entry point so its behaviour can be tuned
 * independently of the others.
 */

import type { WizardFieldType } from '../../contracts/wizard';

export interface Stage1bResult {
  value: string;
  changed: boolean;
  reasonCodes: string[];
}

const NBSP = / /g;
const ZERO_WIDTH = /[​-‍﻿]/g;
const MULTI_SPACE = /[ \t]{2,}/g;

// Leading garbage that should be stripped at the start of a cell.
// Includes whitespace, apostrophes, quotes, vertical bars, copyright/registered
// glyphs, and common stray punctuation.
const LEADING_JUNK = /^[\s'`"|©®@*•·.,;:_~^\\/()\-]+/;

// Trailing garbage symbols that should be stripped at the end of a cell.
const TRAILING_JUNK = /[\s'`"|*•·,;:_~^\\/()\-]+$/;

// Trailing isolated junk: a space followed by a short cluster of pure
// punctuation/symbols that is clearly not part of the real value.
// (Covers cases like "Bob@gmail.com (" → "Bob@gmail.com".)
const TRAILING_ISOLATED_JUNK = / [^\w@.+\-]{1,3}$/;

const collapseWhitespace = (input: string): { value: string; reasonCodes: string[] } => {
  const reasonCodes: string[] = [];
  let next = input;

  if (NBSP.test(next)) {
    next = next.replace(NBSP, ' ');
    reasonCodes.push('replaced-nbsp');
  }
  if (ZERO_WIDTH.test(next)) {
    next = next.replace(ZERO_WIDTH, '');
    reasonCodes.push('stripped-zero-width');
  }
  if (MULTI_SPACE.test(next)) {
    next = next.replace(MULTI_SPACE, ' ');
    reasonCodes.push('collapsed-multi-space');
  }
  return { value: next, reasonCodes };
};

const trimEdges = (input: string): { value: string; trimmed: boolean } => {
  const next = input.replace(/^\s+|\s+$/g, '');
  return { value: next, trimmed: next !== input };
};

const stripLeadingJunk = (input: string): { value: string; stripped: boolean } => {
  const next = input.replace(LEADING_JUNK, '');
  return { value: next, stripped: next !== input };
};

const stripTrailingJunk = (input: string): { value: string; stripped: boolean } => {
  let next = input.replace(TRAILING_ISOLATED_JUNK, '');
  next = next.replace(TRAILING_JUNK, '');
  return { value: next, stripped: next !== input };
};

/**
 * Shared edge-cleanup core used by every Stage 1B field-type branch today.
 * Each per-type wrapper can diverge from this in the future without
 * affecting the other types.
 */
const runEdgeCleanup = (raw: string): Stage1bResult => {
  const reasonCodes: string[] = [];
  let next = raw;

  const collapsed = collapseWhitespace(next);
  next = collapsed.value;
  reasonCodes.push(...collapsed.reasonCodes);

  const trimmed = trimEdges(next);
  if (trimmed.trimmed) {
    reasonCodes.push('trimmed-whitespace');
  }
  next = trimmed.value;

  const leading = stripLeadingJunk(next);
  if (leading.stripped) {
    reasonCodes.push('stripped-leading-edge-junk');
  }
  next = leading.value;

  const trailing = stripTrailingJunk(next);
  if (trailing.stripped) {
    reasonCodes.push('stripped-trailing-edge-junk');
  }
  next = trailing.value;

  // After stripping, run trim once more in case junk left bordering whitespace.
  const trimmedAgain = trimEdges(next);
  if (trimmedAgain.trimmed && !reasonCodes.includes('trimmed-whitespace')) {
    reasonCodes.push('trimmed-whitespace');
  }
  next = trimmedAgain.value;

  return { value: next, changed: next !== raw, reasonCodes };
};

/**
 * Stage 1B for `any` fields. Currently identical to the shared edge cleanup
 * logic, but isolated so future tweaks (e.g., disabling Stage 1B for `any`)
 * leave numeric and text behaviour untouched.
 */
export const runStage1bAny = (value: string): Stage1bResult => runEdgeCleanup(value);

/**
 * Stage 1B for `numeric` fields. Same edge cleanup as the shared core,
 * isolated so numeric-specific tweaks can be added later.
 */
export const runStage1bNumeric = (value: string): Stage1bResult => runEdgeCleanup(value);

/**
 * Stage 1B for `text` fields. Same edge cleanup as the shared core,
 * isolated so text-specific tweaks can be added later.
 */
export const runStage1bText = (value: string): Stage1bResult => runEdgeCleanup(value);

export const runStage1b = (value: string, fieldType: WizardFieldType): Stage1bResult => {
  switch (fieldType) {
    case 'any':
      return runStage1bAny(value);
    case 'numeric':
      return runStage1bNumeric(value);
    case 'text':
      return runStage1bText(value);
  }
};
