// Declarations for text.mjs (plain ESM JS shared with eval/rescore.mjs — see its header).
// Pre-existing typecheck gap fixed alongside Phase 31: score.ts imports './text.mjs' and
// tsc has no declarations for .mjs files without this sibling.

export function normalizeText(s: string): string
export const ABSTAIN_PHRASES: string[]
export function isAbstention(answer: string): boolean
