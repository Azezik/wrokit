import type { Engine } from '../engine';
import type { GeometryFile, FieldGeometry } from '../../contracts/geometry';

import type { BuildGeometryFileInput } from './types';

const generateId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `geo_${crypto.randomUUID()}`;
  }
  return `geo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const draftToField = (
  draft: BuildGeometryFileInput['fields'][number],
  nowIso: string
): FieldGeometry => ({
  fieldId: draft.fieldId,
  pageIndex: draft.pageIndex,
  bbox: draft.bbox,
  pixelBbox: draft.pixelBbox,
  pageSurface: draft.pageSurface,
  confirmedAtIso: nowIso,
  confirmedBy: draft.confirmedBy ?? 'user'
});

export const buildGeometryFile = (input: BuildGeometryFileInput): GeometryFile => {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const file: GeometryFile = {
    schema: 'wrokit/geometry-file',
    version: '1.1',
    geometryFileVersion: 'wrokit/geometry/v1',
    id: input.id ?? generateId(),
    wizardId: input.wizardId,
    documentFingerprint: input.documentFingerprint,
    fields: input.fields.map((draft) => draftToField(draft, nowIso))
  };
  if (input.metadata) {
    file.metadata = input.metadata;
  }
  return file;
};

export interface GeometryEngineInput extends BuildGeometryFileInput {}

export const createGeometryEngine = (): Engine<GeometryEngineInput, GeometryFile> => ({
  name: 'geometry-engine',
  version: '1.0',
  run: async (input) => buildGeometryFile(input)
});
