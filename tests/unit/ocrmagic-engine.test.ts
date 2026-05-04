import { describe, expect, it } from 'vitest';

import { isOcrMagicResult } from '../../src/core/contracts/ocrmagic-result';
import {
  applyTypeSubstitutions,
  buildFieldProfile,
  createOcrMagicEngine,
  generateLocalCandidates,
  runSafeCleanup,
  scoreAgainstProfile
} from '../../src/core/engines/ocrmagic';
import type { MasterDbTable } from '../../src/core/contracts/masterdb-table';
import type { WizardFile } from '../../src/core/contracts/wizard';

const wizard: WizardFile = {
  schema: 'wrokit/wizard-file',
  version: '1.0',
  wizardName: 'Roster Wizard',
  fields: [
    { fieldId: 'date', label: 'Date', type: 'text', required: true },
    { fieldId: 'account', label: 'Account', type: 'numeric', required: true },
    { fieldId: 'name', label: 'Name', type: 'text', required: true },
    { fieldId: 'phone', label: 'Phone', type: 'numeric', required: false },
    { fieldId: 'notes', label: 'Notes', type: 'any', required: false }
  ]
};

const tableFromValues = (
  rows: Array<Record<string, string>>
): MasterDbTable => ({
  schema: 'wrokit/masterdb-table',
  version: '1.0',
  wizardId: wizard.wizardName,
  fieldOrder: ['date', 'account', 'name', 'phone', 'notes'],
  rows: rows.map((values, idx) => ({
    documentId: `DOC-${idx + 1}`,
    sourceName: `doc${idx + 1}.png`,
    extractedAtIso: '2026-04-29T00:00:00Z',
    values: { date: '', account: '', name: '', phone: '', notes: '', ...values }
  }))
});

describe('runSafeCleanup', () => {
  it('strips leading apostrophes, copyright glyph, and trailing pipes', () => {
    expect(runSafeCleanup('© 22-April').value).toBe('22-April');
    expect(runSafeCleanup("'May 9th").value).toBe('May 9th');
    expect(runSafeCleanup('| 97048').value).toBe('97048');
    expect(runSafeCleanup('  Cindy  Gray  ').value).toBe('Cindy Gray');
  });

  it('replaces non-breaking spaces and zero-width characters', () => {
    const raw = ' 613​‌ 286 6091';
    const out = runSafeCleanup(raw);
    expect(out.value).toBe('613 286 6091');
    expect(out.reasonCodes).toContain('replaced-nbsp');
    expect(out.reasonCodes).toContain('stripped-zero-width');
  });

  it('reports unchanged when value already clean', () => {
    expect(runSafeCleanup('').changed).toBe(false);
    expect(runSafeCleanup('Sylvain Boily').changed).toBe(false);
  });
});

describe('applyTypeSubstitutions', () => {
  it('text field flips ambiguous digits to letters', () => {
    expect(applyTypeSubstitutions('R0BERT', 'text').value).toBe('ROBERT');
  });

  it('numeric field flips ambiguous letters to digits', () => {
    expect(applyTypeSubstitutions('6l3286 6O91', 'numeric').value).toBe('613286 6091');
  });

  it('any field never substitutes', () => {
    expect(applyTypeSubstitutions('R0BERT', 'any').changed).toBe(false);
  });
});

describe('generateLocalCandidates', () => {
  it('produces one-character variations for ambiguous chars', () => {
    const out = generateLocalCandidates('1O4882', 'numeric');
    expect(out).toContain('104882');
  });

  it('returns no candidates for any-typed fields', () => {
    expect(generateLocalCandidates('R0BERT', 'any')).toEqual([]);
  });
});

describe('buildFieldProfile + scoreAgainstProfile', () => {
  it('learns six-digit account numbers from the column samples', () => {
    const profile = buildFieldProfile('account', 'numeric', [
      '97044',
      '97046',
      '97047',
      '97048',
      '97050'
    ]);
    expect(profile.inferredKind).toBe('numeric');
    expect(profile.length.mode).toBe(5);
    expect(profile.charClassByPosition.every((cls) => cls === 'digit')).toBe(true);
    expect(scoreAgainstProfile('97051', profile)).toBeGreaterThan(0.9);
    expect(scoreAgainstProfile('9bc51', profile)).toBeLessThan(
      scoreAgainstProfile('97051', profile)
    );
  });
});

describe('createOcrMagicEngine', () => {
  it('cleans whitespace and edge junk without losing the raw values', async () => {
    const masterDb = tableFromValues([
      { date: 'April 16th', account: '97044,', name: '"Ryan Chin Yuen Kee', phone: '5146280714' },
      { date: "'May 9th", account: '97046,', name: '" Darwin Lemay', phone: '613-432-0200' },
      { date: 'Apr-18', account: '97047', name: '"Ryan Byrne', phone: '"6138578518' },
      { date: 'Nov 28', account: '97048', name: "'Roshan Fernando & Therika Ekanayake |", phone: '613 986 7686' },
      { date: 'April 18', account: '| 97048', name: 'Cindy Gray', phone: '"6138397724' },
      { date: '© 22-April', account: '| 97055', name: 'Mark Tenbult', phone: '"613799 3493' }
    ]);

    const engine = createOcrMagicEngine();
    const out = await engine.run({ wizard, masterDb });

    expect(isOcrMagicResult(out.result)).toBe(true);
    // Raw is preserved verbatim.
    expect(masterDb.rows[0].values.account).toBe('97044,');
    expect(masterDb.rows[5].values.date).toBe('© 22-April');

    // Cleaned table strips obvious edge junk.
    const cleanedRows = out.result.cleanedTable.rows;
    expect(cleanedRows[0].values.account).toBe('97044');
    expect(cleanedRows[1].values.date).toBe('May 9th');
    expect(cleanedRows[2].values.name).toBe('Ryan Byrne');
    expect(cleanedRows[3].values.name).toBe('Roshan Fernando & Therika Ekanayake');
    expect(cleanedRows[4].values.account).toBe('97048');
    expect(cleanedRows[5].values.date).toBe('22-April');
    expect(cleanedRows[5].values.account).toBe('97055');

    // Phone column collapses internal whitespace.
    expect(cleanedRows[3].values.phone).toBe('613 986 7686');

    // Audits are rectangular: one entry per (row × field).
    expect(out.result.audits).toHaveLength(masterDb.rows.length * masterDb.fieldOrder.length);
  });

  it('does not aggressively substitute in any-typed fields', async () => {
    const masterDb = tableFromValues([
      { notes: 'O0OO0' },
      { notes: '0OO00' }
    ]);

    const engine = createOcrMagicEngine();
    const out = await engine.run({ wizard, masterDb });
    const cleanedRows = out.result.cleanedTable.rows;
    // 'any' fields are left as-is by substitutions; cleanup may still trim
    // edge whitespace, but the visible shape stays intact.
    expect(cleanedRows[0].values.notes).toBe('O0OO0');
    expect(cleanedRows[1].values.notes).toBe('0OO00');
    const notesAudits = out.result.audits.filter((entry) => entry.fieldId === 'notes');
    expect(notesAudits.every((entry) => entry.changeType !== 'type-substituted')).toBe(true);
  });

  it('records change types and counts in audit metadata', async () => {
    const masterDb = tableFromValues([
      { date: '   ', account: '97042', name: '"Luc Theoret', phone: '"6136181921' },
      { date: '07 - April', account: '97034)', name: '" Mike Kennedy', phone: '"613791 9158' },
      { date: '04 April', account: '97033', name: '"Lisa Keeley', phone: '" 613201 0864' }
    ]);

    const engine = createOcrMagicEngine();
    const out = await engine.run({ wizard, masterDb });

    expect(out.result.changeCounts['edge-cleaned'] + out.result.changeCounts['whitespace-normalized'])
      .toBeGreaterThan(0);

    const lucNameAudit = out.result.audits.find(
      (entry) => entry.documentId === 'DOC-1' && entry.fieldId === 'name'
    );
    expect(lucNameAudit?.cleanValue).toBe('Luc Theoret');
    expect(lucNameAudit?.changeType).toBe('edge-cleaned');
    expect(lucNameAudit?.reasonCodes).toContain('stripped-leading-edge-junk');
  });

  it('does not mutate the source MasterDbTable', async () => {
    const masterDb = tableFromValues([
      { account: '97044,', name: '"Ryan Chin Yuen Kee' }
    ]);
    const before = JSON.parse(JSON.stringify(masterDb));
    const engine = createOcrMagicEngine();
    await engine.run({ wizard, masterDb });
    expect(masterDb).toEqual(before);
  });
});
