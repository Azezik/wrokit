# Wrokit Development Log

## 2026-04-26 — Step: Geometry Module + Surface Authority Layer

### Why this step
- Wrokit needed a coherent Geometry module that turns a `WizardFile` and a `NormalizedPage` into a human-confirmed `GeometryFile` (Config Mode BBOX capture, save/load, validate, edit).
- V1 suffered from canvas/viewport mismatches caused by separate fake canvas spaces, drifting overlay coordinate systems, and CSS-only coordinate assumptions. V2 must enforce a single page authority — the NormalizedPage raster surface — that Geometry today and the Structural Engine / OCR / Localization tomorrow all consume identically.

### What changed
- Added `src/core/page-surface/` — a thin infrastructural orchestration layer that owns canonical NormalizedPage surface authority. It is the only module allowed to convert between screen pixels, NormalizedPage surface pixels, and normalized `[0, 1]` coordinates. Every page-aware module (Geometry today, Structural Engine / OpenCV / Localization / OCR / runtime overlays tomorrow) is required to flow coordinates through this layer.
  - `getPageSurface(page)` derives the canonical `PageSurface` from a `NormalizedPage`.
  - `buildSurfaceTransform(surface, displayRect)` builds the screen↔surface transform from the *actual* displayed image rect.
  - `screenToSurface`, `surfaceToScreen`, `surfaceRectToNormalized`, `normalizedRectToSurface`, `normalizedRectToScreen` cover every conversion.
  - `isNormalizedRectInBounds`, `assertSurfaceMatches`, `normalizeRectFromCorners` are the invariant checks and clipping primitives.
- Extended the `GeometryFile` contract (`src/core/contracts/geometry.ts`) to v1.1 with `geometryFileVersion: 'wrokit/geometry/v1'`. Each `FieldGeometry` now carries:
  - `bbox: { xNorm, yNorm, wNorm, hNorm }` — canonical normalized authority.
  - `pixelBbox: { x, y, width, height }` — surface-pixel snapshot, derived deterministically from `bbox + pageSurface`.
  - `pageSurface: { pageIndex, surfaceWidth, surfaceHeight }` — the NormalizedPage dimensions geometry was captured against, so a future engine can detect drift.
  - `BoundingBox` (the old pixel-only type) was removed from `geometry.ts` and inlined into `structural-model.ts`, which was its only remaining consumer. Geometry no longer leaks pixel-only assumptions into other contracts.
- Added the Geometry engine `src/core/engines/geometry/`:
  - `geometry-engine.ts` implements the canonical `Engine<I, O>` interface and pure-functionally builds a `GeometryFile` from drafts.
  - `validation.ts` is the single source of truth for validation. It enforces: all required wizard fields present; no unknown fieldIds (unless `tolerateUnknownFieldIds`); referenced `pageIndex` exists; coordinates finite and within `[0, 1]` (and `x + w <= 1`, `y + h <= 1`); `pageSurface` matches the loaded NormalizedPage authority within 1px tolerance; `wizardId` matches `WizardFile.wizardName`. Validation lives in core, not UI.
- Added `src/core/io/geometry-file-io.ts` with `serializeGeometryFile`, `parseGeometryFile`, `downloadGeometryFile`, mirroring the WizardFile IO module shape.
- Added `src/core/storage/geometry-builder-store.ts` — an async observable store that owns the in-progress capture session (wizardId, documentFingerprint, fields, metadata) and produces a `GeometryFile` snapshot on demand.
- Rewrote `src/core/runtime/config-runner.ts` from a placeholder into a real composer: `buildAndValidate(...)` runs the geometry engine then the validator; `validateExisting(...)` validates an imported GeometryFile against the loaded WizardFile + pages. Composition lives only in the runner; engines stay pure.
- Added the Config Mode UI feature `src/features/config-capture/ui/ConfigCapture.tsx` (+ `config-capture.css`):
  - Loads a WizardFile via JSON import.
  - Loads a document through the existing normalization intake engine — geometry never sees raw uploads, only NormalizedPages.
  - Walks fields in wizard order with the prompt **"Where is [field label]?"**.
  - Draws BBOX directly on the displayed NormalizedPage image. Pointer events resolve through `page-surface`: `screen → surface → normalized`. The displayed image's actual `getBoundingClientRect()` is the only source for the display transform; a `ResizeObserver` keeps it in sync as the viewport reflows.
  - Save Field is required before moving on. Saved boxes overlay the same image and are themselves rendered by transforming canonical normalized coordinates back to screen space through the same transform — no second coordinate universe.
  - Each saved field is tied to `fieldId + pageIndex`, with `pixelBbox` and `pageSurface` snapshot included.
  - Editing: select any saved field, redraw, save — the upsert replaces the prior bbox.
  - Live `GeometryFile` JSON preview, Download, and Import are wired to the IO module.
  - Validation panel renders the `ConfigRunner.validateExisting` result; UI never decides validity itself.
- Added the page route + dashboard wiring (`src/app/pages/ConfigCapturePage.tsx`, `routes.ts`, `App.tsx`, `HomeDashboardPage.tsx` Geometry status flipped from `planned` to `active`).
- Added unit tests:
  - `tests/unit/page-surface.test.ts` — surface derivation, transform round-trip, in-bounds checks, corner-clipping.
  - `tests/unit/geometry-validation.test.ts` — every validation rule.
  - `tests/unit/geometry-file-io.test.ts` — serialize/parse round-trip and error cases.
  - Existing `tests/unit/contracts.test.ts` updated to the new GeometryFile shape.

### Surface authority enforcement
- The drawing surface is the displayed `<img>` of the canonical `NormalizedPage.imageDataUrl`. There is no separate canvas, no fake page space, and no CSS-only positioning of saved boxes. Saved boxes are positioned by transforming the persisted normalized coordinates through the live display transform, so they cannot drift out of alignment with the page they were drawn on.
- Every coordinate conversion (capture and render) flows through `src/core/page-surface/`. Validation re-checks that the persisted `pageSurface` matches the loaded NormalizedPage dimensions within 1px tolerance; mismatches raise the `page-surface-mismatch` validation issue.
- Persisted geometry is normalized `[0, 1]` over the canonical NormalizedPage surface — the same surface a future OpenCV / Structural Engine pass will consume — so user-drawn BBOX geometry maps directly into the same coordinate universe used by future structural modelling.

### Boundaries preserved
- No OCR, OpenCV, or structure detection added.
- No runtime extraction added.
- No new coordinate system that future engines cannot directly consume.
- `pdfjs-dist` still used only inside `pdf-rasterizer.ts`.
- Geometry has no awareness of source MIME type; it consumes only `NormalizedPage`s produced by the normalization engine.
- GeometryFile is human-confirmed truth; it is not merged with `StructuralModel`.

### Files added
- `src/core/page-surface/page-surface.ts`
- `src/core/page-surface/index.ts`
- `src/core/engines/geometry/geometry-engine.ts`
- `src/core/engines/geometry/validation.ts`
- `src/core/engines/geometry/types.ts`
- `src/core/engines/geometry/index.ts`
- `src/core/io/geometry-file-io.ts`
- `src/core/storage/geometry-builder-store.ts`
- `src/features/config-capture/ui/ConfigCapture.tsx`
- `src/features/config-capture/ui/config-capture.css`
- `src/app/pages/ConfigCapturePage.tsx`
- `tests/unit/page-surface.test.ts`
- `tests/unit/geometry-validation.test.ts`
- `tests/unit/geometry-file-io.test.ts`

### Files modified
- `src/core/contracts/geometry.ts` (extended to v1.1 with normalized bbox + pageSurface ref)
- `src/core/contracts/structural-model.ts` (inlined `BoundingBox` since it's the only remaining consumer of the old shape)
- `src/core/runtime/config-runner.ts` (now composes geometry engine + validation)
- `src/app/App.tsx` (mounts `ConfigCapturePage`)
- `src/app/routes.ts` (registers `configCapture` route)
- `src/app/pages/HomeDashboardPage.tsx` (Geometry module status → active)
- `tests/unit/contracts.test.ts` (updated to v1.1 GeometryFile shape)
- `docs/architecture.md`
- `docs/dev-log.md`

### Checks run
- `npm run check` (`tsc --noEmit`): passed.
- `npm run build` (`tsc -b && vite build`): passed; bundle emitted.
- `npm test` (vitest): all 27 tests pass (10 contracts + 6 page-surface + 7 geometry-validation + 4 geometry-file-io).

### Recommended next step
- Persist completed `GeometryFile` snapshots into the existing `GeometryStore` from the Config Mode UI (Save → store) so the dashboard can list saved geometries via `useSyncExternalStore`, mirroring the upcoming Wizard save flow.

---

## 2026-04-26 — Step: Normalization Engine Intake Fix (PDF Worker + Image Audit)

### Why this step
- PDF upload failed at runtime with `No "GlobalWorkerOptions.workerSrc" specified.`
- The previous `pdf-rasterizer.ts` loaded `pdfjs-dist` from a CDN via runtime `import()`, set `GlobalWorkerOptions.workerSrc = ''`, and passed `disableWorker: true`. The `disableWorker` flag does not bypass PDF.js's worker-source validation in v4 — `getDocument` still requires a real `workerSrc` URL, so it threw immediately.
- The image upload path needed an audit to confirm it produced canonical `NormalizedPage` raster surfaces rather than passing the original upload through to the UI.

### Cause of the PDF worker error
- The CDN-loaded build of `pdfjs-dist@4.10.38` requires `GlobalWorkerOptions.workerSrc` to point at a worker script that the browser can fetch and instantiate.
- Setting `workerSrc = ''` and trying to disable the worker is not a supported configuration in this version; PDF.js validates the source string before falling back to any in-process fake worker, so loading any document fails with the reported error.

### Image normalization audit result
- `image-rasterizer.ts` decodes the upload via `createImageBitmap`, draws onto a fresh `HTMLCanvasElement`, and re-encodes via `canvas.toDataURL('image/png')`.
- The resulting `NormalizedPage.imageDataUrl` is a brand new PNG buffer; the source MIME type, source bytes, and any source-format identity are dropped at the rasterizer boundary.
- The intake UI (`NormalizationIntake.tsx`) only renders `selectedPage.imageDataUrl`. It never references the raw upload `File` or a `URL.createObjectURL` from the original blob. Image normalization was already happening; no leak of the raw upload existed.
- Cleanup hygiene was tightened so the decoded `ImageBitmap` is closed via `try/finally`, matching the PDF rasterizer cleanup pattern.

### What changed
- Added `pdfjs-dist@^4.10.38` as a real dependency in `package.json` (and refreshed `package-lock.json`) so the library is bundled by Vite instead of fetched from a CDN at runtime.
- Rewrote `src/core/engines/normalization/pdf-rasterizer.ts`:
  - Imports `pdfjs-dist` statically.
  - Imports the worker file via Vite's `?url` suffix:
    `import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';`
  - Sets `pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl` exactly once on first use.
  - Uses standard `getDocument({ data })` (no `disableWorker` hack).
  - Adds page/document `cleanup()` + `destroy()` in a `try/finally` so each rasterize call releases PDF.js resources.
- Tightened `src/core/engines/normalization/image-rasterizer.ts` so the decoded bitmap is always released via `try/finally`.
- Added `src/vite-env.d.ts` with `/// <reference types="vite/client" />` so the `?url` import is properly typed under `tsc --noEmit`.

### Boundary preserved
- All PDF.js usage stays inside `pdf-rasterizer.ts`. No other module imports `pdfjs-dist`.
- All image-specific decode/draw/encode logic stays inside `image-rasterizer.ts`.
- `normalization-engine.ts` still routes only on MIME type at the intake boundary and immediately wraps both adapter outputs into a uniform `NormalizedPage` via `toNormalizedPage`. No downstream consumer can detect whether a page came from a PDF or an image.
- `NormalizedPage.sourceName` remains display-only.
- No OCR, OpenCV, structure detection, text-layer extraction, or extraction logic was added.

### Files modified
- `package.json` (added `pdfjs-dist` to `dependencies`)
- `package-lock.json` (refreshed)
- `src/core/engines/normalization/pdf-rasterizer.ts`
- `src/core/engines/normalization/image-rasterizer.ts`
- `docs/architecture.md`
- `docs/dev-log.md`

### Files added
- `src/vite-env.d.ts`

### Checks run
- `npm run check` (`tsc --noEmit`): passed.
- `npm run build` (`tsc -b && vite build`): passed. Vite emits the worker as `dist/assets/pdf.worker.min-<hash>.mjs` and references it under the GitHub Pages base path `/<repo>/assets/...`, confirmed by inspecting the built `index` chunk.
- `npm test` (vitest): all 10 contract tests pass.

### Recommended next step
- Add a `NormalizationStore` so normalized page sessions survive page changes and can be consumed by the upcoming Geometry module without coupling UI state to engine state.

---

## 2026-04-25 — Step: Normalization Engine Intake Boundary

### Why this step
- Wrokit required a hard intake boundary so all uploads become one canonical raster contract before any downstream module access.
- The goal was to eliminate format-awareness downstream (PDF vs image) and enforce `NormalizedPage` as the only post-intake page shape.

### What changed
- Added normalization engine modules under `src/core/engines/normalization/`:
  - `image-rasterizer.ts`: decodes image uploads and emits one raster page surface.
  - `pdf-rasterizer.ts`: renders PDF pages to canvas raster surfaces (only location where PDF.js is referenced).
  - `normalization-engine.ts`: intake orchestrator that validates supported types and returns `NormalizationResult` with `NormalizedPage[]`.
  - `types.ts` + `index.ts` for strict contracts and module export boundaries.
- Upgraded `NormalizedPage` contract to version `2.0` with explicit raster-focused fields:
  - `pageIndex`, `width`, `height`, `aspectRatio`, image URL surface (`imageDataUrl` or `imageBlobUrl`), `sourceName` (display-only), and `normalization` metadata.
- Added upload + normalized page viewport UI:
  - `src/features/normalization/ui/NormalizationIntake.tsx`
  - `src/features/normalization/ui/normalization-intake.css`
  - Supports PDF/PNG/JPG/JPEG/WebP upload, page count display, and multi-page switching.
- Wired dashboard page to render the new normalization intake module.
- Updated runtime runner interfaces (`localization`, `ocr`, `extraction`) to accept `pages: NormalizedPage[]`, strengthening downstream type boundaries.
- Updated architecture docs and contract tests for the new normalization contract and boundary rules.

### Boundaries preserved
- No OCR implementation added.
- No structure detection added.
- No runtime extraction implementation added.
- No PDF text extraction, token extraction, annotation parsing, form parsing, or metadata-based extraction logic added.

### Files created
- `src/core/engines/normalization/types.ts`
- `src/core/engines/normalization/image-rasterizer.ts`
- `src/core/engines/normalization/pdf-rasterizer.ts`
- `src/core/engines/normalization/normalization-engine.ts`
- `src/core/engines/normalization/index.ts`
- `src/features/normalization/ui/NormalizationIntake.tsx`
- `src/features/normalization/ui/normalization-intake.css`

### Files modified
- `src/core/contracts/normalized-page.ts`
- `src/core/runtime/localization-runner.ts`
- `src/core/runtime/ocr-runner.ts`
- `src/core/runtime/extraction-runner.ts`
- `src/app/pages/HomeDashboardPage.tsx`
- `tests/unit/contracts.test.ts`
- `docs/architecture.md`
- `docs/dev-log.md`

### Recommended next step
- Add a dedicated `NormalizationStore` so normalized page sessions can be reused by the upcoming Geometry module without coupling UI state to engine state.

---

## 2026-04-25 — Step: Foundation Audit 001 — Now-Risk Fixes

### Why this step
- Foundation audit (see `docs/audits/foundation-audit-001.md`) flagged eight "fix now" risks that, if left, would force expensive rewrites the moment a second engine, a persistence adapter, or a second feature UI lands.
- Goal: resolve every "now" item with the smallest clean change, with zero new product features.

### Risks resolved in this pass
- R1: WizardFile import/export logic moved out of `WizardBuilder.tsx` into `src/core/io/wizard-file-io.ts` (pure functions + injectable browser env).
- R2 + R10: All stores now expose `subscribe(listener)` + `getSnapshot()` and async mutators returning `Promise<void>`. Common shape lives in `src/core/storage/observable-store.ts`. `WizardBuilder.tsx` now consumes via `useSyncExternalStore`.
- R3: `NormalizedPage`, `GeometryFile`, `StructuralModel`, `ExtractionResult` now declare `schema` + `version` and export runtime guards (`isNormalizedPage`, `isGeometryFile`, `isStructuralModel`, `isExtractionResult`).
- R4: Canonical `Engine<TInput, TOutput>` interface added at `src/core/engines/engine.ts`. All future engine modules must implement it.
- R5: Feature UIs relocated from `src/core/ui/<feature>/` to `src/features/<feature>/ui/`. `core/ui/` now only holds primitives, layout, and styles. Reserved `extraction-preview` and `config-viewport` slots moved with it.
- R6: Stub runners added: `localization-runner.ts`, `ocr-runner.ts`, `confidence-runner.ts`. Architecture doc now codifies the rule: engines are pure, composition lives only in `runtime/`.
- R8: Vitest wired (`vitest.config.ts`, `npm test`). One test per `is<Type>` guard lives in `tests/unit/contracts.test.ts`.

### Risks intentionally deferred
- R7: Vite `base` env handling. Current behavior is correct under GitHub Actions; documented for later.
- R9: `src/demo/sample-wizard.ts` reference. Will move to `tests/fixtures/` or wire to an "Insert sample" action when that work is needed.

### Boundaries preserved
- No extraction features added.
- No OCR, OpenCV, or PDF processing added.
- No new product UI added.
- No runtime composition implemented; all runners still throw `not implemented in foundation phase`.

### Files created
- `src/core/contracts/normalized-page.ts` (rewritten with schema/version/guard)
- `src/core/contracts/geometry.ts` (rewritten with schema/version/guard)
- `src/core/contracts/structural-model.ts` (rewritten with schema/version/guard)
- `src/core/contracts/extraction-result.ts` (rewritten with schema/version/guard)
- `src/core/engines/engine.ts`
- `src/core/io/wizard-file-io.ts`
- `src/core/runtime/localization-runner.ts`
- `src/core/runtime/ocr-runner.ts`
- `src/core/runtime/confidence-runner.ts`
- `src/core/storage/observable-store.ts`
- `src/features/wizard-builder/ui/WizardBuilder.tsx` (moved + refactored)
- `src/features/wizard-builder/ui/wizard-builder.css` (moved)
- `src/features/extraction-preview/ui/.gitkeep` (moved)
- `src/features/config-viewport/ui/.gitkeep` (moved)
- `tests/unit/contracts.test.ts`
- `vitest.config.ts`
- `docs/audits/foundation-audit-001.md`

### Files modified
- `src/core/storage/wizard-store.ts` (async + observable)
- `src/core/storage/geometry-store.ts` (async + observable)
- `src/core/storage/structural-store.ts` (async + observable)
- `src/core/storage/wizard-builder-store.ts` (async + observable)
- `src/app/pages/WizardBuilderPage.tsx` (import path)
- `package.json` (vitest devDep + `test` script)
- `docs/architecture.md`
- `docs/dev-log.md`

### Recommended next step
- Wire the Wizard Builder save flow to `WizardStore.save` (now async + observable) so the dashboard can list saved wizards via `useSyncExternalStore`. Done as a UI-only / store-only change with no engine work.

---

## 2026-04-25 — Step: App Shell + UI Layer Audit/Fix

### Why this step
- The deployed GitHub Pages URL rendered as a blank white screen.
- UI styling and component structure were coupled directly inside feature files.
- We needed a visible shell and reusable visual layer without touching extraction/runtime logic.

### Root cause diagnosed
- GitHub Pages path resolution could break when build `base` did not match project-page repository paths.
- The app had no explicit shell-level visibility guarantees or mount-point diagnostics.

### What changed
- Added a visible app shell (`AppShell`) and dashboard (`HomeDashboardPage`) to ensure the app always renders clear content.
- Added centralized UI token and global style layers:
  - `src/core/ui/styles/tokens.css`
  - `src/core/ui/styles/global.css`
- Added reusable UI primitives:
  - `src/core/ui/components/Button.tsx`
  - `src/core/ui/components/Input.tsx`
  - `src/core/ui/components/Panel.tsx`
  - `src/core/ui/components/Section.tsx`
- Refactored Wizard Builder UI to consume shared components and feature-local CSS (`wizard-builder.css`).
- Updated Vite base handling to derive GitHub Pages repo path from `GITHUB_REPOSITORY` when present.
- Added `#root` mount check in `main.tsx` for easier diagnosis if app shell cannot mount.

### Boundaries preserved
- No extraction features added.
- No OCR, OpenCV, or PDF processing added.
- Wizard/business logic remained in contracts + store modules.

### Files created or modified
- Added: `src/core/ui/styles/tokens.css`
- Added: `src/core/ui/styles/global.css`
- Added: `src/core/ui/components/Button.tsx`
- Added: `src/core/ui/components/Input.tsx`
- Added: `src/core/ui/components/Panel.tsx`
- Added: `src/core/ui/components/Section.tsx`
- Added: `src/core/ui/layout/AppShell.tsx`
- Added: `src/app/pages/HomeDashboardPage.tsx`
- Added: `src/core/ui/wizard-builder/wizard-builder.css`
- Modified: `src/main.tsx`
- Modified: `src/app/App.tsx`
- Modified: `src/app/pages/WizardBuilderPage.tsx`
- Modified: `src/core/ui/wizard-builder/WizardBuilder.tsx`
- Modified: `src/app/routes.ts`
- Modified: `vite.config.ts`
- Modified: `docs/architecture.md`
- Modified: `docs/dev-log.md`

### Recommended next step
- Add simple shell navigation tabs (Dashboard / Wizard Builder / future modules) as a UI-only enhancement using existing shared components.

---

## 2026-04-25 — Step: GitHub Pages Deployment Pipeline Fix

### Why this step
- Production GitHub Pages was serving from the repository project path, but deployment/build wiring was incomplete for Vite static output, causing a missing built asset (`main.tsx` 404 symptom in browser console).
- Goal: enforce a deterministic Pages build-and-deploy flow and keep Vite asset URLs aligned with the repository path.

### What changed
- Added a dedicated GitHub Actions workflow at `.github/workflows/deploy-pages.yml`.
  - Triggers on push to `main` and manual dispatch.
  - Runs `npm ci` then `npm run build`.
  - Uploads `dist/` as Pages artifact.
  - Deploys artifact using GitHub Pages official deploy action.
- Updated `vite.config.ts` base configuration.
  - `base` is now always generated as `/<repo-name>/`.
  - Repository name resolves from `GITHUB_REPOSITORY` and falls back to `wrokit`.

### Boundaries preserved
- No product feature changes.
- No runtime/engine architecture changes.
- No extraction flow changes.

### Files created
- `.github/workflows/deploy-pages.yml`

### Files modified
- `vite.config.ts`
- `docs/dev-log.md`

### Recommended next step
- In repository settings, ensure GitHub Pages source is set to **GitHub Actions** so this workflow is authoritative for deployment.
