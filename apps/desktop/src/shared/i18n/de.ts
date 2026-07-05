import type { en } from './en'

// The GERMAN catalog. Typed against the English source-of-truth catalog, so a missing,
// stale, or extra key is a `npm run typecheck` failure — no partial catalogs, ever
// (i18n record §3.1, D-L1).
//
// Style (i18n record §3.5, D-L7): informal „du", lowercase „du/dein" mid-sentence,
// consistently — including errors and the gate. The copy ADAPTS the friendly spec-§11.4
// tone rather than translating literally. The product name "HilbertRaum" is
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
  'nav.aria': 'Hauptnavigation',
  'nav.home': 'Start',
  'nav.chat': 'Chat',
  // Soft hyphens (U+00AD) give the narrow nav rail clean break points ("Doku-/mente",
  // "Einstel-/lungen") — Electron ships no auto-hyphenation; invisible when the word fits
  // and in the button tooltip. "KI-Modell" already breaks at its real hyphen.
  'nav.documents': 'Dokumente',
  'nav.images': 'Bilder',
  'nav.models': 'KI-Modell',
  'nav.skills': 'Skills',
  'nav.settings': 'Einstellungen',
  'app.lockNow': 'Jetzt sperren',
  'app.lockNowTitle': 'Arbeitsbereich wieder verschlüsseln und sperren',
  'app.noticeDetails': 'Details',
  'app.fatal.title': 'Die App konnte nicht starten',
  'app.fatal.hintBefore':
    'Das lokale Backend ist nicht gestartet, daher kann nichts geladen werden. Starte die ' +
    'App neu; wenn das öfter passiert, prüf ',
  'app.fatal.hintAfter': ' auf deinem Laufwerk und sieh in docs/troubleshooting.md nach.',
  'app.loadingWorkspace': 'Arbeitsbereich wird geladen…',

  // ---- Error boundary (ErrorBoundary.tsx — audit FE-1) ----
  'errorBoundary.title': 'Auf diesem Bildschirm ist etwas schiefgelaufen',
  'errorBoundary.body':
    'Dieser Bildschirm ist auf ein unerwartetes Problem gestoßen. Deine Arbeit und deine Daten ' +
    'sind sicher — es ist nichts verloren gegangen. Versuch es noch einmal oder geh zurück zum Start.',
  'errorBoundary.retry': 'Noch einmal versuchen',
  'errorBoundary.home': 'Zum Start',
  'errorBoundary.app.title': 'Die App ist auf ein Problem gestoßen',
  'errorBoundary.app.body':
    'Etwas Unerwartetes ist passiert. Deine Daten auf dem Laufwerk sind sicher. Lade neu, um ' +
    'fortzufahren.',
  'errorBoundary.app.reload': 'Neu laden',

  // ---- Home ----
  'home.headline.ready': 'Bereit zum Chatten.',
  'home.headline.starting': 'Gleich bereit…',
  'home.headline.almost': 'Fast fertig eingerichtet.',
  'home.lead':
    'Ein privater KI-Arbeitsbereich, komplett offline. Deine Fragen, Dokumente und ' +
    'Chat-Verläufe bleiben auf diesem Gerät.',
  // {folder} ist der wörtliche Ordnername auf dem Laufwerk (nicht übersetzt); die UI hebt ihn fett hervor.
  'home.preflight.continue':
    'Du kannst trotzdem fortfahren. Wenn sich die App nicht öffnet, findest du die ' +
    'Anleitung zur Fehlerbehebung im Ordner {folder} auf dem Laufwerk.',
  'home.checking': 'Wird geprüft…',
  'home.workspace.label': 'Arbeitsbereich',
  'home.workspace.encrypted':
    'Verschlüsselt — bei geschlossener App mit deinem Passwort gesperrt',
  'home.workspace.plaintext': 'Unverschlüsselt (Entwicklermodus)',
  'home.workspace.badgeProtected': 'Geschützt',
  'home.workspace.badgeDeveloper': 'Entwickler',
  'home.model.label': 'KI-Modell',
  'home.model.fallbackName': 'Dein Modell',
  'home.model.running': '{model} läuft auf diesem Gerät',
  'home.model.selected': '{model} ist ausgewählt — es wird möglicherweise noch geladen',
  'home.model.none': 'Noch kein Modell ausgewählt',
  'home.model.badgeRunning': 'Läuft',
  'home.model.badgeStarting': 'Startet',
  'home.model.badgeNeedsModel': 'Braucht ein Modell',
  'home.model.open': 'KI-Modell öffnen',
  'home.model.choose': 'Modell auswählen',
  'home.docs.label': 'Dokumente',
  'home.docs.none': 'Noch keine Dokumente — füge welche hinzu, um Fragen dazu zu stellen',
  'home.docsReady.one': '{count} Dokument bereit für deine Fragen',
  'home.docsReady.other': '{count} Dokumente bereit für deine Fragen',
  'home.docs.badgeReady': 'Bereit',
  'home.docs.badgeNone': 'Noch keine',
  'home.docs.add': 'Dokumente hinzufügen',
  'home.actions.startChat': 'Chat starten',
  'home.actions.askDocs': 'Meine Dokumente fragen',

  // ---- Chat ----
  'chat.title': 'Chat',
  'chat.noModel.title': 'Es läuft gerade kein Modell',
  'chat.noModel.hintBefore':
    'Chat und Dokument-Fragen brauchen ein geladenes Modell. Öffne den KI-Modell-Bereich, ' +
    'wähle ein Modell und wähle dann ',
  'chat.noModel.hintAction': 'Modell starten',
  'chat.noModel.hintAfter':
    '. Alles bleibt lokal — nichts wird heruntergeladen oder irgendwohin gesendet.',
  'chat.noModel.stillLoading':
    'Wenn du die App gerade erst geöffnet hast, wird dein ausgewähltes Modell ' +
    'möglicherweise noch geladen — es geht hier automatisch weiter, sobald es bereit ist.',
  'chat.noModel.starting':
    'Dein Modell wird gestartet — große Modelle brauchen einen Moment zum Laden. Es geht ' +
    'hier automatisch weiter, sobald es bereit ist.',
  'chat.noModel.open': 'KI-Modell öffnen',
  'chat.noModel.recheck': 'Erneut prüfen',
  'chat.empty.title': 'Stell eine Frage — oder frag deine Dokumente.',
  'chat.empty.lineDocuments': 'Antworten kommen aus deinen Dokumenten und nennen ihre Quellen.',
  'chat.empty.lineChat':
    'Antworten kommen vom Modell auf diesem Laufwerk — nichts verlässt es.',
  'chat.empty.fillTitle': 'Text ins Eingabefeld übernehmen',
  'chat.empty.addDocs': 'Dokumente hinzufügen, um Fragen dazu zu stellen',
  // Zwei Beispielsätze: der reine Chat hat keine Dokumente, daher allgemeine Fragen;
  // der Modus „Meine Dokumente fragen“ behält dokumentbezogene Beispiele. ChatScreen wählt je Modus.
  'chat.exampleChat.explain': 'Erkläre ein Konzept einfach',
  'chat.exampleChat.draftEmail': 'Hilf mir, eine höfliche E-Mail zu schreiben',
  'chat.exampleChat.brainstorm': 'Sammle Ideen für ein Projekt',
  'chat.example.summarize': 'Fasse dieses Dokument zusammen',
  'chat.example.paymentTerms': 'Welche Zahlungsbedingungen gelten?',
  'chat.example.indemnity': 'Finde jede Erwähnung von „Haftungsfreistellung“',
  'chat.modeAria': 'Chat-Modus',
  'chat.mode.chat': 'Chat',
  'chat.mode.documents': 'Meine Dokumente fragen',
  'chat.listShow': 'Unterhaltungsliste einblenden',
  'chat.convOptions': 'Optionen der Unterhaltung',
  'chat.saveConversation': 'Diese Unterhaltung speichern',
  'chat.savedTo': 'Gespeichert unter {path}',
  'chat.copied': 'Kopiert',
  'chat.stopped': 'Gestoppt – die Antwort ist möglicherweise unvollständig',
  'chat.scopeNotice': 'Antwort nur aus {titles}',
  'chat.cancelDocTask': 'Dokumentaufgabe abbrechen',
  'chat.placeholder.documents': 'Frag deine Dokumente…',
  'chat.placeholder.chat': 'Nachricht…',
  'chat.send.ask': 'Fragen',
  'chat.send.send': 'Senden',
  'chat.composer.stop': 'Stopp',

  // ---- Chat: conversation list ----
  'chat.list.title': 'Unterhaltungen',
  'chat.list.aria': 'Unterhaltungsverlauf',
  'chat.list.newChat': '+ Neuer Chat',
  'chat.list.newDocQa': '+ Neues Dokument-Q&A',
  'chat.list.hide': 'Unterhaltungsliste ausblenden',
  'chat.list.empty': 'Noch keine Unterhaltungen.',
  'chat.list.docMeta': 'Dokumente',
  'chat.list.otherGroup': 'Sonstige / Bibliothek',
  'chat.list.rowOptionsAria': 'Optionen für Unterhaltung „{title}“',
  'chat.search.placeholder': 'Unterhaltungen durchsuchen…',
  'chat.search.aria': 'Unterhaltungen durchsuchen',
  'chat.search.resultsAria': 'Suchergebnisse',
  'chat.search.resultsFor': 'Ergebnisse für „{query}“',
  'chat.search.noMatches': 'Ich habe nichts gefunden. Formulier es anders.',
  'chat.search.count.one': '{count} Treffer',
  'chat.search.count.other': '{count} Treffer',
  'chat.group.today': 'Heute',
  'chat.group.yesterday': 'Gestern',
  'chat.group.last7days': 'Letzte 7 Tage',
  'chat.group.earlier': 'Früher',
  'chat.delete.menuItem': 'Unterhaltung löschen',
  'chat.delete.title': 'Diese Unterhaltung löschen?',
  'chat.delete.confirm': 'Löschen',
  'chat.delete.body':
    '„{title}“ und die zugehörigen Nachrichten werden dauerhaft von diesem Laufwerk entfernt.',

  // ---- Chat: answer depth ----
  'chat.depth.trigger': 'Antwortdetail: {label}',
  'chat.depth.fast': 'Schnell',
  'chat.depth.balanced': 'Ausgewogen',
  'chat.depth.deep': 'Gründlich',
  'chat.depth.fastHint': 'Kurze Antworten auf den Punkt',
  'chat.depth.balancedHint': 'Der Standard für den Alltag',
  'chat.depth.deepHint': 'Denkt das Problem vor dem Antworten durch — dauert länger',

  // ---- Chat: skill picker + per-message glyph (skills plan §10/§15) ----
  'chat.skill.trigger': 'Skill: {label}',
  'chat.skill.none': 'Kein Skill',
  'chat.skill.suggested': 'Vorschlag: {title} – nutzen?',
  'chat.skill.suggestedHint': 'Vorschlag: {title}',
  'chat.skill.used': 'Skill: {title}',
  'chat.skill.usedTitle': 'Diese Antwort wurde vom Skill „{title}“ geprägt.',
  // S13c (D3) – eine automatisch angewandte Antwort: sichtbar („Beantwortet mit …“) + umkehrbar
  // (ein Klick beantwortet dieselbe Frage ohne den Skill neu). Nie eine stille Überraschung.
  'chat.skill.autoFired': 'Beantwortet mit {title}',
  'chat.skill.autoFiredTitle':
    'Die App hat den Skill „{title}“ automatisch auf diese Antwort angewandt. Du kannst ohne ihn antworten.',
  'chat.skill.answerWithout': 'Ohne ihn antworten',
  // SKA-38 (Skills-Audit 2026-07-03, U6): das Glyph-Label, wenn der Skill einer markierten Antwort
  // später GELÖSCHT wurde – die Herkunft (und der Rückgängig-Weg) bleiben, ehrlich beschriftet.
  'chat.skill.removed': '(entfernter Skill)',
  // U3 (audit §4.3): ein Skill gilt jetzt standardmäßig PRO TURN – das × am Chip verwirft die Wahl und
  // eine gespeicherte Vorgabe, die Checkbox im Menü ist die ausdrückliche Zustimmung, die Wahl als
  // Vorgabe des Gesprächs zu behalten. Nichts bleibt still über Turns hinweg gesetzt.
  'chat.skill.clear': 'Skill {title} entfernen',
  'chat.skill.keep': 'Für dieses Gespräch behalten',
  // Tier-2-Tool-Lauf – die ruhige Aktion im Verlauf + Statuszeile + Bestätigungsdialog (skills plan §12.2/§15, S11b)
  'chat.skill.tool.extractTransactions': 'Transaktionen extrahieren',
  'chat.skill.tool.validateBalances': 'Salden prüfen',
  'chat.skill.tool.categorize': 'Kategorisieren',
  'chat.skill.tool.summarize': 'Geldfluss zusammenfassen',
  'chat.skill.tool.exportCsv': 'Als CSV exportieren',
  'chat.skill.tool.extractInvoice': 'Rechnung einlesen',
  'chat.skill.tool.validateInvoiceTotals': 'Beträge prüfen',
  'chat.skill.tool.exportInvoiceCsv': 'Als CSV exportieren',
  'chat.skill.tool.exportInvoiceJson': 'Als JSON exportieren',
  'chat.skill.tool.exportInvoiceXml': 'Als XML exportieren',
  'chat.skill.tool.redactDocument': 'Personenbezogene Daten schwärzen',
  // Die nach einem Kategorisieren-Lauf in den Verlauf eingespielte Aufschlüsselungsfrage (Phase 33, Q3).
  'chat.skill.categorize.breakdownQuestion': 'Schlüssle meine Ausgaben nach Kategorie auf.',
  // Die nach einem „Geldfluss zusammenfassen“-Lauf eingespielte Frage — analyse-, aber nicht
  // kategorieförmig, damit der Bankanalyse-Handler die Ein-/Ausgaben-Summen (nicht die Kategorie-
  // Aufschlüsselung) liefert. Die Zahlen bleiben im Hauptprozess; der Lauf-Status trägt keine Beträge.
  'chat.skill.summarize.question': 'Fasse meine Einnahmen und Ausgaben zusammen.',
  'chat.skill.run.running.one': 'Läuft: {tool} für {count} Dokument…',
  'chat.skill.run.running.other': 'Läuft: {tool} für {count} Dokumente…',
  // U-1: Statuszeile mit dem Zieldokument (`{document}` löst der Renderer aus seiner eigenen
  // Dokumentliste auf – der Titel verlässt nie den IPC-Zustand). Fällt sonst auf die Zählform zurück.
  'chat.skill.run.runningOn': 'Läuft: {tool} für {document}…',
  // U-1: die Zieldokument-Auswahl der Lauf-Leiste (Bereich mit >1 Dokument) + die Ein-Dokument-Anzeige.
  'chat.skill.run.chooseDocument': 'Zieldokument auswählen',
  'chat.skill.run.thisDocument': 'dieses Dokument',
  'chat.skill.run.cancel': 'Abbrechen',
  'chat.skill.run.done.one': '{count} Transaktion extrahiert.',
  'chat.skill.run.done.other': '{count} Transaktionen extrahiert.',
  'chat.skill.run.done.categorize.one': '{count} Transaktion kategorisiert.',
  'chat.skill.run.done.categorize.other': '{count} Transaktionen kategorisiert.',
  'chat.skill.run.done.summarize.one': '{count} Transaktion zusammengefasst.',
  'chat.skill.run.done.summarize.other': '{count} Transaktionen zusammengefasst.',
  'chat.skill.run.done.export.one': '{count} Zeile gespeichert.',
  'chat.skill.run.done.export.other': '{count} Zeilen gespeichert.',
  'chat.skill.run.done.reconciled': 'Die Salden stimmen überein.',
  'chat.skill.run.done.unreconciled.one':
    '{count} Zeile stimmt nicht überein – prüfe sie, bevor du dich darauf verlässt.',
  'chat.skill.run.done.unreconciled.other':
    '{count} Zeilen stimmen nicht überein – prüfe sie, bevor du dich darauf verlässt.',
  'chat.skill.run.done.unchecked': 'Es war kein laufender Saldo zum Abgleichen abgedruckt.',
  'chat.skill.run.done.extractInvoice.one': '{count} Position extrahiert.',
  'chat.skill.run.done.extractInvoice.other': '{count} Positionen extrahiert.',
  'chat.skill.run.done.invoiceReconciled': 'Die Rechnungsbeträge stimmen überein.',
  'chat.skill.run.done.invoiceUnreconciled.one':
    '{count} Betrag stimmt nicht überein – prüfe ihn, bevor du dich darauf verlässt.',
  'chat.skill.run.done.invoiceUnreconciled.other':
    '{count} Beträge stimmen nicht überein – prüfe sie, bevor du dich darauf verlässt.',
  'chat.skill.run.done.invoiceUnchecked': 'Es waren keine Beträge zum Abgleichen abgedruckt.',
  'chat.skill.run.done.redacted.one':
    'Geschwärzte Kopie gespeichert – {count} Eintrag verborgen. Prüfe sie, bevor du sie weitergibst.',
  'chat.skill.run.done.redacted.other':
    'Geschwärzte Kopie gespeichert – {count} Einträge verborgen. Prüfe sie, bevor du sie weitergibst.',
  'chat.skill.run.done.redactedClean':
    'Keine personenbezogenen Daten erkannt; Kopie gespeichert. Prüfe sie, bevor du sie weitergibst.',
  'chat.skill.run.failedGeneric': 'Das hat nicht geklappt. Es wurde nichts geändert.',
  'chat.skill.run.error.unavailable': 'Dieses Werkzeug ist nicht verfügbar.',
  'chat.skill.run.error.needsExtraction': 'Lies das Dokument zuerst mit der Schaltfläche „{button}“ ein, dann führe dieses Werkzeug aus.',
  'chat.skill.run.error.persistFailed': 'Das konnte nicht gespeichert werden. Es wurde nichts geändert.',
  'chat.skill.run.error.exportWriteFailed': 'Die Datei konnte nicht gespeichert werden. Es wurde nichts geändert.',
  'chat.skill.run.cancelled': 'Gestoppt. Es wurde nichts gespeichert.',
  // SKA-40 (Skills-Audit 2026-07-03, U6): der Status ließ sich nach mehreren Fehlern nicht mehr prüfen –
  // eine beschriftete, schließbare Zeile statt einer still verschwundenen Ausführung.
  'chat.skill.run.stateUnknown': 'Diese Funktion ließ sich nicht prüfen – das Ergebnis ist evtl. unvollständig.',
  // SKA-6: ein ruhiger Hinweis, wenn eine Funktion gerade in einem ANDEREN Chat arbeitet (sie läuft
  // dort weiter und wird dort angezeigt; hier nur ein unaufdringlicher Präsenzhinweis). Inhaltsfrei.
  'chat.skill.run.otherChatBusy': 'Eine Funktion arbeitet gerade in einem anderen Chat.',
  // U-2: die Ein-Klick-Folgeaktion in der Ergebniszeile nach dem Extrahieren. Die KI-Kategorisierung
  // wird hier vom Nutzer ausgelöst, nicht still im Hintergrund. Inhaltsfrei (benennt eine Aktion).
  'chat.skill.run.categorizeOffer': 'Transaktionen kategorisieren',
  'chat.skill.run.dismiss': 'Schließen',
  'chat.skill.confirm.title': 'Dieses Tool ausführen?',
  'chat.skill.confirm.body': 'Dabei wird aus den Dokumenten auf diesem Laufwerk eine Datei erstellt oder exportiert.',
  'chat.skill.confirm.ok': 'Ausführen',

  // ---- Chat: transcript + message actions ----
  'chat.role.user': 'Du',
  'chat.role.assistant': 'HilbertRaum',
  'chat.thinking': 'Denkt nach…',
  'chat.actions.tryAgain': 'Noch einmal',
  'chat.actions.copy': 'Kopieren',
  'chat.actions.save': 'Speichern',
  'chat.actions.saveTitle': 'Diese Unterhaltung als Datei speichern (bleibt lokal)',

  // ---- Chat: Kontext-Komprimierung (context-compaction plan §5.1–§5.3) ----
  'chat.compaction.inProgress': 'Frühere Nachrichten werden zusammengefasst, um Platz zu schaffen…',
  // U5 (Audit §3.6): das Pendant für einen erschöpfenden Skill-Handler, der vor seiner
  // (deterministischen) Antwort das ganze Dokument liest — damit die Wartezeit nicht wie ein Hänger wirkt.
  'chat.analysis.inProgress': 'Das ganze Dokument wird gelesen…',
  'chat.compaction.markerLabel': 'Frühere Nachrichten zusammengefasst',
  'chat.compaction.viewSummary': 'Zusammenfassung der früheren Nachrichten anzeigen',
  'chat.context.usageTooltip': 'Kontext: {used} / {window} Tokens (ungefähr)',
  'chat.context.willSummarize': 'Ältere Nachrichten werden zusammengefasst, um Platz zu schaffen.',
  // Ehrliches Signal (§L0): erscheint bei einer Antwort, die das Modell am Kontextlimit abgeschnitten hat.
  'chat.truncated.label': 'Antwort abgeschnitten – Kontextlimit des Modells erreicht',
  'chat.truncated.hint':
    'Dem Modell ging der Platz aus, um diese Antwort zu beenden. Bitte es fortzufahren, beginne einen neuen Chat oder erhöhe die Kontextgröße im Bereich „KI-Modell“.',

  // ---- Chat: document scope ----
  'chat.scope.usingAll': 'Nutzt alle Dokumente',
  'chat.scope.usingSome.one': 'Nutzt {count} Dokument',
  'chat.scope.usingSome.other': 'Nutzt {count} Dokumente',
  'chat.scope.none': 'Noch keine Dokumente · Dokumente hinzufügen',
  'chat.scope.popoverAria': 'Zu befragende Dokumente',
  'chat.scope.allLine':
    'Antworten kommen aus all deinen Dokumenten. Wähle Dokumente aus, um nur diese zu fragen:',
  'chat.scope.someLine': 'Antworten kommen nur aus diesen Dokumenten:',
  'chat.scope.addLine': 'Dokument hinzufügen:',
  'chat.scope.stopAsking': '{title} nicht mehr fragen',
  'chat.scope.askToo': '{title} auch fragen',
  'chat.scope.useAll': 'Alle Dokumente verwenden',
  'chat.scope.removedDoc': 'Entferntes Dokument',

  // ---- Chat: sources ----
  'chat.sources.toggle': 'Quellen ({count})',
  'chat.sources.page': 'Seite {page}',
  // Ganz-Dokument-Provenienz (Phase 5, FE-B / F11): die „Quellen“ einer Baum-/Kapp-/
  // Extrakt-Antwort sind die genutzten Dokument-Abschnitte (Herkunft), keine 1:1 zitierten
  // Auszüge. Bewusst breitenneutral — die Abdeckungsanzeige daneben sagt „ganzes Dokument“ /
  // „Anfang“ / „teilweise“.
  'chat.sources.wholeDoc': 'Aus dem Dokument entnommen — {count} Abschnitte',
  'chat.sources.wholeDocCaption': 'Abgedeckte Abschnitte',
  'chat.sources.more': 'und {count} weitere Abschnitte',

  // ---- Chat: dictation ----
  'chat.dictation.start': 'Nachricht diktieren',
  'chat.dictation.stop': 'Diktat beenden und Text einfügen',
  'chat.dictation.transcribing': 'Deine Sprache wird in Text umgewandelt',
  'chat.dictation.noSpeech': 'Es wurde keine Sprache erkannt — versuch es noch einmal.',
  'chat.dictation.micBlocked':
    'Das Mikrofon konnte nicht verwendet werden. Prüf die Mikrofon-Einstellungen deines ' +
    'Systems und versuch es dann noch einmal.',

  // ---- Documents ----
  'docs.title': 'Dokumente',
  'docs.lead':
    'Importiere Dokumente, um Fragen dazu zu stellen. Jede Datei wird in deinen ' +
    'Arbeitsbereich kopiert und für die Suche vorbereitet — alles bleibt auf diesem ' +
    'Laufwerk. Frag über den Modus „Meine Dokumente fragen“ im Chat.',
  'docs.status.queued': 'Wartet',
  'docs.status.extracting': 'Liest',
  'docs.status.preparing': 'Bereitet vor',
  'docs.status.indexed': 'Bereit',
  'docs.status.failed': 'Fehlgeschlagen',
  'docs.status.deleted': 'Gelöscht',
  'docs.status.transcribing': 'Transkribiert…',
  'docs.task.summaryBusy': 'Fasst zusammen…',
  'docs.task.translationBusy': 'Übersetzt…',
  'docs.task.compareBusy': 'Vergleicht…',
  'docs.task.ocrBusy': 'Liest den Scan…',
  'docs.task.treeBusy': 'Erstellt einen Tiefenindex…',
  'docs.task.extractBusy': 'Sucht nach Details…',
  'docs.task.summaryBusyTitle': 'Die Zusammenfassung wird geschrieben',
  'docs.task.translationBusyTitle': 'Die Übersetzung wird geschrieben',
  'docs.task.compareBusyTitle': 'Der Vergleich wird geschrieben',
  'docs.task.ocrBusyTitle': 'Die gescannten Seiten werden gelesen',
  'docs.task.treeBusyTitle': 'Für das ganze Dokument wird ein Tiefenindex erstellt',
  'docs.task.extractBusyTitle':
    'Das ganze Dokument wird durchsucht, damit es „Liste alle…"-Fragen beantworten kann',
  'docs.task.categorizeBusy': 'Kategorisiert Umsätze…',
  'docs.task.categorizeBusyTitle': 'Die Umsätze des Kontoauszugs werden kategorisiert',
  'docs.error.noSupported': 'In dieser Auswahl wurden keine unterstützten Dokumente gefunden.',
  'docs.removedDocFallback': 'einem entfernten Dokument',
  'docs.provenance.compareBefore': 'Vergleich von ',
  'docs.provenance.compareMiddle': ' und ',
  'docs.provenance.translatedBefore': 'Übersetzt aus ',
  // German provenance copy reviewed in the D-L7 pass (2026-06-14).
  'docs.provenance.summaryBefore': 'Zusammenfassung von ',
  'docs.provenance.generatedBefore': 'Erzeugt aus ',
  'docs.import.busy': 'Wird importiert…',
  'docs.import.files': 'Dateien importieren',
  'docs.import.folder': 'Ordner importieren',
  'docs.refresh': 'Aktualisieren',
  'docs.askSelected': 'Diese Dokumente fragen ({count})',
  'docs.askSelectedTitle': 'Ein Dokument-Q&A nur mit den ausgewählten Dokumenten öffnen',
  'docs.compareBtn': 'Vergleichen (2)',
  'docs.compareBtnTitle':
    'Einen Vergleich der beiden ausgewählten Dokumente mit dem lokalen Modell schreiben — ' +
    'nichts verlässt dieses Laufwerk',
  'docs.reindexAll': 'Alle neu indexieren ({count})',
  'docs.reindexAllTitle':
    'Jedes Dokument neu indexieren, das mit einem anderen Suchmodell indexiert wurde',
  'docs.reindexAllConfirm.title': '{count} Dokumente neu indexieren?',
  'docs.reindexAllConfirm.body':
    'Dabei wird jedes veraltete Dokument nacheinander neu eingelesen und neu eingebettet. ' +
    'Das kann mehrere Minuten dauern und beansprucht den Prozessor stark – du kannst ' +
    'weiterarbeiten, aber Antworten sind bis zum Abschluss möglicherweise langsamer.',
  'docs.reindexAllConfirm.confirm': 'Alle neu indexieren',
  'docs.reindexAllProgress': 'Indexiere {done} von {total} neu…',
  'docs.supported.base':
    'Unterstützt: TXT, Markdown, PDF, DOCX, CSV — Audioaufnahmen (WAV, MP3, FLAC, OGG), ' +
    'die auf diesem Laufwerk transkribiert werden',
  'docs.supported.ocrExtra':
    ' sowie Fotos von Seiten (PNG, JPG), die auf diesem Laufwerk gelesen werden',
  'docs.preparing': 'Deine Dokumente werden vorbereitet, damit du Fragen dazu stellen kannst…',
  'docs.empty.title': 'Noch keine Dokumente',
  'docs.empty.line':
    'Importiere Dateien, um Fragen dazu zu stellen — alles bleibt auf diesem Laufwerk.',
  'docs.selectAria': '{title} zum Fragen auswählen',
  'docs.selectTitle': 'Auswählen, um nur ausgewählte Dokumente zu fragen',
  'docs.meta.size': 'Größe',
  'docs.meta.sections': 'Abschnitte',
  'docs.meta.sectionsCount.one': '{count} Abschnitt',
  'docs.meta.sectionsCount.other': '{count} Abschnitte',
  'docs.meta.type': 'Typ',
  'docs.meta.summary': 'Zusammenfassung',
  'docs.scan.ocrOffer':
    'Nutze unten „Durchsuchbar machen (OCR)“, um die Seiten auf diesem Laufwerk zu lesen.',
  'docs.scan.ocrMissing':
    'Zum Durchsuchbar-Machen fehlen die OCR-Dateien auf diesem Laufwerk.',
  'docs.stale.banner':
    'Dieses Dokument wurde mit einem anderen Suchmodell vorbereitet — indexiere es neu, ' +
    'damit Antworten es finden können.',
  'docs.preview': 'Vorschau',
  'docs.previewBusy': 'Wird geöffnet…',
  'docs.previewTitle': 'Den extrahierten Text lesen (nur Ansicht; nichts verlässt die App)',
  'docs.cancel': 'Abbrechen',
  'docs.cancelOcrTitle': 'Das Lesen des Scans stoppen',
  'docs.cancelTaskTitle': 'Die Aufgabe stoppen',
  'docs.makeSearchable': 'Durchsuchbar machen (OCR)',
  'docs.makeSearchableTitle':
    'Die gescannten Seiten mit lokaler Texterkennung lesen — nichts verlässt dieses Laufwerk',
  'docs.summarize': 'Zusammenfassen',
  'docs.summarizeAgain': 'Erneut zusammenfassen',
  'docs.summarizeTitle':
    'Eine Zusammenfassung mit dem lokalen Modell schreiben — nichts verlässt dieses Laufwerk',
  'docs.translate': 'Übersetzen',
  'docs.translateTitle': 'Mit dem lokalen Modell übersetzen — nichts verlässt dieses Laufwerk',
  'docs.export': 'Exportieren',
  'docs.exportTitle': 'Dieses Dokument als Markdown-Datei speichern',
  'docs.reindex': 'Neu indexieren',
  'docs.reindexBusy': 'Wird neu indexiert…',
  'docs.reindexTitle': 'Die gespeicherte Kopie erneut lesen und vorbereiten',
  'docs.delete': 'Löschen',
  // Aktionen für eine fehlgeschlagene Zeile (§11.6): kein Vorschau-Knopf (es gibt keinen Text),
  // sondern Entfernen und — nur wenn ein erneuter Versuch helfen kann — „Erneut versuchen".
  'docs.failed.remove': 'Entfernen',
  'docs.failed.removeTitle': 'Diesen fehlgeschlagenen Import aus der Liste entfernen',
  'docs.failed.retry': 'Erneut versuchen',
  'docs.failed.retryTitle': 'Diese Datei noch einmal einlesen und vorbereiten',
  'docs.moreActions': 'Weitere Aktionen für {title}',
  'docs.audioConfirm.title': 'Große Audiodateien importieren?',
  'docs.audioConfirm.confirm': 'Importieren und transkribieren',
  'docs.audioConfirm.contains.one': 'Diese Auswahl enthält {count} Audioaufnahme ({size}).',
  'docs.audioConfirm.contains.other': 'Diese Auswahl enthält {count} Audioaufnahmen ({size}).',
  'docs.audioConfirm.body':
    'Jede Aufnahme wird in deinen Arbeitsbereich kopiert und auf diesem Laufwerk ' +
    'transkribiert — eine lange Aufnahme kann eine Weile dauern. Du kannst die App ' +
    'währenddessen weiter verwenden.',
  'docs.deleteConfirm.title': '„{title}“ löschen?',
  'docs.deleteConfirm.body':
    'Das entfernt das Dokument, seinen extrahierten Text und seinen Suchindex dauerhaft ' +
    'aus deinem Arbeitsbereich. Die Originaldatei außerhalb des Arbeitsbereichs bleibt ' +
    'unberührt.',
  'docs.translateModal.title': '„{title}“ übersetzen',
  'docs.translateModal.aria': '{title} übersetzen',
  'docs.translateModal.hint':
    'Das lokale Modell schreibt eine übersetzte Kopie als neues Dokument — durchsuchbar ' +
    'und befragbar wie jeder Import, und nichts verlässt dieses Laufwerk. Maschinelle ' +
    'Übersetzungen können Fehler enthalten.',
  'docs.translateModal.toGerman': 'Ins Deutsche',
  'docs.translateModal.toEnglish': 'Ins Englische',
  'docs.previewModal.aria': 'Vorschau von {title}',
  'docs.previewModal.hint':
    'Extrahierter Text (nur Ansicht) — darauf basieren Dokumentsuche und Antworten.',
  'docs.previewModal.ocrInfo.one':
    'Auf diesem Laufwerk erkannter Text (OCR) — {count} Seite. Die Erkennung kann Fehler ' +
    'enthalten.',
  'docs.previewModal.ocrInfo.other':
    'Auf diesem Laufwerk erkannter Text (OCR) — {count} Seiten. Die Erkennung kann Fehler ' +
    'enthalten.',
  'docs.previewModal.summary': 'Zusammenfassung',
  'docs.previewModal.generatedBy': 'Erstellt von {model}',
  'docs.previewModal.truncated':
    'Dieses Dokument ist lang — die Zusammenfassung deckt den Anfang ab. Der Rest bleibt ' +
    'durchsuchbar und im Chat befragbar.',
  'docs.previewModal.regenerate': 'Neu erstellen',
  'docs.previewModal.copy': 'Kopieren',
  'docs.previewModal.save': 'Speichern',
  'docs.previewModal.copied': 'Zusammenfassung kopiert',
  'docs.previewModal.copyFailed': 'Kopieren in die Zwischenablage nicht möglich',
  'docs.previewModal.savedTo': 'Zusammenfassung gespeichert unter {path}',
  'docs.previewModal.noText': 'Aus diesem Dokument konnte kein Text extrahiert werden.',
  'docs.previewModal.documentText': 'Dokumenttext',
  'docs.previewModal.page': 'Seite {page}',
  'docs.previewModal.showMore': 'Mehr anzeigen',
  'docs.previewModal.loadingMore': 'Wird geladen…',
  'docs.previewModal.segmentProgress': '{shown} von {total} werden angezeigt',

  // ---- Tiefenindex + Abdeckung (whole-document-analysis plan §5.2) — D-L7-Review ausstehend ----
  'docs.deepIndex.build': 'Tiefenindex erstellen',
  'docs.deepIndex.buildTitle':
    'Liest das ganze Dokument in einen Tiefenindex ein, damit Zusammenfassungen und ' +
    'Antworten alles abdecken können — läuft auf diesem Laufwerk, nichts verlässt es',
  'docs.deepIndex.reindexFirst': 'Für Tiefenindex neu indexieren',
  'docs.deepIndex.reindexFirstTitle':
    'Dieses Dokument wurde hinzugefügt, bevor es Tiefenindexe gab — indexiere es zuerst neu, ' +
    'damit ein Tiefenindex das ganze Dokument abdecken kann',
  'docs.deepIndex.ready': 'Tief indexiert',
  'docs.deepIndex.readyTitle':
    'Ein Tiefenindex für das ganze Dokument ist fertig — Zusammenfassungen können alles abdecken',
  'coverage.relevance': 'Basiert auf den relevantesten Passagen — nicht auf dem ganzen Dokument',
  'coverage.capped.whole': 'Deckt das ganze Dokument ab',
  'coverage.capped.beginning': 'Deckt den Anfang des Dokuments ab',
  'coverage.tree.whole': 'Deckt das ganze Dokument ab (tief indexiert)',
  'coverage.tree.beginning': 'Deckt den Anfang des Dokuments ab — es war zu groß, um es vollständig zu lesen',
  'coverage.tree.partial': 'Tiefenindex läuft — {covered} von {total} Abschnitten',
  'coverage.tree.pending': 'Noch kein Tiefenindex',
  'coverage.depth': 'Detailgrad: {label}',
  'coverage.tier.1': 'Überblick',
  'coverage.tier.2': 'Abschnitt für Abschnitt',
  'coverage.tier.3': 'Ausführlich (volle Abdeckung)',
  'coverage.tier.hint.1': 'Am schnellsten — der gespeicherte Überblick',
  'coverage.tier.hint.2': 'Ein ausführlicherer Durchgang über die Abschnitte',
  'coverage.tier.hint.3': 'Die meisten Details, über das ganze Dokument',
  'coverage.tierSelect.trigger': 'Detailgrad: {label}',
  // Abdeckung einer „Liste alle X"-Antwort (Phase 3). Vollständig über die durchsuchten
  // Abschnitte — NIE „komplett" (H7). „Ganzes Dokument" nur, wenn alles indexiert ist.
  // D-L7-Review ausstehend.
  // U1 (audit §2.3 / ux-10): entschärft von „Jeder Treffer …", das die Vollständigkeit der EXTRAKTION
  // überzeichnete. „Gelesen" ist die ehrliche Aussage — jeder Abschnitt wurde GELESEN, ohne zu behaupten,
  // jeder Treffer sei erfasst.
  'coverage.extract.whole': 'Im ganzen Dokument gelesen — {scanned} Abschnitte durchsucht',
  'coverage.extract.wholeUnparsed':
    'Im ganzen Dokument gelesen — {scanned} Abschnitte durchsucht, {unparsed} nicht lesbar',
  'coverage.extract.sections': 'In {scanned} durchsuchten Abschnitten gelesen',
  'coverage.extract.sectionsUnparsed':
    'In {scanned} durchsuchten Abschnitten gelesen, {unparsed} nicht lesbar',

  // ---- „Liste alle X"-Antwort (Phase 3) — D-L7-Review ausstehend ----
  'analysis.kind.generic': 'Einträge',
  'analysis.kind.date': 'Daten',
  'analysis.kind.amount': 'Beträge',
  'analysis.kind.party': 'Parteien',
  'analysis.kind.obligation': 'Pflichten',
  'analysis.listing.coverageWhole':
    '{count} {kind} im ganzen Dokument gefunden — {scanned} Abschnitte durchsucht{unparsed}:',
  'analysis.listing.coverageSections':
    '{count} {kind} in {scanned} durchsuchten Abschnitten gefunden{unparsed}:',
  'analysis.listing.empty': 'Keine {kind} in {scanned} durchsuchten Abschnitten gefunden{unparsed}.',
  'analysis.listing.unparsedSuffix': ' ({k} nicht lesbar)',
  'analysis.listing.item': '- {value} (×{count})',
  'analysis.listing.caveat':
    'Diese Liste ist vollständig über die durchsuchten Abschnitte — nicht garantiert komplett ' +
    '(ein kleines Modell kann einen Eintrag übersehen, und sehr ähnliche Einträge werden ' +
    'zusammengefasst).',
  'analysis.listing.refPage': 'S. {n}',
  'analysis.listing.refSection': 'Abschnitt {n}',

  // ---- Kontoauszug-Auswertung (full-doc-skills Plan §3.1, Phase 2) ----
  // Die deterministische Antwort über das ganze Dokument, die der Analyse-Handler aus der
  // extrahierten Buchungstabelle erzeugt (0 Modellaufrufe). Beträge/Daten/Währung sind Inhalt
  // und werden unverändert als Parameter durchgereicht.
  'skills.bankAnalysis.count': 'Ich habe **{count}** Buchungen über den ganzen Auszug gelesen.',
  // U1 (audit §2.3): die ehrlich abgesicherte Kopfzeile (du-Form). Jeder Abschnitt wurde gelesen, aber
  // **{dropped}** Zeile(n) mit einer Zahl ließen sich nicht als Buchung erfassen — also nicht zwingend alle.
  'skills.bankAnalysis.countPartial':
    'Ich habe **{count}** Buchungen gelesen. Bei **{dropped}** Zeile(n) stand eine Zahl, die ich nicht als ' +
    'Buchung erfassen konnte — es sind also vielleicht nicht alle Buchungen. Prüf diese Zeilen im Dokument.',
  // U1 (audit §2.3): die CONTRADICTED-D56-Kopfzeile — keine „ganzer Auszug"-Behauptung über einem Text, der
  // sagt, dass die aufgedruckten Salden nicht aufgehen (behebt den Selbstwiderspruch der alten Kopfzeile).
  'skills.bankAnalysis.countContradicted':
    'Ich habe **{count}** Buchungen gelesen, aber die aufgedruckten Salden dieses Auszugs gehen damit nicht ' +
    'auf — ich kann daher nicht bestätigen, dass das alle sind.',
  // U1 (audit §2.3 / ux-11): der leere Fall ist keine Sackgasse mehr — es liegt am Leser, nicht am Dokument,
  // und der nächste Schritt wird genannt (OCR bei einem Scan; sonst ist das Layout evtl. nicht maschinenlesbar).
  'skills.bankAnalysis.empty':
    'Ich habe das ganze Dokument durchsucht, konnte aber keine Buchungen daraus lesen. Die Zeilen liegen ' +
    'vielleicht als gescanntes Bild oder in einem ungewöhnlichen Layout vor, dem mein Leser nicht folgen kann. ' +
    'Wenn es ein Scan ist, lass zuerst OCR (Texterkennung) darüberlaufen; sonst ist das Layout womöglich nicht ' +
    'maschinenlesbar — öffne den Auszug und lies die Zahlen direkt.',
  'skills.bankAnalysis.couldNotRead':
    'Ich konnte diesen Auszug nicht lesen und kann ihn daher nicht auswerten.',
  'skills.bankAnalysis.unreconciledHeading':
    'Bitte diese Zeilen zuerst prüfen — ihr gedruckter Saldo stimmt nicht mit den Beträgen überein:',
  'skills.bankAnalysis.unreconciledItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.totals':
    'Eingänge: **{inAmount} {currency}** · Ausgänge: **{outAmount} {currency}** · Saldoänderung: **{netAmount} {currency}**.',
  'skills.bankAnalysis.noCurrency':
    'Diese Buchungen verwenden mehr als eine Währung, daher gibt es keinen einzelnen Gesamtbetrag — eine Summe müsste je Währung getrennt werden.',
  // Completeness gate (§3.5, D56) — der WIDERSPRUCH-Fall: Der Auszug macht eine Saldo-AUSSAGE, die den
  // gelesenen Buchungen widerspricht (ein Zeilensaldo passt nicht, oder gedruckter Anfangs-/Endsaldo geht
  // nicht auf). Die Lesung ist fragwürdig, daher verweigere ich eine womöglich falsche/unvollständige Summe.
  'skills.bankAnalysis.incompleteNoTotal':
    'Ich kann nicht bestätigen, dass ich den ganzen Auszug erfasst habe — die gedruckten Salden gehen mit ' +
    'den gelesenen Buchungen nicht auf, daher könnten die Zahlen falsch gelesen oder unvollständig sein. ' +
    'Damit ich dir keinen womöglich falschen Gesamtbetrag nenne, gebe ich hier keine Summe an; bitte ' +
    'prüf die Zahlen im geöffneten Auszug selbst.',
  'skills.bankAnalysis.categoryHeading': 'Nach Kategorie:',
  'skills.bankAnalysis.categoryItem': '- {category}: {amount} {currency} ({count})',
  'skills.bankAnalysis.categoryAssisted':
    '_Die Kategorien sind modellgestützt — eine Zuordnung kann falsch sein, die Summen oben bleiben davon unberührt._',
  'skills.bankAnalysis.categoryRuleBased':
    '_Dies ist eine schnelle regelbasierte Gruppierung (ohne Modell). Für eine reichhaltigere, modellgestützte Aufschlüsselung nutze die Schaltfläche „Kategorisieren“._',
  // Lokalisierte ANZEIGE-Labels für die feste Kategorienmenge (Phase 33). Der GESPEICHERTE Bezeichner
  // bleibt der kanonische englische Name (Enum / Modell-gestützt-Erkennung hängen daran); nur die
  // Anzeige der Aufschlüsselung wird übersetzt. Ein unbekannter Name fällt auf den Bezeichner zurück.
  'skills.bankCategory.Groceries': 'Lebensmittel',
  'skills.bankCategory.Dining': 'Restaurants',
  'skills.bankCategory.Transport': 'Transport',
  'skills.bankCategory.Utilities': 'Nebenkosten',
  'skills.bankCategory.Rent': 'Miete',
  'skills.bankCategory.Insurance': 'Versicherung',
  'skills.bankCategory.Subscriptions': 'Abonnements',
  'skills.bankCategory.Health': 'Gesundheit',
  'skills.bankCategory.Shopping': 'Einkäufe',
  'skills.bankCategory.Income': 'Einkommen',
  'skills.bankCategory.Transfer': 'Überweisung',
  'skills.bankCategory.Fees': 'Gebühren',
  'skills.bankCategory.Cash': 'Bargeld',
  'skills.bankCategory.Tax': 'Steuern',
  'skills.bankCategory.Spending': 'Ausgaben',
  'skills.bankCategory.Uncategorized': 'Nicht kategorisiert',
  'skills.bankAnalysis.caveat':
    'Diese Zahlen sind die im Auszug gedruckten Beträge, gelesen über das ganze Dokument — ' +
    'nichts davon wird aus Fließtext zusammengerechnet oder erfunden.',
  // Completeness gate (§3.5, D56) — der UNGEPRÜFTE Fall: Der Auszug druckt KEINEN Anfangs-/Endsaldo, der
  // bestätigt, dass ich jede Zeile erfasst habe, aber es WIDERSPRICHT dem Gelesenen auch nichts. Also gebe
  // ich eine klar GEKENNZEICHNETE Summe der gelesenen Zeilen an — keinen geprüften Auszugssaldo.
  'skills.bankAnalysis.unverifiedCaveat':
    'Diese Zahlen sind die Summe der **{count}** Buchungen, die ich über das ganze Dokument gelesen habe. ' +
    'Der Auszug enthält keinen Anfangs- und Endsaldo, daher kann ich nicht bestätigen, dass das alle ' +
    'Buchungen sind — versteh sie als Summe der angezeigten Zeilen, nicht als geprüften Auszugssaldo. ' +
    'Nichts davon wird aus Fließtext zusammengerechnet oder erfunden.',
  // R5 (Audit §5.7): der eine ehrliche Datumshinweis — nur angehängt, wenn das Dokument keinen Hinweis auf
  // tag- vs. monatszuerst gab und die Daten daher tagzuerst gelesen wurden (die de-AT-Voreinstellung).
  // Assistenzstimme in DU-Form (Plan §0). Inhaltsfrei.
  'skills.bankAnalysis.dateOrderCaveat':
    'Ein Hinweis zu den Daten: Dieser Auszug zeigt nicht, ob sie tag- oder monatszuerst gemeint sind, daher ' +
    'habe ich sie tagzuerst gelesen (Tag.Monat.Jahr) — ein Datum wie 03.05. kann also der 3. Mai oder der ' +
    '5. März sein. Prüf jedes Datum, auf das es ankommt, am Dokument nach.',
  // Eine begrenzte Buchungsliste, damit „zeig mir die Buchungen“ beantwortbar ist (Beträge unverändert).
  'skills.bankAnalysis.transactionsHeading': 'Buchungen:',
  'skills.bankAnalysis.transactionItem': '- {date} · {description} · {amount} {currency}',
  // W4 (Audit §3.3): benenne die ECHTEN Wege statt einer selbstbezüglichen Sackgasse. Der alte Text bat
  // darum, „den Auszug als CSV zu exportieren“ — der Bank-Handler hatte aber keinen Format-Modus und löste
  // dieselbe Vorlage erneut aus (Endlosschleife). Jetzt zeigt er auf den Export-Knopf der Aktionsleiste (mit
  // seinem echten Namen, für eine gespeicherte Datei) UND auf die neue Inline-Ausgabe direkt im Chat. Du-Form.
  'skills.bankAnalysis.transactionsMore':
    '… und **{count}** weitere. Um jede Zeile zu sehen, nutze den Knopf **Als CSV exportieren** in der ' +
    'Aktionsleiste, um den ganzen Auszug zu speichern, oder frag hier im Chat einfach nach dem Auszug als CSV oder JSON.',
  // W4 (Audit §8.1): der deterministische Zahlen-Nachtrag UNTER einer grounded-data-Modellantwort, damit ein
  // Falschzitat des Modells sofort durch die Ein-/Ausgänge/Saldoänderung des Parsers widerlegt wird. Beträge unverändert.
  // SKA-4 (W6, Audit §4.5): Die Ein-/Ausgänge/Saldoänderung sind BERECHNETE Summen (summarizeCashflow), NICHT
  // im Dokument gedruckte Zahlen — daher „berechnet“ statt „wörtlich aus dem Dokument“ (das gilt nur für den
  // Rechnungs-Nachtrag, dessen Netto/Steuer/Brutto gedruckte Beträge sind; diesen NICHT ändern).
  'skills.bankAnalysis.figureEcho': 'Aus den eingelesenen Buchungen berechnete Summen: {figures}.',
  'skills.bankAnalysis.figureEchoIn': 'Eingang {amount} {currency}',
  'skills.bankAnalysis.figureEchoOut': 'Ausgang {amount} {currency}',
  'skills.bankAnalysis.figureEchoNet': 'Saldoänderung {amount} {currency}',
  // W4 (Audit §3.3): der ehrliche Einleitungstext für die Inline-JSON/CSV-Ausgabe des Auszugs. Die CSV-
  // Variante nennt, was im CSV fehlt (Zusammenfassung + Salden), gemäß der §3.6-Ehrlichkeit.
  'skills.bankAnalysis.formatIntro':
    'Hier ist der Auszug als {format}, ausschließlich aus den gelesenen Beträgen erstellt — nichts aus Fließtext zusammengerechnet oder erfunden:',
  'skills.bankAnalysis.formatIntroCsv':
    'Hier ist der Auszug als CSV — nur die Buchungszeilen, aus den gelesenen Beträgen erstellt (nichts aus ' +
    'Fließtext zusammengerechnet oder erfunden). Die Geldfluss-Zusammenfassung und die Anfangs-/Endsalden ' +
    'sind nicht im CSV enthalten; frag nach dem Auszug als JSON, um auch die zu bekommen.',
  // Result-tables Phase 1.5: ein eigenes Kategorien-Set aus dem Prompt braucht das lokale Modell
  // (die deterministischen Regeln kennen nur ihren festen Satz) — ehrlich ablehnen statt still mit
  // einer anderen Taxonomie zu antworten. Das erkannte Set wird zurückgespiegelt.
  'skills.bankAnalysis.customCategoriesNeedModel':
    'Um die Buchungen in deine eigenen Kategorien ({categories}) einzuordnen, brauche ich ein laufendes ' +
    'lokales Modell — die eingebauten Schnellregeln kennen nur ihren festen Satz. Starte ein Modell und ' +
    'frag dann erneut.',
  // Phase 1.6: eine per Name referenzierte Taxonomie-CSV — ehrliche Ablehnung mit Dateiname, nie ein
  // stiller Rückfall auf die feste Taxonomie.
  'skills.bankAnalysis.customTaxonomyNotFound':
    'Ich konnte „{name}“ nicht in deinen Dokumenten finden. Importiere die Datei zuerst (Dokumente → Import) und frag dann erneut.',
  'skills.bankAnalysis.customTaxonomyUnparseable':
    'Ich habe „{name}“ gelesen, konnte es aber nicht als Kategorienliste verwenden. Erwartet wird eine ' +
    'Kategorie pro Zeile — ein Label, optional gefolgt von Stichworten nach einem Semikolon (z. B. ' +
    '„Kinder;Schule, Kita, Taschengeld“).',

  // ---- Rechnungsauswertung (full-doc-skills Plan §3.1, Phase 4 / D49) ----
  // Die deterministische Antwort über das ganze Dokument, die der Analyse-Handler aus der
  // extrahierten Rechnung erzeugt (0 Modellaufrufe). Beträge/Daten/Währung sind Inhalt und werden
  // unverändert als Parameter durchgereicht.
  'skills.invoiceAnalysis.count': 'Ich habe die ganze Rechnung gelesen — **{count}** Positionen.',
  // U1 (audit §2.3): die ehrlich abgesicherte Kopfzeile (du-Form) — jeder Abschnitt gelesen, aber
  // **{dropped}** Zeile(n) mit einer Zahl ließen sich nicht erfassen, also nicht zwingend die ganze Rechnung.
  'skills.invoiceAnalysis.countPartial':
    'Ich habe **{count}** Positionen gelesen. Bei **{dropped}** Zeile(n) stand eine Zahl, die ich nicht als ' +
    'Position erfassen konnte — es sind also vielleicht nicht alle Positionen. Prüf diese Zeilen im Dokument.',
  // U1 (audit §2.3 / ux-11): der leere Fall nennt einen nächsten Schritt statt in einer Sackgasse zu enden.
  'skills.invoiceAnalysis.empty':
    'Ich habe das ganze Dokument durchsucht, konnte aber keine Positionen oder Beträge daraus lesen. Die ' +
    'Zahlen liegen vielleicht als gescanntes Bild oder in einem ungewöhnlichen Layout vor, dem mein Leser ' +
    'nicht folgen kann. Wenn es ein Scan ist, lass zuerst OCR (Texterkennung) darüberlaufen; sonst ist das ' +
    'Layout womöglich nicht maschinenlesbar — öffne die Rechnung und lies die Zahlen direkt.',
  'skills.invoiceAnalysis.couldNotRead':
    'Ich konnte diese Rechnung nicht lesen und kann sie daher nicht auswerten.',
  'skills.invoiceAnalysis.unreconciledHeading':
    'Bitte diese Beträge zuerst prüfen — sie stimmen nicht überein:',
  'skills.invoiceAnalysis.checkLineItemsSumToNet': 'die Positionen ergeben nicht den gedruckten Nettobetrag',
  'skills.invoiceAnalysis.checkNetPlusTaxIsGross': 'netto plus Steuer ergibt nicht den gedruckten Bruttobetrag',
  'skills.invoiceAnalysis.checkTaxMatchesRate': 'der Steuerbetrag passt nicht zum angegebenen Steuersatz',
  'skills.invoiceAnalysis.unreconciledItem': '- {check}',
  'skills.invoiceAnalysis.totalsHeading': 'Beträge, genau wie gedruckt:',
  // SKA-21 (W6): {value} ist „{amount} {currency}“ oder nur der Betrag, wenn die Währung unbekannt/gemischt
  // ist (eine gemischte Rechnung ohne Kopf-Währung stempelt KEINEN Code statt dem von lineItems[0] — und
  // kein hängendes Leerzeichen). Wird von `amountText` im Handler gebaut.
  'skills.invoiceAnalysis.net': '- Netto: **{value}**',
  'skills.invoiceAnalysis.tax': '- Steuer: **{value}**',
  'skills.invoiceAnalysis.taxWithRate': '- Steuer ({rate}%): **{value}**',
  'skills.invoiceAnalysis.gross': '- Bruttobetrag (Zahlbetrag): **{value}**',
  'skills.invoiceAnalysis.positionsHeading': 'Positionen:',
  'skills.invoiceAnalysis.positionItem': '- {description} · {amount} {currency}',
  'skills.invoiceAnalysis.positionsMore':
    '… und **{count}** weitere — bitte mich, die Rechnung als CSV zu exportieren, um alle Positionen zu sehen.',
  'skills.invoiceAnalysis.formatIntro':
    'Hier ist die Rechnung als {format}, ausschließlich aus den gelesenen Beträgen erstellt — nichts aus Fließtext zusammengerechnet oder erfunden:',
  // §3.6-low (W4): CSV enthält NUR die Positionen — Kopf + Beträge fehlen (die sind in JSON/XML). Der alte
  // Text sagte „die Rechnung als CSV“, ohne zu nennen, was im CSV fehlt; jetzt ehrlich benannt.
  'skills.invoiceAnalysis.formatIntroCsv':
    'Hier ist die Rechnung als CSV — nur die Positionen, aus den gelesenen Beträgen erstellt (nichts aus ' +
    'Fließtext zusammengerechnet oder erfunden). Der Kopf (Lieferant, Rechnungsnummer, Daten) und die ' +
    'Beträge sind nicht im CSV enthalten; frag nach der Rechnung als JSON oder XML, um auch die zu bekommen.',
  'skills.invoiceAnalysis.noTotals':
    'Die Rechnung druckt keinen Netto-, Steuer- oder Bruttobetrag, den ich lesen konnte.',
  'skills.invoiceAnalysis.caveat':
    'Diese Zahlen sind die auf der Rechnung gedruckten Beträge, gelesen über das ganze Dokument — ' +
    'nichts davon wird aus Fließtext zusammengerechnet oder erfunden.',
  // R5 (Audit §5.7): der eine ehrliche Datumshinweis — nur angehängt, wenn die Rechnung keinen Hinweis auf
  // tag- vs. monatszuerst gab. Assistenzstimme in DU-Form (Plan §0). Inhaltsfrei.
  'skills.invoiceAnalysis.dateOrderCaveat':
    'Ein Hinweis zu den Daten: Diese Rechnung zeigt nicht, ob sie tag- oder monatszuerst gemeint sind, daher ' +
    'habe ich sie tagzuerst gelesen (Tag.Monat.Jahr) — ein Datum wie 03.05. kann also der 3. Mai oder der ' +
    '5. März sein. Prüf jedes Datum, auf das es ankommt, am Dokument nach.',
  // W3 (Audit §3.1): die geladenen Kopffelder als kleiner Details-Block, damit die Fragen nach Lieferant /
  // Rechnungsnummer / Datum auch auf dem deterministischen Template-Pfad beantwortet werden. Werte sind
  // Dokumentinhalt und werden unverändert als Parameter durchgereicht. Du-Form.
  'skills.invoiceAnalysis.detailsHeading': 'Details, wie gedruckt:',
  'skills.invoiceAnalysis.detailVendor': '- Lieferant: {vendor}',
  // P3 (invoice-hardening-2026-07-04): der Rechnungsempfänger, nur aus einer beschrifteten Zeile gelesen.
  'skills.invoiceAnalysis.detailRecipient': '- Empfänger (Rechnungsempfänger): {recipient}',
  'skills.invoiceAnalysis.detailInvoiceNumber': '- Rechnungsnummer: {number}',
  'skills.invoiceAnalysis.detailInvoiceDate': '- Rechnungsdatum: {date}',
  'skills.invoiceAnalysis.detailDueDate': '- Fälligkeitsdatum: {date}',
  // W3 (Audit §8.1): der deterministische Zahlen-Nachtrag UNTER einer grounded-data-Modellantwort, damit ein
  // Falschzitat des Modells sofort durch die Zahlen des Parsers widerlegt wird. Beträge unverändert.
  'skills.invoiceAnalysis.figureEcho': 'Beträge wie eingelesen, wörtlich aus dem Dokument: {figures}.',
  // SKA-21 (W6): {value} ist „{amount} {currency}“ oder nur der Betrag bei einer gemischten Rechnung ohne
  // Kopf-Währung (kein irreführender lineItems[0]-Code, kein hängendes Leerzeichen) — von `amountText` gebaut.
  'skills.invoiceAnalysis.figureEchoNet': 'Netto {value}',
  'skills.invoiceAnalysis.figureEchoTax': 'Steuer {value}',
  'skills.invoiceAnalysis.figureEchoGross': 'Brutto {value}',
  // invoice-hardening-2026-07-04 P2: das Abgleich-GATE. Bei einem widersprüchlichen Summen-Check ersetzt
  // das Template die selbstbewusste Beträge-Überschrift durch die ungeprüfte Variante samt Hinweis, und
  // der grounded-data-Zahlen-Nachtrag wird durch die Unterdrückungs-Notiz ersetzt. Du-Form.
  'skills.invoiceAnalysis.totalsHeadingUnverified':
    'Beträge wie gedruckt — **sie gehen nicht auf**, behandle sie also als ungeprüft:',
  'skills.invoiceAnalysis.unreconciledCaveat':
    'Diese gedruckten Beträge widersprechen einander — meist heißt das, dass das Dokument nicht sauber ' +
    'gelesen werden konnte (ein Scan, ein Bild-PDF oder ein ungewöhnliches Layout). Verlass dich auf ' +
    'keine dieser Zahlen, ohne das Originaldokument zu prüfen.',
  'skills.invoiceAnalysis.figureEchoSuppressed':
    'Die eingelesenen Summen wiederhole ich hier nicht: Sie stimmen weder untereinander noch mit den ' +
    'Positionen überein — sie als verlässliche Beträge zu zitieren wäre irreführend. Prüf das ' +
    'Originaldokument.',
  // invoice-hardening-2026-07-04 P3: die Glyphen-Salat-Fälle. `unreadableLayout` = die Verweigerung bei
  // verwürfeltem Text UND widersprüchlichen/leeren Zahlen (nach dem Geometrie-Neuversuch);
  // `textQualityCaveat` = der Hinweis im seltenen verwürfelt-aber-stimmig-Fall. Du-Form.
  'skills.invoiceAnalysis.unreadableLayout':
    'Der Text dieses Dokuments lässt sich nicht sauber auslesen — die Zeichen kommen verwürfelt (Glyphe ' +
    'für Glyphe) heraus; meist ist das ein Bild-PDF oder ein ungewöhnlich kodiertes PDF. Ich konnte keine ' +
    'verlässlichen Positionen oder Beträge daraus lesen und zitiere deshalb keine Zahlen. Wenn es ein ' +
    'Scan ist, lass zuerst OCR (Texterkennung) darüberlaufen; sonst öffne die Rechnung und lies die ' +
    'Zahlen direkt.',
  'skills.invoiceAnalysis.textQualityCaveat':
    'Ein Hinweis: Teile des Dokumenttexts kamen verwürfelt (Glyphe für Glyphe) heraus. Die Beträge oben ' +
    'gehen zwar auf, aber prüf alles Wichtige am Originaldokument nach.',

  // Full-doc-skills Phase 3 (§3.2/D45): Hinweis bei Verweigerung einer Teilantwort.
  'skills.analysis.refusePartial':
    'Das kann ich nur genau über das ganze Dokument beantworten, und dieses ist noch nicht ' +
    'vollständig indexiert. Öffne den Dokumente-Bildschirm, wähle „Neu indexieren" und frage dann erneut.',

  // W2 Weiterleitung bei falscher Dokumentanzahl (Audit §2.1). Eine Werkzeug-/Ganzdokument-Skill liest
  // jeweils EIN Dokument, daher lässt sich ein Bereich mit mehreren Dokumenten nicht vollständig
  // auswerten. Statt still auf wenige Textpassagen zurückzufallen, grenzt die App auf das am besten
  // passende Dokument ein (mit dem ehrlichen `scopeNarrowed`-Hinweis) oder bittet dich zu wählen.
  // Deterministisch, inhaltsfrei (Titel + Anzahl, kein Dokumenttext), kein Modellaufruf. Du-Form.
  'skills.analysis.scopeNarrowed':
    'Ich habe nur **{title}** ausgewertet — die übrigen {count} Dokument(e) im Bereich habe ich nicht ' +
    'gelesen. Um ein anderes auszuwerten, wähle genau dieses Dokument aus (oder nenne die Datei in ' +
    'deiner Frage) und frage erneut.',
  // Kein eindeutig bestes Dokument (0 oder mehrere Treffer): bitte um die Auswahl EINES Dokuments.
  'skills.analysis.selectOne':
    'Für eine vollständige Auswertung brauche ich ein einzelnes Dokument — im Moment sind {count} im ' +
    'Bereich, daher sehe ich nur einige Passagen daraus. Wähle ein Dokument aus (oder nenne die Datei in ' +
    'deiner Frage) und frage erneut.',
  // what-changed-Vergleich braucht GENAU zwei Dokumente; bitte um deren Auswahl (Audit §3.4).
  'skills.analysis.selectTwo':
    'Für einen Vergleich wähle bitte genau **zwei** Dokumente (oder zwei Versionen) aus — im Moment ' +
    'sind {count} im Bereich. Wähle die beiden zu vergleichenden aus und frage erneut.',

  // Antwort der Schwärzungs-Weiterleitung: eine Aktions-Skill verweist auf ihre eigene Schaltfläche
  // statt eine Top-k-Antwort zu erzeugen. Deterministisch + inhaltsfrei (kein Modellaufruf, kein
  // Dokumentzugriff); `{button}` ist die Beschriftung aus der SkillRunBar.
  'skills.redactionRouting.answer':
    'Um dieses Dokument zu schwärzen, klicke unten beim Chat auf die Schaltfläche **{button}** und ' +
    'wähle anschließend, wo die Kopie gespeichert werden soll. Sie läuft vollständig auf diesem ' +
    'Gerät und maskiert klar erkennbare personenbezogene Daten – E-Mail-Adressen, Telefonnummern, ' +
    'IBANs, Datumsangaben und Links – und liest dabei das ganze Dokument. Es ist ein bestmöglicher ' +
    'erster Durchlauf, keine Garantie: Namen oder ungewöhnliche Formate erkennt sie nicht – prüfe ' +
    'die gespeicherte Kopie, bevor du sie teilst.',
  // U-1: dieselbe Weiterleitungsantwort, wenn MEHR ALS EIN Dokument im Bereich liegt. Das Werkzeug
  // schwärzt jeweils ein Dokument, daher bleibt die Antwort ehrlich und verweist auf die Zielauswahl
  // der Schaltfläche – inhaltsfrei (die Anzahl steuert den Text; hier erscheint kein Dokumenttitel).
  'skills.redactionRouting.answerMulti':
    'Um ein Dokument zu schwärzen, klicke unten beim Chat auf die Schaltfläche **{button}**, wähle ' +
    'aus, welches Dokument geschwärzt werden soll, und lege anschließend fest, wo die Kopie ' +
    'gespeichert werden soll. Sie verarbeitet jeweils ein Dokument, läuft vollständig auf diesem ' +
    'Gerät und maskiert klar erkennbare personenbezogene Daten – E-Mail-Adressen, Telefonnummern, ' +
    'IBANs, Kartennummern, Datumsangaben und Links – und liest dabei das ganze Dokument. Es ist ein ' +
    'bestmöglicher erster Durchlauf, keine Garantie: Namen oder ungewöhnliche Formate erkennt sie ' +
    'nicht – prüfe die gespeicherte Kopie, bevor du sie teilst.',
  // U2 Vorschau (Audit §3.4): eine INFORMATIVE Frage ("welche personenbezogenen Daten…") über ein einzelnes
  // Dokument liefert die deterministischen Anzahlen je Kategorie (NUR Anzahlen – nie ein erkannter Wert)
  // statt der Weiterleitung auf die Schaltfläche. Dieselben Offline-Detektoren wie das Werkzeug; kein Schreiben.
  'skills.redactionRouting.scan':
    'Ich habe das ganze Dokument nach klar erkennbaren personenbezogenen Daten durchsucht. Gefunden – ' +
    'E-Mail-Adressen: {email}, Telefonnummern: {phone}, IBANs: {iban}, Kartennummern: {card}, ' +
    'Datumsangaben: {date}, Links: {url}. Das ist eine bestmögliche Mustererkennung: Namen, Adressen ' +
    'oder ungewöhnliche Formate erkennt sie nicht – sieh das als Untergrenze, nicht als vollständige ' +
    'Liste. Für eine geschwärzte Kopie klicke unten beim Chat auf die Schaltfläche **{button}** und ' +
    'wähle, wo die Kopie gespeichert werden soll.',

  // ---- Models ----
  'models.title': 'KI-Modell',
  'models.lead':
    'Das KI-Modell beantwortet deine Fragen, vollständig auf diesem Gerät. Alles wird vor ' +
    'der Verwendung geprüft, und nichts wird ohne deine ausdrückliche Bestätigung ' +
    'heruntergeladen.',
  'models.loadError': 'Modelle konnten nicht geladen werden: {error}',
  'models.checking':
    'Modell-Dateien werden geprüft… Die erste Prüfung nach dem Hinzufügen oder ' +
    'Aktualisieren eines Modells kann bei großen Dateien ein paar Minuten dauern; danach ' +
    'wird das Ergebnis gemerkt und es geht sofort.',
  'models.checkingProgress': 'Modell {n} von {m} wird geprüft: {name} — {pct} %',
  'models.state.installed': 'Installiert',
  'models.state.missing': 'Nicht heruntergeladen',
  'models.state.checksumFailed': 'Nicht prüfbar',
  'models.state.unsupported': 'Nicht unterstützt',
  'models.state.notRecommended': 'Nicht empfohlen',
  'models.state.ready': 'Bereit',
  'models.state.running': 'Läuft',
  'models.hint.embeddings': 'Bereitet deine Dokumente vor, damit du Fragen dazu stellen kannst.',
  'models.hint.reranker': 'Verbessert, welche Dokumentpassagen für Antworten verwendet werden.',
  'models.hint.transcriber':
    'Wandelt Audioaufnahmen in durchsuchbaren Text um — und schaltet die 🎤 Spracheingabe im Chat frei.',
  'models.hint.small': 'Klein und flott — schnelle Antworten auf fast jedem Gerät.',
  'models.hint.balanced': 'Ausgewogen — läuft gut auf den meisten Laptops.',
  'models.hint.large': 'Groß — stärkste Antworten; braucht einen leistungsstarken Rechner.',
  'models.usesSpace': 'Belegt {size} Speicherplatz auf dem Laufwerk.',
  'models.downloads.blockedByPolicy':
    'Downloads sind durch die Richtlinie dieses Laufwerks deaktiviert.',
  'models.downloads.enableInSettings':
    'Um Modelle herunterzuladen, schalte in den Einstellungen „Internetzugriff für ' +
    'Modell-Downloads und Updates erlauben“ ein.',
  'models.download.verifying': 'Die heruntergeladene Datei wird geprüft…',
  'models.download.progress': 'Wird heruntergeladen… {pct} % ({received} von {total})',
  'models.download.progressNoTotal': 'Wird heruntergeladen… bisher {received}',
  'models.download.cancel': 'Download abbrechen',
  'models.download.cancelled':
    'Download abgebrochen — ein erneuter Start setzt fort, wo er aufgehört hat.',
  'models.download.unverifiedBefore':
    'Heruntergeladen, aber das Manifest dieses Modells hat noch keine echte Prüfsumme, ' +
    'daher bleibt die Datei ungeprüft. Erzeuge eine mit ',
  'models.download.unverifiedAfter': '.',
  'models.download.otherRunning':
    'Es läuft bereits ein Download — Modelle werden einzeln heruntergeladen',
  'models.download.titled': '{name} herunterladen ({size})',
  'models.download.resume': 'Download fortsetzen',
  'models.download.start': 'Herunterladen',
  // In-App-Engine-(llama.cpp + whisper.cpp)-Installer-Banner — sichtbar, wenn eine Engine fehlt.
  'models.engine.title': 'KI-Engine installieren',
  'models.engine.explain':
    'Modelle laufen in einem eingebauten Demo-Modus (sichtbar simulierte Antworten), bis die ' +
    'KI-Engine installiert ist; die Spracheingabe braucht die Sprach-Engine. Installiere die ' +
    'Engines einmal — starte dann ein Modell für echte Antworten.',
  'models.engine.install': 'KI-Engine installieren',
  'models.engine.retry': 'Erneut versuchen',
  'models.engine.progress': 'KI-Engine wird heruntergeladen… {pct} %',
  'models.engine.downloadingNoTotal': 'KI-Engine wird heruntergeladen…',
  'models.engine.verifying': 'KI-Engine wird geprüft…',
  'models.engine.extracting': 'KI-Engine wird entpackt…',
  'models.engine.installedNote': 'Die KI-Engine ist installiert — starte ein Modell, um sie zu nutzen.',
  // Hinweis nur zur Sprach-Engine: die Chat-Engine ist installiert (Chat funktioniert echt);
  // nur die optionale Sprach-Engine (whisper.cpp) fehlt — daher ein ruhiger Info-Hinweis, kein
  // „Demo-Modus“-Alarm. Nutzt dieselben Download-Job-Schlüssel (Fortschritt/Wiederholen/Richtlinie).
  'models.voiceEngine.title': 'Sprachdiktat hinzufügen (optional)',
  'models.voiceEngine.explain':
    'Chat- und Dokumentantworten funktionieren auf diesem Laufwerk bereits. Die Sprach-Engine ist ' +
    'optional — installiere sie nur, wenn du Nachrichten per Mikrofon diktieren möchtest.',
  'models.voiceEngine.install': 'Sprach-Engine installieren',
  'models.ram.needs': 'Braucht mindestens {min} GB RAM',
  'models.ram.machine': ' — dieser Computer hat etwa {ram} GB',
  'models.ram.advice': '. Wähle ein kleineres Modell — die Qualität bleibt top.',
  'models.badge.active': 'Aktiv',
  'models.badge.recommended': 'Empfohlen',
  'models.badge.ramNeeded': 'Braucht ≥{min} GB RAM',
  'models.automatic.installed':
    'Installiert — wird automatisch verwendet. Es gibt nichts zu starten.',
  'models.automatic.notInstalled':
    'Wird nach der Installation automatisch verwendet — keine Einrichtung nötig.',
  'models.vision.installed':
    'Installiert — bereit im Tab „Bilder". Hier gibt es nichts zu starten.',
  'models.vision.notInstalled':
    'Nach der Installation im Tab „Bilder" verfügbar — keine Einrichtung nötig.',
  'models.selected': 'Ausgewählt',
  'models.select': 'Auswählen',
  'models.stopRuntime': 'Modell stoppen',
  'models.startRuntime': 'Modell starten',
  'models.startMock': 'Im Demo-Modus testen',
  'models.starting': 'Wird gestartet…',
  'models.startingTitle': 'Dieses Modell wird geladen — bei großen Modellen kann das etwas dauern',
  'models.startTitle': 'Dieses Modell auf diesem Gerät starten',
  'models.startMockTitle':
    'Noch keine Modell-Datei — teste die App im Demo-Modus, mit sichtbar simulierten Antworten',
  'models.notPresentTitle': 'Modell-Datei nicht vorhanden',
  'models.tech.summary': 'Technische Details',
  'models.tech.id': 'Modell-ID',
  'models.tech.family': 'Familie',
  'models.tech.format': 'Format',
  'models.tech.runtime': 'Laufzeit',
  'models.tech.license': 'Lizenz',
  'models.tech.sizeOnDisk': 'Größe auf dem Laufwerk',
  'models.tech.minRam': 'Minimaler RAM',
  'models.tech.recRam': 'Empfohlener RAM',
  'models.tech.context': 'Kontextfenster',
  'models.tech.contextValue': '{count} Tokens',
  'models.tech.file': 'Datei',
  // ---- Kontextgrößen-Auswahl (Nutzerbericht 2026-07-04 — der Abschneide-Hinweis verweist hierher) ----
  'models.context.title': 'Kontextgröße',
  'models.context.label': 'Kontextfenster für Antworten:',
  'models.context.auto': 'Automatisch — empfohlene Größe des Modells',
  'models.context.hint':
    'Ein größerer Kontext lässt eine Unterhaltung oder eine Dokument-Antwort mehr Text auf einmal ' +
    'nutzen, braucht aber mehr Arbeitsspeicher und kann Antworten verlangsamen. Wird beim ' +
    'nächsten Modellstart wirksam.',
  'models.context.restartHint':
    'Gerade läuft ein Modell — stoppe und starte es, damit die neue Größe wirkt.',
  'models.verifyTitle':
    'Die Datei auf dem Laufwerk neu hashen und mit ihrer SHA-256-Prüfsumme vergleichen ' +
    '(umgeht den Zwischenspeicher)',
  'models.verifying': 'Wird geprüft…',
  'models.verify': 'Prüfsumme prüfen',
  'models.confirm.title': '{name} herunterladen?',
  'models.confirm.start': 'Download starten',
  'models.confirm.size': 'Größe',
  'models.confirm.license': 'Lizenz',
  'models.confirm.from': 'Quelle',
  'models.confirm.readLicense': 'Lizenz lesen',
  'models.confirm.hint':
    'Die heruntergeladene Datei wird vor der Verwendung geprüft. Das ist die einzige ' +
    'Netzwerkanfrage der App — nichts über dich oder deine Dokumente wird gesendet.',
  'models.confirm.licenseAck':
    'Ich habe die Lizenzbedingungen dieses Modells gelesen und akzeptiere sie',
  'models.empty.title': 'Keine Modell-Manifeste gefunden',
  'models.empty.lineBefore': 'Lege YAML-Manifeste unter ',
  'models.empty.lineAfter': ' auf dem Laufwerk ab.',
  'models.section.yourModel': 'Dein KI-Modell',
  'models.section.otherModels': 'Weitere Modelle',
  'models.section.choose': 'Wähle dein KI-Modell',
  'models.section.docSearch': 'Dokumentsuche',
  'models.section.other': 'Sonstiges',

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
  // ---- Einstellungen: Chat / Kontext-Komprimierung (context-compaction plan §5.4) ----
  'settings.chat.title': 'Chat',
  'settings.chatCompaction.label': 'Ältere Nachrichten zusammenfassen, um Kontext freizugeben',
  'settings.chatCompaction.help':
    'Standardmäßig an. Wenn eine lange Unterhaltung an die Kontextgrenze des Modells stößt, ' +
    'werden die älteren Nachrichten einmalig zu einer kompakten Notiz zusammengefasst — auf ' +
    'diesem Laufwerk gespeichert — statt unbemerkt verworfen zu werden. Schalte es aus, um nur ' +
    'die neuesten Nachrichten zu behalten, die hineinpassen.',
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
  // Ohne Override folgt das gestartete Fenster der Modell-Empfehlung.
  'settings.workspace.contextAuto': 'Automatisch (Modell-Standard) — änderbar im Bereich „KI-Modell“',
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

  // ---- Skills (Rail-Ziel — SkillsScreen.tsx + settings/SkillsTab.tsx, Skills-Plan §15) ----
  'skills.title': 'Skills',
  'skills.intro': 'Skills bringen der KI bei, eine bestimmte Aufgabe zu erledigen. Sie ergänzen ihre Antworten um Hinweise – sie greifen nie auf das Internet oder andere Ordner auf deinem Computer zu.',
  // S13c (D4) – der globale Auto-Anwenden-Schalter, standardmäßig aus. Der Hinweis erklärt klar, was
  // das Einschalten bewirkt und dass jeder automatisch angewandte Skill sichtbar + umkehrbar bleibt.
  'skills.autoFire.title': 'Passenden Skill automatisch anwenden',
  'skills.autoFire.toggle': 'Passenden Skill automatisch anwenden',
  'skills.autoFire.hint':
    'Wenn eingeschaltet, darf die App einen eindeutig passenden App-Skill von sich aus auf eine Antwort anwenden, damit du ihn nicht selbst wählen musst. Nur App-Skills, nie selbst erstellte oder importierte. Du siehst immer, welcher Skill verwendet wurde, und kannst für diese Antwort ohne ihn antworten. Standardmäßig aus.',
  'skills.autoFire.on': 'Automatische Skills an',
  'skills.autoFire.off': 'Automatische Skills aus',
  'skills.import': 'Skill importieren…',
  'skills.import.menuAria': 'Einen Skill importieren',
  'skills.import.fromFile': 'Aus einer Datei (.skill.zip)…',
  'skills.import.fromFolder': 'Aus einem Ordner…',
  'skills.loading': 'Skills werden geladen…',
  'skills.locked': 'Entsperre deinen Arbeitsbereich, um Skills zu verwalten.',
  'skills.loadFailed': 'Skills konnten nicht geladen werden.',
  // SKA-32: Hinweis auf Reconcile-Fehler (nur die Anzahl — nie ein Ordnername; §22-M1).
  'skills.reconcile.folderErrors.one':
    '{count} Skill-Ordner konnte nicht gelesen werden und wird übersprungen. Seine SKILL.md fehlt, ist ungültig oder nicht lesbar.',
  'skills.reconcile.folderErrors.other':
    '{count} Skill-Ordner konnten nicht gelesen werden und werden übersprungen. Jeder Ordner braucht eine gültige SKILL.md.',
  'skills.empty.title': 'Noch keine Skills',
  'skills.empty.line': 'Skills bringen der KI bei, eine bestimmte Aufgabe zu erledigen. Füge einen hinzu, um zu starten.',
  'skills.trusted.app': 'App',
  'skills.trusted.user': 'Von dir',
  'skills.row.enableLabel': 'Aktiviert',
  'skills.row.on': 'Skill an',
  'skills.row.off': 'Skill aus',
  'skills.dup.chip': 'Doppelter Name',
  'skills.dup.title': 'Ein anderer installierter Skill nutzt diesen Namen. Es kann immer nur einer aktiv sein.',
  'skills.unavailable.chip': 'Dateien fehlen',
  'skills.unavailable.title': 'Die Dateien dieses Skills sind nicht mehr auf dem Laufwerk.',
  'skills.incompatible.chip': 'Neuere App nötig',
  'skills.incompatible.title': 'Dieser Skill benötigt eine neuere Version der App; aktualisiere sie, um ihn zu aktivieren.',
  'skills.review.chip': 'Prüfen',
  'skills.warn.title': 'Prüfe, was dieser Skill darf',
  'skills.warn.body': 'Von dir erstellt oder importiert. Prüfe, was er darf, bevor du dich darauf verlässt.',
  'skills.warn.ack': 'Verstanden',
  'skills.menu.aria': 'Skill-Aktionen',
  'skills.menu.export': 'Exportieren…',
  'skills.menu.delete': 'Löschen',
  'skills.export.done': 'Skill exportiert',
  'skills.delete.title': 'Diesen Skill löschen?',
  'skills.delete.body': 'Damit wird der Skill vom Laufwerk entfernt. Chats, die ihn bereits genutzt haben, funktionieren weiter.',
  'skills.delete.confirm': 'Löschen',
  'skills.delete.done': 'Skill gelöscht',
  'skills.detail.aria': 'Skill-Details',
  'skills.detail.version': 'Version',
  'skills.detail.author': 'Autor',
  'skills.detail.language': 'Sprache',
  'skills.detail.kind': 'Typ',
  'skills.kind.instruction': 'Anleitung',
  'skills.kind.tool': 'Nutzt Werkzeuge',
  'skills.tool.note': 'Vorerst ergänzt dies nur Hinweise. Die beschriebenen Werkzeuge kommen in einer späteren Version.',
  'skills.tool.note.active':
    'Wenn du darum bittest, kann dieser Skill zugelassene lokale Werkzeuge auf einem von dir gewählten Dokument ausführen. Nur-Lese-Werkzeuge können auch automatisch laufen, um deine Frage zu beantworten; alles, was schreibt oder eine Datei exportiert, fragt dich immer zuerst. Und sie sehen dabei jeweils nur dieses eine Dokument.',
  'skills.perm.heading': 'Was dieser Skill darf',
  'skills.perm.canTitle': 'Dieser Skill kann:',
  'skills.perm.cannotTitle': 'Dieser Skill kann nicht:',
  'skills.perm.can.instructions': 'Anweisungen zu KI-Antworten hinzufügen',
  'skills.perm.can.documents': 'Nur von dir gewählte Dokumente lesen',
  'skills.perm.can.tools': 'Zugelassene lokale Werkzeuge nutzen, wenn du darum bittest',
  'skills.perm.cannot.network': 'Auf das Internet zugreifen',
  'skills.perm.cannot.files': 'Andere Ordner auf deinem Computer lesen',
  'skills.perm.cannot.scripts': 'Skripte ausführen oder Software installieren',
  'skills.tech.summary': 'Technische Details',
  'skills.tech.id': 'Skill-Id',
  'skills.tech.installId': 'Installations-Id',
  'skills.tech.source': 'Quelle',
  'skills.tech.permissions': 'Berechtigungen',
  'skills.import.title': 'Diesen Skill hinzufügen?',
  'skills.import.confirm': 'Skill hinzufügen',
  'skills.import.added': 'Skill hinzugefügt',
  'skills.import.failedTitle': 'Dieser Skill kann nicht hinzugefügt werden',
  'skills.import.failed': 'Dieser Skill konnte nicht hinzugefügt werden.',
  'skills.import.collision': 'Ein Skill mit diesem Namen ist bereits installiert. Hinzufügen ersetzt ihn.',
  'skills.import.collisionApp': 'Ein App-Skill nutzt diesen Namen bereits. Dein Skill wird hinzugefügt, bleibt aber aus, solange der App-Skill an ist.',
  'skills.import.upgrade': 'Aktualisiert die installierte Version ({from} → {to}).',
  'skills.import.replace': 'Ersetzt die installierte Version ({version}).',
  'skills.import.downgrade': 'Dies ist älter als die installierte Version ({installed}).',
  'skills.import.downgradeBlocked': 'Eine ältere Version zu installieren erfordert den Entwicklermodus. Aktiviere ihn unter Einstellungen → Allgemein, um dies zuzulassen.',
  // Strukturelle Import-Fehlergründe, lokalisiert aus dem inhaltsfreien Code der Vorschau (I2).
  'skills.import.error.notFound': 'Der ausgewählte Skill konnte nicht gefunden werden.',
  'skills.import.error.notZipOrFolder': 'Ein Skill muss eine .skill.zip-Datei oder ein Ordner mit SKILL.md sein.',
  'skills.import.error.unreadableZip': 'Das Skill-Paket konnte nicht als gültiges ZIP-Archiv gelesen werden.',
  'skills.import.error.encryptedZip': 'Das Skill-Paket nutzt ein nicht unterstütztes (verschlüsseltes oder ZIP64-) ZIP-Format.',
  'skills.import.error.unsupportedCompression': 'Das Skill-Paket nutzt eine nicht unterstützte Komprimierungsmethode.',
  'skills.import.error.pathTraversal': 'Das Paket enthält eine Datei, deren Pfad aus dem Paketordner ausbricht.',
  'skills.import.error.absolutePath': 'Das Paket enthält eine Datei mit einem absoluten oder Laufwerksbuchstaben-Pfad.',
  'skills.import.error.invalidPath': 'Das Paket enthält eine Datei mit einem ungültigen Pfad.',
  'skills.import.error.symlink': 'Das Paket enthält einen symbolischen Link, was nicht erlaubt ist.',
  'skills.import.error.tooDeep': 'Das Paket verschachtelt Ordner tiefer als erlaubt.',
  'skills.import.error.pathTooLong': 'Das Paket enthält einen zu langen Dateipfad.',
  'skills.import.error.tooManyFiles': 'Das Paket enthält mehr Dateien als erlaubt.',
  'skills.import.error.tooLarge': 'Das Paket ist größer als erlaubt.',
  'skills.import.error.fileTooLarge': 'Eine Datei im Paket ist größer als erlaubt.',
  'skills.import.error.duplicatePath': 'Das Paket enthält zwei Dateien, die auf denselben Pfad verweisen.',
  'skills.import.error.badExtension': 'Das Paket enthält einen nicht erlaubten Dateityp.',
  'skills.import.error.nestedArchive': 'Das Paket enthält ein eingebettetes Archiv, was nicht erlaubt ist.',
  'skills.import.error.noSkillMd': 'Das Paket enthält keine SKILL.md-Datei.',
  'skills.import.error.invalidManifest': 'Das Skill-Manifest ist ungültig.',
  'skills.import.error.idMismatch': 'Die Skill-ID ist kein gültiger Name.',
  'skills.import.error.downgradeBlocked': 'Eine neuere Version dieses Skills ist bereits installiert. Aktiviere den Entwicklermodus, um eine ältere Version zu installieren.',
  'skills.import.error.appReadOnly': 'Von der App bereitgestellte Skills können nicht geändert oder gelöscht werden.',
  'skills.import.error.locked': 'Entsperre den Arbeitsbereich, um Skills zu verwalten.',
  // SKA-35: Hinweise der Import-Vorschau, lokalisiert über den stabilen Code + app-feste Parameter
  // ({field} = fester Frontmatter-Feldname, {max}/{value} = App-Konstanten — nie Skill-Inhalt).
  'skills.import.note.permissionNotString': 'Die Berechtigung "{field}" ist kein Textwert; der Standard "{value}" wird verwendet.',
  'skills.import.note.permissionUnrecognized': 'Die Berechtigung "{field}" hat einen unbekannten Wert; der Standard "{value}" wird verwendet.',
  'skills.import.note.permissionClamped': 'Der Skill fordert mehr "{field}"-Zugriff an, als diese App erlaubt; er wird auf "{value}" begrenzt.',
  'skills.import.note.listInvalid': 'Die Liste "{field}" ist ungültig und wird ignoriert.',
  'skills.import.note.listItemsTooLong': 'Einige Einträge in "{field}" sind zu lang und werden ignoriert.',
  'skills.import.note.listTruncated': '"{field}" hat mehr Einträge als erlaubt; nur die ersten {max} werden übernommen.',
  'skills.import.note.languageInvalid': 'Das Feld "language" ist kein gültiges Sprachkürzel; "en" wird verwendet.',
  'skills.import.note.allowedToolsIgnored': 'Die deklarierten Werkzeuge werden bei einem Anleitungs-Skill ignoriert (Werkzeuge kommen mit einer späteren Version).',
  'skills.import.note.analysisInvalid': 'Das Feld "analysis" hat einen unbekannten Wert und wird ignoriert.',
  'skills.import.note.analysisIgnoredForTool': 'Das Feld "analysis" wird bei einem Werkzeug-Skill ignoriert (die App bestimmt sein Ganzdokument-Verhalten).',
  'skills.import.note.triggersInvalid': 'Der Block "triggers" ist ungültig und wird ignoriert.',
  'skills.import.note.autoFireInvalid': 'Das Feld "triggers.autoFire" muss true oder false sein; es wird als false behandelt.',
  'skills.import.note.localizedInvalid': 'Der Block "localized" ist ungültig und wird ignoriert.',
  'skills.import.note.localizedLocaleInvalid': 'Ein "localized"-Eintrag hat einen ungültigen Sprachschlüssel und wird ignoriert.',
  'skills.import.note.localizedEntryInvalid': 'Ein "localized"-Eintrag ist ungültig und wird ignoriert.',
  'skills.import.note.localizedTitleIgnored': 'Ein übersetzter Titel wurde ignoriert (er muss eine kurze einzelne Zeile sein).',
  'skills.import.note.localizedDescriptionIgnored': 'Eine übersetzte Beschreibung wurde ignoriert (sie muss eine kurze einzelne Zeile sein).',
  'skills.import.note.localizedTooMany': 'Der Block "localized" hat mehr Sprachen als erlaubt; nur die ersten {max} werden übernommen.',
  'skills.import.note.trustIgnored': 'Ein "trust"-Feld im Skill wird ignoriert; die App vergibt Vertrauen selbst.',
  'skills.import.note.manifestJsonConflict': 'Das Feld "{field}" in der beigelegten manifest.json weicht von SKILL.md ab; SKILL.md gilt.',
  'skills.replace.title': 'Stattdessen diesen Skill nutzen?',
  'skills.replace.body': 'Ein anderer Skill mit diesem Namen ist an. Wenn du diesen einschaltest, wird der andere ausgeschaltet.',
  'skills.replace.confirm': 'Einschalten',

  // ---- Settings → Privacy & data tab ----
  'privacy.offlineOn': '● Offline-Modus: AN',
  'privacy.offlineOff': '○ Netzwerkzugriff aktiviert',
  'privacy.statement.offline':
    'Der Offline-Modus ist an. HilbertRaum führt das KI-Modell auf deinem ' +
    'Laptop aus. Deine Fragen, Dokumente, Embeddings und Chat-Verläufe bleiben lokal.',
  'privacy.statement.online':
    'HilbertRaum führt das KI-Modell auf deinem Laptop aus. Deine Fragen, ' +
    'Dokumente, Embeddings und Chat-Verläufe bleiben lokal — auch mit aktiviertem ' +
    'Internetzugriff nutzen nur Modell-Downloads das Netzwerk.',
  'privacy.statement.noUploads':
    'Diese App sendet deine Daten an keine Cloud-KI-Anbieter. Es gibt keine Uploads von ' +
    'Fragen, Dokumenten oder Embeddings, keine Telemetrie, keine Analytik und keine ' +
    'Fehlerberichte an externe Server.',
  'privacy.network.title': 'Aktueller Netzwerkstatus',
  'privacy.networkState.noPolicy': 'Der Offline-Modus ist an.',
  'privacy.networkState.disabledByPolicy': 'Netzwerkzugriff durch Richtlinie deaktiviert.',
  'privacy.networkState.offDefault': 'Der Offline-Modus ist an (Netzwerk standardmäßig aus).',
  'privacy.networkState.enabled':
    'Internetzugriff ist für Modell-Downloads und Updates aktiviert.',
  'privacy.network.noFiles': 'Keine Fragen oder Dateien verlassen dieses Gerät.',
  'privacy.network.effective': 'Effektiver Zustand',
  'privacy.network.effectiveOffline': 'Offline (keine Netzwerkzugriffe)',
  'privacy.network.effectiveAllowed': 'Netzwerk erlaubt',
  'privacy.network.byPolicy': 'Durch Richtlinie erlaubt',
  'privacy.network.policyYes': 'Ja',
  'privacy.network.policyNo': 'Nein (durch Richtlinie deaktiviert)',
  'privacy.network.yourSetting': 'Deine Einstellung',
  'privacy.network.settingAllowed': 'Internetzugriff erlaubt',
  'privacy.network.settingOff': 'Aus (Standard)',
  'privacy.network.telemetry': 'Telemetrie',
  'privacy.network.telemetryValue':
    'Nichts verlässt dieses Laufwerk — es gibt kein Tracking, das man abschalten müsste',
  'privacy.network.hint':
    'Die App warnt vor jeder Netzwerkaktion. Die einzige optionale Netzwerkfunktion ist ' +
    'das Herunterladen oder Aktualisieren von Modellen — standardmäßig aus und nur über ' +
    'den Allgemein-Tab aktivierbar. Eine Laufwerksrichtlinie kann sie komplett deaktivieren.',
  'privacy.data.title': 'Wo deine Daten liegen',
  'privacy.data.driveRoot': 'Laufwerksstamm',
  'privacy.data.workspace': 'Arbeitsbereich',
  'privacy.data.models': 'Modelle',
  'privacy.data.logs': 'Logs',
  'privacy.data.loading': 'Pfade werden geladen…',
  'privacy.data.hint':
    'Alles — importierte Dokumente, extrahierter Text, Embeddings, Chat-Verläufe, ' +
    'erzeugte Ausgaben, Einstellungen — liegt lokal in deinem Arbeitsbereich. Zum ' +
    'Löschen entfernst du den Arbeitsbereich-Ordner.',
  'privacy.logs.title': 'Nur lokale Logs',
  'privacy.logs.hintBefore':
    'Debug- und Diagnose-Logs werden in eine rotierende Datei im Logs-Ordner oben ' +
    'geschrieben und ',
  'privacy.logs.never': 'niemals hochgeladen',
  'privacy.logs.hintAfter': '. Die Diagnose überträgt nichts von diesem Gerät.',
  'privacy.protection.title': 'Arbeitsbereich-Schutz',
  'privacy.protection.encryptedBefore': 'Dein Arbeitsbereich ist im ',
  'privacy.protection.encryptedWord': 'verschlüsselten',
  'privacy.protection.encryptedAfter': ' Modus.',
  'privacy.protection.plainBefore': 'Dein Arbeitsbereich ist im ',
  'privacy.protection.plainWord': 'unverschlüsselten Entwicklermodus',
  'privacy.protection.plainAfter':
    '. Dateien liegen für schnellere Entwicklung unverschlüsselt auf dem Laufwerk.',
  'privacy.protection.plainWarning':
    'Der unverschlüsselte Entwicklermodus ist nicht der Standard der Kaufversion. ' +
    'Kommerzielle Laufwerke verwenden den verschlüsselten Modus — Schlüssel aus dem ' +
    'Passwort abgeleitet, nichts unverschlüsselt gespeichert. Lege keine sensiblen ' +
    'Dokumente im unverschlüsselten Modus auf einem geteilten oder Wechsellaufwerk ab.',

  // ---- Settings → Diagnostics tab ----
  'diag.localOnly': 'Nur lokale Diagnose. Nichts hiervon wird jemals hochgeladen.',
  'diag.audit.runtime_started': 'Modell gestartet',
  'diag.audit.runtime_stopped': 'Modell gestoppt',
  'diag.audit.runtime_crashed': 'Modell unerwartet beendet',
  'diag.audit.runtime_fallback': 'Kompatibilitätsmodus',
  'diag.audit.model_selected': 'Modell ausgewählt',
  'diag.audit.model_verified': 'Modell-Prüfsumme geprüft',
  'diag.audit.model_download_started': 'Download gestartet',
  'diag.audit.model_download_verified': 'Download verifiziert',
  'diag.audit.model_download_failed': 'Download fehlgeschlagen',
  'diag.audit.document_imported': 'Dokument importiert',
  'diag.audit.document_reindexed': 'Dokument neu indexiert',
  'diag.audit.document_deleted': 'Dokument gelöscht',
  'diag.audit.document_task_completed': 'Dokumentaufgabe abgeschlossen',
  'diag.audit.document_task_failed': 'Dokumentaufgabe fehlgeschlagen',
  'diag.audit.document_exported': 'Dokument exportiert',
  'diag.audit.summary_exported': 'Zusammenfassung exportiert',
  'diag.audit.conversation_deleted': 'Unterhaltung gelöscht',
  'diag.audit.conversation_exported': 'Unterhaltung exportiert',
  'diag.audit.workspace_created': 'Arbeitsbereich erstellt',
  'diag.audit.workspace_unlocked': 'Arbeitsbereich entsperrt',
  'diag.audit.workspace_locked': 'Arbeitsbereich gesperrt',
  'diag.audit.workspace_unlock_failed': 'Entsperrversuch fehlgeschlagen',
  'diag.audit.workspace_password_changed': 'Arbeitsbereich-Passwort geändert',
  'diag.audit.settings_changed': 'Einstellungen geändert',
  'diag.audit.policy_warning': 'Richtlinien-Hinweis',
  'diag.audit.offline_guard_violation': 'Netzwerkversuch bemerkt',
  'diag.audit.collection_created': 'Projekt erstellt',
  'diag.audit.collection_renamed': 'Projekt umbenannt',
  'diag.audit.collection_archived': 'Projektarchiv geändert',
  'diag.audit.collection_deleted': 'Projekt gelöscht',
  'diag.audit.documents_added_to_collection': 'Dokumente zu einer Sammlung hinzugefügt',
  'diag.audit.documents_removed_from_collection': 'Dokumente aus einer Sammlung entfernt',
  'diag.audit.document_lifecycle_changed': 'Dokumentstatus geändert',
  'diag.audit.skill_imported': 'Skill importiert',
  'diag.audit.skill_deleted': 'Skill gelöscht',
  'diag.audit.skill_enabled': 'Skill aktiviert',
  'diag.audit.skill_disabled': 'Skill deaktiviert',
  'diag.audit.skill_run_started': 'Skill-Tool gestartet',
  'diag.audit.skill_run_done': 'Skill-Tool abgeschlossen',
  'diag.audit.skill_run_failed': 'Skill-Tool fehlgeschlagen',
  'diag.accel.gpuFallbackName': 'Grafikkarte',
  'diag.accel.gpu': '{name} (GPU)',
  'diag.accel.mock': 'Eingebauter Demo-Modus',
  'diag.accel.cpu': 'CPU',
  'diag.accel.gpuAvailable': '{name} (GPU verfügbar)',
  'diag.app.title': 'App & Laufzeit',
  'diag.app.version': 'App-Version',
  'diag.app.unknown': 'unbekannt',
  'diag.app.selectedModel': 'Ausgewähltes Modell',
  'diag.app.noneSelected': 'keins ausgewählt',
  'diag.app.profile': 'Hardware-Profil',
  'diag.app.runtime': 'Laufzeit',
  'diag.app.unknownModel': 'unbekanntes Modell',
  'diag.app.onPort': ' auf 127.0.0.1:{port}',
  'diag.app.healthy': 'in Ordnung',
  'diag.app.unhealthy': 'gestört',
  'diag.app.runtimeRunning': 'Läuft — {model}{onPort} ({health})',
  'diag.app.stopped': 'Gestoppt',
  'diag.app.acceleration': 'Beschleunigung',
  'diag.app.runtimeBuild': 'Laufzeit-Build',
  'diag.app.noInstallMarker': 'kein Installations-Marker (manuell bestücktes Laufwerk)',
  'diag.gpu.compat':
    'Kompatibilitätsmodus aktiv: Antworten nutzen die CPU — das funktioniert auf jedem ' +
    'Gerät.',
  'diag.gpu.tryHint':
    'Wenn du deinen Grafiktreiber aktualisiert hast, kannst du es erneut mit der ' +
    'Grafikkarte versuchen.',
  'diag.gpu.offHint':
    'Die Grafikbeschleunigung ist in den Einstellungen ausgeschaltet — schalte sie dort ' +
    'wieder ein, um die Grafikkarte zu verwenden.',
  'diag.gpu.tryAgain': 'GPU erneut versuchen',
  'diag.refresh': 'Aktualisieren',
  'diag.bench.title': 'Hardware-Benchmark',
  'diag.bench.hint':
    'Misst RAM, CPU und Laufwerksgeschwindigkeit dieses Geräts, um ein Modell zu ' +
    'empfehlen. Läuft komplett offline — keine Daten verlassen dein Gerät.',
  'diag.bench.running': 'Läuft…',
  'diag.bench.rerun': 'Benchmark erneut ausführen',
  'diag.bench.run': 'Benchmark ausführen',
  'diag.bench.failed': 'Benchmark fehlgeschlagen: {error}',
  'diag.bench.profile': 'Zugewiesenes Profil',
  'diag.bench.recommended': 'Empfohlenes Modell',
  'diag.bench.noMatch': 'Kein passendes Modell',
  'diag.bench.ram': 'RAM',
  'diag.bench.cpu': 'CPU',
  'diag.bench.cores': ' ({count} Kerne)',
  'diag.bench.osArch': 'OS / Architektur',
  'diag.bench.gpu': 'GPU',
  'diag.bench.notDetected': 'nicht erkannt',
  'diag.bench.driveRead': 'Laufwerk lesen',
  'diag.bench.driveWrite': 'Laufwerk schreiben',
  'diag.bench.notMeasured': 'nicht gemessen',
  'diag.bench.tokens': 'Tokens / Sek.',
  'diag.bench.tokensNotMeasured': 'nicht gemessen (starte zuerst ein Modell)',
  'diag.bench.lastRun': 'Letzter Lauf',
  'diag.system.title': 'System',
  'diag.system.osPlatform': 'OS / Plattform',
  'diag.system.freeSpace': 'Freier Speicher',
  'diag.system.loadFailed':
    'Systemdetails konnten noch nicht geladen werden. Öffne den Tab noch einmal.',
  'diag.paths.title': 'Pfade',
  'diag.paths.prepared': 'Vorbereitetes Laufwerk',
  'diag.paths.yes': 'Ja',
  'diag.paths.noFallback': 'Nein (App-Daten-Fallback)',
  'diag.paths.writable': 'Beschreibbar',
  'diag.paths.no': 'Nein',
  'diag.paths.loadFailed':
    'Laufwerks- und Arbeitsbereich-Details konnten noch nicht geladen werden. Öffne den ' +
    'Tab noch einmal.',
  'diag.activity.title': 'Aktivität',
  'diag.activity.hint':
    'Eine lokale Aufzeichnung dessen, was die App getan hat — Modell-Starts, Downloads, ' +
    'Dokument-Importe, Arbeitsbereich-Ereignisse. Sie bleibt in deinem Arbeitsbereich ' +
    '(verschlüsselt, wenn er es ist) und wird nie hochgeladen. Sie enthält nie Chat-Text ' +
    'oder Dokumentinhalte.',
  'diag.activity.show': 'Aktivität anzeigen',
  'diag.activity.hide': 'Aktivität ausblenden',
  'diag.activity.export': 'In Datei exportieren…',
  'diag.activity.savedTo': 'Aktivitätslog gespeichert unter {path}',
  'diag.activity.filterShow': 'Anzeigen',
  'diag.activity.filterAll': 'Alle Aktivitäten',
  'diag.activity.loading': 'Wird geladen…',
  'diag.activity.empty':
    'Noch nichts aufgezeichnet — Aktivität erscheint hier, während du die App verwendest.',
  'diag.activity.earlier': 'Frühere Aktivität anzeigen',
  'diag.logs.title': 'Aktuelle Logs',
  'diag.logs.hintBefore': 'Das Ende von ',
  'diag.logs.hintAfter':
    ' auf diesem Gerät. Logs bleiben lokal und werden nie hochgeladen; sie enthalten ' +
    'keine Dokumentinhalte und keinen Chat-Text.',
  'diag.logs.show': 'Logs anzeigen',
  'diag.logs.hide': 'Logs ausblenden',
  'diag.logs.empty': '(Log ist leer)',
  'diag.logs.save': 'In Datei speichern…',
  'diag.logs.savedTo': 'Logs gespeichert unter {path}',
  // Kopieren der Diagnose-Karten (Details an den Support weitergeben).
  'diag.copy': 'Kopieren',
  'diag.copyTitle': 'Diese Details in die Zwischenablage kopieren',
  'diag.copied': 'In die Zwischenablage kopiert',
  'diag.copyFailed': 'Kopieren in die Zwischenablage nicht möglich',

  // ---- Shared components' built-in copy ----
  'common.dismiss': 'Ausblenden',
  'common.close': 'Schließen',
  'common.cancel': 'Abbrechen',
  'common.remove': 'Entfernen',
  'indicator.offline': 'Lokal · Offline',
  'indicator.online': 'Lokal · Downloads erlaubt',
  'indicator.offlineDetail':
    'Alles bleibt auf diesem Laufwerk. Es wird keine Internetverbindung verwendet.',
  'indicator.onlineDetail': 'Downloads erlaubt — Chats und Dokumente bleiben lokal.',
  // Kurzlabels für die Anzeige am Fuß der App-Leiste (§12.1 #2) — die volle „Lokal · …"-Form
  // ist zu breit für die 100px-Leiste; die Leiste zeigt nur den effektiven Zustand
  // (Symbol + ein Wort), die volle Beruhigung steht im Tooltip.
  'indicator.short.offline': 'Offline',
  'indicator.short.online': 'Downloads an',

  // ---- Shared password copy ----
  'password.mismatch': 'Die Passwörter stimmen nicht überein.',
  'password.show': 'Passwort anzeigen',
  'password.hide': 'Passwort verbergen',
  'password.strength.tooShort': 'Zu kurz',
  'password.strength.weak': 'Schwach',
  'password.strength.okay': 'Okay',
  'password.strength.strong': 'Stark',
  'password.strength.veryStrong': 'Sehr stark',
  'password.strength.minHint': 'Verwende mindestens 8 Zeichen.',
  'password.strength.longerHint':
    'Länger ist stärker — 12 oder mehr Zeichen oder ein paar zusammenhanglose Wörter ' +
    'funktionieren gut.',

  // ---- Workspace gate ----
  'gate.passwordPlaceholder': 'Passwort',
  'gate.unlock.title': 'Arbeitsbereich entsperren',
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
  'gate.finishing.progress': 'KI-Modell {n} von {m} wird geprüft: {name} — {pct} %',
  'gate.finishing.skip': 'Überspringen — direkt zur App',
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

  // ---- Main-process strings (Phase 41, §3.3 two-rule boundary) ----
  // Persist-canonical set (D-L4): the DB keeps the ENGLISH value; these German values
  // are what the renderer display map shows instead.
  'main.ingest.pdfScanDetected':
    'Dieses PDF sieht aus wie ein Scan — es enthält noch keinen lesbaren Text.',
  'main.ingest.audioNeedsTranscriber':
    'Für den Audio-Import wird das Transkriptionsmodell benötigt — lade es im ' +
    'KI-Modell-Bereich herunter.',
  'main.ingest.audioUnreadable':
    'Diese Audiodatei konnte nicht gelesen werden. Wandle sie in WAV oder MP3 um und ' +
    'importiere sie noch einmal.',
  'main.ingest.audioTranscriptionFailed':
    'Die Aufnahme konnte nicht transkribiert werden. Indexiere dieses Dokument neu, um es ' +
    'noch einmal zu versuchen.',
  'main.ingest.imageNeedsOcr':
    'Für den Foto-Import werden die Texterkennungs-Dateien (OCR) benötigt, die auf diesem ' +
    'Laufwerk fehlen.',
  'main.ingest.imageNoText':
    'In diesem Foto wurde kein lesbarer Text gefunden. Versuch es mit einem schärferen, ' +
    'näheren Bild der Seite.',
  'main.ingest.imageOcrFailed':
    'Dieses Foto konnte nicht gelesen werden. Indexiere es neu, um es noch einmal zu versuchen.',
  'main.ingest.sourceMissing': 'Die Quelldatei wurde nicht gefunden.',
  'main.ingest.interrupted':
    'Die Indexierung wurde unterbrochen, bevor sie fertig war. Indexiere neu, um es noch ' +
    'einmal zu versuchen.',
  'main.ingest.fileTooLarge':
    'Diese Datei ist zu groß, um sie sicher zu importieren. Teile sie in kleinere Dateien ' +
    'auf und versuche es noch einmal.',
  'main.ingest.tooManyChunks':
    'Dieses Dokument ist zu groß, um es vollständig zu indexieren. Teile es in kleinere ' +
    'Dateien auf und importiere die Teile.',
  'main.ingest.parseTimeout':
    'Diese Datei hat zu lange gebraucht und wurde übersprungen. Sie ist möglicherweise ' +
    'beschädigt oder extrem groß.',
  // Interpolierter persist-kanonischer Text ({ext}); kein Exakt-Match — die Display-Map
  // im Renderer erkennt ihn per Vorlagen-Regex und setzt {ext} sprachabhängig ein.
  'main.ingest.unsupportedType':
    'Dieser Dateityp wird nicht unterstützt ({ext}). Versuch TXT, PDF, DOCX, CSV oder ein ' +
    'unterstütztes Audioformat.',
  'main.rag.noContext':
    'Dazu habe ich in deinen Dokumenten nichts gefunden. Formuliere deine Frage anders oder ' +
    'prüf, welche Dokumente du gerade fragst.',
  'main.rag.reindexNeeded':
    'Deine Dokumente brauchen eine kurze Neuindexierung, bevor sie durchsucht werden können ' +
    '— sie wurden mit einem anderen Suchmodell indexiert. Öffne den Dokumente-Bereich und ' +
    'wähle „Neu indexieren“.',
  'main.chat.docTaskBusy':
    'Eine Dokumentaufgabe läuft gerade. Du kannst sie abbrechen oder warten, bis sie fertig ' +
    'ist, bevor du chattest.',
  'main.chat.defaultTitle': 'Neuer Chat',
  'main.benchmark.warnTiny':
    'Dieses Gerät eignet sich am besten für das kleinste, schnellste Modell. Größere ' +
    'Modelle laufen möglicherweise langsam.',
  'main.benchmark.warnUnknown':
    'Wir konnten diese Hardware nicht vollständig erkennen und haben deshalb ein sicheres, ' +
    'leichtes Modell gewählt. Du kannst jederzeit ein größeres Modell ausprobieren.',
  'main.benchmark.warnDriveProbe':
    'Die Laufwerksgeschwindigkeit konnte nicht gemessen werden, die Empfehlung nutzt daher ' +
    'nur RAM und CPU.',
  'main.benchmark.warnSlowDrive':
    'Dieses Laufwerk ist eher langsam. Modelle funktionieren trotzdem, das Laden kann aber ' +
    'länger dauern.',
  'main.benchmark.locked': 'Der Arbeitsbereich ist gesperrt. Entsperre ihn, um den Benchmark auszuführen.',

  // Emission set (D-L5): localized at the emission site via tMain().
  'main.workspace.wrongPassword':
    'Dieses Passwort hat deinen Arbeitsbereich nicht entsperrt. Prüf es und versuch es ' +
    'noch einmal.',
  'main.workspace.openFailed': 'Der Arbeitsbereich konnte nicht geöffnet werden.',
  'main.workspace.createFailed': 'Der Arbeitsbereich konnte nicht erstellt werden.',
  'main.workspace.passwordTooShort': 'Das Passwort muss mindestens {min} Zeichen lang sein.',
  'main.workspace.newPasswordTooShort':
    'Das neue Passwort muss mindestens {min} Zeichen lang sein.',
  'main.workspace.unlockBeforeChange':
    'Entsperre den Arbeitsbereich, bevor du das Passwort änderst.',
  'main.workspace.wrongCurrentPassword':
    'Das stimmt nicht mit deinem aktuellen Passwort überein. Prüf es und versuch es noch einmal.',
  'main.workspace.changeFailed':
    'Das Passwort konnte nicht geändert werden. Dein aktuelles Passwort funktioniert weiterhin.',
  'main.workspace.busyPasswordChange':
    'Das Passwort des Arbeitsbereichs wird gerade geändert. Versuch es gleich noch einmal.',
  'main.runtime.compatibilityMode':
    'Aus Stabilitätsgründen in den Kompatibilitätsmodus gewechselt. Alles funktioniert ' +
    'weiter — Antworten können etwas langsamer sein.',
  'main.noModelRunning':
    'Es läuft kein KI-Modell. Öffne den KI-Modell-Bereich und starte zuerst eines.',
  'main.model.contextExceeded':
    'Das ist zu groß für das Kontextfenster des aktuellen Modells. Wähle ein Modell mit größerem Kontext oder ein kleineres Dokument.',
  'main.chat.streamInFlight': 'Für diese Unterhaltung wird bereits eine Antwort erstellt.',
  'main.chat.nothingToRegenerate': 'Es gibt noch keine Antwort, die neu erstellt werden könnte.',
  'main.chat.emptyMessage': 'Eine leere Nachricht kann nicht gesendet werden.',
  'main.chat.emptyQuestion': 'Eine leere Frage kann nicht gesendet werden.',
  'main.chat.stopFirst':
    'Für diese Unterhaltung wird noch eine Antwort erstellt. Stoppe sie zuerst.',
  'main.chat.locked': 'Der Arbeitsbereich ist gesperrt. Entsperre ihn, um zu chatten.',
  'main.task.unknownKind': 'Unbekannte Dokumentaufgabe.',
  'main.task.refusedChatStreaming':
    'Gerade wird eine Antwort geschrieben. Warte, bis sie fertig ist (oder stoppe sie), und ' +
    'versuch es dann noch einmal.',
  'main.task.comparePickTwo': 'Wähle genau zwei Dokumente zum Vergleichen aus.',
  'main.task.compareReindex':
    'Diese Dokumente brauchen eine kurze Neuindexierung, bevor sie verglichen werden können ' +
    '— mindestens eines wurde mit einem anderen Suchmodell vorbereitet. Öffne den ' +
    'Dokumente-Bereich, wähle „Neu indexieren“ und versuch es dann noch einmal.',
  'main.task.documentNotReady':
    'Dieses Dokument enthält noch keinen lesbaren Text. Importiere oder indexiere es zuerst ' +
    'neu und versuch es dann noch einmal.',
  'main.task.genericFailure':
    'Die Aufgabe konnte nicht abgeschlossen werden. Stell sicher, dass das Modell noch ' +
    'läuft, und versuch es dann noch einmal.',
  'main.task.expired': 'Diese Aufgabe ist nicht mehr verfügbar.',
  'main.task.translationTarget': 'Wähle eine Übersetzungssprache: Deutsch oder Englisch.',
  'main.task.sourceUnreadable':
    'Die gespeicherte Kopie dieses Dokuments konnte nicht gelesen werden. Importiere das ' +
    'Dokument neu und versuch es dann noch einmal.',
  'main.task.needsOcr':
    'Für die Texterkennung werden die OCR-Dateien benötigt, die auf diesem Laufwerk fehlen.',
  'main.task.ocrNotAScan':
    'Nur ein PDF, das als Scan erkannt wurde, kann auf diesem Weg durchsuchbar gemacht werden.',
  'main.task.ocrNoText':
    'In diesem Scan wurde kein lesbarer Text gefunden. Die Seiten sind vielleicht leer oder ' +
    'zu unscharf.',
  'main.task.ocrFailed':
    'Dieser Scan konnte nicht gelesen werden. Stell sicher, dass das Dokument noch auf dem ' +
    'Laufwerk ist, und versuch es dann noch einmal.',
  'main.task.pickOneTranslate': 'Wähle genau ein Dokument zum Übersetzen aus.',
  'main.task.pickOneOcr':
    'Wähle genau ein gescanntes PDF aus, das durchsuchbar gemacht werden soll.',
  'main.task.pickOneSummarize': 'Wähle genau ein Dokument zum Zusammenfassen aus.',
  'main.task.unavailable': 'Dokumentaufgaben sind nicht verfügbar.',
  'main.task.workspaceLocked':
    'Der Arbeitsbereich ist gesperrt. Entsperre ihn, um mit Dokumenten zu arbeiten.',
  'main.download.policyDisabled':
    'Downloads sind durch die Richtlinie dieses Laufwerks deaktiviert.',
  'main.download.networkOff':
    'Der Internetzugriff ist ausgeschaltet. Schalte zuerst „Internetzugriff für ' +
    'Modell-Downloads und Updates erlauben“ in den Einstellungen ein.',
  'main.download.alreadyRunning':
    'Es läuft bereits ein Download. Modelle werden einzeln heruntergeladen.',
  'main.download.noSource': 'Das Modell „{modelId}“ hat keine Download-Quelle in seinem Manifest.',
  'main.download.alreadyVerified': 'Dieses Modell ist bereits heruntergeladen und verifiziert.',
  'main.download.presentUnverified':
    'Die Datei dieses Modells ist bereits vorhanden. Ihr Manifest enthält noch keine echte ' +
    'Prüfsumme, daher kann sie nicht verifiziert werden — erfasse eine mit ' +
    'verify-models --generate.',
  'main.download.licenseFirst':
    'Bitte sieh dir die Lizenz des Modells an ({license}) und akzeptiere sie, bevor du es ' +
    'herunterlädst.',
  'main.download.unknownJob': 'Unbekannter Download.',
  'main.download.checksumMismatch':
    'Die heruntergeladene Datei entsprach nicht der erwarteten Prüfsumme und wurde deshalb ' +
    'verworfen. Bitte versuch es noch einmal.',
  'main.download.fileMissing':
    'Die heruntergeladene Datei war vor der Verifizierung nicht mehr auffindbar.',
  'main.download.httpFailed':
    'Der Download konnte nicht starten ({reason}). Prüf die Verbindung und versuch es ' +
    'noch einmal.',
  'main.download.interrupted':
    'Der Download wurde unterbrochen ({reason}). Der fertige Teil bleibt erhalten — beim ' +
    'nächsten Start wird dort weitergemacht.',
  'main.engine.alreadyRunning': 'Die KI-Engine wird bereits heruntergeladen.',
  'main.engine.noSources':
    'Auf diesem Laufwerk wurden keine Engine-Quellen gefunden (runtime-sources.yaml fehlt).',
  'main.engine.noHostBuild': 'Für diesen Computer ist keine KI-Engine verfügbar.',
  'main.engine.alreadyInstalled': 'Die KI-Engine ist bereits installiert.',
  'main.engine.unknownJob': 'Unbekannter Engine-Download.',
  'main.engine.checksumMismatch':
    'Die heruntergeladene Engine entsprach nicht ihrer erwarteten Prüfsumme und wurde verworfen. ' +
    'Bitte versuche es erneut.',
  'main.engine.fileMissing': 'Die heruntergeladene Engine fehlte, bevor sie geprüft werden konnte.',
  'main.engine.binaryMissing':
    'Die Engine wurde heruntergeladen, konnte aber nicht entpackt werden (das Archivformat hat sich evtl. geändert).',
  'main.engine.extractFailed':
    'Die KI-Engine wurde heruntergeladen, konnte aber nicht entpackt werden. Bitte versuche es erneut.',
  'main.engine.httpFailed':
    'Der Engine-Download konnte nicht starten ({reason}). Bitte prüfe die Verbindung und versuche es erneut.',
  'main.engine.interrupted': 'Der Engine-Download wurde unterbrochen ({reason}). Bitte versuche es erneut.',
  'main.docs.locked': 'Der Arbeitsbereich ist gesperrt. Entsperre ihn, um Dokumente zu verwalten.',
  'main.docs.processing':
    'Dieses Dokument wird noch verarbeitet. Warte, bis der Import fertig ist.',
  'main.docs.taskRunning':
    'Für dieses Dokument läuft eine Aufgabe. Brich sie ab oder warte, bis sie fertig ist.',
  'main.docs.previewEncrypted':
    'Dieses Dokument ist verschlüsselt; entsperre den Arbeitsbereich, um es anzusehen.',
  'main.docs.previewGone':
    'Die Dokumentdatei ist nicht mehr vorhanden. Importiere sie neu, um sie anzusehen.',
  'main.docs.exportTextOnly':
    'Nur Textdokumente (Markdown, TXT, CSV) können auf diesem Weg exportiert werden.',
  'main.docs.exportEncrypted':
    'Dieses Dokument ist verschlüsselt; entsperre den Arbeitsbereich, um es zu exportieren.',
  'main.docs.exportGone':
    'Die Dokumentdatei ist nicht mehr vorhanden. Importiere sie neu, um sie zu exportieren.',
  'main.docs.noStoredTranscript':
    'Für diese Aufnahme ist noch kein Transkript gespeichert. Indexiere sie neu, um sie ' +
    'noch einmal zu transkribieren.',
  'main.models.noManifests':
    'Auf diesem Laufwerk wurde keine Modellliste gefunden — der Ordner model-manifests fehlt.',
  'main.models.autoSelected':
    'Dieses Modell wird automatisch verwendet, sobald es installiert ist — es gibt nichts ' +
    'auszuwählen.',
  // F16 (audit-postmerge-2026-06-29) — siehe en.ts.
  'main.models.locked': 'Der Arbeitsbereich ist gesperrt. Entsperre ihn, um KI-Modelle zu verwalten.',
  'main.audit.locked': 'Der Arbeitsbereich ist gesperrt. Entsperre ihn, um die Aktivität anzuzeigen.',
  'main.settings.locked':
    'Der Arbeitsbereich ist gesperrt. Entsperre ihn, um die Einstellungen zu ändern.',
  // S3 (full-audit-2026-06-30) — siehe en.ts.
  'main.dictation.locked':
    'Der Arbeitsbereich ist gesperrt. Entsperre ihn, um die Spracheingabe zu verwenden.',
  'main.preflight.readOnly':
    'Dieses Laufwerk scheint schreibgeschützt zu sein, daher kann die App ihren ' +
    'Arbeitsbereich nicht anlegen. Versuch einen anderen USB-Anschluss oder sieh in der ' +
    'Anleitung zur Fehlerbehebung nach.',
  'main.preflight.lowSpace':
    'Auf diesem Laufwerk ist wenig freier Speicherplatz. Du kannst trotzdem fortfahren, ' +
    'aber der Import großer Dokumente kann fehlschlagen, bis du Platz schaffst.',
  'main.dialog.importDocuments': 'Dokumente importieren',
  'main.dialog.importFolder': 'Einen Ordner mit Dokumenten importieren',
  'main.dialog.exportDocument': 'Dokument exportieren',
  'main.dialog.exportSummary': 'Zusammenfassung exportieren',
  'main.dialog.exportChat': 'Chat-Verlauf exportieren',
  'main.dialog.exportAudit': 'Aktivitätslog exportieren',
  'main.dialog.exportLog': 'Diagnose-Logs speichern',
  'main.dialog.filterDocuments': 'Dokumente',
  'main.dialog.filterAll': 'Alle Dateien',
  'main.dialog.chooseImage': 'Bild auswählen',
  'main.dialog.filterImages': 'Bilder',
  'main.dialog.importSkill': 'Ein Skill-Paket importieren',
  'main.dialog.importSkillFolder': 'Einen Skill-Ordner importieren',
  'main.dialog.exportSkill': 'Skill exportieren',
  'main.dialog.filterSkill': 'Skill-Paket',
  'main.dialog.exportCsv': 'Transaktionen exportieren',
  'main.dialog.filterCsv': 'CSV-Datei',
  // U5 (Audit §6.2): eigene Speicherdialog-Metadaten je Export — der EINE fest verdrahtete CSV-Dialog
  // diente zuvor jedem Export (die Schwärzung „Geschwärzte Kopie speichern“ bekam den Titel
  // „Transaktionen exportieren“ + einen .csv-Filter). Jedes Format nennt jetzt Titel/Filter/Endung selbst.
  'main.dialog.exportJson': 'Als JSON exportieren',
  'main.dialog.filterJson': 'JSON-Datei',
  'main.dialog.exportXml': 'Als XML exportieren',
  'main.dialog.filterXml': 'XML-Datei',
  'main.dialog.exportRedacted': 'Geschwärzte Kopie speichern',
  'main.dialog.filterText': 'Textdatei',
  'main.collections.builtinUndeletable':
    'Die integrierte Bibliothek und „Temporär“ können nicht gelöscht werden.',
  'main.skills.locked': 'Der Arbeitsbereich ist gesperrt. Entsperre ihn, um Skills zu verwalten.',
  'main.skills.incompatible': 'Dieser Skill benötigt eine neuere Version der App. Aktualisiere sie, um ihn zu nutzen.',
  // Tier-2-Tool-Läufe (skills plan §12.2, S11b) – freundlich, ohne Inhalte.
  'main.skills.run.unavailable': 'Das Tool dieses Skills ist gerade nicht verfügbar.',
  'main.skills.run.noDocument': 'Füge diesem Chat zuerst ein Dokument hinzu und versuche es dann erneut.',
  'main.skills.run.busy': 'Ein Skill arbeitet bereits. Lass ihn fertig werden oder brich ihn ab.',
  // U-1: eine vom Renderer übergebene Ziel-ID, die nicht im neu aufgelösten Bereich liegt (eine
  // defensive Absicherung – der Renderer bietet nur Dokumente aus dem Bereich an). Freundlich + inhaltsfrei.
  'main.skills.run.documentOutOfScope':
    'Dieses Dokument gehört nicht zu den Dokumenten dieses Chats. Wähle eines davon und versuche es erneut.',

  // ---- Dokumentorganisation — Bereiche + Aktionen (Plan §12). D-L7-Review erledigt (2026-06-14). ----
  'docs.section.heading': 'Bereiche',
  'docs.section.library': 'Bibliothek',
  'docs.section.projects': 'Projekte',
  // Gruppenüberschrift über den System-Ablagen (Bibliothek / Temporär / Erstellt / Archiviert), §11.6.
  'docs.section.locations': 'Speicherorte',
  'docs.section.temporary': 'Temporär',
  'docs.section.generated': 'Erstellt',
  'docs.section.archived': 'Archiviert',
  'docs.section.all': 'Alle Dokumente',
  'docs.section.noProjects': 'Noch keine Projekte',
  'docs.section.newProject': 'Neues Projekt',
  'docs.section.collapse': 'Bereiche',
  // Die gesamte Dokumente-Unternavigation ein-/ausklappen (§11.6 — die Liste nutzt dann die volle Breite).
  'docs.rail.hide': 'Bereiche ausblenden',
  'docs.rail.show': 'Bereiche einblenden',
  'docs.project.createTitle': 'Projekt erstellen',
  'docs.project.namePlaceholder': 'Projektname',
  'docs.project.nameAria': 'Projektname',
  'docs.project.create': 'Erstellen',
  'docs.project.rename': 'Umbenennen',
  'docs.project.renameTitle': 'Projekt umbenennen',
  'docs.project.archive': 'Archivieren',
  'docs.project.unarchive': 'Aus dem Archiv holen',
  'docs.project.delete': 'Projekt löschen',
  'docs.project.deleteTitle': 'Dieses Projekt löschen?',
  'docs.project.deleteBody': 'Wähle, was mit den Dokumenten dieses Projekts geschehen soll:',
  'docs.project.deleteKeep': 'Nur das Projekt entfernen — Dokumente behalten',
  'docs.project.deleteKeepHint': 'Die Dokumente bleiben in deiner Bibliothek und in anderen Projekten.',
  'docs.project.deleteWith': 'Das Projekt und die nur hier abgelegten Dokumente löschen',
  'docs.project.deleteWithHint':
    'Nur Dokumente, die nicht in deiner Bibliothek oder einem anderen Projekt liegen, werden gelöscht. Bibliothekswissen bleibt unberührt.',
  'docs.project.deleteConfirm': 'Projekt löschen',
  'docs.project.archivedNote':
    'Archiviert — als Quelle ausgeblendet, die Dokumente bleiben aber anderswo beantwortbar.',
  'docs.project.options': 'Projektoptionen',
  'docs.action.addToProject': 'Zu Projekt hinzufügen…',
  'docs.action.moveToProject': 'In Projekt verschieben…',
  'docs.action.addToLibrary': 'In Bibliothek behalten',
  'docs.action.removeFromProject': 'Aus diesem Projekt entfernen',
  'docs.action.markTemporary': 'Als temporär markieren',
  'docs.action.markPermanent': 'Als dauerhaft markieren',
  'docs.action.archive': 'Archivieren',
  'docs.action.unarchive': 'Aus dem Archiv holen',
  'docs.action.chooseProject': 'Projekt auswählen',
  'docs.lifecycle.temporary': 'Temporär',
  'docs.lifecycle.archived': 'Archiviert',
  'docs.chip.library': 'Bibliothek',
  'docs.chip.temporary': 'Temporär',
  'docs.chip.generated': 'Erzeugt',
  'docs.chip.archived': 'Archiviert',
  'docs.bulk.selected.one': '{count} ausgewählt',
  'docs.bulk.selected.other': '{count} ausgewählt',
  'docs.selectionAria': 'Aktionen für die ausgewählten Dokumente',
  'docs.bulk.delete': 'Löschen',
  'docs.bulk.deleteConfirm.title.one': '{count} Dokument löschen?',
  'docs.bulk.deleteConfirm.title.other': '{count} Dokumente löschen?',
  'docs.bulk.deleteConfirm.body':
    'Damit werden die ausgewählten Dokumente, ihr extrahierter Text und ihr Suchindex ' +
    'dauerhaft aus deinem Arbeitsbereich entfernt. Die Originaldateien außerhalb des ' +
    'Arbeitsbereichs bleiben unberührt.',
  'docs.empty.section': 'Hier ist noch nichts.',

  // ---- Dokumentorganisation — intelligente Ansichten (Plan §7.6/§12.1, Phase E). ----
  // D-L7-Review erledigt (2026-06-14).
  'docs.smart.heading': 'Ansichten',
  'docs.smart.recentlyAdded': 'Kürzlich hinzugefügt',
  'docs.smart.unfiled': 'Nicht einsortiert',
  'docs.smart.needsReindex': 'Neu aufzubereiten',
  'docs.smart.largeFiles': 'Große Dateien',
  'docs.smart.failed': 'Fehlgeschlagen',
  'docs.smart.audio': 'Audio',
  'docs.smart.ocr': 'Gescannt / OCR',
  // „Mehr“-Aufklappen der Ansichten: die selteneren Diagnose-Ansichten klappen dahinter auf (§11.6).
  'docs.smart.more': 'Mehr',
  'docs.provenance.staleBadge': 'Veraltet',
  'docs.provenance.staleChanged': 'Eine Quelle hat sich seit der Erstellung geändert — zum Aktualisieren neu ausführen.',
  'docs.provenance.staleRemoved': 'Eine Quelle wurde seit der Erstellung entfernt — zum Aktualisieren neu ausführen.',

  // ---- Chat — zusammengesetzter Quellenbereich (Plan §13). D-L7-Review erledigt (2026-06-14). ----
  'chat.scope.using': 'Quelle: {sources}',
  'chat.scope.library': 'Bibliothek',
  'chat.scope.projectNamed': 'Projekt: {name}',
  'chat.scope.projectCount.one': '{count} Projekt',
  'chat.scope.projectCount.other': '{count} Projekte',
  'chat.scope.docCount.one': '{count} Dokument',
  'chat.scope.docCount.other': '{count} Dokumente',
  'chat.scope.filesInChat.one': '{count} Datei in diesem Chat',
  'chat.scope.filesInChat.other': '{count} Dateien in diesem Chat',
  'chat.scope.sourcesTitle': 'Wähle deine Quellen',
  'chat.scope.librarySource': 'Bibliothek',
  'chat.scope.librarySourceHint': 'Deine gesamte Wissensbasis',
  'chat.scope.specificToggle': 'Bestimmte Dokumente…',
  'chat.scope.allTap': 'Alle Dokumente',
  'chat.scope.filesInChatLine': 'Dateien in diesem Chat',
  'chat.scope.noProjects': 'Noch keine Projekte',
  'chat.scope.archivedFallback': 'Dieses Projekt wurde archiviert — Antwort aus deiner Bibliothek.',

  // ---- Chat — Datei an einen Chat anhängen / hineinziehen (Plan §11.2/§13.5, Phase C) ----
  // D-L7-Review erledigt (2026-06-14).
  'chat.attach.button': 'Dateien anhängen',
  'chat.attach.drop': 'Dateien hier ablegen, um sie in diesem Chat zu verwenden',
  'chat.attach.processing': '{name} wird verarbeitet…',
  'chat.attach.added': '{name} zu diesem Chat hinzugefügt',
  'chat.attach.newDocChat': 'Neuer Dokument-Chat für {name} gestartet',
  'chat.attach.failed': '{name} konnte diesem Chat nicht hinzugefügt werden.',
  // FE-C: ein Drop mit Dateien, der keine Datei auf der Festplatte ergab (z. B. aus dem Browser
  // gezogen) – wird angezeigt statt still zu scheitern (Begleitung zur FE-A-Korrektur).
  'chat.attach.dropUnsupported':
    'Konnte das nicht hinzufügen – bitte eine auf dem Computer gespeicherte Datei hierher ziehen.',

  // ---- Bilder — „Frag ein Bild" (image-understanding §5/§11, Phase V3) ----
  // Visuelles Verstehen EINES lokalen PNG/JPEG über ein lokales KI-Modell — getrennt von
  // OCR (Dokumente) und von jeder Bildgenerierung (nie gebaut). Nichts wird gespeichert.
  'images.title': 'Ein Bild verstehen',
  'images.empty.body':
    'Stell Fragen zu einem Screenshot, Diagramm, Formular, Beleg oder Foto. Alles bleibt lokal.',
  'images.avail.noModel': 'Bildverständnis braucht ein lokales KI-Bildmodell auf diesem Laufwerk.',
  'images.avail.noRuntime': 'Bildverständnis braucht zuerst die installierte KI-Engine.',
  'images.avail.incompatible': 'Das KI-Bildmodell dieses Laufwerks braucht eine neuere KI-Engine.',
  'images.avail.cta': 'Zum KI-Modell',
  'images.avail.ocrPointer': 'Gescannte Dokumente? Nutze „Durchsuchbar machen (OCR)" unter Dokumente.',
  'images.locked': 'Entsperre deinen Arbeitsbereich, um ein Bild zu verstehen.',
  'images.drop.title': 'Bild hier ablegen',
  'images.drop.choose': 'oder ein Bild auswählen',
  'images.drop.types': 'PNG oder JPEG',
  'images.drop.busy': 'Eine Analyse läuft. Warten Sie, bis sie fertig ist, um eine neue zu starten.',
  'images.back': 'Zurück zu den Analysen',
  'images.preview.remove': 'Entfernen',
  'images.preview.replace': 'Ersetzen',
  'images.preview.alt': 'Ausgewähltes Bild',
  'images.chip.summarize': 'Dieses Bild zusammenfassen',
  'images.chip.summarize.prompt':
    'Fasse den sichtbaren Inhalt dieses Bildes zusammen. Nenne alles Wichtige oder Ungewöhnliche.',
  'images.chip.extractText': 'Sichtbaren Text erfassen',
  'images.chip.extractText.prompt':
    'Erfasse den sichtbaren Text, den du lesen kannst. Erhalte Zeilenumbrüche, wo es hilft. Sag, wenn Text unklar ist.',
  'images.chip.explainChart': 'Dieses Diagramm erklären',
  'images.chip.explainChart.prompt':
    'Erkläre, was dieses Diagramm zu zeigen scheint. Nenne Achsen, Beschriftungen, Trends und jede Unsicherheit.',
  'images.chip.readForm': 'Dieses Formular lesen',
  'images.chip.readForm.prompt':
    'Nenne die wichtigsten sichtbaren Felder und Werte in diesem Formular. Schreibe „unklar", wo du etwas nicht lesen kannst.',
  'images.chip.importantDetails': 'Wichtige Details finden',
  'images.chip.importantDetails.prompt':
    'Liste die wichtigsten sichtbaren Details auf. Leite nichts ab, was nicht sichtbar ist.',
  'images.chip.whatNotice': 'Worauf sollte ich achten?',
  'images.chip.whatNotice.prompt':
    'Worauf sollte ich in diesem Bild achten? Nenne nur die auffälligsten sichtbaren Elemente.',
  'images.composer.placeholder': 'Frag etwas zu diesem Bild…',
  'images.composer.ask': 'Fragen',
  'images.answer.localNote': 'Lokal aus dem ausgewählten Bild erzeugt.',
  'images.answer.copy': 'Kopieren',
  'images.answer.copied': 'Kopiert',
  'images.answer.tryAgain': 'Erneut versuchen',
  'images.answer.reading': 'Bild wird gelesen…',
  'images.answer.starting': 'KI-Bildmodell wird gestartet…',
  'images.answer.stop': 'Stopp',
  'images.answer.stopped': 'Gestoppt.',
  'images.err.tooLarge': 'Dieses Bild ist zu groß zum Analysieren. Versuch ein kleineres Bild.',
  'images.err.unsupported': 'Dieser Dateityp wird nicht unterstützt. Wähle ein PNG oder JPEG.',
  'images.err.decodeFailed':
    'Dieses Bild konnte nicht geöffnet werden. Es ist vielleicht beschädigt oder hat ein nicht unterstütztes Format.',
  'images.err.multiDrop': 'Leg immer nur ein Bild ab.',
  'images.err.runtimeFailed':
    'Das KI-Bildmodell konnte nicht starten. Versuch es erneut oder wähle ein anderes Modell.',
  'images.err.emptyResponse':
    'Für dieses Bild kam keine Antwort zurück. Formulier deine Frage anders.',
  'images.err.busy': 'Die vorige Frage wird noch bearbeitet…',
  // Verlauf (Bildverständnis-Verlauf): gespeicherte Analysen, verschlüsselt, löschbar.
  'images.history.title': 'Verlauf',
  'images.history.empty': 'Analysierte Bilder erscheinen hier.',
  'images.history.running': 'Analyse läuft…',
  'images.history.runningOpen': 'Laufende Analyse ansehen',
  'images.history.turns.one': '{count} Frage',
  'images.history.turns.other': '{count} Fragen',
  'images.history.open': 'Öffnen',
  'images.history.delete': 'Löschen',
  'images.history.deleted': 'Aus dem Verlauf entfernt',
  'images.history.delete.title': 'Dieses Bild löschen?',
  'images.history.delete.confirm': 'Löschen',
  'images.history.delete.body':
    '„{title}“ und die zugehörigen Antworten werden dauerhaft von diesem Laufwerk entfernt.'
}
