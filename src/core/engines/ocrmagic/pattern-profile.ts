/**
 * Stage 4 of OCRMagic: lightweight, deterministic column pattern learning.
 *
 * Profiles are NOT machine-learned models. They are summary statistics
 * derived from the cleaned column samples and reused as a structural
 * reference when scoring correction candidates.
 */

import type {
  OcrMagicCharClass,
  OcrMagicFieldProfile,
  OcrMagicLengthStats
} from '../../contracts/ocrmagic-result';
import type { WizardFieldType } from '../../contracts/wizard';

const SEPARATOR_CHARS = ['-', '/', ' ', ',', '.', ':', ';', '|', '_'];

const classifyChar = (ch: string): OcrMagicCharClass => {
  if (ch === '') {
    return 'empty';
  }
  if (/\s/.test(ch)) {
    return 'space';
  }
  if (/[A-Za-z]/.test(ch)) {
    return 'letter';
  }
  if (/[0-9]/.test(ch)) {
    return 'digit';
  }
  return 'symbol';
};

const dominant = (counts: Map<OcrMagicCharClass, number>): OcrMagicCharClass => {
  let best: OcrMagicCharClass = 'empty';
  let bestN = -1;
  let total = 0;
  for (const [, n] of counts) {
    total += n;
  }
  for (const [cls, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = cls;
    }
  }
  // If no class crosses 60% it's mixed.
  if (total > 0 && bestN / total < 0.6) {
    return 'mixed';
  }
  return best;
};

const inferKind = (
  declaredType: WizardFieldType,
  charClassByPosition: OcrMagicCharClass[],
  nonEmptySampleCount: number
): OcrMagicFieldProfile['inferredKind'] => {
  if (nonEmptySampleCount === 0) {
    return 'empty';
  }
  if (declaredType === 'numeric') {
    return 'numeric';
  }
  if (declaredType === 'text') {
    return 'text';
  }
  let digit = 0;
  let letter = 0;
  for (const cls of charClassByPosition) {
    if (cls === 'digit') {
      digit += 1;
    } else if (cls === 'letter') {
      letter += 1;
    }
  }
  if (digit > 0 && letter === 0) {
    return 'numeric';
  }
  if (letter > 0 && digit === 0) {
    return 'text';
  }
  return 'mixed';
};

const computeLengthStats = (samples: string[]): OcrMagicLengthStats => {
  if (samples.length === 0) {
    return { min: 0, max: 0, mode: 0, mean: 0 };
  }
  const lengths = samples.map((value) => value.length);
  const min = Math.min(...lengths);
  const max = Math.max(...lengths);
  const sum = lengths.reduce((acc, n) => acc + n, 0);
  const mean = sum / lengths.length;

  const counts = new Map<number, number>();
  for (const length of lengths) {
    counts.set(length, (counts.get(length) ?? 0) + 1);
  }
  let mode = lengths[0];
  let modeCount = 0;
  for (const [length, count] of counts) {
    if (count > modeCount) {
      modeCount = count;
      mode = length;
    }
  }
  return { min, max, mode, mean };
};

const collectAffix = (
  samples: string[],
  pick: (value: string) => string
): string[] => {
  const counts = new Map<string, number>();
  for (const value of samples) {
    const key = pick(value);
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(samples.length * 0.4));
  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key]) => key);
};

const collectSeparators = (samples: string[]): string[] => {
  const seen = new Map<string, number>();
  const threshold = Math.max(2, Math.ceil(samples.length * 0.4));
  for (const value of samples) {
    const present = new Set<string>();
    for (const ch of value) {
      if (SEPARATOR_CHARS.includes(ch)) {
        present.add(ch);
      }
    }
    for (const ch of present) {
      seen.set(ch, (seen.get(ch) ?? 0) + 1);
    }
  }
  return [...seen.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([ch]) => ch);
};

const collectRepeatedValues = (samples: string[]): string[] => {
  const counts = new Map<string, number>();
  for (const value of samples) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([value]) => value);
};

export const buildFieldProfile = (
  fieldId: string,
  declaredType: WizardFieldType,
  samples: string[]
): OcrMagicFieldProfile => {
  const nonEmpty = samples.filter((value) => value.length > 0);
  const lengthStats = computeLengthStats(nonEmpty);

  // Build position-aware char-class majority over the modal length window so
  // that one outlier value does not dilute the profile.
  const window = lengthStats.mode > 0 ? lengthStats.mode : Math.max(1, Math.round(lengthStats.mean));
  const charClassByPosition: OcrMagicCharClass[] = [];
  for (let pos = 0; pos < window; pos += 1) {
    const counts = new Map<OcrMagicCharClass, number>();
    for (const value of nonEmpty) {
      const cls = classifyChar(value[pos] ?? '');
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
    }
    charClassByPosition.push(dominant(counts));
  }

  const commonPrefixes = collectAffix(nonEmpty, (value) => value.slice(0, 1));
  const commonSuffixes = collectAffix(nonEmpty, (value) => value.slice(-1));

  return {
    fieldId,
    declaredType,
    inferredKind: inferKind(declaredType, charClassByPosition, nonEmpty.length),
    sampleCount: samples.length,
    nonEmptySampleCount: nonEmpty.length,
    length: lengthStats,
    charClassByPosition,
    commonPrefixes,
    commonSuffixes,
    separators: collectSeparators(nonEmpty),
    repeatedValues: collectRepeatedValues(nonEmpty)
  };
};

const charClassOf = (ch: string): OcrMagicCharClass => classifyChar(ch);

/**
 * Score a candidate value against a learned profile. Higher = better fit.
 * Returns a value in [0, 1] reflecting per-position char-class match plus a
 * length-distance penalty.
 */
export const scoreAgainstProfile = (
  candidate: string,
  profile: OcrMagicFieldProfile
): number => {
  if (profile.nonEmptySampleCount === 0) {
    return 0.5;
  }
  const expectedLen = profile.length.mode > 0 ? profile.length.mode : profile.length.mean;
  const lengthDelta = Math.abs(candidate.length - expectedLen);
  const lengthScore = Math.max(0, 1 - lengthDelta / Math.max(1, expectedLen));

  const window = Math.min(candidate.length, profile.charClassByPosition.length);
  let positionalHits = 0;
  for (let pos = 0; pos < window; pos += 1) {
    const expected = profile.charClassByPosition[pos];
    const actual = charClassOf(candidate[pos] ?? '');
    if (expected === 'mixed' || expected === 'empty') {
      positionalHits += 0.5;
    } else if (expected === actual) {
      positionalHits += 1;
    }
  }
  const positionalScore =
    profile.charClassByPosition.length === 0
      ? 0.5
      : positionalHits / profile.charClassByPosition.length;

  return 0.4 * lengthScore + 0.6 * positionalScore;
};
