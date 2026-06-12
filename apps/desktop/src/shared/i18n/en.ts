// The ENGLISH catalog — the source of truth for every message key (i18n-plan §3.1,
// D-L1). Flat keys, `{name}` interpolation placeholders, `.one`/`.other` plural pairs.
// `de.ts` is typed `Record<MessageKey, string>` against this object, so `npm run
// typecheck` fails when the catalogs drift apart.
//
// English values for strings that already shipped MUST stay byte-identical to the
// pre-i18n literals: ~323 existing test assertions query this copy, and the default
// language resolves to English on the EN dev/CI machine (D-L8).

export const en = {
  // ---- App shell (App.tsx) ----
  'nav.home': 'Home',
  'nav.chat': 'Chat',
  'nav.documents': 'Documents',
  'nav.models': 'AI Model',
  'nav.settings': 'Settings',
  'app.lockNow': 'Lock now',
  'app.lockNowTitle': 'Re-encrypt and lock the workspace',
  'app.noticeDetails': 'Details',

  // ---- Home (plural pair; exercised by unit tests now, wired in the Phase-40 sweep) ----
  'home.docsReady.one': '{count} document ready to ask about',
  'home.docsReady.other': '{count} documents ready to ask about',

  // ---- Settings (SettingsScreen.tsx — chrome + the General tab) ----
  'settings.title': 'Settings',
  'settings.tabsAria': 'Settings sections',
  'settings.tab.general': 'General',
  'settings.tab.privacy': 'Privacy & data',
  'settings.tab.diagnostics': 'Diagnostics (advanced)',
  'settings.loading': 'Loading settings…',
  'settings.saved': 'Saved',
  'settings.network.title': 'Privacy & Offline Mode',
  'settings.network.allow': 'Allow internet access for model downloads and updates',
  'settings.network.hint':
    'Off by default. When off, the app makes no network calls. Turning it on only enables ' +
    'model downloads from the AI Model screen — each one asks for confirmation first, and a ' +
    'drive policy can keep downloads disabled entirely. Your prompts and documents never ' +
    'leave this device regardless of this setting.',
  'settings.appearance.title': 'Appearance',
  'settings.appearance.aria': 'Theme',
  'settings.appearance.system': 'System',
  'settings.appearance.light': 'Light',
  'settings.appearance.dark': 'Dark',
  'settings.appearance.hint':
    '“System” follows your operating system’s light/dark preference. The lock screen ' +
    'always follows the system theme.',
  'settings.language.title': 'Language',
  'settings.language.aria': 'Language',
  'settings.language.hint':
    '“System” follows your operating system’s language: German systems use Deutsch, ' +
    'everything else uses English. Changes apply right away.',
  'settings.performance.title': 'Performance',
  'settings.performance.gpu': 'Use GPU acceleration',
  'settings.performance.gpuHint':
    'Uses your graphics card to speed up responses when available. Turn off only if you ' +
    'notice stability problems — everything keeps working either way.',
  'settings.performance.autoStart': 'Load the selected model automatically when the app starts',
  'settings.performance.autoStartHint':
    'On by default. The model selected on the AI Model screen is loaded in the background at ' +
    'launch (after unlock on encrypted workspaces) so Chat is ready without extra clicks.',
  'settings.developer.title': 'Developer',
  'settings.developer.toggle': 'Developer mode (allows plaintext workspace, unverified models)',
  'settings.developer.hint':
    'Off by default. Dev builds always count as developer. The drive policy is ' +
    'authoritative: on a commercial drive, unverified models stay rejected regardless of ' +
    'this setting.',
  'settings.workspace.title': 'Workspace',
  'settings.workspace.mode': 'Mode',
  'settings.workspace.modeEncrypted': 'Encrypted',
  'settings.workspace.modePlaintext': 'Plaintext (developer)',
  'settings.workspace.contextTokens': 'Context tokens',
  'settings.workspace.encryptedHint':
    'This workspace is encrypted at rest. Use “Lock now” in the sidebar to re-encrypt and ' +
    'lock it; it also locks automatically on quit.',
  'settings.workspace.plaintextHint':
    'Plaintext developer workspace — data is stored unencrypted. The encrypted mode is the ' +
    'commercial default.',
  'settings.changePassword.title': 'Change password',
  'settings.changePassword.hint':
    "Pick a new password for this workspace. You'll use it from the next unlock on. " +
    "It can't be recovered or reset, so choose something you'll remember.",
  'settings.changePassword.current': 'Current password',
  'settings.changePassword.new': 'New password',
  'settings.changePassword.confirm': 'Confirm new password',
  'settings.changePassword.busy':
    'Securing your documents with the new password… On a large library this can take a few ' +
    'minutes.',
  'settings.changePassword.failed': 'Something went wrong. Your current password still works.',
  'settings.changePassword.submit': 'Change password',
  'settings.changePassword.submitBusy': 'Changing…',
  'settings.changePassword.toast': 'Password changed',

  // ---- Shared password copy ----
  'password.mismatch': "Passwords don't match.",

  // ---- Workspace gate (WorkspaceGate.tsx) ----
  'gate.passwordPlaceholder': 'Password',
  'gate.unlock.title': 'Unlock your workspace',
  'gate.unlock.hint':
    "Enter your password to open this drive's workspace. Everything stays on this drive.",
  'gate.unlock.submit': 'Unlock',
  'gate.unlock.submitBusy': 'Unlocking…',
  'gate.welcome.title': 'Welcome',
  'gate.welcome.intro':
    'This is your private AI workspace. Chat with an AI model and ask questions about your ' +
    'documents — it all runs from this drive.',
  'gate.welcome.stays': 'Everything stays on this drive.',
  'gate.welcome.staysRest': 'No internet, no account, no tracking.',
  'gate.welcome.start': 'Get started',
  'gate.finishing.title': 'Setting things up…',
  'gate.finishing.hint':
    "Checking what's already on this drive. The first look at a large AI model file can " +
    'take a few minutes.',
  'gate.finishing.skip': 'Skip — take me to the app',
  'gate.starter.title': 'One last thing',
  'gate.starter.noModel':
    'No AI model is installed on this drive yet — chat needs one to answer. You can add one ' +
    'now, or any time later from the AI Model screen.',
  'gate.starter.optional':
    'Downloading a model is optional and always asks for your confirmation first. Your ' +
    'documents and chats never use the internet either way.',
  'gate.starter.skip': 'Skip for now',
  'gate.starter.addDocuments': 'Add documents',
  'gate.starter.chooseModel': 'Choose your AI model',
  'gate.create.title': 'Create your password',
  'gate.create.hint':
    'This password locks everything in your workspace — documents, chats, and notes — on ' +
    "this drive. It can't be recovered or reset, so pick something you'll remember.",
  'gate.create.plaintextToggle': 'Use a plaintext developer workspace (no encryption)',
  'gate.create.plaintextWarning':
    'Plaintext mode stores your data unencrypted on this drive. Use it only for development.',
  'gate.create.confirmPlaceholder': 'Confirm password',
  'gate.create.back': 'Back',
  'gate.create.submit': 'Create workspace',
  'gate.create.submitBusy': 'Creating…',
  'gate.error.generic': 'Something went wrong. Please try again.',

  // ---- Main-process emissions (D-L5: ephemeral strings localized via tMain at the
  // emission site — these never reach the DB) ----
  'main.workspace.wrongPassword':
    "That password didn't unlock your workspace. Check it and try again."
} as const
