import { describe, expect, it } from 'vitest';

import type {
  StructuralNormalizedRect,
  StructuralObjectNode,
  StructuralObjectType
} from '../../src/core/contracts/structural-model';
import {
  ADVANCED_OVERLAY_OPTIONS,
  DEFAULT_STRUCTURAL_OVERLAY_OPTIONS,
  SIMPLE_OVERLAY_OPTIONS,
  filterStructuralObjects,
  objectPassesOverlayFilter,
  optionsMatchPreset,
  overlayPresetForMode,
  type StructuralOverlayOptions
} from '../../src/core/page-surface/ui/structural-overlay-options';

const rect = (x: number, y: number, w: number, h: number): StructuralNormalizedRect => ({
  xNorm: x,
  yNorm: y,
  wNorm: w,
  hNorm: h
});

const node = (
  objectId: string,
  type: StructuralObjectType,
  confidence = 0.9
): StructuralObjectNode => {
  const r = rect(0, 0, 0.1, 0.1);
  return {
    objectId,
    type,
    objectRectNorm: r,
    bbox: r,
    parentObjectId: null,
    childObjectIds: [],
    confidence
  };
};

describe('overlay presets', () => {
  it('DEFAULT alias resolves to the Simple preset', () => {
    expect(DEFAULT_STRUCTURAL_OVERLAY_OPTIONS).toBe(SIMPLE_OVERLAY_OPTIONS);
  });

  it('Simple preset disables labels, chains, anchors, matches, and lines by default', () => {
    expect(SIMPLE_OVERLAY_OPTIONS.mode).toBe('simple');
    expect(SIMPLE_OVERLAY_OPTIONS.showLabels).toBe(false);
    expect(SIMPLE_OVERLAY_OPTIONS.showContainmentChains).toBe(false);
    expect(SIMPLE_OVERLAY_OPTIONS.showFieldAnchors).toBe(false);
    expect(SIMPLE_OVERLAY_OPTIONS.showTransformationMatches).toBe(false);
    expect(SIMPLE_OVERLAY_OPTIONS.showLineObjects).toBe(false);
    expect(SIMPLE_OVERLAY_OPTIONS.showAllObjects).toBe(false);
    expect(SIMPLE_OVERLAY_OPTIONS.minObjectConfidence).toBeGreaterThan(0);
  });

  it('Advanced preset enables every overlay surface', () => {
    expect(ADVANCED_OVERLAY_OPTIONS.mode).toBe('advanced');
    expect(ADVANCED_OVERLAY_OPTIONS.showLabels).toBe(true);
    expect(ADVANCED_OVERLAY_OPTIONS.showContainmentChains).toBe(true);
    expect(ADVANCED_OVERLAY_OPTIONS.showFieldAnchors).toBe(true);
    expect(ADVANCED_OVERLAY_OPTIONS.showTransformationMatches).toBe(true);
    expect(ADVANCED_OVERLAY_OPTIONS.showLineObjects).toBe(true);
    expect(ADVANCED_OVERLAY_OPTIONS.showAllObjects).toBe(true);
  });

  it('overlayPresetForMode returns the matching preset', () => {
    expect(overlayPresetForMode('simple')).toBe(SIMPLE_OVERLAY_OPTIONS);
    expect(overlayPresetForMode('advanced')).toBe(ADVANCED_OVERLAY_OPTIONS);
  });

  it('optionsMatchPreset detects an exact preset match', () => {
    expect(optionsMatchPreset(SIMPLE_OVERLAY_OPTIONS, 'simple')).toBe(true);
    expect(optionsMatchPreset(ADVANCED_OVERLAY_OPTIONS, 'advanced')).toBe(true);
  });

  it('optionsMatchPreset returns false when any sub-toggle differs', () => {
    const tweaked: StructuralOverlayOptions = { ...SIMPLE_OVERLAY_OPTIONS, showLabels: true };
    expect(optionsMatchPreset(tweaked, 'simple')).toBe(false);
  });
});

describe('objectPassesOverlayFilter', () => {
  it('hides line objects when showLineObjects is false', () => {
    const line = node('l', 'line-horizontal', 0.95);
    expect(objectPassesOverlayFilter(line, SIMPLE_OVERLAY_OPTIONS)).toBe(false);
  });

  it('shows line objects when showLineObjects is true', () => {
    const line = node('l', 'line-horizontal', 0.4);
    expect(objectPassesOverlayFilter(line, ADVANCED_OVERLAY_OPTIONS)).toBe(true);
  });

  it('always-visible types bypass the confidence filter', () => {
    const container = node('c', 'container', 0.1);
    expect(objectPassesOverlayFilter(container, SIMPLE_OVERLAY_OPTIONS)).toBe(true);
  });

  it('non-always-visible types respect minObjectConfidence', () => {
    const lowConf = node('r', 'rectangle', 0.5);
    expect(objectPassesOverlayFilter(lowConf, SIMPLE_OVERLAY_OPTIONS)).toBe(false);
    const highConf = node('r2', 'rectangle', 0.9);
    expect(objectPassesOverlayFilter(highConf, SIMPLE_OVERLAY_OPTIONS)).toBe(true);
  });

  it('showAllObjects bypasses the confidence filter for any non-line type', () => {
    const lowConf = node('r', 'rectangle', 0.05);
    const tweaked: StructuralOverlayOptions = {
      ...SIMPLE_OVERLAY_OPTIONS,
      showAllObjects: true
    };
    expect(objectPassesOverlayFilter(lowConf, tweaked)).toBe(true);
  });

  it('a custom minObjectConfidence excludes objects below the threshold', () => {
    const tweaked: StructuralOverlayOptions = {
      ...SIMPLE_OVERLAY_OPTIONS,
      minObjectConfidence: 0.5
    };
    expect(objectPassesOverlayFilter(node('r', 'rectangle', 0.4), tweaked)).toBe(false);
    expect(objectPassesOverlayFilter(node('r', 'rectangle', 0.6), tweaked)).toBe(true);
  });
});

describe('filterStructuralObjects', () => {
  it('removes filtered-out objects and preserves order', () => {
    const objects: StructuralObjectNode[] = [
      node('a', 'container', 0.1),
      node('b', 'rectangle', 0.4),
      node('c', 'line-horizontal', 0.95),
      node('d', 'rectangle', 0.95)
    ];
    const filtered = filterStructuralObjects(objects, SIMPLE_OVERLAY_OPTIONS);
    expect(filtered.map((o) => o.objectId)).toEqual(['a', 'd']);
  });
});
