# Wrokit Architecture (Current State)

## Project Mission
Wrokit is a modular, human-in-the-loop file ingestion engine where developers define extraction intent and users confirm field geometry.

## Core Principles
- Human-confirmed BBOX geometry is the highest authority.
- Modules stay isolated and communicate via typed contracts.
- UI does not own engine logic.
- Static-hosting compatible, browser-first, no backend required.
- Intake is a one-way normalization boundary: downstream modules only consume `NormalizedPage` raster surfaces.

## Module Boundaries
- `src/core/contracts`: shared typed contracts. Each persisted contract carries `schema` + `version` and exports a runtime `is<Type>` guard.
- `src/core/io`: pure serialization / parsing / file-IO helpers (e.g. `wizard-file-io`, `geometry-file-io`). UI calls these; UI does not embed IO.
- `src/core/page-surface`: thin infrastructural orchestration layer that owns canonical NormalizedPage surface authority — page dimensions, display transforms, screen↔surface coordinate mapping, normalized↔surface conversions, and invariant checks. Every module that touches page geometry (Geometry capture, future Structural Engine, Localization, OCR readout, runtime overlays) consumes coordinates through this layer. It is infrastructure, not business logic.
- `src/core/storage`: UI-agnostic stores. All store mutators are async. All stores expose `subscribe(listener)` and `getSnapshot()` so React can attach via `useSyncExternalStore` and a future persistence adapter is a drop-in.
- `src/core/engines`: pure transforms. Every engine implements the canonical `Engine<TInput, TOutput>` from `src/core/engines/engine.ts`. Engines never compose other engines and never reach into UI or storage.
- `src/core/engines/normalization`: hard intake boundary. Accepts upload files and emits only `NormalizedPage[]`.
  - `image-rasterizer.ts`: image decode/raster path. Decodes via `createImageBitmap`, draws onto a fresh `HTMLCanvasElement`, and re-encodes via `canvas.toDataURL('image/png')`. The output PNG carries no source-format identity.
  - `pdf-rasterizer.ts`: **only allowed PDF.js usage**, and only for PDF page raster rendering. Imports `pdfjs-dist` directly from the bundled npm dependency, and resolves the PDF.js worker through Vite's `?url` import (`pdfjs-dist/build/pdf.worker.min.mjs?url`). The worker is emitted by Vite as a hashed asset under the configured `base` path, which keeps it working under GitHub Pages project-page routing. `GlobalWorkerOptions.workerSrc` is set once on first use and never mutated by callers.
  - `normalization-engine.ts`: routes input files to raster adapters by MIME type at the boundary, then immediately wraps each `RasterizedPageSurface` into a `NormalizedPage` via `toNormalizedPage`. Downstream modules cannot distinguish a PDF-sourced page from an image-sourced page.
- `src/core/engines/geometry`: pure Geometry module.
  - `geometry-engine.ts`: builds a `GeometryFile` from human-confirmed BBOX drafts. Implements `Engine<GeometryEngineInput, GeometryFile>`.
  - `validation.ts`: validates a `GeometryFile` against a `WizardFile` and `NormalizedPage[]`. All validation lives here — UI only renders the result.
  - Geometry stores normalized BBOX (`xNorm/yNorm/wNorm/hNorm`) as the canonical authority, plus a derived `pixelBbox` and a `pageSurface` reference (page dimensions and index) used to verify that geometry is interpreted on the same NormalizedPage surface a future engine will consume.
- `src/core/runtime`: the only place engines are composed. Runners exist as boundaries: `config-runner`, `extraction-runner`, `localization-runner`, `ocr-runner`, `confidence-runner`. Of these, only `config-runner` composes engines today (Geometry build + validation); the others are still stubs that throw `not implemented in foundation phase`.
- `src/core/ui/components`: reusable visual primitives (`Button`, `Input`, `Panel`, `Section`).
- `src/core/ui/layout`: app-wide layout wrappers (`AppShell`).
- `src/core/ui/styles`: centralized visual tokens + global base styles.
- `src/features/<feature>/ui`: feature-owned UI modules (`wizard-builder`, `normalization`, `config-capture`). Features import from `core/*`. `core/*` never imports from `features/*`.
- `src/app`: page composition and shell wiring only.

## Engines vs Runtime Rule
- An engine is a pure transform: one input contract, one output contract, no awareness of any other engine, no UI dependency, no store dependency.
- A runner is the *only* place engines are composed. If logic spans more than one engine, it lives in `src/core/runtime/`, not inside an engine module.
- This rule is what allows two agents to develop two engines in parallel without collision.

## Intake Normalization Boundary Rule
- Accepted intake types: PDF, PNG, JPG/JPEG, WebP.
- Intake conversion is one-way. Once normalized, downstream modules receive only `NormalizedPage[]`.
- Downstream modules must not inspect or branch on original MIME type, upload internals, PDF dimensions, PDF coordinates, text tokens, annotations, or metadata.
- `sourceName` in `NormalizedPage` is display-only and must not drive extraction logic.
- `pdfjs-dist` may be imported only inside `pdf-rasterizer.ts`. No other module — engine, runner, store, contract, UI, or app — may import or reference PDF.js directly.
- The PDF.js worker is loaded as a Vite static asset (`?url` import) so it inherits the deployed `base` path and continues to resolve correctly under static hosting (e.g. GitHub Pages project pages).

## Contract Versioning Rule
- Every persisted contract declares a literal `schema: 'wrokit/<name>'` and a semantic `version`.
- Every persisted contract exports an `is<Type>(value: unknown): value is <Type>` runtime guard.
- Current versions:
  - `WizardFile`: `1.0`
  - `NormalizedPage`: `2.0`
  - `GeometryFile`: `1.1` (also carries `geometryFileVersion: 'wrokit/geometry/v1'` for human-readable schema identity)
  - `StructuralModel`: `1.0`
  - `ExtractionResult`: `1.0`

## Store Pattern
- Stores are observable. Public surface: async mutators returning `Promise<void>`, `getSnapshot(): TSnapshot`, `subscribe(listener): () => void`.
- The base shape lives in `src/core/storage/observable-store.ts`.
- React consumers attach via `useSyncExternalStore(store.subscribe, store.getSnapshot)`.
- Current implementations are in-memory; persistence adapters can be substituted without changing consumers.

## UI Organization Rules
- Visual tokens (colors, spacing, borders, shadows, radii, font sizes) are defined in `src/core/ui/styles/tokens.css`.
- Global element defaults and shared classes live in `src/core/ui/styles/global.css`.
- Reusable UI primitives are imported by feature UIs; feature UIs do not redefine core styling systems.
- Feature-specific UI styling lives beside each feature (e.g., `src/features/wizard-builder/ui/wizard-builder.css`, `src/features/normalization/ui/normalization-intake.css`).
- Business logic stays in stores/contracts/io/engines and is consumed by UI through typed interfaces.

## Data Contracts
- `WizardFile` (`src/core/contracts/wizard.ts`): `schema: 'wrokit/wizard-file'`, `version: '1.0'`. Guard: `isWizardFile`.
- `NormalizedPage` (`src/core/contracts/normalized-page.ts`): `schema: 'wrokit/normalized-page'`, `version: '2.0'`, includes pixel width/height/aspect ratio and raster image URL surface data, plus display-only `sourceName`. Guard: `isNormalizedPage`.
- `GeometryFile` (`src/core/contracts/geometry.ts`): `schema: 'wrokit/geometry-file'`, `version: '1.1'`, `geometryFileVersion: 'wrokit/geometry/v1'`. Each `FieldGeometry` carries a normalized `bbox` (`xNorm/yNorm/wNorm/hNorm`) as canonical authority, a derived `pixelBbox` in NormalizedPage surface pixels, and a `pageSurface` reference so validation can detect drift against the loaded NormalizedPage. Guard: `isGeometryFile`.
- `StructuralModel` (`src/core/contracts/structural-model.ts`): `schema: 'wrokit/structural-model'`, `version: '1.0'`. Guard: `isStructuralModel`.
- `ExtractionResult` (`src/core/contracts/extraction-result.ts`): `schema: 'wrokit/extraction-result'`, `version: '1.0'`. Guard: `isExtractionResult`.

## App Shell and Static Hosting
- The app mounts into a visible `AppShell` with explicit header/content regions.
- `main.tsx` validates `#root` mount existence early and throws a clear error if missing.
- Vite `base` resolves from `GITHUB_REPOSITORY` when available (`/<repo>/`) and falls back to `./`.

## Tests
- Vitest is wired via `vitest.config.ts`. Run `npm test`.
- One test per `is<Type>` contract guard lives in `tests/unit/contracts.test.ts`.
- `tests/unit/`, `tests/integration/`, and `tests/fixtures/` are reserved for future expansion.

## Surface Authority Rule
- The NormalizedPage raster surface is the single canonical page authority used by every downstream module: Geometry capture today; Structural Engine / OpenCV, Localization, OCR crop readout, and runtime overlays in the future.
- `src/core/page-surface/` is the *only* place that converts between screen pixels, NormalizedPage surface pixels, and normalized [0, 1] coordinates. UI must build its display transform from the displayed image's actual `getBoundingClientRect()` and feed every pointer event through `screenToSurface` to obtain authoritative surface coordinates.
- Normalized BBOX (`xNorm/yNorm/wNorm/hNorm`) on the NormalizedPage surface is the authoritative form persisted to disk. The pixel-space `pixelBbox` and the `pageSurface` reference are stored alongside it as derived snapshots so a future engine can verify the geometry was captured against the exact NormalizedPage dimensions it is now consuming.
- There is no separate canvas space, no CSS-only coordinate assumption, and no alternate page-vs-image space. Display scaling is allowed; geometry must always resolve back to canonical NormalizedPage surface coordinates exactly.

## Geometry Module
- `src/core/contracts/geometry.ts` defines the persisted `GeometryFile` shape.
- `src/core/engines/geometry/` builds and validates GeometryFiles. Validation rules:
  - all required wizard fields present;
  - no unknown fieldIds (toggleable via `tolerateUnknownFieldIds`);
  - referenced `pageIndex` exists in the loaded NormalizedPages;
  - normalized coordinates are finite;
  - normalized coordinates are in `[0, 1]` and `xNorm + wNorm <= 1`, `yNorm + hNorm <= 1`;
  - `pageSurface` (pageIndex + dimensions) matches the loaded NormalizedPage authority within 1px tolerance;
  - `wizardId` matches the loaded `WizardFile.wizardName`.
- `src/core/io/geometry-file-io.ts` serializes/parses/downloads GeometryFile JSON.
- `src/core/storage/geometry-builder-store.ts` is the in-progress capture session store.
- `src/core/runtime/config-runner.ts` orchestrates geometry build + validation.
- `src/features/config-capture/ui/ConfigCapture.tsx` is the Config Mode UI: walk wizard fields in order, draw a BBOX on the NormalizedPage viewport, save per field, edit via redraw/clear, live JSON preview, validation panel, download/import GeometryFile JSON.

## Current Implementation Status
Implemented:
- Visible app shell + dashboard module status page.
- Wizard Builder feature wired through reusable UI components and the IO module.
- Normalization intake engine with isolated PDF/image raster adapters.
- Upload UI for PDF/PNG/JPG/JPEG/WebP with normalized page viewport and page switching.
- Surface authority layer (`page-surface`) used by the Geometry module today and reserved for all future page-aware engines.
- Geometry module: BBOX capture (Config Mode), validation, save/load/import/export, edit/redraw, live JSON preview.
- Shared tokenized styling system.
- Versioned + guarded contracts for all five persisted shapes.
- Async observable stores with subscribe/snapshot.
- Canonical `Engine<I, O>` interface.
- Runtime stubs for extraction, localization, OCR, confidence.

Not yet implemented:
- Structural model generation.
- Real OCR.
- Runtime localization and OCR readout.
- Persistence adapter.
