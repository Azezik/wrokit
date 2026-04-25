# Wrokit V2 Agent Rules

## Mission

Wrokit is a modular human-in-the-loop file ingestion engine.

Its purpose is to let a developer define a Wizard File for the data they need, then let an end user visually identify fields once so future matching documents can be extracted automatically.

## Core Principle

Human-confirmed BBOX geometry is the highest authority.

Machine structure exists to explain, preserve, relocate, and validate user-confirmed geometry. It must never replace the user’s confirmed selection unless the user explicitly corrects it.

## Architecture Rules

1. Keep modules isolated.
2. No module should directly depend on UI state.
3. Engines communicate through typed contracts only.
4. PDF is only an intake format.
5. After intake, all processing happens on normalized raster pages.
6. OCR must be localized whenever possible.
7. Do not add full-page OCR unless explicitly requested.
8. Do not add PDF.js text-layer extraction.
9. Do not couple wizard config to extraction runtime.
10. Store human geometry separately from machine structural interpretation.
11. Keep the project compatible with static hosting on GitHub Pages unless explicitly changed later.
12. Do not require a backend at this stage.

## Required Layers

- Wizard File: developer-defined extraction intent.
- Normalized Page: uniform raster output.
- Geometry File: human-confirmed BBOX truth.
- Structural Model: machine-readable visual layout map.
- Runtime Localization: applies saved geometry and structure to new files.
- OCR Readout: extracts only from finalized localized boxes.
- Confidence Model: explains extraction reliability.

## Development Style

Prefer small implementation steps.

Each step should:
- add one module or contract at a time
- include testable output
- avoid architectural rewrites
- preserve existing contracts
- update README or docs when behavior changes

## Forbidden Shortcuts

Do not:
- use PDF text tokens as extraction authority
- merge geometry and structure into one unclear object
- let OCR determine field location globally
- build monolithic app logic
- hide transform failures behind fallback success
- make UI overlays display unsaved or guessed geometry as if confirmed

Do not implement real OCR.
Do not implement real OpenCV.
Do not use PDF.js text extraction.
Do not build runtime extraction yet.

Keep this as a clean starting commit.
