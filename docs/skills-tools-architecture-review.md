# Skills & tools architecture review — how we compare to the 2026 state of the art

_A point-in-time review (2026-07-19), owner-requested. It answers one question: is HilbertRaum's
skills-and-tools design (app-orchestrated tools, no native LLM tool calling) state of the art for an
offline local-LLM app, or a design flaw?_

**Method.** The as-built architecture was mapped from code and the design records
([`architecture.md`](architecture.md) Skills design record, [`security-model.md`](security-model.md)
skill-tool ceiling, [`skills-overview.md`](skills-overview.md)), then compared against web research
(2025–2026 sources) on: llama.cpp native tool calling, constrained decoding, small-model
function-calling benchmarks (BFCL), the Anthropic Agent Skills open standard, MCP, agent
permissioning norms, and tool-routing practice. Sources are cited inline; single-sourced or
unverified claims are flagged.

## 1. Verdict up front

**The architecture is state of the art for its constraints — and in several places it independently
implements exactly what the industry converged on during 2025–2026.** The core choice under
review — *the model never calls tools; the app orchestrates, the model fills narrow verified
slots* — is not a gap relative to "LLMs with tool support". It is the documented best practice for
this app's regime (4B-class default model, 4–8k context, offline, high-reliability document tasks).
Adopting a native tool-calling loop as the control-flow backbone would be a regression, not a
modernization.

Real improvement potentials exist (§5), but they are refinements inside the current architecture,
not a change of architecture.

| Design choice (as built) | 2026 state of the art | Verdict |
|---|---|---|
| App-orchestrated tools; model never emits `tool_calls` (DS4) | Workflows over autonomous agents for narrow, high-reliability tasks; small models unreliable at native multi-turn tool calling | ✅ Matches — validated by benchmarks and all major vendor guidance |
| Grammar-constrained JSON via `response_format: json_schema` → GBNF (D55), temp 0, thinking off | Constrain the wire format, never the reasoning; validate semantically after | ✅ Matches best practice |
| "Locate" pattern: model points at spans, app verifies byte-exact + splices (D58) | Anchored search/replace with app-side verification (Anthropic `str_replace`, Aider, Agentless) | ✅ Matches / leads (occurrence-anchoring + byte-identity by construction) |
| Read-only tools auto-run; writes always confirm; capabilities unreachable by construction | HITL for irreversible actions (OWASP Agentic Top 10); "containment at the environment layer first" (Anthropic) | ✅ Matches — stricter than Claude Code's `allowed-tools` |
| SKILL.md packs (frontmatter + markdown body, localized, semver) | Agent Skills open standard (agentskills.io, Dec 2025), adopted cross-vendor | ✅ Convergent; **ahead** on i18n and versioning; differs deliberately on script execution |
| Deterministic keyword suggestion, CI-gated ≥95% auto-fire precision | Keyword routing legitimate below ~10–20 tools; embedding retrieval above that | ✅ Right-sized at 9 skills; revisit if the catalog grows |
| No MCP | MCP solves cross-vendor N×M interop; overkill for a single app owning both sides | ✅ Correctly not adopted |
| Ingest extract pass is prompt-only JSON (no grammar) + salvage/retry | Grammar-constrain every structured surface | ⚠️ Improvement potential (§5.1) |
| Deterministic router structurally can't serve some intents (issue #54 class) | Hybrid cascade: deterministic fast path + constrained model classification as fallback | ⚠️ Improvement potential (§5.2) |

## 2. The as-built architecture in one paragraph

A skill is a local `SKILL.md` pack (validated frontmatter, restrict-only permission clamping,
app-assigned trust by folder — self-declared trust ignored). It shapes **one turn**: the body is
injected as a fenced, explicitly-untrusted reference block, pre-sized so trimming (whole paragraphs
only; honesty rules merged into paragraph 1 so they survive) can never starve the base prompt.
Suggestion is fully deterministic (bilingual keyword/MIME/filename scoring; offer at score ≥ 2,
opt-in auto-fire at ≥ 3 with a CI-gated ≥95% precision bar). Tools are a static app-owned registry
(12 tools); the effective set is `declared ∩ registry ∩ wired`, runnable **only** for app-source
skills, behind a validate-input → run-in-frozen-context → validate-output gate, with writes always
user-confirmed. The model talks to a loopback `llama-server` via OpenAI-compatible
`/v1/chat/completions` — plain messages, **no `tools` parameter anywhere**; structured outputs are
grammar-constrained (`json_schema` → GBNF) and re-validated in code; for redaction/edit the model
only *locates* spans that the app verifies byte-exact before splicing (byte-identity outside
verified spans by construction). Figures (balances, totals) are computed deterministically — the
model explains validated results, it never produces them.

## 3. What the research says — and how we score against it

### 3.1 Native tool calling with small local models: real, but the wrong backbone

- llama.cpp does support OpenAI-style `tools`/`tool_choice` behind `--jinja` (lazy-grammar
  mechanism, format parsers for Llama 3.x, Qwen 2.5, Mistral Nemo, Hermes, …), but reliability
  hinges on the exact GGUF's embedded chat template, and **thinking models are a documented source
  of parse failures** (HTTP-500 on reasoning prefixes, ggml-org/llama.cpp#20260; malformed
  tool-call XML ~1/128 calls on Qwen3 thinking, #24807). The docs also warn that extreme KV-cache
  quantization "can substantially degrade tool calling".
- Small models are weak at it where it matters: **Qwen3-4B scores ~35% on BFCL multi-turn**
  (arXiv 2508.05118); practitioner fine-tunes of 8B models report 10–22% multi-turn; multiple 2026
  local-LLM evaluations converge on a **~7–9B capability cliff** for dependable native tool
  calling. Our bundled default is a **4B** model at 4–8k context.
- Vendor guidance is unanimous. Anthropic ("Building Effective Agents", 2024-12): workflows —
  "LLMs and tools orchestrated through predefined code paths" — for predictable tasks; agents only
  where flexibility is genuinely needed. OpenAI's agents guide: "a deterministic solution may
  suffice"; Google's agents whitepaper endorses "non-deterministic reasoning governed by hard-coded
  rules". The compounding-error arithmetic (95% per-step accuracy → ~60% over 10 steps — Chip
  Huyen, 2025-01) is decisive for small models.

**Score: our DS4 posture ("the model never parses `tool_calls`; it only explains a validated
result") is the textbook answer for this regime.** The app owns control flow; the model fills
narrow schema-constrained slots (categorize, locate, extract). That is precisely the
"state-of-the-art hybrid" the research synthesis lands on.

### 3.2 Constrained decoding: we do it right, with one gap

The 2024 "structure hurts reasoning" scare (arXiv 2408.02442) was rebutted (dottxt, Nov 2024) and
contradicted at scale (JSONSchemaBench, arXiv 2501.10868: constraints *improved* accuracy):
the rule is **constrain the final payload, never the reasoning**. Our grammar surfaces (categorizer,
enricher, both locate passes) run at temperature 0 with thinking off and re-validate every field in
code (defense-in-depth for the mock runtime and against semantic garbage — grammar guarantees
syntax, not values, which the design record states explicitly).

One caveat from llama.cpp's own docs: the schema is **not** injected into the prompt ("the model
has no visibility into the schema") — the prompt must describe the shape too. Ours do.

**Gap:** the ingest-time extract pass ([`extract.ts`](../apps/desktop/src/main/services/analysis/extract.ts))
is the one structured surface still using prompt-only JSON with tolerant parsing + retry + salvage
instead of a grammar. See §5.1.

### 3.3 The locate pattern: independently matches the industry consensus

The document-edit/redaction contract — model proposes `{line, find, occurrence, replace}` /
`{text, category, line}` under grammar at temp 0; app confirms the string **byte-exact at its
anchor** and drops anything unverified; splice preserves byte-identity outside spans — is the same
shape as Anthropic's `str_replace` editor tool (must match exactly; app applies), Aider's
SEARCH/REPLACE blocks, and the Agentless paper's search/replace-over-diffs finding. The research's
"universally cited villain" is trusting model-computed **line numbers**; we use the line only as a
locality hint and verify the string itself, which sidesteps that failure mode. Cursor-style "second
apply model" approaches exist but are overkill offline — fidelity in app code is the right
placement here. **No change recommended.**

### 3.4 Skill packaging: we converged on the standard before it was one — with deliberate differences

Anthropic's Agent Skills (launched 2025-10, **opened as a cross-vendor standard at agentskills.io
2025-12-18**; by early 2026 reportedly read by 30+ tools — single-sourced figure, flagged) is the
same shape as our packs: YAML frontmatter (`name`+`description` required) + markdown instruction
body + bundled resources, with model-driven progressive disclosure (metadata always in context;
body loaded on trigger).

Where we differ, the differences are defensible or favorable:

- **Localization: we are ahead of the spec.** The open SKILL.md spec has *no* i18n mechanism at
  all; our `localized:` per-locale display overrides fill a real gap (Anthropic's own MCPB bundle
  format solved it the same way — BCP-47-keyed overrides).
- **Versioning: we are stricter.** The spec has no first-class `version` (a `metadata` convention
  at best); we require strict semver plus `minAppVersion` compatibility gating, and a parity test
  pins the docs to the catalog.
- **Script execution: we deliberately don't.** The standard's skills bundle executable scripts run
  by the host — and the standard's `allowed-tools` is "permissive, not restrictive". Security
  research (ReversecLabs, 2026-05) demonstrated working exploit chains through malicious skill
  frontmatter in Claude Code (consent-prompt bypass, reverse shell). Our posture — imported skills
  are instruction-only, can never run tools (`skillCanRunTools` = app-source only), permissions
  clamp restrict-only, trust is app-assigned not self-declared — is materially **stronger** than
  the ecosystem norm, at the cost of imported skills being less powerful. For a privacy-first
  offline product this is the right trade.
- **Progressive disclosure vs one-skill-per-turn:** Anthropic loads all skill metadata and lets the
  model choose; we run a deterministic suggester and inject at most one skill. With 9 skills, a 4B
  model, and 4–8k context, model-driven selection would spend scarce context and trust scarce
  capability for no gain. Right call at this scale (revisit condition in §5.3).

### 3.5 Permissioning: matches (and anticipates) industry norms

The read-auto/write-confirm split with fixed system-level gates is exactly the emerging norm:
Claude Code's read-only-by-default + permission prompts, OpenAI Operator/ChatGPT-agent
confirm-before-consequential-action, OWASP Agentic Top 10 (Dec 2025) naming "Excessive Agency" with
HITL + least privilege as mitigations. Two details deserve highlighting as *better* than typical:
the gate is enforced in the app (a model or forged IPC cannot talk its way past it — contrast
Cline, where the model itself classifies whether a command needs approval), and tool contexts carry
no DB/FS/network handles at all — matching Anthropic's 2026 containment guidance ("design for
containment at the environment layer first") almost verbatim. Simon Willison's "lethal trifecta"
(private data + untrusted content + external communication) is structurally broken here: skills
have no network, ever.

### 3.6 MCP: correctly not adopted

MCP's value is N×M interop between independently-authored clients and servers; that problem does
not exist in a single app owning both sides of a fixed 12-tool registry. The protocol's own
trajectory (OAuth bolted on across four revisions; tool-poisoning / rug-pull attack literature;
OWASP MCP Top 10) adds surface we don't need. Function-calling-style internal APIs are the
documented right choice for a fixed first-party tool set (Descope comparison; Willison's
context-pollution critique). **No change recommended** — and the hard no-network rule makes remote
MCP moot anyway.

## 4. Flaws looked for and not found

- **"We should let the model call tools" — no.** §3.1: at 4B–9B, native tool calling is the less
  reliable path, and every relevant vendor's guidance says to prefer predefined code paths for
  narrow high-reliability tasks. The design records already state the feasibility rationale;
  the research confirms it independently.
- **"Keyword suggestion is primitive" — not at this scale.** The critiques of keyword routing
  (brittleness, maintenance) target catalogs of tens-to-thousands of tools; below ~10–20 tools no
  framework recommends anything heavier. Our version is unusually disciplined for the pattern:
  single-sourced bilingual vocabulary (drift-proof by parity test), word-boundary matching,
  doc-signal corroboration, and an offline eval harness gating auto-fire precision ≥ 0.95 in CI.
- **Prompt-injection posture.** Skill bodies enter the prompt as explicitly-fenced *reference
  text* below an app-authored guard, never as system rules; honesty rules survive trimming by
  construction; fence echoes are scrubbed. This addresses the same attack class the MCP
  tool-poisoning literature describes, at the layer we actually have.

## 5. Improvement potentials (ranked)

### 5.1 Grammar-constrain the ingest extract pass (small, targeted)

The extract pass is the one model surface using prompt-only JSON ("Reply with ONLY a JSON array")
with tolerant parse → retry-with-escalated-cap → salvage. Moving it to the same
`responseSchema` (GBNF) contract as the categorizer would eliminate the prose/code-fence/unparseable
failure class at the source (the #50 reasoning-collapse hardening remains necessary — a grammar
does not stop thinking from burning the token budget, see §5.4 — and `salvageTruncatedArray` stays,
since cap-truncation can still cut a grammatical array mid-flight). Expected win: fewer wasted
retry calls on ingest, fewer `unparsed` markers under reasoning-prone models. Cost: low; the
runtime plumbing (D55) already exists.

### 5.2 A constrained model-classification fallback for the router (the issue #54 class)

The deterministic router is structurally unable to represent some intents — issue #54
("categorize + sum per category") had to be resolved with an honest hint because the only engine
that can serve the ask is unreachable without a turn skill. The routing literature's recommended
shape for exactly this is a **hybrid cascade**: deterministic fast path for confident traffic, a
cheap constrained model call only for the ambiguous residue. Concretely: when the router lands on a
low-confidence fallback, one grammar-constrained single-shot classification (enum of engines /
skill pointers, temp 0 — the same D55 machinery, *not* a tool-calling loop) could route or
recommend with much better coverage, while preserving the 0-model-call happy paths and the
auto-fire consent posture (it may *suggest* a skill, never activate one). This is the highest-value
functional improvement available inside the current architecture; it also future-proofs the
"suggestions" quality as skills grow.

### 5.3 Register the scale-up condition for suggestion (do nothing now)

Deterministic keyword suggestion is right at 9 skills. The literature's degradation zone starts
around 10–20 candidates. If the catalog (including user-imported skills with trigger vocabularies)
approaches that, the documented next step is embedding-based suggestion — and we already ship a
local embedder for RAG, so it stays offline. Worth a line in the design record as a revisit
trigger, not worth building today.

### 5.4 Model-policy note: prefer non-thinking checkpoints for structured surfaces

Qwen dropped hybrid thinking with the 2507 refresh — Instruct and Thinking are now separate
checkpoints, and `enable_thinking` kwargs are moot on split checkpoints. The #50 lesson ("model
reasons anyway despite the kwarg, burns the extract budget") generalizes: for grammar/extract/locate
surfaces, the robust control is **which checkpoint the catalog recommends**, not a template kwarg.
Suggestion: when ratifying the Qwen3.5/3.6 wave (BUILD_STATE §5 item 8), record thinking-mode
behavior per manifest as a first-class criterion for structured-surface suitability (the §9
criteria already name thinking support — extend the note to cover the extract/locate implications),
and keep structured-surface calls pinned to non-thinking behavior.

### 5.5 Optional, low-priority: Agent Skills interop note

SKILL.md is now an open standard with multi-vendor adoption. Our format predates and differs from
it (`id`/`title` vs `name`; first-class `version`; `localized`). Full convergence is not worth
churn, but a short mapping note in the skills design record (what an agentskills.io-conformant pack
would need to become importable — body + metadata import is near-trivial; scripts/`allowed-tools`
are and should remain unsupported) would cheaply keep the door open to the growing skills
ecosystem without importing its security model.

### 5.6 Watch item: native tool calling for the 27B tier — still no

If a future wave targets 14B–27B models as primary (where BFCL reliability improves), the research
still recommends native tool calls only as *single-shot, low-arity selection behind grammar
constraints and app-side argument validation* — i.e. a variant of §5.2, not an agent loop. The
`supports_tools` manifest key (currently ignored by design, model-policy.md) is the natural place
such a capability flag would land. No action now; recorded so the decision trail exists.

## 6. Bottom line

The question "some LLMs support tool calling — are we missing it?" has a clear answer: **we are not
behind the state of the art; we are an instance of it.** The 2025–2026 industry converged on
exactly this stack for high-reliability work with small models — deterministic orchestration,
grammar-constrained narrow model slots, anchored-and-verified edits, human confirmation for writes,
capability containment in the app layer — and HilbertRaum implements each of these with unusual
rigor (CI-gated precision bars, parity-pinned docs, byte-identity proofs). The improvement list is
short and incremental: close the one unconstrained JSON surface (§5.1), add a constrained
classification fallback where deterministic routing provably can't reach (§5.2), and keep
model-catalog policy aligned with the thinking-checkpoint split (§5.4).

## 7. Key sources

Codebase: `apps/desktop/src/main/services/skills/*` (registry, tool-registry, run, prompt,
selector, autofire, locate tools, span-transform), `apps/desktop/src/main/services/runtime/llama.ts`
(D55 `response_format`; no `tools` param), `apps/desktop/src/main/services/analysis/{router,extract}.ts`,
[`architecture.md`](architecture.md) (Skills design record — DS1–DS8, D55, D58, D75, §18 auto-fire
D1–D6), [`security-model.md`](security-model.md) (skill tool ceiling), [`model-policy.md`](model-policy.md).

External (accessed 2026-07-18, flagged where single-sourced):

- llama.cpp `docs/function-calling.md`, `grammars/README.md`, `tools/server/README.md`; issues
  #20260, #24807, #20867 (tool-calling failure modes).
- BFCL v3/v4 (gorilla.cs.berkeley.edu; PMLR v267); arXiv 2508.05118 (Qwen3-4B multi-turn ~35%);
  Databricks function-calling eval (2024-08); arXiv 2511.22138 (edge function-calling taxonomy).
- Constrained decoding: arXiv 2408.02442 vs dottxt "Say What You Mean" (2024-11) and
  JSONSchemaBench arXiv 2501.10868 (2025-01).
- Anthropic "Building Effective Agents" (2024-12-19); "How we contain Claude" (2026-05-25); OpenAI
  "A Practical Guide to Building Agents" (2025); Google "Introduction to Agents" (2025-11); Chip
  Huyen "Agents" (2025-01-07); Martin Fowler function-call article (2025-05-06).
- Editing patterns: Anthropic text-editor tool docs (`str_replace`); aider.chat edit-formats +
  unified-diffs; cursor.com "Instant Apply" (2024-05); arXiv 2407.01489 (Agentless).
- Agent Skills: agentskills.io/specification; anthropic.com engineering blog (2025-10-16);
  labs.reversec.com "Skill Issues" (2026-05); adoption figures via paperclipped.de (2026-03,
  single-sourced). MCPB manifest (localization precedent).
- MCP: modelcontextprotocol.io changelogs (2025-03-26 / 2025-06-18 / 2025-11-25); Invariant Labs
  tool-poisoning disclosure (2025-04); OWASP MCP Top 10; Descope "MCP vs function calling";
  simonwillison.net (2025-06-16 "lethal trifecta"; 2025-11-04 code-execution-with-MCP).
- Permissioning: code.claude.com permission-modes/security docs; OWASP Top 10 for Agentic
  Applications (2025-12-09); OpenAI Operator/ChatGPT agent announcements (2025, secondary-sourced);
  Gemini 2.5 Computer Use (2025-10-07).
- Routing at scale: LangChain "Context Engineering for Agents" (2025-07-02, 3× tool-selection gain
  from RAG-over-tools); OpenAI function-calling guide (&lt;20 tools/turn); vLLM Semantic Router
  (2025-11-07); Re-Invoke arXiv 2408.01875.

Qwen thinking-mode split: qwenlm.github.io Qwen3 blog (2025-04); Qwen 2507 announcement
(2025-07-22); qwen.readthedocs.io function-call guidance (Hermes-style templates recommended).
