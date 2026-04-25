import { useMemo, useRef, useState, type ChangeEvent } from 'react';

import type { NormalizedPage } from '../../../core/contracts/normalized-page';
import { createNormalizationEngine } from '../../../core/engines/normalization';
import { Button } from '../../../core/ui/components/Button';
import { Input } from '../../../core/ui/components/Input';
import { Panel } from '../../../core/ui/components/Panel';
import { Section } from '../../../core/ui/components/Section';

import './normalization-intake.css';

const ACCEPTED_FORMATS = '.pdf,image/png,image/jpeg,image/webp';

export function NormalizationIntake() {
  const engineRef = useRef(createNormalizationEngine());
  const [sourceName, setSourceName] = useState('');
  const [pages, setPages] = useState<NormalizedPage[]>([]);
  const [selectedPageIndex, setSelectedPageIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const selectedPage = useMemo(
    () => pages.find((page) => page.pageIndex === selectedPageIndex) ?? null,
    [pages, selectedPageIndex]
  );

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await engineRef.current.normalize(file);
      setSourceName(result.sourceName);
      setPages(result.pages);
      setSelectedPageIndex(0);
    } catch (uploadError) {
      setSourceName('');
      setPages([]);
      setSelectedPageIndex(0);
      setError(uploadError instanceof Error ? uploadError.message : 'Normalization failed.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Section
      title="Normalized Page Intake"
      description="Upload PDF, PNG, JPG/JPEG, or WebP. All inputs are converted into uniform NormalizedPage raster surfaces."
    >
      <Panel className="normalization-intake">
        <div className="normalization-intake__toolbar">
          <label>
            <Input type="file" accept={ACCEPTED_FORMATS} onChange={onUpload} />
          </label>
          <Button
            type="button"
            onClick={() => {
              setSourceName('');
              setPages([]);
              setSelectedPageIndex(0);
              setError(null);
            }}
          >
            Clear
          </Button>
        </div>

        {isLoading ? <p className="normalization-intake__meta">Normalizing upload…</p> : null}

        {sourceName && pages.length > 0 ? (
          <p className="normalization-intake__meta">
            Source: <strong>{sourceName}</strong> · Page {selectedPageIndex + 1} of {pages.length}
          </p>
        ) : (
          <p className="normalization-intake__meta">No file normalized yet.</p>
        )}

        {pages.length > 1 ? (
          <div className="normalization-intake__toolbar" role="group" aria-label="Page selection">
            {pages.map((page) => (
              <Button
                key={page.pageIndex}
                type="button"
                variant={selectedPageIndex === page.pageIndex ? 'primary' : 'default'}
                onClick={() => {
                  setSelectedPageIndex(page.pageIndex);
                }}
              >
                Page {page.pageIndex + 1}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="normalization-intake__viewport" aria-live="polite">
          {selectedPage?.imageDataUrl ? (
            <img
              className="normalization-intake__image"
              src={selectedPage.imageDataUrl}
              alt={`Normalized page ${selectedPage.pageIndex + 1}`}
            />
          ) : (
            <p className="normalization-intake__meta">Normalized page preview appears here.</p>
          )}
        </div>

        {error ? (
          <p role="alert" className="normalization-intake__error">
            {error}
          </p>
        ) : null}
      </Panel>
    </Section>
  );
}
