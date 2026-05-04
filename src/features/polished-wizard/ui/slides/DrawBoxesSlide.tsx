import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';

import { downloadGeometryFile } from '../../../../core/io/geometry-file-io';
import {
  isNormalizedRectInBounds,
  normalizeRectFromCorners,
  screenToSurface,
  surfaceRectToNormalized,
  type PixelRect,
  type SurfaceTransform
} from '../../../../core/page-surface/page-surface';
import {
  NormalizedPageViewport,
  pointerToImageRect,
  type NormalizedPageViewportHandle
} from '../../../../core/page-surface/ui';
import { createGeometryBuilderStore } from '../../../../core/storage/geometry-builder-store';
import { Button } from '../../../../core/ui/components/Button';
import { Input } from '../../../../core/ui/components/Input';
import type { OrchestratorApi } from '../../orchestrator/useOrchestrator';

interface DrawBoxesSlideProps {
  orchestrator: OrchestratorApi;
}

interface DraftBox {
  startScreen: { x: number; y: number };
  currentScreen: { x: number; y: number };
}

export function DrawBoxesSlide({ orchestrator }: DrawBoxesSlideProps) {
  const { state } = orchestrator;
  const wizard = state.wizard;

  const builderStoreRef = useRef(createGeometryBuilderStore());
  const builderStore = builderStoreRef.current;
  const builderState = useSyncExternalStore(builderStore.subscribe, builderStore.getSnapshot);

  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedPageIndex, setSelectedPageIndex] = useState(0);
  const [draft, setDraft] = useState<DraftBox | null>(null);
  const [surfaceTransform, setSurfaceTransform] = useState<SurfaceTransform | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const viewportRef = useRef<NormalizedPageViewportHandle | null>(null);

  useEffect(() => {
    if (wizard) {
      void builderStore.setWizardId(wizard.wizardName);
    }
  }, [wizard, builderStore]);

  useEffect(() => {
    void builderStore.setDocumentFingerprint(state.configFingerprint);
  }, [state.configFingerprint, builderStore]);

  const selectedPage = useMemo(
    () => state.configPages.find((page) => page.pageIndex === selectedPageIndex) ?? null,
    [state.configPages, selectedPageIndex]
  );

  const activeField = wizard?.fields[activeIndex] ?? null;
  const allCaptured =
    wizard !== null &&
    wizard.fields.length > 0 &&
    wizard.fields.every((field) =>
      builderState.fields.some((entry) => entry.fieldId === field.fieldId)
    );

  const handleDocumentUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    setIsUploading(true);
    try {
      await orchestrator.loadConfigDocument(file);
      setSelectedPageIndex(0);
      setActiveIndex(0);
    } finally {
      setIsUploading(false);
    }
  };

  const screenPointFromEvent = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
      const image = viewportRef.current?.getImageElement() ?? null;
      return pointerToImageRect(image, event);
    },
    []
  );

  const persistDraft = useCallback(
    async (draftToSave: DraftBox) => {
      if (!surfaceTransform || !activeField || !selectedPage) {
        return;
      }
      const startSurface = screenToSurface(surfaceTransform, draftToSave.startScreen);
      const endSurface = screenToSurface(surfaceTransform, draftToSave.currentScreen);
      const surface = surfaceTransform.surface;
      const pixelRect = normalizeRectFromCorners(startSurface, endSurface, surface);
      if (pixelRect.width <= 0 || pixelRect.height <= 0) {
        return;
      }
      const normalizedRect = surfaceRectToNormalized(surface, pixelRect);
      if (!isNormalizedRectInBounds(normalizedRect)) {
        return;
      }
      await builderStore.upsertField({
        fieldId: activeField.fieldId,
        pageIndex: selectedPage.pageIndex,
        bbox: normalizedRect,
        pixelBbox: pixelRect,
        pageSurface: {
          pageIndex: surface.pageIndex,
          surfaceWidth: surface.surfaceWidth,
          surfaceHeight: surface.surfaceHeight
        }
      });
      setDraft(null);

      if (wizard && activeIndex < wizard.fields.length - 1) {
        setActiveIndex(activeIndex + 1);
      }
    },
    [surfaceTransform, activeField, selectedPage, builderStore, wizard, activeIndex]
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!surfaceTransform || !activeField) {
      return;
    }
    const point = screenPointFromEvent(event);
    if (!point) {
      return;
    }
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    setDraft({ startScreen: point, currentScreen: point });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = screenPointFromEvent(event);
    if (!point) {
      return;
    }
    setDraft((current) =>
      current
        ? {
            startScreen: current.startScreen,
            currentScreen: point
          }
        : null
    );
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = screenPointFromEvent(event);
    if (point) {
      setDraft((current) => {
        if (!current) {
          return null;
        }
        const finalized = { startScreen: current.startScreen, currentScreen: point };
        void persistDraft(finalized);
        return finalized;
      });
    }
    if ((event.target as HTMLElement).hasPointerCapture?.(event.pointerId)) {
      (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    }
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    setDraft(null);
    if ((event.target as HTMLElement).hasPointerCapture?.(event.pointerId)) {
      (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    }
  };

  const draftScreenRect = useMemo<PixelRect | null>(() => {
    if (!draft) {
      return null;
    }
    const x = Math.min(draft.startScreen.x, draft.currentScreen.x);
    const y = Math.min(draft.startScreen.y, draft.currentScreen.y);
    const width = Math.abs(draft.startScreen.x - draft.currentScreen.x);
    const height = Math.abs(draft.startScreen.y - draft.currentScreen.y);
    return { x, y, width, height };
  }, [draft]);

  const handleBack = async () => {
    if (!wizard) {
      return;
    }
    if (activeIndex === 0) {
      return;
    }
    const previousField = wizard.fields[activeIndex - 1];
    if (previousField) {
      await builderStore.removeField(previousField.fieldId);
    }
    setDraft(null);
    setActiveIndex(activeIndex - 1);
  };

  const handleNext = () => {
    const geometry = builderStore.toGeometryFile();
    orchestrator.setGeometry(geometry);
    orchestrator.goTo('upload');
  };

  const handleDownloadGeometry = () => {
    setOptionsOpen(false);
    const geometry = builderStore.toGeometryFile();
    downloadGeometryFile(geometry);
  };

  const noDocument = state.configPages.length === 0;

  return (
    <>
      <div className="polished-wizard__slide">
        <h2 className="polished-wizard__title">Show us where each field lives</h2>
        <p className="polished-wizard__subtitle">
          Upload a sample document, then draw a box around each requested field.
        </p>

        {noDocument ? (
          <label className="polished-wizard__dropzone">
            <input
              type="file"
              accept=".pdf,image/png,image/jpeg,image/webp"
              onChange={handleDocumentUpload}
            />
            <strong>{isUploading ? 'Loading…' : 'Click to upload a sample document'}</strong>
            <p className="polished-wizard__hint">PDF, PNG, JPEG, or WebP.</p>
          </label>
        ) : (
          <div className="polished-wizard__draw-stage">
            {state.configPages.length > 1 ? (
              <div role="group" aria-label="Page selection" style={{ display: 'flex', gap: '0.5rem' }}>
                {state.configPages.map((page) => (
                  <Button
                    key={page.pageIndex}
                    type="button"
                    variant={selectedPageIndex === page.pageIndex ? 'primary' : 'default'}
                    onClick={() => {
                      setSelectedPageIndex(page.pageIndex);
                      setDraft(null);
                    }}
                  >
                    Page {page.pageIndex + 1}
                  </Button>
                ))}
              </div>
            ) : null}

            <p className="polished-wizard__question" aria-live="polite">
              {allCaptured
                ? 'All fields captured. Click Next to continue.'
                : activeField
                  ? `Where is "${activeField.label}"?`
                  : 'Loading…'}
            </p>

            <div className="polished-wizard__viewport-frame">
              <NormalizedPageViewport
                ref={viewportRef}
                page={selectedPage}
                interactive={!allCaptured}
                overlayRole="application"
                overlayAriaLabel="Draw bounding box"
                onSurfaceTransformChange={setSurfaceTransform}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
              >
                {draftScreenRect ? (
                  <div
                    className="polished-wizard__draft"
                    style={{
                      left: `${draftScreenRect.x}px`,
                      top: `${draftScreenRect.y}px`,
                      width: `${draftScreenRect.width}px`,
                      height: `${draftScreenRect.height}px`
                    }}
                  />
                ) : null}
              </NormalizedPageViewport>
            </div>

            <p className="polished-wizard__hint">
              {wizard
                ? `Field ${Math.min(activeIndex + 1, wizard.fields.length)} of ${wizard.fields.length}`
                : ''}
            </p>
          </div>
        )}

        {state.error ? <p className="polished-wizard__error">{state.error}</p> : null}
      </div>

      <footer className="polished-wizard__footer">
        <div className="polished-wizard__options">
          <Button
            type="button"
            onClick={() => setOptionsOpen((open) => !open)}
            aria-expanded={optionsOpen}
          >
            Options
          </Button>
          {optionsOpen ? (
            <div className="polished-wizard__options-menu" role="menu">
              <button
                type="button"
                onClick={handleDownloadGeometry}
                disabled={builderState.fields.length === 0}
              >
                Download geometry
              </button>
              <label>
                Replace sample document
                <Input
                  type="file"
                  accept=".pdf,image/png,image/jpeg,image/webp"
                  onChange={handleDocumentUpload}
                />
              </label>
            </div>
          ) : null}
        </div>
        <div className="polished-wizard__footer-actions">
          <Button
            type="button"
            onClick={() => {
              void handleBack();
            }}
            disabled={activeIndex === 0 && !allCaptured}
          >
            Back
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleNext}
            disabled={!allCaptured}
          >
            Next
          </Button>
        </div>
      </footer>
    </>
  );
}
