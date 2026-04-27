## 2026-04-27 — Fix: Run Mode containment-chain authority for field anchors

### Why this step
- Run Mode was emitting predicted Field BBOXes in random-looking locations even when Config detected a useful larger structural object, the Field BBOX clearly sat inside that object, and Run Mode detected the same object on the runtime document.
- The relational chain `Field → containing object → parent → Refined Border → Border` was being **stored** in `StructuralModel` but not **used** as the source of stable anchors.

### Root cause
- `buildFieldRelationships` in `src/core/engines/structure/object-hierarchy.ts` built `stableObjectAnchors` (`A`, `B`, `C`) from `nearestObjects(field, MAX_FIELD_ANCHORS)` — i.e. the three objects whose centers were closest to the field. The actual containment chain (smallest enclosing object → its parent → its grandparent) was recorded only in the legacy `containedBy` scalar, not as anchor authority.
- Consequence: a field that genuinely sat inside `tray ⊂ drawer ⊂ counter` could end up with anchors `A=nearby header`, `B=adjacent line`, `C=tray`. `relativeFieldRect` for `A` was then computed against an object that did not actually contain the field, so its `xRatio/yRatio/wRatio/hRatio` were geometrically meaningless. Projecting that relative rect through the runtime equivalent of `nearby header` placed the predicted box at a location that bore no relationship to where the field really lives — exactly the "weird/random" symptom reported.
- `localization-runner.resolveAnchorPriority` did try to re-rank A/B/C by `containedBy`, but only when the actual container was already in the A/B/C list. If center-distance ranking pushed the real container out of the top 3, the runner had nothing to re-rank to.
- Object matching across Config↔Runtime considered immediate-parent type but not the full ancestor chain. Two runtime objects of the same type with similar geometry but completely different ancestry could be picked interchangeably.

### Fix
- `src/core/engines/structure/object-hierarchy.ts`:
  - New `buildContainmentChain(field, objects, limit)` walks `direct container → parent → grandparent` outward and is now the authoritative source for stable anchors `A → B → C`.
  - New `selectFallbackAnchorObjects(field, objects, excludeIds, needed)` only fills slots the chain leaves empty, preferring (a) other containers, (b) overlapping objects, (c) nearest objects as last resort. Pure center-distance ranking is no longer the primary signal for any anchor slot.
  - `buildFieldRelationships` now produces `objectAnchors[*].rank = primary|secondary|tertiary` and `stableObjectAnchors[*].label = A|B|C` from `[...containmentChain, ...supplemental]`. Each `relativeFieldRect` is computed against its own anchor's `objectRectNorm`, so for true chain anchors ratios are guaranteed to live in `[0, 1]`.
  - Legacy `containedBy` is set to the chain's direct container, mirroring `A.objectId`. `nearestObjects` is still emitted in the legacy slot for backward-compat readers.
- `src/core/runtime/localization-runner.ts`:
  - New `getAncestorTypeChain(page, objectId)` and `ancestorChainMismatchCount(...)` add full-chain ancestor-type comparison to `hierarchyRoleDistance`, ahead of every other criterion. A runtime object whose ancestry matches `[container, container, container]` now beats one that only happens to share the immediate parent type.
  - The sort tuple in `resolveRuntimeObject` is now `[ancestorChainPenalty, childPresencePenalty, depthPenalty, parentTypePenalty]`, then geometry distance, then objectId for determinism. Distance is no longer the primary criterion.
  - Anchor fallback order remains the deterministic `A → B → C → Refined Border → Border`. Because `A` is now guaranteed to be the direct container (or the best-available containing object), the same chain `field → A → B → C → Refined → Border` is what Run Mode actually walks.

### Architecture answers
1. **Why Run Mode was projecting boxes incorrectly.** Stable anchors `A/B/C` were nearest-by-distance, not the containment chain, so `relativeFieldRect` was being computed against objects that didn't actually enclose the field. Projecting through a non-containing anchor at runtime placed predicted boxes anywhere.
2. **Whether relationship data was missing or just unused.** Largely *unused*. Parent/child links, containment, refined-border-to-border, object-to-refined-border, and per-field anchor slots were already in `StructuralModel v3.0`. The chain just wasn't driving anchor selection.
3. **How Field BBOX relative-to-object anchors are now stored.** `fieldAnchors.stableObjectAnchors[0|1|2]` carries the field's `relativeFieldRect` against the **direct container**, **its parent**, **its grandparent** (in that order). `fieldAnchors.refinedBorderAnchor` and `fieldAnchors.borderAnchor` carry the same field expressed relative to Refined Border and Border. `pageAnchorRelations` carries object→object, object→refined-border, and refined-border→border relative geometry independent of any field.
4. **How Run Mode uses those anchors.** `localization-runner.resolveFieldAnchor` walks `A → B → C` deterministically, using each anchor's `relativeFieldRect` projected through the runtime equivalent of that anchor's `objectRectNorm`. If no anchor in the chain resolves on the runtime page, it falls back to projecting via Refined Border, then Border.
5. **How fallback works when a child object is missing.** If `A` cannot be resolved on the runtime page (no ID match and no structural match by type+ancestor chain), the runner moves to `B`. If `B` also cannot be resolved, it moves to `C`. If no chain anchor resolves, it projects the saved `refinedBorderAnchor.relativeFieldRect` through the runtime Refined Border. If even that is unavailable on the legacy model shape, it projects through Border.
6. **How Border / Refined Border remain part of the chain.** Border is always `{0,0,1,1}` and Refined Border is always anchored to Border via `pageAnchorRelations.refinedBorderToBorder.relativeRect`. Every object additionally carries its own relative geometry to Refined Border in `pageAnchorRelations.objectToRefinedBorder[]`. So the chain `field → A → B → C → Refined Border → Border` is fully traversable from any anchor up to page authority.
7. **Whether OpenCV object detection is consistent between Config and Run.** Yes. Both screens consume `createStructuralRunner()` which is the only composer for the OpenCV.js adapter. The same `surfaceRectToNormalized` path converts CV pixel output to canonical normalized rects in both places. Object IDs are not stable across documents (CV emits IDs per run), which is exactly why structural matching falls back to type + ancestor-type chain rather than relying on ID.

### Files modified
- `src/core/engines/structure/object-hierarchy.ts` (new chain-authority anchor builder + supplemental-fill helper, exported `__testing` for unit coverage)
- `src/core/runtime/localization-runner.ts` (ancestor-type chain match in `hierarchyRoleDistance`, refactored sort tuple in `resolveRuntimeObject`)
- `tests/unit/structural-engine.test.ts` (two new tests: chain-ordered anchor production, fallback-fill behavior when chain is short)
- `tests/unit/localization-runner.test.ts` (two new tests: end-to-end chain projection lands inside runtime container; ancestor-chain match beats geometric proximity)
- `docs/architecture.md` (new "Containment Chain Authority for Field Anchors" section)
- `docs/dev-log.md`

### Boundaries preserved
- No mutation of `GeometryFile` and no movement of saved Field BBOXes in Config.
- No OCR added; no visual overlay hacks; no parallel coordinate system; no PDF-vs-image branching; no weakening of `NormalizedPage`/page-surface authority.
- `StructuralModel` schema is unchanged (still v3.0 / `wrokit/structure/v2`); only the *content* of `stableObjectAnchors` and `objectAnchors` changes for newly produced models. The contract guard already required canonical `A/B/C` and `primary/secondary/tertiary` ordering and continues to enforce that.
- Refined Border and Border invariants unchanged: containment-of-saved-BBOXes still enforced by the engine, never cropped.
- OpenCV.js stays inside `cv/opencv-js-adapter.ts`. Structural runner is still the only composer.

### Checks run
- `npm run check` (`tsc --noEmit`): clean.
- `npm test` (vitest): 70/70 passing (66 prior + 4 new).
- `npm run build` (`tsc -b && vite build`): clean.

---

## 2026-04-27 — OpenCV execution honesty + unified structural overlay renderer

### Why this step
- Structural execution provenance was ambiguous: UI showed `opencv-js` adapter identity even when runtime detection could silently fall back to heuristics.
- Config Capture and Run Mode had separate structural overlay implementations, which drifted in rendered layers and readability defaults.
- Goal: make CV execution mode explicit/persisted and enforce one shared structural overlay renderer across both screens.

### What changed
- **OpenCV runtime load + provenance**
  - Added `src/core/engines/structure/cv/opencv-js-runtime-loader.ts`:
    - best-effort browser runtime loading by script injection,
    - explicit status reporting (`loaded`, `already-available`, `unavailable`),
    - no hard failure when runtime is missing.
  - `src/core/runtime/structural-runner.ts` now attempts runtime loading before compute and exposes load status for UI reporting.
  - `CvContentRectResult` now carries `executionMode: 'opencv-runtime' | 'heuristic-fallback'`.
  - `StructuralPage` now persists `cvExecutionMode` so each page records actual structural execution source.
- **Single shared structural overlay system**
  - Added `src/core/page-surface/ui/StructuralDebugOverlay.tsx` and shared styles.
  - Both `ConfigCapture` and `RunMode` now render structural overlays through this component only.
  - Shared renderer supports:
    - Border + Refined Border
    - Structural objects
    - Optional labels + containment chains
    - Saved/predicted field boxes
    - CV execution mode display in refined label
- **Readable defaults + common toggles**
  - Added the same debug controls in Config and Run:
    - Show Structural Objects
    - Show Line Objects
    - Show All Objects
    - Show Object Labels
    - Show Containment Chains
  - Default settings are readability-first:
    - objects shown with filtered visibility (high confidence + structural container types),
    - labels/chains off,
    - line objects off.
- **Tests**
  - Updated CV adapter tests to assert execution-mode outputs for fallback and OpenCV runtime branches.
  - Updated structural-model/engine/localization/contract test fixtures to include persisted `cvExecutionMode`.
  - Kept all existing structural/localization invariants intact.

### Boundaries preserved
- OpenCV-specific behavior remains isolated in structural CV modules; UI does not call OpenCV APIs.
- No alternate coordinate universe introduced; all overlay geometry still flows through canonical `page-surface` transforms.
- GeometryFile authority unchanged; structural overlays remain interpretive/debug and do not mutate saved field BBOX truth.

---

## 2026-04-27 — Tests + docs: OpenCV authority, contingency fallback, and deterministic localization fallback chain

### Why this step
- Structural behavior and fallback ordering needed tighter documentation plus explicit unit coverage at module boundaries (adapter/contracts/engine/localization).
- Goal: codify OpenCV.js structural authority on canonical NormalizedPage raster, keep fallback non-default, and lock deterministic anchor fallback in localization tests.

### What changed
- **Architecture docs**
  - `docs/architecture.md` now explicitly states:
    - structural object authority is real OpenCV.js contour/line/object operations on canonical NormalizedPage raster surfaces,
    - heuristic fallback is a non-default contingency path only when OpenCV runtime is absent/fails,
    - localization fallback order is deterministic `A → B → C → Refined Border → Border`.
- **Adapter tests** (`tests/unit/cv-opencv-js-adapter.test.ts`)
  - Added mocked OpenCV runtime boundary test proving contour + Hough-line outputs are converted into canonical adapter objects and content rect output.
  - Existing heuristic tests remain and continue validating canonical-surface invariants.
- **Contract tests** (`tests/unit/contracts.test.ts`)
  - Added negative schema/validator coverage for:
    - invalid stable-anchor label ordering (must be canonical A/B/C order),
    - invalid object-anchor rank ordering (must be primary/secondary/tertiary order).
- **Structural-engine tests** (`tests/unit/structural-engine.test.ts`)
  - Added test proving one field persists multi-anchor storage (`objectAnchors` and `stableObjectAnchors`) with deterministic `primary→secondary→tertiary` and `A→B→C` invariants.
  - Keeps Border/Refined Border and canonical normalized-coordinate assertions intact.
- **Localization-runner tests** (`tests/unit/localization-runner.test.ts`)
  - Added deterministic fallback test asserting exact tier order:
    - `field-object-a` when A resolves,
    - `field-object-b` when A fails and B resolves,
    - `field-object-c` when A/B fail and C resolves,
    - `refined-border` when object anchors fail,
    - `border` when refined anchor is unavailable.

### Boundaries preserved
- No runtime architecture rewrite and no cross-module coupling changes.
- Canonical coordinate authority remains: all tested transforms remain normalized over the same NormalizedPage surface model.
- Refined Border and Border invariants remain asserted in unit tests.

---

## 2026-04-27 — Fix: Config Capture / Run Mode overlay alignment + shared viewport authority

### Why this step
- Config Capture's structural overlays (Border / Refined Border / objects / saved BBOXes) no longer aligned with the visible document. The overlay appeared too wide / offset relative to the rendered image.
- Root cause was a display-plane desync: the overlay coordinate plane was being measured from a container that did not equal the rendered image rect.
- Run Mode rendered the same kind of overlays through a parallel local implementation, so the same alignment risk existed in both screens with no shared source of truth.

### Root cause
- `ConfigCapture.tsx` set the viewport frame to `width: 100%` and the image to `width: 100%; max-height: 80vh; object-fit: contain`. When the rendered image had to letterbox to satisfy `max-height`, the `<img>` element's bounding rect stayed at the full container width while the actual rendered image content shrank inside it. The overlay was sized to the IMG bounding rect (and `inset: 0` of the frame), so it was wider than the rendered image. Saved-BBOX overlays therefore drifted, and Border / Refined Border / object overlays appeared misaligned.
- Config Capture and Run Mode each owned their own measurement / transform / overlay container, so the same fix had to land in both places and could drift again later.

### Fix
- Added `src/core/page-surface/ui/NormalizedPageViewport.tsx` as the **single shared NormalizedPage viewport authority** for the app. It owns:
  - rendered image measurement (single `ResizeObserver` on the image element),
  - overlay plane sizing (positioned to the measured image rect via `overlayPlaneStyle(displayRect)`),
  - `SurfaceTransform` construction via `buildSurfaceTransform(getPageSurface(page), displayRect)`,
  - pointer-to-image-rect conversion via `pointerToImageRect(image, event)`,
  - resize / layout recalculation.
- The shared viewport uses **shrink-wrap** geometry: the frame is `display: inline-block`, the image is rendered at its natural aspect ratio with `max-width: 100%; max-height: 80vh` (no `object-fit`, no fixed width), and the overlay div is sized **explicitly** to `(0, 0, displayRect.width, displayRect.height)`. By construction: image rect = overlay rect.
- Refactored `src/features/config-capture/ui/ConfigCapture.tsx` to render through `NormalizedPageViewport` and consume the transform via `onSurfaceTransformChange`. Removed the local frame/image/overlay markup and the local measurement effect. Pointer events resolve through `pointerToImageRect`, which uses the shared image element.
- Refactored `src/features/run-mode/ui/RunMode.tsx` to render through the same `NormalizedPageViewport`. Removed the local frame/image/overlay markup and the local measurement effect. Run Mode now consumes the transform via the same `onSurfaceTransformChange` callback.
- Cleaned up `config-capture.css` and `run-mode.css` to drop the per-feature frame/image/overlay rules — the shared viewport owns those styles.

### Coordinate authority preserved
- No change to `StructuralModel` math, `GeometryFile`, or any `page-surface` transform math.
- All overlays in both screens — Border, Refined Border, structural objects, saved BBOXes, predicted BBOXes, draft rect — are still positioned via `normalizedRectToScreen(transform, rectNorm)` on the same `SurfaceTransform`.
- The display transform is still built from the rendered image's actual `getBoundingClientRect()` — but now via one shared component, so Config Capture and Run Mode cannot drift apart.
- Saved geometry remains normalized over the canonical NormalizedPage surface; resizing the browser, changing zoom, or reflowing the layout cannot change saved coordinates.

### Regression guard
- Added `tests/unit/normalized-page-viewport.test.ts`:
  - `overlay plane style pins to (0,0,width,height) of the rendered image rect` — codifies image-plane = overlay-plane via the `overlayPlaneStyle` helper.
  - `normalized rect 0,0,1,1 maps exactly to the displayed image bounds`.
  - `a saved BBOX maps back to the same screen location after a draw round-trip`.
  - `saved normalized coordinates do not change when the displayed image is resized` (resolution / layout independence).
  - `pointerToImageRect resolves clientX/Y against the rendered image, not its container` — the exact failure mode from the regression.
  - Clamping + null-safety cases for `pointerToImageRect`.

### Files added
- `src/core/page-surface/ui/NormalizedPageViewport.tsx`
- `src/core/page-surface/ui/normalized-page-viewport.css`
- `src/core/page-surface/ui/index.ts`
- `tests/unit/normalized-page-viewport.test.ts`

### Files modified
- `src/core/page-surface/index.ts` (re-exports the shared viewport)
- `src/features/config-capture/ui/ConfigCapture.tsx`
- `src/features/config-capture/ui/config-capture.css`
- `src/features/run-mode/ui/RunMode.tsx`
- `src/features/run-mode/ui/run-mode.css`
- `docs/dev-log.md`

### Checks run
- `npm run check` (`tsc --noEmit`): clean.
- `npm test` (vitest): 60/60 passing (53 prior + 7 new viewport regression tests).
- `npm run build` (`tsc -b && vite build`): clean.

### Boundaries preserved
- No change to `StructuralModel`, `GeometryFile`, `WizardFile`, or any contract.
- No change to `src/core/page-surface/page-surface.ts` math.
- No new coordinate system, no offsets, no padding compensation, no magic constants.
- Detected Border remains the structural reference — the fix targeted only the image/overlay plane lock that Border, Refined Border, BBOXes, and structural objects all depend on.

---

## 2026-04-27 — Phase 1 fix: Config Capture structural overlay overwhelm

### Why this step
- Config Capture's "Show Structural Debug Overlay" was producing a near-solid teal/blue blanket over the document preview — even after a prior CSS-only patch made object overlays `background: transparent` with thin borders.
- Visible labels in the field-report screenshot (e.g. `obj_vline_2939`, `obj_hline_1896`) revealed that thousands of single-pixel "line" objects were being emitted per page, fusing into a solid mass through accumulated 75%-opacity teal borders.

### Root cause
- `buildLineObjects` in `src/core/engines/structure/cv/opencv-js-adapter.ts` emitted **one `line-horizontal` object per row** and **one `line-vertical` object per column** whose foreground-pixel density exceeded `0.95`, with no merging of adjacent rows/cols.
- For documents whose foreground is not near-white (teal/blue UI mockups, dark page backgrounds, screenshots, heavy ink), most rows and most columns pass that threshold. Each emitted row/col was a full-span 1-px-thin `<div>` carrying a 1-px teal border on every side. ~5000 such overlapping divs visually fuse into a solid teal overlay even though each div has `background: transparent` — the earlier CSS patch addressed fill but not border-bloat.
- It was also a structural-correctness bug: a "line at row 5" and a "line at row 6" are not two separate lines — they're one line of thickness 2. The hierarchy and `fieldRelationships` were polluted with thousands of duplicate single-row "lines", harming downstream localization.

### Fix
- `buildLineObjects` rewritten to compute per-row and per-col foreground counts once, then merge consecutive high-density rows/cols into runs and emit **one** line object per run.
- Only emit a line when the run is thin (`thickness <= MAX_LINE_THICKNESS_PX = 4`) — thick runs are dense regions and are already covered by `detectConnectedBounds`.
- Added a hard safety cap (`MAX_LINE_OBJECTS_PER_AXIS = 64`) so no pathological raster can ever re-spawn the overwhelm.
- Result: a fully-dark or fully-teal page emits zero spam line objects (the dense region falls through to connected-components classification). A document with two real horizontal rules produces two horizontal-line objects, not thousands.

### Boundaries preserved
- No change to the `CvAdapter` contract, no change to `StructuralModel` contract, no change to `page-surface` authority, no OpenCV.js leakage outside the adapter.
- No new product features. No UI behavior changes beyond the overlay no longer overwhelming the document.
- The CSS overlay path is unchanged — the root cause was object-count, not styling.

### Files modified
- `src/core/engines/structure/cv/opencv-js-adapter.ts`
- `tests/unit/cv-opencv-js-adapter.test.ts`
- `docs/dev-log.md`

### Tests added
- `merges adjacent dense rows/cols into single line objects (no per-row spam)` — confirms two thin horizontal rules and one thin vertical rule produce exactly 2 + 1 line objects with the expected merged bboxes.
- `does not emit line objects for dense regions (those belong to connected components)` — confirms a fully-dark raster produces zero line objects (the ink-heavy regression case).

### Checks run
- `npm run check` — clean.
- `npm test` — 53/53 passing (51 prior + 2 new).
- `npm run build` — clean.

### Remaining risks / next checkpoint
- Awaiting user confirmation on the visual fix in the running app before proceeding to the broader Phase 2 architectural-cleanup pass described in the issue (GeometryFile vs StructuralModel separation, fieldRelationships meaningful for Run Mode, parallel-coordinate-system audit, etc.).

---

## 2026-04-27 — Step: Structural Object Hierarchy layer in Structural Engine

### Why this step
- Border + Refined Border gave coarse structure, but not enough measurable anchors for later localization refinement.
- Goal: enrich `StructuralModel` with a machine-readable object map around human-confirmed BBOXes while keeping Geometry as authority and preserving a single NormalizedPage coordinate universe.

### What changed
- **Structural contract enrichment** (`src/core/contracts/structural-model.ts`):
  - Added `objectHierarchy` on each `StructuralPage` with typed nodes:
    - `objectId`, `type`, `bbox`, `parentObjectId`, `childObjectIds`, `confidence`.
  - Added `fieldRelationships` for each page field:
    - `containedBy`,
    - `nearestObjects`,
    - `relativePositionWithinParent`,
    - `distanceToBorder`,
    - `distanceToRefinedBorder`.
  - Runtime contract guard (`isStructuralModel`) now validates these new sections.
- **CV adapter output extension** (`src/core/engines/structure/cv/cv-adapter.ts`):
  - `CvContentRectResult` now includes `objectsSurface` in canonical surface pixels, alongside `contentRectSurface`.
- **OpenCV.js adapter object detection** (`src/core/engines/structure/cv/opencv-js-adapter.ts`):
  - Kept OpenCV.js isolated in adapter boundary.
  - Added deterministic pixel-based detection for object candidates on the canonical raster surface, emitting:
    - `rectangle`,
    - `container`,
    - `line-horizontal`,
    - `line-vertical`,
    - `table-like`,
    - `header`,
    - `footer`.
  - Output remains surface-pixel coordinates tied directly to `PageSurface`.
- **Hierarchy + relationship module** (`src/core/engines/structure/object-hierarchy.ts`):
  - Builds parent/child nesting from normalized object containment.
  - Promotes nested containers to `nested-region` and rectangles-with-children to `group-region`.
  - Computes field-centric structural relationships without changing field BBOXes.
- **Structural engine integration** (`src/core/engines/structure/structural-engine.ts`):
  - Converts `objectsSurface` to normalized coordinates via the same `surfaceRectToNormalized` path used by border/refined-border handling.
  - Produces `objectHierarchy` and `fieldRelationships` per page.
  - Geometry remains read-only and authoritative; no GeometryFile mutation and no saved BBOX relocation in this step.
- **Config Capture debug overlay** (`src/features/config-capture/ui/ConfigCapture.tsx`, `config-capture.css`):
  - Added structural object box overlays + labels in the existing debug layer.
  - Objects render through the same `normalizedRectToScreen` transform as Border, Refined Border, and saved Geometry overlays.

### Coordinate authority proof
- CV adapter receives only `CvSurfaceRaster` whose pixels must match `PageSurface`.
- Object detections are emitted in that same `PageSurface` pixel plane (`objectsSurface`).
- Structural Engine converts those to normalized rects via `surfaceRectToNormalized`.
- UI overlays convert normalized rects to screen via `normalizedRectToScreen`.
- No alternate coordinate system, no detached OpenCV-only space, and no UI-specific math was introduced.

### Ground truth protection
- Geometry remains untouched and separately stored.
- Object hierarchy enriches StructuralModel context only.
- Saved BBOXes are neither moved nor reinterpreted.

### Files added
- `src/core/engines/structure/object-hierarchy.ts`

### Files modified
- `src/core/contracts/structural-model.ts`
- `src/core/engines/structure/cv/cv-adapter.ts`
- `src/core/engines/structure/cv/opencv-js-adapter.ts`
- `src/core/engines/structure/structural-engine.ts`
- `src/features/config-capture/ui/ConfigCapture.tsx`
- `src/features/config-capture/ui/config-capture.css`
- `tests/unit/structural-engine.test.ts`
- `tests/unit/cv-opencv-js-adapter.test.ts`
- `tests/unit/contracts.test.ts`
- `tests/unit/structural-model-io.test.ts`
- `tests/unit/localization-runner.test.ts`
- `docs/architecture.md`
- `docs/dev-log.md`

### Checks run
- `npm run check`: passed.
- `npm test`: passed.
- `npm run build`: passed.

## 2026-04-26 — Step: Run Mode upload status visibility + runtime structural overlay parity

### Why this step
- Run Mode uploads were functionally parsed/loaded, but status feedback was too implicit and errors were collapsed into one generic message area.
- Run Mode already computed runtime structure through `structural-runner`, but the viewport only displayed predicted BBOX overlays, making structural parity with Config Capture difficult to visually prove.
- Goal: make all Run Mode intake inputs explicit, prove runtime structural compute parity, and show border/refined-border overlays on the same normalized page transform authority.

### What changed
- **Run Mode status authority** (`src/features/run-mode/ui/RunMode.tsx`):
  - Added explicit per-input status + metadata:
    - WizardFile loaded/not loaded (+ wizard name),
    - GeometryFile loaded/not loaded (+ field count),
    - Config StructuralModel loaded/not loaded (+ page count),
    - Runtime document normalized/not normalized (+ runtime page count),
    - Selected runtime page,
    - Runtime structure computed/not computed (+ CV adapter provenance when available).
  - Added per-input parse/validation error surfaces (`wizardError`, `geometryError`, `configStructuralError`, `runtimeNormalizationError`) plus a separate run-execution error (`runError`) so failures do not overwrite each other.
- **Runtime structural parity overlays** (`src/features/run-mode/ui/RunMode.tsx`, `src/features/run-mode/ui/run-mode.css`):
  - Added **Show Runtime Structural Debug Overlay** toggle.
  - Added runtime structural state capture (`runtimeStructuralModel`) from `structuralRunner.compute(...)`.
  - Added visual overlays for runtime Border and runtime Refined Border (including refined-border source label).
  - Overlay now shows runtime Border + runtime Refined Border + predicted BBOXes together when the debug toggle is enabled.
  - Added Runtime StructuralModel JSON preview panel so runtime structural output is inspectable directly in Run Mode.
- **Transform/surface authority preserved**:
  - Runtime overlay rendering is done with the same `page-surface` transform chain used by Config Capture:
    - `getPageSurface(selectedPage)`,
    - `buildSurfaceTransform(surface, displayRect)`,
    - `normalizedRectToScreen(transform, rectNorm)`.
  - No runtime-only coordinate system was introduced.

### Parity audit outcome
- Run Mode was **already** recomputing runtime structure via the shared `createStructuralRunner().compute(...)` path (same authority used by Config Capture).
- This change does **not** introduce any duplicate runtime-only structural computation logic.
- OpenCV/CV detection remains executed by the shared structural engine stack through `structural-runner` on runtime `NormalizedPage` input.

### Files modified
- `src/features/run-mode/ui/RunMode.tsx`
- `src/features/run-mode/ui/run-mode.css`
- `docs/architecture.md`
- `docs/dev-log.md`

### Checks run
- `npm run check` (`tsc --noEmit`): passed.
- `npm test` (vitest): passed.
- `npm run build` (`tsc -b && vite build`): passed.

## 2026-04-26 — Step: Structural Engine v1 (Border + Refined Border)

### Why this step
- Wrokit needed the first Structural Engine / Computer Vision layer alongside the NormalizedPage / Geometry authority model.
- Goal: given a NormalizedPage and (optionally) a GeometryFile, produce the first deterministic StructuralModel containing a `Border` (full normalized page boundary) and a `Refined Border` (main useful content area), under the strict surface authority + ground-truth rules.
- The Structural Engine becomes the second backbone of Wrokit, but must consume the same canonical NormalizedPage raster surface used by Geometry capture. No separate image space, alternate canvas space, OpenCV-only coordinate universe, or structural-only bbox system is permitted.

### What changed
- **Contract** (`src/core/contracts/structural-model.ts`): rewrote `StructuralModel` to v2.0 with `structureVersion: 'wrokit/structure/v1'`. Each `StructuralPage` carries:
  - `pageSurface: { pageIndex, surfaceWidth, surfaceHeight }` — the canonical NormalizedPage surface.
  - `border: { rectNorm: { 0, 0, 1, 1 } }` — the full normalized page boundary.
  - `refinedBorder: { rectNorm, source, influencedByBBoxCount, containsAllSavedBBoxes }` — the main useful content area, in normalized `[0, 1]` coordinates over the *same* NormalizedPage surface, with explicit ground-truth markers.
  - `cvAdapter: { name, version }` — provenance of the CV implementation. The contract is library-agnostic.
- **CV adapter abstraction** (`src/core/engines/structure/cv/cv-adapter.ts`): defined the `CvAdapter` interface — input is a `CvSurfaceRaster` whose pixel dimensions MUST equal the canonical `PageSurface` dimensions (enforced by `assertRasterMatchesSurface`); output is a `contentRectSurface` in NormalizedPage surface pixels. The Structural Engine never imports any specific CV library.
- **OpenCV.js adapter** (`src/core/engines/structure/cv/opencv-js-adapter.ts`): the **only** file in Wrokit allowed to reference OpenCV.js. Implements the abstract `CvAdapter`. Performs background-threshold + bounding-rect-of-content directly against the canonical NormalizedPage raster surface; will use a real `cv.js` runtime when one is exposed (e.g. on `globalThis.cv`), but never requires it. Replacing or extending the OpenCV-specific logic is a single-file change.
- **Page raster loader** (`src/core/engines/structure/page-raster-loader.ts`): the only reader of `NormalizedPage.imageDataUrl` for CV. Always rasterizes to canvas dimensions equal to `surface.surfaceWidth/Height`. There is no DPR scaling, alternate canvas space, or alternate coordinate universe.
- **Structural Engine** (`src/core/engines/structure/structural-engine.ts`): pure transform implementing `Engine<StructuralEngineInput, StructuralModel>`. For each input page:
  - derives the canonical `PageSurface` via `getPageSurface(page)`,
  - asks the CV adapter for a content rect on that surface,
  - converts the result into the canonical normalized coordinate system via `surfaceRectToNormalized`,
  - emits a Border at `{0,0,1,1}` and a Refined Border that respects every saved BBOX as ground truth.
  - Refined Border invariants: with no BBOXes → `cv-content` or `full-page-fallback`; with BBOXes and unusable CV → `bbox-union`; with both → `cv-and-bbox-union`. The engine **expands** the refined border to include any BBOX that escapes; it never crops.
- **Structural Runner** (`src/core/runtime/structural-runner.ts`): the only place engines are composed for structural detection. Owns CV adapter selection (OpenCV.js by default) and exposes a single `compute(input)` method. UI consumes only this runner.
- **IO** (`src/core/io/structural-model-io.ts`): `serializeStructuralModel`, `parseStructuralModel`, `downloadStructuralModel` — mirrors the Geometry IO module shape. StructuralModels are persisted separately from GeometryFiles.
- **Storage** (`src/core/storage/structural-store.ts`): no API changes — still keyed by `id`, separate from `geometry-store`.
- **Config Capture wiring** (`src/features/config-capture/ui/ConfigCapture.tsx`):
  - Auto-computes a StructuralModel as soon as `NormalizedPage[]` exists in the shared session store. The user does not need to draw any BBOX before seeing the structural debug overlay.
  - Re-runs structural compute when BBOXes change (geometry is fed in as ground truth so the refined border honors saved BBOXes).
  - Adds a **"Show Structural Debug Overlay"** toggle. Border + Refined Border are positioned via the **same** `normalizedRectToScreen` transform that positions saved BBOX overlays — one coordinate system for all three overlays.
  - Adds Live StructuralModel JSON preview and a Download StructuralModel JSON button.
- **Dashboard**: `Structural Model` module flipped from `planned` to `active`.

### OpenCV.js containment
- Only `src/core/engines/structure/cv/opencv-js-adapter.ts` may reference OpenCV.js or look up `globalThis.cv`.
- The Structural Engine, Structural Runner, contracts, IO module, stores, runtime stubs, and UI consume only the abstract `CvAdapter` interface and the `StructuralModel` contract.
- Replacing OpenCV.js with a different CV library (or attaching the real `cv.js` WASM build) is a single-file change inside the `cv/` directory and a runner-options swap; nothing else needs to know.

### NormalizedPage surface authority preserved
- The Structural Engine derives `PageSurface` via `getPageSurface(page)` from the same `page-surface` infrastructure module Geometry uses.
- The CV adapter receives a raster whose dimensions equal the canonical surface dimensions (`assertRasterMatchesSurface`). It cannot operate on a non-canonical surface.
- The CV adapter reports a content rect in NormalizedPage surface pixels; the engine maps it to canonical normalized coordinates via `surfaceRectToNormalized` — the same conversion Geometry uses.
- Structural overlays are positioned using `normalizedRectToScreen` against the live display transform — the same transform that positions saved BBOX overlays. There is no separate structural overlay coordinate system.

### Ground truth protection
- Geometry remains authoritative. The engine never overrides, shrinks, moves, or reinterprets a saved BBOX. If structural detection disagrees, the engine **expands** the refined border to include the BBOX. Every `RefinedBorder` ships `containsAllSavedBBoxes: true` after construction; this is verified, not assumed.
- StructuralModel is persisted separately from GeometryFile (`structural-store` vs `geometry-store`, `*.structural.json` vs `*.geometry.json`).

### Anti-drift protections added
- **No pixelBbox snapshots are used as authority.** Structural rects are normalized `[0, 1]` over the canonical NormalizedPage surface. Pixel-space data exists only at the CV adapter boundary as a transient surface-aligned read.
- **No parallel structural bbox language.** All structural rects are typed as `StructuralNormalizedRect` and are produced via the same `surfaceRectToNormalized` helper Geometry uses. The contract guard rejects any model whose rects don't match the shape.
- **No misleading legacy naming.** Public surface uses `pageSurface`, `surfaceWidth/Height`, `rectNorm`, `contentRectSurface`. The word "viewport" does not appear.
- **Future runtime modules can consume StructuralModel without source-specific branching.** The model carries no MIME-type, PDF, or image-source identity. `cvAdapter` is provenance-only and does not change the contract shape.
- **No OCR, runtime extraction, localization, confidence scoring, or extra object hierarchy was added.** The structural model contains only Border and Refined Border per page.

### Files added
- `src/core/engines/structure/structural-engine.ts`
- `src/core/engines/structure/page-raster-loader.ts`
- `src/core/engines/structure/types.ts`
- `src/core/engines/structure/index.ts`
- `src/core/engines/structure/cv/cv-adapter.ts`
- `src/core/engines/structure/cv/opencv-js-adapter.ts`
- `src/core/engines/structure/cv/index.ts`
- `src/core/io/structural-model-io.ts`
- `src/core/runtime/structural-runner.ts`
- `tests/unit/structural-engine.test.ts`
- `tests/unit/structural-model-io.test.ts`
- `tests/unit/cv-opencv-js-adapter.test.ts`

### Files modified
- `src/core/contracts/structural-model.ts` (rewritten to v2.0 + structureVersion)
- `src/features/config-capture/ui/ConfigCapture.tsx` (auto-compute, overlay, JSON preview/download)
- `src/features/config-capture/ui/config-capture.css` (structural overlay + toggle styles)
- `src/app/pages/HomeDashboardPage.tsx` (Structural Model status → active)
- `tests/unit/contracts.test.ts` (updated to v2.0 StructuralModel shape)
- `docs/architecture.md`
- `docs/dev-log.md`

### Checks run
- `npm run check` (`tsc --noEmit`): passed.
- `npm test` (vitest): all 48 tests pass (10 contracts + 6 page-surface + 7 geometry-validation + 4 geometry-file-io + 3 normalized-page-session-store + 5 wizard-builder-store + 4 cv-opencv-js-adapter + 5 structural-engine + 4 structural-model-io).
- `npm run build` (`tsc -b && vite build`): passed; bundle emitted.

### Recommended next step
- Persist completed `StructuralModel` snapshots into the existing `structural-store` from a future "Save Structural" UI action, mirroring the Geometry save flow, so the dashboard can list saved structural interpretations alongside saved geometries.

---

## 2026-04-26 — Step: Canonical NormalizedPage Session Store Authority

### Why this step
- Config Capture previously owned `sourceName`, `pages`, and `selectedPageIndex` as local component state.
- That local ownership was acceptable for a single feature, but it is not strict enough for the architecture target where Geometry, Structural/OpenCV, OCR overlays, and runtime modules must consume the exact same page authority.
- Goal: create one canonical normalized-page session/store as infrastructure and route Config Capture through it.

### What changed
- Added `src/core/storage/normalized-page-session-store.ts` as a thin, typed infrastructure store.
  - State ownership is explicit and minimal:
    - `pages: NormalizedPage[]`
    - `selectedPageIndex: number`
    - `sourceName: string` (display-only)
    - `documentFingerprint: string` (surface identity)
    - `sessionId: string` (active session identity)
  - Mutators are minimal and async:
    - `setNormalizedDocument({ sourceName, pages })`
    - `selectPage(pageIndex)`
    - `clearSession()`
  - Fingerprint generation (`surface:<source>#<page signatures>`) is centralized in this authority layer so consumers do not duplicate derivation.
  - Exposes `createNormalizedPageSessionStore()` and a singleton accessor `getNormalizedPageSessionStore()` so the app has one canonical in-memory session owner.
- Refactored `src/features/config-capture/ui/ConfigCapture.tsx` to consume normalized pages from the shared store via `useSyncExternalStore`.
  - Removed competing local state ownership of normalized pages/source/page selection.
  - Upload still runs through `createNormalizationEngine().normalize(file)`.
  - After upload, Config Capture writes only normalized output (`sourceName`, `NormalizedPage[]`) into `setNormalizedDocument`.
  - Geometry rendering, validation inputs, and page selection now read from the shared session snapshot.
- Added `tests/unit/normalized-page-session-store.test.ts` to lock authority behavior:
  - document load ownership,
  - page selection semantics,
  - session clear/reset identity behavior.

### Surface authority outcome
- Config Capture and any future page-aware module now have a dedicated authority layer to subscribe to for the active normalized document session.
- This removes per-feature page session drift risk before OpenCV/Structural work begins.
- Upload remains boundary-correct: raw files stay at the normalization boundary; downstream consumes only `NormalizedPage`.

### Files modified
- `src/core/storage/normalized-page-session-store.ts` (new)
- `src/features/config-capture/ui/ConfigCapture.tsx`
- `tests/unit/normalized-page-session-store.test.ts` (new)
- `docs/architecture.md`
- `docs/dev-log.md`

### Checks run
- `npm run check` (`tsc --noEmit`): passed.
- `npm test` (vitest): passed.

---

# Wrokit Development Log

## 2026-04-26 — Step: Unify Normalization Flow into Config Capture

### Why this step
- The website previously exposed two separate upload/normalization entry points: a standalone "Normalized Page Intake" section on the dashboard and a document upload inside Config Capture.
- This created a confusing UX where a user could normalize a file in one place and then have to upload it again in another place to draw BBOXes.
- The two paths maintained independent local state with no coordination between them, so normalized pages from the dashboard were never reachable by Config Capture.
- Goal: one canonical intake path. Config Capture is now the only place where the user uploads, normalizes, and draws geometry.

### What changed
- **Removed** the standalone `<NormalizationIntake />` section from `HomeDashboardPage`. The dashboard now renders only the module status panel.
- **Removed** the `NormalizationIntake` import from `HomeDashboardPage.tsx`.
- **Updated** the "Normalized Page Intake" module status entry on the dashboard to note that intake is unified into Config Capture.
- No UI was added. No engine code was changed. No contracts were changed. No stores were changed.
- The `NormalizationIntake` component file (`src/features/normalization/ui/NormalizationIntake.tsx`) is retained as an unmounted library component; the normalization engine it wraps remains fully intact and continues to be used by Config Capture.

### Normalization boundary preserved
- All uploads still flow through `createNormalizationEngine()` inside `ConfigCapture`.
- `pdfjs-dist` is still used only inside `pdf-rasterizer.ts`.
- Every uploaded file is still converted to `NormalizedPage[]` before any geometry operation.
- No downstream module can distinguish a PDF-sourced page from an image-sourced page.

### How Config Capture gets NormalizedPage data
- `ConfigCapture` calls `normalizationEngineRef.current.normalize(file)` on document upload and stores the resulting `NormalizedPage[]` in local component state (`pages`, `sourceName`).
- The displayed `<img>` is `selectedPage.imageDataUrl` — the canonical raster surface, not the raw upload.
- This was already the case before this change; removing the standalone intake section does not alter this data path.

### BBOX coordinate authority preserved
- All pointer events still resolve through `src/core/page-surface/`: screen → surface → normalized.
- Saved overlays are rendered by transforming canonical normalized coordinates back to screen space through the same live display transform.
- No coordinate system changes were made.

### Files modified
- `src/app/pages/HomeDashboardPage.tsx` (removed NormalizationIntake import and render; updated module status note)
- `docs/architecture.md` (updated feature UI section, Geometry Module section, and Implementation Status)
- `docs/dev-log.md`

### Checks run
- `npm run check` (`tsc --noEmit`): passed.
- `npm test` (vitest): all tests pass (no test changes required — no engine, contract, store, or IO changes).

---

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

## 2026-04-26 — Step: Basic Run Mode Transform Matching

### Why this step
- Runtime localization needed a first concrete flow: load saved config artifacts, normalize a new runtime document, build runtime structure, and redraw predicted field boxes.
- The goal of this step is relocation only (not discovery): move human-confirmed GeometryFile boxes onto the runtime page using structural comparison in canonical normalized coordinates.

### What changed
- Implemented `src/core/runtime/localization-runner.ts`.
  - Replaced the previous stub.
  - Added a `PredictedGeometryFile` output contract (runtime-local module type) and `PredictedFieldGeometry` records.
  - Added transform solve based on **config refined border → runtime refined border** comparison per page.
  - Solved transform metadata: `scaleX`, `scaleY`, `translateX`, `translateY`, plus transform basis and source rects.
  - Applied transforms to each saved `FieldGeometry.bbox` and emitted predicted normalized + pixel bboxes on the runtime page surface.
- Added Run Mode UI (`src/features/run-mode/ui/RunMode.tsx`, `run-mode.css`) and page wiring (`src/app/pages/RunModePage.tsx`, `src/app/App.tsx`).
  - Upload/import controls for WizardFile, GeometryFile, Config StructuralModel, and runtime document.
  - Runtime document is normalized through the existing normalization engine.
  - Runtime structural build uses existing `structural-runner` (no duplicated border/refined-border logic).
  - Predicted overlays are drawn on the runtime `NormalizedPage` image using the shared `page-surface` transform utilities.
  - Predicted JSON live preview + download added.
- Updated dashboard runtime status to active (`src/app/pages/HomeDashboardPage.tsx`).
- Added unit tests for localization runner (`tests/unit/localization-runner.test.ts`).

### Authority + anti-drift behavior
- Geometry remains primary truth: runtime matching consumes saved boxes and relocates them; it does not discover fields and does not reinterpret field meaning.
- StructuralModel remains relocation basis: refined-border comparison drives transform solve.
- Output predicted geometry is stored in canonical normalized coordinates with runtime page surface references.
- Overlay placement uses the same canonical conversion path (`normalizedRectToScreen`) used elsewhere, keeping UI and stored geometry in the same coordinate universe.
- OCR is still not used for finding fields.

### Files added
- `src/features/run-mode/ui/RunMode.tsx`
- `src/features/run-mode/ui/run-mode.css`
- `src/app/pages/RunModePage.tsx`
- `tests/unit/localization-runner.test.ts`

### Files modified
- `src/core/runtime/localization-runner.ts`
- `src/app/App.tsx`
- `src/app/pages/HomeDashboardPage.tsx`
- `src/app/routes.ts`
- `docs/architecture.md`
- `docs/dev-log.md`

### Checks run
- `npm run check`
- `npm test`
