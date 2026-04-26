import type { GeometryFile } from '../../contracts/geometry';

import { isNormalizedRectInBounds } from '../../page-surface/page-surface';
import type {
  GeometryValidationContext,
  GeometryValidationIssue,
  GeometryValidationResult
} from './types';

const SURFACE_TOLERANCE = 1; // pixel rounding tolerance

export const validateGeometryFile = (
  geometry: GeometryFile,
  context: GeometryValidationContext
): GeometryValidationResult => {
  const issues: GeometryValidationIssue[] = [];
  const wizardFieldIds = new Set(context.wizard.fields.map((field) => field.fieldId));
  const requiredFieldIds = new Set(
    context.wizard.fields.filter((field) => field.required).map((field) => field.fieldId)
  );

  const expectedWizardId = context.wizard.wizardName;
  if (expectedWizardId && geometry.wizardId !== expectedWizardId) {
    issues.push({
      code: 'wizard-id-mismatch',
      message: `GeometryFile.wizardId "${geometry.wizardId}" does not match WizardFile "${expectedWizardId}".`
    });
  }

  const presentFieldIds = new Set<string>();

  for (const field of geometry.fields) {
    presentFieldIds.add(field.fieldId);

    if (!wizardFieldIds.has(field.fieldId) && !context.tolerateUnknownFieldIds) {
      issues.push({
        code: 'unknown-field-id',
        message: `Field "${field.fieldId}" is not declared in the WizardFile.`,
        fieldId: field.fieldId
      });
    }

    const page = context.pages.find((candidate) => candidate.pageIndex === field.pageIndex);
    if (!page) {
      issues.push({
        code: 'invalid-page-index',
        message: `Field "${field.fieldId}" references missing pageIndex ${field.pageIndex}.`,
        fieldId: field.fieldId,
        pageIndex: field.pageIndex
      });
      continue;
    }

    if (
      Math.abs(page.width - field.pageSurface.surfaceWidth) > SURFACE_TOLERANCE ||
      Math.abs(page.height - field.pageSurface.surfaceHeight) > SURFACE_TOLERANCE ||
      page.pageIndex !== field.pageSurface.pageIndex
    ) {
      issues.push({
        code: 'page-surface-mismatch',
        message: `Field "${field.fieldId}" pageSurface does not match the loaded NormalizedPage authority.`,
        fieldId: field.fieldId,
        pageIndex: field.pageIndex
      });
    }

    if (
      !Number.isFinite(field.bbox.xNorm) ||
      !Number.isFinite(field.bbox.yNorm) ||
      !Number.isFinite(field.bbox.wNorm) ||
      !Number.isFinite(field.bbox.hNorm)
    ) {
      issues.push({
        code: 'invalid-normalized-coordinates',
        message: `Field "${field.fieldId}" has non-finite normalized coordinates.`,
        fieldId: field.fieldId
      });
      continue;
    }

    if (!isNormalizedRectInBounds(field.bbox)) {
      issues.push({
        code: 'out-of-bounds-coordinates',
        message: `Field "${field.fieldId}" coordinates fall outside the canonical [0,1] page bounds.`,
        fieldId: field.fieldId,
        pageIndex: field.pageIndex
      });
    }
  }

  for (const requiredId of requiredFieldIds) {
    if (!presentFieldIds.has(requiredId)) {
      issues.push({
        code: 'missing-required-field',
        message: `Required wizard field "${requiredId}" has no geometry confirmed.`,
        fieldId: requiredId
      });
    }
  }

  return { ok: issues.length === 0, issues };
};
