import { describe, expect, it } from 'vitest';

import { buildObjectHierarchy } from '../../src/core/engines/structure/object-hierarchy';

const PAGE = 1000;

const rect = (x: number, y: number, w: number, h: number) => ({
  xNorm: x / PAGE,
  yNorm: y / PAGE,
  wNorm: w / PAGE,
  hNorm: h / PAGE
});

describe('buildObjectHierarchy: sibling dedup preserves valid structure', () => {
  it('clean nesting: black → magenta → blue all survive and form a 3-deep chain', () => {
    const hierarchy = buildObjectHierarchy([
      { objectId: 'black', bbox: rect(0, 0, 1000, 1000), confidence: 0.7 },
      { objectId: 'magenta', bbox: rect(100, 100, 400, 120), confidence: 0.8 },
      { objectId: 'blue', bbox: rect(120, 120, 350, 80), confidence: 0.8 }
    ]);

    const ids = hierarchy.objects.map((node) => node.objectId).sort();
    expect(ids).toEqual(['black', 'blue', 'magenta']);

    const black = hierarchy.objects.find((n) => n.objectId === 'black')!;
    const magenta = hierarchy.objects.find((n) => n.objectId === 'magenta')!;
    const blue = hierarchy.objects.find((n) => n.objectId === 'blue')!;

    expect(black.parentObjectId).toBeNull();
    expect(black.depth).toBe(0);
    expect(magenta.parentObjectId).toBe('black');
    expect(magenta.depth).toBe(1);
    expect(blue.parentObjectId).toBe('magenta');
    expect(blue.depth).toBe(2);
  });

  it('shared-boundary segmentation: black, magenta, and blue with shared edges all survive', () => {
    // Magenta fills the left half and shares its bottom edge with the top edge
    // of blue. Magenta's right edge crosses the page interior. Blue is below
    // magenta and within magenta's horizontal column. None of these are
    // duplicates, and the predicate must not collapse them.
    const hierarchy = buildObjectHierarchy([
      { objectId: 'black', bbox: rect(0, 0, 1000, 1000), confidence: 0.7 },
      { objectId: 'magenta', bbox: rect(0, 100, 500, 600), confidence: 0.8 },
      { objectId: 'blue', bbox: rect(50, 700, 200, 300), confidence: 0.8 }
    ]);

    const ids = hierarchy.objects.map((node) => node.objectId).sort();
    expect(ids).toEqual(['black', 'blue', 'magenta']);

    const black = hierarchy.objects.find((n) => n.objectId === 'black')!;
    const magenta = hierarchy.objects.find((n) => n.objectId === 'magenta')!;
    const blue = hierarchy.objects.find((n) => n.objectId === 'blue')!;

    // Magenta is contained in black, blue is contained in black; they are
    // siblings under black with a shared horizontal boundary in the page.
    expect(magenta.parentObjectId).toBe('black');
    expect(blue.parentObjectId).toBe('black');

    // Both magenta and blue are listed as siblings of black.
    expect(black.childObjectIds.sort()).toEqual(['blue', 'magenta']);
  });

  it('true duplicate: sub-pixel jittered rect collapses to one survivor', () => {
    // Two near-identical rects shifted by one pixel: IoU ≈ 0.985, area ratio
    // = 1.0, identical aspect ratio, neither rect contains the other. Models
    // anti-aliased capture jitter where the same panel border fragments
    // differently between captures. Exactly one must survive.
    const hierarchy = buildObjectHierarchy([
      { objectId: 'a', bbox: rect(100, 100, 400, 200), confidence: 0.8 },
      { objectId: 'b', bbox: rect(101, 101, 400, 200), confidence: 0.8 }
    ]);

    expect(hierarchy.objects).toHaveLength(1);
    // Equal areas → tiebreak by objectId, so 'a' wins.
    expect(hierarchy.objects[0].objectId).toBe('a');
  });

  it('trivial containment: outer 1-2 px bigger than inner collapses to one survivor (not parent/child)', () => {
    // (100, 100, 400, 200) vs (99, 99, 402, 202): outer strictly contains inner,
    // area ratio ≈ 0.97, IoU ≈ 0.97. Without the trivial-containment pre-pass,
    // sibling dedup never sees this pair (parent and child are not siblings)
    // and the overlay shows two near-identical stacked rects.
    const hierarchy = buildObjectHierarchy([
      { objectId: 'inner', bbox: rect(100, 100, 400, 200), confidence: 0.8 },
      { objectId: 'outer', bbox: rect(99, 99, 402, 202), confidence: 0.8 }
    ]);

    expect(hierarchy.objects).toHaveLength(1);
    // Equal confidence → larger area wins; 'outer' is larger.
    expect(hierarchy.objects[0].objectId).toBe('outer');
    // The survivor must not have an artificial parent/child link to the loser.
    expect(hierarchy.objects[0].parentObjectId).toBeNull();
    expect(hierarchy.objects[0].childObjectIds).toEqual([]);
  });

  it('genuine 3-deep nesting with area ratios ≪ 0.95 is preserved', () => {
    // Outer 1000×1000 black, magenta 400×120 inside (area ratio = 0.048),
    // blue 350×80 inside magenta (area ratio = 0.583). Both ratios fall below
    // 0.95 so trivial-containment dedup must not touch them.
    const hierarchy = buildObjectHierarchy([
      { objectId: 'black', bbox: rect(0, 0, 1000, 1000), confidence: 0.7 },
      { objectId: 'magenta', bbox: rect(100, 100, 400, 120), confidence: 0.8 },
      { objectId: 'blue', bbox: rect(120, 120, 350, 80), confidence: 0.8 }
    ]);

    expect(hierarchy.objects).toHaveLength(3);
    const black = hierarchy.objects.find((n) => n.objectId === 'black')!;
    const magenta = hierarchy.objects.find((n) => n.objectId === 'magenta')!;
    const blue = hierarchy.objects.find((n) => n.objectId === 'blue')!;

    expect(black.parentObjectId).toBeNull();
    expect(magenta.parentObjectId).toBe('black');
    expect(blue.parentObjectId).toBe('magenta');
  });

  it('same position, different size — NOT a duplicate, both survive in containment', () => {
    // (100, 100, 400, 200) vs (100, 100, 400, 100): IoU = 0.5, area ratio =
    // 0.5 → predicate is false → both survive. Smaller is contained in larger.
    const hierarchy = buildObjectHierarchy([
      { objectId: 'tall', bbox: rect(100, 100, 400, 200), confidence: 0.8 },
      { objectId: 'short', bbox: rect(100, 100, 400, 100), confidence: 0.8 }
    ]);

    const ids = hierarchy.objects.map((n) => n.objectId).sort();
    expect(ids).toEqual(['short', 'tall']);

    const tall = hierarchy.objects.find((n) => n.objectId === 'tall')!;
    const short = hierarchy.objects.find((n) => n.objectId === 'short')!;
    expect(tall.parentObjectId).toBeNull();
    expect(short.parentObjectId).toBe('tall');
    expect(tall.childObjectIds).toEqual(['short']);
  });
});
