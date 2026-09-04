import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import type { KnowledgePack } from '../../../shared/types'
import type { Db } from '../db'
import { log } from '../logging'
import { resolveZimDir } from '../drive'
import type { ExternalRetrievalArm } from '../rag'
import { collectPackCandidates } from './arm'
import { fetchArticleHtml } from './client'
import { zimArticleToSegments } from './html'
import {
  discoverDrivePacks,
  listPacks,
  registerPack,
  removePack,
  retrievablePacks,
  setPackEnabled,
  writeLibraryXml,
  type PackDeps
} from './packs'
import { KiwixServer } from './serve'
import { kiwixManageAdd, resolveKiwixManagePath, resolveKiwixServePath } from './tools'

// ZimService — the knowledge-packs facade the IPC layer and the RAG ask path talk to.
// Owns: kiwix-tools resolution, the (lazy, single) kiwix-serve instance, the generated
// library.xml, registration wrappers that invalidate the running server, the retrieval
// arm factory, and the article read for the citation viewer.
//
// The library.xml lives in a per-service OS temp dir, regenerated on every server
// (re)start and removed on stop: nothing about the user's pack collection persists
// outside the encrypted workspace DB (the drive's zim/ files themselves are, of course,
// visible — they are the packs).

export interface ZimServiceOptions {
  rootPath: string
  isDev: boolean
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

export interface PackArticle {
  title: string
  sections: Array<{ label: string | null; text: string }>
}

export class ZimService {
  private readonly opts: ZimServiceOptions
  readonly zimDir: string
  private server: KiwixServer | null = null
  private libraryDir: string | null = null
  private libraryStale = true

  constructor(opts: ZimServiceOptions) {
    this.opts = opts
    this.zimDir = resolveZimDir(opts.rootPath)
  }

  /** True when the kiwix-tools binaries are present (feature availability for the UI). */
  toolsInstalled(): boolean {
    const serve = this.servePath()
    return serve !== null && resolveKiwixManagePath(serve, this.opts.platform) !== null
  }

  private servePath(): string | null {
    return resolveKiwixServePath(this.opts.rootPath, this.opts.platform, this.opts.env, {
      isDev: this.opts.isDev
    })
  }

  private packDeps(): PackDeps {
    const manage = resolveKiwixManagePath(this.servePath(), this.opts.platform)
    return {
      zimDir: this.zimDir,
      manageAdd: async (libraryXmlPath, zimPath) => {
        if (!manage) throw new Error('kiwix-tools is not installed')
        await kiwixManageAdd(manage, libraryXmlPath, zimPath, (cmd, args, o) => nodeSpawn(cmd, args, o))
      }
    }
  }

  // ---- registration (all mutations invalidate the running server's library) ------

  listPacks(db: Db): KnowledgePack[] {
    return listPacks(db, this.zimDir)
  }

  async registerPack(db: Db, zimPath: string): Promise<KnowledgePack> {
    const pack = await registerPack(db, this.packDeps(), zimPath)
    this.invalidateLibrary()
    return pack
  }

  async discoverDrivePacks(db: Db): Promise<number> {
    if (!this.toolsInstalled()) return 0
    const added = await discoverDrivePacks(db, this.packDeps())
    if (added > 0) this.invalidateLibrary()
    return added
  }

  removePack(db: Db, id: string): boolean {
    const removed = removePack(db, id)
    if (removed) this.invalidateLibrary()
    return removed
  }

  setPackEnabled(db: Db, id: string, enabled: boolean): boolean {
    const changed = setPackEnabled(db, id, enabled)
    if (changed) this.invalidateLibrary()
    return changed
  }

  /** Pack set changed: the served library is stale — stop the server (next ask rebuilds)
   *  and re-arm a latched start failure (the change may be the fix). */
  private invalidateLibrary(): void {
    this.libraryStale = true
    this.server?.resetFailureLatch()
    const server = this.server
    if (server) {
      void server.stop().catch(() => {
        /* stop is best-effort here; ensureServer spawns fresh */
      })
    }
  }

  // ---- sidecar ------------------------------------------------------------------

  /**
   * Ensure a sidecar serving the current enabled+available packs; resolves its port,
   * or null when there is nothing to serve or no binaries. Rebuilds library.xml only
   * when the pack set changed since the last start.
   */
  async ensureServer(db: Db): Promise<number | null> {
    const bin = this.servePath()
    if (!bin) return null
    if (!this.libraryDir) {
      this.libraryDir = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-library-'))
    }
    const libraryXmlPath = join(this.libraryDir, 'library.xml')
    if (this.libraryStale || !this.server) {
      const count = await writeLibraryXml(db, this.packDeps(), libraryXmlPath)
      this.libraryStale = false
      if (count === 0) return null
      if (!this.server) {
        this.server = new KiwixServer({ binPath: bin, libraryXmlPath })
      }
    }
    return this.server.ensureStarted()
  }

  /** Stop the sidecar and remove the generated library (quit path — shutdown.ts). */
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await server.stop()
    if (this.libraryDir) {
      try {
        rmSync(this.libraryDir, { recursive: true, force: true })
      } catch {
        /* temp dir — best-effort */
      }
      this.libraryDir = null
      this.libraryStale = true
    }
  }

  // ---- retrieval + viewer -------------------------------------------------------

  /**
   * The external retrieval arm for one ask, or null when packs cannot contribute
   * (no ids in scope, tools missing, or nothing retrievable). The arm starts the
   * sidecar lazily on first use; `retrieve` isolates any failure it throws.
   */
  makeArm(db: Db, packIds: readonly string[] | null | undefined): ExternalRetrievalArm | null {
    if (!packIds || packIds.length === 0) return null
    if (!this.toolsInstalled()) {
      log.warn('Knowledge packs in scope but kiwix-tools is not installed — skipping the ZIM arm')
      return null
    }
    const packs = retrievablePacks(db, this.zimDir, packIds)
    if (packs.length === 0) return null
    return async (question, signal) => {
      const port = await this.ensureServer(db)
      if (port == null) return []
      return collectPackCandidates(port, packs, question, signal)
    }
  }

  /**
   * Read one article for the citation viewer: plain sectioned TEXT (the html.ts
   * extraction), never raw HTML — the renderer keeps its no-innerHTML posture.
   * Null when the pack/article cannot be served (pack gone, entry vanished).
   */
  async getArticle(db: Db, packId: string, articlePath: string): Promise<PackArticle | null> {
    const packs = retrievablePacks(db, this.zimDir, [packId])
    const pack = packs[0]
    if (!pack) return null
    const port = await this.ensureServer(db)
    if (port == null) return null
    // The serving URL id is the filename stem (kiwix-serve's --library naming rule,
    // verified in the 2026-09-04 contract test against kiwix-tools 3.8.1).
    const urlId = pack.leaf.replace(/\.zim$/i, '')
    const html = await fetchArticleHtml(port, urlId, articlePath)
    if (html === null) return null
    const article = zimArticleToSegments(html)
    const sections = article.segments.map((s) => {
      let text = s.text
      if (s.sectionLabel && text.startsWith(s.sectionLabel)) {
        // The heading is rendered as the section label; drop its duplicate first line.
        text = text.slice(s.sectionLabel.length).replace(/^\n+/, '')
      }
      return { label: s.sectionLabel ?? null, text }
    })
    return { title: article.title ?? articlePath, sections }
  }
}
