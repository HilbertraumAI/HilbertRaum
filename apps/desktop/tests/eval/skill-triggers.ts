// Skills S13a — the offline trigger-evaluation harness (skills-s13-plan.md §3.2/§3.3).
//
// Pure measurement over a labelled SYNTHETIC corpus, driven through the PRODUCTION paths: the inert
// suggestion offer (`suggestSkillsForTurn`) and the silent auto-fire decision (`resolveAutoFireSkill`),
// both against a real temp database that reconciles the committed `app-skills/`. There is no second copy
// of the selector here — a selector, vocabulary or manifest change reaches the corpus exactly as it
// reaches a user. NO model, NO network; the database is a throw-away file under a `hilbertraum-` temp dir.
//
// Privacy (skills-s13-plan.md §6): a question is CONTENT — it is scored here and NEVER logged. This
// module returns ids/labels/counts only; nothing here writes the question text to any sink.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { updateSettings } from '../../src/main/services/settings'
import { createConversation } from '../../src/main/services/chat'
import { addToCollection, createCollection } from '../../src/main/services/collections'
import { listSkills, reconcileSkills } from '../../src/main/services/skills/registry'
import { suggestSkillsForTurn } from '../../src/main/services/skills/suggest'
import { resolveAutoFireSkill } from '../../src/main/services/skills/autofire'
import { APP_VOCAB_SKILL_IDS } from '../../src/main/services/skills/vocabulary'

/** The repo root, four levels up from tests/eval/. */
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
/** The version `app.getVersion()` reports in production, so the §6.5 minAppVersion gate runs as it does
 *  for a user (an empty version would treat every skill as compatible). */
const APP_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'package.json'), 'utf8')) as { version: string }
).version

/** One in-scope document's matchable signals (filename + MIME). */
export interface CorpusDoc {
  title: string
  mimeType: string
}

/** One labelled corpus turn (skills-s13-plan.md §3.1). `note` is documentation, never scored. */
export interface CorpusItem {
  id: string
  question: string
  inScopeDocs: CorpusDoc[]
  /** The ground-truth skill id, or 'none' if no skill should fire. */
  expected: string
  /** W5 (audit §8.3): a CROSS-SKILL confusion pair the SUGGESTION policy must get right (fired-wrong 0
   *  over the confusion subset is an asserted bar) — one skill's keyword must win over another's docs or
   *  weaker keyword. Not scored differently; it only marks the subset the bar filters. */
  confusion?: boolean
  /**
   * U4 (audit §4.4): the DOC-SCOPE shape. `'narrowed'` (default) — the `inScopeDocs` are EXPLICITLY in
   * scope (a chat attachment or a hand-pick), so both the suggestion AND the auto-fire path see them.
   * `'whole-corpus'` — the `inScopeDocs` are merely present in a collection the conversation is scoped
   * to, NOT explicitly selected: the inert SUGGESTION offer still reads them, but AUTO-FIRE narrows them
   * away (`explicitDocumentsOnly`), so they contribute no corroborating signal to a silent fire.
   */
  scope?: 'narrowed' | 'whole-corpus'
  note?: string
}

/** Load the committed synthetic corpus (text only — no user data). */
export function loadCorpus(): CorpusItem[] {
  const path = join(REPO_ROOT, 'apps', 'desktop', 'tests', 'fixtures', 'skill-triggers', 'corpus.json')
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { items: CorpusItem[] }
  return parsed.items
}

/** The production-path adapter: one real database, the committed app skills, one isolated scope per row. */
export interface TriggerHarness {
  db: Db
  /** The skill id the inert suggestion offer ranks first for this row, or 'none'. */
  offerFor(row: CorpusItem): string
  /** The skill id the silent auto-fire decision applies for this row, or 'none'. */
  autoFireFor(row: CorpusItem): string
  /** Close the database and remove its temp directory. */
  close(): void
}

const stripApp = (installId: string | undefined): string =>
  installId === undefined ? 'none' : installId.replace(/^app:/, '')

/**
 * Open the harness. Every row gets its OWN scope inside the one shared database, so a row never sees
 * another row's documents (and the resident signal cache can never hand one row's signals to another):
 *  - docs + `narrowed` (the default): the docs as `indexed` documents + a conversation scoped to those
 *    document ids (explicit — what an attachment or a hand-pick looks like);
 *  - docs + `whole-corpus`: the docs in a per-row collection + a conversation scoped to that collection;
 *  - no docs: an empty per-row collection (never the Library).
 */
export function openTriggerHarness(): TriggerHarness {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-skill-triggers-'))
  const db = openDatabase(join(root, 'test.sqlite'))
  const deps = {
    appSkillsDir: join(REPO_ROOT, 'app-skills'),
    userSkillsDir: join(root, 'user-skills'),
    appVersion: APP_VERSION
  }
  const rec = reconcileSkills(db, deps)
  if (rec.errors.length > 0) throw new Error(`reconcileSkills reported errors: ${rec.errors.join('; ')}`)
  // App skills install enabled (reconcile); fail loudly if a committed skill did not come up.
  const enabled = new Set(listSkills(db).filter((s) => s.source === 'app' && s.enabled).map((s) => s.id))
  for (const id of APP_VOCAB_SKILL_IDS) if (!enabled.has(id)) throw new Error(`app skill '${id}' is not enabled`)
  updateSettings(db, { skillsAutoFireEnabled: true })

  const convByRow = new Map<string, string>()
  const seedDoc = (d: CorpusDoc): string => {
    const now = new Date().toISOString()
    const id = randomUUID()
    db.prepare(
      `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?, ?)`
    ).run(id, d.title, d.mimeType, now, now)
    return id
  }
  const conversationFor = (row: CorpusItem): string => {
    const cached = convByRow.get(row.id)
    if (cached) return cached
    const docIds = row.inScopeDocs.map(seedDoc)
    let convId: string
    if (docIds.length > 0 && row.scope !== 'whole-corpus') {
      convId = createConversation(db, {
        mode: 'documents',
        scope: { collectionIds: [], documentIds: docIds }
      }).id
    } else {
      const coll = createCollection(db, `skill-triggers ${row.id}`)
      if (docIds.length > 0) addToCollection(db, docIds, coll.id)
      convId = createConversation(db, { mode: 'documents', collectionId: coll.id }).id
    }
    convByRow.set(row.id, convId)
    return convId
  }

  return {
    db,
    offerFor: (row) =>
      stripApp(suggestSkillsForTurn(db, conversationFor(row), row.question, APP_VERSION)[0]?.installId),
    autoFireFor: (row) =>
      stripApp(resolveAutoFireSkill(db, deps, conversationFor(row), row.question)?.installId),
    close: () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** The four-cell confusion matrix (skills-s13-plan.md §3.2). */
export interface Confusion {
  firedCorrect: number
  firedWrong: number
  missed: number
  correctlyAbstained: number
}

export interface PathResult {
  name: string
  description: string
  confusion: Confusion
  /** firedCorrect / (firedCorrect + firedWrong); null when nothing fired. */
  precision: number | null
  /** firedCorrect / (firedCorrect + missed); null when nothing was expected to fire. */
  recall: number | null
  /** Per-item ids+labels (NO question text) for an auditable trail. */
  perItem: Array<{ id: string; expected: string; predicted: string }>
}

/** Score `items` with a production predictor. Deterministic, content-free output. */
export function scoreCorpus(
  items: CorpusItem[],
  predict: (row: CorpusItem) => string,
  name: string,
  description: string
): PathResult {
  const confusion: Confusion = { firedCorrect: 0, firedWrong: 0, missed: 0, correctlyAbstained: 0 }
  const perItem: PathResult['perItem'] = []
  for (const item of items) {
    const predicted = predict(item)
    const expected = item.expected
    if (predicted !== 'none' && predicted === expected) confusion.firedCorrect++
    else if (predicted !== 'none') confusion.firedWrong++ // wrong skill OR a fire where 'none' was right
    else if (expected !== 'none') confusion.missed++
    else confusion.correctlyAbstained++
    perItem.push({ id: item.id, expected, predicted })
  }
  const fired = confusion.firedCorrect + confusion.firedWrong
  const wanted = confusion.firedCorrect + confusion.missed
  return {
    name,
    description,
    confusion,
    precision: fired > 0 ? confusion.firedCorrect / fired : null,
    recall: wanted > 0 ? confusion.firedCorrect / wanted : null,
    perItem
  }
}

const pct = (v: number | null): string => (v == null ? '  n/a' : `${(v * 100).toFixed(1)}%`)

/**
 * A human-readable measurement report (metrics + confusion only — NO question text). Its numbers are
 * transcribed into the `architecture.md` §18 record (S13a baseline).
 */
export function formatReport(results: PathResult[], corpusSize: number): string {
  const lines: string[] = []
  lines.push(
    `Skills trigger measurement — ${corpusSize} synthetic turns, ${APP_VOCAB_SKILL_IDS.length} app skills as the label space`
  )
  lines.push('')
  lines.push('path                         precision  recall   fired-correct  fired-wrong  missed  abstained')
  for (const r of results) {
    const c = r.confusion
    lines.push(
      [
        r.name.padEnd(28),
        pct(r.precision).padStart(8),
        pct(r.recall).padStart(8),
        String(c.firedCorrect).padStart(14),
        String(c.firedWrong).padStart(12),
        String(c.missed).padStart(7),
        String(c.correctlyAbstained).padStart(10)
      ].join(' ')
    )
  }
  lines.push('')
  for (const r of results) lines.push(`  ${r.name}: ${r.description}`)
  return lines.join('\n')
}
