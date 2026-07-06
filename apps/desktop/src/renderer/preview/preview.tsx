// Visual-preview harness for the screenshot-verify skill. Renders real renderer components with the
// real tokens.css + styles.css and a mock `window.api`, so UI can be screenshot deterministically
// WITHOUT the Electron app, its workspace, or a model. Pick a case with `?case=<id>`.
//
// Add a case: extend CASES below with a label + an element. Keep the mock data inline so a case is
// self-describing. This file is dev-only (never bundled into the shipped app).
import { createRoot } from 'react-dom/client'
import type { Collection, Conversation, DocumentInfo } from '@shared/types'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../i18n'
import { ToastProvider } from '../components'
import { ConversationList } from '../chat/ConversationList'
import { ContextMeter } from '../chat/ContextMeter'
import { DocumentsScreen } from '../screens/DocumentsScreen'
import '../tokens.css'
import '../styles.css'

// ---- Mock data (the built-ins + a few flat projects and chats) ---------------------------------
// Collections are FLAT on this branch (no nesting/parentId) — the By-Project view groups
// conversations under their project, it is not a folder tree.
const now = '2026-06-25T10:00:00Z'
function coll(id: string, name: string, type = 'project'): Collection {
  return {
    id,
    name,
    type: type as Collection['type'],
    description: null,
    builtin: type !== 'project',
    color: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  }
}
const COLLECTIONS: Collection[] = [
  coll('lib', 'Library', 'library'),
  coll('tmp', 'Temporary', 'temporary'),
  coll('tax', 'Taxes'),
  coll('legal', 'Legal')
]
function conv(id: string, title: string, collectionId: string | null): Conversation {
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    modelId: null,
    mode: 'chat',
    scopeDocumentIds: null,
    collectionId,
    scope: null
  }
}
const CONVERSATIONS: Conversation[] = [
  conv('c1', 'Quarterly estimate', 'tax'),
  conv('c2', 'Deduction questions', 'tax'),
  conv('c3', 'NDA review with Acme', 'legal'),
  conv('c4', 'Brainstorm', null)
]
function docRow(id: string, title: string): DocumentInfo {
  return {
    id,
    title,
    status: 'indexed',
    errorMessage: null,
    chunkCount: 5,
    sizeBytes: 2048,
    createdAt: now,
    updatedAt: now,
    collections: [{ id: 'tax', name: 'Taxes', type: 'project', role: 'source' }]
  } as unknown as DocumentInfo
}
const DOCUMENTS: DocumentInfo[] = [docRow('d1', 'return-2025.pdf'), docRow('d2', 'receipts.csv')]

// ---- Mock window.api: a Proxy so any unlisted method resolves to a harmless default ------------
const overrides: Record<string, unknown> = {
  listCollections: async () => COLLECTIONS,
  listDocuments: async () => DOCUMENTS,
  searchConversations: async () => [],
  getAppStatus: async () => ({ ready: true }),
  getImportJob: async () => null
}
;(window as unknown as { api: unknown }).api = new Proxy(
  {},
  {
    get(_t, prop: string) {
      if (prop in overrides) return overrides[prop]
      // Any other call: a no-op async returning null (covers the on-interaction methods).
      return async () => null
    }
  }
)

const noop = (): void => {}

const CASES: Record<string, { label: string; node: JSX.Element }> = {
  'chat-byproject': {
    label: 'Chat sidebar — By Project grouping',
    node: (
      <div style={{ width: 300, height: 620, display: 'flex' }}>
        <ConversationList
          conversations={CONVERSATIONS}
          activeId="c1"
          streaming={false}
          mode="chat"
          collections={COLLECTIONS}
          onSelect={noop}
          onNew={noop}
          onDelete={noop}
          onCollapse={noop}
        />
      </div>
    )
  },
  documents: {
    label: 'Documents — list with project memberships',
    node: (
      <div style={{ width: 1100, height: 720 }}>
        <DocumentsScreen />
      </div>
    )
  },
  // Beta-feedback Phase 2 (#25/D69): the conversation-memory meter at the three tone bands, shown
  // in a composer-footer-like strip. The visible "Memory"/"Speicher" label is what should read as a
  // memory gauge, not a progress bar. The `-de` case flips the UI language (set below before render).
  'context-meter': {
    label: 'Composer footer — conversation-memory meter (calm / amber / near-full)',
    node: (
      <div style={{ width: 480 }}>
        {[
          { pct: '45%', usage: { usedTokens: 45, window: 100 } },
          { pct: '80%', usage: { usedTokens: 80, window: 100 } },
          { pct: '95%', usage: { usedTokens: 95, window: 100 } }
        ].map(({ pct, usage }) => (
          <div
            key={pct}
            className="composer-footer"
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              padding: '8px 12px',
              borderTop: '1px solid var(--border)'
            }}
          >
            <span className="composer-footer-spacer">
              <ContextMeter usage={usage} />
            </span>
          </div>
        ))}
      </div>
    )
  }
}
CASES['context-meter-de'] = { ...CASES['context-meter'], label: `${CASES['context-meter'].label} — DE` }

const params = new URLSearchParams(location.search)
const caseId = params.get('case') ?? 'documents'
// The By-Project view is a localStorage preference; force it on for the chat case.
try {
  localStorage.setItem('hilbertraum.chat.listView', caseId === 'chat-byproject' ? 'byProject' : 'recent')
  // A `-de` case renders in German (I18nProvider reads this mirror at init); everything else EN.
  localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, caseId.endsWith('-de') ? 'de' : 'en')
} catch {
  /* ignore */
}
const chosen = CASES[caseId] ?? CASES.documents

const root = createRoot(document.getElementById('root')!)
root.render(
  <I18nProvider>
    <ToastProvider>
      <div data-preview-case={caseId} style={{ padding: 16, background: 'var(--bg, #fff)' }}>
        {chosen.node}
      </div>
    </ToastProvider>
  </I18nProvider>
)
