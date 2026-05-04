import { useEffect, useState } from 'react';

import type { MasterDbRow, MasterDbTable } from '../../../../core/contracts/masterdb-table';
import { downloadMasterDbCsv } from '../../../../core/io/masterdb-csv-io';
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

  useEffect(() => {
    setTable(incoming ? cloneTable(incoming) : null);
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
  };

  const handleDownload = () => {
    if (table) {
      downloadMasterDbCsv(table);
    }
  };

  const handleStartOver = () => {
    orchestrator.reset();
  };

  const handleProcessMore = () => {
    orchestrator.goTo('upload');
  };

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
      </div>

      <footer className="polished-wizard__footer">
        <Button type="button" onClick={handleStartOver}>
          Start over
        </Button>
        <div className="polished-wizard__footer-actions">
          <Button type="button" onClick={handleProcessMore}>
            Process more files
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleDownload}
            disabled={!table || table.rows.length === 0}
          >
            Download CSV
          </Button>
        </div>
      </footer>
    </>
  );
}
