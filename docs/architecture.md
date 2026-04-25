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
- `src/core/ui/components`: reusable visual primitives (`Button`, `Input`, `Panel`, `Section`).
- `src/core/ui/layout`: app-wide layout wrappers (`AppShell`).
- `src/core/ui/styles`: centralized visual tokens + global base styles.
- `src/core/ui/wizard-builder`: feature-specific Wizard Builder UI module.
- `src/app`: page composition and shell wiring.

## UI Organization Rules
- Visual tokens (colors, spacing, borders, shadows, radii, font sizes) are defined in `src/core/ui/styles/tokens.css`.
- Global element defaults and shared classes live in `src/core/ui/styles/global.css`.
- Reusable UI primitives are imported by feature UIs; feature UIs do not redefine core styling systems.
- Feature-specific UI styling lives beside each feature (e.g., `src/core/ui/wizard-builder/wizard-builder.css`).
- Business logic remains in stores/contracts and is consumed by UI through typed interfaces.

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

## App Shell and Static Hosting
- The app now mounts into a visible `AppShell` with explicit header/content regions.
- `main.tsx` validates `#root` mount existence early and throws a clear error if missing.
- Vite `base` resolves from `GITHUB_REPOSITORY` when available (`/<repo>/`) and falls back to `./`, improving GitHub Pages path reliability while preserving static hosting.

## Current Implementation Status
Implemented:
- Visible app shell + dashboard module status page.
- Wizard Builder feature wired through reusable UI components.
- Shared tokenized styling system.

Not yet implemented:
- Document intake.
- Geometry capture.
- Structural model generation.
- Runtime localization and OCR readout.
