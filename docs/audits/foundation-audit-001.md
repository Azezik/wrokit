# Foundation Audit 001

## 1. Audit date
2026-04-25.

## 2. Repo stage
Foundation. Wrokit V2, post-initial scaffolding, post-app-shell fix, pre-extraction. Wizard Builder is the only implemented feature. No engines, no runtime composition, no persistence, no real OCR/geometry/structure work.

## 3. Verdict
**Needs minor cleanup.** Boundaries were largely correct. Eight specific drift vectors were identified as "fix now" because each one would have forced an expensive rewrite the moment a second engine, a persistence adapter, or a second feature UI landed. All eight are resolved in this pass. Two items (R7, R9) were deferred as low-cost-later.

## 4. Current architecture summary (post-fix)

### Folder / module boundaries
```
src/
  app/                        page composition + shell wiring only
    pages/
    App.tsx
    routes.ts
  core/
    contracts/                versioned + guarded typed contracts
    io/                       pure serialization / parsing / file-IO
    engines/                  pure transforms; engine.ts holds canonical Engine<I,O>
      {ocr,geometry,structure,normalization,localization,confidence}/  reserved
    runtime/                  ONLY place engines are composed (stubs only today)
    storage/                  observable async stores
    ui/
      components/             reusable primitives
      layout/                 app-wide layout
      styles/                 tokens + global css
  features/
    wizard-builder/ui/        the only implemented feature UI
    extraction-preview/ui/    reserved
    config-viewport/ui/       reserved
  demo/                       sample fixture (currently unreferenced)
  main.tsx
tests/
  unit/                       contract guard tests
  integration/                reserved
  fixtures/                   reserved
docs/
  architecture.md             current-state snapshot
  dev-log.md                  append-only chronological log
  audits/                     audit checkpoints (this file)
```

Core never imports from features. Features never import from app. Engines never import other engines. UI never embeds IO or business logic.

### Contract system
- Every persisted contract carries `schema: 'wrokit/<name>'` and `version: '1.0'`.
- Every persisted contract exports a runtime guard `is<Type>(value: unknown): value is <Type>`.
- Five contracts present: `WizardFile`, `NormalizedPage`, `GeometryFile`, `StructuralModel`, `ExtractionResult`.
- Guards are tested in `tests/unit/contracts.test.ts`.

### Engine system
- Canonical interface in `src/core/engines/engine.ts`:
  ```ts
  interface Engine<TInput, TOutput> {
    readonly name: string;
    readonly version: string;
    run(input: TInput): Promise<TOutput>;
    cancel?(): void;
  }
  ```
- Six engine slots reserved: `ocr/`, `geometry/`, `structure/`, `normalization/`, `localization/`, `confidence/`. All currently empty `.gitkeep` placeholders. Each engine, when implemented, must implement `Engine<I, O>` and must not depend on any other engine.

### Store system
- Common shape: `src/core/storage/observable-store.ts` exports `ObservableStore<TSnapshot>` with `getSnapshot()` and `subscribe(listener)`.
- All stores expose async mutators returning `Promise<void>` plus `getSnapshot` + `subscribe`.
- Stores: `wizard-store`, `wizard-builder-store`, `geometry-store`, `structural-store`. All in-memory today; persistence adapters will be drop-ins because the public surface is already async + observable.
- React consumers attach via `useSyncExternalStore(store.subscribe, store.getSnapshot)`.

### UI layering
- `src/core/ui/` holds only primitives (`components/`), layout (`layout/`), and styles (`styles/`).
- All feature UIs live under `src/features/<feature>/ui/`.
- IO logic (file download, JSON parse) lives in `src/core/io/`, not in components.
- Tokens drive all visual styling; feature CSS sits beside the feature.

### Docs system
- `docs/architecture.md` — current-state snapshot, must match code.
- `docs/dev-log.md` — append-only chronological history.
- `docs/audits/` — checkpoint snapshots (this file is the first).
- `AGENTS.md` — non-negotiable rules and forbidden shortcuts.
- `README.md` — outward-facing project description.

## 5. Risks found

| ID | Title | Where | Why risky |
|----|-------|-------|-----------|
| R1 | Business logic in `WizardBuilder.tsx` | UI component | UI owned serialization + download IO; would propagate to OCR/Geometry features |
| R2 | Stores are sync, mutable, component-scoped | `wizard-builder-store` + consumers | Adding persistence would break every consumer signature |
| R3 | Schema/version inconsistent across contracts | `geometry`, `structural-model`, `extraction-result`, `normalized-page` | No way to detect or migrate older saved files |
| R4 | No canonical engine interface | `engines/` empty | Six future engines would diverge in shape |
| R5 | `core/ui/` mixed primitives + feature UIs | `core/ui/wizard-builder/` etc. | Two agents collide on `core/ui` ownership |
| R6 | Runtime layer underspecified | `runtime/` had only two stubs | Localization / OCR / confidence had no orchestration boundary |
| R7 | `vite.config.ts` base derived from CI-only env | `vite.config.ts` | Local builds and CI builds silently produce different asset paths |
| R8 | No test runner despite `tests/` folders | `package.json` | Contracts cannot be enforced |
| R9 | Unreferenced `src/demo/sample-wizard.ts` | `src/demo/` | Risk of dead-code drift |
| R10 | Storage interface in-memory by abstraction | `wizard-store` etc. | Persistence change becomes breaking |

## 6. Fixes recommended
- Now: R1, R2, R3, R4, R5, R6, R8, R10.
- Later: R7, R9.

## 7. Fixes implemented in this pass
- **R1 (done)** — Created `src/core/io/wizard-file-io.ts` with `serializeWizardFile`, `parseWizardFile`, `wizardFileDownloadName`, `downloadWizardFile`, plus a `WizardFileParseError`. UI now calls these instead of building Blobs and parsing JSON inline.
- **R2 + R10 (done)** — Created `src/core/storage/observable-store.ts` with the canonical `ObservableStore<TSnapshot>` shape. All stores (`wizard-store`, `wizard-builder-store`, `geometry-store`, `structural-store`) refactored to async mutators + `subscribe` + `getSnapshot`. `WizardBuilder` consumes via `useSyncExternalStore`.
- **R3 (done)** — `NormalizedPage`, `GeometryFile`, `StructuralModel`, `ExtractionResult` now carry `schema: 'wrokit/<name>'` + `version: '1.0'`. Each exports `is<Type>` runtime guard.
- **R4 (done)** — Added `src/core/engines/engine.ts` with `Engine<TInput, TOutput>`. All future engines must implement it.
- **R5 (done)** — Moved `WizardBuilder.tsx` and `wizard-builder.css` from `src/core/ui/wizard-builder/` to `src/features/wizard-builder/ui/`. Reserved `extraction-preview/` and `config-viewport/` placeholders moved to `src/features/<name>/ui/.gitkeep`. `core/ui/` now contains only `components/`, `layout/`, and `styles/`.
- **R6 (done)** — Added stub `localization-runner.ts`, `ocr-runner.ts`, `confidence-runner.ts` in `src/core/runtime/`. All throw `not implemented in foundation phase`. Architecture doc now states the rule: engines are pure, runtime is the only place engines are composed.
- **R8 (done)** — Added Vitest dev-dep, `vitest.config.ts`, `npm test` script, and `tests/unit/contracts.test.ts` with positive + negative cases for every `is<Type>` guard.

## 8. Deferred items
- **R7** — Vite `base` env handling. Current behavior works under GitHub Actions; revisit when manual builds or sub-path hosting are needed.
- **R9** — `src/demo/sample-wizard.ts` is unreferenced. Resolve when wiring an "Insert sample" UI affordance, or move to `tests/fixtures/` if it remains dormant.

## 9. What is working well
- AGENTS.md continues to be a strong, opinionated rulebook with explicit forbidden shortcuts. Keep it.
- Contracts live in five small dedicated files — no kitchen-sink contract module.
- `runtime/` correctly stays a thin boundary; nothing pretends to be implemented.
- Tokenized CSS pattern (one tokens.css + one global.css + per-feature CSS) is clean.
- `main.tsx` fails loudly on missing mount point — the right default for static hosting.
- Append-only dev-log and current-state architecture doc exist and are consistent with code.
- React + Vite + TypeScript with no router, no state library, no backend — no premature dependencies.

## 10. What future audits should specifically watch for
1. **Cross-engine imports.** If any file under `src/core/engines/<a>/` imports from `src/core/engines/<b>/`, the engines-are-pure rule has been broken. All composition must live in `src/core/runtime/`.
2. **Feature → core direction only.** Nothing under `src/core/` may import from `src/features/`. Nothing under `src/features/<a>/` may import from `src/features/<b>/`.
3. **UI components embedding IO.** Any `URL.createObjectURL`, `JSON.parse`, `fetch`, `localStorage`, or `IndexedDB` usage inside a `.tsx` file is a regression of R1. IO belongs in `src/core/io/` or `src/core/storage/`.
4. **Sync store mutators.** Any new store method that returns state synchronously instead of `Promise<void>` is a regression of R2 and will break the day a real persistence adapter lands.
5. **Contracts without `schema`/`version`/`is<Type>`.** Any new persisted contract that omits these is a regression of R3.
6. **Engines that don't implement `Engine<I, O>`.** Any new module under `src/core/engines/<name>/` must export a factory whose return value satisfies the canonical interface.
7. **Junk-drawer modules.** Watch for `utils.ts`, `helpers.ts`, `common.ts`, or any `lib/` folder with mixed concerns. Contracts, IO, storage, and engines each have a home; nothing else needs one.
8. **Runners that import each other.** Runners may import engines and contracts. Runners must not import other runners — that creates orchestration-of-orchestration which is the textbook monolith path.
9. **Feature UIs reaching into another feature's folder.** Each feature UI must depend only on `src/core/*`. If `wizard-builder/ui` ever imports from `extraction-preview/ui`, the shared piece belongs in `core/`.
10. **AGENTS.md drift.** If new code violates a rule, the right move is to fix the code, not soften the rule.
11. **`src/demo/`** growth without references — it should either become real fixtures under `tests/fixtures/` or be pruned.

## 11. Recommended next checkpoint timing
Run **Foundation Audit 002** when *any* of the following first happens:
- the first real engine is implemented (e.g. geometry capture or normalization), or
- the first persistence adapter (IndexedDB / localStorage) is added, or
- the second feature UI is added under `src/features/`, or
- 30 days from this audit (2026-05-25), whichever comes first.

Whichever trigger fires, compare the then-current `architecture.md` against the "Current architecture summary" section above and confirm none of the watch items in section 10 have regressed. Save the result as `docs/audits/foundation-audit-002.md`.
