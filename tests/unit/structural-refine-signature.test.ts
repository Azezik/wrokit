import { describe, expect, it } from 'vitest';

import {
  areRefineSignaturesCompatible,
  buildRefineCompatibilitySignature,
  canonicalJsonStringify
} from '../../src/core/engines/structural-refine';
import {
  configStructuralFixture,
  geometryFixture,
  wizardFixture
} from './structural-refine-fixtures';

describe('canonicalJsonStringify', () => {
  it('sorts object keys deterministically at every depth', () => {
    const a = canonicalJsonStringify({ b: 1, a: { d: [3, { f: 6, e: 5 }], c: 2 } });
    const b = canonicalJsonStringify({ a: { c: 2, d: [3, { e: 5, f: 6 }] }, b: 1 });
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('buildRefineCompatibilitySignature', () => {
  it('produces a stable signature for the same inputs', async () => {
    const wizard = wizardFixture();
    const geometry = geometryFixture();
    const config = configStructuralFixture();
    const a = await buildRefineCompatibilitySignature({
      wizard,
      geometry,
      configStructural: config,
      nowIso: '2026-04-01T00:00:00Z'
    });
    const b = await buildRefineCompatibilitySignature({
      wizard,
      geometry,
      configStructural: config,
      nowIso: '2026-04-01T00:00:00Z'
    });
    expect(a).toEqual(b);
    expect(a.wizardFieldSignature).toMatch(/^[0-9a-f]{64}$/);
    expect(a.configStructuralObjectIdSignature).toMatch(/^[0-9a-f]{64}$/);
    expect(a.geometryFieldIdSignature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the wizard signature when fields change', async () => {
    const config = configStructuralFixture();
    const geometry = geometryFixture();
    const a = await buildRefineCompatibilitySignature({
      wizard: wizardFixture(),
      geometry,
      configStructural: config
    });
    const altered = wizardFixture();
    altered.fields[0].label = 'Renamed';
    const b = await buildRefineCompatibilitySignature({
      wizard: altered,
      geometry,
      configStructural: config
    });
    expect(a.wizardFieldSignature).not.toBe(b.wizardFieldSignature);
  });

  it('is stable under wizard field reordering (sorted by fieldId)', async () => {
    const config = configStructuralFixture();
    const geometry = geometryFixture();
    const original = wizardFixture();
    const reordered = {
      ...original,
      fields: [...original.fields].reverse()
    };
    const a = await buildRefineCompatibilitySignature({
      wizard: original,
      geometry,
      configStructural: config
    });
    const b = await buildRefineCompatibilitySignature({
      wizard: reordered,
      geometry,
      configStructural: config
    });
    expect(a.wizardFieldSignature).toBe(b.wizardFieldSignature);
  });
});

describe('areRefineSignaturesCompatible', () => {
  it('accepts two signatures from identical inputs', async () => {
    const config = configStructuralFixture();
    const geometry = geometryFixture();
    const wizard = wizardFixture();
    const a = await buildRefineCompatibilitySignature({ wizard, geometry, configStructural: config });
    const b = await buildRefineCompatibilitySignature({ wizard, geometry, configStructural: config });
    expect(areRefineSignaturesCompatible(a, b)).toBe(true);
  });

  it('rejects mismatched wizard fields', async () => {
    const config = configStructuralFixture();
    const geometry = geometryFixture();
    const a = await buildRefineCompatibilitySignature({
      wizard: wizardFixture(),
      geometry,
      configStructural: config
    });
    const altered = wizardFixture();
    altered.fields.pop();
    const b = await buildRefineCompatibilitySignature({
      wizard: altered,
      geometry,
      configStructural: config
    });
    expect(areRefineSignaturesCompatible(a, b)).toBe(false);
  });

  it('rejects mismatched config object id sets', async () => {
    const wizard = wizardFixture();
    const geometry = geometryFixture();
    const a = await buildRefineCompatibilitySignature({
      wizard,
      geometry,
      configStructural: configStructuralFixture()
    });
    const altered = configStructuralFixture();
    altered.pages[0].objectHierarchy.objects[0].objectId = 'obj_new';
    const b = await buildRefineCompatibilitySignature({
      wizard,
      geometry,
      configStructural: altered
    });
    expect(areRefineSignaturesCompatible(a, b)).toBe(false);
  });

  it('rejects mismatched page surface dimensions', async () => {
    const wizard = wizardFixture();
    const geometry = geometryFixture();
    const a = await buildRefineCompatibilitySignature({
      wizard,
      geometry,
      configStructural: configStructuralFixture()
    });
    const altered = configStructuralFixture();
    altered.pages[0].pageSurface.surfaceWidth = 1200;
    const b = await buildRefineCompatibilitySignature({
      wizard,
      geometry,
      configStructural: altered
    });
    expect(areRefineSignaturesCompatible(a, b)).toBe(false);
  });

  it('tolerates differences in createdAtIso (compatibility, not strict equality)', async () => {
    const wizard = wizardFixture();
    const geometry = geometryFixture();
    const config = configStructuralFixture();
    const a = await buildRefineCompatibilitySignature({
      wizard,
      geometry,
      configStructural: config,
      nowIso: '2026-01-01T00:00:00Z'
    });
    const b = await buildRefineCompatibilitySignature({
      wizard,
      geometry,
      configStructural: config,
      nowIso: '2026-12-31T23:59:59Z'
    });
    expect(a.createdAtIso).not.toBe(b.createdAtIso);
    expect(areRefineSignaturesCompatible(a, b)).toBe(true);
  });
});
