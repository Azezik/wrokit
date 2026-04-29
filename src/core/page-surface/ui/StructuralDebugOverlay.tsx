import { useMemo, useState } from 'react';

import type {
  StructuralFieldRelationship,
  StructuralObjectNode,
  StructuralPage
} from '../../contracts/structural-model';
import type { TransformationPage } from '../../contracts/transformation-model';
import {
  normalizedRectToScreen,
  type NormalizedRect,
  type SurfaceTransform
} from '../page-surface';
import {
  projectConfigPageRaw,
  projectConfigPageTransformed,
  type ProjectedConfigObject,
  type ProjectedConfigPage
} from './config-projection';
import {
  filterStructuralObjects,
  type StructuralOverlayOptions
} from './structural-overlay-options';

import './structural-debug-overlay.css';

export interface StructuralOverlayFieldBox {
  fieldId: string;
  label?: string;
  bbox: NormalizedRect;
  variant: 'saved' | 'predicted';
}

export interface StructuralDebugOverlayProps {
  page: StructuralPage | null;
  surfaceTransform: SurfaceTransform | null;
  visible: boolean;
  options: StructuralOverlayOptions;
  fieldBoxes?: StructuralOverlayFieldBox[];
  /**
   * Optional alignment report for the same page. When supplied and the user
   * has enabled `showTransformationMatches`, the overlay annotates each
   * matched runtime object with a small confidence badge. When absent the
   * toggle is a no-op (Config Mode never has a transformation report).
   */
  transformationPage?: TransformationPage | null;
  /**
   * Optional Config StructuralModel page paired with the runtime page above.
   * Required to render the "Config projection (raw / transformed)" debug
   * overlays — the raw view draws config rects directly (red), the transformed
   * view applies the same per-object transform ladder the localization runner
   * uses (green). Run Mode passes this; Config Mode leaves it null because
   * there is no separate config page to project.
   */
  configPage?: StructuralPage | null;
}

const buildContainmentChainText = (
  objectById: Map<string, StructuralObjectNode>,
  objectId: string
): string => {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current = objectById.get(objectId) ?? null;
  while (current) {
    if (visited.has(current.objectId)) {
      chain.push('[cycle]');
      break;
    }
    visited.add(current.objectId);
    chain.unshift(current.objectId);
    current = current.parentObjectId ? objectById.get(current.parentObjectId) ?? null : null;
  }
  return chain.join(' > ');
};

const buildAnchorIndex = (
  fields: ReadonlyArray<StructuralFieldRelationship>
): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const field of fields) {
    const primary = field.fieldAnchors.objectAnchors.find((a) => a.rank === 'primary');
    if (!primary) {
      continue;
    }
    const list = map.get(primary.objectId) ?? [];
    list.push(field.fieldId);
    map.set(primary.objectId, list);
  }
  return map;
};

interface MatchedRuntimeInfo {
  configObjectId: string;
  confidence: number;
}

const buildMatchedRuntimeIndex = (
  transformationPage: TransformationPage | null | undefined
): Map<string, MatchedRuntimeInfo> => {
  const map = new Map<string, MatchedRuntimeInfo>();
  if (!transformationPage) {
    return map;
  }
  for (const match of transformationPage.objectMatches) {
    map.set(match.runtimeObjectId, {
      configObjectId: match.configObjectId,
      confidence: match.confidence
    });
  }
  return map;
};

interface ConfigProjectionRender {
  variant: 'raw' | 'transformed';
  border: ReturnType<typeof normalizedRectToScreen>;
  refinedBorder: ReturnType<typeof normalizedRectToScreen>;
  objects: Array<{
    object: ProjectedConfigObject;
    screenRect: ReturnType<typeof normalizedRectToScreen>;
  }>;
}

const buildConfigProjectionRender = (
  variant: 'raw' | 'transformed',
  projection: ProjectedConfigPage,
  surfaceTransform: SurfaceTransform,
  options: StructuralOverlayOptions
): ConfigProjectionRender => {
  const filteredObjects = filterStructuralObjects(
    projection.objects.map((o) => ({
      objectId: o.objectId,
      objectRectNorm: o.rectNorm,
      bbox: o.rectNorm,
      parentObjectId: o.parentObjectId,
      childObjectIds: o.childObjectIds,
      confidence: o.confidence,
      depth: o.depth
    })),
    options
  );
  const filteredIds = new Set(filteredObjects.map((o) => o.objectId));
  return {
    variant,
    border: normalizedRectToScreen(surfaceTransform, projection.border),
    refinedBorder: normalizedRectToScreen(surfaceTransform, projection.refinedBorder),
    objects: projection.objects
      .filter((o) => filteredIds.has(o.objectId))
      .map((object) => ({
        object,
        screenRect: normalizedRectToScreen(surfaceTransform, object.rectNorm)
      }))
  };
};

export function StructuralDebugOverlay({
  page,
  surfaceTransform,
  visible,
  options,
  fieldBoxes = [],
  transformationPage = null,
  configPage = null
}: StructuralDebugOverlayProps) {
  const [hoveredObjectId, setHoveredObjectId] = useState<string | null>(null);

  const overlay = useMemo(() => {
    if (!page || !surfaceTransform || !visible) {
      return null;
    }

    const objectById = new Map(page.objectHierarchy.objects.map((o) => [o.objectId, o]));
    const filteredObjects = filterStructuralObjects(page.objectHierarchy.objects, options);
    const anchorIndex = buildAnchorIndex(page.fieldRelationships);
    const matchedRuntimeIndex = buildMatchedRuntimeIndex(transformationPage);

    return {
      border: normalizedRectToScreen(surfaceTransform, page.border.rectNorm),
      refinedBorder: normalizedRectToScreen(surfaceTransform, page.refinedBorder.rectNorm),
      refinedBorderSource: page.refinedBorder.source,
      cvExecutionMode: page.cvExecutionMode,
      objects: filteredObjects.map((object) => ({
        ...object,
        screenRect: normalizedRectToScreen(surfaceTransform, object.objectRectNorm),
        containmentChainText: buildContainmentChainText(objectById, object.objectId),
        anchoredFieldIds: anchorIndex.get(object.objectId) ?? [],
        match: matchedRuntimeIndex.get(object.objectId) ?? null
      })),
      fields: fieldBoxes.map((box) => ({
        ...box,
        screenRect: normalizedRectToScreen(surfaceTransform, box.bbox)
      }))
    };
  }, [fieldBoxes, options, page, surfaceTransform, visible, transformationPage]);

  const configProjections = useMemo<ConfigProjectionRender[]>(() => {
    if (!surfaceTransform || !visible || !configPage) {
      return [];
    }
    const out: ConfigProjectionRender[] = [];
    if (options.showConfigProjectionRaw) {
      out.push(
        buildConfigProjectionRender(
          'raw',
          projectConfigPageRaw(configPage),
          surfaceTransform,
          options
        )
      );
    }
    if (options.showConfigProjectionTransformed) {
      out.push(
        buildConfigProjectionRender(
          'transformed',
          projectConfigPageTransformed(configPage, transformationPage),
          surfaceTransform,
          options
        )
      );
    }
    return out;
  }, [configPage, options, surfaceTransform, transformationPage, visible]);

  if (!overlay) {
    return null;
  }

  return (
    <>
      <div
        className="structural-debug-overlay__border"
        style={{
          left: `${overlay.border.x}px`,
          top: `${overlay.border.y}px`,
          width: `${overlay.border.width}px`,
          height: `${overlay.border.height}px`
        }}
      >
        <span className="structural-debug-overlay__label">Border</span>
      </div>
      <div
        className="structural-debug-overlay__refined"
        style={{
          left: `${overlay.refinedBorder.x}px`,
          top: `${overlay.refinedBorder.y}px`,
          width: `${overlay.refinedBorder.width}px`,
          height: `${overlay.refinedBorder.height}px`
        }}
      >
        <span className="structural-debug-overlay__label">
          Refined ({overlay.refinedBorderSource}) · CV {overlay.cvExecutionMode}
        </span>
      </div>

      {options.showStructuralObjects
        ? overlay.objects.map((object) => {
            const isHovered = hoveredObjectId === object.objectId;
            const isAnchorObject =
              options.showFieldAnchors && object.anchoredFieldIds.length > 0;
            const isMatched =
              options.showTransformationMatches && object.match !== null;
            return (
              <div
                key={object.objectId}
                className="structural-debug-overlay__object"
                data-depth={Math.min(object.depth, 4)}
                data-has-children={object.childObjectIds.length > 0 ? 'true' : 'false'}
                data-hovered={isHovered ? 'true' : 'false'}
                data-anchor={isAnchorObject ? 'true' : 'false'}
                data-matched={isMatched ? 'true' : 'false'}
                style={{
                  left: `${object.screenRect.x}px`,
                  top: `${object.screenRect.y}px`,
                  width: `${object.screenRect.width}px`,
                  height: `${object.screenRect.height}px`
                }}
                onPointerEnter={() => setHoveredObjectId(object.objectId)}
                onPointerLeave={() =>
                  setHoveredObjectId((current) => (current === object.objectId ? null : current))
                }
              >
                {options.showLabels || isHovered ? (
                  <span className="structural-debug-overlay__object-label">
                    object · depth {object.depth} · {object.objectId} · conf {object.confidence.toFixed(2)}
                  </span>
                ) : null}
                {(options.showLabels || isHovered) && options.showContainmentChains ? (
                  <span className="structural-debug-overlay__object-chain">
                    chain: {object.containmentChainText}
                  </span>
                ) : null}
                {isAnchorObject ? (
                  <span
                    className="structural-debug-overlay__anchor-badge"
                    title={`Primary anchor for: ${object.anchoredFieldIds.join(', ')}`}
                  >
                    ⚓ {object.anchoredFieldIds.length}
                  </span>
                ) : null}
                {isMatched && object.match ? (
                  <span
                    className="structural-debug-overlay__match-badge"
                    title={`Matched config object ${object.match.configObjectId}`}
                  >
                    ↔ {object.match.confidence.toFixed(2)}
                  </span>
                ) : null}
              </div>
            );
          })
        : null}

      {overlay.fields.map((field) => (
        <div
          key={`${field.variant}-${field.fieldId}`}
          className="structural-debug-overlay__field"
          data-variant={field.variant}
          style={{
            left: `${field.screenRect.x}px`,
            top: `${field.screenRect.y}px`,
            width: `${field.screenRect.width}px`,
            height: `${field.screenRect.height}px`
          }}
        >
          <span className="structural-debug-overlay__label">{field.label ?? field.fieldId}</span>
        </div>
      ))}

      {configProjections.map((projection) => (
        <div
          key={`config-projection-${projection.variant}`}
          className="structural-debug-overlay__config-projection"
          data-variant={projection.variant}
          aria-hidden="true"
        >
          <div
            className="structural-debug-overlay__config-border"
            data-variant={projection.variant}
            style={{
              left: `${projection.border.x}px`,
              top: `${projection.border.y}px`,
              width: `${projection.border.width}px`,
              height: `${projection.border.height}px`
            }}
          >
            <span className="structural-debug-overlay__label">
              Config Border ({projection.variant})
            </span>
          </div>
          <div
            className="structural-debug-overlay__config-refined"
            data-variant={projection.variant}
            style={{
              left: `${projection.refinedBorder.x}px`,
              top: `${projection.refinedBorder.y}px`,
              width: `${projection.refinedBorder.width}px`,
              height: `${projection.refinedBorder.height}px`
            }}
          >
            <span className="structural-debug-overlay__label">
              Config Refined ({projection.variant})
            </span>
          </div>
          {projection.objects.map(({ object, screenRect }) => (
            <div
              key={`${projection.variant}-${object.objectId}`}
              className="structural-debug-overlay__config-object"
              data-variant={projection.variant}
              data-depth={Math.min(object.depth, 4)}
              data-transform-source={object.transformSource}
              title={
                projection.variant === 'transformed'
                  ? `Config object ${object.objectId} · transform via ${object.transformSource} · conf ${object.transformConfidence.toFixed(2)}`
                  : `Config object ${object.objectId} · raw (no transform) · conf ${object.confidence.toFixed(2)}`
              }
              style={{
                left: `${screenRect.x}px`,
                top: `${screenRect.y}px`,
                width: `${screenRect.width}px`,
                height: `${screenRect.height}px`
              }}
            >
              {options.showLabels ? (
                <span className="structural-debug-overlay__object-label">
                  {projection.variant === 'transformed'
                    ? `${object.objectId} · ${object.transformSource} · ${object.transformConfidence.toFixed(2)}`
                    : `${object.objectId} · raw`}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
