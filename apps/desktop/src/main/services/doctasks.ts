// Document task service (architecture.md "Document tasks"; wave-3 plan §6–§8, now in
// architecture.md "Functionality wave 3 — design record") — the shared engine for summary,
// translation, compare, ocr, tree/extract, and categorize. The former 1582-line monolith was
// first split (audit M-A4) into a `doctasks/` directory; then DX-1 (full-audit-2026-06-29
// follow-up Phase 8, architecture.md §38) moved each kind's WORK into `handlers/`. This barrel
// still preserves the public import surface byte-for-byte, so every `from '../services/doctasks'`
// caller is unchanged:
//
//   - doctasks/summary.ts     — summary window math + map-reduce prompts
//   - doctasks/translation.ts — translation window math + templates
//   - doctasks/compare.ts     — compare window math + templates + the pure `alignNodes` (mirror)
//   - doctasks/manager.ts     — the DocTaskManager queue/pump/arbiter + the generate/retry loop +
//                               friendly-error helpers; re-exports `DocTaskDeps` for the barrel
//   - doctasks/context.ts     — leaf vocabulary: `DocTaskDeps` / `InternalTask` / `DocTaskCtx`
//   - doctasks/handlers/*     — the per-kind run-fns keyed by `MODEL_TASK_HANDLERS`
//                               (`index.ts` registry, `shared.ts` doc helpers, then
//                               tree/summary/ocr/translation/compare/categorize). INTERNAL: the
//                               manager dispatches to them; they are NOT part of this surface.
//
// The window-math / prompt functions (and the friendly-error message constants) stay
// individually re-exported because the unit tests (`doctasks-windows.test.ts`) and the manual
// smoke harnesses import them by name; the handler run-fns are NOT re-exported (no caller imports
// them through this barrel — verified against the doctasks test suite), so the exports are
// exactly the four below (adding `context`/`handlers` would also collide on `DocTaskDeps`).

export * from './doctasks/summary'
export * from './doctasks/translation'
export * from './doctasks/compare'
export * from './doctasks/manager'
