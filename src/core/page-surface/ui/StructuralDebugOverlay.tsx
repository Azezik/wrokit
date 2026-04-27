import { useMemo } from 'react';

import type { StructuralObjectNode, StructuralPage } from '../../contracts/structural-model';
import {
  normalizedRectToScreen,
  type NormalizedRect,
  type SurfaceTransform
} from '../page-surface';

import './structural-debug-overlay.css';

export interface StructuralOverlayFieldBox {
  fieldId: string;
  label?: string;
  bbox: NormalizedRect;
  variant: 'saved' | 'predicted';
}

export interface StructuralOverlayOptions {
  showStructuralObjects: boolean;
  showLineObjects: boolean;
  showLabels: boolean;
  showContainmentChains: boolean;
  showAllObjects: boolean;
}

export const DEFAULT_STRUCTURAL_OVERLAY_OPTIONS: StructuralOverlayOptions = {
  showStructuralObjects: true,
  showLineObjects: false,
  showLabels: false,
  showContainmentChains: false,
  showAllObjects: false
};

const isLineType = (type: StructuralObjectNode['type']): boolean =>
  type === 'line-horizontal' || type === 'line-vertical';

const isAlwaysVisibleType = (type: StructuralObjectNode['type']): boolean =>
  type === 'container' ||
  type === 'table-like' ||
  type === 'group-region' ||
  type === 'nested-region' ||
  type === 'header' ||
  type === 'footer';

const objectVisibleWithDefaults = (object: StructuralObjectNode): boolean =>
  object.confidence >= 0.75 || isAlwaysVisibleType(object.type);

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

export interface StructuralDebugOverlayProps {
  page: StructuralPage | null;
  surfaceTransform: SurfaceTransform | null;
  visible: boolean;
  options: StructuralOverlayOptions;
  fieldBoxes?: StructuralOverlayFieldBox[];
}

export function StructuralDebugOverlay({
  page,
  surfaceTransform,
  visible,
  options,
  fieldBoxes = []
}: StructuralDebugOverlayProps) {
  const overlay = useMemo(() => {
    if (!page || !surfaceTransform || !visible) {
      return null;
    }

    const objectById = new Map(page.objectHierarchy.objects.map((object) => [object.objectId, object]));
    const filteredObjects = page.objectHierarchy.objects.filter((object) => {
      if (!options.showLineObjects && isLineType(object.type)) {
        return false;
      }
      if (!options.showAllObjects && !objectVisibleWithDefaults(object)) {
        return false;
      }
      return true;
    });

    return {
      border: normalizedRectToScreen(surfaceTransform, page.border.rectNorm),
      refinedBorder: normalizedRectToScreen(surfaceTransform, page.refinedBorder.rectNorm),
      refinedBorderSource: page.refinedBorder.source,
      cvExecutionMode: page.cvExecutionMode,
      objects: filteredObjects.map((object) => ({
        ...object,
        screenRect: normalizedRectToScreen(surfaceTransform, object.objectRectNorm),
        containmentChainText: buildContainmentChainText(objectById, object.objectId)
      })),
      fields: fieldBoxes.map((box) => ({
        ...box,
        screenRect: normalizedRectToScreen(surfaceTransform, box.bbox)
      }))
    };
  }, [fieldBoxes, options, page, surfaceTransform, visible]);

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
        ? overlay.objects.map((object) => (
            <div
              key={object.objectId}
              className="structural-debug-overlay__object"
              data-object-type={object.type}
              style={{
                left: `${object.screenRect.x}px`,
                top: `${object.screenRect.y}px`,
                width: `${object.screenRect.width}px`,
                height: `${object.screenRect.height}px`
              }}
            >
              {options.showLabels ? (
                <span className="structural-debug-overlay__object-label">
                  {object.type} · {object.objectId} · conf: {object.confidence.toFixed(2)}
                </span>
              ) : null}
              {options.showLabels && options.showContainmentChains ? (
                <span className="structural-debug-overlay__object-chain">
                  chain: {object.containmentChainText}
                </span>
              ) : null}
            </div>
          ))
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
