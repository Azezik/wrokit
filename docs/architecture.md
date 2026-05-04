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
- `src/core/io`: pure serialization / parsing / file-IO helpers — one module per persisted contract (`wizard-file-io`, `geometry-file-io`, `structural-model-io`, `transformation-model-io`, `predicted-geometry-file-io`). UI calls these; UI does not embed IO. Every artifact that crosses a stage boundary has both a download path and a parse path so it can be re-ingested for diagnostic or portability replays.
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
- `src/core/runtime`: the only place engines are composed. Runners exist as boundaries: `config-runner`, `structural-runner`, `extraction-runner`, `localization-runner`, `ocr-runner`, `confidence-runner`. `config-runner` composes Geometry build + validation; `structural-runner` owns the CV adapter selection (OpenCV.js by default) and runs the Structural Engine to produce a `StructuralModel` from `NormalizedPage[]` (+ optional `GeometryFile` for ground-truth-aware refined border). `localization-runner` now performs basic Run Mode relocation by solving a per-page affine-lite transform (`scaleX/scaleY/translateX/translateY`) from config refined border to runtime refined border, then applying it to saved GeometryFile boxes in canonical normalized coordinates. Extraction/OCR/confidence runners remain stubs.
- `src/core/ui/components`: reusable visual primitives (`Button`, `Input`, `Panel`, `Section`).
- `src/core/ui/layout`: app-wide layout wrappers (`AppShell`).
- `src/core/ui/styles`: centralized visual tokens + global base styles.
- `src/features/<feature>/ui`: feature-owned UI modules (`wizard-builder`, `config-capture`, `run-mode`). Features import from `core/*`. `core/*` never imports from `features/*`. There is no standalone normalization UI; normalization is surfaced through Config Capture and Run Mode upload flows, which both run intake through `src/core/engines/normalization`.
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
  - `StructuralModel`: `3.0` (also carries `structureVersion: 'wrokit/structure/v2'` for human-readable schema identity)
  - `TransformationModel`: `1.0` (also carries `transformVersion: 'wrokit/transformation/v1'`)
  - `PredictedGeometryFile`: `1.0` (also carries `geometryFileVersion: 'wrokit/geometry/v1'` and `structureVersion: 'wrokit/structure/v2'` so re-ingest can verify compatibility with the loaded GeometryFile + StructuralModel)
  - `ExtractionResult`: `1.0`
  - `OcrBoxResult`: `1.0`
  - `MasterDbTable`: `1.0`
  - `OcrMagicResult`: `1.0`

## Store Pattern
- Stores are observable. Public surface: async mutators returning `Promise<void>`, `getSnapshot(): TSnapshot`, `subscribe(listener): () => void`.
- The base shape lives in `src/core/storage/observable-store.ts`.
- React consumers attach via `useSyncExternalStore(store.subscribe, store.getSnapshot)`.
- `src/core/storage/normalized-page-session-store.ts` provides a per-stage NormalizedPage session store. It is exported only as a `createNormalizedPageSessionStore` factory; there is no module-level singleton and no shared accessor. Each stage that needs a session instantiates its own (`pages`, `selectedPageIndex`, `sourceName`, `documentFingerprint`, `sessionId`) and exposes thin async mutators (`setNormalizedDocument`, `selectPage`, `clearSession`). NormalizedPage is a calibrated page-surface *standard*, not a shared live document — separate stages must not share one active session.
- Current implementations are in-memory; persistence adapters can be substituted without changing consumers.

## UI Organization Rules
- Visual tokens (colors, spacing, borders, shadows, radii, font sizes) are defined in `src/core/ui/styles/tokens.css`.
- Global element defaults and shared classes live in `src/core/ui/styles/global.css`.
- Reusable UI primitives are imported by feature UIs; feature UIs do not redefine core styling systems.
- Feature-specific UI styling lives beside each feature (e.g., `src/features/wizard-builder/ui/wizard-builder.css`, `src/features/config-capture/ui/config-capture.css`, `src/features/run-mode/ui/run-mode.css`).
- Business logic stays in stores/contracts/io/engines and is consumed by UI through typed interfaces.

## Data Contracts
- `WizardFile` (`src/core/contracts/wizard.ts`): `schema: 'wrokit/wizard-file'`, `version: '1.0'`. Guard: `isWizardFile`.
- `NormalizedPage` (`src/core/contracts/normalized-page.ts`): `schema: 'wrokit/normalized-page'`, `version: '2.0'`, includes pixel width/height/aspect ratio, a required `imageDataUrl` raster surface (data URL produced by the rasterizer), and display-only `sourceName`. Guard: `isNormalizedPage`.
- `GeometryFile` (`src/core/contracts/geometry.ts`): `schema: 'wrokit/geometry-file'`, `version: '1.1'`, `geometryFileVersion: 'wrokit/geometry/v1'`. Each `FieldGeometry` carries a normalized `bbox` (`xNorm/yNorm/wNorm/hNorm`) as canonical authority, a derived `pixelBbox` in NormalizedPage surface pixels, and a `pageSurface` reference so validation can detect drift against the loaded NormalizedPage. Guard: `isGeometryFile`.
- `StructuralModel` (`src/core/contracts/structural-model.ts`): `schema: 'wrokit/structural-model'`, `version: '3.0'`, `structureVersion: 'wrokit/structure/v2'`. Each `StructuralPage` carries a `pageSurface` reference, two normalized rects (`border`, `refinedBorder`), an `objectHierarchy` (typed objects with `objectId/type/objectRectNorm/parent/children/confidence`), `pageAnchorRelations`, and `fieldRelationships`. Stored separately from `GeometryFile`. Guard: `isStructuralModel`.
- `TransformationModel` (`src/core/contracts/transformation-model.ts`): `schema: 'wrokit/transformation-model'`, `version: '1.0'`, `transformVersion: 'wrokit/transformation/v1'`. Read-only Config↔Runtime alignment report. Persisted separately. Guard: `isTransformationModel`.
- `PredictedGeometryFile` (`src/core/contracts/predicted-geometry-file.ts`): `schema: 'wrokit/predicted-geometry-file'`, `version: '1.0'`, `geometryFileVersion: 'wrokit/geometry/v1'`, `structureVersion: 'wrokit/structure/v2'`. Runtime localization output: per-field predicted normalized + pixel bboxes on the runtime page surface, plus the `RuntimeStructuralTransform` (anchor tier, source rects, scale/translate, optional matched object IDs). Never overwrites the source `GeometryFile`. Guard: `isPredictedGeometryFile`.
- `ExtractionResult` (`src/core/contracts/extraction-result.ts`): `schema: 'wrokit/extraction-result'`, `version: '1.0'`. Guard: `isExtractionResult`.
- `OcrBoxResult` (`src/core/contracts/ocrbox-result.ts`): `schema: 'wrokit/ocrbox-result'`, `version: '1.0'`. Per-field localized OCR readout produced by the OCRBOX engine. Records the bbox actually used (post-padding) and the bbox source (`geometry-file` or `predicted-geometry-file`) so consumers can verify provenance without re-running. Guard: `isOcrBoxResult`.
- `MasterDbTable` (`src/core/contracts/masterdb-table.ts`): `schema: 'wrokit/masterdb-table'`, `version: '1.0'`. Append-only ledger of one row per processed document. Header order is locked by the WizardFile (`document_id, source_name, extracted_at_iso, <wizard fields…>`). Guard: `isMasterDbTable`.

## App Shell and Static Hosting
- The app mounts into a visible `AppShell` with explicit header/content regions.
- `main.tsx` validates `#root` mount existence early and throws a clear error if missing.
- Vite `base` resolves from `GITHUB_REPOSITORY` when available (`/<repo>/`) and falls back to `./`.

## Tests
- Vitest is wired via `vitest.config.ts`. Run `npm test`.
- One test per `is<Type>` contract guard lives in `tests/unit/contracts.test.ts`.
- `tests/unit/`, `tests/integration/`, and `tests/fixtures/` are reserved for future expansion.

## Surface Authority Rule
- The NormalizedPage raster surface is the single canonical page-surface *standard* used by every downstream module: Geometry capture today; Structural Engine / OpenCV, Localization, OCR crop readout, and runtime overlays in the future. Two different documents normalized through the same engine produce surfaces that are directly comparable in geometry, structure, and transformation logic — but the documents themselves remain independent.
- The single canonical authority is the page-surface *coordinate* layer (`src/core/page-surface/page-surface.ts` + `src/core/page-surface/ui/NormalizedPageViewport.tsx`), which owns conversions between screen pixels, NormalizedPage surface pixels, and normalized [0, 1] coordinates. There is no shared *live document* singleton: each stage (Config Capture, Run Mode) owns its own NormalizedPage session via `createNormalizedPageSessionStore` (or equivalent local state). The only things crossing stage boundaries are explicit, downloadable, versioned artifacts.
- `src/core/page-surface/` is the *only* place that converts between screen pixels, NormalizedPage surface pixels, and normalized [0, 1] coordinates. UI must build its display transform from the displayed image's actual `getBoundingClientRect()` and feed every pointer event through `screenToSurface` to obtain authoritative surface coordinates.
- `src/core/page-surface/ui/NormalizedPageViewport.tsx` is the **single shared NormalizedPage viewport authority** for the app. Config Capture and Run Mode (and any future page-aware UI) render through this component instead of maintaining their own image/overlay containers. It owns rendered-image measurement, overlay-plane sizing, `SurfaceTransform` construction, pointer-to-image-rect conversion, and resize/reflow recalculation. The frame shrink-wraps to the rendered image and the overlay div is sized explicitly to the measured image rect, so by construction the image plane equals the overlay plane — no CSS-only inset trick can re-introduce a width-mismatch regression. Saved BBOX, structural overlay, and predicted BBOX rects all sit on top via `normalizedRectToScreen(transform, rectNorm)`.
- Normalized BBOX (`xNorm/yNorm/wNorm/hNorm`) on the NormalizedPage surface is the authoritative form persisted to disk. The pixel-space `pixelBbox` and the `pageSurface` reference are stored alongside it as derived snapshots so a future engine can verify the geometry was captured against the exact NormalizedPage dimensions it is now consuming.
- There is no separate canvas space, no CSS-only coordinate assumption, and no alternate page-vs-image space. Display scaling is allowed; geometry must always resolve back to canonical NormalizedPage surface coordinates exactly.

## Structural Engine (Border + Refined Border + Object Hierarchy)
- The Structural Engine is the second backbone of Wrokit alongside the NormalizedPage / Geometry authority model. It produces a `StructuralModel` from canonical `NormalizedPage[]` (and an optional `GeometryFile` so saved BBOXes are honored).
- `src/core/engines/structure/structural-engine.ts` is the pure transform. It implements `Engine<StructuralEngineInput, StructuralModel>`. For each input page it derives the canonical `PageSurface` via `page-surface`, hands a surface-aligned RGBA raster to a CV adapter, and emits a `Border` (always `{0,0,1,1}`) and a `RefinedBorder` in normalized `[0, 1]` coordinates over the same NormalizedPage surface.
- `src/core/engines/structure/cv/cv-adapter.ts` defines the abstract `CvAdapter` contract: input is a `CvSurfaceRaster` whose dimensions MUST match the canonical `PageSurface` dimensions (enforced by `assertRasterMatchesSurface`); output is a `contentRectSurface` plus `objectsSurface` in NormalizedPage surface pixels. The Structural Engine never imports any specific CV library.
- `src/core/engines/structure/cv/opencv-js-adapter.ts` is the **only file in Wrokit allowed to reference OpenCV.js**. It implements the abstract `CvAdapter` and is the first CV implementation used by the Structural Engine. The adapter performs background-threshold + bounding-rect-of-content directly against the canonical NormalizedPage raster surface; if a real `cv.js` runtime is exposed (e.g. on `globalThis.cv`), the adapter is the only place that may use it. Replacing or extending the OpenCV-specific code is a single-file change.
- `src/core/engines/structure/cv/opencv-js-runtime-loader.ts` is the browser runtime bridge that best-effort loads OpenCV.js in the app shell by script injection; it reports `loaded|already-available|unavailable` and never breaks the structural pipeline when unavailable.
- Structural object authority is rooted in CV output generated on the canonical raster surface: contour/line/object detections are produced from real OpenCV.js operations when a runtime is available, and all outputs remain in canonical NormalizedPage surface coordinates before normalization.
- Heuristic pixel-scanning fallback is a **non-default contingency path** used only when OpenCV.js runtime is absent or OpenCV execution fails. Fallback output preserves the same coordinate authority contract (canonical surface in, canonical surface out) and is not the preferred structural source when OpenCV.js is present.
- `src/core/engines/structure/object-hierarchy.ts` converts CV surface detections into canonical normalized hierarchy structures and derives per-field relationships without mutating Geometry truth.
- `src/core/engines/structure/page-raster-loader.ts` is the only reader of `NormalizedPage.imageDataUrl` for CV. It always rasterizes to canvas dimensions equal to `surface.surfaceWidth/Height`, so the CV adapter sees the same surface geometry the user drew BBOXes against. There is no DPR scaling, alternate canvas space, or alternate coordinate universe.
- `src/core/runtime/structural-runner.ts` composes `createStructuralEngine` with the OpenCV.js adapter (default) and exposes a single `compute(input)` method. UI consumes only this runner; it never touches CV adapters or engine internals.
- CV execution honesty is now persisted in the canonical model: every `StructuralPage` stores `cvExecutionMode` (`opencv-runtime` or `heuristic-fallback`) so UI and runtime consumers can distinguish actual OpenCV execution from contingency fallback.
- `src/core/io/structural-model-io.ts` mirrors the Geometry IO module: `serializeStructuralModel`, `parseStructuralModel`, `downloadStructuralModel`. StructuralModels are persisted separately from GeometryFiles.
- `src/core/storage/structural-store.ts` stores StructuralModels in-memory keyed by `id`, alongside the existing `geometry-store`. The two are never merged.
- Refined Border invariants (enforced by the engine, not the UI):
  - When saved BBOXes exist on a page, the refined border MUST contain every BBOX. If CV says otherwise, the engine **expands** the refined border to include them; it never crops.
  - When no BBOXes exist, the refined border is `cv-content` if the adapter found usable content, otherwise `full-page-fallback`.
  - When CV reports a degenerate rect but BBOXes exist, the refined border is the union of all BBOXes (`bbox-union`).
  - When both contribute, the refined border is the union (`cv-and-bbox-union`).
  - Each `RefinedBorder` carries `source`, `influencedByBBoxCount`, and `containsAllSavedBBoxes` so downstream readers can verify ground-truth protection without recomputing.
- Auto-compute timing: `ConfigCapture` triggers structural compute as soon as `NormalizedPage[]` exists in the canonical session store. The user does not need to draw any BBOX before seeing the Border / Refined Border debug overlay. When BBOXes are drawn or imported, the engine recomputes with them honored as ground truth.
- Debug overlay is unified in `src/core/page-surface/ui/StructuralDebugOverlay.tsx` and consumed by both Config Capture and Run Mode. It renders Border, Refined Border, object hierarchy (filtered by confidence + always-visible types), optional object labels/containment chains, optional field-anchor badges (objects that serve as the primary anchor for a saved field), optional TransformationModel match badges (in Run Mode only), and field boxes (saved/predicted) — all from the same `StructuralModel` (and optional `TransformationPage`) contracts.
- Overlay options are a single shared contract in `src/core/page-surface/ui/structural-overlay-options.ts` with two named presets:
  - `SIMPLE_OVERLAY_OPTIONS` — first-paint friendly: filtered objects (always-visible types + confidence ≥ 0.75), no labels, no chains, no lines, no anchors, no matches.
  - `ADVANCED_OVERLAY_OPTIONS` — full debug: every overlay surface enabled, no confidence filter.
- `DEFAULT_STRUCTURAL_OVERLAY_OPTIONS` aliases `SIMPLE_OVERLAY_OPTIONS` so existing callers continue to work.
- Pure helpers `filterStructuralObjects`, `objectPassesOverlayFilter`, and `optionsMatchPreset` are exported from the same module so the filter logic and Custom-vs-Preset detection are unit-testable without rendering.
- Shared debug controls live in `src/core/page-surface/ui/StructuralOverlayControls.tsx`. Both Config Capture and Run Mode render this single component with their own option state — there is no inline toggle JSX in either feature. The component exposes:
  - master "Show Overlay" toggle
  - Simple/Advanced preset buttons (and a "Custom" pill when the live options diverge from either preset)
  - per-feature toggles: Objects, Lines, Show All, Labels, Chains, Field Anchors, Transformation Matches (Transformation Matches is hidden in Config Mode via `transformationAvailable={false}`)
  - min-object-confidence slider
  - inline color legend keyed to the actual overlay swatches
- Per-object-type colors are applied via `data-object-type` attributes so a `container`, `rectangle`, `table-like`, `header`, `footer`, and `line-*` are visually distinguishable. Hovering an object highlights it in place (white inset ring) and reveals its label/chain even when those toggles are off, so dense pages can be inspected without flipping every switch.
- StructuralModel does not carry: OCR, runtime extraction, semantic understanding, automatic field relocation, or global confidence systems. The new object hierarchy adds structural measurement context only.

## OCRBOX Engine (Localized BBOX OCR)
- The OCRBOX engine is an **isolated** extraction layer that reads only the pixels strictly inside each saved Field BBOX (with an optional small symmetric padding capped at `0.02` normalized). It NEVER modifies a Field BBOX, the GeometryFile, the StructuralModel, the TransformationModel, or the PredictedGeometryFile.
- Module layout under `src/core/engines/ocrbox/`:
  - `bbox-cropper.ts` — pure NormalizedPage→canvas crop helper. Renders at canonical surface pixel scale, applies the padding clamp, and returns the exact `bboxUsed` so the result artifact records what was actually read.
  - `tesseract-ocr-adapter.ts` — the **only** Tesseract.js consumer in Wrokit. Lazy-imports the library on first use, holds a single worker per session, and exposes `dispose()`. Replacing the OCR backend is a single-file change.
  - `ocrbox-engine.ts` — pure transform implementing `Engine<OcrBoxEngineInput, OcrBoxResult>`. Iterates field requests, crops, calls the OCR adapter, normalizes whitespace, and emits per-field `{text, confidence, status, bboxUsed, bboxPaddingNorm}`. Per-field errors are reported as `status: 'error'`; the engine never throws on a single bad crop.
  - `index.ts` re-exports the engine, adapter factory, and crop helpers.
- Composition: `src/core/runtime/ocrbox-runner.ts` is the only place the engine is composed. It exposes `extractFromGeometry(GeometryFile, pages)` for Config preview and `extractFromPredicted(PredictedGeometryFile, pages)` for Run-mode extraction. Both paths feed identical `OcrBoxResult` artifacts.
- IO: `src/core/io/ocrbox-result-io.ts` provides serialize/parse/download for the result artifact so it can be downloaded for inspection or re-uploaded for replay.
- UI: `src/features/ocrbox-preview/ui/OcrBoxPreview.tsx` renders the per-field text readout below the viewport in both Config Capture and Run Mode. The component is fed either the live in-progress GeometryFile (Config) or the just-computed PredictedGeometryFile (Run); it never reaches into the geometry/structural/transformation engines.

## MasterDB Engine (CSV Ledger)
- The MasterDB engine is an **isolated** storage layer that compiles per-document `OcrBoxResult`s into one row of a fixed-schema CSV. It NEVER reads NormalizedPage pixels, never runs OCR, and never modifies the WizardFile, GeometryFile, StructuralModel, TransformationModel, PredictedGeometryFile, or OcrBoxResult.
- Module layout under `src/core/engines/masterdb/`:
  - `csv-codec.ts` — pure RFC-4180-style serialize/parse. Quotes cells containing `,`, `"`, or newlines; round-trips multi-line values; rejects CSVs whose leading columns are not the canonical `document_id, source_name, extracted_at_iso`.
  - `masterdb-engine.ts` — pure transform implementing `Engine<MasterDbApplyInput, MasterDbApplyOutput>`. Seeds a fresh table from a WizardFile, or merges new OCRBOX results into an existing table. Rows are upserted by `document_id` (idempotency key); appended rows are listed in `appendedRowIds`, replaced rows in `replacedRowIds`. Wizard fields not yet in the existing table are appended to `fieldOrder` without reordering, so historical CSVs remain compatible.
  - `index.ts` re-exports the engine, codec, and seed helper.
- Composition: `src/core/runtime/masterdb-runner.ts` is the only place the engine is composed. It exposes a single `apply({wizard, existing, results})` that delegates to the engine.
- IO: `src/core/io/masterdb-csv-io.ts` provides the CSV download. Upload uses `parseMasterDbCsv` from the engine's codec; the wizardId is provided by the caller because the CSV itself does not embed it.
- UI: `src/features/masterdb/ui/MasterDbPanel.tsx` mounts beneath the OCRBOX preview in both Config Capture and Run Mode. It supports `Append latest OCRBOX result`, `Upload existing MasterDB CSV`, `Download MasterDB CSV`, and `Clear in-memory MasterDB`. The append flow assumes the uploaded CSV originated from the same WizardFile and re-uses its locked header order.

## Engine Isolation Invariant for OCRBOX + MasterDB
- OCRBOX consumes only `NormalizedPage[]` plus a `(fieldId, pageIndex, bbox)` triple. It does not import or call the geometry, structural, transformation, or localization engines.
- MasterDB consumes only `WizardFile` + `OcrBoxResult[]` (and an optional prior `MasterDbTable`). It does not import or call OCRBOX, geometry, structural, transformation, or localization engines.
- Neither OCRBOX nor MasterDB writes back into any other engine's contracts. They only emit their own versioned, type-guarded artifacts.

## OCRMagic Engine (Optional Field-Aware MasterDB Cleanup)
- The OCRMagic engine is an **isolated**, optional post-processing layer that runs over a finalized `MasterDbTable` and emits a parallel cleaned `MasterDbTable` plus per-cell audit metadata. It NEVER reads NormalizedPage pixels, runs OCR, or modifies the WizardFile, GeometryFile, StructuralModel, TransformationModel, PredictedGeometryFile, OcrBoxResult, or the source MasterDbTable.
- Module layout under `src/core/engines/ocrmagic/`:
  - `cleanup.ts` — pure, conservative edge-junk strip (NBSP, zero-width characters, multi-space, leading/trailing apostrophes, copyright glyphs, separator characters). Reports the reason codes that explain each removal.
  - `substitutions.ts` — pure, type-gated character substitutions. `text` flips digits→letters, `numeric` flips letters→digits, `any` opts out entirely. Also exposes `generateLocalCandidates` for one-character ambiguity flips.
  - `pattern-profile.ts` — pure, deterministic column PatternProfile builder (length stats, per-position char-class majority, common prefixes/suffixes, separators, repeated values, declared vs inferred kind) plus a `scoreAgainstProfile` candidate scorer. Not ML.
  - `ocrmagic-engine.ts` — pure `Engine<OcrMagicCleanInput, OcrMagicCleanOutput>` implementing the 8-stage pipeline: preserve raw → safe cleanup → type substitutions → learn profile → generate candidates → score → apply when margin clears `0.08` → emit audit metadata.
  - `index.ts` re-exports the engine, helpers, and types.
- Composition: `src/core/runtime/ocrmagic-runner.ts` is the only place the engine is composed. It exposes a single `clean({wizard, masterDb})` boundary that returns an `OcrMagicResult`.
- Contract: `src/core/contracts/ocrmagic-result.ts` (`schema: 'wrokit/ocrmagic-result'`, `version: '1.0'`, guard `isOcrMagicResult`). Carries the cleaned `MasterDbTable`, learned `OcrMagicFieldProfile` per field, a flat per-cell audit list, and aggregate `changeCounts`.
- IO: `src/core/io/masterdb-csv-io.ts` exposes `downloadCleanedMasterDbCsv(table)` so the cleaned table downloads with a `*.masterdb.cleaned.csv` filename and does not collide with the raw download.
- UI: `src/features/polished-wizard/ui/slides/ReviewSlide.tsx` exposes `Clean Data` → loading → `Download cleaned CSV` alongside `Download raw CSV`. `src/features/masterdb/ui/MasterDbPanel.tsx` exposes the same actions in the debug surface used by Config Capture and Run Mode.

## Engine Isolation Invariant for OCRMagic
- OCRMagic consumes only `WizardFile.fields[].type` (read-only) plus the source `MasterDbTable`. It does not import or call NormalizedPage, geometry, structural, transformation, localization, OCR, or OCRBOX engines.
- OCRMagic does not write back into any other engine's contracts. Its only output is the versioned, type-guarded `OcrMagicResult` artifact.
- The raw `MasterDbTable` is preserved verbatim; the cleaned `MasterDbTable` is a parallel artifact and the user explicitly chooses which to download.

## Ground Truth Rule
- Human-confirmed BBOX geometry remains the highest authority. The Structural Engine never overrides, shrinks, moves, or reinterprets a saved BBOX as truth. If structural detection disagrees with saved geometry, geometry wins and the refined border expands to include the disagreement.

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
- `src/features/config-capture/ui/ConfigCapture.tsx` is the Config-stage upload entry point. It handles the full Config intake flow: upload file → normalize via the normalization engine → write `NormalizedPage[]` into its own per-stage normalized-page session (via `createNormalizedPageSessionStore`) → read selected page from that local session for BBOX capture. Walk wizard fields in order, draw a BBOX on the NormalizedPage viewport, save per field, edit via redraw/clear, live JSON preview, validation panel, download/import GeometryFile JSON. Run Mode is the runtime-stage upload entry point and owns its own independent normalized page state for the runtime document. There is no separate standalone normalization UI in the app.

## Current Implementation Status
Implemented:
- Visible app shell + dashboard module status page.
- Wizard Builder feature wired through reusable UI components and the IO module.
- Normalization intake engine with isolated PDF/image raster adapters.
- **Per-stage Config Capture intake flow + page-surface coordinate authority**: upload (PDF/PNG/JPG/JPEG/WebP), normalization, per-stage normalized-page session update, and BBOX drawing are a single workflow in `ConfigCapture`. There is no separate standalone normalization UI mounted in the app, and no shared live-document singleton between Config Capture and Run Mode.
- Surface authority layer (`page-surface`) used by the Geometry module and the Structural Engine, and reserved for all future page-aware engines.
- Geometry module: BBOX capture (Config Mode), validation, save/load/import/export, edit/redraw, live JSON preview.
- Structural Engine v1: Border + Refined Border auto-compute on `NormalizedPage[]` availability via the OpenCV.js CV adapter, ground-truth-aware (BBOX union when present), structural-model-io for save/preview/download, debug overlay toggle in Config Capture.
- Shared tokenized styling system.
- Versioned + guarded contracts for all five persisted shapes.
- Async observable stores with subscribe/snapshot.
- Canonical `Engine<I, O>` interface.
- Runtime localization baseline (Run Mode): config artifact load + runtime normalization + runtime structural build + transform-based predicted box redraw + predicted geometry JSON export.
- Runtime stubs for extraction, OCR, confidence.
- OCRBOX engine (localized BBOX OCR) wired through `src/core/engines/ocrbox/` + `src/core/runtime/ocrbox-runner.ts`. Tesseract.js is lazy-loaded on first run. Per-field readout previews are mounted below the viewport in both Config Capture and Run Mode via `OcrBoxPreview`.
- MasterDB engine (CSV ledger) wired through `src/core/engines/masterdb/` + `src/core/runtime/masterdb-runner.ts`. UI panel supports append, upload-existing, download, and clear in both Config Capture and Run Mode.

Not yet implemented:
- Real OCR.
- OCR readout and confidence scoring in runtime pipeline.
- Advanced localization (multi-stage/semantic/object hierarchy).
- Persistence adapter.


## Run Mode (Basic Transform Matching)
- Run Mode UI lives in `src/features/run-mode/ui/RunMode.tsx` and is mounted via `src/app/pages/RunModePage.tsx`.
- Inputs: WizardFile, GeometryFile, Config StructuralModel, runtime document upload. Runtime upload always flows through the normalization engine (`NormalizedPage[]` authority preserved).
- Outputs (every output is a downloadable, versioned, type-guarded artifact, and every output has a corresponding diagnostic re-upload path so it can be re-ingested for inspection or portability replay): runtime `StructuralModel` (`downloadStructuralModel`), `TransformationModel` (`downloadTransformationModel`), `PredictedGeometryFile` (`downloadPredictedGeometryFile`).
- Run Mode now publishes explicit input/status confirmations for each authority artifact: WizardFile loaded/not loaded (wizard name), GeometryFile loaded/not loaded (field count), Config StructuralModel loaded/not loaded (page count), runtime normalized/not normalized (runtime page count + selected page), and parse/validation errors per input.
- Runtime structure is computed by reusing `structural-runner` (same composition path used by Config Capture); no border/refined-border logic is duplicated in UI.
- Structural comparison basis: config `refinedBorder.rectNorm` vs runtime `refinedBorder.rectNorm` per page.
- Transform solve: `scaleX = runtime.w/config.w`, `scaleY = runtime.h/config.h`, `translateX = runtime.x - config.x*scaleX`, `translateY = runtime.y - config.y*scaleY`.
- Runtime localization anchor resolution is deterministic: stable anchors are attempted in `A → B → C` order first; if no usable object anchor resolves, it falls back to `Refined Border`, then `Border` as final contingency.
- Transform apply: each saved GeometryFile normalized bbox is transformed in normalized space and clamped to `[0,1]`, then rendered as predicted overlay and emitted in a predicted-geometry JSON artifact with transform metadata.
- Run Mode includes the same shared structural overlay renderer used in Config Capture, so structural display logic is no longer duplicated per feature.
- Runtime Border, runtime Refined Border, runtime objects, and predicted BBOX overlays all render through the same `page-surface` transform path (`getPageSurface` → `buildSurfaceTransform` → `normalizedRectToScreen`) used in Config Capture, so overlay parity is explicit and single-authority.
- Ground truth remains primary: Run Mode does not discover fields or reinterpret meaning; it relocates existing field geometry by `fieldId`/`pageIndex`.

## Transformation Model (Config↔Runtime Alignment Report)
- The Transformation Model is a **separate alignment layer**: it compares a Config `StructuralModel` against a Runtime `StructuralModel` for the same template and produces an alignment/transform report. It does **not** mutate `GeometryFile`, either `StructuralModel`, or any OpenCV output.
- Contract: `src/core/contracts/transformation-model.ts` (`schema: 'wrokit/transformation-model'`, `version: '1.0'`, `transformVersion: 'wrokit/transformation/v1'`). All transforms are simple affine in v1 (`scaleX, scaleY, translateX, translateY`) over canonical normalized [0, 1] coordinates — no parallel coordinate system, no perspective warp.
- Runner: `src/core/runtime/transformation-runner.ts`. Pure read-only computation: takes `(configModel, runtimeModel)` and returns a `TransformationModel`. Run Mode (`src/features/run-mode/ui/RunMode.tsx`) invokes it after the runtime structural build as a read-only step that does not influence localization.
- Internals (under `src/core/runtime/transformation/`):
  - `similarity.ts` — pure weighted scorer over object type, normalized position, size, aspect ratio, parent-chain anchoring, and refined-border relation. Emits per-component scores and basis tags.
  - `hierarchical-matcher.ts` — three-pass strategy: (1) top-level objects, (2) recursive descent within already-matched parents, (3) stricter global pass over remainders. Greedy max-score 1:1 assignment with confidence threshold; weak matches are rejected and listed as unmatched on either side.
  - `transform-math.ts` — `affineFromRects`, `applyAffineToRect`, `iouOfRects`, `affineDistance`, `IDENTITY_AFFINE`.
  - `consensus.ts` — per-page level summaries for `border` (always 1:1 identity), `refined-border` (1:1 with confidence keyed off the source flag), `object`, and `parent-chain`; plus a single `consensus` block computed by **maximum-inlier search (RANSAC-style)** over the matcher's per-pair affines. For each match's implied affine, count the matches whose own affines agree within scale/translate tolerance; the affine with the largest agreeing subset (weighted total as tiebreaker) seeds the consensus, and the agreeing subset is then averaged via weighted mean (weight = match confidence × √area) to refine the seed. This implements the object-hierarchy authority rule: the largest subset of matches whose pairwise relative geometry is preserved across config and runtime wins, even when other (heavier-weighted) matches disagree. Disagreeing matches are reported as outliers with per-component deltas. Confidence reflects weight coverage of the inlier set and a virtual-projection cross-check (apply consensus to every contributing config rect, average IoU vs runtime match).
  - `field-candidates.ts` — per-field fallback chain `matched-object → parent-object → refined-border → border`. Each candidate carries the transform that would apply, the `relativeFieldRect` from the source anchor, and a confidence derived from the underlying signal. Localization can later consume these without recomputing anchors.
- Honesty rules enforced:
  - Outliers are reported in `consensus.outliers` (with reason and per-component delta), not silently dropped.
  - When data is insufficient, `transform` is `null` and confidence is `0` rather than fabricated.
  - The model only references both source `StructuralModel`s by `{id, documentFingerprint}`; it never embeds or mutates either.
  - Refined-border summary surfaces a warning when either side fell back to `full-page-fallback`.
- IO: `src/core/io/transformation-model-io.ts` (serialize/parse/download); separately persistable.

## Containment Chain Authority for Field Anchors
- Stable field anchors `A → B → C` on every `StructuralFieldRelationship` are produced from the **containment chain**, not from nearest-by-distance ranking. `A` is the smallest object that fully contains the field BBOX, `B` is `A`'s structural parent, and `C` is the next ancestor (or, if the chain runs out, the smallest other containing/overlapping object as supplemental fill). `containedBy` mirrors `A.objectId`.
- `relativeFieldRect` on each chain anchor is computed against that anchor's own normalized rect, so for chain anchors the field ratios are guaranteed to live in `[0, 1]`. Run Mode projects the saved relative rect through whichever runtime anchor it can resolve, falling back deterministically `A → B → C → Refined Border → Border`.
- When the exact anchor `objectId` cannot be matched on the runtime page, `localization-runner` matches structurally by object type **plus full ancestor-type chain** (then by `(childPresence, depthDelta, parentTypeMatch)` as tiebreakers, with geometric distance only as the final tiebreaker). Distance is never the primary signal.
- `pageAnchorRelations.refinedBorderToBorder` and `pageAnchorRelations.objectToRefinedBorder` keep the chain rooted: every object retains its relative geometry to the Refined Border, and Refined Border keeps its relative geometry to Border, so any anchor in the chain can be re-grounded to page authority without recomputation.
- All chain math is in canonical normalized coordinates over the `NormalizedPage` surface; no CSS, viewport, or pixel-only space participates in anchor authority.
