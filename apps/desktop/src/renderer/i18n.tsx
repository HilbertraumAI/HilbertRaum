import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import {
  resolveUiLanguage,
  t,
  tCount,
  type CountMessageKey,
  type MessageKey,
  type MessageParams,
  type UiLanguage,
  type UiLanguageSetting
} from '@shared/i18n'

// Renderer-side language resolution (i18n record §3.2, D-L2/D-L3) — the theme.ts
// pattern: settings live in the possibly-encrypted DB and are unreadable pre-unlock,
// so the gate resolves from a localStorage MIRROR of the last resolved language
// (a UI preference, not user data — the ChatScreen list-collapse precedent), falling
// back to `navigator.language`. Once settings load (and on every Settings patch),
// `applyLanguageSetting` re-resolves, updates `<html lang>`, and rewrites the mirror.

/** localStorage key mirroring the last RESOLVED language ('en' | 'de'). */
export const UI_LANGUAGE_STORAGE_KEY = 'hilbertraum.uiLanguage'

function readMirror(): UiLanguage | null {
  try {
    const value = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)
    return value === 'en' || value === 'de' ? value : null
  } catch {
    return null
  }
}

function writeMirror(lang: UiLanguage): void {
  try {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, lang)
  } catch {
    /* mirror is best-effort — worst case the next gate follows the OS language */
  }
}

/** Pre-unlock language: the mirror if present, else the OS (browser) locale. */
export function resolvePreUnlockLanguage(): UiLanguage {
  return readMirror() ?? resolveUiLanguage('system', navigator.language)
}

export interface I18n {
  /** The resolved language everything currently renders in. */
  lang: UiLanguage
  t: (key: MessageKey, params?: MessageParams) => string
  tCount: (keyBase: CountMessageKey, count: number, params?: MessageParams) => string
  /**
   * Re-resolve from a (possibly changed) `AppSettings.uiLanguage`: called when
   * settings load after unlock and when the Settings picker patches the value.
   * Updates `<html lang>` + the localStorage mirror alongside the rendered language.
   */
  applyLanguageSetting: (setting: UiLanguageSetting) => void
}

function applyResolved(setting: UiLanguageSetting): UiLanguage {
  const lang = resolveUiLanguage(setting, navigator.language)
  document.documentElement.lang = lang
  writeMirror(lang)
  return lang
}

function bind(lang: UiLanguage, applyLanguageSetting: (s: UiLanguageSetting) => void): I18n {
  return {
    lang,
    t: (key, params) => t(lang, key, params),
    tCount: (keyBase, count, params) => tCount(lang, keyBase, count, params),
    applyLanguageSetting
  }
}

// Default value so components render standalone (component tests without the
// provider): a working ENGLISH binding. applyLanguageSetting still maintains
// <html lang> + the mirror, but cannot re-render — only the provider can.
const I18nContext = createContext<I18n>(
  bind('en', (setting) => {
    applyResolved(setting)
  })
)

/** The bound `t`/`tCount` + resolved language + the setting applier. */
export function useT(): I18n {
  return useContext(I18nContext)
}

export function I18nProvider({ children }: { children: ReactNode }): JSX.Element {
  // Initial language = the pre-unlock resolution, so the gate (and the first paint)
  // is already in the right language with zero stored state on a German OS.
  const [lang, setLang] = useState<UiLanguage>(resolvePreUnlockLanguage)

  // Keep <html lang> in step with whatever is rendered (the pre-unlock value too).
  // The mirror is only written on an explicit applyLanguageSetting — a resolved
  // SETTING — never from the pre-unlock guess.
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  // Identity-stable applier (audit FE-5): it only needs the (stable) `setLang`, so a
  // useCallback([]) keeps its reference constant across renders. Consumers that list it in an
  // effect's deps (App.tsx's policy/settings effect) therefore no longer re-fire purely because
  // the UI language changed — the feedback path the previous useMemo([lang]) created.
  const applyLanguageSetting = useCallback(
    (setting: UiLanguageSetting) => setLang(applyResolved(setting)),
    []
  )

  // `value` still re-binds on `lang` so `t`/`tCount` render in the current language; only the
  // applier's identity is pinned.
  const value = useMemo(() => bind(lang, applyLanguageSetting), [lang, applyLanguageSetting])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
