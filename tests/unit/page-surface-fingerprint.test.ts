import { describe, expect, it } from 'vitest';

import type { NormalizedPage } from '../../src/core/contracts/normalized-page';
import { buildDocumentFingerprint } from '../../src/core/page-surface/page-surface-fingerprint';
import { createNormalizedPageSessionStore } from '../../src/core/storage/normalized-page-session-store';

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

describe('buildDocumentFingerprint', () => {
  it('emits a stable surface signature including index, width, and height per page', () => {
    const fingerprint = buildDocumentFingerprint({
      sourceName: 'invoice.pdf',
      pages: [page(0, 1200, 1600), page(1, 1200, 1600)]
    });

    expect(fingerprint).toBe('surface:invoice.pdf#0:1200x1600|1:1200x1600');
  });

  it('rounds non-integer pixel dimensions to whole pixels', () => {
    const fingerprint = buildDocumentFingerprint({
      sourceName: 'scan.png',
      pages: [page(0, 1199.4, 1599.7)]
    });

    expect(fingerprint).toBe('surface:scan.png#0:1199x1600');
  });

  it('produces the same fingerprint as the per-stage session store for the same input', async () => {
    const sourceName = 'shared.pdf';
    const pages = [page(0, 800, 1200)];
    const helperFingerprint = buildDocumentFingerprint({ sourceName, pages });

    const store = createNormalizedPageSessionStore();
    await store.setNormalizedDocument({ sourceName, pages });

    expect(store.getSnapshot().documentFingerprint).toBe(helperFingerprint);
  });

  it('two independent stages computing the same fingerprint do not share state', async () => {
    const configStore = createNormalizedPageSessionStore();
    const runtimeStore = createNormalizedPageSessionStore();
    const sourceName = 'same-template.pdf';
    const pages = [page(0, 1024, 1448)];

    await configStore.setNormalizedDocument({ sourceName, pages });
    await runtimeStore.setNormalizedDocument({ sourceName, pages });

    expect(configStore.getSnapshot().documentFingerprint).toBe(
      runtimeStore.getSnapshot().documentFingerprint
    );
    expect(configStore.getSnapshot().sessionId).not.toBe(
      runtimeStore.getSnapshot().sessionId
    );
  });
});
