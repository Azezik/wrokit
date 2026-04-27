import { useMemo, useRef, useState, type ChangeEvent } from 'react';

import type { GeometryFile } from '../../../core/contracts/geometry';
import type { NormalizedPage } from '../../../core/contracts/normalized-page';
import type { StructuralModel } from '../../../core/contracts/structural-model';
import type { WizardFile } from '../../../core/contracts/wizard';
import { createNormalizationEngine } from '../../../core/engines/normalization';
import {
  GeometryFileParseError,
  parseGeometryFile
} from '../../../core/io/geometry-file-io';
import {
  parseStructuralModel,
  StructuralModelParseError
} from '../../../core/io/structural-model-io';
import { parseWizardFile, WizardFileParseError } from '../../../core/io/wizard-file-io';
import {
  type SurfaceTransform
} from '../../../core/page-surface/page-surface';
import {
  DEFAULT_STRUCTURAL_OVERLAY_OPTIONS,
  NormalizedPageViewport,
  StructuralDebugOverlay,
  type StructuralOverlayFieldBox,
  type StructuralOverlayOptions
} from '../../../core/page-surface/ui';
import { createLocalizationRunner, type PredictedGeometryFile } from '../../../core/runtime/localization-runner';
import { createStructuralRunner } from '../../../core/runtime/structural-runner';
import { createTransformationRunner } from '../../../core/runtime/transformation-runner';
import type { TransformationModel } from '../../../core/contracts/transformation-model';
import { Button } from '../../../core/ui/components/Button';
import { Input } from '../../../core/ui/components/Input';
import { Panel } from '../../../core/ui/components/Panel';
import { Section } from '../../../core/ui/components/Section';

import './run-mode.css';

const ACCEPTED_DOC_FORMATS = '.pdf,image/png,image/jpeg,image/webp';

export function RunMode() {
  const normalizationEngineRef = useRef(createNormalizationEngine());
  const structuralRunnerRef = useRef(createStructuralRunner());
  const localizationRunnerRef = useRef(createLocalizationRunner());
  const transformationRunnerRef = useRef(createTransformationRunner());

  const [wizard, setWizard] = useState<WizardFile | null>(null);
  const [geometry, setGeometry] = useState<GeometryFile | null>(null);
  const [configStructuralModel, setConfigStructuralModel] = useState<StructuralModel | null>(null);

  const [runtimePages, setRuntimePages] = useState<NormalizedPage[]>([]);
  const [runtimeDocumentFingerprint, setRuntimeDocumentFingerprint] = useState('');
  const [selectedPageIndex, setSelectedPageIndex] = useState(0);

  const [predicted, setPredicted] = useState<PredictedGeometryFile | null>(null);
  const [runtimeStructuralModel, setRuntimeStructuralModel] = useState<StructuralModel | null>(null);
  const [transformationModel, setTransformationModel] = useState<TransformationModel | null>(null);
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [isComputingPredictions, setIsComputingPredictions] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [geometryError, setGeometryError] = useState<string | null>(null);
  const [configStructuralError, setConfigStructuralError] = useState<string | null>(null);
  const [runtimeNormalizationError, setRuntimeNormalizationError] = useState<string | null>(null);
  const [showRuntimeStructuralOverlay, setShowRuntimeStructuralOverlay] = useState<boolean>(true);
  const [structuralOverlayOptions, setStructuralOverlayOptions] = useState<StructuralOverlayOptions>(
    DEFAULT_STRUCTURAL_OVERLAY_OPTIONS
  );

  const [surfaceTransform, setSurfaceTransform] = useState<SurfaceTransform | null>(null);
  const structuralRuntimeLoadStatus = structuralRunnerRef.current.runtimeLoadStatus;

  const selectedPage = useMemo(
    () => runtimePages.find((page) => page.pageIndex === selectedPageIndex) ?? null,
    [runtimePages, selectedPageIndex]
  );

  const fieldLabels = useMemo(() => {
    const map = new Map<string, string>();
    if (!wizard) {
      return map;
    }
    for (const field of wizard.fields) {
      map.set(field.fieldId, field.label || field.fieldId);
    }
    return map;
  }, [wizard]);

  const predictedBoxesForPage = useMemo<StructuralOverlayFieldBox[]>(() => {
    if (!predicted || !selectedPage) {
      return [];
    }
    return predicted.fields
      .filter((field) => field.pageIndex === selectedPage.pageIndex)
      .map((field) => ({
        fieldId: field.fieldId,
        label: fieldLabels.get(field.fieldId) ?? field.fieldId,
        bbox: field.bbox,
        variant: 'predicted'
      }));
  }, [predicted, selectedPage, fieldLabels]);

  const runtimeStructuralPage = useMemo(() => {
    if (!runtimeStructuralModel || !selectedPage) {
      return null;
    }
    return (
      runtimeStructuralModel.pages.find((page) => page.pageIndex === selectedPage.pageIndex) ?? null
    );
  }, [runtimeStructuralModel, selectedPage]);

  const jsonPreview = useMemo(
    () => (predicted ? JSON.stringify(predicted, null, 2) : ''),
    [predicted]
  );

  const runtimeStructuralPreview = useMemo(
    () => (runtimeStructuralModel ? JSON.stringify(runtimeStructuralModel, null, 2) : ''),
    [runtimeStructuralModel]
  );

  const transformationPreview = useMemo(
    () => (transformationModel ? JSON.stringify(transformationModel, null, 2) : ''),
    [transformationModel]
  );

  const handleWizardImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    try {
      setWizard(parseWizardFile(await file.text()));
      setWizardError(null);
      setRunError(null);
    } catch (uploadError) {
      setWizardError(
        uploadError instanceof WizardFileParseError ? uploadError.message : 'Could not load WizardFile.'
      );
      setWizard(null);
    }
  };

  const handleGeometryImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    try {
      setGeometry(parseGeometryFile(await file.text()));
      setGeometryError(null);
      setRunError(null);
    } catch (uploadError) {
      setGeometryError(
        uploadError instanceof GeometryFileParseError ? uploadError.message : 'Could not load GeometryFile.'
      );
      setGeometry(null);
    }
  };

  const handleStructuralImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    try {
      setConfigStructuralModel(parseStructuralModel(await file.text()));
      setConfigStructuralError(null);
      setRunError(null);
    } catch (uploadError) {
      setConfigStructuralError(
        uploadError instanceof StructuralModelParseError
          ? uploadError.message
          : 'Could not load Config StructuralModel.'
      );
      setConfigStructuralModel(null);
    }
  };

  const handleRuntimeUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    setIsNormalizing(true);
    setRunError(null);
    setRuntimeNormalizationError(null);
    setPredicted(null);
    setRuntimeStructuralModel(null);
    setTransformationModel(null);

    try {
      const result = await normalizationEngineRef.current.normalize(file);
      setRuntimePages(result.pages);
      setSelectedPageIndex(result.pages[0]?.pageIndex ?? 0);
      const signature = result.pages
        .map((page) => `${page.pageIndex}:${Math.round(page.width)}x${Math.round(page.height)}`)
        .join('|');
      setRuntimeDocumentFingerprint(`surface:${result.sourceName}#${signature}`);
    } catch (uploadError) {
      setRuntimePages([]);
      setRuntimeDocumentFingerprint('');
      setRuntimeNormalizationError(
        uploadError instanceof Error ? uploadError.message : 'Runtime normalization failed.'
      );
    } finally {
      setIsNormalizing(false);
    }
  };

  const handleRunPrediction = async () => {
    if (!wizard || !geometry || !configStructuralModel || runtimePages.length === 0) {
      setRunError('Load WizardFile, GeometryFile, StructuralModel, and runtime document before matching.');
      return;
    }

    setIsComputingPredictions(true);
    setRunError(null);

    try {
      const runtimeStructuralModel = await structuralRunnerRef.current.compute({
        pages: runtimePages,
        documentFingerprint: runtimeDocumentFingerprint,
        geometry: null
      });
      setRuntimeStructuralModel(runtimeStructuralModel);

      // Read-only alignment report between Config and Runtime StructuralModels.
      // Does not influence localization in this phase; it is exposed for
      // inspection and for future localization consumers.
      const transformationReport = transformationRunnerRef.current.compute({
        config: configStructuralModel,
        runtime: runtimeStructuralModel
      });
      setTransformationModel(transformationReport);

      const result = await localizationRunnerRef.current.run({
        wizardId: wizard.wizardName,
        configGeometry: geometry,
        configStructuralModel,
        runtimeStructuralModel,
        runtimePages
      });

      setPredicted(result);
    } catch (runError) {
      setRuntimeStructuralModel(null);
      setTransformationModel(null);
      setPredicted(null);
      setRunError(runError instanceof Error ? runError.message : 'Run Mode matching failed.');
    } finally {
      setIsComputingPredictions(false);
    }
  };

  const handleDownloadPredicted = () => {
    if (!predicted) {
      return;
    }
    const blob = new Blob([JSON.stringify(predicted, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = `${predicted.wizardId.replace(/\s+/g, '-').toLowerCase()}.predicted-geometry.json`;
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  return (
    <Section
      title="Run Mode"
      description="Load config artifacts + runtime document, build runtime structure, and relocate saved human-confirmed BBOX geometry on the new NormalizedPage."
    >
      <div className="run-mode">
        <Panel className="run-mode__column">
          <h3 style={{ marginTop: 0 }}>Inputs</h3>
          <label className="run-mode__upload-label">
            <strong>WizardFile (JSON)</strong>
            <Input type="file" accept="application/json" onChange={handleWizardImport} />
          </label>

          <label className="run-mode__upload-label">
            <strong>GeometryFile (JSON)</strong>
            <Input type="file" accept="application/json" onChange={handleGeometryImport} />
          </label>

          <label className="run-mode__upload-label">
            <strong>Config StructuralModel (JSON)</strong>
            <Input type="file" accept="application/json" onChange={handleStructuralImport} />
          </label>

          <label className="run-mode__upload-label">
            <strong>Runtime document upload</strong>
            <Input type="file" accept={ACCEPTED_DOC_FORMATS} onChange={handleRuntimeUpload} />
          </label>

          <div className="run-mode__toolbar">
            <label className="run-mode__toggle">
              <input
                type="checkbox"
                checked={showRuntimeStructuralOverlay}
                onChange={(event) => setShowRuntimeStructuralOverlay(event.target.checked)}
              />{' '}
              Show Runtime Structural Debug Overlay
            </label>
            <label className="run-mode__toggle">
              <input
                type="checkbox"
                checked={structuralOverlayOptions.showStructuralObjects}
                onChange={(event) =>
                  setStructuralOverlayOptions((current) => ({
                    ...current,
                    showStructuralObjects: event.target.checked
                  }))
                }
              />{' '}
              Show Structural Objects
            </label>
            <label className="run-mode__toggle">
              <input
                type="checkbox"
                checked={structuralOverlayOptions.showLineObjects}
                onChange={(event) =>
                  setStructuralOverlayOptions((current) => ({
                    ...current,
                    showLineObjects: event.target.checked
                  }))
                }
              />{' '}
              Show Line Objects
            </label>
            <label className="run-mode__toggle">
              <input
                type="checkbox"
                checked={structuralOverlayOptions.showAllObjects}
                onChange={(event) =>
                  setStructuralOverlayOptions((current) => ({
                    ...current,
                    showAllObjects: event.target.checked
                  }))
                }
              />{' '}
              Show All Objects
            </label>
            <label className="run-mode__toggle">
              <input
                type="checkbox"
                checked={structuralOverlayOptions.showLabels}
                onChange={(event) =>
                  setStructuralOverlayOptions((current) => ({
                    ...current,
                    showLabels: event.target.checked
                  }))
                }
              />{' '}
              Show Object Labels
            </label>
            <label className="run-mode__toggle">
              <input
                type="checkbox"
                checked={structuralOverlayOptions.showContainmentChains}
                onChange={(event) =>
                  setStructuralOverlayOptions((current) => ({
                    ...current,
                    showContainmentChains: event.target.checked
                  }))
                }
              />{' '}
              Show Containment Chains
            </label>
          </div>

          <div className="run-mode__toolbar">
            <Button type="button" variant="primary" onClick={handleRunPrediction}>
              Match Runtime Document
            </Button>
            <Button type="button" onClick={handleDownloadPredicted}>
              Download Predicted Geometry
            </Button>
          </div>

          <ul className="run-mode__status-list">
            <li>
              WizardFile: {wizard ? 'loaded' : 'not loaded'}
              {wizard ? ` (${wizard.wizardName})` : ''}
            </li>
            <li>
              GeometryFile: {geometry ? 'loaded' : 'not loaded'}
              {geometry ? ` (${geometry.fields.length} fields)` : ''}
            </li>
            <li>
              Config StructuralModel: {configStructuralModel ? 'loaded' : 'not loaded'}
              {configStructuralModel ? ` (${configStructuralModel.pages.length} pages)` : ''}
            </li>
            <li>
              Runtime document: {runtimePages.length > 0 ? 'normalized' : 'not normalized'}
              {runtimePages.length > 0 ? ` (${runtimePages.length} pages)` : ''}
            </li>
            <li>
              Selected runtime page:{' '}
              {selectedPage ? `${selectedPage.pageIndex + 1} of ${runtimePages.length}` : 'none'}
            </li>
            <li>
              Runtime structure status:{' '}
              {runtimeStructuralModel
                ? `computed via ${runtimeStructuralModel.cvAdapter.name}@${runtimeStructuralModel.cvAdapter.version} · page CV ${runtimeStructuralPage?.cvExecutionMode ?? 'n/a'}`
                : 'not computed'}
              {structuralRuntimeLoadStatus
                ? ` · OpenCV runtime ${structuralRuntimeLoadStatus.status}${structuralRuntimeLoadStatus.reason ? ` (${structuralRuntimeLoadStatus.reason})` : ''}`
                : ''}
            </li>
            <li>
              TransformationModel:{' '}
              {transformationModel
                ? `computed · overall confidence ${transformationModel.overallConfidence.toFixed(3)}`
                : 'not computed'}
            </li>
          </ul>

          {isNormalizing ? <p className="run-mode__meta">Normalizing runtime upload…</p> : null}
          {isComputingPredictions ? <p className="run-mode__meta">Building runtime structure + predictions…</p> : null}
          {wizardError ? <p className="run-mode__error">WizardFile error: {wizardError}</p> : null}
          {geometryError ? <p className="run-mode__error">GeometryFile error: {geometryError}</p> : null}
          {configStructuralError ? (
            <p className="run-mode__error">Config StructuralModel error: {configStructuralError}</p>
          ) : null}
          {runtimeNormalizationError ? (
            <p className="run-mode__error">Runtime normalization error: {runtimeNormalizationError}</p>
          ) : null}
          {runError ? <p className="run-mode__error">Run Mode error: {runError}</p> : null}
        </Panel>

        <Panel className="run-mode__column">
          <h3 style={{ marginTop: 0 }}>Runtime normalized page with predicted BBOX overlays</h3>
          {runtimePages.length > 1 ? (
            <div className="run-mode__toolbar" role="group" aria-label="Runtime page selection">
              {runtimePages.map((page) => (
                <Button
                  key={page.pageIndex}
                  type="button"
                  variant={selectedPageIndex === page.pageIndex ? 'primary' : 'default'}
                  onClick={() => setSelectedPageIndex(page.pageIndex)}
                >
                  Page {page.pageIndex + 1}
                </Button>
              ))}
            </div>
          ) : null}

          <NormalizedPageViewport
            page={selectedPage}
            imageAlt={
              selectedPage ? `Runtime normalized page ${selectedPage.pageIndex + 1}` : undefined
            }
            overlayAriaLabel="Runtime structural and predicted overlays"
            onSurfaceTransformChange={setSurfaceTransform}
            emptyState={
              <p className="run-mode__meta">Runtime normalized page preview appears here.</p>
            }
          >
            <StructuralDebugOverlay
              page={runtimeStructuralPage}
              surfaceTransform={surfaceTransform}
              visible={showRuntimeStructuralOverlay}
              options={structuralOverlayOptions}
              fieldBoxes={predictedBoxesForPage}
            />
          </NormalizedPageViewport>

          <h4>Predicted Geometry JSON</h4>
          <pre className="run-mode__json">{jsonPreview || 'Run matching to preview predicted geometry JSON.'}</pre>
          <h4>Runtime StructuralModel JSON</h4>
          <pre className="run-mode__json">
            {runtimeStructuralPreview || 'Run matching to preview runtime StructuralModel JSON.'}
          </pre>
          <h4>
            TransformationModel (alignment report)
            {transformationModel
              ? ` · overall confidence ${transformationModel.overallConfidence.toFixed(3)}`
              : ''}
          </h4>
          <pre className="run-mode__json">
            {transformationPreview || 'Run matching to preview the Config↔Runtime alignment report.'}
          </pre>
        </Panel>
      </div>
    </Section>
  );
}
