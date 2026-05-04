import { describe, expect, it } from 'vitest';

import { isMasterDbTable } from '../../src/core/contracts/masterdb-table';
import {
  MasterDbCsvParseError,
  createMasterDbEngine,
  parseCsv,
  parseMasterDbCsv,
  serializeMasterDbCsv,
  seedMasterDbTable
} from '../../src/core/engines/masterdb';
import type { OcrBoxResult } from '../../src/core/contracts/ocrbox-result';
import type { WizardFile } from '../../src/core/contracts/wizard';

const wizard: WizardFile = {
  schema: 'wrokit/wizard-file',
  version: '1.0',
  wizardName: 'Invoice Wizard',
  fields: [
    { fieldId: 'invoice_number', label: 'Invoice Number', type: 'text', required: true },
    { fieldId: 'invoice_date', label: 'Invoice Date', type: 'text', required: false },
    { fieldId: 'total', label: 'Total', type: 'numeric', required: true }
  ]
};

const ocrResult = (
  documentId: string,
  values: Partial<Record<string, string>>
): OcrBoxResult => ({
  schema: 'wrokit/ocrbox-result',
  version: '1.0',
  id: `ocrbox_${documentId}`,
  wizardId: wizard.wizardName,
  documentFingerprint: documentId,
  bboxSource: 'predicted-geometry-file',
  sourceArtifactId: documentId,
  engineName: 'test',
  engineVersion: '0.1',
  generatedAtIso: '2026-04-29T00:00:00Z',
  fields: Object.entries(values).map(([fieldId, text]) => ({
    fieldId,
    pageIndex: 0,
    text: text ?? '',
    confidence: 0.9,
    status: 'ok',
    bboxUsed: { xNorm: 0.1, yNorm: 0.1, wNorm: 0.1, hNorm: 0.1 },
    bboxPaddingNorm: 0.004
  }))
});

describe('createMasterDbEngine', () => {
  it('seeds a fresh table from the wizard when no existing table is provided', async () => {
    const engine = createMasterDbEngine();
    const out = await engine.run({
      wizard,
      existing: null,
      results: [ocrResult('INV-001', { invoice_number: '104882', total: '135.60' })]
    });
    expect(out.table.fieldOrder).toEqual(['invoice_number', 'invoice_date', 'total']);
    expect(out.table.rows).toHaveLength(1);
    expect(out.appendedRowIds).toEqual(['INV-001']);
    expect(out.replacedRowIds).toEqual([]);
    expect(out.table.rows[0].values.invoice_date).toBe('');
  });

  it('appends new documents and replaces existing rows by document_id', async () => {
    const engine = createMasterDbEngine();
    const first = await engine.run({
      wizard,
      existing: null,
      results: [ocrResult('INV-001', { invoice_number: 'first', total: '10' })]
    });
    const second = await engine.run({
      wizard,
      existing: first.table,
      results: [
        ocrResult('INV-001', { invoice_number: 'first-replaced', total: '11' }),
        ocrResult('INV-002', { invoice_number: 'second', total: '20' })
      ]
    });
    expect(second.appendedRowIds).toEqual(['INV-002']);
    expect(second.replacedRowIds).toEqual(['INV-001']);
    expect(second.table.rows).toHaveLength(2);
    const inv1 = second.table.rows.find((row) => row.documentId === 'INV-001');
    expect(inv1?.values.invoice_number).toBe('first-replaced');
  });

  it('preserves existing field column order and appends new wizard fields without reordering', async () => {
    const oldTable = seedMasterDbTable({
      ...wizard,
      fields: [{ fieldId: 'invoice_number', label: 'I', type: 'text', required: true }]
    });
    oldTable.rows.push({
      documentId: 'OLD-1',
      sourceName: 'old.pdf',
      extractedAtIso: '2025-01-01T00:00:00Z',
      values: { invoice_number: 'legacy' }
    });
    const engine = createMasterDbEngine();
    const out = await engine.run({
      wizard,
      existing: oldTable,
      results: [ocrResult('NEW-1', { invoice_number: 'new', total: '7' })]
    });
    expect(out.table.fieldOrder[0]).toBe('invoice_number');
    expect(out.table.fieldOrder).toContain('invoice_date');
    expect(out.table.fieldOrder).toContain('total');
    const legacy = out.table.rows.find((row) => row.documentId === 'OLD-1');
    expect(legacy?.values.invoice_date).toBe('');
    expect(legacy?.values.total).toBe('');
  });
});

describe('CSV codec round trip', () => {
  it('serializes and re-parses without losing rows', async () => {
    const engine = createMasterDbEngine();
    const out = await engine.run({
      wizard,
      existing: null,
      results: [
        ocrResult('INV-001', { invoice_number: '104882', total: '135.60' }),
        ocrResult('INV-002', {
          invoice_number: 'A,B "needs quoting"',
          invoice_date: 'line1\nline2',
          total: '99'
        })
      ]
    });
    const csv = serializeMasterDbCsv(out.table);
    const reparsed = parseMasterDbCsv(csv, wizard.wizardName);
    expect(isMasterDbTable(reparsed)).toBe(true);
    expect(reparsed.rows).toHaveLength(2);
    expect(reparsed.rows[1].values.invoice_number).toBe('A,B "needs quoting"');
    expect(reparsed.rows[1].values.invoice_date).toBe('line1\nline2');
  });

  it('rejects CSV missing the fixed leading columns', () => {
    expect(() => parseMasterDbCsv('not_id,source\nx,y\n', 'w')).toThrow(MasterDbCsvParseError);
  });

  it('parseCsv handles quoted commas, embedded newlines, and escaped quotes', () => {
    const text = 'a,b,c\n1,"two, two","three\n3"\n4,5,"6 ""quoted"""\n';
    const rows = parseCsv(text);
    expect(rows[0]).toEqual(['a', 'b', 'c']);
    expect(rows[1]).toEqual(['1', 'two, two', 'three\n3']);
    expect(rows[2]).toEqual(['4', '5', '6 "quoted"']);
  });
});
