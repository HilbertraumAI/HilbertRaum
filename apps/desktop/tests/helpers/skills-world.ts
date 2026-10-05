// A skills "world" (temp root + dirs + seeded settings DB + real skill registry) plus the two AppContext shapes
// the skills-IPC and RAG-ask suites build, and a real text-file ingest.
// Constraint: this imports production modules that pull in `electron`, so ONLY import it from test files that
// already `vi.mock('electron', ...)` (every skills-IPC / RAG-ask suite does). It never registers an IPC handler and
// owns no vi.mock - callers still call registerSkillsIpc(ctx) / registerRagIpc(ctx) themselves.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext } from '../../src/main/services/context'
import { createAuditRecorder } from '../../src/main/services/audit'
import { openDatabase, type Db } from '../../src/main/services/db'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import { createPendingModelSwitchCounter } from '../../src/main/services/rag/device-posture'
import type { ModelRuntime } from '../../src/main/services/runtime'
import { seedSettings } from '../../src/main/services/settings'
import { createSkillRegistry, type SkillRegistry } from '../../src/main/services/skills/registry'
import { tempRoot } from './db-fixtures'
import { ANY_SENDER } from './ipc'

export interface SkillsWorld {
  root: string
  /** `<root>/workspace` (not created; the RAG suites ingest into it) */
  workspacePath: string
  appSkillsDir: string
  userSkillsDir: string
  db: Db
  skills: SkillRegistry
}

export interface SkillsWorldOptions {
  /** write skills into the app dir (called after the dirs exist, before the DB opens) */
  seedApp?: (appSkillsDir: string) => void
  seedUser?: (userSkillsDir: string) => void
  /** default true; skills-ipc passes false (it never creates the two dirs) */
  createDirs?: boolean
  /** passed to createSkillRegistry only when set (RAG suites use '0.0.0-test') */
  appVersion?: string
  /** call `skills.reconcile()` right after the registry exists (RAG suites) */
  reconcile?: boolean
}

/** Fresh `hilbertraum-<label>-` root + dirs + seeded settings DB + real skill registry. */
export function makeSkillsWorld(label: string, o: SkillsWorldOptions = {}): SkillsWorld {
  const root = tempRoot(label)
  const workspacePath = join(root, 'workspace')
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  if (o.createDirs !== false) {
    mkdirSync(appSkillsDir, { recursive: true })
    mkdirSync(userSkillsDir, { recursive: true })
  }
  o.seedApp?.(appSkillsDir)
  o.seedUser?.(userSkillsDir)
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const skills = createSkillRegistry({
    getDb: () => db,
    appSkillsDir,
    userSkillsDir,
    ...(o.appVersion ? { appVersion: o.appVersion } : {})
  })
  if (o.reconcile) skills.reconcile()
  return { root, workspacePath, appSkillsDir, userSkillsDir, db, skills }
}

/**
 * The AppContext the skills-IPC suites hand to registerSkillsIpc (`workspacePath` = the world root).
 * `unlocked: false` + `audit: false` reproduce skills-ipc's locked-workspace test (no `audit` key at all).
 * `extra` is spread LAST (model-occupancy overrides `paths` and adds `runtime`, `docTasks`, `manifestsDir`).
 */
export function makeSkillsIpcContext(
  w: SkillsWorld,
  o: { unlocked?: boolean; audit?: boolean; extra?: Record<string, unknown> } = {}
): AppContext {
  const unlocked = o.unlocked ?? true
  return {
    trustedSenders: ANY_SENDER,
    db: w.db,
    paths: { workspacePath: w.root },
    workspace: { isUnlocked: () => unlocked, documentCipher: () => null },
    isDev: false,
    ...(o.audit === false ? {} : { audit: createAuditRecorder(() => w.db) }),
    skills: w.skills,
    ocrEngine: undefined,
    ...o.extra
  } as unknown as AppContext
}

export interface RagAuditEvent {
  type: string
  meta?: Record<string, unknown>
}

/** The AppContext the RAG-ask suites hand to registerRagIpc; `audit` records `{ type, meta }` (unread by the noop-audit suites). */
export function makeRagAskContext(
  w: Pick<SkillsWorld, 'db' | 'root' | 'workspacePath' | 'skills'>,
  runtime: ModelRuntime
): { ctx: AppContext; audit: RagAuditEvent[] } {
  const audit: RagAuditEvent[] = []
  const ctx = {
    trustedSenders: ANY_SENDER,
    paths: { rootPath: w.root, workspacePath: w.workspacePath },
    get db() {
      return w.db
    },
    workspace: { isUnlocked: () => true, documentCipher: () => null, beginDocumentWork: () => () => {} },
    runtime: { active: () => runtime, activeModelId: () => runtime.modelId },
    embedder: createMockEmbedder(),
    reranker: null,
    ocrEngine: undefined,
    manifestsDir: null,
    isDev: true,
    audit: (type: string, _message: string, meta?: Record<string, unknown>) => {
      audit.push({ type, meta })
    },
    skills: w.skills,
    // #477: pendingModelSwitches is required - the ask path's occupancy snapshot reads it unconditionally.
    pendingModelSwitches: createPendingModelSwitchCounter()
  } as unknown as AppContext
  return { ctx, audit }
}

/** Ingest one real text file the production way (stored copy + chunks + mock embeddings + fully_chunked). */
export async function ingestTextFile(
  w: Pick<SkillsWorld, 'db' | 'root' | 'workspacePath'>,
  fileName: string,
  text: string,
  o: { fullyChunked?: boolean } = {}
): Promise<string> {
  const docPath = join(w.root, fileName)
  writeFileSync(docPath, text, 'utf8')
  const doc = createQueuedDocument(w.db, docPath)
  await processDocument(w.db, documentsDir(w.workspacePath), doc.id, { embedder: createMockEmbedder() })
  if (o.fullyChunked === false) {
    w.db.prepare('UPDATE documents SET fully_chunked = NULL WHERE id = ?').run(doc.id)
  }
  return doc.id
}
