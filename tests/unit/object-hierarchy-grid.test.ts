import { describe, expect, it } from 'vitest';

import { buildObjectHierarchy } from '../../src/core/engines/structure/object-hierarchy';

const rect = (xNorm: number, yNorm: number, wNorm: number, hNorm: number) => ({
  xNorm,
  yNorm,
  wNorm,
  hNorm
});

describe('buildObjectHierarchy: object-only hierarchy', () => {
  it('a parent with four child rects produces a parent object with four children — every node is just an object', () => {
    // Parent at (0.1..0.5, 0.1..0.5). Four cells in a 2x2 grid plus the parent.
    // Under the new model, none of these are "table-like" or "rectangle" — they
    // are all just objects, with parent/child links established by containment.
    const hierarchy = buildObjectHierarchy([
      { objectId: 'parent', bbox: rect(0.1, 0.1, 0.4, 0.4), confidence: 0.8 },
      { objectId: 'tl', bbox: rect(0.1, 0.1, 0.2, 0.2), confidence: 0.8 },
      { objectId: 'tr', bbox: rect(0.3, 0.1, 0.2, 0.2), confidence: 0.8 },
      { objectId: 'bl', bbox: rect(0.1, 0.3, 0.2, 0.2), confidence: 0.8 },
      { objectId: 'br', bbox: rect(0.3, 0.3, 0.2, 0.2), confidence: 0.8 }
    ]);

    const parent = hierarchy.objects.find((node) => node.objectId === 'parent')!;
    expect(parent).toBeDefined();
    expect(parent.parentObjectId).toBeNull();
    expect(parent.depth).toBe(0);
    expect(parent.childObjectIds.sort()).toEqual(['bl', 'br', 'tl', 'tr']);

    for (const id of ['tl', 'tr', 'bl', 'br']) {
      const child = hierarchy.objects.find((node) => node.objectId === id)!;
      expect(child.parentObjectId).toBe('parent');
      expect(child.depth).toBe(1);
      expect(child.childObjectIds).toEqual([]);
    }
  });

  it('a parent with non-grid children is still just an object with children', () => {
    const hierarchy = buildObjectHierarchy([
      { objectId: 'parent', bbox: rect(0.0, 0.0, 0.6, 0.6), confidence: 0.8 },
      { objectId: 'a', bbox: rect(0.05, 0.05, 0.1, 0.1), confidence: 0.8 },
      { objectId: 'b', bbox: rect(0.4, 0.2, 0.15, 0.05), confidence: 0.8 },
      { objectId: 'c', bbox: rect(0.2, 0.45, 0.2, 0.1), confidence: 0.8 }
    ]);

    const parent = hierarchy.objects.find((node) => node.objectId === 'parent')!;
    expect(parent.depth).toBe(0);
    expect(parent.childObjectIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('builds a 3-deep hierarchy: page → middle → leaf with monotonically increasing depth', () => {
    const hierarchy = buildObjectHierarchy([
      { objectId: 'page', bbox: rect(0.0, 0.0, 1.0, 1.0), confidence: 0.7 },
      { objectId: 'middle', bbox: rect(0.1, 0.1, 0.4, 0.4), confidence: 0.8 },
      { objectId: 'tl', bbox: rect(0.1, 0.1, 0.2, 0.2), confidence: 0.8 },
      { objectId: 'tr', bbox: rect(0.3, 0.1, 0.2, 0.2), confidence: 0.8 },
      { objectId: 'bl', bbox: rect(0.1, 0.3, 0.2, 0.2), confidence: 0.8 },
      { objectId: 'br', bbox: rect(0.3, 0.3, 0.2, 0.2), confidence: 0.8 }
    ]);

    const pageNode = hierarchy.objects.find((node) => node.objectId === 'page')!;
    const middleNode = hierarchy.objects.find((node) => node.objectId === 'middle')!;

    expect(pageNode.depth).toBe(0);
    expect(middleNode.parentObjectId).toBe('page');
    expect(middleNode.depth).toBe(1);

    for (const id of ['tl', 'tr', 'bl', 'br']) {
      const cell = hierarchy.objects.find((node) => node.objectId === id)!;
      expect(cell.parentObjectId).toBe('middle');
      expect(cell.depth).toBe(2);
    }
  });

  it('does not assign any semantic type to any node (object-only model)', () => {
    const hierarchy = buildObjectHierarchy([
      { objectId: 'a', bbox: rect(0, 0, 0.5, 0.5), confidence: 0.9 },
      { objectId: 'b', bbox: rect(0.1, 0.1, 0.1, 0.1), confidence: 0.9 }
    ]);
    for (const node of hierarchy.objects) {
      expect((node as Record<string, unknown>).type).toBeUndefined();
    }
  });
});
