import { useCallback, useState, type ChangeEvent } from 'react';

import type { GeometryFile } from '../../../core/contracts/geometry';
import type { NormalizedPage } from '../../../core/contracts/normalized-page';
import type { OcrBoxResult } from '../../../core/contracts/ocrbox-result';
import type { PredictedGeometryFile } from '../../../core/contracts/predicted-geometry-file';
import type { WizardFile } from '../../../core/contracts/wizard';
import { downloadOcrBoxResult, parseOcrBoxResult } from '../../../core/io/ocrbox-result-io';
import { createOcrBoxRunner } from '../../../core/runtime/ocrbox-runner';
import { Button } from '../../../core/ui/components/Button';
import { Panel } from '../../../core/ui/components/Panel';

import './ocrbox-preview.css';

export type OcrBoxPreviewSource =
  | { kind: 'geometry'; geometry: GeometryFile | null }
  | { kind: 'predicted'; predicted: PredictedGeometryFile | null };

export interface OcrBoxPreviewProps {
  wizard: WizardFile | null;
  pages: NormalizedPage[];
  source: OcrBoxPreviewSource;
  /** Optional callback for callers that want to feed results into MasterDB. */
  onResult?: (result: OcrBoxResult) => void;
  panelTitle?: string;
  paddingNorm?: number;
}

const fieldLabelMap = (wizard: WizardFile | null): Map<string, string> => {
  const map = new Map<string, string>();
  if (!wizard) {
    return map;
  }
  for (const field of wizard.fields) {
    map.set(field.fieldId, field.label || field.fieldId);
  }
  return map;
};

const sourceFieldCount = (source: OcrBoxPreviewSource): number => {
  if (source.kind === 'geometry') {
    return source.geometry?.fields.length ?? 0;
  }
  return source.predicted?.fields.length ?? 0;
};

export function OcrBoxPreview({
  wizard,
  pages,
  source,
  onResult,
  panelTitle = 'OCRBOX Extraction Preview',
  paddingNorm
}: OcrBoxPreviewProps) {
  const [result, setResult] = useState<OcrBoxResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runExtract = useCallback(async () => {
    if (pages.length === 0) {
      setError('Load and normalize a document first.');
      return;
    }
    if (sourceFieldCount(source) === 0) {
      setError('No field bboxes available to extract.');
      return;
    }
    setBusy(true);
    setError(null);
    const runner = createOcrBoxRunner();
    try {
      const next =
        source.kind === 'geometry'
          ? await runner.extractFromGeometry({
              geometry: source.geometry!,
              pages,
              paddingNorm
            })
          : await runner.extractFromPredicted({
              predicted: source.predicted!,
              pages,
              paddingNorm
            });
      setResult(next);
      onResult?.(next);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'OCRBOX extraction failed.');
    } finally {
      setBusy(false);
      void runner.dispose();
    }
  }, [pages, source, onResult, paddingNorm]);

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseOcrBoxResult(text);
      setResult(parsed);
      onResult?.(parsed);
      setError(null);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Could not import OCRBOX result.');
    }
  };

  const labels = fieldLabelMap(wizard);
  const disabled = busy || pages.length === 0 || sourceFieldCount(source) === 0;

  return (
    <Panel className="ocrbox-preview">
      <div className="ocrbox-preview__header">
        <strong>{panelTitle}</strong>
        <span className="ocrbox-preview__meta">
          {source.kind === 'geometry'
            ? 'Source: GeometryFile (Config bboxes)'
            : 'Source: PredictedGeometryFile (Run bboxes)'}
        </span>
      </div>
      <div className="ocrbox-preview__toolbar">
        <Button type="button" variant="primary" onClick={runExtract} disabled={disabled}>
          {busy ? 'Extracting…' : 'Extract Text from BBOXes'}
        </Button>
        <Button
          type="button"
          onClick={() => result && downloadOcrBoxResult(result)}
          disabled={!result}
        >
          Download OCRBOX JSON
        </Button>
        <label className="ocrbox-preview__import">
          <span>Import existing OCRBOX JSON</span>
          <input type="file" accept="application/json" onChange={handleImport} />
        </label>
      </div>
      {error ? <p className="ocrbox-preview__error">{error}</p> : null}
      {result ? (
        <table className="ocrbox-preview__table" aria-label="OCRBOX field results">
          <thead>
            <tr>
              <th>Field</th>
              <th>Page</th>
              <th>Status</th>
              <th>Confidence</th>
              <th>Text</th>
            </tr>
          </thead>
          <tbody>
            {result.fields.map((field) => (
              <tr key={field.fieldId} data-status={field.status}>
                <td>
                  <strong>{labels.get(field.fieldId) ?? field.fieldId}</strong>
                  <span className="ocrbox-preview__field-id">{field.fieldId}</span>
                </td>
                <td>{field.pageIndex + 1}</td>
                <td>{field.status}</td>
                <td>{field.confidence.toFixed(2)}</td>
                <td>
                  {field.status === 'error' ? (
                    <span className="ocrbox-preview__error">{field.errorMessage ?? 'error'}</span>
                  ) : (
                    <pre className="ocrbox-preview__text">{field.text || '—'}</pre>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="ocrbox-preview__meta">
          Click <em>Extract Text from BBOXes</em> to OCR each saved field box on the current
          NormalizedPage. The persisted bbox is never modified — extraction uses the bbox
          plus a small symmetric padding only.
        </p>
      )}
    </Panel>
  );
}
