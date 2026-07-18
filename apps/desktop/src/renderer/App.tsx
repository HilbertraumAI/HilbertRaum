import { Suspense, lazy, useEffect, useState } from 'react'
import { HomeScreen } from './screens/HomeScreen'
import { ChatScreen } from './screens/ChatScreen'
import { WorkspaceGate } from './screens/WorkspaceGate'

// Route-level code split (full-audit 2026-07-10 PF-6). These six screens load as separate
// async chunks on first navigation, keeping their code (and their exclusive deps — e.g.
// pdfjs on Documents) out of the init bundle the modest-CPU target must parse before first
// paint. Deliberately EAGER: the workspace gate + HomeScreen (the first frame) and
// ChatScreen (the primary surface — first-run lands there, and its shared chat components
// are used by several screens so splitting it would buy little). The i18n catalogs stay in
// the init bundle by design — splitting them is a separate decision.
// Each lazy screen suspends to the quiet fallback below, inside the existing per-screen
// ErrorBoundary (a failed chunk load rejects the import and lands on the boundary's
// localized fallback with retry).
const DocumentsScreen = lazy(() =>
  import('./screens/DocumentsScreen').then((m) => ({ default: m.DocumentsScreen }))
)
const TranslateScreen = lazy(() =>
  import('./screens/TranslateScreen').then((m) => ({ default: m.TranslateScreen }))
)
const ImagesScreen = lazy(() =>
  import('./screens/ImagesScreen').then((m) => ({ default: m.ImagesScreen }))
)
const ModelsScreen = lazy(() =>
  import('./screens/ModelsScreen').then((m) => ({ default: m.ModelsScreen }))
)
const SettingsScreen = lazy(() =>
  import('./screens/SettingsScreen').then((m) => ({ default: m.SettingsScreen }))
)
const SkillsScreen = lazy(() =>
  import('./screens/SkillsScreen').then((m) => ({ default: m.SkillsScreen }))
)
// Evidence-review workspace (EP-1 plan §7.1): lazy like the other non-first-frame screens.
// No nav-rail entry — reachable ONLY via the openReview handoff below.
const ReviewScreen = lazy(() =>
  import('./screens/ReviewScreen').then((m) => ({ default: m.ReviewScreen }))
)
import {
  Banner,
  BrandMark,
  Button,
  ErrorBoundary,
  Icon,
  LocalIndicator,
  ToastProvider,
  type IconName
} from './components'
import { setThemeSetting } from './theme'
import { runAndSurface } from './lib/errors'
import { purgeSessionStores } from './lib/lockPurge'
import { flushReviewSession, type ReviewHandoffTarget } from './lib/reviewSession'
import { I18nProvider, useT, type I18n } from './i18n'
import { resolveNavTarget, type ScreenId, type SettingsTab } from './navigation'
import type { MessageKey } from '@shared/i18n'
import type { WorkspaceStateInfo } from '@shared/types'

interface NavItem {
  id: ScreenId
  labelKey: MessageKey
  icon: IconName
}

// Information architecture (design-guidelines §2): 7 everyday destinations on top,
// Settings as the single bottom utility. Privacy and Diagnostics live INSIDE Settings
// as tabs — they are no longer nav destinations. Skills is a top-level destination of its
// own (no longer a Settings tab) — it is a first-class capability surface, not a setting.
// Images (image-understanding §6) and Translate (TranslateGemma plan §2 D6) are distinct
// task surfaces parallel to Documents/Chat.
const NAV_TOP: NavItem[] = [
  { id: 'home', labelKey: 'nav.home', icon: 'home' },
  { id: 'chat', labelKey: 'nav.chat', icon: 'chat' },
  { id: 'documents', labelKey: 'nav.documents', icon: 'file' },
  // Translate is a genuine primary destination — a first-class text-translation surface on the
  // dedicated TranslateGemma sidecar (TranslateGemma plan §2 D6; design-guidelines §2 updated to
  // "7 primary + 1 utility"). Sits after Documents, before Images.
  { id: 'translate', labelKey: 'nav.translate', icon: 'translate' },
  // Images is a genuine primary destination — a first-class task surface parallel to
  // Documents/Chat, not a sub-mode (image-understanding §6). After Translate, before AI Model.
  { id: 'images', labelKey: 'nav.images', icon: 'image' },
  { id: 'models', labelKey: 'nav.models', icon: 'brain' },
  { id: 'skills', labelKey: 'nav.skills', icon: 'puzzle' }
]

const NAV_BOTTOM: NavItem[] = [{ id: 'settings', labelKey: 'nav.settings', icon: 'settings' }]

export function App(): JSX.Element {
  // The language provider wraps EVERYTHING, including the pre-unlock gate (which
  // resolves from the localStorage mirror / OS locale — i18n record §3.2).
  return (
    <I18nProvider>
      <AppShell />
    </I18nProvider>
  )
}

function AppShell(): JSX.Element {
  const [screen, setScreen] = useState<ScreenId>('home')
  // Which Settings tab is open: driven by navigate() so virtual targets
  // like 'settings:privacy' (and the legacy 'privacy' alias) land on the right tab.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  // Which composer mode the Chat screen opens with. Home's "Ask my documents" jumps
  // straight into a document-Q&A chat; plain "Chat" navigation resets to chat mode.
  const [chatMode, setChatMode] = useState<'chat' | 'documents'>('chat')
  // "Ask selected documents" handoff: the Documents screen's selection,
  // applied to the next documents conversation the Chat screen creates.
  const [chatScope, setChatScope] = useState<string[] | null>(null)
  // EP-1 P5 (plan §10): the conversation the Chat screen should open with — set ONLY by the
  // review screen's "Back to chat" so it returns to the ORIGINATING conversation. One-shot
  // by construction: every normal chat navigation (navigate below) clears it.
  const [chatConversation, setChatConversation] = useState<string | null>(null)
  // Evidence-review handoff (EP-1 plan §7.1 — the chatScope idiom): which review (or
  // message, for a first review) the review screen opens. The screen is meaningless
  // without it, which is why plain navigate('review') resolves to home (navigation.ts).
  const [reviewHandoff, setReviewHandoff] = useState<ReviewHandoffTarget | null>(null)
  // The workspace lifecycle gate. Null = still loading; not 'unlocked' = show
  // the create-password / unlock gate before the normal app shell.
  const [workspace, setWorkspace] = useState<WorkspaceStateInfo | null>(null)
  // Live EFFECTIVE offline state for the single rail-foot privacy indicator (§1.2/§12.1
  // #2). `getPolicy().offlineMode` already folds the drive policy AND the network toggle,
  // so a policy that forces downloads off reads "Offline" even with the toggle on.
  // Re-checked when the Settings screen is visited (the toggle may have changed). Policy
  // detail ("disabled by policy" vs. off by choice) lives on the Privacy & data tab the
  // indicator opens.
  const [offline, setOffline] = useState(true)
  // Set when the backend never came up (getWorkspaceState rejected). Faking 'unlocked'
  // here would render the full shell with every screen surfacing raw IPC errors.
  const [fatalError, setFatalError] = useState<string | null>(null)
  // One-line, dismissible runtime notice: currently the GPU crash auto-fallback's
  // friendly "switched to compatibility mode" message (spec §11.4 tone).
  const [notice, setNotice] = useState<string | null>(null)
  // full-audit 2026-07-11 CODE-26: a FAILED "Lock now" (main restored the unlocked vault,
  // CODE-1a) used to be an unhandled rejection — the shell silently stayed unlocked on the
  // most security-sensitive control. Main's friendly copy is surfaced here as a dismissible
  // error banner; the session stores are deliberately NOT purged and the shell stays usable
  // (the workspace really is still unlocked), so the user can free space and retry.
  const [lockError, setLockError] = useState<string | null>(null)
  const { t, applyLanguageSetting } = useT()

  useEffect(() => {
    const unsubscribe = window.api?.onRuntimeNotice?.((message) => setNotice(message))
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    let active = true
    window.api
      ?.getWorkspaceState()
      .then((s) => active && setWorkspace(s))
      .catch((e) => active && setFatalError(String(e instanceof Error ? e.message : e)))
    return () => {
      active = false
    }
  }, [])

  const unlocked = workspace?.state === 'unlocked'

  useEffect(() => {
    if (!unlocked) return
    let active = true
    window.api
      ?.getPolicy()
      .then((p) => active && setOffline(p.offlineMode))
      .catch(() => active && setOffline(true))
    // Apply the persisted Appearance + Language settings. Settings are only readable
    // post-unlock; re-checked alongside the policy so a Settings-screen change made
    // this session is also picked up after navigation. applyLanguageSetting also
    // refreshes <html lang> and the pre-unlock localStorage mirror.
    window.api
      ?.getSettings()
      .then((s) => {
        if (!active) return
        setThemeSetting(s.theme)
        applyLanguageSetting(s.uiLanguage)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [screen, unlocked, applyLanguageSetting])

  // Central navigation: screens hand any target (real, virtual, or legacy alias) to
  // resolveNavTarget — see navigation.ts for the table.
  function navigate(target: string): void {
    const next = resolveNavTarget(target)
    if (next.chatMode) {
      setChatMode(next.chatMode)
      setChatScope(null)
      setChatConversation(null)
    }
    if (next.settingsTab) setSettingsTab(next.settingsTab)
    setScreen(next.screen)
  }

  // Documents screen → "Ask these documents" (spec §10.4): open Chat in
  // documents mode with the selection as the next conversation's retrieval scope.
  // P5 review FIX-1: this path mounts chat WITHOUT going through navigate(), so it must
  // clear the review back-handoff itself — a surviving `chatConversation` would make the
  // mount re-attach an OLD conversation and stomp the just-set documents mode (pinned by
  // an App-level test). The only setScreen('chat') paths are navigate() and this one.
  function askSelectedDocuments(documentIds: string[]): void {
    setChatMode('documents')
    setChatScope(documentIds.length > 0 ? documentIds : null)
    setChatConversation(null)
    setScreen('chat')
  }

  // Chat → evidence-review workspace (EP-1 plan §7.1): the ONLY way onto the review
  // screen. Back navigation is the screen's own "Back to chat" → backToConversation below.
  function openReview(target: ReviewHandoffTarget): void {
    setReviewHandoff(target)
    setScreen('review')
  }

  // Review → chat (EP-1 P5, plan §10): back restores the review's ORIGINATING conversation
  // as the active chat instead of landing on chat home (the named P2 UX debt). navigate()
  // runs FIRST (it clears the slot for plain chat navigations), then the handoff is set —
  // both land in the same React batch, so the Chat screen mounts with the id in place.
  function backToConversation(conversationId: string): void {
    navigate('chat')
    setChatConversation(conversationId)
  }

  async function lockNow(): Promise<void> {
    setLockError(null)
    // EP-1 plan §7.5: flush pending review auto-save edits BEFORE the vault re-encrypts —
    // after lockWorkspace the write would be refused. Best-effort: a failed flush must
    // never block the lock (the user's explicit security action wins).
    await flushReviewSession().catch(() => {})
    const next = await window.api.lockWorkspace()
    // The real lock seam (TA-2 / H3): main has now aborted the jobs + re-encrypted the vault, so
    // drop the resident source/translation/image content from the module-level session stores in
    // lockstep. Screens can't do this themselves — lock unmounts every screen (the shell swaps to
    // WorkspaceGate below), so a screen-effect purge would never observe the lock.
    purgeSessionStores()
    setWorkspace(next)
    setScreen('home')
    // The locked gate cannot read settings — back to following the OS theme.
    // (The LANGUAGE deliberately stays: the gate follows the localStorage mirror.)
    setThemeSetting('system')
  }

  if (fatalError) {
    return (
      <div className="gate-shell">
        <div className="card">
          <h2>{t('app.fatal.title')}</h2>
          <p className="hint">
            {t('app.fatal.hintBefore')}
            <code>logs/app.log</code>
            {t('app.fatal.hintAfter')}
          </p>
          <p className="hint">
            <code>{fatalError}</code>
          </p>
        </div>
      </div>
    )
  }
  if (workspace && !unlocked) {
    return (
      <WorkspaceGate
        state={workspace}
        onUnlocked={(next, landOn) => {
          setWorkspace(next)
          // First-run create ends on the teaching Chat empty state (or the screen the
          // optional starter step picked); a plain unlock keeps the current screen.
          if (landOn) navigate(landOn)
        }}
      />
    )
  }
  if (!workspace) {
    return (
      <div className="gate-shell">
        <p className="hint">{t('app.loadingWorkspace')}</p>
      </div>
    )
  }

  function navButton(item: NavItem): JSX.Element {
    const label = t(item.labelKey)
    const active = screen === item.id
    return (
      <li key={item.id}>
        <button
          className={`nav-item ${active ? 'active' : ''}`}
          // Icon + short label make a quiet rail; the label can wrap/clip on narrow
          // widths, so the title carries the full destination name for a tooltip too.
          title={label}
          aria-current={active ? 'page' : undefined}
          onClick={() => navigate(item.id)}
        >
          <Icon name={item.icon} className="nav-icon" />
          <span className="nav-label">{label}</span>
        </button>
      </li>
    )
  }

  return (
    // The single toast host: screens fire "Saved"-style confirmations via
    // useToast(); the polite live region lives once, here.
    <ToastProvider>
    <div className="app-shell">
      <nav className="sidebar" aria-label={t('nav.aria')}>
        {/* Issue #47: the lockup heads a column of clickable rail items, and decades of
            convention read a logo in that position as "go Home" — so it must not be the
            one dead click on the rail. Same navigate() path as the labelled Home item
            below, which keeps carrying the VISUAL current-screen highlight; the logo
            carries the semantic aria-current only, so the rail never shows two lit
            selections. The accessible name folds the wordmark and the destination. */}
        <button
          type="button"
          className="brand"
          title={`HilbertRaum — ${t('nav.home')}`}
          aria-label={`HilbertRaum — ${t('nav.home')}`}
          aria-current={screen === 'home' ? 'page' : undefined}
          onClick={() => navigate('home')}
        >
          <BrandMark size={24} />
        </button>
        <ul className="nav-list">{NAV_TOP.map(navButton)}</ul>
        <ul className="nav-list nav-bottom">{NAV_BOTTOM.map(navButton)}</ul>
        {workspace.mode === 'encrypted' && (
          <button
            type="button"
            className="lock-btn"
            title={t('app.lockNowTitle')}
            aria-label={t('app.lockNow')}
            // CODE-26: surfaced, never fire-and-forget — a rejected lock lands on the banner.
            onClick={() => void runAndSurface(lockNow, setLockError)}
          >
            <Icon name="lock" className="nav-icon" />
            <span className="nav-label">{t('app.lockNow')}</span>
          </button>
        )}
        {/* The single app-wide privacy signal (§1.2/§7/§12.1 #2): one quiet, honest
            indicator at the foot of the rail, on EVERY screen. `offline` is the effective
            policy state owned by App, so a drive policy that forces downloads off reads
            "Offline" even with the toggle on. */}
        <LocalIndicator variant="sidebar" offline={offline} onNavigate={navigate} t={t} />
      </nav>

      <main className="content">
        {/* CODE-26: the failed-lock notice — main's friendly persist-canonical copy
            (already localized main-side), next to the content the user keeps working in. */}
        {lockError && (
          <Banner tone="error" t={t} onDismiss={() => setLockError(null)}>
            {lockError}
          </Banner>
        )}
        {notice && (
          <Banner
            tone="info"
            t={t}
            onDismiss={() => setNotice(null)}
            action={
              <Button size="sm" onClick={() => navigate('settings:diagnostics')}>
                {t('app.noticeDetails')}
              </Button>
            }
          >
            {notice}
          </Banner>
        )}
        {/* Per-screen error boundary (audit FE-1). KEYED by `screen`, so navigating to any
            other destination re-mounts the subtree and clears a captured error — the nav rail
            above lives OUTSIDE the boundary, so a render throw never traps the user. The
            fallback also offers an in-place retry. Logging is local-only (ErrorBoundary). */}
        <ErrorBoundary
          key={screen}
          fallback={(reset) => (
            // onHome resets the boundary AND navigates: if HOME itself threw, navigate('home') is
            // a same-value setScreen no-op (no key change → no re-mount), so reset() is what
            // actually clears the error; on any other screen the navigate changes the key and
            // reset() is harmless. Without the reset, "Go to Home" would be a dead no-op when the
            // throwing screen is Home (the default screen).
            <ScreenErrorFallback
              t={t}
              onRetry={reset}
              onHome={() => {
                reset()
                navigate('home')
              }}
            />
          )}
        >
          {/* The suspense point for the lazy screens (PF-6): a quiet, theme-correct hint in
              the same `.screen` container while a chunk loads off the local disk (a few ms,
              once per screen per session — React caches the resolved module). No spinner:
              guidelines §6 bans unlabeled spinners, and the text idiom matches
              app.loadingWorkspace. */}
          <Suspense
            fallback={
              <div className="screen" aria-busy="true">
                <p className="hint">{t('app.loadingScreen')}</p>
              </div>
            }
          >
            {screen === 'home' && <HomeScreen onNavigate={navigate} />}
            {screen === 'chat' && (
              <ChatScreen
                onNavigate={navigate}
                initialMode={chatMode}
                initialScopeDocumentIds={chatScope}
                initialConversationId={chatConversation}
                onOpenReview={openReview}
              />
            )}
            {/* Review renders ONLY with a handoff target (guaranteed by openReview being
                the sole path here; the guard keeps a future misroute blank-safe). */}
            {screen === 'review' && reviewHandoff && (
              <ReviewScreen
                handoff={reviewHandoff}
                onNavigate={navigate}
                onBackToConversation={backToConversation}
              />
            )}
            {screen === 'documents' && (
              <DocumentsScreen onAskSelected={askSelectedDocuments} onNavigate={navigate} />
            )}
            {screen === 'translate' && <TranslateScreen onNavigate={navigate} />}
            {screen === 'images' && <ImagesScreen onNavigate={navigate} />}
            {screen === 'models' && <ModelsScreen />}
            {screen === 'skills' && <SkillsScreen />}
            {screen === 'settings' && (
              <SettingsScreen tab={settingsTab} onTabChange={setSettingsTab} />
            )}
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
    </ToastProvider>
  )
}

// The localized per-screen fallback (audit FE-1). role="alert" so the contained failure is
// announced; the calm copy (spec §11.4) reassures that nothing was lost, with an in-place
// retry and an escape to Home.
function ScreenErrorFallback({
  t,
  onRetry,
  onHome
}: {
  t: I18n['t']
  onRetry: () => void
  onHome: () => void
}): JSX.Element {
  return (
    <div className="screen" role="alert">
      <div className="card">
        <h2>{t('errorBoundary.title')}</h2>
        <p className="hint">{t('errorBoundary.body')}</p>
        <div className="actions">
          <Button variant="primary" onClick={onRetry}>
            {t('errorBoundary.retry')}
          </Button>
          <Button onClick={onHome}>{t('errorBoundary.home')}</Button>
        </div>
      </div>
    </div>
  )
}
