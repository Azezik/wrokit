/**
 * Stage 1 — Pure common-OCR substitution pass.
 *
 * Stage 1 only applies obvious character-for-character OCR mistakes based on
 * the user-declared field type. It does no normalization, no edge cleanup,
 * and no "guessing" about meaning.
 *
 * Each field type has its own dedicated function so changing one branch
 * (e.g., disabling Stage 1 for `any`) does not affect the others.
 */

import type { WizardFieldType } from '../../contracts/wizard';

export interface Stage1Result {
  value: string;
  changed: boolean;
  reasonCodes: string[];
}

/**
 * Numeric Stage 1 map: characters that visually resemble digits become digits.
 *
 * Limited to obvious letter→digit OCR mistakes. Stray pipes, brackets, and
 * other edge-noise characters are NOT here — those belong to Stage 1B
 * edge cleanup, not Stage 1 substitution.
 */
const NUMERIC_SUBSTITUTIONS: Record<string, string> = {
  O: '0',
  o: '0',
  Q: '0',
  I: '1',
  l: '1',
  L: '1',
  Z: '2',
  z: '2',
  S: '5',
  s: '5',
  G: '6',
  B: '8'
};

/**
 * Text Stage 1 map: digits that visually resemble letters become letters.
 */
const TEXT_SUBSTITUTIONS: Record<string, string> = {
  '0': 'O',
  '1': 'I',
  '5': 'S',
  '8': 'B'
};

const applyMap = (value: string, map: Record<string, string>): Stage1Result => {
  if (value.length === 0) {
    return { value, changed: false, reasonCodes: [] };
  }
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
  return {
    value: out.join(''),
    changed,
    reasonCodes: changed ? ['stage-1-substituted'] : []
  };
};

/**
 * Stage 1 for `any` fields — explicitly does nothing. The system must not
 * touch these values at all during the Stage 1 substitution pass.
 */
export const runStage1Any = (value: string): Stage1Result => ({
  value,
  changed: false,
  reasonCodes: []
});

/**
 * Stage 1 for `numeric` fields — convert obvious letter-OCR mistakes into
 * the digit they were almost certainly meant to be.
 */
export const runStage1Numeric = (value: string): Stage1Result =>
  applyMap(value, NUMERIC_SUBSTITUTIONS);

/**
 * Stage 1 for `text` fields — convert obvious digit-OCR mistakes into
 * the letter they were almost certainly meant to be.
 */
export const runStage1Text = (value: string): Stage1Result =>
  applyMap(value, TEXT_SUBSTITUTIONS);

export const runStage1 = (value: string, fieldType: WizardFieldType): Stage1Result => {
  switch (fieldType) {
    case 'any':
      return runStage1Any(value);
    case 'numeric':
      return runStage1Numeric(value);
    case 'text':
      return runStage1Text(value);
  }
};
