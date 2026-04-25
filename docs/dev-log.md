# Wrokit Development Log

## 2026-04-25 — Step: Wizard Builder (First Real Module)

### What was added
- Added Wizard Builder UI module for creating `WizardFile` definitions.
- Added support for wizard naming and field editing (`fieldId`, `label`, `type`, `required`).
- Added field list operations: add, remove, and reorder.
- Added live JSON preview generated from store state.
- Added JSON download (export) and JSON import (with schema validation).
- Added initial persistent documentation files under `/docs`.

### Files created or modified
- Modified: `src/core/contracts/wizard.ts`
- Modified: `src/core/storage/wizard-store.ts`
- Added: `src/core/storage/wizard-builder-store.ts`
- Added: `src/core/ui/wizard-builder/WizardBuilder.tsx`
- Added: `src/app/pages/WizardBuilderPage.tsx`
- Modified: `src/app/App.tsx`
- Modified: `src/app/routes.ts`
- Modified: `src/demo/sample-wizard.ts`
- Added: `docs/architecture.md`
- Added: `docs/dev-log.md`
- Modified: `README.md`

### Contracts introduced or changed
- Changed `WizardFile` contract to a focused builder-stage schema:
  - `schema`, `version`, `wizardName`, `fields`
- Changed `WizardField` contract to required builder fields:
  - `fieldId`, `label`, `type`, `required`
- Added `isWizardFile` contract validator for JSON import boundary.

### Architectural decisions made
- Kept Wizard Builder logic UI-agnostic in `src/core/storage/wizard-builder-store.ts`.
- Kept Wizard Builder module isolated from config/extraction runtime.
- Kept typed contracts as the authority for UI + import/export compatibility.
- Preserved static-hosting and no-backend constraints.

### Known limitations
- No persistent browser storage yet (state is in-memory for current session).
- No route navigation UI; app currently renders Wizard Builder page directly.
- No runtime extraction integration yet by design.

### Recommended next step
- Add local persistence adapter (e.g., `localStorage`) behind `WizardStore` interface and a wizard-list selector UI for load/edit flows.
