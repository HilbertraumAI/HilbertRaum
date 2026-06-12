import type { en } from './en'

// The GERMAN catalog. Typed against the English source-of-truth catalog, so a missing,
// stale, or extra key is a `npm run typecheck` failure — no partial catalogs, ever
// (i18n-plan §3.1, D-L1).
//
// Style (i18n-plan §3.5, D-L7): informal „du", lowercase „du/dein" mid-sentence,
// consistently — including errors and the gate. The copy ADAPTS the friendly spec-§11.4
// tone rather than translating literally. The product name "Private AI Drive Lite" is
// never translated (D-L4 note); language names in the picker stay untranslated.
//
// Glossary (§3.5) — keep terms consistent across ALL German copy:
//   workspace                  → Arbeitsbereich
//   drive                      → Laufwerk
//   vault / encrypted workspace→ verschlüsselter Arbeitsbereich
//   model                      → Modell (AI model → KI-Modell)
//   document                   → Dokument
//   re-index                   → neu indexieren
//   offline                    → offline
//   "Ask my documents"         → „Meine Dokumente fragen"
//   lock / unlock              → sperren / entsperren
//   password                   → Passwort
//   settings                   → Einstellungen
//   plaintext (developer) mode → unverschlüsselt (Entwickler)

export const de: Record<keyof typeof en, string> = {
  // ---- App shell ----
  'nav.home': 'Start',
  'nav.chat': 'Chat',
  'nav.documents': 'Dokumente',
  'nav.models': 'KI-Modell',
  'nav.settings': 'Einstellungen',
  'app.lockNow': 'Jetzt sperren',
  'app.lockNowTitle': 'Arbeitsbereich wieder verschlüsseln und sperren',
  'app.noticeDetails': 'Details',

  // ---- Home ----
  'home.docsReady.one': '{count} Dokument bereit für deine Fragen',
  'home.docsReady.other': '{count} Dokumente bereit für deine Fragen',

  // ---- Settings ----
  'settings.title': 'Einstellungen',
  'settings.tabsAria': 'Einstellungsbereiche',
  'settings.tab.general': 'Allgemein',
  'settings.tab.privacy': 'Privatsphäre & Daten',
  'settings.tab.diagnostics': 'Diagnose (erweitert)',
  'settings.loading': 'Einstellungen werden geladen…',
  'settings.saved': 'Gespeichert',
  'settings.network.title': 'Privatsphäre & Offline-Modus',
  'settings.network.allow': 'Internetzugriff für Modell-Downloads und Updates erlauben',
  'settings.network.hint':
    'Standardmäßig aus. Solange das aus ist, stellt die App keinerlei Internetverbindung ' +
    'her. Eingeschaltet ermöglicht es nur Modell-Downloads über den KI-Modell-Bereich — ' +
    'jeder Download fragt zuerst nach deiner Bestätigung, und eine Laufwerksrichtlinie ' +
    'kann Downloads ganz deaktiviert lassen. Deine Fragen und Dokumente verlassen dieses ' +
    'Gerät in keinem Fall.',
  'settings.appearance.title': 'Erscheinungsbild',
  'settings.appearance.aria': 'Farbschema',
  'settings.appearance.system': 'System',
  'settings.appearance.light': 'Hell',
  'settings.appearance.dark': 'Dunkel',
  'settings.appearance.hint':
    '„System“ folgt der Hell/Dunkel-Einstellung deines Betriebssystems. Der Sperrbildschirm ' +
    'folgt immer dem System.',
  'settings.language.title': 'Sprache',
  'settings.language.aria': 'Sprache',
  'settings.language.hint':
    '„System“ folgt der Sprache deines Betriebssystems: Deutsche Systeme verwenden Deutsch, ' +
    'alle anderen Englisch. Änderungen gelten sofort.',
  'settings.performance.title': 'Leistung',
  'settings.performance.gpu': 'Grafikbeschleunigung verwenden',
  'settings.performance.gpuHint':
    'Nutzt deine Grafikkarte, um Antworten zu beschleunigen, wenn sie verfügbar ist. ' +
    'Schalte das nur aus, wenn dir Stabilitätsprobleme auffallen — alles funktioniert so ' +
    'oder so weiter.',
  'settings.performance.autoStart':
    'Das ausgewählte Modell beim Start der App automatisch laden',
  'settings.performance.autoStartHint':
    'Standardmäßig an. Das im KI-Modell-Bereich ausgewählte Modell wird beim Start im ' +
    'Hintergrund geladen (bei verschlüsselten Arbeitsbereichen nach dem Entsperren), damit ' +
    'der Chat ohne weitere Klicks bereit ist.',
  'settings.developer.title': 'Entwickler',
  'settings.developer.toggle':
    'Entwicklermodus (erlaubt unverschlüsselten Arbeitsbereich, ungeprüfte Modelle)',
  'settings.developer.hint':
    'Standardmäßig aus. Entwickler-Builds zählen immer als Entwickler. Die ' +
    'Laufwerksrichtlinie hat Vorrang: Auf einem kommerziellen Laufwerk bleiben ungeprüfte ' +
    'Modelle unabhängig von dieser Einstellung abgelehnt.',
  'settings.workspace.title': 'Arbeitsbereich',
  'settings.workspace.mode': 'Modus',
  'settings.workspace.modeEncrypted': 'Verschlüsselt',
  'settings.workspace.modePlaintext': 'Unverschlüsselt (Entwickler)',
  'settings.workspace.contextTokens': 'Kontext-Tokens',
  'settings.workspace.encryptedHint':
    'Dieser Arbeitsbereich ist im gesperrten Zustand verschlüsselt. Mit „Jetzt sperren“ in ' +
    'der Seitenleiste verschlüsselst und sperrst du ihn sofort; beim Beenden sperrt er ' +
    'sich automatisch.',
  'settings.workspace.plaintextHint':
    'Unverschlüsselter Entwickler-Arbeitsbereich — die Daten liegen unverschlüsselt auf dem ' +
    'Laufwerk. Der verschlüsselte Modus ist der Standard der Kaufversion.',
  'settings.changePassword.title': 'Passwort ändern',
  'settings.changePassword.hint':
    'Wähle ein neues Passwort für diesen Arbeitsbereich. Du verwendest es ab dem nächsten ' +
    'Entsperren. Es kann nicht wiederhergestellt oder zurückgesetzt werden — wähle also ' +
    'etwas, das du dir merkst.',
  'settings.changePassword.current': 'Aktuelles Passwort',
  'settings.changePassword.new': 'Neues Passwort',
  'settings.changePassword.confirm': 'Neues Passwort bestätigen',
  'settings.changePassword.busy':
    'Deine Dokumente werden mit dem neuen Passwort gesichert… Bei einer großen Bibliothek ' +
    'kann das ein paar Minuten dauern.',
  'settings.changePassword.failed':
    'Etwas ist schiefgelaufen. Dein aktuelles Passwort funktioniert weiterhin.',
  'settings.changePassword.submit': 'Passwort ändern',
  'settings.changePassword.submitBusy': 'Wird geändert…',
  'settings.changePassword.toast': 'Passwort geändert',

  // ---- Shared password copy ----
  'password.mismatch': 'Die Passwörter stimmen nicht überein.',

  // ---- Workspace gate ----
  'gate.passwordPlaceholder': 'Passwort',
  'gate.unlock.title': 'Entsperre deinen Arbeitsbereich',
  'gate.unlock.hint':
    'Gib dein Passwort ein, um den Arbeitsbereich dieses Laufwerks zu öffnen. Alles bleibt ' +
    'auf diesem Laufwerk.',
  'gate.unlock.submit': 'Entsperren',
  'gate.unlock.submitBusy': 'Wird entsperrt…',
  'gate.welcome.title': 'Willkommen',
  'gate.welcome.intro':
    'Das ist dein privater KI-Arbeitsbereich. Chatte mit einem KI-Modell und stelle Fragen ' +
    'zu deinen Dokumenten — alles läuft von diesem Laufwerk.',
  'gate.welcome.stays': 'Alles bleibt auf diesem Laufwerk.',
  'gate.welcome.staysRest': 'Kein Internet, kein Konto, kein Tracking.',
  'gate.welcome.start': 'Los geht’s',
  'gate.finishing.title': 'Alles wird eingerichtet…',
  'gate.finishing.hint':
    'Wir schauen kurz nach, was schon auf diesem Laufwerk ist. Der erste Blick auf eine ' +
    'große KI-Modell-Datei kann ein paar Minuten dauern.',
  'gate.finishing.skip': 'Überspringen — bring mich zur App',
  'gate.starter.title': 'Eine letzte Sache',
  'gate.starter.noModel':
    'Auf diesem Laufwerk ist noch kein KI-Modell installiert — der Chat braucht eines zum ' +
    'Antworten. Du kannst jetzt eines hinzufügen oder jederzeit später über den ' +
    'KI-Modell-Bereich.',
  'gate.starter.optional':
    'Ein Modell herunterzuladen ist optional und fragt immer zuerst nach deiner ' +
    'Bestätigung. Deine Dokumente und Chats nutzen das Internet so oder so nie.',
  'gate.starter.skip': 'Vorerst überspringen',
  'gate.starter.addDocuments': 'Dokumente hinzufügen',
  'gate.starter.chooseModel': 'Wähle dein KI-Modell',
  'gate.create.title': 'Erstelle dein Passwort',
  'gate.create.hint':
    'Dieses Passwort schützt alles in deinem Arbeitsbereich — Dokumente, Chats und ' +
    'Notizen — auf diesem Laufwerk. Es kann nicht wiederhergestellt oder zurückgesetzt ' +
    'werden — wähle also etwas, das du dir merkst.',
  'gate.create.plaintextToggle':
    'Unverschlüsselten Entwickler-Arbeitsbereich verwenden (keine Verschlüsselung)',
  'gate.create.plaintextWarning':
    'Der unverschlüsselte Modus speichert deine Daten ohne Verschlüsselung auf diesem ' +
    'Laufwerk. Verwende ihn nur für die Entwicklung.',
  'gate.create.confirmPlaceholder': 'Passwort bestätigen',
  'gate.create.back': 'Zurück',
  'gate.create.submit': 'Arbeitsbereich erstellen',
  'gate.create.submitBusy': 'Wird erstellt…',
  'gate.error.generic': 'Etwas ist schiefgelaufen. Bitte versuch es noch einmal.',

  // ---- Main-process emissions ----
  'main.workspace.wrongPassword':
    'Dieses Passwort hat deinen Arbeitsbereich nicht entsperrt. Prüf es und versuch es ' +
    'noch einmal.'
}
