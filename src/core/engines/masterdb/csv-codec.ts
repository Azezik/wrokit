import {
  MASTERDB_FIXED_LEADING_COLUMNS,
  type MasterDbRow,
  type MasterDbTable
} from '../../contracts/masterdb-table';

const NEEDS_QUOTE = /[",\r\n]/;

const escapeCell = (value: string): string => {
  if (NEEDS_QUOTE.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};

export const masterDbHeaderColumns = (table: MasterDbTable): string[] => [
  ...MASTERDB_FIXED_LEADING_COLUMNS,
  ...table.fieldOrder
];

const rowAsArray = (table: MasterDbTable, row: MasterDbRow): string[] => {
  const values = [row.documentId, row.sourceName, row.extractedAtIso];
  for (const fieldId of table.fieldOrder) {
    values.push(row.values[fieldId] ?? '');
  }
  return values;
};

export const serializeMasterDbCsv = (table: MasterDbTable): string => {
  const header = masterDbHeaderColumns(table).map(escapeCell).join(',');
  const lines = table.rows.map((row) =>
    rowAsArray(table, row).map(escapeCell).join(',')
  );
  return [header, ...lines].join('\n') + '\n';
};

/**
 * Minimal RFC-4180 style CSV parser. Supports quoted cells, embedded
 * commas, embedded newlines, and `""` quote-escapes. Trims trailing CR
 * from CRLF input.
 */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  const pushCell = () => {
    row.push(cell);
    cell = '';
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushCell();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushCell();
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // swallow CR; the LF (if any) flushes the row
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  // flush trailing partial line
  if (cell.length > 0 || row.length > 0) {
    pushCell();
    pushRow();
  }
  return rows;
};

export class MasterDbCsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterDbCsvParseError';
  }
}

/**
 * Parse a previously-downloaded MasterDB CSV. The file MUST start with the
 * fixed leading columns (`document_id, source_name, extracted_at_iso`)
 * followed by the wizard's field columns. The wizardId is provided by the
 * caller because the CSV itself does not embed it.
 */
export const parseMasterDbCsv = (text: string, wizardId: string): MasterDbTable => {
  const rows = parseCsv(text).filter((entry) => entry.length > 0 && entry.some((cell) => cell !== ''));
  if (rows.length === 0) {
    throw new MasterDbCsvParseError('CSV is empty.');
  }
  const header = rows[0];
  const expectedLeading = MASTERDB_FIXED_LEADING_COLUMNS;
  for (let idx = 0; idx < expectedLeading.length; idx += 1) {
    if (header[idx] !== expectedLeading[idx]) {
      throw new MasterDbCsvParseError(
        `CSV header column ${idx} must be "${expectedLeading[idx]}" (got "${header[idx] ?? ''}").`
      );
    }
  }
  const fieldOrder = header.slice(expectedLeading.length);
  const dataRows: MasterDbRow[] = rows.slice(1).map((cells) => {
    const documentId = cells[0] ?? '';
    const sourceName = cells[1] ?? '';
    const extractedAtIso = cells[2] ?? '';
    const values: Record<string, string> = {};
    for (let idx = 0; idx < fieldOrder.length; idx += 1) {
      values[fieldOrder[idx]] = cells[expectedLeading.length + idx] ?? '';
    }
    return { documentId, sourceName, extractedAtIso, values };
  });
  return {
    schema: 'wrokit/masterdb-table',
    version: '1.0',
    wizardId,
    fieldOrder,
    rows: dataRows
  };
};
