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
  'app.fatal.title': 'Die App konnte nicht starten',
  'app.fatal.hintBefore':
    'Das lokale Backend ist nicht gestartet, daher kann nichts geladen werden. Starte die ' +
    'App neu; wenn das öfter passiert, prüfe ',
  'app.fatal.hintAfter': ' auf deinem Laufwerk und sieh in docs/troubleshooting.md nach.',
  'app.loadingWorkspace': 'Arbeitsbereich wird geladen…',

  // ---- Home ----
  'home.headline.ready': 'Bereit zum Chatten.',
  'home.headline.starting': 'Gleich bereit…',
  'home.headline.almost': 'Fast fertig eingerichtet.',
  'home.lead':
    'Ein privater KI-Arbeitsbereich, komplett offline. Deine Fragen, Dokumente und ' +
    'Chat-Verläufe bleiben auf diesem Gerät.',
  'home.preflight.continueBefore':
    'Du kannst trotzdem fortfahren. Wenn sich die App nicht öffnet, findest du die ' +
    'Anleitung zur Fehlerbehebung im Ordner ',
  'home.preflight.continueAfter': ' auf dem Laufwerk.',
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
  'chat.noModel.open': 'KI-Modell öffnen',
  'chat.noModel.recheck': 'Erneut prüfen',
  'chat.empty.title': 'Stell eine Frage — oder frag deine Dokumente.',
  'chat.empty.lineDocuments': 'Antworten kommen aus deinen Dokumenten und nennen ihre Quellen.',
  'chat.empty.lineChat':
    'Antworten kommen vom Modell auf diesem Laufwerk — nichts verlässt es.',
  'chat.empty.fillTitle': 'Text ins Eingabefeld übernehmen',
  'chat.empty.addDocs': 'Dokumente hinzufügen, um Fragen dazu zu stellen',
  'chat.example.summarize': 'Fasse diesen Vertrag zusammen',
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
  'chat.scopeNotice': 'Antwort nur aus {titles}',
  'chat.cancelDocTask': 'Dokumentaufgabe abbrechen',
  'chat.placeholder.documents': 'Frag deine Dokumente…',
  'chat.placeholder.chat': 'Nachricht…',
  'chat.send.ask': 'Fragen',
  'chat.send.send': 'Senden',
  'chat.composer.stop': 'Stopp',

  // ---- Chat: conversation list ----
  'chat.list.newChat': '+ Neuer Chat',
  'chat.list.newDocQa': '+ Neues Dokument-Q&A',
  'chat.list.hide': 'Unterhaltungsliste ausblenden',
  'chat.list.empty': 'Noch keine Unterhaltungen.',
  'chat.list.docBadge': 'DOK',
  'chat.list.rowOptionsAria': 'Optionen für Unterhaltung „{title}“',
  'chat.search.placeholder': 'Unterhaltungen durchsuchen…',
  'chat.search.aria': 'Unterhaltungen durchsuchen',
  'chat.search.resultsAria': 'Suchergebnisse',
  'chat.search.noMatches': 'Noch keine Treffer — versuch es mit einem anderen Wort.',
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

  // ---- Chat: transcript + message actions ----
  'chat.role.user': 'du',
  'chat.role.assistant': 'Assistent',
  'chat.thinking': 'Denkt nach…',
  'chat.actions.tryAgain': 'Noch einmal',
  'chat.actions.copy': 'Kopieren',
  'chat.actions.save': 'Speichern',
  'chat.actions.saveTitle': 'Diese Unterhaltung als Datei speichern (bleibt lokal)',

  // ---- Chat: document scope ----
  'chat.scope.usingAll.one': 'Nutzt dein {count} Dokument',
  'chat.scope.usingAll.other': 'Nutzt alle {count} Dokumente',
  'chat.scope.usingSome.one': 'Nutzt {count} Dokument',
  'chat.scope.usingSome.other': 'Nutzt {count} Dokumente',
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
  'docs.task.summaryBusyTitle': 'Die Zusammenfassung wird geschrieben',
  'docs.task.translationBusyTitle': 'Die Übersetzung wird geschrieben',
  'docs.task.compareBusyTitle': 'Der Vergleich wird geschrieben',
  'docs.task.ocrBusyTitle': 'Die gescannten Seiten werden gelesen',
  'docs.error.noSupported': 'In dieser Auswahl wurden keine unterstützten Dokumente gefunden.',
  'docs.removedDocFallback': 'einem entfernten Dokument',
  'docs.provenance.compareBefore': 'Vergleich von ',
  'docs.provenance.compareMiddle': ' und ',
  'docs.provenance.translatedBefore': 'Übersetzt aus ',
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
  'docs.previewModal.noText': 'Aus diesem Dokument konnte kein Text extrahiert werden.',
  'docs.previewModal.page': 'Seite {page}',

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
  'models.state.installed': 'Installiert',
  'models.state.missing': 'Nicht heruntergeladen',
  'models.state.checksumFailed': 'Nicht prüfbar',
  'models.state.unsupported': 'Nicht unterstützt',
  'models.state.notRecommended': 'Nicht empfohlen',
  'models.state.ready': 'Bereit',
  'models.state.running': 'Läuft',
  'models.hint.embeddings': 'Bereitet deine Dokumente vor, damit du Fragen dazu stellen kannst.',
  'models.hint.reranker': 'Verbessert, welche Dokumentpassagen für Antworten verwendet werden.',
  'models.hint.transcriber': 'Wandelt Audioaufnahmen in durchsuchbaren Text um.',
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
  'models.selected': 'Ausgewählt',
  'models.select': 'Auswählen',
  'models.stopRuntime': 'Modell stoppen',
  'models.startRuntime': 'Modell starten',
  'models.startMock': 'Mock-Runtime starten',
  'models.startTitle': 'Dieses Modell auf diesem Gerät starten',
  'models.startMockTitle':
    'Keine Modell-Datei vorhanden — startet die eingebaute Mock-Runtime, damit du die App ' +
    'ausprobieren kannst',
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
  'models.verifyTitle':
    'Die Datei auf dem Laufwerk neu hashen und gegen ihre SHA-256 prüfen (umgeht den ' +
    'Zwischenspeicher)',
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
