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
  'nav.documents': 'Documents',
  'nav.translate': 'Translate',
  'nav.images': 'Images',
  'nav.models': 'AI Model',
  'nav.skills': 'Skills',
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

  // ---- Error boundary (ErrorBoundary.tsx — audit FE-1) ----
  // Per-screen fallback (the nav rail stays alive behind it). Calm, reassuring tone
  // (spec §11.4): the failure is contained, nothing is lost, and recovery is one tap.
  'errorBoundary.title': 'Something went wrong on this screen',
  'errorBoundary.body':
    'This screen ran into an unexpected problem. Your work and your data are safe — nothing ' +
    'was lost. Try again, or go back to Home.',
  'errorBoundary.retry': 'Try again',
  'errorBoundary.home': 'Go to Home',
  // Outer last-resort fallback around the whole app (rendered before the language provider,
  // so it is resolved with the pre-unlock language).
  'errorBoundary.app.title': 'The app ran into a problem',
  'errorBoundary.app.body':
    'Something unexpected happened. Your data on the drive is safe. Reload to continue.',
  'errorBoundary.app.reload': 'Reload',

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
  // Split around the inline <b>Use this model</b>.
  'chat.noModel.hintBefore':
    'Chat and document Q&A need a model loaded. Open the AI Model screen, pick a downloaded ' +
    'model, and choose ',
  'chat.noModel.hintAction': 'Use this model',
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

  // ---- Chat: skill picker + per-message glyph (skills plan §10/§15) ----
  'chat.skill.trigger': 'Skill: {label}',
  'chat.skill.none': 'No skill',
  'chat.skill.suggested': 'Suggested: {title} — use it?',
  // U-3: the same deterministic offer surfaced on the CLOSED picker trigger so a user who never
  // opens it still sees the nudge. Quiet, named, one tap selects it — never auto-applied (§22-D3).
  'chat.skill.suggestedHint': 'Suggested: {title}',
  'chat.skill.used': 'Skill: {title}',
  'chat.skill.usedTitle': 'This answer was shaped by the skill “{title}”.',
  // S13c (D3) — an AUTO-FIRED turn: visible (the glyph reads "Answered with …") + reversible (the
  // one-click undo re-runs the same question without the skill). Never a silent surprise.
  'chat.skill.autoFired': 'Answered with {title}',
  'chat.skill.autoFiredTitle':
    'The app applied the skill “{title}” to this answer automatically. You can answer without it.',
  'chat.skill.answerWithout': 'Answer without it',
  // SKA-38 (skills audit 2026-07-03, U6): the glyph label when a stamped turn's skill was later
  // DELETED — the provenance (and the undo) survive the deletion, honestly labelled.
  'chat.skill.removed': '(removed skill)',
  // U3 (audit §4.3): a pick applies PER-TURN by default now — the persistent composer chip's × clears
  // both the session pick and any saved default, and the in-picker checkbox is the explicit opt-in to
  // persist the pick as this conversation's default. Nothing is silently kept across turns any more.
  'chat.skill.clear': 'Clear skill {title}',
  'chat.skill.keep': 'Keep for this conversation',
  // Tier-2 tool run — the calm transcript affordance + busy row + confirm modal (skills plan §12.2/§15, S11b)
  'chat.skill.tool.extractTransactions': 'Extract transactions',
  'chat.skill.tool.validateBalances': 'Check balances',
  'chat.skill.tool.categorize': 'Categorize',
  'chat.skill.tool.summarize': 'Summarize cashflow',
  'chat.skill.tool.exportCsv': 'Export to CSV',
  'chat.skill.tool.extractInvoice': 'Extract invoice',
  'chat.skill.tool.validateInvoiceTotals': 'Check totals',
  'chat.skill.tool.exportInvoiceCsv': 'Export to CSV',
  'chat.skill.tool.exportInvoiceJson': 'Export to JSON',
  'chat.skill.tool.exportInvoiceXml': 'Export to XML',
  'chat.skill.tool.redactDocument': 'Redact personal data',
  'chat.skill.tool.applyDocumentEdits': 'Apply text edits',
  // The breakdown question routed into the transcript after a categorize run (Phase 33, Q3) — it must
  // be both analysis- and category-shaped so the bank analysis handler answers it (0 model calls).
  'chat.skill.categorize.breakdownQuestion': 'Break down my spending by category.',
  // The question routed into the transcript after a "Summarize cashflow" run so the button produces a
  // real answer (the in/out/net totals from the 0-model-call bank analysis handler) instead of a bare
  // "Summarized N transactions" count — the figures stay main-side (the run state carries no figures).
  // Analysis-shaped but NOT category-shaped, so it yields the cash-flow totals, not the category breakdown.
  'chat.skill.summarize.question': 'Summarize my income and expenses.',
  'chat.skill.run.running.one': 'Running: {tool} on {count} document…',
  'chat.skill.run.running.other': 'Running: {tool} on {count} documents…',
  // U-1: the busy row naming the target document (the renderer resolves `{document}` from its own
  // loaded document list — the title never crosses the run-state IPC). Used when the name is known;
  // it falls back to the count form above otherwise.
  'chat.skill.run.runningOn': 'Running: {tool} on {document}…',
  // U-1: the run-bar target chooser (a >1-doc scope) + the single-doc name affordance.
  'chat.skill.run.chooseDocument': 'Choose target document',
  'chat.skill.run.thisDocument': 'this document',
  'chat.skill.run.cancel': 'Cancel',
  'chat.skill.run.done.one': 'Extracted {count} transaction.',
  'chat.skill.run.done.other': 'Extracted {count} transactions.',
  'chat.skill.run.done.categorize.one': 'Categorized {count} transaction.',
  'chat.skill.run.done.categorize.other': 'Categorized {count} transactions.',
  'chat.skill.run.done.summarize.one': 'Summarized {count} transaction.',
  'chat.skill.run.done.summarize.other': 'Summarized {count} transactions.',
  'chat.skill.run.done.export.one': 'Saved {count} row.',
  'chat.skill.run.done.export.other': 'Saved {count} rows.',
  'chat.skill.run.done.reconciled': 'Balances reconcile.',
  'chat.skill.run.done.unreconciled.one': "{count} row doesn't reconcile — check it before relying on it.",
  'chat.skill.run.done.unreconciled.other': "{count} rows don't reconcile — check them before relying on them.",
  'chat.skill.run.done.unchecked': 'No running balance was printed to check against.',
  'chat.skill.run.done.extractInvoice.one': 'Extracted {count} line item.',
  'chat.skill.run.done.extractInvoice.other': 'Extracted {count} line items.',
  'chat.skill.run.done.invoiceReconciled': 'The invoice totals add up.',
  'chat.skill.run.done.invoiceUnreconciled.one': "{count} total doesn't add up — check it before relying on it.",
  'chat.skill.run.done.invoiceUnreconciled.other': "{count} totals don't add up — check them before relying on them.",
  'chat.skill.run.done.invoiceUnchecked': 'No totals were printed to check against.',
  'chat.skill.run.done.redacted.one': 'Saved a redacted copy — {count} item hidden. Best-effort, not a guarantee — review it before sharing.',
  'chat.skill.run.done.redacted.other': 'Saved a redacted copy — {count} items hidden. Best-effort, not a guarantee — review it before sharing.',
  'chat.skill.run.done.redactedClean': 'No personal data was detected; saved a copy. Best-effort, not a guarantee — review it before sharing.',
  // Phase 7 (D78): the DEGRADED run — no model was running, so only offline rule-based detection ran.
  'chat.skill.run.done.redactedFloor.one': 'Saved a redacted copy — {count} item hidden (offline rule-based detection only, no model running). Review it before sharing.',
  'chat.skill.run.done.redactedFloor.other': 'Saved a redacted copy — {count} items hidden (offline rule-based detection only, no model running). Review it before sharing.',
  'chat.skill.run.done.redactedCleanFloor': 'No personal data was detected (offline rule-based detection only, no model running); saved a copy. Review it before sharing.',
  // Phase 8 (D76/D78): targeted edits — N changes applied (all found), a partial variant when some
  // requested text wasn’t found and was skipped, and the no-match case (nothing written). Counts only.
  'chat.skill.run.done.edited.one': 'Applied {count} change and saved an edited copy. Review it before sharing.',
  'chat.skill.run.done.edited.other': 'Applied {count} changes and saved an edited copy. Review it before sharing.',
  'chat.skill.run.done.editedPartial.one': 'Applied {count} change; some requested text wasn’t found and was skipped. Saved an edited copy — review it before sharing.',
  'chat.skill.run.done.editedPartial.other': 'Applied {count} changes; some requested text wasn’t found and was skipped. Saved an edited copy — review it before sharing.',
  'chat.skill.run.done.editedNone': 'None of the requested text was found — nothing was changed and no copy was saved.',
  'chat.skill.run.failedGeneric': "That didn't work. Nothing was changed.",
  'chat.skill.run.error.unavailable': 'This tool isn’t available.',
  'chat.skill.run.error.needsExtraction': 'Read the document first with the “{button}” button, then run this tool.',
  'chat.skill.run.error.persistFailed': 'This couldn’t be saved. Nothing was changed.',
  'chat.skill.run.error.exportWriteFailed': 'The file couldn’t be saved. Nothing was changed.',
  // Phase 8 (D76): the document-edit refusals — there is no rule-based floor for edits, so a missing model
  // or instruction refuses cleanly (never a silent nothing).
  'chat.skill.run.error.needsModel': 'Start a model first — targeted edits need a running model to find the text to change.',
  'chat.skill.run.error.needsInstruction': 'Say what to change first (for example, “replace X with Y”), then run this again.',
  'chat.skill.run.error.editFailed': 'The edits couldn’t be completed. Nothing was changed.',
  'chat.skill.run.cancelled': 'Stopped. Nothing was saved.',
  // SKA-40 (skills audit 2026-07-03, U6): the store gave up polling a run after repeated errors — a
  // labelled, dismissable row rather than a silently vanished run.
  'chat.skill.run.stateUnknown': "Couldn't check on this skill — its result may be incomplete.",
  // SKA-6: a quiet chip when a skill run is working in ANOTHER chat (the run keeps going + is shown
  // there; here it is just a non-alarming presence hint). Content-free — names no document.
  'chat.skill.run.otherChatBusy': 'A skill is working in another chat.',
  // U-2: the one-tap follow-up on the extract RESULT row. The LLM categorize is user-initiated here,
  // not silently auto-run on extract. Content-free (names a tool action, never a document).
  'chat.skill.run.categorizeOffer': 'Categorize transactions',
  'chat.skill.run.dismiss': 'Dismiss',
  'chat.skill.confirm.title': 'Run this tool?',
  'chat.skill.confirm.body': 'This creates or exports a file from the documents on this drive.',
  'chat.skill.confirm.ok': 'Run',

  // ---- Chat: transcript + message actions ----
  'chat.role.user': 'You',
  'chat.role.assistant': 'HilbertRaum',
  'chat.thinking': 'Thinking…',
  'chat.actions.tryAgain': 'Try again',
  'chat.actions.copy': 'Copy',
  'chat.actions.save': 'Save',
  'chat.actions.saveTitle': 'Save this conversation as a file (stays local)',
  // Result-tables §4 (Phase 2): shown only on answers carrying a structured result table.
  'chat.actions.exportCsv': 'Export CSV',
  'chat.actions.exportCsvTitle': 'Save this answer’s table as a CSV file (stays local)',

  // ---- Chat: context compaction (context-compaction plan §5.1–§5.3) ----
  // The one-shot "summarizing…" status above the streaming bubble (§5.2).
  'chat.compaction.inProgress': 'Summarizing earlier messages to free up context…',
  // U5 (audit §3.6): the sibling one-shot status for an exhaustive skill handler reading the whole
  // document before its (deterministic, one-blob) answer — so the wait no longer reads as a hang.
  'chat.analysis.inProgress': 'Reading the whole document…',
  // The transcript summary marker (§5.3, D-b) — a subtle divider, expandable to read the summary.
  'chat.compaction.markerLabel': 'Earlier messages summarized',
  'chat.compaction.viewSummary': 'Show the summary of earlier messages',
  // The conversation-memory meter (§5.1, beta-feedback #25/D69). A short visible label so the
  // gauge reads as "how full THIS conversation's memory is", never as task/answer progress.
  // "context"/"Kontext" stays OUT of the visible label (design-guidelines no-jargon rule).
  'chat.context.label': 'Memory',
  // Tooltip teaches the fill mental model. {pct} is the visible %; {used}/{window} keep the
  // approximate-token honesty ("about" = the estimate is an over-count).
  'chat.context.usageTooltip': 'Memory for this conversation: {pct}% full (about {used} of {window} tokens).',
  'chat.context.willSummarize': 'When it fills up, older messages are summarized automatically to make room.',
  // Honest-signal truncation notice (§L0): shown on an assistant reply the model cut off at the
  // context ceiling (finish_reason 'length'). Label is the visible line; hint is the tooltip.
  'chat.truncated.label': 'Reply cut off — reached the model’s context limit',
  'chat.truncated.hint':
    'The model ran out of room to finish this answer. Ask it to continue, start a new chat, or raise the context size on the AI Model screen.',

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
  // The inline citation marker, DISPLAY-TIME only (#28 / beta-feedback plan Phase 1, D68). The
  // machine-stable index is always `S{n}` — baked into GROUNDING_RULES, emitted by the model, and
  // persisted in citations_json (never localized). We only relabel it at render: EN keeps 'S{n}';
  // DE shows 'Q{n}' ("Quelle") because "S" reads as "Seite" (page number) to a German user. Used
  // by SourcesDisclosure's card label and displayMap's inline-body rewrite.
  'chat.sources.marker': 'S{n}',
  'chat.sources.page': 'Page {page}',
  // Whole-document PROVENANCE (full-audit-2026-06-29 follow-up Phase 5, FE-B / F11 renderer
  // half): a tree/capped/extract answer's "citations" are the document SECTIONS it drew on
  // (leaf provenance, up to ~1000), NOT 1:1 inline-cited excerpts. The wording stays
  // breadth-neutral on purpose — the CoverageMeter beside it owns "whole document" /
  // "beginning" / "partial", so this label must not restate the breadth claim.
  'chat.sources.wholeDoc': 'Drawn from the document — {count} sections',
  'chat.sources.wholeDocCaption': 'Sections covered',
  'chat.sources.more': 'and {count} more sections',

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
  'docs.task.categorizeBusy': 'Categorizing transactions…',
  'docs.task.categorizeBusyTitle': 'The statement’s transactions are being categorized',
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
  'docs.loading': 'Loading documents…',
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
  'docs.retryAllFailed': 'Retry all ({count})',
  'docs.retryAllFailedTitle': 'Re-index every document that failed to index',
  'docs.retryAllConfirm.title': 'Retry {count} failed documents?',
  'docs.retryAllConfirm.body':
    'This re-reads and re-embeds every failed document one at a time. It can take several ' +
    'minutes and uses the processor heavily — you can keep working, but answers may be slower ' +
    'until it finishes. Documents that fail again stay on this tab.',
  'docs.retryAllConfirm.confirm': 'Retry all',
  'docs.reindexAllProgress': 'Re-indexing {done} of {total}…',
  'docs.reindexAllCancel': 'Cancel',
  'docs.reindexAllCancelled': 'Re-indexing stopped — {done} of {total} done.',
  'docs.reindexAllDone': 'Re-indexed {done} documents.',
  'docs.reindexAllPartial': 'Re-indexed {done} of {total} — {failed} failed. Failed documents stay on the Failed imports tab.',
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
  // The model-missing state (TG-3, plan O2/D3): the Translate item disables and this
  // sibling item deep-links to the AI Model screen.
  'docs.translateNoModel': 'Get the translation model…',
  'docs.translateNoModelTitle':
    'Translating needs the translation model — download it on the AI Model screen',
  'docs.export': 'Export',
  'docs.exportTitle': 'Save this document as a Markdown file',
  'docs.reindex': 'Re-index',
  'docs.reindexBusy': 'Re-indexing…',
  'docs.reindexTitle': 'Read and prepare the stored copy again',
  'docs.delete': 'Delete',
  // Failed-import row actions (§11.6 follow-up): a failed import never produced text, so
  // Preview is meaningless — the inline pair becomes Remove (clear the failed entry) and,
  // only when re-indexing could help (a transient read/parse error, NOT an unsupported type),
  // Try again.
  'docs.failed.remove': 'Remove',
  'docs.failed.removeTitle': 'Remove this failed import from the list',
  'docs.failed.retry': 'Try again',
  'docs.failed.retryTitle': 'Read and prepare this file again',
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
  'docs.translateModal.from': 'From',
  'docs.translateModal.to': 'To',
  'docs.translateModal.start': 'Translate',
  'docs.translateModal.sameLang': 'Pick two different languages.',
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
  'docs.previewModal.documentText': 'Document text',
  'docs.previewModal.page': 'Page {page}',
  'docs.previewModal.showMore': 'Show more',
  'docs.previewModal.loadingMore': 'Loading…',
  'docs.previewModal.segmentProgress': 'Showing {shown} of {total}',

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
  'coverage.relevance.counted': 'Based on {covered} of {total} sections',
  'coverage.capped.whole': 'Covers the whole document',
  'coverage.capped.beginning': 'Covers the beginning of the document',
  'coverage.tree.whole': 'Covers the whole document (deeply indexed)',
  'coverage.tree.beginning': 'Covers the beginning of the document — it was too large to read in full',
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
  // U1 (audit §2.3 / ux-10): softened from "Every match found …", which overclaimed exhaustiveness of the
  // EXTRACTION (a small model / an unusual layout can miss a match). "Read across …" is the honest claim —
  // every section was READ; it does not assert every match was captured.
  'coverage.extract.whole': 'Read across the whole document — {scanned} sections scanned',
  'coverage.extract.wholeUnparsed':
    'Read across the whole document — {scanned} sections scanned, {unparsed} could not be read',
  'coverage.extract.sections': 'Read across {scanned} sections scanned',
  'coverage.extract.sectionsUnparsed':
    'Read across {scanned} sections scanned, {unparsed} could not be read',

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

  // ---- Bank-statement analysis answer (full-doc-skills plan §3.1, Phase 2) ----
  // The deterministic, whole-document answer the bank-statement analysis handler synthesises
  // from the extracted transaction table (0 model calls). Honours SKILL.md: quote the printed
  // figures, lead with the count, surface unreconciled rows BEFORE the total, never invent a
  // number. Amounts/dates/currency are CONTENT and pass through verbatim as params.
  'skills.bankAnalysis.count': 'I read **{count}** transactions across the whole statement.',
  // U1 (audit §2.3): the honesty-gated headline. The extractor scanned every section but could not turn
  // **{dropped}** money-bearing line(s) into a transaction — so it must NOT claim these are every one.
  'skills.bankAnalysis.countPartial':
    'I read **{count}** transactions. **{dropped}** line(s) carried a figure I couldn’t parse into a ' +
    'transaction, so this may not be every transaction — check those lines against the document.',
  // U1 (audit §2.3): the CONTRADICTED-D56 headline — no "whole statement" claim over a body that says the
  // printed balances don’t reconcile (fixes the self-contradiction the old count line created).
  'skills.bankAnalysis.countContradicted':
    'I read **{count}** transactions, but this statement’s printed balances don’t add up against them — ' +
    'so I can’t confirm these are all of them.',
  // U1 (audit §2.3 / ux-11): the empty read is no longer a dead end — blame the READER, not the document,
  // and name the next step (OCR a scan; otherwise the layout may not be machine-readable).
  'skills.bankAnalysis.empty':
    'I scanned the whole document but couldn’t parse any transactions from it. The rows may be in a scanned ' +
    'image or an unusual layout my reader can’t follow. If this is a scan, run OCR (text recognition) on it ' +
    'first; otherwise the layout may not be machine-readable — open the statement to read the figures directly.',
  'skills.bankAnalysis.couldNotRead': 'I couldn’t read this statement, so I can’t analyse it.',
  'skills.bankAnalysis.unreconciledHeading':
    'Check these rows first — their printed running balance doesn’t reconcile with the amounts:',
  'skills.bankAnalysis.unreconciledItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.totals':
    'Money in: **{inAmount} {currency}** · Money out: **{outAmount} {currency}** · Net change: **{netAmount} {currency}**.',
  'skills.bankAnalysis.noCurrency':
    'These transactions use more than one currency, so there is no single combined total — a total would have to be split per currency.',
  // Completeness gate (§3.5, D56) — the CONTRADICTED case: the document makes a balance CLAIM the rows
  // refute (a per-row balance mismatches, or a printed opening+closing pair that doesn't tie out). The
  // read is suspect, so I refuse a total that might be a mis-read/partial sum dressed up as the whole.
  'skills.bankAnalysis.incompleteNoTotal':
    'I couldn’t confirm I captured the whole statement — its printed balances don’t add up against the ' +
    'transactions I read, so the figures may be mis-read or incomplete. To avoid giving you a total that ' +
    'might be wrong, I won’t state a sum here; please open the statement and check the figures yourself.',
  'skills.bankAnalysis.categoryHeading': 'By category:',
  'skills.bankAnalysis.categoryItem': '- {category}: {amount} {currency} ({count})',
  'skills.bankAnalysis.categoryAssisted':
    '_Categories are model-assisted — a label may be off, but the totals above are unchanged._',
  // Honesty note for the DETERMINISTIC breakdown (audit C-2): the chat path groups by a quick rule set
  // (no model call) so the result is path-dependent — the "Categorize" button uses the richer
  // model-assisted taxonomy (Groceries/Dining/…). Say so, so the two entry points are not silently
  // divergent. Shown only when the breakdown was NOT model-assisted.
  'skills.bankAnalysis.categoryRuleBased':
    '_This is a quick rule-based grouping (no model used). For a richer, model-assisted breakdown, run the “Categorize” button._',
  // Localized DISPLAY labels for the fixed category set (Phase 33). The PERSISTED identifier stays the
  // canonical English name (the enum / model-assisted detection key on it); only the breakdown display
  // is localized. An unknown name (e.g. a future user category) falls back to its raw identifier.
  'skills.bankCategory.Groceries': 'Groceries',
  'skills.bankCategory.Dining': 'Dining',
  'skills.bankCategory.Transport': 'Transport',
  'skills.bankCategory.Utilities': 'Utilities',
  'skills.bankCategory.Rent': 'Rent',
  'skills.bankCategory.Insurance': 'Insurance',
  'skills.bankCategory.Subscriptions': 'Subscriptions',
  'skills.bankCategory.Health': 'Health',
  'skills.bankCategory.Shopping': 'Shopping',
  'skills.bankCategory.Income': 'Income',
  'skills.bankCategory.Transfer': 'Transfer',
  'skills.bankCategory.Fees': 'Fees',
  'skills.bankCategory.Cash': 'Cash',
  'skills.bankCategory.Tax': 'Tax',
  'skills.bankCategory.Spending': 'Spending',
  'skills.bankCategory.Uncategorized': 'Uncategorized',
  'skills.bankAnalysis.caveat':
    'These figures are the statement’s own printed amounts, read across the whole document — ' +
    'nothing here is added up from prose or invented.',
  // Completeness gate (§3.5, D56) — the UNVERIFIED case: the statement prints NO opening/closing balance
  // to confirm I read every row, but nothing CONTRADICTS what I read either. So I give a clearly LABELLED
  // sum of the rows read — NOT a verified statement total — rather than refuse a perfectly honest figure.
  'skills.bankAnalysis.unverifiedCaveat':
    'These figures are a sum of the **{count}** transactions I read across the whole document. The ' +
    'statement prints no opening or closing balance, so I can’t confirm those are every transaction — ' +
    'treat them as a sum of the rows shown, not a verified statement total. Nothing here is added up ' +
    'from prose or invented.',
  // R5 (audit §5.7): the one honest date caveat, appended only when the document gave no evidence of day-
  // vs month-first ordering and its dates were therefore read day-first (the de-AT default). Content-free.
  'skills.bankAnalysis.dateOrderCaveat':
    'A note on the dates: this statement gives no sign whether they’re day-first or month-first, so I read ' +
    'them day-first (day.month.year) — a date like 03.05. could be 3 May or 5 March. Check any date that ' +
    'matters against the document.',
  // A bounded transaction listing so "show me the transactions" is answerable (figures pass through verbatim).
  'skills.bankAnalysis.transactionsHeading': 'Transactions:',
  'skills.bankAnalysis.transactionItem': '- {date} · {description} · {amount} {currency}',
  // W4 (audit §3.3): name the REAL affordances, not a self-referential escape hatch. The old copy told the
  // user to "ask me to export … as CSV" — but the bank handler had no format mode and re-triggered the same
  // template, an infinite loop. Now it points at the run-bar Export button (its actual label, for a saved
  // file) AND the inline chat serialization W4 added (CSV or JSON right here in chat).
  'skills.bankAnalysis.transactionsMore':
    '… and **{count}** more. To see every row, use the **Export to CSV** button in the run bar to save the ' +
    'whole statement, or just ask for it as CSV or JSON right here in chat.',
  // W4 (audit §8.1): the deterministic figure echo printed UNDER a grounded-data model answer, so any model
  // misquote is immediately contradicted by the parser's own money-in / money-out / net. Amounts verbatim.
  // SKA-4 (W6, audit §4.5): the bank in/out/net are COMPUTED sums (summarizeCashflow), NOT figures printed
  // in the document — so the label says "computed", not "verbatim from the document" (that wording is
  // accurate only for the invoice echo, whose net/tax/gross ARE printed totals; do NOT churn that one).
  'skills.bankAnalysis.figureEcho': 'Totals computed from the parsed transactions: {figures}.',
  'skills.bankAnalysis.figureEchoIn': 'money in {amount} {currency}',
  'skills.bankAnalysis.figureEchoOut': 'money out {amount} {currency}',
  'skills.bankAnalysis.figureEchoNet': 'net change {amount} {currency}',
  // W4 (audit §3.3): the honest intro for the inline JSON/CSV serialization of the statement. The CSV
  // variant states what CSV omits (summary + balances), the §3.6 honesty precedent.
  'skills.bankAnalysis.formatIntro':
    'Here is the statement as {format}, built only from the figures I read — nothing added up from prose or invented:',
  'skills.bankAnalysis.formatIntroCsv':
    'Here is the statement as CSV — the transaction rows only, built from the figures I read (nothing added ' +
    'up from prose or invented). The cashflow summary and the opening/closing balances aren’t in CSV; ask ' +
    'for it as JSON to get those too.',
  // Result-tables Phase 1.5: a prompt-supplied CUSTOM category set needs the local model (the
  // deterministic rules only know their fixed labels) — refuse honestly instead of silently
  // answering with a different taxonomy than the one asked for. Echoes the parsed set so a
  // mis-understood list is visible immediately.
  'skills.bankAnalysis.customCategoriesNeedModel':
    'To sort the transactions into your own categories ({categories}) I need a local model running — ' +
    'the built-in quick rules only know their fixed set. Start a model, then ask again.',
  // Phase 1.6: a taxonomy CSV referenced by name — honest refusals naming the file, never a silent
  // fixed-taxonomy fallback.
  'skills.bankAnalysis.customTaxonomyNotFound':
    'I couldn’t find “{name}” among your documents. Import the file first (Documents → Import), then ask again.',
  'skills.bankAnalysis.customTaxonomyUnparseable':
    'I read “{name}” but couldn’t use it as a category list. Expected one category per line — a label, ' +
    'optionally followed by keywords after a semicolon (for example “Kinder;Schule, Kita, Taschengeld”).',
  // Result-tables §5 (Phase 3): the honesty note under an answer whose table carries model-filled
  // DERIVED columns — a derived value is a label, never a parser figure.
  'skills.bankAnalysis.derivedColumnsNote':
    '_The column(s) {columns} were filled in by the local model from each transaction’s description — ' +
    'left blank where it wasn’t sure. All figures come from the deterministic parser and are unchanged._',

  // ---- Invoice analysis answer (full-doc-skills plan §3.1, Phase 4 / D49) ----
  // The deterministic, whole-document answer the invoice analysis handler synthesises from the
  // extracted invoice (0 model calls). Honours SKILL.md: quote the printed figures, surface any
  // failed totals check BEFORE the headline gross, never invent a field the invoice doesn't state.
  // Amounts/dates/currency are CONTENT and pass through verbatim as params.
  'skills.invoiceAnalysis.count': 'I read the whole invoice — **{count}** line items.',
  // U1 (audit §2.3): the honesty-gated headline — the extractor scanned every section but could not parse
  // **{dropped}** money-bearing line(s), so it must NOT claim to have read the whole invoice exhaustively.
  'skills.invoiceAnalysis.countPartial':
    'I read **{count}** line items. **{dropped}** line(s) carried a figure I couldn’t parse into a line ' +
    'item, so this may not be every line — check those lines against the document.',
  // U1 (audit §2.3 / ux-11): the empty read names a next step instead of dead-ending. Blames the reader.
  'skills.invoiceAnalysis.empty':
    'I scanned the whole document but couldn’t parse any line items or totals from it. The figures may be in ' +
    'a scanned image or an unusual layout my reader can’t follow. If this is a scan, run OCR (text ' +
    'recognition) on it first; otherwise the layout may not be machine-readable — open the invoice to read ' +
    'the figures directly.',
  'skills.invoiceAnalysis.couldNotRead': 'I couldn’t read this invoice, so I can’t analyse it.',
  'skills.invoiceAnalysis.unreconciledHeading':
    'Check these totals first — they don’t reconcile:',
  'skills.invoiceAnalysis.checkLineItemsSumToNet': 'the line items don’t add up to the printed net total',
  'skills.invoiceAnalysis.checkNetPlusTaxIsGross': 'net plus tax doesn’t match the printed gross total',
  'skills.invoiceAnalysis.checkTaxMatchesRate': 'the tax amount doesn’t match the stated tax rate',
  'skills.invoiceAnalysis.unreconciledItem': '- {check}',
  'skills.invoiceAnalysis.totalsHeading': 'Totals, exactly as printed:',
  // SKA-21 (W6): {value} is "{amount} {currency}", or just the amount when the currency is unknown/mixed
  // (a mixed-currency invoice with no header currency stamps NO code rather than lineItems[0]'s — and no
  // dangling space). Built by `amountText` in the handler.
  'skills.invoiceAnalysis.net': '- Net: **{value}**',
  'skills.invoiceAnalysis.tax': '- Tax: **{value}**',
  'skills.invoiceAnalysis.taxWithRate': '- Tax ({rate}%): **{value}**',
  'skills.invoiceAnalysis.gross': '- Gross total (amount due): **{value}**',
  'skills.invoiceAnalysis.positionsHeading': 'Line items:',
  'skills.invoiceAnalysis.positionItem': '- {description} · {amount} {currency}',
  'skills.invoiceAnalysis.positionsMore':
    '… and **{count}** more — ask me to export the invoice as CSV to see every line.',
  'skills.invoiceAnalysis.formatIntro':
    'Here is the invoice as {format}, built only from the figures I read — nothing added up from prose or invented:',
  // §3.6-low (W4): CSV carries the line items ONLY — the header + totals are omitted (they ride in JSON/XML).
  // The old single intro claimed "the invoice as CSV" without saying what CSV leaves out; state it honestly.
  'skills.invoiceAnalysis.formatIntroCsv':
    'Here is the invoice as CSV — the line items only, built from the figures I read (nothing added up from ' +
    'prose or invented). The header (vendor, invoice number, dates) and the totals aren’t in CSV; ask for it ' +
    'as JSON or XML to get those too.',
  'skills.invoiceAnalysis.noTotals':
    'The invoice doesn’t print a net, tax, or gross total I could read.',
  'skills.invoiceAnalysis.caveat':
    'These figures are the invoice’s own printed amounts, read across the whole document — ' +
    'nothing here is added up from prose or invented.',
  // R5 (audit §5.7): the one honest date caveat — appended only when the invoice gave no evidence of day-
  // vs month-first ordering and its dates were therefore read day-first (the de-AT default). Content-free.
  'skills.invoiceAnalysis.dateOrderCaveat':
    'A note on the dates: this invoice gives no sign whether they’re day-first or month-first, so I read ' +
    'them day-first (day.month.year) — a date like 03.05. could be 3 May or 5 March. Check any date that ' +
    'matters against the document.',
  // W3 (audit §3.1): the loaded header fields as a small Details block, so the vendor / invoice-number /
  // date questions are answered even on the deterministic template path. Values are the document's own
  // content, quoted verbatim as params.
  'skills.invoiceAnalysis.detailsHeading': 'Details, as printed:',
  'skills.invoiceAnalysis.detailVendor': '- Vendor: {vendor}',
  // P3 (invoice-hardening-2026-07-04): the bill-to party, read from a labeled line only.
  'skills.invoiceAnalysis.detailRecipient': '- Recipient (billed to): {recipient}',
  'skills.invoiceAnalysis.detailInvoiceNumber': '- Invoice number: {number}',
  'skills.invoiceAnalysis.detailInvoiceDate': '- Invoice date: {date}',
  'skills.invoiceAnalysis.detailDueDate': '- Due date: {date}',
  // W3 (audit §8.1): the deterministic figure echo printed UNDER a grounded-data model answer, so any
  // model misquote is immediately contradicted by the parser's own figures. Amounts pass through verbatim.
  'skills.invoiceAnalysis.figureEcho': 'Figures as parsed, verbatim from the document: {figures}.',
  // SKA-21 (W6): {value} is "{amount} {currency}", or the bare amount on a mixed-currency invoice with no
  // header currency (no misleading lineItems[0] code, no dangling space) — built by `amountText`.
  'skills.invoiceAnalysis.figureEchoNet': 'net {value}',
  'skills.invoiceAnalysis.figureEchoTax': 'tax {value}',
  'skills.invoiceAnalysis.figureEchoGross': 'gross {value}',
  // invoice-hardening-2026-07-04 P2: the reconciliation GATE. When any totals check MISMATCHED, the
  // template swaps the confident totals heading for the unverified one and appends the caveat, and the
  // grounded-data figure echo is replaced by the suppressed note — figures the document's own arithmetic
  // contradicts must never be presented as reliable ("verbatim from the document" is technically true
  // but misleading when the document was probably misread).
  'skills.invoiceAnalysis.totalsHeadingUnverified':
    'Figures as printed — **they don’t add up**, so treat them as unverified:',
  'skills.invoiceAnalysis.unreconciledCaveat':
    'These printed figures contradict each other, which usually means the document didn’t extract ' +
    'cleanly (a scan, an image-based PDF, or an unusual layout). Don’t rely on any of these numbers ' +
    'without checking the original document.',
  'skills.invoiceAnalysis.figureEchoSuppressed':
    'I’m not repeating the parsed totals here: they don’t reconcile with each other or with the line ' +
    'items, so quoting them as reliable figures would be misleading. Check the original document.',
  // invoice-hardening-2026-07-04 P3: the glyph-soup outcomes. `unreadableLayout` is the refusal when the
  // text layer is scrambled AND the figures are contradictory/empty (after the geometry retry);
  // `textQualityCaveat` hedges the rare scrambled-but-reconciling read.
  'skills.invoiceAnalysis.unreadableLayout':
    'This document’s text doesn’t extract cleanly — the characters come out scrambled (glyph by glyph), ' +
    'which usually means an image-based or unusually encoded PDF. I couldn’t read reliable line items or ' +
    'totals from it, so I won’t quote figures. If it’s a scan, run OCR (text recognition) on it first; ' +
    'otherwise open the invoice and read the figures directly.',
  'skills.invoiceAnalysis.textQualityCaveat':
    'A caution: parts of this document’s text extracted in a scrambled (glyph-by-glyph) layout. The ' +
    'figures above do reconcile, but check anything important against the original document.',

  // Full-doc-skills Phase 3 (§3.2/D45): the refuse-partial notice. A tool skill can only answer
  // exhaustively over a FULLY-INDEXED document; a legacy/partly-chunked doc is refused (no partial
  // answer, no model call) and the user is pointed at the existing Re-index affordance. Content-free.
  'skills.analysis.refusePartial':
    'I can only answer this accurately from the whole document, and this one isn’t fully indexed ' +
    'yet. Open the Documents screen and choose Re-index, then ask again.',

  // W2 doc-count-fallthrough routing (audit §2.1). A tool/whole-doc skill reads ONE document at a time,
  // so a multi-document scope can’t be analysed exhaustively. Instead of silently degrading to a couple
  // of retrieved passages, the app either narrows to the one document this skill best matches (with the
  // honest `scopeNarrowed` notice) or asks the user to pick. Deterministic, content-free (a title +
  // count, no document text), no model call.
  // Prepended to the answer when the scope was auto-narrowed to a single best-matching document.
  'skills.analysis.scopeNarrowed':
    'I answered from **{title}** only — the other {count} document(s) in scope weren’t read. To analyse ' +
    'a different one, select just that document (or name its file in your question) and ask again.',
  // No single best match (0 or several candidates): ask the user to pick ONE document to analyse fully.
  'skills.analysis.selectOne':
    'To analyse this fully I need a single document — right now {count} are in scope, so I can only see ' +
    'a few passages across them. Select one document (or name its file in your question) and ask again.',
  // what-changed compare needs EXACTLY two documents; ask the user to select them (audit §3.4).
  'skills.analysis.selectTwo':
    'To compare, select exactly **two** documents (or two versions) — {count} are in scope right now. ' +
    'Choose the two you want to compare and ask again.',

  // Redaction-routing answer: an ACTION skill points the user at its own run button instead of
  // producing a top-k Q&A. Deterministic + content-free (no model call, no document read); `{button}`
  // is the SkillRunBar's own label so the wording matches the affordance the user sees.
  'skills.redactionRouting.answer':
    'To redact this document, click the **{button}** button just above the message box, then choose ' +
    'where to save the copy. It runs entirely on this device and masks clearly-formatted personal ' +
    'data — e-mail addresses, phone numbers, IBANs, dates, and links — reading the whole document. ' +
    'It’s a best-effort first pass, not a guarantee: it can’t catch names or unusual formats, so ' +
    'review the saved copy before you share it.',
  // U-1: the same routing answer when MORE THAN ONE document is in scope. The tool redacts one
  // document at a time, so the copy is honest about that and points at the run button's own target
  // chooser — content-free (the count drives the wording; no document title appears here).
  'skills.redactionRouting.answerMulti':
    'To redact a document, click the **{button}** button just above the message box and pick which ' +
    'document to redact, then choose where to save the copy. It works on one document at a time, ' +
    'runs entirely on this device, and masks clearly-formatted personal data — e-mail addresses, ' +
    'phone numbers, IBANs, payment-card numbers, dates, and links — reading the whole document. It’s ' +
    'a best-effort first pass, not a guarantee: it can’t catch names or unusual formats, so review ' +
    'the saved copy before you share it.',
  // Edit-routing answer (Phase 8, #23): an ACTION skill points the user at its own run button instead of
  // regenerating the prose (which hallucinates). Deterministic + content-free (no model call, no read);
  // `{button}` is the SkillRunBar's own label so the wording matches the affordance the user sees.
  'skills.editRouting.answer':
    'To make these edits, click the **{button}** button just above the message box, then choose where to ' +
    'save the edited copy. It runs entirely on this device and applies only the exact find-and-replace ' +
    'changes you asked for — everywhere the text is found verbatim, leaving everything else unchanged. It ' +
    'never rewrites the document, so it can’t invent or reword anything. This phase saves a plain text ' +
    '(.txt) copy; review it before you share it.',
  // U-1: the same routing answer when MORE THAN ONE document is in scope. The tool edits one document at a
  // time, so the copy is honest about that and points at the run button's own target chooser.
  'skills.editRouting.answerMulti':
    'To make these edits, click the **{button}** button just above the message box and pick which document ' +
    'to edit, then choose where to save the edited copy. It works on one document at a time, runs entirely ' +
    'on this device, and applies only the exact find-and-replace changes you asked for — everywhere the ' +
    'text is found verbatim, leaving everything else unchanged. It never rewrites the document. This phase ' +
    'saves a plain text (.txt) copy; review it before you share it.',
  // U2 dry-run (audit §3.4): an INFORMATIONAL "what personal data is in here?" ask over a single document
  // gets the deterministic per-category counts (COUNTS only — never a detected value) instead of the button
  // deflection. Runs the same offline detectors the tool would; still no file write.
  'skills.redactionRouting.scan':
    'I scanned the whole document for clearly-formatted personal data. Detected — e-mail addresses: ' +
    '{email}, phone numbers: {phone}, IBANs: {iban}, payment-card numbers: {card}, dates: {date}, ' +
    'links: {url}. This is a best-effort pattern scan: it can’t catch names, postal addresses, or ' +
    'unusual formats, so treat these as a floor, not a full inventory. To create a masked copy, click ' +
    'the **{button}** button just above the message box and choose where to save it.',

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
  'models.hint.translation': 'Translates your documents and text between languages, entirely offline.',
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
  'models.vision.installed': 'Installed — ready in the Images tab. Nothing to start here.',
  'models.vision.notInstalled': 'Available in the Images tab once installed — no setup needed.',
  'models.translation.installed': 'Installed — used automatically for translation. Nothing to start here.',
  'models.translation.notInstalled': 'Used automatically for translation once installed — no setup needed.',
  'models.selected': 'Selected',
  // Beta #27 (D70): the Select + Start pair collapsed into ONE primary action per installed chat
  // card — it makes this the active model AND starts its runtime, so a first-time user has a single
  // obvious way to get to chatting (selected models still auto-start at launch; only mid-session did
  // Select≠Start bite). The old models.select / models.startRuntime / models.startTitle labels retired.
  'models.use': 'Use this model',
  'models.useTitle': 'Make this your model and start it so you can chat',
  'models.stopRuntime': 'Stop runtime',
  'models.startMock': 'Try in demo mode',
  'models.starting': 'Starting…',
  'models.startingTitle': 'This model is loading — it can take a little while for large models',
  'models.startMockTitle':
    'No model file yet — try the app in demo mode, with visibly simulated answers',
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
  // ---- Context-size picker (2026-07-04 user report — the truncation hint points here) ----
  'models.context.title': 'Context size',
  'models.context.label': 'Context window for answers:',
  'models.context.auto': 'Automatic — the model’s recommended size',
  'models.context.hint':
    'A larger context lets a conversation or a document answer carry more text at once, but it ' +
    'needs more memory and can slow answers down. Takes effect the next time a model starts.',
  'models.context.restartHint':
    'A model is running right now — stop and start it to apply the new size.',
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
  // ---- Settings: Chat / conversation compaction (context-compaction plan §5.4) ----
  'settings.chat.title': 'Chat',
  'settings.chatCompaction.label': 'Summarize older messages to free up context',
  'settings.chatCompaction.help':
    'On by default. When a long conversation approaches the model’s context limit, the older ' +
    'messages are summarized once into a compact note — kept on this drive — instead of being ' +
    'silently dropped. Turn off to keep only the most recent messages that fit.',
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
  // Shown when no override is set: the launched window follows the model's recommendation.
  'settings.workspace.contextAuto': 'Automatic (model default) — change it on the AI Model screen',
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

  // ---- Skills (rail destination — SkillsScreen.tsx + settings/SkillsTab.tsx, skills plan §15) ----
  'skills.title': 'Skills',
  'skills.intro': 'Skills teach the assistant how to do a specific task. They add guidance to its answers — they never reach the internet or other folders on your computer.',
  // S13c (D4) — the global auto-fire opt-in, off by default. The hint explains plainly what turning
  // it on does and that every auto-applied skill stays visible + reversible.
  'skills.autoFire.title': 'Apply a matching skill automatically',
  'skills.autoFire.toggle': 'Apply a matching skill automatically',
  'skills.autoFire.hint':
    'When on, the app may apply a clearly matching app skill to an answer on its own, so you don’t have to pick it. Only app skills, never ones you made or imported. You’ll always see which skill was used, and you can answer without it for that turn. Off by default.',
  'skills.autoFire.on': 'Automatic skills on',
  'skills.autoFire.off': 'Automatic skills off',
  'skills.import': 'Import skill…',
  'skills.import.menuAria': 'Import a skill',
  'skills.import.fromFile': 'From a file (.skill.zip)…',
  'skills.import.fromFolder': 'From a folder…',
  'skills.loading': 'Loading skills…',
  'skills.locked': 'Unlock your workspace to manage skills.',
  'skills.loadFailed': 'Skills couldn’t be loaded.',
  // SKA-32: the reconcile-error notice (count only — never a folder name; §22-M1).
  'skills.reconcile.folderErrors.one':
    '{count} skill folder could not be read and is skipped. Its SKILL.md is missing, invalid, or unreadable.',
  'skills.reconcile.folderErrors.other':
    '{count} skill folders could not be read and are skipped. Each folder needs a valid SKILL.md.',
  'skills.empty.title': 'No skills yet',
  'skills.empty.line': 'Skills teach the assistant how to do a specific task. Add one to get started.',
  // Trust chip (icon + word, never colour-only — guidelines §9).
  'skills.trusted.app': 'App',
  'skills.trusted.user': 'Made by you',
  // Per-row enable switch. The label states what the switch controls; the checked
  // state carries on/off. Each row's title gives the context.
  'skills.row.enableLabel': 'Enabled',
  'skills.row.on': 'Skill on',
  'skills.row.off': 'Skill off',
  // DS12 — two installed skills declare the same id; only one can be active.
  'skills.dup.chip': 'Duplicate name',
  'skills.dup.title': 'Another installed skill uses this name. Only one can be active at a time.',
  // DS1/§7.4 — the on-disk folder vanished; the row is kept but can’t be used.
  'skills.unavailable.chip': 'Files missing',
  'skills.unavailable.title': 'This skill’s files are no longer on the drive.',
  'skills.incompatible.chip': 'Needs newer app',
  'skills.incompatible.title': 'This skill needs a newer version of the app; update to enable it.',
  // DS7 — review chip + the calm acknowledge banner in the detail view.
  'skills.review.chip': 'Review',
  'skills.warn.title': 'Review what this skill can do',
  'skills.warn.body': 'Made by you or imported. Check what it can do before you rely on it.',
  'skills.warn.ack': 'Got it',
  // Row overflow menu ("⋯").
  'skills.menu.aria': 'Skill actions',
  'skills.menu.export': 'Export…',
  'skills.menu.delete': 'Delete',
  'skills.export.done': 'Skill exported',
  // Delete confirmation (DS-/§9.4 — chats that used it keep working; no FK).
  'skills.delete.title': 'Delete this skill?',
  'skills.delete.body': 'This removes the skill from the drive. Chats that already used it keep working.',
  'skills.delete.confirm': 'Delete',
  'skills.delete.done': 'Skill deleted',
  // Detail drawer.
  'skills.detail.aria': 'Skill details',
  'skills.detail.version': 'Version',
  'skills.detail.author': 'Author',
  'skills.detail.language': 'Language',
  'skills.detail.kind': 'Type',
  'skills.kind.instruction': 'Guidance',
  'skills.kind.tool': 'Uses tools',
  // §13/§22-D1 — a tool-reserved skill adds guidance only in v1.
  'skills.tool.note': 'For now this adds guidance only. The tools it describes arrive in a later version.',
  // S11c — a kind:'tool' skill names its real, app-orchestrated tools. Honest about auto-run (U5 /
  // ux-16): read-only tools may run automatically to answer a question; writes/exports always confirm.
  'skills.tool.note.active':
    'When you ask, this skill can run approved local tools on a document you choose. Read-only tools may also run automatically to answer your question; anything that writes or exports a file always asks you first. They see only that document.',
  // The permission block (skills plan §15 copy). Derived from the already-clamped
  // permissions — the renderer localises the result, it does not re-decide it.
  'skills.perm.heading': 'What this skill can do',
  'skills.perm.canTitle': 'This skill can:',
  'skills.perm.cannotTitle': 'This skill cannot:',
  'skills.perm.can.instructions': 'Add instructions to AI answers',
  'skills.perm.can.documents': 'Read only documents you choose',
  'skills.perm.can.tools': 'Use approved local tools when you ask',
  'skills.perm.cannot.network': 'Access the internet',
  'skills.perm.cannot.files': 'Read other folders on your computer',
  'skills.perm.cannot.scripts': 'Run scripts or install software',
  // "Technical details" disclosure (raw structural metadata — not the assembled fence).
  'skills.tech.summary': 'Technical details',
  'skills.tech.id': 'Skill id',
  'skills.tech.installId': 'Install id',
  'skills.tech.source': 'Source',
  'skills.tech.permissions': 'Permissions',
  // Import preview / confirm dialog.
  'skills.import.title': 'Add this skill?',
  'skills.import.confirm': 'Add skill',
  'skills.import.added': 'Skill added',
  'skills.import.failedTitle': 'This skill can’t be added',
  'skills.import.failed': 'This skill couldn’t be added.',
  'skills.import.collision': 'A skill with this name is already installed. Adding this replaces it.',
  'skills.import.collisionApp': 'An app skill already uses this name. Your skill is added but stays off while the app skill is on.',
  'skills.import.upgrade': 'Updates the installed version ({from} → {to}).',
  'skills.import.replace': 'Replaces the installed version ({version}).',
  'skills.import.downgrade': 'This is older than the installed version ({installed}).',
  'skills.import.downgradeBlocked': 'Installing an older version needs developer mode. Turn it on in Settings → General to allow this.',
  // Structural import-failure reasons, localized from the content-free code the preview carries (I2).
  'skills.import.error.notFound': 'The selected skill could not be found.',
  'skills.import.error.notZipOrFolder': 'A skill must be a .skill.zip file or a folder containing SKILL.md.',
  'skills.import.error.unreadableZip': 'The skill package could not be read as a valid zip archive.',
  'skills.import.error.encryptedZip': 'The skill package uses an unsupported (encrypted or ZIP64) zip format.',
  'skills.import.error.unsupportedCompression': 'The skill package uses an unsupported compression method.',
  'skills.import.error.pathTraversal': 'The package contains a file whose path escapes the package folder.',
  'skills.import.error.absolutePath': 'The package contains a file with an absolute or drive-letter path.',
  'skills.import.error.invalidPath': 'The package contains a file with an invalid path.',
  'skills.import.error.symlink': 'The package contains a symbolic link, which is not allowed.',
  'skills.import.error.tooDeep': 'The package nests folders more deeply than allowed.',
  'skills.import.error.pathTooLong': 'The package contains a file path that is too long.',
  'skills.import.error.tooManyFiles': 'The package contains more files than allowed.',
  'skills.import.error.tooLarge': 'The package is larger than the allowed size.',
  'skills.import.error.fileTooLarge': 'A file in the package is larger than the allowed size.',
  'skills.import.error.duplicatePath': 'The package contains two files that resolve to the same path.',
  'skills.import.error.badExtension': 'The package contains a file type that is not allowed.',
  'skills.import.error.nestedArchive': 'The package contains an embedded archive, which is not allowed.',
  'skills.import.error.noSkillMd': 'The package does not contain a SKILL.md file.',
  'skills.import.error.invalidManifest': 'The skill manifest is invalid.',
  'skills.import.error.idMismatch': 'The skill id is not a valid name.',
  'skills.import.error.downgradeBlocked': 'A newer version of this skill is already installed. Turn on developer mode to install an older version.',
  'skills.import.error.appReadOnly': 'App-provided skills cannot be changed or deleted.',
  'skills.import.error.locked': 'Unlock the workspace to manage skills.',
  // SKA-35: import-preview advisory notes, localized via their stable code + app-fixed params
  // ({field} = a fixed frontmatter field name, {max}/{value} = app constants — never skill content).
  'skills.import.note.permissionNotString': 'The "{field}" permission isn’t a text value; the default "{value}" is used.',
  'skills.import.note.permissionUnrecognized': 'The "{field}" permission has a value this app doesn’t recognize; the default "{value}" is used.',
  'skills.import.note.permissionClamped': 'The skill asks for more "{field}" access than this app allows; it is limited to "{value}".',
  'skills.import.note.listInvalid': 'The "{field}" list is not a list of texts and is ignored.',
  'skills.import.note.listItemsTooLong': 'Some entries in "{field}" are too long and are ignored.',
  'skills.import.note.listTruncated': '"{field}" has more entries than allowed; only the first {max} are kept.',
  'skills.import.note.languageInvalid': 'The "language" field is not a valid language tag; "en" is used.',
  'skills.import.note.allowedToolsIgnored': 'The declared tools are ignored for an instruction skill (tools come with a later version).',
  'skills.import.note.analysisInvalid': 'The "analysis" field has an unknown value and is ignored.',
  'skills.import.note.analysisIgnoredForTool': 'The "analysis" field is ignored for a tool skill (the app decides its whole-document behaviour).',
  'skills.import.note.triggersInvalid': 'The "triggers" block is invalid and is ignored.',
  'skills.import.note.autoFireInvalid': 'The "triggers.autoFire" field must be true or false; it is treated as false.',
  'skills.import.note.localizedInvalid': 'The "localized" block is invalid and is ignored.',
  'skills.import.note.localizedLocaleInvalid': 'A "localized" entry has an invalid language key and is ignored.',
  'skills.import.note.localizedEntryInvalid': 'A "localized" entry is invalid and is ignored.',
  'skills.import.note.localizedTitleIgnored': 'A translated title was ignored (it must be a short single line).',
  'skills.import.note.localizedDescriptionIgnored': 'A translated description was ignored (it must be a short single line).',
  'skills.import.note.localizedTooMany': 'The "localized" block has more languages than allowed; only the first {max} are kept.',
  'skills.import.note.trustIgnored': 'A "trust" field in the skill is ignored; the app assigns trust itself.',
  'skills.import.note.manifestJsonConflict': 'The packaged manifest.json "{field}" differs from SKILL.md; SKILL.md is used.',
  // DS12 — enabling a skill whose name is shared turns the other one off.
  'skills.replace.title': 'Use this skill instead?',
  'skills.replace.body': 'Another skill with this name is on. Turning this one on turns the other one off.',
  'skills.replace.confirm': 'Turn on',

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
  'diag.audit.message_table_exported': 'Answer table exported',
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
  'diag.audit.skill_imported': 'Skill imported',
  'diag.audit.skill_deleted': 'Skill deleted',
  'diag.audit.skill_enabled': 'Skill enabled',
  'diag.audit.skill_disabled': 'Skill disabled',
  'diag.audit.skill_run_started': 'Skill tool started',
  'diag.audit.skill_run_done': 'Skill tool finished',
  'diag.audit.skill_run_failed': 'Skill tool failed',
  'diag.accel.gpuFallbackName': 'Graphics card',
  'diag.accel.gpu': '{name} (GPU)',
  'diag.accel.mock': 'Built-in demo mode',
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
  // Short labels for the app-rail foot indicator (§12.1 #2): the full "Local · …" form
  // is too wide for the 100px rail, so the rail shows just the effective state (icon +
  // one word) with the full reassurance in the tooltip.
  'indicator.short.offline': 'Offline',
  'indicator.short.online': 'Downloads on',

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
  // Interpolated persist-canonical (the offending extension is part of the value), so this
  // is NOT in the exact-match DISPLAY_MAP_KEYS set — the renderer display map reverse-matches
  // it via a template-derived regex (renderer/lib/displayMap.ts) and re-interpolates {ext} in
  // the target language. Friendly + calm per §7; lists the formats the user can actually use.
  'main.ingest.unsupportedType':
    "This file type isn't supported ({ext}). Try TXT, PDF, DOCX, CSV, or a supported audio format.",
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
  'main.benchmark.locked': 'Workspace is locked. Unlock it to run the benchmark.',

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
  'main.translation.noModel':
    'Translating needs the translation model, which is not installed on this drive. ' +
    'You can download it on the AI Model screen.',
  // F-7 (FA-4, option c): the translation sidecar could not start — most likely transient memory
  // pressure from the co-resident chat model. The latch keeps it down until restart, so the copy is
  // actionable rather than a bare failure. Content-free (no path, no runtime detail).
  'main.translation.startFailed':
    "The translation model couldn't start — the device may be low on memory. " +
    'Close other apps or restart HilbertRaum, then try again.',
  // Persisted INTO the generated translation (L12) — localized at materialization time, not a
  // canonical-English DB string. `failedWindowNotice` keeps its `> ` blockquote prefix.
  'main.translation.failedWindowNotice':
    '> ⚠ This part ({part} of {total}) could not be translated — ' +
    'the original text is kept below unchanged.',
  'main.translation.attributionLine': 'Machine-translated by {modelId} — may contain errors.',
  'main.model.contextExceeded':
    "This is too large for the current model's context window. Try a model with a larger context, or a smaller document.",
  'main.chat.streamInFlight': 'A response is already being generated for this conversation.',
  'main.chat.nothingToRegenerate': 'Nothing to regenerate yet.',
  'main.chat.emptyMessage': 'Cannot send an empty message.',
  'main.chat.emptyQuestion': 'Cannot send an empty question.',
  'main.chat.stopFirst': 'A response is still being generated for this conversation. Stop it first.',
  'main.chat.locked': 'Workspace is locked. Unlock it to chat.',
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
  'main.task.translationTarget':
    'Choose a supported source language and a different target language for the translation.',
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
  // F16 (audit-postmerge-2026-06-29): localized lock copy for the model / activity / settings
  // DB-touching handler groups, so a locked call surfaces the friendly message instead of the raw
  // vault-getter string (parity with chat/docs/benchmark).
  'main.models.locked': 'Workspace is locked. Unlock it to manage AI models.',
  'main.audit.locked': 'Workspace is locked. Unlock it to view activity.',
  'main.settings.locked': 'Workspace is locked. Unlock it to change settings.',
  // S3 (full-audit-2026-06-30): dictation writes a transient plaintext WAV into the workspace
  // documents dir, so it must lock-gate like the other workspace-touching handlers.
  'main.dictation.locked': 'Workspace is locked. Unlock it to use voice dictation.',
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
  'main.dialog.exportTableCsv': 'Export table as CSV',
  'main.dialog.exportAudit': 'Export activity log',
  'main.dialog.exportLog': 'Save diagnostic logs',
  'main.dialog.filterDocuments': 'Documents',
  'main.dialog.filterAll': 'All files',
  'main.dialog.chooseImage': 'Choose an image',
  'main.dialog.filterImages': 'Images',
  'main.dialog.importSkill': 'Import a skill package',
  'main.dialog.importSkillFolder': 'Import a skill folder',
  'main.dialog.exportSkill': 'Export skill',
  'main.dialog.filterSkill': 'Skill package',
  'main.dialog.exportCsv': 'Export transactions',
  'main.dialog.filterCsv': 'CSV file',
  // U5 (audit §6.2): per-export save-dialog metadata — the ONE hardcoded CSV dialog used to serve every
  // export (redaction's "Save redacted copy" got an "Export transactions" title + a .csv filter fighting
  // invoice.json on Windows). Each format now names its own title/filter/extension.
  'main.dialog.exportJson': 'Export as JSON',
  'main.dialog.filterJson': 'JSON file',
  'main.dialog.exportXml': 'Export as XML',
  'main.dialog.filterXml': 'XML file',
  'main.dialog.exportRedacted': 'Save redacted copy',
  'main.dialog.exportEdited': 'Save edited copy',
  'main.dialog.filterText': 'Text file',
  // Phase 9 (D77): same-format DOCX export — a Word source keeps its `.docx` (formatting preserved).
  'main.dialog.filterDocx': 'Word document',
  'main.collections.builtinUndeletable': 'The built-in Library and Temporary cannot be deleted.',
  'main.skills.locked': 'Workspace is locked. Unlock it to manage skills.',
  'main.skills.incompatible': 'This skill needs a newer version of the app. Update to use it.',
  // Tier-2 tool runs (skills plan §12.2, S11b) — friendly, content-free.
  'main.skills.run.unavailable': "This skill's tool isn't available right now.",
  'main.skills.run.noDocument': 'Add a document to this chat first, then try again.',
  'main.skills.run.busy': 'A skill is already working. Let it finish or cancel it first.',
  // U-1: a renderer-supplied target id that is not in the freshly-resolved in-scope set (a defensive
  // backstop — the renderer only ever offers in-scope ids). Friendly + content-free.
  'main.skills.run.documentOutOfScope': "That document isn't in this chat's documents. Pick one of them and try again.",

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
  // Beta-feedback Phase 4 (#26/D71): the always-visible "Answering from:" chip near the composer.
  // Reframes the scope popover's trigger so the active retrieval scope is legible BEFORE asking —
  // one click still opens the same picker. The whole-library case names the corpus size instead of
  // the bare word "Library" so "answer from everything" reads as a deliberate breadth, not a default.
  'chat.scope.answeringFrom': 'Answering from: {source}',
  'chat.scope.wholeLibrary.one': 'your whole library — {count} document',
  'chat.scope.wholeLibrary.other': 'your whole library — {count} documents',
  // Attaching a file to an EXISTING whole-library documents chat offers a one-time narrow choice
  // (#26/D71), sticky per conversation once answered.
  'chat.scope.narrowTitle': 'Answer from just this file?',
  'chat.scope.narrowBody':
    'You added {name}. Ask only this file, or keep answering from your whole library?',
  'chat.scope.narrowJust': 'Just this file',
  'chat.scope.narrowWhole': 'Whole library',

  // ---- Chat — attach / drag-drop a file into a chat (plan §11.2/§13.5, Phase C) ----
  // German copy reviewed in the D-L7 pass (2026-06-14).
  'chat.attach.button': 'Attach files',
  'chat.attach.drop': 'Drop files to use them in this chat',
  'chat.attach.processing': 'Processing {name}…',
  // Screen-reader-only confirmation for the keyboard/picker path (UX-3) — paired with
  // `processing` in an aria-live region so attaching a file is audibly acknowledged.
  'chat.attach.added': 'Added {name} to this chat',
  'chat.attach.newDocChat': 'Started a new document chat for {name}',
  'chat.attach.failed': "Couldn't add {name} to this chat.",
  // FE-C: a Files-bearing drop that resolved to no on-disk file (a browser-origin drag) — surfaced
  // instead of failing silently. Pairs with the FE-A drop-path fix (full-audit-2026-06-29 follow-up).
  'chat.attach.dropUnsupported': "Couldn't add that — drag in a file saved on your computer.",

  // ---- Images — "Ask about an image" (image-understanding §5/§11, Phase V3) ----
  // Visual understanding of ONE local PNG/JPEG via a local vision model — distinct from OCR
  // (Documents) and from any image generation/editing (never built). Nothing is persisted.
  'images.title': 'Understand an image',
  'images.empty.body':
    'Ask questions about a screenshot, chart, form, receipt, or photo. Everything stays local.',
  // Availability card (§5.1) — reason-adaptive note + a CTA to AI Model + an OCR pointer.
  'images.avail.noModel': 'Image understanding needs a local vision model on this drive.',
  'images.avail.noRuntime': 'Image understanding needs the AI engine installed first.',
  'images.avail.incompatible': "This drive's vision model needs a newer AI engine.",
  'images.avail.cta': 'Go to AI Model',
  'images.avail.ocrPointer': 'Scanned documents? Use Make searchable (OCR) under Documents.',
  // Locked posture (§5.6). The app shell normally gates the whole app behind the unlock
  // screen, so this is a calm defensive fallback.
  'images.locked': 'Unlock your workspace to understand an image.',
  // Drop zone (§5.2) — a large, focusable target; the "choose" button is the non-drag path.
  'images.drop.title': 'Drop an image here',
  'images.drop.choose': 'or choose an image',
  'images.drop.types': 'PNG or JPEG',
  // Shown while an analysis is running: a new upload is disabled (vision is one-at-a-time).
  'images.drop.busy': 'An analysis is running. Wait for it to finish to start another.',
  // Detail view → back to the upload + previous-results view.
  'images.back': 'Back to analyses',
  // Preview pane (§5.3).
  'images.preview.remove': 'Remove',
  'images.preview.replace': 'Replace',
  'images.preview.alt': 'Selected image',
  // Suggestion chips (§5.5): clicking FILLS the composer (no auto-send) so the user can edit.
  'images.chip.summarize': 'Summarize this image',
  'images.chip.summarize.prompt':
    'Summarize the visible content of this image. Mention anything important or unusual.',
  'images.chip.extractText': 'Extract visible text',
  'images.chip.extractText.prompt':
    'Extract the visible text you can read. Preserve line breaks where helpful. Say if any text is unclear.',
  'images.chip.explainChart': 'Explain this chart',
  'images.chip.explainChart.prompt':
    'Explain what this chart appears to show. Mention axes, labels, trends, and any uncertainty.',
  'images.chip.readForm': 'Read this form',
  'images.chip.readForm.prompt':
    "Identify the key fields and values visible in this form. Use 'unclear' where you cannot read something.",
  'images.chip.importantDetails': 'Find important details',
  'images.chip.importantDetails.prompt':
    'List the most important visible details. Do not infer anything that is not visible.',
  'images.chip.whatNotice': 'What should I notice?',
  'images.chip.whatNotice.prompt':
    'What should I notice in this image? Point out the most salient visible elements only.',
  // Question composer (§5.3).
  'images.composer.placeholder': 'Ask about this image…',
  'images.composer.ask': 'Ask',
  // Answer thread (§5.4).
  'images.answer.localNote': 'Generated locally from the selected image.',
  'images.answer.copy': 'Copy',
  'images.answer.copied': 'Copied',
  'images.answer.tryAgain': 'Try again',
  'images.answer.reading': 'Reading the image…',
  'images.answer.starting': 'Starting the vision model…',
  'images.answer.stop': 'Stop',
  'images.answer.stopped': 'Stopped.',
  // Friendly error rows (§5.6) — a CODE is mapped here; raw model/runtime text never shows.
  'images.err.tooLarge': 'This image is too large to analyze. Try a smaller image.',
  'images.err.unsupported': "That file type isn't supported. Choose a PNG or JPEG.",
  'images.err.decodeFailed':
    "That image couldn't be opened. It may be damaged or in an unsupported format.",
  'images.err.multiDrop': 'Drop one image at a time.',
  'images.err.runtimeFailed': "The vision model couldn't start. Try again, or pick another model.",
  'images.err.emptyResponse': 'No answer came back for that image. Try rephrasing your question.',
  'images.err.busy': 'Working on the previous question…',
  // History (image-understanding history): saved analyses, encrypted at rest, deletable.
  'images.history.title': 'History',
  'images.history.empty': 'Images you analyze will appear here.',
  // The in-flight analysis, shown as the top row of the results list while it runs.
  'images.history.running': 'Analysis running…',
  'images.history.runningOpen': 'View the running analysis',
  'images.history.turns.one': '{count} question',
  'images.history.turns.other': '{count} questions',
  'images.history.open': 'Open',
  'images.history.delete': 'Delete',
  'images.history.deleted': 'Removed from history',
  'images.history.delete.title': 'Delete this image?',
  'images.history.delete.confirm': 'Delete',
  'images.history.delete.body':
    '“{title}” and its answers will be permanently removed from this drive.',

  // ---- Translate screen (TranslateGemma wave, plan §2 D6, TG-4) ----
  // Live TEXT translation on the local TranslateGemma sidecar. Everything stays local; nothing is
  // persisted. (Document drag-and-drop translation is TG-5.)
  'translate.title': 'Translate text',
  'translate.lead':
    'Type or paste text, pick the languages, and translate it locally. Nothing leaves this drive.',
  // Brief placeholder while the first availability read resolves.
  'translate.starting': 'Getting the translation model ready…',
  // Locked posture: the app shell normally gates the whole app behind unlock, so this is a calm fallback.
  'translate.locked': 'Unlock your workspace to translate text.',
  // Availability EmptyState (the O2 install path) — a friendly refusal + a deep link to AI Model.
  'translate.avail.noModel': 'Translation needs the translation model on this drive.',
  'translate.avail.hint': 'Download it once on the AI Model screen — then translation works fully offline.',
  'translate.avail.cta': 'Go to AI Model',
  // Language bar.
  'translate.from': 'From',
  'translate.to': 'To',
  'translate.swap': 'Swap languages',
  // Input pane.
  'translate.input.label': 'Text to translate',
  'translate.input.placeholder': 'Type or paste the text to translate…',
  'translate.action': 'Translate',
  'translate.stop': 'Stop',
  // Output pane.
  'translate.output.label': 'Translation',
  'translate.output.empty': 'The translation will appear here.',
  'translate.working': 'Translating…',
  'translate.copy': 'Copy',
  'translate.copied': 'Copied',
  // Friendly error rows — a CODE is mapped here; raw model/runtime text never shows.
  'translate.err.noModel': 'The translation model is no longer available. Open the AI Model screen to install it.',
  'translate.err.badRequest': 'Pick a source and target language and enter some text to translate.',
  'translate.err.busy': 'A translation is already running. Wait for it to finish, then try again.',
  'translate.err.docTaskBusy': 'A document task is running. Wait for it to finish, then translate.',
  'translate.err.runtimeFailed': "The translation model couldn't finish. Try again, or a shorter text.",
  'translate.err.startFailed':
    "The translation model couldn't start — the device may be low on memory. Close other apps or restart HilbertRaum, then try again.",
  'translate.err.empty': 'No translation came back. Try again, or rephrase the text.',
  'translate.err.sameLang': 'Pick two different languages.',

  // ---- Document drag-and-drop translation (TG-5, plan §2 D7) ----
  // A dropped/picked document is imported as a Temporary doc, translated on the existing
  // translation doc-task, and the materialized Markdown is shown here (Export / Show in Documents).
  'translate.drop.title': 'Or drop a document to translate',
  'translate.drop.choose': 'or choose a document',
  'translate.drop.types': 'PDF, Word, Markdown, or text — translated into the chosen language.',
  // Progress + result.
  'translate.file.importing': 'Reading the document…',
  'translate.file.progress': 'Translating… ({done}/{total})',
  'translate.file.working': 'Translating the document…',
  'translate.file.truncated':
    'Showing the start of the translation — export it or open it in Documents for the whole document.',
  'translate.file.export': 'Export…',
  'translate.file.exported': 'Document exported',
  'translate.file.show': 'Show in Documents',
  'translate.file.reset': 'Translate another document',
  // Friendly file-path errors — a CODE is mapped here; a backend friendly message shows verbatim.
  'translate.file.err.multiDrop': 'Drop one document at a time.',
  'translate.file.err.noPath':
    'That item has no file on disk. Drag a document from a folder, or use “choose a document”.',
  'translate.file.err.unsupported':
    "That file type can't be translated. Try a PDF, Word, Markdown, or text file.",
  'translate.file.err.importFailed': "The document couldn't be read. Try again.",
  'translate.file.err.runtimeFailed': "The document couldn't be translated. Try again."
} as const
