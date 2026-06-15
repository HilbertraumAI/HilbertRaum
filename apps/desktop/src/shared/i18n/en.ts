// The ENGLISH catalog — the source of truth for every message key (i18n record §3.1,
// D-L1). Flat keys, `{name}` interpolation placeholders, `.one`/`.other` plural pairs.
// `de.ts` is typed `Record<MessageKey, string>` against this object, so `npm run
// typecheck` fails when the catalogs drift apart.
//
// English values for strings that already shipped MUST stay byte-identical to the
// pre-i18n literals: ~323 existing test assertions query this copy, and the default
// language resolves to English on the EN dev/CI machine (D-L8).

export const en = {
  // ---- App shell (App.tsx) ----
  'nav.aria': 'Main',
  'nav.home': 'Home',
  'nav.chat': 'Chat',
  // Soft hyphen (U+00AD) gives the narrow nav rail a clean break point ("Docu-/ments")
  // since Electron has no auto-hyphenation; invisible when the word fits or in the tooltip.
  'nav.documents': 'Docu­ments',
  'nav.models': 'AI Model',
  'nav.settings': 'Settings',
  'app.lockNow': 'Lock now',
  'app.lockNowTitle': 'Re-encrypt and lock the workspace',
  'app.noticeDetails': 'Details',
  'app.fatal.title': 'The app could not start',
  // Split around the inline <code>logs/app.log</code> element (the path is literal).
  'app.fatal.hintBefore':
    'The local backend did not come up, so nothing can be loaded. Restart the app; if this ' +
    'keeps happening, check ',
  'app.fatal.hintAfter': ' on your drive and see docs/troubleshooting.md.',
  'app.loadingWorkspace': 'Loading workspace…',

  // ---- Home (HomeScreen.tsx) ----
  'home.headline.ready': 'Ready to chat.',
  'home.headline.starting': 'Getting ready…',
  'home.headline.almost': 'Almost set up.',
  'home.lead':
    'A private, offline AI workspace. Your prompts, documents, and chat history stay on ' +
    'this device.',
  // Split around the inline <strong>docs</strong> (a literal folder name, untranslated).
  // {folder} is the literal drive folder name (not translated); the UI bolds it.
  'home.preflight.continue':
    'You can still continue. If the app doesn’t open, see the troubleshooting guide in the ' +
    'drive’s {folder} folder.',
  'home.checking': 'Checking…',
  'home.workspace.label': 'Workspace',
  'home.workspace.encrypted': 'Encrypted — locked with your password when the app is closed',
  'home.workspace.plaintext': 'Plaintext (developer mode)',
  'home.workspace.badgeProtected': 'Protected',
  'home.workspace.badgeDeveloper': 'Developer',
  'home.model.label': 'AI model',
  'home.model.fallbackName': 'Your model',
  'home.model.running': '{model} is running on this device',
  'home.model.selected': '{model} is selected — it may still be loading',
  'home.model.none': 'No model selected yet',
  'home.model.badgeRunning': 'Running',
  'home.model.badgeStarting': 'Starting',
  'home.model.badgeNeedsModel': 'Needs a model',
  'home.model.open': 'Open AI Model',
  'home.model.choose': 'Choose a model',
  'home.docs.label': 'Documents',
  'home.docs.none': 'No documents yet — add some to ask about them',
  'home.docsReady.one': '{count} document ready to ask about',
  'home.docsReady.other': '{count} documents ready to ask about',
  'home.docs.badgeReady': 'Ready',
  'home.docs.badgeNone': 'None yet',
  'home.docs.add': 'Add documents',
  'home.actions.startChat': 'Start chatting',
  'home.actions.askDocs': 'Ask my documents',

  // ---- Chat (ChatScreen.tsx) ----
  'chat.title': 'Chat',
  'chat.noModel.title': 'No model is running',
  // Split around the inline <b>Start runtime</b>.
  'chat.noModel.hintBefore':
    'Chat and document Q&A need a model loaded into the runtime. Open the AI Model screen, ' +
    'pick a model, then choose ',
  'chat.noModel.hintAction': 'Start runtime',
  'chat.noModel.hintAfter': '. Everything stays local — nothing is downloaded or sent anywhere.',
  'chat.noModel.stillLoading':
    'If you just opened the app, your selected model may still be loading — this screen ' +
    'continues automatically once it is ready.',
  'chat.noModel.starting':
    'Your model is starting — large models take a little while to load. This screen ' +
    'continues automatically once it is ready.',
  'chat.noModel.open': 'Open AI Model',
  'chat.noModel.recheck': 'Re-check',
  'chat.empty.title': 'Ask a question, or ask about your documents.',
  'chat.empty.lineDocuments': 'Answers come from your documents and cite their sources.',
  'chat.empty.lineChat': 'Replies stream from the model on this drive — nothing leaves it.',
  'chat.empty.fillTitle': 'Fill the message box',
  'chat.empty.addDocs': 'Add documents to ask about them',
  // Two example sets: plain Chat has no documents, so its prompts are general-purpose;
  // the "Ask my documents" mode keeps document-shaped prompts. ChatScreen picks by mode.
  'chat.exampleChat.explain': 'Explain a concept in simple terms',
  'chat.exampleChat.draftEmail': 'Help me write a polite email',
  'chat.exampleChat.brainstorm': 'Brainstorm ideas for a project',
  'chat.example.summarize': 'Summarize this document',
  'chat.example.paymentTerms': 'What are the payment terms?',
  'chat.example.indemnity': "Find every mention of 'indemnity'",
  'chat.modeAria': 'Chat mode',
  'chat.mode.chat': 'Chat',
  'chat.mode.documents': 'Ask my documents',
  'chat.listShow': 'Show conversation list',
  'chat.convOptions': 'Conversation options',
  'chat.saveConversation': 'Save this conversation',
  'chat.savedTo': 'Saved to {path}',
  'chat.copied': 'Copied',
  'chat.stopped': 'Stopped — the reply may be incomplete',
  'chat.scopeNotice': 'Answering from {titles} only',
  'chat.cancelDocTask': 'Cancel document task',
  'chat.placeholder.documents': 'Ask about your documents…',
  'chat.placeholder.chat': 'Message…',
  'chat.send.ask': 'Ask',
  'chat.send.send': 'Send',
  'chat.composer.stop': 'Stop',

  // ---- Chat: conversation list (ConversationList.tsx) ----
  'chat.list.title': 'Conversations',
  'chat.list.aria': 'Conversation history',
  'chat.list.newChat': '+ New chat',
  'chat.list.newDocQa': '+ New document Q&A',
  'chat.list.hide': 'Hide conversation list',
  'chat.list.empty': 'No conversations yet.',
  'chat.list.docMeta': 'Documents',
  'chat.list.otherGroup': 'Other / Library',
  'chat.list.rowOptionsAria': 'Options for conversation "{title}"',
  'chat.search.placeholder': 'Search conversations…',
  'chat.search.aria': 'Search conversations',
  'chat.search.resultsAria': 'Search results',
  'chat.search.resultsFor': 'Results for “{query}”',
  'chat.search.noMatches': "I didn't find a match. Try rephrasing.",
  'chat.search.count.one': '{count} result',
  'chat.search.count.other': '{count} results',
  'chat.group.today': 'Today',
  'chat.group.yesterday': 'Yesterday',
  'chat.group.last7days': 'Last 7 days',
  'chat.group.earlier': 'Earlier',
  'chat.delete.menuItem': 'Delete conversation',
  'chat.delete.title': 'Delete this conversation?',
  'chat.delete.confirm': 'Delete',
  'chat.delete.body': '“{title}” and its messages will be permanently removed from this drive.',

  // ---- Chat: answer depth (DepthMenu.tsx; ids stay fast|balanced|deep) ----
  'chat.depth.trigger': 'Answer detail: {label}',
  'chat.depth.fast': 'Quick',
  'chat.depth.balanced': 'Balanced',
  'chat.depth.deep': 'Thorough',
  'chat.depth.fastHint': 'Short, to-the-point answers',
  'chat.depth.balancedHint': 'The everyday default',
  'chat.depth.deepHint': 'Thinks the problem through before answering — takes longer',

  // ---- Chat: transcript + message actions ----
  'chat.role.user': 'You',
  'chat.role.assistant': 'HilbertRaum',
  'chat.thinking': 'Thinking…',
  'chat.actions.tryAgain': 'Try again',
  'chat.actions.copy': 'Copy',
  'chat.actions.save': 'Save',
  'chat.actions.saveTitle': 'Save this conversation as a file (stays local)',

  // ---- Chat: document scope (ScopePopover.tsx) ----
  // Truthful, calm scope copy: never "Using all 0 documents". Zero documents routes to
  // a "No documents yet · Add documents" affordance; "all" never shows a count.
  'chat.scope.usingAll': 'Using all documents',
  'chat.scope.usingSome.one': 'Using {count} document',
  'chat.scope.usingSome.other': 'Using {count} documents',
  'chat.scope.none': 'No documents yet · Add documents',
  'chat.scope.popoverAria': 'Documents to ask',
  'chat.scope.allLine': 'Answers come from all your documents. Pick documents to ask only those:',
  'chat.scope.someLine': 'Answers come from these documents only:',
  'chat.scope.addLine': 'Add a document:',
  'chat.scope.stopAsking': 'Stop asking {title}',
  'chat.scope.askToo': 'Ask {title} too',
  'chat.scope.useAll': 'Use all documents',
  'chat.scope.removedDoc': 'Removed document',

  // ---- Chat: sources (SourcesDisclosure.tsx) ----
  'chat.sources.toggle': 'Sources ({count})',
  'chat.sources.page': 'Page {page}',

  // ---- Chat: dictation (DictationButton.tsx) ----
  'chat.dictation.start': 'Dictate a message',
  'chat.dictation.stop': 'Stop dictation and insert the text',
  'chat.dictation.transcribing': 'Turning your speech into text',
  'chat.dictation.noSpeech': 'No speech was recognized — try speaking again.',
  'chat.dictation.micBlocked':
    'The microphone could not be used. Check the system microphone settings, then try again.',

  // ---- Documents (DocumentsScreen.tsx) ----
  'docs.title': 'Documents',
  'docs.lead':
    'Import documents to ask questions about them. Each file is copied into your workspace ' +
    'and prepared for search — everything stays on this drive. Ask from the Chat screen\'s ' +
    '"Ask my documents" mode.',
  'docs.status.queued': 'Waiting',
  'docs.status.extracting': 'Reading',
  'docs.status.preparing': 'Preparing',
  'docs.status.indexed': 'Ready',
  'docs.status.failed': 'Failed',
  'docs.status.deleted': 'Deleted',
  'docs.status.transcribing': 'Transcribing…',
  'docs.task.summaryBusy': 'Summarizing…',
  'docs.task.translationBusy': 'Translating…',
  'docs.task.compareBusy': 'Comparing…',
  'docs.task.ocrBusy': 'Reading the scan…',
  'docs.task.treeBusy': 'Building a deep index…',
  'docs.task.extractBusy': 'Scanning for details…',
  'docs.task.summaryBusyTitle': 'The summary is being written',
  'docs.task.translationBusyTitle': 'The translation is being written',
  'docs.task.compareBusyTitle': 'The comparison is being written',
  'docs.task.ocrBusyTitle': 'The scanned pages are being read',
  'docs.task.treeBusyTitle': 'A deep index is being built for the whole document',
  'docs.task.extractBusyTitle':
    'The whole document is being scanned so it can answer "list every…" questions',
  'docs.error.noSupported': 'No supported documents were found in that selection.',
  'docs.removedDocFallback': 'a removed document',
  // Provenance lines render around inline <b>title</b> elements.
  'docs.provenance.compareBefore': 'Comparison of ',
  'docs.provenance.compareMiddle': ' and ',
  'docs.provenance.translatedBefore': 'Translated from ',
  'docs.provenance.summaryBefore': 'Summary of ',
  'docs.provenance.generatedBefore': 'Generated from ',
  'docs.import.busy': 'Importing…',
  'docs.import.files': 'Import files',
  'docs.import.folder': 'Import folder',
  'docs.refresh': 'Refresh',
  'docs.askSelected': 'Ask these documents ({count})',
  'docs.askSelectedTitle': 'Open a document Q&A scoped to the selected documents',
  'docs.compareBtn': 'Compare (2)',
  'docs.compareBtnTitle':
    'Write a comparison of the two selected documents with the local model — nothing ' +
    'leaves this drive',
  'docs.reindexAll': 'Re-index all ({count})',
  'docs.reindexAllTitle': 'Re-index every document that was indexed with a different search model',
  'docs.reindexAllConfirm.title': 'Re-index {count} documents?',
  'docs.reindexAllConfirm.body':
    'This re-reads and re-embeds every stale document one at a time. It can take several ' +
    'minutes and uses the processor heavily — you can keep working, but answers may be slower ' +
    'until it finishes.',
  'docs.reindexAllConfirm.confirm': 'Re-index all',
  'docs.reindexAllProgress': 'Re-indexing {done} of {total}…',
  'docs.supported.base':
    'Supported: TXT, Markdown, PDF, DOCX, CSV — audio recordings (WAV, MP3, FLAC, OGG), ' +
    'which are transcribed on this drive',
  'docs.supported.ocrExtra': ', and photos of pages (PNG, JPG), which are read on this drive',
  'docs.preparing': 'Preparing your documents so you can ask about them…',
  'docs.empty.title': 'No documents yet',
  'docs.empty.line': 'Import files to ask questions about them — everything stays on this drive.',
  'docs.selectAria': 'Select {title} for asking',
  'docs.selectTitle': 'Select to ask only chosen documents',
  'docs.meta.size': 'Size',
  'docs.meta.sections': 'Sections',
  'docs.meta.sectionsCount.one': '{count} section',
  'docs.meta.sectionsCount.other': '{count} sections',
  'docs.meta.type': 'Type',
  'docs.meta.summary': 'Summary',
  'docs.scan.ocrOffer': 'Use "Make searchable (OCR)" below to read the pages on this drive.',
  'docs.scan.ocrMissing': 'Making it searchable needs the OCR files, which are not on this drive.',
  'docs.stale.banner':
    'This document was prepared with a different search model — re-index it so answers ' +
    'can find it.',
  'docs.preview': 'Preview',
  'docs.previewBusy': 'Opening…',
  'docs.previewTitle': 'Read the extracted text (read-only; nothing leaves the app)',
  'docs.cancel': 'Cancel',
  'docs.cancelOcrTitle': 'Stop reading the scan',
  'docs.cancelTaskTitle': 'Stop the task',
  'docs.makeSearchable': 'Make searchable (OCR)',
  'docs.makeSearchableTitle':
    'Read the scanned pages with local text recognition — nothing leaves this drive',
  'docs.summarize': 'Summarize',
  'docs.summarizeAgain': 'Summarize again',
  'docs.summarizeTitle': 'Write a summary with the local model — nothing leaves this drive',
  'docs.translate': 'Translate',
  'docs.translateTitle': 'Translate with the local model — nothing leaves this drive',
  'docs.export': 'Export',
  'docs.exportTitle': 'Save this document as a Markdown file',
  'docs.reindex': 'Re-index',
  'docs.reindexBusy': 'Re-indexing…',
  'docs.reindexTitle': 'Read and prepare the stored copy again',
  'docs.delete': 'Delete',
  // Per-row overflow ("⋯") menu (§11.6): one inline Preview + this menu carries the rest.
  // The trigger keeps an accessible name even though it is revealed on hover.
  'docs.moreActions': 'More actions for {title}',
  'docs.audioConfirm.title': 'Import large audio?',
  'docs.audioConfirm.confirm': 'Import and transcribe',
  'docs.audioConfirm.contains.one': 'This selection contains {count} audio recording ({size}).',
  'docs.audioConfirm.contains.other': 'This selection contains {count} audio recordings ({size}).',
  'docs.audioConfirm.body':
    'Each recording is copied into your workspace and transcribed on this drive — ' +
    'a long recording can take a while. You can keep using the app meanwhile.',
  'docs.deleteConfirm.title': 'Delete "{title}"?',
  'docs.deleteConfirm.body':
    'This permanently removes the document, its extracted text, and its search index from ' +
    'your workspace. The original file outside the workspace is not touched.',
  'docs.translateModal.title': 'Translate "{title}"',
  'docs.translateModal.aria': 'Translate {title}',
  'docs.translateModal.hint':
    'The local model writes a translated copy as a new document — searchable and ' +
    'askable like any import, and nothing leaves this drive. Machine translations ' +
    'can contain errors.',
  'docs.translateModal.toGerman': 'To German (Deutsch)',
  'docs.translateModal.toEnglish': 'To English',
  'docs.previewModal.aria': 'Preview of {title}',
  'docs.previewModal.hint':
    'Read-only extracted text — this is what document search and answers are based on.',
  'docs.previewModal.ocrInfo.one':
    'Text recognized on this drive (OCR) — {count} page. Recognition can contain errors.',
  'docs.previewModal.ocrInfo.other':
    'Text recognized on this drive (OCR) — {count} pages. Recognition can contain errors.',
  'docs.previewModal.summary': 'Summary',
  'docs.previewModal.generatedBy': 'Generated by {model}',
  'docs.previewModal.truncated':
    'This document is long — the summary covers its beginning. The rest is still ' +
    'searchable and answerable in chat.',
  'docs.previewModal.regenerate': 'Regenerate',
  'docs.previewModal.copy': 'Copy',
  'docs.previewModal.save': 'Save',
  'docs.previewModal.copied': 'Summary copied',
  'docs.previewModal.copyFailed': 'Could not copy to the clipboard',
  'docs.previewModal.savedTo': 'Summary saved to {path}',
  'docs.previewModal.noText': 'No text could be extracted from this document.',
  'docs.previewModal.page': 'Page {page}',

  // ---- Deep index + coverage (whole-document-analysis plan §5.2) ----
  // User words only: "deeply indexed" (a ready summary tree), "sections" (chunks),
  // "passages" (retrieved excerpts). No tree/node/chunk/vector/embedding jargon.
  'docs.deepIndex.build': 'Build deep index',
  'docs.deepIndex.buildTitle':
    'Read the whole document into a deep index so summaries and answers can cover all of ' +
    'it — runs on this drive, nothing leaves it',
  'docs.deepIndex.reindexFirst': 'Re-index for deep index',
  'docs.deepIndex.reindexFirstTitle':
    'This document was added before deep indexing was available — re-index it first so a ' +
    'deep index can cover the whole document',
  'docs.deepIndex.ready': 'Deeply indexed',
  'docs.deepIndex.readyTitle':
    'A whole-document deep index is ready — summaries can cover everything',
  'coverage.relevance': 'Based on the most relevant passages — not the whole document',
  'coverage.capped.whole': 'Covers the whole document',
  'coverage.capped.beginning': 'Covers the beginning of the document',
  'coverage.tree.whole': 'Covers the whole document (deeply indexed)',
  'coverage.tree.partial': 'Deep index in progress — {covered} of {total} sections',
  'coverage.tree.pending': 'No deep index yet',
  'coverage.depth': 'Detail: {label}',
  'coverage.tier.1': 'Overview',
  'coverage.tier.2': 'Section by section',
  'coverage.tier.3': 'Detailed (full coverage)',
  'coverage.tier.hint.1': 'Fastest — the stored overview',
  'coverage.tier.hint.2': 'A richer pass across the sections',
  'coverage.tier.hint.3': 'The most detail, across the whole document',
  'coverage.tierSelect.trigger': 'Detail: {label}',
  // Structured-extract listing coverage (whole-document-analysis plan §4.2/§5.2, Phase 3).
  // Exhaustive over the sections scanned — NEVER "complete" (H7). "Whole document" only when
  // every in-scope document is fully indexed.
  'coverage.extract.whole': 'Every match found across the whole document — {scanned} sections scanned',
  'coverage.extract.wholeUnparsed':
    'Every match found across the whole document — {scanned} sections scanned, {unparsed} could not be read',
  'coverage.extract.sections': 'Every match found across {scanned} sections scanned',
  'coverage.extract.sectionsUnparsed':
    'Every match found across {scanned} sections scanned, {unparsed} could not be read',

  // ---- "List every X" answer (whole-document-analysis plan §4.2, Phase 3) ----
  // The deterministic listing answer (0 model calls). User words only — "sections", no
  // chunk/record/extract jargon. Honest: exhaustive over the sections scanned, not "complete".
  'analysis.kind.generic': 'items',
  'analysis.kind.date': 'dates',
  'analysis.kind.amount': 'amounts',
  'analysis.kind.party': 'parties',
  'analysis.kind.obligation': 'obligations',
  'analysis.listing.coverageWhole':
    'Found {count} {kind} across the whole document — {scanned} sections scanned{unparsed}:',
  'analysis.listing.coverageSections':
    'Found {count} {kind} across {scanned} sections scanned{unparsed}:',
  'analysis.listing.empty': 'No {kind} found across {scanned} sections scanned{unparsed}.',
  'analysis.listing.unparsedSuffix': ' ({k} could not be read)',
  'analysis.listing.item': '- {value} (×{count})',
  'analysis.listing.caveat':
    'This list is exhaustive over the sections scanned — not guaranteed complete (a small ' +
    'model can miss an item, and very similar entries may be merged).',
  'analysis.listing.refPage': 'p. {n}',
  'analysis.listing.refSection': 'section {n}',

  // ---- Models (ModelsScreen.tsx) ----
  'models.title': 'AI Model',
  'models.lead':
    'The AI model answers your questions, entirely on this device. Everything is verified ' +
    'before use, and nothing is downloaded without your explicit confirmation.',
  'models.loadError': 'Could not load models: {error}',
  'models.checking':
    'Checking model files… The first check after adding or updating a model can take a few ' +
    'minutes for large files; after that the result is remembered and this is instant.',
  // Determinate variant shown once first-run hashing actually starts (the % is the bar).
  'models.checkingProgress': 'Checking model {n} of {m}: {name} — {pct}%',
  'models.state.installed': 'Installed',
  'models.state.missing': 'Not downloaded',
  'models.state.checksumFailed': 'Can’t verify',
  'models.state.unsupported': 'Unsupported',
  'models.state.notRecommended': 'Not recommended',
  'models.state.ready': 'Ready',
  'models.state.running': 'Running',
  'models.hint.embeddings': 'Prepares your documents so you can ask about them.',
  'models.hint.reranker': 'Improves which document passages are used for answers.',
  'models.hint.transcriber':
    'Turns audio recordings into searchable text — and unlocks the 🎤 voice-dictation button in chat.',
  'models.hint.small': 'Small and quick — fast answers on nearly any machine.',
  'models.hint.balanced': 'Balanced — works well on most laptops.',
  'models.hint.large': 'Large — strongest answers; needs a powerful machine.',
  'models.usesSpace': 'Uses {size} of drive space.',
  'models.downloads.blockedByPolicy': 'Downloads are disabled by this drive’s policy.',
  'models.downloads.enableInSettings':
    'To download models, turn on “Allow internet access for model downloads and updates” ' +
    'in Settings.',
  'models.download.verifying': 'Verifying the downloaded file…',
  'models.download.progress': 'Downloading… {pct} % ({received} of {total})',
  'models.download.progressNoTotal': 'Downloading… {received} so far',
  'models.download.cancel': 'Cancel download',
  'models.download.cancelled': 'Download cancelled — starting it again resumes where it stopped.',
  // Split around the inline <code>verify-models --generate</code>.
  'models.download.unverifiedBefore':
    'Downloaded, but this model’s manifest has no real checksum yet so the file stays ' +
    'unverified. Capture one with ',
  'models.download.unverifiedAfter': '.',
  'models.download.otherRunning': 'Another download is running — one model downloads at a time',
  'models.download.titled': 'Download {name} ({size})',
  'models.download.resume': 'Resume download',
  'models.download.start': 'Download',
  // In-app engine (llama.cpp + whisper.cpp) installer banner — shown when an engine is missing.
  'models.engine.title': 'Install the AI engine',
  'models.engine.explain':
    'Models run in a built-in demo mode (visibly simulated answers) until the AI engine ' +
    'is installed; voice dictation needs the voice engine. Install the engines once — then ' +
    'start a model for real answers.',
  'models.engine.install': 'Install AI engine',
  'models.engine.retry': 'Try again',
  'models.engine.progress': 'Downloading the AI engine… {pct} %',
  'models.engine.downloadingNoTotal': 'Downloading the AI engine…',
  'models.engine.verifying': 'Verifying the AI engine…',
  'models.engine.extracting': 'Unpacking the AI engine…',
  'models.engine.installedNote': 'The AI engine is installed — start a model to use it.',
  // Voice-engine-only note: the chat engine is installed (chat works for real); only the
  // optional voice engine (whisper.cpp) is missing, so this is a quiet info note — never the
  // "demo mode" alarm. Reuses the engine download job (progress/retry/policy) keys above.
  'models.voiceEngine.title': 'Add voice dictation (optional)',
  'models.voiceEngine.explain':
    'Chat and document answers already work on this drive. The voice engine is optional — ' +
    'install it only if you want to dictate messages with your microphone.',
  'models.voiceEngine.install': 'Install voice engine',
  // RAM-gate copy, composed of full clauses (spec §11.4 — never "your hardware is bad").
  'models.ram.needs': 'Needs at least {min} GB RAM',
  'models.ram.machine': ' — this computer has about {ram} GB',
  'models.ram.advice': '. Pick a smaller model — quality stays great.',
  'models.badge.active': 'Active',
  'models.badge.recommended': 'Recommended',
  'models.badge.ramNeeded': 'Needs ≥{min} GB RAM',
  'models.automatic.installed': 'Installed — used automatically. There is nothing to start.',
  'models.automatic.notInstalled': 'Used automatically once installed — no setup needed.',
  'models.selected': 'Selected',
  'models.select': 'Select',
  'models.stopRuntime': 'Stop runtime',
  'models.startRuntime': 'Start runtime',
  'models.startMock': 'Start mock runtime',
  'models.starting': 'Starting…',
  'models.startingTitle': 'This model is loading — it can take a little while for large models',
  'models.startTitle': 'Start the local runtime for this model',
  'models.startMockTitle':
    'No weights present — starts the built-in mock runtime so you can try the app',
  'models.notPresentTitle': 'Model file not present',
  'models.tech.summary': 'Technical details',
  'models.tech.id': 'Model id',
  'models.tech.family': 'Family',
  'models.tech.format': 'Format',
  'models.tech.runtime': 'Runtime',
  'models.tech.license': 'License',
  'models.tech.sizeOnDisk': 'Size on disk',
  'models.tech.minRam': 'Minimum RAM',
  'models.tech.recRam': 'Recommended RAM',
  'models.tech.context': 'Context window',
  'models.tech.contextValue': '{count} tokens',
  'models.tech.file': 'File',
  'models.verifyTitle':
    'Re-hash the file on disk and check it against its SHA-256 (bypasses the cache)',
  'models.verifying': 'Verifying…',
  'models.verify': 'Verify checksum',
  'models.confirm.title': 'Download {name}?',
  'models.confirm.start': 'Start download',
  'models.confirm.size': 'Size',
  'models.confirm.license': 'License',
  'models.confirm.from': 'From',
  'models.confirm.readLicense': 'read the license',
  'models.confirm.hint':
    'The downloaded file is verified before it is used. This is the only network request ' +
    'the app makes — nothing about you or your documents is sent.',
  'models.confirm.licenseAck': 'I have read and accept this model’s license terms',
  'models.empty.title': 'No model manifests found',
  // Split around the inline <code>model-manifests/</code>.
  'models.empty.lineBefore': 'Add YAML manifests under ',
  'models.empty.lineAfter': ' on the drive.',
  'models.section.yourModel': 'Your AI model',
  'models.section.otherModels': 'Other models',
  'models.section.choose': 'Choose your AI model',
  'models.section.docSearch': 'Document search',
  'models.section.other': 'Other',

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

  // ---- Settings → Privacy & data tab (PrivacyTab.tsx) ----
  'privacy.offlineOn': '● Offline Mode: ON',
  'privacy.offlineOff': '○ Network access enabled',
  // spec §18.1 — the offline statement (verbatim in English).
  'privacy.statement.offline':
    'Offline Mode is on. HilbertRaum runs the AI model on your laptop. Your ' +
    'prompts, documents, embeddings, and chat history stay local.',
  'privacy.statement.online':
    'HilbertRaum runs the AI model on your laptop. Your prompts, documents, ' +
    'embeddings, and chat history stay local — even with internet access enabled, only ' +
    'model downloads use the network.',
  'privacy.statement.noUploads':
    'This app does not send your data to cloud AI providers. There are no prompt, ' +
    'document, or embedding uploads, no telemetry, no analytics, and no remote crash ' +
    'reporting.',
  'privacy.network.title': 'Current network state',
  'privacy.networkState.noPolicy': 'Offline Mode is on.',
  'privacy.networkState.disabledByPolicy': 'Network access disabled by policy.',
  'privacy.networkState.offDefault': 'Offline Mode is on (network off by default).',
  'privacy.networkState.enabled': 'Internet access is enabled for model downloads and updates.',
  'privacy.network.noFiles': 'No prompts or files leave this device.',
  'privacy.network.effective': 'Effective state',
  'privacy.network.effectiveOffline': 'Offline (no network calls)',
  'privacy.network.effectiveAllowed': 'Network allowed',
  'privacy.network.byPolicy': 'Allowed by policy',
  'privacy.network.policyYes': 'Yes',
  'privacy.network.policyNo': 'No (disabled by policy)',
  'privacy.network.yourSetting': 'Your setting',
  'privacy.network.settingAllowed': 'Internet access allowed',
  'privacy.network.settingOff': 'Off (default)',
  'privacy.network.telemetry': 'Telemetry',
  'privacy.network.telemetryValue': 'Nothing leaves this drive — there’s no tracking to turn off',
  'privacy.network.hint':
    'The app warns before any network action. The only optional network feature is ' +
    'downloading or updating models, which is off by default and must be enabled on the ' +
    'General tab. A drive policy can disable it entirely.',
  'privacy.data.title': 'Where your data lives',
  'privacy.data.driveRoot': 'Drive root',
  'privacy.data.workspace': 'Workspace',
  'privacy.data.models': 'Models',
  'privacy.data.logs': 'Logs',
  'privacy.data.loading': 'Loading paths…',
  'privacy.data.hint':
    'Everything — imported documents, extracted text, embeddings, chat history, generated ' +
    'outputs, settings — is stored locally under your workspace. To delete it, remove the ' +
    'workspace folder.',
  'privacy.logs.title': 'Local logs only',
  // Split around the inline <strong>never uploaded</strong>.
  'privacy.logs.hintBefore':
    'Debug and diagnostic logs are written to a rotating file under the logs folder above ' +
    'and are ',
  'privacy.logs.never': 'never uploaded',
  'privacy.logs.hintAfter': '. Diagnostics does not transmit anything off this device.',
  'privacy.protection.title': 'Workspace protection',
  // Split around the inline <strong>…</strong> mode words.
  'privacy.protection.encryptedBefore': 'Your workspace is in ',
  'privacy.protection.encryptedWord': 'encrypted',
  'privacy.protection.encryptedAfter': ' mode.',
  'privacy.protection.plainBefore': 'Your workspace is in ',
  'privacy.protection.plainWord': 'plaintext developer mode',
  'privacy.protection.plainAfter':
    '. Files are stored unencrypted on the drive for development speed.',
  'privacy.protection.plainWarning':
    'Plaintext developer mode is not the commercial default. The encrypted mode — ' +
    'password-derived key, nothing stored in plaintext — is what commercial drives use. ' +
    'Do not store sensitive documents in plaintext mode on a shared or removable drive.',

  // ---- Settings → Diagnostics tab (DiagnosticsTab.tsx) ----
  'diag.localOnly': 'Local-only diagnostics. Nothing here is ever uploaded.',
  // Friendly labels for the Activity panel's entries + type filter (spec §11.4 tone).
  'diag.audit.runtime_started': 'Model started',
  'diag.audit.runtime_stopped': 'Model stopped',
  'diag.audit.runtime_crashed': 'Model stopped unexpectedly',
  'diag.audit.runtime_fallback': 'Compatibility mode',
  'diag.audit.model_selected': 'Model selected',
  'diag.audit.model_verified': 'Model checksum checked',
  'diag.audit.model_download_started': 'Download started',
  'diag.audit.model_download_verified': 'Download verified',
  'diag.audit.model_download_failed': 'Download failed',
  'diag.audit.document_imported': 'Document imported',
  'diag.audit.document_reindexed': 'Document re-indexed',
  'diag.audit.document_deleted': 'Document deleted',
  'diag.audit.document_task_completed': 'Document task finished',
  'diag.audit.document_task_failed': 'Document task failed',
  'diag.audit.document_exported': 'Document exported',
  'diag.audit.summary_exported': 'Summary exported',
  'diag.audit.conversation_deleted': 'Conversation deleted',
  'diag.audit.conversation_exported': 'Conversation exported',
  'diag.audit.workspace_created': 'Workspace created',
  'diag.audit.workspace_unlocked': 'Workspace unlocked',
  'diag.audit.workspace_locked': 'Workspace locked',
  'diag.audit.workspace_unlock_failed': 'Unlock attempt failed',
  'diag.audit.workspace_password_changed': 'Workspace password changed',
  'diag.audit.settings_changed': 'Settings changed',
  'diag.audit.policy_warning': 'Policy notice',
  'diag.audit.offline_guard_violation': 'Network attempt noticed',
  'diag.audit.collection_created': 'Project created',
  'diag.audit.collection_renamed': 'Project renamed',
  'diag.audit.collection_archived': 'Project archive changed',
  'diag.audit.collection_deleted': 'Project deleted',
  'diag.audit.documents_added_to_collection': 'Documents added to a collection',
  'diag.audit.documents_removed_from_collection': 'Documents removed from a collection',
  'diag.audit.document_lifecycle_changed': 'Document lifecycle changed',
  'diag.accel.gpuFallbackName': 'Graphics card',
  'diag.accel.gpu': '{name} (GPU)',
  'diag.accel.mock': 'Built-in demo runtime',
  'diag.accel.cpu': 'CPU',
  'diag.accel.gpuAvailable': '{name} (GPU available)',
  'diag.app.title': 'App & runtime',
  'diag.app.version': 'App version',
  'diag.app.unknown': 'unknown',
  'diag.app.selectedModel': 'Selected model',
  'diag.app.noneSelected': 'none selected',
  'diag.app.profile': 'Hardware profile',
  'diag.app.runtime': 'Runtime',
  'diag.app.unknownModel': 'unknown model',
  'diag.app.onPort': ' on 127.0.0.1:{port}',
  'diag.app.healthy': 'healthy',
  'diag.app.unhealthy': 'unhealthy',
  'diag.app.runtimeRunning': 'Running — {model}{onPort} ({health})',
  'diag.app.stopped': 'Stopped',
  'diag.app.acceleration': 'Acceleration',
  'diag.app.runtimeBuild': 'Runtime build',
  'diag.app.noInstallMarker': 'no install marker (manually provisioned drive)',
  'diag.gpu.compat':
    'Running in compatibility mode: responses use the CPU, which works on every machine.',
  'diag.gpu.tryHint':
    'If you have updated your graphics driver, you can try the graphics card again.',
  'diag.gpu.offHint':
    'GPU acceleration is turned off in Settings — turn it back on there to use the ' +
    'graphics card again.',
  'diag.gpu.tryAgain': 'Try GPU again',
  'diag.refresh': 'Refresh',
  'diag.bench.title': 'Hardware benchmark',
  'diag.bench.hint':
    'Measures RAM, CPU, and drive speed on this device to recommend a model. Runs ' +
    'entirely offline — no data leaves your machine.',
  'diag.bench.running': 'Running…',
  'diag.bench.rerun': 'Re-run benchmark',
  'diag.bench.run': 'Run benchmark',
  'diag.bench.failed': 'Benchmark failed: {error}',
  'diag.bench.profile': 'Assigned profile',
  'diag.bench.recommended': 'Recommended model',
  'diag.bench.noMatch': 'No matching model',
  'diag.bench.ram': 'RAM',
  'diag.bench.cpu': 'CPU',
  'diag.bench.cores': ' ({count} cores)',
  'diag.bench.osArch': 'OS / arch',
  'diag.bench.gpu': 'GPU',
  'diag.bench.notDetected': 'not detected',
  'diag.bench.driveRead': 'Drive read',
  'diag.bench.driveWrite': 'Drive write',
  'diag.bench.notMeasured': 'not measured',
  'diag.bench.tokens': 'Tokens / sec',
  'diag.bench.tokensNotMeasured': 'not measured (start a model first)',
  'diag.bench.lastRun': 'Last run',
  'diag.system.title': 'System',
  'diag.system.osPlatform': 'OS / platform',
  'diag.system.freeSpace': 'Free space',
  'diag.system.loadFailed': 'System details could not be loaded yet. Try reopening this tab.',
  'diag.paths.title': 'Paths',
  'diag.paths.prepared': 'Prepared drive',
  'diag.paths.yes': 'Yes',
  'diag.paths.noFallback': 'No (app-data fallback)',
  'diag.paths.writable': 'Writable',
  'diag.paths.no': 'No',
  'diag.paths.loadFailed':
    'Drive and workspace details could not be loaded yet. Try reopening this tab.',
  'diag.activity.title': 'Activity',
  'diag.activity.hint':
    'A local record of what the app did — model starts, downloads, document imports, ' +
    'workspace events. It stays in your workspace (encrypted when the workspace is) ' +
    'and is never uploaded. It never contains chat text or document contents.',
  'diag.activity.show': 'Show activity',
  'diag.activity.hide': 'Hide activity',
  'diag.activity.export': 'Export to file…',
  'diag.activity.savedTo': 'Activity log saved to {path}',
  'diag.activity.filterShow': 'Show',
  'diag.activity.filterAll': 'All activity',
  'diag.activity.loading': 'Loading…',
  'diag.activity.empty': 'Nothing recorded yet — activity appears here as you use the app.',
  'diag.activity.earlier': 'Show earlier activity',
  'diag.logs.title': 'Recent logs',
  // Split around the inline <code>logs/app.log</code>.
  'diag.logs.hintBefore': 'The tail of ',
  'diag.logs.hintAfter':
    ' on this device. Logs are local-only and never uploaded; they contain no document ' +
    'contents or chat text.',
  'diag.logs.show': 'Show logs',
  'diag.logs.hide': 'Hide logs',
  'diag.logs.empty': '(log is empty)',
  'diag.logs.save': 'Save to file…',
  'diag.logs.savedTo': 'Logs saved to {path}',
  // Copy-to-clipboard for the diagnostic cards (hand details to support).
  'diag.copy': 'Copy',
  'diag.copyTitle': 'Copy these details to the clipboard',
  'diag.copied': 'Copied to clipboard',
  'diag.copyFailed': 'Could not copy to the clipboard',

  // ---- Shared components' built-in copy (receive a bound t — i18n record §5 ⑤) ----
  'common.dismiss': 'Dismiss',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.remove': 'Remove',
  'indicator.offline': 'Local · Offline',
  'indicator.online': 'Local · Downloads allowed',
  'indicator.offlineDetail': 'Everything stays on this drive. No internet connection is used.',
  'indicator.onlineDetail': 'Downloads allowed — chats and documents stay local.',

  // ---- Shared password copy ----
  'password.mismatch': "Passwords don't match.",
  'password.show': 'Show password',
  'password.hide': 'Hide password',
  'password.strength.tooShort': 'Too short',
  'password.strength.weak': 'Weak',
  'password.strength.okay': 'Okay',
  'password.strength.strong': 'Strong',
  'password.strength.veryStrong': 'Very strong',
  'password.strength.minHint': 'Use at least 8 characters.',
  'password.strength.longerHint':
    'Longer is stronger — 12 or more characters, or a few unrelated words, work well.',

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
  // Determinate verification bar (replaces the bare spinner once hashing starts): the
  // byte-weighted % is the bar; this label says which model and how many are left.
  'gate.finishing.progress': 'Checking AI model {n} of {m}: {name} — {pct}%',
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

  // ---- Main-process strings (Phase 41, i18n record §3.3 two-rule boundary) --------------
  //
  // PERSIST-CANONICAL set (D-L4): these English values are what gets WRITTEN to the DB
  // (documents.error_message, messages.content) or to settings.lastBenchmark.warnings —
  // always via an explicit t('en', …) at the persist site — and the renderer translates
  // them at display time through the exact-match display map
  // (renderer/lib/displayMap.ts). Editing one of these values breaks the match for
  // already-persisted rows (and 'main.ingest.pdfScanDetected' additionally carries the
  // scanDetected exact-match contract) — treat them as part of the data contract.
  'main.ingest.pdfScanDetected': 'This PDF looks like a scan — it has no readable text yet.',
  'main.ingest.audioNeedsTranscriber':
    'Audio import needs the transcription model — download it on the AI Model screen.',
  'main.ingest.audioUnreadable':
    'This audio file could not be read. Convert it to WAV or MP3 and import it again.',
  'main.ingest.audioTranscriptionFailed':
    'The recording could not be transcribed. Re-index this document to try again.',
  'main.ingest.imageNeedsOcr':
    'Photo import needs the text-recognition (OCR) files, which are not on this drive.',
  'main.ingest.imageNoText':
    'No readable text was found in this photo. Try a sharper, closer picture of the page.',
  'main.ingest.imageOcrFailed': "This photo couldn't be read. Re-index it to try again.",
  'main.ingest.sourceMissing': 'Source file not found on disk.',
  'main.ingest.interrupted': 'Ingestion was interrupted before it finished. Re-index to try again.',
  'main.ingest.fileTooLarge':
    'This file is too large to import safely. Split it into smaller files and try again.',
  'main.ingest.tooManyChunks':
    'This document is too large to fully index. Split it into smaller files and import the parts.',
  'main.ingest.parseTimeout':
    'This file took too long to process and was skipped. It may be damaged or extremely large.',
  'main.rag.noContext':
    "I couldn't find this in your documents. Try rephrasing your question, or check which " +
    "documents you're asking about.",
  'main.rag.reindexNeeded':
    'Your documents need a quick re-index before they can be searched — they were indexed ' +
    'with a different search model. Open the Documents screen and choose Re-index.',
  'main.chat.docTaskBusy':
    'A document task is running. You can cancel it, or wait for it to finish before chatting.',
  // Default conversation title — persisted into conversations.title AND exact-matched by
  // maybeSetTitleFromFirstMessage (the first-message title rewrite), so it is part of the
  // data contract like the rest of this section.
  'main.chat.defaultTitle': 'New chat',
  'main.benchmark.warnTiny':
    'This device is best suited for the smallest, quickest model. Larger models may run slowly.',
  'main.benchmark.warnUnknown':
    'We could not fully detect this hardware, so we picked a safe, lightweight model. ' +
    'You can try a larger model any time.',
  'main.benchmark.warnDriveProbe':
    'Drive speed could not be measured, so the recommendation uses RAM and CPU only.',
  'main.benchmark.warnSlowDrive':
    'This drive is on the slower side. Models will still work, but loading them may take longer.',

  // EMISSION set (D-L5): ephemeral strings localized at the emission site via tMain()
  // — IPC throws, runtime notices, preflight problems, task-status errors, dialog
  // titles. These never reach the DB.
  'main.workspace.wrongPassword':
    "That password didn't unlock your workspace. Check it and try again.",
  'main.workspace.openFailed': 'Could not open the workspace.',
  'main.workspace.createFailed': 'Could not create the workspace.',
  'main.workspace.passwordTooShort': 'Password must be at least {min} characters.',
  'main.workspace.newPasswordTooShort': 'The new password must be at least {min} characters.',
  'main.workspace.unlockBeforeChange': 'Unlock the workspace before changing its password.',
  'main.workspace.wrongCurrentPassword':
    "That doesn't match your current password. Check it and try again.",
  'main.workspace.changeFailed':
    'Could not change the password. Your current password still works.',
  'main.workspace.busyPasswordChange':
    'The workspace password is being changed right now. Try again in a moment.',
  'main.runtime.compatibilityMode':
    'Switched to compatibility mode for stability. Everything keeps working — responses may be a bit slower.',
  'main.noModelRunning': 'No AI model is running. Open the AI Model screen and start one first.',
  'main.model.contextExceeded':
    "This is too large for the current model's context window. Try a model with a larger context, or a smaller document.",
  'main.chat.streamInFlight': 'A response is already being generated for this conversation.',
  'main.chat.nothingToRegenerate': 'Nothing to regenerate yet.',
  'main.chat.emptyMessage': 'Cannot send an empty message.',
  'main.chat.emptyQuestion': 'Cannot send an empty question.',
  'main.chat.stopFirst': 'A response is still being generated for this conversation. Stop it first.',
  'main.task.unknownKind': 'Unknown document task.',
  'main.task.refusedChatStreaming':
    'An answer is being written right now. Wait for it to finish (or stop it), then try again.',
  'main.task.comparePickTwo': 'Pick exactly two documents to compare.',
  'main.task.compareReindex':
    'These documents need a quick re-index before they can be compared — at least one was ' +
    'prepared with a different search model. Open the Documents screen and choose Re-index, ' +
    'then try again.',
  'main.task.documentNotReady':
    'This document has no readable text yet. Import or re-index it first, then try again.',
  'main.task.genericFailure':
    'The task could not be finished. Make sure the model is still running, then try again.',
  'main.task.expired': 'This task is no longer available.',
  'main.task.translationTarget': 'Choose a translation language: German or English.',
  'main.task.sourceUnreadable':
    'The stored copy of this document could not be read. Re-import the document, then try again.',
  'main.task.needsOcr': 'Text recognition needs the OCR files, which are not on this drive.',
  'main.task.ocrNotAScan': 'Only a PDF that was detected as a scan can be made searchable this way.',
  'main.task.ocrNoText':
    'No readable text was found in this scan. The pages may be blank or too blurry.',
  'main.task.ocrFailed':
    "This scan couldn't be read. Make sure the document is still on the drive, then try again.",
  'main.task.pickOneTranslate': 'Pick exactly one document to translate.',
  'main.task.pickOneOcr': 'Pick exactly one scanned PDF to make searchable.',
  'main.task.pickOneSummarize': 'Pick exactly one document to summarize.',
  'main.task.unavailable': 'Document tasks are not available.',
  'main.task.workspaceLocked': 'Workspace is locked. Unlock it to work with documents.',
  'main.download.policyDisabled': 'Downloads are disabled by this drive’s policy.',
  'main.download.networkOff':
    'Internet access is turned off. Turn on “Allow internet access for model ' +
    'downloads and updates” in Settings first.',
  'main.download.alreadyRunning': 'Another download is already running. One model downloads at a time.',
  'main.download.noSource': 'Model "{modelId}" has no download source in its manifest.',
  'main.download.alreadyVerified': 'This model is already downloaded and verified.',
  'main.download.presentUnverified':
    'This model’s file is already present. Its manifest carries no real checksum ' +
    'yet, so it cannot be verified — capture one with verify-models --generate.',
  'main.download.licenseFirst':
    'Please review and accept the model’s license ({license}) before downloading.',
  'main.download.unknownJob': 'Unknown download job.',
  'main.download.checksumMismatch':
    'The downloaded file did not match its expected checksum, so it was discarded. ' +
    'Please try again.',
  'main.download.fileMissing': 'The downloaded file went missing before it could be verified.',
  'main.download.httpFailed':
    'The download could not start ({reason}). Please check the connection and try again.',
  'main.download.interrupted':
    'The download was interrupted ({reason}). The finished part is kept — ' +
    'starting it again will resume where it stopped.',
  'main.engine.alreadyRunning': 'The AI engine is already downloading.',
  'main.engine.noSources': 'No engine sources were found on this drive (runtime-sources.yaml is missing).',
  'main.engine.noHostBuild': 'No AI-engine build is available for this computer.',
  'main.engine.alreadyInstalled': 'The AI engine is already installed.',
  'main.engine.unknownJob': 'Unknown engine-download job.',
  'main.engine.checksumMismatch':
    'The downloaded engine did not match its expected checksum, so it was discarded. Please try again.',
  'main.engine.fileMissing': 'The downloaded engine went missing before it could be verified.',
  'main.engine.binaryMissing':
    'The engine downloaded but could not be unpacked (the archive layout may have changed).',
  'main.engine.extractFailed': 'The AI engine downloaded but could not be unpacked. Please try again.',
  'main.engine.httpFailed':
    'The engine download could not start ({reason}). Please check the connection and try again.',
  'main.engine.interrupted': 'The engine download was interrupted ({reason}). Please try again.',
  'main.docs.locked': 'Workspace is locked. Unlock it to manage documents.',
  'main.docs.processing': 'This document is still being processed. Wait for the import to finish.',
  'main.docs.taskRunning': 'A task is running for this document. Cancel it or wait for it to finish.',
  'main.docs.previewEncrypted': 'This document is encrypted; unlock the workspace to preview it.',
  'main.docs.previewGone': 'The document file is no longer on disk. Re-import it to preview.',
  'main.docs.exportTextOnly': 'Only text documents (Markdown, TXT, CSV) can be exported this way.',
  'main.docs.exportEncrypted': 'This document is encrypted; unlock the workspace to export it.',
  'main.docs.exportGone': 'The document file is no longer on disk. Re-import it to export.',
  'main.docs.noStoredTranscript':
    'No transcript is stored for this recording yet. Re-index it to transcribe again.',
  'main.models.noManifests':
    'No model list was found on this drive — the model-manifests folder is missing.',
  'main.models.autoSelected':
    'This model is used automatically once installed — there is nothing to select.',
  'main.preflight.readOnly':
    'This drive appears to be read-only, so the app cannot create its workspace. ' +
    'Try a different USB port, or see the troubleshooting guide.',
  'main.preflight.lowSpace':
    'This drive is low on free space. You can still continue, but importing large ' +
    'documents may fail until you free up room.',
  'main.dialog.importDocuments': 'Import documents',
  'main.dialog.importFolder': 'Import a folder of documents',
  'main.dialog.exportDocument': 'Export document',
  'main.dialog.exportSummary': 'Export summary',
  'main.dialog.exportChat': 'Export chat transcript',
  'main.dialog.exportAudit': 'Export activity log',
  'main.dialog.exportLog': 'Save diagnostic logs',
  'main.dialog.filterDocuments': 'Documents',
  'main.dialog.filterAll': 'All files',
  'main.collections.builtinUndeletable': 'The built-in Library and Temporary cannot be deleted.',

  // ---- Document organization — Documents screen sections + actions (plan §12) ----
  // German copy in de.ts reviewed in the D-L7 pass (2026-06-14).
  'docs.section.heading': 'Sections',
  'docs.section.library': 'Library',
  'docs.section.projects': 'Projects',
  // Group header over the system buckets (Library / Temporary / Generated / Archived), §11.6.
  'docs.section.locations': 'Locations',
  'docs.section.temporary': 'Temporary',
  'docs.section.generated': 'Generated',
  'docs.section.archived': 'Archived',
  'docs.section.all': 'All documents',
  'docs.section.noProjects': 'No projects yet',
  'docs.section.newProject': 'New project',
  'docs.section.collapse': 'Sections',
  // Collapse/expand the whole Documents sub-nav (§11.6 — the list then takes the full width).
  'docs.rail.hide': 'Hide sections',
  'docs.rail.show': 'Show sections',
  'docs.project.createTitle': 'Create a project',
  'docs.project.namePlaceholder': 'Project name',
  'docs.project.nameAria': 'Project name',
  'docs.project.create': 'Create',
  'docs.project.rename': 'Rename',
  'docs.project.renameTitle': 'Rename project',
  'docs.project.archive': 'Archive',
  'docs.project.unarchive': 'Unarchive',
  'docs.project.delete': 'Delete project',
  'docs.project.deleteTitle': 'Delete this project?',
  'docs.project.deleteBody': 'Choose what happens to the documents in this project:',
  'docs.project.deleteKeep': 'Remove the project only — keep its documents',
  'docs.project.deleteKeepHint': 'Documents stay in your Library and any other projects.',
  'docs.project.deleteWith': 'Delete the project and the documents that live only here',
  'docs.project.deleteWithHint':
    'Only documents not kept in your Library or another project are deleted. Library knowledge is never touched.',
  'docs.project.deleteConfirm': 'Delete project',
  'docs.project.archivedNote': 'Archived — hidden as a source, but its documents stay answerable elsewhere.',
  'docs.project.options': 'Project options',
  'docs.action.addToProject': 'Add to project…',
  'docs.action.moveToProject': 'Move to project…',
  'docs.action.addToLibrary': 'Keep in Library',
  'docs.action.removeFromProject': 'Remove from this project',
  'docs.action.markTemporary': 'Mark temporary',
  'docs.action.markPermanent': 'Mark permanent',
  'docs.action.archive': 'Archive',
  'docs.action.unarchive': 'Unarchive',
  'docs.action.chooseProject': 'Choose a project',
  'docs.lifecycle.temporary': 'Temporary',
  'docs.lifecycle.archived': 'Archived',
  'docs.chip.library': 'Library',
  'docs.chip.temporary': 'Temporary',
  'docs.chip.generated': 'Generated',
  'docs.chip.archived': 'Archived',
  'docs.bulk.selected.one': '{count} selected',
  'docs.bulk.selected.other': '{count} selected',
  // Selection toolbar (§11.6): one sticky bar for the multi-document operations, so the
  // per-row action set can stay minimal.
  'docs.selectionAria': 'Actions for the selected documents',
  'docs.bulk.delete': 'Delete',
  'docs.bulk.deleteConfirm.title.one': 'Delete {count} document?',
  'docs.bulk.deleteConfirm.title.other': 'Delete {count} documents?',
  'docs.bulk.deleteConfirm.body':
    'This permanently removes the selected documents, their extracted text, and their ' +
    'search index from your workspace. The original files outside the workspace are not touched.',
  'docs.empty.section': 'Nothing here yet.',

  // ---- Document organization — smart views (plan §7.6/§12.1, Phase E) ----
  // Query-time filters over document metadata, not stored collections.
  'docs.smart.heading': 'Views',
  'docs.smart.recentlyAdded': 'Recently added',
  'docs.smart.unfiled': 'Unfiled',
  'docs.smart.needsReindex': 'Needs re-index',
  'docs.smart.largeFiles': 'Large files',
  'docs.smart.failed': 'Failed imports',
  'docs.smart.audio': 'Audio',
  'docs.smart.ocr': 'Scanned / OCR',
  // Views "More" disclosure: the rare diagnostic views fold behind this (§11.6).
  'docs.smart.more': 'More',
  // Staleness indicator on a generated document (plan §15.3). Quiet, non-blaming;
  // re-running the task is the only fix (snapshot semantics are unchanged).
  'docs.provenance.staleBadge': 'Outdated',
  'docs.provenance.staleChanged': 'A source changed since this was made — re-run to update.',
  'docs.provenance.staleRemoved': 'A source was removed since this was made — re-run to update.',

  // ---- Chat — composite source scope (multi-select picker + footer union, plan §13) ----
  'chat.scope.using': 'Using {sources}',
  'chat.scope.library': 'Library',
  'chat.scope.projectNamed': 'Project: {name}',
  'chat.scope.projectCount.one': '{count} project',
  'chat.scope.projectCount.other': '{count} projects',
  'chat.scope.docCount.one': '{count} document',
  'chat.scope.docCount.other': '{count} documents',
  'chat.scope.filesInChat.one': '{count} file in this chat',
  'chat.scope.filesInChat.other': '{count} files in this chat',
  'chat.scope.sourcesTitle': 'Choose your sources',
  'chat.scope.librarySource': 'Library',
  'chat.scope.librarySourceHint': 'Your whole knowledge base',
  'chat.scope.specificToggle': 'Specific documents…',
  'chat.scope.allTap': 'All documents',
  'chat.scope.filesInChatLine': 'Files in this chat',
  'chat.scope.noProjects': 'No projects yet',
  'chat.scope.archivedFallback': 'This project was archived — answering from your Library.',

  // ---- Chat — attach / drag-drop a file into a chat (plan §11.2/§13.5, Phase C) ----
  // German copy reviewed in the D-L7 pass (2026-06-14).
  'chat.attach.button': 'Attach files',
  'chat.attach.drop': 'Drop files to use them in this chat',
  'chat.attach.processing': 'Processing {name}…',
  // Screen-reader-only confirmation for the keyboard/picker path (UX-3) — paired with
  // `processing` in an aria-live region so attaching a file is audibly acknowledged.
  'chat.attach.added': 'Added {name} to this chat',
  'chat.attach.newDocChat': 'Started a new document chat for {name}',
  'chat.attach.failed': "Couldn't add {name} to this chat."
} as const
