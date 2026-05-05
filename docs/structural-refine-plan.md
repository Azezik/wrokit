# Structural Refine — Implementation Plan

This is a complete, additive plan. Nothing in this plan modifies existing engines, contracts, runners, IO modules, stores, or the upstream config/runtime/transformation flow. Every existing artifact stays untouched. Structural Refine attaches as a parallel observer.

The work is broken into **three phases** at the bottom of this document. Read sections 1–11 first for the full design, then execute Phase 1 → Phase 2 → Phase 3 in order.

---

## 1. Architectural Position

Structural Refine is a **new, isolated subsystem** that sits beside the existing pipeline. It plugs in at one place only: the batch coordinator emits per-document evidence into a Structural Refine Observer; nothing else upstream changes.

```
Existing (unchanged):
  Wizard → Geometry → ConfigStructural
                          │
   per-document  ──► Normalize ──► RuntimeStructural ──► Transformation ──► Localization ──► OCRBOX ──► MasterDB

New (additive):                       │ (read-only fan-out, only when toggle ON)
                                      ▼
                        Structural Refine Observer
                                      │
                                      ▼
                        Structural Refine Aggregator
                                      │
                                      ├─► Structural Refine Analytics (.json)
                                      └─► Structural Refine Model      (StructuralModel-shaped .json)
```

**Hard rule encoded in code review and in module imports**: nothing inside Structural Refine writes back into any existing store, contract, runner, or engine. It exposes a single subscription hook into the batch coordinator.

---

## 2. New Modules and Files

All new code lives under three new directories. Existing directories get **one new optional callback** wired in two places (orchestrator + batch coordinator) — no other touches.

### 2.1 New contracts (`src/core/contracts/`)
- `structural-refine-analytics.ts` — `StructuralRefineAnalytics` contract.
  - `schema: 'wrokit/structural-refine-analytics'`, `version: '1.0'`, guard `isStructuralRefineAnalytics`.
  - Designed to be **portable, mergeable, and accumulative** (see §5).
- *No new structural model contract.* The Structural Refine **Model** reuses the existing `StructuralModel` contract (`wrokit/structural-model` v4.0) verbatim. That is what makes it plug-and-play.

### 2.2 New engine (`src/core/engines/structural-refine/`)
Pure, no-IO, no-store, no-UI:
- `aggregator.ts` — the **streaming aggregator**. Input: per-document evidence (one at a time). Holds a small, bounded in-memory accumulator. No raw model retention.
- `evidence.ts` — pure functions extracting the per-document evidence record from `(runtimeStructuralModel, transformationModel, predictedGeometryFile, configStructuralModel, configGeometry)`. Read-only.
- `merge-analytics.ts` — pure function: `mergeAnalytics(prior: StructuralRefineAnalytics | null, incoming: AggregatorState): StructuralRefineAnalytics`. Used both at end-of-batch and when re-uploading a prior analytics file.
- `compose-model.ts` — pure function: `composeRefinedStructuralModel(analytics: StructuralRefineAnalytics, configStructuralModel: StructuralModel): StructuralModel`. Produces a fully-shaped, type-guard-passing `StructuralModel` (see §6).
- `signature.ts` — wizard/config signature helpers (see §7).
- `index.ts` re-exports.

### 2.3 New runner (`src/core/runtime/`)
- `structural-refine-runner.ts` — composes evidence extraction + aggregator + merge + compose. Single boundary the batch coordinator calls into. Mirrors the pattern of `transformation-runner` and `masterdb-runner`.

### 2.4 New IO (`src/core/io/`)
- `structural-refine-analytics-io.ts` — `serializeStructuralRefineAnalytics`, `parseStructuralRefineAnalytics`, `downloadStructuralRefineAnalytics`. Mirrors `transformation-model-io`.
- *No new structural model IO.* The refined model downloads through the **existing** `structural-model-io.ts` (`downloadStructuralModel`). That guarantees byte-for-byte format parity.

### 2.5 New feature UI (`src/features/structural-refine/ui/`)
- `StructuralRefineToggle.tsx` — the toggle + optional prior-analytics upload control mounted into `UploadBatchSlide.tsx`.
- `StructuralRefineBuildingState.tsx` — small inline status block ("Building Structural Refine model…") rendered on the existing `ProcessingSlide` while the post-batch refine step runs.
- `StructuralRefineDownloads.tsx` — download buttons for the analytics file and refined structural model, mounted into `ReviewSlide.tsx` (only visible when the toggle was on).
- `structural-refine.css` — feature-local styles only.

### 2.6 New store (`src/core/storage/`)
- `structural-refine-store.ts` — per-batch in-memory store. Holds: toggle state, optional uploaded prior analytics, current aggregator handle, latest produced analytics, latest produced refined model. Implements the existing `observable-store` pattern. Cleared on `reset()`.

---

## 3. Existing Code Touch Points (Minimum Necessary)

These are the only edits to existing code; each is purely additive, optional, and behavior-preserving when the toggle is off.

1. **`src/features/polished-wizard/orchestrator/types.ts`** — add three optional fields to `OrchestratorState`:
   - `structuralRefineEnabled: boolean` (default `false`)
   - `priorRefineAnalytics: StructuralRefineAnalytics | null`
   - `lastRefineOutputs: { analytics: StructuralRefineAnalytics; refinedModel: StructuralModel } | null`
   - Add one phase to `BatchProgress.phase`: `'refining'` (only emitted when toggle is on).

2. **`src/features/polished-wizard/orchestrator/useOrchestrator.ts`** — add `setStructuralRefineEnabled`, `setPriorRefineAnalytics`, and read those when invoking the batch coordinator. Stamp `lastRefineOutputs` when the coordinator returns them.

3. **`src/features/polished-wizard/batch-coordinator/batch-coordinator.ts`** — accept two new optional inputs (`refineEnabled`, `priorAnalytics`). When `refineEnabled`:
   - Construct `createStructuralRefineRunner(...)` once at the top.
   - **After each document** (right after the existing `masterDbRunner.apply` call) call `refineRunner.observe({ runtimeStructure, transformationModel, predicted, ... })`. The observer takes only what is already in scope — no new pipeline steps are inserted, no existing step is reordered.
   - **After the loop**, before returning, emit `phase: 'refining'`, then call `refineRunner.finalize({ priorAnalytics, configStructuralModel, wizard, configGeometry })` to produce `{ analytics, refinedModel }`. Return them on the result.
   - When `refineEnabled` is `false`, none of the above runs and the coordinator behaves byte-identically to today.

4. **`src/features/polished-wizard/ui/slides/UploadBatchSlide.tsx`** — render `<StructuralRefineToggle />` between the dropzone and the footer. The toggle controls the orchestrator flag and (optionally) lets the user upload a prior `StructuralRefineAnalytics` file before pressing **Process**.

5. **`src/features/polished-wizard/ui/slides/ProcessingSlide.tsx`** — when `batchProgress.phase === 'refining'`, render `<StructuralRefineBuildingState />` ("Building Structural Refine model…").

6. **`src/features/polished-wizard/ui/slides/ReviewSlide.tsx`** — render `<StructuralRefineDownloads />` next to the existing CSV downloads when `lastRefineOutputs` is non-null.

That is the entire upstream surface area. No engine, contract, IO, store, or runner outside of Structural Refine is otherwise touched.

---

## 4. Storage-Efficient Streaming Aggregator (§ "Storage Efficiency Principle")

The aggregator never retains raw `StructuralModel`s, raw `TransformationModel`s, or raw `PredictedGeometryFile`s. It maintains bounded incremental statistics keyed by **stable identity slots** that exist on the config side.

### 4.1 Per-document evidence (extracted then immediately collapsed)
For each document the observer extracts (then discards):
- For each config object that the transformation matched: its runtime rect, the implied affine, the match basis, the match confidence.
- The page-level consensus affine, its confidence, its inlier weight.
- The refined-border alignment delta.
- For each saved field: which anchor tier resolved (`A | B | C | RefinedBorder | Border`), the predicted normalized rect, the projected rect's IoU vs the matched object's runtime rect (sanity).
- The runtime page surface dims (for normalization parity).

All of this is reduced into the running aggregator state and the raw evidence is dropped before the next document.

### 4.2 Aggregator state (bounded — O(config-objects + config-fields), independent of batch size)

Per config page:
- Page-level consensus affine: running weighted Welford mean (`scaleX, scaleY, translateX, translateY`) + variance + sample count + total weight.
- Refined-border alignment delta: same Welford accumulator.
- Direction-of-shift summary: signed-mean of `translateX/Y` to learn "documents usually shift slightly in the same direction".

Per config object (`objectId`):
- Appearance count (#documents where this object matched on the runtime side).
- Match-confidence running mean + variance.
- Per-match implied-affine running mean + variance + count.
- IoU-after-projection running mean + variance.
- "Outlier vs page consensus" running count (how often this object disagreed with page consensus). High → unreliable, downweight.
- Co-occurrence counts with every other config object (sparse map: `objectId → count`). Captures "objects that repeatedly appear together" and "useful for alignment together."
- Position drift (Welford on this object's runtime rect minus its config rect, in normalized space). Captures "average position of repeated objects" and "average size of repeated objects."
- Anchor-tier-usage histogram: how many fields used this object as A, B, or C and the projection IoU each time. Captures "useful for alignment", "consistently helpful for transforming back toward config", "anchors that repeatedly cause bad alignment."

Per config field (`fieldId`):
- Anchor-tier resolution histogram (`A/B/C/refined/border` counts).
- Projected-rect drift Welford (mean & variance) — the field's average reprojected position relative to its config position.
- Per-anchor projection IoU running stats. Captures "certain objects repeatedly confirm correct alignment."

Per object pair (sparse, only for pairs that co-appeared at least N times):
- Running mean of the relative geometry between the two objects' runtime rects (`Δcenter`, size ratio). Captures "average relationship between repeated objects" and "structural relationships that are more reliable than others."

Global:
- Document count.
- Per-anchor-tier global success/failure counts.
- "Best transformations" — top-K consensus affines retained as a quantile sketch (small fixed memory) for distribution shape, optional and bounded.

All aggregators are **mergeable** (Welford and counts are associative under weighted-mean merge), which is what makes incremental re-feeding (§5) trivial.

### 4.3 Memory budget
Bounded by the size of the config: the number of config objects + fields + (truncated) co-occurrence pairs. Independent of batch size. No raw runtime artifacts persist beyond the moment they are read.

### 4.4 Where the work runs
Two acceptable shapes (the principle allows either):
- **Real-time observer (default).** `refineRunner.observe(...)` is called after each document inside the existing loop, and `finalize` runs in a short post-batch step that emits the `'refining'` phase. The post-batch step is deterministic and brief — it only collapses the aggregator into the analytics + composes the refined model.
- *(Fallback if real-time per-doc is undesirable):* buffer the small evidence records (NOT the full models) in memory and run the aggregator entirely in finalize. Same UI message.

The plan adopts the **real-time observer + tiny finalize** shape.

---

## 5. Structural Refine Analytics Contract

`StructuralRefineAnalytics` (new file, new contract) — designed for portability, accumulation, and wizard-awareness. It is the only aggregator-state-shaped artifact persisted.

```ts
interface StructuralRefineAnalytics {
  schema: 'wrokit/structural-refine-analytics';
  version: '1.0';
  refineVersion: 'wrokit/structural-refine/v1';
  id: string;

  compatibility: RefineCompatibilitySignature;   // §7
  documentCount: number;                          // total across all merges
  mergeHistory: Array<{ batchId: string; addedDocumentCount: number; mergedAtIso: string }>;

  // Per-page accumulators. Same indexing as configStructuralModel.pages.
  pages: Array<{
    pageIndex: number;
    pageSurface: StructuralPageSurfaceRef;       // mirrors structural-model
    consensusAffine: WelfordAffine;              // running mean + variance + count
    refinedBorderDelta: WelfordAffine;
    shiftDirection: { meanTx: number; meanTy: number; sampleCount: number };

    objects: Array<{
      configObjectId: string;
      appearanceCount: number;
      matchConfidence: WelfordScalar;
      impliedAffine: WelfordAffine;
      projectionIou: WelfordScalar;
      outlierVsConsensusCount: number;
      runtimePositionDrift: WelfordRect;          // mean/variance of runtime rect
      anchorTierUsage: { A: number; B: number; C: number };
      anchorProjectionIou: { A: WelfordScalar; B: WelfordScalar; C: WelfordScalar };
      reliability: number;                         // derived in finalize, [0,1]
    }>;

    objectPairs: Array<{
      fromObjectId: string;
      toObjectId: string;
      coOccurrenceCount: number;
      relativeGeometry: WelfordRelative;           // Δcenter + size ratio means/variances
    }>;

    fields: Array<{
      fieldId: string;
      anchorTierHistogram: { A: number; B: number; C: number; refined: number; border: number };
      reprojectedRectDrift: WelfordRect;
      perAnchorIou: { A: WelfordScalar; B: WelfordScalar; C: WelfordScalar };
    }>;
  }>;

  globals: {
    anchorTierGlobal: { A: number; B: number; C: number; refined: number; border: number };
    consensusConfidenceMean: number;
  };

  createdAtIso: string;
  updatedAtIso: string;
}
```

`isStructuralRefineAnalytics` validates schema, version, and that every Welford-shaped sub-object has the expected fields. Round-trip serialize/parse ensures portability — there is no transient runtime data, no closure references, no in-memory-only handle.

### Incremental analytics
`mergeAnalytics(prior, incoming)`:
- Verifies `compatibility` matches (§7); rejects with a clear error otherwise.
- Concatenates `mergeHistory`.
- Merges every Welford accumulator using the standard parallel-Welford formula (count-weighted mean, M2 combination). All counts and IoU stats are simply additive.
- Sums all histograms.
- Re-derives all derived fields (e.g. `reliability`).

This is what fulfills the "10 docs + 50 docs = 60-doc analytics" requirement. The user uploads the prior analytics file in `StructuralRefineToggle`, and the runner threads it into `merge-analytics` after the batch completes.

---

## 6. Structural Refine Model (Plug-and-Play)

This is the artifact the user downloads, transports to another machine, and uploads as if it were a normal config structural model.

### 6.1 Format
**It IS a `StructuralModel`.** Same contract, same version (`'wrokit/structural-model'`, `version: '4.0'`, `structureVersion: 'wrokit/structure/v3'`), same guard. It passes `isStructuralModel` byte-for-byte.

This is the entire reason the refined model is plug-and-play: any module that today accepts a `StructuralModel` (Run Mode load, Transformation runner config side, `structural-model-io.parseStructuralModel`, the structural store) accepts it without a single line of change.

### 6.2 How `composeRefinedStructuralModel(analytics, configStructuralModel)` builds it

Per page, walk the **config structural model's existing object hierarchy** as the topology skeleton. The refined model preserves the config's object IDs, parent links, and field-relationship structure. Only geometry, confidences, and anchor relationships are refined, using the analytics:

For each page:
- `border`: identity (unchanged — `{0,0,1,1}`).
- `refinedBorder`: `cvContentRectNorm` is left at the config value (it stays the comparable rect); `rectNorm` is recomputed as the union of (a) the config refined border and (b) the bbox-union of all config field BBOXes (preserves the config's containment invariants without consulting any runtime). The `source` becomes `cv-and-bbox-union` if BBOXes existed, else `cv-content`. `containsAllSavedBBoxes` is recomputed honestly.
- `objectHierarchy.objects`: for each config object node, take `objectRectNorm` as `(config rect) shifted by analytics.objects[id].runtimePositionDrift.mean`. This is the batch-learned refined position. `confidence` becomes `analytics.objects[id].reliability` (computed from appearance frequency, projection-IoU mean, and outlier rate). `parentObjectId`, `childObjectIds`, `depth`, and `objectId` are preserved from the config. Objects that essentially never appeared in the batch keep their config rect but get their confidence floored — they're never silently dropped, never relocated to fabricated positions.
- `pageAnchorRelations`: recomputed deterministically from the refined object rects + refined border using existing `object-hierarchy.ts` helpers. (We re-call the existing pure helper; we do not duplicate or rewrite it. The helper is already pure and takes rects in.)
- `fieldRelationships`: copied verbatim from the config — the user-drawn field geometry never moves. Only `containedBy`, `nearestObjects`, `distanceTo*`, and the `objectAnchorGraph` ratios are recomputed against the refined object rects (again via the existing pure helper). The saved field BBOX itself is unchanged.

Identity:
- `id`: new UUID prefixed `refined-`.
- `documentFingerprint`: `'refined:' + analytics.id` so it is distinguishable from any source document fingerprint while remaining a valid string.
- `cvAdapter`: `{ name: 'structural-refine', version: '1.0' }` — honest provenance, single line.
- `createdAtIso`: now.

The output passes `isStructuralModel`. We'll add a unit test that takes a config `StructuralModel`, a synthetic analytics file, runs `composeRefinedStructuralModel`, and asserts (a) the guard passes, (b) every saved field is still contained by `refinedBorder.rectNorm`, (c) field BBOX geometry is byte-identical to config, (d) object IDs match the config, (e) downloading and re-parsing through `structural-model-io` round-trips.

### 6.3 Reuse on a second computer
Because the refined model is a plain `StructuralModel`, the existing Run Mode load path accepts it as the **config** structural model in another browser session, and the existing Transformation runner uses it as the config side without change. There is no hidden runtime state, no batch session dependency, and no special re-uploader needed.

---

## 7. Wizard-Aware Compatibility Signature

`compatibility` on `StructuralRefineAnalytics` is a small structured signature, **not a change to the wizard file format**:

```ts
interface RefineCompatibilitySignature {
  wizardName: string;                              // human label
  wizardFieldCount: number;
  wizardFieldSignature: string;                    // sha256-hex of canonical JSON of fields[]: id|label|type|required, sorted
  configStructuralPageCount: number;
  configStructuralObjectIdSignature: string;       // sha256-hex of sorted objectIds across all config pages
  configRefinedBorderSignature: string;            // sha256-hex of rounded refinedBorder rects per page
  pageSurfaceSignatures: Array<{ pageIndex: number; surfaceWidth: number; surfaceHeight: number }>;
  geometryFieldIdSignature: string;                // sha256-hex of sorted GeometryFile field ids
  createdAtIso: string;
}
```

`signature.ts` builds it from `(WizardFile, GeometryFile, StructuralModel)`. SHA-256 in browser via `crypto.subtle.digest`.

Compatibility check is "practical, not strict": `mergeAnalytics` and the upload accept-handler require `wizardFieldSignature`, `configStructuralObjectIdSignature`, and `pageSurfaceSignatures` to match. Mismatches surface a friendly "this analytics file appears to belong to a different wizard/config — not loaded" message and refuse to merge. Wizard files themselves are unchanged.

---

## 8. Toggle Principle (Strict)

Every code path Structural Refine adds is gated:
- Coordinator `if (refineEnabled) { ... }` — when false, zero new work, zero new artifacts, zero behavior change.
- UI: when toggle is off, `StructuralRefineDownloads` is not rendered and `'refining'` phase is never emitted.
- Tests will include a "toggle off" regression test: run the existing batch-coordinator integration with `refineEnabled: false` and assert byte-equality of `MasterDbTable` output and absence of any new fields on the result envelope.

---

## 9. Test Plan

New unit tests under `tests/unit/`:
- `structural-refine-analytics-guard.test.ts` — schema/version/round-trip, missing-field rejection.
- `structural-refine-merge.test.ts` — Welford parallel-merge correctness (10-doc analytics + 50-doc analytics ≡ 60-doc analytics from one shot).
- `structural-refine-compose.test.ts` — composed model passes `isStructuralModel`, preserves object IDs, contains all saved BBOXes, round-trips through `structural-model-io`.
- `structural-refine-signature.test.ts` — wizard/config signature stability, mismatch rejection.
- `structural-refine-toggle-off.test.ts` — coordinator output byte-identical when toggle off.

New integration test under `tests/integration/`:
- `structural-refine-end-to-end.test.ts` — synthetic 5-document batch with toggle on; assert analytics counts, refined model usability as a config structural model in a second simulated batch, predicted-bbox parity sanity.

---

## 10. Order of Implementation (Suggested Sequencing)

1. Contracts + IO + signature (`structural-refine-analytics.ts`, `structural-refine-analytics-io.ts`, `signature.ts`) + their unit tests.
2. Aggregator + evidence extractor + tests for Welford merge.
3. Compose-refined-model + its unit test (using the existing `object-hierarchy.ts` helper for relations).
4. Runner (`structural-refine-runner.ts`) — pure orchestration boundary.
5. Store (`structural-refine-store.ts`).
6. Coordinator wiring (additive optional inputs + post-loop finalize).
7. Orchestrator wiring (state, callbacks, types).
8. UI: `StructuralRefineToggle` on `UploadBatchSlide`, `StructuralRefineBuildingState` on `ProcessingSlide`, `StructuralRefineDownloads` on `ReviewSlide`.
9. End-to-end integration test.
10. Architecture-doc append: a single new section "Structural Refine (Optional Additive Layer)" describing the rules, with the additive-only invariants spelled out so future agents do not regress them.

---

## 11. Invariants to Encode in Code Review

These should be called out in the new architecture-doc section and enforced by tests:

- Structural Refine modules **must not import** from any existing engine internals beyond `structural-model.ts` types and the pure `object-hierarchy.ts` helper.
- Structural Refine **must not** call any setter on `geometry-store`, `structural-store`, `wizard-store`, `geometry-builder-store`, or any normalized-page session store.
- The refined `StructuralModel` artifact **must pass `isStructuralModel`** and **must round-trip through `structural-model-io`**.
- Field BBOX coordinates inside the refined model's `fieldRelationships` and inside the source `GeometryFile` **must be unchanged** (geometry truth is sacred).
- With the toggle off, the batch coordinator and orchestrator outputs **must be byte-identical** to today.
- `mergeAnalytics(A, mergeAnalytics(B, C)) ≡ mergeAnalytics(mergeAnalytics(A, B), C)` (associativity test) so accumulation order doesn't change results.

---

# Phased Execution Plan

The work below breaks the sequencing in §10 into three phases. Each phase ends in a state where the codebase is green (`npm test` passes) and the existing pipeline is unchanged when the toggle is off. Do not start a phase until the previous one is complete and tests pass.

## Phase 1 — Pure Foundation (Contracts, Engine, Signature, IO)

Goal: ship every pure module Structural Refine needs, fully unit-tested, with **zero** integration into the orchestrator, coordinator, or UI. The user-visible app behaves exactly as it does today after Phase 1 completes.

Deliverables:
1. **Contract**: `src/core/contracts/structural-refine-analytics.ts`
   - `StructuralRefineAnalytics` interface (per §5).
   - `WelfordScalar`, `WelfordAffine`, `WelfordRect`, `WelfordRelative` shared types.
   - `RefineCompatibilitySignature` interface (per §7).
   - `isStructuralRefineAnalytics` runtime guard.
2. **Signature helper**: `src/core/engines/structural-refine/signature.ts`
   - `buildRefineCompatibilitySignature(wizard, geometry, configStructural)` using `crypto.subtle.digest('SHA-256', ...)`.
   - Pure helpers for canonical JSON ordering used inside the hashes.
3. **Aggregator + evidence**: `src/core/engines/structural-refine/aggregator.ts` and `evidence.ts`
   - `extractEvidence({runtimeStructure, transformationModel, predicted, configStructural, configGeometry})` returns the bounded per-document evidence record (no raw model retention).
   - `createAggregator(configStructural)` returns `{ observe(evidence), snapshot(): AggregatorState }`.
   - All Welford updates live here.
4. **Merge**: `src/core/engines/structural-refine/merge-analytics.ts`
   - `aggregatorStateToAnalytics(state, compatibility, batchId)` produces a fresh `StructuralRefineAnalytics`.
   - `mergeAnalytics(prior, incoming)` does the parallel-Welford merge, sums histograms, concatenates `mergeHistory`, re-derives `reliability`. Rejects on signature mismatch.
5. **Compose**: `src/core/engines/structural-refine/compose-model.ts`
   - `composeRefinedStructuralModel(analytics, configStructuralModel)` per §6. Reuses the existing pure helper from `src/core/engines/structure/object-hierarchy.ts` for anchor relations (do not duplicate that logic).
6. **Engine index**: `src/core/engines/structural-refine/index.ts` re-exports the public surface.
7. **IO**: `src/core/io/structural-refine-analytics-io.ts`
   - `serializeStructuralRefineAnalytics`, `parseStructuralRefineAnalytics`, `downloadStructuralRefineAnalytics`. Mirrors `transformation-model-io.ts`.
8. **Tests** (under `tests/unit/`):
   - `structural-refine-analytics-guard.test.ts`
   - `structural-refine-merge.test.ts` — including the associativity property: `mergeAnalytics(A, mergeAnalytics(B, C)) ≡ mergeAnalytics(mergeAnalytics(A, B), C)`.
   - `structural-refine-compose.test.ts` — composed model passes `isStructuralModel`, every saved field still contained by `refinedBorder.rectNorm`, BBOX geometry byte-identical to config, object IDs preserved, round-trips through `structural-model-io`.
   - `structural-refine-signature.test.ts` — stability + mismatch rejection.

Phase 1 exit criteria:
- `npm test` passes.
- No existing file outside `src/core/contracts/`, `src/core/engines/structural-refine/`, `src/core/io/` has been edited.
- Existing UI and pipeline behavior is unchanged.

---

## Phase 2 — Wiring (Runner, Store, Coordinator, Orchestrator) Behind a Disabled Toggle

Goal: thread Structural Refine through the runner → store → batch coordinator → orchestrator, but **leave the toggle defaulted to `false`**. The only externally visible difference at the end of Phase 2 is that internal types now carry the new optional fields and a new `'refining'` phase value exists in the union. With the toggle off (the default), behavior is byte-identical to today.

Deliverables:
1. **Runner**: `src/core/runtime/structural-refine-runner.ts`
   - `createStructuralRefineRunner({wizard, geometry, configStructural, priorAnalytics})` returns:
     - `observe({runtimeStructure, transformationModel, predicted})` — extracts evidence and folds into the aggregator.
     - `finalize({batchId})` — returns `{ analytics, refinedModel }`. Internally: snapshot aggregator → `aggregatorStateToAnalytics` → `mergeAnalytics(priorAnalytics, ...)` if prior present → `composeRefinedStructuralModel`.
2. **Store**: `src/core/storage/structural-refine-store.ts`
   - Implements the existing `observable-store.ts` pattern.
   - Holds: `enabled: boolean`, `priorAnalytics: StructuralRefineAnalytics | null`, `lastOutputs: { analytics, refinedModel } | null`.
   - Async mutators: `setEnabled`, `setPriorAnalytics`, `setLastOutputs`, `clear`.
3. **Orchestrator types**: edit `src/features/polished-wizard/orchestrator/types.ts`
   - Add `structuralRefineEnabled: boolean` (default `false`), `priorRefineAnalytics`, `lastRefineOutputs` fields to `OrchestratorState`.
   - Add `'refining'` to the `BatchProgress.phase` union.
4. **Orchestrator hook**: edit `src/features/polished-wizard/orchestrator/useOrchestrator.ts`
   - Add `setStructuralRefineEnabled`, `setPriorRefineAnalytics` to the API.
   - Pass `refineEnabled` and `priorAnalytics` into `batchCoordinator.run(...)`.
   - On result, stamp `lastRefineOutputs` into state when present.
   - Reset clears all three new fields.
5. **Batch coordinator**: edit `src/features/polished-wizard/batch-coordinator/batch-coordinator.ts`
   - Accept new optional inputs `refineEnabled?: boolean` and `priorAnalytics?: StructuralRefineAnalytics | null`.
   - When `refineEnabled === true`:
     - Construct the refine runner once at the top.
     - After each successful document (after the existing `masterDbRunner.apply` call), call `refineRunner.observe({...})`. Wrap in try/catch so a refine failure never breaks the existing batch — log into a refine-only failure list returned on the result envelope.
     - After the loop, emit `phase: 'refining'`, then call `refineRunner.finalize({batchId})`. Return `{ analytics, refinedModel }` on the result envelope under a new optional field.
   - When `refineEnabled` is falsy, none of the new code runs. The function signature still returns the existing shape (the new field is optional and absent).
6. **Tests** (under `tests/unit/` and `tests/integration/`):
   - `structural-refine-toggle-off.test.ts` — invoke the coordinator with `refineEnabled: false` (and unset) and assert the `MasterDbTable` output and the result envelope are byte-identical to a baseline captured before the wiring change.
   - Extend the orchestrator-level tests (or add a new one) to confirm the new state fields default correctly and reset clears them.
   - A small integration test that exercises `refineEnabled: true` with synthetic stub artifacts and asserts the runner produced a non-null `analytics` and a `refinedModel` that passes `isStructuralModel`. (Full end-to-end with real OCR/normalization stays in Phase 3.)

Phase 2 exit criteria:
- `npm test` passes.
- Toggle-off regression test confirms byte-equality with pre-Phase-2 baseline.
- No UI changes yet.

---

## Phase 3 — UI, End-to-End Test, Architecture Doc

Goal: surface the toggle, the building state, and the downloads in the polished wizard, plus the full E2E test and a documentation update.

Deliverables:
1. **Feature UI**: new directory `src/features/structural-refine/ui/`
   - `StructuralRefineToggle.tsx` — checkbox/toggle labeled **Enable Structural Refine** plus an optional "Upload existing analytics" file input. Wires to the orchestrator's `setStructuralRefineEnabled` and `setPriorRefineAnalytics`. Validates the uploaded file via `parseStructuralRefineAnalytics` + `isStructuralRefineAnalytics` and surfaces a friendly error on mismatch.
   - `StructuralRefineBuildingState.tsx` — small inline status panel ("Building Structural Refine model…").
   - `StructuralRefineDownloads.tsx` — two buttons: download analytics (calls `downloadStructuralRefineAnalytics`) and download refined structural model (calls the existing `downloadStructuralModel`). Visible only when `lastRefineOutputs` is non-null.
   - `structural-refine.css` — feature-local styles only; no edits to global tokens or shared CSS files.
2. **Slide edits** (additive; do not refactor surrounding markup):
   - `src/features/polished-wizard/ui/slides/UploadBatchSlide.tsx` — render `<StructuralRefineToggle />` between the dropzone and the footer.
   - `src/features/polished-wizard/ui/slides/ProcessingSlide.tsx` — when `batchProgress.phase === 'refining'`, render `<StructuralRefineBuildingState />`.
   - `src/features/polished-wizard/ui/slides/ReviewSlide.tsx` — render `<StructuralRefineDownloads />` next to the existing CSV download buttons when `lastRefineOutputs` is non-null.
3. **Integration test**: `tests/integration/structural-refine-end-to-end.test.ts`
   - Synthetic 5-document batch with toggle on; assert analytics counts and document count, refined model usability as a config structural model in a second simulated batch (load it as the config side and run another batch through it cleanly), predicted-bbox parity sanity (ensures geometry was not corrupted).
4. **Documentation**: append a new section to `docs/architecture.md` titled **Structural Refine (Optional Additive Layer)** that captures the rules in §11 verbatim plus a one-paragraph summary of the architectural position from §1. Do not edit any other section of the doc.

Phase 3 exit criteria:
- `npm test` passes including the new E2E test.
- Manual smoke check in the dev server: with toggle off the wizard works exactly as before; with toggle on, the "All set!" page shows the toggle, the processing screen briefly shows "Building Structural Refine model…", and the Review page exposes the two new download buttons. The downloaded refined structural model loads successfully through the existing Run Mode upload path on a second session.
- `docs/architecture.md` has the new section appended.

---

## Cross-Phase Reminders for the Implementing Agent

- **Additive-only**: do not edit any existing engine internals, contracts, IO modules, or runners outside the explicit touch-points in §3 / Phase 2.
- **Geometry truth is sacred**: never modify a saved Field BBOX, the original `GeometryFile`, the original config `StructuralModel`, runtime `StructuralModel`s, or `TransformationModel`s. The refined model copies field BBOXes byte-for-byte from the config.
- **No hidden runtime state**: `StructuralRefineAnalytics` and the refined `StructuralModel` must be fully-described JSON artifacts that round-trip through their respective IO modules.
- **Storage discipline**: never retain raw runtime artifacts in the aggregator. Drop per-document evidence the moment it has been folded into the running statistics.
- **Toggle discipline**: every new code path is behind `refineEnabled`. The toggle-off regression test is the canary — if it ever drifts, you have introduced a non-additive change.
