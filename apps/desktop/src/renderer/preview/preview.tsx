// Visual-preview harness for the screenshot-verify skill. Renders real renderer components with the
// real tokens.css + styles.css and a mock `window.api`, so UI can be screenshot deterministically
// WITHOUT the Electron app, its workspace, or a model. Pick a case with `?case=<id>`.
//
// Add a case: extend CASES below with a label + an element. Keep the mock data inline so a case is
// self-describing. This file is dev-only (never bundled into the shipped app).
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_SETTINGS, type Collection, type Conversation, type DocumentInfo, type Message, type ModelInfo, type SkillInfo } from '@shared/types'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../i18n'
import { ToastProvider } from '../components'
import { ConversationList } from '../chat/ConversationList'
import { ContextMeter } from '../chat/ContextMeter'
import { SkillInfoCard } from '../chat/SkillInfoCard'
import { SkillRunBar } from '../chat/SkillRunBar'
import { CoverageMeter } from '../components'
import { ScopePopover } from '../chat/ScopePopover'
import { Transcript } from '../chat/Transcript'
import { App } from '../App'
import { ChatScreen } from '../screens/ChatScreen'
import { DocumentsScreen } from '../screens/DocumentsScreen'
import { ModelsScreen } from '../screens/ModelsScreen'
import { TranslateScreen } from '../screens/TranslateScreen'
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

// ---- Mock chat models for the ModelsScreen case (beta #27/D70 — the collapsed action) ----------
function modelRow(over: Partial<ModelInfo>): ModelInfo {
  return {
    id: 'model',
    displayName: 'Model',
    family: 'qwen3',
    role: 'chat',
    format: 'gguf',
    runtime: 'llama_cpp',
    license: 'apache-2.0',
    sizeOnDiskGb: 2.7,
    recommendedMinRamGb: 8,
    recommendedRamGb: 16,
    recommendedContextTokens: 4096,
    localPath: 'models/chat/model.gguf',
    state: 'installed',
    recommended: false,
    download: undefined,
    ...over
  } as ModelInfo
}
// The card states the merged "Use this model" action must present cleanly: the active+running
// model (leads, shows Stop + Active badge), an installed idle model (the primary "Use this model"
// action, enabled), a RAM-gated model (action disabled + the memory notice), and the developer
// demo card. No model is mid-start here so the primary button reads enabled; the Starting… spinner
// state is exercised by the renderer tests.
const PREVIEW_MODELS: ModelInfo[] = [
  modelRow({ id: 'active-running', displayName: 'Qwen3 4B Instruct', state: 'running', recommended: true }),
  modelRow({ id: 'installed-idle', displayName: 'Qwen3 8B Instruct', sizeOnDiskGb: 5.2 }),
  modelRow({
    id: 'ram-gated',
    displayName: 'Qwen3 27B Instruct',
    sizeOnDiskGb: 17,
    recommendedMinRamGb: 64,
    insufficientRam: true
  }),
  modelRow({ id: 'demo-model', displayName: 'Qwen3 0.6B (demo)', state: 'missing', startableAsMock: true })
]

// ---- Mock window.api: a Proxy so any unlisted method resolves to a harmless default ------------
const overrides: Record<string, unknown> = {
  // App-shell cases (`brand-home*`): the shell needs an unlocked workspace to render the
  // nav rail instead of the gate. Harmless for component-level cases (they never call it).
  getWorkspaceState: async () => ({
    state: 'unlocked',
    mode: 'plaintext_dev',
    plaintextAllowed: true,
    encryptionRequired: false
  }),
  listCollections: async () => COLLECTIONS,
  listDocuments: async () => DOCUMENTS,
  searchConversations: async () => [],
  getAppStatus: async () => {
    // Issue #42 reopen: the `translate-device*` cases exercise the Translate device hint —
    // full offload vs the partial-offload (~CPU speed) form vs forced CPU. Other cases keep
    // the old minimal shape (translationAvailable stays falsy so e.g. `documents` is unchanged).
    const c = new URLSearchParams(location.search).get('case') ?? ''
    if (!c.startsWith('translate-device')) return { ready: true, machineRamGb: 32 }
    const translationDevice =
      c === 'translate-device-partial'
        ? { device: 'auto', gpuLayers: 12, totalLayers: 49, live: false }
        : c === 'translate-device-cpu'
          ? { device: 'cpu', gpuLayers: null, totalLayers: null, live: true }
          : { device: 'auto', gpuLayers: 49, totalLayers: 49, live: true }
    return { ready: true, machineRamGb: 32, translationAvailable: true, translationDevice }
  },
  getImportJob: async () => null,
  // ChatScreen data (the `chat-runtime*` cases; harmless elsewhere).
  listConversations: async () => CONVERSATIONS,
  listMessages: async () => [],
  listSkills: async () => [],
  // ModelsScreen data (only the `models*` cases render it; other cases never call these).
  listModels: async () => PREVIEW_MODELS,
  getSettings: async () => ({ ...DEFAULT_SETTINGS, activeModelId: 'active-running' }),
  getPolicy: async () => null,
  getEngineStatus: async () => null,
  getRuntimeStatus: async () => {
    // #36: the chat-runtime cases exercise the header hint — GPU form vs. the CPU
    // "compatibility mode" form fed by the gpuAutoDisabled enrichment.
    const compat = (new URLSearchParams(location.search).get('case') ?? '') === 'chat-runtime-compat'
    return {
      running: true,
      modelId: 'active-running',
      startingModelId: null,
      port: 1234,
      healthy: true,
      message: 'ok',
      backend: compat ? 'cpu' : 'gpu',
      gpuName: compat ? null : 'NVIDIA GeForce RTX 3090',
      gpuAutoDisabled: compat
    }
  }
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
  // Issue #42 reopen: the muted device line under the Translate language bar (the chat-#36
  // analogue). The partial case is the feature's point — a resident chat model starved the
  // sidecar's VRAM fit, so it names the ~processor speed (tooltip carries cause + remedy).
  'translate-device': {
    label: 'Translate screen — device hint (full GPU offload)',
    node: (
      <div style={{ width: 1100, height: 720 }}>
        <TranslateScreen onNavigate={noop} />
      </div>
    )
  },
  'translate-device-partial': {
    label: 'Translate screen — device hint (PARTIAL offload, ~CPU speed)',
    node: (
      <div style={{ width: 1100, height: 720 }}>
        <TranslateScreen onNavigate={noop} />
      </div>
    )
  },
  'translate-device-cpu': {
    label: 'Translate screen — device hint (forced CPU)',
    node: (
      <div style={{ width: 1100, height: 720 }}>
        <TranslateScreen onNavigate={noop} />
      </div>
    )
  },
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
  },
  // Beta-feedback Phase 3 (#27/D70): the AI Model screen with the collapsed action. Each installed
  // chat card offers ONE primary "Use this model" button (select + start) instead of a Select AND a
  // Start runtime pair. The active model leads with Stop; the RAM-gated card disables the action.
  // The `-de` case renders in German ("Dieses Modell verwenden"). PNG capture deferred to CI/POSIX.
  models: {
    label: 'AI Model screen — one "Use this model" action per installed card',
    node: (
      <div style={{ width: 760 }}>
        <ModelsScreen />
      </div>
    )
  },
  // Beta-feedback Phase 4 (#26/D71): the always-visible "Answering from:" scope chip near the
  // composer, shown in its two headline states — scoped to one document (the single-doc workflow),
  // and the whole-library case that names the corpus size. The chip IS the picker trigger. The `-de`
  // case renders in German ("Antwortet aus:"). PNG capture deferred to CI/POSIX (Windows dev box).
  'scope-chip': {
    label: 'Composer footer — "Answering from:" scope chip (one doc / whole library)',
    node: (
      <div style={{ width: 480 }}>
        {[
          { key: 'doc', scope: { collectionIds: [], documentIds: ['d1'] } },
          { key: 'library', scope: { collectionIds: ['lib'], documentIds: [] } }
        ].map(({ key, scope }) => (
          <div
            key={key}
            className="composer-footer"
            style={{ display: 'flex', padding: '8px 12px', borderTop: '1px solid var(--border)' }}
          >
            <span className="scope-footer-wrap">
              <ScopePopover docs={DOCUMENTS} collections={COLLECTIONS} scope={scope} onChangeScope={noop} />
            </span>
          </div>
        ))}
      </div>
    )
  },
  // Beta-feedback Phase 5 (#24/D72): the coverage line under a grounded answer. A relevance answer
  // now stamps real section counts, so it reads "Based on N of M sections" (top); a NULL-coverage
  // legacy turn keeps the flat honesty label byte-identically (bottom). The `-de` case renders in
  // German ("Basiert auf N von M Abschnitten"). PNG capture deferred to CI/POSIX (Windows dev box).
  'coverage-line': {
    label: 'Answer footer — coverage line (counted relevance fraction + flat legacy fallback)',
    node: (
      <div style={{ width: 480, display: 'flex', flexDirection: 'column', gap: 12, padding: 12 }}>
        <CoverageMeter coverage={{ mode: 'relevance', chunksCovered: 3, chunksTotal: 12, fullyChunked: true }} />
        <CoverageMeter coverage={{ mode: 'relevance', chunksCovered: 0, chunksTotal: 0 }} />
      </div>
    )
  }
}
// Issue #39: the calm one-time warm-up line under the pending first answer — the state the
// renderer reaches after WARMUP_HINT_DELAY_MS of silence on a cold runtime (Transcript is
// rendered directly with `warmupHint` so the screenshot needs no timers). Muted, small,
// same quiet vocabulary as the compaction notice; the blinking cursor bubble sits above it.
CASES['chat-warmup'] = {
  label: 'Chat transcript — first-answer warm-up hint under the pending bubble',
  node: (
    <div style={{ width: 760, height: 420, display: 'flex' }}>
      <Transcript
        messages={[
          {
            id: 'u1',
            conversationId: 'c1',
            role: 'user',
            content: 'Summarize the payment terms across my contracts.',
            createdAt: now,
            tokenCount: null
          }
        ]}
        streamingHere
        streamText=""
        streamThinking=""
        thinkingOpen={false}
        onThinkingOpenChange={noop}
        warmupHint
        emptyState={<div />}
        onCopy={noop}
        onSave={noop}
        actionsDisabled
      />
    </div>
  )
}
// Issue #36: the muted chat-header runtime hint — which model is answering and where it
// runs. `chat-runtime` shows the GPU form; `chat-runtime-compat` (below) the CPU
// "compatibility mode" form (the mock getRuntimeStatus flips on the case id).
CASES['chat-runtime'] = {
  label: 'Chat screen — header runtime hint (model · GPU / CPU compatibility mode)',
  node: (
    <div style={{ width: 1100, height: 700 }}>
      <ChatScreen onNavigate={noop} />
    </div>
  )
}
CASES['chat-runtime-compat'] = {
  ...CASES['chat-runtime'],
  label: `${CASES['chat-runtime'].label} — compat`
}
// Issue #47: the rail brand lockup is now a real Home button. `brand-home` shows the resting
// shell (logo above the labelled Home item — the Home row alone carries the active highlight,
// no double-lit selection); `brand-home-hover` statically applies the hover fill so the
// clickable affordance is visible in a screenshot (a real :hover can't be captured).
CASES['brand-home'] = {
  label: 'App shell — brand lockup as the Home button (issue #47)',
  node: (
    <div style={{ width: 1100, height: 700 }}>
      <App />
    </div>
  )
}
CASES['brand-home-hover'] = {
  label: `${CASES['brand-home'].label} — hover fill`,
  node: (
    <div style={{ width: 1100, height: 700 }}>
      <style>{'.brand { background: var(--surface-hover); }'}</style>
      <App />
    </div>
  )
}
// Issues #44/#46 — the skills discoverability wave. `skill-info-card` renders the new
// first-selection info card (document-edit: catalog what/needs/limits lines + pick-lifetime footer +
// Learn more). `skill-run-result-offer` shows the #44 coexistence: a terminal result row rendering
// ABOVE the restored offer (target chooser + run button) instead of hiding it. The #45 confirm
// format line lives in a Radix modal (needs interaction) — covered by the vitest cases.
const PREVIEW_SKILL: SkillInfo = {
  installId: 'app:document-edit',
  id: 'document-edit',
  title: 'Document Edit',
  description: 'Use when the user wants to make targeted find-and-replace edits to a document.',
  version: '1.0.0',
  kind: 'tool',
  author: 'HilbertRaum',
  language: 'en',
  source: 'app',
  trustedLevel: 'app',
  enabled: true,
  warningAck: true,
  unavailable: false,
  permissions: { documents: 'selected_only', network: 'denied', filesystem: 'skill_resources_only' },
  permissionSummary: '',
  duplicateId: false,
  installedAt: now,
  updatedAt: now
}
CASES['skill-info-card'] = {
  label: 'Composer — first-selection skill info card (issue #46)',
  node: (
    <div style={{ width: 780, padding: 12 }}>
      <SkillInfoCard skill={PREVIEW_SKILL} onClose={noop} onLearnMore={noop} />
    </div>
  )
}
CASES['skill-run-result-offer'] = {
  label: 'Skill run bar — terminal result row above the restored offer (issue #44)',
  node: (
    <div style={{ width: 780, padding: 12 }}>
      <SkillRunBar
        run={{
          runHandle: 'h1',
          skillInstallId: 'app:document-edit',
          toolName: 'apply_document_edits',
          documentCount: 1,
          state: 'done',
          resultKind: 'edited',
          count: 3,
          progress: { done: 0, total: 0 }
        }}
        runnableTools={[{ name: 'apply_document_edits', requiresConfirmation: true }]}
        targetDocuments={[{ id: 'd1', name: 'contract.pdf' }]}
        onRun={noop}
        onCancel={noop}
        onDismiss={noop}
      />
    </div>
  )
}
CASES['skill-info-card-de'] = { ...CASES['skill-info-card'], label: `${CASES['skill-info-card'].label} — DE` }
CASES['context-meter-de'] = { ...CASES['context-meter'], label: `${CASES['context-meter'].label} — DE` }
CASES['models-de'] = { ...CASES.models, label: `${CASES.models.label} — DE` }
CASES['scope-chip-de'] = { ...CASES['scope-chip'], label: `${CASES['scope-chip'].label} — DE` }
CASES['coverage-line-de'] = { ...CASES['coverage-line'], label: `${CASES['coverage-line'].label} — DE` }


// ---- Marketing staged chat (website/press screenshots) ------------------------------------------
// A full app-shell chat showing a finished, entirely FICTIONAL spending answer — no real user
// data ever appears in marketing captures. `?case=marketing-spending` (EN) / `-de` (DE). The
// wrapper walks the real UI (rail → Chat → conversation row) so the capture is the actual
// product rendering, not a mock composition. Dark theme is forced (the website is dark).
const mktCase = (): string => new URLSearchParams(location.search).get('case') ?? ''
const isMkt = (): boolean => mktCase().startsWith('marketing-spending')
const mktDe = (): boolean => mktCase().endsWith('-de')

const MKT_ANSWER_EN = [
  'Based on your bank statements, your largest spending category last year was **housing**. Here is the full breakdown:',
  '',
  '1. **Rent**: **€13,140** total (€1,095 monthly, January–December) [S2].',
  '2. **Groceries & household**: **€4,870** across 214 transactions [S4].',
  '3. **Car & transport**: **€3,205**, fuel €1,610, insurance €780 [S7], repairs €815 [S9].',
  '4. **Insurance**: **€2,455**, health top-up €1,270 [S3], household contents €310, personal liability €185, life insurance €690 [S6].',
  '5. **Travel**: **€1,980**, flights in May and September plus three hotel stays [S8].',
  '',
  'The largest *single* transaction was **€2,140** on 14.08.2025, a dental invoice [S5].',
  '',
  'Together these five categories account for roughly **71%** of your total spending of **€35,900** last year [S1].'
].join('\n')
const MKT_ANSWER_DE = [
  'Auf Basis deiner Kontoauszüge war deine größte Ausgabenkategorie im letzten Jahr **Wohnen**. Hier die vollständige Aufschlüsselung:',
  '',
  '1. **Miete**: **13.140 €** gesamt (1.095 € monatlich, Januar–Dezember) [S2].',
  '2. **Lebensmittel & Haushalt**: **4.870 €** in 214 Transaktionen [S4].',
  '3. **Auto & Verkehr**: **3.205 €**, Tanken 1.610 €, Versicherung 780 € [S7], Reparaturen 815 € [S9].',
  '4. **Versicherungen**: **2.455 €**, private Krankenzusatzversicherung 1.270 € [S3], Hausrat 310 €, Haftpflicht 185 €, Lebensversicherung 690 € [S6].',
  '5. **Reisen**: **1.980 €**, Flüge im Mai und September plus drei Hotelaufenthalte [S8].',
  '',
  'Die größte *Einzeltransaktion* war **2.140 €** am 14.08.2025, eine Zahnarztrechnung [S5].',
  '',
  'Zusammen machen diese fünf Kategorien rund **71 %** deiner Gesamtausgaben von **35.900 €** im letzten Jahr aus [S1].'
].join('\n')

function mktConversations(): Conversation[] {
  const de = mktDe()
  const mk = (id: string, title: string): Conversation => ({
    ...conv(id, title, null),
    mode: 'documents' as Conversation['mode']
  })
  return [
    mk('m1', de ? 'Ausgabenübersicht 2025' : 'Spending overview 2025'),
    { ...conv('m2', de ? 'Mietvertrag: Kündigungsklauseln' : 'Rental contract clauses', null) },
    { ...conv('m3', de ? 'Versicherungsbrief zusammengefasst' : 'Insurance letter summary', null) }
  ]
}
function mktMessages(): Message[] {
  const de = mktDe()
  return [
    {
      id: 'mm1',
      conversationId: 'm1',
      role: 'user',
      content: de ? 'Wofür habe ich letztes Jahr am meisten Geld ausgegeben?' : 'What did I spend the most money on last year?',
      createdAt: now
    },
    {
      id: 'mm2',
      conversationId: 'm1',
      role: 'assistant',
      content: de ? MKT_ANSWER_DE : MKT_ANSWER_EN,
      createdAt: now
    }
  ]
}
// Case-aware overrides: the marketing case swaps in its own conversations/messages and
// forces the dark theme; every other case keeps the exact behavior above.
const baseListConversations = overrides.listConversations as () => Promise<Conversation[]>
overrides.listConversations = async () => (isMkt() ? mktConversations() : baseListConversations())
overrides.listMessages = async () => (isMkt() ? mktMessages() : [])
const baseGetSettings = overrides.getSettings as () => Promise<typeof DEFAULT_SETTINGS>
overrides.getSettings = async () => {
  const s = await baseGetSettings()
  // Force theme AND UI language: settings-driven language resolution would otherwise follow
  // the OS locale, mixing e.g. German chrome into the English capture.
  return isMkt() ? { ...s, theme: 'dark', uiLanguage: mktDe() ? 'de' : 'en' } : s
}
const baseGetRuntimeStatus = overrides.getRuntimeStatus as () => Promise<Record<string, unknown>>
overrides.getRuntimeStatus = async () => {
  const st = await baseGetRuntimeStatus()
  // A believable model name in the header hint instead of the mock id — a currently-ranked,
  // shipping manifest id (PF-2, full-audit 2026-07-12b: captures must not show a model no
  // user can select; swap deliberately when a bigger model productizes).
  return isMkt() ? { ...st, modelId: 'ministral3-8b-instruct-2512-q4' } : st
}
overrides.listDocuments = async () => {
  if (!isMkt()) return DOCUMENTS
  const de = mktDe()
  const names = de
    ? ['kontoauszuege-2025-q1.pdf', 'kontoauszuege-2025-q2.pdf', 'kontoauszuege-2025-q3.pdf',
       'kontoauszuege-2025-q4.pdf', 'kreditkarte-2025.csv', 'mietvertrag-2024.pdf',
       'versicherungspolicen.pdf', 'gehaltsabrechnungen-2025.pdf', 'steuerbescheid-2024.pdf',
       'rechnungen-haushalt-2025.pdf']
    : ['bank-statements-2025-q1.pdf', 'bank-statements-2025-q2.pdf', 'bank-statements-2025-q3.pdf',
       'bank-statements-2025-q4.pdf', 'credit-card-2025.csv', 'rental-contract-2024.pdf',
       'insurance-policies.pdf', 'payslips-2025.pdf', 'tax-assessment-2024.pdf',
       'household-invoices-2025.pdf']
  return names.map((n, i) => docRow(`mkt-d${i + 1}`, n))
}

function StagedMarketingChat(): JSX.Element {
  // Walk the real UI once the shell has rendered: rail "Chat" → the staged conversation.
  // Marks body[data-marketing-ready] for the screenshot script when the transcript is up.
  useEffect(() => {
    document.documentElement.dataset.theme = 'dark'
    // The settings load can remount the tree (language/theme application) AFTER a first
    // successful walk, resetting the selection — so keep walking until the transcript has
    // been continuously present for a few ticks, and only then mark the capture ready.
    let tries = 0
    let stable = 0
    const timer = setInterval(() => {
      tries += 1
      if (tries > 120) {
        clearInterval(timer)
        return
      }
      if (document.querySelector('.msg-content')) {
        stable += 1
        if (stable >= 5) {
          document.body.dataset.marketingReady = '1'
          clearInterval(timer)
        }
        return
      }
      stable = 0
      delete document.body.dataset.marketingReady
      const row = document.querySelector<HTMLButtonElement>('.chat-conv-row button')
      if (row) {
        row.click()
        return
      }
      const chatNav = Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-item')).find(
        (b) => b.querySelector('.nav-label')?.textContent === 'Chat'
      )
      chatNav?.click()
    }, 100)
    return () => clearInterval(timer)
  }, [])
  return <App />
}
CASES['marketing-spending'] = {
  label: 'Marketing — full shell, staged fictional spending answer (dark)',
  node: (
    <div style={{ width: 1180, height: 800 }}>
      <StagedMarketingChat />
    </div>
  )
}
CASES['marketing-spending-de'] = {
  ...CASES['marketing-spending'],
  label: 'Marketing — full shell, staged fictional spending answer (dark) — DE'
}

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
