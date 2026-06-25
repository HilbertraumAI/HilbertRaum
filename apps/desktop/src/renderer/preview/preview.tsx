// Visual-preview harness for the screenshot-verify skill. Renders real renderer components with the
// real tokens.css + styles.css and a mock `window.api`, so UI can be screenshot deterministically
// WITHOUT the Electron app, its workspace, or a model. Pick a case with `?case=<id>`.
//
// Add a case: extend CASES below with a label + an element. Keep the mock data inline so a case is
// self-describing. This file is dev-only (never bundled into the shipped app).
import { createRoot } from 'react-dom/client'
import type { Collection, Conversation, DocumentInfo } from '@shared/types'
import { I18nProvider } from '../i18n'
import { ToastProvider } from '../components'
import { ConversationList } from '../chat/ConversationList'
import { DocumentsScreen } from '../screens/DocumentsScreen'
import '../tokens.css'
import '../styles.css'

// ---- Mock data (a nested project tree + a few chats) -------------------------------------------
const now = '2026-06-25T10:00:00Z'
function coll(id: string, name: string, parentId: string | null = null, type = 'project'): Collection {
  return {
    id,
    name,
    type: type as Collection['type'],
    description: null,
    builtin: type !== 'project',
    color: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    parentId
  }
}
const COLLECTIONS: Collection[] = [
  coll('lib', 'Library', null, 'library'),
  coll('tmp', 'Temporary', null, 'temporary'),
  coll('tax', 'Taxes'),
  coll('tax25', '2025', 'tax'),
  coll('tax24', '2024', 'tax'),
  coll('legal', 'Legal'),
  coll('legal-nda', 'NDAs', 'legal')
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
    label: 'Chat sidebar — By Project folder browser',
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
          onMove={noop}
          onNewFolder={noop}
          onCreateFolder={noop}
          onNewInFolder={noop}
          onOpenFolderFiles={noop}
          onCollapse={noop}
        />
      </div>
    )
  },
  documents: {
    label: 'Documents — rail tree + nested folder browser',
    node: (
      <div style={{ width: 1100, height: 720 }}>
        <DocumentsScreen />
      </div>
    )
  }
}

const params = new URLSearchParams(location.search)
const caseId = params.get('case') ?? 'documents'
// The By-Project view is a localStorage preference; force it on for the chat case.
try {
  localStorage.setItem('hilbertraum.chat.listView', caseId === 'chat-byproject' ? 'byProject' : 'recent')
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
