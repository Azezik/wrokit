/**
 * OCRMagic engine — field-aware, column-aware MasterDB cleanup.
 *
 * Pipeline (per field column):
 *   1. Preserve raw value verbatim.
 *   2. Run safe edge cleanup (whitespace, NBSP, leading/trailing junk).
 *   3. Apply field-type-based character substitutions.
 *   4. Build a column-level PatternProfile from the cleaned baseline.
 *   5. Generate local one-character substitution candidates per cell.
 *   6. Score each candidate against the field type and learned profile.
 *   7. Apply the highest-scoring candidate when its score beats the
 *      cleaned baseline by a meaningful margin.
 *   8. Emit the clean value with audit metadata.
 *
 * The engine is pure: it never reads NormalizedPage pixels, never calls OCR,
 * and never mutates its inputs. The raw `MasterDbTable` is preserved verbatim;
 * the cleaned table is a parallel artifact.
 */

import type { Engine } from '../engine';
import type { MasterDbRow, MasterDbTable } from '../../contracts/masterdb-table';
import type {
  OcrMagicCellAudit,
  OcrMagicChangeType,
  OcrMagicFieldProfile,
  OcrMagicResult
} from '../../contracts/ocrmagic-result';
import type { WizardField, WizardFile } from '../../contracts/wizard';

import { runSafeCleanup } from './cleanup';
import { buildFieldProfile, scoreAgainstProfile } from './pattern-profile';
import { applyTypeSubstitutions, generateLocalCandidates } from './substitutions';
import type { OcrMagicCleanInput, OcrMagicCleanOutput } from './types';

const PATTERN_CORRECTION_MARGIN = 0.08;

interface StageOneOutput {
  rawValue: string;
  cleanedValue: string;
  reasonCodes: string[];
  changeTypes: Set<OcrMagicChangeType>;
  confidenceBefore: number;
  confidenceAfter: number;
}

const fieldTypeOf = (wizard: WizardFile, fieldId: string): WizardField['type'] => {
  const field = wizard.fields.find((entry) => entry.fieldId === fieldId);
  return field?.type ?? 'any';
};

const initialConfidence = (raw: string): number => {
  if (raw.length === 0) {
    return 0;
  }
  // Confidence-before is a rough heuristic: shorter, junk-laden values
  // start lower so they have room to improve through cleanup.
  const stripped = raw.replace(/[\s'"`|©®®@*•·,;:_~^\\/-]/g, '');
  if (stripped.length === 0) {
    return 0.05;
  }
  return Math.min(0.6, stripped.length / Math.max(8, raw.length));
};

const runStageOneToThree = (
  rawValue: string,
  fieldType: WizardField['type']
): StageOneOutput => {
  const reasonCodes: string[] = [];
  const changeTypes = new Set<OcrMagicChangeType>();
  const confidenceBefore = initialConfidence(rawValue);

  const cleaned = runSafeCleanup(rawValue);
  if (cleaned.changed) {
    reasonCodes.push(...cleaned.reasonCodes);
    if (cleaned.reasonCodes.includes('collapsed-multi-space') ||
        cleaned.reasonCodes.includes('replaced-nbsp') ||
        cleaned.reasonCodes.includes('trimmed-whitespace')) {
      changeTypes.add('whitespace-normalized');
    }
    if (cleaned.reasonCodes.includes('stripped-leading-edge-junk') ||
        cleaned.reasonCodes.includes('stripped-trailing-edge-junk') ||
        cleaned.reasonCodes.includes('stripped-zero-width')) {
      changeTypes.add('edge-cleaned');
    }
  }

  const substituted = applyTypeSubstitutions(cleaned.value, fieldType);
  let workingValue = substituted.value;
  if (substituted.changed) {
    reasonCodes.push(`type-substitution:${fieldType}`);
    changeTypes.add('type-substituted');
  }

  // Confidence-after starts at confidence-before plus a bump if we did
  // anything constructive. Pattern correction (stage 6) can raise it further.
  let confidenceAfter = confidenceBefore;
  if (changeTypes.size > 0) {
    confidenceAfter = Math.min(0.85, confidenceBefore + 0.2);
  } else if (workingValue.length > 0) {
    confidenceAfter = Math.max(confidenceBefore, 0.5);
  }

  return {
    rawValue,
    cleanedValue: workingValue,
    reasonCodes,
    changeTypes,
    confidenceBefore,
    confidenceAfter
  };
};

const runPatternCorrection = (
  baseline: StageOneOutput,
  profile: OcrMagicFieldProfile,
  fieldType: WizardField['type']
): StageOneOutput => {
  if (baseline.cleanedValue.length === 0 || fieldType === 'any') {
    return baseline;
  }
  if (profile.nonEmptySampleCount < 3) {
    // Not enough samples to correct against — leave alone.
    return baseline;
  }

  const candidates = generateLocalCandidates(baseline.cleanedValue, fieldType);
  if (candidates.length === 0) {
    return baseline;
  }

  const baselineScore = scoreAgainstProfile(baseline.cleanedValue, profile);
  let bestValue = baseline.cleanedValue;
  let bestScore = baselineScore;
  for (const candidate of candidates) {
    const score = scoreAgainstProfile(candidate, profile);
    if (score > bestScore) {
      bestScore = score;
      bestValue = candidate;
    }
  }

  if (bestValue === baseline.cleanedValue) {
    return baseline;
  }
  if (bestScore - baselineScore < PATTERN_CORRECTION_MARGIN) {
    return baseline;
  }

  const reasonCodes = [...baseline.reasonCodes, 'pattern-corrected'];
  const changeTypes = new Set(baseline.changeTypes);
  changeTypes.add('pattern-corrected');

  return {
    ...baseline,
    cleanedValue: bestValue,
    reasonCodes,
    changeTypes,
    confidenceAfter: Math.min(0.95, Math.max(baseline.confidenceAfter, bestScore))
  };
};

const summarizeChangeType = (changeTypes: Set<OcrMagicChangeType>): OcrMagicChangeType => {
  // Reported changeType is the most-meaningful step we took for the cell.
  if (changeTypes.has('pattern-corrected')) {
    return 'pattern-corrected';
  }
  if (changeTypes.has('type-substituted')) {
    return 'type-substituted';
  }
  if (changeTypes.has('edge-cleaned')) {
    return 'edge-cleaned';
  }
  if (changeTypes.has('whitespace-normalized')) {
    return 'whitespace-normalized';
  }
  return 'unchanged';
};

const cloneTableSkeleton = (table: MasterDbTable): MasterDbTable => ({
  schema: 'wrokit/masterdb-table',
  version: '1.0',
  wizardId: table.wizardId,
  fieldOrder: [...table.fieldOrder],
  rows: table.rows.map((row) => ({
    documentId: row.documentId,
    sourceName: row.sourceName,
    extractedAtIso: row.extractedAtIso,
    values: { ...row.values }
  }))
});

export const createOcrMagicEngine = (): Engine<OcrMagicCleanInput, OcrMagicCleanOutput> => ({
  name: 'ocrmagic-engine',
  version: '1.0',
  run: async (input: OcrMagicCleanInput): Promise<OcrMagicCleanOutput> => {
    const { wizard, masterDb } = input;
    const cleanedTable = cloneTableSkeleton(masterDb);

    // Stages 1-3 per cell. Build cleaned column samples that will feed the
    // PatternProfile in stage 4.
    const baselineByDocByField = new Map<string, Map<string, StageOneOutput>>();
    const cleanedSamplesByField = new Map<string, string[]>();
    for (const fieldId of cleanedTable.fieldOrder) {
      cleanedSamplesByField.set(fieldId, []);
    }

    for (const row of masterDb.rows) {
      const perField = new Map<string, StageOneOutput>();
      baselineByDocByField.set(row.documentId, perField);
      for (const fieldId of cleanedTable.fieldOrder) {
        const fieldType = fieldTypeOf(wizard, fieldId);
        const rawValue = row.values[fieldId] ?? '';
        const baseline = runStageOneToThree(rawValue, fieldType);
        perField.set(fieldId, baseline);
        cleanedSamplesByField.get(fieldId)?.push(baseline.cleanedValue);
      }
    }

    // Stage 4: build PatternProfiles per field column.
    const profiles: Record<string, OcrMagicFieldProfile> = {};
    for (const fieldId of cleanedTable.fieldOrder) {
      const fieldType = fieldTypeOf(wizard, fieldId);
      const samples = cleanedSamplesByField.get(fieldId) ?? [];
      profiles[fieldId] = buildFieldProfile(fieldId, fieldType, samples);
    }

    // Stages 5-7: pattern correction per cell, gated by score margin.
    const audits: OcrMagicCellAudit[] = [];
    const changeCounts: Record<OcrMagicChangeType, number> = {
      unchanged: 0,
      'edge-cleaned': 0,
      'whitespace-normalized': 0,
      'type-substituted': 0,
      'pattern-corrected': 0,
      flagged: 0
    };

    for (const row of cleanedTable.rows) {
      const perField = baselineByDocByField.get(row.documentId);
      if (!perField) {
        continue;
      }
      for (const fieldId of cleanedTable.fieldOrder) {
        const baseline = perField.get(fieldId);
        if (!baseline) {
          continue;
        }
        const fieldType = fieldTypeOf(wizard, fieldId);
        const corrected = runPatternCorrection(baseline, profiles[fieldId], fieldType);
        row.values[fieldId] = corrected.cleanedValue;

        const changeType = summarizeChangeType(corrected.changeTypes);
        changeCounts[changeType] += 1;

        audits.push({
          documentId: row.documentId,
          fieldId,
          rawValue: corrected.rawValue,
          cleanValue: corrected.cleanedValue,
          changeType,
          confidenceBefore: corrected.confidenceBefore,
          confidenceAfter: corrected.confidenceAfter,
          reasonCodes: corrected.reasonCodes
        });
      }
    }

    const result: OcrMagicResult = {
      schema: 'wrokit/ocrmagic-result',
      version: '1.0',
      wizardId: masterDb.wizardId,
      generatedAtIso: new Date().toISOString(),
      cleanedTable,
      profiles,
      audits,
      changeCounts
    };

    return { result };
  }
});

export type { OcrMagicCleanInput, OcrMagicCleanOutput, MasterDbRow };
