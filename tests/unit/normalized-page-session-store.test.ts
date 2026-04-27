import { describe, expect, it } from 'vitest';

import type { NormalizedPage } from '../../src/core/contracts/normalized-page';
import {
  buildDocumentFingerprint,
  createNormalizedPageSessionStore,
  getNormalizedPageSessionStore
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

  it('produces identical fingerprints for the same input via the canonical helper', () => {
    const pages = [page(0, 1200, 1600), page(1, 1200, 1600)];

    const formula = buildDocumentFingerprint('doc.pdf', pages);

    expect(formula).toBe('surface:doc.pdf#0:1200x1600|1:1200x1600');
  });

  it('shares the canonical fingerprint formula across the config and run session partitions', async () => {
    const configStore = getNormalizedPageSessionStore('config');
    const runStore = getNormalizedPageSessionStore('run');
    expect(configStore).not.toBe(runStore);

    const pages = [page(0, 1200, 1600)];

    await configStore.setNormalizedDocument({ sourceName: 'shared.pdf', pages });
    await runStore.setNormalizedDocument({ sourceName: 'shared.pdf', pages });

    expect(configStore.getSnapshot().documentFingerprint).toBe(
      buildDocumentFingerprint('shared.pdf', pages)
    );
    expect(runStore.getSnapshot().documentFingerprint).toBe(
      configStore.getSnapshot().documentFingerprint
    );

    // Sessions are isolated even though the formula is shared: clearing one
    // does not clear the other.
    await configStore.clearSession();
    expect(configStore.getSnapshot().pages).toEqual([]);
    expect(runStore.getSnapshot().pages).toHaveLength(1);

    await runStore.clearSession();
  });

  it('returns the same singleton for repeated calls with the same mode', () => {
    expect(getNormalizedPageSessionStore('config')).toBe(getNormalizedPageSessionStore('config'));
    expect(getNormalizedPageSessionStore('run')).toBe(getNormalizedPageSessionStore('run'));
    expect(getNormalizedPageSessionStore()).toBe(getNormalizedPageSessionStore('config'));
  });
});
