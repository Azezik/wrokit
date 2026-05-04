import { useState, type ChangeEvent, type DragEvent } from 'react';

import { Button } from '../../../../core/ui/components/Button';
import type { OrchestratorApi } from '../../orchestrator/useOrchestrator';

interface UploadBatchSlideProps {
  orchestrator: OrchestratorApi;
}

const ACCEPTED = '.pdf,image/png,image/jpeg,image/webp';

export function UploadBatchSlide({ orchestrator }: UploadBatchSlideProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);

  const addFiles = (incoming: FileList | File[] | null) => {
    if (!incoming) {
      return;
    }
    const next = [...files];
    for (const f of Array.from(incoming)) {
      if (!next.some((existing) => existing.name === f.name && existing.size === f.size)) {
        next.push(f);
      }
    }
    setFiles(next);
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(event.target.files);
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragActive(false);
    addFiles(event.dataTransfer.files);
  };

  const handleDragOver = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = () => {
    setDragActive(false);
  };

  const removeFile = (index: number) => {
    setFiles(files.filter((_, i) => i !== index));
  };

  const handleStart = () => {
    if (files.length === 0) {
      return;
    }
    void orchestrator.runBatch(files);
  };

  return (
    <>
      <div className="polished-wizard__slide">
        <h2 className="polished-wizard__title">All set!</h2>
        <p className="polished-wizard__subtitle">
          Drop the documents you want extracted. The wizard processes them one at a time and
          collects the results into a single MasterDB.
        </p>

        <label
          className={`polished-wizard__dropzone${dragActive ? ' polished-wizard__dropzone--active' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <input type="file" multiple accept={ACCEPTED} onChange={handleInput} />
          <strong>Drag & drop files, or click to choose</strong>
          <p className="polished-wizard__hint">PDF, PNG, JPEG, or WebP — multiple files supported.</p>
        </label>

        {files.length > 0 ? (
          <ul className="polished-wizard__file-list">
            {files.map((file, index) => (
              <li key={`${file.name}-${file.size}-${index}`}>
                <span>{file.name}</span>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-danger)' }}
                  aria-label={`Remove ${file.name}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {orchestrator.state.error ? (
          <p className="polished-wizard__error">{orchestrator.state.error}</p>
        ) : null}
      </div>

      <footer className="polished-wizard__footer">
        <Button type="button" onClick={() => orchestrator.goTo('draw')}>
          Back
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={handleStart}
          disabled={files.length === 0}
        >
          Process {files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : ''}
        </Button>
      </footer>
    </>
  );
}
