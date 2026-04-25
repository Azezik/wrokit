# Wrokit Architecture (Current State)

## Project Mission
Wrokit is a modular, human-in-the-loop file ingestion engine where developers define extraction intent and users confirm field geometry.

## Core Principles
- Human-confirmed BBOX geometry is the highest authority.
- Modules stay isolated and communicate via typed contracts.
- UI does not own engine logic.
- Static-hosting compatible, browser-first, no backend required.

## Module Boundaries
- `src/core/contracts`: shared typed contracts. Each persisted contract carries `schema` + `version` and exports a runtime `is<Type>` guard.
- `src/core/io`: pure serialization / parsing / file-IO helpers (e.g. `wizard-file-io`). UI calls these; UI does not embed IO.
- `src/core/storage`: UI-agnostic stores. All store mutators are async. All stores expose `subscribe(listener)` and `getSnapshot()` so React can attach via `useSyncExternalStore` and a future persistence adapter is a drop-in.
- `src/core/engines`: pure transforms. Every engine implements the canonical `Engine<TInput, TOutput>` from `src/core/engines/engine.ts`. Engines never compose other engines and never reach into UI or storage.
- `src/core/runtime`: the only place engines are composed. Runners exist as boundaries: `config-runner`, `extraction-runner`, `localization-runner`, `ocr-runner`, `confidence-runner`. Most are stubs that throw `not implemented in foundation phase`.
- `src/core/ui/components`: reusable visual primitives (`Button`, `Input`, `Panel`, `Section`).
- `src/core/ui/layout`: app-wide layout wrappers (`AppShell`).
- `src/core/ui/styles`: centralized visual tokens + global base styles.
- `src/features/<feature>/ui`: feature-owned UI modules (`wizard-builder`, reserved `extraction-preview`, reserved `config-viewport`). Features import from `core/*`. `core/*` never imports from `features/*`.
- `src/app`: page composition and shell wiring only.

## Engines vs Runtime Rule
- An engine is a pure transform: one input contract, one output contract, no awareness of any other engine, no UI dependency, no store dependency.
- A runner is the *only* place engines are composed. If logic spans more than one engine, it lives in `src/core/runtime/`, not inside an engine module.
- This rule is what allows two agents to develop two engines in parallel without collision.

## Contract Versioning Rule
- Every persisted contract declares a literal `schema: 'wrokit/<name>'` and `version: '1.x'`.
- Every persisted contract exports an `is<Type>(value: unknown): value is <Type>` runtime guard.
- The current version for every contract is `1.0`.

## Store Pattern
- Stores are observable. Public surface: async mutators returning `Promise<void>`, `getSnapshot(): TSnapshot`, `subscribe(listener): () => void`.
- The base shape lives in `src/core/storage/observable-store.ts`.
- React consumers attach via `useSyncExternalStore(store.subscribe, store.getSnapshot)`.
- Current implementations are in-memory; persistence adapters can be substituted without changing consumers.

## UI Organization Rules
- Visual tokens (colors, spacing, borders, shadows, radii, font sizes) are defined in `src/core/ui/styles/tokens.css`.
- Global element defaults and shared classes live in `src/core/ui/styles/global.css`.
- Reusable UI primitives are imported by feature UIs; feature UIs do not redefine core styling systems.
- Feature-specific UI styling lives beside each feature (e.g., `src/features/wizard-builder/ui/wizard-builder.css`).
- Business logic stays in stores/contracts/io and is consumed by UI through typed interfaces.

## Data Contracts
- `WizardFile` (`src/core/contracts/wizard.ts`): `schema: 'wrokit/wizard-file'`, `version: '1.0'`, `wizardName`, `fields: WizardField[]`. Guard: `isWizardFile`.
- `NormalizedPage` (`src/core/contracts/normalized-page.ts`): `schema: 'wrokit/normalized-page'`, `version: '1.0'`. Guard: `isNormalizedPage`.
- `GeometryFile` (`src/core/contracts/geometry.ts`): `schema: 'wrokit/geometry-file'`, `version: '1.0'`. Guard: `isGeometryFile`.
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

## Current Implementation Status
Implemented:
- Visible app shell + dashboard module status page.
- Wizard Builder feature wired through reusable UI components and the IO module.
- Shared tokenized styling system.
- Versioned + guarded contracts for all five persisted shapes.
- Async observable stores with subscribe/snapshot.
- Canonical `Engine<I, O>` interface.
- Runtime stubs for extraction, config, localization, OCR, confidence.

Not yet implemented:
- Document intake.
- Geometry capture.
- Structural model generation.
- Real engines.
- Runtime localization and OCR readout.
- Persistence adapter.
