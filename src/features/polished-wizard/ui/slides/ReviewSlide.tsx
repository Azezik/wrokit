import { useEffect, useMemo, useState } from 'react';

import type { MasterDbRow, MasterDbTable } from '../../../../core/contracts/masterdb-table';
import type { OcrMagicResult } from '../../../../core/contracts/ocrmagic-result';
import {
  downloadCleanedMasterDbCsv,
  downloadMasterDbCsv
} from '../../../../core/io/masterdb-csv-io';
import { createOcrMagicRunner } from '../../../../core/runtime/ocrmagic-runner';
import { Button } from '../../../../core/ui/components/Button';
import type { OrchestratorApi } from '../../orchestrator/useOrchestrator';

interface ReviewSlideProps {
  orchestrator: OrchestratorApi;
}

const cloneTable = (table: MasterDbTable): MasterDbTable => ({
  ...table,
  rows: table.rows.map((row) => ({ ...row, values: { ...row.values } }))
});

export function ReviewSlide({ orchestrator }: ReviewSlideProps) {
  const incoming = orchestrator.state.masterDb;
  const wizard = orchestrator.state.wizard;
  const [table, setTable] = useState<MasterDbTable | null>(incoming);
  const [cleaned, setCleaned] = useState<OcrMagicResult | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanError, setCleanError] = useState<string | null>(null);

  const ocrMagicRunner = useMemo(() => createOcrMagicRunner(), []);

  useEffect(() => {
    setTable(incoming ? cloneTable(incoming) : null);
    setCleaned(null);
    setCleanError(null);
  }, [incoming]);

  const fieldLabels = new Map<string, string>();
  if (wizard) {
    for (const field of wizard.fields) {
      fieldLabels.set(field.fieldId, field.label || field.fieldId);
    }
  }

  const columnCount = table?.fieldOrder.length ?? 0;
  const density = columnCount >= 10 ? 'dense' : columnCount >= 6 ? 'compact' : 'default';

  const updateCell = (rowIndex: number, fieldId: string, value: string) => {
    if (!table) {
      return;
    }
    const next = cloneTable(table);
    const row = next.rows[rowIndex];
    if (row) {
      row.values[fieldId] = value;
    }
    setTable(next);
    orchestrator.setMasterDb(next);
    // User edits invalidate the previously-cleaned snapshot — they have to
    // re-run OCRMagic to capture their hand-corrections in the cleaned copy.
    setCleaned(null);
  };

  const handleDownloadRaw = () => {
    if (table) {
      downloadMasterDbCsv(table);
    }
  };

  const handleDownloadCleaned = () => {
    if (cleaned) {
      downloadCleanedMasterDbCsv(cleaned.cleanedTable);
    }
  };

  const handleCleanData = async () => {
    if (!wizard || !table || cleaning) {
      return;
    }
    setCleaning(true);
    setCleanError(null);
    try {
      const out = await ocrMagicRunner.clean({ wizard, masterDb: table });
      setCleaned(out.result);
    } catch (error) {
      setCleanError(error instanceof Error ? error.message : 'OCRMagic cleanup failed.');
    } finally {
      setCleaning(false);
    }
  };

  const handleStartOver = () => {
    orchestrator.reset();
  };

  const handleProcessMore = () => {
    orchestrator.goTo('upload');
  };

  const cleanSummary = useMemo(() => {
    if (!cleaned) {
      return null;
    }
    const counts = cleaned.changeCounts;
    const touched =
      counts['edge-cleaned'] +
      counts['whitespace-normalized'] +
      counts['type-substituted'] +
      counts['pattern-corrected'];
    return { touched, total: cleaned.audits.length };
  }, [cleaned]);

  const declaredTypes = cleaned
    ? cleaned.cleanedTable.fieldOrder.map((fieldId) => ({
        fieldId,
        label: fieldLabels.get(fieldId) ?? fieldId,
        declaredType: cleaned.profiles[fieldId]?.declaredType ?? 'any'
      }))
    : [];

  const canClean = Boolean(wizard && table && table.rows.length > 0);

  return (
    <>
      <div className="polished-wizard__slide">
        <h2 className="polished-wizard__title">Your MasterDB is ready</h2>
        <p className="polished-wizard__subtitle">
          Review the extracted values, fix anything that looks off, then download the CSV.
        </p>

        {orchestrator.state.error ? (
          <p className="polished-wizard__error">{orchestrator.state.error}</p>
        ) : null}
        {cleanError ? <p className="polished-wizard__error">{cleanError}</p> : null}

        {table && table.rows.length > 0 ? (
          <div className="polished-wizard__review-table-wrap">
            <table
              className="polished-wizard__review-table"
              data-density={density}
              aria-label="MasterDB rows"
            >
              <thead>
                <tr>
                  {table.fieldOrder.map((fieldId) => (
                    <th key={fieldId}>{fieldLabels.get(fieldId) ?? fieldId}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row: MasterDbRow, rowIndex: number) => (
                  <tr key={row.documentId} title={row.sourceName}>
                    {table.fieldOrder.map((fieldId) => (
                      <td key={fieldId}>
                        <input
                          type="text"
                          value={row.values[fieldId] ?? ''}
                          onChange={(event) =>
                            updateCell(rowIndex, fieldId, event.target.value)
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="polished-wizard__hint">No rows extracted yet.</p>
        )}

        {cleanSummary ? (
          <p className="polished-wizard__hint">
            OCRMagic touched {cleanSummary.touched} of {cleanSummary.total} cell(s) using
            field-type and column-pattern rules. The raw MasterDB is unchanged.
          </p>
        ) : null}

        {declaredTypes.length > 0 ? (
          <p className="polished-wizard__hint">
            Field types read from your WizardFile:{' '}
            {declaredTypes
              .map((entry) => `${entry.label} = ${entry.declaredType}`)
              .join(' · ')}
          </p>
        ) : null}
      </div>

      <footer className="polished-wizard__footer">
        <Button type="button" onClick={handleStartOver}>
          Start over
        </Button>
        <div className="polished-wizard__footer-actions">
          <Button type="button" onClick={handleProcessMore}>
            Process more files
          </Button>
          {cleaned ? (
            <Button type="button" variant="primary" onClick={handleDownloadCleaned}>
              Download cleaned CSV
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              onClick={handleCleanData}
              disabled={!canClean || cleaning}
            >
              {cleaning ? (
                <span className="polished-wizard__inline-spinner" aria-hidden="true" />
              ) : null}
              {cleaning ? 'Cleaning…' : 'Clean Data'}
            </Button>
          )}
          <Button
            type="button"
            onClick={handleDownloadRaw}
            disabled={!table || table.rows.length === 0}
          >
            Download raw CSV
          </Button>
        </div>
      </footer>
    </>
  );
}
