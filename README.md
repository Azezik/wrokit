# Wrokit V2

Wrokit V2 is a browser-based, static-hosting-friendly TypeScript application for modular human-in-the-loop file ingestion.

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
- `wizard.ts` → `WizardFile`, `WizardField`, `isWizardFile`
- `normalized-page.ts` → `NormalizedPage`
- `geometry.ts` → `GeometryFile`, `FieldGeometry`
- `structural-model.ts` → `StructuralModel`
- `extraction-result.ts` → `ExtractionResult`

### Runtime (`src/core/runtime`)
- `config-runner.ts` (wizard config loading boundary)
- `extraction-runner.ts` (future extraction orchestration boundary)

Extraction runtime is intentionally not implemented in this phase.

### Storage (`src/core/storage`)
- `wizard-store.ts` in-memory wizard registry
- `wizard-builder-store.ts` UI-agnostic state operations for builder actions
- `geometry-store.ts` and `structural-store.ts` placeholders

### UI (`src/core/ui`)
- `wizard-builder/WizardBuilder.tsx` first real module
- other UI areas remain reserved for future modules

## Wizard Builder (Implemented)

The current app renders the Wizard Builder module:
- set wizard name
- add/remove/reorder fields
- edit `fieldId`, `label`, `type` (`text | numeric | any`), `required`
- generate live `WizardFile` JSON preview
- download `WizardFile` JSON
- import existing `WizardFile` JSON with contract validation

## Project Docs

- `docs/architecture.md` → concise source-of-truth architecture snapshot
- `docs/dev-log.md` → append-only chronological implementation log

## Suggested Next Steps

1. Add local persistence adapter for wizard definitions.
2. Add wizard load/list UI flow.
3. Add normalized page intake contract flow.
4. Add geometry capture UI with explicit save semantics.
