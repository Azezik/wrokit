import { useCallback, useMemo, useState, type ChangeEvent } from 'react';

import type { MasterDbTable } from '../../../core/contracts/masterdb-table';
import type { OcrBoxResult } from '../../../core/contracts/ocrbox-result';
import type { WizardFile } from '../../../core/contracts/wizard';
import { MasterDbCsvParseError, parseMasterDbCsv } from '../../../core/engines/masterdb';
import { downloadMasterDbCsv } from '../../../core/io/masterdb-csv-io';
import { createMasterDbRunner } from '../../../core/runtime/masterdb-runner';
import { Button } from '../../../core/ui/components/Button';
import { Panel } from '../../../core/ui/components/Panel';

import './masterdb-panel.css';

export interface MasterDbPanelProps {
  wizard: WizardFile | null;
  /** Latest OCRBOX result for the currently-selected document. */
  pendingResult: OcrBoxResult | null;
  panelTitle?: string;
}

export function MasterDbPanel({
  wizard,
  pendingResult,
  panelTitle = 'MasterDB (CSV ledger)'
}: MasterDbPanelProps) {
  const [table, setTable] = useState<MasterDbTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastApplied, setLastApplied] = useState<{
    appended: string[];
    replaced: string[];
  } | null>(null);

  const runnerRef = useMemo(() => createMasterDbRunner(), []);

  const appendDisabled = !wizard || !pendingResult || busy;

  const handleAppend = useCallback(async () => {
    if (!wizard || !pendingResult) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await runnerRef.apply({
        wizard,
        existing: table,
        results: [pendingResult]
      });
      setTable(next.table);
      setLastApplied({ appended: next.appendedRowIds, replaced: next.replacedRowIds });
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'MasterDB apply failed.');
    } finally {
      setBusy(false);
    }
  }, [wizard, pendingResult, table, runnerRef]);

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    if (!wizard) {
      setError('Load a WizardFile before importing a MasterDB CSV.');
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseMasterDbCsv(text, wizard.wizardName);
      setTable(parsed);
      setLastApplied(null);
      setError(null);
    } catch (importError) {
      setError(
        importError instanceof MasterDbCsvParseError
          ? importError.message
          : 'Could not import MasterDB CSV.'
      );
    }
  };

  const handleDownload = () => {
    if (table) {
      downloadMasterDbCsv(table);
    }
  };

  const handleClear = () => {
    setTable(null);
    setLastApplied(null);
    setError(null);
  };

  const headerColumns = table
    ? ['document_id', 'source_name', 'extracted_at_iso', ...table.fieldOrder]
    : [];

  return (
    <Panel className="masterdb-panel">
      <div className="masterdb-panel__header">
        <strong>{panelTitle}</strong>
        <span className="masterdb-panel__meta">
          {table
            ? `${table.rows.length} row(s) · ${table.fieldOrder.length} field column(s)`
            : 'No MasterDB loaded.'}
        </span>
      </div>
      <p className="masterdb-panel__intro">
        MasterDB compiles each document’s OCRBOX result into one row of a fixed-schema CSV.
        Headers are locked from the WizardFile. You can upload a previously-downloaded
        MasterDB CSV (originating from the same WizardFile) and append new rows from
        subsequent extractions; existing rows are matched by <code>document_id</code> and
        replaced in place.
      </p>
      <div className="masterdb-panel__toolbar">
        <Button type="button" variant="primary" onClick={handleAppend} disabled={appendDisabled}>
          Append latest OCRBOX result
        </Button>
        <Button type="button" onClick={handleDownload} disabled={!table || table.rows.length === 0}>
          Download MasterDB CSV
        </Button>
        <label className="masterdb-panel__import">
          <span>Upload existing MasterDB CSV</span>
          <input type="file" accept=".csv,text/csv" onChange={handleImport} />
        </label>
        <Button type="button" onClick={handleClear} disabled={!table}>
          Clear in-memory MasterDB
        </Button>
      </div>
      {error ? <p className="masterdb-panel__error">{error}</p> : null}
      {lastApplied ? (
        <p className="masterdb-panel__meta">
          Last apply — appended: {lastApplied.appended.length || 'none'} · replaced:{' '}
          {lastApplied.replaced.length || 'none'}
        </p>
      ) : null}
      {table && table.rows.length > 0 ? (
        <div className="masterdb-panel__table-wrap">
          <table className="masterdb-panel__table" aria-label="MasterDB rows">
            <thead>
              <tr>
                {headerColumns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.documentId}>
                  <td>{row.documentId}</td>
                  <td>{row.sourceName}</td>
                  <td>{row.extractedAtIso}</td>
                  {table.fieldOrder.map((fieldId) => (
                    <td key={fieldId}>{row.values[fieldId] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
