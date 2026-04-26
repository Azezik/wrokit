import type { GeometryFile } from '../../contracts/geometry';
import type { NormalizedPage } from '../../contracts/normalized-page';
import type {
  StructuralModel,
  StructuralRefinedBorderSource
} from '../../contracts/structural-model';
import type { Engine } from '../engine';

export interface StructuralEngineInput {
  pages: NormalizedPage[];
  /**
   * Optional human-confirmed geometry. When present, every saved BBOX on a page
   * MUST be contained by that page's refined border. Geometry is authoritative
   * truth; the structural engine never narrows it.
   */
  geometry?: GeometryFile | null;
  /**
   * Document fingerprint from the canonical NormalizedPage session authority.
   * Stored on the resulting StructuralModel so consumers can confirm that
   * structural data was generated against the same NormalizedPage surface set
   * that Geometry was captured against.
   */
  documentFingerprint: string;
  /**
   * Optional explicit page filter. When provided, the engine only emits
   * structural pages for the listed indices. Default: every input page.
   */
  pageIndexes?: number[];
  id?: string;
  nowIso?: string;
}

export interface StructuralEngine extends Engine<StructuralEngineInput, StructuralModel> {}

export type RefinedBorderSource = StructuralRefinedBorderSource;
