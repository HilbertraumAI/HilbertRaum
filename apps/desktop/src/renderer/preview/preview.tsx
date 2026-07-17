// Visual-preview harness for the screenshot-verify skill. Renders real renderer components with the
// real tokens.css + styles.css and a mock `window.api`, so UI can be screenshot deterministically
// WITHOUT the Electron app, its workspace, or a model. Pick a case with `?case=<id>`.
//
// Add a case: extend CASES below with a label + an element. Keep the mock data inline so a case is
// self-describing. This file is dev-only (never bundled into the shipped app).
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_SETTINGS, type Citation, type Collection, type Conversation, type DocumentInfo, type DriveStatus, type Message, type ModelInfo, type PolicyStatus, type SkillInfo } from '@shared/types'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY, useT } from '../i18n'
import { LocalIndicator, ToastProvider } from '../components'
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


// ---- Marketing staged captures (website/press screenshots) --------------------------------------
// Full app-shell captures showing finished, entirely FICTIONAL conversations and data. No real
// user data ever appears in marketing captures. Case ids follow `marketing-<shot>[-de][-light]`:
// every shot renders in EN/DE and dark/light. The wrapper walks the real UI (rail, conversation
// row, settings tab) so each capture is the actual product rendering, not a mock composition.
// Shots: salary (plain chat), spending (documents Q&A, sources collapsed), contract (documents
// Q&A, sources expanded), documents (library screen), privacy (Settings privacy tab), and
// indicator (the rail privacy indicator close-up with its reassurance line).
const mktCase = (): string => new URLSearchParams(location.search).get('case') ?? ''
const isMkt = (): boolean => mktCase().startsWith('marketing-')
const mktSegs = (): string[] => mktCase().split('-')
const mktDe = (): boolean => mktSegs().includes('de')
const mktLight = (): boolean => mktSegs().includes('light')
const mktShot = (): string => mktSegs()[1] ?? ''

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

// Salary shot: a plain chat (no documents) about preparing a salary conversation. Amounts are
// deliberately currency-free ("52k"/"58k") so the same capture works for EUR and USD audiences.
const MKT_SALARY_EN = [
  'Going from 52k to 58k is an 11.5% raise: ambitious, but arguable if you anchor it in results. Structure the conversation in three parts:',
  '',
  '**1. Lead with what changed, not with the number.** Your current salary was set for the role you had then. Open with how the role has grown since.',
  '',
  '**2. Bring three concrete arguments:**',
  '1. **Scope**: you have taken on work beyond your role. Name two examples, with dates.',
  '2. **Results**: make the impact measurable, for example "the reporting I automated saves the team about six hours a week".',
  '3. **Market**: comparable roles are currently advertised at 55k to 62k, so 58k is mid-range, not the top.',
  '',
  '**3. Say the number first, and only once.** "Based on this, I am asking for 58,000." Then stop talking and let them respond.',
  '',
  'If the answer is no, ask what specifically would justify 58k within six months, and get it in writing.'
].join('\n')
const MKT_SALARY_DE = [
  'Von 52k auf 58k sind rund 11,5 % mehr: ambitioniert, aber gut vertretbar, wenn du mit Ergebnissen argumentierst. Baue das Gespräch in drei Teilen auf:',
  '',
  '**1. Beginne mit dem, was sich geändert hat, nicht mit der Zahl.** Dein aktuelles Gehalt wurde für deine damalige Rolle festgelegt. Starte damit, wie die Rolle seitdem gewachsen ist.',
  '',
  '**2. Bringe drei konkrete Argumente:**',
  '1. **Verantwortung**: Du hast Aufgaben über deine Rolle hinaus übernommen. Nenne zwei Beispiele, mit Datum.',
  '2. **Ergebnisse**: Mach den Nutzen messbar, zum Beispiel "das automatisierte Reporting spart dem Team rund sechs Stunden pro Woche".',
  '3. **Markt**: Vergleichbare Stellen sind derzeit mit 55k bis 62k ausgeschrieben, 58k liegt also in der Mitte, nicht am oberen Rand.',
  '',
  '**3. Nenne die Zahl zuerst und nur einmal.** "Auf dieser Basis möchte ich 58.000." Danach bewusst schweigen und die Reaktion abwarten.',
  '',
  'Falls die Antwort Nein ist: Frag, was 58k innerhalb von sechs Monaten konkret rechtfertigen würde, und lass es dir schriftlich geben.'
].join('\n')

// Contract shot: deadlines/notice periods extracted from the fictional sample lease used across
// the marketing material (marketing repo: product-video/samples/lease-lindenstrasse-14.md).
const MKT_CONTRACT_EN = [
  'Your rental contract contains these deadlines and notice periods:',
  '',
  '1. **Fixed term**: three years, 1 September 2026 to 31 August 2029; ends without notice (§ 3) [S1].',
  '2. **Ordinary termination**: possible after the first 12 months, with **three months\' written notice** to the end of a calendar month, by registered letter (§ 7) [S2].',
  '3. **Rent payment**: due in advance, on the landlord\'s account **by the 5th of each month** (§ 4) [S3].',
  '4. **Operating costs**: reconciled annually **each June**; differences settled **within four weeks** of the statement (§ 5) [S4].',
  '5. **Deposit**: €2,850, due **before handover of the keys** (§ 6) [S5].',
  '',
  'The date to watch is the termination window: to end the lease on 31 December, your notice must reach the landlord by 30 September.'
].join('\n')
const MKT_CONTRACT_DE = [
  'Dein Mietvertrag enthält folgende Fristen und Kündigungsfristen:',
  '',
  '1. **Befristung**: drei Jahre, 1. September 2026 bis 31. August 2029; endet ohne Kündigung (§ 3) [S1].',
  '2. **Ordentliche Kündigung**: möglich nach den ersten 12 Monaten, mit **drei Monaten schriftlicher Frist** zum Ende eines Kalendermonats, per Einschreiben (§ 7) [S2].',
  '3. **Mietzahlung**: im Voraus fällig, **bis zum 5. jedes Monats** auf dem Konto der Vermieterin (§ 4) [S3].',
  '4. **Betriebskosten**: Abrechnung jährlich **im Juni**; Ausgleich **innerhalb von vier Wochen** nach der Abrechnung (§ 5) [S4].',
  '5. **Kaution**: 2.850 €, fällig **vor der Schlüsselübergabe** (§ 6) [S5].',
  '',
  'Entscheidend ist das Kündigungsfenster: Um zum 31. Dezember zu kündigen, muss die Kündigung bis 30. September bei der Vermieterin eingehen.'
].join('\n')

// Citations for the documents-mode answers. Labels stay machine-stable `S{n}` (the renderer
// localizes the display to `[Q{n}]` in German). Titles match the staged document lists below.
function mktSpendingCitations(): Citation[] {
  const de = mktDe()
  const bank = (q: number): string => (de ? `kontoauszuege-2025-q${q}.pdf` : `bank-statements-2025-q${q}.pdf`)
  const ins = de ? 'versicherungspolicen.pdf' : 'insurance-policies.pdf'
  const card = de ? 'kreditkarte-2025.csv' : 'credit-card-2025.csv'
  return [
    { label: 'S1', sourceTitle: bank(4), pageNumber: 12 },
    { label: 'S2', sourceTitle: de ? 'mietvertrag-2024.pdf' : 'rental-contract-2024.pdf', pageNumber: 2 },
    { label: 'S3', sourceTitle: ins, pageNumber: 7 },
    { label: 'S4', sourceTitle: bank(2), pageNumber: 5 },
    { label: 'S5', sourceTitle: bank(3), pageNumber: 9 },
    { label: 'S6', sourceTitle: ins, pageNumber: 14 },
    { label: 'S7', sourceTitle: ins, pageNumber: 11 },
    { label: 'S8', sourceTitle: card },
    { label: 'S9', sourceTitle: card }
  ]
}
function mktContractCitations(): Citation[] {
  const de = mktDe()
  const doc = de ? 'mietvertrag-lindenstrasse-14.pdf' : 'lease-lindenstrasse-14.pdf'
  const c = (label: string, pageNumber: number, en: string, deSnip: string): Citation => ({
    label,
    sourceTitle: doc,
    pageNumber,
    snippet: de ? deSnip : en
  })
  return [
    c('S1', 1,
      'The lease is concluded for a fixed term of three years, beginning on 1 September 2026 and ending on 31 August 2029, without need of notice at expiry.',
      'Das Mietverhältnis wird auf die Dauer von drei Jahren geschlossen, beginnend am 1. September 2026 und endend am 31. August 2029, ohne dass es einer Kündigung bedarf.'),
    c('S2', 2,
      'After the first 12 months of the term, either party may terminate this lease with three months\' written notice to the end of a calendar month.',
      'Nach Ablauf der ersten 12 Monate kann jede Partei das Mietverhältnis mit einer Frist von drei Monaten schriftlich zum Ende eines Kalendermonats kündigen.'),
    c('S3', 1,
      'Rent is due in advance and must be credited by the 5th day of each month to the Landlord\'s account.',
      'Die Miete ist im Voraus fällig und muss bis zum 5. Tag eines jeden Monats dem Konto der Vermieterin gutgeschrieben sein.'),
    c('S4', 1,
      'Actual costs are reconciled annually each June; differences are settled within four weeks of the statement.',
      'Die tatsächlichen Kosten werden jährlich im Juni abgerechnet; Differenzen werden innerhalb von vier Wochen nach der Abrechnung ausgeglichen.'),
    c('S5', 2,
      'The Tenant provides a deposit of €2,850 (three months\' rent) before handover of the keys.',
      'Der Mieter leistet vor Schlüsselübergabe eine Kaution von 2.850 € (drei Monatsmieten).')
  ]
}

function mktConversations(): Conversation[] {
  const de = mktDe()
  const docsConv = (id: string, title: string): Conversation => ({
    ...conv(id, title, null),
    mode: 'documents' as Conversation['mode']
  })
  if (mktShot() === 'salary') {
    return [
      conv('m1', de ? 'Gehaltsgespräch: Argumente' : 'Salary review: my arguments', null),
      conv('m2', de ? 'Entwurf: E-Mail an Vermieterin' : 'Draft: email to my landlord', null),
      conv('m3', de ? 'Ideen fürs Team-Offsite' : 'Ideas for the team offsite', null)
    ]
  }
  if (mktShot() === 'contract') {
    return [
      {
        ...docsConv('m1', de ? 'Mietvertrag: Fristen' : 'Rental contract: deadlines'),
        // Scoped to the lease itself so the composer chip names the single document.
        scope: { collectionIds: [], documentIds: ['mkt-d1'] }
      },
      docsConv('m2', de ? 'Ausgabenübersicht 2025' : 'Spending overview 2025'),
      docsConv('m3', de ? 'Versicherungsbrief zusammengefasst' : 'Insurance letter summary')
    ]
  }
  return [
    docsConv('m1', de ? 'Ausgabenübersicht 2025' : 'Spending overview 2025'),
    { ...conv('m2', de ? 'Mietvertrag: Kündigungsklauseln' : 'Rental contract clauses', null) },
    { ...conv('m3', de ? 'Versicherungsbrief zusammengefasst' : 'Insurance letter summary', null) }
  ]
}
function mktMessages(): Message[] {
  const de = mktDe()
  const turn = (prompt: string, answer: string, extra?: Partial<Message>): Message[] => [
    { id: 'mm1', conversationId: 'm1', role: 'user', content: prompt, createdAt: now },
    { id: 'mm2', conversationId: 'm1', role: 'assistant', content: answer, createdAt: now, ...extra }
  ]
  if (mktShot() === 'salary') {
    return turn(
      de
        ? 'Ich habe nächsten Monat ein Gehaltsgespräch. Ich verdiene 52k und möchte 58k verlangen. Hilf mir, meine Argumente zu strukturieren.'
        : 'I have a salary review next month. I earn 52k and want to ask for 58k. Help me structure my arguments.',
      de ? MKT_SALARY_DE : MKT_SALARY_EN
    )
  }
  if (mktShot() === 'contract') {
    return turn(
      de
        ? 'Liste alle Fristen und Kündigungsfristen in meinem Mietvertrag auf, jeweils mit der Klausel, aus der sie stammen.'
        : 'List every deadline and notice period in my rental contract, with the clause it comes from.',
      de ? MKT_CONTRACT_DE : MKT_CONTRACT_EN,
      {
        citations: mktContractCitations(),
        coverage: { mode: 'relevance', chunksCovered: 5, chunksTotal: 14 }
      }
    )
  }
  return turn(
    de ? 'Wofür habe ich letztes Jahr am meisten Geld ausgegeben?' : 'What did I spend the most money on last year?',
    de ? MKT_ANSWER_DE : MKT_ANSWER_EN,
    {
      citations: mktSpendingCitations(),
      coverage: { mode: 'relevance', chunksCovered: 9, chunksTotal: 52 }
    }
  )
}
// Staged fictional document library. The `documents` shot shows the full row fidelity
// (type, size, sections, project chips); the chat shots reuse the finance/lease lists that
// their citations name. Everything here is invented data.
function mktDoc(
  id: string,
  title: string,
  mimeType: string,
  sizeBytes: number,
  chunkCount: number,
  collections: Array<{ id: string; name: string; type: string }>
): DocumentInfo {
  return {
    id,
    title,
    status: 'indexed',
    errorMessage: null,
    mimeType,
    chunkCount,
    sizeBytes,
    createdAt: now,
    updatedAt: now,
    collections: collections.map((c) => ({ ...c, role: 'source' }))
  } as unknown as DocumentInfo
}
const MKT_LIB = { id: 'lib', name: 'Library', type: 'library' }
function mktProjects(): Array<{ id: string; name: string; type: string }> {
  const de = mktDe()
  return [
    { id: 'p-fin', name: de ? 'Finanzen 2025' : 'Finances 2025', type: 'project' },
    { id: 'p-legal', name: de ? 'Rechtliches' : 'Legal', type: 'project' },
    { id: 'p-tax', name: de ? 'Steuern' : 'Taxes', type: 'project' },
    { id: 'p-work', name: de ? 'Arbeit' : 'Work', type: 'project' }
  ]
}
function mktDocuments(): DocumentInfo[] {
  const de = mktDe()
  const [fin, legal, tax, work] = mktProjects()
  const PDF = 'application/pdf'
  if (mktShot() === 'contract') {
    return [
      mktDoc('mkt-d1', de ? 'mietvertrag-lindenstrasse-14.pdf' : 'lease-lindenstrasse-14.pdf', PDF, 412 * 1024, 14, [legal]),
      mktDoc('mkt-d2', de ? 'versicherungspolicen.pdf' : 'insurance-policies.pdf', PDF, 1258 * 1024, 42, [MKT_LIB]),
      mktDoc('mkt-d3', de ? 'uebergabeprotokoll-2026.pdf' : 'handover-protocol-2026.pdf', PDF, 186 * 1024, 5, [legal])
    ]
  }
  if (mktShot() === 'documents') {
    return [
      mktDoc('mkt-d1', de ? 'mietvertrag-lindenstrasse-14.pdf' : 'lease-lindenstrasse-14.pdf', PDF, 412 * 1024, 14, [legal]),
      mktDoc('mkt-d2', de ? 'versicherungspolicen-2026.pdf' : 'insurance-policies-2026.pdf', PDF, 1258 * 1024, 42, [MKT_LIB]),
      mktDoc('mkt-d3', de ? 'kontoauszuege-2025.pdf' : 'bank-statements-2025.pdf', PDF, 3480 * 1024, 86, [fin]),
      mktDoc('mkt-d4', de ? 'kreditkarte-2025.csv' : 'credit-card-2025.csv', 'text/csv', 96 * 1024, 12, [fin]),
      mktDoc('mkt-d5', de ? 'gehaltsabrechnungen-2025.pdf' : 'payslips-2025.pdf', PDF, 1126 * 1024, 24, [fin]),
      mktDoc('mkt-d6', de ? 'steuerbescheid-2024.pdf' : 'tax-assessment-2024.pdf', PDF, 640 * 1024, 18, [tax]),
      mktDoc('mkt-d7', de ? 'arztbrief-2026-03.pdf' : 'medical-letter-2026-03.pdf', PDF, 210 * 1024, 6, [MKT_LIB]),
      mktDoc('mkt-d8', de ? 'besprechungsnotizen-lieferant.md' : 'meeting-notes-supplier.md', 'text/markdown', 48 * 1024, 9, [work])
    ]
  }
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

// Case-aware overrides: the marketing cases swap in their own conversations/messages/documents
// and force theme + UI language; every other case keeps the exact behavior above.
const baseListConversations = overrides.listConversations as () => Promise<Conversation[]>
overrides.listConversations = async () => (isMkt() ? mktConversations() : baseListConversations())
const baseListCollections = overrides.listCollections as () => Promise<Collection[]>
overrides.listCollections = async () => {
  if (!isMkt()) return baseListCollections()
  return [
    coll('lib', 'Library', 'library'),
    coll('tmp', 'Temporary', 'temporary'),
    ...mktProjects().map((p) => coll(p.id, p.name))
  ]
}
overrides.listMessages = async () => (isMkt() ? mktMessages() : [])
const baseGetSettings = overrides.getSettings as () => Promise<typeof DEFAULT_SETTINGS>
overrides.getSettings = async () => {
  const s = await baseGetSettings()
  // Force theme AND UI language: settings-driven language resolution would otherwise follow
  // the OS locale, mixing e.g. German chrome into the English capture. workspaceMode reads
  // 'encrypted' so the privacy shot shows the shipping posture, not the dev fallback.
  return isMkt()
    ? {
        ...s,
        theme: mktLight() ? ('light' as const) : ('dark' as const),
        uiLanguage: mktDe() ? ('de' as const) : ('en' as const),
        workspaceMode: 'encrypted' as const
      }
    : s
}
const baseGetRuntimeStatus = overrides.getRuntimeStatus as () => Promise<Record<string, unknown>>
overrides.getRuntimeStatus = async () => {
  const st = await baseGetRuntimeStatus()
  // A believable model name in the header hint instead of the mock id — a currently-ranked,
  // shipping manifest id (PF-2, full-audit 2026-07-12b: captures must not show a model no
  // user can select; swap deliberately when a bigger model productizes).
  return isMkt() ? { ...st, modelId: 'ministral3-8b-instruct-2512-q4' } : st
}
overrides.listDocuments = async () => (isMkt() ? mktDocuments() : DOCUMENTS)
// The privacy shot (and the rail indicator on every marketing shell) reads the effective
// offline state + drive paths. Fully-offline posture, prepared drive at E:\ (Windows-flavored
// paths: the Kit's primary platform).
overrides.getPolicy = async () =>
  isMkt()
    ? ({
        policy: {},
        policyFilePresent: true,
        driveFilePresent: true,
        allowNetworkSetting: false,
        networkAllowedByPolicy: true,
        networkAllowed: false,
        offlineMode: true,
        telemetryAllowed: false
      } as unknown as PolicyStatus)
    : null
overrides.getDriveStatus = async () =>
  isMkt()
    ? ({
        rootPath: 'E:\\',
        workspacePath: 'E:\\workspace',
        modelsPath: 'E:\\models',
        logsPath: 'E:\\logs',
        isPreparedDrive: true,
        writable: true,
        freeBytes: 91 * 1024 * 1024 * 1024,
        platform: 'win32',
        arch: 'x64'
      } as unknown as DriveStatus)
    : null
// F-36: the marketing getSettings override (above) forces settings.workspaceMode 'encrypted' so
// PrivacyTab renders the encrypted protection card — but App gates the rail's Lock-now control on
// workspace.mode === 'encrypted', read from getWorkspaceState. Left at 'plaintext_dev' (the
// brand-home base), the shell shots staged an impossible posture: an encrypted privacy card beside
// a rail with NO Lock-now button. Make this override case-aware too so the two sources agree; the
// component-level cases keep the plaintext_dev base (brand-home needs only 'unlocked').
const baseGetWorkspaceState = overrides.getWorkspaceState as () => Promise<{
  state: string
  mode: string
  plaintextAllowed: boolean
  encryptionRequired: boolean
}>
overrides.getWorkspaceState = async () =>
  isMkt()
    ? {
        state: 'unlocked' as const,
        mode: 'encrypted' as const,
        plaintextAllowed: false,
        encryptionRequired: true
      }
    : baseGetWorkspaceState()

// Walk helpers: each staged shell ticks until its goal selector exists, clicking its way
// through the real UI. Nav labels are matched in both languages.
function mktClickNav(labels: string[]): void {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-item')).find((b) =>
    labels.includes(b.querySelector('.nav-label')?.textContent ?? '')
  )
  btn?.click()
}
function mktStepChat(): void {
  const row = document.querySelector<HTMLButtonElement>('.chat-conv-row button')
  if (row) {
    row.click()
    return
  }
  mktClickNav(['Chat'])
}
function mktStepChatSources(): void {
  const toggle = document.querySelector<HTMLButtonElement>('.sources-toggle[aria-expanded="false"]')
  if (toggle) {
    toggle.click()
    return
  }
  mktStepChat()
}
function mktStepDocuments(): void {
  mktClickNav(['Documents', 'Dokumente'])
}
function mktStepPrivacy(): void {
  const seg = Array.from(document.querySelectorAll<HTMLButtonElement>('.seg-btn')).find((b) =>
    ['Privacy & data', 'Privatsphäre & Daten'].includes((b.textContent ?? '').trim())
  )
  if (seg) {
    seg.click()
    return
  }
  mktClickNav(['Settings', 'Einstellungen'])
}

function StagedShell({ goal, step }: { goal: string; step: () => void }): JSX.Element {
  // Walk the real UI once the shell has rendered. Marks body[data-marketing-ready] for the
  // screenshot script when the goal element is up.
  useEffect(() => {
    document.documentElement.dataset.theme = mktLight() ? 'light' : 'dark'
    // The settings load can remount the tree (language/theme application) AFTER a first
    // successful walk, resetting the selection — so keep walking until the goal has been
    // continuously present for a few ticks, and only then mark the capture ready.
    let tries = 0
    let stable = 0
    const timer = setInterval(() => {
      tries += 1
      if (tries > 120) {
        // F-38 give-up path: the goal never stabilized. Print an actionable warning so a wrong
        // (reset-shell) capture cannot ship silently — waitReady only ever times out generically,
        // and if we reached readiness earlier the flag is set so this is skipped.
        if (!document.body.dataset.marketingReady) {
          console.warn(`[marketing] goal "${goal}" never stabilized after ${tries} ticks — capture may be wrong`)
        }
        clearInterval(timer)
        return
      }
      if (document.querySelector(goal)) {
        stable += 1
        if (stable >= 5) document.body.dataset.marketingReady = '1'
        // F-38: do NOT clearInterval on success. The settings load can remount the tree AFTER a
        // first successful walk; if the goal then disappears the else-branch below clears the flag
        // and re-walks, so waitReady re-blocks instead of capturing the reset shell. Keep observing
        // until the tries cap. (The flag was previously sticky: clearing the timer on success made
        // its own delete unreachable, so a post-readiness remount yielded a silently wrong capture.)
        return
      }
      stable = 0
      delete document.body.dataset.marketingReady
      step()
    }, 100)
    return () => clearInterval(timer)
  }, [goal, step])
  return <App />
}

// The rail privacy indicator close-up: the real component in its offline state, with the
// hover/focus reassurance line rendered statically below (a real Radix tooltip needs
// focus-visible, which a headless capture cannot produce).
function MktIndicator(): JSX.Element {
  const { t } = useT()
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10, padding: 24 }}>
      <LocalIndicator variant="header" offline onNavigate={noop} t={t} />
      <div className="tooltip" style={{ position: 'static' }}>
        {t('indicator.offlineDetail')}
      </div>
    </div>
  )
}

const MKT_SHELL: Record<string, { goal: string; step: () => void; w: number; h: number; what: string }> = {
  salary: { goal: '.msg-content', step: mktStepChat, w: 1180, h: 800, what: 'staged salary-negotiation chat' },
  spending: { goal: '.msg-content', step: mktStepChat, w: 1180, h: 800, what: 'staged fictional spending answer' },
  contract: { goal: '.sources-cards', step: mktStepChatSources, w: 1180, h: 1170, what: 'staged contract-deadlines answer, sources expanded' },
  documents: { goal: '.doc-row', step: mktStepDocuments, w: 1180, h: 800, what: 'staged document library' },
  privacy: { goal: '.offline-statement', step: mktStepPrivacy, w: 1180, h: 1080, what: 'Settings privacy tab, offline posture' }
}
for (const [shot, cfg] of Object.entries(MKT_SHELL)) {
  for (const suffix of ['', '-de', '-light', '-de-light']) {
    CASES[`marketing-${shot}${suffix}`] = {
      label: `Marketing — full shell, ${cfg.what} (${suffix.includes('light') ? 'light' : 'dark'}${suffix.includes('de') ? ', DE' : ''})`,
      node: (
        <div style={{ width: cfg.w, height: cfg.h }}>
          <StagedShell goal={cfg.goal} step={cfg.step} />
        </div>
      )
    }
  }
}
for (const suffix of ['', '-de', '-light', '-de-light']) {
  CASES[`marketing-indicator${suffix}`] = {
    label: `Marketing — rail privacy indicator close-up (${suffix.includes('light') ? 'light' : 'dark'}${suffix.includes('de') ? ', DE' : ''})`,
    node: <MktIndicator />
  }
}
// Theme must be on <html> before first paint (the indicator case has no shell to apply it).
if (isMkt()) document.documentElement.dataset.theme = mktLight() ? 'light' : 'dark'

const params = new URLSearchParams(location.search)
const caseId = params.get('case') ?? 'documents'
// The By-Project view is a localStorage preference; force it on for the chat case.
try {
  localStorage.setItem('hilbertraum.chat.listView', caseId === 'chat-byproject' ? 'byProject' : 'recent')
  // A case with a `-de` segment renders in German (I18nProvider reads this mirror at init);
  // everything else EN. Segment check, not endsWith: marketing ids can end in `-de-light`.
  localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, caseId.split('-').includes('de') ? 'de' : 'en')
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
