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

export function StructuralDebugOverlay({
  page,
  surfaceTransform,
  visible,
  options,
  fieldBoxes = [],
  transformationPage = null
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
                data-object-type={object.type}
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
                    {object.type} · {object.objectId} · conf {object.confidence.toFixed(2)}
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
    </>
  );
}
