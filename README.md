# Wrokit V2 (Foundation)

Wrokit V2 is starting as a browser-based, static-hosting-friendly TypeScript application.

This repository currently provides only the architectural foundation:
- modular folder structure
- typed contracts across layers
- placeholder engine/runtime/storage boundaries
- no backend or server dependencies

## Tech Stack

- Vite
- React
- TypeScript
- Static hosting compatible (`vite build` output can be served by GitHub Pages)

## GitHub Pages Compatibility

The Vite config uses `base: './'` so built assets resolve relative to the deployed path.

No backend, database, or private environment variables are required at this stage.

## Architecture Overview

The project is split into isolated modules under `src/core`.

### Contracts (`src/core/contracts`)
Defines shared typed boundaries:
- `wizard.ts` → `WizardFile`, `WizardField`
- `normalized-page.ts` → `NormalizedPage`
- `geometry.ts` → `GeometryFile`, `FieldGeometry`
- `structural-model.ts` → `StructuralModel`
- `extraction-result.ts` → `ExtractionResult`

### Engines (`src/core/engines`)
Placeholder directories for future implementation:
- normalization
- geometry
- structure
- localization
- ocr
- confidence

### Runtime (`src/core/runtime`)
- `config-runner.ts` (wizard config loading boundary)
- `extraction-runner.ts` (future extraction orchestration boundary)

Extraction runtime is intentionally not implemented in this foundation phase.

### Storage (`src/core/storage`)
In-memory placeholder stores for:
- wizard definitions
- geometry files
- structural models

These provide simple interfaces and can later be replaced by browser persistence or remote adapters.

### UI (`src/core/ui`)
Reserved folders for future modular UI components:
- shared components
- wizard builder
- config viewport
- extraction preview

### Demo (`src/demo`)
`sample-wizard.ts` provides a minimal typed wizard example for early development.

## Current App

`src/app/App.tsx` renders a minimal foundation screen only.

No OCR, OpenCV, PDF.js text extraction, runtime extraction, or structural detection is implemented.

## Suggested Next Steps

1. Add Wizard Builder UI using `WizardFile` contracts.
2. Add normalized page intake contract flow.
3. Add geometry capture UI with explicit save semantics.
4. Add structural model generation placeholders that remain separate from geometry truth.
5. Add tests per module as each feature lands.
