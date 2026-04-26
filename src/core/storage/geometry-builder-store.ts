import type {
  FieldGeometry,
  GeometryFile,
  NormalizedBoundingBox,
  PageSurfaceRef,
  PixelBoundingBox
} from '../contracts/geometry';
import type { ObservableStore, StoreListener } from './observable-store';

export interface GeometryBuilderField {
  fieldId: string;
  pageIndex: number;
  bbox: NormalizedBoundingBox;
  pixelBbox: PixelBoundingBox;
  pageSurface: PageSurfaceRef;
  confirmedAtIso: string;
  confirmedBy: string;
}

export interface GeometryBuilderState {
  wizardId: string;
  documentFingerprint: string;
  geometryId: string;
  fields: GeometryBuilderField[];
  metadata?: Record<string, string>;
}

export interface UpsertFieldInput {
  fieldId: string;
  pageIndex: number;
  bbox: NormalizedBoundingBox;
  pixelBbox: PixelBoundingBox;
  pageSurface: PageSurfaceRef;
  confirmedBy?: string;
  nowIso?: string;
}

export interface GeometryBuilderStore extends ObservableStore<GeometryBuilderState> {
  setWizardId(wizardId: string): Promise<void>;
  setDocumentFingerprint(fingerprint: string): Promise<void>;
  upsertField(field: UpsertFieldInput): Promise<void>;
  removeField(fieldId: string): Promise<void>;
  reset(next?: Partial<GeometryBuilderState>): Promise<void>;
  loadFromGeometryFile(file: GeometryFile): Promise<void>;
  toGeometryFile(): GeometryFile;
}

const generateId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `geo_${crypto.randomUUID()}`;
  }
  return `geo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const fieldFromGeometry = (field: FieldGeometry): GeometryBuilderField => ({
  fieldId: field.fieldId,
  pageIndex: field.pageIndex,
  bbox: field.bbox,
  pixelBbox: field.pixelBbox,
  pageSurface: field.pageSurface,
  confirmedAtIso: field.confirmedAtIso,
  confirmedBy: field.confirmedBy
});

const builderFieldToContract = (field: GeometryBuilderField): FieldGeometry => ({
  fieldId: field.fieldId,
  pageIndex: field.pageIndex,
  bbox: field.bbox,
  pixelBbox: field.pixelBbox,
  pageSurface: field.pageSurface,
  confirmedAtIso: field.confirmedAtIso,
  confirmedBy: field.confirmedBy
});

const initialState = (initial?: Partial<GeometryBuilderState>): GeometryBuilderState => ({
  wizardId: initial?.wizardId ?? '',
  documentFingerprint: initial?.documentFingerprint ?? '',
  geometryId: initial?.geometryId ?? generateId(),
  fields: initial?.fields ?? [],
  metadata: initial?.metadata
});

export const createGeometryBuilderStore = (
  initial?: Partial<GeometryBuilderState>
): GeometryBuilderStore => {
  let state: GeometryBuilderState = initialState(initial);
  const listeners = new Set<StoreListener>();

  const commit = (next: GeometryBuilderState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setWizardId: async (wizardId) => {
      commit({ ...state, wizardId });
    },

    setDocumentFingerprint: async (documentFingerprint) => {
      commit({ ...state, documentFingerprint });
    },

    upsertField: async (input) => {
      const nowIso = input.nowIso ?? new Date().toISOString();
      const next: GeometryBuilderField = {
        fieldId: input.fieldId,
        pageIndex: input.pageIndex,
        bbox: input.bbox,
        pixelBbox: input.pixelBbox,
        pageSurface: input.pageSurface,
        confirmedAtIso: nowIso,
        confirmedBy: input.confirmedBy ?? 'user'
      };
      const existingIndex = state.fields.findIndex((field) => field.fieldId === input.fieldId);
      const fields =
        existingIndex >= 0
          ? state.fields.map((field, index) => (index === existingIndex ? next : field))
          : [...state.fields, next];
      commit({ ...state, fields });
    },

    removeField: async (fieldId) => {
      commit({ ...state, fields: state.fields.filter((field) => field.fieldId !== fieldId) });
    },

    reset: async (next) => {
      commit(initialState(next));
    },

    loadFromGeometryFile: async (file) => {
      commit({
        wizardId: file.wizardId,
        documentFingerprint: file.documentFingerprint,
        geometryId: file.id,
        fields: file.fields.map(fieldFromGeometry),
        metadata: file.metadata
      });
    },

    toGeometryFile: () => {
      const file: GeometryFile = {
        schema: 'wrokit/geometry-file',
        version: '1.1',
        geometryFileVersion: 'wrokit/geometry/v1',
        id: state.geometryId,
        wizardId: state.wizardId,
        documentFingerprint: state.documentFingerprint,
        fields: state.fields.map(builderFieldToContract)
      };
      if (state.metadata) {
        file.metadata = state.metadata;
      }
      return file;
    }
  };
};
