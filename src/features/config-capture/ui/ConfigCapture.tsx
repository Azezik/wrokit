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

import type { GeometryFile } from '../../../core/contracts/geometry';
import type { StructuralModel } from '../../../core/contracts/structural-model';
import type { WizardFile } from '../../../core/contracts/wizard';
import { createNormalizationEngine } from '../../../core/engines/normalization';
import {
  downloadGeometryFile,
  GeometryFileParseError,
  parseGeometryFile,
  serializeGeometryFile
} from '../../../core/io/geometry-file-io';
import {
  downloadStructuralModel,
  serializeStructuralModel
} from '../../../core/io/structural-model-io';
import { parseWizardFile, WizardFileParseError } from '../../../core/io/wizard-file-io';
import {
  buildSurfaceTransform,
  getPageSurface,
  isNormalizedRectInBounds,
  normalizedRectToScreen,
  normalizeRectFromCorners,
  screenToSurface,
  surfaceRectToNormalized,
  type PixelRect
} from '../../../core/page-surface/page-surface';
import { createConfigRunner } from '../../../core/runtime/config-runner';
import { createStructuralRunner } from '../../../core/runtime/structural-runner';
import { createGeometryBuilderStore } from '../../../core/storage/geometry-builder-store';
import { getNormalizedPageSessionStore } from '../../../core/storage/normalized-page-session-store';
import { createStructuralStore } from '../../../core/storage/structural-store';
import { Button } from '../../../core/ui/components/Button';
import { Input } from '../../../core/ui/components/Input';
import { Panel } from '../../../core/ui/components/Panel';
import { Section } from '../../../core/ui/components/Section';

import './config-capture.css';

const ACCEPTED_DOC_FORMATS = '.pdf,image/png,image/jpeg,image/webp';

interface DraftBox {
  startScreen: { x: number; y: number };
  currentScreen: { x: number; y: number };
}

export function ConfigCapture() {
  const normalizationEngineRef = useRef(createNormalizationEngine());
  const configRunnerRef = useRef(createConfigRunner());
  const structuralRunnerRef = useRef(createStructuralRunner());
  const builderStoreRef = useRef(createGeometryBuilderStore());
  const builderStore = builderStoreRef.current;
  const pageSessionStoreRef = useRef(getNormalizedPageSessionStore());
  const pageSessionStore = pageSessionStoreRef.current;
  const structuralStoreRef = useRef(createStructuralStore());
  const structuralStore = structuralStoreRef.current;
  const builderState = useSyncExternalStore(builderStore.subscribe, builderStore.getSnapshot);
  const pageSession = useSyncExternalStore(pageSessionStore.subscribe, pageSessionStore.getSnapshot);
  const structuralState = useSyncExternalStore(
    structuralStore.subscribe,
    structuralStore.getSnapshot
  );

  const [wizard, setWizard] = useState<WizardFile | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);

  const [normalizationError, setNormalizationError] = useState<string | null>(null);
  const [isNormalizing, setIsNormalizing] = useState(false);

  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftBox | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [showStructuralOverlay, setShowStructuralOverlay] = useState<boolean>(true);
  const [structuralError, setStructuralError] = useState<string | null>(null);
  const [isComputingStructure, setIsComputingStructure] = useState<boolean>(false);
  const [activeStructuralModelId, setActiveStructuralModelId] = useState<string | null>(null);

  const imageRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [displayRect, setDisplayRect] = useState<{ width: number; height: number } | null>(null);

  const selectedPage = useMemo(
    () => pageSession.pages.find((page) => page.pageIndex === pageSession.selectedPageIndex) ?? null,
    [pageSession.pages, pageSession.selectedPageIndex]
  );

  useEffect(() => {
    if (wizard) {
      void builderStore.setWizardId(wizard.wizardName);
    }
  }, [wizard, builderStore]);

  useEffect(() => {
    void builderStore.setDocumentFingerprint(pageSession.documentFingerprint);
  }, [pageSession.documentFingerprint, builderStore]);

  useEffect(() => {
    if (!wizard) {
      setActiveFieldId(null);
      return;
    }
    if (!activeFieldId && wizard.fields.length > 0) {
      const firstUnsaved = wizard.fields.find(
        (field) => !builderState.fields.some((saved) => saved.fieldId === field.fieldId)
      );
      setActiveFieldId(firstUnsaved?.fieldId ?? wizard.fields[0].fieldId);
    }
  }, [wizard, activeFieldId, builderState.fields]);

  const measureFrame = useCallback(() => {
    if (!imageRef.current) {
      return;
    }
    const rect = imageRef.current.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setDisplayRect({ width: rect.width, height: rect.height });
    }
  }, []);

  useEffect(() => {
    if (!imageRef.current) {
      return;
    }
    const observer = new ResizeObserver(measureFrame);
    observer.observe(imageRef.current);
    measureFrame();
    return () => {
      observer.disconnect();
    };
  }, [measureFrame, selectedPage]);

  const surfaceTransform = useMemo(() => {
    if (!selectedPage || !displayRect) {
      return null;
    }
    const surface = getPageSurface(selectedPage);
    return buildSurfaceTransform(surface, displayRect);
  }, [selectedPage, displayRect]);

  const geometryFileSnapshot: GeometryFile = useMemo(
    () => builderStore.toGeometryFile(),
    [builderState, builderStore]
  );

  useEffect(() => {
    if (pageSession.pages.length === 0) {
      setActiveStructuralModelId(null);
      setStructuralError(null);
      return;
    }
    const fingerprint = pageSession.documentFingerprint;
    const pages = pageSession.pages;
    let cancelled = false;

    const runCompute = async () => {
      setIsComputingStructure(true);
      setStructuralError(null);
      try {
        const model = await structuralRunnerRef.current.compute({
          pages,
          documentFingerprint: fingerprint,
          geometry: geometryFileSnapshot.fields.length > 0 ? geometryFileSnapshot : null
        });
        if (cancelled) {
          return;
        }
        await structuralStore.save(model);
        setActiveStructuralModelId(model.id);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setStructuralError(
          error instanceof Error ? error.message : 'Could not compute StructuralModel.'
        );
      } finally {
        if (!cancelled) {
          setIsComputingStructure(false);
        }
      }
    };

    void runCompute();
    return () => {
      cancelled = true;
    };
  }, [
    pageSession.documentFingerprint,
    pageSession.pages,
    geometryFileSnapshot,
    structuralStore
  ]);

  const activeStructuralModel: StructuralModel | null = useMemo(() => {
    if (!activeStructuralModelId) {
      return null;
    }
    return (
      structuralState.models.find((model) => model.id === activeStructuralModelId) ?? null
    );
  }, [structuralState.models, activeStructuralModelId]);

  const activeStructuralPage = useMemo(() => {
    if (!activeStructuralModel) {
      return null;
    }
    return (
      activeStructuralModel.pages.find(
        (page) => page.pageIndex === pageSession.selectedPageIndex
      ) ?? null
    );
  }, [activeStructuralModel, pageSession.selectedPageIndex]);

  const structuralOverlay = useMemo(() => {
    if (!surfaceTransform || !activeStructuralPage) {
      return null;
    }
    return {
      border: normalizedRectToScreen(surfaceTransform, activeStructuralPage.border.rectNorm),
      refinedBorder: normalizedRectToScreen(
        surfaceTransform,
        activeStructuralPage.refinedBorder.rectNorm
      ),
      objects: activeStructuralPage.objectHierarchy.objects.map((object) => ({
        objectId: object.objectId,
        type: object.type,
        rect: normalizedRectToScreen(surfaceTransform, object.bbox)
      })),
      source: activeStructuralPage.refinedBorder.source,
      influencedByBBoxCount: activeStructuralPage.refinedBorder.influencedByBBoxCount
    };
  }, [surfaceTransform, activeStructuralPage]);

  const structuralPreview = useMemo(
    () => (activeStructuralModel ? serializeStructuralModel(activeStructuralModel) : ''),
    [activeStructuralModel]
  );

  const handleWizardImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseWizardFile(text);
      setWizard(parsed);
      setWizardError(null);
      setActiveFieldId(parsed.fields[0]?.fieldId ?? null);
    } catch (error) {
      setWizardError(
        error instanceof WizardFileParseError ? error.message : 'Could not import WizardFile.'
      );
    }
  };

  const handleDocumentUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    setIsNormalizing(true);
    setNormalizationError(null);
    try {
      const result = await normalizationEngineRef.current.normalize(file);
      await pageSessionStore.setNormalizedDocument({
        sourceName: result.sourceName,
        pages: result.pages
      });
    } catch (error) {
      await pageSessionStore.clearSession();
      setNormalizationError(
        error instanceof Error ? error.message : 'Normalization failed.'
      );
    } finally {
      setIsNormalizing(false);
    }
  };

  const handleGeometryImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseGeometryFile(text);
      await builderStore.loadFromGeometryFile(parsed);
      setImportError(null);
    } catch (error) {
      setImportError(
        error instanceof GeometryFileParseError ? error.message : 'Could not import GeometryFile.'
      );
    }
  };

  const screenPointFromEvent = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
      if (!imageRef.current) {
        return null;
      }
      const rect = imageRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const clampedX = Math.max(0, Math.min(rect.width, x));
      const clampedY = Math.max(0, Math.min(rect.height, y));
      return { x: clampedX, y: clampedY };
    },
    []
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!surfaceTransform || !activeFieldId) {
      return;
    }
    const point = screenPointFromEvent(event);
    if (!point) {
      return;
    }
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    setDraft({ startScreen: point, currentScreen: point });
  };

  const persistDraft = useCallback(
    async (draftToSave: DraftBox) => {
      if (!surfaceTransform || !activeFieldId || !selectedPage) {
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
        fieldId: activeFieldId,
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

      if (wizard) {
        const remaining = wizard.fields.find(
          (field) =>
            field.fieldId !== activeFieldId &&
            !builderState.fields.some((saved) => saved.fieldId === field.fieldId)
        );
        if (remaining) {
          setActiveFieldId(remaining.fieldId);
        }
      }
    },
    [surfaceTransform, activeFieldId, selectedPage, builderStore, wizard, builderState.fields]
  );

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
        const finalizedDraft = { startScreen: current.startScreen, currentScreen: point };
        void persistDraft(finalizedDraft);
        return finalizedDraft;
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

  const saveActiveField = async () => {
    if (!draft) {
      return;
    }
    await persistDraft(draft);
  };

  const removeField = async (fieldId: string) => {
    await builderStore.removeField(fieldId);
  };

  const validation = useMemo(() => {
    if (!wizard) {
      return null;
    }
    return configRunnerRef.current.validateExisting(
      geometryFileSnapshot,
      wizard,
      pageSession.pages
    );
  }, [geometryFileSnapshot, wizard, pageSession.pages]);

  const livePreview = useMemo(
    () => serializeGeometryFile(geometryFileSnapshot),
    [geometryFileSnapshot]
  );

  const activeFieldLabel = useMemo(() => {
    if (!wizard || !activeFieldId) {
      return null;
    }
    return wizard.fields.find((field) => field.fieldId === activeFieldId)?.label ?? activeFieldId;
  }, [wizard, activeFieldId]);

  const overlayBoxes = useMemo(() => {
    if (!surfaceTransform) {
      return [];
    }
    return builderState.fields
      .filter((field) => field.pageIndex === pageSession.selectedPageIndex)
      .map((field) => ({
        fieldId: field.fieldId,
        rect: normalizedRectToScreen(surfaceTransform, field.bbox)
      }));
  }, [builderState.fields, pageSession.selectedPageIndex, surfaceTransform]);

  return (
    <Section
      title="Config Mode — BBOX Capture"
      description="Load a WizardFile and a normalized document. Draw the bbox for each field directly on the canonical NormalizedPage surface."
    >
      <div className="config-capture">
        <Panel className="config-capture__column config-capture__panel--capture">
          <div className="config-capture__toolbar">
            <label>
              <Input type="file" accept="application/json" onChange={handleWizardImport} />
            </label>
            <span className="config-capture__meta">
              {wizard
                ? `Wizard: ${wizard.wizardName || '(unnamed)'} · ${wizard.fields.length} field(s)`
                : 'No WizardFile loaded.'}
            </span>
          </div>
          {wizardError ? <p className="config-capture__error">{wizardError}</p> : null}

          <div className="config-capture__toolbar">
            <label>
              <Input
                type="file"
                accept={ACCEPTED_DOC_FORMATS}
                onChange={handleDocumentUpload}
              />
            </label>
            {isNormalizing ? (
              <span className="config-capture__meta">Normalizing upload…</span>
            ) : (
              <span className="config-capture__meta">
                {pageSession.sourceName
                  ? `Source: ${pageSession.sourceName} · ${pageSession.pages.length} page(s)`
                  : 'No document loaded.'}
              </span>
            )}
          </div>
          {normalizationError ? <p className="config-capture__error">{normalizationError}</p> : null}

          {pageSession.pages.length > 1 ? (
            <div className="config-capture__toolbar" role="group" aria-label="Page selection">
              {pageSession.pages.map((page) => (
                <Button
                  key={page.pageIndex}
                  type="button"
                  variant={pageSession.selectedPageIndex === page.pageIndex ? 'primary' : 'default'}
                  onClick={() => {
                    void pageSessionStore.selectPage(page.pageIndex);
                    setDraft(null);
                  }}
                >
                  Page {page.pageIndex + 1}
                </Button>
              ))}
            </div>
          ) : null}

          <p className="config-capture__prompt" aria-live="polite">
            {wizard && activeFieldLabel
              ? `Where is ${activeFieldLabel}?`
              : wizard
                ? 'All fields captured. Select one to edit.'
                : 'Load a WizardFile and a document to begin.'}
          </p>

          <div
            ref={frameRef}
            className="config-capture__viewport-frame"
            style={{ display: selectedPage ? 'inline-block' : 'none' }}
          >
            {selectedPage?.imageDataUrl ? (
              <img
                ref={imageRef}
                className="config-capture__viewport-image"
                src={selectedPage.imageDataUrl}
                alt={`Normalized page ${selectedPage.pageIndex + 1}`}
                onLoad={measureFrame}
              />
            ) : null}

            <div
              className="config-capture__overlay"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              role="application"
              aria-label="Draw bounding box on normalized page"
            >
              {showStructuralOverlay && structuralOverlay ? (
                <>
                  <div
                    className="config-capture__structural-border"
                    aria-hidden="true"
                    style={{
                      left: `${structuralOverlay.border.x}px`,
                      top: `${structuralOverlay.border.y}px`,
                      width: `${structuralOverlay.border.width}px`,
                      height: `${structuralOverlay.border.height}px`
                    }}
                  >
                    <span className="config-capture__structural-label">Border</span>
                  </div>
                  <div
                    className="config-capture__structural-refined"
                    aria-hidden="true"
                    style={{
                      left: `${structuralOverlay.refinedBorder.x}px`,
                      top: `${structuralOverlay.refinedBorder.y}px`,
                      width: `${structuralOverlay.refinedBorder.width}px`,
                      height: `${structuralOverlay.refinedBorder.height}px`
                    }}
                  >
                    <span className="config-capture__structural-label">
                      Refined ({structuralOverlay.source})
                    </span>
                  </div>
                  {structuralOverlay.objects.map((object) => (
                    <div
                      key={object.objectId}
                      className="config-capture__structural-object"
                      data-object-type={object.type}
                      aria-hidden="true"
                      style={{
                        left: `${object.rect.x}px`,
                        top: `${object.rect.y}px`,
                        width: `${object.rect.width}px`,
                        height: `${object.rect.height}px`
                      }}
                    >
                      <span className="config-capture__structural-object-label">
                        {object.type} · {object.objectId}
                      </span>
                    </div>
                  ))}
                </>
              ) : null}

              {overlayBoxes.map((overlay) => (
                <div
                  key={overlay.fieldId}
                  className="config-capture__overlay-box"
                  data-saved="true"
                  data-active={overlay.fieldId === activeFieldId ? 'true' : 'false'}
                  style={{
                    left: `${overlay.rect.x}px`,
                    top: `${overlay.rect.y}px`,
                    width: `${overlay.rect.width}px`,
                    height: `${overlay.rect.height}px`
                  }}
                >
                  <span className="config-capture__overlay-label">{overlay.fieldId}</span>
                </div>
              ))}

              {draftScreenRect ? (
                <div
                  className="config-capture__draft"
                  style={{
                    left: `${draftScreenRect.x}px`,
                    top: `${draftScreenRect.y}px`,
                    width: `${draftScreenRect.width}px`,
                    height: `${draftScreenRect.height}px`
                  }}
                />
              ) : null}
            </div>
          </div>

          <div className="config-capture__toolbar">
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                void saveActiveField();
              }}
              disabled={!draft || !activeFieldId || !surfaceTransform}
            >
              Save Field
            </Button>
            <Button
              type="button"
              onClick={() => {
                setDraft(null);
              }}
              disabled={!draft}
            >
              Cancel Draft
            </Button>
          </div>

          <div className="config-capture__toolbar">
            <label className="config-capture__toggle">
              <input
                type="checkbox"
                checked={showStructuralOverlay}
                onChange={(event) => setShowStructuralOverlay(event.target.checked)}
              />
              Show Structural Debug Overlay
            </label>
            <span className="config-capture__meta">
              {isComputingStructure
                ? 'Computing StructuralModel…'
                : activeStructuralModel
                  ? `Structural: ${activeStructuralModel.cvAdapter.name} v${activeStructuralModel.cvAdapter.version} · ${activeStructuralModel.pages.length} page(s)`
                  : pageSession.pages.length > 0
                    ? 'StructuralModel pending.'
                    : 'No NormalizedPage loaded.'}
            </span>
          </div>
          {structuralError ? <p className="config-capture__error">{structuralError}</p> : null}
        </Panel>

        <Panel as="aside" className="config-capture__column config-capture__panel--details">
          <strong>Wizard Fields</strong>
          <div className="config-capture__field-list">
            {wizard && wizard.fields.length > 0 ? (
              wizard.fields.map((field) => {
                const saved = builderState.fields.find((entry) => entry.fieldId === field.fieldId);
                return (
                  <div
                    key={field.fieldId}
                    className="config-capture__field-row"
                    data-active={field.fieldId === activeFieldId ? 'true' : 'false'}
                    data-saved={saved ? 'true' : 'false'}
                  >
                    <div>
                      <div>
                        <strong>{field.label}</strong>{' '}
                        <span className="config-capture__field-status">({field.fieldId})</span>
                      </div>
                      <div className="config-capture__field-status">
                        {saved
                          ? `Saved · page ${saved.pageIndex + 1} · ${(saved.bbox.wNorm * 100).toFixed(1)}% × ${(saved.bbox.hNorm * 100).toFixed(1)}%`
                          : field.required
                            ? 'Required · not yet captured'
                            : 'Not yet captured'}
                      </div>
                    </div>
                    <Button
                      type="button"
                      onClick={() => {
                        setActiveFieldId(field.fieldId);
                        setDraft(null);
                      }}
                    >
                      {saved ? 'Redraw' : 'Capture'}
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      disabled={!saved}
                      onClick={() => {
                        void removeField(field.fieldId);
                      }}
                    >
                      Clear
                    </Button>
                  </div>
                );
              })
            ) : (
              <p className="config-capture__meta">No fields available. Import a WizardFile first.</p>
            )}
          </div>

          <div className="config-capture__toolbar">
            <Button
              type="button"
              onClick={() => {
                downloadGeometryFile(geometryFileSnapshot);
              }}
              disabled={!wizard || builderState.fields.length === 0}
            >
              Download GeometryFile JSON
            </Button>
            <label>
              <Input type="file" accept="application/json" onChange={handleGeometryImport} />
            </label>
          </div>
          {importError ? <p className="config-capture__error">{importError}</p> : null}

          {validation ? (
            <Panel>
              <strong
                className={
                  validation.ok
                    ? 'config-capture__validation--ok'
                    : 'config-capture__validation--error'
                }
              >
                {validation.ok ? 'Validation passed.' : `Validation issues (${validation.issues.length})`}
              </strong>
              {validation.issues.length > 0 ? (
                <ul className="config-capture__validation-list">
                  {validation.issues.map((issue, index) => (
                    <li key={`${issue.code}-${index}`} className="config-capture__validation--error">
                      <code>{issue.code}</code> — {issue.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Panel>
          ) : null}

          <div>
            <strong>Live GeometryFile JSON</strong>
            <pre className="config-capture__json">{livePreview}</pre>
          </div>

          <div className="config-capture__toolbar">
            <Button
              type="button"
              onClick={() => {
                if (activeStructuralModel) {
                  downloadStructuralModel(activeStructuralModel);
                }
              }}
              disabled={!activeStructuralModel}
            >
              Download StructuralModel JSON
            </Button>
          </div>

          <div>
            <strong>Live StructuralModel JSON</strong>
            <pre className="config-capture__json">
              {structuralPreview || 'StructuralModel will be computed once a NormalizedPage is loaded.'}
            </pre>
          </div>
        </Panel>
      </div>
    </Section>
  );
}
