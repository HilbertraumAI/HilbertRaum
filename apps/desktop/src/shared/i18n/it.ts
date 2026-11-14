import type { UiCatalog } from './languages'

// The ITALIAN catalog (interface only).
//
// Style (design-guidelines §7 "Italian microcopy"): informal «tu», lower case, imperative for
// buttons and instructions, «non» + infinitive for negatives, never a participle or adjective
// that agrees with the user. The copy ADAPTS the calm spec-§11.4 tone. Quotes «…», apostrophe ’,
// ellipsis …, en dash « – » (never —). "HilbertRaum" is never translated.
//
// Glossary — keep terms consistent across ALL Italian copy:
//   workspace                  → area di lavoro
//   drive / disk               → unità (f., inv.; «questa unità», never «quest’unità»)
//   vault / encrypted workspace→ area di lavoro crittografata
//   model                      → modello (AI model → modello IA)
//   document                   → documento
//   re-index                   → reindicizzare
//   offline                    → offline
//   "Ask my documents"         → «Chiedi ai miei documenti»
//   lock / unlock              → bloccare / sbloccare
//   password                   → password (f., inv.)
//   settings                   → Impostazioni
//   plaintext (developer) mode → non crittografata (sviluppatori)
//   delete / cancel            → eliminare / annullare (never «cancellare» for either)
//
// Evidence-review glossary (MIRROR of the canonical record in design-guidelines §7; change BOTH
// together):
//   evidence                   → riscontro / riscontri — never «prova», never «evidenza»
//   review (the artifact)      → verifica (evidence review → verifica dei riscontri)
//   review item                → punto di verifica
//   evidence pack              → pacchetto di riscontri
//   citation / source marker   → riferimento alla fonte (never «citazione»)
//   whole-document provenance  → provenienza da un’analisi dell’intero documento; the negation
//                                is always «nessun riferimento alle fonti per singola frase»
//   direct excerpt             → estratto diretto
//   source / source document   → fonte / documento di origine (never «sorgente»)
//   reviewer                   → Persona che verifica (label) / chi verifica (prose);
//                                compounds «di verifica», «in verifica»
//   mark ready / reopen        → Concludi la verifica / Riapri la verifica
//   outdated                   → non aggiornata
//   review creation            → the review is «avviata», the ANSWER is «generata» — never mixed
//   supported-ness             → «con riscontro / con riscontro parziale / senza riscontro»;
//                                «dimostrare» only in negated disclaimers
//   check / verify elsewhere   → controllare (the word «verifica» belongs to the review surface)
//
// Typed `UiCatalog<'it'>` (i18n record D-L10): a missing, misspelt or extra key is a
// `npm run typecheck` failure. `packExport.*` is not part of it: evidence packs stay English
// or German (D-L11).

export const it: UiCatalog<'it'> = {
  // ---- App shell (App.tsx) ----
  'nav.aria': 'Navigazione principale',
  'nav.home': 'Home',
  'nav.chat': 'Chat',
  'nav.documents': 'Documenti',
  'nav.translate': 'Traduzione',
  'nav.images': 'Immagini',
  'nav.models': 'Modello IA',
  'nav.performance': 'Prestazioni',
  'nav.settings': 'Impostazioni',
  'app.lockNow': 'Blocca ora',
  'app.lockNowTitle': 'Crittografa di nuovo e blocca l’area di lavoro',
  'app.noticeDetails': 'Dettagli',
  'app.noticeGoToModels': 'Vai a Modello IA',
  'app.fatal.title': 'L’app non è riuscita ad avviarsi',
  'app.fatal.hintBefore':
    'Il backend locale non si è avviato, quindi non è possibile caricare nulla. Riavvia l’app; ' +
    'se il problema si ripete, controlla ',
  'app.fatal.hintAfter': ' sulla tua unità e consulta «docs/troubleshooting.md».',
  'app.loadingWorkspace': 'Caricamento dell’area di lavoro…',
  'app.loadingScreen': 'Caricamento…',
  // ---- Error boundary (ErrorBoundary.tsx — audit FE-1) ----
  'errorBoundary.title': 'Qualcosa non ha funzionato in questa schermata',
  'errorBoundary.body':
    'Questa schermata ha incontrato un problema imprevisto. Il tuo lavoro e i tuoi dati sono al ' +
    'sicuro: non è andato perso nulla. Riprova oppure torna alla Home.',
  'errorBoundary.retry': 'Riprova',
  'errorBoundary.home': 'Vai alla Home',
  'errorBoundary.app.title': 'L’app ha incontrato un problema',
  'errorBoundary.app.body':
    'È successo qualcosa di imprevisto. I tuoi dati sull’unità sono al sicuro. Ricarica per ' +
    'continuare.',
  'errorBoundary.app.reload': 'Ricarica',
  // ---- Home (HomeScreen.tsx) ----
  'home.headline.ready': 'Tutto pronto per la chat.',
  'home.headline.starting': 'Preparazione in corso…',
  'home.headline.almost': 'Configurazione quasi completata.',
  'home.lead':
    'Un’area di lavoro IA privata e offline. Le tue domande, i tuoi documenti e la cronologia ' +
    'delle chat restano su questo dispositivo.',
  'home.preflight.continue':
    'Puoi comunque continuare. Se l’app non si apre, consulta la guida alla risoluzione dei ' +
    'problemi nella cartella {folder} dell’unità.',
  'home.moved.restored':
    'Questa unità è stata usata l’ultima volta su un altro computer. I valori per questo ' +
    'computer vengono da un controllo precedente, in data {when}: questa volta non è stato ' +
    'misurato nulla.',
  'home.moved.restoredUndated':
    'Questa unità è stata usata l’ultima volta su un altro computer. I valori per questo ' +
    'computer vengono da un controllo precedente: questa volta non è stato misurato nulla.',
  'home.moved.measuring':
    'Questa unità non è mai stata usata su questo computer. È in corso un controllo in ' +
    'background; al termine, la schermata Prestazioni mostra i valori.',
  'home.moved.owed':
    'Questa unità non è ancora stata controllata su questo computer, quindi non ci sono valori.',
  'home.checking': 'Controllo in corso…',
  'home.workspace.label': 'Area di lavoro',
  'home.workspace.encrypted': 'Crittografata – bloccata con la tua password quando l’app è chiusa',
  'home.workspace.plaintext': 'Non crittografata (modalità sviluppatori)',
  'home.workspace.badgeProtected': 'Protetta',
  'home.workspace.badgeDeveloper': 'Sviluppatori',
  'home.model.label': 'Modello IA',
  'home.model.fallbackName': 'Il tuo modello',
  'home.model.running': '{model} è in esecuzione su questo dispositivo',
  'home.model.selected':
    'Modello selezionato: {model}; il caricamento potrebbe essere ancora in corso',
  'home.model.none': 'Ancora nessun modello selezionato',
  'home.model.badgeRunning': 'Attivo',
  'home.model.badgeStarting': 'In avvio',
  'home.model.badgeNeedsModel': 'Serve un modello',
  'home.model.open': 'Vai a Modello IA',
  'home.model.engineCannotRun':
    'Il motore IA non può funzionare su questo computer: le risposte sono simulate',
  'home.model.badgeEngine': 'Non funziona',
  'home.model.demo': '{model} è in esecuzione in modalità demo: le risposte sono simulate',
  'home.model.badgeDemo': 'Modalità demo',
  'home.model.choose': 'Scegli un modello',
  'home.docs.label': 'Documenti',
  'home.docs.none': 'Ancora nessun documento: aggiungine qualcuno per fare domande sul contenuto',
  'home.docsReady.one': '{count} documento pronto per le tue domande',
  'home.docsReady.many': '{count} di documenti pronti per le tue domande',
  'home.docsReady.other': '{count} documenti pronti per le tue domande',
  'home.docs.badgeReady': 'Pronti',
  'home.docs.badgeNone': 'Nessuno',
  'home.docs.add': 'Aggiungi documenti',
  'home.packs.label': 'Pacchetti di conoscenze',
  'home.packsReady.one': '{count} pacchetto di conoscenze pronto per le tue domande',
  'home.packsReady.many': '{count} di pacchetti di conoscenze pronti per le tue domande',
  'home.packsReady.other': '{count} pacchetti di conoscenze pronti per le tue domande',
  'home.packs.none':
    'Ancora nessun pacchetto: aggiungi una Wikipedia offline per fare domande generali',
  'home.packs.noneReady':
    'Nessun pacchetto è pronto per le domande: controlla i pacchetti in Documenti',
  'home.packs.badgeNoneReady': 'Non pronti',
  'home.packs.add': 'Aggiungi pacchetti',
  'home.packs.open': 'Apri i pacchetti di conoscenze',
  'home.actions.startChat': 'Inizia a chattare',
  'home.actions.askDocs': 'Chiedi ai miei documenti',
  // ---- Chat (ChatScreen.tsx) ----
  'chat.title': 'Chat',
  'chat.noModel.title': 'Nessun modello in esecuzione',
  'chat.noModel.startingTitle': 'Il modello IA si sta avviando',
  'chat.noModel.hintBefore':
    'Per la chat e le domande sui documenti serve un modello caricato. Apri la schermata Modello ' +
    'IA, seleziona un modello scaricato e scegli ',
  'chat.noModel.hintAction': 'Usa questo modello',
  'chat.noModel.hintAfter':
    '. Tutto resta in locale: nulla viene scaricato o inviato tramite Internet.',
  'chat.noModel.stillLoading':
    'Se hai appena aperto l’app, il modello selezionato potrebbe essere ancora in caricamento: ' +
    'questa schermata prosegue automaticamente non appena è pronto.',
  'chat.noModel.starting':
    'Il tuo modello si sta avviando: i modelli grandi richiedono un po’ di tempo per il ' +
    'caricamento. Questa schermata prosegue automaticamente non appena è pronto.',
  'chat.noModel.startingProgress':
    'Il tuo modello si sta avviando: lettura del file del modello ({gb}\u00A0GB), finora circa ' +
    '{pct}%. Questa schermata prosegue automaticamente non appena è pronto.',
  'chat.noModel.open': 'Vai a Modello IA',
  'chat.noModel.recheck': 'Controlla di nuovo',
  'chat.empty.title': 'Fai una domanda o chiedi qualcosa sui tuoi documenti.',
  'chat.empty.lineDocuments': 'Le risposte provengono dai tuoi documenti e ne indicano le fonti.',
  'chat.empty.lineChat':
    'Le risposte arrivano dal modello su questa unità: nulla esce da questo dispositivo.',
  'chat.empty.fillTitle': 'Inserisci questo testo nel campo del messaggio',
  'chat.empty.addDocs': 'Aggiungi documenti per fare domande sul loro contenuto',
  'chat.exampleChat.explain': 'Spiegami un concetto in parole semplici',
  'chat.exampleChat.draftEmail': 'Aiutami a scrivere un’email cortese',
  'chat.exampleChat.brainstorm': 'Proponi idee per un progetto',
  'chat.example.summarize': 'Riassumi questo documento',
  'chat.example.paymentTerms': 'Quali sono le condizioni di pagamento?',
  'chat.example.indemnity': 'Trova ogni menzione di «manleva»',
  'chat.modeAria': 'Modalità della chat',
  'chat.mode.chat': 'Chat',
  'chat.mode.documents': 'Chiedi ai miei documenti',
  'chat.listShow': 'Mostra l’elenco delle conversazioni',
  'chat.runtime.gpu': '{model} · GPU ({name})',
  'chat.runtime.cpu': '{model} · CPU',
  'chat.runtime.cpuCompat': '{model} · CPU (modalità di compatibilità)',
  'chat.runtime.demo': '{model} · modalità demo',
  'chat.runtime.title':
    'Il modello IA che risponde in questa chat, e se funziona sulla scheda grafica (GPU) o sul ' +
    'processore (CPU). Dettagli: Impostazioni → Diagnostica.',
  'chat.runtime.compatTitle':
    'La modalità di compatibilità è attiva per garantire la stabilità, quindi le risposte ' +
    'vengono elaborate sul processore e possono essere più lente. Puoi riprovare con la scheda ' +
    'grafica in Impostazioni → Diagnostica.',
  'chat.convOptions': 'Opzioni della conversazione',
  'chat.saveConversation': 'Salva questa conversazione',
  'chat.savedTo': 'File salvato in {path}',
  'chat.copied': 'Copiato',
  'chat.copyFailed': 'Non è stato possibile copiare negli Appunti',
  'chat.transcript.label': 'Messaggi della conversazione',
  'chat.stopped': 'Risposta interrotta: potrebbe essere incompleta',
  'chat.warmup.hint':
    'La prima risposta richiede un po’ più di tempo: il modello si sta preparando. Le risposte ' +
    'successive saranno più veloci.',
  'chat.scopeNotice': 'Risposta basata solo su: {titles}',
  'chat.cancelDocTask': 'Annulla l’attività sul documento',
  'chat.placeholder.documents': 'Chiedi qualcosa sui tuoi documenti…',
  'chat.placeholder.chat': 'Messaggio…',
  'chat.send.ask': 'Chiedi',
  'chat.send.send': 'Invia',
  'chat.composer.stop': 'Interrompi',
  // ---- Chat: conversation list (ConversationList.tsx) ----
  'chat.list.title': 'Conversazioni',
  'chat.list.aria': 'Cronologia delle conversazioni',
  'chat.list.newChat': '+ Nuova chat',
  'chat.list.newDocQa': '+ Nuova chat sui documenti',
  'chat.list.hide': 'Nascondi l’elenco delle conversazioni',
  'chat.list.empty': 'Nessuna conversazione per ora.',
  'chat.list.docMeta': 'Documenti',
  'chat.list.otherGroup': 'Altro / Libreria',
  'chat.list.rowOptionsAria': 'Opzioni per la conversazione «{title}»',
  'chat.search.placeholder': 'Cerca nelle conversazioni…',
  'chat.search.aria': 'Cerca nelle conversazioni',
  'chat.search.resultsAria': 'Risultati della ricerca',
  'chat.search.resultsFor': 'Risultati per «{query}»',
  'chat.search.noMatches': 'Non ho trovato corrispondenze. Prova a riformulare.',
  'chat.search.count.one': '{count} risultato',
  'chat.search.count.many': '{count} di risultati',
  'chat.search.count.other': '{count} risultati',
  'chat.group.today': 'Oggi',
  'chat.group.yesterday': 'Ieri',
  'chat.group.last7days': 'Ultimi 7 giorni',
  'chat.group.earlier': 'Meno recenti',
  'chat.delete.menuItem': 'Elimina la conversazione',
  'chat.delete.title': 'Vuoi eliminare questa conversazione?',
  'chat.delete.confirm': 'Elimina',
  'chat.delete.body':
    'La conversazione «{title}» e i suoi messaggi verranno rimossi definitivamente da questa ' +
    'unità.',
  // ---- Chat: answer depth (DepthMenu.tsx; ids stay fast|balanced|deep) ----
  'chat.depth.trigger': 'Risposta: {label}',
  'chat.depth.fast': 'Rapida',
  'chat.depth.balanced': 'Bilanciata',
  'chat.depth.deep': 'Approfondita',
  'chat.depth.fastHint': 'Risposte brevi e mirate',
  'chat.depth.balancedHint': 'La scelta predefinita per l’uso quotidiano',
  'chat.depth.deepHint': 'Ragiona sul problema prima di rispondere: richiede più tempo',
  // ---- Chat: skill picker + per-message glyph (skills plan §10/§15) ----
  'chat.skill.trigger': 'Skill: {label}',
  'chat.skill.none': 'Nessuna skill',
  'chat.skill.suggested': 'Suggerita: {title}. Vuoi usarla?',
  'chat.skill.suggestedHint': 'Suggerita: {title}',
  'chat.skill.used': 'Skill: {title}',
  'chat.skill.usedTitle': 'Questa risposta è stata elaborata con la skill «{title}».',
  'chat.skill.autoFired': 'Risposta con la skill {title}',
  'chat.skill.autoFiredTitle':
    'L’app ha applicato automaticamente la skill «{title}» a questa risposta. Puoi ottenere una ' +
    'risposta senza la skill.',
  'chat.skill.answerWithout': 'Rispondi senza la skill',
  'chat.skill.answerWithoutBlockedByReview':
    'Questa risposta ha una verifica dei riscontri. Rispondere di nuovo eliminerebbe la verifica ' +
    'insieme alle sue decisioni e note.',
  'chat.skill.removed': '(skill rimossa)',
  'chat.skill.offer.lead': 'Sembra un compito adatto a una skill.',
  'chat.skill.offer.run': 'Esegui «{title}» per questa domanda',
  'chat.skill.offer.model': 'Suggerimento del modello locale',
  'chat.skill.offer.unavailable':
    'Questa skill è disattivata o è stata rimossa: attivala nella scheda Skill per eseguirla.',
  'chat.skill.clear': 'Rimuovi la skill {title}',
  'chat.skill.keep': 'Mantieni per questa conversazione',
  'chat.skill.infoButton': 'Informazioni su «{title}»',
  'chat.skill.info.close': 'Nascondi questa spiegazione',
  'chat.skill.info.needsLabel': 'Richiede:',
  'chat.skill.info.limitsLabel': 'Da tenere presente:',
  'chat.skill.info.perTurn':
    'Vale per le tue domande in questa chat finché non la cambi o la rimuovi. «Mantieni per ' +
    'questa conversazione» la salva anche per le prossime volte.',
  'chat.skill.info.learnMore': 'Ulteriori informazioni',
  'chat.skill.tool.extractTransactions': 'Estrai le transazioni',
  'chat.skill.tool.validateBalances': 'Controlla i saldi',
  'chat.skill.tool.categorize': 'Categorizza',
  'chat.skill.tool.summarize': 'Riassumi entrate e uscite',
  'chat.skill.tool.exportCsv': 'Esporta in CSV',
  'chat.skill.tool.extractInvoice': 'Estrai i dati della fattura',
  'chat.skill.tool.validateInvoiceTotals': 'Controlla i totali',
  'chat.skill.tool.exportInvoiceCsv': 'Esporta in CSV',
  'chat.skill.tool.exportInvoiceJson': 'Esporta in JSON',
  'chat.skill.tool.exportInvoiceXml': 'Esporta in XML',
  'chat.skill.tool.redactDocument': 'Oscura i dati personali',
  'chat.skill.tool.applyDocumentEdits': 'Applica le modifiche al testo',
  'chat.skill.categorize.breakdownQuestion': 'Suddividi le mie spese per categoria.',
  'chat.skill.summarize.question': 'Riassumi le mie entrate e le mie uscite.',
  'chat.skill.run.running.one': 'In esecuzione: {tool} su {count} documento…',
  'chat.skill.run.running.many': 'In esecuzione: {tool} su {count} di documenti…',
  'chat.skill.run.running.other': 'In esecuzione: {tool} su {count} documenti…',
  'chat.skill.run.runningOn': 'In esecuzione: {tool} su {document}…',
  'chat.skill.run.chooseDocument': 'Scegli il documento di destinazione',
  'chat.skill.run.thisDocument': 'questo documento',
  'chat.skill.run.cancel': 'Annulla',
  'chat.skill.run.done.one': '{count} transazione estratta.',
  'chat.skill.run.done.many': '{count} di transazioni estratte.',
  'chat.skill.run.done.other': '{count} transazioni estratte.',
  'chat.skill.run.done.categorize.one': '{count} transazione categorizzata.',
  'chat.skill.run.done.categorize.many': '{count} di transazioni categorizzate.',
  'chat.skill.run.done.categorize.other': '{count} transazioni categorizzate.',
  'chat.skill.run.done.summarize.one': '{count} transazione inclusa nel riassunto.',
  'chat.skill.run.done.summarize.many': '{count} di transazioni incluse nel riassunto.',
  'chat.skill.run.done.summarize.other': '{count} transazioni incluse nel riassunto.',
  'chat.skill.run.done.export.one': '{count} riga salvata.',
  'chat.skill.run.done.export.many': '{count} di righe salvate.',
  'chat.skill.run.done.export.other': '{count} righe salvate.',
  'chat.skill.run.done.reconciled': 'I saldi quadrano.',
  'chat.skill.run.done.unreconciled.one':
    '{count} riga non quadra: controlla il risultato prima di usarlo.',
  'chat.skill.run.done.unreconciled.many':
    '{count} di righe non quadrano: controlla il risultato prima di usarlo.',
  'chat.skill.run.done.unreconciled.other':
    '{count} righe non quadrano: controlla il risultato prima di usarlo.',
  'chat.skill.run.done.unchecked':
    'L’estratto conto non riporta un saldo progressivo con cui fare il confronto.',
  'chat.skill.run.done.extractInvoice.one': '{count} voce estratta.',
  'chat.skill.run.done.extractInvoice.many': '{count} di voci estratte.',
  'chat.skill.run.done.extractInvoice.other': '{count} voci estratte.',
  'chat.skill.run.done.invoiceReconciled': 'I totali della fattura quadrano.',
  'chat.skill.run.done.invoiceUnreconciled.one':
    '{count} totale non quadra: controlla il risultato prima di usarlo.',
  'chat.skill.run.done.invoiceUnreconciled.many':
    '{count} di totali non quadrano: controlla il risultato prima di usarlo.',
  'chat.skill.run.done.invoiceUnreconciled.other':
    '{count} totali non quadrano: controlla il risultato prima di usarlo.',
  'chat.skill.run.done.invoiceUnchecked':
    'La fattura non riporta totali con cui fare il confronto.',
  'chat.skill.run.done.redacted.one':
    'Copia oscurata salvata: {count} elemento nascosto. Rilevamento nei limiti del possibile, ' +
    'senza garanzie: controlla la copia prima di condividerla.',
  'chat.skill.run.done.redacted.many':
    'Copia oscurata salvata: {count} di elementi nascosti. Rilevamento nei limiti del possibile, ' +
    'senza garanzie: controlla la copia prima di condividerla.',
  'chat.skill.run.done.redacted.other':
    'Copia oscurata salvata: {count} elementi nascosti. Rilevamento nei limiti del possibile, ' +
    'senza garanzie: controlla la copia prima di condividerla.',
  'chat.skill.run.done.redactedClean':
    'Nessun dato personale rilevato; copia salvata. Rilevamento nei limiti del possibile, senza ' +
    'garanzie: controlla la copia prima di condividerla.',
  'chat.skill.run.done.redactedFloor.one':
    'Copia oscurata salvata: {count} elemento nascosto (solo rilevamento offline basato su ' +
    'regole, nessun modello in esecuzione). Controlla la copia prima di condividerla.',
  'chat.skill.run.done.redactedFloor.many':
    'Copia oscurata salvata: {count} di elementi nascosti (solo rilevamento offline basato su ' +
    'regole, nessun modello in esecuzione). Controlla la copia prima di condividerla.',
  'chat.skill.run.done.redactedFloor.other':
    'Copia oscurata salvata: {count} elementi nascosti (solo rilevamento offline basato su ' +
    'regole, nessun modello in esecuzione). Controlla la copia prima di condividerla.',
  'chat.skill.run.done.redactedCleanFloor':
    'Nessun dato personale rilevato (solo rilevamento offline basato su regole, nessun modello ' +
    'in esecuzione); copia salvata. Controlla la copia prima di condividerla.',
  'chat.skill.run.done.redactedCapped.one':
    'Copia oscurata salvata: {count} elemento nascosto. Questo documento è molto grande, quindi ' +
    'il rilevamento automatico si è fermato al suo limite e gli elementi successivi potrebbero ' +
    'essere ancora visibili: controlla tutta la copia prima di condividerla.',
  'chat.skill.run.done.redactedCapped.many':
    'Copia oscurata salvata: {count} di elementi nascosti. Questo documento è molto grande, ' +
    'quindi il rilevamento automatico si è fermato al suo limite e gli elementi successivi ' +
    'potrebbero essere ancora visibili: controlla tutta la copia prima di condividerla.',
  'chat.skill.run.done.redactedCapped.other':
    'Copia oscurata salvata: {count} elementi nascosti. Questo documento è molto grande, quindi ' +
    'il rilevamento automatico si è fermato al suo limite e gli elementi successivi potrebbero ' +
    'essere ancora visibili: controlla tutta la copia prima di condividerla.',
  'chat.skill.run.done.edited.one':
    '{count} modifica applicata e copia modificata salvata. Controlla la copia prima di ' +
    'condividerla.',
  'chat.skill.run.done.edited.many':
    '{count} di modifiche applicate e copia modificata salvata. Controlla la copia prima di ' +
    'condividerla.',
  'chat.skill.run.done.edited.other':
    '{count} modifiche applicate e copia modificata salvata. Controlla la copia prima di ' +
    'condividerla.',
  'chat.skill.run.done.editedPartial.one':
    '{count} modifica applicata; una parte del testo richiesto non è stata trovata ed è stata ' +
    'saltata. Copia modificata salvata: controllala prima di condividerla.',
  'chat.skill.run.done.editedPartial.many':
    '{count} di modifiche applicate; una parte del testo richiesto non è stata trovata ed è ' +
    'stata saltata. Copia modificata salvata: controllala prima di condividerla.',
  'chat.skill.run.done.editedPartial.other':
    '{count} modifiche applicate; una parte del testo richiesto non è stata trovata ed è stata ' +
    'saltata. Copia modificata salvata: controllala prima di condividerla.',
  'chat.skill.run.done.editedNone':
    'Nessuna parte del testo richiesto è stata trovata: non è stato modificato nulla e non è ' +
    'stata salvata nessuna copia.',
  'chat.skill.run.done.editedCapped.one':
    '{count} modifica applicata. Questo documento è molto grande, quindi la ricerca dei punti da ' +
    'modificare si è fermata al suo limite. Controlla la copia: i punti successivi potrebbero ' +
    'essere rimasti invariati.',
  'chat.skill.run.done.editedCapped.many':
    '{count} di modifiche applicate. Questo documento è molto grande, quindi la ricerca dei ' +
    'punti da modificare si è fermata al suo limite. Controlla la copia: i punti successivi ' +
    'potrebbero essere rimasti invariati.',
  'chat.skill.run.done.editedCapped.other':
    '{count} modifiche applicate. Questo documento è molto grande, quindi la ricerca dei punti ' +
    'da modificare si è fermata al suo limite. Controlla la copia: i punti successivi potrebbero ' +
    'essere rimasti invariati.',
  'chat.skill.run.failedGeneric': 'Non ha funzionato. Non è stato modificato nulla.',
  'chat.skill.run.error.unavailable': 'Questo strumento non è disponibile.',
  'chat.skill.run.error.needsExtraction':
    'Prima leggi il documento con il pulsante «{button}», poi esegui questo strumento.',
  'chat.skill.run.error.persistFailed':
    'Non è stato possibile salvare. Non è stato modificato nulla.',
  'chat.skill.run.error.exportWriteFailed':
    'Non è stato possibile salvare il file. Non è stato modificato nulla.',
  'chat.skill.run.error.needsModel':
    'Prima avvia un modello: le modifiche mirate richiedono un modello in esecuzione per trovare ' +
    'il testo da modificare.',
  'chat.skill.run.error.needsInstruction':
    'Prima indica cosa modificare (per esempio «sostituisci X con Y»), poi esegui di nuovo ' +
    'questa operazione.',
  'chat.skill.run.error.editFailed':
    'Non è stato possibile completare le modifiche. Non è stato modificato nulla.',
  'chat.skill.run.error.redactionModelStopped':
    'Il modello IA si è arrestato prima che l’oscuramento fosse completato. Non è stato salvato ' +
    'nulla. Esegui di nuovo l’oscuramento: se il problema si ripete, riavvia il modello nella ' +
    'schermata Modello IA.',
  'chat.skill.run.error.redactionTooLong':
    'Alcune parti di questo documento sono troppo lunghe per la finestra di contesto del modello ' +
    'attuale. Non è stato salvato nulla. Scegli una dimensione del contesto più grande nella ' +
    'schermata Modello IA e riavvia il modello, poi esegui di nuovo l’oscuramento.',
  'chat.skill.run.cancelled': 'Operazione interrotta. Non è stato salvato nulla.',
  'chat.skill.run.stateUnknown':
    'Non è stato possibile controllare lo stato di questa skill: il risultato potrebbe essere ' +
    'incompleto.',
  'chat.skill.run.otherChatBusy': 'Una skill sta lavorando in un’altra chat.',
  'chat.skill.run.categorizeOffer': 'Categorizza le transazioni',
  'chat.skill.run.dismiss': 'Chiudi',
  'chat.skill.confirm.title': 'Vuoi eseguire questo strumento?',
  'chat.skill.confirm.body':
    'Verrà creato o esportato un file a partire dai documenti su questa unità.',
  'chat.skill.confirm.target': 'Documento: {document}',
  'chat.skill.confirm.outputDocx':
    'La copia salvata mantiene il formato Word (.docx) di questo documento.',
  'chat.skill.confirm.redactionScope':
    'L’oscuramento copre il testo del documento (incluse intestazioni, piè di pagina, note a piè ' +
    'di pagina, commenti e modifiche rilevate) e rimuove i metadati sull’autore e le ' +
    'destinazioni dei link. Immagini, pagine scansionate e oggetti incorporati non vengono ' +
    'esaminati: controlla la copia salvata prima di condividerla.',
  'chat.skill.confirm.outputText':
    'La copia salvata sarà un file di testo (.txt): il layout e la formattazione originali non ' +
    'vengono mantenuti.',
  'chat.skill.confirm.outputMatrix':
    'I documenti Word (.docx) mantengono il loro formato; i PDF e gli altri formati vengono ' +
    'salvati come copia in un file di testo (.txt).',
  'chat.skill.confirm.ok': 'Esegui',
  // ---- Chat: transcript + message actions ----
  'chat.role.user': 'Tu',
  'chat.role.assistant': 'HilbertRaum',
  'chat.thinking': 'Ragionamento in corso…',
  'chat.actions.tryAgain': 'Riprova',
  'chat.actions.sendAgain': 'Invia di nuovo',
  'chat.actions.copy': 'Copia',
  'chat.actions.save': 'Salva',
  'chat.actions.saveTitle': 'Salva questa conversazione come file (resta in locale)',
  'chat.actions.exportCsv': 'Esporta CSV',
  'chat.actions.exportCsvTitle':
    'Salva la tabella di questa risposta come file CSV (resta in locale)',
  'chat.code.copy': 'Copia',
  'chat.code.copyTitle': 'Copia questo blocco di codice negli Appunti',
  'chat.code.save': 'Salva',
  'chat.code.saveTitle': 'Salva questo blocco di codice come file .{ext} (resta in locale)',
  // ---- Chat: context compaction (context-compaction plan §5.1–§5.3) ----
  'chat.compaction.inProgress': 'Riassunto dei messaggi meno recenti per liberare contesto…',
  'chat.analysis.inProgress': 'Lettura dell’intero documento…',
  'chat.compaction.markerLabel': 'Messaggi meno recenti riassunti',
  'chat.compaction.viewSummary': 'Mostra il riassunto dei messaggi meno recenti',
  'chat.context.label': 'Memoria',
  'chat.context.usageTooltip':
    'Memoria di questa conversazione: {pct}% occupata (circa {used} su {window} token).',
  'chat.context.willSummarize':
    'Quando è piena, i messaggi meno recenti vengono riassunti automaticamente per fare spazio.',
  'chat.truncated.label': 'Risposta troncata',
  'chat.endedEarly.label': 'Risposta interrotta',
  'chat.endedEarly.hint.model':
    'Il modello IA è stato arrestato o cambiato prima che questa risposta fosse completa.',
  'chat.endedEarly.hint.user': 'Hai interrotto questa risposta prima che fosse completa.',
  'chat.endedEarly.hint.lock':
    'L’area di lavoro è stata bloccata o l’app è stata chiusa prima che questa risposta fosse ' +
    'completa.',
  'chat.unanswered.model': 'Nessuna risposta: il modello IA è stato arrestato.',
  'chat.unanswered.user': 'Nessuna risposta: l’hai interrotta.',
  'chat.unanswered.lock':
    'Nessuna risposta: l’area di lavoro è stata bloccata o l’app è stata chiusa.',
  'chat.truncated.hint.context':
    'Il modello ha esaurito lo spazio per completare questa risposta. Chiedigli di continuare, ' +
    'inizia una nuova chat o aumenta la dimensione del contesto nella schermata Modello IA.',
  'chat.truncated.hint.cap':
    'Questa risposta basata sui documenti ha raggiunto la lunghezza massima che l’app consente ' +
    'per una singola risposta. Chiedi al modello di continuare da dove si è fermato.',
  'chat.speed.line': '{tps}\u00A0tok/s · {ttft}\u00A0s al primo token · {tokens} token',
  'chat.speed.hint':
    'Quanto velocemente è stata generata questa risposta: velocità di decodifica del motore IA, ' +
    'attesa fino alla prima parola e numero di token prodotti. Visibile solo per le risposte di ' +
    'questa sessione.',
  // ---- Chat: document scope (ScopePopover.tsx) ----
  'chat.scope.none': 'Ancora nessun documento · Aggiungi documenti',
  'chat.scope.stopAsking': 'Escludi «{title}»',
  'chat.scope.askToo': 'Includi anche «{title}»',
  'chat.scope.removedDoc': 'Documento rimosso',
  // ---- Chat: sources (SourcesDisclosure.tsx) ----
  'chat.sources.toggle': 'Fonti ({count})',
  'chat.sources.marker': 'F{n}',
  'chat.sources.page': 'Pagina {page}',
  'chat.sources.wholeDoc.one': 'Dal documento: {count} sezione',
  'chat.sources.wholeDoc.many': 'Dal documento: {count} di sezioni',
  'chat.sources.wholeDoc.other': 'Dal documento: {count} sezioni',
  'chat.sources.wholeDocCaption': 'Sezioni usate',
  'chat.sources.more.one': 'e {count} sezione in più',
  'chat.sources.more.many': 'e {count} di sezioni in più',
  'chat.sources.more.other': 'e {count} sezioni in più',
  // ---- Chat: dictation (DictationButton.tsx) ----
  'chat.dictation.start': 'Detta un messaggio',
  'chat.dictation.unavailable': 'La dettatura vocale non è installata su questa unità',
  'chat.dictation.unavailableSystem':
    'La dettatura vocale non è disponibile su questo sistema operativo',
  'chat.dictation.needsModel':
    'Per dettare un messaggio serve il modello vocale, che non è installato su questa unità. ' +
    'Puoi aggiungerlo nella schermata Modello IA.',
  'chat.dictation.needsEngine':
    'Per dettare un messaggio serve il motore vocale, che non è installato su questa unità. Puoi ' +
    'installarlo nella schermata Modello IA.',
  'chat.dictation.needsModelAndEngine':
    'Per dettare un messaggio servono il modello vocale e il motore vocale, che non sono ancora ' +
    'su questa unità. Puoi aggiungerli entrambi nella schermata Modello IA.',
  'chat.dictation.engineUnsupported':
    'La dettatura vocale non è ancora disponibile su questo sistema operativo: qui l’app non può ' +
    'installare il motore vocale necessario.',
  'chat.dictation.getModel': 'Ottieni il modello vocale',
  'chat.dictation.getEngine': 'Ottieni il motore vocale',
  'chat.dictation.setUp': 'Configura la dettatura vocale',
  'chat.dictation.stop': 'Interrompi la dettatura e inserisci il testo',
  'chat.dictation.transcribing': 'Conversione della tua voce in testo',
  'chat.dictation.noSpeech': 'Nessuna voce riconosciuta: prova a parlare di nuovo.',
  'chat.dictation.silent':
    'Nessun suono è arrivato al microfono. Controlla che non sia silenziato e che HilbertRaum ' +
    'possa usarlo nelle impostazioni di sistema, poi riprova.',
  'chat.dictation.noSignal':
    'Nessun suono arriva al microfono: controlla che non sia silenziato e che sia selezionato il ' +
    'dispositivo di input giusto.',
  'chat.dictation.micBlocked':
    'Non è stato possibile usare il microfono. Controlla le impostazioni di sistema del ' +
    'microfono, poi riprova.',
  // ---- Documents (DocumentsScreen.tsx) ----
  'docs.title': 'Documenti',
  'docs.lead':
    'Importa documenti per fare domande sul loro contenuto. Ogni file viene copiato nella tua ' +
    'area di lavoro e preparato per la ricerca. Tutto resta su questa unità. Per le domande usa ' +
    'la modalità «Chiedi ai miei documenti» nella schermata Chat.',
  'docs.status.queued': 'In attesa',
  'docs.status.extracting': 'Lettura',
  'docs.status.preparing': 'Preparazione',
  'docs.status.indexed': 'Pronto',
  'docs.status.failed': 'Non riuscito',
  'docs.status.deleted': 'Eliminato',
  'docs.status.transcribing': 'Trascrizione…',
  'docs.task.summaryBusy': 'Riassunto in corso…',
  'docs.task.translationBusy': 'Traduzione in corso…',
  'docs.task.compareBusy': 'Confronto in corso…',
  'docs.task.ocrBusy': 'Lettura della scansione…',
  'docs.task.treeBusy': 'Creazione dell’indice approfondito…',
  'docs.task.extractBusy': 'Ricerca dei dettagli…',
  'docs.task.summaryBusyTitle': 'Il riassunto è in fase di scrittura',
  'docs.task.translationBusyTitle': 'La traduzione è in fase di scrittura',
  'docs.task.compareBusyTitle': 'Il confronto è in fase di scrittura',
  'docs.task.ocrBusyTitle': 'Le pagine scansionate sono in fase di lettura',
  'docs.task.treeBusyTitle': 'Un indice approfondito dell’intero documento è in fase di creazione',
  'docs.task.extractBusyTitle':
    'L’intero documento è in fase di analisi, per poter rispondere a domande come «elenca tutti…»',
  'docs.task.categorizeBusy': 'Categorizzazione delle transazioni…',
  'docs.task.categorizeBusyTitle':
    'Le transazioni dell’estratto conto sono in fase di categorizzazione',
  'docs.task.ocrFinishing': 'Completamento: il testo viene reso ricercabile…',
  'docs.task.stopping': 'Interruzione in corso, se possibile…',
  'docs.error.noSupported': 'In questa selezione non sono stati trovati documenti supportati.',
  'docs.removedDocFallback': 'un documento rimosso',
  'docs.provenance.compareBefore': 'Confronto tra ',
  'docs.provenance.compareMiddle': ' e ',
  'docs.provenance.translatedBefore': 'Tradotto da ',
  'docs.provenance.summaryBefore': 'Riassunto di ',
  'docs.provenance.generatedBefore': 'Generato da ',
  'docs.provenance.articleBefore': 'Salvato dal pacchetto di conoscenze ',
  'docs.provenance.articleUnknownArchive': '(nome non disponibile)',
  'docs.import.busy': 'Importazione…',
  'docs.import.files': 'Importa file',
  'docs.import.folder': 'Importa cartella',
  'docs.import.walkCut.one':
    'La cartella era troppo grande per essere esaminata del tutto: è stato contato {count} ' +
    'elemento.',
  'docs.import.walkCut.many':
    'La cartella era troppo grande per essere esaminata del tutto: sono stati contati {count} di ' +
    'elementi.',
  'docs.import.walkCut.other':
    'La cartella era troppo grande per essere esaminata del tutto: sono stati contati {count} ' +
    'elementi.',
  'docs.refresh': 'Aggiorna',
  'docs.loading': 'Caricamento dei documenti…',
  'docs.askSelected': 'Chiedi a questi documenti ({count})',
  'docs.askSelectedTitle': 'Apri una chat di domande e risposte limitata ai documenti selezionati',
  'docs.compareBtn': 'Confronta (2)',
  'docs.compareBtnTitle':
    'Scrivi con il modello locale un confronto tra i due documenti selezionati: nulla esce da ' +
    'questa unità',
  'docs.reindexAll': 'Reindicizza tutto ({count})',
  'docs.reindexAllTitle':
    'Reindicizza ogni documento indicizzato con un modello di ricerca diverso',
  'docs.reindexAllConfirm.title.one': 'Vuoi reindicizzare {count} documento?',
  'docs.reindexAllConfirm.title.many': 'Vuoi reindicizzare {count} di documenti?',
  'docs.reindexAllConfirm.title.other': 'Vuoi reindicizzare {count} documenti?',
  'docs.reindexAllConfirm.body':
    'Ogni documento con un indice non aggiornato viene riletto e preparato di nuovo per la ' +
    'ricerca, uno alla volta. Può richiedere diversi minuti e impegna molto il processore: puoi ' +
    'continuare a lavorare, ma le risposte potrebbero essere più lente finché l’operazione non ' +
    'termina.',
  'docs.reindexAllConfirm.confirm': 'Reindicizza tutto',
  'docs.retryAllFailed': 'Riprova tutto ({count})',
  'docs.retryAllFailedTitle': 'Reindicizza ogni documento la cui indicizzazione non è riuscita',
  'docs.retryAllConfirm.title.one': 'Vuoi riprovare {count} importazione non riuscita?',
  'docs.retryAllConfirm.title.many': 'Vuoi riprovare {count} di importazioni non riuscite?',
  'docs.retryAllConfirm.title.other': 'Vuoi riprovare {count} importazioni non riuscite?',
  'docs.retryAllConfirm.body':
    'Ogni documento la cui importazione non è riuscita viene riletto e preparato di nuovo per la ' +
    'ricerca, uno alla volta. Può richiedere diversi minuti e impegna molto il processore: puoi ' +
    'continuare a lavorare, ma le risposte potrebbero essere più lente finché l’operazione non ' +
    'termina. I documenti la cui importazione non riesce nemmeno questa volta restano in questo ' +
    'elenco.',
  'docs.retryAllConfirm.confirm': 'Riprova tutto',
  'docs.reindexAllProgress': 'Reindicizzazione: {done} su {total}…',
  'docs.reindexAllCancel': 'Annulla',
  'docs.reindexAllCancelled': 'Reindicizzazione interrotta. Completati: {done} su {total}.',
  'docs.reindexAllDone.one': '{count} documento reindicizzato.',
  'docs.reindexAllDone.many': '{count} di documenti reindicizzati.',
  'docs.reindexAllDone.other': '{count} documenti reindicizzati.',
  'docs.reindexAllPartial':
    'Reindicizzati: {done} su {total}. Non riusciti: {failed}. I documenti non reindicizzati ' +
    'restano in Documenti, tra quelli che richiedono attenzione.',
  'docs.supported.base':
    'Formati supportati: TXT, Markdown, PDF, DOCX, CSV e registrazioni audio (WAV, MP3, FLAC, ' +
    'OGG), trascritte su questa unità',
  'docs.supported.ocrExtra': ', e foto di pagine (PNG, JPG), lette su questa unità',
  'docs.preparing':
    'I tuoi documenti sono in preparazione, così potrai fare domande sul loro contenuto…',
  'docs.empty.title': 'Ancora nessun documento',
  'docs.empty.line':
    'Importa file per fare domande sul loro contenuto. Tutto resta su questa unità.',
  'docs.selectAria': 'Seleziona «{title}» per le domande',
  'docs.selectTitle': 'Seleziona per fare domande solo sui documenti scelti',
  'docs.selectAllAria': 'Seleziona tutti i documenti',
  'docs.selectAllTitle': 'Seleziona tutti i documenti visibili oppure togli la selezione',
  'docs.meta.sectionsCount.one': '{count} sezione',
  'docs.meta.sectionsCount.many': '{count} di sezioni',
  'docs.meta.sectionsCount.other': '{count} sezioni',
  'docs.meta.summary': 'Riassunto',
  'docs.meta.type.text': 'Testo',
  'docs.meta.type.audio': 'Audio',
  'docs.meta.type.image': 'Immagine',
  'docs.scan.ocrOffer':
    'Usa «Rendi ricercabile (OCR)» su questa riga per leggere le pagine su questa unità.',
  'docs.scan.ocrMissing':
    'Per renderlo ricercabile servono i file OCR, che non sono su questa unità. Scaricali qui ' +
    'sotto oppure, su un’unità che hai configurato tu, aggiungili con «fetch-runtime --family ' +
    'ocr».',
  'docs.scan.ocrMissingOffline':
    'Per renderlo ricercabile servono i file OCR, che non sono su questa unità. Per aggiungerli, ' +
    'esegui di nuovo la configurazione dell’unità con «--with-assets», oppure scarica solo i ' +
    'file OCR con «fetch-runtime --family ocr».',
  'docs.photo.ocrMissing':
    'Scarica qui sotto i file OCR, poi usa «Riprova» per leggere questa foto.',
  'docs.photo.ocrMissingOffline':
    'Aggiungi i file OCR con la configurazione dell’unità («fetch-runtime --family ocr»), poi ' +
    'usa «Riprova» per leggere questa foto.',
  'docs.photo.ocrReady':
    'Il riconoscimento del testo ora è pronto: usa «Riprova» per leggere questa foto.',
  'docs.scan.ocrUnavailable':
    'Per rendere ricercabile una scansione serve il riconoscimento del testo (OCR), che non è ' +
    'stato possibile avviare in questa versione.',
  'docs.ocr.unavailableBanner':
    'Il riconoscimento del testo (OCR) non è disponibile in questa versione: i file OCR sono su ' +
    'questa unità, ma non è stato possibile avviare il riconoscimento. Finché il problema non ' +
    'viene risolto, le foto vengono salvate senza testo leggibile e i PDF scansionati non ' +
    'possono essere resi ricercabili.',
  'docs.stale.banner':
    'Questo documento è stato preparato con un modello di ricerca diverso: reindicizzalo, così ' +
    'le risposte potranno trovarlo.',
  'docs.preview': 'Anteprima',
  'docs.previewBusy': 'Apertura…',
  'docs.previewTitle': 'Leggi il testo estratto (sola lettura; nulla esce dall’app)',
  'docs.cancel': 'Annulla',
  'docs.cancelOcrTitle': 'Interrompi la lettura della scansione',
  'docs.cancelTaskTitle': 'Interrompi l’attività',
  'docs.task.stateUnknown':
    'Non è stato possibile controllare lo stato di questa attività: potrebbe essere ancora in ' +
    'corso.',
  'docs.task.dismiss': 'Chiudi',
  'docs.makeSearchable': 'Rendi ricercabile (OCR)',
  'docs.makeSearchableTitle':
    'Leggi le pagine scansionate con il riconoscimento del testo locale: nulla esce da questa ' +
    'unità',
  'docs.makeSearchableAgain': 'Rileggi (OCR)',
  'docs.makeSearchableAgainPhotoTitle': 'Rileggi la foto con il riconoscimento del testo locale',
  'docs.makeSearchableAgainTitle':
    'Esegui di nuovo il riconoscimento del testo locale e sostituisci la lettura salvata; ' +
    '«Reindicizza» invece la riutilizza',
  'docs.summarize': 'Riassumi',
  'docs.summarizeAgain': 'Riassumi di nuovo',
  'docs.translate': 'Traduci',
  'docs.translateNoModel': 'Ottieni il modello di traduzione…',
  'docs.translateNoModelTitle':
    'Per tradurre serve il modello di traduzione: scaricalo nella schermata Modello IA',
  'docs.export': 'Esporta',
  'docs.exportOriginal': 'Esporta il file originale',
  'docs.exportOriginal.gone':
    'La copia salvata di questo file non è su questa unità, quindi non è possibile esportarla. ' +
    'Puoi comunque esportarne il testo estratto.',
  'docs.exportOriginalConfirm.title': 'Vuoi esportare il file originale?',
  'docs.exportOriginal.warning':
    'Questo file esportato viene salvato fuori dall’area di lavoro crittografata di HilbertRaum ' +
    'e non è protetto dalla password della tua area di lavoro.',
  'docs.reindex': 'Reindicizza',
  'docs.reindexBusy': 'Reindicizzazione…',
  'docs.reindexTitle': 'Rileggi e prepara di nuovo la copia salvata',
  'docs.reindexDone': 'Documento «{title}» reindicizzato.',
  'docs.delete': 'Elimina',
  'docs.deleteBusy': 'Eliminazione…',
  'docs.deleteDone': 'Documento «{title}» eliminato.',
  'docs.failed.remove': 'Rimuovi',
  'docs.failed.removeTitle': 'Rimuovi dall’elenco questa importazione non riuscita',
  'docs.failed.retry': 'Riprova',
  'docs.backToChat': 'Torna alla chat',
  'docs.failed.retryTitle': 'Rileggi e prepara di nuovo questo file',
  'docs.moreActions': 'Altre azioni per «{title}»',
  'docs.audioConfirm.title': 'Vuoi importare file audio di grandi dimensioni?',
  'docs.audioConfirm.confirm': 'Importa e trascrivi',
  'docs.audioConfirm.contains.one':
    'Questa selezione contiene {count} registrazione audio ({size}).',
  'docs.audioConfirm.contains.many':
    'Questa selezione contiene {count} di registrazioni audio ({size}).',
  'docs.audioConfirm.contains.other':
    'Questa selezione contiene {count} registrazioni audio ({size}).',
  'docs.audioConfirm.body':
    'Ogni registrazione viene copiata nella tua area di lavoro e trascritta su questa unità: una ' +
    'registrazione lunga può richiedere un po’ di tempo. Nel frattempo puoi continuare a usare ' +
    'l’app.',
  'docs.deleteConfirm.title': 'Vuoi eliminare «{title}»?',
  'docs.deleteConfirm.body':
    'Il documento, il testo estratto e l’indice di ricerca vengono eliminati definitivamente ' +
    'dalla tua area di lavoro. Il file originale fuori dall’area di lavoro non viene toccato.',
  'docs.translateModal.title': 'Traduci «{title}»',
  'docs.translateModal.aria': 'Traduci {title}',
  'docs.translateModal.hint':
    'Il modello locale scrive una copia tradotta come nuovo documento: puoi cercare nel suo ' +
    'testo e fare domande sul suo contenuto come per ogni file importato, e nulla esce da questa ' +
    'unità. Le traduzioni automatiche possono contenere errori.',
  'docs.translateModal.from': 'Da',
  'docs.translateModal.to': 'A',
  'docs.translateModal.start': 'Traduci',
  'docs.translateModal.sameLang': 'Scegli due lingue diverse.',
  'docs.previewModal.aria': 'Anteprima di «{title}»',
  'docs.previewModal.hint':
    'Testo estratto in sola lettura: è su questo che si basano la ricerca nei documenti e le ' +
    'risposte.',
  'docs.previewModal.ocrInfo.one':
    'Testo riconosciuto su questa unità (OCR): {count} pagina. Il riconoscimento può contenere ' +
    'errori.',
  'docs.previewModal.ocrInfo.many':
    'Testo riconosciuto su questa unità (OCR): {count} di pagine. Il riconoscimento può ' +
    'contenere errori.',
  'docs.previewModal.ocrInfo.other':
    'Testo riconosciuto su questa unità (OCR): {count} pagine. Il riconoscimento può contenere ' +
    'errori.',
  'docs.previewModal.ocrInfoPhoto':
    'Testo riconosciuto su questa unità (OCR) da questa foto. Il riconoscimento può contenere ' +
    'errori.',
  'docs.previewModal.ocrInfoPartial':
    'Testo riconosciuto su questa unità (OCR). Pagine con testo riconosciuto: {count} su ' +
    '{total}. Il riconoscimento può contenere errori.',
  'docs.previewModal.ocrInfoNone.one':
    'Il riconoscimento del testo (OCR) ha letto su questa unità {count} pagina scansionata e non ' +
    'ha trovato testo.',
  'docs.previewModal.ocrInfoNone.many':
    'Il riconoscimento del testo (OCR) ha letto su questa unità {count} di pagine scansionate e ' +
    'non ha trovato testo.',
  'docs.previewModal.ocrInfoNone.other':
    'Il riconoscimento del testo (OCR) ha letto su questa unità {count} pagine scansionate e non ' +
    'ha trovato testo.',
  'docs.ocr.unsure.page': 'Il riconoscimento del testo è stato incerto su questa pagina.',
  'docs.ocr.unsure.onlyRecognized':
    'Il riconoscimento del testo è stato incerto sull’unica pagina riconosciuta.',
  'docs.ocr.unsure.photo': 'Il riconoscimento del testo è stato incerto su questa foto.',
  'docs.ocr.unsure.some':
    'Il riconoscimento del testo è stato incerto su una parte delle pagine riconosciute: {count} ' +
    'su {total}.',
  'docs.ocr.unsure.all':
    'Il riconoscimento del testo è stato incerto su tutte le pagine riconosciute ({count}).',
  'docs.ocr.scannedPages': 'Pagine scansionate ancora senza testo leggibile: {count} su {total}.',
  'docs.ocr.scannedPagesNeedsOcr': 'Per leggerle servono i file OCR (schermata Modello IA).',
  'docs.ocr.unsure.causes':
    'Un originale sfocato, storto o scritto a mano viene letto male, e lo stesso vale per una ' +
    'lingua diversa dal tedesco o dall’inglese.',
  'docs.previewModal.summary': 'Riassunto',
  'docs.previewModal.generatedBy': 'Generato da {model}',
  'docs.previewModal.truncated':
    'Questo documento è lungo: il riassunto ne copre l’inizio. Puoi comunque cercare nel resto ' +
    'del testo e fare domande sul suo contenuto in chat.',
  'docs.previewModal.regenerate': 'Rigenera',
  'docs.previewModal.copy': 'Copia',
  'docs.previewModal.save': 'Salva',
  'docs.previewModal.copied': 'Riassunto copiato',
  'docs.previewModal.copyFailed': 'Non è stato possibile copiare negli Appunti',
  'docs.previewModal.savedTo': 'Riassunto salvato in {path}',
  'docs.previewModal.noText': 'Non è stato possibile estrarre testo da questo documento.',
  'docs.previewModal.documentText': 'Testo del documento',
  'docs.previewModal.page': 'Pagina {page}',
  'docs.previewModal.showMore': 'Mostra altro',
  'docs.previewModal.loadingMore': 'Caricamento…',
  'docs.previewModal.segmentProgress': 'Visualizzazione: {shown} su {total}',
  // ---- Deep index + coverage (whole-document-analysis plan §5.2) ----
  'docs.deepIndex.build': 'Crea indice approfondito',
  'docs.deepIndex.reindexFirst': 'Reindicizza per l’indice approfondito',
  'docs.deepIndex.ready': 'Indicizzato a fondo',
  'docs.deepIndex.readyTitle':
    'È pronto un indice approfondito dell’intero documento: i riassunti e le risposte con ' +
    'elenchi possono coprire tutto il contenuto',
  'coverage.relevance': 'Basata sui brani più pertinenti, non sull’intero documento',
  'coverage.relevance.counted': 'Sezioni usate: {covered} su {total}',
  'coverage.capped.whole': 'Copre l’intero documento',
  'coverage.capped.beginning': 'Copre l’inizio del documento',
  'coverage.tree.whole': 'Copre l’intero documento (indicizzato a fondo)',
  'coverage.tree.beginning':
    'Copre l’inizio del documento: era troppo grande per essere letto per intero',
  'coverage.tree.partial': 'Indice approfondito in creazione · sezioni: {covered} su {total}',
  'coverage.tree.pending': 'Nessun indice approfondito',
  'coverage.depth': 'Dettaglio: {label}',
  'coverage.tier.1': 'Panoramica',
  'coverage.tier.2': 'Sezione per sezione',
  'coverage.tier.3': 'Massimo (copertura completa)',
  'coverage.tier.hint.1': 'Più veloce: usa la panoramica salvata',
  'coverage.tier.hint.2': 'Un’analisi più approfondita delle sezioni',
  'coverage.tier.hint.3': 'Il massimo dettaglio, sull’intero documento',
  'coverage.tierSelect.trigger': 'Dettaglio: {label}',
  'coverage.extract.whole': 'Lettura dell’intero documento · sezioni analizzate: {scanned}',
  'coverage.extract.wholeUnparsed':
    'Lettura dell’intero documento · sezioni analizzate: {scanned}, non lette: {unparsed}',
  'coverage.extract.sections': 'Sezioni analizzate: {scanned}',
  'coverage.extract.sectionsUnparsed': 'Sezioni analizzate: {scanned}, non lette: {unparsed}',
  // ---- "List every X" answer (whole-document-analysis plan §4.2, Phase 3) ----
  'analysis.kind.generic': 'elementi',
  'analysis.kind.date': 'date',
  'analysis.kind.amount': 'importi',
  'analysis.kind.party': 'parti',
  'analysis.kind.obligation': 'obblighi',
  'analysis.listing.coverageWhole':
    'Risultati ({kind}) nell’intero documento: {count} – sezioni analizzate: {scanned}{unparsed}:',
  'analysis.listing.coverageSections':
    'Risultati ({kind}): {count} – sezioni analizzate: {scanned}{unparsed}:',
  'analysis.listing.empty': 'Nessun risultato ({kind}). Sezioni analizzate: {scanned}{unparsed}.',
  'analysis.listing.unparsedSuffix': ' (non lette: {k})',
  'analysis.listing.item': '- {value} (×{count})',
  'analysis.listing.caveat':
    'Questo elenco copre tutte le sezioni analizzate, ma non è garantito che sia completo (un ' +
    'modello piccolo può tralasciare un elemento e voci molto simili possono essere unite).',
  'analysis.listing.refPage': 'p. {n}',
  'analysis.listing.refSection': 'sezione {n}',
  'analysis.listing.unparsedHint':
    '**Nota:** durante l’indicizzazione di questo documento non è stato possibile leggere la ' +
    'maggior parte delle sezioni, quindi questo risultato non è affidabile. Apri Documenti ed ' +
    'esegui di nuovo «Crea indice approfondito»: le sezioni non lette verranno elaborate di ' +
    'nuovo (un modello più grande aiuta).',
  'analysis.listing.unparsedHintAmountSkill':
    'Per un estratto conto, la skill «Analisi dell’estratto conto» nel menu delle skill della ' +
    'chat legge gli importi con precisione.',
  'analysis.listing.aggregationHint':
    '**Nota:** hai chiesto categorie o somme, ma questa risposta può solo elencare i valori ' +
    'trovati nel documento, con il numero di volte in cui compaiono: non può raggrupparli né ' +
    'sommarli.',
  'analysis.listing.aggregationHintAmountSkill':
    'Per un estratto conto, attiva la skill «Analisi dell’estratto conto» nel menu delle skill ' +
    'della chat e fai di nuovo la domanda: la skill raggruppa le transazioni per categoria e ' +
    'somma con precisione ogni categoria.',
  'analysis.wholeDocHint':
    '**Nota:** questa risposta si basa solo sulle sezioni più pertinenti, quindi potrebbe ' +
    'tralasciare alcuni elementi. Per un elenco che copra tutte le sezioni, apri Documenti, ' +
    'scegli «Crea indice approfondito» per il documento e fai di nuovo la domanda.',
  'analysis.partialAnswerHint':
    '**Nota:** questa risposta si basa solo sulle sezioni più pertinenti, quindi potrebbe ' +
    'tralasciare alcuni elementi.',
  'analysis.wholeReadSumHint':
    '**Nota:** il modello calcola i totali da solo e può tralasciare o contare male alcune voci. ' +
    'Controlla ogni totale confrontandolo con le fonti.',
  // ---- Bank-statement analysis answer (full-doc-skills plan §3.1, Phase 2) ----
  'skills.bankAnalysis.count': 'Transazioni lette nell’intero estratto conto: **{count}**.',
  'skills.bankAnalysis.countPartial':
    'Transazioni lette: **{count}**. Righe con un importo che non ho potuto riconoscere come ' +
    'transazione: **{dropped}**. L’elenco quindi potrebbe non comprendere tutte le transazioni: ' +
    'confronta con il documento ogni riga di questo tipo.',
  'skills.bankAnalysis.countContradicted':
    'Transazioni lette: **{count}**. Tuttavia i saldi riportati in questo estratto conto non ' +
    'quadrano con le transazioni lette, quindi non posso confermare che l’elenco sia completo.',
  'skills.bankAnalysis.empty':
    'Ho esaminato l’intero documento, ma non ho potuto ricavarne nessuna transazione. Le righe ' +
    'potrebbero trovarsi in un’immagine scansionata o in un layout insolito che il mio strumento ' +
    'di lettura non riesce a seguire. Se è una scansione, esegui prima il riconoscimento del ' +
    'testo (OCR); altrimenti il layout potrebbe non essere leggibile in modo automatico: apri ' +
    'l’estratto conto e leggi direttamente gli importi.',
  'skills.bankAnalysis.couldNotRead':
    'Non ho potuto leggere questo estratto conto, quindi non posso analizzarlo.',
  'skills.bankAnalysis.unreconciledHeading':
    'Controlla prima le righe seguenti, perché il saldo progressivo riportato non quadra con gli ' +
    'importi:',
  'skills.bankAnalysis.unreconciledItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.totals':
    'Entrate: **{inAmount} {currency}** · Uscite: **{outAmount} {currency}** · Variazione netta: ' +
    '**{netAmount} {currency}**.',
  'skills.bankAnalysis.noCurrency':
    'Queste transazioni sono in più di una valuta, quindi non esiste un unico totale ' +
    'complessivo: un totale andrebbe calcolato separatamente per ogni valuta.',
  'skills.bankAnalysis.incompleteNoTotal':
    'Non posso confermare di aver letto per intero l’estratto conto: i saldi riportati non ' +
    'quadrano con le transazioni che ho letto, quindi gli importi potrebbero essere stati letti ' +
    'male o essere incompleti. Per non darti un totale che potrebbe essere sbagliato, qui non ' +
    'indico nessuna somma: apri l’estratto conto e controlla direttamente gli importi.',
  'skills.bankAnalysis.categoryHeading': 'Per categoria:',
  'skills.bankAnalysis.categoryItem': '- {category}: {amount} {currency} ({count})',
  'skills.bankAnalysis.categoryAssisted':
    '_Le categorie sono assegnate con l’aiuto del modello: un’etichetta potrebbe essere ' +
    'sbagliata, ma i totali qui sopra non cambiano._',
  'skills.bankAnalysis.categoryRuleBased':
    '_Questo è un raggruppamento rapido basato su regole (senza modello). Per una suddivisione ' +
    'più dettagliata, con l’aiuto del modello, scegli «Categorizza»._',
  'skills.bankCategory.Groceries': 'Spesa alimentare',
  'skills.bankCategory.Dining': 'Ristoranti',
  'skills.bankCategory.Transport': 'Trasporti',
  'skills.bankCategory.Utilities': 'Utenze',
  'skills.bankCategory.Rent': 'Affitto',
  'skills.bankCategory.Insurance': 'Assicurazioni',
  'skills.bankCategory.Subscriptions': 'Abbonamenti',
  'skills.bankCategory.Health': 'Salute',
  'skills.bankCategory.Shopping': 'Acquisti',
  'skills.bankCategory.Income': 'Redditi',
  'skills.bankCategory.Transfer': 'Trasferimenti',
  'skills.bankCategory.Fees': 'Commissioni',
  'skills.bankCategory.Cash': 'Contanti',
  'skills.bankCategory.Tax': 'Tasse',
  'skills.bankCategory.Spending': 'Spese',
  'skills.bankCategory.Uncategorized': 'Senza categoria',
  'skills.bankAnalysis.caveat':
    'Questi valori sono gli importi riportati nell’estratto conto stesso, letti nell’intero ' +
    'documento: nulla è stato calcolato dal testo discorsivo né inventato.',
  'skills.bankAnalysis.unverifiedCaveat':
    'Questi valori sono la somma delle transazioni che ho letto nell’intero documento (in tutto: ' +
    '**{count}**). L’estratto conto non riporta un saldo iniziale o finale, quindi non posso ' +
    'confermare che l’elenco comprenda tutte le transazioni: considera questi valori una somma ' +
    'delle righe mostrate, non un totale controllato dell’estratto conto. Nulla è stato ' +
    'calcolato dal testo discorsivo né inventato.',
  'skills.bankAnalysis.dateOrderCaveat':
    'Nota sulle date: questo estratto conto non indica se il giorno viene prima del mese o ' +
    'viceversa, quindi le ho lette con il giorno per primo (giorno.mese.anno). Una data come ' +
    '03.05. può perciò essere il 3 maggio o il 5 marzo. Controlla nel documento ogni data ' +
    'importante.',
  'skills.bankAnalysis.transactionsHeading': 'Transazioni:',
  'skills.bankAnalysis.transactionItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.transactionsMore':
    '… e **{count}** in più. Per vedere tutte le righe, scegli **Esporta in CSV** nella barra di ' +
    'esecuzione e salva l’intero estratto conto, oppure chiedilo semplicemente in formato CSV o ' +
    'JSON qui nella chat.',
  'skills.bankAnalysis.figureEcho': 'Totali calcolati dalle transazioni estratte: {figures}.',
  'skills.bankAnalysis.figureEchoIn': 'entrate {amount} {currency}',
  'skills.bankAnalysis.figureEchoOut': 'uscite {amount} {currency}',
  'skills.bankAnalysis.figureEchoNet': 'variazione netta {amount} {currency}',
  'skills.bankAnalysis.formatIntro':
    'Ecco l’estratto conto in formato {format}, creato solo dagli importi che ho letto (nulla è ' +
    'stato calcolato dal testo discorsivo né inventato):',
  'skills.bankAnalysis.formatIntroCsv':
    'Ecco l’estratto conto in formato CSV, solo con le righe delle transazioni, creato dagli ' +
    'importi che ho letto (nulla è stato calcolato dal testo discorsivo né inventato). Il ' +
    'riassunto di entrate e uscite e i saldi iniziale e finale non sono inclusi nel CSV: chiedi ' +
    'l’estratto conto in formato JSON per avere anche quelli.',
  'skills.bankAnalysis.customCategoriesNeedModel':
    'Per suddividere le transazioni nelle tue categorie ({categories}) mi serve un modello ' +
    'locale in esecuzione: le regole rapide integrate conoscono solo le loro categorie fisse. ' +
    'Avvia un modello, poi fai di nuovo la domanda.',
  'skills.bankAnalysis.customTaxonomyNotFound':
    'Non ho trovato «{name}» tra i tuoi documenti. Prima importa il file (Documenti → Importa ' +
    'file), poi fai di nuovo la domanda.',
  'skills.bankAnalysis.customTaxonomyUnparseable':
    'Ho letto il file «{name}», ma non ho potuto usarlo come elenco di categorie. Il formato ' +
    'previsto è una categoria per riga: un’etichetta, seguita, se vuoi, da parole chiave dopo un ' +
    'punto e virgola (per esempio «Figli;Scuola, Asilo, Paghetta»).',
  'skills.bankAnalysis.derivedColumnsNote':
    '_Colonne compilate dal modello locale in base alla descrizione di ogni transazione: ' +
    '{columns}. Dove il modello non era sicuro, le celle sono rimaste vuote. Tutti gli importi ' +
    'provengono dall’estrazione deterministica e non sono stati modificati._',
  // ---- Invoice analysis answer (full-doc-skills plan §3.1, Phase 4 / D49) ----
  'skills.invoiceAnalysis.count': 'Ho letto l’intera fattura. Voci: **{count}**.',
  'skills.invoiceAnalysis.countPartial':
    'Voci lette: **{count}**. Righe con un importo che non ho potuto riconoscere come voce: ' +
    '**{dropped}**. L’elenco quindi potrebbe non comprendere tutte le voci: confronta con il ' +
    'documento ogni riga di questo tipo.',
  'skills.invoiceAnalysis.empty':
    'Ho esaminato l’intero documento, ma non ho potuto ricavarne né voci né totali. Gli importi ' +
    'potrebbero trovarsi in un’immagine scansionata o in un layout insolito che il mio strumento ' +
    'di lettura non riesce a seguire. Se è una scansione, esegui prima il riconoscimento del ' +
    'testo (OCR); altrimenti il layout potrebbe non essere leggibile in modo automatico: apri la ' +
    'fattura e leggi direttamente gli importi.',
  'skills.invoiceAnalysis.couldNotRead':
    'Non ho potuto leggere questa fattura, quindi non posso analizzarla.',
  'skills.invoiceAnalysis.unreconciledHeading':
    'Controlla prima i totali seguenti, perché non quadrano:',
  'skills.invoiceAnalysis.checkLineItemsSumToNet':
    'la somma delle voci non corrisponde al totale netto riportato',
  'skills.invoiceAnalysis.checkNetPlusTaxIsGross':
    'il netto più l’imposta non corrisponde al totale lordo riportato',
  'skills.invoiceAnalysis.checkTaxMatchesRate':
    'l’importo dell’imposta non corrisponde all’aliquota indicata',
  'skills.invoiceAnalysis.unreconciledItem': '- {check}',
  'skills.invoiceAnalysis.totalsHeading': 'Totali, esattamente come riportati nel documento:',
  'skills.invoiceAnalysis.net': '- Netto: **{value}**',
  'skills.invoiceAnalysis.tax': '- Imposta: **{value}**',
  'skills.invoiceAnalysis.taxWithRate': '- Imposta ({rate}%): **{value}**',
  'skills.invoiceAnalysis.gross': '- Totale lordo (importo da pagare): **{value}**',
  'skills.invoiceAnalysis.positionsHeading': 'Voci:',
  'skills.invoiceAnalysis.positionItem': '- {description} · {amount} {currency}',
  'skills.invoiceAnalysis.positionsMore':
    '… e **{count}** in più. Per vedere tutte le voci, chiedimi di esportare la fattura in ' +
    'formato CSV.',
  'skills.invoiceAnalysis.formatIntro':
    'Ecco la fattura in formato {format}, creata solo dagli importi che ho letto (nulla è stato ' +
    'calcolato dal testo discorsivo né inventato):',
  'skills.invoiceAnalysis.formatIntroCsv':
    'Ecco la fattura in formato CSV, solo con le voci, creata dagli importi che ho letto (nulla ' +
    'è stato calcolato dal testo discorsivo né inventato). L’intestazione (fornitore, numero ' +
    'della fattura, date) e i totali non sono inclusi nel CSV: chiedi la fattura in formato JSON ' +
    'o XML per avere anche quelli.',
  'skills.invoiceAnalysis.noTotals':
    'Nella fattura non ho trovato un totale netto, un totale dell’imposta o un totale lordo che ' +
    'potessi leggere.',
  'skills.invoiceAnalysis.caveat':
    'Questi valori sono gli importi riportati nella fattura stessa, letti nell’intero documento: ' +
    'nulla è stato calcolato dal testo discorsivo né inventato.',
  'skills.invoiceAnalysis.dateOrderCaveat':
    'Nota sulle date: questa fattura non indica se il giorno viene prima del mese o viceversa, ' +
    'quindi le ho lette con il giorno per primo (giorno.mese.anno). Una data come 03.05. può ' +
    'perciò essere il 3 maggio o il 5 marzo. Controlla nel documento ogni data importante.',
  'skills.invoiceAnalysis.detailsHeading': 'Dettagli, come riportati nel documento:',
  'skills.invoiceAnalysis.detailVendor': '- Fornitore: {vendor}',
  'skills.invoiceAnalysis.detailRecipient':
    '- Destinatario (intestatario della fattura): {recipient}',
  'skills.invoiceAnalysis.detailInvoiceNumber': '- Numero della fattura: {number}',
  'skills.invoiceAnalysis.detailInvoiceDate': '- Data della fattura: {date}',
  'skills.invoiceAnalysis.detailDueDate': '- Data di scadenza: {date}',
  'skills.invoiceAnalysis.figureEcho':
    'Importi estratti, riportati testualmente dal documento: {figures}.',
  'skills.invoiceAnalysis.figureEchoNet': 'netto {value}',
  'skills.invoiceAnalysis.figureEchoTax': 'imposta {value}',
  'skills.invoiceAnalysis.figureEchoGross': 'lordo {value}',
  'skills.invoiceAnalysis.totalsHeadingUnverified':
    'Importi come riportati nel documento (**non quadrano**, quindi considerali non controllati):',
  'skills.invoiceAnalysis.unreconciledCaveat':
    'Questi importi riportati si contraddicono, il che di solito significa che il testo del ' +
    'documento non è stato estratto correttamente (una scansione, un PDF composto da immagini o ' +
    'un layout insolito). Non fare affidamento su nessuno di questi numeri senza controllare il ' +
    'documento originale.',
  'skills.invoiceAnalysis.figureEchoSuppressed':
    'Qui non ripeto i totali estratti: non quadrano tra loro né con le voci, quindi presentarli ' +
    'come valori affidabili sarebbe fuorviante. Controlla il documento originale.',
  'skills.invoiceAnalysis.unreadableLayout':
    'Il testo di questo documento non si estrae correttamente: i caratteri risultano mescolati ' +
    '(glifo per glifo), il che di solito indica un PDF composto da immagini o con una codifica ' +
    'insolita. Non ho potuto leggerne voci o totali affidabili, quindi non riporto nessun ' +
    'importo. Se è una scansione, esegui prima il riconoscimento del testo (OCR); altrimenti ' +
    'apri la fattura e leggi direttamente gli importi.',
  'skills.invoiceAnalysis.textQualityCaveat':
    'Nota: alcune parti del testo di questo documento sono state estratte con i caratteri ' +
    'mescolati (glifo per glifo). Gli importi qui sopra quadrano, ma controlla ogni dato ' +
    'importante nel documento originale.',
  'skills.analysis.refusePartial':
    'Posso rispondere con precisione solo in base all’intero documento, e questo non è ancora ' +
    'indicizzato del tutto. Apri la schermata Documenti, scegli «Reindicizza», poi fai di nuovo ' +
    'la domanda.',
  'skills.analysis.scopeNarrowed':
    'Per rispondere ho usato solo il documento **{title}**. Documenti tra le fonti della chat ' +
    'che non ho letto: {count}. Per analizzarne un altro, seleziona solo quel documento (o ' +
    'scrivi il nome del suo file nella domanda) e fai di nuovo la domanda.',
  'skills.analysis.selectOne':
    'Per un’analisi completa mi serve un solo documento. Al momento i documenti selezionati ' +
    'sono: {count}. Così vedo solo alcuni brani sparsi tra questi documenti. Seleziona un ' +
    'documento (o scrivi il nome del suo file nella domanda) e fai di nuovo la domanda.',
  'skills.analysis.selectTwo':
    'Per un confronto, seleziona esattamente **due** documenti (o due versioni). Al momento i ' +
    'documenti selezionati sono: {count}. Scegli i due che vuoi confrontare e fai di nuovo la ' +
    'domanda.',
  'skills.redactionRouting.answer':
    'Per oscurare questo documento, scegli **{button}**, il pulsante subito sopra il campo del ' +
    'messaggio, poi indica dove salvare la copia. Lo strumento funziona interamente su questo ' +
    'dispositivo e, leggendo l’intero documento, oscura i dati personali in formati chiaramente ' +
    'riconoscibili: indirizzi e-mail, numeri di telefono, IBAN, date e link. È un primo ' +
    'intervento nei limiti del possibile, non una garanzia: non riconosce i nomi né i formati ' +
    'insoliti, quindi controlla la copia salvata prima di condividerla.',
  'skills.redactionRouting.answerMulti':
    'Per oscurare un documento, scegli **{button}**, il pulsante subito sopra il campo del ' +
    'messaggio, seleziona il documento da oscurare, poi indica dove salvare la copia. Lo ' +
    'strumento elabora un documento alla volta, funziona interamente su questo dispositivo e, ' +
    'leggendo l’intero documento, oscura i dati personali in formati chiaramente riconoscibili: ' +
    'indirizzi e-mail, numeri di telefono, IBAN, numeri di carte di pagamento, date e link. È un ' +
    'primo intervento nei limiti del possibile, non una garanzia: non riconosce i nomi né i ' +
    'formati insoliti, quindi controlla la copia salvata prima di condividerla.',
  'skills.editRouting.answer':
    'Per apportare queste modifiche, scegli **{button}**, il pulsante subito sopra il campo del ' +
    'messaggio, poi indica dove salvare la copia modificata. Lo strumento funziona interamente su ' +
    'questo dispositivo e applica solo le sostituzioni esatte (trova e sostituisci) che hai chiesto, ' +
    'ovunque trovi il testo in forma identica, senza cambiare nient’altro. Non riscrive mai il ' +
    'documento, quindi non può inventare né riformulare nulla. Un documento Word mantiene il formato ' +
    '.docx; gli altri formati vengono salvati come file di testo (.txt). Controlla la copia prima di ' +
    'condividerla.',
  'skills.editRouting.answerMulti':
    'Per apportare queste modifiche, scegli **{button}**, il pulsante subito sopra il campo del ' +
    'messaggio, seleziona il documento da modificare, poi indica dove salvare la copia modificata. ' +
    'Lo strumento elabora un documento alla volta, funziona interamente su questo dispositivo e ' +
    'applica solo le sostituzioni esatte (trova e sostituisci) che hai chiesto, ovunque trovi il ' +
    'testo in forma identica, senza cambiare nient’altro. Non riscrive mai il documento. Un ' +
    'documento Word mantiene il formato .docx; gli altri formati vengono salvati come file di testo ' +
    '(.txt). Controlla la copia prima di condividerla.',
  'skills.redactionRouting.scan':
    'Ho esaminato l’intero documento alla ricerca di dati personali in formati chiaramente ' +
    'riconoscibili. Ecco cosa ho rilevato. Indirizzi e-mail: {email}; numeri di telefono: ' +
    '{phone}; IBAN: {iban}; numeri di carte di pagamento: {card}; date: {date}; link: {url}. La ' +
    'ricerca si basa su schemi e funziona nei limiti del possibile: non riconosce nomi, ' +
    'indirizzi postali o formati insoliti, quindi considera questi numeri un minimo, non un ' +
    'inventario completo. Per creare una copia oscurata, scegli **{button}**, il pulsante subito ' +
    'sopra il campo del messaggio, e indica dove salvarla.',
  // ---- Models (ModelsScreen.tsx) ----
  'models.title': 'Modello IA',
  'models.library.title': 'Libreria dei modelli',
  'models.library.view': 'Visualizzazione della libreria dei modelli',
  'models.library.onDrive': 'Su questa unità',
  'models.library.browse': 'Sfoglia modelli',
  'models.library.search': 'Cerca modelli',
  'models.library.searchPlaceholder': 'Nome, famiglia o variante…',
  'models.library.task': 'Attività',
  'models.library.allTasks': 'Tutte le attività',
  'models.library.family': 'Famiglia',
  'models.library.allFamilies': 'Tutte le famiglie',
  'models.library.familyNotInView': '{name} (nessun modello in questa visualizzazione)',
  'models.library.resetFamily': 'Tutte le famiglie',
  'models.library.noFamilyForTask':
    'Nessun modello della famiglia {family} corrisponde a questa attività.',
  'models.library.noFamilyOnDrive.one':
    'Su questa unità non c’è nessun modello della famiglia {family}. «Sfoglia modelli» mostra ' +
    '{count} modello.',
  'models.library.noFamilyOnDrive.many':
    'Su questa unità non c’è nessun modello della famiglia {family}. «Sfoglia modelli» mostra ' +
    '{count} di modelli.',
  'models.library.noFamilyOnDrive.other':
    'Su questa unità non c’è nessun modello della famiglia {family}. «Sfoglia modelli» mostra ' +
    '{count} modelli.',
  'models.library.chat': 'Chat',
  'models.library.translation': 'Traduzione',
  'models.library.images': 'Immagini',
  'models.library.voice': 'Voce',
  'models.library.memory': 'Memoria minima: {size}',
  'models.library.clear': 'Cancella i filtri',
  'models.library.showVariants': 'Mostra tutte le varianti ({count})',
  'models.library.hideVariants': 'Mostra meno varianti ({count})',
  'models.library.results.one': '{count} variante corrispondente',
  'models.library.results.many': '{count} di varianti corrispondenti',
  'models.library.results.other': '{count} varianti corrispondenti',
  'models.library.noMatches':
    'Nessun modello corrisponde a questi filtri. Prova un’altra ricerca o cancella i filtri.',
  'models.library.noneInstalled': 'Su questa unità non c’è ancora nessun modello pronto all’uso.',
  'models.library.onlyActive':
    'Il tuo modello installato è mostrato qui sopra. Sfoglia il catalogo per trovare alternative.',
  'models.library.noAlternatives': 'In questo catalogo non ci sono altri modelli.',
  'models.library.download': 'Download del modello in corso',
  'models.lead':
    'Il modello IA risponde alle tue domande, interamente su questo dispositivo. Tutto viene ' +
    'controllato prima dell’uso e nulla viene scaricato senza la tua conferma esplicita.',
  'models.loadError': 'Non è stato possibile caricare i modelli: {error}',
  'models.checking':
    'Controllo dei file dei modelli in corso… Il primo controllo dopo aver aggiunto o aggiornato ' +
    'un modello può richiedere qualche minuto per i file grandi; poi il risultato viene ' +
    'memorizzato e il controllo è immediato.',
  'models.checkingProgress': 'Controllo del modello {n} di {m}: {name} ({pct}%)',
  'models.state.installed': 'Installato',
  'models.state.missing': 'Non scaricato',
  'models.state.checksumFailed': 'Controllo non riuscito',
  'models.state.unsupported': 'Non supportato',
  'models.state.notRecommended': 'Non consigliato',
  'models.state.ready': 'Pronto',
  'models.state.running': 'Avviato',
  'models.badge.notResponding': 'Non risponde',
  'models.notRespondingHint':
    'Il modello IA ha smesso di rispondere. Di solito riavviarlo risolve il problema.',
  'models.restart': 'Riavvia',
  'models.hint.embeddings': 'Prepara i tuoi documenti, così puoi fare domande sul loro contenuto.',
  'models.hint.reranker': 'Migliora la scelta dei brani dei documenti usati per le risposte.',
  'models.hint.transcriber':
    'Trasforma le registrazioni audio in testo ricercabile e attiva il pulsante 🎤 per la ' +
    'dettatura vocale nella chat.',
  'models.hint.translation':
    'Traduce i tuoi documenti e testi da una lingua all’altra, interamente offline.',
  'models.hint.vision':
    'Risponde alle tue domande su un’immagine alla volta. Non legge i PDF e non rende ' +
    'ricercabili le scansioni.',
  'models.hint.small': 'Piccolo e rapido: risposte veloci su quasi tutti i computer.',
  'models.hint.balanced': 'Bilanciato: funziona bene sulla maggior parte dei portatili.',
  'models.hint.large': 'Grande: le risposte migliori; richiede un computer potente.',
  'models.usesSpace': 'Occupa {size} di spazio sull’unità',
  'models.downloads.blockedByPolicy': 'I download sono disattivati dai criteri di questa unità.',
  'models.downloads.enableInSettings':
    'Per scaricare, attiva «Consenti l’accesso a Internet per download e aggiornamenti dei modelli» ' +
    'nelle Impostazioni.',
  'models.download.verifying': 'Controllo del file scaricato in corso…',
  'models.download.progress': 'Download in corso… {pct}% ({received} su {total})',
  'models.download.progressNoTotal': 'Download in corso… finora {received}',
  'models.download.cancel': 'Annulla il download',
  'models.download.cancelled':
    'Download annullato: se avvii di nuovo il download, riprende dal punto in cui si era fermato.',
  'models.download.stoppedNetworkOff':
    'Download interrotto perché l’accesso a Internet è stato disattivato. Quando l’accesso è di ' +
    'nuovo attivo, avvia di nuovo il download: riprenderà dal punto in cui si era fermato.',
  'models.download.unverifiedBefore':
    'Scaricato, ma il manifest di questo modello non ha ancora un checksum reale, quindi il file ' +
    'resta non controllato. Generane uno con ',
  'models.download.unverifiedAfter': '.',
  'models.download.otherRunning':
    'È in corso un altro download: i modelli si scaricano uno alla volta',
  'models.download.titled': 'Scarica {name} ({size})',
  'models.download.resume': 'Riprendi il download',
  'models.download.start': 'Scarica',
  'models.download.failed': 'Il download di {name} non è riuscito.',
  'models.download.retry': 'Riprova il download',
  'models.download.dismiss': 'Chiudi',
  'models.download.retryUnavailable':
    'Questo modello non è più disponibile per il download qui, quindi non è possibile riprovare ' +
    'da questo risultato. Chiudi il risultato oppure cerca il modello nella libreria.',
  'models.download.retryInstalled': 'Già presente su questa unità.',
  'models.download.withdrawn':
    'Non più disponibile per il download: il fornitore ha rimosso proprio questo file ' +
    '({reason}). Le copie già presenti su un’unità continuano a funzionare e possono ancora ' +
    'essere controllate.',
  'models.engine.title': 'Installa il motore IA',
  'models.engine.explain':
    'I modelli funzionano in una modalità demo integrata (con risposte visibilmente simulate) ' +
    'finché non installi il motore IA; la dettatura vocale richiede il motore vocale. Installa i ' +
    'motori una sola volta, poi avvia un modello per avere risposte reali.',
  'models.engine.install': 'Installa il motore IA',
  'models.engine.retry': 'Riprova',
  'models.engineProblem.title': 'Il motore IA non può funzionare su questo computer',
  'models.engineProblem.voiceTitle': 'Il motore vocale non può funzionare su questo computer.',
  'models.engineProblem.libraryMissingPackage':
    'Manca una libreria di sistema necessaria al motore: {library}. Installa il pacchetto ' +
    '{debPackage} (Ubuntu, Debian, Linux Mint) o {rpmPackage} (Fedora) con il gestore software o ' +
    'da un terminale, poi scegli «Controlla di nuovo».',
  'models.engineProblem.libraryMissing':
    'Manca una libreria di sistema necessaria al motore: {library}. Installa la libreria con il ' +
    'gestore software o da un terminale, poi scegli «Controlla di nuovo».',
  'models.engineProblem.systemTooOldLinux':
    'Il motore richiede una versione più recente di Linux: Ubuntu 22.04, Debian 12, Fedora 36 o ' +
    'successive.',
  'models.engineProblem.systemTooOldMac':
    'Il motore richiede una versione più recente di macOS. Aggiorna macOS, poi scegli «Controlla ' +
    'di nuovo».',
  'models.engineProblem.systemTooOld':
    'Il motore richiede una versione più recente del sistema operativo.',
  'models.engineProblem.vcRuntimeMissing':
    'In Windows manca il Microsoft Visual C++ Redistributable (x64) necessario al motore. ' +
    'Installalo, poi scegli «Controlla di nuovo».',
  'models.engineProblem.filesDamaged':
    'Alcuni file del motore su questa unità mancano o sono danneggiati. La guida alla ' +
    'risoluzione dei problemi spiega come configurarlo di nuovo.',
  'models.engineProblem.filesDamagedReinstall':
    'Alcuni file del motore su questa unità mancano o sono danneggiati. Installa di nuovo il ' +
    'motore per sostituirli.',
  'models.engineProblem.filesDamagedAfterInstall':
    'Il motore è appena stato installato e ancora non riesce ad avviarsi, quindi probabilmente ' +
    'la causa non sono i suoi file. La guida alla risoluzione dei problemi spiega cos’altro ' +
    'controllare.',
  'models.engineProblem.filesDamagedAfterInstallWin':
    'Il motore è appena stato installato e ancora non riesce ad avviarsi, quindi probabilmente ' +
    'la causa non sono i suoi file. Può dipendere anche da un Microsoft Visual C++ ' +
    'Redistributable (x64) non aggiornato: installa quello attuale, poi scegli «Controlla di ' +
    'nuovo».',
  'models.engineProblem.reinstall': 'Installa di nuovo il motore IA',
  'models.engineProblem.voiceReinstall': 'Installa di nuovo il motore vocale',
  'models.engineProblem.reinstalled': 'Il motore IA è stato installato di nuovo.',
  'models.engineProblem.voiceReinstalled': 'Il motore vocale è stato installato di nuovo.',
  'models.engineUpdate.title': 'È disponibile un aggiornamento per il motore IA',
  'models.engineUpdate.voiceTitle': 'È disponibile un aggiornamento per il motore vocale',
  'models.engineUpdate.bothTitle':
    'Sono disponibili aggiornamenti per il motore IA e per il motore vocale',
  'models.engineUpdate.explain':
    'Questa unità contiene una versione meno recente di quella prevista da questa app. ' +
    'L’aggiornamento scarica prima la nuova versione; poi i modelli si fermano per qualche ' +
    'secondo mentre i file vengono sostituiti, e il modello selezionato si riavvia.',
  'models.engineUpdate.update': 'Aggiorna',
  'models.engineUpdate.done': 'Il motore IA è stato aggiornato.',
  'models.engineUpdate.voiceDone': 'Il motore vocale è stato aggiornato.',
  'models.engineUpdate.bothDone': 'Il motore IA e il motore vocale sono stati aggiornati.',
  'models.engineProblem.blocked':
    'La sicurezza di Windows ha bloccato il motore (Controllo intelligente delle app o il tuo ' +
    'antivirus). La guida alla risoluzione dei problemi spiega cosa puoi fare.',
  'models.engineProblem.demoNote':
    'Fino ad allora i modelli rispondono in modalità demo: le risposte sono simulate.',
  'models.engineProblem.check': 'Controlla di nuovo',
  'models.engineProblem.checking': 'Controllo in corso…',
  'models.engineProblem.stillFailing':
    'Il motore non riesce ancora ad avviarsi. Controlla che l’installazione sia terminata, poi ' +
    'riprova.',
  'models.engineProblem.fixed': 'Il motore IA funziona di nuovo.',
  'models.engineProblem.voiceFixed': 'Il motore vocale funziona di nuovo.',
  'models.engine.progress': 'Download del motore IA in corso… {pct}%',
  'models.engine.downloadingNoTotal': 'Download del motore IA in corso…',
  'models.engine.verifying': 'Controllo del motore IA in corso…',
  'models.engine.extracting': 'Estrazione del motore IA in corso…',
  'models.voiceEngine.title': 'Aggiungi la dettatura vocale (opzionale)',
  'models.voiceEngine.explain':
    'Le risposte in chat e sui documenti funzionano già su questa unità. Il motore vocale è ' +
    'opzionale: installalo solo se vuoi dettare i messaggi con il microfono.',
  'models.voiceEngine.install': 'Installa il motore vocale',
  'models.packTools.row': 'Strumenti per i pacchetti di conoscenze: non installati',
  'models.packTools.install': 'Installa…',
  'models.ocr.row': 'Riconoscimento del testo per scansioni e foto (opzionale)',
  'models.ocr.rowOrientation':
    'Per raddrizzare le scansioni girate di lato serve un altro file OCR (opzionale)',
  'ocr.install.action': 'Scarica i file OCR',
  'ocr.install.actionTitle':
    'Scarica i file di lingua del riconoscimento del testo (OCR) per scansioni e foto',
  'ocr.install.confirm.title': 'Vuoi scaricare i file OCR?',
  'ocr.install.confirm.explain':
    'Il riconoscimento del testo (OCR) legge su questo computer i PDF scansionati e le pagine ' +
    'fotografate. Richiede su questa unità i file elencati qui sotto: non viene scaricato ' +
    'nient’altro e i tuoi documenti non escono mai da questo computer.',
  'ocr.install.confirm.languages': 'File',
  'ocr.install.confirm.hint':
    'Prima dell’uso, ogni file viene controllato con il checksum previsto.',
  'ocr.install.confirm.start': 'Scarica',
  'ocr.install.lang.deu': 'Tedesco',
  'ocr.install.lang.eng': 'Inglese',
  'ocr.install.lang.osd': 'Orientamento della pagina (raddrizza le pagine girate di lato)',
  'ocr.install.starting': 'Avvio del download…',
  'ocr.install.progress': 'Download dei file OCR in corso… {pct}%',
  'ocr.install.verifying': 'Controllo dei file OCR in corso…',
  'ocr.install.activating': 'Avvio del riconoscimento del testo…',
  'ocr.install.failed': 'Non è stato possibile installare i file OCR.',
  'ocr.install.retry': 'Riprova il download dei file OCR',
  'ocr.install.cancel': 'Annulla il download dei file OCR',
  'ocr.install.alreadyPresent':
    'I file OCR sono già su questa unità. Riavvia HilbertRaum per usarli.',
  'ocr.install.outcome.activated': 'Il riconoscimento del testo è pronto: non serve riavviare.',
  'ocr.install.outcome.restartRequired':
    'I file OCR sono al loro posto. Riavvia HilbertRaum per usare i nuovi file di lingua.',
  'ocr.install.outcome.unchanged':
    'I file OCR sono al loro posto. Se il riconoscimento del testo continua a non essere ' +
    'disponibile, riavvia HilbertRaum.',
  'models.ram.needs': 'Richiede almeno {min}\u00A0GB di RAM',
  'models.ram.machine': ' (questo computer ha circa {ram}\u00A0GB)',
  'models.ram.advice': '. Scegli un modello più piccolo: la qualità resta ottima.',
  'models.badge.active': 'Attivo',
  'models.badge.recommended': 'Consigliato per questo computer',
  'models.badge.ramNeeded': 'Richiede ≥{min}\u00A0GB di RAM',
  'models.automatic.installed':
    'Installato – viene usato automaticamente. Non c’è nulla da avviare.',
  'models.automatic.notInstalled':
    'Viene usato automaticamente una volta installato: non serve alcuna configurazione.',
  'models.transcriber.engineUnsupported':
    'Su questo sistema operativo l’app non può ancora installare il motore vocale, quindi qui ' +
    'questo modello non attiva la dettatura vocale né l’importazione audio.',
  'models.vision.installed':
    'Installato – viene usato automaticamente nella schermata Immagini. Qui non c’è nulla da ' +
    'avviare.',
  'models.vision.notInstalled':
    'Viene usato automaticamente nella schermata Immagini una volta installato: non serve alcuna ' +
    'configurazione.',
  'models.vision.goToImages': 'Vai a Immagini',
  'models.translation.installed':
    'Installato – viene usato automaticamente per la traduzione. Qui non c’è nulla da avviare.',
  'models.translation.notInstalled':
    'Viene usato automaticamente per la traduzione una volta installato: non serve alcuna ' +
    'configurazione.',
  'models.use': 'Usa questo modello',
  'models.useTitle': 'Rendilo il tuo modello e avvialo, così puoi chattare',
  'models.stopRuntime': 'Arresta il modello',
  'models.answeringNote':
    'È in corso la scrittura di una risposta. Arrestare o cambiare il modello la interrompe: il ' +
    'testo scritto finora viene conservato.',
  'models.startMock': 'Prova in modalità demo',
  'models.starting': 'Avvio in corso…',
  'models.startingTitle':
    'Questo modello si sta caricando: con i modelli grandi può volerci un po’',
  'models.startMockTitle':
    'Ancora nessun file del modello: prova l’app in modalità demo, con risposte visibilmente ' +
    'simulate',
  'models.tech.summary': 'Dettagli tecnici',
  'models.tech.id': 'ID del modello',
  'models.tech.family': 'Famiglia',
  'models.tech.format': 'Formato',
  'models.tech.runtime': 'Motore',
  'models.tech.license': 'Licenza',
  'models.tech.sizeOnDisk': 'Dimensioni sull’unità',
  'models.tech.minRam': 'RAM minima',
  'models.tech.recRam': 'RAM consigliata',
  'models.tech.context': 'Finestra di contesto',
  'models.tech.contextValue.one': '{count} token',
  'models.tech.contextValue.many': '{count} di token',
  'models.tech.contextValue.other': '{count} token',
  'models.tech.file': 'File',
  // ---- Context-size picker (2026-07-04 user report — the truncation hint points here) ----
  'models.context.title': 'Dimensione del contesto',
  'models.context.label': 'Finestra di contesto per le risposte:',
  'models.context.auto': 'Automatico – la dimensione consigliata dal modello',
  'models.context.autoResolved.one':
    'Automatico – la dimensione consigliata dal modello ({count} token)',
  'models.context.autoResolved.many':
    'Automatico – la dimensione consigliata dal modello ({count} di token)',
  'models.context.autoResolved.other':
    'Automatico – la dimensione consigliata dal modello ({count} token)',
  'models.context.bigWarning':
    'Le finestre molto grandi richiedono molta memoria in più mentre il modello è in esecuzione. ' +
    'Sui computer con meno memoria il modello potrebbe non avviarsi o rispondere molto più ' +
    'lentamente: in quel caso scegli una dimensione minore oppure «Automatico».',
  'models.context.hint':
    'Un contesto più grande permette a una conversazione o a una risposta sui documenti di usare ' +
    'più testo alla volta, ma richiede più memoria e può rallentare le risposte. Ha effetto al ' +
    'prossimo avvio di un modello.',
  'models.context.restartHint':
    'Un modello è in esecuzione in questo momento: arrestalo e avvialo di nuovo per applicare la ' +
    'nuova dimensione.',
  'models.verifyTitle':
    'Ricalcola l’hash del file sull’unità e confrontalo con il suo SHA-256 (senza usare la cache)',
  'models.verifying': 'Controllo in corso…',
  'models.verify': 'Controlla integrità',
  'models.verifyAll': 'Controlla tutti i file dei modelli',
  'models.verifyingAll': 'Controllo di tutti i file dei modelli in corso…',
  'models.verifyAllTitle':
    'Controlla di nuovo tutti i file dei modelli su questa unità, confrontandoli con il loro ' +
    'SHA-256',
  'models.verifyAllHint':
    'Ogni modello viene controllato quando lo avvii. Questo pulsante controlla invece tutti i ' +
    'file dei modelli su questa unità: su un’unità lenta può richiedere diversi minuti. Puoi ' +
    'interrompere il controllo in qualsiasi momento; i file già controllati restano controllati.',
  'models.verifyAllStop': 'Interrompi il controllo',
  'models.verifyAllStopping': 'Interruzione in corso…',
  'models.confirm.title': 'Vuoi scaricare {name}?',
  'models.confirm.start': 'Avvia il download',
  'models.confirm.size': 'Dimensioni',
  'models.confirm.license': 'Licenza',
  'models.confirm.from': 'Origine',
  'models.confirm.readLicense': 'leggi la licenza',
  'models.confirm.hint':
    'Il file scaricato viene controllato prima dell’uso. È l’unica richiesta di rete fatta ' +
    'dall’app: non viene inviato nulla su di te o sui tuoi documenti.',
  'models.confirm.licenseAck': 'Ho letto e accetto i termini di licenza di questo modello',
  'models.empty.title': 'Nessun manifest di modello trovato',
  'models.empty.lineBefore': 'Aggiungi i manifest YAML nella cartella ',
  'models.empty.lineAfter': ' sull’unità.',
  'models.section.yourModel': 'Il tuo modello IA',
  'models.section.docSearch': 'Ricerca nei documenti',
  // ---- Settings (SettingsScreen.tsx — chrome + the General tab) ----
  'settings.title': 'Impostazioni',
  'settings.tabsAria': 'Sezioni delle impostazioni',
  'settings.tab.general': 'Generali',
  'settings.tab.privacy': 'Privacy e dati',
  'settings.tab.skills': 'Skill',
  'settings.tab.diagnostics': 'Diagnostica (avanzata)',
  'settings.loading': 'Caricamento delle impostazioni…',
  'settings.saved': 'Salvato',
  'settings.saveFailed': 'Non è stato possibile salvare questa impostazione. Riprova.',
  'settings.network.title': 'Privacy e modalità offline',
  'settings.network.allow':
    'Consenti l’accesso a Internet per download e aggiornamenti dei modelli',
  'settings.network.hint':
    'Attivata per impostazione predefinita, così una nuova installazione può scaricare subito un ' +
    'modello. Quando è disattivata, l’app non si connette mai a Internet. Quando è attiva, ' +
    'permette di scaricare modelli, il motore IA, gli strumenti opzionali per i pacchetti di ' +
    'conoscenze e i file opzionali per il riconoscimento del testo (OCR): ogni download chiede ' +
    'prima una conferma, e i criteri dell’unità possono tenere i download del tutto disattivati. ' +
    'Le tue domande e i tuoi documenti non escono mai da questo dispositivo, qualunque sia ' +
    'questa impostazione.',
  'settings.appearance.title': 'Aspetto',
  'settings.appearance.aria': 'Tema',
  'settings.appearance.system': 'Sistema',
  'settings.appearance.light': 'Chiaro',
  'settings.appearance.dark': 'Scuro',
  'settings.appearance.hint':
    '«Sistema» segue la preferenza chiaro/scuro del tuo sistema operativo. La schermata di ' +
    'blocco segue sempre il tema del sistema.',
  'settings.language.title': 'Lingua',
  'settings.language.aria': 'Lingua',
  'settings.language.system': 'Sistema',
  'settings.language.hint':
    '«Sistema» segue la lingua del tuo sistema operativo, se HilbertRaum la offre; altrimenti ' +
    'usa l’inglese. Le modifiche si applicano subito.',
  'settings.performance.title': 'Prestazioni',
  'settings.performance.gpu': 'Usa l’accelerazione GPU',
  'settings.performance.gpuHint':
    'Usa la tua scheda grafica, se disponibile, per rendere più veloci le risposte. Disattiva ' +
    'l’opzione solo se noti problemi di stabilità: tutto continua a funzionare in ogni caso.',
  'settings.performance.rerankWideScope':
    'Riordina per pertinenza più brani dei pacchetti di conoscenze',
  'settings.performance.rerankWideScopeHint':
    'Ogni domanda richiede più tempo. Vale solo su un computer con abbastanza thread del ' +
    'processore e con il modello di riordinamento installato; su un computer con una scheda ' +
    'grafica utilizzabile ogni brano viene già riordinato.',
  'settings.performance.autoStart':
    'Carica automaticamente il modello selezionato all’avvio dell’app',
  'settings.performance.autoStartHint':
    'Attivata per impostazione predefinita. Il modello selezionato nella schermata Modello IA ' +
    'viene caricato in background all’avvio (nelle aree di lavoro crittografate, dopo lo ' +
    'sblocco), così la schermata Chat è pronta senza altri clic.',
  // ---- Settings: Chat / conversation compaction (context-compaction plan §5.4) ----
  'settings.chat.title': 'Chat',
  'settings.chatCompaction.label': 'Riassumi i messaggi meno recenti per liberare contesto',
  'settings.chatCompaction.help':
    'Attivata per impostazione predefinita. Quando una conversazione lunga si avvicina al limite ' +
    'di contesto del modello, i messaggi meno recenti vengono riassunti una sola volta in una ' +
    'nota compatta, salvata su questa unità, invece di essere scartati senza avviso. Disattiva ' +
    'l’opzione per tenere solo i messaggi più recenti che rientrano nel contesto.',
  'settings.developer.title': 'Sviluppatori',
  'settings.developer.toggle':
    'Modalità sviluppatori (consente un’area di lavoro non crittografata e modelli non ' +
    'controllati)',
  'settings.developer.hint':
    'Disattivata per impostazione predefinita. Le build di sviluppo sono sempre considerate in ' +
    'modalità sviluppatori. Prevalgono i criteri dell’unità: su un’unità commerciale i modelli ' +
    'non controllati restano rifiutati, qualunque sia questa impostazione.',
  'settings.workspace.title': 'Area di lavoro',
  'settings.workspace.mode': 'Modalità',
  'settings.workspace.modeEncrypted': 'Crittografata',
  'settings.workspace.modePlaintext': 'Non crittografata (sviluppatori)',
  'settings.workspace.contextTokens': 'Token di contesto',
  'settings.workspace.contextAuto':
    'Automatico (predefinito del modello) – modificabile nella schermata Modello IA',
  'settings.workspace.encryptedHint':
    'Questa area di lavoro è crittografata quando è bloccata. Usa «Blocca ora» nella barra ' +
    'laterale per crittografarla di nuovo e bloccarla; si blocca anche automaticamente quando ' +
    'chiudi l’app.',
  'settings.workspace.plaintextHint':
    'Area di lavoro per sviluppatori non crittografata: i dati sono salvati senza crittografia. ' +
    'La modalità crittografata è quella predefinita della versione commerciale.',
  'settings.changePassword.title': 'Cambia password',
  'settings.changePassword.hint':
    'Scegli una nuova password per questa area di lavoro. La userai dal prossimo sblocco. Non ' +
    'può essere recuperata né reimpostata, quindi scegline una che ricorderai.',
  'settings.changePassword.current': 'Password attuale',
  'settings.changePassword.new': 'Nuova password',
  'settings.changePassword.confirm': 'Conferma la nuova password',
  'settings.changePassword.busy':
    'Protezione dei tuoi documenti con la nuova password… Se hai molti documenti, può richiedere ' +
    'qualche minuto.',
  'settings.changePassword.failed':
    'Qualcosa non ha funzionato. La tua password attuale funziona ancora.',
  'settings.changePassword.submit': 'Cambia password',
  'settings.changePassword.submitBusy': 'Modifica in corso…',
  'settings.changePassword.toast': 'Password cambiata',
  // ---- Skills (settings/SkillsTab.tsx, skills plan §15) ----
  'skills.intro':
    'Le skill insegnano all’assistente a svolgere un compito specifico. Aggiungono indicazioni ' +
    'alle sue risposte, ma non accedono mai a Internet né ad altre cartelle del tuo computer.',
  'skills.info.meeting-protocol.what':
    'Trasforma la prossima risposta in un verbale di riunione ordinato: decisioni, attività da ' +
    'svolgere e domande aperte.',
  'skills.info.meeting-protocol.needs':
    'La trascrizione o gli appunti tra le fonti di questa chat (allega il file o incolla il ' +
    'testo).',
  'skills.info.meeting-protocol.limits':
    'Elabora un documento alla volta e registra solo ciò che dicono davvero gli appunti.',
  'skills.info.contract-brief.what':
    'Riassume un contratto in parole semplici: parti, date, obblighi, condizioni principali e ' +
    'domande da porre.',
  'skills.info.contract-brief.needs': 'Il contratto tra le fonti di questa chat.',
  'skills.info.contract-brief.limits':
    'Un aiuto alla lettura per un documento alla volta, non una consulenza legale.',
  'skills.info.deadline-obligation-finder.what':
    'Trova scadenze, termini di preavviso, date di rinnovo e di pagamento e gli obblighi ' +
    'collegati.',
  'skills.info.deadline-obligation-finder.needs': 'Il documento tra le fonti di questa chat.',
  'skills.info.deadline-obligation-finder.limits':
    'Legge un documento alla volta; prima di agire, controlla le date importanti nel documento ' +
    'originale.',
  'skills.info.what-changed.what':
    'Confronta due versioni di un documento e riporta le modifiche importanti, non un confronto ' +
    'grezzo riga per riga.',
  'skills.info.what-changed.needs':
    'Esattamente due documenti (o versioni) tra le fonti di questa chat.',
  'skills.info.what-changed.limits':
    'Con più o meno di due documenti tra le fonti della chat non può fare il confronto e ' +
    'risponde normalmente.',
  'skills.info.share-safe-review.what':
    'Controlla un documento prima che tu lo condivida: informazioni sensibili visibili e rischi ' +
    'pratici legati alla condivisione.',
  'skills.info.share-safe-review.needs': 'Il documento tra le fonti di questa chat.',
  'skills.info.share-safe-review.limits':
    'Fornisce solo consigli: non afferma mai che un documento sia anonimizzato o sicuro da ' +
    'pubblicare.',
  'skills.info.invoice.what':
    'Legge una fattura con un’estrazione esatta, che puoi controllare: voci e totali, controllo ' +
    'dei totali, esportazione in CSV/JSON/XML.',
  'skills.info.invoice.needs':
    'Un documento simile a una fattura tra le fonti della chat; le sue azioni compaiono come ' +
    'pulsanti subito sopra il campo del messaggio.',
  'skills.info.invoice.limits':
    'Una fattura alla volta; un totale che non può controllare viene indicato come non ' +
    'controllato, mai taciuto.',
  'skills.info.bank-statement.what':
    'Legge un estratto conto con un’estrazione esatta, che puoi controllare: transazioni, ' +
    'categorie, controllo dei saldi, esportazione in CSV.',
  'skills.info.bank-statement.needs':
    'Un documento simile a un estratto conto tra le fonti della chat; le sue azioni compaiono ' +
    'come pulsanti subito sopra il campo del messaggio.',
  'skills.info.bank-statement.limits':
    'Un estratto conto alla volta; per categorizzare le transazioni serve un modello in ' +
    'esecuzione.',
  'skills.info.document-redaction.what':
    'Salva una copia oscurata di un documento: rilevamento basato su regole di e-mail, numeri e ' +
    'date, più nomi e indirizzi individuati dal modello.',
  'skills.info.document-redaction.needs':
    'Il documento tra le fonti della chat; il pulsante «Oscura i dati personali» compare subito ' +
    'sopra il campo del messaggio.',
  'skills.info.document-redaction.limits':
    'Nei limiti del possibile, mai una garanzia: senza un modello in esecuzione funziona solo il ' +
    'rilevamento basato su regole; i file Word restano in formato .docx, gli altri formati ' +
    'vengono salvati come .txt.',
  'skills.info.document-edit.what':
    'Applica sostituzioni esatte (trova e sostituisci) e salva una copia modificata: non ' +
    'riscrive mai il tuo documento.',
  'skills.info.document-edit.needs':
    'Un modello in esecuzione, il documento tra le fonti della chat e la tua istruzione (per ' +
    'esempio «sostituisci X con Y»); il pulsante «Applica le modifiche al testo» compare subito ' +
    'sopra il campo del messaggio.',
  'skills.info.document-edit.limits':
    'Il testo non trovato in forma identica viene saltato e segnalato; i file Word restano in ' +
    'formato .docx, gli altri formati vengono salvati come .txt.',
  'skills.autoFire.title': 'Applica automaticamente una skill adatta',
  'skills.autoFire.toggle': 'Applica automaticamente una skill adatta',
  'skills.autoFire.hint':
    'Se l’opzione è attiva, l’app può applicare da sola a una risposta una skill dell’app ' +
    'chiaramente adatta, così non devi sceglierla tu. Solo le skill dell’app, mai quelle create ' +
    'o importate da te. Vedi sempre quale skill è stata usata e, per quella domanda, puoi ' +
    'ottenere una risposta senza la skill. Disattivata per impostazione predefinita.',
  'skills.autoFire.on': 'Skill automatiche attivate',
  'skills.autoFire.off': 'Skill automatiche disattivate',
  'skills.autoFire.saveFailed':
    'Non è stato possibile salvare l’impostazione delle skill automatiche.',
  'skills.import': 'Importa skill…',
  'skills.import.menuAria': 'Importa una skill',
  'skills.import.fromFile': 'Da un file (.skill.zip)…',
  'skills.import.fromFolder': 'Da una cartella…',
  'skills.loading': 'Caricamento delle skill…',
  'skills.loadFailed': 'Non è stato possibile caricare le skill.',
  'skills.reconcile.folderErrors.one':
    '{count} cartella di skill non è leggibile e viene saltata. Il suo file «SKILL.md» manca, ' +
    'non è valido o non può essere letto.',
  'skills.reconcile.folderErrors.many':
    '{count} di cartelle di skill non sono leggibili e vengono saltate. Ogni cartella deve ' +
    'contenere un file «SKILL.md» valido.',
  'skills.reconcile.folderErrors.other':
    '{count} cartelle di skill non sono leggibili e vengono saltate. Ogni cartella deve ' +
    'contenere un file «SKILL.md» valido.',
  'skills.empty.title': 'Ancora nessuna skill',
  'skills.empty.line':
    'Le skill insegnano all’assistente a svolgere un compito specifico. Aggiungine una per ' +
    'iniziare.',
  'skills.trusted.app': 'App',
  'skills.trusted.user': 'Creata da te',
  'skills.row.enableLabel': 'Attiva',
  'skills.row.on': 'Skill attivata',
  'skills.row.off': 'Skill disattivata',
  'skills.row.onFailed': 'Non è stato possibile attivare questa skill.',
  'skills.row.offFailed': 'Non è stato possibile disattivare questa skill.',
  'skills.dup.chip': 'Nome duplicato',
  'skills.dup.title':
    'Un’altra skill installata usa questo nome. Può essere attiva solo una alla volta.',
  'skills.unavailable.chip': 'File mancanti',
  'skills.unavailable.title': 'I file di questa skill non sono più sull’unità.',
  'skills.incompatible.chip': 'App da aggiornare',
  'skills.incompatible.title':
    'Questa skill richiede una versione più recente dell’app: aggiorna l’app per attivarla.',
  'skills.review.chip': 'Controlla',
  'skills.warn.title': 'Controlla cosa può fare questa skill',
  'skills.warn.body':
    'Creata da te o importata. Controlla cosa può fare prima di affidarti a questa skill.',
  'skills.warn.ack': 'Ho capito',
  'skills.menu.aria': 'Azioni della skill',
  'skills.menu.export': 'Esporta…',
  'skills.menu.delete': 'Elimina',
  'skills.export.done': 'Skill esportata',
  'skills.export.failed': 'Non è stato possibile esportare questa skill.',
  'skills.delete.title': 'Vuoi eliminare questa skill?',
  'skills.delete.body':
    'La skill viene rimossa dall’unità. Le chat che l’hanno già usata continuano a funzionare.',
  'skills.delete.confirm': 'Elimina',
  'skills.delete.done': 'Skill eliminata',
  'skills.delete.failed': 'Non è stato possibile eliminare questa skill.',
  'skills.detail.aria': 'Dettagli della skill',
  'skills.detail.version': 'Versione',
  'skills.detail.author': 'Autore',
  'skills.detail.language': 'Lingua',
  'skills.detail.kind': 'Tipo',
  'skills.kind.instruction': 'Indicazioni',
  'skills.kind.tool': 'Usa strumenti',
  'skills.tool.note':
    'Per ora aggiunge solo indicazioni. Gli strumenti che descrive arriveranno in una versione ' +
    'futura.',
  'skills.tool.note.active':
    'Se lo chiedi, questa skill può eseguire strumenti locali approvati su un documento che ' +
    'scegli tu. Gli strumenti di sola lettura possono anche avviarsi automaticamente per ' +
    'rispondere alla tua domanda; tutto ciò che scrive o esporta un file ti chiede sempre prima ' +
    'la conferma. Gli strumenti vedono solo quel documento.',
  'skills.perm.heading': 'Cosa può fare questa skill',
  'skills.perm.canTitle': 'Questa skill può:',
  'skills.perm.cannotTitle': 'Questa skill non può:',
  'skills.perm.can.instructions': 'Aggiungere istruzioni alle risposte dell’IA',
  'skills.perm.can.documents': 'Leggere solo i documenti che scegli tu',
  'skills.perm.can.tools': 'Usare strumenti locali approvati quando lo chiedi',
  'skills.perm.cannot.network': 'Accedere a Internet',
  'skills.perm.cannot.files': 'Leggere altre cartelle del tuo computer',
  'skills.perm.cannot.scripts': 'Eseguire script o installare software',
  'skills.tech.summary': 'Dettagli tecnici',
  'skills.tech.id': 'ID della skill',
  'skills.tech.installId': 'ID di installazione',
  'skills.tech.source': 'Origine',
  'skills.tech.permissions': 'Autorizzazioni',
  'skills.import.title': 'Vuoi aggiungere questa skill?',
  'skills.import.confirm': 'Aggiungi skill',
  'skills.import.added': 'Skill aggiunta',
  'skills.import.failedTitle': 'Non è possibile aggiungere questa skill',
  'skills.import.failed': 'Non è stato possibile aggiungere questa skill.',
  'skills.import.collision':
    'È già installata una skill con questo nome. Se aggiungi questa skill, sostituirai quella ' +
    'installata.',
  'skills.import.collisionApp':
    'Una skill dell’app usa già questo nome. La tua skill viene aggiunta, ma resta disattivata ' +
    'finché la skill dell’app è attiva.',
  'skills.import.upgrade': 'Aggiorna la versione installata ({from} → {to}).',
  'skills.import.replace': 'Sostituisce la versione installata ({version}).',
  'skills.import.downgrade': 'Questa versione è meno recente di quella installata ({installed}).',
  'skills.import.downgradeBlocked':
    'Per installare una versione meno recente serve la modalità sviluppatori. Attivala in ' +
    'Impostazioni → Generali per consentirlo.',
  'skills.import.error.notFound': 'Non è stato possibile trovare la skill selezionata.',
  'skills.import.error.notZipOrFolder':
    'Una skill deve essere un file .skill.zip o una cartella che contiene il file «SKILL.md».',
  'skills.import.error.unreadableZip':
    'Non è stato possibile leggere il pacchetto della skill come archivio zip valido.',
  'skills.import.error.encryptedZip':
    'Il pacchetto della skill usa un formato zip non supportato (crittografato o ZIP64).',
  'skills.import.error.unsupportedCompression':
    'Il pacchetto della skill usa un metodo di compressione non supportato.',
  'skills.import.error.pathTraversal':
    'Il pacchetto contiene un file il cui percorso esce dalla cartella del pacchetto.',
  'skills.import.error.absolutePath':
    'Il pacchetto contiene un file con un percorso assoluto o con una lettera di unità.',
  'skills.import.error.invalidPath': 'Il pacchetto contiene un file con un percorso non valido.',
  'skills.import.error.symlink':
    'Il pacchetto contiene un collegamento simbolico, che non è consentito.',
  'skills.import.error.tooDeep':
    'Il pacchetto contiene cartelle annidate più in profondità di quanto consentito.',
  'skills.import.error.pathTooLong': 'Il pacchetto contiene un percorso di file troppo lungo.',
  'skills.import.error.tooManyFiles': 'Il pacchetto contiene più file di quelli consentiti.',
  'skills.import.error.tooLarge': 'Il pacchetto supera le dimensioni consentite.',
  'skills.import.error.fileTooLarge': 'Un file del pacchetto supera le dimensioni consentite.',
  'skills.import.error.duplicatePath':
    'Il pacchetto contiene due file che corrispondono allo stesso percorso.',
  'skills.import.error.badExtension': 'Il pacchetto contiene un tipo di file non consentito.',
  'skills.import.error.nestedArchive':
    'Il pacchetto contiene un archivio incorporato, che non è consentito.',
  'skills.import.error.noSkillMd': 'Il pacchetto non contiene un file «SKILL.md».',
  'skills.import.error.invalidManifest': 'Il manifest della skill non è valido.',
  'skills.import.error.idMismatch': 'L’ID della skill non è un nome valido.',
  'skills.import.error.downgradeBlocked':
    'È già installata una versione più recente di questa skill. Attiva la modalità sviluppatori ' +
    'per installare una versione meno recente.',
  'skills.import.error.appReadOnly':
    'Le skill fornite dall’app non possono essere modificate né eliminate.',
  'skills.import.error.locked': 'Sblocca l’area di lavoro per gestire le skill.',
  'skills.import.note.permissionNotString':
    'L’autorizzazione «{field}» non è un valore di testo; viene usato il valore predefinito ' +
    '«{value}».',
  'skills.import.note.permissionUnrecognized':
    'L’autorizzazione «{field}» ha un valore che questa app non riconosce; viene usato il valore ' +
    'predefinito «{value}».',
  'skills.import.note.permissionClamped':
    'La skill chiede per «{field}» un accesso maggiore di quello consentito da questa app; ' +
    'l’accesso viene limitato a «{value}».',
  'skills.import.note.listInvalid': 'L’elenco «{field}» non è un elenco di testi e viene ignorato.',
  'skills.import.note.listItemsTooLong':
    'Alcune voci dell’elenco «{field}» sono troppo lunghe e vengono ignorate.',
  'skills.import.note.listTruncated':
    'L’elenco «{field}» contiene più voci di quelle consentite; vengono mantenute solo le prime ' +
    '{max}.',
  'skills.import.note.languageInvalid':
    'Il campo «language» non contiene un codice di lingua valido; viene usato «en».',
  'skills.import.note.allowedToolsIgnored':
    'Gli strumenti dichiarati vengono ignorati per una skill di indicazioni (gli strumenti ' +
    'arriveranno in una versione futura).',
  'skills.import.note.analysisInvalid':
    'Il campo «analysis» ha un valore sconosciuto e viene ignorato.',
  'skills.import.note.analysisIgnoredForTool':
    'Il campo «analysis» viene ignorato per una skill che usa strumenti (è l’app a decidere come ' +
    'la skill elabora l’intero documento).',
  'skills.import.note.triggersInvalid': 'Il blocco «triggers» non è valido e viene ignorato.',
  'skills.import.note.autoFireInvalid':
    'Il campo «triggers.autoFire» deve essere true o false; viene trattato come false.',
  'skills.import.note.localizedInvalid': 'Il blocco «localized» non è valido e viene ignorato.',
  'skills.import.note.localizedLocaleInvalid':
    'Una voce del blocco «localized» ha un codice di lingua non valido e viene ignorata.',
  'skills.import.note.localizedEntryInvalid':
    'Una voce del blocco «localized» non è valida e viene ignorata.',
  'skills.import.note.localizedTitleIgnored':
    'Un titolo tradotto è stato ignorato (deve essere una sola riga breve).',
  'skills.import.note.localizedDescriptionIgnored':
    'Una descrizione tradotta è stata ignorata (deve essere una sola riga breve).',
  'skills.import.note.localizedTooMany':
    'Il blocco «localized» contiene più lingue di quelle consentite; vengono mantenute solo le ' +
    'prime {max}.',
  'skills.import.note.trustIgnored':
    'Il campo «trust» della skill viene ignorato: è l’app ad assegnare il livello di fiducia.',
  'skills.import.note.manifestJsonConflict':
    'Il campo «{field}» del file «manifest.json» incluso nel pacchetto è diverso da quello di ' +
    '«SKILL.md»; viene usato «SKILL.md».',
  'skills.replace.title': 'Vuoi usare invece questa skill?',
  'skills.replace.body':
    'È attiva un’altra skill con questo nome. Se attivi questa, l’altra viene disattivata.',
  'skills.replace.confirm': 'Attiva',
  // ---- Settings → Privacy & data tab (PrivacyTab.tsx) ----
  'privacy.offlineOn': '● Modalità offline: attiva',
  'privacy.offlineOff': '○ Accesso alla rete attivo',
  'privacy.statement.offline':
    'La modalità offline è attiva. HilbertRaum esegue il modello IA su questo computer. Le tue ' +
    'domande, i tuoi documenti, gli embedding e la cronologia delle chat restano in locale.',
  'privacy.statement.online':
    'HilbertRaum esegue il modello IA su questo computer. Le tue domande, i tuoi documenti, gli ' +
    'embedding e la cronologia delle chat restano in locale: anche con l’accesso a Internet attivo, ' +
    'usano la rete solo i download, cioè modelli, motore IA, strumenti opzionali per i pacchetti di ' +
    'conoscenze e file opzionali per il riconoscimento del testo (OCR).',
  'privacy.statement.noUploads':
    'Questa app non invia i tuoi dati a fornitori di IA nel cloud. Non ci sono caricamenti di ' +
    'domande, documenti o embedding, né telemetria, né statistiche di utilizzo, né invio remoto ' +
    'di rapporti sugli arresti anomali.',
  'privacy.network.title': 'Stato attuale della rete',
  'privacy.networkState.noPolicy': 'La modalità offline è attiva.',
  'privacy.networkState.disabledByPolicy': 'Accesso alla rete disattivato dai criteri dell’unità.',
  'privacy.networkState.offDefault':
    'La modalità offline è attiva (l’accesso a Internet è disattivato nelle Impostazioni).',
  'privacy.networkState.enabled':
    'L’accesso a Internet è attivo per i download: modelli, motore IA, strumenti opzionali per i ' +
    'pacchetti di conoscenze e file opzionali per il riconoscimento del testo (OCR).',
  'privacy.network.noFiles': 'Né le domande né i file escono da questo dispositivo.',
  'privacy.network.effective': 'Stato effettivo',
  'privacy.network.effectiveOffline': 'Offline (nessuna connessione a Internet)',
  'privacy.network.effectiveAllowed': 'Rete consentita',
  'privacy.network.byPolicy': 'Consentita dai criteri',
  'privacy.network.policyYes': 'Sì',
  'privacy.network.policyNo': 'No (disattivata dai criteri)',
  'privacy.network.yourSetting': 'La tua impostazione',
  'privacy.network.settingAllowed': 'Accesso a Internet consentito',
  'privacy.network.settingOff': 'Disattivata',
  'privacy.network.telemetry': 'Telemetria',
  'privacy.network.telemetryValue':
    'Nulla esce da questo dispositivo: non c’è nessun tracciamento da disattivare',
  'privacy.network.hint':
    'L’app ti avvisa prima di ogni azione su Internet. Scarica soltanto modelli IA, il motore ' +
    'IA, gli strumenti opzionali per i pacchetti di conoscenze e i file opzionali per il ' +
    'riconoscimento del testo (OCR): ognuno solo dopo la tua conferma, e ognuno controllato ' +
    'prima dell’uso. L’opzione è attiva per impostazione predefinita e puoi disattivarla nella ' +
    'scheda Generali. I criteri dell’unità possono disattivarla del tutto. L’API locale qui ' +
    'sotto è una funzione separata, che attivi solo se vuoi, e non usa mai Internet.',
  'privacy.data.title': 'Dove si trovano i tuoi dati',
  'privacy.data.driveRoot': 'Radice dell’unità',
  'privacy.data.workspace': 'Area di lavoro',
  'privacy.data.models': 'Modelli',
  'privacy.data.logs': 'Log',
  'privacy.data.loading': 'Caricamento dei percorsi…',
  'privacy.data.hint':
    'Tutto (documenti importati, testo estratto, embedding, cronologia delle chat, risultati ' +
    'generati, impostazioni) è salvato in locale nella tua area di lavoro. Per eliminarlo, ' +
    'rimuovi la cartella dell’area di lavoro.',
  'privacy.logs.title': 'Solo log locali',
  'privacy.logs.hintBefore':
    'I log di debug e di diagnostica vengono scritti in un file a rotazione nella cartella dei ' +
    'log indicata sopra e ',
  'privacy.logs.never': 'non vengono mai inviati',
  'privacy.logs.hintAfter': '. La diagnostica non trasmette nulla fuori da questo dispositivo.',
  'privacy.protection.title': 'Protezione dell’area di lavoro',
  'privacy.protection.encryptedBefore': 'La tua area di lavoro è in modalità ',
  'privacy.protection.encryptedWord': 'crittografata',
  'privacy.protection.encryptedAfter': '.',
  'privacy.protection.plainBefore': 'La tua area di lavoro è in ',
  'privacy.protection.plainWord': 'modalità sviluppatori non crittografata',
  'privacy.protection.plainAfter':
    '. I file sono salvati sull’unità senza crittografia, per uno sviluppo più rapido.',
  'privacy.protection.plainWarning':
    'La modalità sviluppatori non crittografata non è quella predefinita della versione ' +
    'commerciale. Le unità commerciali usano la modalità crittografata: la chiave deriva dalla ' +
    'password e nulla viene salvato senza crittografia. Non salvare documenti sensibili in ' +
    'modalità non crittografata su un’unità condivisa o rimovibile.',
  // ---- Settings → Privacy & data → "Local API" card (local-api wave P4) ----
  'settings.localApi.title': 'API locale',
  'settings.localApi.lead':
    'Consenti ad altri programmi su questo computer di inviare testo al tuo modello IA e di ' +
    'leggerne le risposte. Resta disattivata finché non la attivi.',
  'settings.localApi.toggle': 'Consenti ad altre app su questo computer di usare il mio modello IA',
  'settings.localApi.hint':
    'La connessione non esce mai da questo computer: nulla viene inviato su Internet.',
  'settings.localApi.policyOff': 'Disattivata dai criteri della tua unità.',
  'settings.localApi.confirm.title': 'Vuoi consentire ad altre app di usare il tuo modello?',
  'settings.localApi.confirm.what':
    'Gli altri programmi su questo computer potranno inviare testo al tuo modello IA e leggerne ' +
    'le risposte.',
  'settings.localApi.confirm.boundary':
    'Non possono vedere i tuoi documenti, i tuoi file o le tue conversazioni, e tramite ' +
    'HilbertRaum nulla esce da questo computer. HilbertRaum però non può controllare cosa fa un ' +
    'programma collegato con le risposte che riceve: prima di collegare un’app, controlla se ' +
    'salva o sincronizza i suoi dati.',
  'settings.localApi.confirm.persists': 'Resta attiva finché non la disattivi.',
  'settings.localApi.confirm.neverStored':
    'Le richieste delle altre app ricevono una risposta e poi vengono dimenticate: non finiscono ' +
    'nella cronologia delle chat né nei log.',
  'settings.localApi.confirm.ack': 'Ho capito cosa potranno fare le altre app.',
  'settings.localApi.confirm.cta': 'Attiva',
  'settings.localApi.connect.title': 'Collega un’altra app',
  'settings.localApi.connect.hint':
    'Incolla questi due valori nell’app che vuoi collegare. Di solito le app li chiamano «base ' +
    'URL» e «API key».',
  'settings.localApi.connect.address': 'Indirizzo del server',
  'settings.localApi.connect.key': 'Chiave di accesso',
  'settings.localApi.connect.copy': 'Copia',
  'settings.localApi.connect.copyAddressAria': 'Copia l’indirizzo del server',
  'settings.localApi.connect.copyKeyAria': 'Copia la chiave di accesso',
  'settings.localApi.connect.copiedAddress': 'Indirizzo del server copiato.',
  'settings.localApi.connect.copiedKey':
    'Copiata: tra un minuto verrà rimossa automaticamente dagli Appunti. La cronologia o la ' +
    'sincronizzazione degli Appunti di Windows potrebbero conservarne delle copie.',
  'settings.localApi.connect.copyFailed': 'Non è stato possibile copiare. Riprova.',
  'settings.localApi.connect.noKey':
    'Non serve nessuna chiave di accesso finché l’opzione «Richiedi una chiave di accesso» è ' +
    'disattivata.',
  'settings.localApi.model.running':
    'Un modello è in esecuzione: le altre app possono ricevere risposte.',
  'settings.localApi.model.stopped':
    'Nessun modello in esecuzione: le altre app riceveranno un errore finché non ne avvii uno.',
  'settings.localApi.status.port': 'In ascolto sulla porta {port}.',
  'settings.localApi.status.served.one': 'Finora ha risposto a {count} richiesta.',
  'settings.localApi.status.served.many': 'Finora ha risposto a {count} di richieste.',
  'settings.localApi.status.served.other': 'Finora ha risposto a {count} richieste.',
  'settings.localApi.status.off': 'Non in esecuzione.',
  'settings.localApi.busyWarning':
    'In questo momento un’app sta usando il tuo modello. Se chatti qui nello stesso momento, ' +
    'entrambe le attività possono rallentare: la tua chat ha sempre la precedenza.',
  'settings.localApi.preemptedWarning':
    'Poco fa il tuo uso di HilbertRaum ha interrotto la richiesta di un’app. L’app può ' +
    'semplicemente riprovare.',
  'settings.localApi.token.toggle': 'Richiedi una chiave di accesso',
  'settings.localApi.token.hint': 'Consigliato: lascia attiva questa opzione.',
  'settings.localApi.token.confirm.title': 'Vuoi disattivare la chiave di accesso?',
  'settings.localApi.token.confirm.body':
    'Senza una chiave di accesso, qualsiasi programma su questo computer può usare il tuo ' +
    'modello IA senza chiedere. Lasciala attiva, a meno che un’app non possa davvero inserire ' +
    'una chiave.',
  'settings.localApi.token.confirm.cta': 'Disattiva',
  'settings.localApi.token.regenerate': 'Crea una nuova chiave',
  'settings.localApi.token.regenerate.title': 'Vuoi creare una nuova chiave di accesso?',
  'settings.localApi.token.regenerate.body':
    'Le app che usano la vecchia chiave smetteranno di funzionare finché non incollerai la nuova ' +
    'chiave in ognuna di esse.',
  'settings.localApi.token.regenerate.cta': 'Crea nuova chiave',
  'settings.localApi.token.regenerated': 'Nuova chiave di accesso creata.',
  'settings.localApi.token.regenerateFailed':
    'Non è stato possibile creare una nuova chiave. Riprova.',
  'settings.localApi.port.label': 'Numero di porta',
  'settings.localApi.port.hint':
    'Cambialo solo se un altro programma usa già questo numero. Da 1024 a 65535.',
  'settings.localApi.error.portInUse':
    'Un altro programma su questo computer sta già usando questo numero. Potrebbe anche ' +
    'significare che un altro programma si sta spacciando per HilbertRaum: non incollare la tua ' +
    'chiave di accesso da nessuna parte finché non hai risolto il problema. Cambia il numero ' +
    '(per esempio {suggestion}) e attiva di nuovo l’API; se un’app era già collegata, incolla ' +
    'anche lì il nuovo indirizzo del server.',
  'settings.localApi.error.startFailed':
    'Non è stato possibile avviare l’API locale. I dettagli sono nella scheda Diagnostica.',
  // ---- Settings → Diagnostics tab (DiagnosticsTab.tsx) ----
  'diag.localOnly': 'Diagnostica solo locale. Nulla di quanto è mostrato qui viene mai inviato.',
  'diag.localApi.label': 'API locale',
  'diag.localApi.off': 'Disattivata',
  'diag.localApi.running':
    'Attiva · porta {port} · richieste con risposta: {served}, rifiutate: {rejected}',
  'diag.localApi.portInUse': 'Disattivata – il numero di porta è già in uso',
  'diag.localApi.startFailed': 'Disattivata – avvio non riuscito',
  'diag.audit.runtime_started': 'Modello avviato',
  'diag.audit.runtime_stopped': 'Modello arrestato',
  'diag.audit.runtime_crashed': 'Modello arrestato in modo imprevisto',
  'diag.audit.runtime_fallback': 'Modalità di compatibilità',
  'diag.audit.model_selected': 'Modello selezionato',
  'diag.audit.model_verified': 'Checksum del modello controllato',
  'diag.audit.model_download_started': 'Download avviato',
  'diag.audit.model_download_verified': 'Download controllato',
  'diag.audit.model_download_failed': 'Download non riuscito',
  'diag.audit.document_imported': 'Documento importato',
  'diag.audit.document_reindexed': 'Documento reindicizzato',
  'diag.audit.document_deleted': 'Documento eliminato',
  'diag.audit.document_task_completed': 'Attività sul documento completata',
  'diag.audit.document_task_failed': 'Attività sul documento non riuscita',
  'diag.audit.document_exported': 'Documento esportato',
  'diag.audit.summary_exported': 'Riassunto esportato',
  'diag.audit.conversation_deleted': 'Conversazione eliminata',
  'diag.audit.conversation_exported': 'Conversazione esportata',
  'diag.audit.message_table_exported': 'Tabella della risposta esportata',
  'diag.audit.code_block_exported': 'Blocco di codice salvato come file',
  'diag.audit.workspace_created': 'Area di lavoro creata',
  'diag.audit.workspace_unlocked': 'Area di lavoro sbloccata',
  'diag.audit.workspace_locked': 'Area di lavoro bloccata',
  'diag.audit.workspace_unlock_failed': 'Tentativo di sblocco non riuscito',
  'diag.audit.workspace_lock_failed':
    'Tentativo di blocco non riuscito (l’area di lavoro è rimasta aperta)',
  'diag.audit.workspace_password_changed': 'Password dell’area di lavoro cambiata',
  'diag.audit.settings_changed': 'Impostazioni modificate',
  'diag.audit.local_api_toggled': 'API locale attivata o disattivata',
  'diag.audit.policy_warning': 'Avviso sui criteri dell’unità',
  'diag.audit.offline_guard_violation': 'Tentativo di accesso alla rete rilevato',
  'diag.audit.collection_created': 'Progetto creato',
  'diag.audit.collection_renamed': 'Progetto rinominato',
  'diag.audit.collection_archived': 'Progetto archiviato o estratto dall’archivio',
  'diag.audit.collection_deleted': 'Progetto eliminato',
  'diag.audit.documents_added_to_collection': 'Documenti aggiunti a un progetto o a una sezione',
  'diag.audit.documents_removed_from_collection':
    'Documenti rimossi da un progetto o da una sezione',
  'diag.audit.document_lifecycle_changed': 'Stato del documento modificato',
  'diag.audit.skill_imported': 'Skill importata',
  'diag.audit.skill_deleted': 'Skill eliminata',
  'diag.audit.skill_enabled': 'Skill attivata',
  'diag.audit.skill_disabled': 'Skill disattivata',
  'diag.audit.skill_run_started': 'Esecuzione di uno strumento di skill avviata',
  'diag.audit.skill_run_done': 'Esecuzione di uno strumento di skill completata',
  'diag.audit.skill_run_failed': 'Esecuzione di uno strumento di skill non riuscita',
  'diag.audit.evidence_review_created': 'Verifica dei riscontri avviata',
  'diag.audit.evidence_review_ready': 'Verifica dei riscontri conclusa',
  'diag.audit.evidence_review_deleted': 'Verifica dei riscontri eliminata',
  'diag.audit.evidence_pack_exported': 'Pacchetto di riscontri esportato',
  'diag.audit.knowledge_pack_added': 'Pacchetto di conoscenze aggiunto',
  'diag.audit.knowledge_pack_removed': 'Pacchetto di conoscenze rimosso',
  'diag.audit.knowledge_pack_article_saved':
    'Articolo di un pacchetto di conoscenze salvato come documento',
  'diag.accel.gpuFallbackName': 'Scheda grafica',
  'diag.accel.gpu': '{name} (GPU)',
  'diag.accel.mock': 'Modalità demo integrata',
  'diag.app.engine': 'Motore IA',
  'diag.app.voiceEngine': 'Motore vocale',
  'diag.engine.cannotRun': 'Non può funzionare – {reason}',
  'diag.engine.reason.libraryMissing': 'manca una libreria di sistema',
  'diag.engine.reason.systemTooOld': 'serve una versione più recente del sistema operativo',
  'diag.engine.reason.filesDamaged': 'file del motore mancanti o danneggiati',
  'diag.engine.reason.filesDamagedAfterInstall':
    'file del motore segnalati come danneggiati subito dopo una nuova installazione',
  'diag.engine.reason.vcRuntimeMissing': 'manca il Visual C++ Redistributable',
  'diag.engine.reason.blocked': 'bloccato dalla sicurezza di Windows',
  'diag.accel.cpu': 'CPU',
  'diag.accel.gpuAvailable': '{name} (GPU disponibile)',
  'diag.app.title': 'App e motore',
  'diag.app.version': 'Versione dell’app',
  'diag.app.unknown': 'dato non disponibile',
  'diag.app.selectedModel': 'Modello selezionato',
  'diag.app.noneSelected': 'nessuno selezionato',
  'diag.app.profile': 'Profilo hardware',
  'diag.app.runtime': 'Motore',
  'diag.app.unknownModel': 'modello sconosciuto',
  'diag.app.onPort': ' su 127.0.0.1:{port}',
  'diag.app.healthy': 'funzionante',
  'diag.app.unhealthy': 'non funzionante',
  'diag.app.runtimeRunning': 'In esecuzione – {model}{onPort} ({health})',
  'diag.app.stopped': 'Arrestato',
  'diag.app.acceleration': 'Accelerazione',
  'diag.app.runtimeBuild': 'Build del motore',
  'diag.app.noInstallMarker': 'nessun indicatore di installazione (unità preparata manualmente)',
  'diag.app.engineVersions': 'Versioni dei motori',
  'diag.engineVersion.older': '{engine} {installed}, questa app prevede la versione {pinned}',
  'diag.engineVersion.newer':
    '{engine} {installed}, versione più recente di quella prevista da questa app ({pinned})',
  'diag.engineVersion.unknown':
    '{engine}: nessuna versione registrata, questa app prevede la versione {pinned}',
  'diag.engineVersion.cpuNet': '{engine} di riserva per CPU',
  'diag.gpu.compat':
    'Modalità di compatibilità attiva: le risposte usano la CPU, che funziona su qualsiasi ' +
    'computer.',
  'diag.gpu.tryHint': 'Se hai aggiornato il driver della scheda grafica, puoi riprovare a usarla.',
  'diag.gpu.offHint':
    'L’accelerazione GPU è disattivata nelle Impostazioni: riattivala lì per usare di nuovo la ' +
    'scheda grafica.',
  'diag.gpu.tryAgain': 'Riprova con la GPU',
  'diag.gpu.tryFailed': 'Il nuovo tentativo con la scheda grafica non è riuscito: {error}',
  'diag.refresh': 'Aggiorna',
  // ---- Performance screen (PerformanceScreen.tsx; benchmark.md "Performance screen") ----
  'perf.title': 'Prestazioni',
  'perf.lead':
    'La velocità con cui questo computer esegue il tuo modello IA, misurata su questo ' +
    'dispositivo. Nulla viene inviato altrove.',
  'perf.card.title': 'Questo computer',
  'perf.checkedAt': 'Ultimo controllo: {when}',
  'perf.notChecked': 'Controllo non ancora eseguito',
  'perf.otherMachine':
    'Questo risultato è stato misurato su un altro computer. Controlla di nuovo per misurare ' +
    'questo computer.',
  'perf.report.otherComputer': 'Un altro computer: {cpu}, {ram}\u00A0GB di RAM',
  'perf.verdict.speed': 'Questo computer esegue {model} a circa {tps}\u00A0tok/s.',
  'perf.verdict.noSpeed':
    '{model} è il più adatto a questo computer (in base a: {basis}). La velocità viene misurata ' +
    'dopo che un modello è stato avviato.',
  'perf.basis.discrete': 'memoria grafica',
  'perf.basis.unified': 'memoria unificata',
  'perf.basis.cpu': 'RAM',
  'perf.recommendation.atCheckTime': 'Consigliato al momento del controllo',
  'perf.recommendation.next': 'Consigliato per il prossimo avvio',
  'perf.recommendation.nextOnThisComputer': 'Consigliato per il prossimo avvio su questo computer',
  'perf.verdict.noRecommendation': 'Nessun modello del catalogo è ancora adatto a questo computer.',
  'perf.verdict.notChecked':
    'Un breve controllo misura la memoria, la velocità dell’unità e, quando un modello è in ' +
    'esecuzione, la velocità di generazione.',
  'perf.verdict.driveFast': 'Da questa unità i modelli si avviano rapidamente.',
  'perf.verdict.driveSlow': 'Da questa unità i modelli si avviano lentamente.',
  'perf.tile.speed': 'Velocità',
  'perf.tile.speed.unit': 'tok/s',
  'perf.tile.speed.sub': 'Misurata con {model} in data {when}',
  'perf.tile.speed.approx': 'Valore approssimativo: conteggio dei blocchi, non tempi del motore IA',
  'perf.tile.speed.chunks': 'blocchi: {chunks}',
  'perf.tile.speed.none': 'Non ancora misurata',
  'perf.tile.speed.noneHint': 'Avvia un modello, poi controlla di nuovo',
  'perf.tile.memory': 'Memoria',
  'perf.tile.memory.unit': 'GB di RAM',
  'perf.tile.memory.unified': 'Memoria unificata',
  'perf.tile.memory.unifiedSub': 'Condivisa tra processore e core grafici',
  'perf.model.title': 'Il tuo modello',
  'perf.model.line.one': '{model} · {size}\u00A0GB sull’unità · contesto di {context} token',
  'perf.model.line.many': '{model} · {size}\u00A0GB sull’unità · contesto di {context} di token',
  'perf.model.line.other': '{model} · {size}\u00A0GB sull’unità · contesto di {context} token',
  'perf.model.none': 'Ancora nessun modello selezionato. Scegline uno nella schermata Modello IA.',
  'perf.model.need': 'Occupa {need}\u00A0GB con questo contesto.',
  'perf.model.needEstimate':
    'Richiede almeno {need}\u00A0GB per i pesi, più la cache del contesto, che viene misurata al ' +
    'primo avvio.',
  'perf.model.gpu':
    'Entra nella memoria grafica ({budget}\u00A0GB): tutti i livelli ({layers}) sono sulla GPU.',
  'perf.model.gpuEstimate': 'Dovrebbe entrare nella memoria grafica ({budget}\u00A0GB).',
  'perf.model.partial':
    'La memoria grafica dispone di {budget}\u00A0GB. Livelli sulla GPU: {gpuLayers} su {layers}; ' +
    'circa {spill}\u00A0GB restano nella RAM. Risposte più lente.',
  'perf.model.partialFree':
    'Livelli sulla GPU: {gpuLayers} su {layers}; circa {spill}\u00A0GB restano nella RAM. All’avvio ' +
    'del modello la memoria libera sulla scheda era solo di {free}\u00A0GB su {budget}\u00A0GB, e il ' +
    'motore IA tiene un margine di sicurezza di {margin}\u00A0GB. Risposte più lente. Riavvia il ' +
    'modello quando la scheda è libera.',
  'perf.model.partialMargin':
    'Livelli sulla GPU: {gpuLayers} su {layers}; circa {spill}\u00A0GB restano nella RAM. La scheda ' +
    'era libera ({free}\u00A0GB su {budget}\u00A0GB), ma il motore IA riserva anche ' +
    '{working}\u00A0GB di buffer di lavoro e un margine di sicurezza di {margin}\u00A0GB, e sposta ' +
    'interi livelli fuori dalla scheda quando il totale si avvicina al limite. Risposte più lente.',
  'perf.model.partialMarginNoWorking':
    'Livelli sulla GPU: {gpuLayers} su {layers}; circa {spill}\u00A0GB restano nella RAM. La scheda ' +
    'era libera ({free}\u00A0GB su {budget}\u00A0GB), ma il motore IA riserva anche dei buffer di ' +
    'lavoro e un margine di sicurezza di {margin}\u00A0GB, e sposta interi livelli fuori dalla ' +
    'scheda quando il totale si avvicina al limite. Risposte più lente.',
  'perf.model.partialEstimate':
    'La memoria grafica dispone di {budget}\u00A0GB: circa {spill}\u00A0GB resteranno nella RAM. ' +
    'Risposte più lente.',
  'perf.model.cpu': 'Funziona sul processore e usa la RAM ({budget}\u00A0GB).',
  'perf.model.cpuEstimate': 'Funzionerà sul processore e userà la RAM ({budget}\u00A0GB).',
  'perf.model.unified':
    'Entra nella memoria unificata ({ram}\u00A0GB; disponibili per il modello: fino a ' +
    '{budget}\u00A0GB).',
  'perf.model.unifiedEstimate':
    'Dovrebbe entrare nella memoria unificata ({ram}\u00A0GB; disponibili per il modello: fino a ' +
    '{budget}\u00A0GB).',
  'perf.model.tooLarge':
    'Troppo grande per questo computer (disponibili: {budget}\u00A0GB). Scegli un modello più ' +
    'piccolo.',
  'perf.model.unknown':
    'La collocazione del modello viene misurata la prima volta che si avvia su questo computer.',
  'perf.model.unknownObserved': 'Il motore IA non ha comunicato dove è stato collocato il modello.',
  'perf.model.perDrive':
    'L’unità conserva una sola misurazione per modello, quindi un avvio su un altro computer ' +
    'sostituisce quella fatta qui.',
  'perf.model.measuredOther.one':
    'Misurazione precedente in data {when}, con un contesto di {context} token; la stima qui ' +
    'sopra vale per le impostazioni attuali.',
  'perf.model.measuredOther.many':
    'Misurazione precedente in data {when}, con un contesto di {context} di token; la stima qui ' +
    'sopra vale per le impostazioni attuali.',
  'perf.model.measuredOther.other':
    'Misurazione precedente in data {when}, con un contesto di {context} token; la stima qui ' +
    'sopra vale per le impostazioni attuali.',
  'perf.model.runningOnCard': 'In esecuzione sulla scheda grafica in questo momento.',
  'perf.model.choose': 'Scegli un modello più piccolo',
  'perf.models.title': 'Modelli su questo computer',
  'perf.models.hint':
    'Chat e traduzione condividono la scheda grafica. Immagini, ricerca nei documenti e voce ' +
    'funzionano sul processore per scelta progettuale, quindi usano RAM, non memoria grafica.',
  'perf.role.chat': 'Chat',
  'perf.role.translation': 'Traduzione',
  'perf.role.vision': 'Immagini',
  'perf.role.reranker': 'Ricerca nei documenti (riordinamento)',
  'perf.role.embeddings': 'Ricerca nei documenti (indice)',
  'perf.role.transcriber': 'Voce',
  'perf.models.row': '{model} · {size}\u00A0GB',
  'perf.models.rowNoSize': '{model}',
  'perf.models.none': 'Nessun modello installato per questa funzione.',
  'perf.models.device.gpu': 'scheda grafica',
  'perf.models.device.cpu': 'processore, per scelta progettuale',
  'perf.models.device.processor': 'processore',
  'perf.models.loaded': 'caricato ora',
  'perf.models.notLoaded': 'non caricato',
  'perf.models.lifetime.session': 'resta caricato',
  'perf.models.lifetime.idle': 'libera la memoria quando è inattivo',
  'perf.models.lifetime.per-use': 'attivo solo mentre lavora',
  'perf.models.split': 'livelli sulla scheda: {gpuLayers} su {layers}',
  'perf.models.card':
    'Scheda grafica: chat {chat}\u00A0GB + traduzione {translation}\u00A0GB, su {vram}\u00A0GB.',
  'perf.models.cardReranker': 'Scheda grafica: riordinamento {reranker}\u00A0GB, su {vram}\u00A0GB.',
  'perf.models.cardBoth':
    'In questo momento entrambi i modelli sono sulla scheda. Quello avviato per secondo ha ' +
    'ricevuto lo spazio rimasto e funziona più lentamente: arrestalo e avvialo di nuovo quando ' +
    'l’altro avrà liberato la memoria.',
  'perf.models.ram': 'Caricare tutto insieme richiede circa {sum}\u00A0GB su {ram}\u00A0GB di RAM.',
  'perf.models.memory':
    'Caricare tutto insieme richiede circa {sum}\u00A0GB su {budget}\u00A0GB di memoria unificata ' +
    'disponibile per i modelli.',
  'perf.models.ramTooMuch': 'Troppo in una volta',
  'perf.models.ramOk': 'Rientra',
  'perf.place.gpu': 'Su GPU',
  'perf.place.partial': 'In parte su GPU',
  'perf.place.cpu': 'Su processore',
  'perf.place.tooLarge': 'Troppo grande',
  'perf.place.unknown': 'Non misurato',
  'perf.tile.graphics': 'Memoria grafica',
  'perf.tile.graphics.unit': 'GB di VRAM',
  'perf.tile.graphics.none':
    'Nessuna scheda grafica utilizzabile. I modelli funzionano sul processore.',
  'perf.tile.graphics.engine':
    'Il motore IA non può funzionare su questo computer, quindi non è stato possibile ' +
    'controllare la scheda grafica.',
  'perf.tile.graphics.off':
    'L’accelerazione grafica è disattivata. I modelli funzionano sul processore.',
  'perf.tile.graphics.small': 'Meno di {min}\u00A0GB: i modelli funzionano sul processore.',
  'perf.tile.graphics.integrated':
    'Integrata, memoria condivisa: i modelli funzionano sul processore.',
  'perf.tile.graphics.unitShared': 'GB condivisi',
  'perf.tile.graphics.notRecorded': 'Quel controllo non ha registrato la scheda grafica.',
  'perf.rating.usable': 'Adatta',
  'perf.rating.small': 'Ridotta',
  'perf.rating.integrated': 'Integrata',
  'perf.rating.notRecorded': 'Non registrata',
  'perf.rating.none': 'Nessuna',
  'perf.rating.unknown': 'Sconosciuta',
  'perf.others.subGpu': '{cpu}, {ram}\u00A0GB di RAM, {vram}\u00A0GB di VRAM · {when}',
  'perf.tile.drive': 'Unità',
  'perf.tile.drive.unit': 'MB/s in lettura',
  'perf.tile.drive.load': 'Da un avvio del modello in data {when}, lettura di {gb}\u00A0GB',
  'perf.tile.drive.hash': 'Da un controllo dei file in data {when}, lettura di {gb}\u00A0GB',
  'perf.tile.drive.none': 'Non ancora misurata',
  'perf.tile.drive.noneHint':
    'Viene misurata al primo avvio di un modello o al primo controllo dei file',
  'perf.rating.good': 'Buona',
  'perf.rating.slow': 'Lenta',
  'perf.rating.fast': 'Veloce',
  'perf.rating.pending': 'In attesa',
  'perf.rating.approx': 'Approssimativa',
  'perf.rating.slowDrive': 'Unità lenta',
  'perf.profile.TINY': 'Minimo',
  'perf.profile.LITE': 'Leggero',
  'perf.profile.BALANCED': 'Bilanciato',
  'perf.profile.PRO': 'Pro',
  'perf.profile.UNKNOWN': 'Sconosciuto',
  'perf.check': 'Controlla questo computer',
  'perf.checkAgain': 'Controlla di nuovo',
  'perf.running': 'Controllo in corso…',
  'perf.startAndMeasure': 'Avvia {model} e misura',
  'perf.contextSize': 'Cambia la dimensione del contesto',
  'perf.copy': 'Copia il rapporto',
  'perf.autoNote':
    'Parte automaticamente la prima volta e ogni volta che colleghi questa unità a un altro ' +
    'computer.',
  'perf.failed': 'Il controllo non è riuscito: {error}',
  'perf.loadFailed': 'Non è stato possibile leggere i valori più recenti: {error}',
  'perf.retry': 'Riprova',
  'perf.step.system': 'Rilevamento dell’hardware',
  'perf.step.drive': 'Controllo della velocità dell’unità',
  'perf.step.speed': 'Controllo della velocità di generazione con {model}',
  'perf.step.speedSkipped':
    'Controllo della velocità di generazione (saltato: nessun modello in esecuzione)',
  'perf.step.hint': 'Circa mezzo minuto. Puoi continuare a usare l’app.',
  'perf.running.background': 'Controllo di questo computer in corso in background.',
  'perf.step.state.done': '{step}: completato',
  'perf.step.state.active': '{step}: in corso',
  'perf.step.state.todo': '{step}: in attesa',
  'perf.observed.title': 'Valori rilevati durante il lavoro',
  'perf.observed.hint':
    'Valori reali dall’uso normale, non da una domanda di prova. Queste righe valgono per questa ' +
    'sessione; le velocità di lettura mostrate vengono salvate anche con i valori dell’unità qui ' +
    'sopra.',
  'perf.observed.none':
    'In questa sessione non è ancora stato rilevato nulla. Chiedi qualcosa al modello oppure ' +
    'avvialo.',
  'perf.observed.answer': 'Ultima risposta: {tps}\u00A0tok/s, primo token dopo {ttft}\u00A0s',
  'perf.observed.answerSub': '{model}, {when}, {tokens} token',
  'perf.observed.load': 'Avvio del modello: {seconds}\u00A0s',
  'perf.observed.loadSub': '{model}, lettura di {gb}\u00A0GB da questa unità a {mbps}\u00A0MB/s',
  'perf.observed.check': 'Controllo dei file: {seconds}\u00A0s',
  'perf.observed.checkSub':
    '{model}, controllo completo dei file in data {when}, lettura di {gb}\u00A0GB',
  'perf.observed.oncePerModel': 'Una volta per modello',
  'perf.others.title': 'Altri computer su cui è stata usata questa unità',
  'perf.others.hint':
    'Ogni computer conserva il proprio risultato, quindi il modello consigliato dipende dal ' +
    'computer, non dall’unità.',
  'perf.others.none':
    'Ancora nessuno. Collega l’unità a un altro computer: farà il controllo da sola.',
  'perf.others.row': '{tps}\u00A0tok/s con {model}',
  'perf.others.rowNoSpeed': 'Consigliato: {model}; velocità non misurata',
  'perf.others.sub': '{cpu}, {ram}\u00A0GB di RAM · {when}',
  'perf.others.load': 'avvio del modello {seconds}\u00A0s',
  'perf.others.check': 'controllo dei file {seconds}\u00A0s',
  'perf.footer':
    'Il rapporto tecnico completo, con tutti i valori grezzi, resta nelle Impostazioni, nella ' +
    'scheda Diagnostica.',
  'perf.footerLink': 'Apri Diagnostica',
  'perf.unknownModel': 'il modello caricato',
  'perf.unknownCpu': 'CPU sconosciuta',
  'diag.bench.title': 'Controllo delle prestazioni',
  'diag.bench.hint':
    'I valori grezzi dell’ultimo controllo su questo computer, da inserire in una richiesta di ' +
    'assistenza. La schermata Prestazioni spiega cosa significano ed esegue un nuovo controllo. ' +
    'Tutto viene misurato offline: nessun dato esce dal tuo computer.',
  'diag.bench.empty':
    'Su questo computer non è ancora stato eseguito nessun controllo. Apri la schermata ' +
    'Prestazioni per eseguirne uno.',
  'diag.bench.profile': 'Profilo assegnato',
  'diag.bench.noMatch': 'Nessun modello adatto',
  'diag.bench.ram': 'RAM',
  'diag.bench.cpu': 'CPU',
  'diag.bench.cores.one': ' ({count} core)',
  'diag.bench.cores.many': ' ({count} di core)',
  'diag.bench.cores.other': ' ({count} core)',
  'diag.bench.osArch': 'Sistema operativo / architettura',
  'diag.bench.gpu': 'GPU',
  'diag.bench.notDetected': 'non rilevata',
  'diag.bench.effectiveRead': 'Velocità di lettura misurata',
  'diag.bench.effectiveReadNone': 'non ancora misurata (viene misurata all’avvio di un modello)',
  'diag.bench.effectiveReadLoad': 'da un avvio del modello in data {when}, lettura di {gb}\u00A0GB',
  'diag.bench.effectiveReadHash': 'da un controllo dei file in data {when}, lettura di {gb}\u00A0GB',
  'diag.bench.driveWrite': 'Scrittura sull’unità',
  'diag.bench.notMeasured': 'non misurata',
  'diag.bench.tokens': 'Velocità di generazione (tok/s)',
  'diag.bench.tokensNotMeasured': 'non misurata (avvia prima un modello)',
  'diag.bench.tokensModel': 'misurata con il modello caricato {model}',
  'diag.bench.tokensOver': 'su {tokens} token',
  'diag.bench.tokensApprox':
    'valore approssimativo: conteggio dei blocchi, non tempi del motore IA',
  'diag.bench.lastRun': 'Ultimo controllo',
  'diag.system.title': 'Sistema',
  'diag.system.osPlatform': 'Sistema operativo / piattaforma',
  'diag.system.freeSpace': 'Spazio libero',
  'diag.system.imagesSize': 'Dimensioni della cronologia delle immagini',
  'diag.system.loadFailed':
    'Non è stato ancora possibile caricare i dettagli del sistema. Prova a riaprire questa ' +
    'scheda.',
  'diag.paths.title': 'Percorsi',
  'diag.paths.prepared': 'Unità preparata',
  'diag.paths.yes': 'Sì',
  'diag.paths.noFallback': 'No (si usa la cartella dei dati dell’app)',
  'diag.paths.writable': 'Scrivibile',
  'diag.paths.no': 'No',
  'diag.paths.loadFailed':
    'Non è stato ancora possibile caricare i dettagli dell’unità e dell’area di lavoro. Prova a ' +
    'riaprire questa scheda.',
  'diag.activity.title': 'Attività',
  'diag.activity.hint':
    'Un registro locale di ciò che ha fatto l’app: avvii dei modelli, download, importazioni di ' +
    'documenti, eventi dell’area di lavoro. Resta nella tua area di lavoro (crittografato, se ' +
    'l’area di lavoro è crittografata) e non viene mai inviato. Non contiene mai il testo delle ' +
    'chat né il contenuto dei documenti.',
  'diag.activity.show': 'Mostra le attività',
  'diag.activity.hide': 'Nascondi le attività',
  'diag.activity.export': 'Esporta in un file…',
  'diag.activity.savedTo': 'Registro delle attività salvato in {path}',
  'diag.activity.filterShow': 'Mostra',
  'diag.activity.filterAll': 'Tutte le attività',
  'diag.activity.loading': 'Caricamento…',
  'diag.activity.empty':
    'Ancora nessuna attività registrata: le attività compaiono qui mentre usi l’app.',
  'diag.activity.earlier': 'Mostra le attività meno recenti',
  'diag.logs.title': 'Log recenti',
  'diag.logs.hintBefore': 'Le ultime righe di ',
  'diag.logs.hintAfter':
    ' su questo dispositivo. I log sono solo locali e non vengono mai inviati; non contengono il ' +
    'contenuto dei documenti né il testo delle chat.',
  'diag.logs.show': 'Mostra i log',
  'diag.logs.hide': 'Nascondi i log',
  'diag.logs.empty': '(il log è vuoto)',
  'diag.logs.save': 'Salva in un file…',
  'diag.logs.savedTo': 'Log salvati in {path}',
  'diag.copy': 'Copia',
  'diag.copyTitle': 'Copia questi dettagli negli Appunti',
  'diag.copied': 'Copiato negli Appunti',
  'diag.copyFailed': 'Non è stato possibile copiare negli Appunti',
  // ---- Shared components' built-in copy (receive a bound t — i18n record §5 ⑤) ----
  'common.dismiss': 'Chiudi',
  'common.close': 'Chiudi',
  'common.cancel': 'Annulla',
  'common.remove': 'Rimuovi',
  'common.apply': 'Applica',
  'common.labelValue': '{label}: {value}',
  'common.percent': '{pct}%',
  'indicator.offline': 'Locale · Offline',
  'indicator.online': 'Locale · Download consentiti',
  'indicator.offlineDetail':
    'Tutto resta su questa unità. Non viene usata nessuna connessione a Internet.',
  'indicator.onlineDetail': 'Download consentiti: chat e documenti restano in locale.',
  'indicator.short.offline': 'Offline',
  'indicator.short.online': 'Rete attiva',
  'indicator.withLocalApi': '{state} · API attiva',
  'indicator.localApiDetail':
    'Altre app su questo computer possono usare il tuo modello. Nulla esce da questo computer.',
  // ---- Shared password copy ----
  'password.mismatch': 'Le password non coincidono.',
  'password.show': 'Mostra la password',
  'password.hide': 'Nascondi la password',
  'password.strength.tooShort': 'Troppo corta',
  'password.strength.weak': 'Debole',
  'password.strength.okay': 'Media',
  'password.strength.strong': 'Forte',
  'password.strength.veryStrong': 'Molto forte',
  'password.strength.minHint': 'Usa almeno {min} caratteri.',
  'password.strength.longerHint':
    'Più è lunga, più è forte: vanno bene 12 o più caratteri, oppure alcune parole senza legame ' +
    'tra loro.',
  // ---- Workspace gate (WorkspaceGate.tsx) ----
  'gate.passwordPlaceholder': 'Password',
  'gate.unlock.title': 'Sblocca la tua area di lavoro',
  'gate.unlock.hint':
    'Inserisci la tua password per aprire l’area di lavoro di questa unità. Tutto resta su ' +
    'questa unità.',
  'gate.unlock.submit': 'Sblocca',
  'gate.unlock.submitBusy': 'Sblocco in corso…',
  'gate.welcome.title': 'Ti diamo il benvenuto',
  'gate.welcome.intro':
    'Questa è la tua area di lavoro IA privata. Chatta con un modello IA e fai domande sui tuoi ' +
    'documenti: tutto viene eseguito da questa unità.',
  'gate.welcome.stays': 'Tutto resta su questa unità.',
  'gate.welcome.staysRest': 'Niente Internet, niente account, niente tracciamento.',
  'gate.welcome.start': 'Inizia',
  'gate.finishing.title': 'Configurazione in corso…',
  'gate.finishing.hint':
    'Controllo dei contenuti già presenti su questa unità. La prima lettura di un file di ' +
    'modello IA di grandi dimensioni può richiedere qualche minuto.',
  'gate.finishing.progress': 'Controllo del modello IA {n} di {m}: {name} ({pct}%)',
  'gate.finishing.skip': 'Salta e vai all’app',
  'gate.starter.title': 'Un’ultima cosa',
  'gate.starter.noModel':
    'Su questa unità non è ancora installato nessun modello IA: la chat ne ha bisogno per ' +
    'rispondere. Puoi aggiungerne uno ora o in qualsiasi momento dalla schermata Modello IA.',
  'gate.starter.optional':
    'Scaricare un modello è opzionale e richiede sempre prima la tua conferma. I tuoi documenti ' +
    'e le tue chat non usano mai Internet, in ogni caso.',
  'gate.starter.skip': 'Salta per ora',
  'gate.starter.addDocuments': 'Aggiungi documenti',
  'gate.starter.chooseModel': 'Scegli il tuo modello IA',
  'gate.create.title': 'Crea la tua password',
  'gate.create.hint':
    'Questa password blocca tutto ciò che si trova nella tua area di lavoro su questa unità: ' +
    'documenti, chat e note. Non può essere recuperata né reimpostata, quindi scegline una che ' +
    'ricorderai.',
  'gate.create.plaintextToggle': 'Usa un’area di lavoro per sviluppatori non crittografata',
  'gate.create.plaintextWarning':
    'La modalità non crittografata salva i tuoi dati su questa unità senza crittografia. Usala ' +
    'solo per lo sviluppo.',
  'gate.create.confirmPlaceholder': 'Conferma la password',
  'gate.create.back': 'Indietro',
  'gate.create.submit': 'Crea l’area di lavoro',
  'gate.create.submitBusy': 'Creazione in corso…',
  'gate.error.generic': 'Qualcosa non ha funzionato. Riprova.',
  // ---- Main-process strings (Phase 41, i18n record §3.3 two-rule boundary) --------------
  'main.ingest.pdfScanDetected':
    'Questo PDF sembra una scansione: non contiene ancora testo leggibile.',
  'main.ingest.audioNeedsTranscriber':
    'L’importazione audio richiede il modello di trascrizione: scaricalo nella schermata Modello ' +
    'IA.',
  'main.ingest.audioNeedsEngine':
    'L’importazione audio richiede il motore vocale: installalo nella schermata Modello IA.',
  'main.ingest.audioNeedsModelAndEngine':
    'L’importazione audio richiede il modello di trascrizione e il motore vocale: aggiungili ' +
    'entrambi nella schermata Modello IA.',
  'main.ingest.audioEngineUnsupported':
    'L’importazione audio non è ancora disponibile su questo sistema operativo: qui l’app non ' +
    'può installare il motore vocale necessario.',
  'main.ingest.audioUnreadable':
    'Non è stato possibile leggere questo file audio. Convertilo in WAV o MP3 e importalo di ' +
    'nuovo.',
  'main.ingest.audioTranscriptionFailed':
    'Non è stato possibile trascrivere la registrazione. Reindicizza questo documento per ' +
    'riprovare.',
  'main.ingest.engineCannotRun':
    'Il motore IA non può funzionare su questo computer, quindi non è stato possibile ' +
    'indicizzare questo documento. Nella schermata Modello IA trovi cosa fare, poi riprova.',
  'main.ingest.engineLibraryMissing':
    'Il motore IA non può funzionare su questo computer perché manca la libreria di sistema ' +
    '{library}. Nella schermata Modello IA trovi come risolvere, poi riprova.',
  'main.ingest.voiceEngineCannotRun':
    'Il motore vocale non può funzionare su questo computer, quindi non è stato possibile ' +
    'trascrivere questa registrazione. Nella schermata Modello IA trovi cosa fare, poi ' +
    'reindicizza questo documento.',
  'main.ingest.searchModelTimeout':
    'Il modello di ricerca non ha risposto in tempo, quindi non è stato possibile indicizzare ' +
    'questo documento. Riprova.',
  'main.ingest.searchModelCannotStart':
    'Il modello di ricerca non si è avviato, quindi non è stato possibile indicizzare questo ' +
    'documento. Nella schermata Modello IA scegli «Controlla tutti i file dei modelli», poi ' +
    'riprova.',
  'main.ingest.searchModelFailed':
    'Il modello di ricerca ha avuto un problema, quindi non è stato possibile indicizzare questo ' +
    'documento. Riprova.',
  'main.ingest.imageNeedsOcr':
    'L’importazione di foto richiede i file del riconoscimento del testo (OCR), che non sono su ' +
    'questa unità.',
  'main.ingest.imageNoText':
    'In questa foto non è stato trovato testo leggibile. Prova con una foto della pagina più ' +
    'nitida e ravvicinata.',
  'main.ingest.imageOcrFailed':
    'Non è stato possibile leggere questa foto. Reindicizzala per riprovare.',
  'main.ingest.imageOcrUnavailable':
    'Non è stato possibile eseguire il riconoscimento del testo (OCR) in questa versione, quindi ' +
    'questa foto è stata salvata senza testo leggibile. Reindicizzala quando l’OCR sarà ' +
    'disponibile.',
  'main.ingest.sourceMissing': 'File di origine non trovato sull’unità.',
  'main.ingest.interrupted':
    'L’indicizzazione si è interrotta prima del termine. Reindicizza per riprovare.',
  'main.ingest.fileTooLarge':
    'Questo file è troppo grande per essere importato in sicurezza. Dividilo in file più piccoli ' +
    'e riprova.',
  'main.ingest.tooManyChunks':
    'Questo documento è troppo grande per essere indicizzato per intero. Dividilo in file più ' +
    'piccoli e importa le parti.',
  'main.ingest.parseTimeout':
    'L’elaborazione di questo file ha richiesto troppo tempo, quindi il file è stato saltato. ' +
    'Potrebbe essere danneggiato o estremamente grande.',
  'main.ingest.unsupportedType':
    'Questo tipo di file non è supportato ({ext}). Prova con TXT, PDF, DOCX, CSV o un formato ' +
    'audio supportato.',
  'main.rag.noContext':
    'Non ho trovato questa informazione nei tuoi documenti. Prova a riformulare la domanda o ' +
    'controlla su quali documenti la stai facendo.',
  'main.rag.reindexNeeded':
    'I tuoi documenti richiedono una rapida reindicizzazione prima di poter essere cercati: sono ' +
    'stati indicizzati con un modello di ricerca diverso. Apri la schermata Documenti e scegli ' +
    '«Reindicizza».',
  'main.chat.docTaskBusy':
    'È in corso un’attività sui documenti. Puoi annullarla o attendere che finisca prima di ' +
    'chattare.',
  'main.chat.defaultTitle': 'Nuova chat',
  'main.evidenceReviews.defaultTitle': 'Verifica dei riscontri',
  'main.benchmark.warnTiny':
    'Questo dispositivo è più adatto al modello più piccolo e veloce. I modelli più grandi ' +
    'potrebbero funzionare lentamente.',
  'main.benchmark.warnUnknown':
    'Non abbiamo potuto rilevare completamente questo hardware, quindi abbiamo scelto un modello ' +
    'leggero e sicuro. Puoi provare un modello più grande in qualsiasi momento.',
  'main.benchmark.warnDriveProbe':
    'Non è stato possibile misurare la velocità dell’unità, quindi la scelta del modello ' +
    'consigliato si basa solo su RAM e CPU.',
  'main.benchmark.warnSlowDrive':
    'Questa unità non è tra le più veloci. I modelli funzionano comunque, ma il caricamento può ' +
    'richiedere più tempo.',
  'main.benchmark.warnSpeedSkipped':
    'Questa volta la velocità di generazione del testo non è stata misurata, perché il modello ' +
    'era occupato con un’altra attività. Il profilo qui sotto tiene conto solo di RAM, CPU e ' +
    'velocità dell’unità: per una misurazione completa, esegui di nuovo il controllo delle ' +
    'prestazioni quando nient’altro sta usando il modello.',
  'main.benchmark.warnSlowRead':
    'La lettura da questa unità è stata misurata a circa {mbps}\u00A0MB/s. L’avvio di un modello ' +
    'legge l’intero file a questa velocità, quindi su questa unità i modelli si avvieranno ' +
    'lentamente.',
  'main.benchmark.warnVeryLowTokens':
    'La generazione del testo è stata molto lenta con il modello caricato ({model}), quindi il ' +
    'profilo assegnato è stato abbassato di un livello. Se quel modello è più grande di quello ' +
    'consigliato, avvia il modello consigliato ed esegui di nuovo il controllo delle prestazioni.',
  'main.benchmark.warnRecommendationLowered':
    'Con il modello caricato ({model}) la generazione del testo è stata misurata a circa ' +
    '{tps}\u00A0tok/s, quindi il modello consigliato è sceso di una fascia di dimensioni, così le ' +
    'risposte restano rapide su questo computer.',
  'main.benchmark.locked':
    'L’area di lavoro è bloccata. Sbloccala per eseguire il controllo delle prestazioni.',
  'main.benchmark.lockedDuringRun':
    'L’area di lavoro è stata bloccata durante il controllo delle prestazioni, quindi il ' +
    'risultato non è stato salvato. Esegui di nuovo il controllo.',
  'main.dialog.openLink.title': 'Vuoi aprire questo link nel browser?',
  'main.dialog.openLink.message': 'Vuoi aprire questo link nel browser?',
  'main.dialog.openLink.site': 'Sito: {site}',
  'main.dialog.openLink.truncated': 'Qui il link è abbreviato. Caratteri non mostrati: {hidden}.',
  'main.dialog.openLink.credentials':
    'L’indirizzo contiene un nome utente: il sito che viene effettivamente aperto è quello ' +
    'indicato nella riga «Sito».',
  'main.dialog.openLink.hint':
    'Questo link proviene da una risposta o dal manifest di un modello, non da HilbertRaum. Il ' +
    'tuo browser si collegherà a questo sito.',
  'main.dialog.openLink.open': 'Apri',
  'main.dialog.openLink.cancel': 'Annulla',
  'main.workspace.wrongPassword':
    'Questa password non ha sbloccato la tua area di lavoro. Controllala e riprova.',
  'main.workspace.openFailed': 'Non è stato possibile aprire l’area di lavoro.',
  'main.workspace.vaultDamaged':
    'La tua password è corretta, ma i dati dell’area di lavoro sull’unità sono danneggiati e non ' +
    'è stato possibile aprirli. Reinserire la password non serve. Non creare una nuova area di ' +
    'lavoro: lascia i file come sono e ripristina la cartella «workspace» da un backup.',
  'main.workspace.recoveryBlocked':
    'Non è ancora possibile aprire l’area di lavoro: un altro programma tiene aperto un file di ' +
    'ripristino con i tuoi dati più recenti. Chiudi ciò che potrebbe analizzare l’unità ' +
    '(antivirus, indicizzazione della ricerca, una finestra aperta sulla cartella «workspace»), ' +
    'attendi un momento e riprova. Non è andato perso nulla.',
  'main.workspace.newer':
    'Questa area di lavoro è stata scritta da una versione più recente di HilbertRaum: aggiorna ' +
    'l’app per aprirla. Non è stato modificato nulla.',
  'main.workspace.createFailed': 'Non è stato possibile creare l’area di lavoro.',
  'main.workspace.passwordTooShort': 'La password deve avere almeno {min} caratteri.',
  'main.workspace.newPasswordTooShort': 'La nuova password deve avere almeno {min} caratteri.',
  'main.workspace.unlockBeforeChange': 'Sblocca l’area di lavoro prima di cambiarne la password.',
  'main.workspace.wrongCurrentPassword':
    'Non corrisponde alla tua password attuale. Controllala e riprova.',
  'main.workspace.changeFailed':
    'Non è stato possibile cambiare la password. La tua password attuale funziona ancora.',
  'main.workspace.busyPasswordChange':
    'La password dell’area di lavoro è in fase di modifica. Riprova tra un momento.',
  'main.workspace.lockFailed':
    'Non è stato possibile bloccare l’area di lavoro: resta aperta e i tuoi dati sono al sicuro. ' +
    'Libera un po’ di spazio sull’unità e riprova.',
  'main.runtime.compatibilityMode':
    'Per stabilità è stata attivata la modalità di compatibilità. Tutto continua a funzionare: ' +
    'le risposte potrebbero essere un po’ più lente.',
  'main.runtime.speedUpDisabled':
    'Per stabilità è stata disattivata un’accelerazione opzionale. Il modello si sta riavviando: ' +
    'invia di nuovo il tuo messaggio.',
  'main.runtime.crashRestarting':
    'Il modello IA si è arrestato in modo imprevisto e si sta riavviando. Tra un momento invia ' +
    'di nuovo il tuo messaggio.',
  'main.runtime.crashStopped':
    'Il modello IA si è arrestato di nuovo in modo imprevisto, quindi non è stato riavviato. ' +
    'Puoi avviarlo di nuovo nella schermata Modello IA.',
  'main.runtime.modelCannotLoad':
    'Non è stato possibile caricare il modello {model} su questo computer: le risposte sono ' +
    'simulate finché non scegli un altro modello.',
  'main.runtime.engineCannotRun':
    'Il motore IA non può funzionare su questo computer, quindi le risposte sono simulate. La ' +
    'schermata Modello IA indica cosa manca.',
  'main.engine.cannotRun':
    'Il motore IA non può funzionare su questo computer. La schermata Modello IA indica cosa ' +
    'manca.',
  'main.noModelRunning':
    'Nessun modello IA è in esecuzione. Apri la schermata Modello IA e avviane prima uno.',
  'main.modelStarting': 'Il modello IA si sta avviando. Riprova tra un momento.',
  'main.translation.noModel':
    'Per tradurre serve il modello di traduzione, che non è installato su questa unità. Puoi ' +
    'scaricarlo nella schermata Modello IA.',
  'main.translation.startFailed':
    'Non è stato possibile avviare il modello di traduzione: sul dispositivo potrebbe esserci ' +
    'poca memoria libera. Chiudi le altre app o riavvia HilbertRaum, poi riprova.',
  'main.translation.failedWindowNotice':
    '> ⚠ Non è stato possibile tradurre questa parte ({part} di {total}): il testo originale ' +
    'resta qui sotto senza modifiche.',
  'main.translation.missingPageNotice':
    '> ⚠ La pagina {page} dell’originale non è stata tradotta: non contiene testo leggibile ' +
    '(potrebbe essere un’immagine scansionata).',
  'main.translation.missingPageRangeNotice':
    '> ⚠ Le pagine {from}–{to} dell’originale non sono state tradotte: non contengono testo ' +
    'leggibile (potrebbero essere immagini scansionate).',
  'main.translation.attributionLine':
    'Tradotto automaticamente con il modello {modelId}: potrebbe contenere errori.',
  'main.model.contextExceeded':
    'Il contenuto è troppo grande per la finestra di contesto del modello attuale. Aumenta la ' +
    'dimensione del contesto nella schermata Modello IA (una dimensione scelta manualmente fa da ' +
    'limite) oppure prova con un documento più piccolo.',
  'main.chat.streamInFlight':
    'Per questa conversazione è già in corso la generazione di una risposta.',
  'main.chat.emptyCompletion':
    'Il modello ha restituito una risposta vuota. Riprova o riformula il messaggio.',
  'main.chat.runtimeUnresponsive':
    'Il modello IA ha smesso di rispondere. Riprova: se il problema si ripete, riavvia il ' +
    'modello nella schermata Modello IA.',
  'main.chat.connectionLost':
    'Il modello IA si è arrestato prima di completare la risposta. Invia di nuovo il messaggio: ' +
    'se il problema si ripete, riavvia il modello nella schermata Modello IA.',
  'main.chat.streamError':
    'Il modello IA si è interrotto per un errore prima di completare la risposta. Riprova: se il ' +
    'problema si ripete, riavvia il modello nella schermata Modello IA.',
  'main.chat.searchModelTimeout':
    'Il modello di ricerca non ha risposto in tempo, quindi non è stato possibile cercare nei ' +
    'tuoi documenti. Riprova.',
  'main.chat.searchModelCannotStart':
    'Il modello di ricerca non si è avviato, quindi non è stato possibile cercare nei tuoi ' +
    'documenti. Nella schermata Modello IA scegli «Controlla tutti i file dei modelli», poi ' +
    'riprova.',
  'main.chat.searchModelFailed':
    'Il modello di ricerca ha avuto un problema, quindi non è stato possibile cercare nei tuoi ' +
    'documenti. Riprova.',
  'main.chat.nothingToRegenerate': 'Non c’è ancora nessuna risposta da rigenerare.',
  'main.chat.nothingToResend':
    'Questa domanda non è più l’ultimo messaggio della conversazione, quindi non può essere ' +
    'inviata di nuovo.',
  'main.chat.skillUnavailable':
    'Questa skill non è più disponibile: è stata disattivata o rimossa. Attivala nella scheda ' +
    'Skill oppure fai di nuovo la domanda senza la skill.',
  'main.chat.reviewBlocksRegenerate':
    'Questa risposta ha una verifica dei riscontri. Rispondere di nuovo eliminerebbe la verifica ' +
    'insieme alle sue decisioni e note: fai invece di nuovo la domanda come nuovo messaggio.',
  'main.chat.emptyMessage': 'Non è possibile inviare un messaggio vuoto.',
  'main.chat.emptyQuestion': 'Non è possibile inviare una domanda vuota.',
  'main.chat.stopFirst':
    'Per questa conversazione è ancora in corso la generazione di una risposta. Prima ' +
    'interrompila.',
  'main.chat.locked': 'L’area di lavoro è bloccata. Sbloccala per chattare.',
  'main.busy.chat':
    'È in corso la scrittura di una risposta. Attendi che finisca (o interrompila), poi riprova.',
  'main.busy.docTask':
    'Un’attività sui documenti sta usando il modello. Attendi che finisca o annullala, poi ' +
    'riprova.',
  'main.busy.skillRun':
    'Una skill sta lavorando su un documento. Attendi che finisca o annullala nella barra di ' +
    'esecuzione, poi riprova.',
  'main.busy.benchmark':
    'È in corso un controllo delle prestazioni di questo computer. Riprova tra un momento.',
  'main.task.unknownKind': 'Attività sui documenti sconosciuta.',
  'main.task.refusedChatStreaming':
    'È in corso la scrittura di una risposta. Attendi che finisca (o interrompila), poi riprova.',
  'main.task.comparePickTwo': 'Scegli esattamente due documenti da confrontare.',
  'main.task.compareReindex':
    'Prima di poter essere confrontati, questi documenti richiedono una breve reindicizzazione: ' +
    'almeno uno è stato preparato con un modello di ricerca diverso. Apri la schermata Documenti ' +
    'e scegli «Reindicizza», poi riprova.',
  'main.task.documentNotReady':
    'Questo documento non contiene ancora testo leggibile. Prima importalo o reindicizzalo, poi ' +
    'riprova.',
  'main.task.genericFailure':
    'Non è stato possibile completare l’attività. Controlla che il modello sia ancora in ' +
    'esecuzione, poi riprova.',
  'main.task.expired': 'Questa attività non è più disponibile.',
  'main.task.translationTarget':
    'Per la traduzione scegli una lingua di partenza supportata e una lingua di arrivo diversa.',
  'main.task.sourceUnreadable':
    'Non è stato possibile leggere la copia salvata di questo documento. Importa di nuovo il ' +
    'documento, poi riprova.',
  'main.task.needsOcr':
    'Il riconoscimento del testo richiede i file OCR, che non sono su questa unità. Scaricali ' +
    'con «Scarica i file OCR» sul documento scansionato o nella schermata Modello IA oppure, su ' +
    'un’unità che hai configurato tu, aggiungili con «fetch-runtime --family ocr».',
  'main.task.ocrUnavailable':
    'Il riconoscimento del testo (OCR) non è disponibile in questa versione: i file OCR sono su ' +
    'questa unità, ma non è stato possibile avviare il riconoscimento.',
  'main.task.ocrNotAScan':
    'Solo un PDF rilevato come scansione, o che contiene pagine scansionate, può essere reso ' +
    'ricercabile in questo modo.',
  'main.task.ocrNoText':
    'In questa scansione non è stato trovato testo leggibile. Le pagine potrebbero essere vuote ' +
    'o troppo sfocate.',
  'main.task.ocrFailed':
    'Non è stato possibile leggere questa scansione. Controlla che il documento sia ancora ' +
    'sull’unità, poi riprova.',
  'main.task.documentBusyIngesting':
    'Questo documento è ancora in fase di importazione o reindicizzazione. Attendi che finisca, ' +
    'poi riprova.',
  'main.task.pickOneTranslate': 'Scegli esattamente un documento da tradurre.',
  'main.task.pickOneOcr': 'Scegli esattamente un PDF scansionato da rendere ricercabile.',
  'main.task.pickOneSummarize': 'Scegli esattamente un documento da riassumere.',
  'main.task.unavailable': 'Le attività sui documenti non sono disponibili.',
  'main.task.workspaceLocked':
    'L’area di lavoro è bloccata. Sbloccala per lavorare con i documenti.',
  'main.download.policyDisabled': 'I download sono disattivati dai criteri di questa unità.',
  'main.download.networkOff':
    'L’accesso a Internet è disattivato. Prima attiva «Consenti l’accesso a Internet per ' +
    'download e aggiornamenti dei modelli» nelle Impostazioni.',
  'main.download.alreadyRunning':
    'È già in corso un altro download. I modelli si scaricano uno alla volta.',
  'main.download.stoppedNetworkOff':
    'L’accesso a Internet è disattivato, quindi il download in corso si è interrotto. Per ' +
    'completarlo, riattiva l’accesso a Internet nelle Impostazioni.',
  'main.download.noSource':
    'Il modello «{modelId}» non ha nessuna origine di download nel suo manifest.',
  'main.download.sourceWithdrawn':
    'Il fornitore del modello «{modelId}» ha rimosso proprio questo file, quindi non è più ' +
    'possibile scaricarlo ({reason}). I modelli già presenti su questa unità continuano a ' +
    'funzionare.',
  'main.download.alreadyVerified': 'Questo modello è già scaricato e controllato.',
  'main.download.presentUnverified':
    'Il file di questo modello è già presente. Il suo manifest non contiene ancora un checksum ' +
    'reale, quindi non è possibile controllarlo: generane uno con «verify-models --generate».',
  'main.download.licenseFirst':
    'Prima di scaricare il modello, leggi e accetta la sua licenza ({license}).',
  'main.download.notEnoughSpace':
    'Su questa unità non c’è abbastanza spazio libero (necessario per il download: {needed}; ' +
    'libero: {free}). Libera spazio sull’unità oppure scegli un modello più piccolo.',
  'main.download.unknownJob': 'Download sconosciuto.',
  'main.download.checksumMismatch':
    'Il file scaricato non corrispondeva al checksum previsto, quindi è stato scartato. Riprova.',
  'main.download.fileMissing':
    'Il file scaricato è scomparso prima che fosse possibile controllarlo.',
  'main.download.httpFailed':
    'Non è stato possibile avviare il download ({reason}). Controlla la connessione e riprova.',
  'main.download.interrupted':
    'Il download si è interrotto ({reason}). La parte già scaricata viene conservata: se avvii ' +
    'di nuovo il download, riprenderà dal punto in cui si era fermato.',
  'main.download.writeFailed':
    'Non è stato possibile salvare il file del modello su questa unità. Controlla che l’unità ' +
    'non sia piena o protetta da scrittura, poi riprova.',
  'main.download.resumeDiscarded':
    'Il server ha inviato la parte sbagliata del file, quindi il download parziale è stato ' +
    'scartato. Se avvii di nuovo il download, ricomincerà dall’inizio.',
  'main.engine.alreadyRunning': 'Il download del motore IA è già in corso.',
  'main.engine.noSources':
    'Su questa unità non è stata trovata nessuna origine per il motore (manca il file ' +
    '«runtime-sources.yaml»).',
  'main.engine.noHostBuild': 'Non è disponibile nessuna build del motore IA per questo computer.',
  'main.engine.alreadyInstalled': 'Il motore IA è già installato.',
  'main.engine.unknownJob': 'Operazione di download del motore sconosciuta.',
  'main.engine.checksumMismatch':
    'Il motore scaricato non corrispondeva al checksum previsto, quindi è stato scartato. ' +
    'Riprova.',
  'main.engine.fileMissing':
    'Il motore scaricato è scomparso prima che fosse possibile controllarlo.',
  'main.engine.unverifiablePlaceholder':
    'Questa origine del motore IA non ha un checksum reale, quindi non è stato possibile ' +
    'controllare il download e il motore non è stato installato. L’unità potrebbe essere ' +
    'configurata in modo errato.',
  'main.engine.binaryMissing':
    'Il motore è stato scaricato, ma non è stato possibile estrarlo (forse la struttura ' +
    'dell’archivio è cambiata).',
  'main.engine.extractFailed':
    'Il motore IA è stato scaricato, ma non è stato possibile estrarlo. Riprova.',
  'main.engine.httpFailed':
    'Non è stato possibile avviare il download del motore ({reason}). Controlla la connessione e ' +
    'riprova.',
  'main.engine.interrupted': 'Il download del motore si è interrotto ({reason}). Riprova.',
  'main.engine.runtimeRunning':
    'Non è possibile sostituire il motore IA mentre un modello è in esecuzione. Arresta il ' +
    'modello nella schermata Modello IA, poi riprova.',
  'main.engine.transcriptionRunning':
    'Non è possibile sostituire il motore vocale mentre è in corso una trascrizione audio. ' +
    'Attendi che la trascrizione finisca, poi riprova.',
  'main.engine.knowledgePackToolsRunning':
    'Non è possibile sostituire gli strumenti per i pacchetti di conoscenze mentre un pacchetto ' +
    'è in uso. Blocca l’area di lavoro o attendi che la domanda in corso finisca, poi riprova; ' +
    'se l’avviso resta, riavvia l’app.',
  'main.engine.badRequest':
    'La richiesta di installazione del motore non è stata compresa. Riprova.',
  'main.engine.nothingToRepair':
    'Non c’è nulla da riparare: il motore su questa unità non risulta danneggiato.',
  'main.engine.nothingToUpdate':
    'Non c’è nulla da aggiornare: i motori su questa unità hanno già la versione usata da questa ' +
    'app, o una più recente.',
  'main.engine.updateBusy':
    'Il motore IA è in uso in questo momento (è in corso una risposta, un’importazione, una ' +
    'traduzione o un’attività sui documenti). Riprova l’aggiornamento quando avrà finito.',
  'main.ocr.badRequest': 'La richiesta di download dei file OCR non è stata compresa. Riprova.',
  'main.ocr.alreadyRunning': 'Il download dei file OCR è già in corso.',
  'main.ocr.noSources':
    'Su questa unità non c’è un elenco di download per i file OCR. Aggiungili invece con gli ' +
    'script di configurazione dell’unità («fetch-runtime --family ocr»).',
  'main.ocr.sourcesMismatch':
    'L’elenco di download dei file OCR su questa unità non corrisponde a questa versione di ' +
    'HilbertRaum, quindi non è stato scaricato nulla. Aggiungi invece i file con gli script di ' +
    'configurazione dell’unità («fetch-runtime --family ocr»).',
  'main.ocr.alreadyInstalled':
    'I file OCR sono già su questa unità. Se il riconoscimento del testo continua a non essere ' +
    'disponibile, riavvia HilbertRaum.',
  'main.ocr.unsafeFolder':
    'La cartella «ocr» su questa unità non è una cartella normale (potrebbe rimandare a un’altra ' +
    'posizione), quindi non è stato scritto nulla. Sostituiscila con una cartella normale ' +
    'chiamata «ocr», poi riprova.',
  'main.ocr.writeFailed':
    'Non è stato possibile salvare i file OCR su questa unità. Controlla che l’unità non sia ' +
    'piena o protetta da scrittura, poi riprova.',
  'main.ocr.downloadFailed':
    'Non è stato possibile scaricare i file OCR. Controlla la connessione a Internet, poi ' +
    'riprova.',
  'main.ocr.checksumMismatch':
    'Un file OCR scaricato non corrispondeva al checksum previsto ed è stato scartato: i file ' +
    'già presenti su questa unità non sono stati modificati. Riprova.',
  'main.ocr.readFailed':
    'Non è stato possibile leggere i file OCR già presenti su questa unità: l’unità potrebbe ' +
    'essere stata scollegata, oppure un altro programma sta usando i file. Controlla l’unità, ' +
    'poi riprova.',
  'main.ocr.unknownJob':
    'Questo download dei file OCR non è più monitorato. Avvialo di nuovo se i file mancano ' +
    'ancora.',
  'main.docs.locked': 'L’area di lavoro è bloccata. Sbloccala per gestire i documenti.',
  'main.docs.processing':
    'Questo documento è ancora in fase di elaborazione. Attendi che l’importazione finisca.',
  'main.docs.tooManyPaths':
    'Sono stati selezionati troppi file in una volta. Scegli invece una cartella.',
  'main.docs.taskRunning':
    'Su questo documento è in corso un’attività. Annullala o attendi che finisca.',
  'main.docs.skillRunning':
    'Una skill sta lavorando su questo documento. Annullala o attendi che finisca.',
  'main.docs.previewEncrypted':
    'Questo documento è crittografato: sblocca l’area di lavoro per vederne l’anteprima.',
  'main.docs.previewGone':
    'Il file del documento non è più sull’unità. Importalo di nuovo per vederne l’anteprima.',
  'main.docs.exportTextOnly':
    'In questo modo puoi esportare solo documenti di testo (Markdown, TXT, CSV).',
  'main.docs.exportEncrypted':
    'Questo documento è crittografato: sblocca l’area di lavoro per esportarlo.',
  'main.docs.exportGone':
    'Il file del documento non è più sull’unità. Importalo di nuovo per esportarlo.',
  'main.docs.exportOriginalChanged':
    'È ancora disponibile solo la tua copia di questo file, ed è cambiata dopo l’importazione: ' +
    'quindi non è più l’originale. Esporta invece il testo estratto.',
  'main.docs.noStoredTranscript':
    'Per questa registrazione non è ancora salvata una trascrizione. Reindicizzala per ' +
    'trascriverla di nuovo.',
  'main.models.noManifests':
    'Su questa unità non è stato trovato nessun elenco dei modelli: manca la cartella ' +
    '«model-manifests».',
  'main.models.autoSelected':
    'Questo modello viene usato automaticamente una volta installato: non c’è nulla da ' +
    'selezionare.',
  'main.models.locked': 'L’area di lavoro è bloccata. Sbloccala per gestire i modelli IA.',
  'main.audit.locked': 'L’area di lavoro è bloccata. Sbloccala per vedere l’attività.',
  'main.settings.locked': 'L’area di lavoro è bloccata. Sbloccala per cambiare le impostazioni.',
  'main.evidenceReviews.locked':
    'L’area di lavoro è bloccata. Sbloccala per lavorare alle verifiche dei riscontri.',
  'main.evidenceReviews.invalidRequest': 'Questa richiesta di verifica non è valida.',
  'main.evidenceReviews.exportNotRecorded':
    'Non è stato possibile registrare il pacchetto di riscontri nella cronologia delle ' +
    'esportazioni, quindi il file esportato è stato rimosso. Non è stato salvato nulla: ripeti ' +
    'l’esportazione.',
  'main.evidenceReviews.exportFileNotRecorded':
    'Il file del pacchetto di riscontri è stato salvato, ma non è stato possibile né registrarlo ' +
    'nella cronologia delle esportazioni né rimuoverlo. Il suo hash non risulta registrato: ' +
    'esporta di nuovo e sostituisci il file.',
  'main.evidenceReviews.exportOutdated':
    'Questa verifica non è aggiornata: una fonte o la risposta è cambiata da quando la verifica ' +
    'è stata avviata. Prendi atto della modifica nella verifica prima di esportare.',
  'main.settings.invalidPatch':
    'Questa modifica delle impostazioni non è valida e non è stata salvata.',
  'main.dictation.locked': 'L’area di lavoro è bloccata. Sbloccala per usare la dettatura vocale.',
  'main.dictation.silent':
    'Nessun suono è arrivato al microfono. Controlla che non sia silenziato e che HilbertRaum ' +
    'possa usarlo nelle impostazioni di sistema, poi riprova.',
  'main.dictation.tooShort': 'La registrazione era troppo breve per contenere parole: riprova.',
  'main.dictation.unavailable':
    'La dettatura vocale non è ancora disponibile su questa unità: la schermata Modello IA ' +
    'mostra cosa manca.',
  'main.dictation.failed': 'Non è stato possibile trascrivere la registrazione: riprova.',
  'main.dictation.tooLong':
    'Questa registrazione è troppo lunga per la dettatura. Per le registrazioni lunghe, importa ' +
    'invece il file audio come documento.',
  'main.dictation.busy': 'Trascrizione dell’ultima dettatura ancora in corso: attendi un momento.',
  'main.dictation.engineCannotRun':
    'Il motore vocale non può funzionare su questo computer. La schermata Modello IA indica cosa ' +
    'manca.',
  'main.preflight.readOnly':
    'Questa unità sembra essere in sola lettura, quindi l’app non può creare la sua area di ' +
    'lavoro. Prova un’altra porta USB oppure consulta la guida alla risoluzione dei problemi.',
  'main.preflight.lowSpace':
    'Su questa unità c’è poco spazio libero. Puoi comunque continuare, ma l’importazione di ' +
    'documenti grandi potrebbe non riuscire finché non liberi spazio.',
  'main.dialog.importDocuments': 'Importa documenti',
  'main.dialog.importFolder': 'Importa una cartella di documenti',
  'main.dialog.exportDocument': 'Esporta il documento',
  'main.dialog.exportOriginal': 'Esporta il file originale',
  'main.dialog.exportSummary': 'Esporta il riassunto',
  'main.dialog.exportChat': 'Esporta la trascrizione della chat',
  'main.dialog.exportTableCsv': 'Esporta la tabella in CSV',
  'main.dialog.exportCodeBlock': 'Salva il blocco di codice come file',
  'main.dialog.exportAudit': 'Esporta il registro delle attività',
  'main.dialog.exportEvidencePack': 'Esporta il pacchetto di riscontri',
  'main.dialog.exportLog': 'Salva i log di diagnostica',
  'main.dialog.filterDocuments': 'Documenti',
  'main.dialog.filterAll': 'Tutti i file',
  'main.zim.unavailable': 'I pacchetti di conoscenze non sono disponibili in questa sessione.',
  'main.zim.articleUnavailable':
    'Questo articolo non è disponibile in questo momento, quindi non è stato possibile salvarlo. ' +
    'Il pacchetto potrebbe essere disattivato o rimosso, oppure la sua unità potrebbe essere ' +
    'scollegata.',
  'main.zim.saveFailed': 'Non è stato possibile aggiungere l’articolo ai tuoi documenti. Riprova.',
  'main.zim.dialogTitle': 'Aggiungi pacchetti di conoscenze',
  'main.zim.filterZim': 'Archivi ZIM',
  'main.dialog.chooseImage': 'Scegli un’immagine',
  'main.dialog.filterImages': 'Immagini',
  'main.images.unsupportedType':
    'Questo tipo di file non è supportato. Scegli un file PNG, JPEG o WEBP.',
  'main.images.tooLarge':
    'Questa immagine è troppo grande da analizzare. Prova con un’immagine più piccola.',
  'main.dialog.importSkill': 'Importa un pacchetto di skill',
  'main.dialog.importSkillFolder': 'Importa una cartella di skill',
  'main.dialog.exportSkill': 'Esporta la skill',
  'main.dialog.filterSkill': 'Pacchetto di skill',
  'main.dialog.exportCsv': 'Esporta le transazioni',
  'main.dialog.filterCsv': 'File CSV',
  'main.dialog.exportJson': 'Esporta in JSON',
  'main.dialog.filterJson': 'File JSON',
  'main.dialog.exportXml': 'Esporta in XML',
  'main.dialog.filterXml': 'File XML',
  'main.dialog.exportRedacted': 'Salva la copia oscurata',
  'main.dialog.exportEdited': 'Salva la copia modificata',
  'main.dialog.filterText': 'File di testo',
  'main.dialog.filterDocx': 'Documento Word',
  'main.collections.builtinUndeletable':
    'Le sezioni integrate Libreria e Temporanei non possono essere eliminate.',
  'main.skills.locked': 'L’area di lavoro è bloccata. Sbloccala per gestire le skill.',
  'main.skills.notPicked':
    'Prima scegli il pacchetto della skill con la finestra di selezione dei file.',
  'main.skills.incompatible':
    'Questa skill richiede una versione più recente dell’app. Aggiorna l’app per usarla.',
  'main.skills.run.unavailable': 'Lo strumento di questa skill non è disponibile al momento.',
  'main.skills.run.noDocument': 'Prima aggiungi un documento a questa chat, poi riprova.',
  'main.skills.run.busy': 'Una skill sta già lavorando. Prima attendi che finisca o annullala.',
  'main.skills.run.documentOutOfScope':
    'Quel documento non è tra i documenti di questa chat. Scegline uno e riprova.',
  // ---- Document organization — Documents screen sections + actions (plan §12) ----
  'docs.section.heading': 'Sezioni',
  'docs.section.library': 'Libreria',
  'docs.section.projects': 'Progetti',
  'docs.section.temporary': 'Temporanei',
  'docs.section.generated': 'Generati',
  'docs.section.archived': 'Archiviati',
  'docs.section.all': 'Tutti i documenti',
  'docs.section.newProject': 'Nuovo progetto',
  'docs.mode.aria': 'Vista dei documenti',
  'docs.mode.documents': 'I miei documenti',
  'docs.mode.packs': 'Pacchetti di conoscenze',
  'docs.filter.placeholder': 'Filtra per nome…',
  'docs.filter.aria': 'Filtra i documenti per nome',
  'docs.filter.noMatch': 'Nessun documento corrisponde a «{query}».',
  'docs.empty.packsLine':
    'Oppure aggiungi un pacchetto di conoscenze: una Wikipedia offline da cui la chat può trarre ' +
    'le risposte.',
  'docs.empty.packsAction': 'Pacchetti di conoscenze',
  'docs.rail.hide': 'Nascondi sezioni',
  'docs.rail.show': 'Mostra sezioni',
  'docs.project.createTitle': 'Crea un progetto',
  'docs.project.namePlaceholder': 'Nome del progetto',
  'docs.project.nameAria': 'Nome del progetto',
  'docs.project.create': 'Crea',
  'docs.project.rename': 'Rinomina',
  'docs.project.renameTitle': 'Rinomina il progetto',
  'docs.project.archive': 'Archivia',
  'docs.project.unarchive': 'Estrai dall’archivio',
  'docs.project.delete': 'Elimina progetto',
  'docs.project.deleteTitle': 'Vuoi eliminare questo progetto?',
  'docs.project.deleteBody': 'Scegli cosa succede ai documenti di questo progetto:',
  'docs.project.deleteKeep': 'Rimuovi solo il progetto e conserva i suoi documenti',
  'docs.project.deleteKeepHint': 'I documenti restano nella tua Libreria e negli altri progetti.',
  'docs.project.deleteWith': 'Elimina il progetto e i documenti che si trovano solo qui',
  'docs.project.deleteWithHint':
    'Vengono eliminati solo i documenti che non sono anche nella tua Libreria o in un altro ' +
    'progetto. I contenuti della Libreria non vengono mai toccati.',
  'docs.project.archivedNote':
    'Archiviato: nascosto come fonte, ma i suoi documenti restano disponibili per le domande ' +
    'altrove.',
  'docs.project.options': 'Opzioni del progetto',
  'docs.action.moveToProject': 'Sposta in un progetto…',
  'docs.action.addToLibrary': 'Conserva nella Libreria',
  'docs.action.removeFromProject': 'Rimuovi da questo progetto',
  'docs.action.markTemporary': 'Segna come temporaneo',
  'docs.action.markPermanent': 'Segna come permanente',
  'docs.action.archive': 'Archivia',
  'docs.action.unarchive': 'Estrai dall’archivio',
  'docs.action.chooseProject': 'Scegli un progetto',
  'docs.chip.library': 'Libreria',
  'docs.chip.temporary': 'Temporaneo',
  'docs.chip.generated': 'Generato',
  'docs.chip.archived': 'Archiviato',
  'docs.bulk.selected.one': '{count} selezionato',
  'docs.bulk.selected.many': '{count} selezionati',
  'docs.bulk.selected.other': '{count} selezionati',
  'docs.selectionAria': 'Azioni per i documenti selezionati',
  'docs.bulk.delete': 'Elimina',
  'docs.bulk.deleteConfirm.title.one': 'Vuoi eliminare {count} documento?',
  'docs.bulk.deleteConfirm.title.many': 'Vuoi eliminare {count} di documenti?',
  'docs.bulk.deleteConfirm.title.other': 'Vuoi eliminare {count} documenti?',
  'docs.bulk.deleteConfirm.body':
    'I documenti selezionati, il loro testo estratto e il loro indice di ricerca vengono ' +
    'eliminati definitivamente dalla tua area di lavoro. I file originali fuori dall’area di ' +
    'lavoro non vengono toccati.',
  'docs.empty.section': 'Qui non c’è ancora nulla.',
  // ---- Document organization — smart views (plan §7.6/§12.1, Phase E; regrouped §11.16) ----
  'docs.smart.recentlyAdded': 'Aggiunti di recente',
  'docs.smart.unfiled': 'Senza progetto',
  'docs.smart.attention': 'Richiedono attenzione',
  'docs.smart.attentionTitle': 'Importazioni non riuscite e documenti da reindicizzare',
  'docs.smart.more': 'Altro',
  'docs.provenance.staleBadge': 'Non aggiornato',
  'docs.provenance.staleChanged':
    'Una fonte è cambiata dopo la creazione di questo documento: esegui di nuovo l’operazione ' +
    'per aggiornarlo.',
  'docs.provenance.staleRemoved':
    'Una fonte è stata rimossa dopo la creazione di questo documento: esegui di nuovo ' +
    'l’operazione per aggiornarlo.',
  // ---- Chat — composite source scope (multi-select picker + footer union, plan §13) ----
  'chat.scope.library': 'Libreria',
  'chat.scope.projectNamed': 'Progetto «{name}»',
  'chat.scope.projectCount.one': '{count} progetto',
  'chat.scope.projectCount.many': '{count} di progetti',
  'chat.scope.projectCount.other': '{count} progetti',
  // ---- Knowledge packs (ZIM wave: ScopePopover / SourcesDisclosure / ArticleModal / PacksPanel) ----
  'chat.scope.packsTitle': 'Pacchetti di conoscenze',
  'chat.scope.packUnavailable': 'non disponibile',
  'chat.scope.packNamed': 'Pacchetto «{name}»',
  'chat.scope.packNamedState': 'Pacchetto «{name}» ({state})',
  'chat.scope.packCount.one': '{count} pacchetto di conoscenze',
  'chat.scope.packCount.many': '{count} di pacchetti di conoscenze',
  'chat.scope.packCount.other': '{count} pacchetti di conoscenze',
  'chat.scope.documentsToggle': 'Cerca nei miei documenti',
  'chat.scope.documentsToggleHint':
    'Se disattivi questa opzione, le risposte provengono solo dai pacchetti di conoscenze ' +
    'selezionati. I file allegati a questa chat vengono comunque usati.',
  'chat.scope.documentsOffSuffix': 'documenti esclusi',
  'chat.scope.documentsOffNoPacks':
    'nessuna fonte – attiva i documenti o seleziona un pacchetto di conoscenze',
  'chat.scope.packDisabled': 'disattivato',
  'chat.scope.packRemoved': 'Pacchetto rimosso',
  'chat.scope.packLimit.one': 'Fino a {count} pacchetto di conoscenze per chat',
  'chat.scope.packLimit.many': 'Fino a {count} di pacchetti di conoscenze per chat',
  'chat.scope.packLimit.other': 'Fino a {count} pacchetti di conoscenze per chat',
  // ---- Per-answer knowledge-pack outcomes (#301 P4, findings M6/M7 — PackOutcomesNotice) ----
  'chat.packs.outcome.summary':
    'Pacchetti di conoscenze · consultati: {searched} · non consultati o con errori: {other}',
  'chat.packs.outcome.removedPack': 'un pacchetto rimosso',
  'chat.packs.outcome.passages.one': '{count} brano',
  'chat.packs.outcome.passages.many': '{count} di brani',
  'chat.packs.outcome.passages.other': '{count} brani',
  'chat.packs.outcome.unknown':
    'Pacchetti di conoscenze: esito non registrato per questa risposta meno recente',
  'chat.packs.outcome.searched': 'consultato',
  'chat.packs.outcome.selection-limit': 'non consultato: limite di selezione (12 per chat)',
  'chat.packs.outcome.removed': 'non consultato: pacchetto rimosso',
  'chat.packs.outcome.disabled': 'non consultato: pacchetto disattivato',
  'chat.packs.outcome.file-missing': 'non consultato: file mancante',
  'chat.packs.outcome.identity-mismatch':
    'non consultato: in questa posizione c’è un archivio diverso',
  'chat.packs.outcome.not-served': 'non consultato: nome in conflitto con un altro pacchetto',
  'chat.packs.outcome.not-searchable': 'non consultato: senza indice di ricerca',
  'chat.packs.outcome.tools-missing': 'non consultato: programmi kiwix-tools non installati',
  'chat.packs.outcome.mode':
    'non consultato: le risposte sull’intero documento leggono solo il documento',
  'chat.packs.outcome.search-failed': 'non riuscito: errore di ricerca',
  'chat.packs.outcome.read-failed': 'non riuscito: non è stato possibile leggere nessun articolo',
  'chat.packs.outcome.timeout': 'non riuscito: tempo scaduto',
  'chat.packs.outcome.deadline': 'non consultato: tempo esaurito per questa domanda',
  'chat.packs.outcome.server-restarted':
    'non riuscito: il server dei pacchetti si è riavviato durante questa domanda',
  'chat.sources.openArticle': 'Apri l’articolo',
  'chat.article.title': 'Articolo',
  'chat.article.from': 'Archivio: {archive} · copia offline',
  'chat.article.loading': 'Caricamento dell’articolo…',
  'chat.article.unavailable':
    'Questo articolo non è disponibile in questo momento. Il pacchetto potrebbe essere ' +
    'disattivato o rimosso, oppure la sua unità potrebbe essere scollegata.',
  'chat.article.partial': 'È stato possibile mostrare solo la prima parte di questo articolo.',
  'chat.article.save': 'Salva nei miei documenti',
  'chat.article.saveAria': 'Salva nei miei documenti: {title}',
  'chat.article.saving': 'Salvataggio nei tuoi documenti…',
  'chat.article.saved':
    'Articolo salvato nei tuoi documenti come «{title}». Resta ricercabile anche senza il ' +
    'pacchetto.',
  'chat.article.alreadySaved': 'Questo articolo è già nei tuoi documenti come «{title}».',
  // ---- #301 P6 (a11y pass; plan §9.23 (b)4/(b)6 and decision (c)5) — BEGIN -----------------
  'chat.scope.packMissing': 'file mancante',
  'chat.scope.packMismatch': 'archivio diverso in questa posizione',
  'chat.scope.packNotSearchable': 'senza indice di ricerca',
  'chat.sources.openArticleNamed': 'Apri l’articolo: {title}',
  // ---- #301 P6 — END ------------------------------------------------------------------------
  'packs.add': 'Aggiungi pacchetti…',
  'packs.addBusy': 'Aggiunta in corso…',
  'packs.refresh': 'Aggiorna',
  'packs.lead':
    'Archivi di consultazione offline (file ZIM, per esempio una Wikipedia offline) da cui la ' +
    'chat può trarre le risposte. I file vengono usati dove si trovano e non vengono mai ' +
    'copiati: mettili nella cartella «zim» dell’unità o aggiungili qui.',
  'packs.summary.count.one': '{count} pacchetto',
  'packs.summary.count.many': '{count} di pacchetti',
  'packs.summary.count.other': '{count} pacchetti',
  'packs.summary.enabled.one': '{count} attivo',
  'packs.summary.enabled.many': '{count} attivi',
  'packs.summary.enabled.other': '{count} attivi',
  'packs.summary.size': '{size} su questa unità',
  'packs.loading': 'Caricamento dei pacchetti…',
  'packs.refreshing': 'Ricerca dei pacchetti sull’unità…',
  'packs.emptyTitle': 'Ancora nessun pacchetto di conoscenze',
  'packs.emptyLine':
    'Scarica un archivio .zim in un unico file da library.kiwix.org, poi aggiungilo qui o ' +
    'copialo nella cartella «zim» dell’unità.',
  'packs.copyLibrary': 'Copia l’indirizzo della libreria Kiwix',
  'packs.copiedToast': 'Indirizzo library.kiwix.org copiato',
  'packs.copyFailed': 'Non è stato possibile copiare: l’indirizzo è library.kiwix.org',
  'packs.setup.title': 'Configurazione una tantum: gli strumenti per i pacchetti di conoscenze',
  'packs.toolsMissing':
    'I programmi kiwix-tools non sono installati su questa unità, quindi non è possibile ' +
    'aggiungere pacchetti né cercare al loro interno. La procedura di installazione è nella ' +
    'guida alla risoluzione dei problemi, alla voce «The panel says kiwix-tools are missing».',
  'packs.tools.install': 'Installa gli strumenti per i pacchetti di conoscenze…',
  'packs.tools.confirm.title': 'Vuoi installare gli strumenti per i pacchetti di conoscenze?',
  'packs.tools.confirm.explain':
    'I programmi kiwix-tools {version}, che rendono disponibili i pacchetti di conoscenze ' +
    '(archivi ZIM), verranno scaricati dal server del progetto Kiwix e controllati prima ' +
    'dell’uso. Sono opzionali: chat e documenti funzionano anche senza.',
  'packs.tools.confirm.hint':
    'Il download viene controllato prima dell’uso e non viene inviato nulla su di te o sui tuoi ' +
    'documenti. Gli strumenti servono solo per i pacchetti di conoscenze.',
  'packs.tools.confirm.ack': 'Ho letto e accetto i termini della licenza {license} di kiwix-tools',
  'packs.tools.confirm.start': 'Avvia il download',
  'packs.tools.sizeUnknown': 'sconosciute',
  'packs.tools.progress':
    'Installazione degli strumenti per i pacchetti di conoscenze in corso… {pct}%',
  'packs.tools.downloadingNoTotal':
    'Installazione degli strumenti per i pacchetti di conoscenze in corso…',
  'packs.tools.verifying': 'Controllo degli strumenti per i pacchetti di conoscenze in corso…',
  'packs.tools.extracting': 'Estrazione degli strumenti per i pacchetti di conoscenze in corso…',
  'packs.tools.failed':
    'Non è stato possibile installare gli strumenti per i pacchetti di conoscenze.',
  'packs.tools.doneToast': 'Strumenti per i pacchetti di conoscenze installati',
  'packs.addedToast.one': 'Pacchetto di conoscenze aggiunto',
  'packs.addedToast.many': '{count} di pacchetti di conoscenze aggiunti',
  'packs.addedToast.other': '{count} pacchetti di conoscenze aggiunti',
  'packs.addPartial': 'Archivi che non è stato possibile aggiungere: {failed} su {total}.',
  'packs.addFailed.notAZim': 'Il file scelto non è un archivio ZIM leggibile.',
  'packs.addFailed.toolsMissing':
    'I programmi kiwix-tools non sono installati su questa unità, quindi non è possibile ' +
    'aggiungere pacchetti né cercare al loro interno. La procedura di installazione è nella ' +
    'guida alla risoluzione dei problemi, alla voce «The panel says kiwix-tools are missing».',
  'packs.addFailed.manager':
    'Non è stato possibile leggere l’archivio con kiwix-manage. Controlla che il file sia ' +
    'completo e riprova.',
  'packs.addFailed.pathUnsupported':
    'Su Windows, kiwix-manage non può leggere questo archivio perché il nome del file o della ' +
    'cartella contiene una dieresi, un accento o un altro carattere non ASCII. Copia il file ' +
    'nella cartella «zim/» dell’unità con un nome senza caratteri di questo tipo e aggiungilo di ' +
    'nuovo.',
  'packs.addFailed.other': 'Non è stato possibile aggiungere l’archivio.',
  'packs.removedToast': 'Pacchetto di conoscenze rimosso',
  'packs.articleCount.one': '{count} articolo',
  'packs.articleCount.many': '{count} di articoli',
  'packs.articleCount.other': '{count} articoli',
  'packs.state.enabled': 'Attivo',
  'packs.state.disabled': 'Disattivato',
  'packs.state.missing': 'File mancante',
  'packs.state.missingTitle': 'Il file dell’archivio non è stato trovato: l’unità è collegata?',
  'packs.state.identityMismatch': 'Archivio diverso',
  'packs.state.identityMismatchTitle':
    'Il file nella posizione di questo pacchetto è un archivio diverso: rimuovi questo pacchetto ' +
    'e aggiungi di nuovo il file',
  'packs.state.notSearchable': 'Senza indice di ricerca',
  'packs.state.notSearchableTitle':
    'Questo archivio non ha un indice per la ricerca nel testo completo. Viene saltato quando ' +
    'fai domande, ma i suoi articoli restano leggibili.',
  'packs.state.notServed': 'Non disponibile',
  'packs.state.notServedTitle':
    'Il nome del suo file è in conflitto con quello del pacchetto «{title}», quindi è ' +
    'disponibile solo quel pacchetto: rinomina questo file per usarli entrambi.',
  'packs.state.notServedTitleUnknown':
    'Il nome del suo file è in conflitto con quello di un altro pacchetto, quindi è disponibile ' +
    'solo quel pacchetto: rinomina questo file per usarli entrambi.',
  'packs.switchLabel': 'Usa «{title}» nelle chat',
  'packs.ask': 'Chiedi a questo pacchetto',
  'packs.askTitle': 'Apri una chat che risponde usando solo questo pacchetto',
  'packs.rowMenu': 'Altre azioni per «{title}»',
  'packs.remove': 'Rimuovi',
  'packs.listLabel': 'Pacchetti di conoscenze',
  'packs.removeTitle': 'Vuoi rimuovere questo pacchetto di conoscenze?',
  'packs.removeConfirm': 'Rimuovi pacchetto',
  'packs.removeBody':
    'Il pacchetto viene rimosso solo da HilbertRaum: il file dell’archivio sull’unità non viene ' +
    'toccato. Le chat che lo usavano smettono semplicemente di attingervi.',
  'chat.scope.docCount.one': '{count} documento',
  'chat.scope.docCount.many': '{count} di documenti',
  'chat.scope.docCount.other': '{count} documenti',
  'chat.scope.filesInChat.one': '{count} file in questa chat',
  'chat.scope.filesInChat.many': '{count} di file in questa chat',
  'chat.scope.filesInChat.other': '{count} file in questa chat',
  'chat.scope.sourcesTitle': 'Scegli le fonti',
  'chat.scope.librarySource': 'Libreria',
  'chat.scope.librarySourceHint': 'Tutta la tua base di conoscenze',
  'chat.scope.specificToggle': 'Documenti specifici…',
  'chat.scope.allTap': 'Tutti i documenti',
  'chat.scope.attachmentsOnlyTap': 'Solo i file in questa chat',
  'chat.scope.filesInChatLine': 'File in questa chat',
  'chat.scope.attachmentNotReadable': '{name} (non ancora leggibile)',
  'chat.scope.attachmentFailedHint':
    'Un file che non è ancora leggibile non contribuisce alle risposte. In Documenti trovi il ' +
    'motivo e cosa fare.',
  'chat.scope.noProjects': 'Ancora nessun progetto',
  'chat.scope.noPacks': 'Ancora nessun pacchetto di conoscenze su questa unità.',
  'chat.scope.addPacks': 'Aggiungi pacchetti…',
  'chat.scope.archivedFallback':
    'Questo progetto è stato archiviato: le risposte provengono dalla tua Libreria.',
  'chat.scope.answeringFrom': 'Risposte basate su: {source}',
  'chat.scope.wholeLibrary.one': 'tutta la tua Libreria ({count} documento)',
  'chat.scope.wholeLibrary.many': 'tutta la tua Libreria ({count} di documenti)',
  'chat.scope.wholeLibrary.other': 'tutta la tua Libreria ({count} documenti)',
  'chat.scope.narrowTitle': 'Vuoi risposte basate solo su questo file?',
  'chat.scope.narrowBody':
    'Hai aggiunto il file {name}. Vuoi fare domande solo su questo file o continuare a ricevere ' +
    'risposte da tutta la tua Libreria?',
  'chat.scope.narrowJust': 'Solo questo file',
  'chat.scope.narrowWhole': 'Tutta la Libreria',
  // ---- Chat — attach / drag-drop a file into a chat (plan §11.2/§13.5, Phase C) ----
  'chat.attach.button': 'Allega file',
  'chat.attach.drop': 'Trascina qui i file per usarli in questa chat',
  'chat.attach.processing': 'Elaborazione di {name}…',
  'chat.attach.added': 'File {name} aggiunto a questa chat',
  'chat.attach.newDocChat': 'Avviata una nuova chat sui documenti per il file {name}',
  'chat.attach.failed': 'Non è stato possibile aggiungere il file {name} a questa chat.',
  'chat.attach.dropUnsupported':
    'Non è stato possibile aggiungere l’elemento: trascina qui un file salvato sul tuo computer.',
  'chat.attach.trackFailed':
    'Non è stato possibile seguire l’importazione del file: controlla il risultato in Documenti.',
  'chat.attach.scanned':
    'Il file {name} sembra una scansione, quindi non può ancora essere letto. In Documenti usa ' +
    '«Rendi ricercabile (OCR)» su questo file. Dopo verrà aggiunto da solo a questa chat: non ' +
    'serve allegarlo di nuovo.',
  'chat.attach.photoNeedsOcr':
    'Il file {name} è la foto di una pagina e per leggerlo servono i file OCR, che non sono ' +
    'ancora su questa unità. In Documenti usa «Scarica i file OCR», poi «Riprova» su questo ' +
    'file. Dopo verrà aggiunto da solo a questa chat: non serve allegarlo di nuovo.',
  'chat.attach.goToDocuments': 'Vai a Documenti',
  // ---- Images — "Ask about an image" (image-understanding §5/§11, Phase V3) ----
  'images.title': 'Analizza un’immagine',
  'images.empty.body':
    'Fai domande su uno screenshot, un grafico, un modulo, una ricevuta o una foto. Tutto resta ' +
    'in locale.',
  'images.avail.noModel':
    'Per analizzare le immagini serve un modello locale per le immagini su questa unità.',
  'images.avail.noRuntime': 'Per analizzare le immagini bisogna prima installare il motore IA.',
  'images.avail.incompatible':
    'Il modello per le immagini di questa unità richiede un motore IA più recente.',
  'images.avail.cta': 'Vai a Modello IA',
  'images.avail.ocrPointer': 'Documenti scansionati? Usa «Rendi ricercabile (OCR)» in Documenti.',
  'images.drop.title': 'Trascina qui un’immagine',
  'images.drop.choose': 'oppure scegli un’immagine',
  'images.drop.types': 'PNG, JPEG o WEBP',
  'images.drop.busy': 'È in corso un’analisi. Attendi che finisca per avviarne un’altra.',
  'images.back': 'Torna alle analisi',
  'images.preview.remove': 'Rimuovi',
  'images.preview.replace': 'Sostituisci',
  'images.preview.alt': 'Immagine selezionata',
  'images.chip.summarize': 'Riassumi questa immagine',
  'images.chip.summarize.prompt':
    'Riassumi il contenuto visibile di questa immagine. Segnala tutto ciò che è importante o ' +
    'insolito.',
  'images.chip.extractText': 'Estrai il testo visibile',
  'images.chip.extractText.prompt':
    'Estrai il testo visibile che riesci a leggere. Mantieni gli a capo dove è utile. Indica se ' +
    'una parte del testo non è chiara.',
  'images.chip.explainChart': 'Spiega questo grafico',
  'images.chip.explainChart.prompt':
    'Spiega cosa sembra mostrare questo grafico. Indica assi, etichette, tendenze ed eventuali ' +
    'incertezze.',
  'images.chip.readForm': 'Leggi questo modulo',
  'images.chip.readForm.prompt':
    'Individua i campi principali e i valori visibili in questo modulo. Scrivi «non chiaro» dove ' +
    'non riesci a leggere qualcosa.',
  'images.chip.importantDetails': 'Trova i dettagli importanti',
  'images.chip.importantDetails.prompt':
    'Elenca i dettagli visibili più importanti. Non dedurre nulla che non sia visibile.',
  'images.chip.whatNotice': 'Cosa dovrei notare?',
  'images.chip.whatNotice.prompt':
    'Cosa dovrei notare in questa immagine? Indica solo gli elementi visibili più rilevanti.',
  'images.composer.placeholder': 'Fai una domanda su questa immagine…',
  'images.composer.ask': 'Chiedi',
  'images.answer.localNote': 'Risposta generata in locale dall’immagine selezionata.',
  'images.answer.copy': 'Copia',
  'images.answer.copied': 'Copiato',
  'images.answer.copyFailed': 'Non è stato possibile copiare negli Appunti',
  'images.answer.tryAgain': 'Riprova',
  'images.answer.reading': 'Lettura dell’immagine…',
  'images.answer.starting': 'Avvio del modello per le immagini…',
  'images.answer.stop': 'Interrompi',
  'images.answer.stopped': 'Risposta interrotta.',
  'images.err.tooLarge':
    'Questa immagine è troppo grande da analizzare. Prova con un’immagine più piccola.',
  'images.err.unsupported':
    'Questo tipo di file non è supportato. Scegli un file PNG, JPEG o WEBP.',
  'images.err.heic':
    'Le foto HEIC dell’iPhone non sono ancora supportate. Prima converti la foto in JPEG.',
  'images.err.pdf':
    'Questa schermata legge una singola immagine, non un PDF. Per un PDF scansionato, usa «Rendi ' +
    'ricercabile (OCR)» in Documenti.',
  'images.err.pdfAction': 'Vai a Documenti',
  'images.err.decodeFailed':
    'Non è stato possibile aprire questa immagine. Potrebbe essere danneggiata o in un formato ' +
    'non supportato.',
  'images.err.multiDrop': 'Trascina un’immagine alla volta.',
  'images.err.runtimeFailed':
    'Non è stato possibile avviare il modello per le immagini. Riprova oppure scegli un altro ' +
    'modello.',
  'images.err.engineCannotRun':
    'Il motore IA non può funzionare su questo computer. La schermata Modello IA indica cosa ' +
    'manca.',
  'images.err.emptyResponse':
    'Per questa immagine non è arrivata nessuna risposta. Prova a riformulare la domanda.',
  'images.err.emptyQuestion': 'Prima scrivi una domanda sull’immagine.',
  'images.err.timedOut':
    'L’operazione richiede troppo tempo. Prova con un’immagine più piccola oppure fai di nuovo ' +
    'la domanda.',
  'images.err.contextExceeded':
    'Questa conversazione è diventata troppo lunga per questa immagine. Fai una domanda più ' +
    'breve oppure avvia una nuova analisi.',
  'images.err.busy': 'Elaborazione della domanda precedente…',
  'images.err.openFailed': 'Non è stato possibile aprire questa analisi. Riprova.',
  'images.err.deleteFailed': 'Non è stato possibile eliminare questa analisi. Riprova.',
  'images.err.clearFailed': 'Non è stato possibile cancellare la cronologia. Riprova.',
  'images.history.title': 'Cronologia',
  'images.history.empty': 'Qui compariranno le immagini che analizzi.',
  'images.history.running': 'Analisi in corso…',
  'images.history.runningOpen': 'Mostra l’analisi in corso',
  'images.history.turns.one': '{count} domanda',
  'images.history.turns.many': '{count} di domande',
  'images.history.turns.other': '{count} domande',
  'images.history.delete': 'Elimina',
  'images.history.deleteAria': 'Elimina «{title}»',
  'images.history.deleted': 'Rimossa dalla cronologia',
  'images.history.delete.title': 'Vuoi eliminare questa immagine?',
  'images.history.delete.confirm': 'Elimina',
  'images.history.delete.body':
    'L’immagine «{title}» e le relative risposte verranno rimosse definitivamente da questa ' +
    'unità.',
  'images.history.total': 'Totale: {size}',
  'images.history.clear': 'Cancella la cronologia',
  'images.history.clear.title': 'Vuoi cancellare la cronologia delle immagini?',
  'images.history.clear.confirm': 'Cancella la cronologia',
  'images.history.clear.body':
    'Tutte le analisi salvate ({size}) e le relative immagini verranno rimosse definitivamente ' +
    'da questa unità.',
  'images.history.cleared': 'Cronologia delle immagini cancellata',
  // ---- Translate screen (TranslateGemma wave, plan §2 D6, TG-4) ----
  'translate.title': 'Traduci un testo',
  'translate.lead':
    'Scrivi o incolla un testo, scegli le lingue e traducilo in locale. Nulla esce da questa ' +
    'unità.',
  'translate.starting': 'Preparazione del modello di traduzione…',
  'translate.avail.noModel': 'Per tradurre serve il modello di traduzione su questa unità.',
  'translate.avail.hint':
    'Scaricalo una volta nella schermata Modello IA: da quel momento la traduzione funziona ' +
    'completamente offline.',
  'translate.avail.cta': 'Vai a Modello IA',
  'translate.from': 'Da',
  'translate.to': 'A',
  'translate.swap': 'Inverti le lingue',
  'translate.input.label': 'Testo da tradurre',
  'translate.input.placeholder': 'Scrivi o incolla il testo da tradurre…',
  'translate.action': 'Traduci',
  'translate.stop': 'Interrompi',
  'translate.output.label': 'Traduzione',
  'translate.output.empty': 'La traduzione apparirà qui.',
  'translate.working': 'Traduzione in corso…',
  'translate.copy': 'Copia',
  'translate.copied': 'Copiato',
  'translate.device.gpu':
    'La traduzione funziona sulla scheda grafica (GPU, livelli: {done}/{total})',
  'translate.device.gpuUnknown': 'La traduzione funziona sulla scheda grafica (GPU)',
  'translate.device.gpuPartial':
    'La traduzione funziona solo in parte sulla scheda grafica (livelli: {done}/{total}): la ' +
    'memoria grafica era quasi tutta occupata, di solito dal modello di chat, quindi la velocità ' +
    'è più o meno quella del processore',
  'translate.device.gpuNone':
    'La traduzione funziona sul processore: la memoria grafica era completamente occupata, di ' +
    'solito dal modello di chat, quindi nessun livello ha trovato posto sulla scheda grafica ' +
    '(livelli: 0/{total})',
  'translate.device.cpu': 'La traduzione funziona sul processore (CPU)',
  'translate.device.cpuBesideChat':
    'La traduzione funziona sul processore: il modello di chat sta usando la memoria grafica e ' +
    'non resta spazio per la traduzione',
  'translate.device.cpuChatStarting':
    'La traduzione funziona sul processore: si stava avviando un modello di chat, e il modello ' +
    'di chat ha la precedenza sulla scheda grafica',
  'translate.device.cpuTooLarge':
    'La traduzione funziona sul processore: il modello di traduzione non entra nella memoria di ' +
    'questa scheda grafica',
  'translate.device.title':
    'Dove ha funzionato il modello di traduzione al suo ultimo avvio. La scelta viene rifatta a ' +
    'ogni avvio (il modello libera la memoria circa 2 minuti dopo l’ultima traduzione).',
  'translate.device.partialTitle':
    'Per lasciare al modello di traduzione più spazio sulla scheda: usa un modello di chat più ' +
    'piccolo oppure arresta il modello di chat prima di tradurre. Al prossimo avvio (circa 2 ' +
    'minuti dopo l’ultima traduzione) il modello di traduzione si adatta di nuovo allo spazio ' +
    'disponibile.',
  'translate.device.gpuNoneTitle':
    'Perché il modello di traduzione possa usare la scheda grafica: usa un modello di chat più ' +
    'piccolo oppure arresta il modello di chat prima di tradurre. Al prossimo avvio (circa 2 ' +
    'minuti dopo l’ultima traduzione) il modello di traduzione si adatta di nuovo allo spazio ' +
    'disponibile.',
  'translate.err.noModel':
    'Il modello di traduzione non è più disponibile. Apri la schermata Modello IA per ' +
    'installarlo.',
  'translate.err.badRequest':
    'Scegli una lingua di partenza e una lingua di arrivo e inserisci un testo da tradurre.',
  'translate.err.busy': 'È già in corso una traduzione. Attendi che finisca, poi riprova.',
  'translate.err.docTaskBusy':
    'È in corso un’attività sui documenti. Attendi che finisca, poi traduci.',
  'translate.err.runtimeFailed':
    'Non è stato possibile completare la traduzione. Riprova oppure prova con un testo più breve.',
  'translate.err.startFailed':
    'Non è stato possibile avviare il modello di traduzione: sul dispositivo potrebbe esserci ' +
    'poca memoria libera. Chiudi le altre app o riavvia HilbertRaum, poi riprova.',
  'translate.err.engineCannotRun':
    'Il motore IA non può funzionare su questo computer. La schermata Modello IA indica cosa ' +
    'manca.',
  'translate.err.empty': 'Non è arrivata nessuna traduzione. Riprova oppure riformula il testo.',
  'translate.err.sameLang': 'Scegli due lingue diverse.',
  'translate.err.tooLong':
    'Il testo è troppo lungo per tradurlo qui (oltre 200.000 caratteri). Dividilo in parti più ' +
    'piccole oppure salvalo come file e traducilo come documento.',
  // ---- Document drag-and-drop translation (TG-5, plan §2 D7) ----
  'translate.drop.title': 'Oppure trascina qui un documento da tradurre',
  'translate.drop.choose': 'oppure scegli un documento',
  'translate.drop.types': 'PDF, Word, Markdown o testo, tradotti nella lingua scelta.',
  'translate.file.importing': 'Lettura del documento…',
  'translate.file.progress': 'Traduzione in corso… ({done}/{total})',
  'translate.file.preparing': 'Preparazione della traduzione: lettura del documento…',
  'translate.file.saving': 'Salvataggio del documento tradotto…',
  'translate.file.truncated':
    'Viene mostrato l’inizio della traduzione: per il documento completo, esportala o aprila in ' +
    'Documenti.',
  'translate.file.export': 'Esporta…',
  'translate.file.exported': 'Documento esportato',
  'translate.file.show': 'Mostra in Documenti',
  'translate.file.reset': 'Traduci un altro documento',
  'translate.file.doneAnnounce':
    'Traduzione del documento completata. Il risultato è ora visibile.',
  'translate.file.gapPages.one':
    '⚠ La pagina {pages} dell’originale non è stata tradotta: non contiene testo leggibile ' +
    '(potrebbe essere una pagina scansionata). Nel risultato la lacuna è segnalata.',
  'translate.file.gapPages.many':
    '⚠ Le pagine {pages} dell’originale non sono state tradotte: non contengono testo leggibile ' +
    '(potrebbero essere pagine scansionate). Nel risultato ogni lacuna è segnalata.',
  'translate.file.gapPages.other':
    '⚠ Le pagine {pages} dell’originale non sono state tradotte: non contengono testo leggibile ' +
    '(potrebbero essere pagine scansionate). Nel risultato ogni lacuna è segnalata.',
  'translate.file.failedParts.one':
    '⚠ {count} parte non è stata tradotta: il risultato conserva il testo originale e lo segnala.',
  'translate.file.failedParts.many':
    '⚠ {count} di parti non sono state tradotte: il risultato conserva il testo originale nei ' +
    'punti segnalati.',
  'translate.file.failedParts.other':
    '⚠ {count} parti non sono state tradotte: il risultato conserva il testo originale nei punti ' +
    'segnalati.',
  'translate.file.err.multiDrop': 'Trascina un documento alla volta.',
  'translate.file.err.noPath':
    'Questo elemento non corrisponde a un file su un’unità. Trascina un documento da una ' +
    'cartella oppure usa «scegli un documento».',
  'translate.file.err.unsupported':
    'Questo tipo di file non può essere tradotto. Prova con un file PDF, Word, Markdown o di ' +
    'testo.',
  'translate.file.err.scanned':
    'Questo PDF sembra una scansione senza testo leggibile. Prima rendilo ricercabile in ' +
    'Documenti con «Rendi ricercabile (OCR)», poi traducilo.',
  'translate.file.err.scannedAction': 'Vai a Documenti',
  'translate.file.err.importFailed': 'Non è stato possibile leggere il documento. Riprova.',
  'translate.file.err.runtimeFailed': 'Non è stato possibile tradurre il documento. Riprova.',
  // ---- Evidence review (EP-1 plan §7 — ReviewScreen.tsx + chat entry points) ----
  'review.action.start': 'Verifica i riscontri',
  'review.action.continue': 'Continua la verifica',
  'review.entry.sources': 'Verifica la risposta e le fonti',
  'review.status.draft': 'Bozza',
  'review.status.ready': 'Conclusa',
  'review.status.outdated': 'Non aggiornata',
  'review.readonlyHint': 'Verifica conclusa: per modificarla, riapri la verifica.',
  // ---- P4: Outdated banner + acknowledge (spec §15.5/§21.3/§28.6) ----
  'review.outdated.title': 'Questa verifica non è aggiornata.',
  'review.outdated.answerChanged':
    'Il testo della risposta non corrisponde più a quello salvato nella verifica.',
  'review.outdated.coverageChanged':
    'I metadati di copertura registrati non corrispondono più a quelli salvati nella verifica.',
  'review.outdated.sourcesChanged.one':
    '{count} documento di origine è cambiato da quando è stata avviata questa verifica.',
  'review.outdated.sourcesChanged.many':
    '{count} di documenti di origine sono cambiati da quando è stata avviata questa verifica.',
  'review.outdated.sourcesChanged.other':
    '{count} documenti di origine sono cambiati da quando è stata avviata questa verifica.',
  'review.outdated.keepNote':
    'Le decisioni che hai registrato restano invariate. Puoi conservare la verifica come traccia ' +
    'storica, prendere atto della modifica oppure fare di nuovo la domanda in chat e avviare una ' +
    'nuova verifica.',
  'review.outdated.acknowledge': 'Prendi atto della modifica',
  'review.outdated.acknowledgedAt': 'Presa d’atto della modifica: {date}.',
  'review.outdated.exportHint':
    'Prendi atto della modifica prima di esportare un pacchetto di riscontri.',
  'review.back': 'Torna alla chat',
  'review.rename': 'Rinomina',
  'review.rename.label': 'Titolo della verifica',
  'review.rename.save': 'Salva',
  'review.loading': 'Caricamento della verifica…',
  'review.notFound':
    'Non è stato possibile trovare questa verifica. Potrebbe essere stata eliminata.',
  'review.question.toggle': 'Domanda',
  'review.answerPane.aria': 'Risposta in verifica',
  'review.autosave.saving': 'Salvataggio in corso…',
  'review.autosave.saved': 'Salvato',
  'review.autosave.error': 'Non è stato ancora possibile salvare alcune modifiche.',
  'review.autosave.retry': 'Riprova',
  'review.evidence.title': 'Riscontri',
  'review.evidence.captionRelevance':
    'Le fonti mostrate sono gli estratti forniti al modello IA locale per questa risposta.',
  'review.evidence.captionWholeDoc':
    'Questa risposta è stata ricavata da un’analisi dell’intero documento. Le sezioni mostrate ' +
    'ne indicano la provenienza: nessun riferimento alle fonti per singola frase.',
  'review.evidence.captionStructured':
    'Per questa risposta sono stati usati dati estratti in locale. Qui sotto sono mostrati i ' +
    'brani delle fonti da cui sono stati estratti.',
  'review.evidence.none':
    'Per questa risposta non sono stati salvati estratti delle fonti. Puoi registrare una ' +
    'verifica generale, ma una verifica a livello delle singole fonti non è disponibile.',
  'review.disclaimer':
    'Un riferimento alla fonte mostra da dove proviene un’informazione. Da solo non dimostra che ' +
    'la risposta sia corretta.',
  'review.evidence.filterLabel': 'Filtra le fonti',
  'review.evidence.filterPlaceholder': 'Filtra per titolo o testo…',
  'review.evidence.filterClear': 'Cancella il filtro',
  'review.evidence.filterNone': 'Nessuna fonte corrisponde al filtro.',
  'review.evidence.shownCount': 'Fonti mostrate: {shown} su {total}',
  'review.evidence.more.one': 'e {count} fonte in più',
  'review.evidence.more.many': 'e {count} di fonti in più',
  'review.evidence.more.other': 'e {count} fonti in più',
  'review.evidence.linkingItem': 'Collegamento dei riscontri al punto di verifica {n}',
  'review.source.kind.direct_excerpt': 'Estratto diretto',
  'review.source.kind.whole_document_provenance': 'Provenienza da un’analisi dell’intero documento',
  'review.source.kind.structured_record': 'Dati estratti',
  'review.source.unresolved': 'Non è stato possibile determinare l’identità della fonte',
  'review.source.archive':
    'Articolo di un pacchetto di conoscenze: non è possibile verificarne identità e contenuto ' +
    'rispetto all’area di lavoro',
  'review.source.missingAtCreation':
    'La fonte non era disponibile quando è stata avviata questa verifica',
  'review.source.changed':
    'Il documento di origine è cambiato da quando è stata avviata questa verifica',
  'review.source.missingNow':
    'Questa fonte non è più presente nell’area di lavoro. L’estratto salvato resta in questa ' +
    'verifica.',
  'review.source.cannotVerify': 'Non è possibile verificare lo stato attuale di questa fonte',
  'review.sourceContext.open': 'Apri la fonte nel contesto',
  'review.sourceContext.title': 'Fonte nel contesto',
  'review.sourceContext.loading': 'Caricamento del testo memorizzato…',
  'review.sourceContext.failed':
    'Non è stato possibile caricare il testo memorizzato di questa fonte.',
  'review.sourceContext.hashMatch':
    'L’hash memorizzato del documento corrisponde a quello salvato nella verifica.',
  'review.sourceContext.hashMismatch':
    'Il documento di origine è cambiato da quando è stata avviata questa verifica.',
  'review.sourceContext.hashUnknown':
    'Non è possibile verificare lo stato attuale del documento rispetto a quello salvato nella ' +
    'verifica.',
  'review.sourceContext.missing':
    'Questa fonte era disponibile quando è stata generata la risposta, ma non è più presente ' +
    'nell’area di lavoro. L’estratto salvato resta in questa verifica, se disponibile.',
  'review.sourceContext.notLocated':
    'Non è stato possibile trovare l’estratto salvato nel testo memorizzato attuale. Qui sotto è ' +
    'mostrato come è stato registrato all’avvio della verifica.',
  'review.sourceContext.storedNote':
    'Il contesto proviene dal testo estratto e memorizzato durante l’importazione: il file di ' +
    'origine non viene aperto.',
  'review.sourceContext.excerptHeading': 'Estratto salvato',
  'review.link.add': 'Collega al punto di verifica',
  'review.link.remove': 'Rimuovi il collegamento',
  'review.link.cited': 'Indicato come fonte nella risposta',
  'review.link.reviewer': 'Collegato in verifica',
  'review.link.selectHint':
    'Seleziona un punto di verifica per collegare o scollegare i riscontri.',
  'review.relation.label': 'Relazione',
  'review.relation.none': 'Nessuna indicazione',
  'review.relation.supports': 'A sostegno',
  'review.relation.qualifies': 'Con limitazioni',
  'review.relation.contradicts': 'In contrasto',
  'review.relation.context': 'Solo contesto',
  'review.item.aria': 'Punto di verifica {n}',
  'review.item.noMarker': 'Nessun riferimento diretto alla fonte in questo testo',
  'review.item.wholeDocDerived': 'Ricavato da un’analisi dell’intero documento',
  'review.item.noteLabel': 'Nota',
  'review.item.notePlaceholder': 'Aggiungi una nota (opzionale)',
  'review.item.viewEvidence': 'Mostra i riscontri',
  // ---- P5 reviewer text selections (spec §12.1 "Review separately"; plan §10) ----
  'review.selection.start': 'Verifica un brano separatamente',
  'review.selection.hint':
    'Seleziona il brano nel testo originale qui sotto (mostrato senza formattazione), poi scegli ' +
    '«Verifica separatamente».',
  'review.selection.surfaceAria': 'Testo originale del punto di verifica {n}',
  'review.selection.add': 'Verifica separatamente',
  'review.selection.close': 'Fine',
  'review.selection.added': 'Brano aggiunto come punto di verifica a sé.',
  'review.selection.refused':
    'Non è stato possibile aggiungere questa selezione. Seleziona di nuovo il brano e riprova.',
  'review.item.selectionTag': 'Testo selezionato in verifica',
  'review.selection.remove': 'Rimuovi la selezione',
  'review.decision.groupAria': 'Decisione',
  'review.decision.supported': 'Verificato – con riscontro',
  'review.decision.partly_supported': 'Verificato – con riscontro parziale',
  'review.decision.not_supported': 'Verificato – senza riscontro',
  'review.decision.follow_up': 'Da approfondire',
  'review.decision.not_reviewed': 'Non verificato',
  'review.decision.not_applicable': 'Non applicabile',
  'review.bulk.menu': 'Azioni in blocco',
  'review.bulk.headingsNa': 'Segna i titoli come «Non applicabile»',
  'review.bulk.followUp': 'Segna i punti senza decisione come «Da approfondire»',
  'review.bulk.clear': 'Azzera tutte le decisioni',
  'review.bulk.clearConfirmTitle': 'Vuoi azzerare tutte le decisioni?',
  'review.bulk.clearConfirmBody':
    'Ogni decisione di questa verifica torna a «Non verificato». Le note vengono mantenute.',
  'review.bulk.clearConfirm': 'Azzera le decisioni',
  'review.progress': 'Decisioni prese: {decided} su {required}',
  'review.progress.followUps.one': '{count} punto da approfondire',
  'review.progress.followUps.many': '{count} di punti da approfondire',
  'review.progress.followUps.other': '{count} punti da approfondire',
  'review.footer.summary': 'Riepilogo della verifica',
  'review.summary.status': 'Stato',
  'review.summary.decisions': 'Decisioni',
  'review.summary.sources': 'Fonti',
  'review.summary.sourcesCount.one': '{count} fonte',
  'review.summary.sourcesCount.many': '{count} di fonti',
  'review.summary.sourcesCount.other': '{count} fonti',
  'review.summary.sourcesUnresolved.one':
    '{count} fonte di cui non è stato possibile determinare l’identità',
  'review.summary.sourcesUnresolved.many':
    '{count} di fonti di cui non è stato possibile determinare l’identità',
  'review.summary.sourcesUnresolved.other':
    '{count} fonti di cui non è stato possibile determinare l’identità',
  'review.summary.sourcesArchive.one':
    '{count} fonte è un articolo di un pacchetto di conoscenze e non può essere verificata ' +
    'rispetto all’area di lavoro',
  'review.summary.sourcesArchive.many':
    '{count} di fonti sono articoli di pacchetti di conoscenze e non possono essere verificate ' +
    'rispetto all’area di lavoro',
  'review.summary.sourcesArchive.other':
    '{count} fonti sono articoli di pacchetti di conoscenze e non possono essere verificate ' +
    'rispetto all’area di lavoro',
  'review.summary.sourcesMissing.one':
    '{count} fonte non era disponibile quando è stata avviata questa verifica',
  'review.summary.sourcesMissing.many':
    '{count} di fonti non erano disponibili quando è stata avviata questa verifica',
  'review.summary.sourcesMissing.other':
    '{count} fonti non erano disponibili quando è stata avviata questa verifica',
  'review.summary.sourcesChangedNow.one':
    '{count} documento di origine è cambiato da quando è stata avviata questa verifica',
  'review.summary.sourcesChangedNow.many':
    '{count} di documenti di origine sono cambiati da quando è stata avviata questa verifica',
  'review.summary.sourcesChangedNow.other':
    '{count} documenti di origine sono cambiati da quando è stata avviata questa verifica',
  'review.summary.sourcesMissingNow.one':
    '{count} documento di origine non è più presente nell’area di lavoro',
  'review.summary.sourcesMissingNow.many':
    '{count} di documenti di origine non sono più presenti nell’area di lavoro',
  'review.summary.sourcesMissingNow.other':
    '{count} documenti di origine non sono più presenti nell’area di lavoro',
  'review.summary.truncated':
    'La risposta generata potrebbe essere incompleta: è stata troncata al limite di lunghezza ' +
    'delle risposte del modello.',
  'review.summary.stopped.model':
    'La risposta generata è incompleta: il modello IA è stato arrestato o cambiato prima che ' +
    'fosse completa.',
  'review.summary.stopped.user':
    'La risposta generata è incompleta: è stata interrotta prima che fosse completa.',
  'review.summary.stopped.lock':
    'La risposta generata è incompleta: l’area di lavoro è stata bloccata o l’app è stata chiusa ' +
    'prima che fosse completa.',
  'review.summary.generation': 'Dettagli della generazione',
  'review.summary.model': 'Modello',
  'review.summary.generatedAt': 'Data di generazione',
  'review.summary.appVersion': 'Versione dell’app',
  'review.summary.skill': 'Skill',
  'review.summary.unavailable': 'Dato non disponibile',
  'review.summary.reviewerLabel': 'Persona che verifica',
  'review.summary.reviewerPlaceholder': 'Il tuo nome o una sigla (opzionale)',
  'review.summary.generalNote': 'Nota generale',
  'review.summary.generalNotePlaceholder': 'Osservazioni generali (opzionale)',
  'review.summary.exports': 'Cronologia delle esportazioni',
  'review.summary.markReady': 'Concludi la verifica',
  'review.summary.reopen': 'Riapri la verifica',
  'review.summary.gateHint':
    'Ogni blocco della risposta richiede una decisione prima che la verifica possa essere ' +
    'conclusa (decisioni prese: {decided} su {required}). Anche «Non applicabile» conta come ' +
    'decisione.',
  'review.toast.ready': 'Verifica conclusa.',
  'review.completedAt': 'Data di conclusione: {date}',
  'review.deleteWithConversation.one':
    'Verrà eliminata anche {count} verifica dei riscontri collegata a questa conversazione.',
  'review.deleteWithConversation.many':
    'Verranno eliminate anche {count} di verifiche dei riscontri collegate a questa ' +
    'conversazione.',
  'review.deleteWithConversation.other':
    'Verranno eliminate anche {count} verifiche dei riscontri collegate a questa conversazione.',
  'review.deleteWithConversation.unknown':
    'Verranno eliminate anche le eventuali verifiche dei riscontri collegate a questa ' +
    'conversazione.',
  // ---- Evidence-pack export (EP-1 plan §8 — summary panel + status line) ----
  'review.status.lastExported': 'Ultima esportazione: {date}',
  'review.export.action': 'Crea il pacchetto di riscontri',
  'review.export.title': 'Esporta il pacchetto di riscontri',
  'review.export.encryptionWarning':
    'Questo file esportato viene salvato fuori dall’area di lavoro crittografata di HilbertRaum ' +
    'e non è protetto dalla password della tua area di lavoro.',
  'review.export.packLanguage.en': 'Questo pacchetto sarà redatto in inglese.',
  'review.export.packLanguage.de': 'Questo pacchetto sarà redatto in tedesco.',
  'review.export.options': 'Includi nel pacchetto',
  'review.export.optNotes': 'Note di verifica',
  'review.export.optExcerpts': 'Estratti delle fonti',
  'review.export.optHashes': 'Hash dei documenti',
  'review.export.optUnreviewed': 'Punti non verificati',
  'review.export.optTechnical': 'Dettagli tecnici',
  'review.export.format': 'Formato del file',
  'review.export.formatHtml': 'HTML – pagina web autonoma',
  'review.export.formatPdf': 'PDF – pronto per la stampa (A4)',
  'review.export.confirm': 'Esporta il pacchetto…',
  'review.export.cancel': 'Chiudi',
  'review.export.done': 'Pacchetto di riscontri esportato.',
  'review.export.error':
    'Non è stato possibile esportare il pacchetto di riscontri. Non è stato scritto nessun file.',
  'review.export.copyHash': 'Copia SHA-256',
  'review.export.hashCopied': 'SHA-256 copiato negli Appunti.'
}
