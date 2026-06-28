// Document task service (architecture.md "Document tasks"; wave-3 plan §6–§8, now in
// architecture.md "Functionality wave 3 — design record") — the shared engine for
// summary, translation, and compare. The former 1582-line monolith was split (audit M-A4)
// into a `doctasks/` directory behind this barrel, which preserves the public import
// surface byte-for-byte so every `from '../services/doctasks'` caller is unchanged:
//
//   - doctasks/summary.ts     — summary window math + map-reduce prompts
//   - doctasks/translation.ts — translation window math + templates
//   - doctasks/compare.ts     — compare window math + the two-mode templates
//   - doctasks/manager.ts     — the DocTaskManager orchestration + friendly-error helpers
//
// The window-math / prompt functions stay individually re-exported because the unit tests
// (`doctasks-windows.test.ts`) and the manual smoke harnesses import them by name.

export * from './doctasks/summary'
export * from './doctasks/translation'
export * from './doctasks/compare'
export * from './doctasks/manager'
