// W3 (audit §3.1/§8.1) — the THIRD answer mode's prompt builder: an LLM answer NARRATED over a
// deterministically extracted + validated data object. Today a tool-skill question either hits a fixed
// template (no model, wrong-question interception) or the raw-chunk relevance path (no structure). This
// mode hands the model the SMALL, already-validated object the extractor produced and lets it answer the
// ACTUAL question over verified data — quoting figures verbatim, never computing one. The figures stay the
// parser's; the model only reads them (the §8.1 division of labor). Kept in its own file (plan §W3: "new
// small prompt builder — prefer a new file") so it is pure + unit-testable with no DB/runtime imports —
// `generateGroundedDataAnswer` in `index.ts` does the streaming orchestration around it.

/**
 * The STABLE, model-facing rules for the grounded-data turn (fixed English, app-authored — D-L6
 * precedent; they ride in the USER turn WITH the data, never `system`, exactly like the skill fence and
 * the whole-doc truncation notice). They forbid the one thing the model must never do here — invent or
 * DERIVE a figure — while `GROUNDED_SYSTEM_PROMPT` supplies the general grounding posture. The model
 * still answers in the user's language (the last rule); the rules themselves stay byte-stable so the
 * cache prefix is preserved.
 */
export const GROUNDED_DATA_RULES =
  'Answer the question using ONLY the extracted data below. Every figure, date, name, and total in it ' +
  'was parsed and reconciled deterministically from the whole source document — quote them EXACTLY as ' +
  'they appear, character for character. Do NOT do arithmetic and do NOT add, subtract, total, convert, ' +
  'or otherwise derive any number that is not already written in the data; do NOT invent a value. If the ' +
  'data does not contain the fact asked for, say plainly that the extraction does not carry it rather ' +
  'than guessing. Answer in the same language as the question.'

/**
 * Build the grounded USER turn for the THIRD answer mode (audit §8.1). Mirrors `buildGroundedPrompt`'s
 * shape — the question, the optional skill fence (untrusted reference text, in the user turn — skills
 * plan §11.2/§22-H2), then the authoritative block, then `Answer:` — but the block is the serialized
 * VERIFIED object (JSON + reconciliation results + provenance) and the rules forbid arithmetic. Pure +
 * unit-testable (no DB/runtime). `skillFence` absent ⇒ the fence block is omitted byte-for-byte.
 */
export function buildGroundedDataPrompt(
  question: string,
  dataBlock: string,
  skillFence?: string | null
): string {
  const skillBlock = skillFence ? `\n${skillFence}\n` : ''
  return `Question:
${question}
${skillBlock}
${GROUNDED_DATA_RULES}

Extracted data (deterministically parsed and validated from the whole document):
${dataBlock}

Answer:`
}
