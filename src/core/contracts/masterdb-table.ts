/**
 * MasterDB table — append-only ledger of one record per processed document.
 *
 * Authority rules:
 * - The header order is locked at creation time from the WizardFile
 *   (`wizardName`) and never reorders. Missing values become empty strings.
 * - Every row carries a `documentId` which acts as the idempotency key.
 *   Re-extracting the same source replaces the previous row in place; new
 *   sources append. The header set is never widened by a single document.
 * - The MasterDB engine never reads NormalizedPage pixels or runs OCR. It
 *   only consumes already-finalized OcrBoxResults (or compatible records).
 */

export const MASTERDB_FIXED_LEADING_COLUMNS = [
  'document_id',
  'source_name',
  'extracted_at_iso'
] as const;

export type MasterDbFixedColumn = (typeof MASTERDB_FIXED_LEADING_COLUMNS)[number];

export interface MasterDbRow {
  documentId: string;
  sourceName: string;
  extractedAtIso: string;
  values: Record<string, string>;
}

export interface MasterDbTable {
  schema: 'wrokit/masterdb-table';
  version: '1.0';
  wizardId: string;
  /**
   * Locked, ordered list of WizardField fieldIds. Combined with the fixed
   * leading columns this is the canonical CSV header order.
   */
  fieldOrder: string[];
  rows: MasterDbRow[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isStringMap = (value: unknown): value is Record<string, string> => {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
};

const isMasterDbRow = (value: unknown): value is MasterDbRow => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.documentId === 'string' &&
    typeof value.sourceName === 'string' &&
    typeof value.extractedAtIso === 'string' &&
    isStringMap(value.values)
  );
};

export const isMasterDbTable = (value: unknown): value is MasterDbTable => {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.schema !== 'wrokit/masterdb-table' ||
    value.version !== '1.0' ||
    typeof value.wizardId !== 'string' ||
    !isStringArray(value.fieldOrder) ||
    !Array.isArray(value.rows)
  ) {
    return false;
  }
  return value.rows.every(isMasterDbRow);
};
