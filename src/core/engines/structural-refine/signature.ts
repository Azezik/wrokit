/**
 * Refine compatibility signature.
 *
 * Builds a deterministic SHA-256-based fingerprint of the (wizard, geometry,
 * config structural model) trio that an analytics file was produced under.
 * Two analytics files merge cleanly only when the relevant signature parts
 * match — see `mergeAnalytics` in `./merge-analytics.ts`.
 *
 * All hashes use `crypto.subtle.digest('SHA-256', ...)` which is available
 * both in modern browsers and in Node 18+ via `globalThis.crypto`.
 */
import type { GeometryFile } from '../../contracts/geometry';
import type {
  RefineCompatibilitySignature
} from '../../contracts/structural-refine-analytics';
import type { StructuralModel } from '../../contracts/structural-model';
import type { WizardFile } from '../../contracts/wizard';

const REFINED_BORDER_ROUND_DECIMALS = 6;

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * JSON.stringify with deterministically-sorted object keys at every depth.
 * Pure helper — no Date / Set / Map handling because we only canonicalize
 * plain JSON values.
 */
export const canonicalJsonStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((entry) => canonicalJsonStringify(entry));
    return `[${parts.join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`);
  return `{${entries.join(',')}}`;
};

const getSubtle = (): SubtleCrypto => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('crypto.subtle is unavailable; SHA-256 hashing requires a secure context.');
  }
  return subtle;
};

const bytesToHex = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
};

const sha256Hex = async (text: string): Promise<string> => {
  const subtle = getSubtle();
  const encoder = new TextEncoder();
  const digest = await subtle.digest('SHA-256', encoder.encode(text));
  return bytesToHex(digest);
};

const wizardFieldSignaturePayload = (wizard: WizardFile): unknown => {
  return [...wizard.fields]
    .map((field) => ({
      fieldId: field.fieldId,
      label: field.label,
      type: field.type,
      required: field.required
    }))
    .sort((a, b) => a.fieldId.localeCompare(b.fieldId));
};

const configObjectIdsAcrossPages = (config: StructuralModel): string[] => {
  const ids: string[] = [];
  for (const page of config.pages) {
    for (const object of page.objectHierarchy.objects) {
      ids.push(object.objectId);
    }
  }
  return ids.sort((a, b) => a.localeCompare(b));
};

const configRefinedBorderPayload = (config: StructuralModel): unknown => {
  return [...config.pages]
    .map((page) => ({
      pageIndex: page.pageIndex,
      rectNorm: {
        xNorm: round(page.refinedBorder.rectNorm.xNorm, REFINED_BORDER_ROUND_DECIMALS),
        yNorm: round(page.refinedBorder.rectNorm.yNorm, REFINED_BORDER_ROUND_DECIMALS),
        wNorm: round(page.refinedBorder.rectNorm.wNorm, REFINED_BORDER_ROUND_DECIMALS),
        hNorm: round(page.refinedBorder.rectNorm.hNorm, REFINED_BORDER_ROUND_DECIMALS)
      },
      cvContentRectNorm: {
        xNorm: round(page.refinedBorder.cvContentRectNorm.xNorm, REFINED_BORDER_ROUND_DECIMALS),
        yNorm: round(page.refinedBorder.cvContentRectNorm.yNorm, REFINED_BORDER_ROUND_DECIMALS),
        wNorm: round(page.refinedBorder.cvContentRectNorm.wNorm, REFINED_BORDER_ROUND_DECIMALS),
        hNorm: round(page.refinedBorder.cvContentRectNorm.hNorm, REFINED_BORDER_ROUND_DECIMALS)
      }
    }))
    .sort((a, b) => a.pageIndex - b.pageIndex);
};

const pageSurfaceSignaturePayload = (config: StructuralModel) => {
  return [...config.pages]
    .map((page) => ({
      pageIndex: page.pageSurface.pageIndex,
      surfaceWidth: page.pageSurface.surfaceWidth,
      surfaceHeight: page.pageSurface.surfaceHeight
    }))
    .sort((a, b) => a.pageIndex - b.pageIndex);
};

const geometryFieldIdsSorted = (geometry: GeometryFile): string[] =>
  geometry.fields.map((field) => field.fieldId).sort((a, b) => a.localeCompare(b));

export interface BuildRefineCompatibilitySignatureInput {
  wizard: WizardFile;
  geometry: GeometryFile;
  configStructural: StructuralModel;
  /**
   * Optional override for the signature's `createdAtIso` timestamp. Tests use
   * this to keep signatures byte-stable across runs; production callers can
   * leave it unset and the helper will stamp `new Date().toISOString()`.
   */
  nowIso?: string;
}

export const buildRefineCompatibilitySignature = async (
  input: BuildRefineCompatibilitySignatureInput
): Promise<RefineCompatibilitySignature> => {
  const wizardFieldSignature = await sha256Hex(
    canonicalJsonStringify(wizardFieldSignaturePayload(input.wizard))
  );
  const configStructuralObjectIdSignature = await sha256Hex(
    canonicalJsonStringify(configObjectIdsAcrossPages(input.configStructural))
  );
  const configRefinedBorderSignature = await sha256Hex(
    canonicalJsonStringify(configRefinedBorderPayload(input.configStructural))
  );
  const geometryFieldIdSignature = await sha256Hex(
    canonicalJsonStringify(geometryFieldIdsSorted(input.geometry))
  );

  return {
    wizardName: input.wizard.wizardName,
    wizardFieldCount: input.wizard.fields.length,
    wizardFieldSignature,
    configStructuralPageCount: input.configStructural.pages.length,
    configStructuralObjectIdSignature,
    configRefinedBorderSignature,
    pageSurfaceSignatures: pageSurfaceSignaturePayload(input.configStructural),
    geometryFieldIdSignature,
    createdAtIso: input.nowIso ?? new Date().toISOString()
  };
};

/**
 * Practical-not-strict compatibility check. Two signatures are compatible
 * when the wizard fields match, the config object id set matches, and the
 * page surfaces match. `wizardName`, `createdAtIso`, and the rounded
 * refined-border rects can drift between runs (cosmetic / numerical) without
 * blocking a merge.
 */
export const areRefineSignaturesCompatible = (
  a: RefineCompatibilitySignature,
  b: RefineCompatibilitySignature
): boolean => {
  if (a.wizardFieldSignature !== b.wizardFieldSignature) {
    return false;
  }
  if (a.wizardFieldCount !== b.wizardFieldCount) {
    return false;
  }
  if (a.configStructuralObjectIdSignature !== b.configStructuralObjectIdSignature) {
    return false;
  }
  if (a.configStructuralPageCount !== b.configStructuralPageCount) {
    return false;
  }
  if (a.geometryFieldIdSignature !== b.geometryFieldIdSignature) {
    return false;
  }
  if (a.pageSurfaceSignatures.length !== b.pageSurfaceSignatures.length) {
    return false;
  }
  for (let i = 0; i < a.pageSurfaceSignatures.length; i += 1) {
    const left = a.pageSurfaceSignatures[i];
    const right = b.pageSurfaceSignatures[i];
    if (
      left.pageIndex !== right.pageIndex ||
      left.surfaceWidth !== right.surfaceWidth ||
      left.surfaceHeight !== right.surfaceHeight
    ) {
      return false;
    }
  }
  return true;
};
