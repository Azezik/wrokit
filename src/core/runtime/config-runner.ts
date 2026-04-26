import type { GeometryFile } from '../contracts/geometry';
import type { NormalizedPage } from '../contracts/normalized-page';
import type { WizardFile } from '../contracts/wizard';
import {
  buildGeometryFile,
  validateGeometryFile,
  type GeometryFieldDraft,
  type GeometryValidationResult
} from '../engines/geometry';

export interface ConfigRunnerCommitInput {
  wizard: WizardFile;
  pages: NormalizedPage[];
  drafts: GeometryFieldDraft[];
  geometryId?: string;
  documentFingerprint: string;
  metadata?: Record<string, string>;
  tolerateUnknownFieldIds?: boolean;
  nowIso?: string;
}

export interface ConfigRunnerCommitOutput {
  geometry: GeometryFile;
  validation: GeometryValidationResult;
}

export interface ConfigRunner {
  buildAndValidate(input: ConfigRunnerCommitInput): ConfigRunnerCommitOutput;
  validateExisting(
    geometry: GeometryFile,
    wizard: WizardFile,
    pages: NormalizedPage[],
    options?: { tolerateUnknownFieldIds?: boolean }
  ): GeometryValidationResult;
}

export const createConfigRunner = (): ConfigRunner => ({
  buildAndValidate: (input) => {
    const geometry = buildGeometryFile({
      id: input.geometryId,
      wizardId: input.wizard.wizardName,
      documentFingerprint: input.documentFingerprint,
      fields: input.drafts,
      metadata: input.metadata,
      nowIso: input.nowIso
    });

    const validation = validateGeometryFile(geometry, {
      wizard: input.wizard,
      pages: input.pages,
      tolerateUnknownFieldIds: input.tolerateUnknownFieldIds
    });

    return { geometry, validation };
  },

  validateExisting: (geometry, wizard, pages, options) =>
    validateGeometryFile(geometry, {
      wizard,
      pages,
      tolerateUnknownFieldIds: options?.tolerateUnknownFieldIds
    })
});
