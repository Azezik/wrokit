
# Wrokit V2 Architecture Audit

## 1. Overall verdict: **minor cleanup with one focused restructuring**

The core spine is sound. NormalizedPage authority, page-surface coordinates, the shared `NormalizedPageViewport`, the `StructuralDebugOverlay`, and the OpenCV adapter isolation are all genuinely canonical and held to professionally. The pipeline drift is concentrated in three places: **(a)** Run Mode bypasses the canonical session store and runs a parallel localization engine that ignores the TransformationModel, **(b)** `StructuralModel v3.0` still carries a full set of legacy/deprecated fields that the type guard *requires*, and **(c)** documentation has fallen one major version behind the code. None of this requires a rewrite. It is correctable inside the existing contracts.

---

## 2. Pipeline integrity findings

- **Intake → NormalizedPage is properly one-way.** `normalization-engine.ts` always wraps via `toNormalizedPage`, and only `pdf-rasterizer.ts` imports `pdfjs-dist`. No downstream module branches on MIME, PDF metadata, or `sourceName` for logic. The intake boundary is honored.
- **PDF.js is correctly isolated to rasterization.** Worker URL is loaded via `?url`, runtime worker config is one-shot. No text-layer extraction.
- **NormalizedPage session store is canonical *only in Config Capture*.** `RunMode.tsx:51-52,213-216` keeps its own `runtimePages` state and hand-rolls a `surface:${sourceName}#${signature}` fingerprint that duplicates `buildDocumentFingerprint` from `normalized-page-session-store.ts:31-37`. This violates the doc rule "page-aware modules must consume `NormalizedPage` through this session authority."
- **`NormalizationIntake.tsx`** (`features/normalization/ui/`) is unmounted, never imported, and renders its own `<img>` outside `NormalizedPageViewport`. Dead but live in the tree → drift risk.
- **Run Mode produces three artifacts in parallel** (Runtime StructuralModel, TransformationModel, PredictedGeometryFile). The TransformationModel is computed and shown but **its `fieldAlignments` candidates are never consumed by `localization-runner`**. Localization re-derives anchor resolution itself (`localization-runner.ts:351-495`). Two engines, one document, divergent field placement is possible.
- **`imageBlobUrl`** is contract-supported (`normalized-page.ts:15`, viewport switches on it) but the engine never produces it. Half-implemented surface.

## 3. Coordinate / viewport / overlay findings

- **Single coordinate authority is upheld.** Every saved BBOX, structural rect, refined border, predicted box, and overlay rect is normalized `[0,1]` over the NormalizedPage surface and projected via `normalizedRectToScreen` from `page-surface.ts`. There is no CSS-only assumption, no canvas space, no PDF coordinate leaking through.
- **Pixel data is correctly derivative.** `pixelBbox` on `FieldGeometry` is a derived snapshot, not authority. The CV adapter receives a raster guaranteed to equal the surface dimensions (`page-raster-loader.ts`, `assertRasterMatchesSurface`).
- **`NormalizedPageViewport` is the single shared viewport authority.** It owns `getBoundingClientRect`-driven measurement, `ResizeObserver`, the overlay-plane sizing, pointer-to-image conversion, and resets `displayRect` on page identity change. Both Config Capture and Run Mode mount it. This part is genuinely solid.
- **Overlay drift is small but present.** `RunMode.tsx` and `ConfigCapture.tsx` each maintain their own `surfaceTransform` state and their own status-text construction string for adapter/cv-execution/runtime-load. The viewport itself is shared; the *status text* and *option state* are duplicated across features.

## 4. Overlay clarity / UX findings

- **The Simple/Advanced/Custom preset model is genuinely good.** `structural-overlay-options.ts` exports clean presets, the Custom pill correctly tracks divergence, line objects are off by default, low-confidence non-skeleton objects are filtered.
- **Per-type colors + hover-isolation work as intended** (`structural-debug-overlay.css`).
- **Real visual issues that hurt readability:**
  - `__object-label` is hard-pinned at `top: -1.1rem` with `position: absolute`. On dense pages, labels stack and overlap because there is no collision avoidance — the dev log even calls this out as the original problem, but the stacking issue still exists; only the toggle was hidden.
  - `__anchor-badge` (top-right) and `__match-badge` (bottom-right) sit at fixed corners; on small objects they obscure the rect itself. There is no size threshold.
  - `Refined (cv-content) · CV opencv-runtime` label at `top: -1.4rem` collides with the Border label when the refined border equals the page rect.
  - The `data-object-type` color palette is not WCAG-checked against the light page background; `line-horizontal/vertical` use `0.22` alpha and are nearly invisible until hovered.
  - The legend chip row in `StructuralOverlayControls` has no swatches inline — it relies on `data-swatch="…"` CSS which is not visible from the controls component (legend looks like text-only).
- **Config vs Run parity:** the two screens render the same engine output, but RunMode's status-list (~30 lines of adjacent `<li>` text) is heavier and noisier than Config Capture's single-line `statusText`. Same engine, two visual treatments.
- **No "advanced debug mode is off-by-default" story for predicted boxes**; predicted variant is hard-coded blue with a label of just `fieldId` — no confidence/tier/anchor-source visible without opening JSON.

## 5. StructuralModel / GeometryFile / TransformationModel findings

- **GeometryFile is correctly separate.** It is never mutated by structure, transformation, run mode, or OpenCV. Validation lives in `engines/geometry/validation.ts`; the engine confirms `pageSurface` matches the loaded NormalizedPage authority. This separation is genuinely clean.
- **Field BBOX semantics are correct.** Only human-confirmed user-drawn extraction boxes become FieldGeometry; predicted boxes go into a separate `PredictedGeometryFile` with `schema: 'wrokit/predicted-geometry-file'`.
- **StructuralModel v3.0 carries unfinished migration debt.** `structural-model.ts:96-222` and the `isStructuralFieldRelationship` guard *still require* the legacy fields (`bbox`, `containedBy`, `nearestObjects`, `relativePositionWithinParent`, `distanceToBorder`, `distanceToRefinedBorder`). They are marked `@deprecated` but mandatory. `localization-runner.ts:156` still reads `relationship.containedBy` for anchor priority. `object-hierarchy.ts:486-493` still emits all of them. This is precisely the "backwards-compatibility shim" the project rules forbid, baked into the persisted contract.
- **Border and Refined Border invariants are robust.** Engine never crops; expansion-on-disagreement is enforced; `containsAllSavedBBoxes` is a verifiable on-disk flag; sources are honestly tagged. Good.
- **TransformationModel is correctly read-only and separately persistable** — but its `fieldAlignments` candidate chain is unused. Either it should be the source of localization truth, or it should not be computed on every Run Mode click. Today it is decoration.

## 6. OpenCV / fallback findings

- **OpenCV.js isolation is real.** `opencv-js-adapter.ts` is the only file that touches `cv.*`. Engine never imports anything CV-specific.
- **CV execution mode is honestly persisted** as `cvExecutionMode: 'opencv-runtime' | 'heuristic-fallback'` per page, surfaced in the overlay status line.
- **Honesty gap:** when the runtime is unavailable and the heuristic path runs, `cvAdapter.name='opencv-js'` and `version='1.0'` are still written into the StructuralModel (`structural-engine.ts:288-291`). The model says "produced by opencv-js" while the per-page `cvExecutionMode` says "heuristic-fallback". The two fields contradict if read alone. The adapter identity should reflect what actually executed (e.g. `opencv-js` vs `heuristic-cpu`), or the cvAdapter ref should be at the page level.
- **No fake OpenCV.** The runtime check (`isLikelyOpenCvRuntime`) is duck-typed but reasonable. The fallback is clearly named `detectWithHeuristicFallback` and the line/contour algorithms are a different code path from the OpenCV one — not a stub.

## 7. Run Mode localization findings

- **Runtime structure is computed via the same `structural-runner` as Config.** Good — single composer.
- **TransformationModel is computed but not consumed.** `RunMode.tsx:248-260` calls `transformationRunner.compute(...)` then immediately calls `localizationRunner.run(...)` with the raw runtime model — the transformation result feeds nothing except the JSON preview and overlay match badges. `field-candidates.ts` builds an explicit fallback chain (matched-object → parent-object → refined-border → border) with confidences and rejected outliers — exactly what the localization runner needs but does not use.
- **Localization runner has its own parallel matcher.** `localization-runner.ts:351-397` (`resolveRuntimeObject`) re-implements config↔runtime object matching using a distance + ancestor-chain heuristic. `transformation/hierarchical-matcher.ts` does the same job with weighted similarity, hierarchical descent, and explicit confidence thresholds. Two parallel matchers. The doc explicitly says "transformation report does not influence localization in this phase," which formalizes the drift rather than fixes it.
- **Predicted geometry is correctly normalized and non-mutating** — output is a `PredictedGeometryFile`, never written back into the source GeometryFile.
- **Predicted boxes carry per-field `transform` and `anchorTierUsed`,** which is honest and useful.

## 8. Modularity / code organization findings

- **Engines are pure and contract-driven.** Geometry, Structure, and Normalization engines have no UI/store dependencies, all implement the canonical `Engine<I, O>` shape, and runners are the only composers. This part is professionally organized.
- **Stores are observable and async-mutator only.** Conformant.
- **Drift / cleanup items:**
  - **`docs/architecture.md` is one major version behind.** Says `StructuralModel v2.0 / wrokit/structure/v1`; code is `v3.0 / wrokit/structure/v2`. Says `version: '1.1'` for GeometryFile (matches), and never mentions TransformationModel's actual integration story with localization.
  - **`AGENTS.md` says "Do not implement real OpenCV.js".** The codebase now does support real OpenCV.js when present. Stale instruction.
  - **`src/app/routes.ts`** defines route constants but the app renders all four pages stacked inside `App.tsx` without a router. Routes constants are imported nowhere.
  - **`src/features/normalization/ui/NormalizationIntake.tsx`** is unmounted and renders its own `<img>` outside the canonical viewport. Either delete or wire it through `NormalizedPageViewport`.
  - **`src/demo/sample-wizard.ts`** sits in the source tree without being imported (verify before deletion).
  - **`localization-runner.ts:156-188`** reads the deprecated `relationship.containedBy` for priority math. Remove the deprecated branch or keep the field — pick one.
  - **`object-hierarchy.ts`** mirrors `bbox` and `objectRectNorm` on every node, doubling on-disk size and tempting future readers to use the wrong field.
  - **JSON previews in RunMode** are built with hand-rolled `JSON.stringify` instead of the existing `serializeStructuralModel` / IO helpers. Trivial drift.
- **Tests are in good shape:** 14 unit specs covering contracts, page-surface, structural engine, localization, transformation matcher, transformation consensus, transformation runner, structural overlay options, and CV adapter. No integration tests yet (`tests/integration/` is empty).

---

## 9. Recommended fixes — five phases

### Phase 1 — Per-stage NormalizedPage isolation + complete artifact set

> Replaces the original "Reunify Run Mode under canonical authorities" Phase 1.
> The original direction proposed *one shared* `NormalizedPageSessionStore` consumed by both Config Capture and Run Mode. That direction was rejected after architectural review: `NormalizedPage` is a calibrated *page-surface standard*, not a shared live document. Config and Run must each own their own active document; the only things crossing the stage boundary are explicit, downloadable, versioned artifacts. The shared elements should be pure helpers and pure UI primitives, not live state.
>
> Phase 1 is now executed as four small, low-risk sub-phases (1A → 1D). Each must complete before Phase 2 begins.

#### Phase 1A — De-singleton the NormalizedPage session store
- **Goal:** treat `NormalizedPageSessionStore` as a per-stage instance, not a module-level global, so each stage owns its own active document.
- **Issues addressed:** the module-level singleton at `src/core/storage/normalized-page-session-store.ts:92-95` violates the per-instance store convention used by every other store under `src/core/storage/`; it is latent cross-stage coupling that would activate the moment a second consumer mounts (e.g. if the original Phase 1 had been executed).
- **Files:** `src/core/storage/normalized-page-session-store.ts` (remove the module-level `normalizedPageSessionStore` instance and the `getNormalizedPageSessionStore` accessor; export only the `createNormalizedPageSessionStore` factory), `src/features/config-capture/ui/ConfigCapture.tsx` (instantiate via `useRef(createNormalizedPageSessionStore())` exactly like every other store), `docs/architecture.md` (replace "single session authority" wording with "single page-surface coordinate authority"; clarify that the canonical authority is `page-surface.ts` + `NormalizedPageViewport.tsx`, not the session store), `tests/unit/normalized-page-session-store.test.ts` (no behavior change; verify the factory remains correct).
- **Risk:** low. Config Capture is the only consumer today; behavior is unchanged because there was always exactly one mount.
- **Expected outcome:** every stage is artifact-driven and instance-isolated. Two stages running in the same browser, on different machines, or on different mounts behave identically.
- **Order rationale:** must come first. All later phases assume that no two stages share a live document.

#### Phase 1B — Extract pure shared helpers (no shared state)
- **Goal:** keep the deduplication wins around `documentFingerprint` and overlay status text without re-introducing any cross-stage runtime coupling.
- **Issues addressed:** (§2) duplicated fingerprint construction in `RunMode.tsx:213-216` vs `normalized-page-session-store.ts:31-37`; (§3) per-feature `statusText` strings drifting between `ConfigCapture.tsx` and `RunMode.tsx`.
- **Files:** new pure helper module under `src/core/page-surface/` (e.g. `page-surface-fingerprint.ts` exporting `buildDocumentFingerprint({ sourceName, pages })`); new `src/core/page-surface/ui/structural-status-text.ts` exporting a pure `buildStructuralStatusText({ structuralModel, page, runtimeLoadStatus, transformationModel? })`; both consumed from `ConfigCapture.tsx` and `RunMode.tsx` in place of inline construction.
- **Risk:** low. Pure functions only.
- **Expected outcome:** one fingerprint formula and one status-text formula in the codebase, both stateless, used by both stages without sharing live state.
- **Order rationale:** must come after Phase 1A so the fingerprint helper is consumed only by per-instance stores; must come before Phase 2 so the helper API is stable when localization starts consuming the TransformationModel.

#### Phase 1C — Complete the artifact set (close the portability gap)
- **Goal:** make every cross-stage artifact a first-class versioned contract with parse/serialize/download IO and a runtime guard, so the Computer-A → Computer-B → Computer-C portability test passes for every output, not just the three on the critical path.
- **Issues addressed:** `PredictedGeometryFile` defined inline in `localization-runner.ts:53-66` with no contract file, no `is*` guard, and no IO module; `TransformationModel` has full IO (`transformation-model-io.ts`) but no download/upload UI in Run Mode; runtime `StructuralModel` has no download UI; predicted-geometry download is hand-rolled in `RunMode.tsx:273-287`.
- **Files:** new `src/core/contracts/predicted-geometry-file.ts` (lift the type out of the runner; add `schema`, `version`, `isPredictedGeometryFile` guard); new `src/core/io/predicted-geometry-file-io.ts` (serialize/parse/download mirroring the other IO modules); update `src/core/runtime/localization-runner.ts` to import from the new contract; update `src/features/run-mode/ui/RunMode.tsx` to call `downloadPredictedGeometryFile`, `downloadTransformationModel`, and a runtime `downloadStructuralModel` (already exported from `structural-model-io.ts`); optional re-upload inputs for runtime StructuralModel / TransformationModel / PredictedGeometryFile for diagnostic replays; new contract tests under `tests/unit/contracts.test.ts`.
- **Risk:** low; additive only.
- **Expected outcome:** every output of every stage can be downloaded, re-uploaded, and re-validated by an `is*` guard. The artifact set itself is the handoff boundary — no UI state, no in-memory object, no shared session is required to move between machines.
- **Order rationale:** can run in parallel with Phase 1B; must be complete before Phase 2 so TransformationModel-driven localization has a stable, downloadable output contract for predicted geometry.

#### Phase 1D — Delete or wire dead surfaces
- **Goal:** remove unmounted/unused code paths so future readers cannot mistake them for live ones.
- **Issues addressed:** `src/features/normalization/ui/NormalizationIntake.tsx` is unmounted and renders an `<img>` outside the canonical viewport; `src/app/routes.ts` defines route constants imported nowhere because `App.tsx` mounts all four pages stacked with no router; `src/demo/sample-wizard.ts` may be orphaned (verify before deletion); `imageBlobUrl` on `NormalizedPage` is supported by the contract but never produced by the engine.
- **Files:** delete `src/features/normalization/ui/NormalizationIntake.tsx` and its CSS (or rewrite it through `NormalizedPageViewport` if a use case appears), delete `src/app/routes.ts` (or wire a real router), verify and delete `src/demo/sample-wizard.ts` if unused, drop `imageBlobUrl` from `src/core/contracts/normalized-page.ts` and simplify the viewport's image-src logic.
- **Risk:** low — removals only. None of these are mounted today.
- **Expected outcome:** the codebase only contains code that runs. No drift surface left for the next refactor.
- **Order rationale:** safe at this point because Phases 1A–1C have stabilized the canonical surface; deleting earlier risks taking out code that the new helpers or contracts still touch.

### Phase 2 — Make TransformationModel the source of truth for localization
- **Goal:** collapse the two parallel matchers into one. `localization-runner` should consume `TransformationModel.fieldAlignments` (already complete with confidences and fallback chain), not re-derive its own anchor resolution.
- **Issues addressed:** (§2 + §7) parallel matching engines; (§7) field-candidates is dead weight today.
- **Files:** `src/core/runtime/localization-runner.ts` (replace `resolveRuntimeObject`/`resolveFieldAnchor` with a thin consumer of `TransformationFieldAlignment.candidates`), `src/features/run-mode/ui/RunMode.tsx` (compute TransformationModel before localization and pass it in), `src/core/runtime/transformation/field-candidates.ts` (no change in math; possibly minor API surface), tests (`localization-runner.test.ts`).
- **Risk:** medium-high — touches the predicted-box path users see. Needs equivalence tests before removing the old code.
- **Expected outcome:** one matching engine, predicted boxes derived from explicit candidate confidences, the TransformationModel becomes load-bearing instead of decorative.
- **Order rationale:** Phase 2 begins only after Phases 1A–1D are all complete. The per-stage isolation (1A), pure shared helpers (1B), and full first-class artifact set (1C) together provide the stable foundation TransformationModel-driven localization depends on; 1D ensures no dead code path is co-evolved during this phase. Phase 2 must still precede Phase 3 because the legacy fields Phase 3 removes are read by the old localization path.

### Phase 3 — StructuralModel v4: drop the deprecated/legacy fields
- **Goal:** finish the migration that v3.0 started. Make the contract say what the engine actually authors today.
- **Issues addressed:** (§5) deprecated-but-required fields; (§8) doubled `bbox`/`objectRectNorm`; (§8) `containedBy` consumed by old localization.
- **Files:** `src/core/contracts/structural-model.ts` (bump to `version: '4.0'`, `structureVersion: 'wrokit/structure/v3'`, drop `bbox`, `containedBy`, `nearestObjects`, `relativePositionWithinParent`, `distanceToBorder`, `distanceToRefinedBorder`, `StructuralFieldRelativePosition`), `src/core/engines/structure/object-hierarchy.ts`, `src/core/engines/structure/structural-engine.ts`, `src/core/io/structural-model-io.ts`, all unit tests under `tests/unit/structural-*`, and any localization-runner reads of the legacy fields (only safe after Phase 2).
- **Risk:** medium — schema bump invalidates any saved StructuralModel JSON. Acceptable: nothing is in production.
- **Expected outcome:** every field in the persisted shape is authoritative, no contract bloat, no tempting wrong field to read.
- **Order rationale:** must come after Phase 2 because the deprecated fields are still consumed by today's localization path.

### Phase 4 — Honest CV provenance + dead-code purge
- **Goal:** make `cvAdapter` reflect what executed, and remove the unmounted/unused surfaces.
- **Issues addressed:** (§6) cvAdapter ref says `opencv-js` even when only the heuristic ran; (§8) `routes.ts` unused; (§8) `NormalizationIntake.tsx` unmounted; (§8) `imageBlobUrl` half-implemented; (§8) `sample-wizard.ts` orphaned (verify); (§8) RunMode's hand-rolled JSON.stringify previews.
- **Files:** `src/core/contracts/structural-model.ts` (move `cvAdapter` to per-page or split into `cvAdapter` + `cvExecutionMode`), `src/core/engines/structure/structural-engine.ts`, `src/core/contracts/normalized-page.ts` (drop `imageBlobUrl` until something writes it), `src/core/page-surface/ui/NormalizedPageViewport.tsx` (simplify image-src logic), delete `src/app/routes.ts` (or wire a real router), delete `src/features/normalization/ui/NormalizationIntake.tsx` + its CSS (or wire it via `NormalizedPageViewport`), `src/features/run-mode/ui/RunMode.tsx` (use `serializeStructuralModel` etc. for previews), `docs/architecture.md`, `AGENTS.md`, `docs/dev-log.md`.
- **Risk:** low — these are removals or label fixes.
- **Expected outcome:** the codebase only contains code that runs, the StructuralModel never claims an adapter that didn't actually execute, and AGENTS.md/architecture.md are honest about the present state.
- **Order rationale:** safe at this point because Phases 1–3 have settled what the canonical surface looks like; deleting earlier risks taking out code Phase 1 still needs.

### Phase 5 — Overlay UX refinement
- **Goal:** make the overlay feel like one professional monitor of the engine, not a debug dump.
- **Issues addressed:** (§4) label collisions; (§4) Border vs Refined label overlap; (§4) line-object near-invisibility; (§4) badges hiding small objects; (§4) Run Mode status-list noise; (§4) predicted-box label lacks tier/confidence; (§4) legend has no actual swatches.
- **Files:** `src/core/page-surface/ui/StructuralDebugOverlay.tsx`, `src/core/page-surface/ui/structural-debug-overlay.css`, `src/core/page-surface/ui/StructuralOverlayControls.tsx`, `src/core/page-surface/ui/structural-overlay-controls.css`, `src/features/run-mode/ui/RunMode.tsx` (compress status into `statusText`), `src/features/run-mode/ui/run-mode.css`, `src/features/config-capture/ui/config-capture.css`.
- **Concrete changes:** label-collision avoidance (pick top-vs-bottom anchor based on object bounds vs page edge), hide labels/badges below a min-area threshold, render legend chips with actual color swatches, fold Run Mode's status `<ul>` into one inline status line keyed off the same status helper Config uses, append `· tier · conf` to predicted-box labels, raise alpha on line-object strokes.
- **Risk:** low — visual-only, no contract or engine changes.
- **Expected outcome:** one visual treatment shared by Config and Run, readable on dense and sparse pages, simple-mode legible at a glance, advanced-mode honest without hiding small objects.
- **Order rationale:** last because it is the most user-facing and benefits from the simpler `TransformationModel`-driven data flow established in Phases 1–3.

---

## 10. Suggested Phase 1A prompt

> De-singleton the NormalizedPage session store so each stage owns its own active document. Do not unify Config and Run on a shared live session — `NormalizedPage` is a calibrated page-surface *standard*, not a shared live document. The shared elements should be pure helpers and pure UI primitives, not live state.
>
> Concretely:
> 1. In `src/core/storage/normalized-page-session-store.ts`, delete the module-level `normalizedPageSessionStore` instance and the `getNormalizedPageSessionStore` accessor (lines 92-95 of the current file). Export only the existing `createNormalizedPageSessionStore` factory.
> 2. In `src/features/config-capture/ui/ConfigCapture.tsx`, replace the `useRef(getNormalizedPageSessionStore())` call with `useRef(createNormalizedPageSessionStore())` so Config Capture instantiates its own session like every other store in the file (`createGeometryBuilderStore`, `createStructuralStore`).
> 3. Leave Run Mode unchanged. It already uses local React state (`runtimePages`, `runtimeDocumentFingerprint`, `selectedPageIndex`) and that is the correct artifact-driven shape.
> 4. Update `docs/architecture.md`: replace the "single session authority" / "page-aware modules must consume `NormalizedPage` through this session authority" wording with a "single page-surface coordinate authority" rule. The canonical authority is `src/core/page-surface/page-surface.ts` + `src/core/page-surface/ui/NormalizedPageViewport.tsx` (coordinate math + viewport), not the session store. Each stage owns its own session.
> 5. Confirm `tests/unit/normalized-page-session-store.test.ts` still passes; it already uses `createNormalizedPageSessionStore()` directly, so behavior should be unchanged.
> 6. Do not extract the shared fingerprint helper or the shared status-text helper in this phase — those land in Phase 1B. Do not add new contracts or IO — those land in Phase 1C. Do not delete unmounted surfaces — those land in Phase 1D.
>
> The deliverable for Phase 1A is one architectural change: the session store is no longer a global. No behavior change; only the latent cross-stage coupling potential is removed. Stop after Phase 1A and wait for confirmation before starting Phase 1B.

---

## 11. Should stay exactly as-is

- `src/core/engines/normalization/normalization-engine.ts` and `pdf-rasterizer.ts` — the intake boundary is honored cleanly. Do not touch.
- `src/core/page-surface/page-surface.ts` and `NormalizedPageViewport.tsx` — coordinate authority and the image-plane=overlay-plane invariant are correctly implemented and tested. Do not refactor.
- `src/core/engines/geometry/` and the `GeometryFile` contract (`version: '1.1'`) — separation from StructuralModel is genuinely clean and the validation is rigorous. Leave it.
- `src/core/engines/structure/cv/opencv-js-adapter.ts` and `opencv-js-runtime-loader.ts` — single-file CV containment, honest fallback, surface-aligned input. Do not move OpenCV out of this file or weaken the runtime check.
- The Border / Refined Border invariant logic in `structural-engine.ts:143-197` (expansion-on-disagreement, never-crop, source tagging, `containsAllSavedBBoxes` flag) — this is the ground-truth protection rule and it is correctly implemented.
- The `transformation/` submodules (`similarity.ts`, `hierarchical-matcher.ts`, `transform-math.ts`, `consensus.ts`, `field-candidates.ts`) — the math and structure are good. Phase 2 makes them load-bearing; the modules themselves should not change.
- The Simple/Advanced/Custom preset model in `structural-overlay-options.ts` — the design is right; only the rendering needs Phase 5 polish.
- The `Engine<I, O>` contract and the runner-as-only-composer rule — preserve strictly.

## Execution Rules (added by you)

- Follow phases in order
- Do not skip phases
- Do not redesign architecture
- Implement one phase at a time
- Stop after each phase
