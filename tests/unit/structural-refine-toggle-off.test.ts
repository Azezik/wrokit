/**
 * Toggle-off regression: when refineEnabled is false (or absent), the batch
 * coordinator output must be structurally identical to a pre-wiring baseline.
 * In particular, `refineOutputs` must be absent and the MasterDb table must
 * contain exactly the wizard-defined columns.
 *
 * We use an empty files array so the coordinator never touches CV libraries;
 * only the pure MasterDB engine runs.
 */
import { describe, expect, it } from 'vitest';

import { isMasterDbTable } from '../../src/core/contracts/masterdb-table';
import type { WizardFile } from '../../src/core/contracts/wizard';
import { createBatchCoordinator } from '../../src/features/polished-wizard/batch-coordinator/batch-coordinator';

const wizard: WizardFile = {
  schema: 'wrokit/wizard-file',
  version: '1.0',
  wizardName: 'Toggle Off Test Wizard',
  fields: [
    { fieldId: 'invoice_number', label: 'Invoice #', type: 'text', required: true },
    { fieldId: 'total', label: 'Total', type: 'numeric', required: false }
  ]
};

const configStructuralModel = {
  schema: 'wrokit/structural-model' as const,
  version: '4.0' as const,
  structureVersion: 'wrokit/structure/v3' as const,
  id: 'sm_1',
  documentFingerprint: 'sha256:config',
  cvAdapter: { name: 'opencv-js', version: '1.0' },
  pages: [],
  createdAtIso: '2026-01-01T00:00:00Z'
};

const configGeometry = {
  schema: 'wrokit/geometry-file' as const,
  version: '1.1' as const,
  geometryFileVersion: 'wrokit/geometry/v1' as const,
  id: 'geo_1',
  wizardId: 'Toggle Off Test Wizard',
  documentFingerprint: 'sha256:config',
  fields: []
};

describe('structural-refine toggle-off', () => {
  it('produces a valid MasterDb table with 0 files and no refineEnabled', async () => {
    const coordinator = createBatchCoordinator();
    const result = await coordinator.run({
      wizard,
      configGeometry,
      configStructuralModel,
      files: []
    });
    expect(isMasterDbTable(result.table)).toBe(true);
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
    expect(result.failures).toHaveLength(0);
    expect(result.refineOutputs).toBeUndefined();
  });

  it('produces an identical result with refineEnabled: false', async () => {
    const coordinator = createBatchCoordinator();
    const baseline = await coordinator.run({
      wizard,
      configGeometry,
      configStructuralModel,
      files: []
    });
    const withToggleOff = await coordinator.run({
      wizard,
      configGeometry,
      configStructuralModel,
      files: [],
      refineEnabled: false
    });

    // Core MasterDb table structure must be identical.
    expect(JSON.stringify(withToggleOff.table)).toBe(JSON.stringify(baseline.table));
    expect(withToggleOff.successCount).toBe(baseline.successCount);
    expect(withToggleOff.failureCount).toBe(baseline.failureCount);
    expect(withToggleOff.refineOutputs).toBeUndefined();
  });

  it('does not surface refineOutputs when refineEnabled is false even with priorAnalytics set', async () => {
    const coordinator = createBatchCoordinator();
    const result = await coordinator.run({
      wizard,
      configGeometry,
      configStructuralModel,
      files: [],
      refineEnabled: false,
      // Setting a prior here to ensure it's ignored
      priorAnalytics: null
    });
    expect(result.refineOutputs).toBeUndefined();
  });

  it('emits a done progress event with 0 files and toggle off', async () => {
    const coordinator = createBatchCoordinator();
    const phases: string[] = [];
    await coordinator.run({
      wizard,
      configGeometry,
      configStructuralModel,
      files: [],
      refineEnabled: false,
      onProgress: (p) => phases.push(p.phase)
    });
    expect(phases).toContain('done');
    expect(phases).not.toContain('refining');
  });

  it('emits a refining progress event when refineEnabled is true', async () => {
    const coordinator = createBatchCoordinator();
    const phases: string[] = [];
    await coordinator.run({
      wizard,
      configGeometry,
      configStructuralModel,
      files: [],
      refineEnabled: true,
      onProgress: (p) => phases.push(p.phase)
    });
    expect(phases).toContain('done');
    // refining is emitted before the done when refineEnabled is true
    // (done is re-emitted from the post-loop progress call before refining;
    // then refining is emitted during finalize)
    expect(phases).toContain('refining');
  });
});
