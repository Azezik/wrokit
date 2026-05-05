import { describe, expect, it } from 'vitest';

import { isOcrMagicResult } from '../../src/core/contracts/ocrmagic-result';
import {
  createOcrMagicEngine,
  runStage1,
  runStage1Any,
  runStage1Numeric,
  runStage1Text,
  runStage1b,
  runStage1bAny,
  runStage1bNumeric,
  runStage1bText
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

describe('Stage 1 — pure type substitution pass', () => {
  it('any field is left untouched (no substitutions, no cleanup)', () => {
    const out = runStage1Any('  R0BERT ');
    expect(out.value).toBe('  R0BERT ');
    expect(out.changed).toBe(false);
    expect(runStage1('R0BERT', 'any').changed).toBe(false);
  });

  it('numeric flips obvious letter-OCR mistakes into digits', () => {
    expect(runStage1Numeric('6l3286 6O91').value).toBe('613286 6091');
    expect(runStage1Numeric('IO0').value).toBe('100');
    expect(runStage1('S5BG', 'numeric').value).toBe('5586');
  });

  it('text flips obvious digit-OCR mistakes into letters', () => {
    expect(runStage1Text('R0BERT').value).toBe('ROBERT');
    expect(runStage1('B0B', 'text').value).toBe('BOB');
  });

  it('Stage 1 leaves stray edge symbols alone — those belong to Stage 1B', () => {
    // `|` is not in the numeric substitution map; it stays for Stage 1B.
    const out = runStage1Numeric('| 97048');
    expect(out.value).toBe('| 97048');
    expect(out.changed).toBe(false);
  });
});

describe('Stage 1B — small per-field-type cleanup pass', () => {
  it('strips leading apostrophes, leading symbol+space, and trailing junk', () => {
    expect(runStage1bAny("' Bob@gmail.com").value).toBe('Bob@gmail.com');
    expect(runStage1bAny('© 22-April').value).toBe('22-April');
    expect(runStage1bAny('| 97048').value).toBe('97048');
    expect(runStage1bAny('Bob@gmail.com (').value).toBe('Bob@gmail.com');
  });

  it('trims outer whitespace and collapses multi-space without rewriting the value', () => {
    expect(runStage1bAny('  Cindy  Gray  ').value).toBe('Cindy Gray');
    expect(runStage1bText('  Cindy  Gray  ').value).toBe('Cindy Gray');
    expect(runStage1bNumeric('  613 286  6091 ').value).toBe('613 286 6091');
  });

  it('replaces non-breaking and zero-width whitespace', () => {
    const raw = ' 613​‌ 286 6091';
    const out = runStage1bAny(raw);
    expect(out.value).toBe('613 286 6091');
    expect(out.reasonCodes).toContain('replaced-nbsp');
    expect(out.reasonCodes).toContain('stripped-zero-width');
  });

  it('applies to all field types including any', () => {
    expect(runStage1b("' x", 'any').value).toBe('x');
    expect(runStage1b("' 12", 'numeric').value).toBe('12');
    expect(runStage1b("' Bob", 'text').value).toBe('Bob');
  });

  it('does not aggressively rewrite the main value', () => {
    expect(runStage1bText('Bob@gmail.com').value).toBe('Bob@gmail.com');
    expect(runStage1bAny('Sylvain Boily').changed).toBe(false);
    expect(runStage1bAny('').changed).toBe(false);
  });
});

describe('createOcrMagicEngine', () => {
  it('runs Stage 1 then Stage 1B per cell, preserving the raw values', async () => {
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

    // Cleaned table strips obvious edge junk via Stage 1B.
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

  it('does not substitute or rewrite any-typed fields beyond edge cleanup', async () => {
    const masterDb = tableFromValues([
      { notes: 'O0OO0' },
      { notes: '0OO00' }
    ]);

    const engine = createOcrMagicEngine();
    const out = await engine.run({ wizard, masterDb });
    const cleanedRows = out.result.cleanedTable.rows;
    expect(cleanedRows[0].values.notes).toBe('O0OO0');
    expect(cleanedRows[1].values.notes).toBe('0OO00');
    const notesAudits = out.result.audits.filter((entry) => entry.fieldId === 'notes');
    expect(notesAudits.every((entry) => entry.changeType === 'unchanged')).toBe(true);
    expect(notesAudits.every((entry) => entry.fieldType === 'any')).toBe(true);
  });

  it('records change types and counts in audit metadata', async () => {
    const masterDb = tableFromValues([
      { date: '   ', account: '97042', name: '"Luc Theoret', phone: '"6136181921' },
      { date: '07 - April', account: '97034)', name: '" Mike Kennedy', phone: '"613791 9158' },
      { date: '04 April', account: '97033', name: '"Lisa Keeley', phone: '" 613201 0864' }
    ]);

    const engine = createOcrMagicEngine();
    const out = await engine.run({ wizard, masterDb });

    expect(out.result.changeCounts['stage-1b']).toBeGreaterThan(0);

    const lucNameAudit = out.result.audits.find(
      (entry) => entry.documentId === 'DOC-1' && entry.fieldId === 'name'
    );
    expect(lucNameAudit?.cleanValue).toBe('Luc Theoret');
    expect(lucNameAudit?.changeType).toBe('stage-1b');
    expect(lucNameAudit?.reasonCodes).toContain('stripped-leading-edge-junk');
    expect(lucNameAudit?.fieldType).toBe('text');
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

  it('reports stage-1-and-1b when both stages change a cell', async () => {
    // Numeric field with letter-OCR (Stage 1) AND leading edge junk (Stage 1B).
    const masterDb = tableFromValues([{ account: '" 97O44' }]);
    const engine = createOcrMagicEngine();
    const out = await engine.run({ wizard, masterDb });
    const audit = out.result.audits.find((entry) => entry.fieldId === 'account');
    expect(audit?.cleanValue).toBe('97044');
    expect(audit?.changeType).toBe('stage-1-and-1b');
    expect(out.result.changeCounts['stage-1-and-1b']).toBe(1);
  });
});
