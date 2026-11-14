import type { UiCatalog } from './languages'

// The FRENCH catalog. Style (design-guidelines §7 "French microcopy"): formal « vous »,
// lowercase mid-sentence; buttons in the infinitive, instructions in the vous imperative;
// nothing agrees with the reader's gender. Quotes « … » with a no-break space inside; a
// no-break space before : ; ? ! % — always U+00A0, written \u00A0 in this file; U+202F only
// between the digits of a typed figure. Apostrophe ’, ellipsis …, the spaced en dash – (never
// —), œ. Unit symbols stay Latin (GB, MB, KB, tok/s, s). Plurals: one (0 and 1), many
// (written like other), other; every form shows {count}. "HilbertRaum" is never translated.
//
// Glossary — keep terms consistent across ALL French copy:
//   workspace                  → espace de travail
//   drive                      → disque
//   vault / encrypted workspace→ espace de travail chiffré (chiffrer, never crypter)
//   model                      → modèle (AI model → modèle d’IA)
//   document                   → document
//   re-index                   → réindexer
//   offline                    → hors ligne
//   "Ask my documents"         → « Interroger mes documents »
//   lock / unlock              → verrouiller / déverrouiller
//   password                   → mot de passe
//   settings                   → Paramètres
//   plaintext (developer) mode → non chiffré (développeur)
//   screens                    → Accueil, Chat, Documents, Traduction, Images, Modèle d’IA,
//                                Performance, Paramètres
//
// Evidence-review glossary (MIRROR of the canonical record in design-guidelines §7; change
// BOTH together):
//   evidence                   → justificatif(s) — the noun « preuve » is banned; « prouver »
//                                appears only negated, in the disclaimers
//   supported                  → étayé (« Vérifié – étayé »)
//   review / evidence review   → vérification / vérification des justificatifs
//   review item                → point de vérification
//   evidence pack              → pack de justificatifs
//   citation / source marker   → référence (never « citation »)
//   whole-document provenance  → provenance : analyse du document entier; the negation is
//                                always « pas des références phrase par phrase »
//   direct excerpt             → extrait direct
//   source (document)          → source / document source
//   reviewer                   → « Vérifié par » (label) / la personne qui vérifie (prose)
//   mark ready / reopen        → Clôturer / Rouvrir la vérification
//   outdated                   → obsolète
//   review creation            → a vérification is « créée », the ANSWER « générée » —
//                                never mixed
//
// Typed `UiCatalog<'fr'>` (i18n record D-L10): a missing, misspelt or extra key is a
// `npm run typecheck` failure. `packExport.*` is not part of it: evidence packs stay English
// or German (D-L11).

export const fr: UiCatalog<'fr'> = {
  // ---- App shell (App.tsx) ----
  'nav.aria': 'Navigation principale',
  'nav.home': 'Accueil',
  'nav.chat': 'Chat',
  'nav.documents': 'Documents',
  'nav.translate': 'Traduction',
  'nav.images': 'Images',
  'nav.models': 'Modèle d’IA',
  'nav.performance': 'Performance',
  'nav.settings': 'Paramètres',
  'app.lockNow': 'Verrouiller',
  'app.lockNowTitle': 'Chiffrer à nouveau et verrouiller l’espace de travail',
  'app.noticeDetails': 'Détails',
  'app.noticeGoToModels': 'Ouvrir l’écran Modèle d’IA',
  'app.fatal.title': 'L’application n’a pas pu démarrer',
  'app.fatal.hintBefore':
    'Le service local de l’application n’a pas démarré\u00A0: rien ne peut être chargé. ' +
    'Redémarrez l’application\u00A0; si le problème persiste, consultez le fichier ',
  'app.fatal.hintAfter': ' sur votre disque et le guide «\u00A0docs/troubleshooting.md\u00A0».',
  'app.loadingWorkspace': 'Chargement de l’espace de travail…',
  'app.loadingScreen': 'Chargement…',
  // ---- Error boundary (ErrorBoundary.tsx — audit FE-1) ----
  'errorBoundary.title': 'Un problème est survenu sur cet écran',
  'errorBoundary.body':
    'Cet écran a rencontré un problème inattendu. Votre travail et vos données sont en ' +
    'sécurité\u00A0: rien n’a été perdu. Réessayez ou revenez à l’Accueil.',
  'errorBoundary.retry': 'Réessayer',
  'errorBoundary.home': 'Revenir à l’Accueil',
  'errorBoundary.app.title': 'L’application a rencontré un problème',
  'errorBoundary.app.body':
    'Un événement inattendu s’est produit. Vos données sur le disque sont en sécurité. Rechargez ' +
    'pour continuer.',
  'errorBoundary.app.reload': 'Recharger',
  // ---- Home (HomeScreen.tsx) ----
  'home.headline.ready': 'Tout est prêt pour discuter.',
  'home.headline.starting': 'Préparation…',
  'home.headline.almost': 'Configuration presque terminée.',
  'home.lead':
    'Un espace de travail d’IA privé et hors ligne. Vos consignes, vos documents et votre ' +
    'historique des conversations restent sur cet appareil.',
  'home.preflight.continue':
    'Vous pouvez tout de même continuer. Si l’application ne s’ouvre pas, consultez le guide de ' +
    'dépannage dans le dossier {folder} du disque.',
  'home.moved.restored':
    'Ce disque a été utilisé en dernier sur un autre ordinateur. Les valeurs pour cet ordinateur ' +
    'proviennent d’un test antérieur, effectué le {when}\u00A0: rien n’a été mesuré à l’instant.',
  'home.moved.restoredUndated':
    'Ce disque a été utilisé en dernier sur un autre ordinateur. Les valeurs pour cet ordinateur ' +
    'proviennent d’un test antérieur\u00A0: rien n’a été mesuré à l’instant.',
  'home.moved.measuring':
    'Ce disque n’a encore jamais été utilisé sur cet ordinateur. Un test est en cours en ' +
    'arrière-plan\u00A0; l’écran Performance affichera les valeurs une fois le test terminé.',
  'home.moved.owed':
    'Ce disque n’a pas encore été testé sur cet ordinateur\u00A0: aucune valeur n’est donc ' +
    'disponible.',
  'home.checking': 'Vérification…',
  'home.workspace.label': 'Espace de travail',
  'home.workspace.encrypted':
    'Chiffré\u00A0: verrouillé par votre mot de passe quand l’application est fermée',
  'home.workspace.plaintext': 'Non chiffré (mode développeur)',
  'home.workspace.badgeProtected': 'Protégé',
  'home.workspace.badgeDeveloper': 'Développeur',
  'home.model.label': 'Modèle d’IA',
  'home.model.fallbackName': 'Votre modèle',
  'home.model.running': '{model} fonctionne sur cet appareil',
  'home.model.selected':
    'Modèle sélectionné\u00A0: {model} (il est peut-être encore en cours de chargement)',
  'home.model.none': 'Aucun modèle sélectionné pour l’instant',
  'home.model.badgeRunning': 'En marche',
  'home.model.badgeStarting': 'Démarrage',
  'home.model.badgeNeedsModel': 'Sans modèle',
  'home.model.open': 'Ouvrir l’écran Modèle d’IA',
  'home.model.engineCannotRun':
    'Le moteur d’IA ne peut pas fonctionner sur cet ordinateur\u00A0: les réponses sont simulées',
  'home.model.badgeEngine': 'Indisponible',
  'home.model.demo': '{model} fonctionne en mode démo\u00A0: les réponses sont simulées',
  'home.model.badgeDemo': 'Mode démo',
  'home.model.choose': 'Choisir un modèle',
  'home.docs.label': 'Documents',
  'home.docs.none': 'Aucun document pour l’instant\u00A0: ajoutez-en pour pouvoir les interroger',
  'home.docsReady.one': '{count} document prêt à être interrogé',
  'home.docsReady.many': '{count} documents prêts à être interrogés',
  'home.docsReady.other': '{count} documents prêts à être interrogés',
  'home.docs.badgeReady': 'Prêt',
  'home.docs.badgeNone': 'Aucun',
  'home.docs.add': 'Ajouter des documents',
  'home.packs.label': 'Packs de connaissances',
  'home.packsReady.one': '{count} pack de connaissances prêt à être interrogé',
  'home.packsReady.many': '{count} packs de connaissances prêts à être interrogés',
  'home.packsReady.other': '{count} packs de connaissances prêts à être interrogés',
  'home.packs.none':
    'Aucun pack pour l’instant\u00A0: ajoutez une version hors ligne de Wikipédia pour poser des ' +
    'questions générales',
  'home.packs.noneReady':
    'Aucun pack n’est prêt à être interrogé\u00A0: vérifiez vos packs sur l’écran Documents',
  'home.packs.badgeNoneReady': 'Aucun prêt',
  'home.packs.add': 'Ajouter des packs',
  'home.packs.open': 'Ouvrir les packs de connaissances',
  'home.actions.startChat': 'Commencer à discuter',
  'home.actions.askDocs': 'Interroger mes documents',
  // ---- Chat (ChatScreen.tsx) ----
  'chat.title': 'Chat',
  'chat.noModel.title': 'Aucun modèle n’est en marche',
  'chat.noModel.startingTitle': 'Le modèle d’IA démarre',
  'chat.noModel.hintBefore':
    'Le Chat et les questions-réponses sur vos documents nécessitent un modèle chargé. Ouvrez ' +
    'l’écran Modèle d’IA, sélectionnez un modèle téléchargé, puis choisissez ',
  'chat.noModel.hintAction': 'Utiliser ce modèle',
  'chat.noModel.hintAfter':
    '. Tout reste en local\u00A0: rien n’est téléchargé ni envoyé sur Internet.',
  'chat.noModel.stillLoading':
    'Si vous venez d’ouvrir l’application, le modèle sélectionné est peut-être encore en cours ' +
    'de chargement\u00A0: cet écran continuera automatiquement dès que le modèle sera prêt.',
  'chat.noModel.starting':
    'Votre modèle démarre\u00A0: le chargement des grands modèles prend un peu de temps. Cet ' +
    'écran continuera automatiquement dès que le modèle sera prêt.',
  'chat.noModel.startingProgress':
    'Votre modèle démarre\u00A0: lecture du fichier de modèle ({gb}\u00A0GB), environ ' +
    '{pct}\u00A0% pour l’instant. Cet écran continuera automatiquement dès que le modèle sera ' +
    'prêt.',
  'chat.noModel.open': 'Ouvrir l’écran Modèle d’IA',
  'chat.noModel.recheck': 'Vérifier à nouveau',
  'chat.empty.title': 'Posez une question, ou interrogez vos documents.',
  'chat.empty.lineDocuments':
    'Les réponses proviennent de vos documents et indiquent leurs sources.',
  'chat.empty.lineChat':
    'Les réponses s’affichent en direct depuis le modèle de ce disque\u00A0: rien ne quitte cet ' +
    'appareil.',
  'chat.empty.fillTitle': 'Insérer dans la zone de message',
  'chat.empty.addDocs': 'Ajouter des documents pour les interroger',
  'chat.exampleChat.explain': 'Expliquez un concept en termes simples',
  'chat.exampleChat.draftEmail': 'Aidez-moi à rédiger un e-mail poli',
  'chat.exampleChat.brainstorm': 'Trouvez des idées pour un projet',
  'chat.example.summarize': 'Résumez ce document',
  'chat.example.paymentTerms': 'Quelles sont les conditions de paiement\u00A0?',
  'chat.example.indemnity': 'Trouvez chaque mention de «\u00A0indemnisation\u00A0»',
  'chat.modeAria': 'Mode du Chat',
  'chat.mode.chat': 'Chat',
  'chat.mode.documents': 'Interroger mes documents',
  'chat.listShow': 'Afficher la liste des conversations',
  'chat.runtime.gpu': '{model} · GPU ({name})',
  'chat.runtime.cpu': '{model} · CPU',
  'chat.runtime.cpuCompat': '{model} · CPU (mode de compatibilité)',
  'chat.runtime.demo': '{model} · mode démo',
  'chat.runtime.title':
    'Le modèle d’IA qui répond dans cette conversation, et s’il fonctionne sur votre carte ' +
    'graphique (GPU) ou sur votre processeur (CPU). Détails\u00A0: Paramètres → Diagnostic.',
  'chat.runtime.compatTitle':
    'Le mode de compatibilité est activé par souci de stabilité\u00A0: les réponses sont ' +
    'générées sur le processeur et peuvent être plus lentes. Vous pouvez essayer de nouveau la ' +
    'carte graphique dans Paramètres → Diagnostic.',
  'chat.convOptions': 'Options de la conversation',
  'chat.saveConversation': 'Enregistrer cette conversation',
  'chat.savedTo': 'Fichier enregistré\u00A0: {path}',
  'chat.copied': 'Copié',
  'chat.copyFailed': 'Le texte n’a pas pu être copié dans le presse-papiers',
  'chat.transcript.label': 'Messages de la conversation',
  'chat.stopped': 'Génération arrêtée\u00A0: la réponse est peut-être incomplète',
  'chat.warmup.hint':
    'La première réponse prend un peu plus de temps\u00A0: le modèle se met en route. Les ' +
    'réponses suivantes seront plus rapides.',
  'chat.scopeNotice': 'Réponse fondée uniquement sur ce que la question nomme\u00A0: {titles}',
  'chat.cancelDocTask': 'Annuler la tâche sur le document',
  'chat.placeholder.documents': 'Posez une question sur vos documents…',
  'chat.placeholder.chat': 'Message…',
  'chat.send.ask': 'Interroger',
  'chat.send.send': 'Envoyer',
  'chat.composer.stop': 'Arrêter',
  // ---- Chat: conversation list (ConversationList.tsx) ----
  'chat.list.title': 'Conversations',
  'chat.list.aria': 'Historique des conversations',
  'chat.list.newChat': '+ Nouvelle conversation',
  'chat.list.newDocQa': '+ Nouvelle question sur mes documents',
  'chat.list.hide': 'Masquer la liste des conversations',
  'chat.list.empty': 'Aucune conversation pour l’instant.',
  'chat.list.docMeta': 'Documents',
  'chat.list.otherGroup': 'Autres / Bibliothèque',
  'chat.list.rowOptionsAria': 'Options de la conversation «\u00A0{title}\u00A0»',
  'chat.search.placeholder': 'Rechercher une conversation…',
  'chat.search.aria': 'Rechercher dans les conversations',
  'chat.search.resultsAria': 'Résultats de la recherche',
  'chat.search.resultsFor': 'Résultats pour «\u00A0{query}\u00A0»',
  'chat.search.noMatches': 'Je n’ai trouvé aucun résultat. Essayez une autre formulation.',
  'chat.search.count.one': '{count} résultat',
  'chat.search.count.many': '{count} résultats',
  'chat.search.count.other': '{count} résultats',
  'chat.group.today': 'Aujourd’hui',
  'chat.group.yesterday': 'Hier',
  'chat.group.last7days': '7 derniers jours',
  'chat.group.earlier': 'Plus anciennes',
  'chat.delete.menuItem': 'Supprimer la conversation',
  'chat.delete.title': 'Supprimer cette conversation\u00A0?',
  'chat.delete.confirm': 'Supprimer',
  'chat.delete.body':
    'La conversation «\u00A0{title}\u00A0» et ses messages seront définitivement supprimés de ce ' +
    'disque.',
  // ---- Chat: answer depth (DepthMenu.tsx; ids stay fast|balanced|deep) ----
  'chat.depth.trigger': 'Détail\u00A0: {label}',
  'chat.depth.fast': 'Rapide',
  'chat.depth.balanced': 'Équilibré',
  'chat.depth.deep': 'Approfondi',
  'chat.depth.fastHint': 'Des réponses courtes et directes',
  'chat.depth.balancedHint': 'Le choix par défaut pour un usage courant',
  'chat.depth.deepHint':
    'Examine le problème en profondeur avant de répondre\u00A0: cela prend plus de temps',
  // ---- Chat: skill picker + per-message glyph (skills plan §10/§15) ----
  'chat.skill.trigger': 'Compétence\u00A0: {label}',
  'chat.skill.none': 'Aucune compétence',
  'chat.skill.suggested': 'Suggestion\u00A0: {title}. L’utiliser\u00A0?',
  'chat.skill.suggestedHint': 'Suggestion\u00A0: {title}',
  'chat.skill.used': 'Compétence\u00A0: {title}',
  'chat.skill.usedTitle': 'Cette réponse a été produite avec la compétence «\u00A0{title}\u00A0».',
  'chat.skill.autoFired': 'Réponse générée avec «\u00A0{title}\u00A0»',
  'chat.skill.autoFiredTitle':
    'L’application a appliqué automatiquement la compétence «\u00A0{title}\u00A0» à cette ' +
    'réponse. Vous pouvez obtenir une réponse sans cette compétence.',
  'chat.skill.answerWithout': 'Répondre sans la compétence',
  'chat.skill.answerWithoutBlockedByReview':
    'Cette réponse fait l’objet d’une vérification des justificatifs. Répondre à nouveau ' +
    'supprimerait la vérification, avec ses décisions et ses notes.',
  'chat.skill.removed': '(compétence supprimée)',
  'chat.skill.offer.lead': 'Une compétence semble adaptée à cette demande.',
  'chat.skill.offer.run': 'Lancer «\u00A0{title}\u00A0» pour cette question',
  'chat.skill.offer.model': 'Suggestion du modèle local',
  'chat.skill.offer.unavailable':
    'Cette compétence est désactivée ou a été supprimée\u00A0: activez-la dans Paramètres → ' +
    'Compétences pour la lancer.',
  'chat.skill.clear': 'Retirer la compétence «\u00A0{title}\u00A0»',
  'chat.skill.keep': 'Conserver pour cette conversation',
  'chat.skill.infoButton': 'À propos de «\u00A0{title}\u00A0»',
  'chat.skill.info.close': 'Masquer cette explication',
  'chat.skill.info.needsLabel': 'Nécessite\u00A0:',
  'chat.skill.info.limitsLabel': 'À savoir\u00A0:',
  'chat.skill.info.perTurn':
    'Cette compétence s’applique à vos questions dans cette conversation jusqu’à ce que vous en ' +
    'choisissiez une autre ou la retiriez\u00A0; «\u00A0Conserver pour cette conversation\u00A0» ' +
    'l’enregistre aussi pour plus tard.',
  'chat.skill.info.learnMore': 'En savoir plus',
  'chat.skill.tool.extractTransactions': 'Extraire les transactions',
  'chat.skill.tool.validateBalances': 'Vérifier les soldes',
  'chat.skill.tool.categorize': 'Catégoriser',
  'chat.skill.tool.summarize': 'Résumer les flux de trésorerie',
  'chat.skill.tool.exportCsv': 'Exporter en CSV',
  'chat.skill.tool.extractInvoice': 'Extraire la facture',
  'chat.skill.tool.validateInvoiceTotals': 'Vérifier les totaux',
  'chat.skill.tool.exportInvoiceCsv': 'Exporter en CSV',
  'chat.skill.tool.exportInvoiceJson': 'Exporter en JSON',
  'chat.skill.tool.exportInvoiceXml': 'Exporter en XML',
  'chat.skill.tool.redactDocument': 'Caviarder les données personnelles',
  'chat.skill.tool.applyDocumentEdits': 'Appliquer les modifications de texte',
  'chat.skill.categorize.breakdownQuestion': 'Répartissez mes dépenses par catégorie.',
  'chat.skill.summarize.question': 'Résumez mes recettes et mes dépenses.',
  'chat.skill.run.running.one': 'En cours\u00A0: «\u00A0{tool}\u00A0» sur {count} document…',
  'chat.skill.run.running.many': 'En cours\u00A0: «\u00A0{tool}\u00A0» sur {count} documents…',
  'chat.skill.run.running.other': 'En cours\u00A0: «\u00A0{tool}\u00A0» sur {count} documents…',
  'chat.skill.run.runningOn': 'En cours\u00A0: «\u00A0{tool}\u00A0» sur {document}…',
  'chat.skill.run.chooseDocument': 'Choisir le document cible',
  'chat.skill.run.thisDocument': 'ce document',
  'chat.skill.run.cancel': 'Annuler',
  'chat.skill.run.done.one': '{count} transaction extraite.',
  'chat.skill.run.done.many': '{count} transactions extraites.',
  'chat.skill.run.done.other': '{count} transactions extraites.',
  'chat.skill.run.done.categorize.one': '{count} transaction catégorisée.',
  'chat.skill.run.done.categorize.many': '{count} transactions catégorisées.',
  'chat.skill.run.done.categorize.other': '{count} transactions catégorisées.',
  'chat.skill.run.done.summarize.one': 'Résumé de {count} transaction.',
  'chat.skill.run.done.summarize.many': 'Résumé de {count} transactions.',
  'chat.skill.run.done.summarize.other': 'Résumé de {count} transactions.',
  'chat.skill.run.done.export.one': '{count} ligne enregistrée.',
  'chat.skill.run.done.export.many': '{count} lignes enregistrées.',
  'chat.skill.run.done.export.other': '{count} lignes enregistrées.',
  'chat.skill.run.done.reconciled': 'Les soldes concordent.',
  'chat.skill.run.done.unreconciled.one':
    '{count} ligne ne concorde pas\u00A0: vérifiez le résultat avant de vous y fier.',
  'chat.skill.run.done.unreconciled.many':
    '{count} lignes ne concordent pas\u00A0: vérifiez le résultat avant de vous y fier.',
  'chat.skill.run.done.unreconciled.other':
    '{count} lignes ne concordent pas\u00A0: vérifiez le résultat avant de vous y fier.',
  'chat.skill.run.done.unchecked':
    'Le relevé n’indique aucun solde courant permettant la vérification.',
  'chat.skill.run.done.extractInvoice.one': '{count} ligne extraite.',
  'chat.skill.run.done.extractInvoice.many': '{count} lignes extraites.',
  'chat.skill.run.done.extractInvoice.other': '{count} lignes extraites.',
  'chat.skill.run.done.invoiceReconciled': 'Les totaux de la facture concordent.',
  'chat.skill.run.done.invoiceUnreconciled.one':
    '{count} total ne concorde pas\u00A0: vérifiez le résultat avant de vous y fier.',
  'chat.skill.run.done.invoiceUnreconciled.many':
    '{count} totaux ne concordent pas\u00A0: vérifiez le résultat avant de vous y fier.',
  'chat.skill.run.done.invoiceUnreconciled.other':
    '{count} totaux ne concordent pas\u00A0: vérifiez le résultat avant de vous y fier.',
  'chat.skill.run.done.invoiceUnchecked':
    'La facture n’indique aucun total permettant la vérification.',
  'chat.skill.run.done.redacted.one':
    'Copie caviardée enregistrée\u00A0: {count} élément masqué. Ce traitement est fait au mieux, ' +
    'sans garantie\u00A0: relisez la copie avant de la partager.',
  'chat.skill.run.done.redacted.many':
    'Copie caviardée enregistrée\u00A0: {count} éléments masqués. Ce traitement est fait au ' +
    'mieux, sans garantie\u00A0: relisez la copie avant de la partager.',
  'chat.skill.run.done.redacted.other':
    'Copie caviardée enregistrée\u00A0: {count} éléments masqués. Ce traitement est fait au ' +
    'mieux, sans garantie\u00A0: relisez la copie avant de la partager.',
  'chat.skill.run.done.redactedClean':
    'Aucune donnée personnelle n’a été détectée\u00A0; une copie a été enregistrée. Ce ' +
    'traitement est fait au mieux, sans garantie\u00A0: relisez la copie avant de la partager.',
  'chat.skill.run.done.redactedFloor.one':
    'Copie caviardée enregistrée\u00A0: {count} élément masqué (détection hors ligne par règles ' +
    'uniquement, aucun modèle en marche). Relisez la copie avant de la partager.',
  'chat.skill.run.done.redactedFloor.many':
    'Copie caviardée enregistrée\u00A0: {count} éléments masqués (détection hors ligne par ' +
    'règles uniquement, aucun modèle en marche). Relisez la copie avant de la partager.',
  'chat.skill.run.done.redactedFloor.other':
    'Copie caviardée enregistrée\u00A0: {count} éléments masqués (détection hors ligne par ' +
    'règles uniquement, aucun modèle en marche). Relisez la copie avant de la partager.',
  'chat.skill.run.done.redactedCleanFloor':
    'Aucune donnée personnelle n’a été détectée (détection hors ligne par règles uniquement, ' +
    'aucun modèle en marche)\u00A0; une copie a été enregistrée. Relisez la copie avant de la ' +
    'partager.',
  'chat.skill.run.done.redactedCapped.one':
    'Copie caviardée enregistrée\u00A0: {count} élément masqué. Ce document est très ' +
    'volumineux\u00A0: la détection automatique s’est arrêtée à sa limite, et des éléments ' +
    'situés plus loin peuvent ne pas être masqués. Relisez toute la copie avant de la partager.',
  'chat.skill.run.done.redactedCapped.many':
    'Copie caviardée enregistrée\u00A0: {count} éléments masqués. Ce document est très ' +
    'volumineux\u00A0: la détection automatique s’est arrêtée à sa limite, et des éléments ' +
    'situés plus loin peuvent ne pas être masqués. Relisez toute la copie avant de la partager.',
  'chat.skill.run.done.redactedCapped.other':
    'Copie caviardée enregistrée\u00A0: {count} éléments masqués. Ce document est très ' +
    'volumineux\u00A0: la détection automatique s’est arrêtée à sa limite, et des éléments ' +
    'situés plus loin peuvent ne pas être masqués. Relisez toute la copie avant de la partager.',
  'chat.skill.run.done.edited.one':
    '{count} modification appliquée\u00A0; une copie modifiée a été enregistrée. Relisez la ' +
    'copie avant de la partager.',
  'chat.skill.run.done.edited.many':
    '{count} modifications appliquées\u00A0; une copie modifiée a été enregistrée. Relisez la ' +
    'copie avant de la partager.',
  'chat.skill.run.done.edited.other':
    '{count} modifications appliquées\u00A0; une copie modifiée a été enregistrée. Relisez la ' +
    'copie avant de la partager.',
  'chat.skill.run.done.editedPartial.one':
    '{count} modification appliquée\u00A0; une partie du texte demandé est introuvable et a été ' +
    'ignorée. Une copie modifiée a été enregistrée\u00A0: relisez la copie avant de la partager.',
  'chat.skill.run.done.editedPartial.many':
    '{count} modifications appliquées\u00A0; une partie du texte demandé est introuvable et a ' +
    'été ignorée. Une copie modifiée a été enregistrée\u00A0: relisez la copie avant de la ' +
    'partager.',
  'chat.skill.run.done.editedPartial.other':
    '{count} modifications appliquées\u00A0; une partie du texte demandé est introuvable et a ' +
    'été ignorée. Une copie modifiée a été enregistrée\u00A0: relisez la copie avant de la ' +
    'partager.',
  'chat.skill.run.done.editedNone':
    'Aucun des textes demandés n’a été trouvé\u00A0: rien n’a été modifié et aucune copie n’a ' +
    'été enregistrée.',
  'chat.skill.run.done.editedCapped.one':
    '{count} modification appliquée. Ce document est très volumineux\u00A0: la recherche des ' +
    'passages à modifier s’est arrêtée à sa limite. Relisez la copie\u00A0: des passages situés ' +
    'plus loin peuvent ne pas avoir été modifiés.',
  'chat.skill.run.done.editedCapped.many':
    '{count} modifications appliquées. Ce document est très volumineux\u00A0: la recherche des ' +
    'passages à modifier s’est arrêtée à sa limite. Relisez la copie\u00A0: des passages situés ' +
    'plus loin peuvent ne pas avoir été modifiés.',
  'chat.skill.run.done.editedCapped.other':
    '{count} modifications appliquées. Ce document est très volumineux\u00A0: la recherche des ' +
    'passages à modifier s’est arrêtée à sa limite. Relisez la copie\u00A0: des passages situés ' +
    'plus loin peuvent ne pas avoir été modifiés.',
  'chat.skill.run.failedGeneric': 'L’opération n’a pas abouti. Rien n’a été modifié.',
  'chat.skill.run.error.unavailable': 'Cet outil n’est pas disponible.',
  'chat.skill.run.error.needsExtraction':
    'Faites d’abord lire le document avec le bouton «\u00A0{button}\u00A0», puis lancez cet ' +
    'outil.',
  'chat.skill.run.error.persistFailed':
    'L’enregistrement n’a pas pu être effectué. Rien n’a été modifié.',
  'chat.skill.run.error.exportWriteFailed':
    'Le fichier n’a pas pu être enregistré. Rien n’a été modifié.',
  'chat.skill.run.error.needsModel':
    'Démarrez d’abord un modèle\u00A0: les modifications ciblées ont besoin d’un modèle en ' +
    'marche pour trouver le texte à modifier.',
  'chat.skill.run.error.needsInstruction':
    'Indiquez d’abord ce qu’il faut modifier (par exemple «\u00A0remplacer X par Y\u00A0»), puis ' +
    'relancez l’opération.',
  'chat.skill.run.error.editFailed':
    'Les modifications n’ont pas pu être menées à bien. Rien n’a été modifié.',
  'chat.skill.run.error.redactionModelStopped':
    'Le modèle d’IA s’est arrêté avant la fin du caviardage. Rien n’a été enregistré. Relancez ' +
    'l’opération\u00A0: si le problème persiste, redémarrez le modèle sur l’écran Modèle d’IA.',
  'chat.skill.run.error.redactionTooLong':
    'Certaines parties de ce document sont trop longues pour la fenêtre de contexte du modèle ' +
    'actuel. Rien n’a été enregistré. Choisissez une taille de contexte plus grande sur l’écran ' +
    'Modèle d’IA et redémarrez le modèle, puis relancez l’opération.',
  'chat.skill.run.cancelled': 'Opération arrêtée. Rien n’a été enregistré.',
  'chat.skill.run.stateUnknown':
    'L’état de cette compétence n’a pas pu être vérifié\u00A0: son résultat est peut-être ' +
    'incomplet.',
  'chat.skill.run.otherChatBusy': 'Une compétence est en cours dans une autre conversation.',
  'chat.skill.run.categorizeOffer': 'Catégoriser les transactions',
  'chat.skill.run.dismiss': 'Masquer',
  'chat.skill.confirm.title': 'Lancer cet outil\u00A0?',
  'chat.skill.confirm.body':
    'Cette opération crée ou exporte un fichier à partir des documents de ce disque.',
  'chat.skill.confirm.target': 'Document\u00A0: {document}',
  'chat.skill.confirm.outputDocx':
    'La copie enregistrée conserve le format Word (.docx) de ce document.',
  'chat.skill.confirm.redactionScope':
    'Le masquage couvre le texte du document (y compris les en-têtes, les pieds de page, les ' +
    'notes de bas de page, les commentaires et les modifications suivies) et efface les ' +
    'métadonnées d’auteur et les cibles des liens. Les images, les pages numérisées et les ' +
    'objets incorporés ne sont pas vérifiés\u00A0: relisez la copie enregistrée avant de la ' +
    'partager.',
  'chat.skill.confirm.outputText':
    'La copie enregistrée sera en texte simple (.txt)\u00A0: la mise en page et la mise en forme ' +
    'du document ne sont pas conservées.',
  'chat.skill.confirm.outputMatrix':
    'Les documents Word (.docx) conservent leur format\u00A0; les PDF et les autres formats sont ' +
    'enregistrés sous forme de copie en texte simple (.txt).',
  'chat.skill.confirm.ok': 'Lancer',
  // ---- Chat: transcript + message actions ----
  'chat.role.user': 'Vous',
  'chat.role.assistant': 'HilbertRaum',
  'chat.thinking': 'Réflexion…',
  'chat.actions.tryAgain': 'Réessayer',
  'chat.actions.sendAgain': 'Renvoyer',
  'chat.actions.copy': 'Copier',
  'chat.actions.save': 'Enregistrer',
  'chat.actions.saveTitle': 'Enregistrer cette conversation dans un fichier (reste en local)',
  'chat.actions.exportCsv': 'Exporter en CSV',
  'chat.actions.exportCsvTitle':
    'Enregistrer le tableau de cette réponse dans un fichier CSV (reste en local)',
  'chat.code.copy': 'Copier',
  'chat.code.copyTitle': 'Copier ce bloc de code dans le presse-papiers',
  'chat.code.save': 'Enregistrer',
  'chat.code.saveTitle': 'Enregistrer ce bloc de code dans un fichier .{ext} (reste en local)',
  // ---- Chat: context compaction (context-compaction plan §5.1–§5.3) ----
  'chat.compaction.inProgress': 'Résumé des anciens messages pour libérer du contexte…',
  'chat.analysis.inProgress': 'Lecture du document entier…',
  'chat.compaction.markerLabel': 'Anciens messages résumés',
  'chat.compaction.viewSummary': 'Afficher le résumé des anciens messages',
  'chat.context.label': 'Mémoire',
  'chat.context.usageTooltip':
    'Mémoire de cette conversation\u00A0: remplie à {pct}\u00A0% (environ {used} sur {window} ' +
    'tokens).',
  'chat.context.willSummarize':
    'Quand elle est pleine, les messages les plus anciens sont résumés automatiquement pour ' +
    'faire de la place.',
  'chat.truncated.label': 'Réponse tronquée',
  'chat.endedEarly.label': 'Réponse arrêtée',
  'chat.endedEarly.hint.model':
    'Le modèle d’IA a été arrêté ou changé avant la fin de cette réponse.',
  'chat.endedEarly.hint.user': 'Vous avez arrêté cette réponse avant qu’elle soit terminée.',
  'chat.endedEarly.hint.lock':
    'L’espace de travail a été verrouillé ou l’application fermée avant la fin de cette réponse.',
  'chat.unanswered.model': 'Sans réponse\u00A0: le modèle d’IA a été arrêté.',
  'chat.unanswered.user': 'Sans réponse\u00A0: vous avez arrêté la génération.',
  'chat.unanswered.lock':
    'Sans réponse\u00A0: l’espace de travail a été verrouillé ou l’application fermée.',
  'chat.truncated.hint.context':
    'Le modèle a manqué de place pour terminer cette réponse. Demandez-lui de continuer, ' +
    'commencez une nouvelle conversation ou augmentez la taille du contexte sur l’écran Modèle ' +
    'd’IA.',
  'chat.truncated.hint.cap':
    'Cette réponse fondée sur vos documents a atteint la longueur maximale que l’application ' +
    'autorise pour une réponse. Demandez au modèle de continuer là où il s’est arrêté.',
  'chat.speed.line':
    '{tps}\u00A0tok/s · premier token après {ttft}\u00A0s · tokens\u00A0: {tokens}',
  'chat.speed.hint':
    'Vitesse de génération de cette réponse\u00A0: vitesse de décodage du moteur d’IA, attente ' +
    'avant le premier mot et nombre de tokens produits. Uniquement pour les réponses de cette ' +
    'session.',
  // ---- Chat: document scope (ScopePopover.tsx) ----
  'chat.scope.none': 'Aucun document · Ajouter des documents',
  'chat.scope.stopAsking': 'Ne plus interroger «\u00A0{title}\u00A0»',
  'chat.scope.askToo': 'Interroger aussi «\u00A0{title}\u00A0»',
  'chat.scope.removedDoc': 'Document supprimé',
  // ---- Chat: sources (SourcesDisclosure.tsx) ----
  'chat.sources.toggle': 'Sources ({count})',
  'chat.sources.marker': 'S{n}',
  'chat.sources.page': 'Page {page}',
  'chat.sources.wholeDoc.one': 'D’après le document\u00A0: {count} section',
  'chat.sources.wholeDoc.many': 'D’après le document\u00A0: {count} sections',
  'chat.sources.wholeDoc.other': 'D’après le document\u00A0: {count} sections',
  'chat.sources.wholeDocCaption': 'Sections couvertes',
  'chat.sources.more.one': 'et {count} section de plus',
  'chat.sources.more.many': 'et {count} sections de plus',
  'chat.sources.more.other': 'et {count} sections de plus',
  // ---- Chat: dictation (DictationButton.tsx) ----
  'chat.dictation.start': 'Dicter un message',
  'chat.dictation.unavailable': 'La dictée vocale n’est pas installée sur ce disque',
  'chat.dictation.unavailableSystem':
    'La dictée vocale n’est pas disponible sur ce système d’exploitation',
  'chat.dictation.needsModel':
    'Pour dicter un message, il faut le modèle de transcription, qui n’est pas installé sur ce ' +
    'disque. Vous pouvez l’ajouter sur l’écran Modèle d’IA.',
  'chat.dictation.needsEngine':
    'Pour dicter un message, il faut le moteur vocal, qui n’est pas installé sur ce disque. Vous ' +
    'pouvez l’installer sur l’écran Modèle d’IA.',
  'chat.dictation.needsModelAndEngine':
    'Pour dicter un message, il faut le modèle de transcription et le moteur vocal, qui ne sont ' +
    'pas encore sur ce disque. Vous pouvez ajouter les deux sur l’écran Modèle d’IA.',
  'chat.dictation.engineUnsupported':
    'La dictée vocale n’est pas encore disponible sur ce système d’exploitation\u00A0: ' +
    'l’application ne peut pas y installer le moteur vocal nécessaire.',
  'chat.dictation.getModel': 'Obtenir le modèle de transcription',
  'chat.dictation.getEngine': 'Obtenir le moteur vocal',
  'chat.dictation.setUp': 'Configurer la dictée vocale',
  'chat.dictation.stop': 'Arrêter la dictée et insérer le texte',
  'chat.dictation.transcribing': 'Conversion de votre voix en texte',
  'chat.dictation.noSpeech': 'Aucune parole n’a été reconnue\u00A0: essayez de parler à nouveau.',
  'chat.dictation.silent':
    'Aucun son n’est parvenu au microphone. Vérifiez qu’il n’est pas coupé et que HilbertRaum ' +
    'est autorisé à l’utiliser dans les paramètres du système, puis réessayez.',
  'chat.dictation.noSignal':
    'Aucun son ne parvient au microphone\u00A0: vérifiez qu’il n’est pas coupé et que la bonne ' +
    'entrée audio est sélectionnée.',
  'chat.dictation.micBlocked':
    'Le microphone n’a pas pu être utilisé. Vérifiez les paramètres du microphone dans votre ' +
    'système, puis réessayez.',
  // ---- Documents (DocumentsScreen.tsx) ----
  'docs.title': 'Documents',
  'docs.lead':
    'Importez des documents pour poser des questions à leur sujet. Chaque fichier est copié dans ' +
    'votre espace de travail et préparé pour la recherche\u00A0: tout reste sur ce disque. Posez ' +
    'vos questions depuis le mode «\u00A0Interroger mes documents\u00A0» de l’écran Chat.',
  'docs.status.queued': 'En attente',
  'docs.status.extracting': 'Lecture',
  'docs.status.preparing': 'Préparation',
  'docs.status.indexed': 'Prêt',
  'docs.status.failed': 'Échec',
  'docs.status.deleted': 'Supprimé',
  'docs.status.transcribing': 'Transcription…',
  'docs.task.summaryBusy': 'Rédaction du résumé…',
  'docs.task.translationBusy': 'Traduction en cours…',
  'docs.task.compareBusy': 'Comparaison en cours…',
  'docs.task.ocrBusy': 'Lecture du document numérisé…',
  'docs.task.treeBusy': 'Création d’un index approfondi…',
  'docs.task.extractBusy': 'Recherche des détails…',
  'docs.task.summaryBusyTitle': 'Le résumé est en cours de rédaction',
  'docs.task.translationBusyTitle': 'La traduction est en cours de rédaction',
  'docs.task.compareBusyTitle': 'La comparaison est en cours de rédaction',
  'docs.task.ocrBusyTitle': 'Les pages numérisées sont en cours de lecture',
  'docs.task.treeBusyTitle': 'Un index approfondi est en cours de création pour le document entier',
  'docs.task.extractBusyTitle':
    'Le document entier est en cours d’analyse pour pouvoir répondre aux questions du type ' +
    '«\u00A0Listez tous les…\u00A0»',
  'docs.task.categorizeBusy': 'Catégorisation des transactions…',
  'docs.task.categorizeBusyTitle': 'Les transactions du relevé sont en cours de catégorisation',
  'docs.task.ocrFinishing': 'Finalisation\u00A0: le texte est rendu interrogeable…',
  'docs.task.stopping': 'Arrêt si possible…',
  'docs.error.noSupported': 'Aucun document pris en charge n’a été trouvé dans cette sélection.',
  'docs.removedDocFallback': 'un document supprimé',
  'docs.provenance.compareBefore': 'Comparaison\u00A0: ',
  'docs.provenance.compareMiddle': ' et ',
  'docs.provenance.translatedBefore': 'Source de la traduction\u00A0: ',
  'docs.provenance.summaryBefore': 'Source du résumé\u00A0: ',
  'docs.provenance.generatedBefore': 'Document source\u00A0: ',
  'docs.provenance.articleBefore': 'Enregistré depuis le pack de connaissances\u00A0: ',
  'docs.provenance.articleUnknownArchive': 'nom inconnu',
  'docs.import.busy': 'Importation…',
  'docs.import.files': 'Importer des fichiers',
  'docs.import.folder': 'Importer un dossier',
  'docs.import.walkCut.one':
    'Le dossier était trop volumineux pour être parcouru entièrement\u00A0: {count} élément a ' +
    'été compté.',
  'docs.import.walkCut.many':
    'Le dossier était trop volumineux pour être parcouru entièrement\u00A0: {count} éléments ont ' +
    'été comptés.',
  'docs.import.walkCut.other':
    'Le dossier était trop volumineux pour être parcouru entièrement\u00A0: {count} éléments ont ' +
    'été comptés.',
  'docs.refresh': 'Actualiser',
  'docs.loading': 'Chargement des documents…',
  'docs.askSelected': 'Interroger ces documents ({count})',
  'docs.askSelectedTitle':
    'Ouvrir une session de questions-réponses limitée aux documents sélectionnés',
  'docs.compareBtn': 'Comparer (2)',
  'docs.compareBtnTitle':
    'Rédiger une comparaison des deux documents sélectionnés avec le modèle local\u00A0: rien ne ' +
    'quitte ce disque',
  'docs.reindexAll': 'Tout réindexer ({count})',
  'docs.reindexAllTitle': 'Réindexer chaque document indexé avec un autre modèle de recherche',
  'docs.reindexAllConfirm.title.one': 'Réindexer {count} document\u00A0?',
  'docs.reindexAllConfirm.title.many': 'Réindexer {count} documents\u00A0?',
  'docs.reindexAllConfirm.title.other': 'Réindexer {count} documents\u00A0?',
  'docs.reindexAllConfirm.body':
    'Chaque document à réindexer est relu et ses représentations vectorielles sont recalculées, ' +
    'un document à la fois. Cela peut prendre plusieurs minutes et sollicite fortement le ' +
    'processeur\u00A0: vous pouvez continuer à travailler, mais les réponses risquent d’être ' +
    'plus lentes jusqu’à la fin.',
  'docs.reindexAllConfirm.confirm': 'Tout réindexer',
  'docs.retryAllFailed': 'Tout réessayer ({count})',
  'docs.retryAllFailedTitle': 'Réindexer chaque document dont l’indexation a échoué',
  'docs.retryAllConfirm.title.one': 'Réessayer {count} document en échec\u00A0?',
  'docs.retryAllConfirm.title.many': 'Réessayer {count} documents en échec\u00A0?',
  'docs.retryAllConfirm.title.other': 'Réessayer {count} documents en échec\u00A0?',
  'docs.retryAllConfirm.body':
    'Chaque document en échec est relu et ses représentations vectorielles sont recalculées, un ' +
    'document à la fois. Cela peut prendre plusieurs minutes et sollicite fortement le ' +
    'processeur\u00A0: vous pouvez continuer à travailler, mais les réponses risquent d’être ' +
    'plus lentes jusqu’à la fin. Les documents qui échouent de nouveau restent dans cette liste.',
  'docs.retryAllConfirm.confirm': 'Tout réessayer',
  'docs.reindexAllProgress': 'Réindexation\u00A0: {done} sur {total}…',
  'docs.reindexAllCancel': 'Annuler',
  'docs.reindexAllCancelled': 'Réindexation arrêtée. Documents traités\u00A0: {done} sur {total}.',
  'docs.reindexAllDone.one': '{count} document réindexé.',
  'docs.reindexAllDone.many': '{count} documents réindexés.',
  'docs.reindexAllDone.other': '{count} documents réindexés.',
  'docs.reindexAllPartial':
    'Documents réindexés\u00A0: {done} sur {total}. Échecs\u00A0: {failed}. Les documents en ' +
    'échec restent listés sur l’écran Documents.',
  'docs.supported.base':
    'Formats pris en charge\u00A0: TXT, Markdown, PDF, DOCX, CSV, ainsi que les enregistrements ' +
    'audio (WAV, MP3, FLAC, OGG), transcrits sur ce disque',
  'docs.supported.ocrExtra': ', et les photos de pages (PNG, JPG), lues sur ce disque',
  'docs.preparing': 'Préparation de vos documents pour que vous puissiez les interroger…',
  'docs.empty.title': 'Aucun document pour l’instant',
  'docs.empty.line':
    'Importez des fichiers pour poser des questions à leur sujet\u00A0: tout reste sur ce disque.',
  'docs.selectAria': 'Sélectionner «\u00A0{title}\u00A0» pour l’interroger',
  'docs.selectTitle': 'Sélectionner pour n’interroger que les documents choisis',
  'docs.selectAllAria': 'Sélectionner tous les documents',
  'docs.selectAllTitle': 'Sélectionner tous les documents visibles ou annuler la sélection',
  'docs.meta.sectionsCount.one': '{count} section',
  'docs.meta.sectionsCount.many': '{count} sections',
  'docs.meta.sectionsCount.other': '{count} sections',
  'docs.meta.summary': 'Résumé',
  'docs.meta.type.text': 'Texte',
  'docs.meta.type.audio': 'Audio',
  'docs.meta.type.image': 'Image',
  'docs.scan.ocrOffer':
    'Utilisez «\u00A0Rendre interrogeable (OCR)\u00A0» sur cette ligne pour lire les pages sur ' +
    'ce disque.',
  'docs.scan.ocrMissing':
    'Pour rendre ce document interrogeable, il faut les fichiers OCR, qui ne sont pas sur ce ' +
    'disque. Téléchargez-les ci-dessous ou, sur un disque que vous avez préparé vous-même, ' +
    'ajoutez-les avec la commande «\u00A0fetch-runtime --family ocr\u00A0».',
  'docs.scan.ocrMissingOffline':
    'Pour rendre ce document interrogeable, il faut les fichiers OCR, qui ne sont pas sur ce ' +
    'disque. Pour les ajouter, relancez la préparation du disque avec ' +
    '«\u00A0--with-assets\u00A0», ou récupérez uniquement les fichiers OCR avec ' +
    '«\u00A0fetch-runtime --family ocr\u00A0».',
  'docs.photo.ocrMissing':
    'Téléchargez les fichiers OCR ci-dessous, puis utilisez «\u00A0Réessayer\u00A0» pour lire ' +
    'cette photo.',
  'docs.photo.ocrMissingOffline':
    'Ajoutez les fichiers OCR avec les scripts de préparation du disque («\u00A0fetch-runtime ' +
    '--family ocr\u00A0»), puis utilisez «\u00A0Réessayer\u00A0» pour lire cette photo.',
  'docs.photo.ocrReady':
    'La reconnaissance de texte est maintenant prête\u00A0: utilisez «\u00A0Réessayer\u00A0» ' +
    'pour lire cette photo.',
  'docs.scan.ocrUnavailable':
    'Pour rendre ce document interrogeable, il faut la reconnaissance de texte (OCR), qui n’a ' +
    'pas pu démarrer dans cette version.',
  'docs.ocr.unavailableBanner':
    'La reconnaissance de texte (OCR) n’est pas disponible dans cette version\u00A0: les ' +
    'fichiers OCR sont sur ce disque, mais le module de reconnaissance n’a pas pu démarrer. Les ' +
    'photos sont enregistrées sans texte lisible et les PDF numérisés ne peuvent pas être rendus ' +
    'interrogeables tant que ce problème n’est pas résolu.',
  'docs.stale.banner':
    'Ce document a été préparé avec un autre modèle de recherche\u00A0: réindexez-le pour que ' +
    'les réponses puissent le trouver.',
  'docs.preview': 'Aperçu',
  'docs.previewBusy': 'Ouverture…',
  'docs.previewTitle': 'Lire le texte extrait (lecture seule\u00A0; rien ne quitte l’application)',
  'docs.cancel': 'Annuler',
  'docs.cancelOcrTitle': 'Arrêter la lecture du document numérisé',
  'docs.cancelTaskTitle': 'Arrêter la tâche',
  'docs.task.stateUnknown':
    'L’état de cette tâche n’a pas pu être vérifié\u00A0: elle est peut-être encore en cours.',
  'docs.task.dismiss': 'Masquer',
  'docs.makeSearchable': 'Rendre interrogeable (OCR)',
  'docs.makeSearchableTitle':
    'Lire les pages numérisées avec la reconnaissance de texte locale\u00A0: rien ne quitte ce ' +
    'disque',
  'docs.makeSearchableAgain': 'Relire (OCR)',
  'docs.makeSearchableAgainPhotoTitle': 'Relire la photo avec la reconnaissance de texte locale',
  'docs.makeSearchableAgainTitle':
    'Relancer la reconnaissance de texte locale et remplacer la lecture enregistrée\u00A0: ' +
    '«\u00A0Réindexer\u00A0» la réutilise',
  'docs.summarize': 'Résumer',
  'docs.summarizeAgain': 'Résumer à nouveau',
  'docs.translate': 'Traduire',
  'docs.translateNoModel': 'Obtenir le modèle de traduction…',
  'docs.translateNoModelTitle':
    'La traduction nécessite le modèle de traduction\u00A0: téléchargez-le sur l’écran Modèle ' +
    'd’IA',
  'docs.export': 'Exporter',
  'docs.exportOriginal': 'Exporter le fichier original',
  'docs.exportOriginal.gone':
    'La copie enregistrée de ce fichier n’est pas sur ce disque\u00A0: elle ne peut donc pas ' +
    'être exportée. Vous pouvez toujours exporter son texte extrait.',
  'docs.exportOriginalConfirm.title': 'Exporter le fichier original\u00A0?',
  'docs.exportOriginal.warning':
    'Ce fichier exporté est enregistré en dehors de l’espace de travail chiffré de HilbertRaum ' +
    'et n’est pas protégé par le mot de passe de votre espace de travail.',
  'docs.reindex': 'Réindexer',
  'docs.reindexBusy': 'Réindexation…',
  'docs.reindexTitle': 'Relire et préparer à nouveau la copie enregistrée',
  'docs.reindexDone': 'Document «\u00A0{title}\u00A0» réindexé.',
  'docs.delete': 'Supprimer',
  'docs.deleteBusy': 'Suppression…',
  'docs.deleteDone': 'Document «\u00A0{title}\u00A0» supprimé.',
  'docs.failed.remove': 'Retirer',
  'docs.failed.removeTitle': 'Retirer cette importation en échec de la liste',
  'docs.failed.retry': 'Réessayer',
  'docs.backToChat': 'Retour au Chat',
  'docs.failed.retryTitle': 'Relire et préparer à nouveau ce fichier',
  'docs.moreActions': 'Autres actions pour «\u00A0{title}\u00A0»',
  'docs.audioConfirm.title': 'Importer de gros fichiers audio\u00A0?',
  'docs.audioConfirm.confirm': 'Importer et transcrire',
  'docs.audioConfirm.contains.one':
    'Cette sélection contient {count} enregistrement audio ({size}).',
  'docs.audioConfirm.contains.many':
    'Cette sélection contient {count} enregistrements audio ({size}).',
  'docs.audioConfirm.contains.other':
    'Cette sélection contient {count} enregistrements audio ({size}).',
  'docs.audioConfirm.body':
    'Chaque enregistrement est copié dans votre espace de travail et transcrit sur ce ' +
    'disque\u00A0: un long enregistrement peut prendre un certain temps. Vous pouvez continuer à ' +
    'utiliser l’application pendant ce temps.',
  'docs.deleteConfirm.title': 'Supprimer «\u00A0{title}\u00A0»\u00A0?',
  'docs.deleteConfirm.body':
    'Le document, son texte extrait et son index de recherche sont définitivement supprimés de ' +
    'votre espace de travail. Le fichier original situé en dehors de l’espace de travail reste ' +
    'intact.',
  'docs.translateModal.title': 'Traduire «\u00A0{title}\u00A0»',
  'docs.translateModal.aria': 'Traduire «\u00A0{title}\u00A0»',
  'docs.translateModal.hint':
    'Le modèle local rédige une copie traduite sous forme de nouveau document, accessible à la ' +
    'recherche et aux questions comme tout document importé, et rien ne quitte ce disque. Les ' +
    'traductions automatiques peuvent contenir des erreurs.',
  'docs.translateModal.from': 'De',
  'docs.translateModal.to': 'Vers',
  'docs.translateModal.start': 'Traduire',
  'docs.translateModal.sameLang': 'Choisissez deux langues différentes.',
  'docs.previewModal.aria': 'Aperçu de «\u00A0{title}\u00A0»',
  'docs.previewModal.hint':
    'Texte extrait, en lecture seule\u00A0: c’est sur lui que reposent la recherche dans les ' +
    'documents et les réponses.',
  'docs.previewModal.ocrInfo.one':
    'Texte reconnu sur ce disque (OCR)\u00A0: {count} page. La reconnaissance peut contenir des ' +
    'erreurs.',
  'docs.previewModal.ocrInfo.many':
    'Texte reconnu sur ce disque (OCR)\u00A0: {count} pages. La reconnaissance peut contenir des ' +
    'erreurs.',
  'docs.previewModal.ocrInfo.other':
    'Texte reconnu sur ce disque (OCR)\u00A0: {count} pages. La reconnaissance peut contenir des ' +
    'erreurs.',
  'docs.previewModal.ocrInfoPhoto':
    'Texte reconnu sur ce disque (OCR) à partir de cette photo. La reconnaissance peut contenir ' +
    'des erreurs.',
  'docs.previewModal.ocrInfoPartial':
    'Texte reconnu sur ce disque (OCR) pour une partie des pages\u00A0: {count} sur {total}. La ' +
    'reconnaissance peut contenir des erreurs.',
  'docs.previewModal.ocrInfoNone.one':
    'La reconnaissance de texte (OCR) a lu {count} page numérisée sur ce disque sans y trouver ' +
    'de texte.',
  'docs.previewModal.ocrInfoNone.many':
    'La reconnaissance de texte (OCR) a lu {count} pages numérisées sur ce disque sans y trouver ' +
    'de texte.',
  'docs.previewModal.ocrInfoNone.other':
    'La reconnaissance de texte (OCR) a lu {count} pages numérisées sur ce disque sans y trouver ' +
    'de texte.',
  'docs.ocr.unsure.page': 'La reconnaissance de texte a eu un doute sur cette page.',
  'docs.ocr.unsure.onlyRecognized':
    'La reconnaissance de texte a eu un doute sur la seule page qu’elle a reconnue.',
  'docs.ocr.unsure.photo': 'La reconnaissance de texte a eu un doute sur cette photo.',
  'docs.ocr.unsure.some':
    'La reconnaissance de texte a eu des doutes sur une partie des pages reconnues\u00A0: ' +
    '{count} sur {total}.',
  'docs.ocr.unsure.all':
    'La reconnaissance de texte a eu des doutes sur toutes les pages reconnues ({count}).',
  'docs.ocr.scannedPages': 'Pages numérisées encore sans texte lisible\u00A0: {count} sur {total}.',
  'docs.ocr.scannedPagesNeedsOcr': 'Pour les lire, il faut les fichiers OCR (écran Modèle d’IA).',
  'docs.ocr.unsure.causes':
    'Un document flou, de travers ou manuscrit est mal reconnu, de même qu’un texte dans une ' +
    'autre langue que l’allemand ou l’anglais.',
  'docs.previewModal.summary': 'Résumé',
  'docs.previewModal.generatedBy': 'Généré par le modèle {model}',
  'docs.previewModal.truncated':
    'Ce document est long\u00A0: le résumé en couvre le début. La suite du document reste ' +
    'accessible à la recherche et aux questions dans le Chat.',
  'docs.previewModal.regenerate': 'Régénérer',
  'docs.previewModal.copy': 'Copier',
  'docs.previewModal.save': 'Enregistrer',
  'docs.previewModal.copied': 'Résumé copié',
  'docs.previewModal.copyFailed': 'Le résumé n’a pas pu être copié dans le presse-papiers',
  'docs.previewModal.savedTo': 'Résumé enregistré\u00A0: {path}',
  'docs.previewModal.noText': 'Aucun texte n’a pu être extrait de ce document.',
  'docs.previewModal.documentText': 'Texte du document',
  'docs.previewModal.page': 'Page {page}',
  'docs.previewModal.showMore': 'Afficher plus',
  'docs.previewModal.loadingMore': 'Chargement…',
  'docs.previewModal.segmentProgress': 'Affichage\u00A0: {shown} sur {total}',
  // ---- Deep index + coverage (whole-document-analysis plan §5.2) ----
  'docs.deepIndex.build': 'Créer l’index approfondi',
  'docs.deepIndex.reindexFirst': 'Réindexer pour l’index approfondi',
  'docs.deepIndex.ready': 'Index approfondi',
  'docs.deepIndex.readyTitle':
    'Un index approfondi du document entier est prêt\u00A0: les résumés et les réponses sous ' +
    'forme de liste peuvent tout couvrir',
  'coverage.relevance': 'D’après les passages les plus pertinents, pas le document entier',
  'coverage.relevance.counted': 'Sections utilisées\u00A0: {covered} sur {total}',
  'coverage.capped.whole': 'Couvre le document entier',
  'coverage.capped.beginning': 'Couvre le début du document',
  'coverage.tree.whole': 'Couvre le document entier (index approfondi)',
  'coverage.tree.beginning':
    'Couvre le début du document\u00A0: il était trop volumineux pour être lu en entier',
  'coverage.tree.partial': 'Index approfondi en cours – sections\u00A0: {covered} sur {total}',
  'coverage.tree.pending': 'Pas encore d’index approfondi',
  'coverage.depth': 'Détail\u00A0: {label}',
  'coverage.tier.1': 'Synthèse',
  'coverage.tier.2': 'Section par section',
  'coverage.tier.3': 'Détaillé (couverture complète)',
  'coverage.tier.hint.1': 'Le plus rapide\u00A0: la synthèse enregistrée',
  'coverage.tier.hint.2': 'Une lecture plus riche de toutes les sections',
  'coverage.tier.hint.3': 'Le plus de détails, sur le document entier',
  'coverage.tierSelect.trigger': 'Détail\u00A0: {label}',
  'coverage.extract.whole': 'Lecture du document entier – sections analysées\u00A0: {scanned}',
  'coverage.extract.wholeUnparsed':
    'Lecture du document entier – sections analysées\u00A0: {scanned}, échecs de lecture\u00A0: ' +
    '{unparsed}',
  'coverage.extract.sections': 'Sections analysées\u00A0: {scanned}',
  'coverage.extract.sectionsUnparsed':
    'Sections analysées\u00A0: {scanned}, échecs de lecture\u00A0: {unparsed}',
  // ---- "List every X" answer (whole-document-analysis plan §4.2, Phase 3) ----
  'analysis.kind.generic': 'éléments',
  'analysis.kind.date': 'dates',
  'analysis.kind.amount': 'montants',
  'analysis.kind.party': 'parties',
  'analysis.kind.obligation': 'obligations',
  'analysis.listing.coverageWhole':
    'Résultats ({kind})\u00A0: {count} dans tout le document. Sections analysées\u00A0: ' +
    '{scanned}{unparsed}\u00A0:',
  'analysis.listing.coverageSections':
    'Résultats ({kind})\u00A0: {count}. Sections analysées\u00A0: {scanned}{unparsed}\u00A0:',
  'analysis.listing.empty':
    'Aucun résultat ({kind}). Sections analysées\u00A0: {scanned}{unparsed}.',
  'analysis.listing.unparsedSuffix': ' (échecs de lecture\u00A0: {k})',
  'analysis.listing.item': '- {value} (×{count})',
  'analysis.listing.caveat':
    'Cette liste couvre de façon exhaustive les sections analysées, sans garantie d’être ' +
    'complète (un petit modèle peut manquer un élément, et des entrées très semblables peuvent ' +
    'être fusionnées).',
  'analysis.listing.refPage': 'p.\u00A0{n}',
  'analysis.listing.refSection': 'section {n}',
  'analysis.listing.unparsedHint':
    '**À noter\u00A0:** la plupart des sections n’ont pas pu être lues lors de l’indexation de ' +
    'ce document\u00A0: ce résultat n’est donc pas fiable. Ouvrez l’écran Documents et lancez de ' +
    'nouveau «\u00A0Créer l’index approfondi\u00A0»\u00A0: les sections qui n’ont pas pu être ' +
    'lues font alors l’objet d’une nouvelle tentative (un modèle plus grand améliore le ' +
    'résultat).',
  'analysis.listing.unparsedHintAmountSkill':
    'Pour un relevé bancaire, la compétence «\u00A0Analyse de relevé bancaire\u00A0» du menu des ' +
    'compétences du Chat lit les montants avec exactitude.',
  'analysis.listing.aggregationHint':
    '**À noter\u00A0:** vous avez demandé des catégories ou des sommes, mais cette réponse peut ' +
    'seulement lister les valeurs trouvées dans le document, avec le nombre d’occurrences de ' +
    'chacune\u00A0: elle ne peut ni les regrouper ni les additionner.',
  'analysis.listing.aggregationHintAmountSkill':
    'Pour un relevé bancaire, activez la compétence «\u00A0Analyse de relevé bancaire\u00A0» ' +
    'dans le menu des compétences du Chat et posez de nouveau la question\u00A0: cette ' +
    'compétence répartit les transactions par catégorie et additionne exactement chaque ' +
    'catégorie.',
  'analysis.wholeDocHint':
    '**À noter\u00A0:** cette réponse repose uniquement sur les sections les plus pertinentes et ' +
    'peut donc omettre des éléments. Pour une liste qui couvre toutes les sections, ouvrez ' +
    'l’écran Documents, choisissez «\u00A0Créer l’index approfondi\u00A0» pour le document, puis ' +
    'posez de nouveau la question.',
  'analysis.partialAnswerHint':
    '**À noter\u00A0:** cette réponse repose uniquement sur les sections les plus pertinentes et ' +
    'peut donc omettre des éléments.',
  'analysis.wholeReadSumHint':
    '**À noter\u00A0:** le modèle calcule lui-même les totaux et peut oublier ou mal compter des ' +
    'éléments. Vérifiez chaque total à l’aide des sources.',
  // ---- Bank-statement analysis answer (full-doc-skills plan §3.1, Phase 2) ----
  'skills.bankAnalysis.count': 'J’ai lu le relevé en entier. Transactions\u00A0: **{count}**.',
  'skills.bankAnalysis.countPartial':
    'Transactions lues\u00A0: **{count}**. Lignes contenant un montant que je n’ai pas pu ' +
    'interpréter comme une transaction\u00A0: **{dropped}**. Cette liste ne contient donc ' +
    'peut-être pas toutes les transactions\u00A0: comparez-la avec le document.',
  'skills.bankAnalysis.countContradicted':
    'Transactions lues\u00A0: **{count}**. Toutefois, les soldes imprimés sur ce relevé ne ' +
    'concordent pas avec ce que j’ai lu\u00A0: je ne peux donc pas confirmer que la liste est ' +
    'complète.',
  'skills.bankAnalysis.empty':
    'J’ai parcouru le document entier, mais je n’ai pu en extraire aucune transaction. Les ' +
    'lignes se trouvent peut-être dans une image numérisée ou dans une mise en page inhabituelle ' +
    'que mon outil de lecture ne sait pas suivre. S’il s’agit d’un document numérisé, lancez ' +
    'd’abord la reconnaissance de texte (OCR)\u00A0; sinon, la mise en page n’est peut-être pas ' +
    'lisible par une machine\u00A0: ouvrez le relevé pour lire directement les montants.',
  'skills.bankAnalysis.couldNotRead':
    'Je n’ai pas pu lire ce relevé\u00A0: je ne peux donc pas l’analyser.',
  'skills.bankAnalysis.unreconciledHeading':
    'Vérifiez d’abord chaque ligne ci-dessous, dont le solde courant imprimé ne concorde pas ' +
    'avec les montants\u00A0:',
  'skills.bankAnalysis.unreconciledItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.totals':
    'Entrées\u00A0: **{inAmount} {currency}** · Sorties\u00A0: **{outAmount} {currency}** · ' +
    'Variation nette\u00A0: **{netAmount} {currency}**.',
  'skills.bankAnalysis.noCurrency':
    'Ces transactions sont libellées dans plusieurs devises\u00A0: il n’existe donc pas de total ' +
    'unique, et un total devrait être calculé séparément pour chaque devise.',
  'skills.bankAnalysis.incompleteNoTotal':
    'Je ne peux pas confirmer avoir lu l’intégralité du relevé\u00A0: ses soldes imprimés ne ' +
    'concordent pas avec ce que j’ai lu, et les montants sont donc peut-être mal lus ou ' +
    'incomplets. Pour ne pas vous donner un total qui pourrait être faux, je n’indique aucune ' +
    'somme ici\u00A0; ouvrez le relevé et vérifiez vous-même les montants.',
  'skills.bankAnalysis.categoryHeading': 'Par catégorie\u00A0:',
  'skills.bankAnalysis.categoryItem': '- {category}\u00A0: {amount} {currency} ({count})',
  'skills.bankAnalysis.categoryAssisted':
    '_Les catégories sont attribuées avec l’aide du modèle\u00A0: un libellé peut être inexact, ' +
    'mais les totaux ci-dessus restent inchangés._',
  'skills.bankAnalysis.categoryRuleBased':
    '_Il s’agit d’un regroupement rapide par règles (sans modèle). Pour une répartition plus ' +
    'fine, assistée par le modèle, utilisez le bouton «\u00A0Catégoriser\u00A0»._',
  'skills.bankCategory.Groceries': 'Courses',
  'skills.bankCategory.Dining': 'Restaurants',
  'skills.bankCategory.Transport': 'Transports',
  'skills.bankCategory.Utilities': 'Charges',
  'skills.bankCategory.Rent': 'Loyer',
  'skills.bankCategory.Insurance': 'Assurances',
  'skills.bankCategory.Subscriptions': 'Abonnements',
  'skills.bankCategory.Health': 'Santé',
  'skills.bankCategory.Shopping': 'Achats',
  'skills.bankCategory.Income': 'Revenus',
  'skills.bankCategory.Transfer': 'Virements',
  'skills.bankCategory.Fees': 'Frais',
  'skills.bankCategory.Cash': 'Espèces',
  'skills.bankCategory.Tax': 'Impôts',
  'skills.bankCategory.Spending': 'Dépenses',
  'skills.bankCategory.Uncategorized': 'Sans catégorie',
  'skills.bankAnalysis.caveat':
    'Ces montants sont ceux que le relevé imprime lui-même, lus dans le document entier\u00A0: ' +
    'rien n’est additionné à partir du texte courant ni inventé.',
  'skills.bankAnalysis.unverifiedCaveat':
    'Ces montants sont la somme des transactions que j’ai lues dans le document entier ' +
    '(transactions\u00A0: **{count}**). Le relevé n’indique ni solde initial ni solde ' +
    'final\u00A0: je ne peux donc pas confirmer qu’il s’agit de toutes les transactions. ' +
    'Considérez ces montants comme la somme des lignes affichées, et non comme un total vérifié ' +
    'du relevé. Rien n’est additionné à partir du texte courant ni inventé.',
  'skills.bankAnalysis.dateOrderCaveat':
    'Une remarque sur les dates\u00A0: ce relevé n’indique pas si le jour précède le mois ou ' +
    'l’inverse. Je les ai donc lues avec le jour en premier (jour.mois.année)\u00A0; une date ' +
    'comme 03.05. peut ainsi correspondre au 3 mai ou au 5 mars. Vérifiez dans le document toute ' +
    'date importante.',
  'skills.bankAnalysis.transactionsHeading': 'Transactions\u00A0:',
  'skills.bankAnalysis.transactionItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.transactionsMore':
    '… et **{count}** de plus. Pour voir toutes les lignes, utilisez le bouton **Exporter en ' +
    'CSV** de la barre d’exécution afin d’enregistrer le relevé complet, ou demandez-le ' +
    'simplement au format CSV ou JSON, directement dans cette conversation.',
  'skills.bankAnalysis.figureEcho':
    'Totaux calculés à partir des transactions extraites\u00A0: {figures}.',
  'skills.bankAnalysis.figureEchoIn': 'entrées {amount} {currency}',
  'skills.bankAnalysis.figureEchoOut': 'sorties {amount} {currency}',
  'skills.bankAnalysis.figureEchoNet': 'variation nette {amount} {currency}',
  'skills.bankAnalysis.formatIntro':
    'Voici le relevé au format {format}, établi uniquement à partir des montants que j’ai lus ' +
    '(rien n’est additionné à partir du texte courant ni inventé)\u00A0:',
  'skills.bankAnalysis.formatIntroCsv':
    'Voici le relevé au format CSV, limité aux lignes de transactions et établi à partir des ' +
    'montants que j’ai lus (rien n’est additionné à partir du texte courant ni inventé). Le ' +
    'résumé des flux de trésorerie et les soldes initial et final ne figurent pas dans le ' +
    'CSV\u00A0: demandez le relevé au format JSON pour les obtenir aussi.',
  'skills.bankAnalysis.customCategoriesNeedModel':
    'Pour répartir les transactions dans vos propres catégories ({categories}), j’ai besoin d’un ' +
    'modèle local en marche\u00A0: les règles rapides intégrées ne connaissent que leurs ' +
    'catégories fixes. Démarrez un modèle, puis posez de nouveau la question.',
  'skills.bankAnalysis.customTaxonomyNotFound':
    'Je n’ai pas trouvé «\u00A0{name}\u00A0» parmi vos documents. Importez d’abord le fichier ' +
    '(Documents → Importer des fichiers), puis posez de nouveau la question.',
  'skills.bankAnalysis.customTaxonomyUnparseable':
    'J’ai lu «\u00A0{name}\u00A0», mais je n’ai pas pu l’utiliser comme liste de catégories. ' +
    'Format attendu\u00A0: une catégorie par ligne, c’est-à-dire un libellé, suivi ' +
    'éventuellement de mots-clés après un point-virgule (par exemple «\u00A0Enfants\u00A0; ' +
    'école, crèche, argent de poche\u00A0»).',
  'skills.bankAnalysis.derivedColumnsNote':
    '_Colonnes remplies par le modèle local à partir de la description de chaque ' +
    'transaction\u00A0: {columns}. Une cellule reste vide lorsque le modèle n’était pas sûr. ' +
    'Tous les montants proviennent de l’analyseur déterministe et restent inchangés._',
  // ---- Invoice analysis answer (full-doc-skills plan §3.1, Phase 4 / D49) ----
  'skills.invoiceAnalysis.count': 'J’ai lu la facture en entier. Lignes\u00A0: **{count}**.',
  'skills.invoiceAnalysis.countPartial':
    'Lignes de facture lues\u00A0: **{count}**. Lignes du document contenant un montant que je ' +
    'n’ai pas pu interpréter comme une ligne de facture\u00A0: **{dropped}**. Cette liste ne ' +
    'contient donc peut-être pas toutes les lignes\u00A0: comparez-la avec le document.',
  'skills.invoiceAnalysis.empty':
    'J’ai parcouru le document entier, mais je n’ai pu en extraire aucune ligne ni aucun total. ' +
    'Les montants se trouvent peut-être dans une image numérisée ou dans une mise en page ' +
    'inhabituelle que mon outil de lecture ne sait pas suivre. S’il s’agit d’un document ' +
    'numérisé, lancez d’abord la reconnaissance de texte (OCR)\u00A0; sinon, la mise en page ' +
    'n’est peut-être pas lisible par une machine\u00A0: ouvrez la facture pour lire directement ' +
    'les montants.',
  'skills.invoiceAnalysis.couldNotRead':
    'Je n’ai pas pu lire cette facture\u00A0: je ne peux donc pas l’analyser.',
  'skills.invoiceAnalysis.unreconciledHeading':
    'Vérifiez d’abord ces totaux, qui ne concordent pas\u00A0:',
  'skills.invoiceAnalysis.checkLineItemsSumToNet':
    'la somme des lignes ne correspond pas au total hors taxes imprimé',
  'skills.invoiceAnalysis.checkNetPlusTaxIsGross':
    'le total hors taxes plus la taxe ne correspond pas au total toutes taxes comprises imprimé',
  'skills.invoiceAnalysis.checkTaxMatchesRate':
    'le montant de la taxe ne correspond pas au taux de taxe indiqué',
  'skills.invoiceAnalysis.unreconciledItem': '- {check}',
  'skills.invoiceAnalysis.totalsHeading': 'Totaux, tels qu’imprimés\u00A0:',
  'skills.invoiceAnalysis.net': '- Total hors taxes\u00A0: **{value}**',
  'skills.invoiceAnalysis.tax': '- Taxe\u00A0: **{value}**',
  'skills.invoiceAnalysis.taxWithRate': '- Taxe ({rate}\u00A0%)\u00A0: **{value}**',
  'skills.invoiceAnalysis.gross': '- Total toutes taxes comprises (montant dû)\u00A0: **{value}**',
  'skills.invoiceAnalysis.positionsHeading': 'Lignes\u00A0:',
  'skills.invoiceAnalysis.positionItem': '- {description} · {amount} {currency}',
  'skills.invoiceAnalysis.positionsMore':
    '… et **{count}** de plus\u00A0: demandez-moi d’exporter la facture au format CSV pour voir ' +
    'toutes les lignes.',
  'skills.invoiceAnalysis.formatIntro':
    'Voici la facture au format {format}, établie uniquement à partir des montants que j’ai lus ' +
    '(rien n’est additionné à partir du texte courant ni inventé)\u00A0:',
  'skills.invoiceAnalysis.formatIntroCsv':
    'Voici la facture au format CSV, limitée aux lignes et établie à partir des montants que ' +
    'j’ai lus (rien n’est additionné à partir du texte courant ni inventé). L’en-tête ' +
    '(fournisseur, numéro de facture, dates) et les totaux ne figurent pas dans le CSV\u00A0: ' +
    'demandez la facture au format JSON ou XML pour les obtenir aussi.',
  'skills.invoiceAnalysis.noTotals':
    'La facture n’indique aucun total hors taxes, montant de taxe ou total toutes taxes ' +
    'comprises que j’aie pu lire.',
  'skills.invoiceAnalysis.caveat':
    'Ces montants sont ceux que la facture imprime elle-même, lus dans le document entier\u00A0: ' +
    'rien n’est additionné à partir du texte courant ni inventé.',
  'skills.invoiceAnalysis.dateOrderCaveat':
    'Une remarque sur les dates\u00A0: cette facture n’indique pas si le jour précède le mois ou ' +
    'l’inverse. Je les ai donc lues avec le jour en premier (jour.mois.année)\u00A0; une date ' +
    'comme 03.05. peut ainsi correspondre au 3 mai ou au 5 mars. Vérifiez dans le document toute ' +
    'date importante.',
  'skills.invoiceAnalysis.detailsHeading': 'Informations, telles qu’imprimées\u00A0:',
  'skills.invoiceAnalysis.detailVendor': '- Fournisseur\u00A0: {vendor}',
  'skills.invoiceAnalysis.detailRecipient': '- Destinataire de la facture\u00A0: {recipient}',
  'skills.invoiceAnalysis.detailInvoiceNumber': '- Numéro de facture\u00A0: {number}',
  'skills.invoiceAnalysis.detailInvoiceDate': '- Date de facture\u00A0: {date}',
  'skills.invoiceAnalysis.detailDueDate': '- Date d’échéance\u00A0: {date}',
  'skills.invoiceAnalysis.figureEcho':
    'Montants extraits, repris tels quels du document\u00A0: {figures}.',
  'skills.invoiceAnalysis.figureEchoNet': 'total hors taxes {value}',
  'skills.invoiceAnalysis.figureEchoTax': 'taxe {value}',
  'skills.invoiceAnalysis.figureEchoGross': 'total toutes taxes comprises {value}',
  'skills.invoiceAnalysis.totalsHeadingUnverified':
    'Montants tels qu’imprimés, à considérer comme non vérifiés car **ils ne concordent ' +
    'pas**\u00A0:',
  'skills.invoiceAnalysis.unreconciledCaveat':
    'Ces montants imprimés se contredisent, ce qui signifie généralement que le texte du ' +
    'document n’a pas été extrait correctement (document numérisé, PDF constitué d’images ou ' +
    'mise en page inhabituelle). Ne vous fiez à aucun de ces chiffres sans vérifier le document ' +
    'original.',
  'skills.invoiceAnalysis.figureEchoSuppressed':
    'Je ne reprends pas ici les totaux extraits\u00A0: ils ne concordent ni entre eux ni avec ' +
    'les lignes, et les citer comme des montants fiables serait trompeur. Vérifiez le document ' +
    'original.',
  'skills.invoiceAnalysis.unreadableLayout':
    'Le texte de ce document ne s’extrait pas correctement\u00A0: les caractères sortent dans le ' +
    'désordre (glyphe par glyphe), ce qui signifie généralement un PDF constitué d’images ou ' +
    'encodé de façon inhabituelle. Je n’ai pas pu en lire de lignes ni de totaux fiables\u00A0: ' +
    'je ne cite donc aucun montant. S’il s’agit d’un document numérisé, lancez d’abord la ' +
    'reconnaissance de texte (OCR)\u00A0; sinon, ouvrez la facture et lisez directement les ' +
    'montants.',
  'skills.invoiceAnalysis.textQualityCaveat':
    'Une mise en garde\u00A0: une partie du texte de ce document a été extraite dans le désordre ' +
    '(glyphe par glyphe). Les montants ci-dessus concordent bien, mais vérifiez tout élément ' +
    'important dans le document original.',
  'skills.analysis.refusePartial':
    'Je ne peux répondre précisément à cette question qu’à partir du document entier, et ' +
    'celui-ci n’est pas encore entièrement indexé. Ouvrez l’écran Documents et choisissez ' +
    '«\u00A0Réindexer\u00A0», puis posez de nouveau la question.',
  'skills.analysis.scopeNarrowed':
    'J’ai répondu uniquement à partir du document **{title}**. Autres documents des sources de ' +
    'cette conversation, non lus\u00A0: {count}. Pour en analyser un autre, sélectionnez ' +
    'uniquement ce document (ou nommez son fichier dans votre question), puis posez de nouveau ' +
    'la question.',
  'skills.analysis.selectOne':
    'Pour une analyse complète, j’ai besoin d’un seul document. Documents actuellement dans les ' +
    'sources de cette conversation\u00A0: {count}\u00A0; je n’en vois donc que quelques ' +
    'passages. Sélectionnez un seul document (ou nommez son fichier dans votre question), puis ' +
    'posez de nouveau la question.',
  'skills.analysis.selectTwo':
    'Pour comparer, sélectionnez exactement **deux** documents (ou deux versions). Documents ' +
    'actuellement dans les sources de cette conversation\u00A0: {count}. Choisissez les deux que ' +
    'vous voulez comparer, puis posez de nouveau la question.',
  'skills.redactionRouting.answer':
    'Pour caviarder ce document, cliquez sur le bouton **{button}** juste au-dessus de la zone ' +
    'de message, puis choisissez où enregistrer la copie. L’opération s’exécute entièrement sur ' +
    'cet appareil et masque les données personnelles au format bien reconnaissable (adresses ' +
    'e-mail, numéros de téléphone, IBAN, dates et liens) en lisant le document entier. Il s’agit ' +
    'd’une première passe faite au mieux, sans garantie\u00A0: elle ne détecte ni les noms ni ' +
    'les formats inhabituels, relisez donc la copie enregistrée avant de la partager.',
  'skills.redactionRouting.answerMulti':
    'Pour caviarder un document, cliquez sur le bouton **{button}** juste au-dessus de la zone ' +
    'de message et sélectionnez le document à caviarder, puis choisissez où enregistrer la ' +
    'copie. L’opération traite un document à la fois, s’exécute entièrement sur cet appareil et ' +
    'masque les données personnelles au format bien reconnaissable (adresses e-mail, numéros de ' +
    'téléphone, IBAN, numéros de carte bancaire, dates et liens) en lisant le document entier. ' +
    'Il s’agit d’une première passe faite au mieux, sans garantie\u00A0: elle ne détecte ni les ' +
    'noms ni les formats inhabituels, relisez donc la copie enregistrée avant de la partager.',
  'skills.editRouting.answer':
    'Pour effectuer ces modifications, cliquez sur le bouton **{button}** juste au-dessus de la zone ' +
    'de message, puis choisissez où enregistrer la copie modifiée. L’opération s’exécute entièrement ' +
    'sur cet appareil et applique uniquement les remplacements exacts (rechercher et remplacer) que ' +
    'vous avez demandés, partout où le texte figure mot pour mot, sans rien changer d’autre. Elle ne ' +
    'réécrit jamais le document\u00A0: elle ne peut donc rien inventer ni reformuler. Un document ' +
    'Word reste au format .docx\u00A0; les autres formats sont enregistrés en texte simple (.txt). ' +
    'Relisez la copie avant de la partager.',
  'skills.editRouting.answerMulti':
    'Pour effectuer ces modifications, cliquez sur le bouton **{button}** juste au-dessus de la zone ' +
    'de message et sélectionnez le document à modifier, puis choisissez où enregistrer la copie ' +
    'modifiée. L’opération traite un document à la fois, s’exécute entièrement sur cet appareil et ' +
    'applique uniquement les remplacements exacts (rechercher et remplacer) que vous avez demandés, ' +
    'partout où le texte figure mot pour mot, sans rien changer d’autre. Elle ne réécrit jamais le ' +
    'document. Un document Word reste au format .docx\u00A0; les autres formats sont enregistrés en ' +
    'texte simple (.txt). Relisez la copie avant de la partager.',
  'skills.redactionRouting.scan':
    'J’ai parcouru le document entier à la recherche de données personnelles au format bien ' +
    'reconnaissable. Éléments détectés – adresses e-mail\u00A0: {email}, numéros de ' +
    'téléphone\u00A0: {phone}, IBAN\u00A0: {iban}, numéros de carte bancaire\u00A0: {card}, ' +
    'dates\u00A0: {date}, liens\u00A0: {url}. Il s’agit d’une recherche de motifs faite au ' +
    'mieux\u00A0: elle ne détecte ni les noms, ni les adresses postales, ni les formats ' +
    'inhabituels. Considérez donc ces chiffres comme un minimum, et non comme un inventaire ' +
    'complet. Pour créer une copie caviardée, cliquez sur le bouton **{button}** juste au-dessus ' +
    'de la zone de message et choisissez où l’enregistrer.',
  // ---- Models (ModelsScreen.tsx) ----
  'models.title': 'Modèle d’IA',
  'models.library.title': 'Bibliothèque de modèles',
  'models.library.view': 'Affichage de la bibliothèque de modèles',
  'models.library.onDrive': 'Sur ce disque',
  'models.library.browse': 'Parcourir les modèles',
  'models.library.search': 'Rechercher des modèles',
  'models.library.searchPlaceholder': 'Nom, famille ou variante…',
  'models.library.task': 'Tâche',
  'models.library.allTasks': 'Toutes les tâches',
  'models.library.family': 'Famille',
  'models.library.allFamilies': 'Toutes les familles',
  'models.library.familyNotInView': '{name} (aucun dans cette vue)',
  'models.library.resetFamily': 'Toutes les familles',
  'models.library.noFamilyForTask': 'Aucun modèle {family} ne correspond à cette tâche.',
  'models.library.noFamilyOnDrive.one':
    'Aucun modèle {family} sur ce disque. «\u00A0Parcourir les modèles\u00A0» affiche {count} ' +
    'modèle.',
  'models.library.noFamilyOnDrive.many':
    'Aucun modèle {family} sur ce disque. «\u00A0Parcourir les modèles\u00A0» affiche {count} ' +
    'modèles.',
  'models.library.noFamilyOnDrive.other':
    'Aucun modèle {family} sur ce disque. «\u00A0Parcourir les modèles\u00A0» affiche {count} ' +
    'modèles.',
  'models.library.chat': 'Chat',
  'models.library.translation': 'Traduction',
  'models.library.images': 'Images',
  'models.library.voice': 'Voix',
  'models.library.memory': 'Mémoire minimale\u00A0: {size}',
  'models.library.clear': 'Effacer les filtres',
  'models.library.showVariants': 'Afficher toutes les variantes ({count})',
  'models.library.hideVariants': 'Afficher moins de variantes ({count})',
  'models.library.results.one': '{count} variante correspondante',
  'models.library.results.many': '{count} variantes correspondantes',
  'models.library.results.other': '{count} variantes correspondantes',
  'models.library.noMatches':
    'Aucun modèle ne correspond à ces filtres. Essayez une autre recherche ou effacez les ' +
    'filtres.',
  'models.library.noneInstalled': 'Aucun modèle n’est encore prêt à l’emploi sur ce disque.',
  'models.library.onlyActive':
    'Votre modèle installé est affiché ci-dessus. Parcourez le catalogue pour trouver d’autres ' +
    'modèles.',
  'models.library.noAlternatives': 'Ce catalogue ne contient aucun autre modèle.',
  'models.library.download': 'Téléchargement de modèle en cours',
  'models.lead':
    'Le modèle d’IA répond à vos questions, entièrement sur cet appareil. Tout est vérifié avant ' +
    'utilisation, et rien n’est téléchargé sans votre confirmation explicite.',
  'models.loadError': 'Les modèles n’ont pas pu être chargés\u00A0: {error}',
  'models.checking':
    'Vérification des fichiers de modèle… La première vérification après l’ajout ou la mise à ' +
    'jour d’un modèle peut prendre quelques minutes pour les fichiers volumineux\u00A0; ensuite, ' +
    'le résultat est mémorisé et la vérification est immédiate.',
  'models.checkingProgress': 'Vérification du modèle {n} sur {m}\u00A0: {name} – {pct}\u00A0%',
  'models.state.installed': 'Installé',
  'models.state.missing': 'Non téléchargé',
  'models.state.checksumFailed': 'Non vérifiable',
  'models.state.unsupported': 'Non pris en charge',
  'models.state.notRecommended': 'Déconseillé',
  'models.state.ready': 'Prêt',
  'models.state.running': 'En marche',
  'models.badge.notResponding': 'Ne répond pas',
  'models.notRespondingHint':
    'Le modèle d’IA a cessé de répondre. Un redémarrage règle généralement le problème.',
  'models.restart': 'Redémarrer',
  'models.hint.embeddings': 'Prépare vos documents pour que vous puissiez les interroger.',
  'models.hint.reranker': 'Améliore le choix des passages de documents utilisés pour les réponses.',
  'models.hint.transcriber':
    'Transforme les enregistrements audio en texte interrogeable et active le bouton de dictée ' +
    'vocale 🎤 dans le Chat.',
  'models.hint.translation':
    'Traduit vos documents et vos textes d’une langue à l’autre, entièrement hors ligne.',
  'models.hint.vision':
    'Répond à vos questions sur une image à la fois. Ce modèle ne lit pas les PDF et ne rend pas ' +
    'les documents numérisés interrogeables.',
  'models.hint.small':
    'Petit et réactif\u00A0: des réponses rapides sur presque tous les ordinateurs.',
  'models.hint.balanced':
    'Équilibré\u00A0: fonctionne bien sur la plupart des ordinateurs portables.',
  'models.hint.large':
    'Grand\u00A0: les meilleures réponses\u00A0; nécessite un ordinateur puissant.',
  'models.usesSpace': 'Occupe {size} sur le disque',
  'models.downloads.blockedByPolicy':
    'Les téléchargements sont désactivés par la politique de ce disque.',
  'models.downloads.enableInSettings':
    'Pour télécharger, activez «\u00A0Autoriser l’accès à Internet pour les téléchargements de ' +
    'modèles et les mises à jour\u00A0» dans les Paramètres.',
  'models.download.verifying': 'Vérification du fichier téléchargé…',
  'models.download.progress': 'Téléchargement… {pct}\u00A0% ({received} sur {total})',
  'models.download.progressNoTotal': 'Téléchargement… déjà {received}',
  'models.download.cancel': 'Annuler le téléchargement',
  'models.download.cancelled':
    'Téléchargement annulé. Si vous le relancez, il reprendra là où il s’était arrêté.',
  'models.download.stoppedNetworkOff':
    'Interrompu, car l’accès à Internet a été désactivé. Une fois l’accès rétabli, relancez le ' +
    'téléchargement\u00A0: il reprendra là où il s’était arrêté.',
  'models.download.unverifiedBefore':
    'Téléchargé, mais le manifeste de ce modèle n’a pas encore de vraie somme de contrôle\u00A0: ' +
    'le fichier reste donc non vérifié. Générez-en une avec ',
  'models.download.unverifiedAfter': '.',
  'models.download.otherRunning':
    'Un autre téléchargement est en cours\u00A0: les modèles se téléchargent un par un',
  'models.download.titled': 'Télécharger {name} ({size})',
  'models.download.resume': 'Reprendre le téléchargement',
  'models.download.start': 'Télécharger',
  'models.download.failed': 'Le téléchargement du modèle {name} a échoué.',
  'models.download.retry': 'Relancer le téléchargement',
  'models.download.dismiss': 'Masquer',
  'models.download.retryUnavailable':
    'Ce modèle n’est plus proposé au téléchargement ici\u00A0: le téléchargement ne peut donc ' +
    'pas être relancé depuis ce résultat. Masquez-le ou cherchez le modèle dans la bibliothèque.',
  'models.download.retryInstalled': 'Déjà sur ce disque.',
  'models.download.withdrawn':
    'Ce modèle n’est plus disponible au téléchargement\u00A0: l’éditeur a retiré ce fichier ' +
    'précis ({reason}). Les copies déjà présentes sur un disque continuent de fonctionner et ' +
    'restent vérifiables.',
  'models.engine.title': 'Installer le moteur d’IA',
  'models.engine.explain':
    'Tant que le moteur d’IA n’est pas installé, les modèles fonctionnent dans un mode démo ' +
    'intégré (réponses visiblement simulées)\u00A0; la dictée vocale nécessite le moteur vocal. ' +
    'Installez les moteurs une seule fois, puis démarrez un modèle pour obtenir de vraies ' +
    'réponses.',
  'models.engine.install': 'Installer le moteur d’IA',
  'models.engine.retry': 'Réessayer',
  'models.engineProblem.title': 'Le moteur d’IA ne peut pas fonctionner sur cet ordinateur',
  'models.engineProblem.voiceTitle': 'Le moteur vocal ne peut pas fonctionner sur cet ordinateur.',
  'models.engineProblem.libraryMissingPackage':
    'Une bibliothèque système nécessaire au moteur est absente\u00A0: {library}. Installez le ' +
    'paquet {debPackage} (Ubuntu, Debian, Linux Mint) ou {rpmPackage} (Fedora) avec votre ' +
    'gestionnaire de logiciels ou un terminal, puis choisissez «\u00A0Vérifier à nouveau\u00A0».',
  'models.engineProblem.libraryMissing':
    'Une bibliothèque système nécessaire au moteur est absente\u00A0: {library}. Installez-la ' +
    'avec votre gestionnaire de logiciels ou un terminal, puis choisissez «\u00A0Vérifier à ' +
    'nouveau\u00A0».',
  'models.engineProblem.systemTooOldLinux':
    'Le moteur nécessite une version plus récente de Linux\u00A0: Ubuntu 22.04, Debian 12, ' +
    'Fedora 36 ou une version ultérieure.',
  'models.engineProblem.systemTooOldMac':
    'Le moteur nécessite une version plus récente de macOS. Mettez macOS à jour, puis choisissez ' +
    '«\u00A0Vérifier à nouveau\u00A0».',
  'models.engineProblem.systemTooOld':
    'Le moteur nécessite une version plus récente du système d’exploitation.',
  'models.engineProblem.vcRuntimeMissing':
    'Windows ne dispose pas du Microsoft Visual C++ Redistributable (x64) dont le moteur a ' +
    'besoin. Installez-le, puis choisissez «\u00A0Vérifier à nouveau\u00A0».',
  'models.engineProblem.filesDamaged':
    'Certains fichiers du moteur sur ce disque sont manquants ou endommagés. Le guide de ' +
    'dépannage explique comment le remettre en place.',
  'models.engineProblem.filesDamagedReinstall':
    'Certains fichiers du moteur sur ce disque sont manquants ou endommagés. Réinstallez-le pour ' +
    'les remplacer.',
  'models.engineProblem.filesDamagedAfterInstall':
    'Le moteur vient d’être installé et ne peut toujours pas démarrer\u00A0: ses fichiers ne ' +
    'sont donc probablement pas en cause. Le guide de dépannage explique quoi vérifier d’autre.',
  'models.engineProblem.filesDamagedAfterInstallWin':
    'Le moteur vient d’être installé et ne peut toujours pas démarrer\u00A0: ses fichiers ne ' +
    'sont donc probablement pas en cause. Un Microsoft Visual C++ Redistributable (x64) obsolète ' +
    'peut aussi provoquer ce problème\u00A0: installez la version actuelle, puis choisissez ' +
    '«\u00A0Vérifier à nouveau\u00A0».',
  'models.engineProblem.reinstall': 'Réinstaller le moteur d’IA',
  'models.engineProblem.voiceReinstall': 'Réinstaller le moteur vocal',
  'models.engineProblem.reinstalled': 'Le moteur d’IA a été réinstallé.',
  'models.engineProblem.voiceReinstalled': 'Le moteur vocal a été réinstallé.',
  'models.engineUpdate.title': 'Une mise à jour du moteur d’IA est disponible',
  'models.engineUpdate.voiceTitle': 'Une mise à jour du moteur vocal est disponible',
  'models.engineUpdate.bothTitle':
    'Des mises à jour du moteur d’IA et du moteur vocal sont disponibles',
  'models.engineUpdate.explain':
    'Ce disque contient une version plus ancienne que celle prévue pour cette application. La ' +
    'mise à jour télécharge d’abord la nouvelle version\u00A0; ensuite, les modèles ' +
    's’interrompent quelques secondes pendant le remplacement des fichiers, puis le modèle ' +
    'sélectionné redémarre.',
  'models.engineUpdate.update': 'Mettre à jour',
  'models.engineUpdate.done': 'Le moteur d’IA a été mis à jour.',
  'models.engineUpdate.voiceDone': 'Le moteur vocal a été mis à jour.',
  'models.engineUpdate.bothDone': 'Le moteur d’IA et le moteur vocal ont été mis à jour.',
  'models.engineProblem.blocked':
    'La sécurité de Windows a bloqué le moteur (Contrôle intelligent des applications ou votre ' +
    'antivirus). Le guide de dépannage explique ce que vous pouvez faire.',
  'models.engineProblem.demoNote':
    'D’ici là, les modèles répondent en mode démo\u00A0: les réponses sont simulées.',
  'models.engineProblem.check': 'Vérifier à nouveau',
  'models.engineProblem.checking': 'Vérification…',
  'models.engineProblem.stillFailing':
    'Le moteur ne peut toujours pas démarrer. Vérifiez que l’installation est terminée, puis ' +
    'réessayez.',
  'models.engineProblem.fixed': 'Le moteur d’IA fonctionne de nouveau.',
  'models.engineProblem.voiceFixed': 'Le moteur vocal fonctionne de nouveau.',
  'models.engine.progress': 'Téléchargement du moteur d’IA… {pct}\u00A0%',
  'models.engine.downloadingNoTotal': 'Téléchargement du moteur d’IA…',
  'models.engine.verifying': 'Vérification du moteur d’IA…',
  'models.engine.extracting': 'Décompression du moteur d’IA…',
  'models.voiceEngine.title': 'Ajouter la dictée vocale (facultatif)',
  'models.voiceEngine.explain':
    'Le Chat et les réponses sur vos documents fonctionnent déjà sur ce disque. Le moteur vocal ' +
    'est facultatif\u00A0: installez-le seulement si vous souhaitez dicter vos messages avec ' +
    'votre microphone.',
  'models.voiceEngine.install': 'Installer le moteur vocal',
  'models.packTools.row': 'Outils des packs de connaissances\u00A0: non installés',
  'models.packTools.install': 'Installer…',
  'models.ocr.row':
    'Reconnaissance de texte pour les documents numérisés et les photos (facultatif)',
  'models.ocr.rowOrientation':
    'Remettre à l’endroit les pages numérisées pivotées nécessite un fichier OCR supplémentaire ' +
    '(facultatif)',
  'ocr.install.action': 'Télécharger les fichiers OCR',
  'ocr.install.actionTitle':
    'Télécharger les fichiers de langue de la reconnaissance de texte (OCR) pour les documents ' +
    'numérisés et les photos',
  'ocr.install.confirm.title': 'Télécharger les fichiers OCR\u00A0?',
  'ocr.install.confirm.explain':
    'La reconnaissance de texte (OCR) lit les PDF numérisés et les pages photographiées sur cet ' +
    'ordinateur. Elle a besoin des fichiers ci-dessous sur ce disque\u00A0: rien d’autre n’est ' +
    'téléchargé, et vos documents ne quittent jamais cet ordinateur.',
  'ocr.install.confirm.languages': 'Fichiers',
  'ocr.install.confirm.hint':
    'Chaque fichier est vérifié par rapport à sa somme de contrôle attendue avant d’être utilisé.',
  'ocr.install.confirm.start': 'Télécharger',
  'ocr.install.lang.deu': 'Allemand',
  'ocr.install.lang.eng': 'Anglais',
  'ocr.install.lang.osd': 'Orientation des pages (remet à l’endroit les pages pivotées)',
  'ocr.install.starting': 'Démarrage du téléchargement…',
  'ocr.install.progress': 'Téléchargement des fichiers OCR… {pct}\u00A0%',
  'ocr.install.verifying': 'Vérification des fichiers OCR…',
  'ocr.install.activating': 'Démarrage de la reconnaissance de texte…',
  'ocr.install.failed': 'Les fichiers OCR n’ont pas pu être installés.',
  'ocr.install.retry': 'Relancer le téléchargement des fichiers OCR',
  'ocr.install.cancel': 'Annuler le téléchargement des fichiers OCR',
  'ocr.install.alreadyPresent':
    'Les fichiers OCR sont déjà sur ce disque. Redémarrez HilbertRaum pour les utiliser.',
  'ocr.install.outcome.activated':
    'La reconnaissance de texte est prête\u00A0: aucun redémarrage n’est nécessaire.',
  'ocr.install.outcome.restartRequired':
    'Les fichiers OCR sont en place. Redémarrez HilbertRaum pour utiliser les nouveaux fichiers ' +
    'de langue.',
  'ocr.install.outcome.unchanged':
    'Les fichiers OCR sont en place. Si la reconnaissance de texte n’est toujours pas proposée, ' +
    'redémarrez HilbertRaum.',
  'models.ram.needs': 'Nécessite au moins {min}\u00A0GB de RAM',
  'models.ram.machine': ' – cet ordinateur dispose d’environ {ram}\u00A0GB',
  'models.ram.advice': '. Choisissez un modèle plus petit\u00A0: la qualité reste excellente.',
  'models.badge.active': 'Actif',
  'models.badge.recommended': 'Recommandé pour cet ordinateur',
  'models.badge.ramNeeded': 'Nécessite ≥{min}\u00A0GB de RAM',
  'models.automatic.installed':
    'Installé\u00A0: utilisé automatiquement. Il n’y a rien à démarrer.',
  'models.automatic.notInstalled':
    'Utilisé automatiquement une fois installé\u00A0: aucune configuration nécessaire.',
  'models.transcriber.engineUnsupported':
    'Sur ce système d’exploitation, l’application ne peut pas encore installer le moteur ' +
    'vocal\u00A0: ce modèle ne permet donc ni la dictée vocale ni l’importation audio ici.',
  'models.vision.installed':
    'Installé\u00A0: utilisé automatiquement sur l’écran Images. Rien à démarrer ici.',
  'models.vision.notInstalled':
    'Utilisé automatiquement sur l’écran Images une fois installé\u00A0: aucune configuration ' +
    'nécessaire.',
  'models.vision.goToImages': 'Ouvrir l’écran Images',
  'models.translation.installed':
    'Installé\u00A0: utilisé automatiquement pour la traduction. Rien à démarrer ici.',
  'models.translation.notInstalled':
    'Utilisé automatiquement pour la traduction une fois installé\u00A0: aucune configuration ' +
    'nécessaire.',
  'models.use': 'Utiliser ce modèle',
  'models.useTitle': 'En faire votre modèle et le démarrer pour pouvoir discuter',
  'models.stopRuntime': 'Arrêter le modèle',
  'models.answeringNote':
    'Une réponse est en cours de rédaction. Arrêter le modèle ou en changer interrompt la ' +
    'réponse\u00A0: le texte déjà écrit est conservé.',
  'models.startMock': 'Essayer en mode démo',
  'models.starting': 'Démarrage…',
  'models.startingTitle':
    'Chargement du modèle\u00A0: cela peut prendre un peu de temps pour les modèles volumineux',
  'models.startMockTitle':
    'Pas encore de fichier de modèle\u00A0: essayez l’application en mode démo, avec des ' +
    'réponses visiblement simulées',
  'models.tech.summary': 'Détails techniques',
  'models.tech.id': 'Identifiant du modèle',
  'models.tech.family': 'Famille',
  'models.tech.format': 'Format',
  'models.tech.runtime': 'Moteur d’exécution',
  'models.tech.license': 'Licence',
  'models.tech.sizeOnDisk': 'Taille sur le disque',
  'models.tech.minRam': 'RAM minimale',
  'models.tech.recRam': 'RAM recommandée',
  'models.tech.context': 'Fenêtre de contexte',
  'models.tech.contextValue.one': '{count} token',
  'models.tech.contextValue.many': '{count} tokens',
  'models.tech.contextValue.other': '{count} tokens',
  'models.tech.file': 'Fichier',
  // ---- Context-size picker (2026-07-04 user report — the truncation hint points here) ----
  'models.context.title': 'Taille du contexte',
  'models.context.label': 'Fenêtre de contexte pour les réponses\u00A0:',
  'models.context.auto': 'Automatique\u00A0: taille recommandée du modèle',
  'models.context.autoResolved.one':
    'Automatique\u00A0: taille recommandée du modèle ({count} token)',
  'models.context.autoResolved.many':
    'Automatique\u00A0: taille recommandée du modèle ({count} tokens)',
  'models.context.autoResolved.other':
    'Automatique\u00A0: taille recommandée du modèle ({count} tokens)',
  'models.context.bigWarning':
    'Les très grandes fenêtres de contexte demandent beaucoup de mémoire supplémentaire pendant ' +
    'que le modèle fonctionne. Sur un ordinateur doté de moins de mémoire, le modèle risque de ' +
    'ne pas démarrer ou de répondre beaucoup plus lentement\u00A0: dans ce cas, choisissez une ' +
    'taille plus petite ou «\u00A0Automatique\u00A0».',
  'models.context.hint':
    'Un contexte plus grand permet à une conversation ou à une réponse sur des documents de ' +
    'prendre en compte plus de texte à la fois, mais il demande plus de mémoire et peut ralentir ' +
    'les réponses. Prend effet au prochain démarrage d’un modèle.',
  'models.context.restartHint':
    'Un modèle est en marche\u00A0: arrêtez-le puis redémarrez-le pour appliquer la nouvelle ' +
    'taille.',
  'models.verifyTitle':
    'Recalculer l’empreinte du fichier sur le disque et la comparer à sa somme SHA-256 (sans ' +
    'passer par le cache)',
  'models.verifying': 'Vérification…',
  'models.verify': 'Vérifier la somme de contrôle',
  'models.verifyAll': 'Vérifier tous les fichiers de modèle',
  'models.verifyingAll': 'Vérification de tous les fichiers de modèle…',
  'models.verifyAllTitle':
    'Vérifier à nouveau chaque fichier de modèle de ce disque à l’aide de sa somme SHA-256',
  'models.verifyAllHint':
    'Chaque modèle est vérifié lorsque vous le démarrez. Cette action vérifie à la place tous ' +
    'les fichiers de modèle de ce disque\u00A0: sur un disque lent, cela peut prendre plusieurs ' +
    'minutes. Vous pouvez l’arrêter à tout moment\u00A0; les fichiers déjà vérifiés le restent.',
  'models.verifyAllStop': 'Arrêter la vérification',
  'models.verifyAllStopping': 'Arrêt…',
  'models.confirm.title': 'Télécharger {name}\u00A0?',
  'models.confirm.start': 'Lancer le téléchargement',
  'models.confirm.size': 'Taille',
  'models.confirm.license': 'Licence',
  'models.confirm.from': 'Source',
  'models.confirm.readLicense': 'lire la licence',
  'models.confirm.hint':
    'Le fichier téléchargé est vérifié avant d’être utilisé. C’est la seule requête réseau de ' +
    'l’application\u00A0: rien sur vous ni sur vos documents n’est envoyé.',
  'models.confirm.licenseAck': 'J’ai lu et j’accepte les conditions de licence de ce modèle',
  'models.empty.title': 'Aucun manifeste de modèle trouvé',
  'models.empty.lineBefore': 'Ajoutez des manifestes YAML dans ',
  'models.empty.lineAfter': ' sur le disque.',
  'models.section.yourModel': 'Votre modèle d’IA',
  'models.section.docSearch': 'Recherche dans les documents',
  // ---- Settings (SettingsScreen.tsx — chrome + the General tab) ----
  'settings.title': 'Paramètres',
  'settings.tabsAria': 'Sections des paramètres',
  'settings.tab.general': 'Général',
  'settings.tab.privacy': 'Confidentialité et données',
  'settings.tab.skills': 'Compétences',
  'settings.tab.diagnostics': 'Diagnostic (avancé)',
  'settings.loading': 'Chargement des paramètres…',
  'settings.saved': 'Enregistré',
  'settings.saveFailed': 'Ce paramètre n’a pas pu être enregistré. Réessayez.',
  'settings.network.title': 'Confidentialité et mode hors ligne',
  'settings.network.allow':
    'Autoriser l’accès à Internet pour les téléchargements de modèles et les mises à jour',
  'settings.network.hint':
    'Option activée par défaut, pour qu’une nouvelle installation puisse télécharger un modèle ' +
    'dès le départ. Quand elle est désactivée, l’application ne se connecte jamais à Internet. ' +
    'Une fois activée, cette option permet de télécharger les modèles, le moteur d’IA, les ' +
    'outils facultatifs des packs de connaissances et les fichiers facultatifs de reconnaissance ' +
    'de texte (OCR)\u00A0: chaque téléchargement demande d’abord une confirmation, et une ' +
    'politique du disque peut désactiver complètement les téléchargements. Vos consignes et vos ' +
    'documents ne quittent jamais cet appareil, quel que soit ce paramètre.',
  'settings.appearance.title': 'Apparence',
  'settings.appearance.aria': 'Thème',
  'settings.appearance.system': 'Système',
  'settings.appearance.light': 'Clair',
  'settings.appearance.dark': 'Sombre',
  'settings.appearance.hint':
    '«\u00A0Système\u00A0» suit le mode clair ou sombre de votre système d’exploitation. L’écran ' +
    'de verrouillage suit toujours le thème du système.',
  'settings.language.title': 'Langue',
  'settings.language.aria': 'Langue',
  'settings.language.system': 'Système',
  'settings.language.hint':
    '«\u00A0Système\u00A0» suit la langue de votre système d’exploitation lorsque HilbertRaum la ' +
    'propose et utilise l’anglais dans les autres cas. Les changements s’appliquent ' +
    'immédiatement.',
  'settings.performance.title': 'Performance',
  'settings.performance.gpu': 'Utiliser l’accélération par carte graphique (GPU)',
  'settings.performance.gpuHint':
    'Utilise votre carte graphique, si elle est disponible, pour accélérer les réponses. Ne ' +
    'désactivez cette option qu’en cas de problèmes de stabilité\u00A0: tout continue de ' +
    'fonctionner dans les deux cas.',
  'settings.performance.rerankWideScope':
    'Reclasser davantage de passages des packs de connaissances',
  'settings.performance.rerankWideScopeHint':
    'Plus lent pour chaque question. Ne s’applique que sur un ordinateur qui dispose d’assez de ' +
    'fils d’exécution du processeur et sur lequel le modèle de reclassement est installé\u00A0; ' +
    'un ordinateur doté d’une carte graphique utilisable reclasse déjà tous les passages.',
  'settings.performance.autoStart':
    'Charger automatiquement le modèle sélectionné au démarrage de l’application',
  'settings.performance.autoStartHint':
    'Option activée par défaut. Le modèle sélectionné sur l’écran Modèle d’IA est chargé en ' +
    'arrière-plan au lancement (après le déverrouillage pour un espace de travail chiffré), pour ' +
    'que l’écran Chat soit prêt sans clic supplémentaire.',
  // ---- Settings: Chat / conversation compaction (context-compaction plan §5.4) ----
  'settings.chat.title': 'Chat',
  'settings.chatCompaction.label': 'Résumer les anciens messages pour libérer du contexte',
  'settings.chatCompaction.help':
    'Option activée par défaut. Quand une longue conversation approche de la limite de contexte ' +
    'du modèle, les anciens messages sont résumés une seule fois en une note compacte, conservée ' +
    'sur ce disque, au lieu d’être écartés sans avertissement. Désactivez cette option pour ne ' +
    'garder que les messages les plus récents qui tiennent dans le contexte.',
  'settings.developer.title': 'Développeur',
  'settings.developer.toggle':
    'Mode développeur (autorise un espace de travail non chiffré et des modèles non vérifiés)',
  'settings.developer.hint':
    'Option désactivée par défaut. Dans une version de développement, le mode développeur est ' +
    'toujours actif. La politique du disque prévaut\u00A0: sur un disque de la version ' +
    'commerciale, les modèles non vérifiés restent refusés, quel que soit ce paramètre.',
  'settings.workspace.title': 'Espace de travail',
  'settings.workspace.mode': 'Mode',
  'settings.workspace.modeEncrypted': 'Chiffré',
  'settings.workspace.modePlaintext': 'Non chiffré (développeur)',
  'settings.workspace.contextTokens': 'Tokens de contexte',
  'settings.workspace.contextAuto':
    'Automatique (valeur par défaut du modèle)\u00A0: modifiable sur l’écran Modèle d’IA',
  'settings.workspace.encryptedHint':
    'Cet espace de travail est chiffré au repos. Utilisez «\u00A0Verrouiller\u00A0» ' +
    'dans la barre latérale pour le chiffrer à nouveau et le verrouiller\u00A0; il se verrouille ' +
    'aussi automatiquement quand vous quittez l’application.',
  'settings.workspace.plaintextHint':
    'Espace de travail non chiffré (développeur)\u00A0: les données sont stockées sans ' +
    'chiffrement. Le mode chiffré est le mode par défaut de la version commerciale.',
  'settings.changePassword.title': 'Modifier le mot de passe',
  'settings.changePassword.hint':
    'Choisissez un nouveau mot de passe pour cet espace de travail. Il servira dès le prochain ' +
    'déverrouillage. Il ne peut être ni récupéré ni réinitialisé\u00A0: choisissez donc un mot ' +
    'de passe dont vous vous souviendrez.',
  'settings.changePassword.current': 'Mot de passe actuel',
  'settings.changePassword.new': 'Nouveau mot de passe',
  'settings.changePassword.confirm': 'Confirmer le nouveau mot de passe',
  'settings.changePassword.busy':
    'Protection de vos documents avec le nouveau mot de passe… Pour une grande bibliothèque, ' +
    'cela peut prendre quelques minutes.',
  'settings.changePassword.failed':
    'Un problème est survenu. Votre mot de passe actuel fonctionne toujours.',
  'settings.changePassword.submit': 'Modifier le mot de passe',
  'settings.changePassword.submitBusy': 'Modification…',
  'settings.changePassword.toast': 'Mot de passe modifié',
  // ---- Skills (settings/SkillsTab.tsx, skills plan §15) ----
  'skills.intro':
    'Les compétences apprennent à l’assistant à effectuer une tâche précise. Elles complètent ' +
    'ses réponses par des indications\u00A0: elles n’accèdent jamais à Internet ni aux autres ' +
    'dossiers de votre ordinateur.',
  'skills.info.meeting-protocol.what':
    'Présente la prochaine réponse sous forme de compte rendu de réunion clair\u00A0: décisions, ' +
    'actions à mener et questions ouvertes.',
  'skills.info.meeting-protocol.needs':
    'La transcription ou les notes, parmi les sources de cette conversation (joignez le fichier ' +
    'ou collez le texte).',
  'skills.info.meeting-protocol.limits':
    'Traite un document à la fois et ne consigne que ce que disent réellement les notes.',
  'skills.info.contract-brief.what':
    'Résume un contrat en langage clair\u00A0: parties, dates, obligations, clauses essentielles ' +
    'et questions à poser.',
  'skills.info.contract-brief.needs': 'Le contrat, parmi les sources de cette conversation.',
  'skills.info.contract-brief.limits':
    'Une aide à la lecture, pour un document à la fois\u00A0: pas un conseil juridique.',
  'skills.info.deadline-obligation-finder.what':
    'Repère les échéances, les délais de préavis, les dates de renouvellement et de paiement, ' +
    'ainsi que les obligations qui s’y rattachent.',
  'skills.info.deadline-obligation-finder.needs':
    'Le document, parmi les sources de cette conversation.',
  'skills.info.deadline-obligation-finder.limits':
    'Lit un document à la fois\u00A0; vérifiez les dates critiques dans le document original ' +
    'avant d’agir en conséquence.',
  'skills.info.what-changed.what':
    'Compare deux versions d’un document et indique les changements qui comptent, et non une ' +
    'comparaison brute ligne par ligne.',
  'skills.info.what-changed.needs':
    'Exactement deux documents (ou versions), parmi les sources de cette conversation.',
  'skills.info.what-changed.limits':
    'Avec plus ou moins de deux documents dans les sources, la compétence ne peut pas comparer ' +
    'et répond normalement.',
  'skills.info.share-safe-review.what':
    'Vérifie un document avant que vous le partagiez\u00A0: informations sensibles visibles et ' +
    'risques concrets liés au partage.',
  'skills.info.share-safe-review.needs': 'Le document, parmi les sources de cette conversation.',
  'skills.info.share-safe-review.limits':
    'À titre indicatif uniquement\u00A0: la compétence n’affirme jamais qu’un document est ' +
    'anonymisé ou peut être publié sans risque.',
  'skills.info.invoice.what':
    'Lit une facture avec une extraction exacte et vérifiable\u00A0: lignes et totaux, cohérence ' +
    'des totaux, export CSV/JSON/XML.',
  'skills.info.invoice.needs':
    'Un document de type facture parmi les sources\u00A0; les actions de la compétence ' +
    'apparaissent sous forme de boutons juste au-dessus de la zone de message.',
  'skills.info.invoice.limits':
    'Une facture à la fois\u00A0; un total que la compétence ne peut pas vérifier est signalé ' +
    'comme non vérifié, jamais passé sous silence.',
  'skills.info.bank-statement.what':
    'Lit un relevé bancaire avec une extraction exacte et vérifiable\u00A0: transactions, ' +
    'catégories, cohérence des soldes, export CSV.',
  'skills.info.bank-statement.needs':
    'Un document de type relevé parmi les sources\u00A0; les actions de la compétence ' +
    'apparaissent sous forme de boutons juste au-dessus de la zone de message.',
  'skills.info.bank-statement.limits':
    'Un relevé à la fois\u00A0; la catégorisation des transactions nécessite un modèle en marche.',
  'skills.info.document-redaction.what':
    'Enregistre une copie caviardée d’un document\u00A0: détection par règles des e-mails, ' +
    'numéros et dates, et repérage des noms et adresses par le modèle.',
  'skills.info.document-redaction.needs':
    'Le document, parmi les sources\u00A0; le bouton «\u00A0Caviarder les données ' +
    'personnelles\u00A0» apparaît juste au-dessus de la zone de message.',
  'skills.info.document-redaction.limits':
    'Traitement fait au mieux, jamais garanti\u00A0: sans modèle en marche, seule la détection ' +
    'par règles s’applique\u00A0; les documents Word restent au format .docx, les autres formats ' +
    'sont enregistrés en .txt.',
  'skills.info.document-edit.what':
    'Applique des modifications exactes de type rechercher et remplacer, puis enregistre une ' +
    'copie modifiée\u00A0: votre document n’est jamais réécrit.',
  'skills.info.document-edit.needs':
    'Un modèle en marche, le document parmi les sources et votre demande (par exemple ' +
    '«\u00A0remplacer X par Y\u00A0»)\u00A0; le bouton «\u00A0Appliquer les modifications de ' +
    'texte\u00A0» apparaît juste au-dessus de la zone de message.',
  'skills.info.document-edit.limits':
    'Un texte introuvable mot pour mot est ignoré et signalé\u00A0; les documents Word restent ' +
    'au format .docx, les autres formats sont enregistrés en .txt.',
  'skills.autoFire.title': 'Appliquer automatiquement une compétence adaptée',
  'skills.autoFire.toggle': 'Appliquer automatiquement une compétence adaptée',
  'skills.autoFire.hint':
    'Lorsque cette option est activée, l’application peut appliquer d’elle-même une compétence ' +
    'de l’application clairement adaptée à une réponse, sans que vous ayez à la choisir. ' +
    'Uniquement les compétences de l’application, jamais celles que vous avez créées ou ' +
    'importées. Vous voyez toujours quelle compétence a été utilisée, et vous pouvez obtenir une ' +
    'réponse sans elle pour cette question. Option désactivée par défaut.',
  'skills.autoFire.on': 'Compétences automatiques activées',
  'skills.autoFire.off': 'Compétences automatiques désactivées',
  'skills.autoFire.saveFailed':
    'Le paramètre des compétences automatiques n’a pas pu être enregistré.',
  'skills.import': 'Importer une compétence…',
  'skills.import.menuAria': 'Importer une compétence',
  'skills.import.fromFile': 'Depuis un fichier (.skill.zip)…',
  'skills.import.fromFolder': 'Depuis un dossier…',
  'skills.loading': 'Chargement des compétences…',
  'skills.loadFailed': 'Les compétences n’ont pas pu être chargées.',
  'skills.reconcile.folderErrors.one':
    '{count} dossier de compétence n’a pas pu être lu et est ignoré. Chaque dossier doit ' +
    'contenir un fichier «\u00A0SKILL.md\u00A0» valide.',
  'skills.reconcile.folderErrors.many':
    '{count} dossiers de compétences n’ont pas pu être lus et sont ignorés. Chaque dossier doit ' +
    'contenir un fichier «\u00A0SKILL.md\u00A0» valide.',
  'skills.reconcile.folderErrors.other':
    '{count} dossiers de compétences n’ont pas pu être lus et sont ignorés. Chaque dossier doit ' +
    'contenir un fichier «\u00A0SKILL.md\u00A0» valide.',
  'skills.empty.title': 'Aucune compétence pour l’instant',
  'skills.empty.line':
    'Les compétences apprennent à l’assistant à effectuer une tâche précise. Ajoutez-en une pour ' +
    'commencer.',
  'skills.trusted.app': 'Intégrée',
  'skills.trusted.user': 'Personnelle',
  'skills.row.enableLabel': 'Activée',
  'skills.row.on': 'Compétence activée',
  'skills.row.off': 'Compétence désactivée',
  'skills.row.onFailed': 'Cette compétence n’a pas pu être activée.',
  'skills.row.offFailed': 'Cette compétence n’a pas pu être désactivée.',
  'skills.dup.chip': 'Nom en double',
  'skills.dup.title':
    'Une autre compétence installée porte ce nom. Une seule peut être active à la fois.',
  'skills.unavailable.chip': 'Fichiers absents',
  'skills.unavailable.title': 'Les fichiers de cette compétence ne sont plus sur le disque.',
  'skills.incompatible.chip': 'Mise à jour requise',
  'skills.incompatible.title':
    'Cette compétence nécessite une version plus récente de l’application\u00A0: mettez ' +
    'l’application à jour pour l’activer.',
  'skills.review.chip': 'À vérifier',
  'skills.warn.title': 'Vérifiez ce que cette compétence peut faire',
  'skills.warn.body':
    'Créée par vous ou importée. Vérifiez ce qu’elle peut faire avant de vous y fier.',
  'skills.warn.ack': 'J’ai compris',
  'skills.menu.aria': 'Actions sur la compétence',
  'skills.menu.export': 'Exporter…',
  'skills.menu.delete': 'Supprimer',
  'skills.export.done': 'Compétence exportée',
  'skills.export.failed': 'Cette compétence n’a pas pu être exportée.',
  'skills.delete.title': 'Supprimer cette compétence\u00A0?',
  'skills.delete.body':
    'La compétence sera supprimée du disque. Les conversations qui l’ont déjà utilisée ' +
    'continuent de fonctionner.',
  'skills.delete.confirm': 'Supprimer',
  'skills.delete.done': 'Compétence supprimée',
  'skills.delete.failed': 'Cette compétence n’a pas pu être supprimée.',
  'skills.detail.aria': 'Détails de la compétence',
  'skills.detail.version': 'Version',
  'skills.detail.author': 'Créée par',
  'skills.detail.language': 'Langue',
  'skills.detail.kind': 'Type',
  'skills.kind.instruction': 'Indications',
  'skills.kind.tool': 'Utilise des outils',
  'skills.tool.note':
    'Pour l’instant, cette compétence ajoute uniquement des indications. Les outils qu’elle ' +
    'décrit arriveront dans une version ultérieure.',
  'skills.tool.note.active':
    'À votre demande, cette compétence peut exécuter des outils locaux approuvés sur un document ' +
    'que vous choisissez. Les outils en lecture seule peuvent aussi s’exécuter automatiquement ' +
    'pour répondre à votre question\u00A0; toute opération qui écrit ou exporte un fichier vous ' +
    'demande toujours votre accord au préalable. Ces outils ne voient que ce document.',
  'skills.perm.heading': 'Ce que cette compétence peut faire',
  'skills.perm.canTitle': 'Cette compétence peut\u00A0:',
  'skills.perm.cannotTitle': 'Cette compétence ne peut pas\u00A0:',
  'skills.perm.can.instructions': 'Ajouter des instructions aux réponses de l’IA',
  'skills.perm.can.documents': 'Lire uniquement les documents que vous choisissez',
  'skills.perm.can.tools': 'Utiliser des outils locaux approuvés, à votre demande',
  'skills.perm.cannot.network': 'Accéder à Internet',
  'skills.perm.cannot.files': 'Lire d’autres dossiers de votre ordinateur',
  'skills.perm.cannot.scripts': 'Exécuter des scripts ou installer des logiciels',
  'skills.tech.summary': 'Détails techniques',
  'skills.tech.id': 'Identifiant de la compétence',
  'skills.tech.installId': 'Identifiant d’installation',
  'skills.tech.source': 'Source',
  'skills.tech.permissions': 'Autorisations',
  'skills.import.title': 'Ajouter cette compétence\u00A0?',
  'skills.import.confirm': 'Ajouter la compétence',
  'skills.import.added': 'Compétence ajoutée',
  'skills.import.failedTitle': 'Cette compétence ne peut pas être ajoutée',
  'skills.import.failed': 'Cette compétence n’a pas pu être ajoutée.',
  'skills.import.collision':
    'Une compétence portant ce nom est déjà installée. Si vous ajoutez celle-ci, elle remplacera ' +
    'la compétence installée.',
  'skills.import.collisionApp':
    'Une compétence de l’application porte déjà ce nom. Votre compétence est ajoutée, mais reste ' +
    'désactivée tant que celle de l’application est activée.',
  'skills.import.upgrade': 'Met à jour la version installée ({from} → {to}).',
  'skills.import.replace': 'Remplace la version installée ({version}).',
  'skills.import.downgrade':
    'Cette version est plus ancienne que la version installée ({installed}).',
  'skills.import.downgradeBlocked':
    'L’installation d’une version plus ancienne nécessite le mode développeur. Activez-le dans ' +
    'Paramètres → Général pour l’autoriser.',
  'skills.import.error.notFound': 'La compétence sélectionnée est introuvable.',
  'skills.import.error.notZipOrFolder':
    'Une compétence doit être un fichier .skill.zip ou un dossier qui contient un fichier ' +
    '«\u00A0SKILL.md\u00A0».',
  'skills.import.error.unreadableZip':
    'Le paquet de la compétence n’a pas pu être lu comme une archive zip valide.',
  'skills.import.error.encryptedZip':
    'Le paquet de la compétence utilise un format zip non pris en charge (chiffré ou ZIP64).',
  'skills.import.error.unsupportedCompression':
    'Le paquet de la compétence utilise une méthode de compression non prise en charge.',
  'skills.import.error.pathTraversal':
    'Le paquet contient un fichier dont le chemin sort du dossier du paquet.',
  'skills.import.error.absolutePath':
    'Le paquet contient un fichier dont le chemin est absolu ou commence par une lettre de ' +
    'disque.',
  'skills.import.error.invalidPath':
    'Le paquet contient un fichier dont le chemin n’est pas valide.',
  'skills.import.error.symlink':
    'Le paquet contient un lien symbolique, ce qui n’est pas autorisé.',
  'skills.import.error.tooDeep':
    'Le paquet comporte plus de niveaux de dossiers imbriqués que le nombre autorisé.',
  'skills.import.error.pathTooLong': 'Le paquet contient un chemin de fichier trop long.',
  'skills.import.error.tooManyFiles': 'Le paquet contient plus de fichiers que le nombre autorisé.',
  'skills.import.error.tooLarge': 'Le paquet dépasse la taille autorisée.',
  'skills.import.error.fileTooLarge': 'Un fichier du paquet dépasse la taille autorisée.',
  'skills.import.error.duplicatePath':
    'Le paquet contient deux fichiers qui correspondent au même chemin.',
  'skills.import.error.badExtension': 'Le paquet contient un type de fichier non autorisé.',
  'skills.import.error.nestedArchive':
    'Le paquet contient une archive incorporée, ce qui n’est pas autorisé.',
  'skills.import.error.noSkillMd': 'Le paquet ne contient pas de fichier «\u00A0SKILL.md\u00A0».',
  'skills.import.error.invalidManifest': 'Le manifeste de la compétence n’est pas valide.',
  'skills.import.error.idMismatch': 'L’identifiant de la compétence n’est pas un nom valide.',
  'skills.import.error.downgradeBlocked':
    'Une version plus récente de cette compétence est déjà installée. Activez le mode ' +
    'développeur pour installer une version plus ancienne.',
  'skills.import.error.appReadOnly':
    'Les compétences fournies avec l’application ne peuvent être ni modifiées ni supprimées.',
  'skills.import.error.locked': 'Déverrouillez l’espace de travail pour gérer les compétences.',
  'skills.import.note.permissionNotString':
    'L’autorisation «\u00A0{field}\u00A0» n’est pas une valeur texte\u00A0; la valeur par défaut ' +
    '«\u00A0{value}\u00A0» est utilisée.',
  'skills.import.note.permissionUnrecognized':
    'L’autorisation «\u00A0{field}\u00A0» a une valeur que cette application ne reconnaît ' +
    'pas\u00A0; la valeur par défaut «\u00A0{value}\u00A0» est utilisée.',
  'skills.import.note.permissionClamped':
    'La compétence demande un accès «\u00A0{field}\u00A0» plus large que ce que cette ' +
    'application autorise\u00A0; il est limité à «\u00A0{value}\u00A0».',
  'skills.import.note.listInvalid':
    'La liste «\u00A0{field}\u00A0» n’est pas une liste de textes et est ignorée.',
  'skills.import.note.listItemsTooLong':
    'Certaines entrées de «\u00A0{field}\u00A0» sont trop longues et sont ignorées.',
  'skills.import.note.listTruncated':
    '«\u00A0{field}\u00A0» contient plus d’entrées que le nombre autorisé\u00A0; seules les ' +
    '{max} premières sont conservées.',
  'skills.import.note.languageInvalid':
    'Le champ «\u00A0language\u00A0» ne contient pas de code de langue valide\u00A0; ' +
    '«\u00A0en\u00A0» est utilisé.',
  'skills.import.note.allowedToolsIgnored':
    'Les outils déclarés sont ignorés pour une compétence de type «\u00A0Indications\u00A0» (les ' +
    'outils arriveront dans une version ultérieure).',
  'skills.import.note.analysisInvalid':
    'Le champ «\u00A0analysis\u00A0» a une valeur inconnue et est ignoré.',
  'skills.import.note.analysisIgnoredForTool':
    'Le champ «\u00A0analysis\u00A0» est ignoré pour une compétence qui utilise des outils ' +
    '(l’application décide elle-même de son comportement sur le document entier).',
  'skills.import.note.triggersInvalid':
    'Le bloc «\u00A0triggers\u00A0» n’est pas valide et est ignoré.',
  'skills.import.note.autoFireInvalid':
    'Le champ «\u00A0triggers.autoFire\u00A0» doit valoir «\u00A0true\u00A0» ou ' +
    '«\u00A0false\u00A0»\u00A0; il est traité comme «\u00A0false\u00A0».',
  'skills.import.note.localizedInvalid':
    'Le bloc «\u00A0localized\u00A0» n’est pas valide et est ignoré.',
  'skills.import.note.localizedLocaleInvalid':
    'Une entrée de «\u00A0localized\u00A0» a une clé de langue non valide et est ignorée.',
  'skills.import.note.localizedEntryInvalid':
    'Une entrée de «\u00A0localized\u00A0» n’est pas valide et est ignorée.',
  'skills.import.note.localizedTitleIgnored':
    'Un titre traduit a été ignoré (il doit tenir sur une seule ligne courte).',
  'skills.import.note.localizedDescriptionIgnored':
    'Une description traduite a été ignorée (elle doit tenir sur une seule ligne courte).',
  'skills.import.note.localizedTooMany':
    'Le bloc «\u00A0localized\u00A0» contient plus de langues que le nombre autorisé\u00A0; ' +
    'seules les {max} premières sont conservées.',
  'skills.import.note.trustIgnored':
    'Un champ «\u00A0trust\u00A0» de la compétence est ignoré\u00A0: l’application attribue ' +
    'elle-même le niveau de confiance.',
  'skills.import.note.manifestJsonConflict':
    'La valeur «\u00A0{field}\u00A0» du fichier «\u00A0manifest.json\u00A0» inclus diffère de ' +
    'celle de «\u00A0SKILL.md\u00A0»\u00A0; c’est «\u00A0SKILL.md\u00A0» qui s’applique.',
  'skills.replace.title': 'Utiliser plutôt cette compétence\u00A0?',
  'skills.replace.body':
    'Une autre compétence portant ce nom est activée. Activer celle-ci désactivera l’autre.',
  'skills.replace.confirm': 'Activer',
  // ---- Settings → Privacy & data tab (PrivacyTab.tsx) ----
  'privacy.offlineOn': '● Mode hors ligne\u00A0: activé',
  'privacy.offlineOff': '○ Accès réseau activé',
  'privacy.statement.offline':
    'Le mode hors ligne est activé. HilbertRaum exécute le modèle d’IA sur cet ordinateur. Vos ' +
    'consignes, vos documents, les représentations vectorielles et l’historique des conversations ' +
    'restent en local.',
  'privacy.statement.online':
    'HilbertRaum exécute le modèle d’IA sur cet ordinateur. Vos consignes, vos documents, les ' +
    'représentations vectorielles et l’historique des conversations restent en local\u00A0: même ' +
    'avec l’accès à Internet activé, seuls les téléchargements (modèles, moteur d’IA, outils ' +
    'facultatifs des packs de connaissances et fichiers facultatifs de reconnaissance de texte ' +
    '(OCR)) utilisent le réseau.',
  'privacy.statement.noUploads':
    'Cette application n’envoie pas vos données à des fournisseurs d’IA dans le cloud. Aucun ' +
    'envoi de consignes, de documents ou de représentations vectorielles, aucune télémétrie, ' +
    'aucune analyse d’usage et aucun rapport de plantage à distance.',
  'privacy.network.title': 'État actuel du réseau',
  'privacy.networkState.noPolicy': 'Le mode hors ligne est activé.',
  'privacy.networkState.disabledByPolicy': 'Accès réseau désactivé par la politique du disque.',
  'privacy.networkState.offDefault':
    'Le mode hors ligne est activé (accès à Internet désactivé dans les Paramètres).',
  'privacy.networkState.enabled':
    'L’accès à Internet est activé pour les téléchargements\u00A0: modèles, moteur d’IA, outils ' +
    'facultatifs des packs de connaissances et fichiers facultatifs de reconnaissance de texte (OCR).',
  'privacy.network.noFiles': 'Aucune consigne ni aucun fichier ne quitte cet appareil.',
  'privacy.network.effective': 'État effectif',
  'privacy.network.effectiveOffline': 'Hors ligne (aucune connexion à Internet)',
  'privacy.network.effectiveAllowed': 'Réseau autorisé',
  'privacy.network.byPolicy': 'Autorisé par la politique du disque',
  'privacy.network.policyYes': 'Oui',
  'privacy.network.policyNo': 'Non (désactivé par la politique du disque)',
  'privacy.network.yourSetting': 'Votre choix',
  'privacy.network.settingAllowed': 'Accès à Internet autorisé',
  'privacy.network.settingOff': 'Désactivé',
  'privacy.network.telemetry': 'Télémétrie',
  'privacy.network.telemetryValue':
    'Rien ne quitte cet appareil\u00A0: il n’y a aucun suivi à désactiver',
  'privacy.network.hint':
    'L’application vous avertit avant toute action sur Internet. Les seuls éléments qu’elle ' +
    'télécharge sont des modèles d’IA, le moteur d’IA, les outils facultatifs des packs de ' +
    'connaissances et les fichiers facultatifs de reconnaissance de texte (OCR)\u00A0: chacun ' +
    'uniquement après votre confirmation, et chacun vérifié avant utilisation. Cette option est ' +
    'activée par défaut et peut être désactivée dans l’onglet «\u00A0Général\u00A0». Une ' +
    'politique du disque peut la désactiver complètement. L’API locale ci-dessous est une ' +
    'fonction distincte, à activer vous-même, qui n’utilise jamais Internet.',
  'privacy.data.title': 'Où se trouvent vos données',
  'privacy.data.driveRoot': 'Racine du disque',
  'privacy.data.workspace': 'Espace de travail',
  'privacy.data.models': 'Modèles',
  'privacy.data.logs': 'Journaux',
  'privacy.data.loading': 'Chargement des chemins…',
  'privacy.data.hint':
    'Tout est stocké en local dans votre espace de travail\u00A0: documents importés, texte ' +
    'extrait, représentations vectorielles, historique des conversations, résultats générés, ' +
    'paramètres. Pour tout effacer, supprimez le dossier de l’espace de travail.',
  'privacy.logs.title': 'Journaux locaux uniquement',
  'privacy.logs.hintBefore':
    'Les journaux de débogage et de diagnostic sont écrits dans un fichier à rotation, dans le ' +
    'dossier des journaux ci-dessus, et ne sont ',
  'privacy.logs.never': 'jamais envoyés en ligne',
  'privacy.logs.hintAfter': '. Le diagnostic ne transmet rien en dehors de cet appareil.',
  'privacy.protection.title': 'Protection de l’espace de travail',
  'privacy.protection.encryptedBefore': 'Votre espace de travail est en mode ',
  'privacy.protection.encryptedWord': 'chiffré',
  'privacy.protection.encryptedAfter': '.',
  'privacy.protection.plainBefore': 'Votre espace de travail est en ',
  'privacy.protection.plainWord': 'mode non chiffré (développeur)',
  'privacy.protection.plainAfter':
    '. Les fichiers sont stockés sans chiffrement sur le disque pour accélérer le développement.',
  'privacy.protection.plainWarning':
    'Le mode non chiffré (développeur) n’est pas le mode par défaut de la version commerciale. ' +
    'Les disques de la version commerciale utilisent le mode chiffré\u00A0: une clé dérivée du ' +
    'mot de passe, rien n’est stocké sans chiffrement. Ne stockez pas de documents sensibles en ' +
    'mode non chiffré sur un disque partagé ou amovible.',
  // ---- Settings → Privacy & data → "Local API" card (local-api wave P4) ----
  'settings.localApi.title': 'API locale',
  'settings.localApi.lead':
    'Permet à d’autres programmes de cet ordinateur d’envoyer du texte à votre modèle d’IA et ' +
    'd’en lire les réponses. Cette option reste désactivée tant que vous ne l’activez pas.',
  'settings.localApi.toggle':
    'Autoriser d’autres applications de cet ordinateur à utiliser mon modèle d’IA',
  'settings.localApi.hint':
    'La connexion ne quitte jamais cet ordinateur\u00A0: rien n’est envoyé sur Internet.',
  'settings.localApi.policyOff': 'La politique de votre disque désactive cette option.',
  'settings.localApi.confirm.title':
    'Autoriser d’autres applications à utiliser votre modèle\u00A0?',
  'settings.localApi.confirm.what':
    'D’autres programmes de cet ordinateur pourront envoyer du texte à votre modèle d’IA et lire ' +
    'ses réponses.',
  'settings.localApi.confirm.boundary':
    'Ces programmes ne peuvent voir ni vos documents, ni vos fichiers, ni vos conversations, et ' +
    'rien ne quitte cet ordinateur par l’intermédiaire de HilbertRaum. Mais HilbertRaum ne peut ' +
    'pas contrôler ce qu’un programme connecté fait des réponses qu’il reçoit\u00A0: avant de ' +
    'connecter une application, vérifiez si elle stocke ou synchronise ses données.',
  'settings.localApi.confirm.persists':
    'Cette option reste activée jusqu’à ce que vous la désactiviez.',
  'settings.localApi.confirm.neverStored':
    'Les requêtes des autres applications reçoivent une réponse, puis sont oubliées\u00A0: elles ' +
    'ne sont enregistrées ni dans votre historique des conversations ni dans les journaux.',
  'settings.localApi.confirm.ack': 'Je comprends ce que les autres applications pourront faire.',
  'settings.localApi.confirm.cta': 'Activer',
  'settings.localApi.connect.title': 'Connecter une autre application',
  'settings.localApi.connect.hint':
    'Collez ces deux valeurs dans l’application à connecter. La plupart des applications les ' +
    'appellent «\u00A0URL de base\u00A0» et «\u00A0clé API\u00A0».',
  'settings.localApi.connect.address': 'Adresse du serveur',
  'settings.localApi.connect.key': 'Clé d’accès',
  'settings.localApi.connect.copy': 'Copier',
  'settings.localApi.connect.copyAddressAria': 'Copier l’adresse du serveur',
  'settings.localApi.connect.copyKeyAria': 'Copier la clé d’accès',
  'settings.localApi.connect.copiedAddress': 'Adresse du serveur copiée.',
  'settings.localApi.connect.copiedKey':
    'Clé copiée\u00A0: le presse-papiers sera vidé automatiquement dans une minute. L’historique ' +
    'du presse-papiers de Windows ou sa synchronisation peuvent toutefois conserver des copies ' +
    'de la clé.',
  'settings.localApi.connect.copyFailed': 'La copie a échoué. Réessayez.',
  'settings.localApi.connect.noKey':
    'Aucune clé d’accès n’est nécessaire tant que la clé n’est pas exigée.',
  'settings.localApi.model.running':
    'Un modèle fonctionne\u00A0: les autres applications peuvent obtenir des réponses.',
  'settings.localApi.model.stopped':
    'Aucun modèle ne fonctionne\u00A0: les autres applications recevront une erreur tant que ' +
    'vous n’en aurez pas démarré un.',
  'settings.localApi.status.port': 'En écoute sur le port {port}.',
  'settings.localApi.status.served.one': '{count} requête traitée jusqu’à présent.',
  'settings.localApi.status.served.many': '{count} requêtes traitées jusqu’à présent.',
  'settings.localApi.status.served.other': '{count} requêtes traitées jusqu’à présent.',
  'settings.localApi.status.off': 'À l’arrêt.',
  'settings.localApi.busyWarning':
    'Une application utilise votre modèle en ce moment. Discuter ici en même temps peut ralentir ' +
    'les deux\u00A0: votre propre conversation reste toujours prioritaire.',
  'settings.localApi.preemptedWarning':
    'Votre propre utilisation de HilbertRaum a interrompu il y a un instant la requête d’une ' +
    'application. L’application peut simplement réessayer.',
  'settings.localApi.token.toggle': 'Exiger une clé d’accès',
  'settings.localApi.token.hint': 'Recommandé\u00A0: laissez cette option activée.',
  'settings.localApi.token.confirm.title': 'Désactiver la clé d’accès\u00A0?',
  'settings.localApi.token.confirm.body':
    'Sans clé d’accès, n’importe quel programme de cet ordinateur peut utiliser votre modèle ' +
    'd’IA sans rien demander. Laissez-la activée, sauf si une application ne peut vraiment pas ' +
    'saisir de clé.',
  'settings.localApi.token.confirm.cta': 'Désactiver',
  'settings.localApi.token.regenerate': 'Créer une nouvelle clé',
  'settings.localApi.token.regenerate.title': 'Créer une nouvelle clé d’accès\u00A0?',
  'settings.localApi.token.regenerate.body':
    'Les applications qui utilisent l’ancienne clé cesseront de fonctionner jusqu’à ce que vous ' +
    'y colliez la nouvelle clé.',
  'settings.localApi.token.regenerate.cta': 'Créer une nouvelle clé',
  'settings.localApi.token.regenerated': 'Nouvelle clé d’accès créée.',
  'settings.localApi.token.regenerateFailed': 'La nouvelle clé n’a pas pu être créée. Réessayez.',
  'settings.localApi.port.label': 'Numéro de port',
  'settings.localApi.port.hint':
    'Ne modifiez ce numéro que si un autre programme l’utilise déjà. Entre 1024 et 65535.',
  'settings.localApi.error.portInUse':
    'Un autre programme de cet ordinateur utilise déjà ce numéro. Cela peut aussi signifier ' +
    'qu’un autre programme se fait passer pour HilbertRaum\u00A0: ne collez votre clé d’accès ' +
    'nulle part tant que le problème n’est pas résolu. Changez de numéro (par exemple ' +
    '{suggestion}) et réactivez l’API locale\u00A0; si une application était déjà connectée, ' +
    'collez-y aussi la nouvelle adresse du serveur.',
  'settings.localApi.error.startFailed':
    'L’API locale n’a pas pu démarrer. Les détails se trouvent dans l’onglet ' +
    '«\u00A0Diagnostic\u00A0».',
  // ---- Settings → Diagnostics tab (DiagnosticsTab.tsx) ----
  'diag.localOnly': 'Diagnostic local uniquement. Rien ici n’est jamais envoyé en ligne.',
  'diag.localApi.label': 'API locale',
  'diag.localApi.off': 'Désactivée',
  'diag.localApi.running':
    'Activée · port {port} · réponses\u00A0: {served}, refus\u00A0: {rejected}',
  'diag.localApi.portInUse': 'Désactivée\u00A0: ce numéro de port est déjà utilisé',
  'diag.localApi.startFailed': 'Désactivée\u00A0: l’API n’a pas pu démarrer',
  'diag.audit.runtime_started': 'Modèle démarré',
  'diag.audit.runtime_stopped': 'Modèle arrêté',
  'diag.audit.runtime_crashed': 'Arrêt inattendu du modèle',
  'diag.audit.runtime_fallback': 'Mode de compatibilité',
  'diag.audit.model_selected': 'Modèle sélectionné',
  'diag.audit.model_verified': 'Somme de contrôle du modèle vérifiée',
  'diag.audit.model_download_started': 'Téléchargement lancé',
  'diag.audit.model_download_verified': 'Téléchargement vérifié',
  'diag.audit.model_download_failed': 'Échec du téléchargement',
  'diag.audit.document_imported': 'Document importé',
  'diag.audit.document_reindexed': 'Document réindexé',
  'diag.audit.document_deleted': 'Document supprimé',
  'diag.audit.document_task_completed': 'Tâche sur un document terminée',
  'diag.audit.document_task_failed': 'Échec d’une tâche sur un document',
  'diag.audit.document_exported': 'Document exporté',
  'diag.audit.summary_exported': 'Résumé exporté',
  'diag.audit.conversation_deleted': 'Conversation supprimée',
  'diag.audit.conversation_exported': 'Conversation exportée',
  'diag.audit.message_table_exported': 'Tableau d’une réponse exporté',
  'diag.audit.code_block_exported': 'Bloc de code enregistré dans un fichier',
  'diag.audit.workspace_created': 'Espace de travail créé',
  'diag.audit.workspace_unlocked': 'Espace de travail déverrouillé',
  'diag.audit.workspace_locked': 'Espace de travail verrouillé',
  'diag.audit.workspace_unlock_failed': 'Échec d’une tentative de déverrouillage',
  'diag.audit.workspace_lock_failed':
    'Échec d’une tentative de verrouillage (l’espace de travail est resté ouvert)',
  'diag.audit.workspace_password_changed': 'Mot de passe de l’espace de travail modifié',
  'diag.audit.settings_changed': 'Paramètres modifiés',
  'diag.audit.local_api_toggled': 'API locale activée ou désactivée',
  'diag.audit.policy_warning': 'Avis de la politique du disque',
  'diag.audit.offline_guard_violation': 'Tentative d’accès au réseau détectée',
  'diag.audit.collection_created': 'Projet créé',
  'diag.audit.collection_renamed': 'Projet renommé',
  'diag.audit.collection_archived': 'Archivage d’un projet modifié',
  'diag.audit.collection_deleted': 'Projet supprimé',
  'diag.audit.documents_added_to_collection': 'Documents ajoutés à une section ou à un projet',
  'diag.audit.documents_removed_from_collection': 'Documents retirés d’une section ou d’un projet',
  'diag.audit.document_lifecycle_changed': 'Cycle de vie d’un document modifié',
  'diag.audit.skill_imported': 'Compétence importée',
  'diag.audit.skill_deleted': 'Compétence supprimée',
  'diag.audit.skill_enabled': 'Compétence activée',
  'diag.audit.skill_disabled': 'Compétence désactivée',
  'diag.audit.skill_run_started': 'Outil de compétence lancé',
  'diag.audit.skill_run_done': 'Outil de compétence terminé',
  'diag.audit.skill_run_failed': 'Échec d’un outil de compétence',
  'diag.audit.evidence_review_created': 'Vérification des justificatifs créée',
  'diag.audit.evidence_review_ready': 'Vérification des justificatifs clôturée',
  'diag.audit.evidence_review_deleted': 'Vérification des justificatifs supprimée',
  'diag.audit.evidence_pack_exported': 'Pack de justificatifs exporté',
  'diag.audit.knowledge_pack_added': 'Pack de connaissances ajouté',
  'diag.audit.knowledge_pack_removed': 'Pack de connaissances retiré',
  'diag.audit.knowledge_pack_article_saved':
    'Article d’un pack de connaissances enregistré comme document',
  'diag.accel.gpuFallbackName': 'Carte graphique',
  'diag.accel.gpu': '{name} (GPU)',
  'diag.accel.mock': 'Mode démo intégré',
  'diag.app.engine': 'Moteur d’IA',
  'diag.app.voiceEngine': 'Moteur vocal',
  'diag.engine.cannotRun': 'Ne peut pas fonctionner\u00A0: {reason}',
  'diag.engine.reason.libraryMissing': 'une bibliothèque système est absente',
  'diag.engine.reason.systemTooOld': 'le système est trop ancien',
  'diag.engine.reason.filesDamaged': 'fichiers du moteur absents ou endommagés',
  'diag.engine.reason.filesDamagedAfterInstall':
    'fichiers du moteur signalés comme endommagés juste après une nouvelle installation',
  'diag.engine.reason.vcRuntimeMissing': 'Visual C++ Redistributable absent',
  'diag.engine.reason.blocked': 'bloqué par la sécurité de Windows',
  'diag.accel.cpu': 'Processeur (CPU)',
  'diag.accel.gpuAvailable': '{name} (GPU disponible)',
  'diag.app.title': 'Application et moteur d’exécution',
  'diag.app.version': 'Version de l’application',
  'diag.app.unknown': 'non disponible',
  'diag.app.selectedModel': 'Modèle sélectionné',
  'diag.app.noneSelected': 'aucun',
  'diag.app.profile': 'Profil matériel',
  'diag.app.runtime': 'Moteur d’exécution',
  'diag.app.unknownModel': 'modèle inconnu',
  'diag.app.onPort': ' sur 127.0.0.1:{port}',
  'diag.app.healthy': 'opérationnel',
  'diag.app.unhealthy': 'défaillant',
  'diag.app.runtimeRunning': 'En marche – {model}{onPort} ({health})',
  'diag.app.stopped': 'Arrêté',
  'diag.app.acceleration': 'Accélération',
  'diag.app.runtimeBuild': 'Version du moteur d’exécution',
  'diag.app.noInstallMarker': 'aucun marqueur d’installation (disque préparé manuellement)',
  'diag.app.engineVersions': 'Versions des moteurs',
  'diag.engineVersion.older': '{engine} {installed}, cette application attend la version {pinned}',
  'diag.engineVersion.newer':
    '{engine} {installed}, plus récente que la version attendue par cette application ({pinned})',
  'diag.engineVersion.unknown':
    '{engine}\u00A0: aucune version enregistrée, cette application attend la version {pinned}',
  'diag.engineVersion.cpuNet': '{engine} (repli sur processeur)',
  'diag.gpu.compat':
    'Mode de compatibilité activé\u00A0: les réponses sont générées sur le processeur (CPU), ce ' +
    'qui fonctionne sur tous les ordinateurs.',
  'diag.gpu.tryHint':
    'Si vous avez mis à jour votre pilote graphique, vous pouvez réessayer avec la carte ' +
    'graphique.',
  'diag.gpu.offHint':
    'L’accélération par carte graphique (GPU) est désactivée\u00A0: réactivez-la dans les ' +
    'Paramètres pour utiliser de nouveau la carte graphique.',
  'diag.gpu.tryAgain': 'Réessayer avec la carte graphique',
  'diag.gpu.tryFailed':
    'La nouvelle tentative avec la carte graphique n’a pas abouti\u00A0: {error}',
  'diag.refresh': 'Actualiser',
  // ---- Performance screen (PerformanceScreen.tsx; benchmark.md "Performance screen") ----
  'perf.title': 'Performance',
  'perf.lead':
    'La vitesse à laquelle cet ordinateur exécute votre modèle d’IA, mesurée sur cet appareil. ' +
    'Rien n’est envoyé nulle part.',
  'perf.card.title': 'Cet ordinateur',
  'perf.checkedAt': 'Dernier test\u00A0: {when}',
  'perf.notChecked': 'Pas encore de test',
  'perf.otherMachine':
    'Ce résultat a été mesuré sur un autre ordinateur. Relancez le test pour mesurer celui-ci.',
  'perf.report.otherComputer': 'Autre ordinateur\u00A0: {cpu}, {ram}\u00A0GB de RAM',
  'perf.verdict.speed': 'Cet ordinateur exécute {model} à environ {tps}\u00A0tok/s.',
  'perf.verdict.noSpeed':
    '{model} est le modèle le mieux adapté à cet ordinateur (critère\u00A0: {basis}). La vitesse ' +
    'est mesurée dès qu’un modèle a fonctionné.',
  'perf.basis.discrete': 'mémoire graphique',
  'perf.basis.unified': 'mémoire unifiée',
  'perf.basis.cpu': 'RAM',
  'perf.recommendation.atCheckTime': 'Recommandé au moment du test',
  'perf.recommendation.next': 'Recommandé pour le prochain démarrage',
  'perf.recommendation.nextOnThisComputer':
    'Recommandé pour le prochain démarrage sur cet ordinateur',
  'perf.verdict.noRecommendation': 'Aucun modèle du catalogue ne convient encore à cet ordinateur.',
  'perf.verdict.notChecked':
    'Un test rapide mesure la mémoire, la vitesse du disque et, dès qu’un modèle fonctionne, la ' +
    'vitesse de génération.',
  'perf.verdict.driveFast': 'Les modèles démarrent rapidement depuis ce disque.',
  'perf.verdict.driveSlow': 'Les modèles démarrent lentement depuis ce disque.',
  'perf.tile.speed': 'Vitesse',
  'perf.tile.speed.unit': 'tok/s',
  'perf.tile.speed.sub': 'Mesure effectuée avec {model} le {when}',
  'perf.tile.speed.approx':
    'Valeur approximative\u00A0: fragments comptés, pas le chronométrage du moteur',
  'perf.tile.speed.chunks': 'nombre de fragments\u00A0: {chunks}',
  'perf.tile.speed.none': 'Pas encore de mesure',
  'perf.tile.speed.noneHint': 'Démarrez un modèle, puis relancez le test',
  'perf.tile.memory': 'Mémoire',
  'perf.tile.memory.unit': 'GB de RAM',
  'perf.tile.memory.unified': 'Mémoire unifiée',
  'perf.tile.memory.unifiedSub': 'Partagée par le processeur et les cœurs graphiques',
  'perf.model.title': 'Votre modèle',
  'perf.model.line.one': '{model} · {size}\u00A0GB sur le disque · contexte\u00A0: {context} token',
  'perf.model.line.many':
    '{model} · {size}\u00A0GB sur le disque · contexte\u00A0: {context} tokens',
  'perf.model.line.other':
    '{model} · {size}\u00A0GB sur le disque · contexte\u00A0: {context} tokens',
  'perf.model.none':
    'Aucun modèle sélectionné pour l’instant. Choisissez-en un sur l’écran Modèle d’IA.',
  'perf.model.need': 'Occupe {need}\u00A0GB avec ce contexte.',
  'perf.model.needEstimate':
    'Nécessite au moins {need}\u00A0GB pour les poids, plus le cache de contexte, mesuré au ' +
    'premier démarrage.',
  'perf.model.gpu':
    'Tient dans la mémoire graphique ({budget}\u00A0GB)\u00A0: toutes les couches ({layers}) sur ' +
    'la carte graphique.',
  'perf.model.gpuEstimate': 'Devrait tenir dans la mémoire graphique ({budget}\u00A0GB).',
  'perf.model.partial':
    'La mémoire graphique peut contenir {budget}\u00A0GB. Couches sur la carte graphique\u00A0: ' +
    '{gpuLayers} sur {layers}\u00A0; part exécutée depuis la RAM\u00A0: environ {spill}\u00A0GB. ' +
    'Réponses plus lentes.',
  'perf.model.partialFree':
    'Couches sur la carte graphique\u00A0: {gpuLayers} sur {layers}\u00A0; part exécutée depuis ' +
    'la RAM\u00A0: environ {spill}\u00A0GB. Au démarrage du modèle, la carte n’avait que ' +
    '{free}\u00A0GB de libre sur {budget}\u00A0GB, et le moteur d’IA réserve une marge de ' +
    'sécurité de {margin}\u00A0GB. Réponses plus lentes. Redémarrez le modèle une fois la carte ' +
    'libérée.',
  'perf.model.partialMargin':
    'Couches sur la carte graphique\u00A0: {gpuLayers} sur {layers}\u00A0; part exécutée depuis ' +
    'la RAM\u00A0: environ {spill}\u00A0GB. La carte était libre ({free} sur {budget}\u00A0GB), ' +
    'mais le moteur d’IA réserve aussi {working}\u00A0GB de tampons de travail et une marge de ' +
    'sécurité de {margin}\u00A0GB, et il retire des couches entières de la carte quand le total ' +
    'frôle la mémoire libre. Réponses plus lentes.',
  'perf.model.partialMarginNoWorking':
    'Couches sur la carte graphique\u00A0: {gpuLayers} sur {layers}\u00A0; part exécutée depuis ' +
    'la RAM\u00A0: environ {spill}\u00A0GB. La carte était libre ({free} sur {budget}\u00A0GB), ' +
    'mais le moteur d’IA réserve aussi des tampons de travail et une marge de sécurité de ' +
    '{margin}\u00A0GB, et il retire des couches entières de la carte quand le total frôle la ' +
    'mémoire libre. Réponses plus lentes.',
  'perf.model.partialEstimate':
    'La mémoire graphique peut contenir {budget}\u00A0GB. Part qui s’exécutera depuis la ' +
    'RAM\u00A0: environ {spill}\u00A0GB. Réponses plus lentes.',
  'perf.model.cpu': 'S’exécute sur le processeur, depuis la RAM ({budget}\u00A0GB).',
  'perf.model.cpuEstimate': 'S’exécutera sur le processeur, depuis la RAM ({budget}\u00A0GB).',
  'perf.model.unified':
    'Tient dans la mémoire unifiée ({ram}\u00A0GB\u00A0; mémoire disponible pour le ' +
    'modèle\u00A0: jusqu’à {budget}\u00A0GB).',
  'perf.model.unifiedEstimate':
    'Devrait tenir dans la mémoire unifiée ({ram}\u00A0GB\u00A0; mémoire disponible pour le ' +
    'modèle\u00A0: jusqu’à {budget}\u00A0GB).',
  'perf.model.tooLarge':
    'Trop volumineux pour cet ordinateur (mémoire disponible\u00A0: {budget}\u00A0GB). ' +
    'Choisissez un modèle plus petit.',
  'perf.model.unknown':
    'L’emplacement du modèle en mémoire est mesuré lors de son premier démarrage sur cet ' +
    'ordinateur.',
  'perf.model.unknownObserved': 'Le moteur d’IA n’a pas indiqué où le modèle a été placé.',
  'perf.model.perDrive':
    'Le disque conserve une seule mesure par modèle\u00A0: un démarrage sur un autre ordinateur ' +
    'remplace donc celle effectuée ici.',
  'perf.model.measuredOther.one':
    'Mesure effectuée précédemment avec un contexte de {context} token, le {when}\u00A0; ' +
    'l’estimation ci-dessus correspond aux paramètres actuels.',
  'perf.model.measuredOther.many':
    'Mesure effectuée précédemment avec un contexte de {context} tokens, le {when}\u00A0; ' +
    'l’estimation ci-dessus correspond aux paramètres actuels.',
  'perf.model.measuredOther.other':
    'Mesure effectuée précédemment avec un contexte de {context} tokens, le {when}\u00A0; ' +
    'l’estimation ci-dessus correspond aux paramètres actuels.',
  'perf.model.runningOnCard': 'Fonctionne actuellement sur la carte graphique.',
  'perf.model.choose': 'Choisir un modèle plus petit',
  'perf.models.title': 'Modèles sur cet ordinateur',
  'perf.models.hint':
    'Le Chat et la traduction se partagent la carte graphique. Les images, la recherche dans les ' +
    'documents et la voix fonctionnent volontairement sur le processeur\u00A0: elles utilisent ' +
    'donc la RAM, pas la mémoire graphique.',
  'perf.role.chat': 'Chat',
  'perf.role.translation': 'Traduction',
  'perf.role.vision': 'Images',
  'perf.role.reranker': 'Recherche dans les documents (classement)',
  'perf.role.embeddings': 'Recherche dans les documents (index)',
  'perf.role.transcriber': 'Voix',
  'perf.models.row': '{model} · {size}\u00A0GB',
  'perf.models.rowNoSize': '{model}',
  'perf.models.none': 'Aucun modèle installé pour cette fonction.',
  'perf.models.device.gpu': 'carte graphique',
  'perf.models.device.cpu': 'processeur, volontairement',
  'perf.models.device.processor': 'processeur',
  'perf.models.loaded': 'chargé',
  'perf.models.notLoaded': 'non chargé',
  'perf.models.lifetime.session': 'reste chargé',
  'perf.models.lifetime.idle': 'se décharge en cas d’inactivité',
  'perf.models.lifetime.per-use': 'ne fonctionne que pendant une tâche',
  'perf.models.split': 'couches sur la carte\u00A0: {gpuLayers} sur {layers}',
  'perf.models.card':
    'Carte graphique\u00A0: Chat {chat}\u00A0GB + traduction {translation}\u00A0GB, sur ' +
    '{vram}\u00A0GB.',
  'perf.models.cardReranker':
    'Carte graphique\u00A0: classement {reranker}\u00A0GB, sur {vram}\u00A0GB.',
  'perf.models.cardBoth':
    'Les deux sont actuellement sur la carte. Celui qui a démarré en second a reçu la mémoire ' +
    'restante et fonctionne plus lentement\u00A0; arrêtez-le puis redémarrez-le une fois l’autre ' +
    'déchargé.',
  'perf.models.ram':
    'Tout charger en même temps nécessite environ {sum}\u00A0GB sur {ram}\u00A0GB de RAM.',
  'perf.models.memory':
    'Tout charger en même temps nécessite environ {sum}\u00A0GB de mémoire unifiée (disponible ' +
    'pour les modèles\u00A0: {budget}\u00A0GB).',
  'perf.models.ramTooMuch': 'Trop à la fois',
  'perf.models.ramOk': 'Tout tient',
  'perf.place.gpu': 'Sur le GPU',
  'perf.place.partial': 'En partie sur le GPU',
  'perf.place.cpu': 'Sur le processeur',
  'perf.place.tooLarge': 'Trop grand',
  'perf.place.unknown': 'Non mesuré',
  'perf.tile.graphics': 'Mémoire graphique',
  'perf.tile.graphics.unit': 'GB de VRAM',
  'perf.tile.graphics.none':
    'Aucune carte graphique utilisable. Les modèles s’exécutent sur le processeur.',
  'perf.tile.graphics.engine':
    'Le moteur d’IA ne peut pas fonctionner sur cet ordinateur\u00A0: la carte graphique n’a ' +
    'donc pas pu être vérifiée.',
  'perf.tile.graphics.off':
    'L’accélération par carte graphique est désactivée. Les modèles s’exécutent sur le ' +
    'processeur.',
  'perf.tile.graphics.small':
    'Moins de {min}\u00A0GB\u00A0: les modèles s’exécutent sur le processeur.',
  'perf.tile.graphics.integrated':
    'Carte intégrée, mémoire partagée\u00A0: les modèles s’exécutent sur le processeur.',
  'perf.tile.graphics.unitShared': 'GB de mémoire partagée',
  'perf.tile.graphics.notRecorded': 'Ce test n’a pas enregistré la carte graphique.',
  'perf.rating.usable': 'Utilisable',
  'perf.rating.small': 'Limitée',
  'perf.rating.integrated': 'Intégrée',
  'perf.rating.notRecorded': 'Non enregistrée',
  'perf.rating.none': 'Aucune',
  'perf.rating.unknown': 'Inconnue',
  'perf.others.subGpu': '{cpu}, {ram}\u00A0GB de RAM, {vram}\u00A0GB de VRAM · {when}',
  'perf.tile.drive': 'Disque',
  'perf.tile.drive.unit': 'MB/s en lecture',
  'perf.tile.drive.load': 'Lors d’un chargement de modèle le {when}, lecture de {gb}\u00A0GB',
  'perf.tile.drive.hash': 'Lors d’une vérification de fichier le {when}, lecture de {gb}\u00A0GB',
  'perf.tile.drive.none': 'Pas encore de mesure',
  'perf.tile.drive.noneHint':
    'Mesure prise lors du premier démarrage d’un modèle ou de la première vérification de fichier',
  'perf.rating.good': 'Bonne',
  'perf.rating.slow': 'Peu rapide',
  'perf.rating.fast': 'Rapide',
  'perf.rating.pending': 'En attente',
  'perf.rating.approx': 'Approximative',
  'perf.rating.slowDrive': 'Disque lent',
  'perf.profile.TINY': 'Minimal',
  'perf.profile.LITE': 'Léger',
  'perf.profile.BALANCED': 'Équilibré',
  'perf.profile.PRO': 'Pro',
  'perf.profile.UNKNOWN': 'Inconnu',
  'perf.check': 'Tester cet ordinateur',
  'perf.checkAgain': 'Relancer le test',
  'perf.running': 'Test en cours…',
  'perf.startAndMeasure': 'Démarrer {model} et mesurer',
  'perf.contextSize': 'Modifier la taille du contexte',
  'perf.copy': 'Copier le rapport',
  'perf.autoNote':
    'Le test se lance tout seul la première fois, puis chaque fois que ce disque est branché sur ' +
    'un autre ordinateur.',
  'perf.failed': 'Le test a échoué\u00A0: {error}',
  'perf.loadFailed': 'Les dernières valeurs n’ont pas pu être lues\u00A0: {error}',
  'perf.retry': 'Réessayer',
  'perf.step.system': 'Matériel détecté',
  'perf.step.drive': 'Vitesse du disque',
  'perf.step.speed': 'Vitesse de génération avec {model}',
  'perf.step.speedSkipped': 'Vitesse de génération (aucun modèle en marche, étape ignorée)',
  'perf.step.hint': 'Environ une demi-minute. Vous pouvez continuer à utiliser l’application.',
  'perf.running.background': 'Test de cet ordinateur en cours, en arrière-plan.',
  'perf.step.state.done': '{step}\u00A0: étape terminée',
  'perf.step.state.active': '{step}\u00A0: en cours',
  'perf.step.state.todo': '{step}\u00A0: en attente',
  'perf.observed.title': 'Observé pendant votre travail',
  'perf.observed.hint':
    'Des valeurs réelles issues d’une utilisation normale, pas d’une consigne de test. Ces ' +
    'lignes ne sont conservées que pour cette session\u00A0; les vitesses de lecture affichées ' +
    'sont aussi enregistrées avec les valeurs du disque ci-dessus.',
  'perf.observed.none':
    'Rien d’observé pour l’instant dans cette session. Posez une question au modèle ou ' +
    'démarrez-le.',
  'perf.observed.answer':
    'Dernière réponse\u00A0: {tps}\u00A0tok/s, premier token après {ttft}\u00A0s',
  'perf.observed.answerSub': '{model}, {when}, tokens\u00A0: {tokens}',
  'perf.observed.load': 'Démarrage du modèle\u00A0: {seconds}\u00A0s',
  'perf.observed.loadSub': '{model}, lecture de {gb}\u00A0GB depuis ce disque à {mbps}\u00A0MB/s',
  'perf.observed.check': 'Vérification de fichier\u00A0: {seconds}\u00A0s',
  'perf.observed.checkSub':
    'Vérification complète du fichier\u00A0: {model}, le {when}, lecture de {gb}\u00A0GB',
  'perf.observed.oncePerModel': 'Une fois par modèle',
  'perf.others.title': 'Autres ordinateurs sur lesquels ce disque a été utilisé',
  'perf.others.hint':
    'Chaque ordinateur conserve son propre résultat\u00A0: le modèle recommandé dépend donc de ' +
    'l’ordinateur, pas du disque.',
  'perf.others.none':
    'Aucun pour l’instant. Branchez le disque sur un autre ordinateur\u00A0: le test s’y lancera ' +
    'tout seul.',
  'perf.others.row': '{tps}\u00A0tok/s avec {model}',
  'perf.others.rowNoSpeed': 'Modèle recommandé\u00A0: {model}, vitesse non mesurée',
  'perf.others.sub': '{cpu}, {ram}\u00A0GB de RAM · {when}',
  'perf.others.load': 'démarrage du modèle en {seconds}\u00A0s',
  'perf.others.check': 'vérification de fichier en {seconds}\u00A0s',
  'perf.footer':
    'Le rapport technique complet, avec toutes les valeurs brutes, reste disponible dans ' +
    'Paramètres → Diagnostic.',
  'perf.footerLink': 'Ouvrir le diagnostic',
  'perf.unknownModel': 'le modèle chargé',
  'perf.unknownCpu': 'Processeur inconnu',
  'diag.bench.title': 'Test du matériel',
  'diag.bench.hint':
    'Les valeurs brutes du dernier test effectué sur cet ordinateur, à joindre à un message ' +
    'd’assistance. L’écran Performance explique leur signification et lance un nouveau test. ' +
    'Tout est mesuré hors ligne\u00A0: aucune donnée ne quitte votre ordinateur.',
  'diag.bench.empty':
    'Aucun test n’a encore été effectué sur cet ordinateur. Ouvrez l’écran Performance pour en ' +
    'lancer un.',
  'diag.bench.profile': 'Profil attribué',
  'diag.bench.noMatch': 'Aucun modèle adapté',
  'diag.bench.ram': 'RAM',
  'diag.bench.cpu': 'Processeur (CPU)',
  'diag.bench.cores.one': ' ({count} cœur)',
  'diag.bench.cores.many': ' ({count} cœurs)',
  'diag.bench.cores.other': ' ({count} cœurs)',
  'diag.bench.osArch': 'Système d’exploitation / architecture',
  'diag.bench.gpu': 'Carte graphique (GPU)',
  'diag.bench.notDetected': 'non détectée',
  'diag.bench.effectiveRead': 'Vitesse de lecture mesurée',
  'diag.bench.effectiveReadNone': 'pas encore de mesure\u00A0: le démarrage d’un modèle la fournit',
  'diag.bench.effectiveReadLoad':
    'lors d’un chargement de modèle le {when}, lecture de {gb}\u00A0GB',
  'diag.bench.effectiveReadHash':
    'lors d’une vérification de fichier le {when}, lecture de {gb}\u00A0GB',
  'diag.bench.driveWrite': 'Écriture sur le disque',
  'diag.bench.notMeasured': 'non mesurée',
  'diag.bench.tokens': 'Vitesse de décodage (tokens par seconde)',
  'diag.bench.tokensNotMeasured': 'non mesurée (démarrez d’abord un modèle)',
  'diag.bench.tokensModel': 'mesure effectuée avec le modèle chargé {model}',
  'diag.bench.tokensOver': 'tokens décodés\u00A0: {tokens}',
  'diag.bench.tokensApprox':
    'valeur approximative\u00A0: fragments comptés, pas le chronométrage du moteur',
  'diag.bench.lastRun': 'Dernier test',
  'diag.system.title': 'Système',
  'diag.system.osPlatform': 'Système d’exploitation / plateforme',
  'diag.system.freeSpace': 'Espace libre',
  'diag.system.imagesSize': 'Taille de l’historique des images',
  'diag.system.loadFailed':
    'Les informations système n’ont pas encore pu être chargées. Essayez de rouvrir cet onglet.',
  'diag.paths.title': 'Chemins',
  'diag.paths.prepared': 'Disque préparé',
  'diag.paths.yes': 'Oui',
  'diag.paths.noFallback': 'Non (repli sur le dossier de données de l’application)',
  'diag.paths.writable': 'Accessible en écriture',
  'diag.paths.no': 'Non',
  'diag.paths.loadFailed':
    'Les informations sur le disque et l’espace de travail n’ont pas encore pu être chargées. ' +
    'Essayez de rouvrir cet onglet.',
  'diag.activity.title': 'Activité',
  'diag.activity.hint':
    'Un journal local de ce que l’application a fait\u00A0: démarrages de modèles, ' +
    'téléchargements, importations de documents, événements de l’espace de travail. Il reste ' +
    'dans votre espace de travail (chiffré si l’espace de travail l’est) et n’est jamais envoyé ' +
    'en ligne. Il ne contient jamais le texte des conversations ni le contenu des documents.',
  'diag.activity.show': 'Afficher l’activité',
  'diag.activity.hide': 'Masquer l’activité',
  'diag.activity.export': 'Exporter dans un fichier…',
  'diag.activity.savedTo': 'Journal d’activité enregistré\u00A0: {path}',
  'diag.activity.filterShow': 'Afficher',
  'diag.activity.filterAll': 'Toute l’activité',
  'diag.activity.loading': 'Chargement…',
  'diag.activity.empty':
    'Rien n’a encore été enregistré\u00A0: l’activité s’affiche ici au fur et à mesure que vous ' +
    'utilisez l’application.',
  'diag.activity.earlier': 'Afficher l’activité plus ancienne',
  'diag.logs.title': 'Journaux récents',
  'diag.logs.hintBefore': 'La fin du fichier ',
  'diag.logs.hintAfter':
    ' sur cet appareil. Les journaux restent en local et ne sont jamais envoyés en ligne\u00A0; ' +
    'ils ne contiennent ni le contenu des documents ni le texte des conversations.',
  'diag.logs.show': 'Afficher les journaux',
  'diag.logs.hide': 'Masquer les journaux',
  'diag.logs.empty': '(le journal est vide)',
  'diag.logs.save': 'Enregistrer dans un fichier…',
  'diag.logs.savedTo': 'Journaux enregistrés\u00A0: {path}',
  'diag.copy': 'Copier',
  'diag.copyTitle': 'Copier ces informations dans le presse-papiers',
  'diag.copied': 'Contenu copié dans le presse-papiers',
  'diag.copyFailed': 'Le contenu n’a pas pu être copié dans le presse-papiers',
  // ---- Shared components' built-in copy (receive a bound t — i18n record §5 ⑤) ----
  'common.dismiss': 'Masquer',
  'common.close': 'Fermer',
  'common.cancel': 'Annuler',
  'common.remove': 'Retirer',
  'common.apply': 'Appliquer',
  'common.labelValue': '{label}\u00A0: {value}',
  'common.percent': '{pct}\u00A0%',
  'indicator.offline': 'Local · Hors ligne',
  'indicator.online': 'Local · Téléchargements autorisés',
  'indicator.offlineDetail':
    'Tout reste sur ce disque. Aucune connexion à Internet n’est utilisée.',
  'indicator.onlineDetail':
    'Téléchargements autorisés\u00A0: les conversations et les documents restent en local.',
  'indicator.short.offline': 'Hors ligne',
  'indicator.short.online': 'Réseau activé',
  'indicator.withLocalApi': '{state} · API activée',
  'indicator.localApiDetail':
    'D’autres applications de cet ordinateur peuvent utiliser votre modèle. Rien ne quitte cet ' +
    'ordinateur.',
  // ---- Shared password copy ----
  'password.mismatch': 'Les mots de passe ne correspondent pas.',
  'password.show': 'Afficher le mot de passe',
  'password.hide': 'Masquer le mot de passe',
  'password.strength.tooShort': 'Trop court',
  'password.strength.weak': 'Faible',
  'password.strength.okay': 'Correct',
  'password.strength.strong': 'Fort',
  'password.strength.veryStrong': 'Très fort',
  'password.strength.minHint': 'Utilisez au moins {min} caractères.',
  'password.strength.longerHint':
    'Un mot de passe plus long est plus sûr\u00A0: 12 caractères ou plus, ou quelques mots sans ' +
    'rapport entre eux, conviennent bien.',
  // ---- Workspace gate (WorkspaceGate.tsx) ----
  'gate.passwordPlaceholder': 'Mot de passe',
  'gate.unlock.title': 'Déverrouiller votre espace de travail',
  'gate.unlock.hint':
    'Saisissez votre mot de passe pour ouvrir l’espace de travail de ce disque. Tout reste sur ' +
    'ce disque.',
  'gate.unlock.submit': 'Déverrouiller',
  'gate.unlock.submitBusy': 'Déverrouillage…',
  'gate.welcome.title': 'Bienvenue',
  'gate.welcome.intro':
    'Voici votre espace de travail d’IA privé. Discutez avec un modèle d’IA et posez des ' +
    'questions sur vos documents\u00A0: tout fonctionne depuis ce disque.',
  'gate.welcome.stays': 'Tout reste sur ce disque.',
  'gate.welcome.staysRest': 'Sans Internet, sans compte, sans suivi.',
  'gate.welcome.start': 'Commencer',
  'gate.finishing.title': 'Mise en place…',
  'gate.finishing.hint':
    'Vérification de ce qui se trouve déjà sur ce disque. La première analyse d’un gros fichier ' +
    'de modèle d’IA peut prendre quelques minutes.',
  'gate.finishing.progress': 'Vérification du modèle d’IA {n} sur {m}\u00A0: {name} – {pct}\u00A0%',
  'gate.finishing.skip': 'Passer et ouvrir l’application',
  'gate.starter.title': 'Une dernière chose',
  'gate.starter.noModel':
    'Aucun modèle d’IA n’est encore installé sur ce disque\u00A0: il en faut un pour obtenir des ' +
    'réponses dans le Chat. Vous pouvez en ajouter un maintenant, ou plus tard à tout moment ' +
    'depuis l’écran Modèle d’IA.',
  'gate.starter.optional':
    'Le téléchargement d’un modèle est facultatif et demande toujours d’abord votre ' +
    'confirmation. Vos documents et vos conversations n’utilisent jamais Internet, dans tous les ' +
    'cas.',
  'gate.starter.skip': 'Passer pour l’instant',
  'gate.starter.addDocuments': 'Ajouter des documents',
  'gate.starter.chooseModel': 'Choisir votre modèle d’IA',
  'gate.create.title': 'Créer votre mot de passe',
  'gate.create.hint':
    'Ce mot de passe verrouille tout le contenu de votre espace de travail sur ce disque\u00A0: ' +
    'documents, conversations et notes. Il ne peut être ni récupéré ni réinitialisé\u00A0: ' +
    'choisissez donc un mot de passe dont vous vous souviendrez.',
  'gate.create.plaintextToggle': 'Utiliser un espace de travail non chiffré (développeur)',
  'gate.create.plaintextWarning':
    'Le mode non chiffré stocke vos données sans chiffrement sur ce disque. Ne l’utilisez que ' +
    'pour le développement.',
  'gate.create.confirmPlaceholder': 'Confirmer le mot de passe',
  'gate.create.back': 'Retour',
  'gate.create.submit': 'Créer l’espace de travail',
  'gate.create.submitBusy': 'Création…',
  'gate.error.generic': 'Un problème est survenu. Réessayez.',
  // ---- Main-process strings (Phase 41, i18n record §3.3 two-rule boundary) --------------
  'main.ingest.pdfScanDetected':
    'Ce PDF semble être un document numérisé\u00A0: il ne contient pas encore de texte lisible.',
  'main.ingest.audioNeedsTranscriber':
    'L’importation audio nécessite le modèle de transcription\u00A0: téléchargez-le sur l’écran ' +
    'Modèle d’IA.',
  'main.ingest.audioNeedsEngine':
    'L’importation audio nécessite le moteur vocal\u00A0: installez-le sur l’écran Modèle d’IA.',
  'main.ingest.audioNeedsModelAndEngine':
    'L’importation audio nécessite le modèle de transcription et le moteur vocal\u00A0: ' +
    'ajoutez-les tous les deux sur l’écran Modèle d’IA.',
  'main.ingest.audioEngineUnsupported':
    'L’importation audio n’est pas encore disponible sur ce système d’exploitation\u00A0: ' +
    'l’application ne peut pas y installer le moteur vocal nécessaire.',
  'main.ingest.audioUnreadable':
    'Ce fichier audio n’a pas pu être lu. Convertissez-le en WAV ou en MP3, puis importez-le de ' +
    'nouveau.',
  'main.ingest.audioTranscriptionFailed':
    'L’enregistrement n’a pas pu être transcrit. Réindexez ce document pour réessayer.',
  'main.ingest.engineCannotRun':
    'Le moteur d’IA ne peut pas fonctionner sur cet ordinateur\u00A0: ce document n’a donc pas ' +
    'pu être indexé. Suivez les indications de l’écran Modèle d’IA, puis réessayez.',
  'main.ingest.engineLibraryMissing':
    'Le moteur d’IA ne peut pas fonctionner sur cet ordinateur, car une bibliothèque système est ' +
    'absente\u00A0: {library}. Suivez les indications de l’écran Modèle d’IA pour corriger le ' +
    'problème, puis réessayez.',
  'main.ingest.voiceEngineCannotRun':
    'Le moteur vocal ne peut pas fonctionner sur cet ordinateur\u00A0: cet enregistrement n’a ' +
    'donc pas pu être transcrit. Suivez les indications de l’écran Modèle d’IA, puis réindexez ' +
    'ce document.',
  'main.ingest.searchModelTimeout':
    'Le modèle de recherche n’a pas répondu à temps\u00A0: ce document n’a donc pas pu être ' +
    'indexé. Réessayez.',
  'main.ingest.searchModelCannotStart':
    'Le modèle de recherche n’a pas pu démarrer\u00A0: ce document n’a donc pas pu être indexé. ' +
    'Sur l’écran Modèle d’IA, choisissez «\u00A0Vérifier tous les fichiers de modèle\u00A0», ' +
    'puis réessayez.',
  'main.ingest.searchModelFailed':
    'Le modèle de recherche a rencontré un problème\u00A0: ce document n’a donc pas pu être ' +
    'indexé. Réessayez.',
  'main.ingest.imageNeedsOcr':
    'L’importation de photos nécessite les fichiers de reconnaissance de texte (OCR), qui ne ' +
    'sont pas sur ce disque.',
  'main.ingest.imageNoText':
    'Aucun texte lisible n’a été trouvé sur cette photo. Essayez une photo de la page plus ' +
    'nette, prise de plus près.',
  'main.ingest.imageOcrFailed': 'Cette photo n’a pas pu être lue. Réindexez-la pour réessayer.',
  'main.ingest.imageOcrUnavailable':
    'La reconnaissance de texte (OCR) n’a pas pu fonctionner dans cette version\u00A0: cette ' +
    'photo a donc été enregistrée sans texte lisible. Réindexez-la dès que l’OCR sera disponible.',
  'main.ingest.sourceMissing': 'Le fichier de ce document est introuvable sur le disque.',
  'main.ingest.interrupted':
    'Le traitement du document a été interrompu avant la fin. Réindexez-le pour réessayer.',
  'main.ingest.fileTooLarge':
    'Ce fichier est trop volumineux pour être importé en toute sécurité. Divisez-le en fichiers ' +
    'plus petits, puis réessayez.',
  'main.ingest.tooManyChunks':
    'Ce document est trop volumineux pour être entièrement indexé. Divisez-le en fichiers plus ' +
    'petits et importez chaque partie.',
  'main.ingest.parseTimeout':
    'Ce fichier a été ignoré, car son traitement prenait trop de temps. Il est peut-être ' +
    'endommagé ou extrêmement volumineux.',
  'main.ingest.unsupportedType':
    'Ce type de fichier n’est pas pris en charge ({ext}). Essayez TXT, PDF, DOCX, CSV ou un ' +
    'format audio pris en charge.',
  'main.rag.noContext':
    'Je n’ai pas trouvé cela dans vos documents. Reformulez votre question ou vérifiez quels ' +
    'documents vous interrogez.',
  'main.rag.reindexNeeded':
    'Vos documents ont besoin d’une réindexation rapide avant de pouvoir être interrogés\u00A0: ' +
    'ils ont été indexés avec un autre modèle de recherche. Ouvrez l’écran Documents et ' +
    'choisissez «\u00A0Réindexer\u00A0».',
  'main.chat.docTaskBusy':
    'Une tâche est en cours sur un document. Vous pouvez l’annuler, ou attendre qu’elle soit ' +
    'terminée avant de discuter.',
  'main.chat.defaultTitle': 'Nouvelle conversation',
  'main.evidenceReviews.defaultTitle': 'Vérification des justificatifs',
  'main.benchmark.warnTiny':
    'Cet appareil convient le mieux au modèle le plus petit et le plus rapide. Les modèles plus ' +
    'grands risquent d’être lents.',
  'main.benchmark.warnUnknown':
    'Ce matériel n’a pas pu être entièrement détecté\u00A0: un modèle léger et sûr a donc été ' +
    'choisi. Vous pouvez essayer un modèle plus grand à tout moment.',
  'main.benchmark.warnDriveProbe':
    'La vitesse du disque n’a pas pu être mesurée\u00A0: la recommandation repose donc ' +
    'uniquement sur la RAM et le processeur.',
  'main.benchmark.warnSlowDrive':
    'Ce disque est plutôt lent. Les modèles fonctionneront quand même, mais leur chargement peut ' +
    'prendre plus de temps.',
  'main.benchmark.warnSpeedSkipped':
    'La vitesse de génération de texte n’a pas été mesurée cette fois, car le modèle était ' +
    'occupé à autre chose. Le profil ci-dessous repose uniquement sur la RAM, le processeur et ' +
    'la vitesse du disque\u00A0: relancez le test quand rien d’autre n’utilise le modèle pour ' +
    'obtenir une mesure complète.',
  'main.benchmark.warnSlowRead':
    'La lecture depuis ce disque atteint environ {mbps}\u00A0MB/s. Le démarrage d’un modèle lit ' +
    'tout son fichier à cette vitesse\u00A0: les modèles démarreront donc lentement depuis ce ' +
    'disque.',
  'main.benchmark.warnVeryLowTokens':
    'La génération de texte a été très lente avec le modèle chargé ({model})\u00A0: le profil ' +
    'attribué a donc été abaissé d’un niveau. Si ce modèle est plus grand que le modèle ' +
    'recommandé, démarrez le modèle recommandé et relancez le test.',
  'main.benchmark.warnRecommendationLowered':
    'La génération de texte a atteint environ {tps}\u00A0tok/s avec le modèle chargé ' +
    '({model})\u00A0: le modèle recommandé a donc été abaissé d’une catégorie de taille pour que ' +
    'les réponses restent rapides sur cet ordinateur.',
  'main.benchmark.locked':
    'L’espace de travail est verrouillé. Déverrouillez-le pour lancer le test.',
  'main.benchmark.lockedDuringRun':
    'L’espace de travail a été verrouillé pendant le test\u00A0: le résultat n’a donc pas été ' +
    'enregistré. Relancez le test.',
  'main.dialog.openLink.title': 'Ouvrir ce lien dans votre navigateur\u00A0?',
  'main.dialog.openLink.message': 'Ouvrir ce lien dans votre navigateur\u00A0?',
  'main.dialog.openLink.site': 'Site\u00A0: {site}',
  'main.dialog.openLink.truncated':
    'Le lien est raccourci ici. Caractères non affichés\u00A0: {hidden}.',
  'main.dialog.openLink.credentials':
    'L’adresse contient un nom d’utilisateur\u00A0: le site réellement ouvert est celui indiqué ' +
    'sur la ligne «\u00A0Site\u00A0».',
  'main.dialog.openLink.hint':
    'Ce lien provient d’une réponse ou d’un manifeste de modèle, pas de HilbertRaum. Votre ' +
    'navigateur se connectera à ce site.',
  'main.dialog.openLink.open': 'Ouvrir',
  'main.dialog.openLink.cancel': 'Annuler',
  'main.workspace.wrongPassword':
    'Ce mot de passe n’a pas déverrouillé votre espace de travail. Vérifiez-le et réessayez.',
  'main.workspace.openFailed': 'L’espace de travail n’a pas pu être ouvert.',
  'main.workspace.vaultDamaged':
    'Votre mot de passe est correct, mais les données de l’espace de travail sur le disque sont ' +
    'endommagées et n’ont pas pu être ouvertes. Ressaisir le mot de passe n’y changera rien. Ne ' +
    'créez pas de nouvel espace de travail\u00A0: laissez les fichiers tels quels et restaurez ' +
    'le dossier «\u00A0workspace\u00A0» à partir d’une sauvegarde.',
  'main.workspace.recoveryBlocked':
    'L’espace de travail ne peut pas encore être ouvert\u00A0: un autre programme garde ouvert ' +
    'un fichier de récupération qui contient vos données les plus récentes. Fermez tout ce qui ' +
    'pourrait analyser le disque (antivirus, indexation de recherche, fenêtre de fichiers ' +
    'ouverte sur le dossier «\u00A0workspace\u00A0»), patientez un instant, puis réessayez. Rien ' +
    'n’est perdu.',
  'main.workspace.newer':
    'Cet espace de travail a été enregistré par une version plus récente de HilbertRaum\u00A0: ' +
    'mettez l’application à jour pour l’ouvrir. Rien n’a été modifié.',
  'main.workspace.createFailed': 'L’espace de travail n’a pas pu être créé.',
  'main.workspace.passwordTooShort': 'Le mot de passe doit comporter au moins {min} caractères.',
  'main.workspace.newPasswordTooShort':
    'Le nouveau mot de passe doit comporter au moins {min} caractères.',
  'main.workspace.unlockBeforeChange':
    'Déverrouillez l’espace de travail avant de modifier son mot de passe.',
  'main.workspace.wrongCurrentPassword':
    'Ce n’est pas votre mot de passe actuel. Vérifiez votre saisie et réessayez.',
  'main.workspace.changeFailed':
    'Le mot de passe n’a pas pu être modifié. Votre mot de passe actuel fonctionne toujours.',
  'main.workspace.busyPasswordChange':
    'Le mot de passe de l’espace de travail est en cours de modification. Réessayez dans un ' +
    'instant.',
  'main.workspace.lockFailed':
    'L’espace de travail n’a pas pu être verrouillé\u00A0: il reste ouvert et vos données sont ' +
    'en sécurité. Libérez de l’espace sur le disque, puis réessayez.',
  'main.runtime.compatibilityMode':
    'Passage en mode de compatibilité pour plus de stabilité. Tout continue de ' +
    'fonctionner\u00A0: les réponses peuvent être un peu plus lentes.',
  'main.runtime.speedUpDisabled':
    'Une accélération facultative a été désactivée pour plus de stabilité. Le modèle ' +
    'redémarre\u00A0: renvoyez votre message.',
  'main.runtime.crashRestarting':
    'Le modèle d’IA s’est arrêté de façon inattendue et redémarre. Renvoyez votre message dans ' +
    'un instant.',
  'main.runtime.crashStopped':
    'Le modèle d’IA s’est de nouveau arrêté de façon inattendue\u00A0: il n’a donc pas été ' +
    'redémarré. Vous pouvez le redémarrer sur l’écran Modèle d’IA.',
  'main.runtime.modelCannotLoad':
    'Le modèle {model} n’a pas pu être chargé sur cet ordinateur\u00A0: les réponses sont ' +
    'simulées jusqu’à ce que vous choisissiez un autre modèle.',
  'main.runtime.engineCannotRun':
    'Le moteur d’IA ne peut pas fonctionner sur cet ordinateur\u00A0: les réponses sont donc ' +
    'simulées. L’écran Modèle d’IA indique ce qui manque.',
  'main.engine.cannotRun':
    'Le moteur d’IA ne peut pas fonctionner sur cet ordinateur. L’écran Modèle d’IA indique ce ' +
    'qui manque.',
  'main.noModelRunning':
    'Aucun modèle d’IA n’est en marche. Ouvrez l’écran Modèle d’IA et démarrez-en un d’abord.',
  'main.modelStarting': 'Le modèle d’IA démarre. Réessayez dans un instant.',
  'main.translation.noModel':
    'La traduction nécessite le modèle de traduction, qui n’est pas installé sur ce disque. Vous ' +
    'pouvez le télécharger sur l’écran Modèle d’IA.',
  'main.translation.startFailed':
    'Le modèle de traduction n’a pas pu démarrer\u00A0: il n’y a peut-être plus assez de mémoire ' +
    'libre sur cet appareil. Fermez d’autres applications ou redémarrez HilbertRaum, puis ' +
    'réessayez.',
  'main.translation.failedWindowNotice':
    '> ⚠ Cette partie ({part} sur {total}) n’a pas pu être traduite\u00A0: le texte d’origine ' +
    'est conservé tel quel ci-dessous.',
  'main.translation.missingPageNotice':
    '> ⚠ La page {page} de l’original n’a pas pu être traduite\u00A0: elle ne contient aucun ' +
    'texte lisible (il s’agit peut-être d’une image numérisée).',
  'main.translation.missingPageRangeNotice':
    '> ⚠ Les pages {from}–{to} de l’original n’ont pas pu être traduites\u00A0: elles ne ' +
    'contiennent aucun texte lisible (il s’agit peut-être d’images numérisées).',
  'main.translation.attributionLine':
    'Traduction automatique par le modèle {modelId}\u00A0: elle peut contenir des erreurs.',
  'main.model.contextExceeded':
    'Ce contenu est trop volumineux pour la fenêtre de contexte du modèle actuel. Augmentez la ' +
    'taille du contexte sur l’écran Modèle d’IA (une taille fixe choisie sur cet écran limite le ' +
    'contexte), ou essayez un document plus petit.',
  'main.chat.streamInFlight':
    'Une réponse est déjà en cours de génération pour cette conversation.',
  'main.chat.emptyCompletion':
    'Le modèle a renvoyé une réponse vide. Réessayez ou reformulez votre message.',
  'main.chat.runtimeUnresponsive':
    'Le modèle d’IA ne répond plus. Réessayez\u00A0: si le problème persiste, redémarrez le ' +
    'modèle sur l’écran Modèle d’IA.',
  'main.chat.connectionLost':
    'Le modèle d’IA s’est arrêté avant la fin de la réponse. Renvoyez votre message\u00A0: si le ' +
    'problème persiste, redémarrez le modèle sur l’écran Modèle d’IA.',
  'main.chat.streamError':
    'Le modèle d’IA a rencontré une erreur avant la fin de la réponse. Réessayez\u00A0: si le ' +
    'problème persiste, redémarrez le modèle sur l’écran Modèle d’IA.',
  'main.chat.searchModelTimeout':
    'Le modèle de recherche n’a pas répondu à temps\u00A0: la recherche dans vos documents n’a ' +
    'donc pas pu avoir lieu. Réessayez.',
  'main.chat.searchModelCannotStart':
    'Le modèle de recherche n’a pas pu démarrer\u00A0: la recherche dans vos documents n’a donc ' +
    'pas pu avoir lieu. Sur l’écran Modèle d’IA, choisissez «\u00A0Vérifier tous les fichiers de ' +
    'modèle\u00A0», puis réessayez.',
  'main.chat.searchModelFailed':
    'Le modèle de recherche a rencontré un problème\u00A0: la recherche dans vos documents n’a ' +
    'donc pas pu avoir lieu. Réessayez.',
  'main.chat.nothingToRegenerate': 'Il n’y a encore rien à régénérer.',
  'main.chat.nothingToResend':
    'Cette question n’est plus le dernier message de la conversation\u00A0: elle ne peut donc ' +
    'pas être renvoyée.',
  'main.chat.skillUnavailable':
    'Cette compétence n’est plus disponible\u00A0: elle a été désactivée ou supprimée. ' +
    'Activez-la dans Paramètres → Compétences, ou posez de nouveau la question sans elle.',
  'main.chat.reviewBlocksRegenerate':
    'Cette réponse fait l’objet d’une vérification des justificatifs. Répondre à nouveau ' +
    'supprimerait la vérification, avec ses décisions et ses notes\u00A0: posez plutôt votre ' +
    'question de nouveau dans un nouveau message.',
  'main.chat.emptyMessage': 'Un message vide ne peut pas être envoyé.',
  'main.chat.emptyQuestion': 'Une question vide ne peut pas être envoyée.',
  'main.chat.stopFirst':
    'Une réponse est encore en cours de génération pour cette conversation. Arrêtez-la d’abord.',
  'main.chat.locked': 'L’espace de travail est verrouillé. Déverrouillez-le pour discuter.',
  'main.busy.chat':
    'Une réponse est en cours de rédaction. Attendez qu’elle soit terminée (ou arrêtez-la), puis ' +
    'réessayez.',
  'main.busy.docTask':
    'Une tâche sur un document utilise le modèle. Attendez qu’elle soit terminée ou annulez-la, ' +
    'puis réessayez.',
  'main.busy.skillRun':
    'Une compétence travaille sur un document. Attendez qu’elle ait terminé ou annulez-la dans ' +
    'la barre d’exécution, puis réessayez.',
  'main.busy.benchmark':
    'Un test des performances de cet ordinateur est en cours. Réessayez dans un instant.',
  'main.task.unknownKind': 'Tâche de document inconnue.',
  'main.task.refusedChatStreaming':
    'Une réponse est en cours de rédaction. Attendez qu’elle soit terminée (ou arrêtez-la), puis ' +
    'réessayez.',
  'main.task.comparePickTwo': 'Choisissez exactement deux documents à comparer.',
  'main.task.compareReindex':
    'Ces documents nécessitent une réindexation rapide avant de pouvoir être comparés\u00A0: au ' +
    'moins l’un d’eux a été préparé avec un autre modèle de recherche. Ouvrez l’écran Documents ' +
    'et choisissez «\u00A0Réindexer\u00A0», puis réessayez.',
  'main.task.documentNotReady':
    'Ce document ne contient pas encore de texte lisible. Importez-le ou réindexez-le d’abord, ' +
    'puis réessayez.',
  'main.task.genericFailure':
    'La tâche n’a pas pu être terminée. Vérifiez que le modèle est toujours en marche, puis ' +
    'réessayez.',
  'main.task.expired': 'Cette tâche n’est plus disponible.',
  'main.task.translationTarget':
    'Choisissez une langue source prise en charge et une langue cible différente pour la ' +
    'traduction.',
  'main.task.sourceUnreadable':
    'La copie enregistrée de ce document n’a pas pu être lue. Importez de nouveau le document, ' +
    'puis réessayez.',
  'main.task.needsOcr':
    'La reconnaissance de texte nécessite les fichiers OCR, qui ne sont pas sur ce disque. ' +
    'Téléchargez-les avec «\u00A0Télécharger les fichiers OCR\u00A0» sur le document numérisé ou ' +
    'sur l’écran Modèle d’IA. Sur un disque que vous avez préparé vous-même, vous pouvez aussi ' +
    'les ajouter avec la commande «\u00A0fetch-runtime --family ocr\u00A0».',
  'main.task.ocrUnavailable':
    'La reconnaissance de texte (OCR) n’est pas disponible dans cette version\u00A0: les ' +
    'fichiers OCR sont sur ce disque, mais le module de reconnaissance n’a pas pu démarrer.',
  'main.task.ocrNotAScan':
    'Seul un PDF détecté comme document numérisé, ou qui contient des pages numérisées, peut ' +
    'être rendu interrogeable de cette façon.',
  'main.task.ocrNoText':
    'Aucun texte lisible n’a été trouvé dans ce document numérisé. Les pages sont peut-être ' +
    'vierges ou trop floues.',
  'main.task.ocrFailed':
    'Ce document numérisé n’a pas pu être lu. Vérifiez que le document se trouve toujours sur le ' +
    'disque, puis réessayez.',
  'main.task.documentBusyIngesting':
    'Ce document est encore en cours d’importation ou de réindexation. Attendez la fin de ' +
    'l’opération, puis réessayez.',
  'main.task.pickOneTranslate': 'Choisissez exactement un document à traduire.',
  'main.task.pickOneOcr': 'Choisissez exactement un PDF numérisé à rendre interrogeable.',
  'main.task.pickOneSummarize': 'Choisissez exactement un document à résumer.',
  'main.task.unavailable': 'Les tâches sur les documents ne sont pas disponibles.',
  'main.task.workspaceLocked':
    'L’espace de travail est verrouillé. Déverrouillez-le pour travailler sur vos documents.',
  'main.download.policyDisabled':
    'Les téléchargements sont désactivés par la politique de ce disque.',
  'main.download.networkOff':
    'L’accès à Internet est désactivé. Activez d’abord «\u00A0Autoriser l’accès à Internet pour ' +
    'les téléchargements de modèles et les mises à jour\u00A0» dans les Paramètres.',
  'main.download.alreadyRunning':
    'Un autre téléchargement est déjà en cours. Les modèles se téléchargent un par un.',
  'main.download.stoppedNetworkOff':
    'L’accès à Internet est désactivé\u00A0: le téléchargement en cours a donc été interrompu. ' +
    'Pour le terminer, réactivez l’accès à Internet dans les Paramètres.',
  'main.download.noSource':
    'Le modèle «\u00A0{modelId}\u00A0» n’a aucune source de téléchargement dans son manifeste.',
  'main.download.sourceWithdrawn':
    'L’éditeur du modèle «\u00A0{modelId}\u00A0» a retiré ce fichier précis\u00A0: il ne peut ' +
    'donc plus être téléchargé ({reason}). Les modèles déjà présents sur ce disque continuent de ' +
    'fonctionner.',
  'main.download.alreadyVerified': 'Ce modèle est déjà téléchargé et vérifié.',
  'main.download.presentUnverified':
    'Le fichier de ce modèle est déjà présent. Son manifeste ne contient pas encore de vraie ' +
    'somme de contrôle\u00A0: le fichier ne peut donc pas être vérifié. Générez-en une avec la ' +
    'commande «\u00A0verify-models --generate\u00A0».',
  'main.download.licenseFirst':
    'Consultez et acceptez la licence du modèle ({license}) avant de le télécharger.',
  'main.download.notEnoughSpace':
    'Il n’y a pas assez d’espace libre sur ce disque (nécessaire pour le téléchargement\u00A0: ' +
    '{needed}\u00A0; disponible\u00A0: {free}). Libérez de l’espace sur le disque ou choisissez ' +
    'un modèle plus petit.',
  'main.download.unknownJob': 'Téléchargement inconnu.',
  'main.download.checksumMismatch':
    'Le fichier téléchargé ne correspondait pas à la somme de contrôle attendue\u00A0: il a donc ' +
    'été supprimé. Réessayez.',
  'main.download.fileMissing': 'Le fichier téléchargé a disparu avant de pouvoir être vérifié.',
  'main.download.httpFailed':
    'Le téléchargement n’a pas pu démarrer ({reason}). Vérifiez la connexion et réessayez.',
  'main.download.interrupted':
    'Le téléchargement a été interrompu ({reason}). La partie déjà téléchargée est ' +
    'conservée\u00A0: si vous le relancez, il reprendra là où il s’était arrêté.',
  'main.download.writeFailed':
    'Le fichier du modèle n’a pas pu être enregistré sur ce disque. Vérifiez que le disque n’est ' +
    'ni plein ni protégé en écriture, puis réessayez.',
  'main.download.resumeDiscarded':
    'Le serveur a envoyé la mauvaise partie du fichier\u00A0: le téléchargement partiel a donc ' +
    'été supprimé. Si vous le relancez, il recommencera depuis le début.',
  'main.engine.alreadyRunning': 'Le moteur d’IA est déjà en cours de téléchargement.',
  'main.engine.noSources':
    'Aucune source de moteur n’a été trouvée sur ce disque (le fichier ' +
    '«\u00A0runtime-sources.yaml\u00A0» est absent).',
  'main.engine.noHostBuild': 'Aucune version du moteur d’IA n’est disponible pour cet ordinateur.',
  'main.engine.alreadyInstalled': 'Le moteur d’IA est déjà installé.',
  'main.engine.unknownJob': 'Téléchargement de moteur inconnu.',
  'main.engine.checksumMismatch':
    'Le moteur téléchargé ne correspondait pas à la somme de contrôle attendue\u00A0: il a donc ' +
    'été supprimé. Réessayez.',
  'main.engine.fileMissing': 'Le moteur téléchargé a disparu avant de pouvoir être vérifié.',
  'main.engine.unverifiablePlaceholder':
    'Cette source du moteur d’IA n’a pas de vraie somme de contrôle\u00A0: le téléchargement n’a ' +
    'donc pas pu être vérifié et n’a pas été installé. Le disque est peut-être mal configuré.',
  'main.engine.binaryMissing':
    'Le moteur a été téléchargé mais n’a pas pu être décompressé (la structure de l’archive a ' +
    'peut-être changé).',
  'main.engine.extractFailed':
    'Le moteur d’IA a été téléchargé mais n’a pas pu être décompressé. Réessayez.',
  'main.engine.httpFailed':
    'Le téléchargement du moteur n’a pas pu démarrer ({reason}). Vérifiez la connexion et ' +
    'réessayez.',
  'main.engine.interrupted': 'Le téléchargement du moteur a été interrompu ({reason}). Réessayez.',
  'main.engine.runtimeRunning':
    'Le moteur d’IA ne peut pas être remplacé pendant qu’un modèle est en marche. Arrêtez le ' +
    'modèle sur l’écran Modèle d’IA, puis réessayez.',
  'main.engine.transcriptionRunning':
    'Le moteur vocal ne peut pas être remplacé pendant une transcription audio. Attendez qu’elle ' +
    'soit terminée, puis réessayez.',
  'main.engine.knowledgePackToolsRunning':
    'Les outils des packs de connaissances ne peuvent pas être remplacés pendant qu’un pack est ' +
    'en cours d’utilisation. Verrouillez l’espace de travail ou attendez la fin de la question ' +
    'en cours, puis réessayez. Si le message persiste, redémarrez l’application.',
  'main.engine.badRequest': 'La demande d’installation du moteur n’a pas été comprise. Réessayez.',
  'main.engine.nothingToRepair':
    'Il n’y a rien à réparer\u00A0: le moteur présent sur ce disque n’a pas été détecté comme ' +
    'endommagé.',
  'main.engine.nothingToUpdate':
    'Il n’y a rien à mettre à jour\u00A0: les moteurs présents sur ce disque sont déjà à la ' +
    'version utilisée par cette application, ou plus récents.',
  'main.engine.updateBusy':
    'Le moteur d’IA est actuellement utilisé (une réponse, une importation, une traduction ou ' +
    'une tâche sur un document est en cours). Relancez la mise à jour une fois l’opération ' +
    'terminée.',
  'main.ocr.badRequest':
    'La demande de téléchargement des fichiers OCR n’a pas été comprise. Réessayez.',
  'main.ocr.alreadyRunning': 'Les fichiers OCR sont déjà en cours de téléchargement.',
  'main.ocr.noSources':
    'Ce disque ne contient pas de liste de téléchargement pour les fichiers OCR. Ajoutez-les ' +
    'plutôt avec les scripts de préparation du disque («\u00A0fetch-runtime --family ocr\u00A0»).',
  'main.ocr.sourcesMismatch':
    'La liste de téléchargement des fichiers OCR sur ce disque ne correspond pas à cette version ' +
    'de HilbertRaum\u00A0: rien n’a donc été téléchargé. Ajoutez plutôt les fichiers avec les ' +
    'scripts de préparation du disque («\u00A0fetch-runtime --family ocr\u00A0»).',
  'main.ocr.alreadyInstalled':
    'Les fichiers OCR sont déjà sur ce disque. Si la reconnaissance de texte n’est toujours pas ' +
    'proposée, redémarrez HilbertRaum.',
  'main.ocr.unsafeFolder':
    'Le dossier «\u00A0ocr\u00A0» de ce disque n’est pas un dossier ordinaire (il pointe ' +
    'peut-être vers un autre emplacement)\u00A0: rien n’a donc été écrit. Remplacez-le par un ' +
    'dossier ordinaire nommé «\u00A0ocr\u00A0», puis réessayez.',
  'main.ocr.writeFailed':
    'Les fichiers OCR n’ont pas pu être enregistrés sur ce disque. Vérifiez qu’il n’est ni plein ' +
    'ni protégé en écriture, puis réessayez.',
  'main.ocr.downloadFailed':
    'Les fichiers OCR n’ont pas pu être téléchargés. Vérifiez la connexion à Internet, puis ' +
    'réessayez.',
  'main.ocr.checksumMismatch':
    'Un fichier OCR téléchargé ne correspondait pas à sa somme de contrôle attendue et a été ' +
    'supprimé\u00A0: les fichiers déjà présents sur ce disque n’ont pas été modifiés. Réessayez.',
  'main.ocr.readFailed':
    'Les fichiers OCR déjà présents sur ce disque n’ont pas pu être lus\u00A0: le disque a ' +
    'peut-être été retiré, ou un autre programme utilise ces fichiers. Vérifiez le disque, puis ' +
    'réessayez.',
  'main.ocr.unknownJob':
    'Ce téléchargement des fichiers OCR n’est plus suivi. Relancez-le si les fichiers manquent ' +
    'encore.',
  'main.docs.locked':
    'L’espace de travail est verrouillé. Déverrouillez-le pour gérer vos documents.',
  'main.docs.processing':
    'Ce document est encore en cours de traitement. Attendez la fin de l’importation.',
  'main.docs.tooManyPaths':
    'Trop de fichiers ont été sélectionnés à la fois. Choisissez plutôt un dossier.',
  'main.docs.taskRunning':
    'Une tâche est en cours sur ce document. Annulez-la ou attendez qu’elle soit terminée.',
  'main.docs.skillRunning':
    'Une compétence est en cours d’exécution sur ce document. Annulez-la ou attendez qu’elle ' +
    'soit terminée.',
  'main.docs.previewEncrypted':
    'Ce document est chiffré\u00A0: déverrouillez l’espace de travail pour en afficher l’aperçu.',
  'main.docs.previewGone':
    'Le fichier du document n’est plus sur le disque. Importez-le de nouveau pour en afficher ' +
    'l’aperçu.',
  'main.docs.exportTextOnly':
    'Seuls les documents texte (Markdown, TXT, CSV) peuvent être exportés de cette façon.',
  'main.docs.exportEncrypted':
    'Ce document est chiffré\u00A0: déverrouillez l’espace de travail pour l’exporter.',
  'main.docs.exportGone':
    'Le fichier du document n’est plus sur le disque. Importez-le de nouveau pour l’exporter.',
  'main.docs.exportOriginalChanged':
    'Seule votre propre copie de ce fichier est encore disponible, et elle a été modifiée depuis ' +
    'son importation\u00A0: ce n’est donc plus le fichier original. Exportez plutôt le texte ' +
    'extrait.',
  'main.docs.noStoredTranscript':
    'Aucune transcription n’est encore stockée pour cet enregistrement. Réindexez-le pour ' +
    'relancer la transcription.',
  'main.models.noManifests':
    'Aucune liste de modèles n’a été trouvée sur ce disque\u00A0: le dossier ' +
    '«\u00A0model-manifests\u00A0» est absent.',
  'main.models.autoSelected':
    'Ce modèle est utilisé automatiquement une fois installé\u00A0: il n’y a rien à sélectionner.',
  'main.models.locked':
    'L’espace de travail est verrouillé. Déverrouillez-le pour gérer les modèles d’IA.',
  'main.audit.locked':
    'L’espace de travail est verrouillé. Déverrouillez-le pour afficher l’activité.',
  'main.settings.locked':
    'L’espace de travail est verrouillé. Déverrouillez-le pour modifier les paramètres.',
  'main.evidenceReviews.locked':
    'L’espace de travail est verrouillé. Déverrouillez-le pour travailler sur les vérifications ' +
    'des justificatifs.',
  'main.evidenceReviews.invalidRequest': 'Cette demande de vérification n’est pas valide.',
  'main.evidenceReviews.exportNotRecorded':
    'Le pack de justificatifs n’a pas pu être inscrit dans l’historique des exportations\u00A0: ' +
    'le fichier exporté a donc été supprimé. Rien n’a été enregistré\u00A0: relancez ' +
    'l’exportation.',
  'main.evidenceReviews.exportFileNotRecorded':
    'Le fichier du pack de justificatifs a été enregistré, mais il n’a pu être ni inscrit dans ' +
    'l’historique des exportations ni supprimé. Son empreinte n’est donc pas consignée\u00A0: ' +
    'exportez de nouveau et remplacez le fichier.',
  'main.evidenceReviews.exportOutdated':
    'Cette vérification est obsolète\u00A0: depuis sa création, une source ou la réponse a ' +
    'changé. Prenez acte de la modification dans la vérification avant d’exporter.',
  'main.settings.invalidPatch':
    'Cette modification des paramètres n’est pas valide et n’a pas été enregistrée.',
  'main.dictation.locked':
    'L’espace de travail est verrouillé. Déverrouillez-le pour utiliser la dictée vocale.',
  'main.dictation.silent':
    'Aucun son n’est parvenu au microphone. Vérifiez qu’il n’est pas coupé et que HilbertRaum ' +
    'est autorisé à l’utiliser dans les paramètres du système, puis réessayez.',
  'main.dictation.tooShort':
    'L’enregistrement était trop court pour contenir de la parole\u00A0: réessayez.',
  'main.dictation.unavailable':
    'La dictée vocale n’est pas encore disponible sur ce disque\u00A0: l’écran Modèle d’IA ' +
    'indique ce qui manque.',
  'main.dictation.failed': 'La transcription n’a pas pu être effectuée\u00A0: réessayez.',
  'main.dictation.tooLong':
    'Cet enregistrement est trop long pour la dictée. Pour les longs enregistrements, importez ' +
    'plutôt le fichier audio comme document.',
  'main.dictation.busy':
    'La dernière dictée est encore en cours de transcription\u00A0: un instant.',
  'main.dictation.engineCannotRun':
    'Le moteur vocal ne peut pas fonctionner sur cet ordinateur. L’écran Modèle d’IA indique ce ' +
    'qui manque.',
  'main.preflight.readOnly':
    'Ce disque semble être en lecture seule\u00A0: l’application ne peut donc pas y créer son ' +
    'espace de travail. Essayez un autre port USB ou consultez le guide de dépannage.',
  'main.preflight.lowSpace':
    'Il reste peu d’espace libre sur ce disque. Vous pouvez tout de même continuer, mais ' +
    'l’importation de gros documents risque d’échouer tant que vous n’aurez pas libéré de la ' +
    'place.',
  'main.dialog.importDocuments': 'Importer des documents',
  'main.dialog.importFolder': 'Importer un dossier de documents',
  'main.dialog.exportDocument': 'Exporter le document',
  'main.dialog.exportOriginal': 'Exporter le fichier original',
  'main.dialog.exportSummary': 'Exporter le résumé',
  'main.dialog.exportChat': 'Exporter la conversation',
  'main.dialog.exportTableCsv': 'Exporter le tableau en CSV',
  'main.dialog.exportCodeBlock': 'Enregistrer le bloc de code dans un fichier',
  'main.dialog.exportAudit': 'Exporter le journal d’activité',
  'main.dialog.exportEvidencePack': 'Exporter le pack de justificatifs',
  'main.dialog.exportLog': 'Enregistrer les journaux de diagnostic',
  'main.dialog.filterDocuments': 'Documents',
  'main.dialog.filterAll': 'Tous les fichiers',
  'main.zim.unavailable': 'Les packs de connaissances ne sont pas disponibles dans cette session.',
  'main.zim.articleUnavailable':
    'Cet article n’est pas disponible pour le moment\u00A0: il n’a donc pas pu être enregistré. ' +
    'Le pack est peut-être désactivé ou retiré, ou son disque débranché.',
  'main.zim.saveFailed': 'L’article n’a pas pu être ajouté à vos documents. Réessayez.',
  'main.zim.dialogTitle': 'Ajouter des packs de connaissances',
  'main.zim.filterZim': 'Archives ZIM',
  'main.dialog.chooseImage': 'Choisir une image',
  'main.dialog.filterImages': 'Images',
  'main.images.unsupportedType':
    'Ce type de fichier n’est pas pris en charge. Choisissez une image PNG, JPEG ou WEBP.',
  'main.images.tooLarge':
    'Cette image est trop volumineuse pour être analysée. Essayez une image plus petite.',
  'main.dialog.importSkill': 'Importer le paquet d’une compétence',
  'main.dialog.importSkillFolder': 'Importer le dossier d’une compétence',
  'main.dialog.exportSkill': 'Exporter la compétence',
  'main.dialog.filterSkill': 'Paquet de compétence',
  'main.dialog.exportCsv': 'Exporter les transactions',
  'main.dialog.filterCsv': 'Fichier CSV',
  'main.dialog.exportJson': 'Exporter en JSON',
  'main.dialog.filterJson': 'Fichier JSON',
  'main.dialog.exportXml': 'Exporter en XML',
  'main.dialog.filterXml': 'Fichier XML',
  'main.dialog.exportRedacted': 'Enregistrer la copie caviardée',
  'main.dialog.exportEdited': 'Enregistrer la copie modifiée',
  'main.dialog.filterText': 'Fichier texte',
  'main.dialog.filterDocx': 'Document Word',
  'main.collections.builtinUndeletable':
    'Les sections intégrées «\u00A0Bibliothèque\u00A0» et «\u00A0Temporaire\u00A0» ne peuvent ' +
    'pas être supprimées.',
  'main.skills.locked':
    'L’espace de travail est verrouillé. Déverrouillez-le pour gérer les compétences.',
  'main.skills.notPicked':
    'Choisissez d’abord le paquet de la compétence à l’aide du sélecteur de fichiers.',
  'main.skills.incompatible':
    'Cette compétence nécessite une version plus récente de l’application. Mettez l’application ' +
    'à jour pour l’utiliser.',
  'main.skills.run.unavailable': 'L’outil de cette compétence n’est pas disponible pour le moment.',
  'main.skills.run.noDocument': 'Ajoutez d’abord un document à cette conversation, puis réessayez.',
  'main.skills.run.busy':
    'Une compétence est déjà en cours. Attendez qu’elle ait terminé ou annulez-la d’abord.',
  'main.skills.run.documentOutOfScope':
    'Ce document ne fait pas partie des documents de cette conversation. Choisissez l’un d’eux ' +
    'et réessayez.',
  // ---- Document organization — Documents screen sections + actions (plan §12) ----
  'docs.section.heading': 'Sections',
  'docs.section.library': 'Bibliothèque',
  'docs.section.projects': 'Projets',
  'docs.section.temporary': 'Temporaire',
  'docs.section.generated': 'Générés',
  'docs.section.archived': 'Archivés',
  'docs.section.all': 'Tous les documents',
  'docs.section.newProject': 'Nouveau projet',
  'docs.mode.aria': 'Affichage de l’écran Documents',
  'docs.mode.documents': 'Mes documents',
  'docs.mode.packs': 'Packs de connaissances',
  'docs.filter.placeholder': 'Filtrer par nom…',
  'docs.filter.aria': 'Filtrer les documents par nom',
  'docs.filter.noMatch': 'Aucun document ne correspond à «\u00A0{query}\u00A0».',
  'docs.empty.packsLine':
    'Ou ajoutez un pack de connaissances\u00A0: une version hors ligne de Wikipédia dont le Chat ' +
    'peut se servir pour répondre.',
  'docs.empty.packsAction': 'Packs de connaissances',
  'docs.rail.hide': 'Masquer les sections',
  'docs.rail.show': 'Afficher les sections',
  'docs.project.createTitle': 'Créer un projet',
  'docs.project.namePlaceholder': 'Nom du projet',
  'docs.project.nameAria': 'Nom du projet',
  'docs.project.create': 'Créer',
  'docs.project.rename': 'Renommer',
  'docs.project.renameTitle': 'Renommer le projet',
  'docs.project.archive': 'Archiver',
  'docs.project.unarchive': 'Désarchiver',
  'docs.project.delete': 'Supprimer le projet',
  'docs.project.deleteTitle': 'Supprimer ce projet\u00A0?',
  'docs.project.deleteBody': 'Choisissez ce que deviennent les documents de ce projet\u00A0:',
  'docs.project.deleteKeep': 'Supprimer uniquement le projet et conserver ses documents',
  'docs.project.deleteKeepHint':
    'Les documents restent dans votre Bibliothèque et dans les autres projets éventuels.',
  'docs.project.deleteWith': 'Supprimer le projet et les documents qui ne se trouvent qu’ici',
  'docs.project.deleteWithHint':
    'Seuls les documents absents de votre Bibliothèque et de tout autre projet sont supprimés. ' +
    'Le contenu de la Bibliothèque n’est jamais touché.',
  'docs.project.archivedNote':
    'Projet archivé\u00A0: masqué en tant que source, mais ses documents restent interrogeables ' +
    'ailleurs.',
  'docs.project.options': 'Options du projet',
  'docs.action.moveToProject': 'Déplacer vers un projet…',
  'docs.action.addToLibrary': 'Conserver dans la Bibliothèque',
  'docs.action.removeFromProject': 'Retirer de ce projet',
  'docs.action.markTemporary': 'Marquer comme temporaire',
  'docs.action.markPermanent': 'Marquer comme permanent',
  'docs.action.archive': 'Archiver',
  'docs.action.unarchive': 'Désarchiver',
  'docs.action.chooseProject': 'Choisir un projet',
  'docs.chip.library': 'Bibliothèque',
  'docs.chip.temporary': 'Temporaire',
  'docs.chip.generated': 'Généré',
  'docs.chip.archived': 'Archivé',
  'docs.bulk.selected.one': '{count} sélectionné',
  'docs.bulk.selected.many': '{count} sélectionnés',
  'docs.bulk.selected.other': '{count} sélectionnés',
  'docs.selectionAria': 'Actions pour les documents sélectionnés',
  'docs.bulk.delete': 'Supprimer',
  'docs.bulk.deleteConfirm.title.one': 'Supprimer {count} document\u00A0?',
  'docs.bulk.deleteConfirm.title.many': 'Supprimer {count} documents\u00A0?',
  'docs.bulk.deleteConfirm.title.other': 'Supprimer {count} documents\u00A0?',
  'docs.bulk.deleteConfirm.body':
    'Les documents sélectionnés, leur texte extrait et leur index de recherche sont ' +
    'définitivement supprimés de votre espace de travail. Les fichiers originaux situés en ' +
    'dehors de l’espace de travail restent intacts.',
  'docs.empty.section': 'Rien ici pour l’instant.',
  // ---- Document organization — smart views (plan §7.6/§12.1, Phase E; regrouped §11.16) ----
  'docs.smart.recentlyAdded': 'Ajoutés récemment',
  'docs.smart.unfiled': 'Non classés',
  'docs.smart.attention': 'À traiter',
  'docs.smart.attentionTitle': 'Importations en échec et documents à réindexer',
  'docs.smart.more': 'Plus',
  'docs.provenance.staleBadge': 'Obsolète',
  'docs.provenance.staleChanged':
    'Une source a changé depuis la création de ce document\u00A0: relancez la tâche pour le ' +
    'mettre à jour.',
  'docs.provenance.staleRemoved':
    'Une source a été supprimée depuis la création de ce document\u00A0: relancez la tâche pour ' +
    'le mettre à jour.',
  // ---- Chat — composite source scope (multi-select picker + footer union, plan §13) ----
  'chat.scope.library': 'Bibliothèque',
  'chat.scope.projectNamed': 'Projet «\u00A0{name}\u00A0»',
  'chat.scope.projectCount.one': '{count} projet',
  'chat.scope.projectCount.many': '{count} projets',
  'chat.scope.projectCount.other': '{count} projets',
  // ---- Knowledge packs (ZIM wave: ScopePopover / SourcesDisclosure / ArticleModal / PacksPanel) ----
  'chat.scope.packsTitle': 'Packs de connaissances',
  'chat.scope.packUnavailable': 'non disponible',
  'chat.scope.packNamed': 'Pack «\u00A0{name}\u00A0»',
  'chat.scope.packNamedState': 'Pack «\u00A0{name}\u00A0» ({state})',
  'chat.scope.packCount.one': '{count} pack de connaissances',
  'chat.scope.packCount.many': '{count} packs de connaissances',
  'chat.scope.packCount.other': '{count} packs de connaissances',
  'chat.scope.documentsToggle': 'Rechercher dans mes documents',
  'chat.scope.documentsToggleHint':
    'Option désactivée\u00A0: les réponses proviennent uniquement des packs de connaissances ' +
    'cochés. Les fichiers joints à cette conversation restent utilisés.',
  'chat.scope.documentsOffSuffix': 'documents désactivés',
  'chat.scope.documentsOffNoPacks':
    'aucune source – activez les documents ou cochez un pack de connaissances',
  'chat.scope.packDisabled': 'désactivé',
  'chat.scope.packRemoved': 'Pack retiré',
  'chat.scope.packLimit.one': 'Jusqu’à {count} pack de connaissances par conversation',
  'chat.scope.packLimit.many': 'Jusqu’à {count} packs de connaissances par conversation',
  'chat.scope.packLimit.other': 'Jusqu’à {count} packs de connaissances par conversation',
  // ---- Per-answer knowledge-pack outcomes (#301 P4, findings M6/M7 — PackOutcomesNotice) ----
  'chat.packs.outcome.summary':
    'Packs de connaissances interrogés\u00A0: {searched} · non interrogés ou en échec\u00A0: ' +
    '{other}',
  'chat.packs.outcome.removedPack': 'un pack retiré',
  'chat.packs.outcome.passages.one': '{count} passage',
  'chat.packs.outcome.passages.many': '{count} passages',
  'chat.packs.outcome.passages.other': '{count} passages',
  'chat.packs.outcome.unknown':
    'Packs de connaissances\u00A0: résultat non enregistré pour cette ancienne réponse',
  'chat.packs.outcome.searched': 'interrogé',
  'chat.packs.outcome.selection-limit':
    'non interrogé\u00A0: limite de sélection (12 par conversation)',
  'chat.packs.outcome.removed': 'non interrogé\u00A0: pack retiré',
  'chat.packs.outcome.disabled': 'non interrogé\u00A0: pack désactivé',
  'chat.packs.outcome.file-missing': 'non interrogé\u00A0: fichier absent',
  'chat.packs.outcome.identity-mismatch': 'non interrogé\u00A0: autre archive à cet emplacement',
  'chat.packs.outcome.not-served': 'non interrogé\u00A0: conflit de nom avec un autre pack',
  'chat.packs.outcome.not-searchable': 'non interrogé\u00A0: pas d’index de recherche plein texte',
  'chat.packs.outcome.tools-missing': 'non interrogé\u00A0: programmes kiwix-tools non installés',
  'chat.packs.outcome.mode':
    'non interrogé\u00A0: les réponses sur le document entier ne lisent que le document',
  'chat.packs.outcome.search-failed': 'échec\u00A0: erreur de recherche',
  'chat.packs.outcome.read-failed': 'échec\u00A0: aucun article n’a pu être lu',
  'chat.packs.outcome.timeout': 'échec\u00A0: délai dépassé',
  'chat.packs.outcome.deadline':
    'non interrogé\u00A0: plus de temps disponible pour cette question',
  'chat.packs.outcome.server-restarted':
    'échec\u00A0: le serveur des packs a redémarré pendant cette question',
  'chat.sources.openArticle': 'Ouvrir l’article',
  'chat.article.title': 'Article',
  'chat.article.from': 'Copie hors ligne issue de «\u00A0{archive}\u00A0»',
  'chat.article.loading': 'Chargement de l’article…',
  'chat.article.unavailable':
    'Cet article n’est pas disponible pour le moment. Le pack est peut-être désactivé ou retiré, ' +
    'ou son disque débranché.',
  'chat.article.partial': 'Seule la première partie de cet article a pu être affichée.',
  'chat.article.save': 'Enregistrer dans mes documents',
  'chat.article.saveAria': 'Enregistrer dans mes documents\u00A0: {title}',
  'chat.article.saving': 'Enregistrement dans vos documents…',
  'chat.article.saved':
    'Article enregistré dans vos documents sous le nom «\u00A0{title}\u00A0». Il reste ' +
    'interrogeable même sans le pack.',
  'chat.article.alreadySaved':
    'Cet article se trouve déjà dans vos documents sous le nom «\u00A0{title}\u00A0».',
  // ---- #301 P6 (a11y pass; plan §9.23 (b)4/(b)6 and decision (c)5) — BEGIN -----------------
  'chat.scope.packMissing': 'fichier absent',
  'chat.scope.packMismatch': 'autre archive à cet emplacement',
  'chat.scope.packNotSearchable': 'pas d’index de recherche plein texte',
  'chat.sources.openArticleNamed': 'Ouvrir l’article\u00A0: {title}',
  // ---- #301 P6 — END ------------------------------------------------------------------------
  'packs.add': 'Ajouter des packs…',
  'packs.addBusy': 'Ajout…',
  'packs.refresh': 'Actualiser',
  'packs.lead':
    'Archives de référence hors ligne (fichiers ZIM, par exemple une version hors ligne de ' +
    'Wikipédia) dont le Chat peut se servir pour répondre. Les fichiers sont utilisés sur place, ' +
    'jamais copiés\u00A0: déposez-les dans le dossier «\u00A0zim\u00A0» du disque ou ajoutez-les ' +
    'ici.',
  'packs.summary.count.one': '{count} pack',
  'packs.summary.count.many': '{count} packs',
  'packs.summary.count.other': '{count} packs',
  'packs.summary.enabled.one': '{count} activé',
  'packs.summary.enabled.many': '{count} activés',
  'packs.summary.enabled.other': '{count} activés',
  'packs.summary.size': '{size} sur ce disque',
  'packs.loading': 'Chargement des packs…',
  'packs.refreshing': 'Recherche de packs sur le disque…',
  'packs.emptyTitle': 'Aucun pack de connaissances pour l’instant',
  'packs.emptyLine':
    'Téléchargez une archive .zim en un seul fichier depuis library.kiwix.org, puis ajoutez-la ' +
    'ici ou copiez-la dans le dossier «\u00A0zim\u00A0» du disque.',
  'packs.copyLibrary': 'Copier l’adresse de la bibliothèque Kiwix',
  'packs.copiedToast': 'Adresse copiée\u00A0: library.kiwix.org',
  'packs.copyFailed': 'L’adresse n’a pas pu être copiée\u00A0: il s’agit de library.kiwix.org',
  'packs.setup.title': 'Configuration initiale\u00A0: les outils des packs de connaissances',
  'packs.toolsMissing':
    'Les programmes kiwix-tools ne sont pas installés sur ce disque\u00A0: les packs ne peuvent ' +
    'donc être ni ajoutés ni interrogés. Pour l’étape d’installation, consultez la section ' +
    '«\u00A0The panel says kiwix-tools are missing\u00A0» du guide de dépannage.',
  'packs.tools.install': 'Installer les outils des packs de connaissances…',
  'packs.tools.confirm.title': 'Installer les outils des packs de connaissances\u00A0?',
  'packs.tools.confirm.explain':
    'Les programmes kiwix-tools {version}, qui mettent à disposition les packs de connaissances ' +
    '(archives ZIM), seront téléchargés depuis le serveur du projet Kiwix et vérifiés avant ' +
    'utilisation. Ils sont facultatifs\u00A0: le Chat et les documents fonctionnent sans eux.',
  'packs.tools.confirm.hint':
    'Le téléchargement est vérifié avant d’être utilisé, et aucune information sur vous ou sur ' +
    'vos documents n’est envoyée. Ces outils ne servent qu’aux packs de connaissances.',
  'packs.tools.confirm.ack':
    'J’ai lu et j’accepte les conditions de la licence {license} de kiwix-tools',
  'packs.tools.confirm.start': 'Lancer le téléchargement',
  'packs.tools.sizeUnknown': 'inconnue',
  'packs.tools.progress': 'Installation des outils des packs de connaissances… {pct}\u00A0%',
  'packs.tools.downloadingNoTotal': 'Installation des outils des packs de connaissances…',
  'packs.tools.verifying': 'Vérification des outils des packs de connaissances…',
  'packs.tools.extracting': 'Décompression des outils des packs de connaissances…',
  'packs.tools.failed': 'L’installation des outils des packs de connaissances a échoué.',
  'packs.tools.doneToast': 'Outils des packs de connaissances installés',
  'packs.addedToast.one': '{count} pack de connaissances ajouté',
  'packs.addedToast.many': '{count} packs de connaissances ajoutés',
  'packs.addedToast.other': '{count} packs de connaissances ajoutés',
  'packs.addPartial': 'Archives non ajoutées\u00A0: {failed} sur {total}.',
  'packs.addFailed.notAZim': 'Le fichier choisi n’est pas une archive ZIM lisible.',
  'packs.addFailed.toolsMissing':
    'Les programmes kiwix-tools ne sont pas installés sur ce disque\u00A0: les packs ne peuvent ' +
    'donc être ni ajoutés ni interrogés. Pour l’étape d’installation, consultez la section ' +
    '«\u00A0The panel says kiwix-tools are missing\u00A0» du guide de dépannage.',
  'packs.addFailed.manager':
    'L’archive n’a pas pu être lue par kiwix-manage. Vérifiez que le fichier est complet, puis ' +
    'réessayez.',
  'packs.addFailed.pathUnsupported':
    'Sous Windows, kiwix-manage ne peut pas lire cette archive, car son nom de fichier ou son ' +
    'dossier contient un tréma, un accent ou un autre caractère non ASCII. Copiez le fichier ' +
    'dans le dossier «\u00A0zim/\u00A0» du disque sous un nom sans ces caractères, puis ' +
    'ajoutez-le de nouveau.',
  'packs.addFailed.other': 'L’archive n’a pas pu être ajoutée.',
  'packs.removedToast': 'Pack de connaissances retiré',
  'packs.articleCount.one': '{count} article',
  'packs.articleCount.many': '{count} articles',
  'packs.articleCount.other': '{count} articles',
  'packs.state.enabled': 'Activé',
  'packs.state.disabled': 'Désactivé',
  'packs.state.missing': 'Fichier absent',
  'packs.state.missingTitle':
    'Le fichier d’archive est introuvable\u00A0: le disque est-il branché\u00A0?',
  'packs.state.identityMismatch': 'Autre archive',
  'packs.state.identityMismatchTitle':
    'Le fichier situé à l’emplacement de ce pack est une autre archive\u00A0: retirez ce pack et ' +
    'ajoutez de nouveau le fichier',
  'packs.state.notSearchable': 'Sans index',
  'packs.state.notSearchableTitle':
    'Cette archive n’a pas d’index de recherche plein texte. Elle est ignorée lors des ' +
    'questions, mais ses articles restent lisibles.',
  'packs.state.notServed': 'Non chargé',
  'packs.state.notServedTitle':
    'Son nom de fichier entre en conflit avec celui du pack «\u00A0{title}\u00A0»\u00A0: seul ce ' +
    'dernier est chargé. Renommez ce fichier pour utiliser les deux.',
  'packs.state.notServedTitleUnknown':
    'Son nom de fichier entre en conflit avec celui d’un autre pack\u00A0: seul ce dernier est ' +
    'chargé. Renommez ce fichier pour utiliser les deux.',
  'packs.switchLabel': 'Utiliser «\u00A0{title}\u00A0» dans les conversations',
  'packs.ask': 'Interroger ce pack',
  'packs.askTitle': 'Ouvrir une conversation qui répond uniquement à partir de ce pack',
  'packs.rowMenu': 'Autres actions pour «\u00A0{title}\u00A0»',
  'packs.remove': 'Retirer',
  'packs.listLabel': 'Packs de connaissances',
  'packs.removeTitle': 'Retirer ce pack de connaissances\u00A0?',
  'packs.removeConfirm': 'Retirer le pack',
  'packs.removeBody':
    'Le pack est seulement retiré de HilbertRaum\u00A0: le fichier d’archive sur le disque reste ' +
    'intact. Les conversations qui l’utilisaient cessent simplement d’y puiser des informations.',
  'chat.scope.docCount.one': '{count} document',
  'chat.scope.docCount.many': '{count} documents',
  'chat.scope.docCount.other': '{count} documents',
  'chat.scope.filesInChat.one': '{count} fichier dans cette conversation',
  'chat.scope.filesInChat.many': '{count} fichiers dans cette conversation',
  'chat.scope.filesInChat.other': '{count} fichiers dans cette conversation',
  'chat.scope.sourcesTitle': 'Choisissez vos sources',
  'chat.scope.librarySource': 'Bibliothèque',
  'chat.scope.librarySourceHint': 'Toute votre base de connaissances',
  'chat.scope.specificToggle': 'Documents précis…',
  'chat.scope.allTap': 'Tous les documents',
  'chat.scope.attachmentsOnlyTap': 'Uniquement les fichiers de cette conversation',
  'chat.scope.filesInChatLine': 'Fichiers de cette conversation',
  'chat.scope.attachmentNotReadable': '{name} (pas encore lisible)',
  'chat.scope.attachmentFailedHint':
    'Un fichier qui ne peut pas encore être lu n’apporte rien aux réponses. L’écran Documents ' +
    'indique pourquoi, et ce qu’il faut faire.',
  'chat.scope.noProjects': 'Aucun projet pour l’instant',
  'chat.scope.noPacks': 'Aucun pack de connaissances sur ce disque pour l’instant.',
  'chat.scope.addPacks': 'Ajouter des packs…',
  'chat.scope.archivedFallback':
    'Ce projet a été archivé\u00A0: les réponses proviennent de votre Bibliothèque.',
  'chat.scope.answeringFrom': 'Sources des réponses\u00A0: {source}',
  'chat.scope.wholeLibrary.one': 'toute votre bibliothèque – {count} document',
  'chat.scope.wholeLibrary.many': 'toute votre bibliothèque – {count} documents',
  'chat.scope.wholeLibrary.other': 'toute votre bibliothèque – {count} documents',
  'chat.scope.narrowTitle': 'Répondre uniquement à partir de ce fichier\u00A0?',
  'chat.scope.narrowBody':
    'Vous avez ajouté le fichier {name}. Interroger uniquement ce fichier, ou continuer à ' +
    'répondre à partir de toute votre bibliothèque\u00A0?',
  'chat.scope.narrowJust': 'Uniquement ce fichier',
  'chat.scope.narrowWhole': 'Toute la bibliothèque',
  // ---- Chat — attach / drag-drop a file into a chat (plan §11.2/§13.5, Phase C) ----
  'chat.attach.button': 'Joindre des fichiers',
  'chat.attach.drop': 'Déposez des fichiers pour les utiliser dans cette conversation',
  'chat.attach.processing': 'Traitement de «\u00A0{name}\u00A0»…',
  'chat.attach.added': 'Fichier ajouté à cette conversation\u00A0: {name}',
  'chat.attach.newDocChat': 'Nouvelle conversation ouverte pour le fichier {name}',
  'chat.attach.failed': 'Le fichier {name} n’a pas pu être ajouté à cette conversation.',
  'chat.attach.dropUnsupported':
    'Cet élément n’a pas pu être ajouté\u00A0: faites glisser un fichier enregistré sur votre ' +
    'ordinateur.',
  'chat.attach.trackFailed':
    'Le suivi de l’importation du fichier a échoué\u00A0: consultez l’écran Documents pour ' +
    'connaître le résultat.',
  'chat.attach.scanned':
    'Le fichier {name} semble être un document numérisé\u00A0: il ne peut donc pas encore être ' +
    'lu. Sur l’écran Documents, utilisez «\u00A0Rendre interrogeable (OCR)\u00A0» pour ce ' +
    'fichier. Il rejoindra ensuite cette conversation automatiquement, sans que vous ayez à le ' +
    'joindre de nouveau.',
  'chat.attach.photoNeedsOcr':
    'Le fichier {name} est la photo d’une page. Pour le lire, il faut les fichiers OCR, qui ne ' +
    'sont pas encore sur ce disque. Sur l’écran Documents, utilisez «\u00A0Télécharger les ' +
    'fichiers OCR\u00A0», puis «\u00A0Réessayer\u00A0» pour ce fichier. Il rejoindra ensuite ' +
    'cette conversation automatiquement, sans que vous ayez à le joindre de nouveau.',
  'chat.attach.goToDocuments': 'Ouvrir l’écran Documents',
  // ---- Images — "Ask about an image" (image-understanding §5/§11, Phase V3) ----
  'images.title': 'Comprendre une image',
  'images.empty.body':
    'Posez des questions sur une capture d’écran, un graphique, un formulaire, un reçu ou une ' +
    'photo. Tout reste en local.',
  'images.avail.noModel':
    'La compréhension d’images nécessite qu’un modèle local pour les images soit présent sur ce ' +
    'disque.',
  'images.avail.noRuntime':
    'La compréhension d’images nécessite d’abord l’installation du moteur d’IA.',
  'images.avail.incompatible':
    'Le modèle pour les images présent sur ce disque nécessite une version plus récente du ' +
    'moteur d’IA.',
  'images.avail.cta': 'Ouvrir l’écran Modèle d’IA',
  'images.avail.ocrPointer':
    'Des documents numérisés\u00A0? Utilisez «\u00A0Rendre interrogeable (OCR)\u00A0» sur ' +
    'l’écran Documents.',
  'images.drop.title': 'Déposez une image ici',
  'images.drop.choose': 'ou choisissez une image',
  'images.drop.types': 'PNG, JPEG ou WEBP',
  'images.drop.busy':
    'Une analyse est en cours. Attendez qu’elle soit terminée pour en lancer une autre.',
  'images.back': 'Retour aux analyses',
  'images.preview.remove': 'Retirer',
  'images.preview.replace': 'Remplacer',
  'images.preview.alt': 'Image sélectionnée',
  'images.chip.summarize': 'Résumer cette image',
  'images.chip.summarize.prompt':
    'Résumez le contenu visible de cette image. Mentionnez tout élément important ou inhabituel.',
  'images.chip.extractText': 'Extraire le texte visible',
  'images.chip.extractText.prompt':
    'Extrayez le texte visible que vous pouvez lire. Conservez les retours à la ligne lorsque ' +
    'c’est utile. Signalez tout texte difficile à lire.',
  'images.chip.explainChart': 'Expliquer ce graphique',
  'images.chip.explainChart.prompt':
    'Expliquez ce que ce graphique semble montrer. Mentionnez les axes, les étiquettes, les ' +
    'tendances et toute incertitude.',
  'images.chip.readForm': 'Lire le formulaire',
  'images.chip.readForm.prompt':
    'Identifiez les principaux champs et valeurs visibles dans ce formulaire. Indiquez ' +
    '«\u00A0illisible\u00A0» pour tout élément que vous ne pouvez pas lire.',
  'images.chip.importantDetails': 'Relever les détails clés',
  'images.chip.importantDetails.prompt':
    'Listez les détails visibles les plus importants. Ne déduisez rien qui ne soit pas visible.',
  'images.chip.whatNotice': 'Que dois-je remarquer\u00A0?',
  'images.chip.whatNotice.prompt':
    'Que dois-je remarquer dans cette image\u00A0? Signalez uniquement les éléments visibles les ' +
    'plus marquants.',
  'images.composer.placeholder': 'Posez une question sur cette image…',
  'images.composer.ask': 'Demander',
  'images.answer.localNote': 'Réponse générée en local à partir de l’image sélectionnée.',
  'images.answer.copy': 'Copier',
  'images.answer.copied': 'Réponse copiée',
  'images.answer.copyFailed': 'La réponse n’a pas pu être copiée dans le presse-papiers',
  'images.answer.tryAgain': 'Réessayer',
  'images.answer.reading': 'Lecture de l’image…',
  'images.answer.starting': 'Démarrage du modèle pour les images…',
  'images.answer.stop': 'Arrêter',
  'images.answer.stopped': 'Génération arrêtée.',
  'images.err.tooLarge':
    'Cette image est trop volumineuse pour être analysée. Essayez une image plus petite.',
  'images.err.unsupported':
    'Ce type de fichier n’est pas pris en charge. Choisissez une image PNG, JPEG ou WEBP.',
  'images.err.heic':
    'Les photos HEIC de l’iPhone ne sont pas encore prises en charge. Convertissez d’abord la ' +
    'photo en JPEG.',
  'images.err.pdf':
    'Cet écran lit une seule image, pas un PDF. Pour un PDF numérisé, utilisez «\u00A0Rendre ' +
    'interrogeable (OCR)\u00A0» sur l’écran Documents.',
  'images.err.pdfAction': 'Ouvrir l’écran Documents',
  'images.err.decodeFailed':
    'Cette image n’a pas pu être ouverte. Elle est peut-être endommagée ou dans un format non ' +
    'pris en charge.',
  'images.err.multiDrop': 'Déposez une seule image à la fois.',
  'images.err.runtimeFailed':
    'Le modèle pour les images n’a pas pu démarrer. Réessayez, ou choisissez un autre modèle.',
  'images.err.engineCannotRun':
    'Le moteur d’IA ne peut pas fonctionner sur cet ordinateur. L’écran Modèle d’IA indique ce ' +
    'qui manque.',
  'images.err.emptyResponse':
    'Aucune réponse n’a été renvoyée pour cette image. Essayez de reformuler votre question.',
  'images.err.emptyQuestion': 'Saisissez d’abord une question sur l’image.',
  'images.err.timedOut':
    'Cela prend trop de temps. Essayez une image plus petite, ou posez de nouveau la question.',
  'images.err.contextExceeded':
    'Cette conversation est devenue trop longue pour cette image. Posez une question plus ' +
    'courte, ou lancez une nouvelle analyse.',
  'images.err.busy': 'Traitement de la question précédente…',
  'images.err.openFailed': 'Cette analyse n’a pas pu être ouverte. Réessayez.',
  'images.err.deleteFailed': 'Cette analyse n’a pas pu être supprimée. Réessayez.',
  'images.err.clearFailed': 'L’historique n’a pas pu être effacé. Réessayez.',
  'images.history.title': 'Historique',
  'images.history.empty': 'Les images que vous analysez s’afficheront ici.',
  'images.history.running': 'Analyse en cours…',
  'images.history.runningOpen': 'Afficher l’analyse en cours',
  'images.history.turns.one': '{count} question',
  'images.history.turns.many': '{count} questions',
  'images.history.turns.other': '{count} questions',
  'images.history.delete': 'Supprimer',
  'images.history.deleteAria': 'Supprimer «\u00A0{title}\u00A0»',
  'images.history.deleted': 'Analyse supprimée de l’historique',
  'images.history.delete.title': 'Supprimer cette image\u00A0?',
  'images.history.delete.confirm': 'Supprimer',
  'images.history.delete.body':
    'L’image «\u00A0{title}\u00A0» et ses réponses seront définitivement supprimées de ce disque.',
  'images.history.total': 'Total\u00A0: {size}',
  'images.history.clear': 'Effacer l’historique',
  'images.history.clear.title': 'Effacer l’historique des images\u00A0?',
  'images.history.clear.confirm': 'Effacer l’historique',
  'images.history.clear.body':
    'Toutes les analyses enregistrées ({size}) et leurs images seront définitivement supprimées ' +
    'de ce disque.',
  'images.history.cleared': 'Historique des images effacé',
  // ---- Translate screen (TranslateGemma wave, plan §2 D6, TG-4) ----
  'translate.title': 'Traduire un texte',
  'translate.lead':
    'Saisissez ou collez un texte, choisissez les langues et traduisez-le en local. Rien ne ' +
    'quitte ce disque.',
  'translate.starting': 'Préparation du modèle de traduction…',
  'translate.avail.noModel': 'La traduction nécessite le modèle de traduction sur ce disque.',
  'translate.avail.hint':
    'Téléchargez-le une seule fois sur l’écran Modèle d’IA\u00A0: la traduction fonctionnera ' +
    'ensuite entièrement hors ligne.',
  'translate.avail.cta': 'Ouvrir l’écran Modèle d’IA',
  'translate.from': 'De',
  'translate.to': 'Vers',
  'translate.swap': 'Inverser les langues',
  'translate.input.label': 'Texte à traduire',
  'translate.input.placeholder': 'Saisissez ou collez le texte à traduire…',
  'translate.action': 'Traduire',
  'translate.stop': 'Arrêter',
  'translate.output.label': 'Traduction',
  'translate.output.empty': 'La traduction s’affichera ici.',
  'translate.working': 'Traduction en cours…',
  'translate.copy': 'Copier',
  'translate.copied': 'Traduction copiée',
  'translate.device.gpu':
    'La traduction s’exécute sur la carte graphique (GPU, couches\u00A0: {done}/{total})',
  'translate.device.gpuUnknown': 'La traduction s’exécute sur la carte graphique (GPU)',
  'translate.device.gpuPartial':
    'La traduction ne s’exécute qu’en partie sur la carte graphique (couches\u00A0: ' +
    '{done}/{total})\u00A0: la mémoire graphique était en grande partie occupée, généralement ' +
    'par le modèle du Chat, si bien que la traduction tourne à peu près à la vitesse du ' +
    'processeur',
  'translate.device.gpuNone':
    'La traduction s’exécute sur le processeur\u00A0: la mémoire graphique était entièrement ' +
    'occupée, généralement par le modèle du Chat, si bien qu’aucune couche n’a pu être placée ' +
    'sur la carte graphique (couches\u00A0: 0/{total})',
  'translate.device.cpu': 'La traduction s’exécute sur le processeur (CPU)',
  'translate.device.cpuBesideChat':
    'La traduction s’exécute sur le processeur\u00A0: le modèle du Chat utilise la mémoire ' +
    'graphique, et il n’y reste pas assez de place pour la traduction',
  'translate.device.cpuChatStarting':
    'La traduction s’exécute sur le processeur\u00A0: un modèle du Chat était en cours de ' +
    'démarrage, et le modèle du Chat a la priorité sur la carte graphique',
  'translate.device.cpuTooLarge':
    'La traduction s’exécute sur le processeur\u00A0: le modèle de traduction ne tient pas dans ' +
    'la mémoire de cette carte graphique',
  'translate.device.title':
    'Où le modèle de traduction s’est exécuté lors de son dernier démarrage. Ce choix est refait ' +
    'à chaque démarrage (le modèle est déchargé environ 2\u00A0minutes après la dernière ' +
    'traduction).',
  'translate.device.partialTitle':
    'Pour placer une plus grande partie du modèle de traduction sur la carte graphique\u00A0: ' +
    'utilisez un modèle plus petit pour le Chat, ou arrêtez celui-ci avant de traduire. Le ' +
    'modèle de traduction se réajuste à son prochain démarrage (environ 2\u00A0minutes après la ' +
    'dernière traduction).',
  'translate.device.gpuNoneTitle':
    'Pour que le modèle de traduction puisse au moins en partie s’exécuter sur la carte ' +
    'graphique\u00A0: utilisez un modèle plus petit pour le Chat, ou arrêtez celui-ci avant de ' +
    'traduire. Le modèle de traduction se réajuste à son prochain démarrage (environ ' +
    '2\u00A0minutes après la dernière traduction).',
  'translate.err.noModel':
    'Le modèle de traduction n’est plus disponible. Ouvrez l’écran Modèle d’IA pour l’installer.',
  'translate.err.badRequest':
    'Choisissez une langue source et une langue cible, puis saisissez un texte à traduire.',
  'translate.err.busy':
    'Une traduction est déjà en cours. Attendez qu’elle soit terminée, puis réessayez.',
  'translate.err.docTaskBusy':
    'Une tâche est en cours sur un document. Attendez qu’elle soit terminée, puis lancez la ' +
    'traduction.',
  'translate.err.runtimeFailed':
    'Le modèle de traduction n’a pas pu terminer. Réessayez, éventuellement avec un texte plus ' +
    'court.',
  'translate.err.startFailed':
    'Le modèle de traduction n’a pas pu démarrer\u00A0: il n’y a peut-être plus assez de mémoire ' +
    'libre sur cet appareil. Fermez d’autres applications ou redémarrez HilbertRaum, puis ' +
    'réessayez.',
  'translate.err.engineCannotRun':
    'Le moteur d’IA ne peut pas fonctionner sur cet ordinateur. L’écran Modèle d’IA indique ce ' +
    'qui manque.',
  'translate.err.empty': 'Aucune traduction n’a été renvoyée. Réessayez, ou reformulez le texte.',
  'translate.err.sameLang': 'Choisissez deux langues différentes.',
  'translate.err.tooLong':
    'Le texte est trop long pour être traduit ici (plus de 200\u202F000 caractères). Divisez-le ' +
    'en parties plus petites, ou enregistrez-le dans un fichier et traduisez-le en tant que ' +
    'document.',
  // ---- Document drag-and-drop translation (TG-5, plan §2 D7) ----
  'translate.drop.title': 'Ou déposez un document à traduire',
  'translate.drop.choose': 'ou choisissez un document',
  'translate.drop.types':
    'PDF, Word, Markdown ou texte\u00A0: le document est traduit dans la langue choisie.',
  'translate.file.importing': 'Lecture du document…',
  'translate.file.progress': 'Traduction en cours… ({done}/{total})',
  'translate.file.preparing': 'Préparation de la traduction\u00A0: lecture du document…',
  'translate.file.saving': 'Enregistrement du document traduit…',
  'translate.file.truncated':
    'Seul le début de la traduction est affiché\u00A0: exportez-la ou ouvrez-la sur l’écran ' +
    'Documents pour voir le document entier.',
  'translate.file.export': 'Exporter…',
  'translate.file.exported': 'Document exporté',
  'translate.file.show': 'Afficher sur l’écran Documents',
  'translate.file.reset': 'Traduire un autre document',
  'translate.file.doneAnnounce': 'Traduction du document terminée. Le résultat est affiché.',
  'translate.file.gapPages.one':
    '⚠ La page {pages} de l’original n’a pas pu être traduite\u00A0: elle ne contient aucun ' +
    'texte lisible (il s’agit peut-être d’une page numérisée). Le résultat signale ce passage ' +
    'manquant.',
  'translate.file.gapPages.many':
    '⚠ Les pages {pages} de l’original n’ont pas pu être traduites\u00A0: elles ne contiennent ' +
    'aucun texte lisible (il s’agit peut-être de pages numérisées). Le résultat signale chaque ' +
    'passage manquant.',
  'translate.file.gapPages.other':
    '⚠ Les pages {pages} de l’original n’ont pas pu être traduites\u00A0: elles ne contiennent ' +
    'aucun texte lisible (il s’agit peut-être de pages numérisées). Le résultat signale chaque ' +
    'passage manquant.',
  'translate.file.failedParts.one':
    '⚠ {count} partie n’a pas pu être traduite\u00A0: le résultat conserve et signale le texte ' +
    'd’origine.',
  'translate.file.failedParts.many':
    '⚠ {count} parties n’ont pas pu être traduites\u00A0: le résultat conserve et signale le ' +
    'texte d’origine.',
  'translate.file.failedParts.other':
    '⚠ {count} parties n’ont pas pu être traduites\u00A0: le résultat conserve et signale le ' +
    'texte d’origine.',
  'translate.file.err.multiDrop': 'Déposez un seul document à la fois.',
  'translate.file.err.noPath':
    'Cet élément ne correspond à aucun fichier enregistré. Faites glisser un document depuis un ' +
    'dossier, ou utilisez le bouton «\u00A0choisissez un document\u00A0».',
  'translate.file.err.unsupported':
    'Ce type de fichier ne peut pas être traduit. Essayez un fichier PDF, Word, Markdown ou ' +
    'texte.',
  'translate.file.err.scanned':
    'Ce PDF semble être un document numérisé sans texte lisible. Rendez-le d’abord interrogeable ' +
    'sur l’écran Documents avec «\u00A0Rendre interrogeable (OCR)\u00A0», puis traduisez-le.',
  'translate.file.err.scannedAction': 'Ouvrir l’écran Documents',
  'translate.file.err.importFailed': 'Le document n’a pas pu être lu. Réessayez.',
  'translate.file.err.runtimeFailed': 'Le document n’a pas pu être traduit. Réessayez.',
  // ---- Evidence review (EP-1 plan §7 — ReviewScreen.tsx + chat entry points) ----
  'review.action.start': 'Vérifier les justificatifs',
  'review.action.continue': 'Poursuivre la vérification',
  'review.entry.sources': 'Vérifier la réponse et les sources',
  'review.status.draft': 'Brouillon',
  'review.status.ready': 'Clôturée',
  'review.status.outdated': 'Obsolète',
  'review.readonlyHint': 'Vérification clôturée\u00A0: rouvrez-la pour la modifier.',
  // ---- P4: Outdated banner + acknowledge (spec §15.5/§21.3/§28.6) ----
  'review.outdated.title': 'Cette vérification est obsolète.',
  'review.outdated.answerChanged':
    'Le texte de la réponse ne correspond plus à l’instantané vérifié.',
  'review.outdated.coverageChanged':
    'Les métadonnées de couverture enregistrées ne correspondent plus à l’instantané vérifié.',
  'review.outdated.sourcesChanged.one':
    '{count} document source a changé depuis la création de cette vérification.',
  'review.outdated.sourcesChanged.many':
    '{count} documents sources ont changé depuis la création de cette vérification.',
  'review.outdated.sourcesChanged.other':
    '{count} documents sources ont changé depuis la création de cette vérification.',
  'review.outdated.keepNote':
    'Vos décisions enregistrées restent inchangées. Vous pouvez conserver la vérification en ' +
    'l’état, prendre acte de la modification, ou poser de nouveau la question dans le Chat et ' +
    'commencer une nouvelle vérification.',
  'review.outdated.acknowledge': 'Prendre acte de la modification',
  'review.outdated.acknowledgedAt': 'Prise d’acte de la modification le {date}.',
  'review.outdated.exportHint':
    'Prenez acte de la modification avant d’exporter un pack de justificatifs.',
  'review.back': 'Retour au Chat',
  'review.rename': 'Renommer',
  'review.rename.label': 'Titre de la vérification',
  'review.rename.save': 'Enregistrer',
  'review.loading': 'Chargement de la vérification…',
  'review.notFound': 'Cette vérification est introuvable. Elle a peut-être été supprimée.',
  'review.question.toggle': 'Question',
  'review.answerPane.aria': 'Réponse en cours de vérification',
  'review.autosave.saving': 'Enregistrement…',
  'review.autosave.saved': 'Enregistré',
  'review.autosave.error': 'Certaines modifications n’ont pas encore pu être enregistrées.',
  'review.autosave.retry': 'Réessayer',
  'review.evidence.title': 'Justificatifs',
  'review.evidence.captionRelevance':
    'Les sources affichées sont les extraits fournis au modèle d’IA local pour cette réponse.',
  'review.evidence.captionWholeDoc':
    'Cette réponse a été obtenue par une analyse du document entier. Les sections affichées en ' +
    'indiquent la provenance\u00A0: ce ne sont pas des références phrase par phrase.',
  'review.evidence.captionStructured':
    'Cette réponse s’appuie sur des données extraites localement. Les extraits des sources dont ' +
    'proviennent ces données sont affichés ci-dessous.',
  'review.evidence.none':
    'Aucun extrait de source n’est conservé pour cette réponse. Vous pouvez enregistrer une ' +
    'vérification générale, mais la vérification source par source n’est pas possible.',
  'review.disclaimer':
    'Une référence indique d’où provient une information. Elle ne prouve pas à elle seule que la ' +
    'réponse est exacte.',
  'review.evidence.filterLabel': 'Filtrer les sources',
  'review.evidence.filterPlaceholder': 'Filtrer par titre ou par texte…',
  'review.evidence.filterClear': 'Effacer le filtre',
  'review.evidence.filterNone': 'Aucune source ne correspond à votre filtre.',
  'review.evidence.shownCount': 'Sources affichées\u00A0: {shown} sur {total}',
  'review.evidence.more.one': 'et {count} source de plus',
  'review.evidence.more.many': 'et {count} sources de plus',
  'review.evidence.more.other': 'et {count} sources de plus',
  'review.evidence.linkingItem': 'Justificatifs à lier au point de vérification {n}',
  'review.source.kind.direct_excerpt': 'Extrait direct',
  'review.source.kind.whole_document_provenance': 'Provenance\u00A0: document entier',
  'review.source.kind.structured_record': 'Données extraites',
  'review.source.unresolved': 'L’identité de la source n’a pas pu être déterminée',
  'review.source.archive':
    'Article d’un pack de connaissances\u00A0: son identité et son contenu ne peuvent pas être ' +
    'vérifiés par rapport à l’espace de travail',
  'review.source.missingAtCreation':
    'Source non disponible lors de la création de cette vérification',
  'review.source.changed': 'Le document source a changé depuis la création de cette vérification',
  'review.source.missingNow':
    'Cette source n’est plus dans l’espace de travail. L’extrait conservé reste dans cette ' +
    'vérification.',
  'review.source.cannotVerify': 'L’état actuel de cette source ne peut pas être vérifié',
  'review.sourceContext.open': 'Afficher la source dans son contexte',
  'review.sourceContext.title': 'Source dans son contexte',
  'review.sourceContext.loading': 'Chargement du texte enregistré…',
  'review.sourceContext.failed': 'Le texte enregistré de cette source n’a pas pu être chargé.',
  'review.sourceContext.hashMatch':
    'L’empreinte enregistrée du document correspond à l’instantané de la vérification.',
  'review.sourceContext.hashMismatch':
    'Le document source a changé depuis la création de cette vérification.',
  'review.sourceContext.hashUnknown':
    'L’état actuel du document ne peut pas être comparé à l’instantané de la vérification.',
  'review.sourceContext.missing':
    'Cette source était disponible lors de la génération de la réponse, mais elle n’est plus ' +
    'dans l’espace de travail. L’extrait conservé reste dans cette vérification, s’il est ' +
    'disponible.',
  'review.sourceContext.notLocated':
    'L’extrait conservé est introuvable dans le texte enregistré actuel. Il est affiché ' +
    'ci-dessous tel qu’il a été consigné lors de la création de la vérification.',
  'review.sourceContext.storedNote':
    'Le contexte provient du texte enregistré, extrait lors de l’importation\u00A0: le fichier ' +
    'du document lui-même n’est pas ouvert.',
  'review.sourceContext.excerptHeading': 'Extrait conservé',
  'review.link.add': 'Lier au point de vérification',
  'review.link.remove': 'Retirer le lien',
  'review.link.cited': 'Lié par une référence de la réponse',
  'review.link.reviewer': 'Lié lors de la vérification',
  'review.link.selectHint':
    'Sélectionnez un point de vérification pour lier des justificatifs ou retirer des liens.',
  'review.relation.label': 'Relation',
  'review.relation.none': 'Non précisée',
  'review.relation.supports': 'Étaye',
  'review.relation.qualifies': 'Nuance',
  'review.relation.contradicts': 'Contredit',
  'review.relation.context': 'Contexte uniquement',
  'review.item.aria': 'Point de vérification {n}',
  'review.item.noMarker': 'Aucune référence directe à une source dans ce texte',
  'review.item.wholeDocDerived': 'Provenance\u00A0: analyse du document entier',
  'review.item.noteLabel': 'Note',
  'review.item.notePlaceholder': 'Ajouter une note (facultatif)',
  'review.item.viewEvidence': 'Afficher les justificatifs',
  // ---- P5 reviewer text selections (spec §12.1 "Review separately"; plan §10) ----
  'review.selection.start': 'Vérifier un passage séparément',
  'review.selection.hint':
    'Sélectionnez le passage dans le texte original ci-dessous (affiché sans mise en forme), ' +
    'puis choisissez «\u00A0Vérifier séparément\u00A0».',
  'review.selection.surfaceAria': 'Texte original du point de vérification {n}',
  'review.selection.add': 'Vérifier séparément',
  'review.selection.close': 'Fermer',
  'review.selection.added': 'Passage ajouté comme point de vérification distinct.',
  'review.selection.refused':
    'Cette sélection n’a pas pu être ajoutée. Sélectionnez de nouveau le passage, puis réessayez.',
  'review.item.selectionTag': 'Texte sélectionné lors de la vérification',
  'review.selection.remove': 'Retirer la sélection',
  'review.decision.groupAria': 'Décision',
  'review.decision.supported': 'Vérifié – étayé',
  'review.decision.partly_supported': 'Vérifié – partiellement étayé',
  'review.decision.not_supported': 'Vérifié – non étayé',
  'review.decision.follow_up': 'À suivre',
  'review.decision.not_reviewed': 'Non vérifié',
  'review.decision.not_applicable': 'Sans objet',
  'review.bulk.menu': 'Actions groupées',
  'review.bulk.headingsNa': 'Marquer les titres comme «\u00A0Sans objet\u00A0»',
  'review.bulk.followUp': 'Marquer les points sans décision comme «\u00A0À suivre\u00A0»',
  'review.bulk.clear': 'Effacer toutes les décisions',
  'review.bulk.clearConfirmTitle': 'Effacer toutes les décisions\u00A0?',
  'review.bulk.clearConfirmBody':
    'Chaque décision de cette vérification revient à «\u00A0Non vérifié\u00A0». Les notes sont ' +
    'conservées.',
  'review.bulk.clearConfirm': 'Effacer les décisions',
  'review.progress': 'Décisions prises\u00A0: {decided} sur {required}',
  'review.progress.followUps.one': '{count} point à suivre',
  'review.progress.followUps.many': '{count} points à suivre',
  'review.progress.followUps.other': '{count} points à suivre',
  'review.footer.summary': 'Récapitulatif de la vérification',
  'review.summary.status': 'État',
  'review.summary.decisions': 'Décisions',
  'review.summary.sources': 'Sources',
  'review.summary.sourcesCount.one': '{count} source',
  'review.summary.sourcesCount.many': '{count} sources',
  'review.summary.sourcesCount.other': '{count} sources',
  'review.summary.sourcesUnresolved.one': '{count} source n’a pas pu être identifiée',
  'review.summary.sourcesUnresolved.many': '{count} sources n’ont pas pu être identifiées',
  'review.summary.sourcesUnresolved.other': '{count} sources n’ont pas pu être identifiées',
  'review.summary.sourcesArchive.one':
    '{count} source provient d’un article de pack de connaissances et ne peut pas être vérifiée ' +
    'par rapport à l’espace de travail',
  'review.summary.sourcesArchive.many':
    '{count} sources proviennent d’articles de packs de connaissances et ne peuvent pas être ' +
    'vérifiées par rapport à l’espace de travail',
  'review.summary.sourcesArchive.other':
    '{count} sources proviennent d’articles de packs de connaissances et ne peuvent pas être ' +
    'vérifiées par rapport à l’espace de travail',
  'review.summary.sourcesMissing.one':
    '{count} source n’était pas disponible lors de la création de cette vérification',
  'review.summary.sourcesMissing.many':
    '{count} sources n’étaient pas disponibles lors de la création de cette vérification',
  'review.summary.sourcesMissing.other':
    '{count} sources n’étaient pas disponibles lors de la création de cette vérification',
  'review.summary.sourcesChangedNow.one':
    '{count} document source a changé depuis la création de cette vérification',
  'review.summary.sourcesChangedNow.many':
    '{count} documents sources ont changé depuis la création de cette vérification',
  'review.summary.sourcesChangedNow.other':
    '{count} documents sources ont changé depuis la création de cette vérification',
  'review.summary.sourcesMissingNow.one':
    '{count} document source n’est plus dans l’espace de travail',
  'review.summary.sourcesMissingNow.many':
    '{count} documents sources ne sont plus dans l’espace de travail',
  'review.summary.sourcesMissingNow.other':
    '{count} documents sources ne sont plus dans l’espace de travail',
  'review.summary.truncated':
    'La réponse générée est peut-être incomplète\u00A0: elle a été coupée à la limite de sortie ' +
    'du modèle.',
  'review.summary.stopped.model':
    'La réponse générée est incomplète\u00A0: le modèle d’IA a été arrêté ou changé avant la fin ' +
    'de la réponse.',
  'review.summary.stopped.user':
    'La réponse générée est incomplète\u00A0: elle a été arrêtée avant d’être terminée.',
  'review.summary.stopped.lock':
    'La réponse générée est incomplète\u00A0: l’espace de travail a été verrouillé ou ' +
    'l’application fermée avant la fin de la réponse.',
  'review.summary.generation': 'Détails de la génération',
  'review.summary.model': 'Modèle',
  'review.summary.generatedAt': 'Date de génération',
  'review.summary.appVersion': 'Version de l’application',
  'review.summary.skill': 'Compétence',
  'review.summary.unavailable': 'Non disponible',
  'review.summary.reviewerLabel': 'Vérifié par',
  'review.summary.reviewerPlaceholder': 'Votre nom ou une désignation (facultatif)',
  'review.summary.generalNote': 'Note générale',
  'review.summary.generalNotePlaceholder': 'Observations d’ensemble (facultatif)',
  'review.summary.exports': 'Historique des exportations',
  'review.summary.markReady': 'Clôturer la vérification',
  'review.summary.reopen': 'Rouvrir la vérification',
  'review.summary.gateHint':
    'Chaque bloc de la réponse doit recevoir une décision avant que la vérification puisse être ' +
    'clôturée (décisions prises\u00A0: {decided} sur {required}). «\u00A0Sans objet\u00A0» ' +
    'compte comme une décision.',
  'review.toast.ready': 'Vérification clôturée.',
  'review.completedAt': 'Clôturée le {date}',
  'review.deleteWithConversation.one':
    '{count} vérification des justificatifs liée à cette conversation sera également supprimée.',
  'review.deleteWithConversation.many':
    '{count} vérifications des justificatifs liées à cette conversation seront également ' +
    'supprimées.',
  'review.deleteWithConversation.other':
    '{count} vérifications des justificatifs liées à cette conversation seront également ' +
    'supprimées.',
  'review.deleteWithConversation.unknown':
    'Les éventuelles vérifications des justificatifs liées à cette conversation seront également ' +
    'supprimées.',
  // ---- Evidence-pack export (EP-1 plan §8 — summary panel + status line) ----
  'review.status.lastExported': 'Dernière exportation\u00A0: {date}',
  'review.export.action': 'Créer un pack de justificatifs',
  'review.export.title': 'Exporter le pack de justificatifs',
  'review.export.encryptionWarning':
    'Ce fichier exporté est enregistré en dehors de l’espace de travail chiffré de HilbertRaum ' +
    'et n’est pas protégé par le mot de passe de votre espace de travail.',
  'review.export.packLanguage.en': 'Ce pack sera rédigé en anglais.',
  'review.export.packLanguage.de': 'Ce pack sera rédigé en allemand.',
  'review.export.options': 'Inclure dans le pack',
  'review.export.optNotes': 'Notes de vérification',
  'review.export.optExcerpts': 'Extraits des sources',
  'review.export.optHashes': 'Empreintes des documents',
  'review.export.optUnreviewed': 'Points non vérifiés',
  'review.export.optTechnical': 'Détails techniques',
  'review.export.format': 'Format de fichier',
  'review.export.formatHtml': 'HTML – page web autonome',
  'review.export.formatPdf': 'PDF – prêt à imprimer (A4)',
  'review.export.confirm': 'Exporter le pack…',
  'review.export.cancel': 'Fermer',
  'review.export.done': 'Pack de justificatifs exporté.',
  'review.export.error':
    'Le pack de justificatifs n’a pas pu être exporté. Aucun fichier n’a été écrit.',
  'review.export.copyHash': 'Copier la somme SHA-256',
  'review.export.hashCopied': 'Somme SHA-256 copiée dans le presse-papiers.'
}
