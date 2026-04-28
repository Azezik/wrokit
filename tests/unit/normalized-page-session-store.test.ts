import { describe, expect, it } from 'vitest';

import type { NormalizedPage } from '../../src/core/contracts/normalized-page';
import {
  buildDocumentFingerprint,
  createNormalizedPageSessionStore
} from '../../src/core/storage/normalized-page-session-store';

const page = (index: number, width: number, height: number): NormalizedPage => ({
  schema: 'wrokit/normalized-page',
  version: '2.0',
  pageIndex: index,
  width,
  height,
  aspectRatio: width / height,
  imageDataUrl: `data:image/png;base64,page-${index}`,
  sourceName: 'doc.pdf',
  normalization: {
    normalizedAtIso: '2026-04-26T00:00:00.000Z',
    boundary: 'intake-raster-only',
    pipelineVersion: '1.0'
  }
});

describe('normalized-page-session-store', () => {
  it('owns normalized pages and selects the first page by default when a document is loaded', async () => {
    const store = createNormalizedPageSessionStore();
    await store.setNormalizedDocument({
      sourceName: 'sample.pdf',
      pages: [page(0, 1200, 1600), page(1, 1200, 1600)]
    });

    const snapshot = store.getSnapshot();

    expect(snapshot.sourceName).toBe('sample.pdf');
    expect(snapshot.pages).toHaveLength(2);
    expect(snapshot.selectedPageIndex).toBe(0);
    expect(snapshot.documentFingerprint).toContain('surface:sample.pdf#');
  });

  it('ignores selection updates for missing pages', async () => {
    const store = createNormalizedPageSessionStore();
    await store.setNormalizedDocument({
      sourceName: 'sample.pdf',
      pages: [page(0, 1200, 1600), page(1, 1200, 1600)]
    });

    await store.selectPage(1);
    expect(store.getSnapshot().selectedPageIndex).toBe(1);

    await store.selectPage(999);
    expect(store.getSnapshot().selectedPageIndex).toBe(1);
  });

  it('exposes a single canonical fingerprint formula reused by every page-aware feature', async () => {
    // Both Config Capture and Run Mode write into this store via
    // setNormalizedDocument. The test proves the fingerprint that lands in
    // the snapshot equals the fingerprint produced by the exported pure
    // helper for the same input — i.e. there is one formula, not two.
    const store = createNormalizedPageSessionStore();
    const sourceName = 'runtime-doc.pdf';
    const pages = [page(0, 1240, 1755), page(1, 1240, 1755)];

    await store.setNormalizedDocument({ sourceName, pages });

    const expected = buildDocumentFingerprint(sourceName, pages);

    expect(expected).toBe('surface:runtime-doc.pdf#0:1240x1755|1:1240x1755');
    expect(store.getSnapshot().documentFingerprint).toBe(expected);
  });

  it('resets session identity and clears page authority', async () => {
    const store = createNormalizedPageSessionStore();
    const initialSessionId = store.getSnapshot().sessionId;

    await store.setNormalizedDocument({
      sourceName: 'sample.pdf',
      pages: [page(0, 1200, 1600)]
    });

    const loadedSessionId = store.getSnapshot().sessionId;
    expect(loadedSessionId).not.toBe(initialSessionId);

    await store.clearSession();

    const cleared = store.getSnapshot();
    expect(cleared.pages).toEqual([]);
    expect(cleared.sourceName).toBe('');
    expect(cleared.documentFingerprint).toBe('');
    expect(cleared.selectedPageIndex).toBe(0);
    expect(cleared.sessionId).not.toBe(loadedSessionId);
  });
});
