# Wrokit Architecture (Current State)

## Project Mission
Wrokit is a modular, human-in-the-loop file ingestion engine where developers define extraction intent and users confirm field geometry.

## Core Principles
- Human-confirmed BBOX geometry is the highest authority.
- Modules stay isolated and communicate via typed contracts.
- UI does not own engine logic.
- Static-hosting compatible, browser-first, no backend required.

## Module Boundaries
- `src/core/contracts`: shared typed contracts.
- `src/core/storage`: UI-agnostic state and persistence abstractions.
- `src/core/runtime`: orchestration boundaries (not fully implemented).
- `src/core/ui/wizard-builder`: Wizard Builder UI module only.
- `src/app`: app shell/page composition.

## Data Contracts
- `WizardFile` (`src/core/contracts/wizard.ts`):
  - `schema: 'wrokit/wizard-file'`
  - `version: '1.0'`
  - `wizardName: string`
  - `fields: WizardField[]`
- `WizardField`:
  - `fieldId: string`
  - `label: string`
  - `type: 'text' | 'numeric' | 'any'`
  - `required: boolean`

## Current Repo Structure
- `src/app`: app root + page wiring.
- `src/core/contracts`: wizard, geometry, normalized page, structural model, extraction result.
- `src/core/storage`: wizard storage and wizard-builder state store.
- `src/core/ui/wizard-builder`: Wizard Builder component.
- `src/core/runtime`: placeholders.
- `docs`: architecture + implementation history.

## Current Implementation Status
Implemented:
- First real module: Wizard Builder.
- Add/remove/reorder fields.
- Live `WizardFile` JSON preview.
- Import/export JSON support.

Not yet implemented:
- Document intake.
- Geometry capture.
- Structural model generation.
- Runtime localization and OCR readout.

## Future Planned Layers
1. Normalized page intake.
2. Geometry capture and persistence.
3. Structural model generation (separate from geometry truth).
4. Runtime localization.
5. OCR readout and confidence model.
