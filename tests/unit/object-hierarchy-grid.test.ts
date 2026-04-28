import { describe, expect, it } from 'vitest';

import { buildObjectHierarchy } from '../../src/core/engines/structure/object-hierarchy';

const rect = (xNorm: number, yNorm: number, wNorm: number, hNorm: number) => ({
  xNorm,
  yNorm,
  wNorm,
  hNorm
});

describe('buildObjectHierarchy structure-aware classification', () => {
  it('promotes a parent rectangle whose children form a 2x2 grid to table-like', () => {
    // Parent at (0.1..0.5, 0.1..0.5). Four cells in a 2x2 grid plus the parent.
    const hierarchy = buildObjectHierarchy([
      { objectId: 'parent', type: 'rectangle', bbox: rect(0.1, 0.1, 0.4, 0.4), confidence: 0.8 },
      { objectId: 'tl', type: 'rectangle', bbox: rect(0.1, 0.1, 0.2, 0.2), confidence: 0.8 },
      { objectId: 'tr', type: 'rectangle', bbox: rect(0.3, 0.1, 0.2, 0.2), confidence: 0.8 },
      { objectId: 'bl', type: 'rectangle', bbox: rect(0.1, 0.3, 0.2, 0.2), confidence: 0.8 },
      { objectId: 'br', type: 'rectangle', bbox: rect(0.3, 0.3, 0.2, 0.2), confidence: 0.8 }
    ]);

    const parent = hierarchy.objects.find((node) => node.objectId === 'parent');
    expect(parent).toBeDefined();
    expect(parent!.type).toBe('table-like');
    // Children remain rectangles (leaf cells).
    for (const id of ['tl', 'tr', 'bl', 'br']) {
      const child = hierarchy.objects.find((node) => node.objectId === id)!;
      expect(child.type).toBe('rectangle');
      expect(child.parentObjectId).toBe('parent');
    }
  });

  it('classifies a parent with non-grid children as group-region, not table-like', () => {
    // Three children of varying sizes scattered inside parent — no grid.
    const hierarchy = buildObjectHierarchy([
      { objectId: 'parent', type: 'rectangle', bbox: rect(0.0, 0.0, 0.6, 0.6), confidence: 0.8 },
      { objectId: 'a', type: 'rectangle', bbox: rect(0.05, 0.05, 0.1, 0.1), confidence: 0.8 },
      { objectId: 'b', type: 'rectangle', bbox: rect(0.4, 0.2, 0.15, 0.05), confidence: 0.8 },
      { objectId: 'c', type: 'rectangle', bbox: rect(0.2, 0.45, 0.2, 0.1), confidence: 0.8 }
    ]);

    const parent = hierarchy.objects.find((node) => node.objectId === 'parent')!;
    expect(parent.type).toBe('group-region');
  });

  it('does not let line-only children turn a parent into table-like', () => {
    // A parent containing only horizontal/vertical lines is NOT a table; the
    // structural label should depend on real cell children.
    const hierarchy = buildObjectHierarchy([
      { objectId: 'parent', type: 'rectangle', bbox: rect(0.0, 0.0, 0.5, 0.5), confidence: 0.8 },
      { objectId: 'h1', type: 'line-horizontal', bbox: rect(0.05, 0.1, 0.4, 0.005), confidence: 0.9 },
      { objectId: 'h2', type: 'line-horizontal', bbox: rect(0.05, 0.2, 0.4, 0.005), confidence: 0.9 },
      { objectId: 'v1', type: 'line-vertical', bbox: rect(0.1, 0.05, 0.005, 0.4), confidence: 0.9 },
      { objectId: 'v2', type: 'line-vertical', bbox: rect(0.3, 0.05, 0.005, 0.4), confidence: 0.9 }
    ]);

    const parent = hierarchy.objects.find((node) => node.objectId === 'parent')!;
    expect(parent.type).not.toBe('table-like');
  });

  it('builds a 3-deep hierarchy for nested grids (page → table → cell)', () => {
    // A "page" rectangle that contains a "table" rectangle that contains a 2x2 grid.
    const hierarchy = buildObjectHierarchy([
      { objectId: 'page', type: 'rectangle', bbox: rect(0.0, 0.0, 1.0, 1.0), confidence: 0.7 },
      { objectId: 'table', type: 'rectangle', bbox: rect(0.1, 0.1, 0.4, 0.4), confidence: 0.8 },
      { objectId: 'tl', type: 'rectangle', bbox: rect(0.1, 0.1, 0.2, 0.2), confidence: 0.8 },
      { objectId: 'tr', type: 'rectangle', bbox: rect(0.3, 0.1, 0.2, 0.2), confidence: 0.8 },
      { objectId: 'bl', type: 'rectangle', bbox: rect(0.1, 0.3, 0.2, 0.2), confidence: 0.8 },
      { objectId: 'br', type: 'rectangle', bbox: rect(0.3, 0.3, 0.2, 0.2), confidence: 0.8 }
    ]);

    const tableNode = hierarchy.objects.find((node) => node.objectId === 'table')!;
    const pageNode = hierarchy.objects.find((node) => node.objectId === 'page')!;

    expect(tableNode.parentObjectId).toBe('page');
    expect(tableNode.type).toBe('table-like');
    // The page contains exactly one direct child (the table) — that's not a
    // grid, so it should be a group-region, not a table-like itself.
    expect(pageNode.type).toBe('group-region');

    // All four cells should be parented to the table.
    for (const id of ['tl', 'tr', 'bl', 'br']) {
      const cell = hierarchy.objects.find((node) => node.objectId === id)!;
      expect(cell.parentObjectId).toBe('table');
    }
  });
});
