import type { BoundingBox } from './geometry';

export interface StructuralRegion {
  id: string;
  kind: 'text-block' | 'table' | 'line-item' | 'header' | 'footer' | 'unknown';
  pageIndex: number;
  bbox: BoundingBox;
}

export interface StructuralModel {
  id: string;
  documentFingerprint: string;
  regions: StructuralRegion[];
  createdAtIso: string;
}
