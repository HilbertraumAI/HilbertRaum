import type { UiCatalog } from './languages'

// The DUTCH catalog (interface only). Typed `UiCatalog<'nl'>`: a missing, stale or extra key
// is a typecheck failure. `packExport.*` is not part of it (evidence packs stay en/de).
// One catalog for the Netherlands and Flanders (`nl-BE` resolves here): standard Dutch.
//
// Style (design-guidelines §7 "Dutch microcopy"): informal «je», lower case (jij/jou/jouw only
// for contrast; never u, uw, jullie). Buttons and menu items are infinitives with the object in
// front (Opslaan, Documenten importeren); a go-to button is «Naar <screen>»; instructions in a
// sentence are imperatives (Kies, Probeer). The copy ADAPTS the calm spec-§11.4 tone. Quotes
// “…” (U+201C/U+201D) without nesting, apostrophe ’ (PDF’s, foto’s), ellipsis …, en dash « – »
// (never the em dash), no exclamation mark, no no-break space. Compounds are one word or take a
// hyphen (AI-model, offlinemodus). Nothing is glued to a placeholder. "HilbertRaum" is never
// translated. In this comment «…» only marks Dutch examples; it never appears in a value.
//
// Glossary — keep terms consistent across ALL Dutch copy:
//   workspace                  → werkruimte (de)
//   drive / disk               → schijf (de) — never station, stick, drive, apparaat
//   vault / encrypted workspace→ versleutelde werkruimte
//   model                      → model (het) (AI model → AI-model, never KI)
//   document                   → document (het); file → bestand (het)
//   re-index                   → opnieuw indexeren
//   offline                    → offline (Offline Mode → Offlinemodus)
//   "Ask my documents"         → «Vragen aan mijn documenten»
//   lock / unlock              → vergrendelen / ontgrendelen
//   password                   → wachtwoord (het) — never paswoord
//   settings                   → Instellingen
//   plaintext (developer) mode → onversleuteld (ontwikkelaars)
//   delete, remove / clear / cancel → verwijderen / wissen / annuleren
//   chat / conversation        → chat (de) / gesprek (het)
//   skill / token / knowledge pack → skill (de) / token (het) / kennispakket (het)
//   check, verify (outside Review) → controleren
//
// Evidence-review glossary (MIRROR of the canonical record in design-guidelines §7; change BOTH
// together):
//   evidence                   → onderbouwing (de) — the noun «bewijs» is banned
//   review (the artifact)      → beoordeling (evidence review → beoordeling van de
//                                onderbouwing)
//   review item                → beoordelingspunt (numbered: «Punt {n} van {total}»)
//   evidence pack              → onderbouwingspakket (never «dossier»)
//   citation / source marker   → bronverwijzing (never «citaat», «bronvermelding»)
//   whole-document provenance  → herkomst uit een analyse van het hele document; the negation
//                                is always «geen bronverwijzingen per zin»
//   direct excerpt             → direct fragment
//   source / source document   → bron / brondocument
//   reviewer                   → Beoordelaar (label) / wie beoordeelt (prose); never a
//                                third-person pronoun
//   mark ready / reopen        → Beoordeling afronden / Beoordeling heropenen
//   outdated                   → verouderd
//   review creation            → the review is «aangemaakt», the ANSWER is «gegenereerd» —
//                                never mixed
//   supported-ness             → «onderbouwd / deels onderbouwd / niet onderbouwd»;
//                                «bewijzen» only in negated disclaimers

export const nl: UiCatalog<'nl'> = {
  // ---- App shell (App.tsx) ----
  'nav.aria': 'Hoofdnavigatie',
  'nav.home': 'Start',
  'nav.chat': 'Chat',
  'nav.documents': 'Documenten',
  'nav.translate': 'Vertalen',
  'nav.images': 'Afbeeldingen',
  'nav.models': 'AI-model',
  'nav.performance': 'Prestaties',
  'nav.settings': 'Instellingen',
  'app.lockNow': 'Vergrendelen',
  'app.lockNowTitle': 'De werkruimte opnieuw versleutelen en vergrendelen',
  'app.noticeDetails': 'Details',
  'app.noticeGoToModels': 'Naar AI-model',
  'app.fatal.title': 'De app kon niet starten',
  'app.fatal.hintBefore':
    'De lokale backend is niet gestart, dus er kan niets worden geladen. Start de app opnieuw; ' +
    'blijft dit gebeuren, controleer dan ',
  'app.fatal.hintAfter': ' op je schijf en lees docs/troubleshooting.md.',
  'app.loadingWorkspace': 'Werkruimte laden…',
  'app.loadingScreen': 'Laden…',
  // ---- Error boundary (ErrorBoundary.tsx — audit FE-1) ----
  'errorBoundary.title': 'Er ging iets mis op dit scherm',
  'errorBoundary.body':
    'Er ging iets onverwachts mis op dit scherm. Je werk en je gegevens zijn veilig: er is niets ' +
    'verloren gegaan. Probeer het opnieuw of ga terug naar Start.',
  'errorBoundary.retry': 'Opnieuw proberen',
  'errorBoundary.home': 'Naar Start',
  'errorBoundary.app.title': 'Er ging iets mis in de app',
  'errorBoundary.app.body':
    'Er is iets onverwachts gebeurd. Je gegevens op de schijf zijn veilig. Laad de app opnieuw ' +
    'om verder te gaan.',
  'errorBoundary.app.reload': 'Opnieuw laden',
  // ---- Home (HomeScreen.tsx) ----
  'home.headline.ready': 'Klaar om te chatten.',
  'home.headline.starting': 'Voorbereiden…',
  'home.headline.almost': 'Bijna ingesteld.',
  'home.lead':
    'Een offline privéwerkruimte voor AI. Je vragen, documenten en chatgeschiedenis blijven op ' +
    'dit apparaat.',
  'home.preflight.continue':
    'Je kunt toch doorgaan. Gaat de app niet open, lees dan de handleiding voor ' +
    'probleemoplossing in de map {folder} op de schijf.',
  'home.moved.restored':
    'Deze schijf is het laatst op een andere computer gebruikt. De meetwaarden voor deze ' +
    'computer komen uit een eerdere controle op {when}: er is zojuist niets gemeten.',
  'home.moved.restoredUndated':
    'Deze schijf is het laatst op een andere computer gebruikt. De meetwaarden voor deze ' +
    'computer komen uit een eerdere controle: er is zojuist niets gemeten.',
  'home.moved.measuring':
    'Deze schijf is nog niet eerder op deze computer gebruikt. Er loopt een controle op de ' +
    'achtergrond; het scherm Prestaties toont de meetwaarden zodra de controle klaar is.',
  'home.moved.owed':
    'Deze schijf is op deze computer nog niet gecontroleerd, dus er zijn nog geen meetwaarden.',
  'home.checking': 'Controleren…',
  'home.workspace.label': 'Werkruimte',
  'home.workspace.encrypted': 'Versleuteld – vergrendeld met je wachtwoord als de app gesloten is',
  'home.workspace.plaintext': 'Onversleuteld (ontwikkelaarsmodus)',
  'home.workspace.badgeProtected': 'Beschermd',
  'home.workspace.badgeDeveloper': 'Ontwikkelaar',
  'home.model.label': 'AI-model',
  'home.model.fallbackName': 'Je model',
  'home.model.running': '{model} draait op dit apparaat',
  'home.model.selected': '{model} is geselecteerd en wordt mogelijk nog geladen',
  'home.model.none': 'Nog geen model geselecteerd',
  'home.model.badgeRunning': 'Draait',
  'home.model.badgeStarting': 'Opstarten',
  'home.model.badgeNeedsModel': 'Model nodig',
  'home.model.open': 'Naar AI-model',
  'home.model.engineCannotRun':
    'De AI-engine kan op deze computer niet draaien: de antwoorden worden gesimuleerd',
  'home.model.badgeEngine': 'Draait niet',
  'home.model.demo': '{model} draait in demomodus: de antwoorden worden gesimuleerd',
  'home.model.badgeDemo': 'Demomodus',
  'home.model.choose': 'Model kiezen',
  'home.docs.label': 'Documenten',
  'home.docs.none': 'Nog geen documenten: voeg documenten toe om er vragen over te stellen',
  'home.docsReady.one': '{count} document klaar voor je vragen',
  'home.docsReady.other': '{count} documenten klaar voor je vragen',
  'home.docs.badgeReady': 'Klaar',
  'home.docs.badgeNone': 'Nog geen',
  'home.docs.add': 'Documenten toevoegen',
  'home.packs.label': 'Kennispakketten',
  'home.packsReady.one': '{count} kennispakket klaar voor je vragen',
  'home.packsReady.other': '{count} kennispakketten klaar voor je vragen',
  'home.packs.none':
    'Nog geen kennispakketten: voeg een offline Wikipedia toe om algemene vragen te stellen',
  'home.packs.noneReady':
    'Er is geen kennispakket klaar voor je vragen: controleer de pakketten in Documenten',
  'home.packs.badgeNoneReady': 'Niet klaar',
  'home.packs.add': 'Kennispakketten toevoegen',
  'home.packs.open': 'Kennispakketten openen',
  'home.actions.startChat': 'Chat starten',
  'home.actions.askDocs': 'Vragen aan mijn documenten',
  // ---- Chat (ChatScreen.tsx) ----
  'chat.title': 'Chat',
  'chat.noModel.title': 'Er draait geen model',
  'chat.noModel.startingTitle': 'Het AI-model wordt gestart',
  'chat.noModel.hintBefore':
    'Voor chatten en vragen over documenten is een geladen model nodig. Ga naar het scherm ' +
    'AI-model, kies een gedownload model en klik op ',
  'chat.noModel.hintAction': 'Dit model gebruiken',
  'chat.noModel.hintAfter':
    '. Alles blijft lokaal: er wordt niets gedownload of via internet verstuurd.',
  'chat.noModel.stillLoading':
    'Als je de app net hebt geopend, wordt je geselecteerde model misschien nog geladen. Dit ' +
    'scherm gaat automatisch verder zodra het model klaar is.',
  'chat.noModel.starting':
    'Je model wordt gestart: grote modellen hebben wat tijd nodig om te laden. Dit scherm gaat ' +
    'automatisch verder zodra het model klaar is.',
  'chat.noModel.startingProgress':
    'Je model wordt gestart: het modelbestand ({gb}\u00A0GB) wordt gelezen, tot nu toe ongeveer ' +
    '{pct}%. Dit scherm gaat automatisch verder zodra het model klaar is.',
  'chat.noModel.open': 'Naar AI-model',
  'chat.noModel.recheck': 'Opnieuw controleren',
  'chat.empty.title': 'Stel een vraag, of vraag iets over je documenten.',
  'chat.empty.lineDocuments': 'Antwoorden komen uit je documenten en hebben bronverwijzingen.',
  'chat.empty.lineChat':
    'Antwoorden komen direct van het model op deze schijf: niets verlaat dit apparaat.',
  'chat.empty.fillTitle': 'In het berichtvak zetten',
  'chat.empty.addDocs': 'Documenten toevoegen om er vragen over te stellen',
  'chat.exampleChat.explain': 'Leg een begrip in eenvoudige woorden uit',
  'chat.exampleChat.draftEmail': 'Help me een beleefde e-mail te schrijven',
  'chat.exampleChat.brainstorm': 'Bedenk ideeën voor een project',
  'chat.example.summarize': 'Vat dit document samen',
  'chat.example.paymentTerms': 'Wat zijn de betalingsvoorwaarden?',
  'chat.example.indemnity': 'Zoek elke vermelding van “vrijwaring”',
  'chat.modeAria': 'Chatmodus',
  'chat.mode.chat': 'Chat',
  'chat.mode.documents': 'Vragen aan mijn documenten',
  'chat.listShow': 'Gesprekkenlijst tonen',
  'chat.runtime.gpu': '{model} · GPU ({name})',
  'chat.runtime.cpu': '{model} · CPU',
  'chat.runtime.cpuCompat': '{model} · CPU (compatibiliteitsmodus)',
  'chat.runtime.demo': '{model} · demomodus',
  'chat.runtime.title':
    'Het AI-model dat in deze chat antwoordt, en of dat model op je grafische kaart (GPU) of op ' +
    'je processor (CPU) draait. Details: Instellingen → Diagnose.',
  'chat.runtime.compatTitle':
    'Voor de stabiliteit staat de compatibiliteitsmodus aan, dus antwoorden worden op de ' +
    'processor gegenereerd en kunnen trager zijn. Onder Instellingen → Diagnose kun je de ' +
    'grafische kaart opnieuw proberen.',
  'chat.convOptions': 'Opties voor het gesprek',
  'chat.saveConversation': 'Dit gesprek opslaan',
  'chat.savedTo': 'Opgeslagen als {path}',
  'chat.copied': 'Gekopieerd',
  'chat.copyFailed': 'Kopiëren naar het klembord is niet gelukt',
  'chat.transcript.label': 'Verloop van het gesprek',
  'chat.stopped': 'Gestopt – het antwoord is mogelijk onvolledig',
  'chat.warmup.hint':
    'Het eerste antwoord duurt wat langer: het model warmt nog op. Latere antwoorden komen ' +
    'sneller.',
  'chat.scopeNotice': 'Antwoorden alleen uit: {titles}',
  'chat.cancelDocTask': 'Documenttaak annuleren',
  'chat.placeholder.documents': 'Vraag iets over je documenten…',
  'chat.placeholder.chat': 'Bericht…',
  'chat.send.ask': 'Vragen',
  'chat.send.send': 'Verzenden',
  'chat.composer.stop': 'Stoppen',
  // ---- Chat: conversation list (ConversationList.tsx) ----
  'chat.list.title': 'Gesprekken',
  'chat.list.aria': 'Gespreksgeschiedenis',
  'chat.list.newChat': '+ Nieuwe chat',
  'chat.list.newDocQa': '+ Nieuwe vragen over documenten',
  'chat.list.hide': 'Gesprekkenlijst verbergen',
  'chat.list.empty': 'Nog geen gesprekken.',
  'chat.list.docMeta': 'Documenten',
  'chat.list.otherGroup': 'Overig / Bibliotheek',
  'chat.list.rowOptionsAria': 'Opties voor het gesprek “{title}”',
  'chat.search.placeholder': 'Gesprekken doorzoeken…',
  'chat.search.aria': 'Gesprekken doorzoeken',
  'chat.search.resultsAria': 'Zoekresultaten',
  'chat.search.resultsFor': 'Resultaten voor “{query}”',
  'chat.search.noMatches': 'Ik heb niets gevonden. Probeer het anders te formuleren.',
  'chat.search.count.one': '{count} resultaat',
  'chat.search.count.other': '{count} resultaten',
  'chat.group.today': 'Vandaag',
  'chat.group.yesterday': 'Gisteren',
  'chat.group.last7days': 'Afgelopen 7 dagen',
  'chat.group.earlier': 'Eerder',
  'chat.delete.menuItem': 'Gesprek verwijderen',
  'chat.delete.title': 'Dit gesprek verwijderen?',
  'chat.delete.confirm': 'Verwijderen',
  'chat.delete.body':
    'Het gesprek “{title}” en de berichten erin worden definitief van deze schijf verwijderd.',
  // ---- Chat: answer depth (DepthMenu.tsx; ids stay fast|balanced|deep) ----
  'chat.depth.trigger': 'Antwoord: {label}',
  'chat.depth.fast': 'Snel',
  'chat.depth.balanced': 'Gebalanceerd',
  'chat.depth.deep': 'Grondig',
  'chat.depth.fastHint': 'Korte, bondige antwoorden',
  'chat.depth.balancedHint': 'De standaard voor elke dag',
  'chat.depth.deepHint': 'Denkt het probleem eerst goed door en antwoordt dan: dat duurt langer',
  // ---- Chat: skill picker + per-message glyph (skills plan §10/§15) ----
  'chat.skill.trigger': 'Skill: {label}',
  'chat.skill.none': 'Geen skill',
  'chat.skill.suggested': 'Voorgesteld: {title} – gebruiken?',
  'chat.skill.suggestedHint': 'Voorgesteld: {title}',
  'chat.skill.used': 'Skill: {title}',
  'chat.skill.usedTitle': 'Dit antwoord is gevormd met de skill “{title}”.',
  'chat.skill.autoFired': 'Beantwoord met {title}',
  'chat.skill.autoFiredTitle':
    'De app heeft de skill “{title}” automatisch op dit antwoord toegepast. Je kunt de vraag ook ' +
    'zonder deze skill laten beantwoorden.',
  'chat.skill.answerWithout': 'Zonder skill antwoorden',
  'chat.skill.answerWithoutBlockedByReview':
    'Bij dit antwoord hoort een beoordeling van de onderbouwing. Opnieuw antwoorden zou de ' +
    'beoordeling met de beslissingen en notities erin verwijderen.',
  'chat.skill.removed': '(verwijderde skill)',
  'chat.skill.offer.lead': 'Dit lijkt een taak voor een skill.',
  'chat.skill.offer.run': '“{title}” voor deze vraag uitvoeren',
  'chat.skill.offer.model': 'Voorgesteld door het lokale model',
  'chat.skill.offer.unavailable':
    'Deze skill is uitgeschakeld of verwijderd. Om de skill uit te voeren, schakel je die in op ' +
    'het tabblad “Skills”.',
  'chat.skill.clear': 'Skill {title} wissen',
  'chat.skill.keep': 'Voor dit gesprek behouden',
  'chat.skill.infoButton': 'Over “{title}”',
  'chat.skill.info.close': 'Deze uitleg verbergen',
  'chat.skill.info.needsLabel': 'Nodig:',
  'chat.skill.info.limitsLabel': 'Goed om te weten:',
  'chat.skill.info.perTurn':
    'Geldt voor je vragen in deze chat tot je de skill wijzigt of wist. “Voor dit gesprek ' +
    'behouden” slaat de skill ook op voor later.',
  'chat.skill.info.learnMore': 'Meer informatie',
  'chat.skill.tool.extractTransactions': 'Transacties extraheren',
  'chat.skill.tool.validateBalances': 'Saldi controleren',
  'chat.skill.tool.categorize': 'Categoriseren',
  'chat.skill.tool.summarize': 'Inkomsten en uitgaven samenvatten',
  'chat.skill.tool.exportCsv': 'CSV exporteren',
  'chat.skill.tool.extractInvoice': 'Factuurgegevens extraheren',
  'chat.skill.tool.validateInvoiceTotals': 'Totalen controleren',
  'chat.skill.tool.exportInvoiceCsv': 'CSV exporteren',
  'chat.skill.tool.exportInvoiceJson': 'JSON exporteren',
  'chat.skill.tool.exportInvoiceXml': 'XML exporteren',
  'chat.skill.tool.redactDocument': 'Persoonsgegevens onleesbaar maken',
  'chat.skill.tool.applyDocumentEdits': 'Tekstwijzigingen toepassen',
  'chat.skill.categorize.breakdownQuestion': 'Splits mijn uitgaven uit per categorie.',
  'chat.skill.summarize.question': 'Vat mijn inkomsten en uitgaven samen.',
  'chat.skill.run.running.one': 'Bezig: {tool} voor {count} document…',
  'chat.skill.run.running.other': 'Bezig: {tool} voor {count} documenten…',
  'chat.skill.run.runningOn': 'Bezig: {tool} voor {document}…',
  'chat.skill.run.chooseDocument': 'Doeldocument kiezen',
  'chat.skill.run.thisDocument': 'dit document',
  'chat.skill.run.cancel': 'Annuleren',
  'chat.skill.run.done.one': '{count} transactie geëxtraheerd.',
  'chat.skill.run.done.other': '{count} transacties geëxtraheerd.',
  'chat.skill.run.done.categorize.one': '{count} transactie gecategoriseerd.',
  'chat.skill.run.done.categorize.other': '{count} transacties gecategoriseerd.',
  'chat.skill.run.done.summarize.one': '{count} transactie samengevat.',
  'chat.skill.run.done.summarize.other': '{count} transacties samengevat.',
  'chat.skill.run.done.export.one': '{count} rij opgeslagen.',
  'chat.skill.run.done.export.other': '{count} rijen opgeslagen.',
  'chat.skill.run.done.reconciled': 'De saldi kloppen.',
  'chat.skill.run.done.unreconciled.one':
    '{count} rij klopt niet: controleer deze rij voordat je erop vertrouwt.',
  'chat.skill.run.done.unreconciled.other':
    '{count} rijen kloppen niet: controleer deze rijen voordat je erop vertrouwt.',
  'chat.skill.run.done.unchecked':
    'Er stond geen lopend saldo op het afschrift om mee te vergelijken.',
  'chat.skill.run.done.extractInvoice.one': '{count} factuurregel geëxtraheerd.',
  'chat.skill.run.done.extractInvoice.other': '{count} factuurregels geëxtraheerd.',
  'chat.skill.run.done.invoiceReconciled': 'De totalen van de factuur kloppen.',
  'chat.skill.run.done.invoiceUnreconciled.one':
    '{count} totaal klopt niet: controleer dit totaal voordat je erop vertrouwt.',
  'chat.skill.run.done.invoiceUnreconciled.other':
    '{count} totalen kloppen niet: controleer deze totalen voordat je erop vertrouwt.',
  'chat.skill.run.done.invoiceUnchecked':
    'Er stonden geen totalen op de factuur om mee te vergelijken.',
  'chat.skill.run.done.redacted.one':
    'Kopie opgeslagen waarin persoonsgegevens onleesbaar zijn gemaakt: {count} item verborgen. ' +
    'Naar beste vermogen, zonder garantie: controleer de kopie voordat je die deelt.',
  'chat.skill.run.done.redacted.other':
    'Kopie opgeslagen waarin persoonsgegevens onleesbaar zijn gemaakt: {count} items verborgen. ' +
    'Naar beste vermogen, zonder garantie: controleer de kopie voordat je die deelt.',
  'chat.skill.run.done.redactedClean':
    'Er zijn geen persoonsgegevens herkend; er is een kopie opgeslagen. Naar beste vermogen, ' +
    'zonder garantie: controleer de kopie voordat je die deelt.',
  'chat.skill.run.done.redactedFloor.one':
    'Kopie opgeslagen waarin persoonsgegevens onleesbaar zijn gemaakt: {count} item verborgen ' +
    '(alleen offline herkenning op basis van regels, er draait geen model). Controleer de kopie ' +
    'voordat je die deelt.',
  'chat.skill.run.done.redactedFloor.other':
    'Kopie opgeslagen waarin persoonsgegevens onleesbaar zijn gemaakt: {count} items verborgen ' +
    '(alleen offline herkenning op basis van regels, er draait geen model). Controleer de kopie ' +
    'voordat je die deelt.',
  'chat.skill.run.done.redactedCleanFloor':
    'Er zijn geen persoonsgegevens herkend (alleen offline herkenning op basis van regels, er ' +
    'draait geen model); er is een kopie opgeslagen. Controleer de kopie voordat je die deelt.',
  'chat.skill.run.done.redactedCapped.one':
    'Kopie opgeslagen waarin persoonsgegevens onleesbaar zijn gemaakt: {count} item verborgen. ' +
    'Dit document is erg groot, dus de automatische herkenning is bij de limiet gestopt en ' +
    'latere items zijn mogelijk nog leesbaar. Controleer de hele kopie voordat je die deelt.',
  'chat.skill.run.done.redactedCapped.other':
    'Kopie opgeslagen waarin persoonsgegevens onleesbaar zijn gemaakt: {count} items verborgen. ' +
    'Dit document is erg groot, dus de automatische herkenning is bij de limiet gestopt en ' +
    'latere items zijn mogelijk nog leesbaar. Controleer de hele kopie voordat je die deelt.',
  'chat.skill.run.done.edited.one':
    '{count} wijziging toegepast en een bewerkte kopie opgeslagen. Controleer de kopie voordat ' +
    'je die deelt.',
  'chat.skill.run.done.edited.other':
    '{count} wijzigingen toegepast en een bewerkte kopie opgeslagen. Controleer de kopie voordat ' +
    'je die deelt.',
  'chat.skill.run.done.editedPartial.one':
    '{count} wijziging toegepast; een deel van de gevraagde tekst is niet gevonden en ' +
    'overgeslagen. Er is een bewerkte kopie opgeslagen: controleer de kopie voordat je die deelt.',
  'chat.skill.run.done.editedPartial.other':
    '{count} wijzigingen toegepast; een deel van de gevraagde tekst is niet gevonden en ' +
    'overgeslagen. Er is een bewerkte kopie opgeslagen: controleer de kopie voordat je die deelt.',
  'chat.skill.run.done.editedNone':
    'Niets van de gevraagde tekst is gevonden: er is niets gewijzigd en er is geen kopie ' +
    'opgeslagen.',
  'chat.skill.run.done.editedCapped.one':
    '{count} wijziging toegepast. Dit document is erg groot, dus het zoeken naar plekken om te ' +
    'wijzigen is bij de limiet gestopt. Controleer de kopie: latere plekken zijn mogelijk niet ' +
    'gewijzigd.',
  'chat.skill.run.done.editedCapped.other':
    '{count} wijzigingen toegepast. Dit document is erg groot, dus het zoeken naar plekken om te ' +
    'wijzigen is bij de limiet gestopt. Controleer de kopie: latere plekken zijn mogelijk niet ' +
    'gewijzigd.',
  'chat.skill.run.failedGeneric': 'Dat is niet gelukt. Er is niets gewijzigd.',
  'chat.skill.run.error.unavailable': 'Deze actie is niet beschikbaar.',
  'chat.skill.run.error.needsExtraction':
    'Lees het document eerst in met de knop “{button}” en voer deze actie daarna uit.',
  'chat.skill.run.error.persistFailed': 'Dit kon niet worden opgeslagen. Er is niets gewijzigd.',
  'chat.skill.run.error.exportWriteFailed':
    'Het bestand kon niet worden opgeslagen. Er is niets gewijzigd.',
  'chat.skill.run.error.needsModel':
    'Start eerst een model: voor gerichte wijzigingen is een draaiend model nodig dat de te ' +
    'wijzigen tekst opzoekt.',
  'chat.skill.run.error.needsInstruction':
    'Zeg eerst wat er moet veranderen (bijvoorbeeld “vervang X door Y”) en voer dit daarna ' +
    'opnieuw uit.',
  'chat.skill.run.error.editFailed':
    'De wijzigingen konden niet worden voltooid. Er is niets gewijzigd.',
  'chat.skill.run.error.redactionModelStopped':
    'Het AI-model is gestopt voordat de persoonsgegevens onleesbaar waren gemaakt. Er is niets ' +
    'opgeslagen. Voer de actie opnieuw uit; gebeurt dit vaker, start het model dan opnieuw op ' +
    'het scherm AI-model.',
  'chat.skill.run.error.redactionTooLong':
    'Delen van dit document zijn te lang voor het contextvenster van het huidige model. Er is ' +
    'niets opgeslagen. Kies op het scherm AI-model een grotere contextgrootte, start het model ' +
    'opnieuw en voer de actie daarna nog eens uit.',
  'chat.skill.run.cancelled': 'Gestopt. Er is niets opgeslagen.',
  'chat.skill.run.stateUnknown':
    'De status van deze skill kon niet worden gecontroleerd: het resultaat is mogelijk ' +
    'onvolledig.',
  'chat.skill.run.otherChatBusy': 'Er werkt een skill in een andere chat.',
  'chat.skill.run.categorizeOffer': 'Transacties categoriseren',
  'chat.skill.run.dismiss': 'Verbergen',
  'chat.skill.confirm.title': 'Deze actie uitvoeren?',
  'chat.skill.confirm.body':
    'Hiermee wordt een bestand aangemaakt of geëxporteerd op basis van de documenten op deze ' +
    'schijf.',
  'chat.skill.confirm.target': 'Document: {document}',
  'chat.skill.confirm.outputDocx':
    'De opgeslagen kopie behoudt de Word-indeling van dit document (.docx).',
  'chat.skill.confirm.redactionScope':
    'Het onleesbaar maken geldt voor de tekst van het document (ook kopteksten, voetteksten, ' +
    'voetnoten, opmerkingen en bijgehouden wijzigingen) en wist de metagegevens over de auteur ' +
    'en de doelen van koppelingen. Afbeeldingen, gescande pagina’s en ingesloten objecten worden ' +
    'niet gecontroleerd: controleer de opgeslagen kopie voordat je die deelt.',
  'chat.skill.confirm.outputText':
    'De opgeslagen kopie wordt gewone tekst (.txt): de oorspronkelijke indeling en opmaak ' +
    'blijven niet behouden.',
  'chat.skill.confirm.outputMatrix':
    'Word-documenten (.docx) behouden de indeling; PDF’s en andere indelingen worden opgeslagen ' +
    'als kopie met gewone tekst (.txt).',
  'chat.skill.confirm.ok': 'Uitvoeren',
  // ---- Chat: transcript + message actions ----
  'chat.role.user': 'Jij',
  'chat.role.assistant': 'HilbertRaum',
  'chat.thinking': 'Nadenken…',
  'chat.actions.tryAgain': 'Opnieuw proberen',
  'chat.actions.sendAgain': 'Opnieuw verzenden',
  'chat.actions.copy': 'Kopiëren',
  'chat.actions.save': 'Opslaan',
  'chat.actions.saveTitle': 'Dit gesprek als bestand opslaan (blijft lokaal)',
  'chat.actions.exportCsv': 'CSV exporteren',
  'chat.actions.exportCsvTitle':
    'De tabel uit dit antwoord als CSV-bestand opslaan (blijft lokaal)',
  'chat.code.copy': 'Kopiëren',
  'chat.code.copyTitle': 'Dit codeblok naar het klembord kopiëren',
  'chat.code.save': 'Opslaan',
  'chat.code.saveTitle': 'Dit codeblok opslaan als bestand met de extensie .{ext} (blijft lokaal)',
  // ---- Chat: context compaction (context-compaction plan §5.1–§5.3) ----
  'chat.compaction.inProgress': 'Eerdere berichten samenvatten om geheugen vrij te maken…',
  'chat.analysis.inProgress': 'Het hele document lezen…',
  'chat.compaction.markerLabel': 'Eerdere berichten samengevat',
  'chat.compaction.viewSummary': 'De samenvatting van eerdere berichten tonen',
  'chat.context.label': 'Geheugen',
  'chat.context.usageTooltip':
    'Geheugen voor dit gesprek: {pct}% vol (ongeveer {used} van {window} tokens).',
  'chat.context.willSummarize':
    'Als het geheugen vol raakt, worden oudere berichten automatisch samengevat om ruimte te ' +
    'maken.',
  'chat.truncated.label': 'Antwoord afgekapt',
  'chat.endedEarly.label': 'Antwoord gestopt',
  'chat.endedEarly.hint.model':
    'Het AI-model is gestopt of er is een ander model gekozen voordat dit antwoord klaar was.',
  'chat.endedEarly.hint.user': 'Je hebt dit antwoord gestopt voordat het klaar was.',
  'chat.endedEarly.hint.lock':
    'De werkruimte is vergrendeld of de app is gesloten voordat dit antwoord klaar was.',
  'chat.unanswered.model': 'Niet beantwoord – het AI-model is gestopt.',
  'chat.unanswered.user': 'Niet beantwoord – je hebt het gestopt.',
  'chat.unanswered.lock': 'Niet beantwoord – de werkruimte is vergrendeld of de app is gesloten.',
  'chat.truncated.hint.context':
    'Het model had niet genoeg ruimte om dit antwoord af te maken. Vraag het model om verder te ' +
    'gaan, begin een nieuwe chat of vergroot de contextgrootte op het scherm AI-model.',
  'chat.truncated.hint.cap':
    'Dit antwoord op basis van je documenten heeft de vaste lengte bereikt die de app voor één ' +
    'antwoord toestaat. Vraag het model om verder te gaan waar het is gestopt.',
  'chat.speed.line': '{tps}\u00A0tok/s · {ttft}\u00A0s tot het eerste token · tokens: {tokens}',
  'chat.speed.hint':
    'Hoe snel dit antwoord is gegenereerd: de decodeersnelheid van de AI-engine, de wachttijd ' +
    'tot het eerste woord en het aantal gegenereerde tokens. Alleen zichtbaar bij antwoorden uit ' +
    'deze sessie.',
  // ---- Chat: document scope (ScopePopover.tsx) ----
  'chat.scope.none': 'Nog geen documenten · Toevoegen',
  'chat.scope.stopAsking': 'Niet meer vragen aan {title}',
  'chat.scope.askToo': 'Ook vragen aan {title}',
  'chat.scope.removedDoc': 'Verwijderd document',
  // ---- Chat: sources (SourcesDisclosure.tsx) ----
  'chat.sources.toggle': 'Bronnen ({count})',
  'chat.sources.marker': 'B{n}',
  'chat.sources.page': 'Pagina {page}',
  'chat.sources.wholeDoc.one': 'Uit het document – {count} sectie',
  'chat.sources.wholeDoc.other': 'Uit het document – {count} secties',
  'chat.sources.wholeDocCaption': 'Gebruikte secties',
  'chat.sources.more.one': 'en nog {count} sectie',
  'chat.sources.more.other': 'en nog {count} secties',
  // ---- Chat: dictation (DictationButton.tsx) ----
  'chat.dictation.start': 'Bericht dicteren',
  'chat.dictation.unavailable': 'De dicteerfunctie is niet op deze schijf geïnstalleerd',
  'chat.dictation.unavailableSystem':
    'De dicteerfunctie is niet beschikbaar op dit besturingssysteem',
  'chat.dictation.needsModel':
    'Voor het dicteren van een bericht is het spraakmodel nodig, maar dat staat niet op deze ' +
    'schijf. Je kunt het spraakmodel toevoegen op het scherm AI-model.',
  'chat.dictation.needsEngine':
    'Voor het dicteren van een bericht is de spraakengine nodig, maar die is niet op deze schijf ' +
    'geïnstalleerd. Je kunt de spraakengine installeren op het scherm AI-model.',
  'chat.dictation.needsModelAndEngine':
    'Voor het dicteren van een bericht zijn het spraakmodel en de spraakengine nodig, maar die ' +
    'staan nog niet op deze schijf. Je kunt beide toevoegen op het scherm AI-model.',
  'chat.dictation.engineUnsupported':
    'De dicteerfunctie is op dit besturingssysteem nog niet beschikbaar: de app kan de ' +
    'spraakengine die daarvoor nodig is hier niet installeren.',
  'chat.dictation.getModel': 'Spraakmodel ophalen',
  'chat.dictation.getEngine': 'Spraakengine ophalen',
  'chat.dictation.setUp': 'Dicteerfunctie instellen',
  'chat.dictation.stop': 'Dicteren stoppen en de tekst invoegen',
  'chat.dictation.transcribing': 'Je spraak wordt omgezet in tekst',
  'chat.dictation.noSpeech': 'Er is geen spraak herkend: probeer opnieuw iets te zeggen.',
  'chat.dictation.silent':
    'Er kwam geen geluid binnen via de microfoon. Controleer of de microfoon niet is gedempt en ' +
    'of HilbertRaum de microfoon volgens de systeeminstellingen mag gebruiken, en probeer het ' +
    'daarna opnieuw.',
  'chat.dictation.noSignal':
    'Er komt geen geluid binnen via de microfoon: controleer of de microfoon niet is gedempt en ' +
    'of het juiste invoerapparaat is gekozen.',
  'chat.dictation.micBlocked':
    'De microfoon kon niet worden gebruikt. Controleer de microfooninstellingen van het systeem ' +
    'en probeer het daarna opnieuw.',
  // ---- Documents (DocumentsScreen.tsx) ----
  'docs.title': 'Documenten',
  'docs.lead':
    'Importeer documenten om er vragen over te stellen. Elk bestand wordt naar je werkruimte ' +
    'gekopieerd en voorbereid voor het zoeken: alles blijft op deze schijf. Stel je vragen op ' +
    'het scherm Chat, in de modus “Vragen aan mijn documenten”.',
  'docs.status.queued': 'In wachtrij',
  'docs.status.extracting': 'Inlezen',
  'docs.status.preparing': 'Voorbereiden',
  'docs.status.indexed': 'Klaar',
  'docs.status.failed': 'Mislukt',
  'docs.status.deleted': 'Verwijderd',
  'docs.status.transcribing': 'Transcriberen…',
  'docs.task.summaryBusy': 'Samenvatten…',
  'docs.task.translationBusy': 'Vertalen…',
  'docs.task.compareBusy': 'Vergelijken…',
  'docs.task.ocrBusy': 'Scan lezen…',
  'docs.task.treeBusy': 'Diepe index opbouwen…',
  'docs.task.extractBusy': 'Details zoeken…',
  'docs.task.summaryBusyTitle': 'De samenvatting wordt geschreven',
  'docs.task.translationBusyTitle': 'De vertaling wordt geschreven',
  'docs.task.compareBusyTitle': 'De vergelijking wordt geschreven',
  'docs.task.ocrBusyTitle': 'De gescande pagina’s worden gelezen',
  'docs.task.treeBusyTitle': 'Er wordt een diepe index voor het hele document opgebouwd',
  'docs.task.extractBusyTitle':
    'Het hele document wordt doorzocht, zodat vragen als “noem alle…” kunnen worden beantwoord',
  'docs.task.categorizeBusy': 'Transacties categoriseren…',
  'docs.task.categorizeBusyTitle': 'De transacties in het afschrift worden gecategoriseerd',
  'docs.task.ocrFinishing': 'Afronden: de tekst doorzoekbaar maken…',
  'docs.task.stopping': 'Stoppen als dat kan…',
  'docs.error.noSupported': 'In deze selectie zijn geen ondersteunde documenten gevonden.',
  'docs.removedDocFallback': 'een verwijderd document',
  'docs.provenance.compareBefore': 'Vergelijking van ',
  'docs.provenance.compareMiddle': ' en ',
  'docs.provenance.translatedBefore': 'Vertaling van ',
  'docs.provenance.summaryBefore': 'Samenvatting van ',
  'docs.provenance.generatedBefore': 'Gegenereerd uit ',
  'docs.provenance.articleBefore': 'Opgeslagen uit het kennispakket ',
  'docs.provenance.articleUnknownArchive': '(naam onbekend)',
  'docs.import.busy': 'Importeren…',
  'docs.import.files': 'Bestanden importeren',
  'docs.import.folder': 'Map importeren',
  'docs.import.walkCut.one':
    'De map was te groot om helemaal te doorzoeken: er is {count} item geteld.',
  'docs.import.walkCut.other':
    'De map was te groot om helemaal te doorzoeken: er zijn {count} items geteld.',
  'docs.refresh': 'Vernieuwen',
  'docs.loading': 'Documenten laden…',
  'docs.askSelected': 'Vragen aan deze documenten ({count})',
  'docs.askSelectedTitle':
    'Een gesprek met vragen over documenten openen, beperkt tot de geselecteerde documenten',
  'docs.compareBtn': 'Vergelijken (2)',
  'docs.compareBtnTitle':
    'Met het lokale model een vergelijking van de twee geselecteerde documenten schrijven: niets ' +
    'verlaat deze schijf',
  'docs.reindexAll': 'Alles opnieuw indexeren ({count})',
  'docs.reindexAllTitle':
    'Elk document opnieuw indexeren dat met een ander zoekmodel is geïndexeerd',
  'docs.reindexAllConfirm.title.one': '{count} document opnieuw indexeren?',
  'docs.reindexAllConfirm.title.other': '{count} documenten opnieuw indexeren?',
  'docs.reindexAllConfirm.body':
    'Elk verouderd document wordt één voor één opnieuw ingelezen en opnieuw voorbereid voor het ' +
    'zoeken. Dat kan enkele minuten duren en belast de processor zwaar: je kunt doorwerken, maar ' +
    'antwoorden kunnen trager zijn tot het klaar is.',
  'docs.reindexAllConfirm.confirm': 'Alles opnieuw indexeren',
  'docs.retryAllFailed': 'Alles opnieuw proberen ({count})',
  'docs.retryAllFailedTitle': 'Elk document opnieuw indexeren waarvan het indexeren is mislukt',
  'docs.retryAllConfirm.title.one': '{count} mislukt document opnieuw proberen?',
  'docs.retryAllConfirm.title.other': '{count} mislukte documenten opnieuw proberen?',
  'docs.retryAllConfirm.body':
    'Elk mislukt document wordt één voor één opnieuw ingelezen en opnieuw voorbereid voor het ' +
    'zoeken. Dat kan enkele minuten duren en belast de processor zwaar: je kunt doorwerken, maar ' +
    'antwoorden kunnen trager zijn tot het klaar is. Documenten die opnieuw mislukken, blijven ' +
    'onder “Aandacht nodig” staan.',
  'docs.retryAllConfirm.confirm': 'Alles opnieuw proberen',
  'docs.reindexAllProgress': 'Opnieuw indexeren: {done} van {total}…',
  'docs.reindexAllCancel': 'Annuleren',
  'docs.reindexAllCancelled': 'Opnieuw indexeren gestopt. Klaar: {done} van {total}.',
  'docs.reindexAllDone.one': '{count} document opnieuw geïndexeerd.',
  'docs.reindexAllDone.other': '{count} documenten opnieuw geïndexeerd.',
  'docs.reindexAllPartial':
    'Opnieuw geïndexeerd: {done} van {total}. Mislukt: {failed}. Mislukte documenten blijven ' +
    'onder “Aandacht nodig” staan.',
  'docs.supported.base':
    'Ondersteund: TXT, Markdown, PDF, DOCX, CSV en geluidsopnamen (WAV, MP3, FLAC, OGG), die op ' +
    'deze schijf worden getranscribeerd',
  'docs.supported.ocrExtra':
    ', en foto’s van pagina’s (PNG, JPG), die op deze schijf worden gelezen',
  'docs.preparing': 'Je documenten worden voorbereid, zodat je er vragen over kunt stellen…',
  'docs.empty.title': 'Nog geen documenten',
  'docs.empty.line':
    'Importeer bestanden om er vragen over te stellen: alles blijft op deze schijf.',
  'docs.selectAria': 'Het document “{title}” selecteren om er vragen over te stellen',
  'docs.selectTitle': 'Selecteren om alleen aan de gekozen documenten vragen te stellen',
  'docs.selectAllAria': 'Alle documenten selecteren',
  'docs.selectAllTitle': 'Alle zichtbare documenten selecteren, of de selectie wissen',
  'docs.meta.sectionsCount.one': '{count} sectie',
  'docs.meta.sectionsCount.other': '{count} secties',
  'docs.meta.summary': 'Samenvatting',
  'docs.meta.type.text': 'Tekst',
  'docs.meta.type.audio': 'Audio',
  'docs.meta.type.image': 'Afbeelding',
  'docs.scan.ocrOffer':
    'Gebruik “Doorzoekbaar maken (OCR)” in deze rij om de pagina’s op deze schijf te lezen.',
  'docs.scan.ocrMissing':
    'Voor het doorzoekbaar maken zijn de OCR-bestanden nodig, maar die staan niet op deze ' +
    'schijf. Download ze hieronder, of voeg ze op een schijf die je zelf hebt ingesteld toe met ' +
    '“fetch-runtime --family ocr”.',
  'docs.scan.ocrMissingOffline':
    'Voor het doorzoekbaar maken zijn de OCR-bestanden nodig, maar die staan niet op deze ' +
    'schijf. Wil je ze toevoegen, herhaal dan het instellen van de schijf met “--with-assets”, ' +
    'of haal alleen de OCR-bestanden op met “fetch-runtime --family ocr”.',
  'docs.photo.ocrMissing':
    'Download hieronder de OCR-bestanden en gebruik daarna “Opnieuw proberen” om deze foto te ' +
    'lezen.',
  'docs.photo.ocrMissingOffline':
    'Voeg de OCR-bestanden toe met de scripts voor het instellen van de schijf (“fetch-runtime ' +
    '--family ocr”) en gebruik daarna “Opnieuw proberen” om deze foto te lezen.',
  'docs.photo.ocrReady':
    'De tekstherkenning is nu klaar: gebruik “Opnieuw proberen” om deze foto te lezen.',
  'docs.scan.ocrUnavailable':
    'Voor het doorzoekbaar maken is tekstherkenning (OCR) nodig, maar die kon in deze versie ' +
    'niet starten.',
  'docs.ocr.unavailableBanner':
    'Tekstherkenning (OCR) is in deze versie niet beschikbaar: de OCR-bestanden staan op deze ' +
    'schijf, maar de herkenning kon niet starten. Foto’s worden zonder leesbare tekst opgeslagen ' +
    'en gescande PDF’s kunnen niet doorzoekbaar worden gemaakt totdat dit is opgelost.',
  'docs.stale.banner':
    'Dit document is met een ander zoekmodel voorbereid: indexeer het opnieuw, zodat antwoorden ' +
    'het kunnen vinden.',
  'docs.preview': 'Voorbeeld',
  'docs.previewBusy': 'Openen…',
  'docs.previewTitle': 'De geëxtraheerde tekst lezen (alleen-lezen; niets verlaat de app)',
  'docs.cancel': 'Annuleren',
  'docs.cancelOcrTitle': 'Het lezen van de scan stoppen',
  'docs.cancelTaskTitle': 'De taak stoppen',
  'docs.task.stateUnknown':
    'De status van deze taak kon niet worden gecontroleerd: mogelijk loopt de taak nog.',
  'docs.task.dismiss': 'Verbergen',
  'docs.makeSearchable': 'Doorzoekbaar maken (OCR)',
  'docs.makeSearchableTitle':
    'De gescande pagina’s lezen met lokale tekstherkenning: niets verlaat deze schijf',
  'docs.makeSearchableAgain': 'Opnieuw lezen (OCR)',
  'docs.makeSearchableAgainPhotoTitle': 'De foto opnieuw lezen met de lokale tekstherkenning',
  'docs.makeSearchableAgainTitle':
    'De lokale tekstherkenning opnieuw uitvoeren en de opgeslagen herkende tekst vervangen: ' +
    '“Opnieuw indexeren” hergebruikt die tekst',
  'docs.summarize': 'Samenvatten',
  'docs.summarizeAgain': 'Opnieuw samenvatten',
  'docs.translate': 'Vertalen',
  'docs.translateNoModel': 'Vertaalmodel ophalen…',
  'docs.translateNoModelTitle':
    'Voor vertalen is het vertaalmodel nodig: download het op het scherm AI-model',
  'docs.export': 'Exporteren',
  'docs.exportOriginal': 'Origineel bestand exporteren',
  'docs.exportOriginal.gone':
    'De opgeslagen kopie van dit bestand staat niet op deze schijf, dus het bestand kan niet ' +
    'worden geëxporteerd. Je kunt de geëxtraheerde tekst nog wel exporteren.',
  'docs.exportOriginalConfirm.title': 'Het originele bestand exporteren?',
  'docs.exportOriginal.warning':
    'Dit geëxporteerde bestand staat buiten de versleutelde werkruimte van HilbertRaum en wordt ' +
    'niet beschermd door het wachtwoord van je werkruimte.',
  'docs.reindex': 'Opnieuw indexeren',
  'docs.reindexBusy': 'Opnieuw indexeren…',
  'docs.reindexTitle': 'De opgeslagen kopie opnieuw lezen en voorbereiden',
  'docs.reindexDone': 'Het document “{title}” is opnieuw geïndexeerd.',
  'docs.delete': 'Verwijderen',
  'docs.deleteBusy': 'Verwijderen…',
  'docs.deleteDone': 'Het document “{title}” is verwijderd.',
  'docs.failed.remove': 'Verwijderen',
  'docs.failed.removeTitle': 'Deze mislukte import uit de lijst verwijderen',
  'docs.failed.retry': 'Opnieuw proberen',
  'docs.failed.lead': 'Dit bestand kon niet worden verwerkt.',
  'docs.backToChat': 'Terug naar de chat',
  'docs.failed.retryTitle': 'Dit bestand opnieuw lezen en voorbereiden',
  'docs.moreActions': 'Meer acties voor het document “{title}”',
  'docs.audioConfirm.title': 'Grote geluidsopnamen importeren?',
  'docs.audioConfirm.confirm': 'Importeren en transcriberen',
  'docs.audioConfirm.contains.one': 'Deze selectie bevat {count} geluidsopname ({size}).',
  'docs.audioConfirm.contains.other': 'Deze selectie bevat {count} geluidsopnamen ({size}).',
  'docs.audioConfirm.body':
    'Elke opname wordt naar je werkruimte gekopieerd en op deze schijf getranscribeerd: bij een ' +
    'lange opname kan dat enige tijd duren. Je kunt de app ondertussen blijven gebruiken.',
  'docs.deleteConfirm.title': 'Het document “{title}” verwijderen?',
  'docs.deleteConfirm.body':
    'Hiermee worden het document, de geëxtraheerde tekst en de zoekindex definitief uit je ' +
    'werkruimte verwijderd. Het originele bestand buiten de werkruimte blijft ongewijzigd.',
  'docs.translateModal.title': 'Het document “{title}” vertalen',
  'docs.translateModal.aria': 'Het document {title} vertalen',
  'docs.translateModal.hint':
    'Het lokale model schrijft een vertaalde kopie als nieuw document. Je kunt dat document ' +
    'doorzoeken en er vragen over stellen zoals bij elke import, en niets verlaat deze schijf. ' +
    'Machinevertalingen kunnen fouten bevatten.',
  'docs.translateModal.from': 'Van',
  'docs.translateModal.to': 'Naar',
  'docs.translateModal.start': 'Vertalen',
  'docs.translateModal.sameLang': 'Kies twee verschillende talen.',
  'docs.previewModal.aria': 'Voorbeeld van het document {title}',
  'docs.previewModal.hint':
    'Geëxtraheerde tekst (alleen-lezen): hierop zijn het zoeken in documenten en de antwoorden ' +
    'gebaseerd.',
  'docs.previewModal.ocrInfo.one':
    'Tekst op deze schijf herkend (OCR): {count} pagina. De herkenning kan fouten bevatten.',
  'docs.previewModal.ocrInfo.other':
    'Tekst op deze schijf herkend (OCR): {count} pagina’s. De herkenning kan fouten bevatten.',
  'docs.previewModal.ocrInfoPhoto':
    'Tekst uit deze foto op deze schijf herkend (OCR). De herkenning kan fouten bevatten.',
  'docs.previewModal.ocrInfoPartial':
    'Tekst op deze schijf herkend (OCR). Pagina’s met herkende tekst: {count} van {total}. De ' +
    'herkenning kan fouten bevatten.',
  'docs.previewModal.ocrInfoNone.one':
    'Tekstherkenning (OCR) heeft op deze schijf {count} gescande pagina gelezen en er geen tekst ' +
    'op gevonden.',
  'docs.previewModal.ocrInfoNone.other':
    'Tekstherkenning (OCR) heeft op deze schijf {count} gescande pagina’s gelezen en er geen ' +
    'tekst op gevonden.',
  'docs.ocr.unsure.page': 'De tekstherkenning was onzeker over deze pagina.',
  'docs.ocr.unsure.onlyRecognized': 'De tekstherkenning was onzeker over de enige herkende pagina.',
  'docs.ocr.unsure.photo': 'De tekstherkenning was onzeker over deze foto.',
  'docs.ocr.unsure.some':
    'De tekstherkenning was onzeker over een deel van de herkende pagina’s: {count} van {total}.',
  'docs.ocr.unsure.all': 'De tekstherkenning was onzeker over alle herkende pagina’s ({count}).',
  'docs.ocr.scannedPages': 'Gescande pagina’s nog zonder leesbare tekst: {count} van {total}.',
  'docs.ocr.scannedPagesNeedsOcr':
    'Om deze pagina’s te lezen zijn de OCR-bestanden nodig (scherm AI-model).',
  'docs.ocr.unsure.causes':
    'Een wazig, scheef of handgeschreven origineel wordt slecht gelezen, en dat geldt ook voor ' +
    'een andere taal dan Duits of Engels.',
  'docs.previewModal.summary': 'Samenvatting',
  'docs.previewModal.generatedBy': 'Gegenereerd door het model {model}',
  'docs.previewModal.truncated':
    'Dit document is lang: de samenvatting gaat over het begin. In de rest kun je nog steeds ' +
    'zoeken, en in de chat kun je er vragen over stellen.',
  'docs.previewModal.regenerate': 'Opnieuw genereren',
  'docs.previewModal.copy': 'Kopiëren',
  'docs.previewModal.save': 'Opslaan',
  'docs.previewModal.copied': 'Samenvatting gekopieerd',
  'docs.previewModal.copyFailed': 'Kopiëren naar het klembord is niet gelukt',
  'docs.previewModal.savedTo': 'Samenvatting opgeslagen als {path}',
  'docs.previewModal.noText': 'Er kon geen tekst uit dit document worden geëxtraheerd.',
  'docs.previewModal.documentText': 'Documenttekst',
  'docs.previewModal.page': 'Pagina {page}',
  'docs.previewModal.showMore': 'Meer tonen',
  'docs.previewModal.loadingMore': 'Laden…',
  'docs.previewModal.segmentProgress': 'Getoond: {shown} van {total}',
  // ---- Deep index + coverage (whole-document-analysis plan §5.2) ----
  'docs.deepIndex.build': 'Diepe index opbouwen',
  'docs.deepIndex.reindexFirst': 'Opnieuw indexeren voor een diepe index',
  'docs.deepIndex.ready': 'Diep geïndexeerd',
  'docs.deepIndex.readyTitle':
    'Er is een diepe index voor het hele document klaar: samenvattingen en lijstantwoorden ' +
    'kunnen alles omvatten',
  'coverage.relevance': 'Gebaseerd op de meest relevante tekstdelen, niet op het hele document',
  'coverage.relevance.counted': 'Gebruikte secties: {covered} van {total}',
  'coverage.capped.whole': 'Omvat het hele document',
  'coverage.capped.beginning': 'Omvat het begin van het document',
  'coverage.tree.whole': 'Omvat het hele document (diep geïndexeerd)',
  'coverage.tree.beginning':
    'Omvat het begin van het document: het was te groot om volledig te lezen',
  'coverage.tree.partial': 'Diepe index in opbouw – secties: {covered} van {total}',
  'coverage.tree.pending': 'Nog geen diepe index',
  'coverage.depth': 'Detail: {label}',
  'coverage.tier.1': 'Overzicht',
  'coverage.tier.2': 'Sectie voor sectie',
  'coverage.tier.3': 'Gedetailleerd (hele document)',
  'coverage.tier.hint.1': 'Het snelst: het opgeslagen overzicht',
  'coverage.tier.hint.2': 'Een uitgebreidere ronde langs de secties',
  'coverage.tier.hint.3': 'De meeste details, over het hele document',
  'coverage.tierSelect.trigger': 'Detail: {label}',
  'coverage.extract.whole': 'Het hele document gelezen – secties: {scanned}',
  'coverage.extract.wholeUnparsed':
    'Het hele document gelezen – secties: {scanned}, niet leesbaar: {unparsed}',
  'coverage.extract.sections': 'Gelezen secties: {scanned}',
  'coverage.extract.sectionsUnparsed': 'Gelezen secties: {scanned}, niet leesbaar: {unparsed}',
  // ---- "List every X" answer (whole-document-analysis plan §4.2, Phase 3) ----
  'analysis.kind.generic': 'items',
  'analysis.kind.date': 'datums',
  'analysis.kind.amount': 'bedragen',
  'analysis.kind.party': 'partijen',
  'analysis.kind.obligation': 'verplichtingen',
  'analysis.listing.coverageWhole':
    'Gevonden in het hele document ({kind}): {count} – gelezen secties: {scanned}{unparsed}:',
  'analysis.listing.coverageSections':
    'Gevonden ({kind}): {count} – gelezen secties: {scanned}{unparsed}:',
  'analysis.listing.empty': 'Niets gevonden ({kind}) – gelezen secties: {scanned}{unparsed}.',
  'analysis.listing.unparsedSuffix': ' (niet leesbaar: {k})',
  'analysis.listing.item': '- {value} (×{count})',
  'analysis.listing.caveat':
    'Deze lijst bevat alles wat in de gelezen secties is gevonden, maar is niet gegarandeerd ' +
    'compleet (een klein model kan een item missen, en sterk gelijkende items kunnen worden ' +
    'samengevoegd).',
  'analysis.listing.refPage': 'p. {n}',
  'analysis.listing.refSection': 'sectie {n}',
  'analysis.listing.unparsedHint':
    '**Let op:** de meeste secties konden niet worden gelezen toen dit document werd ' +
    'geïndexeerd, dus dit resultaat is onbetrouwbaar. Ga naar Documenten en voer “Diepe index ' +
    'opbouwen” opnieuw uit: secties die niet konden worden gelezen, worden dan opnieuw ' +
    'geprobeerd (een groter model helpt).',
  'analysis.listing.unparsedHintAmountSkill':
    'Voor een bankafschrift leest de skill “Bankafschriftanalyse” in het skillmenu van de chat ' +
    'de bedragen exact uit.',
  'analysis.listing.aggregationHint':
    '**Let op:** je vroeg om categorieën of totalen, maar dit antwoord kan alleen de waarden ' +
    'opsommen die in het document zijn gevonden, met hoe vaak elke waarde voorkomt. Groeperen of ' +
    'optellen kan dit antwoord niet.',
  'analysis.listing.aggregationHintAmountSkill':
    'Kies voor een bankafschrift de skill “Bankafschriftanalyse” in het skillmenu van de chat en ' +
    'stel je vraag opnieuw: die skill verdeelt de transacties over categorieën en telt elke ' +
    'categorie exact op.',
  'analysis.wholeDocHint':
    '**Let op:** dit antwoord is alleen gebaseerd op de meest relevante secties, dus er kunnen ' +
    'items ontbreken. Wil je een lijst die elke sectie omvat, ga dan naar Documenten, kies ' +
    '“Diepe index opbouwen” voor het document en stel je vraag opnieuw.',
  'analysis.partialAnswerHint':
    '**Let op:** dit antwoord is alleen gebaseerd op de meest relevante secties, dus er kunnen ' +
    'items ontbreken.',
  'analysis.wholeReadSumHint':
    '**Let op:** het model berekent totalen zelf en kan daarbij items missen of verkeerd tellen. ' +
    'Controleer elk totaal aan de hand van de bronnen.',
  // ---- Bank-statement analysis answer (full-doc-skills plan §3.1, Phase 2) ----
  'skills.bankAnalysis.count': 'Gelezen transacties in het hele afschrift: **{count}**.',
  'skills.bankAnalysis.countPartial':
    'Gelezen transacties: **{count}**. Regels met een bedrag dat ik niet als transactie kon ' +
    'uitlezen: **{dropped}**. Dit zijn dus mogelijk niet alle transacties: controleer die regels ' +
    'aan de hand van het document.',
  'skills.bankAnalysis.countContradicted':
    'Gelezen transacties: **{count}**. De afgedrukte saldi van dit afschrift kloppen daar niet ' +
    'mee, dus ik kan niet bevestigen dat dit alle transacties zijn.',
  'skills.bankAnalysis.empty':
    'Ik heb het hele document doorzocht, maar kon er geen transacties uit halen. Mogelijk staan ' +
    'de regels in een gescande afbeelding of in een ongebruikelijke opmaak die ik niet kan ' +
    'volgen. Is dit een scan, gebruik dan eerst tekstherkenning (OCR); anders is de opmaak ' +
    'misschien niet machinaal leesbaar. Open in dat geval het afschrift en lees de bedragen daar ' +
    'zelf.',
  'skills.bankAnalysis.couldNotRead':
    'Ik kon dit afschrift niet lezen, dus ik kan het niet analyseren.',
  'skills.bankAnalysis.unreconciledHeading':
    'Controleer eerst deze regels. Het afgedrukte lopende saldo klopt niet met de bedragen:',
  'skills.bankAnalysis.unreconciledItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.totals':
    'Bijgeschreven: **{inAmount} {currency}** · Afgeschreven: **{outAmount} {currency}** · ' +
    'Nettoverandering: **{netAmount} {currency}**.',
  'skills.bankAnalysis.noCurrency':
    'Deze transacties gebruiken meer dan één valuta, dus er is geen gezamenlijk totaal: een ' +
    'totaal zou per valuta moeten worden gesplitst.',
  'skills.bankAnalysis.incompleteNoTotal':
    'Ik kon niet bevestigen dat ik het hele afschrift heb gelezen: de afgedrukte saldi kloppen ' +
    'niet met de transacties die ik heb gelezen, dus de bedragen kunnen verkeerd gelezen of ' +
    'onvolledig zijn. Om je geen totaal te geven dat mogelijk niet klopt, noem ik hier geen som. ' +
    'Open het afschrift en controleer de bedragen zelf.',
  'skills.bankAnalysis.categoryHeading': 'Per categorie:',
  'skills.bankAnalysis.categoryItem': '- {category}: {amount} {currency} ({count})',
  'skills.bankAnalysis.categoryAssisted':
    '_De categorieën zijn met hulp van het model bepaald: een label kan verkeerd zijn, maar de ' +
    'totalen hierboven blijven ongewijzigd._',
  'skills.bankAnalysis.categoryRuleBased':
    '_Dit is een snelle indeling op basis van regels (zonder model). Gebruik de knop ' +
    '“Categoriseren” voor een uitgebreidere indeling met hulp van het model._',
  'skills.bankCategory.Groceries': 'Boodschappen',
  'skills.bankCategory.Dining': 'Uit eten',
  'skills.bankCategory.Transport': 'Vervoer',
  'skills.bankCategory.Utilities': 'Energie en water',
  'skills.bankCategory.Rent': 'Huur',
  'skills.bankCategory.Insurance': 'Verzekeringen',
  'skills.bankCategory.Subscriptions': 'Abonnementen',
  'skills.bankCategory.Health': 'Gezondheid',
  'skills.bankCategory.Shopping': 'Winkelen',
  'skills.bankCategory.Income': 'Inkomsten',
  'skills.bankCategory.Transfer': 'Overboekingen',
  'skills.bankCategory.Fees': 'Kosten',
  'skills.bankCategory.Cash': 'Contant geld',
  'skills.bankCategory.Tax': 'Belastingen',
  'skills.bankCategory.Spending': 'Uitgaven',
  'skills.bankCategory.Uncategorized': 'Zonder categorie',
  'skills.bankAnalysis.caveat':
    'Dit zijn de bedragen zoals ze op het afschrift zelf zijn afgedrukt, gelezen uit het hele ' +
    'document: niets hiervan is uit lopende tekst opgeteld of verzonnen.',
  'skills.bankAnalysis.unverifiedCaveat':
    'Deze bedragen zijn een som van de transacties die ik in het hele document heb gelezen ' +
    '(aantal: **{count}**). Het afschrift vermeldt geen begin- of eindsaldo, dus ik kan niet ' +
    'bevestigen dat dit alle transacties zijn. Zie ze als een som van de getoonde regels, niet ' +
    'als een gecontroleerd totaal van het afschrift. Niets hiervan is uit lopende tekst opgeteld ' +
    'of verzonnen.',
  'skills.bankAnalysis.dateOrderCaveat':
    'Een opmerking over de datums: dit afschrift laat niet zien of de dag of de maand eerst ' +
    'staat, dus ik heb ze gelezen met de dag eerst (dag.maand.jaar). Een datum als 03.05. kan 3 ' +
    'mei of 5 maart zijn. Controleer elke belangrijke datum aan de hand van het document.',
  'skills.bankAnalysis.transactionsHeading': 'Transacties:',
  'skills.bankAnalysis.transactionItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.transactionsMore':
    '… en nog **{count}**. Wil je elke regel zien, gebruik dan de knop **CSV exporteren** in de ' +
    'actiebalk om het hele afschrift op te slaan, of vraag hier in de chat om het afschrift als ' +
    'CSV of JSON.',
  'skills.bankAnalysis.figureEcho': 'Totalen berekend uit de uitgelezen transacties: {figures}.',
  'skills.bankAnalysis.figureEchoIn': 'bijgeschreven {amount} {currency}',
  'skills.bankAnalysis.figureEchoOut': 'afgeschreven {amount} {currency}',
  'skills.bankAnalysis.figureEchoNet': 'nettoverandering {amount} {currency}',
  'skills.bankAnalysis.formatIntro':
    'Hier is het afschrift als {format}, alleen opgebouwd uit de bedragen die ik heb gelezen ' +
    '(niets uit lopende tekst opgeteld of verzonnen):',
  'skills.bankAnalysis.formatIntroCsv':
    'Hier is het afschrift als CSV: alleen de transactieregels, opgebouwd uit de bedragen die ik ' +
    'heb gelezen (niets uit lopende tekst opgeteld of verzonnen). De samenvatting van inkomsten ' +
    'en uitgaven en het begin- en eindsaldo staan niet in de CSV; vraag het afschrift als JSON ' +
    'op om die ook te krijgen.',
  'skills.bankAnalysis.customCategoriesNeedModel':
    'Om de transacties in je eigen categorieën in te delen ({categories}), moet er een lokaal ' +
    'model draaien: de ingebouwde snelle regels kennen alleen hun vaste set. Start een model en ' +
    'stel je vraag daarna opnieuw.',
  'skills.bankAnalysis.customTaxonomyNotFound':
    'Ik kon het bestand “{name}” niet vinden tussen je documenten. Importeer het bestand eerst ' +
    '(Documenten → Bestanden importeren) en stel je vraag daarna opnieuw.',
  'skills.bankAnalysis.customTaxonomyUnparseable':
    'Ik heb het bestand “{name}” gelezen, maar kon het niet als categorielijst gebruiken. Ik ' +
    'verwacht één categorie per regel: een label, eventueel gevolgd door trefwoorden na een ' +
    'puntkomma (bijvoorbeeld “Kinderen;school, opvang, zakgeld”).',
  'skills.bankAnalysis.derivedColumnsNote':
    '_Kolommen die het lokale model heeft ingevuld op basis van de omschrijving van elke ' +
    'transactie: {columns}. Waar het model niet zeker was, is het veld leeg gelaten. Alle ' +
    'bedragen komen uit de vaste uitlezing zonder model en zijn ongewijzigd._',
  // ---- Invoice analysis answer (full-doc-skills plan §3.1, Phase 4 / D49) ----
  'skills.invoiceAnalysis.count': 'Ik heb de hele factuur gelezen. Factuurregels: **{count}**.',
  'skills.invoiceAnalysis.countPartial':
    'Gelezen factuurregels: **{count}**. Regels met een bedrag dat ik niet als factuurregel kon ' +
    'uitlezen: **{dropped}**. Dit zijn dus mogelijk niet alle regels: controleer die regels aan ' +
    'de hand van het document.',
  'skills.invoiceAnalysis.empty':
    'Ik heb het hele document doorzocht, maar kon er geen factuurregels of totalen uit halen. ' +
    'Mogelijk staan de bedragen in een gescande afbeelding of in een ongebruikelijke opmaak die ' +
    'ik niet kan volgen. Is dit een scan, gebruik dan eerst tekstherkenning (OCR); anders is de ' +
    'opmaak misschien niet machinaal leesbaar. Open in dat geval de factuur en lees de bedragen ' +
    'daar zelf.',
  'skills.invoiceAnalysis.couldNotRead':
    'Ik kon deze factuur niet lezen en kan die dus niet analyseren.',
  'skills.invoiceAnalysis.unreconciledHeading':
    'Controleer eerst deze totalen, want ze kloppen niet:',
  'skills.invoiceAnalysis.checkLineItemsSumToNet':
    'de factuurregels tellen niet op tot het afgedrukte nettototaal',
  'skills.invoiceAnalysis.checkNetPlusTaxIsGross':
    'netto plus btw komt niet overeen met het afgedrukte brutototaal',
  'skills.invoiceAnalysis.checkTaxMatchesRate':
    'het btw-bedrag komt niet overeen met het vermelde btw-tarief',
  'skills.invoiceAnalysis.unreconciledItem': '- {check}',
  'skills.invoiceAnalysis.totalsHeading': 'Totalen, precies zoals afgedrukt:',
  'skills.invoiceAnalysis.net': '- Netto: **{value}**',
  'skills.invoiceAnalysis.tax': '- Btw: **{value}**',
  'skills.invoiceAnalysis.taxWithRate': '- Btw ({rate}%): **{value}**',
  'skills.invoiceAnalysis.gross': '- Brutototaal (te betalen): **{value}**',
  'skills.invoiceAnalysis.positionsHeading': 'Factuurregels:',
  'skills.invoiceAnalysis.positionItem': '- {description} · {amount} {currency}',
  'skills.invoiceAnalysis.positionsMore':
    '… en nog **{count}**. Vraag me de factuur als CSV te exporteren om elke regel te zien.',
  'skills.invoiceAnalysis.formatIntro':
    'Hier is de factuur als {format}, alleen opgebouwd uit de bedragen die ik heb gelezen (niets ' +
    'uit lopende tekst opgeteld of verzonnen):',
  'skills.invoiceAnalysis.formatIntroCsv':
    'Hier is de factuur als CSV: alleen de factuurregels, opgebouwd uit de bedragen die ik heb ' +
    'gelezen (niets uit lopende tekst opgeteld of verzonnen). De kopgegevens (leverancier, ' +
    'factuurnummer, datums) en de totalen staan niet in de CSV; vraag de factuur als JSON of XML ' +
    'op om die ook te krijgen.',
  'skills.invoiceAnalysis.noTotals':
    'Op de factuur staat geen netto-, btw- of brutototaal dat ik kon lezen.',
  'skills.invoiceAnalysis.caveat':
    'Dit zijn de bedragen zoals ze op de factuur zelf zijn afgedrukt, gelezen uit het hele ' +
    'document: niets hiervan is uit lopende tekst opgeteld of verzonnen.',
  'skills.invoiceAnalysis.dateOrderCaveat':
    'Een opmerking over de datums: deze factuur laat niet zien of de dag of de maand eerst ' +
    'staat, dus ik heb ze gelezen met de dag eerst (dag.maand.jaar). Een datum als 03.05. kan 3 ' +
    'mei of 5 maart zijn. Controleer elke belangrijke datum aan de hand van het document.',
  'skills.invoiceAnalysis.detailsHeading': 'Gegevens, zoals afgedrukt:',
  'skills.invoiceAnalysis.detailVendor': '- Leverancier: {vendor}',
  'skills.invoiceAnalysis.detailRecipient': '- Ontvanger (gefactureerd aan): {recipient}',
  'skills.invoiceAnalysis.detailInvoiceNumber': '- Factuurnummer: {number}',
  'skills.invoiceAnalysis.detailInvoiceDate': '- Factuurdatum: {date}',
  'skills.invoiceAnalysis.detailDueDate': '- Vervaldatum: {date}',
  'skills.invoiceAnalysis.figureEcho':
    'Bedragen zoals uitgelezen, letterlijk uit het document: {figures}.',
  'skills.invoiceAnalysis.figureEchoNet': 'netto {value}',
  'skills.invoiceAnalysis.figureEchoTax': 'btw {value}',
  'skills.invoiceAnalysis.figureEchoGross': 'bruto {value}',
  'skills.invoiceAnalysis.totalsHeadingUnverified':
    'Bedragen zoals afgedrukt (**ze kloppen niet**, dus beschouw ze als niet gecontroleerd):',
  'skills.invoiceAnalysis.unreconciledCaveat':
    'Deze afgedrukte bedragen spreken elkaar tegen. Dat betekent meestal dat de tekst niet goed ' +
    'uit het document is gehaald (een scan, een PDF die uit afbeeldingen bestaat of een ' +
    'ongebruikelijke opmaak). Vertrouw op geen van deze bedragen zonder het document zelf te ' +
    'controleren.',
  'skills.invoiceAnalysis.figureEchoSuppressed':
    'Ik herhaal de uitgelezen totalen hier niet: ze kloppen niet met elkaar of met de ' +
    'factuurregels, dus ze als betrouwbare bedragen noemen zou misleidend zijn. Controleer het ' +
    'document zelf.',
  'skills.invoiceAnalysis.unreadableLayout':
    'De tekst van dit document komt er niet goed uit: de tekens komen er door elkaar uit (teken ' +
    'voor teken), wat meestal wijst op een PDF die uit afbeeldingen bestaat of een ' +
    'ongebruikelijke tekencodering heeft. Ik kon er geen betrouwbare factuurregels of totalen ' +
    'uit lezen, dus ik noem geen bedragen. Is het een scan, gebruik dan eerst tekstherkenning ' +
    '(OCR); open anders de factuur en lees de bedragen daar zelf.',
  'skills.invoiceAnalysis.textQualityCaveat':
    'Een waarschuwing: delen van de tekst van dit document zijn door elkaar uitgelezen (teken ' +
    'voor teken). De bedragen hierboven kloppen wel, maar controleer alles wat belangrijk is aan ' +
    'de hand van het document zelf.',
  'skills.analysis.refusePartial':
    'Ik kan dit alleen nauwkeurig beantwoorden op basis van het hele document, en dit document ' +
    'is nog niet volledig geïndexeerd. Open het scherm Documenten, kies “Opnieuw indexeren” en ' +
    'stel je vraag daarna opnieuw.',
  'skills.analysis.scopeNarrowed':
    'Ik heb alleen uit het document **{title}** geantwoord. Andere geselecteerde documenten die ' +
    'niet zijn gelezen: {count}. Wil je een ander document analyseren, selecteer dan alleen dat ' +
    'document (of noem de bestandsnaam in je vraag) en stel je vraag opnieuw.',
  'skills.analysis.selectOne':
    'Om dit volledig te analyseren heb ik één document nodig. Nu geselecteerd: {count}, dus ik ' +
    'zie alleen een paar tekstdelen verspreid over die documenten. Selecteer één document (of ' +
    'noem de bestandsnaam in je vraag) en stel je vraag opnieuw.',
  'skills.analysis.selectTwo':
    'Selecteer precies **twee** documenten (of twee versies) om te vergelijken. Nu geselecteerd: ' +
    '{count}. Kies de twee die je wilt vergelijken en stel je vraag opnieuw.',
  'skills.redactionRouting.answer':
    'Klik op de knop **{button}** vlak boven het berichtvak om persoonsgegevens in dit document ' +
    'onleesbaar te maken, en kies daarna waar de kopie moet worden opgeslagen. De actie draait ' +
    'volledig op dit apparaat en maakt persoonsgegevens in een duidelijk herkenbare notatie ' +
    'onleesbaar (e-mailadressen, telefoonnummers, IBAN’s, datums en links); daarbij wordt het ' +
    'hele document gelezen. Het is een eerste ronde naar beste vermogen, zonder garantie: namen ' +
    'en ongebruikelijke notaties worden niet herkend, dus controleer de opgeslagen kopie voordat ' +
    'je die deelt.',
  'skills.redactionRouting.answerMulti':
    'Klik op de knop **{button}** vlak boven het berichtvak om persoonsgegevens in een document ' +
    'onleesbaar te maken, kies welk document het moet zijn en kies daarna waar de kopie moet ' +
    'worden opgeslagen. De actie werkt met één document tegelijk, draait volledig op dit ' +
    'apparaat en maakt persoonsgegevens in een duidelijk herkenbare notatie onleesbaar ' +
    '(e-mailadressen, telefoonnummers, IBAN’s, betaalkaartnummers, datums en links); daarbij ' +
    'wordt het hele document gelezen. Het is een eerste ronde naar beste vermogen, zonder ' +
    'garantie: namen en ongebruikelijke notaties worden niet herkend, dus controleer de ' +
    'opgeslagen kopie voordat je die deelt.',
  'skills.editRouting.answer':
    'Klik op de knop **{button}** vlak boven het berichtvak om deze wijzigingen aan te brengen, en ' +
    'kies daarna waar de bewerkte kopie moet worden opgeslagen. De actie draait volledig op dit ' +
    'apparaat en voert alleen de exacte wijzigingen met zoeken en vervangen uit waar je om hebt ' +
    'gevraagd: overal waar de tekst letterlijk voorkomt, terwijl al het andere ongewijzigd blijft. ' +
    'Het document wordt nooit herschreven, dus er kan niets worden verzonnen of anders geformuleerd. ' +
    'Een Word-document blijft .docx; andere indelingen worden als gewone tekst (.txt) opgeslagen. ' +
    'Controleer de kopie voordat je die deelt.',
  'skills.editRouting.answerMulti':
    'Klik op de knop **{button}** vlak boven het berichtvak, kies welk document je wilt bewerken en ' +
    'kies daarna waar de bewerkte kopie moet worden opgeslagen. De actie werkt met één document ' +
    'tegelijk, draait volledig op dit apparaat en voert alleen de exacte wijzigingen met zoeken en ' +
    'vervangen uit waar je om hebt gevraagd: overal waar de tekst letterlijk voorkomt, terwijl al ' +
    'het andere ongewijzigd blijft. Het document wordt nooit herschreven. Een Word-document blijft ' +
    '.docx; andere indelingen worden als gewone tekst (.txt) opgeslagen. Controleer de kopie voordat ' +
    'je die deelt.',
  'skills.redactionRouting.scan':
    'Ik heb het hele document doorzocht op persoonsgegevens in een duidelijk herkenbare notatie. ' +
    'Gevonden – e-mailadressen: {email}, telefoonnummers: {phone}, IBAN’s: {iban}, ' +
    'betaalkaartnummers: {card}, datums: {date}, links: {url}. Dit is een zoektocht op patronen ' +
    'naar beste vermogen: namen, postadressen en ongebruikelijke notaties worden niet herkend, ' +
    'dus zie deze aantallen als een minimum, niet als een volledig overzicht. Wil je een kopie ' +
    'waarin deze gegevens onleesbaar zijn gemaakt, klik dan op de knop **{button}** vlak boven ' +
    'het berichtvak en kies waar je die kopie wilt opslaan.',
  // ---- Models (ModelsScreen.tsx) ----
  'models.title': 'AI-model',
  'models.library.title': 'Modelbibliotheek',
  'models.library.view': 'Weergave van de modelbibliotheek',
  'models.library.onDrive': 'Op deze schijf',
  'models.library.browse': 'Modellen bekijken',
  'models.library.search': 'Modellen zoeken',
  'models.library.searchPlaceholder': 'Naam, familie of variant…',
  'models.library.task': 'Taak',
  'models.library.allTasks': 'Alle taken',
  'models.library.family': 'Familie',
  'models.library.allFamilies': 'Alle families',
  'models.library.familyNotInView': '{name} (geen modellen in deze weergave)',
  'models.library.resetFamily': 'Alle families',
  'models.library.noFamilyForTask':
    'Er passen geen modellen van de familie {family} bij deze taak.',
  'models.library.noFamilyOnDrive.one':
    'Er staan geen modellen van de familie {family} op deze schijf. “Modellen bekijken” toont ' +
    '{count} model.',
  'models.library.noFamilyOnDrive.other':
    'Er staan geen modellen van de familie {family} op deze schijf. “Modellen bekijken” toont ' +
    '{count} modellen.',
  'models.library.chat': 'Chat',
  'models.library.translation': 'Vertaling',
  'models.library.images': 'Afbeeldingen',
  'models.library.voice': 'Spraak',
  'models.library.memory': 'Minimaal geheugen: {size}',
  'models.library.clear': 'Filters wissen',
  'models.library.showVariants': 'Alle varianten tonen ({count})',
  'models.library.hideVariants': 'Minder varianten tonen ({count})',
  'models.library.results.one': '{count} passende variant',
  'models.library.results.other': '{count} passende varianten',
  'models.library.noMatches':
    'Er passen geen modellen bij deze filters. Probeer een andere zoekopdracht of wis de filters.',
  'models.library.noneInstalled': 'Er staan nog geen gebruiksklare modellen op deze schijf.',
  'models.library.onlyActive':
    'Je geïnstalleerde model staat hierboven. Bekijk de catalogus om alternatieven te vinden.',
  'models.library.noAlternatives': 'Er staan geen andere modellen in deze catalogus.',
  'models.library.download': 'Huidige modeldownload',
  'models.lead':
    'Het AI-model beantwoordt je vragen, volledig op dit apparaat. Alles wordt vóór gebruik ' +
    'gecontroleerd, en er wordt niets gedownload zonder je uitdrukkelijke bevestiging.',
  'models.loadError': 'De modellen konden niet worden geladen: {error}',
  'models.checking':
    'Modelbestanden controleren… De eerste controle na het toevoegen of bijwerken van een model ' +
    'kan bij grote bestanden een paar minuten duren; daarna wordt het resultaat onthouden en ' +
    'gaat dit meteen.',
  'models.checkingProgress': 'Model {n} van {m} wordt gecontroleerd: {name} – {pct}%',
  'models.state.installed': 'Geïnstalleerd',
  'models.state.missing': 'Niet gedownload',
  'models.state.checksumFailed': 'Niet controleerbaar',
  'models.state.unsupported': 'Niet ondersteund',
  'models.state.notRecommended': 'Niet aanbevolen',
  'models.state.ready': 'Klaar',
  'models.state.running': 'Draait',
  'models.badge.notResponding': 'Reageert niet',
  'models.notRespondingHint':
    'Het AI-model antwoordt niet meer. Meestal lost opnieuw starten dit op.',
  'models.restart': 'Opnieuw starten',
  'models.hint.embeddings': 'Bereidt je documenten voor, zodat je er vragen over kunt stellen.',
  'models.hint.reranker':
    'Verbetert welke tekstdelen uit documenten voor antwoorden worden gebruikt.',
  'models.hint.transcriber':
    'Zet geluidsopnamen om in doorzoekbare tekst en maakt in de chat de dicteerknop 🎤 ' +
    'beschikbaar.',
  'models.hint.translation': 'Vertaalt je documenten en tekst tussen talen, volledig offline.',
  'models.hint.vision':
    'Beantwoordt je vragen over één afbeelding tegelijk. Dit model leest geen PDF’s en maakt ' +
    'scans niet doorzoekbaar.',
  'models.hint.small': 'Klein en snel: vlotte antwoorden op bijna elke computer.',
  'models.hint.balanced': 'Gebalanceerd: werkt goed op de meeste laptops.',
  'models.hint.large': 'Groot: de sterkste antwoorden; heeft een krachtige computer nodig.',
  'models.usesSpace': 'Gebruikt {size} op de schijf',
  'models.downloads.blockedByPolicy':
    'Downloads zijn uitgeschakeld door het beleid van deze schijf.',
  'models.downloads.enableInSettings':
    'Zet “Internettoegang toestaan voor downloads en updates” aan in Instellingen om te downloaden.',
  'models.download.verifying': 'Het gedownloade bestand wordt gecontroleerd…',
  'models.download.progress': 'Downloaden… {pct}% ({received} van {total})',
  'models.download.progressNoTotal': 'Downloaden… tot nu toe {received}',
  'models.download.cancel': 'Download annuleren',
  'models.download.cancelled':
    'Download geannuleerd: bij een nieuwe start gaat de download verder waar die gestopt is.',
  'models.download.stoppedNetworkOff':
    'Gestopt omdat internettoegang is uitgezet. Staat internettoegang weer aan, dan gaat de ' +
    'download bij een nieuwe start verder waar die gestopt is.',
  'models.download.unverifiedBefore':
    'Gedownload, maar het manifest van dit model heeft nog geen echte controlesom, dus het ' +
    'bestand blijft niet-gecontroleerd. Maak er een aan met ',
  'models.download.unverifiedAfter': '.',
  'models.download.otherRunning':
    'Er loopt al een andere download: modellen worden één voor één gedownload',
  'models.download.titled': '{name} downloaden ({size})',
  'models.download.resume': 'Download hervatten',
  'models.download.start': 'Downloaden',
  'models.download.failed': 'Het downloaden van {name} is niet gelukt.',
  'models.download.retry': 'Download opnieuw proberen',
  'models.download.dismiss': 'Verbergen',
  'models.download.retryUnavailable':
    'Dit model wordt hier niet meer aangeboden om te downloaden, dus vanuit dit resultaat kan de ' +
    'download niet opnieuw worden geprobeerd. Verberg dit resultaat, of zoek het model in de ' +
    'modelbibliotheek.',
  'models.download.retryInstalled': 'Staat al op deze schijf.',
  'models.download.withdrawn':
    'Niet meer beschikbaar om te downloaden: de uitgever heeft precies dit bestand verwijderd ' +
    '({reason}). Kopieën die al op een schijf staan, blijven werken en blijven controleerbaar.',
  'models.engine.title': 'De AI-engine installeren',
  'models.engine.explain':
    'Modellen draaien in een ingebouwde demomodus (met zichtbaar gesimuleerde antwoorden) totdat ' +
    'de AI-engine is geïnstalleerd; voor dicteren is de spraakengine nodig. Installeer de ' +
    'engines één keer en start daarna een model voor echte antwoorden.',
  'models.engine.install': 'AI-engine installeren',
  'models.engine.retry': 'Opnieuw proberen',
  'models.engineProblem.title': 'De AI-engine kan op deze computer niet draaien',
  'models.engineProblem.voiceTitle': 'De spraakengine kan op deze computer niet draaien.',
  'models.engineProblem.libraryMissingPackage':
    'Er ontbreekt een systeembibliotheek die de engine nodig heeft: {library}. Installeer het ' +
    'pakket {debPackage} (Ubuntu, Debian, Linux Mint) of {rpmPackage} (Fedora) met je ' +
    'softwarebeheer of een terminal, en kies daarna “Opnieuw controleren”.',
  'models.engineProblem.libraryMissing':
    'Er ontbreekt een systeembibliotheek die de engine nodig heeft: {library}. Installeer die ' +
    'bibliotheek met je softwarebeheer of een terminal, en kies daarna “Opnieuw controleren”.',
  'models.engineProblem.systemTooOldLinux':
    'De engine heeft een nieuwere Linux-versie nodig: Ubuntu 22.04, Debian 12, Fedora 36 of ' +
    'nieuwer.',
  'models.engineProblem.systemTooOldMac':
    'De engine heeft een nieuwere versie van macOS nodig. Werk macOS bij en kies daarna “Opnieuw ' +
    'controleren”.',
  'models.engineProblem.systemTooOld':
    'De engine heeft een nieuwere versie van het besturingssysteem nodig.',
  'models.engineProblem.vcRuntimeMissing':
    'Windows mist de Microsoft Visual C++ Redistributable (x64) die de engine nodig heeft. ' +
    'Installeer de Redistributable en kies daarna “Opnieuw controleren”.',
  'models.engineProblem.filesDamaged':
    'Een deel van de bestanden van de engine op deze schijf ontbreekt of is beschadigd. In de ' +
    'handleiding voor probleemoplossing staat hoe je de engine opnieuw instelt.',
  'models.engineProblem.filesDamagedReinstall':
    'Een deel van de bestanden van de engine op deze schijf ontbreekt of is beschadigd. ' +
    'Installeer de engine opnieuw om die bestanden te vervangen.',
  'models.engineProblem.filesDamagedAfterInstall':
    'De engine is net geïnstalleerd en kan nog steeds niet starten, dus de bestanden zijn ' +
    'waarschijnlijk niet de oorzaak. In de handleiding voor probleemoplossing staat wat je ' +
    'verder kunt controleren.',
  'models.engineProblem.filesDamagedAfterInstallWin':
    'De engine is net geïnstalleerd en kan nog steeds niet starten, dus de bestanden zijn ' +
    'waarschijnlijk niet de oorzaak. Een verouderde Microsoft Visual C++ Redistributable (x64) ' +
    'kan dit ook veroorzaken: installeer de actuele versie en kies daarna “Opnieuw controleren”.',
  'models.engineProblem.reinstall': 'AI-engine opnieuw installeren',
  'models.engineProblem.voiceReinstall': 'Spraakengine opnieuw installeren',
  'models.engineProblem.reinstalled': 'De AI-engine is opnieuw geïnstalleerd.',
  'models.engineProblem.voiceReinstalled': 'De spraakengine is opnieuw geïnstalleerd.',
  'models.engineUpdate.title': 'Er is een update voor de AI-engine beschikbaar',
  'models.engineUpdate.voiceTitle': 'Er is een update voor de spraakengine beschikbaar',
  'models.engineUpdate.bothTitle':
    'Er zijn updates voor de AI-engine en de spraakengine beschikbaar',
  'models.engineUpdate.explain':
    'Op deze schijf staat een oudere versie dan waarvoor deze app is gemaakt. De update ' +
    'downloadt eerst de nieuwe versie; daarna pauzeren de modellen een paar seconden terwijl de ' +
    'bestanden worden vervangen, en start het geselecteerde model opnieuw.',
  'models.engineUpdate.update': 'Bijwerken',
  'models.engineUpdate.done': 'De AI-engine is bijgewerkt.',
  'models.engineUpdate.voiceDone': 'De spraakengine is bijgewerkt.',
  'models.engineUpdate.bothDone': 'De AI-engine en de spraakengine zijn bijgewerkt.',
  'models.engineProblem.blocked':
    'De Windows-beveiliging heeft de engine geblokkeerd (Slim app-beheer of je ' +
    'antivirusprogramma). In de handleiding voor probleemoplossing staat wat je kunt doen.',
  'models.engineProblem.demoNote':
    'Tot dan antwoorden modellen in demomodus: de antwoorden worden gesimuleerd.',
  'models.engineProblem.check': 'Opnieuw controleren',
  'models.engineProblem.checking': 'Controleren…',
  'models.engineProblem.stillFailing':
    'De engine kan nog steeds niet starten. Controleer of de installatie is voltooid en probeer ' +
    'het dan opnieuw.',
  'models.engineProblem.fixed': 'De AI-engine draait weer.',
  'models.engineProblem.voiceFixed': 'De spraakengine draait weer.',
  'models.engine.progress': 'AI-engine downloaden… {pct}%',
  'models.engine.downloadingNoTotal': 'AI-engine downloaden…',
  'models.engine.verifying': 'AI-engine controleren…',
  'models.engine.extracting': 'AI-engine uitpakken…',
  'models.voiceEngine.title': 'Dicteerfunctie toevoegen (optioneel)',
  'models.voiceEngine.explain':
    'Antwoorden in chats en over documenten werken op deze schijf al. De spraakengine is ' +
    'optioneel: installeer die alleen als je berichten met je microfoon wilt dicteren.',
  'models.voiceEngine.install': 'Spraakengine installeren',
  'models.packTools.row': 'Hulpprogramma’s voor kennispakketten: niet geïnstalleerd',
  'models.packTools.install': 'Installeren…',
  'models.ocr.row': 'Tekstherkenning voor scans en foto’s (optioneel)',
  'models.ocr.rowOrientation':
    'Voor het rechtop zetten van gedraaide scans is nog één OCR-bestand nodig (optioneel)',
  'ocr.install.action': 'OCR-bestanden downloaden',
  'ocr.install.actionTitle':
    'De taalbestanden voor tekstherkenning (OCR) downloaden voor scans en foto’s',
  'ocr.install.confirm.title': 'De OCR-bestanden downloaden?',
  'ocr.install.confirm.explain':
    'Tekstherkenning (OCR) leest gescande PDF’s en gefotografeerde pagina’s op deze computer. ' +
    'Daarvoor zijn de onderstaande bestanden op deze schijf nodig: verder wordt er niets ' +
    'gedownload, en je documenten verlaten deze computer nooit.',
  'ocr.install.confirm.languages': 'Bestanden',
  'ocr.install.confirm.hint':
    'Elk bestand wordt vóór gebruik gecontroleerd met de verwachte controlesom.',
  'ocr.install.confirm.start': 'Downloaden',
  'ocr.install.lang.deu': 'Duits',
  'ocr.install.lang.eng': 'Engels',
  'ocr.install.lang.osd': 'Paginaoriëntatie (zet gedraaide pagina’s rechtop)',
  'ocr.install.starting': 'Download starten…',
  'ocr.install.progress': 'OCR-bestanden downloaden… {pct}%',
  'ocr.install.verifying': 'OCR-bestanden controleren…',
  'ocr.install.activating': 'Tekstherkenning starten…',
  'ocr.install.failed': 'De OCR-bestanden konden niet worden geïnstalleerd.',
  'ocr.install.retry': 'OCR-download opnieuw proberen',
  'ocr.install.cancel': 'OCR-download annuleren',
  'ocr.install.alreadyPresent':
    'De OCR-bestanden staan al op deze schijf. Start HilbertRaum opnieuw om ze te gebruiken.',
  'ocr.install.outcome.activated': 'De tekstherkenning is klaar: opnieuw starten is niet nodig.',
  'ocr.install.outcome.restartRequired':
    'De OCR-bestanden staan klaar. Start HilbertRaum opnieuw om de nieuwe taalbestanden te ' +
    'gebruiken.',
  'ocr.install.outcome.unchanged':
    'De OCR-bestanden staan klaar. Wordt tekstherkenning nog steeds niet aangeboden, start ' +
    'HilbertRaum dan opnieuw.',
  'models.ram.needs': 'Heeft minstens {min}\u00A0GB RAM nodig',
  'models.ram.machine': ' – deze computer heeft ongeveer {ram}\u00A0GB',
  'models.ram.advice': '. Kies een kleiner model: de kwaliteit blijft uitstekend.',
  'models.badge.active': 'Actief',
  'models.badge.recommended': 'Aanbevolen voor deze computer',
  'models.badge.ramNeeded': '≥{min}\u00A0GB RAM nodig',
  'models.automatic.installed':
    'Geïnstalleerd: wordt automatisch gebruikt. Er is niets te starten.',
  'models.automatic.notInstalled':
    'Wordt na installatie automatisch gebruikt: je hoeft niets in te stellen.',
  'models.transcriber.engineUnsupported':
    'Op dit besturingssysteem kan de app de spraakengine nog niet installeren, dus met dit model ' +
    'zijn dicteren en het importeren van audio hier niet mogelijk.',
  'models.vision.installed':
    'Geïnstalleerd: wordt automatisch gebruikt op het scherm Afbeeldingen. Hier is niets te ' +
    'starten.',
  'models.vision.notInstalled':
    'Wordt na installatie automatisch gebruikt op het scherm Afbeeldingen: je hoeft niets in te ' +
    'stellen.',
  'models.vision.goToImages': 'Naar Afbeeldingen',
  'models.translation.installed':
    'Geïnstalleerd: wordt automatisch gebruikt om te vertalen. Hier is niets te starten.',
  'models.translation.notInstalled':
    'Wordt na installatie automatisch gebruikt om te vertalen: je hoeft niets in te stellen.',
  'models.use': 'Dit model gebruiken',
  'models.useTitle': 'Maak dit je model en start het, zodat je kunt chatten',
  'models.stopRuntime': 'Model stoppen',
  'models.answeringNote':
    'Er wordt een antwoord geschreven. Als je het model stopt of een ander model kiest, eindigt ' +
    'dat antwoord: de tekst tot nu toe blijft behouden.',
  'models.startMock': 'Uitproberen in demomodus',
  'models.starting': 'Starten…',
  'models.startingTitle': 'Dit model wordt geladen: bij grote modellen kan dat enige tijd duren',
  'models.startMockTitle':
    'Nog geen modelbestand: probeer de app uit in demomodus, met zichtbaar gesimuleerde ' +
    'antwoorden',
  'models.tech.summary': 'Technische details',
  'models.tech.id': 'Model-ID',
  'models.tech.family': 'Familie',
  'models.tech.format': 'Formaat',
  'models.tech.runtime': 'Engine',
  'models.tech.license': 'Licentie',
  'models.tech.sizeOnDisk': 'Grootte op schijf',
  'models.tech.minRam': 'Minimaal RAM',
  'models.tech.recRam': 'Aanbevolen RAM',
  'models.tech.context': 'Contextvenster',
  'models.tech.contextValue.one': '{count} token',
  'models.tech.contextValue.other': '{count} tokens',
  'models.tech.file': 'Bestand',
  // ---- Context-size picker (2026-07-04 user report — the truncation hint points here) ----
  'models.context.title': 'Contextgrootte',
  'models.context.label': 'Contextvenster voor antwoorden:',
  'models.context.auto': 'Automatisch – de aanbevolen grootte van het model',
  'models.context.autoResolved.one':
    'Automatisch – de aanbevolen grootte van het model ({count} token)',
  'models.context.autoResolved.other':
    'Automatisch – de aanbevolen grootte van het model ({count} tokens)',
  'models.context.bigWarning':
    'Zeer grote contextvensters hebben veel extra geheugen nodig terwijl het model draait. Op ' +
    'kleinere computers start het model dan mogelijk niet, of antwoordt het veel trager: kies in ' +
    'dat geval een kleinere grootte of “Automatisch”.',
  'models.context.hint':
    'Met een grotere context kan een gesprek of een antwoord over een document meer tekst ' +
    'tegelijk gebruiken, maar dat vraagt meer geheugen en kan antwoorden vertragen. Geldt vanaf ' +
    'de volgende keer dat een model start.',
  'models.context.restartHint':
    'Er draait nu een model: stop het model en start het opnieuw om de nieuwe grootte toe te ' +
    'passen.',
  'models.verifyTitle':
    'De SHA-256 van het bestand op de schijf opnieuw berekenen en met de verwachte waarde ' +
    'vergelijken (de cache wordt overgeslagen)',
  'models.verifying': 'Controleren…',
  'models.verify': 'Controlesom controleren',
  'models.verifyAll': 'Alle modelbestanden controleren',
  'models.verifyingAll': 'Alle modelbestanden controleren…',
  'models.verifyAllTitle':
    'Elk modelbestand op deze schijf opnieuw controleren met de SHA-256-controlesom',
  'models.verifyAllHint':
    'Elk model wordt bij het starten gecontroleerd. Met deze knop controleer je in plaats daarvan ' +
    'elk modelbestand op deze schijf: op een trage schijf kan de controle enkele minuten duren. Je ' +
    'kunt op elk moment stoppen; bestanden die al zijn gecontroleerd, blijven gecontroleerd.',
  'models.verifyAllStop': 'Controle stoppen',
  'models.verifyAllStopping': 'Stoppen…',
  'models.confirm.title': '{name} downloaden?',
  'models.confirm.start': 'Download starten',
  'models.confirm.size': 'Grootte',
  'models.confirm.license': 'Licentie',
  'models.confirm.from': 'Afkomstig van',
  'models.confirm.readLicense': 'Licentie lezen',
  'models.confirm.hint':
    'Het gedownloade bestand wordt vóór gebruik gecontroleerd. Dit is het enige netwerkverzoek ' +
    'dat de app doet: er wordt niets over jou of je documenten verstuurd.',
  'models.confirm.licenseAck':
    'Ik heb de licentievoorwaarden van dit model gelezen en ga ermee akkoord',
  'models.empty.title': 'Geen modelmanifesten gevonden',
  'models.empty.lineBefore': 'Plaats YAML-manifesten in de map ',
  'models.empty.lineAfter': ' op de schijf.',
  'models.section.yourModel': 'Je AI-model',
  'models.section.docSearch': 'Zoeken in documenten',
  // ---- Settings (SettingsScreen.tsx — chrome + the General tab) ----
  'settings.title': 'Instellingen',
  'settings.tabsAria': 'Onderdelen van Instellingen',
  'settings.tab.general': 'Algemeen',
  'settings.tab.privacy': 'Privacy en gegevens',
  'settings.tab.skills': 'Skills',
  'settings.tab.diagnostics': 'Diagnose (geavanceerd)',
  'settings.loading': 'Instellingen laden…',
  'settings.saved': 'Opgeslagen',
  'settings.saveFailed': 'Deze instelling kon niet worden opgeslagen. Probeer het opnieuw.',
  'settings.network.title': 'Privacy en offlinemodus',
  'settings.network.allow': 'Internettoegang toestaan voor downloads en updates',
  'settings.network.hint':
    'Standaard aan, zodat een nieuwe installatie meteen een model kan downloaden. Staat dit uit, ' +
    'dan maakt de app geen verbinding met internet. Zet je het aan, dan zijn downloads mogelijk ' +
    'voor modellen, de AI-engine, de optionele hulpprogramma’s voor kennispakketten en de ' +
    'optionele bestanden voor tekstherkenning (OCR). Elke download vraagt eerst om bevestiging, ' +
    'en een schijfbeleid kan downloads helemaal uitgeschakeld houden. Je vragen en documenten ' +
    'verlaten dit apparaat nooit, hoe deze instelling ook staat.',
  'settings.appearance.title': 'Weergave',
  'settings.appearance.aria': 'Thema',
  'settings.appearance.system': 'Systeem',
  'settings.appearance.light': 'Licht',
  'settings.appearance.dark': 'Donker',
  'settings.appearance.hint':
    '“Systeem” volgt de instelling voor licht of donker van je besturingssysteem. Het ' +
    'vergrendelingsscherm volgt altijd het systeemthema.',
  'settings.language.title': 'Taal',
  'settings.language.aria': 'Taal',
  'settings.language.system': 'Systeem',
  'settings.language.hint':
    '“Systeem” volgt de taal van je besturingssysteem als HilbertRaum die aanbiedt, en gebruikt ' +
    'anders Engels. Wijzigingen gelden meteen.',
  'settings.performance.title': 'Prestaties',
  'settings.performance.gpu': 'GPU-versnelling gebruiken',
  'settings.performance.gpuHint':
    'Gebruikt je grafische kaart om antwoorden te versnellen, als die beschikbaar is. Zet dit ' +
    'alleen uit als je stabiliteitsproblemen merkt: alles blijft hoe dan ook werken.',
  'settings.performance.rerankWideScope':
    'Meer tekstdelen uit kennispakketten opnieuw rangschikken',
  'settings.performance.rerankWideScopeHint':
    'Trager per vraag. Wordt alleen gebruikt op een computer met genoeg processorthreads en een ' +
    'geïnstalleerd rangschikkingsmodel; een computer met een bruikbare grafische kaart ' +
    'rangschikt elk tekstdeel al opnieuw.',
  'settings.performance.autoStart': 'Het geselecteerde model automatisch laden als de app start',
  'settings.performance.autoStartHint':
    'Standaard aan. Het model dat op het scherm AI-model is geselecteerd, wordt bij het starten ' +
    'op de achtergrond geladen (bij een versleutelde werkruimte na het ontgrendelen), zodat het ' +
    'scherm Chat zonder extra klikken klaarstaat.',
  // ---- Settings: Chat / conversation compaction (context-compaction plan §5.4) ----
  'settings.chat.title': 'Chat',
  'settings.chatCompaction.label': 'Oudere berichten samenvatten om context vrij te maken',
  'settings.chatCompaction.help':
    'Standaard aan. Als een lang gesprek de contextlimiet van het model nadert, worden de oudere ' +
    'berichten eenmalig samengevat in een compacte notitie – opgeslagen op deze schijf – in ' +
    'plaats van ongemerkt te worden weggelaten. Zet dit uit om alleen de nieuwste berichten te ' +
    'houden die passen.',
  'settings.developer.title': 'Ontwikkelaar',
  'settings.developer.toggle':
    'Ontwikkelaarsmodus (staat een onversleutelde werkruimte en niet-gecontroleerde modellen toe)',
  'settings.developer.hint':
    'Standaard uit. Ontwikkelversies tellen altijd als ontwikkelaar. Het schijfbeleid is ' +
    'bepalend: op een commerciële schijf worden niet-gecontroleerde modellen altijd geweigerd, ' +
    'hoe deze instelling ook staat.',
  'settings.workspace.title': 'Werkruimte',
  'settings.workspace.mode': 'Modus',
  'settings.workspace.modeEncrypted': 'Versleuteld',
  'settings.workspace.modePlaintext': 'Onversleuteld (ontwikkelaars)',
  'settings.workspace.contextTokens': 'Contextgrootte (tokens)',
  'settings.workspace.contextAuto':
    'Automatisch (standaard van het model) – wijzig dit op het scherm AI-model',
  'settings.workspace.encryptedHint':
    'Deze werkruimte is versleuteld opgeslagen. Gebruik “Vergrendelen” in de zijbalk om de ' +
    'werkruimte opnieuw te versleutelen en te vergrendelen; bij het afsluiten van de app gebeurt ' +
    'dat ook automatisch.',
  'settings.workspace.plaintextHint':
    'Onversleutelde ontwikkelaarswerkruimte: gegevens worden onversleuteld opgeslagen. De ' +
    'versleutelde modus is de standaard van de commerciële versie.',
  'settings.changePassword.title': 'Wachtwoord wijzigen',
  'settings.changePassword.hint':
    'Kies een nieuw wachtwoord voor deze werkruimte. Je gebruikt het vanaf de volgende keer dat ' +
    'je ontgrendelt. Het kan niet worden hersteld of opnieuw ingesteld, dus kies iets wat je ' +
    'onthoudt.',
  'settings.changePassword.current': 'Huidig wachtwoord',
  'settings.changePassword.new': 'Nieuw wachtwoord',
  'settings.changePassword.confirm': 'Nieuw wachtwoord bevestigen',
  'settings.changePassword.busy':
    'Je documenten worden met het nieuwe wachtwoord beschermd… Bij een grote verzameling ' +
    'documenten kan dit een paar minuten duren.',
  'settings.changePassword.failed': 'Er ging iets mis. Je huidige wachtwoord werkt nog steeds.',
  'settings.changePassword.submit': 'Wachtwoord wijzigen',
  'settings.changePassword.submitBusy': 'Wijzigen…',
  'settings.changePassword.toast': 'Wachtwoord gewijzigd',
  // ---- Skills (settings/SkillsTab.tsx, skills plan §15) ----
  'skills.intro':
    'Skills leren de assistent een bepaalde taak uit te voeren. Ze voegen aanwijzingen toe aan ' +
    'de antwoorden en hebben nooit toegang tot internet of tot andere mappen op je computer.',
  'skills.info.meeting-protocol.what':
    'Maakt van het volgende antwoord overzichtelijke notulen: besluiten, actiepunten en ' +
    'openstaande vragen.',
  'skills.info.meeting-protocol.needs':
    'Het transcript of de aantekeningen in deze chat (voeg het bestand bij of plak de tekst).',
  'skills.info.meeting-protocol.limits':
    'Werkt met één document tegelijk en legt alleen vast wat er echt in de aantekeningen staat.',
  'skills.info.contract-brief.what':
    'Vat een contract samen in begrijpelijke taal: partijen, datums, verplichtingen, belangrijke ' +
    'bepalingen en vragen die je kunt stellen.',
  'skills.info.contract-brief.needs': 'Het contract in deze chat.',
  'skills.info.contract-brief.limits':
    'Een leeshulp voor één document tegelijk, geen juridisch advies.',
  'skills.info.deadline-obligation-finder.what':
    'Vindt termijnen, opzegtermijnen, verlengings- en betaaldatums en de verplichtingen die ' +
    'erbij horen.',
  'skills.info.deadline-obligation-finder.needs': 'Het document in deze chat.',
  'skills.info.deadline-obligation-finder.limits':
    'Leest één document tegelijk; controleer belangrijke datums in het origineel voordat je ' +
    'ernaar handelt.',
  'skills.info.what-changed.what':
    'Vergelijkt twee versies van een document en meldt de wezenlijke wijzigingen, geen ruwe ' +
    'lijst met verschillen.',
  'skills.info.what-changed.needs': 'Precies twee documenten (of versies) in deze chat.',
  'skills.info.what-changed.limits':
    'Met meer of minder dan twee documenten in deze chat kan de skill niet vergelijken; je ' +
    'krijgt dan een gewoon antwoord.',
  'skills.info.share-safe-review.what':
    'Controleert een document voordat je het deelt: zichtbare gevoelige informatie en praktische ' +
    'risico’s van het delen.',
  'skills.info.share-safe-review.needs': 'Het document in deze chat.',
  'skills.info.share-safe-review.limits':
    'Alleen adviserend: de skill beweert nooit dat een document geanonimiseerd is of veilig kan ' +
    'worden gepubliceerd.',
  'skills.info.invoice.what':
    'Leest een factuur met exacte, controleerbare extractie: factuurregels en totalen, een ' +
    'controle van de totalen, export naar CSV, JSON of XML.',
  'skills.info.invoice.needs':
    'Een document in deze chat dat op een factuur lijkt; de acties van de skill verschijnen als ' +
    'knoppen vlak boven het berichtvak.',
  'skills.info.invoice.limits':
    'Eén factuur tegelijk; een totaal dat niet te controleren is, wordt als niet gecontroleerd ' +
    'gemeld en nooit verdoezeld.',
  'skills.info.bank-statement.what':
    'Leest een bankafschrift met exacte, controleerbare extractie: transacties, categorieën, ' +
    'controle van de saldi, export naar CSV.',
  'skills.info.bank-statement.needs':
    'Een document in deze chat dat op een afschrift lijkt; de acties van de skill verschijnen ' +
    'als knoppen vlak boven het berichtvak.',
  'skills.info.bank-statement.limits':
    'Eén afschrift tegelijk; voor het categoriseren van transacties is een draaiend model nodig.',
  'skills.info.document-redaction.what':
    'Slaat een kopie van een document op waarin persoonsgegevens onleesbaar zijn gemaakt: ' +
    'herkenning op basis van regels voor e-mailadressen, nummers en datums, plus namen en ' +
    'adressen die het model vindt.',
  'skills.info.document-redaction.needs':
    'Het document in deze chat; de knop “Persoonsgegevens onleesbaar maken” verschijnt vlak ' +
    'boven het berichtvak.',
  'skills.info.document-redaction.limits':
    'Naar beste vermogen, nooit een garantie: zonder draaiend model werkt alleen de herkenning ' +
    'op basis van regels; Word-documenten blijven .docx, andere indelingen worden als .txt ' +
    'opgeslagen.',
  'skills.info.document-edit.what':
    'Voert exacte wijzigingen met zoeken en vervangen uit en slaat een bewerkte kopie op: je ' +
    'document wordt nooit herschreven.',
  'skills.info.document-edit.needs':
    'Een draaiend model, het document in deze chat en je opdracht (bijvoorbeeld “vervang X door ' +
    'Y”); de knop “Tekstwijzigingen toepassen” verschijnt vlak boven het berichtvak.',
  'skills.info.document-edit.limits':
    'Tekst die niet letterlijk wordt gevonden, wordt overgeslagen en gemeld; Word-documenten ' +
    'blijven .docx, andere indelingen worden als .txt opgeslagen.',
  'skills.autoFire.title': 'Een passende skill automatisch toepassen',
  'skills.autoFire.toggle': 'Een passende skill automatisch toepassen',
  'skills.autoFire.hint':
    'Als dit aanstaat, kan de app zelf een duidelijk passende skill van de app op een antwoord ' +
    'toepassen, zodat je die niet hoeft te kiezen. Alleen skills van de app, nooit skills die je ' +
    'zelf hebt gemaakt of geïmporteerd. Je ziet altijd welke skill is gebruikt, en je kunt die ' +
    'vraag ook zonder de skill laten beantwoorden. Standaard uit.',
  'skills.autoFire.on': 'Automatische skills aan',
  'skills.autoFire.off': 'Automatische skills uit',
  'skills.autoFire.saveFailed':
    'De instelling voor automatische skills kon niet worden opgeslagen.',
  'skills.import': 'Skill importeren…',
  'skills.import.menuAria': 'Een skill importeren',
  'skills.import.fromFile': 'Uit een bestand (.skill.zip)…',
  'skills.import.fromFolder': 'Uit een map…',
  'skills.loading': 'Skills laden…',
  'skills.loadFailed': 'De skills konden niet worden geladen.',
  'skills.reconcile.folderErrors.one':
    '{count} skillmap kon niet worden gelezen en wordt overgeslagen. De SKILL.md in die map ' +
    'ontbreekt, is ongeldig of is niet leesbaar.',
  'skills.reconcile.folderErrors.other':
    '{count} skillmappen konden niet worden gelezen en worden overgeslagen. Elke map heeft een ' +
    'geldige SKILL.md nodig.',
  'skills.empty.title': 'Nog geen skills',
  'skills.empty.line':
    'Skills leren de assistent een bepaalde taak uit te voeren. Voeg een skill toe om te ' +
    'beginnen.',
  'skills.trusted.app': 'App',
  'skills.trusted.user': 'Zelf gemaakt',
  'skills.row.enableLabel': 'Ingeschakeld',
  'skills.row.on': 'Skill aan',
  'skills.row.off': 'Skill uit',
  'skills.row.onFailed': 'Deze skill kon niet worden ingeschakeld.',
  'skills.row.offFailed': 'Deze skill kon niet worden uitgeschakeld.',
  'skills.dup.chip': 'Dubbele naam',
  'skills.dup.title':
    'Een andere geïnstalleerde skill gebruikt deze naam. Er kan maar één tegelijk actief zijn.',
  'skills.unavailable.chip': 'Bestanden ontbreken',
  'skills.unavailable.title': 'De bestanden van deze skill staan niet meer op de schijf.',
  'skills.incompatible.chip': 'Nieuwere app nodig',
  'skills.incompatible.title':
    'Deze skill heeft een nieuwere versie van de app nodig; werk de app bij om de skill in te ' +
    'schakelen.',
  'skills.review.chip': 'Nakijken',
  'skills.warn.title': 'Kijk na wat deze skill kan',
  'skills.warn.body':
    'Zelf gemaakt of geïmporteerd. Controleer wat de skill kan voordat je erop vertrouwt.',
  'skills.warn.ack': 'Begrepen',
  'skills.menu.aria': 'Opties voor de skill',
  'skills.menu.export': 'Exporteren…',
  'skills.menu.delete': 'Verwijderen',
  'skills.export.done': 'Skill geëxporteerd',
  'skills.export.failed': 'Deze skill kon niet worden geëxporteerd.',
  'skills.delete.title': 'Deze skill verwijderen?',
  'skills.delete.body':
    'Hiermee wordt de skill van de schijf verwijderd. Chats die de skill al hebben gebruikt, ' +
    'blijven werken.',
  'skills.delete.confirm': 'Verwijderen',
  'skills.delete.done': 'Skill verwijderd',
  'skills.delete.failed': 'Deze skill kon niet worden verwijderd.',
  'skills.detail.aria': 'Details van de skill',
  'skills.detail.version': 'Versie',
  'skills.detail.author': 'Auteur',
  'skills.detail.language': 'Taal',
  'skills.detail.kind': 'Type',
  'skills.kind.instruction': 'Aanwijzingen',
  'skills.kind.tool': 'Voert acties uit',
  'skills.tool.note':
    'Voorlopig voegt deze skill alleen aanwijzingen toe. De acties die de skill beschrijft, ' +
    'komen in een latere versie.',
  'skills.tool.note.active':
    'Als je erom vraagt, kan deze skill goedgekeurde lokale acties uitvoeren op een document dat ' +
    'je kiest. Acties die alleen lezen, kunnen ook automatisch worden uitgevoerd om je vraag te ' +
    'beantwoorden; alles wat een bestand schrijft of exporteert, vraagt altijd eerst je ' +
    'toestemming. De acties zien alleen dat document.',
  'skills.perm.heading': 'Wat deze skill kan',
  'skills.perm.canTitle': 'Deze skill kan:',
  'skills.perm.cannotTitle': 'Deze skill kan niet:',
  'skills.perm.can.instructions': 'Instructies toevoegen aan AI-antwoorden',
  'skills.perm.can.documents': 'Alleen documenten lezen die je kiest',
  'skills.perm.can.tools': 'Goedgekeurde lokale acties uitvoeren als je erom vraagt',
  'skills.perm.cannot.network': 'Verbinding maken met internet',
  'skills.perm.cannot.files': 'Andere mappen op je computer lezen',
  'skills.perm.cannot.scripts': 'Scripts uitvoeren of software installeren',
  'skills.tech.summary': 'Technische details',
  'skills.tech.id': 'Skill-ID',
  'skills.tech.installId': 'Installatie-ID',
  'skills.tech.source': 'Bron',
  'skills.tech.permissions': 'Rechten',
  'skills.import.title': 'Deze skill toevoegen?',
  'skills.import.confirm': 'Skill toevoegen',
  'skills.import.added': 'Skill toegevoegd',
  'skills.import.failedTitle': 'Deze skill kan niet worden toegevoegd',
  'skills.import.failed': 'Deze skill kon niet worden toegevoegd.',
  'skills.import.collision':
    'Er is al een skill met deze naam geïnstalleerd. Als je deze skill toevoegt, wordt de ' +
    'bestaande vervangen.',
  'skills.import.collisionApp':
    'Een skill van de app gebruikt deze naam al. Je skill wordt toegevoegd, maar blijft uit ' +
    'zolang de skill van de app aanstaat.',
  'skills.import.upgrade': 'Werkt de geïnstalleerde versie bij ({from} → {to}).',
  'skills.import.replace': 'Vervangt de geïnstalleerde versie ({version}).',
  'skills.import.downgrade': 'Deze versie is ouder dan de geïnstalleerde versie ({installed}).',
  'skills.import.downgradeBlocked':
    'Voor het installeren van een oudere versie is de ontwikkelaarsmodus nodig. Zet die aan in ' +
    'Instellingen → Algemeen om dit toe te staan.',
  'skills.import.error.notFound': 'De geselecteerde skill is niet gevonden.',
  'skills.import.error.notZipOrFolder':
    'Een skill moet een .skill.zip-bestand zijn of een map met een SKILL.md.',
  'skills.import.error.unreadableZip':
    'Het skillpakket kon niet als geldig zip-archief worden gelezen.',
  'skills.import.error.encryptedZip':
    'Het skillpakket gebruikt een zip-indeling die niet wordt ondersteund (versleuteld of ZIP64).',
  'skills.import.error.unsupportedCompression':
    'Het skillpakket gebruikt een compressiemethode die niet wordt ondersteund.',
  'skills.import.error.pathTraversal':
    'Het pakket bevat een bestand met een pad dat buiten de map van het pakket wijst.',
  'skills.import.error.absolutePath':
    'Het pakket bevat een bestand met een absoluut pad of een pad met een schijfletter.',
  'skills.import.error.invalidPath': 'Het pakket bevat een bestand met een ongeldig pad.',
  'skills.import.error.symlink':
    'Het pakket bevat een symbolische koppeling, en dat is niet toegestaan.',
  'skills.import.error.tooDeep': 'In het pakket zijn mappen dieper genest dan is toegestaan.',
  'skills.import.error.pathTooLong': 'Het pakket bevat een bestandspad dat te lang is.',
  'skills.import.error.tooManyFiles': 'Het pakket bevat meer bestanden dan is toegestaan.',
  'skills.import.error.tooLarge': 'Het pakket is groter dan de toegestane grootte.',
  'skills.import.error.fileTooLarge':
    'Een bestand in het pakket is groter dan de toegestane grootte.',
  'skills.import.error.duplicatePath':
    'Het pakket bevat twee bestanden die naar hetzelfde pad leiden.',
  'skills.import.error.badExtension': 'Het pakket bevat een bestandstype dat niet is toegestaan.',
  'skills.import.error.nestedArchive':
    'Het pakket bevat een ingesloten archief, en dat is niet toegestaan.',
  'skills.import.error.noSkillMd': 'Het pakket bevat geen bestand SKILL.md.',
  'skills.import.error.invalidManifest': 'Het manifest van de skill is ongeldig.',
  'skills.import.error.idMismatch': 'De ID van de skill is geen geldige naam.',
  'skills.import.error.downgradeBlocked':
    'Er is al een nieuwere versie van deze skill geïnstalleerd. Zet de ontwikkelaarsmodus aan om ' +
    'een oudere versie te installeren.',
  'skills.import.error.appReadOnly':
    'Skills van de app kunnen niet worden gewijzigd of verwijderd.',
  'skills.import.error.locked': 'Ontgrendel de werkruimte om skills te beheren.',
  'skills.import.note.permissionNotString':
    'Het recht “{field}” is geen tekstwaarde; de standaardwaarde “{value}” wordt gebruikt.',
  'skills.import.note.permissionUnrecognized':
    'Het recht “{field}” heeft een waarde die deze app niet herkent; de standaardwaarde ' +
    '“{value}” wordt gebruikt.',
  'skills.import.note.permissionClamped':
    'De skill vraagt voor “{field}” meer toegang dan deze app toestaat; de toegang is beperkt ' +
    'tot “{value}”.',
  'skills.import.note.listInvalid':
    'De lijst “{field}” is geen lijst met teksten en wordt genegeerd.',
  'skills.import.note.listItemsTooLong':
    'Sommige vermeldingen in “{field}” zijn te lang en worden genegeerd.',
  'skills.import.note.listTruncated':
    'Het veld “{field}” heeft meer vermeldingen dan is toegestaan; alleen de eerste {max} ' +
    'blijven behouden.',
  'skills.import.note.languageInvalid':
    'Het veld “language” bevat geen geldige taalcode; “en” wordt gebruikt.',
  'skills.import.note.allowedToolsIgnored':
    'De opgegeven acties worden genegeerd voor een skill met aanwijzingen (acties komen in een ' +
    'latere versie).',
  'skills.import.note.analysisInvalid':
    'Het veld “analysis” heeft een onbekende waarde en wordt genegeerd.',
  'skills.import.note.analysisIgnoredForTool':
    'Het veld “analysis” wordt genegeerd voor een skill die acties uitvoert (de app bepaalt zelf ' +
    'hoe die skill met het hele document omgaat).',
  'skills.import.note.triggersInvalid': 'Het blok “triggers” is ongeldig en wordt genegeerd.',
  'skills.import.note.autoFireInvalid':
    'Het veld “triggers.autoFire” moet true of false zijn; het wordt als false behandeld.',
  'skills.import.note.localizedInvalid': 'Het blok “localized” is ongeldig en wordt genegeerd.',
  'skills.import.note.localizedLocaleInvalid':
    'Een vermelding in “localized” heeft een ongeldige taalcode en wordt genegeerd.',
  'skills.import.note.localizedEntryInvalid':
    'Een vermelding in “localized” is ongeldig en wordt genegeerd.',
  'skills.import.note.localizedTitleIgnored':
    'Een vertaalde titel is genegeerd (die moet uit één korte regel bestaan).',
  'skills.import.note.localizedDescriptionIgnored':
    'Een vertaalde beschrijving is genegeerd (die moet uit één korte regel bestaan).',
  'skills.import.note.localizedTooMany':
    'Het blok “localized” bevat meer talen dan is toegestaan; alleen de eerste {max} blijven ' +
    'behouden.',
  'skills.import.note.trustIgnored':
    'Een veld “trust” in de skill wordt genegeerd; de app bepaalt het vertrouwensniveau zelf.',
  'skills.import.note.manifestJsonConflict':
    'Het veld “{field}” in de meegeleverde manifest.json wijkt af van SKILL.md; SKILL.md wordt ' +
    'gebruikt.',
  'skills.replace.title': 'In plaats daarvan deze skill gebruiken?',
  'skills.replace.body':
    'Er staat al een andere skill met deze naam aan. Als je deze skill inschakelt, wordt de ' +
    'andere uitgeschakeld.',
  'skills.replace.confirm': 'Inschakelen',
  // ---- Settings → Privacy & data tab (PrivacyTab.tsx) ----
  'privacy.offlineOn': '● Offlinemodus: aan',
  'privacy.offlineOff': '○ Netwerktoegang ingeschakeld',
  'privacy.statement.offline':
    'De offlinemodus staat aan. HilbertRaum draait het AI-model op deze computer. Je vragen, ' +
    'documenten, embeddings en chatgeschiedenis blijven lokaal.',
  'privacy.statement.online':
    'HilbertRaum draait het AI-model op deze computer. Je vragen, documenten, embeddings en ' +
    'chatgeschiedenis blijven lokaal. Ook als internettoegang is ingeschakeld, gebruiken alleen ' +
    'downloads het netwerk: modellen, de AI-engine, de optionele hulpprogramma’s voor ' +
    'kennispakketten en de optionele bestanden voor tekstherkenning (OCR).',
  'privacy.statement.noUploads':
    'Deze app stuurt je gegevens niet naar AI-aanbieders in de cloud. Er worden geen vragen, ' +
    'documenten of embeddings geüpload, en er is geen telemetrie, geen gebruiksanalyse en geen ' +
    'crashrapportage op afstand.',
  'privacy.network.title': 'Huidige netwerkstatus',
  'privacy.networkState.noPolicy': 'De offlinemodus staat aan.',
  'privacy.networkState.disabledByPolicy': 'Netwerktoegang uitgeschakeld door beleid.',
  'privacy.networkState.offDefault':
    'De offlinemodus staat aan (internettoegang is in Instellingen uitgezet).',
  'privacy.networkState.enabled':
    'Internettoegang is ingeschakeld voor downloads: modellen, de AI-engine, de optionele ' +
    'hulpprogramma’s voor kennispakketten en de optionele bestanden voor tekstherkenning (OCR).',
  'privacy.network.noFiles': 'Geen vragen of bestanden verlaten dit apparaat.',
  'privacy.network.effective': 'Werkelijke status',
  'privacy.network.effectiveOffline': 'Offline (geen internetverbindingen)',
  'privacy.network.effectiveAllowed': 'Netwerk toegestaan',
  'privacy.network.byPolicy': 'Toegestaan door beleid',
  'privacy.network.policyYes': 'Ja',
  'privacy.network.policyNo': 'Nee (uitgeschakeld door beleid)',
  'privacy.network.yourSetting': 'Je instelling',
  'privacy.network.settingAllowed': 'Internettoegang toegestaan',
  'privacy.network.settingOff': 'Uit',
  'privacy.network.telemetry': 'Telemetrie',
  'privacy.network.telemetryValue':
    'Niets verlaat dit apparaat: er is geen tracking om uit te zetten',
  'privacy.network.hint':
    'De app waarschuwt vóór elke actie op internet. Het enige wat de app ooit downloadt, zijn ' +
    'AI-modellen, de AI-engine, de optionele hulpprogramma’s voor kennispakketten en de ' +
    'optionele bestanden voor tekstherkenning (OCR). Voor elke download vraagt de app eerst je ' +
    'bevestiging, en elke download wordt vóór gebruik gecontroleerd. Dit staat standaard aan en ' +
    'kan op het tabblad “Algemeen” worden uitgezet. Een schijfbeleid kan dit helemaal ' +
    'uitschakelen. De lokale API hieronder is een aparte functie die je zelf moet inschakelen en ' +
    'die nooit internet gebruikt.',
  'privacy.data.title': 'Waar je gegevens staan',
  'privacy.data.driveRoot': 'Hoofdmap van de schijf',
  'privacy.data.workspace': 'Werkruimte',
  'privacy.data.models': 'Modellen',
  'privacy.data.logs': 'Logbestanden',
  'privacy.data.loading': 'Paden laden…',
  'privacy.data.hint':
    'Alles – geïmporteerde documenten, geëxtraheerde tekst, embeddings, chatgeschiedenis, ' +
    'gegenereerde uitvoer, instellingen – wordt lokaal in je werkruimte opgeslagen. Wil je alles ' +
    'verwijderen, verwijder dan de map van de werkruimte.',
  'privacy.logs.title': 'Alleen lokale logbestanden',
  'privacy.logs.hintBefore':
    'Debug- en diagnoselogbestanden worden naar een roterend bestand in de map voor logbestanden ' +
    'hierboven geschreven en worden ',
  'privacy.logs.never': 'nooit geüpload',
  'privacy.logs.hintAfter': '. Diagnose verstuurt niets van dit apparaat naar buiten.',
  'privacy.protection.title': 'Beveiliging van de werkruimte',
  'privacy.protection.encryptedBefore': 'Je werkruimte staat in de ',
  'privacy.protection.encryptedWord': 'versleutelde',
  'privacy.protection.encryptedAfter': ' modus.',
  'privacy.protection.plainBefore': 'Je werkruimte staat in de ',
  'privacy.protection.plainWord': 'onversleutelde ontwikkelaarsmodus',
  'privacy.protection.plainAfter':
    '. Bestanden worden onversleuteld op de schijf opgeslagen om de ontwikkeling te versnellen.',
  'privacy.protection.plainWarning':
    'De onversleutelde ontwikkelaarsmodus is niet de standaard van de commerciële versie. ' +
    'Commerciële schijven gebruiken de versleutelde modus: de sleutel is van het wachtwoord ' +
    'afgeleid en er wordt niets onversleuteld opgeslagen. Sla geen gevoelige documenten in de ' +
    'onversleutelde modus op een gedeelde of verwisselbare schijf op.',
  // ---- Settings → Privacy & data → "Local API" card (local-api wave P4) ----
  'settings.localApi.title': 'Lokale API',
  'settings.localApi.lead':
    'Laat andere programma’s op deze computer tekst naar je AI-model sturen en de antwoorden ' +
    'lezen. Dit staat uit totdat je het aanzet.',
  'settings.localApi.toggle': 'Andere apps op deze computer mijn AI-model laten gebruiken',
  'settings.localApi.hint':
    'De verbinding verlaat deze computer nooit: er wordt niets via internet verstuurd.',
  'settings.localApi.policyOff': 'Uitgeschakeld door het beleid van je schijf.',
  'settings.localApi.confirm.title': 'Andere apps je model laten gebruiken?',
  'settings.localApi.confirm.what':
    'Andere programma’s op deze computer kunnen dan tekst naar je AI-model sturen en de ' +
    'antwoorden lezen.',
  'settings.localApi.confirm.boundary':
    'Die programma’s kunnen je documenten, bestanden en gesprekken niet zien, en via HilbertRaum ' +
    'verlaat niets deze computer. Maar HilbertRaum kan niet bepalen wat een verbonden programma ' +
    'doet met de antwoorden die het ontvangt: controleer voordat je een app verbindt of die app ' +
    'gegevens opslaat of synchroniseert.',
  'settings.localApi.confirm.persists': 'Dit blijft aan totdat je het uitzet.',
  'settings.localApi.confirm.neverStored':
    'Verzoeken van andere apps worden beantwoord en daarna vergeten: ze worden niet in je ' +
    'chatgeschiedenis of logbestanden opgeslagen.',
  'settings.localApi.confirm.ack': 'Ik begrijp wat andere apps dan kunnen doen.',
  'settings.localApi.confirm.cta': 'Inschakelen',
  'settings.localApi.connect.title': 'Een andere app verbinden',
  'settings.localApi.connect.hint':
    'Plak deze twee waarden in de app die je wilt verbinden. De meeste apps noemen ze “base URL” ' +
    'en “API key”.',
  'settings.localApi.connect.address': 'Serveradres',
  'settings.localApi.connect.key': 'Toegangssleutel',
  'settings.localApi.connect.copy': 'Kopiëren',
  'settings.localApi.connect.copyAddressAria': 'Het serveradres kopiëren',
  'settings.localApi.connect.copyKeyAria': 'De toegangssleutel kopiëren',
  'settings.localApi.connect.copiedAddress': 'Serveradres gekopieerd.',
  'settings.localApi.connect.copiedKey':
    'Gekopieerd: het klembord wordt over een minuut automatisch gewist. De klembordgeschiedenis ' +
    'of de synchronisatie van Windows kan kopieën behouden.',
  'settings.localApi.connect.copyFailed': 'Kopiëren is niet gelukt. Probeer het opnieuw.',
  'settings.localApi.connect.noKey':
    'Er is geen toegangssleutel nodig zolang een sleutel niet verplicht is.',
  'settings.localApi.model.running': 'Er draait een model: andere apps kunnen antwoorden krijgen.',
  'settings.localApi.model.stopped':
    'Er draait geen model: andere apps krijgen een foutmelding totdat je een model start.',
  'settings.localApi.status.port': 'Bereikbaar via poort {port}.',
  'settings.localApi.status.served.one': 'Tot nu toe is {count} verzoek beantwoord.',
  'settings.localApi.status.served.other': 'Tot nu toe zijn {count} verzoeken beantwoord.',
  'settings.localApi.status.off': 'Niet actief.',
  'settings.localApi.busyWarning':
    'Een app gebruikt je model op dit moment. Als je hier tegelijk chat, kunnen beide trager ' +
    'worden: je eigen chat heeft altijd voorrang.',
  'settings.localApi.preemptedWarning':
    'Je eigen gebruik van HilbertRaum heeft zojuist het verzoek van een app onderbroken. De app ' +
    'kan het eenvoudig opnieuw proberen.',
  'settings.localApi.token.toggle': 'Toegangssleutel vereisen',
  'settings.localApi.token.hint': 'Aanbevolen: laat dit aanstaan.',
  'settings.localApi.token.confirm.title': 'Toegangssleutel uitschakelen?',
  'settings.localApi.token.confirm.body':
    'Zonder toegangssleutel kan elk programma op deze computer je AI-model gebruiken zonder te ' +
    'vragen. Laat dit aanstaan, tenzij een app echt geen sleutel kan invoeren.',
  'settings.localApi.token.confirm.cta': 'Uitschakelen',
  'settings.localApi.token.regenerate': 'Nieuwe sleutel aanmaken',
  'settings.localApi.token.regenerate.title': 'Nieuwe toegangssleutel aanmaken?',
  'settings.localApi.token.regenerate.body':
    'Apps die de oude sleutel gebruiken, werken pas weer als je de nieuwe sleutel erin plakt.',
  'settings.localApi.token.regenerate.cta': 'Nieuwe sleutel aanmaken',
  'settings.localApi.token.regenerated': 'Nieuwe toegangssleutel aangemaakt.',
  'settings.localApi.token.regenerateFailed':
    'Er kon geen nieuwe sleutel worden aangemaakt. Probeer het opnieuw.',
  'settings.localApi.port.label': 'Poortnummer',
  'settings.localApi.port.hint':
    'Wijzig dit alleen als een ander programma dit nummer al gebruikt. Tussen 1024 en 65535.',
  'settings.localApi.error.portInUse':
    'Een ander programma op deze computer gebruikt dit nummer al. Dat kan ook betekenen dat een ' +
    'ander programma zich voordoet als HilbertRaum: plak je toegangssleutel dus nergens voordat ' +
    'dit is opgelost. Wijzig het nummer (bijvoorbeeld {suggestion}) en schakel de lokale API ' +
    'opnieuw in; was er al een app verbonden, plak het nieuwe serveradres dan ook in die app.',
  'settings.localApi.error.startFailed':
    'De lokale API kon niet starten. Op het tabblad “Diagnose” staan de details.',
  // ---- Settings → Diagnostics tab (DiagnosticsTab.tsx) ----
  'diag.localOnly': 'Alleen lokale diagnose. Niets hiervan wordt ooit geüpload.',
  'diag.localApi.label': 'Lokale API',
  'diag.localApi.off': 'Uit',
  'diag.localApi.running': 'Aan · poort {port} · beantwoord: {served}, geweigerd: {rejected}',
  'diag.localApi.portInUse': 'Uit – het poortnummer is al in gebruik',
  'diag.localApi.startFailed': 'Uit – de API kon niet starten',
  'diag.audit.runtime_started': 'Model gestart',
  'diag.audit.runtime_stopped': 'Model gestopt',
  'diag.audit.runtime_crashed': 'Model onverwacht gestopt',
  'diag.audit.runtime_fallback': 'Compatibiliteitsmodus',
  'diag.audit.model_selected': 'Model geselecteerd',
  'diag.audit.model_verified': 'Controlesom van het model gecontroleerd',
  'diag.audit.model_download_started': 'Download gestart',
  'diag.audit.model_download_verified': 'Download gecontroleerd',
  'diag.audit.model_download_failed': 'Download mislukt',
  'diag.audit.document_imported': 'Document geïmporteerd',
  'diag.audit.document_reindexed': 'Document opnieuw geïndexeerd',
  'diag.audit.document_deleted': 'Document verwijderd',
  'diag.audit.document_task_completed': 'Documenttaak voltooid',
  'diag.audit.document_task_failed': 'Documenttaak mislukt',
  'diag.audit.document_exported': 'Document geëxporteerd',
  'diag.audit.summary_exported': 'Samenvatting geëxporteerd',
  'diag.audit.conversation_deleted': 'Gesprek verwijderd',
  'diag.audit.conversation_exported': 'Gesprek geëxporteerd',
  'diag.audit.message_table_exported': 'Tabel uit een antwoord geëxporteerd',
  'diag.audit.code_block_exported': 'Codeblok als bestand opgeslagen',
  'diag.audit.workspace_created': 'Werkruimte aangemaakt',
  'diag.audit.workspace_unlocked': 'Werkruimte ontgrendeld',
  'diag.audit.workspace_locked': 'Werkruimte vergrendeld',
  'diag.audit.workspace_unlock_failed': 'Ontgrendelen mislukt',
  'diag.audit.workspace_lock_failed': 'Vergrendelen mislukt (de werkruimte bleef open)',
  'diag.audit.workspace_password_changed': 'Wachtwoord van de werkruimte gewijzigd',
  'diag.audit.settings_changed': 'Instellingen gewijzigd',
  'diag.audit.local_api_toggled': 'Lokale API in- of uitgeschakeld',
  'diag.audit.policy_warning': 'Melding over het beleid',
  'diag.audit.offline_guard_violation': 'Netwerkpoging opgemerkt',
  'diag.audit.collection_created': 'Project aangemaakt',
  'diag.audit.collection_renamed': 'Naam van het project gewijzigd',
  'diag.audit.collection_archived': 'Archivering van het project gewijzigd',
  'diag.audit.collection_deleted': 'Project verwijderd',
  'diag.audit.documents_added_to_collection': 'Documenten aan een sectie of project toegevoegd',
  'diag.audit.documents_removed_from_collection': 'Documenten uit een sectie of project verwijderd',
  'diag.audit.document_lifecycle_changed': 'Levenscyclus van het document gewijzigd',
  'diag.audit.skill_imported': 'Skill geïmporteerd',
  'diag.audit.skill_deleted': 'Skill verwijderd',
  'diag.audit.skill_enabled': 'Skill ingeschakeld',
  'diag.audit.skill_disabled': 'Skill uitgeschakeld',
  'diag.audit.skill_run_started': 'Skillactie gestart',
  'diag.audit.skill_run_done': 'Skillactie voltooid',
  'diag.audit.skill_run_failed': 'Skillactie mislukt',
  'diag.audit.evidence_review_created': 'Beoordeling van de onderbouwing aangemaakt',
  'diag.audit.evidence_review_ready': 'Beoordeling van de onderbouwing afgerond',
  'diag.audit.evidence_review_deleted': 'Beoordeling van de onderbouwing verwijderd',
  'diag.audit.evidence_pack_exported': 'Onderbouwingspakket geëxporteerd',
  'diag.audit.knowledge_pack_added': 'Kennispakket toegevoegd',
  'diag.audit.knowledge_pack_removed': 'Kennispakket verwijderd',
  'diag.audit.knowledge_pack_article_saved': 'Artikel uit een kennispakket als document opgeslagen',
  'diag.accel.gpuFallbackName': 'Grafische kaart',
  'diag.accel.gpu': '{name} (GPU)',
  'diag.accel.mock': 'Ingebouwde demomodus',
  'diag.app.engine': 'AI-engine',
  'diag.app.voiceEngine': 'Spraakengine',
  'diag.engine.cannotRun': 'Draait niet – {reason}',
  'diag.engine.reason.libraryMissing': 'er ontbreekt een systeembibliotheek',
  'diag.engine.reason.systemTooOld': 'het systeem is te oud',
  'diag.engine.reason.filesDamaged': 'enginebestanden ontbreken of zijn beschadigd',
  'diag.engine.reason.filesDamagedAfterInstall':
    'enginebestanden zijn vlak na een nieuwe installatie als beschadigd gemeld',
  'diag.engine.reason.vcRuntimeMissing': 'de Visual C++-runtime ontbreekt',
  'diag.engine.reason.blocked': 'geblokkeerd door de Windows-beveiliging',
  'diag.accel.cpu': 'CPU',
  'diag.accel.gpuAvailable': '{name} (GPU beschikbaar)',
  'diag.app.title': 'App en engine',
  'diag.app.version': 'Appversie',
  'diag.app.unknown': 'onbekend',
  'diag.app.selectedModel': 'Geselecteerd model',
  'diag.app.noneSelected': 'geen model geselecteerd',
  'diag.app.profile': 'Hardwareprofiel',
  'diag.app.runtime': 'Engine',
  'diag.app.unknownModel': 'onbekend model',
  'diag.app.onPort': ' op 127.0.0.1:{port}',
  'diag.app.healthy': 'in orde',
  'diag.app.unhealthy': 'niet in orde',
  'diag.app.runtimeRunning': 'Draait – {model}{onPort} ({health})',
  'diag.app.stopped': 'Gestopt',
  'diag.app.acceleration': 'Versnelling',
  'diag.app.runtimeBuild': 'Geïnstalleerde engine',
  'diag.app.noInstallMarker': 'geen installatiemarkering (handmatig ingestelde schijf)',
  'diag.app.engineVersions': 'Engineversies',
  'diag.engineVersion.older': '{engine} {installed}, deze app verwacht {pinned}',
  'diag.engineVersion.newer': '{engine} {installed}, nieuwer dan deze app verwacht ({pinned})',
  'diag.engineVersion.unknown': '{engine}: geen versie vastgelegd, deze app verwacht {pinned}',
  'diag.engineVersion.cpuNet': 'CPU-reserveversie van {engine}',
  'diag.gpu.compat':
    'De AI-engine draait in de compatibiliteitsmodus: antwoorden worden met de CPU gegenereerd, ' +
    'en dat werkt op elke computer.',
  'diag.gpu.tryHint':
    'Als je het stuurprogramma van je grafische kaart hebt bijgewerkt, kun je de grafische kaart ' +
    'opnieuw proberen.',
  'diag.gpu.offHint':
    'GPU-versnelling staat uit in Instellingen. Zet de GPU-versnelling daar weer aan om de ' +
    'grafische kaart opnieuw te gebruiken.',
  'diag.gpu.tryAgain': 'GPU opnieuw proberen',
  'diag.gpu.tryFailed': 'Opnieuw proberen met de grafische kaart is niet gelukt: {error}',
  'diag.refresh': 'Vernieuwen',
  // ---- Performance screen (PerformanceScreen.tsx; benchmark.md "Performance screen") ----
  'perf.title': 'Prestaties',
  'perf.lead':
    'Hoe snel deze computer je AI-model draait, gemeten op dit apparaat. Er wordt niets ' +
    'verstuurd.',
  'perf.card.title': 'Deze computer',
  'perf.checkedAt': 'Gecontroleerd op {when}',
  'perf.notChecked': 'Nog niet gecontroleerd',
  'perf.otherMachine':
    'Dit resultaat is op een andere computer gemeten. Kies “Opnieuw controleren” om deze ' +
    'computer te meten.',
  'perf.report.otherComputer': 'Andere computer: {cpu}, {ram}\u00A0GB RAM',
  'perf.verdict.speed': 'Hier draait {model} met ongeveer {tps}\u00A0tok/s.',
  'perf.verdict.noSpeed':
    'Bij deze computer past {model} het best (op basis van: {basis}). De snelheid wordt gemeten ' +
    'zodra er een model heeft gedraaid.',
  'perf.basis.discrete': 'grafisch geheugen',
  'perf.basis.unified': 'gedeeld geheugen',
  'perf.basis.cpu': 'RAM',
  'perf.recommendation.atCheckTime': 'Aanbevolen op het moment van de controle',
  'perf.recommendation.next': 'Aanbevolen voor de volgende start',
  'perf.recommendation.nextOnThisComputer': 'Aanbevolen voor de volgende start op deze computer',
  'perf.verdict.noRecommendation': 'Er past nog geen model uit de catalogus bij deze computer.',
  'perf.verdict.notChecked':
    'Een korte controle meet het geheugen, de snelheid van de schijf en, zodra er een model ' +
    'draait, de generatiesnelheid.',
  'perf.verdict.driveFast': 'Modellen starten snel vanaf deze schijf.',
  'perf.verdict.driveSlow': 'Modellen starten traag vanaf deze schijf.',
  'perf.tile.speed': 'Snelheid',
  'perf.tile.speed.unit': 'tok/s',
  'perf.tile.speed.sub': 'Gemeten met {model} op {when}',
  'perf.tile.speed.approx':
    'Bij benadering: getelde tekstblokken, geen tijdmetingen van de AI-engine',
  'perf.tile.speed.chunks': 'tekstblokken: {chunks}',
  'perf.tile.speed.none': 'Nog niet gemeten',
  'perf.tile.speed.noneHint': 'Start een model en controleer dan opnieuw',
  'perf.tile.memory': 'Geheugen',
  'perf.tile.memory.unit': 'GB RAM',
  'perf.tile.memory.unified': 'Gedeeld geheugen',
  'perf.tile.memory.unifiedSub': 'Gedeeld door de processor en de grafische kernen',
  'perf.model.title': 'Je model',
  'perf.model.line.one': '{model} · {size}\u00A0GB op schijf · context van {context} tokens',
  'perf.model.line.other': '{model} · {size}\u00A0GB op schijf · context van {context} tokens',
  'perf.model.none': 'Nog geen model geselecteerd. Kies er een op het scherm AI-model.',
  'perf.model.need': 'Gebruikt {need}\u00A0GB met deze context.',
  'perf.model.needEstimate':
    'Heeft minstens {need}\u00A0GB nodig voor de modelgewichten, plus de contextcache, die bij de ' +
    'eerste start wordt gemeten.',
  'perf.model.gpu':
    'Past in het grafische geheugen ({budget}\u00A0GB): alle lagen op de GPU ({layers}).',
  'perf.model.gpuEstimate': 'Past waarschijnlijk in het grafische geheugen ({budget}\u00A0GB).',
  'perf.model.partial':
    'Grafisch geheugen: {budget}\u00A0GB. Lagen op de GPU: {gpuLayers} van {layers}; ongeveer ' +
    '{spill}\u00A0GB draait vanuit het RAM. Antwoorden zijn trager.',
  'perf.model.partialFree':
    'Lagen op de GPU: {gpuLayers} van {layers}; ongeveer {spill}\u00A0GB draait vanuit het RAM. Toen ' +
    'het model startte, was maar {free}\u00A0GB van de {budget}\u00A0GB op de kaart vrij, en de ' +
    'AI-engine houdt een veiligheidsmarge van {margin}\u00A0GB aan. Antwoorden zijn trager. Start ' +
    'het model opnieuw zodra de kaart vrij is.',
  'perf.model.partialMargin':
    'Lagen op de GPU: {gpuLayers} van {layers}; ongeveer {spill}\u00A0GB draait vanuit het RAM. De ' +
    'kaart was vrij ({free} van {budget}\u00A0GB), maar de AI-engine reserveert ook ' +
    '{working}\u00A0GB aan werkbuffers en een veiligheidsmarge van {margin}\u00A0GB, en verplaatst ' +
    'hele lagen van de kaart zodra het totaal de grens nadert. Antwoorden zijn trager.',
  'perf.model.partialMarginNoWorking':
    'Lagen op de GPU: {gpuLayers} van {layers}; ongeveer {spill}\u00A0GB draait vanuit het RAM. De ' +
    'kaart was vrij ({free} van {budget}\u00A0GB), maar de AI-engine reserveert ook werkbuffers en ' +
    'een veiligheidsmarge van {margin}\u00A0GB, en verplaatst hele lagen van de kaart zodra het ' +
    'totaal de grens nadert. Antwoorden zijn trager.',
  'perf.model.partialEstimate':
    'Grafisch geheugen: {budget}\u00A0GB. Ongeveer {spill}\u00A0GB zal vanuit het RAM draaien. ' +
    'Antwoorden zijn trager.',
  'perf.model.cpu': 'Draait op de processor vanuit het RAM ({budget}\u00A0GB).',
  'perf.model.cpuEstimate': 'Zal op de processor draaien vanuit het RAM ({budget}\u00A0GB).',
  'perf.model.unified':
    'Past in het gedeelde geheugen ({ram}\u00A0GB, waarvan maximaal {budget}\u00A0GB beschikbaar is ' +
    'voor het model).',
  'perf.model.unifiedEstimate':
    'Past waarschijnlijk in het gedeelde geheugen ({ram}\u00A0GB, waarvan maximaal {budget}\u00A0GB ' +
    'beschikbaar is voor het model).',
  'perf.model.tooLarge':
    'Te groot voor deze computer ({budget}\u00A0GB beschikbaar). Kies een kleiner model.',
  'perf.model.unknown':
    'Waar het model terechtkomt, wordt gemeten wanneer het voor het eerst op deze computer start.',
  'perf.model.unknownObserved': 'De AI-engine heeft niet gemeld waar het model terechtkwam.',
  'perf.model.perDrive':
    'De schijf houdt per model één meting bij, dus een start op een andere computer vervangt de ' +
    'meting die hier is gedaan.',
  'perf.model.measuredOther.one':
    'Eerder gemeten met een context van {context} tokens op {when}; de schatting hierboven geldt ' +
    'voor de huidige instellingen.',
  'perf.model.measuredOther.other':
    'Eerder gemeten met een context van {context} tokens op {when}; de schatting hierboven geldt ' +
    'voor de huidige instellingen.',
  'perf.model.runningOnCard': 'Draait op dit moment op de grafische kaart.',
  'perf.model.choose': 'Kleiner model kiezen',
  'perf.models.title': 'Modellen op deze computer',
  'perf.models.hint':
    'Chat en vertaling delen de grafische kaart. Afbeeldingen, zoeken in documenten en spraak ' +
    'draaien bewust op de processor, dus die kosten RAM en geen grafisch geheugen.',
  'perf.role.chat': 'Chat',
  'perf.role.translation': 'Vertaling',
  'perf.role.vision': 'Afbeeldingen',
  'perf.role.reranker': 'Zoeken in documenten (rangschikking)',
  'perf.role.embeddings': 'Zoeken in documenten (index)',
  'perf.role.transcriber': 'Spraak',
  'perf.models.row': '{model} · {size}\u00A0GB',
  'perf.models.rowNoSize': '{model}',
  'perf.models.none': 'Hiervoor is geen model geïnstalleerd.',
  'perf.models.device.gpu': 'grafische kaart',
  'perf.models.device.cpu': 'processor, bewust gekozen',
  'perf.models.device.processor': 'processor',
  'perf.models.loaded': 'nu geladen',
  'perf.models.notLoaded': 'niet geladen',
  'perf.models.lifetime.session': 'blijft geladen',
  'perf.models.lifetime.idle': 'wordt bij inactiviteit uit het geheugen gehaald',
  'perf.models.lifetime.per-use': 'draait alleen tijdens gebruik',
  'perf.models.split': 'lagen op de kaart: {gpuLayers} van {layers}',
  'perf.models.card':
    'Grafische kaart: chat {chat}\u00A0GB + vertaling {translation}\u00A0GB, van {vram}\u00A0GB.',
  'perf.models.cardReranker': 'Grafische kaart: rangschikking {reranker}\u00A0GB, van {vram}\u00A0GB.',
  'perf.models.cardBoth':
    'Beide staan op dit moment op de kaart. Het model dat als tweede startte, kreeg wat er over ' +
    'was en draait trager: stop en start dat model zodra het andere model uit het geheugen is ' +
    'gehaald.',
  'perf.models.ram':
    'Als alles tegelijk geladen is, is ongeveer {sum}\u00A0GB van {ram}\u00A0GB RAM nodig.',
  'perf.models.memory':
    'Als alles tegelijk geladen is, is ongeveer {sum}\u00A0GB nodig; voor modellen is ' +
    '{budget}\u00A0GB gedeeld geheugen beschikbaar.',
  'perf.models.ramTooMuch': 'Te veel tegelijk',
  'perf.models.ramOk': 'Past',
  'perf.place.gpu': 'Op de GPU',
  'perf.place.partial': 'Deels op de GPU',
  'perf.place.cpu': 'Op de processor',
  'perf.place.tooLarge': 'Te groot',
  'perf.place.unknown': 'Niet gemeten',
  'perf.tile.graphics': 'Grafisch geheugen',
  'perf.tile.graphics.unit': 'GB VRAM',
  'perf.tile.graphics.none': 'Geen bruikbare grafische kaart. Modellen draaien op de processor.',
  'perf.tile.graphics.engine':
    'De AI-engine kan op deze computer niet draaien, dus de grafische kaart kon niet worden ' +
    'gecontroleerd.',
  'perf.tile.graphics.off': 'GPU-versnelling staat uit. Modellen draaien op de processor.',
  'perf.tile.graphics.small': 'Minder dan {min}\u00A0GB: modellen draaien op de processor.',
  'perf.tile.graphics.integrated':
    'Geïntegreerd, gedeeld geheugen: modellen draaien op de processor.',
  'perf.tile.graphics.unitShared': 'GB gedeeld',
  'perf.tile.graphics.notRecorded': 'Bij die controle is de grafische kaart niet vastgelegd.',
  'perf.rating.usable': 'Bruikbaar',
  'perf.rating.small': 'Klein',
  'perf.rating.integrated': 'Geïntegreerd',
  'perf.rating.notRecorded': 'Niet vastgelegd',
  'perf.rating.none': 'Geen',
  'perf.rating.unknown': 'Onbekend',
  'perf.others.subGpu': '{cpu}, {ram}\u00A0GB RAM, {vram}\u00A0GB VRAM · {when}',
  'perf.tile.drive': 'Schijf',
  'perf.tile.drive.unit': 'MB/s lezen',
  'perf.tile.drive.load': 'Gemeten bij een modelstart op {when}: {gb}\u00A0GB gelezen',
  'perf.tile.drive.hash': 'Gemeten bij een bestandscontrole op {when}: {gb}\u00A0GB gelezen',
  'perf.tile.drive.none': 'Nog niet gemeten',
  'perf.tile.drive.noneHint': 'Wordt gemeten bij de eerste modelstart of bestandscontrole',
  'perf.rating.good': 'Goed',
  'perf.rating.slow': 'Traag',
  'perf.rating.fast': 'Snel',
  'perf.rating.pending': 'Volgt nog',
  'perf.rating.approx': 'Bij benadering',
  'perf.rating.slowDrive': 'Trage schijf',
  'perf.profile.TINY': 'Klein',
  'perf.profile.LITE': 'Licht',
  'perf.profile.BALANCED': 'Gebalanceerd',
  'perf.profile.PRO': 'Pro',
  'perf.profile.UNKNOWN': 'Onbekend',
  'perf.check': 'Deze computer controleren',
  'perf.checkAgain': 'Opnieuw controleren',
  'perf.running': 'Bezig…',
  'perf.startAndMeasure': '{model} starten en meten',
  'perf.contextSize': 'Contextgrootte wijzigen',
  'perf.copy': 'Rapport kopiëren',
  'perf.autoNote':
    'Wordt de eerste keer vanzelf uitgevoerd, en telkens wanneer deze schijf op een andere ' +
    'computer wordt aangesloten.',
  'perf.failed': 'De controle is niet gelukt: {error}',
  'perf.loadFailed': 'De nieuwste meetwaarden konden niet worden gelezen: {error}',
  'perf.retry': 'Opnieuw proberen',
  'perf.step.system': 'Hardware herkend',
  'perf.step.drive': 'Snelheid van de schijf',
  'perf.step.speed': 'Generatiesnelheid met {model}',
  'perf.step.speedSkipped': 'Generatiesnelheid (er draait geen model, overgeslagen)',
  'perf.step.hint': 'Ongeveer een halve minuut. Je kunt de app intussen blijven gebruiken.',
  'perf.running.background': 'Deze computer wordt op de achtergrond gecontroleerd.',
  'perf.step.state.done': '{step}: klaar',
  'perf.step.state.active': '{step}: bezig',
  'perf.step.state.todo': '{step}: wacht',
  'perf.observed.title': 'Waargenomen tijdens je werk',
  'perf.observed.hint':
    'Echte meetwaarden uit normaal gebruik, geen testvraag. Deze rijen blijven staan tot het ' +
    'einde van deze sessie; de leessnelheden in deze rijen worden ook opgeslagen bij de ' +
    'meetwaarden van de schijf hierboven.',
  'perf.observed.none':
    'Nog niets waargenomen in deze sessie. Stel het model een vraag, of start het model.',
  'perf.observed.answer': 'Laatste antwoord: {tps}\u00A0tok/s, eerste token na {ttft}\u00A0s',
  'perf.observed.answerSub': '{model}, {when}, tokens: {tokens}',
  'perf.observed.load': 'Modelstart: {seconds}\u00A0s',
  'perf.observed.loadSub': '{model}, {gb}\u00A0GB gelezen van deze schijf met {mbps}\u00A0MB/s',
  'perf.observed.check': 'Bestandscontrole: {seconds}\u00A0s',
  'perf.observed.checkSub': 'Volledige bestandscontrole van {model} op {when}: {gb}\u00A0GB gelezen',
  'perf.observed.oncePerModel': 'Eenmaal per model',
  'perf.others.title': 'Andere computers waarop deze schijf is gebruikt',
  'perf.others.hint':
    'Voor elke computer wordt een eigen resultaat bijgehouden, zodat het aanbevolen model bij de ' +
    'computer hoort en niet bij de schijf.',
  'perf.others.none':
    'Nog geen. Sluit de schijf aan op een andere computer, dan voert de app daar vanzelf een ' +
    'controle uit.',
  'perf.others.row': '{tps}\u00A0tok/s met {model}',
  'perf.others.rowNoSpeed': 'Aanbevolen: {model}; snelheid niet gemeten',
  'perf.others.sub': '{cpu}, {ram}\u00A0GB RAM · {when}',
  'perf.others.load': 'modelstart {seconds}\u00A0s',
  'perf.others.check': 'bestandscontrole {seconds}\u00A0s',
  'perf.footer':
    'Het technische rapport met alle ruwe meetwaarden vind je in Instellingen → ' +
    'Diagnose.',
  'perf.footerLink': 'Naar Diagnose',
  'perf.unknownModel': 'het geladen model',
  'perf.unknownCpu': 'Onbekende CPU',
  'diag.bench.title': 'Prestatiecontrole',
  'diag.bench.hint':
    'De ruwe meetwaarden van de laatste controle op deze computer, voor een bericht aan de ' +
    'ondersteuning. Op het scherm Prestaties lees je wat ze betekenen en kun je een nieuwe ' +
    'controle uitvoeren. Alles wordt offline gemeten: er verlaten geen gegevens je computer.',
  'diag.bench.empty':
    'Er is op deze computer nog geen controle uitgevoerd. Open het scherm Prestaties om er een ' +
    'uit te voeren.',
  'diag.bench.profile': 'Toegewezen profiel',
  'diag.bench.noMatch': 'Geen passend model',
  'diag.bench.ram': 'RAM',
  'diag.bench.cpu': 'CPU',
  'diag.bench.cores.one': ' ({count} kern)',
  'diag.bench.cores.other': ' ({count} kernen)',
  'diag.bench.osArch': 'Besturingssysteem / architectuur',
  'diag.bench.gpu': 'GPU',
  'diag.bench.notDetected': 'niet gevonden',
  'diag.bench.effectiveRead': 'Gemeten leessnelheid',
  'diag.bench.effectiveReadNone': 'nog niet gemeten: wordt gemeten zodra je een model start',
  'diag.bench.effectiveReadLoad': 'gemeten bij een modelstart op {when}: {gb}\u00A0GB gelezen',
  'diag.bench.effectiveReadHash': 'gemeten bij een bestandscontrole op {when}: {gb}\u00A0GB gelezen',
  'diag.bench.driveWrite': 'Schrijfsnelheid van de schijf',
  'diag.bench.notMeasured': 'niet gemeten',
  'diag.bench.tokens': 'Generatiesnelheid (tokens per seconde)',
  'diag.bench.tokensNotMeasured': 'niet gemeten (start eerst een model)',
  'diag.bench.tokensModel': 'gemeten met het geladen model {model}',
  'diag.bench.tokensOver': 'tokens: {tokens}',
  'diag.bench.tokensApprox':
    'bij benadering – getelde tekstblokken, niet de tijdmeting van de engine',
  'diag.bench.lastRun': 'Laatst uitgevoerd',
  'diag.system.title': 'Systeem',
  'diag.system.osPlatform': 'Besturingssysteem / platform',
  'diag.system.freeSpace': 'Vrije ruimte',
  'diag.system.imagesSize': 'Grootte van de afbeeldingsgeschiedenis',
  'diag.system.loadFailed':
    'De systeemgegevens konden nog niet worden geladen. Probeer dit tabblad opnieuw te openen.',
  'diag.paths.title': 'Paden',
  'diag.paths.prepared': 'Voorbereide schijf',
  'diag.paths.yes': 'Ja',
  'diag.paths.noFallback': 'Nee (de map met appgegevens wordt gebruikt)',
  'diag.paths.writable': 'Beschrijfbaar',
  'diag.paths.no': 'Nee',
  'diag.paths.loadFailed':
    'De gegevens van de schijf en de werkruimte konden nog niet worden geladen. Probeer dit ' +
    'tabblad opnieuw te openen.',
  'diag.activity.title': 'Activiteit',
  'diag.activity.hint':
    'Een lokaal overzicht van wat de app heeft gedaan: modelstarts, downloads, geïmporteerde ' +
    'documenten, gebeurtenissen in de werkruimte. Het overzicht blijft in je werkruimte ' +
    '(versleuteld als de werkruimte dat is) en wordt nooit geüpload. Het bevat nooit chattekst ' +
    'of de inhoud van documenten.',
  'diag.activity.show': 'Activiteit tonen',
  'diag.activity.hide': 'Activiteit verbergen',
  'diag.activity.export': 'Naar bestand exporteren…',
  'diag.activity.savedTo': 'Activiteitenoverzicht opgeslagen als {path}',
  'diag.activity.filterShow': 'Tonen',
  'diag.activity.filterAll': 'Alle activiteit',
  'diag.activity.loading': 'Laden…',
  'diag.activity.empty':
    'Nog niets vastgelegd: activiteit verschijnt hier zodra je de app gebruikt.',
  'diag.activity.earlier': 'Eerdere activiteit tonen',
  'diag.logs.title': 'Recente logregels',
  'diag.logs.hintBefore': 'De laatste regels van ',
  'diag.logs.hintAfter':
    ' op dit apparaat. Logbestanden blijven lokaal en worden nooit geüpload; ze bevatten geen ' +
    'inhoud van documenten en geen chattekst.',
  'diag.logs.show': 'Logregels tonen',
  'diag.logs.hide': 'Logregels verbergen',
  'diag.logs.empty': '(het logbestand is leeg)',
  'diag.logs.save': 'Opslaan als bestand…',
  'diag.logs.savedTo': 'Logregels opgeslagen als {path}',
  'diag.copy': 'Kopiëren',
  'diag.copyTitle': 'Deze gegevens naar het klembord kopiëren',
  'diag.copied': 'Gekopieerd naar het klembord',
  'diag.copyFailed': 'Kopiëren naar het klembord is niet gelukt',
  // ---- Shared components' built-in copy (receive a bound t — i18n record §5 ⑤) ----
  'common.dismiss': 'Verbergen',
  'common.close': 'Sluiten',
  'common.cancel': 'Annuleren',
  'common.remove': 'Verwijderen',
  'common.apply': 'Toepassen',
  'common.labelValue': '{label}: {value}',
  'common.percent': '{pct}%',
  'indicator.offline': 'Lokaal · Offline',
  'indicator.online': 'Lokaal · Downloads toegestaan',
  'indicator.offlineDetail':
    'Alles blijft op deze schijf. Er wordt geen internetverbinding gebruikt.',
  'indicator.onlineDetail': 'Downloads toegestaan: chats en documenten blijven lokaal.',
  'indicator.short.offline': 'Offline',
  'indicator.short.online': 'Netwerk aan',
  'indicator.withLocalApi': '{state} · API aan',
  'indicator.localApiDetail':
    'Andere apps op deze computer kunnen je model gebruiken. Niets verlaat deze computer.',
  // ---- Shared password copy ----
  'password.mismatch': 'De wachtwoorden komen niet overeen.',
  'password.show': 'Wachtwoord tonen',
  'password.hide': 'Wachtwoord verbergen',
  'password.strength.tooShort': 'Te kort',
  'password.strength.weak': 'Zwak',
  'password.strength.okay': 'Oké',
  'password.strength.strong': 'Sterk',
  'password.strength.veryStrong': 'Zeer sterk',
  'password.strength.minHint': 'Gebruik minstens {min} tekens.',
  'password.strength.longerHint':
    'Langer is sterker: 12 of meer tekens, of een paar woorden zonder verband, werken goed.',
  // ---- Workspace gate (WorkspaceGate.tsx) ----
  'gate.passwordPlaceholder': 'Wachtwoord',
  'gate.unlock.title': 'Je werkruimte ontgrendelen',
  'gate.unlock.hint':
    'Voer je wachtwoord in om de werkruimte op deze schijf te openen. Alles blijft op deze ' +
    'schijf.',
  'gate.unlock.submit': 'Ontgrendelen',
  'gate.unlock.submitBusy': 'Ontgrendelen…',
  'gate.welcome.title': 'Welkom',
  'gate.welcome.intro':
    'Dit is je privéwerkruimte voor AI. Chat met een AI-model en stel vragen over je documenten: ' +
    'alles draait vanaf deze schijf.',
  'gate.welcome.stays': 'Alles blijft op deze schijf.',
  'gate.welcome.staysRest': 'Geen internet, geen account, geen tracking.',
  'gate.welcome.start': 'Beginnen',
  'gate.finishing.title': 'Alles wordt ingesteld…',
  'gate.finishing.hint':
    'Er wordt gecontroleerd wat er al op deze schijf staat. De eerste controle van een groot ' +
    'AI-modelbestand kan een paar minuten duren.',
  'gate.finishing.progress': 'AI-model {n} van {m} wordt gecontroleerd: {name} – {pct}%',
  'gate.finishing.skip': 'Overslaan – naar de app',
  'gate.starter.title': 'Nog één ding',
  'gate.starter.noModel':
    'Er is nog geen AI-model op deze schijf geïnstalleerd: de chat heeft een model nodig om te ' +
    'antwoorden. Je kunt nu een model toevoegen, of later op elk moment via het scherm AI-model.',
  'gate.starter.optional':
    'Een model downloaden is optioneel en vraagt altijd eerst om je bevestiging. Je documenten ' +
    'en chats gebruiken hoe dan ook nooit internet.',
  'gate.starter.skip': 'Nu overslaan',
  'gate.starter.addDocuments': 'Documenten toevoegen',
  'gate.starter.chooseModel': 'Je AI-model kiezen',
  'gate.create.title': 'Je wachtwoord aanmaken',
  'gate.create.hint':
    'Dit wachtwoord vergrendelt alles in je werkruimte op deze schijf: documenten, chats en ' +
    'notities. Het kan niet worden hersteld of opnieuw ingesteld, dus kies iets wat je onthoudt.',
  'gate.create.plaintextToggle':
    'Een onversleutelde ontwikkelaarswerkruimte gebruiken (geen versleuteling)',
  'gate.create.plaintextWarning':
    'De onversleutelde modus slaat je gegevens zonder versleuteling op deze schijf op. Gebruik ' +
    'deze modus alleen voor ontwikkeling.',
  'gate.create.confirmPlaceholder': 'Wachtwoord bevestigen',
  'gate.create.back': 'Terug',
  'gate.create.submit': 'Werkruimte aanmaken',
  'gate.create.submitBusy': 'Aanmaken…',
  'gate.error.generic': 'Er ging iets mis. Probeer het opnieuw.',
  // ---- Main-process strings (Phase 41, i18n record §3.3 two-rule boundary) --------------
  'main.ingest.pdfScanDetected':
    'Dit PDF-bestand lijkt een scan te zijn: er staat nog geen leesbare tekst in.',
  'main.ingest.audioNeedsTranscriber':
    'Voor het importeren van audio is het transcriptiemodel nodig: download het op het scherm ' +
    'AI-model.',
  'main.ingest.audioNeedsEngine':
    'Voor het importeren van audio is de spraakengine nodig: installeer die op het scherm ' +
    'AI-model.',
  'main.ingest.audioNeedsModelAndEngine':
    'Voor het importeren van audio zijn het transcriptiemodel en de spraakengine nodig: voeg ' +
    'beide toe op het scherm AI-model.',
  'main.ingest.audioEngineUnsupported':
    'Het importeren van audio is op dit besturingssysteem nog niet beschikbaar: de app kan de ' +
    'spraakengine die daarvoor nodig is hier niet installeren.',
  'main.ingest.audioUnreadable':
    'Dit audiobestand kon niet worden gelezen. Zet het om naar WAV of MP3 en importeer het ' +
    'opnieuw.',
  'main.ingest.audioTranscriptionFailed':
    'De opname kon niet worden getranscribeerd. Indexeer dit document opnieuw om het nog eens te ' +
    'proberen.',
  'main.ingest.engineCannotRun':
    'De AI-engine kan op deze computer niet draaien, dus dit document kon niet worden ' +
    'geïndexeerd. Op het scherm AI-model staat wat je kunt doen. Probeer het daarna opnieuw.',
  'main.ingest.engineLibraryMissing':
    'De AI-engine kan op deze computer niet draaien, omdat de systeembibliotheek {library} ' +
    'ontbreekt. Op het scherm AI-model staat hoe je dit oplost. Probeer het daarna opnieuw.',
  'main.ingest.voiceEngineCannotRun':
    'De spraakengine kan op deze computer niet draaien, dus deze opname kon niet worden ' +
    'getranscribeerd. Op het scherm AI-model staat wat je kunt doen. Indexeer dit document ' +
    'daarna opnieuw.',
  'main.ingest.searchModelTimeout':
    'Het zoekmodel reageerde niet op tijd, dus dit document kon niet worden geïndexeerd. Probeer ' +
    'het opnieuw.',
  'main.ingest.searchModelCannotStart':
    'Het zoekmodel kon niet starten, dus dit document kon niet worden geïndexeerd. Kies op het ' +
    'scherm AI-model “Alle modelbestanden controleren” en probeer het daarna opnieuw.',
  'main.ingest.searchModelFailed':
    'Er ging iets mis met het zoekmodel, dus dit document kon niet worden geïndexeerd. Probeer ' +
    'het opnieuw.',
  'main.ingest.imageNeedsOcr':
    'Voor het importeren van foto’s zijn de bestanden voor tekstherkenning (OCR) nodig, maar die ' +
    'staan niet op deze schijf.',
  'main.ingest.imageNoText':
    'Er is geen leesbare tekst in deze foto gevonden. Probeer een scherpere foto van de pagina, ' +
    'van dichterbij genomen.',
  'main.ingest.imageOcrFailed':
    'Deze foto kon niet worden gelezen. Indexeer de foto opnieuw om het nog eens te proberen.',
  'main.ingest.imageOcrUnavailable':
    'Tekstherkenning (OCR) kon in deze versie niet draaien, dus deze foto is zonder leesbare ' +
    'tekst opgeslagen. Indexeer de foto opnieuw zodra OCR beschikbaar is.',
  'main.ingest.sourceMissing': 'Het bestand is niet op de schijf gevonden.',
  'main.ingest.interrupted':
    'Het importeren is onderbroken voordat het klaar was. Indexeer het document opnieuw om het ' +
    'nog eens te proberen.',
  'main.ingest.fileTooLarge':
    'Dit bestand is te groot om veilig te importeren. Splits het in kleinere bestanden en ' +
    'probeer het opnieuw.',
  'main.ingest.tooManyChunks':
    'Dit document is te groot om volledig te indexeren. Splits het in kleinere bestanden en ' +
    'importeer de delen.',
  'main.ingest.parseTimeout':
    'Het verwerken van dit bestand duurde te lang, dus het is overgeslagen. Mogelijk is het ' +
    'bestand beschadigd of extreem groot.',
  'main.ingest.unsupportedType':
    'Dit bestandstype wordt niet ondersteund ({ext}). Probeer TXT, PDF, DOCX, CSV of een ' +
    'ondersteund audioformaat.',
  'main.rag.noContext':
    'Ik kon dit niet vinden in je documenten. Probeer je vraag anders te formuleren, of ' +
    'controleer aan welke documenten je de vraag stelt.',
  'main.rag.reindexNeeded':
    'Je documenten moeten eerst kort opnieuw worden geïndexeerd voordat je erin kunt zoeken: de ' +
    'documenten zijn met een ander zoekmodel geïndexeerd. Ga naar het scherm Documenten en kies ' +
    '“Opnieuw indexeren”.',
  'main.chat.docTaskBusy':
    'Er is een documenttaak bezig. Je kunt de taak annuleren, of wachten tot die klaar is ' +
    'voordat je chat.',
  'main.chat.defaultTitle': 'Nieuwe chat',
  'main.evidenceReviews.defaultTitle': 'Beoordeling van de onderbouwing',
  'main.benchmark.warnTiny':
    'Dit apparaat is het meest geschikt voor het kleinste, snelste model. Grotere modellen ' +
    'kunnen traag draaien.',
  'main.benchmark.warnUnknown':
    'We konden deze hardware niet volledig herkennen, dus we hebben een veilig, licht model ' +
    'gekozen. Je kunt altijd een groter model proberen.',
  'main.benchmark.warnDriveProbe':
    'De snelheid van de schijf kon niet worden gemeten, dus de aanbeveling is alleen gebaseerd ' +
    'op RAM en CPU.',
  'main.benchmark.warnSlowDrive':
    'Deze schijf is aan de trage kant. Modellen werken nog steeds, maar het laden kan langer ' +
    'duren.',
  'main.benchmark.warnSpeedSkipped':
    'De snelheid van de tekstgeneratie is deze keer niet gemeten, omdat het model met iets ' +
    'anders bezig was. Het profiel hieronder gebruikt alleen RAM, CPU en de snelheid van de ' +
    'schijf. Voer voor een volledige meting de prestatiecontrole opnieuw uit wanneer niets ' +
    'anders het model gebruikt.',
  'main.benchmark.warnSlowRead':
    'De gemeten leessnelheid van deze schijf is ongeveer {mbps}\u00A0MB/s. Bij het starten van een ' +
    'model wordt het hele modelbestand met die snelheid gelezen, dus modellen starten traag vanaf ' +
    'deze schijf.',
  'main.benchmark.warnVeryLowTokens':
    'De tekstgeneratie was erg traag met het geladen model ({model}), dus het toegewezen profiel ' +
    'is één niveau verlaagd. Is dat model groter dan het aanbevolen model, start dan het ' +
    'aanbevolen model en voer de prestatiecontrole opnieuw uit.',
  'main.benchmark.warnRecommendationLowered':
    'Bij de tekstgeneratie is ongeveer {tps}\u00A0tok/s gemeten met het geladen model ({model}), dus ' +
    'het aanbevolen model is één grootteklasse lager gezet, zodat antwoorden op deze computer snel ' +
    'blijven.',
  'main.benchmark.locked':
    'De werkruimte is vergrendeld. Ontgrendel de werkruimte om de prestatiecontrole uit te ' +
    'voeren.',
  'main.benchmark.lockedDuringRun':
    'De werkruimte is vergrendeld terwijl de prestatiecontrole liep, dus het resultaat is niet ' +
    'opgeslagen. Voer de prestatiecontrole opnieuw uit.',
  'main.dialog.openLink.title': 'Deze link in je browser openen?',
  'main.dialog.openLink.message': 'Deze link in je browser openen?',
  'main.dialog.openLink.site': 'Website: {site}',
  'main.dialog.openLink.truncated': 'De link is hier ingekort. Niet getoonde tekens: {hidden}.',
  'main.dialog.openLink.credentials':
    'Het adres bevat een gebruikersnaam: de website die echt wordt geopend, is die op de regel ' +
    '“Website”.',
  'main.dialog.openLink.hint':
    'Deze link komt uit een antwoord of een modelmanifest, niet van HilbertRaum. Je browser ' +
    'maakt verbinding met deze website.',
  'main.dialog.openLink.open': 'Openen',
  'main.dialog.openLink.cancel': 'Annuleren',
  'main.workspace.wrongPassword':
    'Met dat wachtwoord is je werkruimte niet ontgrendeld. Controleer het en probeer het opnieuw.',
  'main.workspace.openFailed': 'De werkruimte kon niet worden geopend.',
  'main.workspace.vaultDamaged':
    'Je wachtwoord klopt, maar de gegevens van de werkruimte op de schijf zijn beschadigd en ' +
    'konden niet worden geopend. Het wachtwoord opnieuw invoeren helpt niet. Maak geen nieuwe ' +
    'werkruimte aan: laat de bestanden zoals ze zijn en herstel de map van de werkruimte vanuit ' +
    'een back-up.',
  'main.workspace.recoveryBlocked':
    'De werkruimte kon nog niet worden geopend: een ander programma houdt een herstelbestand met ' +
    'je nieuwste gegevens vast. Sluit alles wat de schijf mogelijk scant (antivirus, ' +
    'zoekindexering, een bestandsvenster met de map van de werkruimte), wacht een moment en ' +
    'probeer het dan opnieuw. Er is niets verloren gegaan.',
  'main.workspace.newer':
    'Deze werkruimte is geschreven door een nieuwere versie van HilbertRaum: werk de app bij om ' +
    'de werkruimte te openen. Er is niets gewijzigd.',
  'main.workspace.createFailed': 'De werkruimte kon niet worden aangemaakt.',
  'main.workspace.passwordTooShort': 'Het wachtwoord moet minstens {min} tekens lang zijn.',
  'main.workspace.newPasswordTooShort':
    'Het nieuwe wachtwoord moet minstens {min} tekens lang zijn.',
  'main.workspace.unlockBeforeChange':
    'Ontgrendel de werkruimte voordat je het wachtwoord wijzigt.',
  'main.workspace.wrongCurrentPassword':
    'Dat komt niet overeen met je huidige wachtwoord. Controleer het en probeer het opnieuw.',
  'main.workspace.changeFailed':
    'Het wachtwoord kon niet worden gewijzigd. Je huidige wachtwoord werkt nog steeds.',
  'main.workspace.busyPasswordChange':
    'Het wachtwoord van de werkruimte wordt op dit moment gewijzigd. Probeer het zo meteen ' +
    'opnieuw.',
  'main.workspace.lockFailed':
    'Vergrendelen is niet gelukt: de werkruimte blijft open en je gegevens zijn veilig. Maak wat ' +
    'ruimte vrij op de schijf en probeer het dan opnieuw.',
  'main.runtime.compatibilityMode':
    'Voor de stabiliteit is overgeschakeld naar de compatibiliteitsmodus. Alles blijft werken; ' +
    'antwoorden kunnen iets trager zijn.',
  'main.runtime.speedUpDisabled':
    'Een optionele versnelling is voor de stabiliteit uitgezet. Het model start opnieuw: stuur ' +
    'je bericht nog een keer.',
  'main.runtime.crashRestarting':
    'Het AI-model is onverwacht gestopt en start opnieuw. Stuur je bericht zo meteen nog een ' +
    'keer.',
  'main.runtime.crashStopped':
    'Het AI-model is opnieuw onverwacht gestopt en is daarom niet opnieuw gestart. Je kunt het ' +
    'model weer starten op het scherm AI-model.',
  'main.runtime.modelCannotLoad':
    'Het model {model} kon op deze computer niet worden geladen: de antwoorden worden ' +
    'gesimuleerd totdat je een ander model kiest.',
  'main.runtime.engineCannotRun':
    'De AI-engine kan op deze computer niet draaien, dus de antwoorden worden gesimuleerd. Op ' +
    'het scherm AI-model staat wat er ontbreekt.',
  'main.engine.cannotRun':
    'De AI-engine kan op deze computer niet draaien. Op het scherm AI-model staat wat er ' +
    'ontbreekt.',
  'main.noModelRunning':
    'Er draait geen AI-model. Ga naar het scherm AI-model en start eerst een model.',
  'main.modelStarting': 'Het AI-model wordt gestart. Probeer het zo meteen opnieuw.',
  'main.translation.noModel':
    'Voor vertalen is het vertaalmodel nodig, maar dat is niet op deze schijf geïnstalleerd. Je ' +
    'kunt het downloaden op het scherm AI-model.',
  'main.translation.startFailed':
    'Het vertaalmodel kon niet starten: mogelijk is er op dit apparaat te weinig geheugen vrij. ' +
    'Sluit andere apps of start HilbertRaum opnieuw, en probeer het daarna nog eens.',
  'main.translation.failedWindowNotice':
    '> ⚠ Dit deel ({part} van {total}) kon niet worden vertaald: hieronder staat de ' +
    'oorspronkelijke tekst, ongewijzigd.',
  'main.translation.missingPageNotice':
    '> ⚠ Pagina {page} van het origineel kon niet worden vertaald: er staat geen leesbare tekst ' +
    'op (mogelijk een gescande afbeelding).',
  'main.translation.missingPageRangeNotice':
    '> ⚠ Pagina’s {from}–{to} van het origineel konden niet worden vertaald: er staat geen ' +
    'leesbare tekst op (mogelijk gescande afbeeldingen).',
  'main.translation.attributionLine':
    'Machinaal vertaald door het model {modelId}. De vertaling kan fouten bevatten.',
  'main.model.contextExceeded':
    'Dit is te groot voor het contextvenster van het huidige model. Vergroot de contextgrootte ' +
    'op het scherm AI-model (een vaste keuze begrenst de contextgrootte), of probeer een kleiner ' +
    'document.',
  'main.chat.streamInFlight': 'Voor dit gesprek wordt al een antwoord gegenereerd.',
  'main.chat.emptyCompletion':
    'Het model gaf een leeg antwoord. Probeer het opnieuw, of formuleer je bericht anders.',
  'main.chat.runtimeUnresponsive':
    'Het AI-model reageert niet meer. Probeer het opnieuw; gebeurt dit vaker, start het model ' +
    'dan opnieuw op het scherm AI-model.',
  'main.chat.connectionLost':
    'Het AI-model is gestopt voordat het antwoord klaar was. Verzend je bericht opnieuw; gebeurt ' +
    'dit vaker, start het model dan opnieuw op het scherm AI-model.',
  'main.chat.streamError':
    'Er is een fout opgetreden in het AI-model voordat het antwoord klaar was. Probeer het ' +
    'opnieuw; gebeurt dit vaker, start het model dan opnieuw op het scherm AI-model.',
  'main.chat.searchModelTimeout':
    'Het zoekmodel reageerde niet op tijd, dus je documenten konden niet worden doorzocht. ' +
    'Probeer het opnieuw.',
  'main.chat.searchModelCannotStart':
    'Het zoekmodel kon niet starten, dus je documenten konden niet worden doorzocht. Kies op het ' +
    'scherm AI-model “Alle modelbestanden controleren” en probeer het daarna opnieuw.',
  'main.chat.searchModelFailed':
    'Bij het zoekmodel is een probleem opgetreden, dus je documenten konden niet worden ' +
    'doorzocht. Probeer het opnieuw.',
  'main.chat.nothingToRegenerate': 'Er is nog niets om opnieuw te genereren.',
  'main.chat.nothingToResend':
    'Deze vraag is niet meer het laatste bericht in dit gesprek en kan daarom niet opnieuw ' +
    'worden verzonden.',
  'main.chat.skillUnavailable':
    'Deze skill is niet meer beschikbaar: de skill is uitgeschakeld of verwijderd. Schakel de ' +
    'skill in op het tabblad “Skills”, of stel je vraag opnieuw zonder skill.',
  'main.chat.reviewBlocksRegenerate':
    'Bij dit antwoord hoort een beoordeling van de onderbouwing. Opnieuw antwoorden zou de ' +
    'beoordeling met de beslissingen en notities erin verwijderen: stel je vraag in plaats ' +
    'daarvan opnieuw als nieuw bericht.',
  'main.chat.emptyMessage': 'Een leeg bericht kan niet worden verzonden.',
  'main.chat.emptyQuestion': 'Een lege vraag kan niet worden verzonden.',
  'main.chat.stopFirst':
    'Voor dit gesprek wordt nog een antwoord gegenereerd. Stop dat antwoord eerst.',
  'main.chat.locked': 'De werkruimte is vergrendeld. Ontgrendel de werkruimte om te chatten.',
  'main.busy.chat':
    'Er wordt op dit moment een antwoord geschreven. Wacht tot het klaar is (of stop het) en ' +
    'probeer het dan opnieuw.',
  'main.busy.docTask':
    'Een documenttaak gebruikt het model. Wacht tot de taak klaar is, of annuleer de taak, en ' +
    'probeer het dan opnieuw.',
  'main.busy.skillRun':
    'Er werkt een skill aan een document. Wacht tot de skill klaar is, of annuleer de skill in ' +
    'de actiebalk, en probeer het dan opnieuw.',
  'main.busy.benchmark':
    'Er wordt op dit moment een prestatiecontrole van deze computer uitgevoerd. Probeer het zo ' +
    'meteen opnieuw.',
  'main.task.unknownKind': 'Onbekende documenttaak.',
  'main.task.refusedChatStreaming':
    'Er wordt nu een antwoord geschreven. Wacht tot het klaar is (of stop het) en probeer het ' +
    'dan opnieuw.',
  'main.task.comparePickTwo': 'Kies precies twee documenten om te vergelijken.',
  'main.task.compareReindex':
    'Deze documenten moeten eerst kort opnieuw worden geïndexeerd voordat ze kunnen worden ' +
    'vergeleken: minstens één document is met een ander zoekmodel voorbereid. Ga naar het scherm ' +
    'Documenten, kies “Opnieuw indexeren” en probeer het daarna opnieuw.',
  'main.task.documentNotReady':
    'Dit document heeft nog geen leesbare tekst. Importeer het eerst, of indexeer het opnieuw, ' +
    'en probeer het dan nog eens.',
  'main.task.genericFailure':
    'De taak kon niet worden afgerond. Controleer of het model nog draait en probeer het dan ' +
    'opnieuw.',
  'main.task.expired': 'Deze taak is niet meer beschikbaar.',
  'main.task.translationTarget':
    'Kies voor de vertaling een ondersteunde brontaal en een andere doeltaal.',
  'main.task.sourceUnreadable':
    'De opgeslagen kopie van dit document kon niet worden gelezen. Importeer het document ' +
    'opnieuw en probeer het dan nog eens.',
  'main.task.needsOcr':
    'Voor tekstherkenning zijn de OCR-bestanden nodig, maar die staan niet op deze schijf. ' +
    'Download ze met “OCR-bestanden downloaden” bij het gescande document of op het scherm ' +
    'AI-model, of voeg ze op een schijf die je zelf hebt ingesteld toe met “fetch-runtime ' +
    '--family ocr”.',
  'main.task.ocrUnavailable':
    'Tekstherkenning (OCR) is in deze versie niet beschikbaar: de OCR-bestanden staan op deze ' +
    'schijf, maar de herkenning kon niet starten.',
  'main.task.ocrNotAScan':
    'Alleen een PDF-bestand dat als scan is herkend, of dat gescande pagina’s bevat, kan op deze ' +
    'manier doorzoekbaar worden gemaakt.',
  'main.task.ocrNoText':
    'Er is geen leesbare tekst in deze scan gevonden. Mogelijk zijn de pagina’s leeg of te ' +
    'onscherp.',
  'main.task.ocrFailed':
    'Deze scan kon niet worden gelezen. Controleer of het document nog op de schijf staat en ' +
    'probeer het dan opnieuw.',
  'main.task.documentBusyIngesting':
    'Dit document wordt nog geïmporteerd of opnieuw geïndexeerd. Wacht tot dat klaar is en ' +
    'probeer het dan opnieuw.',
  'main.task.pickOneTranslate': 'Kies precies één document om te vertalen.',
  'main.task.pickOneOcr': 'Kies precies één gescand PDF-bestand om doorzoekbaar te maken.',
  'main.task.pickOneSummarize': 'Kies precies één document om samen te vatten.',
  'main.task.unavailable': 'Documenttaken zijn niet beschikbaar.',
  'main.task.workspaceLocked':
    'De werkruimte is vergrendeld. Ontgrendel de werkruimte om met documenten te werken.',
  'main.download.policyDisabled': 'Downloads zijn uitgeschakeld door het beleid van deze schijf.',
  'main.download.networkOff':
    'Internettoegang staat uit. Zet eerst “Internettoegang toestaan voor downloads en updates” aan ' +
    'in Instellingen.',
  'main.download.alreadyRunning':
    'Er loopt al een andere download. Modellen worden één voor één gedownload.',
  'main.download.stoppedNetworkOff':
    'Internettoegang staat uit, dus de download die bezig was, is gestopt. Zet internettoegang ' +
    'weer aan in Instellingen om de download af te ronden.',
  'main.download.noSource': 'Het model “{modelId}” heeft geen downloadbron in het manifest.',
  'main.download.sourceWithdrawn':
    'De uitgever van het model “{modelId}” heeft precies dit bestand verwijderd, dus het kan ' +
    'niet meer worden gedownload ({reason}). Modellen die al op deze schijf staan, blijven ' +
    'werken.',
  'main.download.alreadyVerified': 'Dit model is al gedownload en gecontroleerd.',
  'main.download.presentUnverified':
    'Het bestand van dit model staat er al. Het manifest heeft nog geen echte controlesom, dus ' +
    'het bestand kan niet worden gecontroleerd. Maak er een aan met “verify-models --generate”.',
  'main.download.licenseFirst':
    'Bekijk eerst de licentie van het model ({license}) en ga ermee akkoord voordat je downloadt.',
  'main.download.notEnoughSpace':
    'Er is niet genoeg vrije ruimte op deze schijf: de download heeft {needed} nodig; vrije ' +
    'ruimte: {free}. Maak ruimte vrij op de schijf of kies een kleiner model.',
  'main.download.unknownJob': 'Onbekende download.',
  'main.download.checksumMismatch':
    'Het gedownloade bestand kwam niet overeen met de verwachte controlesom en is daarom ' +
    'verwijderd. Probeer het opnieuw.',
  'main.download.fileMissing':
    'Het gedownloade bestand was verdwenen voordat het kon worden gecontroleerd.',
  'main.download.httpFailed':
    'De download kon niet starten ({reason}). Controleer de verbinding en probeer het opnieuw.',
  'main.download.interrupted':
    'De download is onderbroken ({reason}). Het voltooide deel blijft behouden: bij een nieuwe ' +
    'start gaat de download verder waar die gestopt is.',
  'main.download.writeFailed':
    'Het modelbestand kon niet op deze schijf worden opgeslagen. Controleer of de schijf niet ' +
    'vol of schrijfbeveiligd is en probeer het opnieuw.',
  'main.download.resumeDiscarded':
    'De server stuurde het verkeerde deel van het bestand, dus de gedeeltelijke download is ' +
    'verwijderd. Bij een nieuwe start begint de download opnieuw vanaf het begin.',
  'main.engine.alreadyRunning': 'De AI-engine wordt al gedownload.',
  'main.engine.noSources':
    'Er zijn op deze schijf geen downloadbronnen voor de engine gevonden (runtime-sources.yaml ' +
    'ontbreekt).',
  'main.engine.noHostBuild': 'Er is geen versie van de AI-engine beschikbaar voor deze computer.',
  'main.engine.alreadyInstalled': 'De AI-engine is al geïnstalleerd.',
  'main.engine.unknownJob': 'Onbekende download van de engine.',
  'main.engine.checksumMismatch':
    'De gedownloade engine kwam niet overeen met de verwachte controlesom en is daarom ' +
    'verwijderd. Probeer het opnieuw.',
  'main.engine.fileMissing':
    'De gedownloade engine was verdwenen voordat die kon worden gecontroleerd.',
  'main.engine.unverifiablePlaceholder':
    'Deze downloadbron voor de AI-engine heeft geen echte controlesom, dus de download kon niet ' +
    'worden gecontroleerd en is niet geïnstalleerd. De schijf is mogelijk verkeerd ingesteld.',
  'main.engine.binaryMissing':
    'De engine is gedownload, maar kon niet worden uitgepakt (de indeling van het archief is ' +
    'mogelijk veranderd).',
  'main.engine.extractFailed':
    'De AI-engine is gedownload, maar kon niet worden uitgepakt. Probeer het opnieuw.',
  'main.engine.httpFailed':
    'De download van de engine kon niet starten ({reason}). Controleer de verbinding en probeer ' +
    'het opnieuw.',
  'main.engine.interrupted':
    'De download van de engine is onderbroken ({reason}). Probeer het opnieuw.',
  'main.engine.runtimeRunning':
    'De AI-engine kan niet worden vervangen terwijl er een model draait. Stop het model op het ' +
    'scherm AI-model en probeer het dan opnieuw.',
  'main.engine.transcriptionRunning':
    'De spraakengine kan niet worden vervangen terwijl er audio wordt getranscribeerd. Wacht tot ' +
    'dat klaar is en probeer het dan opnieuw.',
  'main.engine.knowledgePackToolsRunning':
    'De hulpprogramma’s voor kennispakketten kunnen niet worden vervangen terwijl er een ' +
    'kennispakket in gebruik is. Vergrendel de werkruimte of wacht tot de huidige vraag is ' +
    'beantwoord, en probeer het dan opnieuw. Blijft deze melding staan, start de app dan opnieuw.',
  'main.engine.badRequest':
    'Het verzoek om de engine te installeren werd niet begrepen. Probeer het opnieuw.',
  'main.engine.nothingToRepair':
    'Er is niets te herstellen: de engine op deze schijf is niet als beschadigd herkend.',
  'main.engine.nothingToUpdate':
    'Er is niets bij te werken: de engines op deze schijf hebben al de versie die deze app ' +
    'gebruikt, of een nieuwere.',
  'main.engine.updateBusy':
    'De AI-engine is op dit moment in gebruik (er is een antwoord, een import, een vertaling of ' +
    'een documenttaak bezig). Probeer de update opnieuw als dat klaar is.',
  'main.ocr.badRequest':
    'Het verzoek om de OCR-bestanden te downloaden werd niet begrepen. Probeer het opnieuw.',
  'main.ocr.alreadyRunning': 'De OCR-bestanden worden al gedownload.',
  'main.ocr.noSources':
    'Deze schijf heeft geen downloadlijst voor de OCR-bestanden. Voeg ze in plaats daarvan toe ' +
    'met de scripts voor het instellen van de schijf (“fetch-runtime --family ocr”).',
  'main.ocr.sourcesMismatch':
    'De downloadlijst voor de OCR-bestanden op deze schijf past niet bij deze versie van ' +
    'HilbertRaum, dus er is niets gedownload. Voeg de bestanden in plaats daarvan toe met de ' +
    'scripts voor het instellen van de schijf (“fetch-runtime --family ocr”).',
  'main.ocr.alreadyInstalled':
    'De OCR-bestanden staan al op deze schijf. Wordt tekstherkenning nog steeds niet aangeboden, ' +
    'start HilbertRaum dan opnieuw.',
  'main.ocr.unsafeFolder':
    'De map “ocr” op deze schijf is geen gewone map (de map verwijst mogelijk naar een andere ' +
    'locatie), dus er is niets weggeschreven. Vervang de map door een gewone map met de naam ' +
    '“ocr” en probeer het dan opnieuw.',
  'main.ocr.writeFailed':
    'De OCR-bestanden konden niet op deze schijf worden opgeslagen. Controleer of de schijf niet ' +
    'vol of schrijfbeveiligd is en probeer het dan opnieuw.',
  'main.ocr.downloadFailed':
    'De OCR-bestanden konden niet worden gedownload. Controleer de internetverbinding en probeer ' +
    'het dan opnieuw.',
  'main.ocr.checksumMismatch':
    'Een gedownload OCR-bestand kwam niet overeen met de verwachte controlesom en is daarom ' +
    'verwijderd: de bestanden die al op deze schijf stonden, zijn niet gewijzigd. Probeer het ' +
    'opnieuw.',
  'main.ocr.readFailed':
    'De OCR-bestanden die al op deze schijf staan, konden niet worden gelezen: mogelijk is de ' +
    'schijf losgekoppeld, of gebruikt een ander programma de bestanden. Controleer de schijf en ' +
    'probeer het dan opnieuw.',
  'main.ocr.unknownJob':
    'Deze OCR-download wordt niet meer gevolgd. Start de download opnieuw als de bestanden nog ' +
    'ontbreken.',
  'main.docs.locked':
    'De werkruimte is vergrendeld. Ontgrendel de werkruimte om documenten te beheren.',
  'main.docs.processing': 'Dit document wordt nog verwerkt. Wacht tot het importeren klaar is.',
  'main.docs.tooManyPaths':
    'Er zijn te veel bestanden tegelijk geselecteerd. Kies in plaats daarvan een map.',
  'main.docs.taskRunning':
    'Er loopt een taak voor dit document. Annuleer de taak of wacht tot die klaar is.',
  'main.docs.skillRunning':
    'Er werkt een skill aan dit document. Annuleer de skill of wacht tot die klaar is.',
  'main.docs.previewEncrypted':
    'Dit document is versleuteld; ontgrendel de werkruimte om er een voorbeeld van te bekijken.',
  'main.docs.previewGone':
    'Het documentbestand staat niet meer op de schijf. Importeer het document opnieuw om een ' +
    'voorbeeld te bekijken.',
  'main.docs.exportTextOnly':
    'Alleen tekstdocumenten (Markdown, TXT, CSV) kunnen op deze manier worden geëxporteerd.',
  'main.docs.exportEncrypted':
    'Dit document is versleuteld; ontgrendel de werkruimte om het te exporteren.',
  'main.docs.exportGone':
    'Het documentbestand staat niet meer op de schijf. Importeer het document opnieuw om het te ' +
    'exporteren.',
  'main.docs.exportOriginalChanged':
    'Alleen je eigen kopie van dit bestand is nog beschikbaar, en die is sinds het importeren ' +
    'gewijzigd: het is dus niet meer het origineel. Exporteer in plaats daarvan de geëxtraheerde ' +
    'tekst.',
  'main.docs.noStoredTranscript':
    'Voor deze opname is nog geen transcript opgeslagen. Indexeer de opname opnieuw om nog eens ' +
    'te transcriberen.',
  'main.models.noManifests':
    'Er is geen modellijst op deze schijf gevonden: de map model-manifests ontbreekt.',
  'main.models.autoSelected':
    'Dit model wordt automatisch gebruikt zodra het is geïnstalleerd: er is niets te selecteren.',
  'main.models.locked':
    'De werkruimte is vergrendeld. Ontgrendel de werkruimte om AI-modellen te beheren.',
  'main.audit.locked':
    'De werkruimte is vergrendeld. Ontgrendel de werkruimte om de activiteit te bekijken.',
  'main.settings.locked':
    'De werkruimte is vergrendeld. Ontgrendel de werkruimte om instellingen te wijzigen.',
  'main.evidenceReviews.locked':
    'De werkruimte is vergrendeld. Ontgrendel de werkruimte om aan beoordelingen van de ' +
    'onderbouwing te werken.',
  'main.evidenceReviews.invalidRequest': 'Dit verzoek voor de beoordeling is niet geldig.',
  'main.evidenceReviews.exportNotRecorded':
    'Het onderbouwingspakket kon niet in de exportgeschiedenis worden vastgelegd, dus het ' +
    'geëxporteerde bestand is verwijderd. Er is niets opgeslagen: probeer het exporteren opnieuw.',
  'main.evidenceReviews.exportFileNotRecorded':
    'Het bestand met het onderbouwingspakket is opgeslagen, maar kon niet in de ' +
    'exportgeschiedenis worden vastgelegd en ook niet worden verwijderd. De hash van het bestand ' +
    'is dus niet vastgelegd: exporteer opnieuw en vervang het bestand.',
  'main.evidenceReviews.exportOutdated':
    'Deze beoordeling is verouderd: een bron of het antwoord is gewijzigd sinds de beoordeling ' +
    'is aangemaakt. Bevestig de wijziging in de beoordeling voordat je exporteert.',
  'main.settings.invalidPatch':
    'Deze wijziging van de instellingen is ongeldig en is niet opgeslagen.',
  'main.dictation.locked':
    'De werkruimte is vergrendeld. Ontgrendel de werkruimte om de dicteerfunctie te gebruiken.',
  'main.dictation.silent':
    'Er kwam geen geluid binnen via de microfoon. Controleer of de microfoon niet is gedempt en ' +
    'of HilbertRaum de microfoon volgens de systeeminstellingen mag gebruiken, en probeer het ' +
    'daarna opnieuw.',
  'main.dictation.tooShort': 'De opname was te kort om spraak te bevatten: probeer het opnieuw.',
  'main.dictation.unavailable':
    'De dicteerfunctie is nog niet beschikbaar op deze schijf: op het scherm AI-model zie je wat ' +
    'er ontbreekt.',
  'main.dictation.failed': 'Dat kon niet worden getranscribeerd: probeer het opnieuw.',
  'main.dictation.tooLong':
    'Die opname is te lang voor de dicteerfunctie. Importeer bij een lange opname het ' +
    'audiobestand in plaats daarvan als document.',
  'main.dictation.busy': 'De vorige opname wordt nog getranscribeerd: een ogenblik.',
  'main.dictation.engineCannotRun':
    'De spraakengine kan op deze computer niet draaien. Op het scherm AI-model staat wat er ' +
    'ontbreekt.',
  'main.preflight.readOnly':
    'Deze schijf lijkt alleen-lezen te zijn, dus de app kan geen werkruimte aanmaken. Probeer ' +
    'een andere USB-poort, of lees de handleiding voor probleemoplossing.',
  'main.preflight.lowSpace':
    'Deze schijf heeft weinig vrije ruimte. Je kunt toch doorgaan, maar het importeren van grote ' +
    'documenten kan mislukken totdat je ruimte vrijmaakt.',
  'main.dialog.importDocuments': 'Documenten importeren',
  'main.dialog.importFolder': 'Map met documenten importeren',
  'main.dialog.exportDocument': 'Document exporteren',
  'main.dialog.exportOriginal': 'Origineel bestand exporteren',
  'main.dialog.exportSummary': 'Samenvatting exporteren',
  'main.dialog.exportChat': 'Gesprek exporteren',
  'main.dialog.exportTableCsv': 'Tabel als CSV exporteren',
  'main.dialog.exportCodeBlock': 'Codeblok als bestand opslaan',
  'main.dialog.exportAudit': 'Activiteitenoverzicht exporteren',
  'main.dialog.exportEvidencePack': 'Onderbouwingspakket exporteren',
  'main.dialog.exportLog': 'Logbestanden voor diagnose opslaan',
  'main.dialog.filterDocuments': 'Documenten',
  'main.dialog.filterAll': 'Alle bestanden',
  'main.zim.unavailable': 'Kennispakketten zijn in deze sessie niet beschikbaar.',
  'main.zim.articleUnavailable':
    'Dit artikel is nu niet beschikbaar, dus het kon niet worden opgeslagen. Mogelijk is het ' +
    'kennispakket uitgeschakeld of verwijderd, of is de schijf met het pakket losgekoppeld.',
  'main.zim.saveFailed':
    'Het artikel kon niet aan je documenten worden toegevoegd. Probeer het opnieuw.',
  'main.zim.dialogTitle': 'Kennispakketten toevoegen',
  'main.zim.filterZim': 'ZIM-archieven',
  'main.dialog.chooseImage': 'Afbeelding kiezen',
  'main.dialog.filterImages': 'Afbeeldingen',
  'main.images.unsupportedType':
    'Dit bestandstype wordt niet ondersteund. Kies een PNG, JPEG of WEBP.',
  'main.images.tooLarge':
    'Deze afbeelding is te groot om te analyseren. Probeer een kleinere afbeelding.',
  'main.dialog.importSkill': 'Skillpakket importeren',
  'main.dialog.importSkillFolder': 'Skillmap importeren',
  'main.dialog.exportSkill': 'Skill exporteren',
  'main.dialog.filterSkill': 'Skillpakket',
  'main.dialog.exportCsv': 'Transacties exporteren',
  'main.dialog.filterCsv': 'CSV-bestand',
  'main.dialog.exportJson': 'Als JSON exporteren',
  'main.dialog.filterJson': 'JSON-bestand',
  'main.dialog.exportXml': 'Als XML exporteren',
  'main.dialog.filterXml': 'XML-bestand',
  'main.dialog.exportRedacted': 'Kopie opslaan waarin persoonsgegevens onleesbaar zijn gemaakt',
  'main.dialog.exportEdited': 'Bewerkte kopie opslaan',
  'main.dialog.filterText': 'Tekstbestand',
  'main.dialog.filterDocx': 'Word-document',
  'main.collections.builtinUndeletable':
    'De ingebouwde locaties “Bibliotheek” en “Tijdelijk” kunnen niet worden verwijderd.',
  'main.skills.locked':
    'De werkruimte is vergrendeld. Ontgrendel de werkruimte om skills te beheren.',
  'main.skills.notPicked': 'Kies eerst het skillpakket met de bestandskiezer.',
  'main.skills.incompatible':
    'Deze skill heeft een nieuwere versie van de app nodig. Werk de app bij om de skill te ' +
    'gebruiken.',
  'main.skills.run.unavailable': 'De actie van deze skill is op dit moment niet beschikbaar.',
  'main.skills.run.noDocument':
    'Voeg eerst een document aan deze chat toe en probeer het dan opnieuw.',
  'main.skills.run.busy':
    'Er is al een skill bezig. Wacht tot de skill klaar is of annuleer de skill eerst.',
  'main.skills.run.documentOutOfScope':
    'Dat document hoort niet bij de documenten van deze chat. Kies een van die documenten en ' +
    'probeer het opnieuw.',
  // ---- Document organization — Documents screen sections + actions (plan §12) ----
  'docs.section.heading': 'Secties',
  'docs.section.library': 'Bibliotheek',
  'docs.section.projects': 'Projecten',
  'docs.section.temporary': 'Tijdelijk',
  'docs.section.generated': 'Gegenereerd',
  'docs.section.archived': 'Gearchiveerd',
  'docs.section.all': 'Alle documenten',
  'docs.section.newProject': 'Nieuw project',
  'docs.mode.aria': 'Weergave van Documenten',
  'docs.mode.documents': 'Mijn documenten',
  'docs.mode.packs': 'Kennispakketten',
  'docs.filter.placeholder': 'Filteren op naam…',
  'docs.filter.aria': 'Documenten op naam filteren',
  'docs.filter.noMatch': 'Er zijn geen documenten die bij “{query}” passen.',
  'docs.empty.packsLine':
    'Of voeg een kennispakket toe: een offline Wikipedia waaruit de chat antwoorden kan halen.',
  'docs.empty.packsAction': 'Kennispakketten',
  'docs.rail.hide': 'Secties verbergen',
  'docs.rail.show': 'Secties tonen',
  'docs.project.createTitle': 'Project aanmaken',
  'docs.project.namePlaceholder': 'Naam van het project',
  'docs.project.nameAria': 'Naam van het project',
  'docs.project.create': 'Aanmaken',
  'docs.project.rename': 'Naam wijzigen',
  'docs.project.renameTitle': 'Naam van het project wijzigen',
  'docs.project.archive': 'Archiveren',
  'docs.project.unarchive': 'Uit het archief halen',
  'docs.project.delete': 'Project verwijderen',
  'docs.project.deleteTitle': 'Dit project verwijderen?',
  'docs.project.deleteBody': 'Kies wat er met de documenten in dit project gebeurt:',
  'docs.project.deleteKeep': 'Alleen het project verwijderen en de documenten behouden',
  'docs.project.deleteKeepHint':
    'De documenten blijven in de Bibliotheek en in eventuele andere projecten.',
  'docs.project.deleteWith': 'Het project verwijderen, en ook de documenten die alleen hier staan',
  'docs.project.deleteWithHint':
    'Alleen documenten die niet in de Bibliotheek of in een ander project staan, worden ' +
    'verwijderd. Wat in de Bibliotheek staat, blijft altijd ongewijzigd.',
  'docs.project.archivedNote':
    'Gearchiveerd: verborgen als bron, maar de documenten blijven elders beschikbaar voor vragen.',
  'docs.project.options': 'Projectopties',
  'docs.action.moveToProject': 'Naar project verplaatsen…',
  'docs.action.addToLibrary': 'In de Bibliotheek houden',
  'docs.action.removeFromProject': 'Uit dit project verwijderen',
  'docs.action.markTemporary': 'Als tijdelijk markeren',
  'docs.action.markPermanent': 'Als blijvend markeren',
  'docs.action.archive': 'Archiveren',
  'docs.action.unarchive': 'Uit het archief halen',
  'docs.action.chooseProject': 'Project kiezen',
  'docs.chip.library': 'Bibliotheek',
  'docs.chip.temporary': 'Tijdelijk',
  'docs.chip.generated': 'Gegenereerd',
  'docs.chip.archived': 'Gearchiveerd',
  'docs.bulk.selected.one': '{count} geselecteerd',
  'docs.bulk.selected.other': '{count} geselecteerd',
  'docs.selectionAria': 'Acties voor de geselecteerde documenten',
  'docs.bulk.delete': 'Verwijderen',
  'docs.bulk.deleteConfirm.title.one': '{count} document verwijderen?',
  'docs.bulk.deleteConfirm.title.other': '{count} documenten verwijderen?',
  'docs.bulk.deleteConfirm.body':
    'Hiermee worden de geselecteerde documenten, de geëxtraheerde tekst en de zoekindex ' +
    'definitief uit je werkruimte verwijderd. De originele bestanden buiten de werkruimte ' +
    'blijven ongewijzigd.',
  'docs.empty.section': 'Hier staat nog niets.',
  // ---- Document organization — smart views (plan §7.6/§12.1, Phase E; regrouped §11.16) ----
  'docs.smart.recentlyAdded': 'Recent toegevoegd',
  'docs.smart.unfiled': 'Geen project',
  'docs.smart.attention': 'Aandacht nodig',
  'docs.smart.attentionTitle':
    'Mislukte imports en documenten die opnieuw moeten worden geïndexeerd',
  'docs.smart.more': 'Meer',
  'docs.provenance.staleBadge': 'Verouderd',
  'docs.provenance.staleChanged':
    'Een bron is gewijzigd sinds dit document is gegenereerd: voer de taak opnieuw uit om het ' +
    'bij te werken.',
  'docs.provenance.staleRemoved':
    'Een bron is verwijderd sinds dit document is gegenereerd: voer de taak opnieuw uit om het ' +
    'bij te werken.',
  // ---- Chat — composite source scope (multi-select picker + footer union, plan §13) ----
  'chat.scope.library': 'Bibliotheek',
  'chat.scope.projectNamed': 'Project “{name}”',
  'chat.scope.projectCount.one': '{count} project',
  'chat.scope.projectCount.other': '{count} projecten',
  // ---- Knowledge packs (ZIM wave: ScopePopover / SourcesDisclosure / ArticleModal / PacksPanel) ----
  'chat.scope.packsTitle': 'Kennispakketten',
  'chat.scope.packUnavailable': 'niet beschikbaar',
  'chat.scope.packNamed': 'Pakket “{name}”',
  'chat.scope.packNamedState': 'Pakket “{name}” ({state})',
  'chat.scope.packCount.one': '{count} kennispakket',
  'chat.scope.packCount.other': '{count} kennispakketten',
  'chat.scope.documentsToggle': 'Mijn documenten doorzoeken',
  'chat.scope.documentsToggleHint':
    'Uit: antwoorden komen alleen uit de aangevinkte kennispakketten. Bestanden die aan deze ' +
    'chat zijn toegevoegd, worden nog steeds gebruikt.',
  'chat.scope.documentsOffSuffix': 'documenten uit',
  'chat.scope.documentsOffNoPacks':
    'geen bronnen – schakel documenten in of vink een kennispakket aan',
  'chat.scope.packDisabled': 'uitgeschakeld',
  'chat.scope.packRemoved': 'Verwijderd pakket',
  'chat.scope.packLimit.one': 'Maximaal {count} kennispakket per chat',
  'chat.scope.packLimit.other': 'Maximaal {count} kennispakketten per chat',
  // ---- Per-answer knowledge-pack outcomes (#301 P4, findings M6/M7 — PackOutcomesNotice) ----
  'chat.packs.outcome.summary':
    'Kennispakketten: {searched} doorzocht · {other} niet doorzocht of mislukt',
  'chat.packs.outcome.removedPack': 'een verwijderd pakket',
  'chat.packs.outcome.passages.one': '{count} tekstdeel',
  'chat.packs.outcome.passages.other': '{count} tekstdelen',
  'chat.packs.outcome.unknown':
    'Kennispakketten: de uitkomst is voor dit oudere antwoord niet vastgelegd',
  'chat.packs.outcome.searched': 'doorzocht',
  'chat.packs.outcome.selection-limit': 'niet doorzocht: selectielimiet (12 per chat)',
  'chat.packs.outcome.removed': 'niet doorzocht: pakket verwijderd',
  'chat.packs.outcome.disabled': 'niet doorzocht: pakket uitgeschakeld',
  'chat.packs.outcome.file-missing': 'niet doorzocht: bestand ontbreekt',
  'chat.packs.outcome.identity-mismatch': 'niet doorzocht: ander archief op deze locatie',
  'chat.packs.outcome.not-served': 'niet doorzocht: de naam botst met een ander pakket',
  'chat.packs.outcome.not-searchable': 'niet doorzocht: geen zoekindex',
  'chat.packs.outcome.tools-missing': 'niet doorzocht: kiwix-tools niet geïnstalleerd',
  'chat.packs.outcome.mode':
    'niet doorzocht: antwoorden over het hele document lezen alleen het document',
  'chat.packs.outcome.search-failed': 'mislukt: zoekfout',
  'chat.packs.outcome.read-failed': 'mislukt: er kon geen artikel worden gelezen',
  'chat.packs.outcome.timeout': 'mislukt: duurde te lang',
  'chat.packs.outcome.deadline': 'niet doorzocht: geen tijd meer voor deze vraag',
  'chat.packs.outcome.server-restarted':
    'mislukt: de pakketserver is tijdens deze vraag opnieuw gestart',
  'chat.sources.openArticle': 'Artikel openen',
  'chat.article.title': 'Artikel',
  'chat.article.from': 'Uit {archive} – offline kopie',
  'chat.article.loading': 'Artikel laden…',
  'chat.article.unavailable':
    'Dit artikel is nu niet beschikbaar. Mogelijk is het pakket uitgeschakeld of verwijderd, of ' +
    'is de schijf met het pakket losgekoppeld.',
  'chat.article.partial': 'Alleen het eerste deel van dit artikel kon worden getoond.',
  'chat.article.save': 'Opslaan in mijn documenten',
  'chat.article.saveAria': 'Opslaan in mijn documenten: {title}',
  'chat.article.saving': 'Opslaan in je documenten…',
  'chat.article.saved':
    'Opgeslagen in je documenten als “{title}”. Het artikel blijft doorzoekbaar, ook zonder het ' +
    'pakket.',
  'chat.article.alreadySaved': 'Dit artikel staat al in je documenten als “{title}”.',
  // ---- #301 P6 (a11y pass; plan §9.23 (b)4/(b)6 and decision (c)5) — BEGIN -----------------
  'chat.scope.packMissing': 'bestand ontbreekt',
  'chat.scope.packMismatch': 'ander archief op deze locatie',
  'chat.scope.packNotSearchable': 'geen zoekindex',
  'chat.sources.openArticleNamed': 'Artikel openen: {title}',
  // ---- #301 P6 — END ------------------------------------------------------------------------
  'packs.add': 'Kennispakketten toevoegen…',
  'packs.addBusy': 'Toevoegen…',
  'packs.refresh': 'Vernieuwen',
  'packs.lead':
    'Offline naslagwerken (ZIM-bestanden, bijvoorbeeld een offline Wikipedia) waaruit de chat ' +
    'antwoorden kan halen. Bestanden worden gebruikt waar ze staan en nooit gekopieerd: zet ze ' +
    'in de map zim op de schijf of voeg ze hier toe.',
  'packs.summary.count.one': '{count} pakket',
  'packs.summary.count.other': '{count} pakketten',
  'packs.summary.enabled.one': '{count} ingeschakeld',
  'packs.summary.enabled.other': '{count} ingeschakeld',
  'packs.summary.size': '{size} op deze schijf',
  'packs.loading': 'Kennispakketten laden…',
  'packs.refreshing': 'Schijf controleren op kennispakketten…',
  'packs.emptyTitle': 'Nog geen kennispakketten',
  'packs.emptyLine':
    'Download van library.kiwix.org een .zim-archief dat uit één bestand bestaat, en voeg het ' +
    'daarna hier toe of kopieer het naar de map zim op de schijf.',
  'packs.copyLibrary': 'Adres van de Kiwix-bibliotheek kopiëren',
  'packs.copiedToast': 'library.kiwix.org gekopieerd',
  'packs.copyFailed': 'Kopiëren is niet gelukt: het adres is library.kiwix.org',
  'packs.setup.title': 'Eenmalig instellen: de hulpprogramma’s voor kennispakketten',
  'packs.toolsMissing':
    'De programma’s van kiwix-tools zijn niet op deze schijf geïnstalleerd, dus kennispakketten ' +
    'kunnen niet worden toegevoegd of doorzocht. De installatiestap staat in de handleiding voor ' +
    'probleemoplossing onder “The panel says kiwix-tools are missing”.',
  'packs.tools.install': 'Hulpprogramma’s voor kennispakketten installeren…',
  'packs.tools.confirm.title': 'Hulpprogramma’s voor kennispakketten installeren?',
  'packs.tools.confirm.explain':
    'kiwix-tools {version}, de programma’s die kennispakketten (ZIM-archieven) aanbieden, worden ' +
    'gedownload van de server van het Kiwix-project en vóór gebruik gecontroleerd. De ' +
    'programma’s zijn optioneel: chat en documenten werken ook zonder.',
  'packs.tools.confirm.hint':
    'De download wordt vóór gebruik gecontroleerd, en er wordt niets over jou of je documenten ' +
    'verstuurd. De hulpprogramma’s zijn alleen nodig voor kennispakketten.',
  'packs.tools.confirm.ack':
    'Ik heb de licentievoorwaarden van kiwix-tools ({license}) gelezen en ga ermee akkoord',
  'packs.tools.confirm.start': 'Download starten',
  'packs.tools.sizeUnknown': 'onbekend',
  'packs.tools.progress': 'Hulpprogramma’s voor kennispakketten installeren… {pct}%',
  'packs.tools.downloadingNoTotal': 'Hulpprogramma’s voor kennispakketten installeren…',
  'packs.tools.verifying': 'Hulpprogramma’s voor kennispakketten controleren…',
  'packs.tools.extracting': 'Hulpprogramma’s voor kennispakketten uitpakken…',
  'packs.tools.failed':
    'Het installeren van de hulpprogramma’s voor kennispakketten is niet gelukt.',
  'packs.tools.doneToast': 'Hulpprogramma’s voor kennispakketten geïnstalleerd',
  'packs.addedToast.one': 'Kennispakket toegevoegd',
  'packs.addedToast.other': '{count} kennispakketten toegevoegd',
  'packs.addPartial': 'Archieven die niet konden worden toegevoegd: {failed} van {total}.',
  'packs.addFailed.notAZim': 'Het gekozen bestand is geen leesbaar ZIM-archief.',
  'packs.addFailed.toolsMissing':
    'De programma’s van kiwix-tools zijn niet op deze schijf geïnstalleerd, dus kennispakketten ' +
    'kunnen niet worden toegevoegd of doorzocht. De installatiestap staat in de handleiding voor ' +
    'probleemoplossing onder “The panel says kiwix-tools are missing”.',
  'packs.addFailed.manager':
    'Het archief kon niet door kiwix-manage worden gelezen. Controleer of het bestand compleet ' +
    'is en probeer het opnieuw.',
  'packs.addFailed.pathUnsupported':
    'Onder Windows kan kiwix-manage dit archief niet lezen, omdat de bestandsnaam of de map een ' +
    'umlaut, een accent of een ander niet-ASCII-teken bevat. Kopieer het bestand onder een naam ' +
    'zonder zulke tekens naar de map zim/ op de schijf en voeg het opnieuw toe.',
  'packs.addFailed.other': 'Het archief kon niet worden toegevoegd.',
  'packs.removedToast': 'Kennispakket verwijderd',
  'packs.articleCount.one': '{count} artikel',
  'packs.articleCount.other': '{count} artikelen',
  'packs.state.enabled': 'Ingeschakeld',
  'packs.state.disabled': 'Uitgeschakeld',
  'packs.state.missing': 'Bestand ontbreekt',
  'packs.state.missingTitle': 'Het archiefbestand is niet gevonden. Is de schijf aangesloten?',
  'packs.state.identityMismatch': 'Ander archief',
  'packs.state.identityMismatchTitle':
    'Het bestand op de locatie van dit pakket is een ander archief: verwijder dit pakket en voeg ' +
    'het bestand opnieuw toe',
  'packs.state.notSearchable': 'Geen zoekindex',
  'packs.state.notSearchableTitle':
    'Dit archief heeft geen zoekindex voor de volledige tekst. Bij vragen wordt het archief ' +
    'overgeslagen, maar de artikelen blijven leesbaar.',
  'packs.state.notServed': 'Niet aangeboden',
  'packs.state.notServedTitle':
    'De bestandsnaam botst met die van het pakket “{title}”, dus alleen dat pakket wordt ' +
    'aangeboden. Geef dit bestand een andere naam om beide te gebruiken.',
  'packs.state.notServedTitleUnknown':
    'De bestandsnaam botst met die van een ander pakket, dus alleen dat pakket wordt aangeboden. ' +
    'Geef dit bestand een andere naam om beide te gebruiken.',
  'packs.switchLabel': 'Het kennispakket “{title}” in chats gebruiken',
  'packs.ask': 'Vragen aan dit pakket',
  'packs.askTitle': 'Een chat openen die alleen op basis van dit pakket antwoordt',
  'packs.rowMenu': 'Meer acties voor het kennispakket “{title}”',
  'packs.remove': 'Verwijderen',
  'packs.listLabel': 'Kennispakketten',
  'packs.removeTitle': 'Dit kennispakket verwijderen?',
  'packs.removeConfirm': 'Pakket verwijderen',
  'packs.removeBody':
    'Het pakket wordt alleen uit HilbertRaum verwijderd; het archiefbestand op de schijf blijft ' +
    'staan. Chats die het pakket gebruikten, halen er voortaan niets meer uit.',
  'chat.scope.docCount.one': '{count} document',
  'chat.scope.docCount.other': '{count} documenten',
  'chat.scope.filesInChat.one': '{count} bestand in deze chat',
  'chat.scope.filesInChat.other': '{count} bestanden in deze chat',
  'chat.scope.sourcesTitle': 'Kies je bronnen',
  'chat.scope.librarySource': 'Bibliotheek',
  'chat.scope.librarySourceHint': 'Je hele kennisbank',
  'chat.scope.specificToggle': 'Specifieke documenten…',
  'chat.scope.allTap': 'Alle documenten',
  'chat.scope.attachmentsOnlyTap': 'Alleen de bestanden in deze chat',
  'chat.scope.filesInChatLine': 'Bestanden in deze chat',
  'chat.scope.attachmentNotReadable': '{name} (nog niet leesbaar)',
  'chat.scope.attachmentFailedHint':
    'Een bestand dat nog niet leesbaar is, voegt niets toe aan de antwoorden. In Documenten zie ' +
    'je waarom, en wat je kunt doen.',
  'chat.scope.noProjects': 'Nog geen projecten',
  'chat.scope.noPacks': 'Nog geen kennispakketten op deze schijf.',
  'chat.scope.addPacks': 'Kennispakketten toevoegen…',
  'chat.scope.archivedFallback':
    'Dit project is gearchiveerd: er wordt geantwoord uit je Bibliotheek.',
  'chat.scope.answeringFrom': 'Antwoorden uit: {source}',
  'chat.scope.wholeLibrary.one': 'je hele bibliotheek – {count} document',
  'chat.scope.wholeLibrary.other': 'je hele bibliotheek – {count} documenten',
  'chat.scope.narrowTitle': 'Alleen op basis van dit bestand antwoorden?',
  'chat.scope.narrowBody':
    'Je hebt het bestand {name} toegevoegd. Alleen vragen aan dit bestand, of blijven antwoorden ' +
    'uit je hele bibliotheek?',
  'chat.scope.narrowJust': 'Alleen dit bestand',
  'chat.scope.narrowWhole': 'Hele bibliotheek',
  // ---- Chat — attach / drag-drop a file into a chat (plan §11.2/§13.5, Phase C) ----
  'chat.attach.button': 'Bestanden bijvoegen',
  'chat.attach.drop': 'Zet bestanden hier neer om ze in deze chat te gebruiken',
  'chat.attach.processing': '{name} verwerken…',
  'chat.attach.added': 'Het bestand {name} is aan deze chat toegevoegd',
  'chat.attach.newDocChat': 'Er is een nieuwe documentchat gestart voor het bestand {name}',
  'chat.attach.failed': 'Het bestand {name} kon niet aan deze chat worden toegevoegd.',
  'chat.attach.dropUnsupported':
    'Dat kon niet worden toegevoegd: sleep een bestand hierheen dat op je computer is opgeslagen.',
  'chat.attach.trackFailed':
    'De import van het bestand kon niet worden gevolgd: bekijk het resultaat in Documenten.',
  'chat.attach.scanned':
    'Het bestand {name} lijkt een scan en kan daarom nog niet worden gelezen. Gebruik in ' +
    'Documenten “Doorzoekbaar maken (OCR)” voor dit bestand. Daarna hoort het bestand vanzelf ' +
    'bij deze chat: je hoeft het niet opnieuw bij te voegen.',
  'chat.attach.photoNeedsOcr':
    'Het bestand {name} is een foto van een pagina. Om de foto te lezen zijn de OCR-bestanden ' +
    'nodig, maar die staan nog niet op deze schijf. Gebruik in Documenten “OCR-bestanden ' +
    'downloaden” en daarna “Opnieuw proberen” voor dit bestand. Daarna hoort het bestand vanzelf ' +
    'bij deze chat: je hoeft het niet opnieuw bij te voegen.',
  'chat.attach.goToDocuments': 'Naar Documenten',
  // ---- Images — "Ask about an image" (image-understanding §5/§11, Phase V3) ----
  'images.title': 'Een afbeelding begrijpen',
  'images.empty.body':
    'Stel vragen over een schermafbeelding, grafiek, formulier, kassabon of foto. Alles blijft ' +
    'lokaal.',
  'images.avail.noModel':
    'Voor het begrijpen van afbeeldingen is een lokaal beeldmodel op deze schijf nodig.',
  'images.avail.noRuntime':
    'Voor het begrijpen van afbeeldingen moet eerst de AI-engine zijn geïnstalleerd.',
  'images.avail.incompatible': 'Het beeldmodel op deze schijf heeft een nieuwere AI-engine nodig.',
  'images.avail.cta': 'Naar AI-model',
  'images.avail.ocrPointer':
    'Gescande documenten? Gebruik “Doorzoekbaar maken (OCR)” in Documenten.',
  'images.drop.title': 'Zet hier een afbeelding neer',
  'images.drop.choose': 'of een afbeelding kiezen',
  'images.drop.types': 'PNG, JPEG of WEBP',
  'images.drop.busy': 'Er loopt een analyse. Wacht tot die klaar is om een nieuwe te starten.',
  'images.back': 'Terug naar de analyses',
  'images.preview.remove': 'Verwijderen',
  'images.preview.replace': 'Vervangen',
  'images.preview.alt': 'Gekozen afbeelding',
  'images.chip.summarize': 'Afbeelding samenvatten',
  'images.chip.summarize.prompt':
    'Vat de zichtbare inhoud van deze afbeelding samen. Noem alles wat belangrijk of ongewoon is.',
  'images.chip.extractText': 'Zichtbare tekst extraheren',
  'images.chip.extractText.prompt':
    'Neem de zichtbare tekst over die je kunt lezen. Behoud regeleinden waar dat helpt. Zeg het ' +
    'als een deel van de tekst onduidelijk is.',
  'images.chip.explainChart': 'Deze grafiek uitleggen',
  'images.chip.explainChart.prompt':
    'Leg uit wat deze grafiek lijkt te laten zien. Noem assen, labels, trends en eventuele ' +
    'onzekerheid.',
  'images.chip.readForm': 'Formulier uitlezen',
  'images.chip.readForm.prompt':
    'Noem de belangrijkste velden en waarden die in dit formulier zichtbaar zijn. Schrijf ' +
    '“onduidelijk” waar je iets niet kunt lezen.',
  'images.chip.importantDetails': 'Belangrijke details vinden',
  'images.chip.importantDetails.prompt':
    'Noem de belangrijkste zichtbare details. Leid niets af wat niet zichtbaar is.',
  'images.chip.whatNotice': 'Waar moet ik op letten?',
  'images.chip.whatNotice.prompt':
    'Waar moet ik op letten in deze afbeelding? Wijs alleen de opvallendste zichtbare elementen ' +
    'aan.',
  'images.composer.placeholder': 'Stel een vraag over deze afbeelding…',
  'images.composer.ask': 'Vragen',
  'images.answer.localNote': 'Lokaal gegenereerd uit de gekozen afbeelding.',
  'images.answer.copy': 'Kopiëren',
  'images.answer.copied': 'Gekopieerd',
  'images.answer.copyFailed': 'Kopiëren naar het klembord is niet gelukt',
  'images.answer.tryAgain': 'Opnieuw proberen',
  'images.answer.reading': 'Afbeelding lezen…',
  'images.answer.starting': 'Beeldmodel starten…',
  'images.answer.stop': 'Stoppen',
  'images.answer.stopped': 'Gestopt.',
  'images.err.tooLarge':
    'Deze afbeelding is te groot om te analyseren. Probeer een kleinere afbeelding.',
  'images.err.unsupported': 'Dit bestandstype wordt niet ondersteund. Kies een PNG, JPEG of WEBP.',
  'images.err.heic':
    'HEIC-foto’s van een iPhone worden nog niet ondersteund. Zet de foto eerst om naar JPEG.',
  'images.err.pdf':
    'Dit scherm leest één afbeelding, geen PDF. Gebruik voor een gescande PDF “Doorzoekbaar ' +
    'maken (OCR)” in Documenten.',
  'images.err.pdfAction': 'Naar Documenten',
  'images.err.decodeFailed':
    'Deze afbeelding kon niet worden geopend. Het bestand is mogelijk beschadigd of heeft een ' +
    'indeling die niet wordt ondersteund.',
  'images.err.multiDrop': 'Zet één afbeelding tegelijk neer.',
  'images.err.runtimeFailed':
    'Het beeldmodel kon niet starten. Probeer het opnieuw, of kies een ander model.',
  'images.err.engineCannotRun':
    'De AI-engine kan op deze computer niet draaien. Op het scherm AI-model staat wat er ' +
    'ontbreekt.',
  'images.err.emptyResponse':
    'Er is geen antwoord over deze afbeelding teruggekomen. Probeer je vraag anders te ' +
    'formuleren.',
  'images.err.emptyQuestion': 'Typ eerst een vraag over de afbeelding.',
  'images.err.timedOut':
    'Dit duurt te lang. Probeer een kleinere afbeelding, of stel de vraag opnieuw.',
  'images.err.contextExceeded':
    'Dit gesprek is te lang geworden voor deze afbeelding. Stel een kortere vraag, of start een ' +
    'nieuwe analyse.',
  'images.err.busy': 'Vorige vraag beantwoorden…',
  'images.err.openFailed': 'Deze analyse kon niet worden geopend. Probeer het opnieuw.',
  'images.err.deleteFailed': 'Deze analyse kon niet worden verwijderd. Probeer het opnieuw.',
  'images.err.clearFailed': 'De geschiedenis kon niet worden gewist. Probeer het opnieuw.',
  'images.history.title': 'Geschiedenis',
  'images.history.empty': 'Afbeeldingen die je analyseert, verschijnen hier.',
  'images.history.running': 'Analyseren…',
  'images.history.runningOpen': 'Lopende analyse bekijken',
  'images.history.turns.one': '{count} vraag',
  'images.history.turns.other': '{count} vragen',
  'images.history.delete': 'Verwijderen',
  'images.history.deleteAria': 'De afbeelding “{title}” verwijderen',
  'images.history.deleted': 'Uit de geschiedenis verwijderd',
  'images.history.delete.title': 'Deze afbeelding verwijderen?',
  'images.history.delete.confirm': 'Verwijderen',
  'images.history.delete.body':
    'De afbeelding “{title}” en de antwoorden erover worden definitief van deze schijf ' +
    'verwijderd.',
  'images.history.total': 'Totaal: {size}',
  'images.history.clear': 'Geschiedenis wissen',
  'images.history.clear.title': 'Afbeeldingsgeschiedenis wissen?',
  'images.history.clear.confirm': 'Geschiedenis wissen',
  'images.history.clear.body':
    'Alle opgeslagen analyses ({size}) en de opgeslagen afbeeldingen daarvan worden definitief ' +
    'van deze schijf verwijderd.',
  'images.history.cleared': 'Afbeeldingsgeschiedenis gewist',
  // ---- Translate screen (TranslateGemma wave, plan §2 D6, TG-4) ----
  'translate.title': 'Tekst vertalen',
  'translate.lead':
    'Typ of plak tekst, kies de talen en vertaal de tekst lokaal. Niets verlaat deze schijf.',
  'translate.starting': 'Vertaalmodel klaarmaken…',
  'translate.avail.noModel': 'Voor vertalen is het vertaalmodel op deze schijf nodig.',
  'translate.avail.hint':
    'Download het eenmalig op het scherm AI-model: daarna werkt vertalen volledig offline.',
  'translate.avail.cta': 'Naar AI-model',
  'translate.from': 'Van',
  'translate.to': 'Naar',
  'translate.swap': 'Talen omwisselen',
  'translate.input.label': 'Te vertalen tekst',
  'translate.input.placeholder': 'Typ of plak de tekst die je wilt vertalen…',
  'translate.action': 'Vertalen',
  'translate.stop': 'Stoppen',
  'translate.output.label': 'Vertaling',
  'translate.output.empty': 'Hier verschijnt de vertaling.',
  'translate.working': 'Vertalen…',
  'translate.copy': 'Kopiëren',
  'translate.copied': 'Gekopieerd',
  'translate.device.gpu':
    'Het vertalen draait op de grafische kaart (GPU, lagen: {done} van {total})',
  'translate.device.gpuUnknown': 'Het vertalen draait op de grafische kaart (GPU)',
  'translate.device.gpuPartial':
    'Het vertalen draait maar gedeeltelijk op de grafische kaart (lagen: {done} van {total}): ' +
    'het grafische geheugen was grotendeels bezet, meestal door het chatmodel, dus het vertalen ' +
    'gaat ongeveer zo snel als op de processor',
  'translate.device.gpuNone':
    'Het vertalen draait op de processor: het grafische geheugen was volledig bezet, meestal ' +
    'door het chatmodel, dus er past geen enkele laag op de grafische kaart (lagen: 0 van ' +
    '{total})',
  'translate.device.cpu': 'Het vertalen draait op de processor (CPU)',
  'translate.device.cpuBesideChat':
    'Het vertalen draait op de processor: het chatmodel gebruikt het grafische geheugen en het ' +
    'vertaalmodel zou er niet naast passen',
  'translate.device.cpuChatStarting':
    'Het vertalen draait op de processor: er werd een chatmodel gestart, en het chatmodel krijgt ' +
    'als eerste de grafische kaart',
  'translate.device.cpuTooLarge':
    'Het vertalen draait op de processor: het vertaalmodel past niet in het geheugen van deze ' +
    'grafische kaart',
  'translate.device.title':
    'Waar het vertaalmodel draaide toen het voor het laatst werd gestart. Bij elke start wordt ' +
    'dat opnieuw bepaald (het vertaalmodel wordt ongeveer 2 minuten na de laatste vertaling uit ' +
    'het geheugen gehaald).',
  'translate.device.partialTitle':
    'Zo krijgt het vertaalmodel meer van de kaart: gebruik een kleiner chatmodel, of stop het ' +
    'chatmodel voordat je vertaalt. Bij de volgende start wordt opnieuw bepaald hoeveel van het ' +
    'vertaalmodel op de kaart past (ongeveer 2 minuten na de laatste vertaling).',
  'translate.device.gpuNoneTitle':
    'Zo komt het vertaalmodel wel op de kaart: gebruik een kleiner chatmodel, of stop het ' +
    'chatmodel voordat je vertaalt. Bij de volgende start wordt opnieuw bepaald hoeveel van het ' +
    'vertaalmodel op de kaart past (ongeveer 2 minuten na de laatste vertaling).',
  'translate.err.noModel':
    'Het vertaalmodel is niet meer beschikbaar. Ga naar het scherm AI-model om het te ' +
    'installeren.',
  'translate.err.badRequest': 'Kies een brontaal en een doeltaal en voer tekst in om te vertalen.',
  'translate.err.busy':
    'Er loopt al een vertaling. Wacht tot die klaar is en probeer het dan opnieuw.',
  'translate.err.docTaskBusy': 'Er loopt een documenttaak. Wacht tot die klaar is en vertaal dan.',
  'translate.err.runtimeFailed':
    'Het vertaalmodel kon de vertaling niet afmaken. Probeer het opnieuw, of probeer een kortere ' +
    'tekst.',
  'translate.err.startFailed':
    'Het vertaalmodel kon niet starten: mogelijk is er op dit apparaat te weinig geheugen vrij. ' +
    'Sluit andere apps of start HilbertRaum opnieuw, en probeer het daarna nog eens.',
  'translate.err.engineCannotRun':
    'De AI-engine kan op deze computer niet draaien. Op het scherm AI-model staat wat er ' +
    'ontbreekt.',
  'translate.err.empty':
    'Er is geen vertaling teruggekomen. Probeer het opnieuw, of formuleer de tekst anders.',
  'translate.err.sameLang': 'Kies twee verschillende talen.',
  'translate.err.tooLong':
    'De tekst is te lang om hier te vertalen (meer dan 200.000 tekens). Verdeel de tekst in ' +
    'kleinere delen, of sla de tekst op als bestand en vertaal dat als document.',
  // ---- Document drag-and-drop translation (TG-5, plan §2 D7) ----
  'translate.drop.title': 'Of zet een document neer om het te vertalen',
  'translate.drop.choose': 'of een document kiezen',
  'translate.drop.types': 'PDF, Word, Markdown of tekst – vertaald naar de gekozen taal.',
  'translate.file.importing': 'Document inlezen…',
  'translate.file.progress': 'Vertalen… ({done}/{total})',
  'translate.file.preparing': 'Vertaling voorbereiden – document inlezen…',
  'translate.file.saving': 'Vertaald document opslaan…',
  'translate.file.truncated':
    'Hier staat het begin van de vertaling. Exporteer de vertaling of open die in Documenten om ' +
    'het hele document te zien.',
  'translate.file.export': 'Exporteren…',
  'translate.file.exported': 'Document geëxporteerd',
  'translate.file.show': 'In Documenten tonen',
  'translate.file.reset': 'Nog een document vertalen',
  'translate.file.doneAnnounce':
    'De vertaling van het document is klaar. Het resultaat wordt getoond.',
  'translate.file.gapPages.one':
    '⚠ Pagina {pages} van het origineel is niet vertaald: er staat geen leesbare tekst op ' +
    '(mogelijk een gescande pagina). In de uitvoer is de plek gemarkeerd.',
  'translate.file.gapPages.other':
    '⚠ Pagina’s {pages} van het origineel zijn niet vertaald: er staat geen leesbare tekst op ' +
    '(mogelijk gescande pagina’s). In de uitvoer is elke plek gemarkeerd.',
  'translate.file.failedParts.one':
    '⚠ {count} deel kon niet worden vertaald: op de gemarkeerde plek in de uitvoer staat de ' +
    'oorspronkelijke tekst.',
  'translate.file.failedParts.other':
    '⚠ {count} delen konden niet worden vertaald: op de gemarkeerde plekken in de uitvoer staat ' +
    'de oorspronkelijke tekst.',
  'translate.file.err.multiDrop': 'Zet één document tegelijk neer.',
  'translate.file.err.noPath':
    'Bij dit item hoort geen bestand op de schijf. Sleep een document uit een map hierheen, of ' +
    'gebruik “een document kiezen”.',
  'translate.file.err.unsupported':
    'Dit bestandstype kan niet worden vertaald. Probeer een PDF-, Word-, Markdown- of ' +
    'tekstbestand.',
  'translate.file.err.scanned':
    'Deze PDF lijkt een scan zonder leesbare tekst. Maak de PDF eerst doorzoekbaar in ' +
    'Documenten, met “Doorzoekbaar maken (OCR)”, en vertaal het bestand daarna.',
  'translate.file.err.scannedAction': 'Naar Documenten',
  'translate.file.err.importFailed': 'Het document kon niet worden gelezen. Probeer het opnieuw.',
  'translate.file.err.runtimeFailed': 'Het document kon niet worden vertaald. Probeer het opnieuw.',
  // ---- Evidence review (EP-1 plan §7 — ReviewScreen.tsx + chat entry points) ----
  'review.action.start': 'Onderbouwing beoordelen',
  'review.action.continue': 'Beoordeling voortzetten',
  'review.entry.sources': 'Antwoord en bronnen beoordelen',
  'review.status.draft': 'Concept',
  'review.status.ready': 'Afgerond',
  'review.status.outdated': 'Verouderd',
  'review.readonlyHint': 'Afgerond. Heropen de beoordeling om die te bewerken.',
  // ---- P4: Outdated banner + acknowledge (spec §15.5/§21.3/§28.6) ----
  'review.outdated.title': 'Deze beoordeling is verouderd.',
  'review.outdated.answerChanged':
    'De tekst van het antwoord komt niet meer overeen met de beoordeelde momentopname.',
  'review.outdated.coverageChanged':
    'De vastgelegde metagegevens over de dekking komen niet meer overeen met de beoordeelde ' +
    'momentopname.',
  'review.outdated.sourcesChanged.one':
    '{count} brondocument is gewijzigd sinds deze beoordeling is aangemaakt.',
  'review.outdated.sourcesChanged.other':
    '{count} brondocumenten zijn gewijzigd sinds deze beoordeling is aangemaakt.',
  'review.outdated.keepNote':
    'Je vastgelegde beslissingen zijn niet gewijzigd. Je kunt de beoordeling behouden zoals die ' +
    'was, de wijziging bevestigen, of je vraag opnieuw stellen in de chat en een nieuwe ' +
    'beoordeling beginnen.',
  'review.outdated.acknowledge': 'Wijziging bevestigen',
  'review.outdated.acknowledgedAt': 'Wijziging bevestigd op {date}.',
  'review.outdated.exportHint':
    'Bevestig de wijziging voordat je een onderbouwingspakket exporteert.',
  'review.back': 'Terug naar de chat',
  'review.rename': 'Titel wijzigen',
  'review.rename.label': 'Titel van de beoordeling',
  'review.rename.save': 'Opslaan',
  'review.loading': 'Beoordeling laden…',
  'review.notFound': 'Deze beoordeling is niet gevonden. Mogelijk is de beoordeling verwijderd.',
  'review.question.toggle': 'Vraag',
  'review.answerPane.aria': 'Antwoord dat wordt beoordeeld',
  'review.autosave.saving': 'Opslaan…',
  'review.autosave.saved': 'Opgeslagen',
  'review.autosave.error': 'Sommige wijzigingen konden nog niet worden opgeslagen.',
  'review.autosave.retry': 'Opnieuw proberen',
  'review.evidence.title': 'Onderbouwing',
  'review.evidence.captionRelevance':
    'De getoonde bronnen zijn de fragmenten die het lokale AI-model voor dit antwoord heeft ' +
    'gekregen.',
  'review.evidence.captionWholeDoc':
    'Dit antwoord is afgeleid uit een analyse van het hele document. De getoonde secties geven ' +
    'de herkomst aan; het zijn geen bronverwijzingen per zin.',
  'review.evidence.captionStructured':
    'Dit antwoord gebruikt lokaal geëxtraheerde gegevens. Hieronder staan de tekstdelen uit de ' +
    'bronnen waarop de extractie is gebaseerd.',
  'review.evidence.none':
    'Bij dit antwoord zijn geen fragmenten uit bronnen opgeslagen. Je kunt een algemene ' +
    'beoordeling vastleggen, maar controle op bronniveau is niet mogelijk.',
  'review.disclaimer':
    'Een bronverwijzing laat zien waar informatie vandaan komt. Dat bewijst op zichzelf niet dat ' +
    'het antwoord klopt.',
  'review.evidence.filterLabel': 'Bronnen filteren',
  'review.evidence.filterPlaceholder': 'Filteren op titel of tekst…',
  'review.evidence.filterClear': 'Filter wissen',
  'review.evidence.filterNone': 'Er zijn geen bronnen die bij je filter passen.',
  'review.evidence.shownCount': 'Getoonde bronnen: {shown} van {total}',
  'review.evidence.more.one': 'en nog {count} bron',
  'review.evidence.more.other': 'en nog {count} bronnen',
  'review.evidence.linkingItem': 'Onderbouwing koppelen aan beoordelingspunt {n}',
  'review.source.kind.direct_excerpt': 'Direct fragment',
  'review.source.kind.whole_document_provenance': 'Herkomst uit een analyse van het hele document',
  'review.source.kind.structured_record': 'Geëxtraheerde gegevens',
  'review.source.unresolved': 'De identiteit van de bron kon niet worden vastgesteld',
  'review.source.archive':
    'Artikel uit een kennispakket – de identiteit en de inhoud ervan kunnen niet aan de hand van ' +
    'de werkruimte worden gecontroleerd',
  'review.source.missingAtCreation':
    'De bron was niet beschikbaar toen deze beoordeling werd aangemaakt',
  'review.source.changed': 'Het brondocument is gewijzigd sinds deze beoordeling is aangemaakt',
  'review.source.missingNow':
    'Deze bron staat niet meer in de werkruimte. Het opgeslagen fragment blijft in deze ' +
    'beoordeling.',
  'review.source.cannotVerify': 'De huidige toestand van deze bron kan niet worden gecontroleerd',
  'review.sourceContext.open': 'Bron in context openen',
  'review.sourceContext.title': 'Bron in context',
  'review.sourceContext.loading': 'Opgeslagen tekst laden…',
  'review.sourceContext.failed': 'De opgeslagen tekst van deze bron kon niet worden geladen.',
  'review.sourceContext.hashMatch':
    'De opgeslagen hash van het document komt overeen met de momentopname van de beoordeling.',
  'review.sourceContext.hashMismatch':
    'Het brondocument is gewijzigd sinds deze beoordeling is aangemaakt.',
  'review.sourceContext.hashUnknown':
    'De huidige toestand van het document kan niet aan de hand van de momentopname van de ' +
    'beoordeling worden gecontroleerd.',
  'review.sourceContext.missing':
    'Deze bron was beschikbaar toen het antwoord werd gegenereerd, maar staat niet meer in de ' +
    'werkruimte. Het opgeslagen fragment blijft in deze beoordeling, voor zover het beschikbaar ' +
    'is.',
  'review.sourceContext.notLocated':
    'Het opgeslagen fragment is niet teruggevonden in de huidige opgeslagen tekst. Hieronder ' +
    'staat het fragment zoals het werd vastgelegd toen de beoordeling werd aangemaakt.',
  'review.sourceContext.storedNote':
    'De context komt uit de opgeslagen tekst die bij het importeren is geëxtraheerd: het ' +
    'originele bestand zelf wordt niet geopend.',
  'review.sourceContext.excerptHeading': 'Opgeslagen fragment',
  'review.link.add': 'Aan beoordelingspunt koppelen',
  'review.link.remove': 'Koppeling verwijderen',
  'review.link.cited': 'Bronverwijzing in het antwoord',
  'review.link.reviewer': 'Gekoppeld bij de beoordeling',
  'review.link.selectHint':
    'Kies een beoordelingspunt om onderbouwing te koppelen of een koppeling te verwijderen.',
  'review.relation.label': 'Relatie',
  'review.relation.none': 'Geen markering',
  'review.relation.supports': 'Onderbouwt',
  'review.relation.qualifies': 'Nuanceert',
  'review.relation.contradicts': 'Spreekt tegen',
  'review.relation.context': 'Alleen context',
  'review.item.aria': 'Beoordelingspunt {n}',
  'review.item.noMarker': 'Geen directe bronverwijzing in deze tekst',
  'review.item.wholeDocDerived': 'Afgeleid uit een analyse van het hele document',
  'review.item.noteLabel': 'Notitie',
  'review.item.notePlaceholder': 'Notitie toevoegen (optioneel)',
  'review.item.viewEvidence': 'Onderbouwing bekijken',
  // ---- P5 reviewer text selections (spec §12.1 "Review separately"; plan §10) ----
  'review.selection.start': 'Passage apart beoordelen',
  'review.selection.hint':
    'Selecteer de passage in de oorspronkelijke tekst hieronder (zonder opmaak getoond) en kies ' +
    'daarna “Apart beoordelen”.',
  'review.selection.surfaceAria': 'Oorspronkelijke tekst van beoordelingspunt {n}',
  'review.selection.add': 'Apart beoordelen',
  'review.selection.close': 'Klaar',
  'review.selection.added': 'Passage toegevoegd als apart beoordelingspunt.',
  'review.selection.refused':
    'Deze selectie kon niet worden toegevoegd. Selecteer de passage opnieuw en probeer het nog ' +
    'eens.',
  'review.item.selectionTag': 'Tekstselectie bij de beoordeling',
  'review.selection.remove': 'Selectie verwijderen',
  'review.decision.groupAria': 'Beslissing',
  'review.decision.supported': 'Beoordeeld – onderbouwd',
  'review.decision.partly_supported': 'Beoordeeld – deels onderbouwd',
  'review.decision.not_supported': 'Beoordeeld – niet onderbouwd',
  'review.decision.follow_up': 'Opvolging nodig',
  'review.decision.not_reviewed': 'Niet beoordeeld',
  'review.decision.not_applicable': 'Niet van toepassing',
  'review.bulk.menu': 'Bulkacties',
  'review.bulk.headingsNa': 'Koppen markeren als “Niet van toepassing”',
  'review.bulk.followUp': 'Punten zonder beslissing markeren als “Opvolging nodig”',
  'review.bulk.clear': 'Alle beslissingen wissen',
  'review.bulk.clearConfirmTitle': 'Alle beslissingen wissen?',
  'review.bulk.clearConfirmBody':
    'Elke beslissing in deze beoordeling gaat terug naar “Niet beoordeeld”. Notities blijven ' +
    'behouden.',
  'review.bulk.clearConfirm': 'Beslissingen wissen',
  'review.progress': 'Beslist: {decided} van {required}',
  'review.progress.followUps.one': '{count} punt voor opvolging',
  'review.progress.followUps.other': '{count} punten voor opvolging',
  'review.footer.summary': 'Samenvatting van de beoordeling',
  'review.summary.status': 'Status',
  'review.summary.decisions': 'Beslissingen',
  'review.summary.sources': 'Bronnen',
  'review.summary.sourcesCount.one': '{count} bron',
  'review.summary.sourcesCount.other': '{count} bronnen',
  'review.summary.sourcesUnresolved.one':
    'Van {count} bron kon de identiteit niet worden vastgesteld',
  'review.summary.sourcesUnresolved.other':
    'Van {count} bronnen kon de identiteit niet worden vastgesteld',
  'review.summary.sourcesArchive.one':
    '{count} bron is een artikel uit een kennispakket dat niet aan de hand van de werkruimte kan ' +
    'worden gecontroleerd',
  'review.summary.sourcesArchive.other':
    '{count} bronnen zijn artikelen uit kennispakketten die niet aan de hand van de werkruimte ' +
    'kunnen worden gecontroleerd',
  'review.summary.sourcesMissing.one':
    '{count} bron was niet beschikbaar toen deze beoordeling werd aangemaakt',
  'review.summary.sourcesMissing.other':
    '{count} bronnen waren niet beschikbaar toen deze beoordeling werd aangemaakt',
  'review.summary.sourcesChangedNow.one':
    '{count} brondocument is gewijzigd sinds deze beoordeling is aangemaakt',
  'review.summary.sourcesChangedNow.other':
    '{count} brondocumenten zijn gewijzigd sinds deze beoordeling is aangemaakt',
  'review.summary.sourcesMissingNow.one': '{count} brondocument staat niet meer in de werkruimte',
  'review.summary.sourcesMissingNow.other':
    '{count} brondocumenten staan niet meer in de werkruimte',
  'review.summary.truncated':
    'Het gegenereerde antwoord is mogelijk onvolledig: het is afgekapt bij de uitvoerlimiet van ' +
    'het model.',
  'review.summary.stopped.model':
    'Het gegenereerde antwoord is onvolledig: het AI-model is gestopt of gewisseld voordat het ' +
    'antwoord klaar was.',
  'review.summary.stopped.user':
    'Het gegenereerde antwoord is onvolledig: het genereren is gestopt voordat het antwoord ' +
    'klaar was.',
  'review.summary.stopped.lock':
    'Het gegenereerde antwoord is onvolledig: de werkruimte is vergrendeld of de app is gesloten ' +
    'voordat het antwoord klaar was.',
  'review.summary.generation': 'Details van het genereren',
  'review.summary.model': 'Model',
  'review.summary.generatedAt': 'Gegenereerd',
  'review.summary.appVersion': 'Versie van de app',
  'review.summary.skill': 'Skill',
  'review.summary.unavailable': 'Niet beschikbaar',
  'review.summary.reviewerLabel': 'Beoordelaar',
  'review.summary.reviewerPlaceholder': 'Je naam of een aanduiding (optioneel)',
  'review.summary.generalNote': 'Algemene notitie',
  'review.summary.generalNotePlaceholder': 'Algemene opmerkingen (optioneel)',
  'review.summary.exports': 'Exportgeschiedenis',
  'review.summary.markReady': 'Beoordeling afronden',
  'review.summary.reopen': 'Beoordeling heropenen',
  'review.summary.gateHint':
    'Elk antwoordblok heeft een beslissing nodig voordat de beoordeling kan worden afgerond ' +
    '(beslist: {decided} van {required}). “Niet van toepassing” telt als beslissing.',
  'review.toast.ready': 'Beoordeling afgerond.',
  'review.completedAt': 'Afgerond op {date}',
  'review.deleteWithConversation.one':
    '{count} beoordeling van de onderbouwing bij dit gesprek wordt ook verwijderd.',
  'review.deleteWithConversation.other':
    '{count} beoordelingen van de onderbouwing bij dit gesprek worden ook verwijderd.',
  'review.deleteWithConversation.unknown':
    'Eventuele beoordelingen van de onderbouwing bij dit gesprek worden ook verwijderd.',
  // ---- Evidence-pack export (EP-1 plan §8 — summary panel + status line) ----
  'review.status.lastExported': 'Laatst geëxporteerd op {date}',
  'review.export.action': 'Onderbouwingspakket aanmaken',
  'review.export.title': 'Onderbouwingspakket exporteren',
  'review.export.encryptionWarning':
    'Dit geëxporteerde bestand staat buiten de versleutelde werkruimte van HilbertRaum en wordt ' +
    'niet beschermd door het wachtwoord van je werkruimte.',
  'review.export.packLanguage.en': 'Dit pakket wordt in het Engels geschreven.',
  'review.export.packLanguage.de': 'Dit pakket wordt in het Duits geschreven.',
  'review.export.options': 'In het pakket opnemen',
  'review.export.optNotes': 'Notities bij de beoordeling',
  'review.export.optExcerpts': 'Fragmenten uit de bronnen',
  'review.export.optHashes': 'Hashes van de documenten',
  'review.export.optUnreviewed': 'Niet-beoordeelde punten',
  'review.export.optTechnical': 'Technische details',
  'review.export.format': 'Bestandsindeling',
  'review.export.formatHtml': 'HTML – op zichzelf staande webpagina',
  'review.export.formatPdf': 'PDF – klaar om af te drukken (A4)',
  'review.export.confirm': 'Pakket exporteren…',
  'review.export.cancel': 'Sluiten',
  'review.export.done': 'Onderbouwingspakket geëxporteerd.',
  'review.export.error':
    'Het onderbouwingspakket kon niet worden geëxporteerd. Er is geen bestand geschreven.',
  'review.export.copyHash': 'SHA-256 kopiëren',
  'review.export.hashCopied': 'SHA-256 gekopieerd naar het klembord.'
}
