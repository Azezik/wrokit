/**
 * Stage 3 of OCRMagic: field-type-aware character substitutions.
 *
 * Substitutions are gated by the wizard's declared field type:
 *   - text:    a digit that visually resembles a letter is treated as a letter.
 *   - numeric: a letter that visually resembles a digit is treated as a digit.
 *   - any:     no aggressive substitutions; we have no context.
 *
 * Substitutions are character-local. A second `pattern-corrected` pass uses
 * the column profile to score whether the substituted candidate is actually
 * a better fit for the column shape than the cleaned baseline.
 */

import type { WizardFieldType } from '../../contracts/wizard';

const DIGIT_TO_LETTER: Record<string, string> = {
  '0': 'O',
  '1': 'I',
  '5': 'S',
  '8': 'B'
};

const LETTER_TO_DIGIT: Record<string, string> = {
  O: '0',
  o: '0',
  Q: '0',
  D: '0',
  I: '1',
  l: '1',
  '|': '1',
  S: '5',
  s: '5',
  B: '8',
  Z: '2',
  z: '2',
  G: '6'
};

export interface SubstitutionResult {
  value: string;
  changed: boolean;
}

export const applyTypeSubstitutions = (
  value: string,
  fieldType: WizardFieldType
): SubstitutionResult => {
  if (fieldType === 'any' || value.length === 0) {
    return { value, changed: false };
  }

  const map = fieldType === 'text' ? DIGIT_TO_LETTER : LETTER_TO_DIGIT;
  let changed = false;
  const out: string[] = [];

  for (const ch of value) {
    const sub = map[ch];
    if (sub !== undefined) {
      out.push(sub);
      changed = true;
    } else {
      out.push(ch);
    }
  }

  return { value: out.join(''), changed };
};

/**
 * Generate substitution candidates that flip ambiguous characters one-at-a-time
 * up to a small budget. Useful when a single OCR mis-read corrupts an
 * otherwise-conforming value.
 */
export const generateLocalCandidates = (
  value: string,
  fieldType: WizardFieldType,
  maxCandidates = 8
): string[] => {
  if (fieldType === 'any' || value.length === 0) {
    return [];
  }
  const map = fieldType === 'text' ? DIGIT_TO_LETTER : LETTER_TO_DIGIT;
  const candidates = new Set<string>();
  const chars = [...value];
  for (let i = 0; i < chars.length && candidates.size < maxCandidates; i += 1) {
    const sub = map[chars[i]];
    if (sub === undefined) {
      continue;
    }
    const next = [...chars];
    next[i] = sub;
    candidates.add(next.join(''));
  }
  return [...candidates];
};
