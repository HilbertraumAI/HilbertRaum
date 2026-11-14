import type { UiCatalog } from './languages'

// The UKRAINIAN catalog (interface only; the code is `uk`). Typed `UiCatalog<'uk'>`: a missing,
// stale or extra key is a typecheck failure. `packExport.*` is not part of it (evidence packs
// stay en/de). Four plural forms per base: one, few, many, other (other = fractions only).
//
// Style (design-guidelines §7 "Ukrainian microcopy"): formal «ви», lower case. Action controls
// take the infinitive («Зберегти»), instructions the «ви» imperative («Виберіть»), states the
// impersonal -но/-то form («Збережено»). The app never speaks in the first-person past tense
// (it is gendered). The copy ADAPTS the calm spec-§11.4 tone. Quotes «…» („…“ only inside),
// apostrophe U+02BC (never U+2019 or '), ellipsis …, spaced em dash « — ». No ending is ever
// glued to a {placeholder}. "HilbertRaum" is never translated and never declined.
// Ukrainian only: no word, spelling or calque taken from another Slavic catalog.
//
// Glossary — keep terms consistent across ALL Ukrainian copy:
//   workspace                  → робочий простір
//   drive / disk               → диск («на цьому диску», «з цього диска»)
//   vault / encrypted workspace→ зашифрований робочий простір
//   model                      → модель (AI model → ШІ-модель; AI engine → ШІ-рушій)
//   document                   → документ
//   re-index                   → переіндексувати
//   offline                    → офлайн (Offline Mode → офлайн-режим)
//   "Ask my documents"         → «Запитати мої документи»
//   lock / unlock              → заблокувати / розблокувати
//   password                   → пароль
//   settings                   → Параметри («налаштування» is the act of setting up)
//   plaintext (developer) mode → незашифрований (для розробників)
//   app / skill / knowledge pack → застосунок / навичка / пакет знань
//   download                   → завантажити — ONLY downloads; loading is «запуск» (a model),
//                                «відкриття» (a list, the workspace) or «Зачекайте…»
//   delete / remove / cancel   → видалити / прибрати / скасувати
//   on / off / default         → увімкнено / вимкнено / типово
//
// Evidence-review glossary (MIRROR of the canonical record in design-guidelines §7; change BOTH
// together):
//   evidence                   → обґрунтування — never «докази», never «підтвердження»
//   review (the artifact)      → перевірка (evidence review → перевірка обґрунтування)
//   review item                → пункт перевірки
//   evidence pack              → пакет обґрунтування
//   citation / source marker   → посилання на джерело (never «цитата»)
//   whole-document provenance  → походження з аналізу всього документа; the negation is always
//                                «без посилань на джерела для окремих речень»
//   direct excerpt             → прямий уривок
//   source / source document   → джерело / документ-джерело
//   reviewer                   → Особа, яка перевіряє (label and prose); compounds «перевірки»,
//                                «під час перевірки»
//   mark ready / reopen        → Завершити перевірку / Знову відкрити перевірку
//   outdated                   → застаріла
//   review creation            → the review is «розпочата», the ANSWER is «згенерована» —
//                                never mixed, never «створена»
//   supported-ness             → «обґрунтовано / частково обґрунтовано / не обґрунтовано»;
//                                «доводити» only in negated disclaimers
//   check / verify elsewhere   → a verb («Перевірити ще раз») or «Звірити контрольну суму»; the
//                                bare noun «Перевірка» belongs to the Review screen

export const uk: UiCatalog<'uk'> = {
  // ---- App shell (App.tsx) ----
  'nav.aria': 'Основна навігація',
  'nav.home': 'Головна',
  'nav.chat': 'Чат',
  'nav.documents': 'Документи',
  'nav.translate': 'Переклад',
  'nav.images': 'Зображення',
  'nav.models': 'ШІ-модель',
  'nav.performance': 'Швидкодія',
  'nav.settings': 'Параметри',
  'app.lockNow': 'Заблокувати',
  'app.lockNowTitle': 'Знову зашифрувати й заблокувати робочий простір',
  'app.noticeDetails': 'Докладніше',
  'app.noticeGoToModels': 'Відкрити ШІ-модель',
  'app.fatal.title': 'Не вдалося запустити застосунок',
  'app.fatal.hintBefore':
    'Локальна серверна частина не запустилася, тому нічого не вдасться відкрити. Перезапустіть ' +
    'застосунок; якщо це повторюється, перегляньте файл ',
  'app.fatal.hintAfter': ' на вашому диску та прочитайте документ «docs/troubleshooting.md».',
  'app.loadingWorkspace': 'Відкриття робочого простору…',
  'app.loadingScreen': 'Зачекайте…',
  // ---- Error boundary (ErrorBoundary.tsx — audit FE-1) ----
  'errorBoundary.title': 'На цьому екрані щось пішло не так',
  'errorBoundary.body':
    'На цьому екрані виникла неочікувана проблема. Ваша робота та ваші дані в безпеці — нічого ' +
    'не втрачено. Спробуйте ще раз або поверніться на екран «Головна».',
  'errorBoundary.retry': 'Спробувати ще раз',
  'errorBoundary.home': 'Відкрити екран «Головна»',
  'errorBoundary.app.title': 'У застосунку виникла проблема',
  'errorBoundary.app.body':
    'Сталося щось неочікуване. Ваші дані на диску в безпеці. Щоб продовжити, перезавантажте ' +
    'застосунок.',
  'errorBoundary.app.reload': 'Перезавантажити',
  // ---- Home (HomeScreen.tsx) ----
  'home.headline.ready': 'Усе готово до розмови.',
  'home.headline.starting': 'Підготовка…',
  'home.headline.almost': 'Налаштування майже завершено.',
  'home.lead':
    'Приватний робочий простір зі ШІ, що працює офлайн. Ваші запити, документи та історія чатів ' +
    'залишаються на цьому пристрої.',
  'home.preflight.continue':
    'Можна все одно продовжити. Якщо застосунок не відкривається, прочитайте посібник з усунення ' +
    'несправностей у папці {folder} на диску.',
  'home.moved.restored':
    'Цей диск востаннє використовували на іншому компʼютері. Показники для цього компʼютера ' +
    'взято з попереднього тесту (виконано {when}) — цього разу нічого не вимірювалося.',
  'home.moved.restoredUndated':
    'Цей диск востаннє використовували на іншому компʼютері. Показники для цього компʼютера ' +
    'взято з попереднього тесту — цього разу нічого не вимірювалося.',
  'home.moved.measuring':
    'Цей диск ще не використовували на цьому компʼютері. У фоновому режимі триває тест; коли він ' +
    'завершиться, показники зʼявляться на екрані «Швидкодія».',
  'home.moved.owed':
    'Цей диск ще не перевіряли на цьому компʼютері, тому показників для нього немає.',
  'home.checking': 'Перевіряється…',
  'home.workspace.label': 'Робочий простір',
  'home.workspace.encrypted': 'Зашифровано — коли застосунок закрито, заблоковано вашим паролем',
  'home.workspace.plaintext': 'Незашифрований (режим для розробників)',
  'home.workspace.badgeProtected': 'Захищено',
  'home.workspace.badgeDeveloper': 'Для розробників',
  'home.model.label': 'ШІ-модель',
  'home.model.fallbackName': 'Ваша модель',
  'home.model.running': '{model} працює на цьому пристрої',
  'home.model.selected': 'Вибрано: {model} — можливо, модель ще запускається',
  'home.model.none': 'Модель ще не вибрано',
  'home.model.badgeRunning': 'Працює',
  'home.model.badgeStarting': 'Запуск',
  'home.model.badgeNeedsModel': 'Потрібна модель',
  'home.model.open': 'Відкрити ШІ-модель',
  'home.model.engineCannotRun':
    'ШІ-рушій не може працювати на цьому компʼютері — відповіді імітуються',
  'home.model.badgeEngine': 'Не працює',
  'home.model.demo': '{model} працює в демонстраційному режимі — відповіді імітуються',
  'home.model.badgeDemo': 'Демонстрація',
  'home.model.choose': 'Вибрати модель',
  'home.docs.label': 'Документи',
  'home.docs.none': 'Документів ще немає — додайте кілька, щоб ставити до них запитання',
  'home.docsReady.one': '{count} документ готовий до запитань',
  'home.docsReady.few': '{count} документи готові до запитань',
  'home.docsReady.many': '{count} документів готові до запитань',
  'home.docsReady.other': '{count} документа готові до запитань',
  'home.docs.badgeReady': 'Готово',
  'home.docs.badgeNone': 'Ще немає',
  'home.docs.add': 'Додати документи',
  'home.packs.label': 'Пакети знань',
  'home.packsReady.one': '{count} пакет знань готовий до запитань',
  'home.packsReady.few': '{count} пакети знань готові до запитань',
  'home.packsReady.many': '{count} пакетів знань готові до запитань',
  'home.packsReady.other': '{count} пакета знань готові до запитань',
  'home.packs.none':
    'Пакетів знань ще немає — додайте офлайн-версію Вікіпедії, щоб ставити загальні запитання',
  'home.packs.noneReady':
    'Жоден пакет знань не готовий до запитань — перевірте їх на екрані «Документи»',
  'home.packs.badgeNoneReady': 'Немає готових',
  'home.packs.add': 'Додати пакети',
  'home.packs.open': 'Відкрити пакети знань',
  'home.actions.startChat': 'Почати чат',
  'home.actions.askDocs': 'Запитати мої документи',
  // ---- Chat (ChatScreen.tsx) ----
  'chat.title': 'Чат',
  'chat.noModel.title': 'Модель не запущено',
  'chat.noModel.startingTitle': 'ШІ-модель запускається',
  'chat.noModel.hintBefore':
    'Для чату та запитань до документів потрібна запущена модель. Відкрийте екран «ШІ-модель», ' +
    'виберіть завантажену модель і натисніть кнопку ',
  'chat.noModel.hintAction': 'Вибрати цю модель',
  'chat.noModel.hintAfter':
    '. Усе залишається на цьому пристрої — нічого не завантажується й не надсилається через ' +
    'інтернет.',
  'chat.noModel.stillLoading':
    'Якщо ви щойно відкрили застосунок, вибрана модель, можливо, ще запускається. Щойно вона ' +
    'буде готова, екран оновиться автоматично.',
  'chat.noModel.starting':
    'Ваша модель запускається — великим моделям на запуск потрібно трохи часу. Щойно вона буде ' +
    'готова, екран оновиться автоматично.',
  'chat.noModel.startingProgress':
    'Ваша модель запускається — триває читання файлу моделі ({gb}\u00A0GB), уже прочитано близько ' +
    '{pct}%. Щойно модель буде готова, екран оновиться автоматично.',
  'chat.noModel.open': 'Відкрити ШІ-модель',
  'chat.noModel.recheck': 'Перевірити ще раз',
  'chat.empty.title': 'Поставте запитання або запитайте про свої документи.',
  'chat.empty.lineDocuments':
    'Відповіді беруться з ваших документів і містять посилання на джерела.',
  'chat.empty.lineChat':
    'Відповіді надходять від моделі на цьому диску — ніщо не виходить за межі цього пристрою.',
  'chat.empty.fillTitle': 'Вставити в поле повідомлення',
  'chat.empty.addDocs': 'Додати документи, щоб запитувати про них',
  'chat.exampleChat.explain': 'Поясніть поняття простими словами',
  'chat.exampleChat.draftEmail': 'Допоможіть написати ввічливий лист',
  'chat.exampleChat.brainstorm': 'Запропонуйте ідеї для проєкту',
  'chat.example.summarize': 'Підсумуйте цей документ',
  'chat.example.paymentTerms': 'Які умови оплати?',
  'chat.example.indemnity': 'Знайдіть усі згадки про «відшкодування»',
  'chat.modeAria': 'Режим чату',
  'chat.mode.chat': 'Чат',
  'chat.mode.documents': 'Запитати мої документи',
  'chat.listShow': 'Показати список розмов',
  'chat.runtime.gpu': '{model} · GPU ({name})',
  'chat.runtime.cpu': '{model} · CPU',
  'chat.runtime.cpuCompat': '{model} · CPU (режим сумісності)',
  'chat.runtime.demo': '{model} · демонстрація',
  'chat.runtime.title':
    'ШІ-модель, яка відповідає в цьому чаті, і де вона працює: на відеокарті (GPU) чи на ' +
    'процесорі (CPU). Докладніше: Параметри → Діагностика.',
  'chat.runtime.compatTitle':
    'Для стабільності увімкнено режим сумісності, тому відповіді обчислюються на процесорі й ' +
    'можуть бути повільнішими. Знову спробувати відеокарту можна тут: Параметри → Діагностика.',
  'chat.convOptions': 'Дії з розмовою',
  'chat.saveConversation': 'Зберегти цю розмову',
  'chat.savedTo': 'Збережено: {path}',
  'chat.copied': 'Скопійовано',
  'chat.copyFailed': 'Не вдалося скопіювати в буфер обміну',
  'chat.transcript.label': 'Текст розмови',
  'chat.stopped': 'Зупинено — відповідь може бути неповною',
  'chat.warmup.hint':
    'Перша відповідь потребує трохи більше часу — модель готується до роботи. Наступні відповіді ' +
    'будуть швидшими.',
  'chat.scopeNotice': 'Відповіді лише з документів: {titles}',
  'chat.cancelDocTask': 'Скасувати завдання з документом',
  'chat.placeholder.documents': 'Запитайте про свої документи…',
  'chat.placeholder.chat': 'Повідомлення…',
  'chat.send.ask': 'Запитати',
  'chat.send.send': 'Надіслати',
  'chat.composer.stop': 'Зупинити',
  // ---- Chat: conversation list (ConversationList.tsx) ----
  'chat.list.title': 'Розмови',
  'chat.list.aria': 'Історія розмов',
  'chat.list.newChat': '+ Новий чат',
  'chat.list.newDocQa': '+ Нові запитання до документів',
  'chat.list.hide': 'Сховати список розмов',
  'chat.list.empty': 'Розмов ще немає.',
  'chat.list.docMeta': 'Документи',
  'chat.list.otherGroup': 'Інше / Бібліотека',
  'chat.list.rowOptionsAria': 'Дії з розмовою «{title}»',
  'chat.search.placeholder': 'Пошук розмов…',
  'chat.search.aria': 'Пошук розмов',
  'chat.search.resultsAria': 'Результати пошуку',
  'chat.search.resultsFor': 'Результати за запитом «{query}»',
  'chat.search.noMatches': 'Збігів не знайдено. Спробуйте сформулювати інакше.',
  'chat.search.count.one': '{count} результат',
  'chat.search.count.few': '{count} результати',
  'chat.search.count.many': '{count} результатів',
  'chat.search.count.other': '{count} результату',
  'chat.group.today': 'Сьогодні',
  'chat.group.yesterday': 'Учора',
  'chat.group.last7days': 'Останні 7 днів',
  'chat.group.earlier': 'Раніше',
  'chat.delete.menuItem': 'Видалити розмову',
  'chat.delete.title': 'Видалити цю розмову?',
  'chat.delete.confirm': 'Видалити',
  'chat.delete.body': 'Чат «{title}» і його повідомлення буде остаточно видалено з цього диска.',
  // ---- Chat: answer depth (DepthMenu.tsx; ids stay fast|balanced|deep) ----
  'chat.depth.trigger': 'Відповідь: {label}',
  'chat.depth.fast': 'Швидка',
  'chat.depth.balanced': 'Збалансована',
  'chat.depth.deep': 'Ґрунтовна',
  'chat.depth.fastHint': 'Короткі відповіді по суті',
  'chat.depth.balancedHint': 'Типовий варіант на кожен день',
  'chat.depth.deepHint': 'Модель обмірковує питання перед відповіддю — це триває довше',
  // ---- Chat: skill picker + per-message glyph (skills plan §10/§15) ----
  'chat.skill.trigger': 'Навичка: {label}',
  'chat.skill.none': 'Без навички',
  'chat.skill.suggested': 'Пропозиція: {title} — використати?',
  'chat.skill.suggestedHint': 'Пропозиція: {title}',
  'chat.skill.used': 'Навичка: {title}',
  'chat.skill.usedTitle': 'Цю відповідь сформувала навичка «{title}».',
  'chat.skill.autoFired': 'Відповідь з навичкою «{title}»',
  'chat.skill.autoFiredTitle':
    'Застосунок автоматично використав для цієї відповіді навичку «{title}». Відповідь можна ' +
    'отримати й без неї.',
  'chat.skill.answerWithout': 'Відповісти без неї',
  'chat.skill.answerWithoutBlockedByReview':
    'Для цієї відповіді є перевірка обґрунтування. Повторна відповідь видалить перевірку разом з ' +
    'її рішеннями й нотатками.',
  'chat.skill.removed': '(навичку видалено)',
  'chat.skill.offer.lead': 'Схоже, з цим допоможе навичка.',
  'chat.skill.offer.run': 'Запустити навичку «{title}» для цього запитання',
  'chat.skill.offer.model': 'Запропонувала локальна модель',
  'chat.skill.offer.unavailable':
    'Цю навичку вимкнено або видалено. Увімкніть її на вкладці «Навички», щоб запустити.',
  'chat.skill.clear': 'Прибрати навичку «{title}»',
  'chat.skill.keep': 'Залишити для цієї розмови',
  'chat.skill.infoButton': 'Про навичку «{title}»',
  'chat.skill.info.close': 'Сховати це пояснення',
  'chat.skill.info.needsLabel': 'Потрібно:',
  'chat.skill.info.limitsLabel': 'Майте на увазі:',
  'chat.skill.info.perTurn':
    'Навичка діє для ваших запитань у цьому чаті, доки ви її не зміните або не приберете. ' +
    'Прапорець «Залишити для цієї розмови» також зберігає її на майбутнє.',
  'chat.skill.info.learnMore': 'Дізнатися більше',
  'chat.skill.tool.extractTransactions': 'Витягти транзакції',
  'chat.skill.tool.validateBalances': 'Перевірити залишки',
  'chat.skill.tool.categorize': 'Розподілити за категоріями',
  'chat.skill.tool.summarize': 'Підсумувати рух коштів',
  'chat.skill.tool.exportCsv': 'Експортувати в CSV',
  'chat.skill.tool.extractInvoice': 'Витягти дані рахунку на оплату',
  'chat.skill.tool.validateInvoiceTotals': 'Перевірити загальні суми',
  'chat.skill.tool.exportInvoiceCsv': 'Експортувати в CSV',
  'chat.skill.tool.exportInvoiceJson': 'Експортувати в JSON',
  'chat.skill.tool.exportInvoiceXml': 'Експортувати в XML',
  'chat.skill.tool.redactDocument': 'Приховати персональні дані',
  'chat.skill.tool.applyDocumentEdits': 'Застосувати зміни до тексту',
  'chat.skill.categorize.breakdownQuestion': 'Розподіліть мої витрати за категоріями.',
  'chat.skill.summarize.question': 'Підсумуйте мої доходи й витрати.',
  'chat.skill.run.running.one': 'Виконується: {tool} ({count} документ)…',
  'chat.skill.run.running.few': 'Виконується: {tool} ({count} документи)…',
  'chat.skill.run.running.many': 'Виконується: {tool} ({count} документів)…',
  'chat.skill.run.running.other': 'Виконується: {tool} ({count} документа)…',
  'chat.skill.run.runningOn': 'Виконується: {tool} ({document})…',
  'chat.skill.run.chooseDocument': 'Вибрати цільовий документ',
  'chat.skill.run.thisDocument': 'цей документ',
  'chat.skill.run.cancel': 'Скасувати',
  'chat.skill.run.done.one': 'Витягнуто {count} транзакцію.',
  'chat.skill.run.done.few': 'Витягнуто {count} транзакції.',
  'chat.skill.run.done.many': 'Витягнуто {count} транзакцій.',
  'chat.skill.run.done.other': 'Витягнуто {count} транзакції.',
  'chat.skill.run.done.categorize.one': 'Розподілено за категоріями {count} транзакцію.',
  'chat.skill.run.done.categorize.few': 'Розподілено за категоріями {count} транзакції.',
  'chat.skill.run.done.categorize.many': 'Розподілено за категоріями {count} транзакцій.',
  'chat.skill.run.done.categorize.other': 'Розподілено за категоріями {count} транзакції.',
  'chat.skill.run.done.summarize.one': 'Підсумовано {count} транзакцію.',
  'chat.skill.run.done.summarize.few': 'Підсумовано {count} транзакції.',
  'chat.skill.run.done.summarize.many': 'Підсумовано {count} транзакцій.',
  'chat.skill.run.done.summarize.other': 'Підсумовано {count} транзакції.',
  'chat.skill.run.done.export.one': 'Збережено {count} рядок.',
  'chat.skill.run.done.export.few': 'Збережено {count} рядки.',
  'chat.skill.run.done.export.many': 'Збережено {count} рядків.',
  'chat.skill.run.done.export.other': 'Збережено {count} рядка.',
  'chat.skill.run.done.reconciled': 'Залишки сходяться.',
  'chat.skill.run.done.unreconciled.one':
    '{count} рядок не сходиться — перевірте перед використанням.',
  'chat.skill.run.done.unreconciled.few':
    '{count} рядки не сходяться — перевірте перед використанням.',
  'chat.skill.run.done.unreconciled.many':
    '{count} рядків не сходяться — перевірте перед використанням.',
  'chat.skill.run.done.unreconciled.other':
    '{count} рядка не сходяться — перевірте перед використанням.',
  'chat.skill.run.done.unchecked':
    'У виписці немає проміжних залишків, з якими можна було б звірити дані.',
  'chat.skill.run.done.extractInvoice.one': 'Витягнуто {count} позицію.',
  'chat.skill.run.done.extractInvoice.few': 'Витягнуто {count} позиції.',
  'chat.skill.run.done.extractInvoice.many': 'Витягнуто {count} позицій.',
  'chat.skill.run.done.extractInvoice.other': 'Витягнуто {count} позиції.',
  'chat.skill.run.done.invoiceReconciled': 'Загальні суми рахунку на оплату сходяться.',
  'chat.skill.run.done.invoiceUnreconciled.one':
    '{count} загальна сума не сходиться — перевірте перед використанням.',
  'chat.skill.run.done.invoiceUnreconciled.few':
    '{count} загальні суми не сходяться — перевірте перед використанням.',
  'chat.skill.run.done.invoiceUnreconciled.many':
    '{count} загальних сум не сходяться — перевірте перед використанням.',
  'chat.skill.run.done.invoiceUnreconciled.other':
    '{count} загальної суми не сходяться — перевірте перед використанням.',
  'chat.skill.run.done.invoiceUnchecked':
    'У рахунку на оплату немає загальних сум, з якими можна було б звірити дані.',
  'chat.skill.run.done.redacted.one':
    'Збережено копію з прихованими даними — приховано {count} елемент. Зроблено в міру ' +
    'можливостей, без гарантії — перевірте копію перед поширенням.',
  'chat.skill.run.done.redacted.few':
    'Збережено копію з прихованими даними — приховано {count} елементи. Зроблено в міру ' +
    'можливостей, без гарантії — перевірте копію перед поширенням.',
  'chat.skill.run.done.redacted.many':
    'Збережено копію з прихованими даними — приховано {count} елементів. Зроблено в міру ' +
    'можливостей, без гарантії — перевірте копію перед поширенням.',
  'chat.skill.run.done.redacted.other':
    'Збережено копію з прихованими даними — приховано {count} елемента. Зроблено в міру ' +
    'можливостей, без гарантії — перевірте копію перед поширенням.',
  'chat.skill.run.done.redactedClean':
    'Персональних даних не виявлено; копію збережено. Зроблено в міру можливостей, без гарантії ' +
    '— перевірте копію перед поширенням.',
  'chat.skill.run.done.redactedFloor.one':
    'Збережено копію з прихованими даними — приховано {count} елемент (лише офлайн-виявлення за ' +
    'правилами, модель не запущено). Перевірте копію перед поширенням.',
  'chat.skill.run.done.redactedFloor.few':
    'Збережено копію з прихованими даними — приховано {count} елементи (лише офлайн-виявлення за ' +
    'правилами, модель не запущено). Перевірте копію перед поширенням.',
  'chat.skill.run.done.redactedFloor.many':
    'Збережено копію з прихованими даними — приховано {count} елементів (лише офлайн-виявлення ' +
    'за правилами, модель не запущено). Перевірте копію перед поширенням.',
  'chat.skill.run.done.redactedFloor.other':
    'Збережено копію з прихованими даними — приховано {count} елемента (лише офлайн-виявлення за ' +
    'правилами, модель не запущено). Перевірте копію перед поширенням.',
  'chat.skill.run.done.redactedCleanFloor':
    'Персональних даних не виявлено (лише офлайн-виявлення за правилами, модель не запущено); ' +
    'копію збережено. Перевірте копію перед поширенням.',
  'chat.skill.run.done.redactedCapped.one':
    'Збережено копію з прихованими даними — приховано {count} елемент. Цей документ дуже ' +
    'великий, тому автоматичне виявлення зупинилося на своїй межі, і далі в тексті дані можуть ' +
    'лишитися неприхованими — перевірте всю копію перед поширенням.',
  'chat.skill.run.done.redactedCapped.few':
    'Збережено копію з прихованими даними — приховано {count} елементи. Цей документ дуже ' +
    'великий, тому автоматичне виявлення зупинилося на своїй межі, і далі в тексті дані можуть ' +
    'лишитися неприхованими — перевірте всю копію перед поширенням.',
  'chat.skill.run.done.redactedCapped.many':
    'Збережено копію з прихованими даними — приховано {count} елементів. Цей документ дуже ' +
    'великий, тому автоматичне виявлення зупинилося на своїй межі, і далі в тексті дані можуть ' +
    'лишитися неприхованими — перевірте всю копію перед поширенням.',
  'chat.skill.run.done.redactedCapped.other':
    'Збережено копію з прихованими даними — приховано {count} елемента. Цей документ дуже ' +
    'великий, тому автоматичне виявлення зупинилося на своїй межі, і далі в тексті дані можуть ' +
    'лишитися неприхованими — перевірте всю копію перед поширенням.',
  'chat.skill.run.done.edited.one':
    'Застосовано {count} зміну й збережено відредаговану копію. Перевірте копію перед поширенням.',
  'chat.skill.run.done.edited.few':
    'Застосовано {count} зміни й збережено відредаговану копію. Перевірте копію перед поширенням.',
  'chat.skill.run.done.edited.many':
    'Застосовано {count} змін і збережено відредаговану копію. Перевірте копію перед поширенням.',
  'chat.skill.run.done.edited.other':
    'Застосовано {count} зміни й збережено відредаговану копію. Перевірте копію перед поширенням.',
  'chat.skill.run.done.editedPartial.one':
    'Застосовано {count} зміну; частину потрібного тексту не знайдено й пропущено. Збережено ' +
    'відредаговану копію — перевірте копію перед поширенням.',
  'chat.skill.run.done.editedPartial.few':
    'Застосовано {count} зміни; частину потрібного тексту не знайдено й пропущено. Збережено ' +
    'відредаговану копію — перевірте копію перед поширенням.',
  'chat.skill.run.done.editedPartial.many':
    'Застосовано {count} змін; частину потрібного тексту не знайдено й пропущено. Збережено ' +
    'відредаговану копію — перевірте копію перед поширенням.',
  'chat.skill.run.done.editedPartial.other':
    'Застосовано {count} зміни; частину потрібного тексту не знайдено й пропущено. Збережено ' +
    'відредаговану копію — перевірте копію перед поширенням.',
  'chat.skill.run.done.editedNone':
    'Потрібного тексту не знайдено — нічого не змінено, копію не збережено.',
  'chat.skill.run.done.editedCapped.one':
    'Застосовано {count} зміну. Цей документ дуже великий, тому пошук місць для змін зупинився ' +
    'на своїй межі — перевірте копію: далі в тексті деякі місця можуть лишитися без змін.',
  'chat.skill.run.done.editedCapped.few':
    'Застосовано {count} зміни. Цей документ дуже великий, тому пошук місць для змін зупинився ' +
    'на своїй межі — перевірте копію: далі в тексті деякі місця можуть лишитися без змін.',
  'chat.skill.run.done.editedCapped.many':
    'Застосовано {count} змін. Цей документ дуже великий, тому пошук місць для змін зупинився на ' +
    'своїй межі — перевірте копію: далі в тексті деякі місця можуть лишитися без змін.',
  'chat.skill.run.done.editedCapped.other':
    'Застосовано {count} зміни. Цей документ дуже великий, тому пошук місць для змін зупинився ' +
    'на своїй межі — перевірте копію: далі в тексті деякі місця можуть лишитися без змін.',
  'chat.skill.run.failedGeneric': 'Не вдалося. Нічого не змінено.',
  'chat.skill.run.error.unavailable': 'Цей інструмент недоступний.',
  'chat.skill.run.error.needsExtraction':
    'Спершу прочитайте документ кнопкою «{button}», а потім запустіть цей інструмент.',
  'chat.skill.run.error.persistFailed': 'Не вдалося зберегти. Нічого не змінено.',
  'chat.skill.run.error.exportWriteFailed': 'Не вдалося зберегти файл. Нічого не змінено.',
  'chat.skill.run.error.needsModel':
    'Спершу запустіть модель — для точкових змін потрібна запущена модель, яка знайде текст, що ' +
    'треба змінити.',
  'chat.skill.run.error.needsInstruction':
    'Спершу напишіть, що змінити (наприклад, «замініть X на Y»), а потім запустіть це ще раз.',
  'chat.skill.run.error.editFailed': 'Не вдалося завершити зміни. Нічого не змінено.',
  'chat.skill.run.error.redactionModelStopped':
    'ШІ-модель зупинилася, перш ніж приховування даних було завершено. Нічого не збережено. ' +
    'Запустіть приховування ще раз — якщо це повторюється, перезапустіть модель на екрані ' +
    '«ШІ-модель».',
  'chat.skill.run.error.redactionTooLong':
    'Частини цього документа задовгі для контекстного вікна поточної моделі. Нічого не ' +
    'збережено. Виберіть більший розмір контексту на екрані «ШІ-модель», перезапустіть модель, а ' +
    'потім запустіть приховування ще раз.',
  'chat.skill.run.cancelled': 'Зупинено. Нічого не збережено.',
  'chat.skill.run.stateUnknown':
    'Не вдалося дізнатися стан цієї навички — її результат може бути неповним.',
  'chat.skill.run.otherChatBusy': 'В іншому чаті працює навичка.',
  'chat.skill.run.categorizeOffer': 'Розподілити транзакції за категоріями',
  'chat.skill.run.dismiss': 'Сховати',
  'chat.skill.confirm.title': 'Запустити цей інструмент?',
  'chat.skill.confirm.body':
    'Буде створено або експортовано файл на основі документів на цьому диску.',
  'chat.skill.confirm.target': 'Документ: {document}',
  'chat.skill.confirm.outputDocx': 'Збережена копія матиме формат Word, як і цей документ (.docx).',
  'chat.skill.confirm.redactionScope':
    'Приховування охоплює текст документа (зокрема верхні й нижні колонтитули, виноски, примітки ' +
    'та відстежувані виправлення), а також видаляє метадані автора й адреси посилань. ' +
    'Зображення, скановані сторінки та вбудовані обʼєкти не перевіряються — перевірте збережену ' +
    'копію перед поширенням.',
  'chat.skill.confirm.outputText':
    'Збережена копія буде звичайним текстом (.txt) — початковий макет і форматування не ' +
    'збережуться.',
  'chat.skill.confirm.outputMatrix':
    'Документи Word (.docx) зберігають свій формат; PDF-файли та файли інших форматів ' +
    'зберігаються як текстова копія (.txt).',
  'chat.skill.confirm.ok': 'Запустити',
  // ---- Chat: transcript + message actions ----
  'chat.role.user': 'Ви',
  'chat.role.assistant': 'HilbertRaum',
  'chat.thinking': 'Модель думає…',
  'chat.actions.tryAgain': 'Спробувати ще раз',
  'chat.actions.sendAgain': 'Надіслати ще раз',
  'chat.actions.copy': 'Скопіювати',
  'chat.actions.save': 'Зберегти',
  'chat.actions.saveTitle': 'Зберегти цю розмову як файл (залишається на цьому пристрої)',
  'chat.actions.exportCsv': 'Експортувати в CSV',
  'chat.actions.exportCsvTitle':
    'Зберегти таблицю з цієї відповіді як CSV-файл (залишається на цьому пристрої)',
  'chat.code.copy': 'Скопіювати',
  'chat.code.copyTitle': 'Скопіювати цей блок коду в буфер обміну',
  'chat.code.save': 'Зберегти',
  'chat.code.saveTitle': 'Зберегти цей блок коду як файл .{ext} (залишається на цьому пристрої)',
  // ---- Chat: context compaction (context-compaction plan §5.1–§5.3) ----
  'chat.compaction.inProgress':
    'Підсумовування попередніх повідомлень, щоб звільнити памʼять розмови…',
  'chat.analysis.inProgress': 'Читання всього документа…',
  'chat.compaction.markerLabel': 'Попередні повідомлення підсумовано',
  'chat.compaction.viewSummary': 'Показати підсумок попередніх повідомлень',
  'chat.context.label': 'Памʼять',
  'chat.context.usageTooltip':
    'Памʼять цієї розмови: заповнено {pct}% (токенів: близько {used} з {window}).',
  'chat.context.willSummarize':
    'Коли памʼять заповниться, старіші повідомлення буде автоматично підсумовано, щоб звільнити ' +
    'місце.',
  'chat.truncated.label': 'Відповідь обірвано',
  'chat.endedEarly.label': 'Відповідь зупинено',
  'chat.endedEarly.hint.model': 'ШІ-модель було зупинено або змінено до завершення цієї відповіді.',
  'chat.endedEarly.hint.user': 'Ви зупинили цю відповідь до її завершення.',
  'chat.endedEarly.hint.lock':
    'Робочий простір було заблоковано або застосунок закрито до завершення цієї відповіді.',
  'chat.unanswered.model': 'Без відповіді — ШІ-модель було зупинено.',
  'chat.unanswered.user': 'Без відповіді — ви зупинили генерацію.',
  'chat.unanswered.lock':
    'Без відповіді — робочий простір було заблоковано або застосунок закрито.',
  'chat.truncated.hint.context':
    'Моделі забракло місця, щоб завершити цю відповідь. Попросіть її продовжити, почніть новий ' +
    'чат або збільште розмір контексту на екрані «ШІ-модель».',
  'chat.truncated.hint.cap':
    'Ця відповідь на основі документів досягла фіксованої довжини, яку застосунок дозволяє для ' +
    'однієї відповіді. Попросіть модель продовжити з місця, де вона зупинилася.',
  'chat.speed.line': '{tps}\u00A0tok/s · {ttft}\u00A0s до першого токена · токенів: {tokens}',
  'chat.speed.hint':
    'Як швидко згенеровано цю відповідь: швидкість декодування ШІ-рушія, час очікування до ' +
    'першого слова та кількість згенерованих токенів. Показується лише для відповідей з цього ' +
    'сеансу.',
  // ---- Chat: document scope (ScopePopover.tsx) ----
  'chat.scope.none': 'Документів ще немає · Додати документи',
  'chat.scope.stopAsking': 'Не запитувати: {title}',
  'chat.scope.askToo': 'Запитувати також: {title}',
  'chat.scope.removedDoc': 'Видалений документ',
  // ---- Chat: sources (SourcesDisclosure.tsx) ----
  'chat.sources.toggle': 'Джерела ({count})',
  'chat.sources.marker': 'Д{n}',
  'chat.sources.page': 'Сторінка {page}',
  'chat.sources.wholeDoc.one': 'Узято з документа — {count} розділ',
  'chat.sources.wholeDoc.few': 'Узято з документа — {count} розділи',
  'chat.sources.wholeDoc.many': 'Узято з документа — {count} розділів',
  'chat.sources.wholeDoc.other': 'Узято з документа — {count} розділу',
  'chat.sources.wholeDocCaption': 'Охоплені розділи',
  'chat.sources.more.one': 'і ще {count} розділ',
  'chat.sources.more.few': 'і ще {count} розділи',
  'chat.sources.more.many': 'і ще {count} розділів',
  'chat.sources.more.other': 'і ще {count} розділу',
  // ---- Chat: dictation (DictationButton.tsx) ----
  'chat.dictation.start': 'Продиктувати повідомлення',
  'chat.dictation.unavailable': 'Голосове диктування не встановлено на цьому диску',
  'chat.dictation.unavailableSystem': 'Голосове диктування недоступне в цій операційній системі',
  'chat.dictation.needsModel':
    'Для диктування повідомлень потрібна модель мовлення, якої немає на цьому диску. Додати її ' +
    'можна на екрані «ШІ-модель».',
  'chat.dictation.needsEngine':
    'Для диктування повідомлень потрібен рушій мовлення, якого не встановлено на цьому диску. ' +
    'Встановити його можна на екрані «ШІ-модель».',
  'chat.dictation.needsModelAndEngine':
    'Для диктування повідомлень потрібні модель мовлення та рушій мовлення, яких на цьому диску ' +
    'ще немає. Додати обидва можна на екрані «ШІ-модель».',
  'chat.dictation.engineUnsupported':
    'Голосове диктування поки що недоступне в цій операційній системі: застосунок не може ' +
    'встановити тут потрібний рушій мовлення.',
  'chat.dictation.getModel': 'Отримати модель мовлення',
  'chat.dictation.getEngine': 'Отримати рушій мовлення',
  'chat.dictation.setUp': 'Налаштувати голосове диктування',
  'chat.dictation.stop': 'Зупинити диктування й вставити текст',
  'chat.dictation.transcribing': 'Мовлення перетворюється на текст',
  'chat.dictation.noSpeech': 'Мовлення не розпізнано — спробуйте сказати ще раз.',
  'chat.dictation.silent':
    'До мікрофона не надійшло жодного звуку. Перевірте, чи не вимкнено на ньому звук і чи ' +
    'дозволено застосунку HilbertRaum користуватися ним у параметрах системи, а потім спробуйте ' +
    'ще раз.',
  'chat.dictation.noSignal':
    'Звук не надходить до мікрофона — перевірте, чи не вимкнено на ньому звук і чи вибрано ' +
    'правильний пристрій введення.',
  'chat.dictation.micBlocked':
    'Не вдалося використати мікрофон. Перевірте параметри мікрофона в системі, а потім спробуйте ' +
    'ще раз.',
  // ---- Documents (DocumentsScreen.tsx) ----
  'docs.title': 'Документи',
  'docs.lead':
    'Імпортуйте документи, щоб ставити до них запитання. Кожен файл копіюється у ваш робочий ' +
    'простір і готується для пошуку — усе залишається на цьому диску. Запитуйте на екрані «Чат» ' +
    'у режимі «Запитати мої документи».',
  'docs.status.queued': 'У черзі',
  'docs.status.extracting': 'Читання',
  'docs.status.preparing': 'Підготовка',
  'docs.status.indexed': 'Готово',
  'docs.status.failed': 'Не вдалося',
  'docs.status.deleted': 'Видалено',
  'docs.status.transcribing': 'Перетворення на текст…',
  'docs.task.summaryBusy': 'Підсумовування…',
  'docs.task.translationBusy': 'Переклад…',
  'docs.task.compareBusy': 'Порівняння…',
  'docs.task.ocrBusy': 'Розпізнавання тексту…',
  'docs.task.treeBusy': 'Створення глибокого індексу…',
  'docs.task.extractBusy': 'Пошук подробиць…',
  'docs.task.summaryBusyTitle': 'Триває написання підсумку',
  'docs.task.translationBusyTitle': 'Триває написання перекладу',
  'docs.task.compareBusyTitle': 'Триває написання порівняння',
  'docs.task.ocrBusyTitle': 'Триває розпізнавання тексту сканованих сторінок',
  'docs.task.treeBusyTitle': 'Триває створення глибокого індексу для всього документа',
  'docs.task.extractBusyTitle':
    'Триває аналіз усього документа, щоб за ним можна було відповідати на запитання на кшталт ' +
    '«перелічіть усі…»',
  'docs.task.categorizeBusy': 'Розподіл транзакцій за категоріями…',
  'docs.task.categorizeBusyTitle': 'Триває розподіл транзакцій банківської виписки за категоріями',
  'docs.task.ocrFinishing': 'Завершення — текст готується для пошуку…',
  'docs.task.stopping': 'Зупинка, якщо це можливо…',
  'docs.error.noSupported': 'Серед вибраного не знайдено підтримуваних документів.',
  'docs.removedDocFallback': '(документ видалено)',
  'docs.provenance.compareBefore': 'Порівняння документів ',
  'docs.provenance.compareMiddle': ' і ',
  'docs.provenance.translatedBefore': 'Переклад документа ',
  'docs.provenance.summaryBefore': 'Підсумок документа ',
  'docs.provenance.generatedBefore': 'Створено з документа ',
  'docs.provenance.articleBefore': 'Збережено з пакету знань ',
  'docs.provenance.articleUnknownArchive': '(назва невідома)',
  'docs.import.busy': 'Імпорт…',
  'docs.import.files': 'Імпортувати файли',
  'docs.import.folder': 'Імпортувати папку',
  'docs.import.walkCut.one': 'Папка завелика для повного перегляду — пораховано {count} елемент.',
  'docs.import.walkCut.few': 'Папка завелика для повного перегляду — пораховано {count} елементи.',
  'docs.import.walkCut.many':
    'Папка завелика для повного перегляду — пораховано {count} елементів.',
  'docs.import.walkCut.other':
    'Папка завелика для повного перегляду — пораховано {count} елемента.',
  'docs.refresh': 'Оновити список',
  'docs.loading': 'Відкриття списку документів…',
  'docs.askSelected': 'Запитати ці документи ({count})',
  'docs.askSelectedTitle': 'Відкрити чат для запитань лише до вибраних документів',
  'docs.compareBtn': 'Порівняти (2)',
  'docs.compareBtnTitle':
    'Скласти порівняння двох вибраних документів за допомогою локальної моделі — ніщо не ' +
    'виходить за межі цього диска',
  'docs.reindexAll': 'Переіндексувати все ({count})',
  'docs.reindexAllTitle': 'Переіндексувати кожен документ, який індексувала інша модель пошуку',
  'docs.reindexAllConfirm.title.one': 'Переіндексувати {count} документ?',
  'docs.reindexAllConfirm.title.few': 'Переіндексувати {count} документи?',
  'docs.reindexAllConfirm.title.many': 'Переіндексувати {count} документів?',
  'docs.reindexAllConfirm.title.other': 'Переіндексувати {count} документа?',
  'docs.reindexAllConfirm.body':
    'Кожен застарілий документ буде по черзі прочитано ще раз і для нього заново обчислено ' +
    'ембединги. Це може тривати кілька хвилин і сильно навантажує процесор — можна працювати ' +
    'далі, але доки це не завершиться, відповіді можуть бути повільнішими.',
  'docs.reindexAllConfirm.confirm': 'Переіндексувати все',
  'docs.retryAllFailed': 'Повторити все ({count})',
  'docs.retryAllFailedTitle': 'Переіндексувати кожен документ, який не вдалося проіндексувати',
  'docs.retryAllConfirm.title.one':
    'Ще раз обробити {count} документ, який не вдалося проіндексувати?',
  'docs.retryAllConfirm.title.few':
    'Ще раз обробити {count} документи, які не вдалося проіндексувати?',
  'docs.retryAllConfirm.title.many':
    'Ще раз обробити {count} документів, які не вдалося проіндексувати?',
  'docs.retryAllConfirm.title.other':
    'Ще раз обробити {count} документа, які не вдалося проіндексувати?',
  'docs.retryAllConfirm.body':
    'Кожен документ, який не вдалося проіндексувати, буде по черзі прочитано ще раз і для нього ' +
    'заново обчислено ембединги. Це може тривати кілька хвилин і сильно навантажує процесор — ' +
    'можна працювати далі, але доки це не завершиться, відповіді можуть бути повільнішими. ' +
    'Документи, які знову не вдасться обробити, залишаться в розділі «Потребують уваги».',
  'docs.retryAllConfirm.confirm': 'Повторити все',
  'docs.reindexAllProgress': 'Переіндексування: {done} з {total}…',
  'docs.reindexAllCancel': 'Скасувати',
  'docs.reindexAllCancelled': 'Переіндексування зупинено. Виконано: {done} з {total}.',
  'docs.reindexAllDone.one': 'Переіндексовано {count} документ.',
  'docs.reindexAllDone.few': 'Переіндексовано {count} документи.',
  'docs.reindexAllDone.many': 'Переіндексовано {count} документів.',
  'docs.reindexAllDone.other': 'Переіндексовано {count} документа.',
  'docs.reindexAllPartial':
    'Переіндексовано: {done} з {total}. Не вдалося: {failed}. Документи, які не вдалося ' +
    'переіндексувати, залишаються в розділі «Потребують уваги».',
  'docs.supported.base':
    'Підтримуються: TXT, Markdown, PDF, DOCX, CSV, а також аудіозаписи (WAV, MP3, FLAC, OGG), ' +
    'які на цьому диску перетворюються на текст',
  'docs.supported.ocrExtra':
    ', і фотографії сторінок (PNG, JPG), текст яких розпізнається на цьому диску',
  'docs.preparing': 'Ваші документи готуються, щоб до них можна було ставити запитання…',
  'docs.empty.title': 'Документів ще немає',
  'docs.empty.line':
    'Імпортуйте файли, щоб ставити до них запитання, — усе залишається на цьому диску.',
  'docs.selectAria': 'Вибрати документ «{title}» для запитань',
  'docs.selectTitle': 'Позначте, щоб ставити запитання лише до вибраних документів',
  'docs.selectAllAria': 'Вибрати всі документи',
  'docs.selectAllTitle': 'Вибрати всі видимі документи або очистити вибір',
  'docs.meta.sectionsCount.one': '{count} розділ',
  'docs.meta.sectionsCount.few': '{count} розділи',
  'docs.meta.sectionsCount.many': '{count} розділів',
  'docs.meta.sectionsCount.other': '{count} розділу',
  'docs.meta.summary': 'Підсумок',
  'docs.meta.type.text': 'Текст',
  'docs.meta.type.audio': 'Аудіо',
  'docs.meta.type.image': 'Зображення',
  'docs.scan.ocrOffer':
    'Скористайтеся кнопкою «Розпізнати текст (OCR)» у цьому рядку, щоб прочитати сторінки на ' +
    'цьому диску.',
  'docs.scan.ocrMissing':
    'Для розпізнавання тексту потрібні OCR-файли, яких немає на цьому диску. Завантажте їх нижче ' +
    '— або, якщо ви самі налаштовували цей диск, додайте їх командою «fetch-runtime --family ' +
    'ocr».',
  'docs.scan.ocrMissingOffline':
    'Для розпізнавання тексту потрібні OCR-файли, яких немає на цьому диску. Щоб додати їх, ще ' +
    'раз запустіть налаштування диска з параметром «--with-assets» або завантажте лише OCR-файли ' +
    'командою «fetch-runtime --family ocr».',
  'docs.photo.ocrMissing':
    'Завантажте OCR-файли нижче, а потім скористайтеся кнопкою «Спробувати ще раз», щоб ' +
    'розпізнати текст на цій фотографії.',
  'docs.photo.ocrMissingOffline':
    'Додайте OCR-файли засобами налаштування диска («fetch-runtime --family ocr»), а потім ' +
    'скористайтеся кнопкою «Спробувати ще раз», щоб розпізнати текст на цій фотографії.',
  'docs.photo.ocrReady':
    'Розпізнавання тексту вже готове — скористайтеся кнопкою «Спробувати ще раз», щоб розпізнати ' +
    'текст на цій фотографії.',
  'docs.scan.ocrUnavailable':
    'Щоб у документі можна було шукати, потрібне розпізнавання тексту (OCR), але в цій збірці ' +
    'його не вдалося запустити.',
  'docs.ocr.unavailableBanner':
    'Розпізнавання тексту (OCR) недоступне в цій збірці: OCR-файли є на цьому диску, але засіб ' +
    'розпізнавання не вдалося запустити. Доки це не виправлено, фотографії зберігаються без ' +
    'придатного для читання тексту, а скановані PDF-файли не можна зробити придатними для пошуку.',
  'docs.stale.banner':
    'Цей документ підготувала інша модель пошуку — переіндексуйте його, щоб відповіді могли його ' +
    'знайти.',
  'docs.preview': 'Переглянути',
  'docs.previewBusy': 'Відкриття…',
  'docs.previewTitle':
    'Прочитати видобутий текст (лише перегляд; ніщо не виходить за межі застосунку)',
  'docs.cancel': 'Скасувати',
  'docs.cancelOcrTitle': 'Зупинити розпізнавання скану',
  'docs.cancelTaskTitle': 'Зупинити завдання',
  'docs.task.stateUnknown':
    'Не вдалося перевірити стан цього завдання — можливо, воно ще виконується.',
  'docs.task.dismiss': 'Сховати',
  'docs.makeSearchable': 'Розпізнати текст (OCR)',
  'docs.makeSearchableTitle':
    'Прочитати скановані сторінки за допомогою локального розпізнавання тексту — ніщо не ' +
    'виходить за межі цього диска',
  'docs.makeSearchableAgain': 'Розпізнати ще раз (OCR)',
  'docs.makeSearchableAgainPhotoTitle':
    'Ще раз прочитати фотографію за допомогою локального розпізнавання тексту',
  'docs.makeSearchableAgainTitle':
    'Ще раз запустити локальне розпізнавання тексту й замінити збережений результат — дія ' +
    '«Переіндексувати» використовує його повторно',
  'docs.summarize': 'Підсумувати',
  'docs.summarizeAgain': 'Підсумувати ще раз',
  'docs.translate': 'Перекласти',
  'docs.translateNoModel': 'Отримати модель перекладу…',
  'docs.translateNoModelTitle':
    'Для перекладу потрібна модель перекладу — завантажте її на екрані «ШІ-модель»',
  'docs.export': 'Експортувати',
  'docs.exportOriginal': 'Експортувати оригінальний файл',
  'docs.exportOriginal.gone':
    'Збереженої копії цього файлу немає на цьому диску, тому експортувати її не можна. Видобутий ' +
    'текст і далі можна експортувати.',
  'docs.exportOriginalConfirm.title': 'Експортувати оригінальний файл?',
  'docs.exportOriginal.warning':
    'Цей експортований файл зберігається поза зашифрованим робочим простором HilbertRaum, і ' +
    'пароль вашого робочого простору його не захищає.',
  'docs.reindex': 'Переіндексувати',
  'docs.reindexBusy': 'Переіндексування…',
  'docs.reindexTitle': 'Ще раз прочитати й підготувати збережену копію',
  'docs.reindexDone': 'Документ «{title}» переіндексовано.',
  'docs.delete': 'Видалити',
  'docs.deleteBusy': 'Видалення…',
  'docs.deleteDone': 'Документ «{title}» видалено.',
  'docs.failed.remove': 'Прибрати',
  'docs.failed.removeTitle': 'Прибрати цей невдалий імпорт зі списку',
  'docs.failed.retry': 'Спробувати ще раз',
  'docs.failed.lead': 'Не вдалося додати цей файл.',
  'docs.backToChat': 'Назад до чату',
  'docs.failed.retryTitle': 'Ще раз прочитати й підготувати цей файл',
  'docs.moreActions': 'Інші дії з документом «{title}»',
  'docs.audioConfirm.title': 'Імпортувати великі аудіозаписи?',
  'docs.audioConfirm.confirm': 'Імпортувати й перетворити на текст',
  'docs.audioConfirm.contains.one': 'Вибране містить {count} аудіозапис ({size}).',
  'docs.audioConfirm.contains.few': 'Вибране містить {count} аудіозаписи ({size}).',
  'docs.audioConfirm.contains.many': 'Вибране містить {count} аудіозаписів ({size}).',
  'docs.audioConfirm.contains.other': 'Вибране містить {count} аудіозапису ({size}).',
  'docs.audioConfirm.body':
    'Кожен запис копіюється у ваш робочий простір і на цьому диску перетворюється на текст — ' +
    'довгий запис може оброблятися деякий час. Тим часом можна далі користуватися застосунком.',
  'docs.deleteConfirm.title': 'Видалити документ «{title}»?',
  'docs.deleteConfirm.body':
    'Документ, його видобутий текст і пошуковий індекс буде остаточно видалено з вашого робочого ' +
    'простору. Оригінальний файл поза робочим простором залишиться без змін.',
  'docs.translateModal.title': 'Перекласти документ «{title}»',
  'docs.translateModal.aria': 'Перекласти документ «{title}»',
  'docs.translateModal.hint':
    'Локальна модель створює перекладену копію як новий документ: як і в будь-якому ' +
    'імпортованому документі, у ньому можна шукати й ставити до нього запитання. Ніщо не ' +
    'виходить за межі цього диска. Машинний переклад може містити помилки.',
  'docs.translateModal.from': 'З мови',
  'docs.translateModal.to': 'На мову',
  'docs.translateModal.start': 'Перекласти',
  'docs.translateModal.sameLang': 'Виберіть дві різні мови.',
  'docs.previewModal.aria': 'Перегляд документа «{title}»',
  'docs.previewModal.hint':
    'Видобутий текст (лише перегляд) — саме на ньому ґрунтуються пошук у документах і відповіді.',
  'docs.previewModal.ocrInfo.one':
    'Текст розпізнано на цьому диску (OCR) — {count} сторінка. У розпізнаному тексті можуть бути ' +
    'помилки.',
  'docs.previewModal.ocrInfo.few':
    'Текст розпізнано на цьому диску (OCR) — {count} сторінки. У розпізнаному тексті можуть бути ' +
    'помилки.',
  'docs.previewModal.ocrInfo.many':
    'Текст розпізнано на цьому диску (OCR) — {count} сторінок. У розпізнаному тексті можуть бути ' +
    'помилки.',
  'docs.previewModal.ocrInfo.other':
    'Текст розпізнано на цьому диску (OCR) — {count} сторінки. У розпізнаному тексті можуть бути ' +
    'помилки.',
  'docs.previewModal.ocrInfoPhoto':
    'Текст цієї фотографії розпізнано на цьому диску (OCR). У розпізнаному тексті можуть бути ' +
    'помилки.',
  'docs.previewModal.ocrInfoPartial':
    'Текст розпізнано на цьому диску (OCR) — сторінки: {count} з {total}. У розпізнаному тексті ' +
    'можуть бути помилки.',
  'docs.previewModal.ocrInfoNone.one':
    'Під час розпізнавання тексту (OCR) на цьому диску прочитано {count} скановану сторінку, але ' +
    'тексту не знайдено.',
  'docs.previewModal.ocrInfoNone.few':
    'Під час розпізнавання тексту (OCR) на цьому диску прочитано {count} скановані сторінки, але ' +
    'тексту не знайдено.',
  'docs.previewModal.ocrInfoNone.many':
    'Під час розпізнавання тексту (OCR) на цьому диску прочитано {count} сканованих сторінок, ' +
    'але тексту не знайдено.',
  'docs.previewModal.ocrInfoNone.other':
    'Під час розпізнавання тексту (OCR) на цьому диску прочитано {count} сканованої сторінки, ' +
    'але тексту не знайдено.',
  'docs.ocr.unsure.page': 'Текст цієї сторінки розпізнано з низькою впевненістю.',
  'docs.ocr.unsure.onlyRecognized':
    'Текст розпізнано лише на одній сторінці, причому з низькою впевненістю.',
  'docs.ocr.unsure.photo': 'Текст цієї фотографії розпізнано з низькою впевненістю.',
  'docs.ocr.unsure.some': 'Розпізнані сторінки з низькою впевненістю: {count} з {total}.',
  'docs.ocr.unsure.all':
    'Текст усіх розпізнаних сторінок ({count}) розпізнано з низькою впевненістю.',
  'docs.ocr.scannedPages':
    'Скановані сторінки, на яких ще немає придатного для читання тексту: {count} з {total}.',
  'docs.ocr.scannedPagesNeedsOcr': 'Щоб їх прочитати, потрібні OCR-файли (екран «ШІ-модель»).',
  'docs.ocr.unsure.causes':
    'Розмитий, перекошений або рукописний оригінал розпізнається погано, як і текст будь-якою ' +
    'мовою, крім німецької та англійської.',
  'docs.previewModal.summary': 'Підсумок',
  'docs.previewModal.generatedBy': 'Згенерувала модель {model}',
  'docs.previewModal.truncated':
    'Цей документ довгий — підсумок охоплює його початок. Решта тексту й далі доступна для ' +
    'пошуку та запитань у чаті.',
  'docs.previewModal.regenerate': 'Згенерувати ще раз',
  'docs.previewModal.copy': 'Скопіювати',
  'docs.previewModal.save': 'Зберегти',
  'docs.previewModal.copied': 'Підсумок скопійовано',
  'docs.previewModal.copyFailed': 'Не вдалося скопіювати в буфер обміну',
  'docs.previewModal.savedTo': 'Підсумок збережено у файл {path}',
  'docs.previewModal.noText': 'З цього документа не вдалося видобути текст.',
  'docs.previewModal.documentText': 'Текст документа',
  'docs.previewModal.page': 'Сторінка {page}',
  'docs.previewModal.showMore': 'Показати більше',
  'docs.previewModal.loadingMore': 'Зачекайте…',
  'docs.previewModal.segmentProgress': 'Показано {shown} з {total}',
  // ---- Deep index + coverage (whole-document-analysis plan §5.2) ----
  'docs.deepIndex.build': 'Створити глибокий індекс',
  'docs.deepIndex.reindexFirst': 'Переіндексувати для глибокого індексу',
  'docs.deepIndex.ready': 'Глибоко проіндексовано',
  'docs.deepIndex.readyTitle':
    'Глибокий індекс усього документа готовий — підсумки й відповіді з переліками можуть ' +
    'охоплювати весь документ',
  'coverage.relevance': 'На основі найрелевантніших фрагментів, а не всього документа',
  'coverage.relevance.counted': 'Використано розділів: {covered} з {total}',
  'coverage.capped.whole': 'Охоплює весь документ',
  'coverage.capped.beginning': 'Охоплює початок документа',
  'coverage.tree.whole': 'Охоплює весь документ (глибоко проіндексовано)',
  'coverage.tree.beginning':
    'Охоплює початок документа — він завеликий, щоб прочитати його повністю',
  'coverage.tree.partial': 'Глибокий індекс створюється — розділів: {covered} з {total}',
  'coverage.tree.pending': 'Глибокого індексу ще немає',
  'coverage.depth': 'Деталізація: {label}',
  'coverage.tier.1': 'Огляд',
  'coverage.tier.2': 'Розділ за розділом',
  'coverage.tier.3': 'Докладно (повне охоплення)',
  'coverage.tier.hint.1': 'Найшвидше — збережений огляд',
  'coverage.tier.hint.2': 'Докладніше опрацювання всіх розділів',
  'coverage.tier.hint.3': 'Найбільше подробиць з усього документа',
  'coverage.tierSelect.trigger': 'Деталізація: {label}',
  'coverage.extract.whole': 'Прочитано весь документ — проаналізовано розділів: {scanned}',
  'coverage.extract.wholeUnparsed':
    'Прочитано весь документ — проаналізовано розділів: {scanned}, не прочитано: {unparsed}',
  'coverage.extract.sections': 'Проаналізовано розділів: {scanned}',
  'coverage.extract.sectionsUnparsed':
    'Проаналізовано розділів: {scanned}, не прочитано: {unparsed}',
  // ---- "List every X" answer (whole-document-analysis plan §4.2, Phase 3) ----
  'analysis.kind.generic': 'елементи',
  'analysis.kind.date': 'дати',
  'analysis.kind.amount': 'суми',
  'analysis.kind.party': 'сторони',
  'analysis.kind.obligation': 'зобовʼязання',
  'analysis.listing.coverageWhole':
    'Результати ({kind}) у всьому документі: {count}. Проаналізовано розділів: ' +
    '{scanned}{unparsed}:',
  'analysis.listing.coverageSections':
    'Результати ({kind}): {count}. Проаналізовано розділів: {scanned}{unparsed}:',
  'analysis.listing.empty':
    'Результатів ({kind}) не знайдено. Проаналізовано розділів: {scanned}{unparsed}.',
  'analysis.listing.unparsedSuffix': ' (не прочитано: {k})',
  'analysis.listing.item': '- {value} (×{count})',
  'analysis.listing.caveat':
    'Цей перелік складено з усіх проаналізованих розділів, але його повнота не гарантована ' +
    '(невелика модель може пропустити елемент, а дуже схожі записи можуть бути обʼєднані).',
  'analysis.listing.refPage': 'с. {n}',
  'analysis.listing.refSection': 'розділ {n}',
  'analysis.listing.unparsedHint':
    '**Зауважте:** під час індексування цього документа більшість розділів не вдалося прочитати, ' +
    'тому цей результат ненадійний. Відкрийте екран «Документи» і ще раз виберіть пункт ' +
    '«Створити глибокий індекс» — непрочитані розділи буде оброблено повторно (більша модель ' +
    'допомагає).',
  'analysis.listing.unparsedHintAmountSkill':
    'Для банківської виписки навичка «Аналіз банківської виписки» в меню навичок у чаті точно ' +
    'зчитує суми.',
  'analysis.listing.aggregationHint':
    '**Зауважте:** ви запитали про категорії або суми, але ця відповідь може лише перелічити ' +
    'значення, знайдені в документі, і показати, скільки разів трапляється кожне, — групувати ' +
    'або додавати їх вона не може.',
  'analysis.listing.aggregationHintAmountSkill':
    'Для банківської виписки увімкніть навичку «Аналіз банківської виписки» в меню навичок у ' +
    'чаті й запитайте ще раз — вона розподілить транзакції за категоріями й точно обчислить суму ' +
    'кожної категорії.',
  'analysis.wholeDocHint':
    '**Зауважте:** ця відповідь ґрунтується лише на найрелевантніших розділах, тому в ній можуть ' +
    'бути пропущені елементи. Щоб отримати перелік з усіх розділів, відкрийте екран «Документи», ' +
    'виберіть для документа пункт «Створити глибокий індекс» і запитайте ще раз.',
  'analysis.partialAnswerHint':
    '**Зауважте:** ця відповідь ґрунтується лише на найрелевантніших розділах, тому в ній можуть ' +
    'бути пропущені елементи.',
  'analysis.wholeReadSumHint':
    '**Зауважте:** модель сама обчислює загальні суми й може пропустити або неправильно ' +
    'порахувати елементи. Звіряйте кожну загальну суму з джерелами.',
  // ---- Bank-statement analysis answer (full-doc-skills plan §3.1, Phase 2) ----
  'skills.bankAnalysis.count': 'Прочитано транзакцій у всій виписці: **{count}**.',
  'skills.bankAnalysis.countPartial':
    'Прочитано транзакцій: **{count}**. Рядки з числом, яке не вдалося прочитати як транзакцію: ' +
    '**{dropped}**. Тож це, можливо, не всі транзакції — звірте ці рядки з документом.',
  'skills.bankAnalysis.countContradicted':
    'Прочитано транзакцій: **{count}**, але зазначені в цій виписці залишки з ними не сходяться ' +
    '— тож не можна підтвердити, що це всі транзакції.',
  'skills.bankAnalysis.empty':
    'Документ переглянуто повністю, але не вдалося прочитати з нього жодної транзакції. Можливо, ' +
    'рядки містяться на сканованому зображенні або мають незвичний макет, який засіб читання не ' +
    'може розібрати. Якщо це скан, спершу розпізнайте в ньому текст (OCR); інакше макет, ' +
    'можливо, непридатний для машинного читання — відкрийте виписку й прочитайте суми ' +
    'безпосередньо.',
  'skills.bankAnalysis.couldNotRead':
    'Не вдалося прочитати цю виписку, тому її не можна проаналізувати.',
  'skills.bankAnalysis.unreconciledHeading':
    'Спершу перевірте ці рядки — зазначені в них проміжні залишки не сходяться із сумами:',
  'skills.bankAnalysis.unreconciledItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.totals':
    'Надходження: **{inAmount} {currency}** · Списання: **{outAmount} {currency}** · Зміна ' +
    'залишку: **{netAmount} {currency}**.',
  'skills.bankAnalysis.noCurrency':
    'У цих транзакціях використано більше ніж одну валюту, тому однієї загальної суми немає — ' +
    'загальну суму довелося б рахувати окремо для кожної валюти.',
  'skills.bankAnalysis.incompleteNoTotal':
    'Не вдалося підтвердити, що виписку прочитано повністю: зазначені в ній залишки не сходяться ' +
    'з прочитаними транзакціями, тож суми, можливо, прочитано неправильно або не повністю. Щоб ' +
    'не показати загальну суму, яка може бути хибною, її тут не наведено; відкрийте виписку й ' +
    'перевірте суми самостійно.',
  'skills.bankAnalysis.categoryHeading': 'За категоріями:',
  'skills.bankAnalysis.categoryItem': '- {category}: {amount} {currency} ({count})',
  'skills.bankAnalysis.categoryAssisted':
    '_Категорії визначено за допомогою моделі — окрема категорія може бути неточною, але ' +
    'наведені вище загальні суми від цього не змінюються._',
  'skills.bankAnalysis.categoryRuleBased':
    '_Це швидке групування за правилами (без моделі). Щоб отримати докладніший розподіл за ' +
    'допомогою моделі, скористайтеся кнопкою «Розподілити за категоріями»._',
  'skills.bankCategory.Groceries': 'Продукти',
  'skills.bankCategory.Dining': 'Кафе й ресторани',
  'skills.bankCategory.Transport': 'Транспорт',
  'skills.bankCategory.Utilities': 'Комунальні послуги',
  'skills.bankCategory.Rent': 'Оренда',
  'skills.bankCategory.Insurance': 'Страхування',
  'skills.bankCategory.Subscriptions': 'Підписки',
  'skills.bankCategory.Health': 'Здоровʼя',
  'skills.bankCategory.Shopping': 'Покупки',
  'skills.bankCategory.Income': 'Доходи',
  'skills.bankCategory.Transfer': 'Перекази',
  'skills.bankCategory.Fees': 'Комісії',
  'skills.bankCategory.Cash': 'Готівка',
  'skills.bankCategory.Tax': 'Податки',
  'skills.bankCategory.Spending': 'Витрати',
  'skills.bankCategory.Uncategorized': 'Без категорії',
  'skills.bankAnalysis.caveat':
    'Ці суми зазначено в самій виписці та прочитано з усього документа; нічого тут не обчислено ' +
    'з описового тексту і нічого не вигадано.',
  'skills.bankAnalysis.unverifiedCaveat':
    'Ці суми обчислено з транзакцій, прочитаних у всьому документі (прочитано транзакцій: ' +
    '**{count}**). У виписці не зазначено ні початкового, ні кінцевого залишку, тож не можна ' +
    'підтвердити, що це всі транзакції. Вважайте ці суми сумою показаних рядків, а не ' +
    'перевіреною загальною сумою виписки. Нічого тут не обчислено з описового тексту і нічого не ' +
    'вигадано.',
  'skills.bankAnalysis.dateOrderCaveat':
    'Примітка щодо дат: з цієї виписки не видно, що стоїть першим — день чи місяць, тому дати ' +
    'прочитано так, ніби першим стоїть день (день.місяць.рік). Дата на зразок 03.05. може ' +
    'означати 3 травня або 5 березня. Звірте з документом кожну важливу дату.',
  'skills.bankAnalysis.transactionsHeading': 'Транзакції:',
  'skills.bankAnalysis.transactionItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.transactionsMore':
    '… і ще **{count}**. Щоб побачити всі рядки, збережіть усю виписку кнопкою **Експортувати в ' +
    'CSV** на панелі виконання. Можна також попросити показати її тут, у чаті, у форматі CSV або ' +
    'JSON.',
  'skills.bankAnalysis.figureEcho': 'Загальні суми, обчислені з прочитаних транзакцій: {figures}.',
  'skills.bankAnalysis.figureEchoIn': 'надходження {amount} {currency}',
  'skills.bankAnalysis.figureEchoOut': 'списання {amount} {currency}',
  'skills.bankAnalysis.figureEchoNet': 'зміна залишку {amount} {currency}',
  'skills.bankAnalysis.formatIntro':
    'Ось виписка у форматі {format}, складена лише з прочитаних сум — нічого не обчислено з ' +
    'описового тексту і нічого не вигадано:',
  'skills.bankAnalysis.formatIntroCsv':
    'Ось виписка у форматі CSV — лише рядки транзакцій, складені з прочитаних сум (нічого не ' +
    'обчислено з описового тексту і нічого не вигадано). Зведення руху коштів, початковий і ' +
    'кінцевий залишки до CSV не входять; щоб отримати й їх, попросіть виписку у форматі JSON.',
  'skills.bankAnalysis.customCategoriesNeedModel':
    'Щоб розподілити транзакції за вашими власними категоріями ({categories}), потрібна запущена ' +
    'локальна модель — вбудовані швидкі правила знають лише свій фіксований набір категорій. ' +
    'Запустіть модель і запитайте ще раз.',
  'skills.bankAnalysis.customTaxonomyNotFound':
    'Файл «{name}» не знайдено серед ваших документів. Спочатку імпортуйте його (Документи → ' +
    'Імпортувати файли), а потім запитайте ще раз.',
  'skills.bankAnalysis.customTaxonomyUnparseable':
    'Файл «{name}» прочитано, але використати його як список категорій не вдалося. Очікується ' +
    'одна категорія в рядку — назва, після якої можна через крапку з комою вказати ключові слова ' +
    '(наприклад, «Діти;школа, дитсадок, кишенькові»).',
  'skills.bankAnalysis.derivedColumnsNote':
    '_Стовпці, які заповнила локальна модель за описом кожної транзакції: {columns}. Там, де ' +
    'модель не була впевнена, клітинки залишено порожніми. Усі суми прочитано за фіксованими ' +
    'правилами, без моделі, і їх не змінено._',
  // ---- Invoice analysis answer (full-doc-skills plan §3.1, Phase 4 / D49) ----
  'skills.invoiceAnalysis.count': 'Рахунок на оплату прочитано повністю — позицій: **{count}**.',
  'skills.invoiceAnalysis.countPartial':
    'Прочитано позицій: **{count}**. Рядки з числом, яке не вдалося прочитати як позицію: ' +
    '**{dropped}**. Тож це, можливо, не всі позиції — звірте ці рядки з документом.',
  'skills.invoiceAnalysis.empty':
    'Документ переглянуто повністю, але не вдалося прочитати з нього ні позицій, ні загальних ' +
    'сум. Можливо, суми містяться на сканованому зображенні або мають незвичний макет, який ' +
    'засіб читання не може розібрати. Якщо це скан, спершу розпізнайте в ньому текст (OCR); ' +
    'інакше макет, можливо, непридатний для машинного читання — відкрийте рахунок на оплату й ' +
    'прочитайте суми безпосередньо.',
  'skills.invoiceAnalysis.couldNotRead':
    'Не вдалося прочитати цей рахунок на оплату, тому його не можна проаналізувати.',
  'skills.invoiceAnalysis.unreconciledHeading':
    'Спершу перевірте ці загальні суми — вони не сходяться:',
  'skills.invoiceAnalysis.checkLineItemsSumToNet':
    'сума позицій не дорівнює зазначеній сумі без податку',
  'skills.invoiceAnalysis.checkNetPlusTaxIsGross':
    'сума без податку разом із податком не дорівнює зазначеній сумі з податком',
  'skills.invoiceAnalysis.checkTaxMatchesRate':
    'сума податку не відповідає зазначеній ставці податку',
  'skills.invoiceAnalysis.unreconciledItem': '- {check}',
  'skills.invoiceAnalysis.totalsHeading': 'Загальні суми точно так, як у документі:',
  'skills.invoiceAnalysis.net': '- Сума без податку: **{value}**',
  'skills.invoiceAnalysis.tax': '- Податок: **{value}**',
  'skills.invoiceAnalysis.taxWithRate': '- Податок ({rate}%): **{value}**',
  'skills.invoiceAnalysis.gross': '- Загальна сума з податком (до сплати): **{value}**',
  'skills.invoiceAnalysis.positionsHeading': 'Позиції:',
  'skills.invoiceAnalysis.positionItem': '- {description} · {amount} {currency}',
  'skills.invoiceAnalysis.positionsMore':
    '… і ще **{count}** — щоб побачити всі позиції, попросіть експортувати рахунок на оплату в ' +
    'CSV.',
  'skills.invoiceAnalysis.formatIntro':
    'Ось рахунок на оплату у форматі {format}, складений лише з прочитаних сум — нічого не ' +
    'обчислено з описового тексту і нічого не вигадано:',
  'skills.invoiceAnalysis.formatIntroCsv':
    'Ось рахунок на оплату у форматі CSV — лише позиції, складені з прочитаних сум (нічого не ' +
    'обчислено з описового тексту і нічого не вигадано). Реквізити (постачальник, номер рахунку ' +
    'на оплату, дати) і загальні суми до CSV не входять; щоб отримати й їх, попросіть рахунок на ' +
    'оплату у форматі JSON або XML.',
  'skills.invoiceAnalysis.noTotals':
    'У рахунку на оплату немає суми без податку, податку або суми з податком, яку вдалося б ' +
    'прочитати.',
  'skills.invoiceAnalysis.caveat':
    'Ці суми зазначено в самому рахунку на оплату та прочитано з усього документа; нічого тут не ' +
    'обчислено з описового тексту і нічого не вигадано.',
  'skills.invoiceAnalysis.dateOrderCaveat':
    'Примітка щодо дат: з цього рахунку на оплату не видно, що стоїть першим — день чи місяць, ' +
    'тому дати прочитано так, ніби першим стоїть день (день.місяць.рік). Дата на зразок 03.05. ' +
    'може означати 3 травня або 5 березня. Звірте з документом кожну важливу дату.',
  'skills.invoiceAnalysis.detailsHeading': 'Реквізити, як у документі:',
  'skills.invoiceAnalysis.detailVendor': '- Постачальник: {vendor}',
  'skills.invoiceAnalysis.detailRecipient': '- Отримувач (платник): {recipient}',
  'skills.invoiceAnalysis.detailInvoiceNumber': '- Номер рахунку на оплату: {number}',
  'skills.invoiceAnalysis.detailInvoiceDate': '- Дата рахунку на оплату: {date}',
  'skills.invoiceAnalysis.detailDueDate': '- Строк оплати: {date}',
  'skills.invoiceAnalysis.figureEcho': 'Суми, як їх прочитано, дослівно з документа: {figures}.',
  'skills.invoiceAnalysis.figureEchoNet': 'сума без податку {value}',
  'skills.invoiceAnalysis.figureEchoTax': 'податок {value}',
  'skills.invoiceAnalysis.figureEchoGross': 'сума з податком {value}',
  'skills.invoiceAnalysis.totalsHeadingUnverified':
    'Суми з документа — **вони не сходяться**, тому вважайте їх неперевіреними:',
  'skills.invoiceAnalysis.unreconciledCaveat':
    'Ці зазначені в документі суми суперечать одна одній — зазвичай це означає, що текст ' +
    'документа видобуто неточно (скан, PDF-файл, створений із зображень, або незвичний макет). ' +
    'Не покладайтеся на жодне з цих чисел, не перевіривши оригінальний документ.',
  'skills.invoiceAnalysis.figureEchoSuppressed':
    'Прочитані загальні суми тут не наведено: вони не сходяться ні між собою, ні з позиціями, ' +
    'тож подавати їх як надійні числа було б оманливо. Перевірте оригінальний документ.',
  'skills.invoiceAnalysis.unreadableLayout':
    'Текст цього документа не вдається чисто видобути — символи виходять перемішаними (гліф за ' +
    'гліфом), що зазвичай означає PDF-файл, створений із зображень або з незвичним кодуванням. ' +
    'Прочитати з нього надійні позиції або загальні суми не вдалося, тому суми тут не наведено. ' +
    'Якщо це скан, спершу розпізнайте в ньому текст (OCR); інакше відкрийте рахунок на оплату й ' +
    'прочитайте суми безпосередньо.',
  'skills.invoiceAnalysis.textQualityCaveat':
    'Зауважте: частину тексту цього документа видобуто в перемішаному вигляді (гліф за гліфом). ' +
    'Наведені вище суми сходяться, але звірте все важливе з оригінальним документом.',
  'skills.analysis.refusePartial':
    'Точно відповісти на це можна лише з усього документа, а цей документ ще не повністю ' +
    'проіндексовано. Відкрийте екран «Документи», виберіть пункт «Переіндексувати», а потім ' +
    'запитайте ще раз.',
  'skills.analysis.scopeNarrowed':
    'Відповідь складено лише на основі документа **{title}**. Інших вибраних документів, які не ' +
    'прочитано: {count}. Щоб проаналізувати інший документ, виберіть лише його (або назвіть його ' +
    'файл у запитанні) і запитайте ще раз.',
  'skills.analysis.selectOne':
    'Для повного аналізу потрібен один документ — зараз вибрано документів: {count}, тому видно ' +
    'лише кілька фрагментів із них. Виберіть один документ (або назвіть його файл у запитанні) і ' +
    'запитайте ще раз.',
  'skills.analysis.selectTwo':
    'Щоб порівняти, виберіть рівно **два** документи (або дві версії). Зараз вибрано документів: ' +
    '{count}. Виберіть два, які хочете порівняти, і запитайте ще раз.',
  'skills.redactionRouting.answer':
    'Щоб приховати персональні дані в цьому документі, натисніть кнопку **{button}** просто над ' +
    'полем повідомлення, а потім виберіть, куди зберегти копію. Інструмент працює повністю на ' +
    'цьому пристрої, читає весь документ і приховує чітко оформлені персональні дані — адреси ' +
    'електронної пошти, номери телефонів, номери IBAN, дати й посилання. Це перша спроба в міру ' +
    'можливостей, а не гарантія: імен і незвичних форматів він не виявляє, тому перевірте ' +
    'збережену копію перед поширенням.',
  'skills.redactionRouting.answerMulti':
    'Щоб приховати персональні дані в документі, натисніть кнопку **{button}** просто над полем ' +
    'повідомлення, виберіть потрібний документ, а потім — куди зберегти копію. Інструмент ' +
    'обробляє один документ за раз, працює повністю на цьому пристрої, читає весь документ і ' +
    'приховує чітко оформлені персональні дані — адреси електронної пошти, номери телефонів, ' +
    'номери IBAN, номери платіжних карток, дати й посилання. Це перша спроба в міру можливостей, ' +
    'а не гарантія: імен і незвичних форматів він не виявляє, тому перевірте збережену копію ' +
    'перед поширенням.',
  'skills.editRouting.answer':
    'Щоб внести ці зміни, натисніть кнопку **{button}** просто над полем повідомлення, а потім ' +
    'виберіть, куди зберегти відредаговану копію. Інструмент працює повністю на цьому пристрої й ' +
    'застосовує лише ті точні зміни через пошук і заміну, про які ви попросили: скрізь, де текст ' +
    'знайдено дослівно, а все інше залишає без змін. Він ніколи не переписує документ, тому не може ' +
    'нічого ні вигадати, ні переформулювати. Документ Word залишається у форматі .docx; файли інших ' +
    'форматів зберігаються як звичайний текст (.txt). Перевірте копію перед поширенням.',
  'skills.editRouting.answerMulti':
    'Щоб внести ці зміни, натисніть кнопку **{button}** просто над полем повідомлення, виберіть ' +
    'документ, який треба змінити, а потім — куди зберегти відредаговану копію. Інструмент обробляє ' +
    'один документ за раз, працює повністю на цьому пристрої й застосовує лише ті точні зміни через ' +
    'пошук і заміну, про які ви попросили: скрізь, де текст знайдено дослівно, а все інше залишає ' +
    'без змін. Він ніколи не переписує документ. Документ Word залишається у форматі .docx; файли ' +
    'інших форматів зберігаються як звичайний текст (.txt). Перевірте копію перед поширенням.',
  'skills.redactionRouting.scan':
    'Увесь документ переглянуто в пошуках чітко оформлених персональних даних. Виявлено — адреси ' +
    'електронної пошти: {email}, номери телефонів: {phone}, номери IBAN: {iban}, номери ' +
    'платіжних карток: {card}, дати: {date}, посилання: {url}. Це пошук за шаблонами в міру ' +
    'можливостей: імен, поштових адрес і незвичних форматів він не виявляє, тому вважайте ці ' +
    'числа нижньою межею, а не повним переліком. Щоб створити копію з прихованими даними, ' +
    'натисніть кнопку **{button}** просто над полем повідомлення й виберіть, куди її зберегти.',
  // ---- Models (ModelsScreen.tsx) ----
  'models.title': 'ШІ-модель',
  'models.library.title': 'Бібліотека моделей',
  'models.library.view': 'Подання бібліотеки моделей',
  'models.library.onDrive': 'На цьому диску',
  'models.library.browse': 'Огляд моделей',
  'models.library.search': 'Пошук моделей',
  'models.library.searchPlaceholder': 'Назва, сімейство або варіант…',
  'models.library.task': 'Завдання',
  'models.library.allTasks': 'Усі завдання',
  'models.library.family': 'Сімейство',
  'models.library.allFamilies': 'Усі сімейства',
  'models.library.familyNotInView': '{name} (немає в цьому поданні)',
  'models.library.resetFamily': 'Усі сімейства',
  'models.library.noFamilyForTask':
    'Жодна модель сімейства {family} не підходить для цього завдання.',
  'models.library.noFamilyOnDrive.one':
    'На цьому диску немає моделей сімейства {family}. Подання «Огляд моделей» показує {count} ' +
    'модель.',
  'models.library.noFamilyOnDrive.few':
    'На цьому диску немає моделей сімейства {family}. Подання «Огляд моделей» показує {count} ' +
    'моделі.',
  'models.library.noFamilyOnDrive.many':
    'На цьому диску немає моделей сімейства {family}. Подання «Огляд моделей» показує {count} ' +
    'моделей.',
  'models.library.noFamilyOnDrive.other':
    'На цьому диску немає моделей сімейства {family}. Подання «Огляд моделей» показує {count} ' +
    'моделі.',
  'models.library.chat': 'Чат',
  'models.library.translation': 'Переклад',
  'models.library.images': 'Зображення',
  'models.library.voice': 'Мовлення',
  'models.library.memory': 'Мінімальний обсяг памʼяті: {size}',
  'models.library.clear': 'Очистити фільтри',
  'models.library.showVariants': 'Показати всі варіанти ({count})',
  'models.library.hideVariants': 'Показати менше варіантів ({count})',
  'models.library.results.one': 'Знайдено {count} варіант',
  'models.library.results.few': 'Знайдено {count} варіанти',
  'models.library.results.many': 'Знайдено {count} варіантів',
  'models.library.results.other': 'Знайдено {count} варіанта',
  'models.library.noMatches':
    'Жодна модель не відповідає цим фільтрам. Спробуйте інший пошуковий запит або очистіть ' +
    'фільтри.',
  'models.library.noneInstalled': 'На цьому диску ще немає моделей, готових до використання.',
  'models.library.onlyActive':
    'Вашу встановлену модель показано вище. Інші моделі можна знайти в каталозі.',
  'models.library.noAlternatives': 'У цьому каталозі немає інших моделей.',
  'models.library.download': 'Поточне завантаження моделі',
  'models.lead':
    'ШІ-модель відповідає на ваші запитання повністю на цьому пристрої. Усе перевіряється перед ' +
    'використанням, і без вашого явного підтвердження нічого не завантажується.',
  'models.loadError': 'Не вдалося відкрити список моделей: {error}',
  'models.checking':
    'Перевірка файлів моделей… Перша перевірка після додавання чи оновлення моделі може тривати ' +
    'кілька хвилин, якщо файли великі; після цього результат запамʼятовується, і далі перевірка ' +
    'відбувається миттєво.',
  'models.checkingProgress': 'Перевірка моделі {n} з {m}: {name} — {pct}%',
  'models.state.installed': 'Встановлено',
  'models.state.missing': 'Не завантажено',
  'models.state.checksumFailed': 'Не вдалося звірити',
  'models.state.unsupported': 'Не підтримується',
  'models.state.notRecommended': 'Не рекомендовано',
  'models.state.ready': 'Готово',
  'models.state.running': 'Працює',
  'models.badge.notResponding': 'Не відповідає',
  'models.notRespondingHint': 'ШІ-модель перестала відповідати. Зазвичай це виправляє перезапуск.',
  'models.restart': 'Перезапустити',
  'models.hint.embeddings': 'Готує ваші документи, щоб до них можна було ставити запитання.',
  'models.hint.reranker':
    'Покращує вибір фрагментів документів, які використовуються для відповідей.',
  'models.hint.transcriber':
    'Перетворює аудіозаписи на придатний для пошуку текст — і робить доступною кнопку 🎤 для ' +
    'голосового диктування в чаті.',
  'models.hint.translation':
    'Перекладає ваші документи й тексти з однієї мови на іншу повністю офлайн.',
  'models.hint.vision':
    'Відповідає на ваші запитання щодо одного зображення за раз. Не читає PDF-файли й не ' +
    'розпізнає текст у сканах.',
  'models.hint.small': 'Мала та швидка — швидкі відповіді майже на будь-якому компʼютері.',
  'models.hint.balanced': 'Збалансована — добре працює на більшості ноутбуків.',
  'models.hint.large': 'Велика — найкращі відповіді; потребує потужного компʼютера.',
  'models.usesSpace': 'Займає {size} місця на диску',
  'models.downloads.blockedByPolicy': 'Завантаження вимкнено відповідно до політики цього диска.',
  'models.downloads.enableInSettings':
    'Для завантажень увімкніть параметр «Дозволити доступ до інтернету для завантажень та оновлень» ' +
    'на екрані «Параметри».',
  'models.download.verifying': 'Перевірка завантаженого файлу…',
  'models.download.progress': 'Завантаження… {pct}% ({received} з {total})',
  'models.download.progressNoTotal': 'Завантаження… отримано {received}',
  'models.download.cancel': 'Скасувати завантаження',
  'models.download.cancelled':
    'Завантаження скасовано — якщо запустити його знову, воно продовжиться з місця зупинки.',
  'models.download.stoppedNetworkOff':
    'Зупинено, бо доступ до інтернету вимкнено — коли його знову буде увімкнено, завантаження ' +
    'можна запустити ще раз, і воно продовжиться з місця зупинки.',
  'models.download.unverifiedBefore':
    'Завантажено, але в маніфесті цієї моделі ще немає справжньої контрольної суми, тож файл ' +
    'залишається неперевіреним. Створіть її за допомогою ',
  'models.download.unverifiedAfter': '.',
  'models.download.otherRunning': 'Уже триває інше завантаження — моделі завантажуються по одній',
  'models.download.titled': 'Завантажити модель {name} ({size})',
  'models.download.resume': 'Продовжити завантаження',
  'models.download.start': 'Завантажити',
  'models.download.failed': 'Не вдалося завантажити модель {name}.',
  'models.download.retry': 'Повторити завантаження',
  'models.download.dismiss': 'Сховати',
  'models.download.retryUnavailable':
    'Ця модель більше не доступна тут для завантаження, тому повторити спробу з цього результату ' +
    'не можна. Сховайте цей результат або знайдіть модель у бібліотеці.',
  'models.download.retryInstalled': 'Уже є на цьому диску.',
  'models.download.withdrawn':
    'Більше не доступно для завантаження: видавець видалив саме цей файл ({reason}). Копії, які ' +
    'вже є на диску, і далі працюють, і їх можна перевірити.',
  'models.engine.title': 'Встановіть ШІ-рушій',
  'models.engine.explain':
    'Доки ШІ-рушій не встановлено, моделі працюють у вбудованому демонстраційному режимі ' +
    '(відповіді явно імітуються); для голосового диктування потрібен рушій мовлення. Встановіть ' +
    'рушії один раз — потім запустіть модель, щоб отримувати справжні відповіді.',
  'models.engine.install': 'Встановити ШІ-рушій',
  'models.engine.retry': 'Спробувати ще раз',
  'models.engineProblem.title': 'ШІ-рушій не може працювати на цьому компʼютері',
  'models.engineProblem.voiceTitle': 'Рушій мовлення не може працювати на цьому компʼютері.',
  'models.engineProblem.libraryMissingPackage':
    'Бракує потрібної йому системної бібліотеки: {library}. Встановіть пакет {debPackage} ' +
    '(Ubuntu, Debian, Linux Mint) або {rpmPackage} (Fedora) через менеджер програм або термінал, ' +
    'а потім натисніть кнопку «Перевірити ще раз».',
  'models.engineProblem.libraryMissing':
    'Бракує потрібної йому системної бібліотеки: {library}. Встановіть її через менеджер програм ' +
    'або термінал, а потім натисніть кнопку «Перевірити ще раз».',
  'models.engineProblem.systemTooOldLinux':
    'Йому потрібна новіша версія Linux: Ubuntu 22.04, Debian 12, Fedora 36 або новіша.',
  'models.engineProblem.systemTooOldMac':
    'Йому потрібна новіша версія macOS. Оновіть macOS, а потім натисніть кнопку «Перевірити ще ' +
    'раз».',
  'models.engineProblem.systemTooOld': 'Йому потрібна новіша версія операційної системи.',
  'models.engineProblem.vcRuntimeMissing':
    'У Windows бракує потрібного йому компонента Microsoft Visual C++ Redistributable (x64). ' +
    'Встановіть його, а потім натисніть кнопку «Перевірити ще раз».',
  'models.engineProblem.filesDamaged':
    'Деякі його файли на цьому диску відсутні або пошкоджені. У посібнику з усунення ' +
    'несправностей пояснено, як налаштувати його знову.',
  'models.engineProblem.filesDamagedReinstall':
    'Деякі його файли на цьому диску відсутні або пошкоджені. Встановіть його ще раз, щоб ' +
    'замінити їх.',
  'models.engineProblem.filesDamagedAfterInstall':
    'Його щойно встановлено, але він і далі не може запуститися, тож причина, найімовірніше, не ' +
    'в його файлах. У посібнику з усунення несправностей пояснено, що ще варто перевірити.',
  'models.engineProblem.filesDamagedAfterInstallWin':
    'Його щойно встановлено, але він і далі не може запуститися, тож причина, найімовірніше, не ' +
    'в його файлах. Це також може спричинити застарілий компонент Microsoft Visual C++ ' +
    'Redistributable (x64): встановіть актуальну версію, а потім натисніть кнопку «Перевірити ще ' +
    'раз».',
  'models.engineProblem.reinstall': 'Встановити ШІ-рушій ще раз',
  'models.engineProblem.voiceReinstall': 'Встановити рушій мовлення ще раз',
  'models.engineProblem.reinstalled': 'ШІ-рушій встановлено ще раз.',
  'models.engineProblem.voiceReinstalled': 'Рушій мовлення встановлено ще раз.',
  'models.engineUpdate.title': 'Доступне оновлення ШІ-рушія',
  'models.engineUpdate.voiceTitle': 'Доступне оновлення рушія мовлення',
  'models.engineUpdate.bothTitle': 'Доступні оновлення ШІ-рушія та рушія мовлення',
  'models.engineUpdate.explain':
    'На цьому диску встановлено старішу версію, ніж та, для якої створено цей застосунок. Спершу ' +
    'оновлення завантажує нову версію; потім, поки замінюються файли, моделі призупиняються на ' +
    'кілька секунд, і вибрана модель запускається знову.',
  'models.engineUpdate.update': 'Оновити',
  'models.engineUpdate.done': 'ШІ-рушій оновлено.',
  'models.engineUpdate.voiceDone': 'Рушій мовлення оновлено.',
  'models.engineUpdate.bothDone': 'ШІ-рушій і рушій мовлення оновлено.',
  'models.engineProblem.blocked':
    'Засоби безпеки Windows заблокували його (Smart App Control або ваша антивірусна програма). ' +
    'У посібнику з усунення несправностей пояснено, що можна зробити.',
  'models.engineProblem.demoNote':
    'Доти моделі відповідають у демонстраційному режимі — відповіді імітуються.',
  'models.engineProblem.check': 'Перевірити ще раз',
  'models.engineProblem.checking': 'Перевіряється…',
  'models.engineProblem.stillFailing':
    'Він і далі не може запуститися. Переконайтеся, що встановлення завершилося, а потім ' +
    'спробуйте ще раз.',
  'models.engineProblem.fixed': 'ШІ-рушій знову працює.',
  'models.engineProblem.voiceFixed': 'Рушій мовлення знову працює.',
  'models.engine.progress': 'Завантаження ШІ-рушія… {pct}%',
  'models.engine.downloadingNoTotal': 'Завантаження ШІ-рушія…',
  'models.engine.verifying': 'Перевірка ШІ-рушія…',
  'models.engine.extracting': 'Розпакування ШІ-рушія…',
  'models.voiceEngine.title': 'Додати голосове диктування (необовʼязково)',
  'models.voiceEngine.explain':
    'Відповіді в чаті та за документами вже працюють на цьому диску. Рушій мовлення ' +
    'необовʼязковий — встановлюйте його, лише якщо хочете диктувати повідомлення за допомогою ' +
    'мікрофона.',
  'models.voiceEngine.install': 'Встановити рушій мовлення',
  'models.packTools.row': 'Інструменти для пакетів знань: не встановлено',
  'models.packTools.install': 'Встановити…',
  'models.ocr.row': 'Розпізнавання тексту для сканів і фотографій (необовʼязково)',
  'models.ocr.rowOrientation':
    'Для вирівнювання сканів, повернутих набік, потрібен ще один OCR-файл (необовʼязково)',
  'ocr.install.action': 'Завантажити OCR-файли',
  'ocr.install.actionTitle':
    'Завантажити мовні файли розпізнавання тексту (OCR) для сканів і фотографій',
  'ocr.install.confirm.title': 'Завантажити OCR-файли?',
  'ocr.install.confirm.explain':
    'Розпізнавання тексту (OCR) читає скановані PDF-файли та сфотографовані сторінки на цьому ' +
    'компʼютері. Для цього на цьому диску мають бути файли, наведені нижче, — більше нічого не ' +
    'завантажується, а ваші документи ніколи не виходять за межі цього компʼютера.',
  'ocr.install.confirm.languages': 'Файли',
  'ocr.install.confirm.hint':
    'Перед використанням кожен файл звіряється з очікуваною контрольною сумою.',
  'ocr.install.confirm.start': 'Завантажити',
  'ocr.install.lang.deu': 'німецька',
  'ocr.install.lang.eng': 'англійська',
  'ocr.install.lang.osd': 'орієнтація сторінок (розвертає сторінки, що лежать боком)',
  'ocr.install.starting': 'Запуск завантаження…',
  'ocr.install.progress': 'Завантаження OCR-файлів… {pct}%',
  'ocr.install.verifying': 'Перевірка OCR-файлів…',
  'ocr.install.activating': 'Запуск розпізнавання тексту…',
  'ocr.install.failed': 'Не вдалося встановити OCR-файли.',
  'ocr.install.retry': 'Повторити завантаження OCR-файлів',
  'ocr.install.cancel': 'Скасувати завантаження OCR-файлів',
  'ocr.install.alreadyPresent':
    'OCR-файли вже є на цьому диску. Перезапустіть HilbertRaum, щоб використовувати їх.',
  'ocr.install.outcome.activated': 'Розпізнавання тексту готове — перезапуск не потрібен.',
  'ocr.install.outcome.restartRequired':
    'OCR-файли на місці. Перезапустіть HilbertRaum, щоб використовувати нові мовні файли.',
  'ocr.install.outcome.unchanged':
    'OCR-файли на місці. Якщо розпізнавання тексту й далі не пропонується, перезапустіть ' +
    'HilbertRaum.',
  'models.ram.needs': 'Потрібно щонайменше {min}\u00A0GB оперативної памʼяті',
  'models.ram.machine': ' — цей компʼютер має близько {ram}\u00A0GB',
  'models.ram.advice': '. Виберіть меншу модель — якість залишиться високою.',
  'models.badge.active': 'Активна',
  'models.badge.recommended': 'Рекомендовано для цього компʼютера',
  'models.badge.ramNeeded': 'Потрібно ≥{min}\u00A0GB RAM',
  'models.automatic.installed':
    'Встановлено — використовується автоматично. Запускати нічого не потрібно.',
  'models.automatic.notInstalled':
    'Після встановлення використовується автоматично — налаштовувати нічого не потрібно.',
  'models.transcriber.engineUnsupported':
    'У цій операційній системі застосунок поки що не може встановити рушій мовлення, тому тут ця ' +
    'модель не вмикає ні голосового диктування, ні імпорту аудіо.',
  'models.vision.installed':
    'Встановлено — автоматично використовується на екрані «Зображення». Тут нічого запускати не ' +
    'потрібно.',
  'models.vision.notInstalled':
    'Після встановлення автоматично використовується на екрані «Зображення» — налаштовувати ' +
    'нічого не потрібно.',
  'models.vision.goToImages': 'Відкрити Зображення',
  'models.translation.installed':
    'Встановлено — автоматично використовується для перекладу. Тут нічого запускати не потрібно.',
  'models.translation.notInstalled':
    'Після встановлення автоматично використовується для перекладу — налаштовувати нічого не ' +
    'потрібно.',
  'models.use': 'Вибрати цю модель',
  'models.useTitle': 'Вибрати цю модель і запустити її, щоб можна було спілкуватися в чаті',
  'models.stopRuntime': 'Зупинити модель',
  'models.answeringNote':
    'Зараз генерується відповідь. Якщо зупинити або змінити модель, відповідь буде перервано — ' +
    'уже написаний текст збережеться.',
  'models.startMock': 'Спробувати в демонстраційному режимі',
  'models.starting': 'Запуск…',
  'models.startingTitle': 'Ця модель запускається — для великих моделей це може тривати певний час',
  'models.startMockTitle':
    'Файлу моделі ще немає — спробуйте застосунок у демонстраційному режимі, де відповіді явно ' +
    'імітуються',
  'models.tech.summary': 'Технічні подробиці',
  'models.tech.id': 'Ідентифікатор моделі',
  'models.tech.family': 'Сімейство',
  'models.tech.format': 'Формат',
  'models.tech.runtime': 'Середовище виконання',
  'models.tech.license': 'Ліцензія',
  'models.tech.sizeOnDisk': 'Розмір на диску',
  'models.tech.minRam': 'Мінімальна оперативна памʼять',
  'models.tech.recRam': 'Рекомендована оперативна памʼять',
  'models.tech.context': 'Контекстне вікно',
  'models.tech.contextValue.one': '{count} токен',
  'models.tech.contextValue.few': '{count} токени',
  'models.tech.contextValue.many': '{count} токенів',
  'models.tech.contextValue.other': '{count} токена',
  'models.tech.file': 'Файл',
  // ---- Context-size picker (2026-07-04 user report — the truncation hint points here) ----
  'models.context.title': 'Розмір контексту',
  'models.context.label': 'Контекстне вікно для відповідей:',
  'models.context.auto': 'Автоматично — розмір, рекомендований для моделі',
  'models.context.autoResolved.one':
    'Автоматично — розмір, рекомендований для моделі ({count} токен)',
  'models.context.autoResolved.few':
    'Автоматично — розмір, рекомендований для моделі ({count} токени)',
  'models.context.autoResolved.many':
    'Автоматично — розмір, рекомендований для моделі ({count} токенів)',
  'models.context.autoResolved.other':
    'Автоматично — розмір, рекомендований для моделі ({count} токена)',
  'models.context.bigWarning':
    'Дуже великі вікна потребують багато додаткової памʼяті, поки модель працює. На менш ' +
    'потужних компʼютерах модель може не запуститися або відповідати значно повільніше — у ' +
    'такому разі виберіть менший розмір або автоматичний.',
  'models.context.hint':
    'Більший контекст дає змогу розмові чи відповіді за документами охопити більше тексту за ' +
    'раз, але потребує більше памʼяті й може сповільнити відповіді. Застосовується під час ' +
    'наступного запуску моделі.',
  'models.context.restartHint':
    'Зараз працює модель — зупиніть і знову запустіть її, щоб застосувати новий розмір.',
  'models.verifyTitle':
    'Повторно обчислити хеш файлу на диску та звірити його з SHA-256 (без використання кешу)',
  'models.verifying': 'Перевіряється…',
  'models.verify': 'Звірити контрольну суму',
  'models.verifyAll': 'Перевірити всі файли моделей',
  'models.verifyingAll': 'Перевірка всіх файлів моделей…',
  'models.verifyAllTitle': 'Повторно звірити кожен файл моделі на цьому диску з його SHA-256',
  'models.verifyAllHint':
    'Кожна модель перевіряється під час її запуску. Натомість ця дія перевіряє всі файли моделей ' +
    'на цьому диску — на повільному диску це може тривати кілька хвилин. Зупинити її можна ' +
    'будь-коли; уже перевірені файли залишаються перевіреними.',
  'models.verifyAllStop': 'Зупинити перевірку файлів',
  'models.verifyAllStopping': 'Зупинення…',
  'models.confirm.title': 'Завантажити модель {name}?',
  'models.confirm.start': 'Почати завантаження',
  'models.confirm.size': 'Розмір',
  'models.confirm.license': 'Ліцензія',
  'models.confirm.from': 'Джерело',
  'models.confirm.readLicense': 'Прочитати ліцензію',
  'models.confirm.hint':
    'Завантажений файл перевіряється перед використанням. Це єдиний мережевий запит застосунку — ' +
    'нічого про вас чи ваші документи не надсилається.',
  'models.confirm.licenseAck': 'Я приймаю умови ліцензії цієї моделі; їх прочитано',
  'models.empty.title': 'Маніфестів моделей не знайдено',
  'models.empty.lineBefore': 'Додайте YAML-маніфести до папки ',
  'models.empty.lineAfter': ' на диску.',
  'models.section.yourModel': 'Ваша ШІ-модель',
  'models.section.docSearch': 'Пошук у документах',
  // ---- Settings (SettingsScreen.tsx — chrome + the General tab) ----
  'settings.title': 'Параметри',
  'settings.tabsAria': 'Розділи параметрів',
  'settings.tab.general': 'Загальні',
  'settings.tab.privacy': 'Приватність і дані',
  'settings.tab.skills': 'Навички',
  'settings.tab.diagnostics': 'Діагностика (розширена)',
  'settings.loading': 'Відкриття параметрів…',
  'settings.saved': 'Збережено',
  'settings.saveFailed': 'Не вдалося зберегти цей параметр. Спробуйте ще раз.',
  'settings.network.title': 'Приватність і офлайн-режим',
  'settings.network.allow': 'Дозволити доступ до інтернету для завантажень та оновлень',
  'settings.network.hint':
    'Типово увімкнено, щоб щойно встановлений застосунок міг одразу завантажити модель. Коли ' +
    'вимкнено, застосунок не звертається до інтернету. Увімкнений параметр дає змогу ' +
    'завантажувати моделі, ШІ-рушій, додаткові інструменти для пакетів знань і додаткові файли ' +
    'розпізнавання тексту (OCR) — кожне завантаження спершу запитує підтвердження, а політика ' +
    'диска може повністю заборонити завантаження. Ваші запити й документи ніколи не виходять за ' +
    'межі цього пристрою, незалежно від цього параметра.',
  'settings.appearance.title': 'Вигляд',
  'settings.appearance.aria': 'Тема',
  'settings.appearance.system': 'Системна',
  'settings.appearance.light': 'Світла',
  'settings.appearance.dark': 'Темна',
  'settings.appearance.hint':
    'Варіант «Системна» відповідає вибору світлої або темної теми у вашій операційній системі. ' +
    'Екран блокування завжди використовує системну тему.',
  'settings.language.title': 'Мова',
  'settings.language.aria': 'Мова',
  'settings.language.system': 'Системна',
  'settings.language.hint':
    'Варіант «Системна» відповідає мові вашої операційної системи, якщо HilbertRaum її ' +
    'підтримує; інакше використовується англійська. Зміни застосовуються одразу.',
  'settings.performance.title': 'Швидкодія',
  'settings.performance.gpu': 'Використовувати GPU-прискорення',
  'settings.performance.gpuHint':
    'Використовує відеокарту, щоб пришвидшити відповіді, якщо вона доступна. Вимикайте, лише ' +
    'якщо помічаєте проблеми зі стабільністю — усе працюватиме в будь-якому разі.',
  'settings.performance.rerankWideScope': 'Переранжувати більше фрагментів із пакетів знань',
  'settings.performance.rerankWideScopeHint':
    'Повільніше для кожного запитання. Діє лише на компʼютері з достатньою кількістю потоків ' +
    'процесора та встановленою моделлю переранжування; компʼютер із придатною відеокартою вже ' +
    'переранжовує кожен фрагмент.',
  'settings.performance.autoStart':
    'Автоматично запускати вибрану модель, коли відкривається застосунок',
  'settings.performance.autoStartHint':
    'Типово увімкнено. Модель, вибрана на екрані «ШІ-модель», запускається у фоновому режимі, ' +
    'коли відкривається застосунок (у зашифрованих робочих просторах — після розблокування), тож ' +
    'екран «Чат» готовий без зайвих клацань.',
  // ---- Settings: Chat / conversation compaction (context-compaction plan §5.4) ----
  'settings.chat.title': 'Чат',
  'settings.chatCompaction.label': 'Підсумовувати старіші повідомлення, щоб звільнити контекст',
  'settings.chatCompaction.help':
    'Типово увімкнено. Коли довга розмова наближається до межі контексту моделі, старіші ' +
    'повідомлення один раз підсумовуються в стислу нотатку (вона зберігається на цьому диску), а ' +
    'не непомітно відкидаються. Вимкніть, щоб зберігати лише найновіші повідомлення, які ' +
    'вміщуються.',
  'settings.developer.title': 'Для розробників',
  'settings.developer.toggle':
    'Режим для розробників (дає змогу використовувати незашифрований робочий простір і ' +
    'неперевірені моделі)',
  'settings.developer.hint':
    'Типово вимкнено. Збірки для розробки завжди працюють у режимі для розробників. Вирішальною ' +
    'є політика диска: на комерційному диску неперевірені моделі й далі відхиляються незалежно ' +
    'від цього параметра.',
  'settings.workspace.title': 'Робочий простір',
  'settings.workspace.mode': 'Режим',
  'settings.workspace.modeEncrypted': 'Зашифрований',
  'settings.workspace.modePlaintext': 'Незашифрований (для розробників)',
  'settings.workspace.contextTokens': 'Токени контексту',
  'settings.workspace.contextAuto':
    'Автоматично (типове значення моделі) — змінити можна на екрані «ШІ-модель»',
  'settings.workspace.encryptedHint':
    'Дані цього робочого простору зберігаються в зашифрованому вигляді. Щоб знову зашифрувати й ' +
    'заблокувати його, скористайтеся кнопкою «Заблокувати» на бічній панелі; під час виходу із ' +
    'застосунку він також блокується автоматично.',
  'settings.workspace.plaintextHint':
    'Незашифрований робочий простір для розробників — дані зберігаються без шифрування. Для ' +
    'комерційної версії типовим є зашифрований режим.',
  'settings.changePassword.title': 'Змінити пароль',
  'settings.changePassword.hint':
    'Виберіть новий пароль для цього робочого простору. Він діятиме з наступного розблокування. ' +
    'Його не можна відновити або скинути, тож виберіть такий, який ви запамʼятаєте.',
  'settings.changePassword.current': 'Поточний пароль',
  'settings.changePassword.new': 'Новий пароль',
  'settings.changePassword.confirm': 'Підтвердьте новий пароль',
  'settings.changePassword.busy':
    'Захист ваших документів новим паролем… Якщо документів багато, це може тривати кілька ' +
    'хвилин.',
  'settings.changePassword.failed': 'Щось пішло не так. Ваш поточний пароль і далі діє.',
  'settings.changePassword.submit': 'Змінити пароль',
  'settings.changePassword.submitBusy': 'Зміна пароля…',
  'settings.changePassword.toast': 'Пароль змінено',
  // ---- Skills (settings/SkillsTab.tsx, skills plan §15) ----
  'skills.intro':
    'Навички вчать помічника виконувати певне завдання. Вони додають до його відповідей вказівки ' +
    '— і ніколи не звертаються ні до інтернету, ні до інших папок на вашому компʼютері.',
  'skills.info.meeting-protocol.what':
    'Оформлює наступну відповідь як чіткий протокол зустрічі: рішення, завдання й відкриті ' +
    'питання.',
  'skills.info.meeting-protocol.needs':
    'Текст розмови із зустрічі або нотатки, вибрані для цього чату (прикріпіть файл або вставте ' +
    'текст).',
  'skills.info.meeting-protocol.limits':
    'Обробляє один документ за раз і фіксує лише те, що справді є в нотатках.',
  'skills.info.contract-brief.what':
    'Стисло викладає договір простою мовою: сторони, дати, зобовʼязання, ключові умови та ' +
    'запитання, які варто поставити.',
  'skills.info.contract-brief.needs': 'Договір, вибраний для цього чату.',
  'skills.info.contract-brief.limits':
    'Допомагає читати один документ за раз — це не юридична консультація.',
  'skills.info.deadline-obligation-finder.what':
    'Знаходить кінцеві строки, строки попередження, дати продовження й оплати, а також повʼязані ' +
    'з ними зобовʼязання.',
  'skills.info.deadline-obligation-finder.needs': 'Документ, вибраний для цього чату.',
  'skills.info.deadline-obligation-finder.limits':
    'Читає один документ за раз; перш ніж діяти, звірте важливі дати з оригіналом.',
  'skills.info.what-changed.what':
    'Порівнює дві версії документа й показує суттєві зміни, а не необроблений перелік ' +
    'відмінностей.',
  'skills.info.what-changed.needs': 'Рівно два документи (або дві версії), вибрані для цього чату.',
  'skills.info.what-changed.limits':
    'Якщо вибрано більше або менше ніж два документи, порівняння не виконується, і відповідь ' +
    'буде звичайною.',
  'skills.info.share-safe-review.what':
    'Перевіряє документ перед поширенням: видима чутлива інформація та практичні ризики ' +
    'поширення.',
  'skills.info.share-safe-review.needs': 'Документ, вибраний для цього чату.',
  'skills.info.share-safe-review.limits':
    'Лише рекомендації — навичка ніколи не стверджує, що документ знеособлено або що його ' +
    'безпечно оприлюднювати.',
  'skills.info.invoice.what':
    'Читає рахунок на оплату й точно витягує дані, які можна перевірити: позиції та загальні ' +
    'суми, перевірка загальних сум, експорт у CSV, JSON або XML.',
  'skills.info.invoice.needs':
    'Документ, схожий на рахунок на оплату, серед вибраних документів; дії навички зʼявляються у ' +
    'вигляді кнопок просто над полем повідомлення.',
  'skills.info.invoice.limits':
    'Один рахунок на оплату за раз; загальна сума, яку не вдалося перевірити, позначається як ' +
    'неперевірена, а не замовчується.',
  'skills.info.bank-statement.what':
    'Читає банківську виписку й точно витягує дані, які можна перевірити: транзакції, категорії, ' +
    'перевірка залишків, експорт у CSV.',
  'skills.info.bank-statement.needs':
    'Документ, схожий на банківську виписку, серед вибраних документів; дії навички зʼявляються ' +
    'у вигляді кнопок просто над полем повідомлення.',
  'skills.info.bank-statement.limits':
    'Одна виписка за раз; для розподілу транзакцій за категоріями потрібна запущена модель.',
  'skills.info.document-redaction.what':
    'Зберігає копію документа з прихованими даними: адреси електронної пошти, номери й дати ' +
    'виявляються за правилами, а імена й адреси знаходить модель.',
  'skills.info.document-redaction.needs':
    'Вибраний документ; кнопка «Приховати персональні дані» зʼявляється просто над полем ' +
    'повідомлення.',
  'skills.info.document-redaction.limits':
    'У міру можливостей, без гарантії — без запущеної моделі працює лише виявлення за правилами; ' +
    'документи Word зберігаються як .docx, інші формати — як .txt.',
  'skills.info.document-edit.what':
    'Вносить точкові зміни через пошук і заміну та зберігає відредаговану копію — ваш документ ' +
    'ніколи не переписується.',
  'skills.info.document-edit.needs':
    'Запущена модель, вибраний документ і ваша вказівка (наприклад, «замініть X на Y»); кнопка ' +
    '«Застосувати зміни до тексту» зʼявляється просто над полем повідомлення.',
  'skills.info.document-edit.limits':
    'Текст, який не знайдено дослівно, пропускається, і про це повідомляється; документи Word ' +
    'зберігаються як .docx, інші формати — як .txt.',
  'skills.autoFire.title': 'Автоматично застосовувати відповідну навичку',
  'skills.autoFire.toggle': 'Автоматично застосовувати відповідну навичку',
  'skills.autoFire.hint':
    'Якщо увімкнено, застосунок може сам використати для відповіді вбудовану навичку, яка чітко ' +
    'підходить, щоб вам не доводилося її вибирати. Лише вбудовані навички — ніколи не ті, які ви ' +
    'створили або імпортували. Ви завжди бачитимете, яку навичку використано, і зможете отримати ' +
    'відповідь без неї для цього запитання. Типово вимкнено.',
  'skills.autoFire.on': 'Автоматичні навички увімкнено',
  'skills.autoFire.off': 'Автоматичні навички вимкнено',
  'skills.autoFire.saveFailed': 'Не вдалося зберегти параметр автоматичних навичок.',
  'skills.import': 'Імпортувати навичку…',
  'skills.import.menuAria': 'Імпортувати навичку',
  'skills.import.fromFile': 'З файлу (.skill.zip)…',
  'skills.import.fromFolder': 'З папки…',
  'skills.loading': 'Відкриття списку навичок…',
  'skills.loadFailed': 'Не вдалося відкрити список навичок.',
  'skills.reconcile.folderErrors.one':
    '{count} папку навички не вдалося прочитати й пропущено. Кожна папка має містити правильний ' +
    'файл SKILL.md.',
  'skills.reconcile.folderErrors.few':
    '{count} папки навичок не вдалося прочитати й пропущено. Кожна папка має містити правильний ' +
    'файл SKILL.md.',
  'skills.reconcile.folderErrors.many':
    '{count} папок навичок не вдалося прочитати й пропущено. Кожна папка має містити правильний ' +
    'файл SKILL.md.',
  'skills.reconcile.folderErrors.other':
    '{count} папки навички не вдалося прочитати й пропущено. Кожна папка має містити правильний ' +
    'файл SKILL.md.',
  'skills.empty.title': 'Навичок ще немає',
  'skills.empty.line':
    'Навички вчать помічника виконувати певне завдання. Додайте навичку, щоб почати.',
  'skills.trusted.app': 'Вбудована',
  'skills.trusted.user': 'Створена вами',
  'skills.row.enableLabel': 'Увімкнено',
  'skills.row.on': 'Навичку увімкнено',
  'skills.row.off': 'Навичку вимкнено',
  'skills.row.onFailed': 'Не вдалося увімкнути цю навичку.',
  'skills.row.offFailed': 'Не вдалося вимкнути цю навичку.',
  'skills.dup.chip': 'Назва повторюється',
  'skills.dup.title':
    'Цю назву використовує інша встановлена навичка. Водночас активною може бути лише одна.',
  'skills.unavailable.chip': 'Файлів немає',
  'skills.unavailable.title': 'Файлів цієї навички більше немає на диску.',
  'skills.incompatible.chip': 'Потрібне оновлення',
  'skills.incompatible.title':
    'Цій навичці потрібна новіша версія застосунку; оновіть застосунок, щоб її увімкнути.',
  'skills.review.chip': 'Перевірити',
  'skills.warn.title': 'Перевірте, що може робити ця навичка',
  'skills.warn.body':
    'Створена вами або імпортована. Перш ніж покладатися на цю навичку, перевірте, що вона може ' +
    'робити.',
  'skills.warn.ack': 'Зрозуміло',
  'skills.menu.aria': 'Дії з навичкою',
  'skills.menu.export': 'Експортувати…',
  'skills.menu.delete': 'Видалити',
  'skills.export.done': 'Навичку експортовано',
  'skills.export.failed': 'Не вдалося експортувати цю навичку.',
  'skills.delete.title': 'Видалити цю навичку?',
  'skills.delete.body':
    'Навичку буде видалено з диска. Чати, у яких її вже використовували, працюватимуть і далі.',
  'skills.delete.confirm': 'Видалити',
  'skills.delete.done': 'Навичку видалено',
  'skills.delete.failed': 'Не вдалося видалити цю навичку.',
  'skills.detail.aria': 'Відомості про навичку',
  'skills.detail.version': 'Версія',
  'skills.detail.author': 'Автор',
  'skills.detail.language': 'Мова',
  'skills.detail.kind': 'Тип',
  'skills.kind.instruction': 'Вказівки',
  'skills.kind.tool': 'Використовує інструменти',
  'skills.tool.note':
    'Поки що ця навичка лише додає вказівки. Інструменти, які вона описує, зʼявляться в одній із ' +
    'наступних версій.',
  'skills.tool.note.active':
    'Коли ви попросите, ця навичка може запускати схвалені локальні інструменти для вибраного ' +
    'вами документа. Інструменти, які лише читають дані, можуть запускатися й автоматично, щоб ' +
    'відповісти на ваше запитання; усе, що записує або експортує файл, завжди спершу просить ' +
    'вашого підтвердження. Інструменти бачать лише цей документ.',
  'skills.perm.heading': 'Що може робити ця навичка',
  'skills.perm.canTitle': 'Ця навичка може:',
  'skills.perm.cannotTitle': 'Ця навичка не може:',
  'skills.perm.can.instructions': 'Додавати вказівки до відповідей ШІ',
  'skills.perm.can.documents': 'Читати лише вибрані вами документи',
  'skills.perm.can.tools': 'Використовувати схвалені локальні інструменти, коли ви попросите',
  'skills.perm.cannot.network': 'Звертатися до інтернету',
  'skills.perm.cannot.files': 'Читати інші папки на вашому компʼютері',
  'skills.perm.cannot.scripts': 'Запускати сценарії або встановлювати програми',
  'skills.tech.summary': 'Технічні подробиці',
  'skills.tech.id': 'Ідентифікатор навички',
  'skills.tech.installId': 'Ідентифікатор встановлення',
  'skills.tech.source': 'Походження',
  'skills.tech.permissions': 'Дозволи',
  'skills.import.title': 'Додати цю навичку?',
  'skills.import.confirm': 'Додати навичку',
  'skills.import.added': 'Навичку додано',
  'skills.import.failedTitle': 'Цю навичку не можна додати',
  'skills.import.failed': 'Не вдалося додати цю навичку.',
  'skills.import.collision':
    'Навичку з такою назвою вже встановлено. Якщо додати цю, вона замінить наявну.',
  'skills.import.collisionApp':
    'Цю назву вже використовує вбудована навичка. Вашу навичку буде додано, але вона ' +
    'залишатиметься вимкненою, доки вбудована навичка увімкнена.',
  'skills.import.upgrade': 'Оновлює встановлену версію ({from} → {to}).',
  'skills.import.replace': 'Замінює встановлену версію ({version}).',
  'skills.import.downgrade': 'Ця версія старіша за встановлену ({installed}).',
  'skills.import.downgradeBlocked':
    'Щоб встановити старішу версію, потрібен режим для розробників. Увімкніть його (Параметри → ' +
    'Загальні), щоб дозволити це.',
  'skills.import.error.notFound': 'Не вдалося знайти вибрану навичку.',
  'skills.import.error.notZipOrFolder':
    'Навичка має бути файлом .skill.zip або папкою з файлом SKILL.md.',
  'skills.import.error.unreadableZip':
    'Не вдалося прочитати пакет навички як правильний ZIP-архів.',
  'skills.import.error.encryptedZip':
    'Пакет навички має непідтримуваний формат ZIP (зашифрований або ZIP64).',
  'skills.import.error.unsupportedCompression':
    'Пакет навички використовує непідтримуваний метод стиснення.',
  'skills.import.error.pathTraversal':
    'Пакет містить файл, шлях до якого виходить за межі папки пакету.',
  'skills.import.error.absolutePath':
    'Пакет містить файл з абсолютним шляхом або шляхом із літерою диска.',
  'skills.import.error.invalidPath': 'Пакет містить файл з неправильним шляхом.',
  'skills.import.error.symlink': 'Пакет містить символічне посилання, а це не дозволено.',
  'skills.import.error.tooDeep': 'У пакеті папки вкладено глибше, ніж дозволено.',
  'skills.import.error.pathTooLong': 'Пакет містить задовгий шлях до файлу.',
  'skills.import.error.tooManyFiles': 'Пакет містить більше файлів, ніж дозволено.',
  'skills.import.error.tooLarge': 'Пакет перевищує дозволений розмір.',
  'skills.import.error.fileTooLarge': 'Один із файлів пакету перевищує дозволений розмір.',
  'skills.import.error.duplicatePath':
    'Пакет містить два файли, що відповідають одному й тому самому шляху.',
  'skills.import.error.badExtension': 'Пакет містить файл недозволеного типу.',
  'skills.import.error.nestedArchive': 'Пакет містить вкладений архів, а це не дозволено.',
  'skills.import.error.noSkillMd': 'Пакет не містить файлу SKILL.md.',
  'skills.import.error.invalidManifest': 'Маніфест навички неправильний.',
  'skills.import.error.idMismatch': 'Ідентифікатор навички не є допустимою назвою.',
  'skills.import.error.downgradeBlocked':
    'Новішу версію цієї навички вже встановлено. Щоб встановити старішу версію, увімкніть режим ' +
    'для розробників.',
  'skills.import.error.appReadOnly': 'Вбудовані навички не можна змінити або видалити.',
  'skills.import.error.locked': 'Розблокуйте робочий простір, щоб керувати навичками.',
  'skills.import.note.permissionNotString':
    'Дозвіл «{field}» не є текстовим значенням; використовується типове значення «{value}».',
  'skills.import.note.permissionUnrecognized':
    'Дозвіл «{field}» має значення, яке цей застосунок не розпізнає; використовується типове ' +
    'значення «{value}».',
  'skills.import.note.permissionClamped':
    'Навичка запитує ширший доступ «{field}», ніж дозволяє цей застосунок; доступ обмежено ' +
    'значенням «{value}».',
  'skills.import.note.listInvalid':
    'Список «{field}» не є списком текстових значень і ігнорується.',
  'skills.import.note.listItemsTooLong': 'Деякі записи в полі «{field}» задовгі й ігноруються.',
  'skills.import.note.listTruncated':
    'Поле «{field}» містить більше записів, ніж дозволено; залишаються лише перші {max}.',
  'skills.import.note.languageInvalid':
    'Поле «language» не містить правильного коду мови; використовується «en».',
  'skills.import.note.allowedToolsIgnored':
    'Для навички типу «Вказівки» оголошені інструменти ігноруються (інструменти зʼявляться в ' +
    'одній із наступних версій).',
  'skills.import.note.analysisInvalid': 'Поле «analysis» має невідоме значення й ігнорується.',
  'skills.import.note.analysisIgnoredForTool':
    'Для навички, що використовує інструменти, поле «analysis» ігнорується (як працювати з усім ' +
    'документом, визначає застосунок).',
  'skills.import.note.triggersInvalid': 'Блок «triggers» неправильний і ігнорується.',
  'skills.import.note.autoFireInvalid':
    'Поле «triggers.autoFire» має бути true або false; його значення вважається false.',
  'skills.import.note.localizedInvalid': 'Блок «localized» неправильний і ігнорується.',
  'skills.import.note.localizedLocaleInvalid':
    'Запис у блоці «localized» має неправильний ключ мови й ігнорується.',
  'skills.import.note.localizedEntryInvalid':
    'Запис у блоці «localized» неправильний і ігнорується.',
  'skills.import.note.localizedTitleIgnored':
    'Перекладену назву проігноровано (це має бути один короткий рядок).',
  'skills.import.note.localizedDescriptionIgnored':
    'Перекладений опис проігноровано (це має бути один короткий рядок).',
  'skills.import.note.localizedTooMany':
    'Блок «localized» містить більше мов, ніж дозволено; залишаються лише перші {max}.',
  'skills.import.note.trustIgnored':
    'Поле «trust» у навичці ігнорується; рівень довіри застосунок визначає сам.',
  'skills.import.note.manifestJsonConflict':
    'Поле «{field}» у вкладеному файлі manifest.json відрізняється від SKILL.md; ' +
    'використовується SKILL.md.',
  'skills.replace.title': 'Використовувати цю навичку замість іншої?',
  'skills.replace.body':
    'Увімкнено іншу навичку з такою назвою. Якщо увімкнути цю, іншу буде вимкнено.',
  'skills.replace.confirm': 'Увімкнути',
  // ---- Settings → Privacy & data tab (PrivacyTab.tsx) ----
  'privacy.offlineOn': '● Офлайн-режим: увімкнено',
  'privacy.offlineOff': '○ Доступ до мережі увімкнено',
  'privacy.statement.offline':
    'Офлайн-режим увімкнено. HilbertRaum запускає ШІ-модель на цьому компʼютері. Ваші запити, ' +
    'документи, ембединги та історія чатів залишаються на цьому пристрої.',
  'privacy.statement.online':
    'HilbertRaum запускає ШІ-модель на цьому компʼютері. Ваші запити, документи, ембединги та ' +
    'історія чатів залишаються на цьому пристрої — навіть коли доступ до інтернету увімкнено, мережу ' +
    'використовують лише завантаження (моделей, ШІ-рушія, додаткових інструментів для пакетів знань ' +
    'і додаткових файлів розпізнавання тексту (OCR)).',
  'privacy.statement.noUploads':
    'Цей застосунок не надсилає ваші дані постачальникам хмарних ШІ-сервісів. Ні запити, ні ' +
    'документи, ні ембединги не надсилаються; немає ні телеметрії, ні аналітики, ні віддалених ' +
    'звітів про збої.',
  'privacy.network.title': 'Поточний стан мережі',
  'privacy.networkState.noPolicy': 'Офлайн-режим увімкнено.',
  'privacy.networkState.disabledByPolicy': 'Доступ до мережі вимкнено відповідно до політики.',
  'privacy.networkState.offDefault':
    'Офлайн-режим увімкнено (доступ до інтернету вимкнено на екрані «Параметри»).',
  'privacy.networkState.enabled':
    'Доступ до інтернету увімкнено для завантажень: моделі, ШІ-рушій, додаткові інструменти для ' +
    'пакетів знань і додаткові файли розпізнавання тексту (OCR).',
  'privacy.network.noFiles': 'Ні запити, ні файли не виходять за межі цього пристрою.',
  'privacy.network.effective': 'Фактичний стан',
  'privacy.network.effectiveOffline': 'Офлайн (без звернень до інтернету)',
  'privacy.network.effectiveAllowed': 'Мережу дозволено',
  'privacy.network.byPolicy': 'Політика дозволяє',
  'privacy.network.policyYes': 'Так',
  'privacy.network.policyNo': 'Ні (вимкнено відповідно до політики)',
  'privacy.network.yourSetting': 'Ваш параметр',
  'privacy.network.settingAllowed': 'Доступ до інтернету дозволено',
  'privacy.network.settingOff': 'Вимкнено',
  'privacy.network.telemetry': 'Телеметрія',
  'privacy.network.telemetryValue':
    'Ніщо не виходить за межі цього пристрою — відстеження немає, тож і вимикати нічого',
  'privacy.network.hint':
    'Застосунок попереджає перед будь-якою дією в інтернеті. Він завантажує лише ШІ-моделі, ' +
    'ШІ-рушій, додаткові інструменти для пакетів знань і додаткові файли розпізнавання тексту ' +
    '(OCR) — щоразу лише після вашого підтвердження, і кожен файл перевіряється перед ' +
    'використанням. Типово це увімкнено; вимкнути можна на вкладці «Загальні». Політика диска ' +
    'може повністю це заборонити. Локальний API нижче — окрема функція, яку вмикають лише за ' +
    'бажанням; вона ніколи не звертається до інтернету.',
  'privacy.data.title': 'Де зберігаються ваші дані',
  'privacy.data.driveRoot': 'Корінь диска',
  'privacy.data.workspace': 'Робочий простір',
  'privacy.data.models': 'Моделі',
  'privacy.data.logs': 'Журнали',
  'privacy.data.loading': 'Визначення шляхів…',
  'privacy.data.hint':
    'Усе — імпортовані документи, видобутий текст, ембединги, історія чатів, згенеровані ' +
    'результати, параметри — зберігається локально у вашому робочому просторі. Щоб видалити ці ' +
    'дані, видаліть папку робочого простору.',
  'privacy.logs.title': 'Лише локальні журнали',
  'privacy.logs.hintBefore':
    'Журнали налагодження й діагностики записуються у файл із ротацією в папці журналів, ' +
    'указаній вище, і ',
  'privacy.logs.never': 'ніколи не надсилаються',
  'privacy.logs.hintAfter': '. Діагностика нічого не передає за межі цього пристрою.',
  'privacy.protection.title': 'Захист робочого простору',
  'privacy.protection.encryptedBefore': 'Ваш робочий простір працює в ',
  'privacy.protection.encryptedWord': 'зашифрованому',
  'privacy.protection.encryptedAfter': ' режимі.',
  'privacy.protection.plainBefore': 'Ваш робочий простір працює в ',
  'privacy.protection.plainWord': 'незашифрованому режимі для розробників',
  'privacy.protection.plainAfter':
    '. Файли зберігаються на диску без шифрування, щоб пришвидшити розробку.',
  'privacy.protection.plainWarning':
    'Незашифрований режим для розробників — не типовий режим комерційної версії. Комерційні ' +
    'диски використовують зашифрований режим: ключ виводиться з пароля, і нічого не зберігається ' +
    'без шифрування. Не зберігайте конфіденційні документи в незашифрованому режимі на спільному ' +
    'або знімному диску.',
  // ---- Settings → Privacy & data → "Local API" card (local-api wave P4) ----
  'settings.localApi.title': 'Локальний API',
  'settings.localApi.lead':
    'Дозвольте іншим програмам на цьому компʼютері надсилати текст вашій ШІ-моделі та читати ' +
    'відповіді. Ця функція вимкнена, доки ви її не увімкнете.',
  'settings.localApi.toggle':
    'Дозволити іншим застосункам на цьому компʼютері використовувати мою ШІ-модель',
  'settings.localApi.hint':
    'Зʼєднання ніколи не виходить за межі цього компʼютера — нічого не надсилається через ' +
    'інтернет.',
  'settings.localApi.policyOff': 'Вимкнено відповідно до політики вашого диска.',
  'settings.localApi.confirm.title': 'Дозволити іншим застосункам використовувати вашу модель?',
  'settings.localApi.confirm.what':
    'Інші програми на цьому компʼютері зможуть надсилати текст вашій ШІ-моделі та читати її ' +
    'відповіді.',
  'settings.localApi.confirm.boundary':
    'Вони не бачать ваших документів, файлів і розмов, і через HilbertRaum ніщо не виходить за ' +
    'межі цього компʼютера. Проте HilbertRaum не може контролювати, що підключена програма ' +
    'робить з отриманими відповідями. Перш ніж підключати застосунок, перевірте, чи він зберігає ' +
    'або синхронізує свої дані.',
  'settings.localApi.confirm.persists':
    'Функція залишатиметься увімкненою, доки ви її не вимкнете.',
  'settings.localApi.confirm.neverStored':
    'Запити інших застосунків отримують відповідь і забуваються — вони не зберігаються ні в ' +
    'історії чатів, ні в журналах.',
  'settings.localApi.confirm.ack': 'Я розумію, що зможуть робити інші програми.',
  'settings.localApi.confirm.cta': 'Увімкнути',
  'settings.localApi.connect.title': 'Підключити інший застосунок',
  'settings.localApi.connect.hint':
    'Вставте ці два значення в застосунок, який хочете підключити. У більшості застосунків вони ' +
    'називаються «base URL» і «API key».',
  'settings.localApi.connect.address': 'Адреса сервера',
  'settings.localApi.connect.key': 'Ключ доступу',
  'settings.localApi.connect.copy': 'Скопіювати',
  'settings.localApi.connect.copyAddressAria': 'Скопіювати адресу сервера',
  'settings.localApi.connect.copyKeyAria': 'Скопіювати ключ доступу',
  'settings.localApi.connect.copiedAddress': 'Адресу сервера скопійовано.',
  'settings.localApi.connect.copiedKey':
    'Скопійовано — буфер обміну буде автоматично очищено за хвилину. Журнал буфера обміну ' +
    'Windows або синхронізація можуть зберегти копії.',
  'settings.localApi.connect.copyFailed': 'Не вдалося скопіювати. Спробуйте ще раз.',
  'settings.localApi.connect.noKey': 'Поки вимогу ключа вимкнено, ключ доступу не потрібен.',
  'settings.localApi.model.running': 'Модель працює — інші застосунки можуть отримувати відповіді.',
  'settings.localApi.model.stopped':
    'Жодна модель не працює — інші застосунки отримуватимуть помилку, доки ви не запустите ' +
    'модель.',
  'settings.localApi.status.port': 'Очікує зʼєднань на порту {port}.',
  'settings.localApi.status.served.one': 'Наразі оброблено {count} запит.',
  'settings.localApi.status.served.few': 'Наразі оброблено {count} запити.',
  'settings.localApi.status.served.many': 'Наразі оброблено {count} запитів.',
  'settings.localApi.status.served.other': 'Наразі оброблено {count} запиту.',
  'settings.localApi.status.off': 'Не працює.',
  'settings.localApi.busyWarning':
    'Зараз вашу модель використовує інший застосунок. Якщо водночас користуватися чатом тут, це ' +
    'може сповільнити роботу обох — ваш власний чат завжди має пріоритет.',
  'settings.localApi.preemptedWarning':
    'Щойно ваша власна робота в HilbertRaum перервала запит іншого застосунку. Застосунок може ' +
    'просто спробувати ще раз.',
  'settings.localApi.token.toggle': 'Вимагати ключ доступу',
  'settings.localApi.token.hint': 'Рекомендовано: залиште увімкненим.',
  'settings.localApi.token.confirm.title': 'Вимкнути ключ доступу?',
  'settings.localApi.token.confirm.body':
    'Без ключа доступу будь-яка програма на цьому компʼютері може використовувати вашу ' +
    'ШІ-модель, не питаючи дозволу. Залиште його увімкненим, хіба що застосунок справді не може ' +
    'ввести ключ.',
  'settings.localApi.token.confirm.cta': 'Вимкнути',
  'settings.localApi.token.regenerate': 'Створити новий ключ',
  'settings.localApi.token.regenerate.title': 'Створити новий ключ доступу?',
  'settings.localApi.token.regenerate.body':
    'Застосунки зі старим ключем перестануть працювати, доки ви не вставите в них новий ключ.',
  'settings.localApi.token.regenerate.cta': 'Створити новий ключ',
  'settings.localApi.token.regenerated': 'Новий ключ доступу створено.',
  'settings.localApi.token.regenerateFailed': 'Не вдалося створити новий ключ. Спробуйте ще раз.',
  'settings.localApi.port.label': 'Номер порту',
  'settings.localApi.port.hint':
    'Змінюйте його, лише якщо цей номер уже використовує інша програма. Від 1024 до 65535.',
  'settings.localApi.error.portInUse':
    'Цей номер уже використовує інша програма на цьому компʼютері. Це також може означати, що ' +
    'інша програма видає себе за HilbertRaum, тому нікуди не вставляйте ключ доступу, доки не ' +
    'розберетеся з цим. Змініть номер (наприклад, {suggestion}) і знову увімкніть локальний API; ' +
    'якщо застосунок уже був підключений, вставте в нього також нову адресу сервера.',
  'settings.localApi.error.startFailed':
    'Не вдалося запустити локальний API. Подробиці — на вкладці «Діагностика».',
  // ---- Settings → Diagnostics tab (DiagnosticsTab.tsx) ----
  'diag.localOnly': 'Лише локальна діагностика. Звідси ніколи нічого не надсилається.',
  'diag.localApi.label': 'Локальний API',
  'diag.localApi.off': 'Вимкнено',
  'diag.localApi.running': 'Увімкнено · порт {port} · оброблено: {served}, відхилено: {rejected}',
  'diag.localApi.portInUse': 'Вимкнено — цей номер порту вже використовується',
  'diag.localApi.startFailed': 'Вимкнено — не вдалося запустити',
  'diag.audit.runtime_started': 'Модель запущено',
  'diag.audit.runtime_stopped': 'Модель зупинено',
  'diag.audit.runtime_crashed': 'Модель неочікувано зупинилася',
  'diag.audit.runtime_fallback': 'Режим сумісності',
  'diag.audit.model_selected': 'Модель вибрано',
  'diag.audit.model_verified': 'Контрольну суму моделі звірено',
  'diag.audit.model_download_started': 'Завантаження розпочато',
  'diag.audit.model_download_verified': 'Завантаження перевірено',
  'diag.audit.model_download_failed': 'Не вдалося завантажити',
  'diag.audit.document_imported': 'Документ імпортовано',
  'diag.audit.document_reindexed': 'Документ переіндексовано',
  'diag.audit.document_deleted': 'Документ видалено',
  'diag.audit.document_task_completed': 'Завдання з документом завершено',
  'diag.audit.document_task_failed': 'Не вдалося виконати завдання з документом',
  'diag.audit.document_exported': 'Документ експортовано',
  'diag.audit.summary_exported': 'Підсумок експортовано',
  'diag.audit.conversation_deleted': 'Розмову видалено',
  'diag.audit.conversation_exported': 'Розмову експортовано',
  'diag.audit.message_table_exported': 'Таблицю з відповіді експортовано',
  'diag.audit.code_block_exported': 'Блок коду збережено як файл',
  'diag.audit.workspace_created': 'Робочий простір створено',
  'diag.audit.workspace_unlocked': 'Робочий простір розблоковано',
  'diag.audit.workspace_locked': 'Робочий простір заблоковано',
  'diag.audit.workspace_unlock_failed': 'Не вдалося розблокувати',
  'diag.audit.workspace_lock_failed':
    'Не вдалося заблокувати (робочий простір залишився відкритим)',
  'diag.audit.workspace_password_changed': 'Пароль робочого простору змінено',
  'diag.audit.settings_changed': 'Параметри змінено',
  'diag.audit.local_api_toggled': 'Локальний API увімкнено або вимкнено',
  'diag.audit.policy_warning': 'Повідомлення про політику',
  'diag.audit.offline_guard_violation': 'Виявлено спробу звернення до мережі',
  'diag.audit.collection_created': 'Проєкт створено',
  'diag.audit.collection_renamed': 'Проєкт перейменовано',
  'diag.audit.collection_archived': 'Проєкт архівовано або повернуто з архіву',
  'diag.audit.collection_deleted': 'Проєкт видалено',
  'diag.audit.documents_added_to_collection': 'Документи додано до розділу або проєкту',
  'diag.audit.documents_removed_from_collection': 'Документи прибрано з розділу або проєкту',
  'diag.audit.document_lifecycle_changed': 'Стан документа змінено',
  'diag.audit.skill_imported': 'Навичку імпортовано',
  'diag.audit.skill_deleted': 'Навичку видалено',
  'diag.audit.skill_enabled': 'Навичку увімкнено',
  'diag.audit.skill_disabled': 'Навичку вимкнено',
  'diag.audit.skill_run_started': 'Інструмент навички запущено',
  'diag.audit.skill_run_done': 'Інструмент навички завершив роботу',
  'diag.audit.skill_run_failed': 'Не вдалося виконати інструмент навички',
  'diag.audit.evidence_review_created': 'Перевірку обґрунтування розпочато',
  'diag.audit.evidence_review_ready': 'Перевірку обґрунтування завершено',
  'diag.audit.evidence_review_deleted': 'Перевірку обґрунтування видалено',
  'diag.audit.evidence_pack_exported': 'Пакет обґрунтування експортовано',
  'diag.audit.knowledge_pack_added': 'Пакет знань додано',
  'diag.audit.knowledge_pack_removed': 'Пакет знань прибрано',
  'diag.audit.knowledge_pack_article_saved': 'Статтю з пакету знань збережено як документ',
  'diag.accel.gpuFallbackName': 'Відеокарта',
  'diag.accel.gpu': '{name} (GPU)',
  'diag.accel.mock': 'Вбудований демонстраційний режим',
  'diag.app.engine': 'ШІ-рушій',
  'diag.app.voiceEngine': 'Рушій мовлення',
  'diag.engine.cannotRun': 'Не може працювати — {reason}',
  'diag.engine.reason.libraryMissing': 'бракує системної бібліотеки',
  'diag.engine.reason.systemTooOld': 'застаріла версія системи',
  'diag.engine.reason.filesDamaged': 'файли рушія відсутні або пошкоджені',
  'diag.engine.reason.filesDamagedAfterInstall':
    'файли рушія визначено як пошкоджені одразу після нового встановлення',
  'diag.engine.reason.vcRuntimeMissing': 'бракує середовища виконання Visual C++',
  'diag.engine.reason.blocked': 'його заблокували засоби безпеки Windows',
  'diag.accel.cpu': 'CPU',
  'diag.accel.gpuAvailable': '{name} (GPU доступний)',
  'diag.app.title': 'Застосунок і середовище виконання',
  'diag.app.version': 'Версія застосунку',
  'diag.app.unknown': 'невідомо',
  'diag.app.selectedModel': 'Вибрана модель',
  'diag.app.noneSelected': 'не вибрано',
  'diag.app.profile': 'Профіль обладнання',
  'diag.app.runtime': 'Середовище виконання',
  'diag.app.unknownModel': 'невідома модель',
  'diag.app.onPort': ' на 127.0.0.1:{port}',
  'diag.app.healthy': 'відповідає',
  'diag.app.unhealthy': 'не відповідає',
  'diag.app.runtimeRunning': 'Працює — {model}{onPort} ({health})',
  'diag.app.stopped': 'Зупинено',
  'diag.app.acceleration': 'Прискорення',
  'diag.app.runtimeBuild': 'Збірка середовища виконання',
  'diag.app.noInstallMarker': 'немає позначки встановлення (диск налаштовано вручну)',
  'diag.app.engineVersions': 'Версії рушіїв',
  'diag.engineVersion.older': '{engine} {installed}, цей застосунок очікує версію {pinned}',
  'diag.engineVersion.newer':
    '{engine} {installed} — новіша версія, ніж очікує цей застосунок ({pinned})',
  'diag.engineVersion.unknown':
    '{engine}: версію не зафіксовано, цей застосунок очікує версію {pinned}',
  'diag.engineVersion.cpuNet': 'резервна версія {engine} для CPU',
  'diag.gpu.compat':
    'Застосунок працює в режимі сумісності: відповіді обчислюються на CPU, а це можливо на ' +
    'будь-якому компʼютері.',
  'diag.gpu.tryHint': 'Якщо ви оновили драйвер відеокарти, можна знову спробувати відеокарту.',
  'diag.gpu.offHint':
    'GPU-прискорення вимкнено на екрані «Параметри» — увімкніть його там знову, щоб ' +
    'використовувати відеокарту.',
  'diag.gpu.tryAgain': 'Спробувати GPU ще раз',
  'diag.gpu.tryFailed': 'Повторна спроба з відеокартою не вдалася: {error}',
  'diag.refresh': 'Оновити дані',
  // ---- Performance screen (PerformanceScreen.tsx; benchmark.md "Performance screen") ----
  'perf.title': 'Швидкодія',
  'perf.lead':
    'Наскільки швидко ваша ШІ-модель працює на цьому компʼютері. Усе вимірюється на цьому ' +
    'пристрої, і нічого нікуди не надсилається.',
  'perf.card.title': 'Цей компʼютер',
  'perf.checkedAt': 'Перевірено {when}',
  'perf.notChecked': 'Ще не перевірено',
  'perf.otherMachine':
    'Цей результат виміряно на іншому компʼютері. Перевірте ще раз, щоб отримати показники цього ' +
    'компʼютера.',
  'perf.report.otherComputer': 'Інший компʼютер: {cpu}, {ram}\u00A0GB RAM',
  'perf.verdict.speed': 'Швидкість на цьому компʼютері: близько {tps}\u00A0tok/s (модель: {model}).',
  'perf.verdict.noSpeed':
    '{model} найкраще підходить цьому компʼютеру (враховано: {basis}). Швидкість буде виміряно ' +
    'після запуску моделі.',
  'perf.basis.discrete': 'відеопамʼять',
  'perf.basis.unified': 'обʼєднана памʼять',
  'perf.basis.cpu': 'оперативна памʼять',
  'perf.recommendation.atCheckTime': 'Рекомендовано на момент тесту',
  'perf.recommendation.next': 'Рекомендовано для наступного запуску',
  'perf.recommendation.nextOnThisComputer':
    'Рекомендовано для наступного запуску на цьому компʼютері',
  'perf.verdict.noRecommendation':
    'Жодна модель із каталогу поки що не підходить цьому компʼютеру.',
  'perf.verdict.notChecked':
    'Швидкий тест вимірює памʼять, швидкість диска та, коли працює модель, швидкість генерації.',
  'perf.verdict.driveFast': 'Моделі запускаються з цього диска швидко.',
  'perf.verdict.driveSlow': 'Моделі запускаються з цього диска повільно.',
  'perf.tile.speed': 'Швидкість',
  'perf.tile.speed.unit': 'tok/s',
  'perf.tile.speed.sub': 'Виміряно {when}, модель: {model}',
  'perf.tile.speed.approx':
    'Приблизно: за кількістю фрагментів, а не за часом із середовища виконання',
  'perf.tile.speed.chunks': 'фрагментів: {chunks}',
  'perf.tile.speed.none': 'Ще не виміряно',
  'perf.tile.speed.noneHint': 'Запустіть модель, а потім перевірте ще раз',
  'perf.tile.memory': 'Памʼять',
  'perf.tile.memory.unit': 'GB RAM',
  'perf.tile.memory.unified': 'Обʼєднана памʼять',
  'perf.tile.memory.unifiedSub': 'Спільна для процесора та графічних ядер',
  'perf.model.title': 'Ваша модель',
  'perf.model.line.one': '{model} · {size}\u00A0GB на диску · контекст: {context} токен',
  'perf.model.line.few': '{model} · {size}\u00A0GB на диску · контекст: {context} токени',
  'perf.model.line.many': '{model} · {size}\u00A0GB на диску · контекст: {context} токенів',
  'perf.model.line.other': '{model} · {size}\u00A0GB на диску · контекст: {context} токена',
  'perf.model.none': 'Модель ще не вибрано. Виберіть її на екрані «ШІ-модель».',
  'perf.model.need': 'Із цим контекстом займає {need}\u00A0GB.',
  'perf.model.needEstimate':
    'Потребує щонайменше {need}\u00A0GB для ваг, а також памʼяті для кешу контексту — її обсяг буде ' +
    'виміряно під час першого запуску.',
  'perf.model.gpu': 'Вміщується у відеопамʼять ({budget}\u00A0GB): усі шари ({layers}) на GPU.',
  'perf.model.gpuEstimate': 'Має вміститися у відеопамʼять ({budget}\u00A0GB).',
  'perf.model.partial':
    'Відеопамʼять: {budget}\u00A0GB. Шарів на GPU: {gpuLayers} з {layers}; близько {spill}\u00A0GB ' +
    'працює з оперативної памʼяті. Відповіді повільніші.',
  'perf.model.partialFree':
    'Шарів на GPU: {gpuLayers} з {layers}; близько {spill}\u00A0GB працює з оперативної памʼяті. ' +
    'Коли модель запускалася, з {budget}\u00A0GB памʼяті відеокарти було вільно лише {free}\u00A0GB, ' +
    'а середовище виконання залишає запас безпеки {margin}\u00A0GB. Відповіді повільніші. ' +
    'Перезапустіть модель, коли відеокарта звільниться.',
  'perf.model.partialMargin':
    'Шарів на GPU: {gpuLayers} з {layers}; близько {spill}\u00A0GB працює з оперативної памʼяті. ' +
    'Відеокарта була вільна ({free} з {budget}\u00A0GB), але середовище виконання також резервує ' +
    '{working}\u00A0GB для робочих буферів і запас безпеки {margin}\u00A0GB, а коли сума ' +
    'наближається до межі, переносить цілі шари з відеокарти. Відповіді повільніші.',
  'perf.model.partialMarginNoWorking':
    'Шарів на GPU: {gpuLayers} з {layers}; близько {spill}\u00A0GB працює з оперативної памʼяті. ' +
    'Відеокарта була вільна ({free} з {budget}\u00A0GB), але середовище виконання також резервує ' +
    'памʼять для робочих буферів і запас безпеки {margin}\u00A0GB, а коли сума наближається до межі, ' +
    'переносить цілі шари з відеокарти. Відповіді повільніші.',
  'perf.model.partialEstimate':
    'Відеопамʼять: {budget}\u00A0GB. Близько {spill}\u00A0GB працюватиме з оперативної памʼяті. ' +
    'Відповіді повільніші.',
  'perf.model.cpu': 'Працює на процесорі з оперативної памʼяті ({budget}\u00A0GB).',
  'perf.model.cpuEstimate': 'Працюватиме на процесорі з оперативної памʼяті ({budget}\u00A0GB).',
  'perf.model.unified':
    'Вміщується в обʼєднану памʼять ({ram}\u00A0GB, для моделі доступно до {budget}\u00A0GB).',
  'perf.model.unifiedEstimate':
    'Має вміститися в обʼєднану памʼять ({ram}\u00A0GB, для моделі доступно до {budget}\u00A0GB).',
  'perf.model.tooLarge':
    'Завелика для цього компʼютера (доступно {budget}\u00A0GB). Виберіть меншу модель.',
  'perf.model.unknown':
    'Де розміститься модель, буде виміряно під час її першого запуску на цьому компʼютері.',
  'perf.model.unknownObserved': 'Середовище виконання не повідомило, де розмістилася модель.',
  'perf.model.perDrive':
    'Диск зберігає один запис для кожної моделі, тому запуск на іншому компʼютері замінює запис, ' +
    'виміряний тут.',
  'perf.model.measuredOther.one':
    'Раніше виміряно {when}, контекст: {context} токен; оцінка вище стосується поточних ' +
    'параметрів.',
  'perf.model.measuredOther.few':
    'Раніше виміряно {when}, контекст: {context} токени; оцінка вище стосується поточних ' +
    'параметрів.',
  'perf.model.measuredOther.many':
    'Раніше виміряно {when}, контекст: {context} токенів; оцінка вище стосується поточних ' +
    'параметрів.',
  'perf.model.measuredOther.other':
    'Раніше виміряно {when}, контекст: {context} токена; оцінка вище стосується поточних ' +
    'параметрів.',
  'perf.model.runningOnCard': 'Зараз працює на відеокарті.',
  'perf.model.choose': 'Вибрати меншу модель',
  'perf.models.title': 'Моделі на цьому компʼютері',
  'perf.models.hint':
    'Чат і переклад спільно використовують відеокарту. Зображення, пошук у документах і мовлення ' +
    'за задумом працюють на процесорі, тому використовують оперативну памʼять, а не відеопамʼять.',
  'perf.role.chat': 'Чат',
  'perf.role.translation': 'Переклад',
  'perf.role.vision': 'Зображення',
  'perf.role.reranker': 'Пошук у документах (переранжування)',
  'perf.role.embeddings': 'Пошук у документах (індекс)',
  'perf.role.transcriber': 'Мовлення',
  'perf.models.row': '{model} · {size}\u00A0GB',
  'perf.models.rowNoSize': '{model}',
  'perf.models.none': 'Для цього не встановлено жодної моделі.',
  'perf.models.device.gpu': 'відеокарта',
  'perf.models.device.cpu': 'процесор, за задумом',
  'perf.models.device.processor': 'процесор',
  'perf.models.loaded': 'запущено',
  'perf.models.notLoaded': 'не запущено',
  'perf.models.lifetime.session': 'залишається запущеною',
  'perf.models.lifetime.idle': 'зупиняється під час простою',
  'perf.models.lifetime.per-use': 'запускається лише за потреби',
  'perf.models.split': 'шарів на відеокарті: {gpuLayers} з {layers}',
  'perf.models.card':
    'Відеокарта ({vram}\u00A0GB): чат {chat}\u00A0GB + переклад {translation}\u00A0GB.',
  'perf.models.cardReranker': 'Відеокарта ({vram}\u00A0GB): переранжування {reranker}\u00A0GB.',
  'perf.models.cardBoth':
    'Зараз обидві моделі на відеокарті. Та, що запустилася другою, отримала залишок памʼяті й ' +
    'працює повільніше; зупиніть і знову запустіть її, коли інша звільнить памʼять.',
  'perf.models.ram':
    'Якщо все запущено одночасно, потрібно близько {sum}\u00A0GB з {ram}\u00A0GB оперативної памʼяті.',
  'perf.models.memory':
    'Якщо все запущено одночасно, потрібно близько {sum}\u00A0GB з {budget}\u00A0GB обʼєднаної ' +
    'памʼяті, доступної для моделей.',
  'perf.models.ramTooMuch': 'Забагато одночасно',
  'perf.models.ramOk': 'Вистачає',
  'perf.place.gpu': 'На GPU',
  'perf.place.partial': 'Частково на GPU',
  'perf.place.cpu': 'На процесорі',
  'perf.place.tooLarge': 'Завелика',
  'perf.place.unknown': 'Не виміряно',
  'perf.tile.graphics': 'Відеопамʼять',
  'perf.tile.graphics.unit': 'GB VRAM',
  'perf.tile.graphics.none': 'Немає придатної відеокарти. Моделі працюють на процесорі.',
  'perf.tile.graphics.engine':
    'ШІ-рушій не може працювати на цьому компʼютері, тому відеокарту не вдалося перевірити.',
  'perf.tile.graphics.off': 'Графічне прискорення вимкнено. Моделі працюють на процесорі.',
  'perf.tile.graphics.small': 'Менше ніж {min}\u00A0GB: моделі працюють на процесорі.',
  'perf.tile.graphics.integrated':
    'Інтегрована, зі спільною памʼяттю: моделі працюють на процесорі.',
  'perf.tile.graphics.unitShared': 'GB спільної памʼяті',
  'perf.tile.graphics.notRecorded': 'Під час того тесту відеокарту не зафіксовано.',
  'perf.rating.usable': 'Придатна',
  'perf.rating.small': 'Мала',
  'perf.rating.integrated': 'Інтегрована',
  'perf.rating.notRecorded': 'Не зафіксовано',
  'perf.rating.none': 'Немає',
  'perf.rating.unknown': 'Невідомо',
  'perf.others.subGpu': '{cpu}, {ram}\u00A0GB RAM, {vram}\u00A0GB VRAM · {when}',
  'perf.tile.drive': 'Диск',
  'perf.tile.drive.unit': 'MB/s читання',
  'perf.tile.drive.load': 'Запуск моделі {when}: прочитано {gb}\u00A0GB',
  'perf.tile.drive.hash': 'Перевірка файлів {when}: прочитано {gb}\u00A0GB',
  'perf.tile.drive.none': 'Ще не виміряно',
  'perf.tile.drive.noneHint': 'Вимірюється під час першого запуску моделі або перевірки файлів',
  'perf.rating.good': 'Добре',
  'perf.rating.slow': 'Повільно',
  'perf.rating.fast': 'Швидко',
  'perf.rating.pending': 'Очікується',
  'perf.rating.approx': 'Приблизно',
  'perf.rating.slowDrive': 'Повільний диск',
  'perf.profile.TINY': 'Мінімальний',
  'perf.profile.LITE': 'Легкий',
  'perf.profile.BALANCED': 'Збалансований',
  'perf.profile.PRO': 'Pro',
  'perf.profile.UNKNOWN': 'Невідомий',
  'perf.check': 'Перевірити цей компʼютер',
  'perf.checkAgain': 'Перевірити ще раз',
  'perf.running': 'Виконується…',
  'perf.startAndMeasure': 'Запустити й виміряти: {model}',
  'perf.contextSize': 'Змінити розмір контексту',
  'perf.copy': 'Скопіювати звіт',
  'perf.autoNote':
    'Запускається автоматично вперше та щоразу, коли цей диск підключають до іншого компʼютера.',
  'perf.failed': 'Не вдалося виконати тест: {error}',
  'perf.loadFailed': 'Не вдалося прочитати найновіші показники: {error}',
  'perf.retry': 'Спробувати ще раз',
  'perf.step.system': 'Обладнання визначено',
  'perf.step.drive': 'Швидкість диска',
  'perf.step.speed': 'Швидкість генерації (модель: {model})',
  'perf.step.speedSkipped': 'Швидкість генерації (модель не працює, пропущено)',
  'perf.step.hint': 'Близько пів хвилини. Застосунком можна й далі користуватися.',
  'perf.running.background': 'Цей компʼютер перевіряється у фоновому режимі.',
  'perf.step.state.done': '{step}: готово',
  'perf.step.state.active': '{step}: триває',
  'perf.step.state.todo': '{step}: в очікуванні',
  'perf.observed.title': 'Зафіксовано під час вашої роботи',
  'perf.observed.hint':
    'Реальні показники звичайного використання, а не тестового запиту. Ці рядки показуються лише ' +
    'протягом цього сеансу; показані в них швидкості читання також зберігаються разом із ' +
    'показниками диска вище.',
  'perf.observed.none':
    'Під час цього сеансу ще нічого не зафіксовано. Поставте моделі запитання або запустіть її.',
  'perf.observed.answer': 'Остання відповідь: {tps}\u00A0tok/s, перший токен через {ttft}\u00A0s',
  'perf.observed.answerSub': '{model}, {when}, токенів: {tokens}',
  'perf.observed.load': 'Запуск моделі: {seconds}\u00A0s',
  'perf.observed.loadSub':
    '{model}, прочитано {gb}\u00A0GB з цього диска зі швидкістю {mbps}\u00A0MB/s',
  'perf.observed.check': 'Перевірка файлів: {seconds}\u00A0s',
  'perf.observed.checkSub': '{model}: повна перевірка файлів {when}, прочитано {gb}\u00A0GB',
  'perf.observed.oncePerModel': 'Раз на модель',
  'perf.others.title': 'Інші компʼютери, на яких використовували цей диск',
  'perf.others.hint':
    'Для кожного компʼютера зберігається окремий результат, тому рекомендована модель залежить ' +
    'від компʼютера, а не від диска.',
  'perf.others.none':
    'Поки що немає. Підключіть диск до іншого компʼютера, і тест запуститься автоматично.',
  'perf.others.row': '{tps}\u00A0tok/s (модель: {model})',
  'perf.others.rowNoSpeed': 'Рекомендовано: {model}; швидкість не виміряно',
  'perf.others.sub': '{cpu}, {ram}\u00A0GB RAM · {when}',
  'perf.others.load': 'запуск моделі: {seconds}\u00A0s',
  'perf.others.check': 'перевірка файлів: {seconds}\u00A0s',
  'perf.footer':
    'Повний технічний звіт з усіма необробленими показниками доступний тут: Параметри → ' +
    'Діагностика.',
  'perf.footerLink': 'Відкрити вкладку «Діагностика»',
  'perf.unknownModel': 'запущена модель',
  'perf.unknownCpu': 'Невідомий CPU',
  'diag.bench.title': 'Тест обладнання',
  'diag.bench.hint':
    'Необроблені показники останнього тесту на цьому компʼютері — для звернення до служби ' +
    'підтримки. Що вони означають, пояснює екран «Швидкодія»; там же можна запустити новий тест. ' +
    'Усе вимірюється офлайн — жодні дані не виходять за межі вашого компʼютера.',
  'diag.bench.empty':
    'На цьому компʼютері ще не запускали тест. Щоб запустити його, відкрийте екран «Швидкодія».',
  'diag.bench.profile': 'Призначений профіль',
  'diag.bench.noMatch': 'Немає відповідної моделі',
  'diag.bench.ram': 'RAM',
  'diag.bench.cpu': 'CPU',
  'diag.bench.cores.one': ' ({count} ядро)',
  'diag.bench.cores.few': ' ({count} ядра)',
  'diag.bench.cores.many': ' ({count} ядер)',
  'diag.bench.cores.other': ' ({count} ядра)',
  'diag.bench.osArch': 'Операційна система / архітектура',
  'diag.bench.gpu': 'GPU',
  'diag.bench.notDetected': 'не виявлено',
  'diag.bench.effectiveRead': 'Виміряна швидкість читання',
  'diag.bench.effectiveReadNone': 'ще не виміряно — вимірюється під час запуску моделі',
  'diag.bench.effectiveReadLoad': 'під час запуску моделі {when}, прочитано {gb}\u00A0GB',
  'diag.bench.effectiveReadHash': 'під час перевірки файлів {when}, прочитано {gb}\u00A0GB',
  'diag.bench.driveWrite': 'Запис на диск',
  'diag.bench.notMeasured': 'не виміряно',
  'diag.bench.tokens': 'Швидкість декодування (токенів за секунду)',
  'diag.bench.tokensNotMeasured': 'не виміряно (спершу запустіть модель)',
  'diag.bench.tokensModel': 'виміряно із запущеною моделлю {model}',
  'diag.bench.tokensOver': 'охоплено токенів: {tokens}',
  'diag.bench.tokensApprox':
    'приблизно — пораховано фрагменти, а не час за даними середовища виконання',
  'diag.bench.lastRun': 'Останній тест',
  'diag.system.title': 'Система',
  'diag.system.osPlatform': 'Операційна система / платформа',
  'diag.system.freeSpace': 'Вільне місце',
  'diag.system.imagesSize': 'Розмір історії зображень',
  'diag.system.loadFailed':
    'Відомості про систему ще не вдалося отримати. Спробуйте знову відкрити цю вкладку.',
  'diag.paths.title': 'Шляхи',
  'diag.paths.prepared': 'Підготовлений диск',
  'diag.paths.yes': 'Так',
  'diag.paths.noFallback': 'Ні (резервна папка даних застосунку)',
  'diag.paths.writable': 'Доступний для запису',
  'diag.paths.no': 'Ні',
  'diag.paths.loadFailed':
    'Відомості про диск і робочий простір ще не вдалося отримати. Спробуйте знову відкрити цю ' +
    'вкладку.',
  'diag.activity.title': 'Активність',
  'diag.activity.hint':
    'Локальний запис того, що робив застосунок: запуски моделей, завантаження, імпорт ' +
    'документів, події робочого простору. Він зберігається у вашому робочому просторі (у ' +
    'зашифрованому вигляді, якщо робочий простір зашифрований) і ніколи не надсилається. У ньому ' +
    'ніколи немає тексту чатів або вмісту документів.',
  'diag.activity.show': 'Показати активність',
  'diag.activity.hide': 'Сховати активність',
  'diag.activity.export': 'Експортувати у файл…',
  'diag.activity.savedTo': 'Журнал активності збережено: {path}',
  'diag.activity.filterShow': 'Показати',
  'diag.activity.filterAll': 'Уся активність',
  'diag.activity.loading': 'Зачекайте…',
  'diag.activity.empty':
    'Ще нічого не записано — дії зʼявлятимуться тут, коли ви користуватиметеся застосунком.',
  'diag.activity.earlier': 'Показати попередню активність',
  'diag.logs.title': 'Останні записи журналу',
  'diag.logs.hintBefore': 'Кінець файлу ',
  'diag.logs.hintAfter':
    ' на цьому пристрої. Журнали зберігаються лише локально й ніколи не надсилаються; у них ' +
    'немає вмісту документів або тексту чатів.',
  'diag.logs.show': 'Показати журнали',
  'diag.logs.hide': 'Сховати журнали',
  'diag.logs.empty': '(журнал порожній)',
  'diag.logs.save': 'Зберегти у файл…',
  'diag.logs.savedTo': 'Журнали збережено: {path}',
  'diag.copy': 'Скопіювати',
  'diag.copyTitle': 'Скопіювати ці відомості в буфер обміну',
  'diag.copied': 'Скопійовано в буфер обміну',
  'diag.copyFailed': 'Не вдалося скопіювати в буфер обміну',
  // ---- Shared components' built-in copy (receive a bound t — i18n record §5 ⑤) ----
  'common.dismiss': 'Сховати',
  'common.close': 'Закрити',
  'common.cancel': 'Скасувати',
  'common.remove': 'Прибрати',
  'common.apply': 'Застосувати',
  'common.labelValue': '{label}: {value}',
  'common.percent': '{pct}%',
  'indicator.offline': 'Локально · Офлайн',
  'indicator.online': 'Локально · Завантаження дозволено',
  'indicator.offlineDetail':
    'Усе залишається на цьому диску. Інтернет-зʼєднання не використовується.',
  'indicator.onlineDetail':
    'Завантаження дозволено — чати й документи залишаються на цьому пристрої.',
  'indicator.short.offline': 'Офлайн',
  'indicator.short.online': 'З мережею',
  'indicator.withLocalApi': '{state} · API працює',
  'indicator.localApiDetail':
    'Інші застосунки на цьому компʼютері можуть використовувати вашу модель. Ніщо не виходить за ' +
    'межі цього компʼютера.',
  // ---- Shared password copy ----
  'password.mismatch': 'Паролі не збігаються.',
  'password.show': 'Показати пароль',
  'password.hide': 'Сховати пароль',
  'password.strength.tooShort': 'Закороткий',
  'password.strength.weak': 'Слабкий',
  'password.strength.okay': 'Середній',
  'password.strength.strong': 'Надійний',
  'password.strength.veryStrong': 'Дуже надійний',
  'password.strength.minHint': 'Використайте щонайменше {min} символів.',
  'password.strength.longerHint':
    'Що довший пароль, то він надійніший — добре підходять щонайменше 12 символів або кілька не ' +
    'повʼязаних між собою слів.',
  // ---- Workspace gate (WorkspaceGate.tsx) ----
  'gate.passwordPlaceholder': 'Пароль',
  'gate.unlock.title': 'Розблокуйте робочий простір',
  'gate.unlock.hint':
    'Введіть пароль, щоб відкрити робочий простір на цьому диску. Усе залишається на цьому диску.',
  'gate.unlock.submit': 'Розблокувати',
  'gate.unlock.submitBusy': 'Розблокування…',
  'gate.welcome.title': 'Вітаємо',
  'gate.welcome.intro':
    'Це ваш приватний робочий простір зі ШІ. Спілкуйтеся зі ШІ-моделлю та ставте запитання щодо ' +
    'своїх документів — усе працює з цього диска.',
  'gate.welcome.stays': 'Усе залишається на цьому диску.',
  'gate.welcome.staysRest': 'Без інтернету, без облікового запису, без відстеження.',
  'gate.welcome.start': 'Почати',
  'gate.finishing.title': 'Налаштування…',
  'gate.finishing.hint':
    'Триває перевірка того, що вже є на цьому диску. Перша перевірка великого файлу ШІ-моделі ' +
    'може тривати кілька хвилин.',
  'gate.finishing.progress': 'Перевірка ШІ-моделі {n} з {m}: {name} — {pct}%',
  'gate.finishing.skip': 'Пропустити — перейти до застосунку',
  'gate.starter.title': 'Останній крок',
  'gate.starter.noModel':
    'На цьому диску ще не встановлено жодної ШІ-моделі, а без неї чат не зможе відповідати. ' +
    'Можна додати модель зараз або будь-коли пізніше на екрані «ШІ-модель».',
  'gate.starter.optional':
    'Завантажувати модель необовʼязково, і перед завантаженням застосунок завжди запитує ваше ' +
    'підтвердження. Ваші документи й чати в будь-якому разі не використовують інтернет.',
  'gate.starter.skip': 'Поки що пропустити',
  'gate.starter.addDocuments': 'Додати документи',
  'gate.starter.chooseModel': 'Вибрати модель',
  'gate.create.title': 'Створіть пароль',
  'gate.create.hint':
    'Цей пароль захищає все у вашому робочому просторі — документи, чати й нотатки — на цьому ' +
    'диску. Його не можна відновити або скинути, тож виберіть такий, який ви запамʼятаєте.',
  'gate.create.plaintextToggle':
    'Використовувати незашифрований робочий простір для розробників (без шифрування)',
  'gate.create.plaintextWarning':
    'У незашифрованому режимі ваші дані зберігаються на цьому диску без шифрування. ' +
    'Використовуйте його лише для розробки.',
  'gate.create.confirmPlaceholder': 'Підтвердьте пароль',
  'gate.create.back': 'Назад',
  'gate.create.submit': 'Створити робочий простір',
  'gate.create.submitBusy': 'Створення…',
  'gate.error.generic': 'Щось пішло не так. Спробуйте ще раз.',
  // ---- Main-process strings (Phase 41, i18n record §3.3 two-rule boundary) --------------
  'main.ingest.pdfScanDetected':
    'Цей PDF-файл схожий на скан — у ньому ще немає придатного для читання тексту.',
  'main.ingest.audioNeedsTranscriber':
    'Для імпорту аудіо потрібна модель мовлення — завантажте її на екрані «ШІ-модель».',
  'main.ingest.audioNeedsEngine':
    'Для імпорту аудіо потрібен рушій мовлення — встановіть його на екрані «ШІ-модель».',
  'main.ingest.audioNeedsModelAndEngine':
    'Для імпорту аудіо потрібні модель мовлення і рушій мовлення — додайте їх на екрані ' +
    '«ШІ-модель».',
  'main.ingest.audioEngineUnsupported':
    'Імпорт аудіо в цій операційній системі поки що недоступний: застосунок не може встановити ' +
    'тут потрібний для нього рушій мовлення.',
  'main.ingest.audioUnreadable':
    'Не вдалося прочитати цей аудіофайл. Перетворіть його у формат WAV або MP3 та імпортуйте ще ' +
    'раз.',
  'main.ingest.audioTranscriptionFailed':
    'Не вдалося перетворити запис на текст. Щоб спробувати ще раз, переіндексуйте цей документ.',
  'main.ingest.engineCannotRun':
    'ШІ-рушій не може працювати на цьому компʼютері, тому цей документ не вдалося ' +
    'проіндексувати. Що робити, пояснено на екрані «ШІ-модель»; після цього спробуйте ще раз.',
  'main.ingest.engineLibraryMissing':
    'ШІ-рушій не може працювати на цьому компʼютері, бо бракує системної бібліотеки {library}. ' +
    'Як це виправити, пояснено на екрані «ШІ-модель»; після цього спробуйте ще раз.',
  'main.ingest.voiceEngineCannotRun':
    'Рушій мовлення не може працювати на цьому компʼютері, тому цей запис не вдалося перетворити ' +
    'на текст. Що робити, пояснено на екрані «ШІ-модель»; після цього переіндексуйте цей ' +
    'документ.',
  'main.ingest.searchModelTimeout':
    'Модель пошуку не відповіла вчасно, тому цей документ не вдалося проіндексувати. Спробуйте ' +
    'ще раз.',
  'main.ingest.searchModelCannotStart':
    'Модель пошуку не запустилася, тому цей документ не вдалося проіндексувати. На екрані ' +
    '«ШІ-модель» натисніть кнопку «Перевірити всі файли моделей», а потім спробуйте ще раз.',
  'main.ingest.searchModelFailed':
    'У роботі моделі пошуку виникла проблема, тому цей документ не вдалося проіндексувати. ' +
    'Спробуйте ще раз.',
  'main.ingest.imageNeedsOcr':
    'Для імпорту фотографій потрібні файли розпізнавання тексту (OCR), яких немає на цьому диску.',
  'main.ingest.imageNoText':
    'На цій фотографії не знайдено придатного для читання тексту. Спробуйте зробити чіткіший ' +
    'знімок сторінки з меншої відстані.',
  'main.ingest.imageOcrFailed':
    'Не вдалося прочитати цю фотографію. Щоб спробувати ще раз, переіндексуйте її.',
  'main.ingest.imageOcrUnavailable':
    'Розпізнавання тексту (OCR) не вдалося запустити в цій збірці, тому цю фотографію збережено ' +
    'без придатного для читання тексту. Переіндексуйте її, коли розпізнавання тексту стане ' +
    'доступним.',
  'main.ingest.sourceMissing': 'Оригінальний файл не знайдено на диску.',
  'main.ingest.interrupted':
    'Обробку документа перервано до її завершення. Щоб спробувати ще раз, переіндексуйте його.',
  'main.ingest.fileTooLarge':
    'Цей файл завеликий для безпечного імпорту. Розділіть його на менші файли й спробуйте ще раз.',
  'main.ingest.tooManyChunks':
    'Цей документ завеликий, щоб проіндексувати його повністю. Розділіть його на менші файли та ' +
    'імпортуйте ці частини.',
  'main.ingest.parseTimeout':
    'Обробка цього файлу тривала задовго, тому його пропущено. Можливо, він пошкоджений або ' +
    'надзвичайно великий.',
  'main.ingest.unsupportedType':
    'Цей тип файлу не підтримується ({ext}). Спробуйте TXT, PDF, DOCX, CSV або підтримуваний ' +
    'аудіоформат.',
  'main.rag.noContext':
    'У ваших документах цього не знайдено. Спробуйте сформулювати запитання інакше або ' +
    'перевірте, які документи ви запитуєте.',
  'main.rag.reindexNeeded':
    'Ваші документи треба швидко переіндексувати, перш ніж у них можна буде шукати: їх ' +
    'проіндексувала інша модель пошуку. Відкрийте екран «Документи» й виберіть пункт ' +
    '«Переіндексувати».',
  'main.chat.docTaskBusy':
    'Виконується завдання з документом. Можна скасувати його або дочекатися завершення, а потім ' +
    'продовжити чат.',
  'main.chat.defaultTitle': 'Новий чат',
  'main.evidenceReviews.defaultTitle': 'Перевірка обґрунтування',
  'main.benchmark.warnTiny':
    'Цей пристрій найкраще підходить для найменшої та найшвидшої моделі. Більші моделі можуть ' +
    'працювати повільно.',
  'main.benchmark.warnUnknown':
    'Не вдалося повністю визначити це обладнання, тому вибрано надійну легку модель. Більшу ' +
    'модель можна спробувати будь-коли.',
  'main.benchmark.warnDriveProbe':
    'Не вдалося виміряти швидкість диска, тому рекомендація враховує лише оперативну памʼять і ' +
    'CPU.',
  'main.benchmark.warnSlowDrive':
    'Цей диск доволі повільний. Моделі все одно працюватимуть, але можуть довше запускатися.',
  'main.benchmark.warnSpeedSkipped':
    'Цього разу швидкість генерації тексту не виміряно, бо модель була зайнята іншим. Профіль ' +
    'нижче враховує лише оперативну памʼять, CPU і швидкість диска — запустіть тест ще раз, коли ' +
    'модель більше ніщо не використовуватиме, щоб отримати повні показники.',
  'main.benchmark.warnSlowRead':
    'Виміряна швидкість читання з цього диска — близько {mbps}\u00A0MB/s. Під час запуску моделі ' +
    'весь її файл читається з такою швидкістю, тому на цьому диску моделі запускатимуться повільно.',
  'main.benchmark.warnVeryLowTokens':
    'Генерація тексту із запущеною моделлю ({model}) була дуже повільною, тому призначений ' +
    'профіль знижено на один рівень. Якщо ця модель більша за рекомендовану, запустіть ' +
    'рекомендовану модель і запустіть тест ще раз.',
  'main.benchmark.warnRecommendationLowered':
    'Швидкість генерації тексту із запущеною моделлю ({model}) становила близько {tps}\u00A0tok/s, ' +
    'тому рекомендовану модель знижено на один рівень розміру, щоб відповіді на цьому компʼютері ' +
    'залишалися швидкими.',
  'main.benchmark.locked': 'Робочий простір заблоковано. Розблокуйте його, щоб запустити тест.',
  'main.benchmark.lockedDuringRun':
    'Робочий простір заблоковано під час тесту, тому результат не збережено. Запустіть тест ще ' +
    'раз.',
  'main.dialog.openLink.title': 'Відкрити це посилання в браузері?',
  'main.dialog.openLink.message': 'Відкрити це посилання в браузері?',
  'main.dialog.openLink.site': 'Сайт: {site}',
  'main.dialog.openLink.truncated': 'Тут посилання скорочено — не показано символів: {hidden}.',
  'main.dialog.openLink.credentials':
    'Адреса містить імʼя користувача — насправді відкриється сайт, зазначений у рядку «Сайт».',
  'main.dialog.openLink.hint':
    'Це посилання походить із відповіді або з маніфесту моделі, а не від HilbertRaum. Ваш ' +
    'браузер підключиться до цього сайту.',
  'main.dialog.openLink.open': 'Відкрити',
  'main.dialog.openLink.cancel': 'Скасувати',
  'main.workspace.wrongPassword':
    'Цей пароль не розблокував ваш робочий простір. Перевірте його та спробуйте ще раз.',
  'main.workspace.openFailed': 'Не вдалося відкрити робочий простір.',
  'main.workspace.vaultDamaged':
    'Ваш пароль правильний, але дані робочого простору на диску пошкоджено, тому їх не вдалося ' +
    'відкрити. Повторне введення пароля не допоможе. Не створюйте новий робочий простір — ' +
    'залиште файли як є та відновіть папку робочого простору з резервної копії.',
  'main.workspace.recoveryBlocked':
    'Поки що не вдалося відкрити робочий простір: інша програма утримує файл відновлення з ' +
    'вашими найновішими даними. Закрийте все, що може сканувати диск (антивірус, індексування ' +
    'для пошуку, вікно файлового менеджера з папкою робочого простору), зачекайте трохи й ' +
    'спробуйте ще раз. Нічого не втрачено.',
  'main.workspace.newer':
    'Цей робочий простір записала новіша версія HilbertRaum — оновіть застосунок, щоб відкрити ' +
    'його. Нічого не змінено.',
  'main.workspace.createFailed': 'Не вдалося створити робочий простір.',
  'main.workspace.passwordTooShort': 'Пароль має містити щонайменше {min} символів.',
  'main.workspace.newPasswordTooShort': 'Новий пароль має містити щонайменше {min} символів.',
  'main.workspace.unlockBeforeChange':
    'Розблокуйте робочий простір, перш ніж змінювати його пароль.',
  'main.workspace.wrongCurrentPassword':
    'Це не збігається з вашим поточним паролем. Перевірте його та спробуйте ще раз.',
  'main.workspace.changeFailed': 'Не вдалося змінити пароль. Ваш поточний пароль і далі діє.',
  'main.workspace.busyPasswordChange':
    'Пароль робочого простору зараз змінюється. Спробуйте ще раз за мить.',
  'main.workspace.lockFailed':
    'Не вдалося заблокувати робочий простір — він залишається відкритим, а ваші дані в безпеці. ' +
    'Звільніть трохи місця на диску й спробуйте ще раз.',
  'main.runtime.compatibilityMode':
    'Для стабільності увімкнено режим сумісності. Усе працює далі — відповіді можуть бути трохи ' +
    'повільнішими.',
  'main.runtime.speedUpDisabled':
    'Для стабільності вимкнено додаткове прискорення. Модель перезапускається — надішліть ' +
    'повідомлення ще раз.',
  'main.runtime.crashRestarting':
    'ШІ-модель неочікувано зупинилася й запускається знову. За мить надішліть повідомлення ще ' +
    'раз.',
  'main.runtime.crashStopped':
    'ШІ-модель знову неочікувано зупинилася, тому її не перезапущено. Запустити її знову можна ' +
    'на екрані «ШІ-модель».',
  'main.runtime.modelCannotLoad':
    'Не вдалося запустити модель {model} на цьому компʼютері — відповіді імітуються, доки ви не ' +
    'виберете іншу модель.',
  'main.runtime.engineCannotRun':
    'ШІ-рушій не може працювати на цьому компʼютері, тому відповіді імітуються. Чого бракує, ' +
    'показано на екрані «ШІ-модель».',
  'main.engine.cannotRun':
    'ШІ-рушій не може працювати на цьому компʼютері. Чого бракує, показано на екрані «ШІ-модель».',
  'main.noModelRunning':
    'ШІ-модель не запущено. Відкрийте екран «ШІ-модель» і спершу запустіть модель.',
  'main.modelStarting': 'ШІ-модель запускається. Спробуйте ще раз за мить.',
  'main.translation.noModel':
    'Для перекладу потрібна модель перекладу, але на цьому диску її не встановлено. Її можна ' +
    'завантажити на екрані «ШІ-модель».',
  'main.translation.startFailed':
    'Не вдалося запустити модель перекладу — можливо, на цьому пристрої замало вільної памʼяті. ' +
    'Закрийте інші застосунки або перезапустіть HilbertRaum, а потім спробуйте ще раз.',
  'main.translation.failedWindowNotice':
    '> ⚠ Цю частину ({part} з {total}) не вдалося перекласти — нижче збережено оригінальний ' +
    'текст без змін.',
  'main.translation.missingPageNotice':
    '> ⚠ Сторінку {page} оригіналу не вдалося перекласти — на ній немає придатного для читання ' +
    'тексту (можливо, це скановане зображення).',
  'main.translation.missingPageRangeNotice':
    '> ⚠ Сторінки {from}–{to} оригіналу не вдалося перекласти — на них немає придатного для ' +
    'читання тексту (можливо, це скановані зображення).',
  'main.translation.attributionLine':
    'Машинний переклад (модель {modelId}) — може містити помилки.',
  'main.model.contextExceeded':
    'Це завелике для контекстного вікна поточної моделі. Збільште розмір контексту на екрані ' +
    '«ШІ-модель» (вибраний фіксований розмір обмежує його) або спробуйте менший документ.',
  'main.chat.streamInFlight': 'Для цієї розмови вже генерується відповідь.',
  'main.chat.emptyCompletion':
    'Модель повернула порожню відповідь. Спробуйте ще раз або сформулюйте повідомлення інакше.',
  'main.chat.runtimeUnresponsive':
    'ШІ-модель перестала відповідати. Спробуйте ще раз — якщо це повторюється, перезапустіть ' +
    'модель на екрані «ШІ-модель».',
  'main.chat.connectionLost':
    'ШІ-модель зупинилася, перш ніж відповідь було завершено. Надішліть повідомлення ще раз — ' +
    'якщо це повторюється, перезапустіть модель на екрані «ШІ-модель».',
  'main.chat.streamError':
    'У ШІ-моделі сталася помилка, перш ніж відповідь було завершено. Спробуйте ще раз — якщо це ' +
    'повторюється, перезапустіть модель на екрані «ШІ-модель».',
  'main.chat.searchModelTimeout':
    'Модель пошуку не відповіла вчасно, тому виконати пошук у ваших документах не вдалося. ' +
    'Спробуйте ще раз.',
  'main.chat.searchModelCannotStart':
    'Модель пошуку не запустилася, тому виконати пошук у ваших документах не вдалося. На екрані ' +
    '«ШІ-модель» натисніть кнопку «Перевірити всі файли моделей», а потім спробуйте ще раз.',
  'main.chat.searchModelFailed':
    'У роботі моделі пошуку виникла проблема, тому виконати пошук у ваших документах не вдалося. ' +
    'Спробуйте ще раз.',
  'main.chat.nothingToRegenerate': 'Ще немає відповіді, яку можна згенерувати ще раз.',
  'main.chat.nothingToResend':
    'Це запитання більше не останнє повідомлення в цій розмові, тому надіслати його ще раз не ' +
    'можна.',
  'main.chat.skillUnavailable':
    'Ця навичка більше недоступна — її вимкнено або видалено. Увімкніть її на вкладці «Навички» ' +
    'або запитайте ще раз без неї.',
  'main.chat.reviewBlocksRegenerate':
    'Для цієї відповіді є перевірка обґрунтування. Повторна відповідь видалить перевірку разом з ' +
    'її рішеннями й нотатками — натомість поставте запитання ще раз як нове повідомлення.',
  'main.chat.emptyMessage': 'Не можна надіслати порожнє повідомлення.',
  'main.chat.emptyQuestion': 'Не можна надіслати порожнє запитання.',
  'main.chat.stopFirst': 'Для цієї розмови ще генерується відповідь. Спершу зупиніть її.',
  'main.chat.locked': 'Робочий простір заблоковано. Розблокуйте його, щоб користуватися чатом.',
  'main.busy.chat':
    'Зараз генерується відповідь. Дочекайтеся її завершення (або зупиніть її), а потім спробуйте ' +
    'ще раз.',
  'main.busy.docTask':
    'Модель зараз зайнята завданням з документом. Дочекайтеся завершення або скасуйте завдання, ' +
    'а потім спробуйте ще раз.',
  'main.busy.skillRun':
    'Навичка зараз працює з документом. Дочекайтеся завершення або скасуйте її на панелі ' +
    'виконання, а потім спробуйте ще раз.',
  'main.busy.benchmark': 'Зараз тест вимірює показники цього компʼютера. Спробуйте ще раз за мить.',
  'main.task.unknownKind': 'Невідоме завдання з документом.',
  'main.task.refusedChatStreaming':
    'Зараз генерується відповідь. Дочекайтеся її завершення (або зупиніть її), а потім спробуйте ' +
    'ще раз.',
  'main.task.comparePickTwo': 'Виберіть рівно два документи для порівняння.',
  'main.task.compareReindex':
    'Перш ніж порівнювати ці документи, потрібне коротке переіндексування: щонайменше один із ' +
    'них підготувала інша модель пошуку. Відкрийте екран «Документи», виберіть пункт ' +
    '«Переіндексувати», а потім спробуйте ще раз.',
  'main.task.documentNotReady':
    'У цьому документі ще немає придатного для читання тексту. Спершу імпортуйте або ' +
    'переіндексуйте його, а потім спробуйте ще раз.',
  'main.task.genericFailure':
    'Не вдалося завершити завдання. Переконайтеся, що модель досі працює, а потім спробуйте ще ' +
    'раз.',
  'main.task.expired': 'Це завдання більше недоступне.',
  'main.task.translationTarget': 'Виберіть підтримувану мову оригіналу та іншу мову перекладу.',
  'main.task.sourceUnreadable':
    'Не вдалося прочитати збережену копію цього документа. Повторно імпортуйте документ, а потім ' +
    'спробуйте ще раз.',
  'main.task.needsOcr':
    'Для розпізнавання тексту потрібні OCR-файли, яких немає на цьому диску. Завантажте їх ' +
    'кнопкою «Завантажити OCR-файли» в рядку сканованого документа або на екрані «ШІ-модель» — ' +
    'або, якщо ви самі налаштовували цей диск, додайте їх командою «fetch-runtime --family ocr».',
  'main.task.ocrUnavailable':
    'Розпізнавання тексту (OCR) недоступне в цій збірці: OCR-файли є на цьому диску, але засіб ' +
    'розпізнавання не вдалося запустити.',
  'main.task.ocrNotAScan':
    'Так розпізнати текст можна лише в PDF-файлі, який визначено як скан або який містить ' +
    'скановані сторінки.',
  'main.task.ocrNoText':
    'У цьому скані не знайдено придатного для читання тексту. Можливо, сторінки порожні або ' +
    'надто розмиті.',
  'main.task.ocrFailed':
    'Не вдалося прочитати цей скан. Переконайтеся, що документ досі на диску, а потім спробуйте ' +
    'ще раз.',
  'main.task.documentBusyIngesting':
    'Цей документ ще імпортується або переіндексовується. Дочекайтеся завершення, а потім ' +
    'спробуйте ще раз.',
  'main.task.pickOneTranslate': 'Виберіть рівно один документ для перекладу.',
  'main.task.pickOneOcr': 'Виберіть рівно один сканований PDF-файл, щоб розпізнати в ньому текст.',
  'main.task.pickOneSummarize': 'Виберіть рівно один документ, щоб його підсумувати.',
  'main.task.unavailable': 'Завдання з документами недоступні.',
  'main.task.workspaceLocked':
    'Робочий простір заблоковано. Розблокуйте його, щоб працювати з документами.',
  'main.download.policyDisabled': 'Завантаження вимкнено відповідно до політики цього диска.',
  'main.download.networkOff':
    'Доступ до інтернету вимкнено. Спершу увімкніть параметр «Дозволити доступ до інтернету для ' +
    'завантажень та оновлень» на екрані «Параметри».',
  'main.download.alreadyRunning': 'Уже триває інше завантаження. Моделі завантажуються по одній.',
  'main.download.stoppedNetworkOff':
    'Доступ до інтернету вимкнено, тому завантаження, що тривало, зупинено. Щоб завершити його, ' +
    'знову увімкніть доступ до інтернету на екрані «Параметри».',
  'main.download.noSource': 'У маніфесті моделі «{modelId}» немає джерела для завантаження.',
  'main.download.sourceWithdrawn':
    'Видавець моделі «{modelId}» видалив саме цей файл, тому його більше не можна завантажити ' +
    '({reason}). Моделі, які вже є на цьому диску, і далі працюють.',
  'main.download.alreadyVerified': 'Цю модель уже завантажено й перевірено.',
  'main.download.presentUnverified':
    'Файл цієї моделі вже є. У маніфесті моделі ще немає справжньої контрольної суми, тому файл ' +
    'не можна перевірити — створіть її командою «verify-models --generate».',
  'main.download.licenseFirst':
    'Перш ніж завантажувати, перегляньте та прийміть ліцензію моделі ({license}).',
  'main.download.notEnoughSpace':
    'На цьому диску недостатньо вільного місця: для завантаження потрібно {needed}, вільне ' +
    'місце: {free}. Звільніть місце на диску або виберіть меншу модель.',
  'main.download.unknownJob': 'Невідоме завдання завантаження.',
  'main.download.checksumMismatch':
    'Контрольна сума завантаженого файлу не збіглася з очікуваною, тому файл відкинуто. ' +
    'Спробуйте ще раз.',
  'main.download.fileMissing': 'Завантажений файл зник, перш ніж його вдалося перевірити.',
  'main.download.httpFailed':
    'Не вдалося почати завантаження ({reason}). Перевірте зʼєднання та спробуйте ще раз.',
  'main.download.interrupted':
    'Завантаження перервано ({reason}). Уже отриману частину збережено — якщо запустити ' +
    'завантаження знову, воно продовжиться з місця зупинки.',
  'main.download.writeFailed':
    'Не вдалося зберегти файл моделі на цьому диску. Переконайтеся, що диск не заповнений і не ' +
    'захищений від запису, а потім спробуйте ще раз.',
  'main.download.resumeDiscarded':
    'Сервер надіслав не ту частину файлу, тому частково завантажені дані відкинуто. Якщо ' +
    'запустити завантаження знову, воно почнеться з початку.',
  'main.engine.alreadyRunning': 'ШІ-рушій уже завантажується.',
  'main.engine.noSources':
    'На цьому диску не знайдено джерел для завантаження рушія (бракує файлу ' +
    'runtime-sources.yaml).',
  'main.engine.noHostBuild': 'Для цього компʼютера немає збірки ШІ-рушія.',
  'main.engine.alreadyInstalled': 'ШІ-рушій уже встановлено.',
  'main.engine.unknownJob': 'Невідоме завдання завантаження рушія.',
  'main.engine.checksumMismatch':
    'Контрольна сума завантаженого рушія не збіглася з очікуваною, тому його відкинуто. ' +
    'Спробуйте ще раз.',
  'main.engine.fileMissing': 'Завантажений рушій зник, перш ніж його вдалося перевірити.',
  'main.engine.unverifiablePlaceholder':
    'Для цього джерела ШІ-рушія немає справжньої контрольної суми, тому завантаження не вдалося ' +
    'перевірити, і його не встановлено. Можливо, диск налаштовано неправильно.',
  'main.engine.binaryMissing':
    'Рушій завантажено, але його не вдалося розпакувати (можливо, змінилася структура архіву).',
  'main.engine.extractFailed':
    'ШІ-рушій завантажено, але його не вдалося розпакувати. Спробуйте ще раз.',
  'main.engine.httpFailed':
    'Не вдалося почати завантаження рушія ({reason}). Перевірте зʼєднання та спробуйте ще раз.',
  'main.engine.interrupted': 'Завантаження рушія перервано ({reason}). Спробуйте ще раз.',
  'main.engine.runtimeRunning':
    'ШІ-рушій не можна замінити, поки працює модель. Зупиніть модель на екрані «ШІ-модель», а ' +
    'потім спробуйте ще раз.',
  'main.engine.transcriptionRunning':
    'Рушій мовлення не можна замінити, поки аудіо перетворюється на текст. Дочекайтеся ' +
    'завершення, а потім спробуйте ще раз.',
  'main.engine.knowledgePackToolsRunning':
    'Інструменти для пакетів знань не можна замінити, поки пакет використовується. Заблокуйте ' +
    'робочий простір або дочекайтеся відповіді на поточне запитання, а потім спробуйте ще раз — ' +
    'або перезапустіть застосунок, якщо це повідомлення не зникає.',
  'main.engine.badRequest': 'Запит на встановлення рушія незрозумілий. Спробуйте ще раз.',
  'main.engine.nothingToRepair':
    'Виправляти нічого не потрібно: пошкоджень рушія на цьому диску не виявлено.',
  'main.engine.nothingToUpdate':
    'Оновлювати нічого не потрібно: рушії на цьому диску вже мають версію, яку використовує цей ' +
    'застосунок, або новішу.',
  'main.engine.updateBusy':
    'ШІ-рушій зараз використовується (триває генерація відповіді, імпорт, переклад або завдання ' +
    'з документом). Спробуйте оновити його ще раз, коли все завершиться.',
  'main.ocr.badRequest': 'Запит на завантаження OCR-файлів незрозумілий. Спробуйте ще раз.',
  'main.ocr.alreadyRunning': 'OCR-файли вже завантажуються.',
  'main.ocr.noSources':
    'На цьому диску немає списку завантаження для OCR-файлів. Натомість додайте їх за допомогою ' +
    'сценаріїв налаштування диска («fetch-runtime --family ocr»).',
  'main.ocr.sourcesMismatch':
    'Список завантаження OCR-файлів на цьому диску не відповідає цій версії HilbertRaum, тому ' +
    'нічого не завантажено. Натомість додайте файли за допомогою сценаріїв налаштування диска ' +
    '(«fetch-runtime --family ocr»).',
  'main.ocr.alreadyInstalled':
    'OCR-файли вже є на цьому диску. Якщо розпізнавання тексту й далі не пропонується, ' +
    'перезапустіть HilbertRaum.',
  'main.ocr.unsafeFolder':
    'Папка «ocr» на цьому диску не є звичайною папкою (можливо, вона вказує на інше ' +
    'розташування), тому нічого не записано. Замініть її звичайною папкою з назвою «ocr», а ' +
    'потім спробуйте ще раз.',
  'main.ocr.writeFailed':
    'Не вдалося зберегти OCR-файли на цей диск. Переконайтеся, що на ньому є вільне місце і що ' +
    'він не захищений від запису, а потім спробуйте ще раз.',
  'main.ocr.downloadFailed':
    'Не вдалося завантажити OCR-файли. Перевірте зʼєднання з інтернетом, а потім спробуйте ще ' +
    'раз.',
  'main.ocr.checksumMismatch':
    'Контрольна сума завантаженого OCR-файлу не збіглася з очікуваною, тому файл відкинуто — ' +
    'файли, які вже були на цьому диску, не змінено. Спробуйте ще раз.',
  'main.ocr.readFailed':
    'OCR-файли, які вже є на цьому диску, не вдалося прочитати: можливо, диск відʼєднано або ' +
    'файли використовує інша програма. Перевірте диск, а потім спробуйте ще раз.',
  'main.ocr.unknownJob':
    'Це завантаження OCR-файлів більше не відстежується. Якщо файлів досі немає, запустіть його ' +
    'знову.',
  'main.docs.locked': 'Робочий простір заблоковано. Розблокуйте його, щоб керувати документами.',
  'main.docs.processing': 'Цей документ ще обробляється. Дочекайтеся завершення імпорту.',
  'main.docs.tooManyPaths': 'Вибрано забагато файлів одночасно. Натомість виберіть папку.',
  'main.docs.taskRunning':
    'Для цього документа виконується завдання. Скасуйте його або дочекайтеся завершення.',
  'main.docs.skillRunning':
    'З цим документом зараз працює навичка. Скасуйте її або дочекайтеся завершення.',
  'main.docs.previewEncrypted':
    'Цей документ зашифровано; щоб переглянути його, розблокуйте робочий простір.',
  'main.docs.previewGone':
    'Файлу документа більше немає на диску. Щоб переглянути його, імпортуйте документ ще раз.',
  'main.docs.exportTextOnly':
    'Так можна експортувати лише текстові документи (Markdown, TXT, CSV).',
  'main.docs.exportEncrypted':
    'Цей документ зашифровано; щоб експортувати його, розблокуйте робочий простір.',
  'main.docs.exportGone':
    'Файлу документа більше немає на диску. Щоб експортувати його, імпортуйте документ ще раз.',
  'main.docs.exportOriginalChanged':
    'Доступна лише ваша власна копія цього файлу, і після імпорту вона змінилася — тож це вже не ' +
    'оригінал. Натомість експортуйте видобутий текст.',
  'main.docs.noStoredTranscript':
    'Для цього запису ще немає збереженого тексту. Щоб знову перетворити запис на текст, ' +
    'переіндексуйте його.',
  'main.models.noManifests':
    'На цьому диску не знайдено списку моделей — бракує папки model-manifests.',
  'main.models.autoSelected':
    'Ця модель використовується автоматично після встановлення — вибирати нічого не потрібно.',
  'main.models.locked': 'Робочий простір заблоковано. Розблокуйте його, щоб керувати ШІ-моделями.',
  'main.audit.locked': 'Робочий простір заблоковано. Розблокуйте його, щоб переглянути активність.',
  'main.settings.locked': 'Робочий простір заблоковано. Розблокуйте його, щоб змінити параметри.',
  'main.evidenceReviews.locked':
    'Робочий простір заблоковано. Розблокуйте його, щоб працювати з перевірками обґрунтування.',
  'main.evidenceReviews.invalidRequest': 'Цей запит щодо перевірки неправильний.',
  'main.evidenceReviews.exportNotRecorded':
    'Не вдалося записати пакет обґрунтування в історію експорту, тому експортований файл ' +
    'видалено. Нічого не збережено — спробуйте експортувати ще раз.',
  'main.evidenceReviews.exportFileNotRecorded':
    'Файл пакету обґрунтування збережено, але його не вдалося записати в історію експорту й не ' +
    'вдалося видалити. Його хеш не збережено — експортуйте ще раз і замініть файл.',
  'main.evidenceReviews.exportOutdated':
    'Ця перевірка застаріла — джерело або відповідь змінилися, відколи її розпочато. Перш ніж ' +
    'експортувати, візьміть зміну до відома в перевірці.',
  'main.settings.invalidPatch': 'Ця зміна параметрів недійсна, тому її не збережено.',
  'main.dictation.locked':
    'Робочий простір заблоковано. Розблокуйте його, щоб користуватися голосовим диктуванням.',
  'main.dictation.silent':
    'До мікрофона не надійшло жодного звуку. Перевірте, чи не вимкнено на ньому звук і чи ' +
    'дозволено застосунку HilbertRaum користуватися ним у параметрах системи, а потім спробуйте ' +
    'ще раз.',
  'main.dictation.tooShort': 'Запис надто короткий, щоб у ньому було мовлення, — спробуйте ще раз.',
  'main.dictation.unavailable':
    'Голосове диктування на цьому диску ще недоступне — чого бракує, показано на екрані ' +
    '«ШІ-модель».',
  'main.dictation.failed': 'Не вдалося перетворити це на текст — спробуйте ще раз.',
  'main.dictation.tooLong':
    'Цей запис задовгий для диктування. Для довгих записів натомість імпортуйте аудіофайл як ' +
    'документ.',
  'main.dictation.busy': 'Попереднє диктування ще перетворюється на текст — зачекайте трохи.',
  'main.dictation.engineCannotRun':
    'Рушій мовлення не може працювати на цьому компʼютері. Чого бракує, показано на екрані ' +
    '«ШІ-модель».',
  'main.preflight.readOnly':
    'Схоже, цей диск доступний лише для читання, тому застосунок не може створити свій робочий ' +
    'простір. Спробуйте інший USB-порт або прочитайте посібник з усунення несправностей.',
  'main.preflight.lowSpace':
    'На цьому диску мало вільного місця. Можна все одно продовжити, але імпорт великих ' +
    'документів може не вдатися, доки ви не звільните місце.',
  'main.dialog.importDocuments': 'Імпортувати документи',
  'main.dialog.importFolder': 'Імпортувати папку з документами',
  'main.dialog.exportDocument': 'Експортувати документ',
  'main.dialog.exportOriginal': 'Експортувати оригінальний файл',
  'main.dialog.exportSummary': 'Експортувати підсумок',
  'main.dialog.exportChat': 'Експортувати текст розмови',
  'main.dialog.exportTableCsv': 'Експортувати таблицю як CSV',
  'main.dialog.exportCodeBlock': 'Зберегти блок коду як файл',
  'main.dialog.exportAudit': 'Експортувати журнал активності',
  'main.dialog.exportEvidencePack': 'Експортувати пакет обґрунтування',
  'main.dialog.exportLog': 'Зберегти журнали діагностики',
  'main.dialog.filterDocuments': 'Документи',
  'main.dialog.filterAll': 'Усі файли',
  'main.zim.unavailable': 'Пакети знань недоступні в цьому сеансі.',
  'main.zim.articleUnavailable':
    'Ця стаття зараз недоступна, тому її не вдалося зберегти. Можливо, пакет вимкнено, прибрано ' +
    'або диск із ним відʼєднано.',
  'main.zim.saveFailed': 'Не вдалося додати статтю до ваших документів. Спробуйте ще раз.',
  'main.zim.dialogTitle': 'Додати пакети знань',
  'main.zim.filterZim': 'ZIM-архіви',
  'main.dialog.chooseImage': 'Вибрати зображення',
  'main.dialog.filterImages': 'Зображення',
  'main.images.unsupportedType':
    'Цей тип файлу не підтримується. Виберіть файл PNG, JPEG або WEBP.',
  'main.images.tooLarge': 'Це зображення завелике для аналізу. Спробуйте менше зображення.',
  'main.dialog.importSkill': 'Імпортувати пакет навички',
  'main.dialog.importSkillFolder': 'Імпортувати папку навички',
  'main.dialog.exportSkill': 'Експортувати навичку',
  'main.dialog.filterSkill': 'Пакет навички',
  'main.dialog.exportCsv': 'Експортувати транзакції',
  'main.dialog.filterCsv': 'CSV-файл',
  'main.dialog.exportJson': 'Експортувати як JSON',
  'main.dialog.filterJson': 'JSON-файл',
  'main.dialog.exportXml': 'Експортувати як XML',
  'main.dialog.filterXml': 'XML-файл',
  'main.dialog.exportRedacted': 'Зберегти копію з прихованими даними',
  'main.dialog.exportEdited': 'Зберегти відредаговану копію',
  'main.dialog.filterText': 'Текстовий файл',
  'main.dialog.filterDocx': 'Документ Word',
  'main.collections.builtinUndeletable':
    'Вбудовані розділи «Бібліотека» і «Тимчасові» не можна видалити.',
  'main.skills.locked': 'Робочий простір заблоковано. Розблокуйте його, щоб керувати навичками.',
  'main.skills.notPicked': 'Спершу виберіть пакет навички у вікні вибору файлів.',
  'main.skills.incompatible':
    'Цій навичці потрібна новіша версія застосунку. Оновіть застосунок, щоб її використовувати.',
  'main.skills.run.unavailable': 'Інструмент цієї навички зараз недоступний.',
  'main.skills.run.noDocument': 'Спершу додайте документ до цього чату, а потім спробуйте ще раз.',
  'main.skills.run.busy':
    'Навичка вже працює. Дочекайтеся завершення або спершу скасуйте виконання.',
  'main.skills.run.documentOutOfScope':
    'Цього документа немає серед документів цього чату. Виберіть один із них і спробуйте ще раз.',
  // ---- Document organization — Documents screen sections + actions (plan §12) ----
  'docs.section.heading': 'Розділи',
  'docs.section.library': 'Бібліотека',
  'docs.section.projects': 'Проєкти',
  'docs.section.temporary': 'Тимчасові',
  'docs.section.generated': 'Згенеровані',
  'docs.section.archived': 'В архіві',
  'docs.section.all': 'Усі документи',
  'docs.section.newProject': 'Новий проєкт',
  'docs.mode.aria': 'Подання документів',
  'docs.mode.documents': 'Мої документи',
  'docs.mode.packs': 'Пакети знань',
  'docs.filter.placeholder': 'Фільтр за назвою…',
  'docs.filter.aria': 'Фільтрувати документи за назвою',
  'docs.filter.noMatch': 'Жоден документ не відповідає запиту «{query}».',
  'docs.empty.packsLine':
    'Або додайте пакет знань — офлайн-версію Вікіпедії, на основі якої чат може відповідати.',
  'docs.empty.packsAction': 'Пакети знань',
  'docs.rail.hide': 'Сховати розділи',
  'docs.rail.show': 'Показати розділи',
  'docs.project.createTitle': 'Створити проєкт',
  'docs.project.namePlaceholder': 'Назва проєкту',
  'docs.project.nameAria': 'Назва проєкту',
  'docs.project.create': 'Створити',
  'docs.project.rename': 'Перейменувати',
  'docs.project.renameTitle': 'Перейменувати проєкт',
  'docs.project.archive': 'Архівувати',
  'docs.project.unarchive': 'Повернути з архіву',
  'docs.project.delete': 'Видалити проєкт',
  'docs.project.deleteTitle': 'Видалити цей проєкт?',
  'docs.project.deleteBody': 'Виберіть, що буде з документами цього проєкту:',
  'docs.project.deleteKeep': 'Прибрати лише проєкт — зберегти його документи',
  'docs.project.deleteKeepHint':
    'Документи залишаться в розділі «Бібліотека» та в будь-яких інших проєктах.',
  'docs.project.deleteWith': 'Видалити проєкт і документи, які є лише в ньому',
  'docs.project.deleteWithHint':
    'Буде видалено лише документи, яких немає в розділі «Бібліотека» або в іншому проєкті. Вміст ' +
    'розділу «Бібліотека» ніколи не зачіпається.',
  'docs.project.archivedNote':
    'В архіві — не показується як джерело, але його документи й далі доступні для запитань в ' +
    'інших місцях.',
  'docs.project.options': 'Дії з проєктом',
  'docs.action.moveToProject': 'Перемістити до проєкту…',
  'docs.action.addToLibrary': 'Зберегти в розділі «Бібліотека»',
  'docs.action.removeFromProject': 'Прибрати з цього проєкту',
  'docs.action.markTemporary': 'Зберігати тимчасово',
  'docs.action.markPermanent': 'Зберігати постійно',
  'docs.action.archive': 'Архівувати',
  'docs.action.unarchive': 'Повернути з архіву',
  'docs.action.chooseProject': 'Вибрати проєкт',
  'docs.chip.library': 'Бібліотека',
  'docs.chip.temporary': 'Тимчасовий',
  'docs.chip.generated': 'Згенерований',
  'docs.chip.archived': 'В архіві',
  'docs.bulk.selected.one': 'Вибрано: {count}',
  'docs.bulk.selected.few': 'Вибрано: {count}',
  'docs.bulk.selected.many': 'Вибрано: {count}',
  'docs.bulk.selected.other': 'Вибрано: {count}',
  'docs.selectionAria': 'Дії з вибраними документами',
  'docs.bulk.delete': 'Видалити',
  'docs.bulk.deleteConfirm.title.one': 'Видалити {count} документ?',
  'docs.bulk.deleteConfirm.title.few': 'Видалити {count} документи?',
  'docs.bulk.deleteConfirm.title.many': 'Видалити {count} документів?',
  'docs.bulk.deleteConfirm.title.other': 'Видалити {count} документа?',
  'docs.bulk.deleteConfirm.body':
    'Вибрані документи, їхній видобутий текст і пошуковий індекс буде остаточно видалено з ' +
    'вашого робочого простору. Оригінальні файли поза робочим простором залишаться без змін.',
  'docs.empty.section': 'Тут ще нічого немає.',
  // ---- Document organization — smart views (plan §7.6/§12.1, Phase E; regrouped §11.16) ----
  'docs.smart.recentlyAdded': 'Нещодавно додані',
  'docs.smart.unfiled': 'Без проєкту',
  'docs.smart.attention': 'Потребують уваги',
  'docs.smart.attentionTitle': 'Невдалі імпорти й документи, які потрібно переіндексувати',
  'docs.smart.more': 'Більше',
  'docs.provenance.staleBadge': 'Застарів',
  'docs.provenance.staleChanged':
    'Джерело змінилося після створення цього документа — щоб оновити його, запустіть завдання ще ' +
    'раз.',
  'docs.provenance.staleRemoved':
    'Джерело видалено після створення цього документа — щоб оновити його, запустіть завдання ще ' +
    'раз.',
  // ---- Chat — composite source scope (multi-select picker + footer union, plan §13) ----
  'chat.scope.library': 'Бібліотека',
  'chat.scope.projectNamed': 'Проєкт «{name}»',
  'chat.scope.projectCount.one': '{count} проєкт',
  'chat.scope.projectCount.few': '{count} проєкти',
  'chat.scope.projectCount.many': '{count} проєктів',
  'chat.scope.projectCount.other': '{count} проєкту',
  // ---- Knowledge packs (ZIM wave: ScopePopover / SourcesDisclosure / ArticleModal / PacksPanel) ----
  'chat.scope.packsTitle': 'Пакети знань',
  'chat.scope.packUnavailable': 'недоступний',
  'chat.scope.packNamed': 'Пакет «{name}»',
  'chat.scope.packNamedState': 'Пакет «{name}» ({state})',
  'chat.scope.packCount.one': '{count} пакет знань',
  'chat.scope.packCount.few': '{count} пакети знань',
  'chat.scope.packCount.many': '{count} пакетів знань',
  'chat.scope.packCount.other': '{count} пакета знань',
  'chat.scope.documentsToggle': 'Шукати в моїх документах',
  'chat.scope.documentsToggleHint':
    'Вимкнено: відповіді беруться лише з позначених пакетів знань. Файли, прикріплені до цього ' +
    'чату, і далі використовуються.',
  'chat.scope.documentsOffSuffix': 'документи вимкнено',
  'chat.scope.documentsOffNoPacks':
    'нічого не вибрано — увімкніть документи або позначте пакет знань',
  'chat.scope.packDisabled': 'вимкнено',
  'chat.scope.packRemoved': 'Прибраний пакет',
  'chat.scope.packLimit.one': 'Не більше ніж {count} пакет знань на чат',
  'chat.scope.packLimit.few': 'Не більше ніж {count} пакети знань на чат',
  'chat.scope.packLimit.many': 'Не більше ніж {count} пакетів знань на чат',
  'chat.scope.packLimit.other': 'Не більше ніж {count} пакета знань на чат',
  // ---- Per-answer knowledge-pack outcomes (#301 P4, findings M6/M7 — PackOutcomesNotice) ----
  'chat.packs.outcome.summary':
    'Пакети знань — пошук виконано: {searched} · пошук не виконано або не вдався: {other}',
  'chat.packs.outcome.removedPack': 'прибраний пакет',
  'chat.packs.outcome.passages.one': '{count} фрагмент',
  'chat.packs.outcome.passages.few': '{count} фрагменти',
  'chat.packs.outcome.passages.many': '{count} фрагментів',
  'chat.packs.outcome.passages.other': '{count} фрагмента',
  'chat.packs.outcome.unknown': 'Пакети знань: для цієї старішої відповіді результат не збережено',
  'chat.packs.outcome.searched': 'пошук виконано',
  'chat.packs.outcome.selection-limit': 'пошук не виконано: обмеження вибору (12 на чат)',
  'chat.packs.outcome.removed': 'пошук не виконано: пакет прибрано',
  'chat.packs.outcome.disabled': 'пошук не виконано: пакет вимкнено',
  'chat.packs.outcome.file-missing': 'пошук не виконано: файлу немає',
  'chat.packs.outcome.identity-mismatch': 'пошук не виконано: на цьому місці інший архів',
  'chat.packs.outcome.not-served': 'пошук не виконано: назва конфліктує з іншим пакетом',
  'chat.packs.outcome.not-searchable': 'пошук не виконано: немає повнотекстового індексу',
  'chat.packs.outcome.tools-missing': 'пошук не виконано: програми kiwix-tools не встановлено',
  'chat.packs.outcome.mode':
    'пошук не виконано: відповіді на основі всього документа використовують лише цей документ',
  'chat.packs.outcome.search-failed': 'не вдалося: помилка пошуку',
  'chat.packs.outcome.read-failed': 'не вдалося: не прочитано жодної статті',
  'chat.packs.outcome.timeout': 'не вдалося: минув час очікування',
  'chat.packs.outcome.deadline': 'пошук не виконано: на це запитання забракло часу',
  'chat.packs.outcome.server-restarted':
    'не вдалося: під час цього запитання сервер пакетів перезапустився',
  'chat.sources.openArticle': 'Відкрити статтю',
  'chat.article.title': 'Стаття',
  'chat.article.from': 'З пакету знань {archive} — офлайн-копія',
  'chat.article.loading': 'Відкриття статті…',
  'chat.article.unavailable':
    'Ця стаття зараз недоступна. Можливо, пакет вимкнено, прибрано або його диск відʼєднано.',
  'chat.article.partial': 'Вдалося показати лише першу частину цієї статті.',
  'chat.article.save': 'Зберегти до моїх документів',
  'chat.article.saveAria': 'Зберегти до моїх документів: {title}',
  'chat.article.saving': 'Збереження до ваших документів…',
  'chat.article.saved':
    'Збережено до ваших документів як «{title}». У цьому документі можна шукати навіть без ' +
    'пакету.',
  'chat.article.alreadySaved': 'Ця стаття вже є серед ваших документів як «{title}».',
  // ---- #301 P6 (a11y pass; plan §9.23 (b)4/(b)6 and decision (c)5) — BEGIN -----------------
  'chat.scope.packMissing': 'файлу немає',
  'chat.scope.packMismatch': 'на цьому місці інший архів',
  'chat.scope.packNotSearchable': 'немає повнотекстового індексу',
  'chat.sources.openArticleNamed': 'Відкрити статтю: {title}',
  // ---- #301 P6 — END ------------------------------------------------------------------------
  'packs.add': 'Додати пакети…',
  'packs.addBusy': 'Додавання…',
  'packs.refresh': 'Оновити список',
  'packs.lead':
    'Офлайн-архіви довідкових матеріалів (ZIM-файли, наприклад офлайн-версія Вікіпедії), на ' +
    'основі яких чат може відповідати. Файли використовуються там, де вони лежать, і ніколи не ' +
    'копіюються: покладіть їх у папку zim на диску або додайте тут.',
  'packs.summary.count.one': '{count} пакет',
  'packs.summary.count.few': '{count} пакети',
  'packs.summary.count.many': '{count} пакетів',
  'packs.summary.count.other': '{count} пакета',
  'packs.summary.enabled.one': 'увімкнено: {count}',
  'packs.summary.enabled.few': 'увімкнено: {count}',
  'packs.summary.enabled.many': 'увімкнено: {count}',
  'packs.summary.enabled.other': 'увімкнено: {count}',
  'packs.summary.size': '{size} на цьому диску',
  'packs.loading': 'Відкриття списку пакетів…',
  'packs.refreshing': 'Пошук пакетів на диску…',
  'packs.emptyTitle': 'Пакетів знань ще немає',
  'packs.emptyLine':
    'Завантажте однофайловий архів .zim із сайту library.kiwix.org, а потім додайте його тут або ' +
    'скопіюйте в папку zim на диску.',
  'packs.copyLibrary': 'Скопіювати адресу бібліотеки',
  'packs.copiedToast': 'Скопійовано: library.kiwix.org',
  'packs.copyFailed': 'Не вдалося скопіювати — адреса: library.kiwix.org',
  'packs.setup.title': 'Одноразове налаштування: інструменти для пакетів знань',
  'packs.toolsMissing':
    'Програми kiwix-tools не встановлено на цьому диску, тому додавати пакети й шукати в них не ' +
    'можна. Крок встановлення описано в посібнику з усунення несправностей, у розділі «The panel ' +
    'says kiwix-tools are missing».',
  'packs.tools.install': 'Встановити інструменти для пакетів знань…',
  'packs.tools.confirm.title': 'Встановити інструменти для пакетів знань?',
  'packs.tools.confirm.explain':
    'Програми kiwix-tools {version}, які обслуговують пакети знань (ZIM-архіви), буде ' +
    'завантажено із сервера проєкту Kiwix і перевірено перед використанням. Вони необовʼязкові: ' +
    'чат і документи працюють і без них.',
  'packs.tools.confirm.hint':
    'Завантажені файли перевіряються перед використанням, і нічого про вас чи ваші документи не ' +
    'надсилається. Ці інструменти потрібні лише для пакетів знань.',
  'packs.tools.confirm.ack': 'Я приймаю умови ліцензії {license} для kiwix-tools; їх прочитано',
  'packs.tools.confirm.start': 'Почати завантаження',
  'packs.tools.sizeUnknown': 'невідомо',
  'packs.tools.progress': 'Встановлення інструментів для пакетів знань… {pct}%',
  'packs.tools.downloadingNoTotal': 'Встановлення інструментів для пакетів знань…',
  'packs.tools.verifying': 'Перевірка інструментів для пакетів знань…',
  'packs.tools.extracting': 'Розпакування інструментів для пакетів знань…',
  'packs.tools.failed': 'Не вдалося встановити інструменти для пакетів знань.',
  'packs.tools.doneToast': 'Інструменти для пакетів знань встановлено',
  'packs.addedToast.one': 'Додано {count} пакет знань',
  'packs.addedToast.few': 'Додано {count} пакети знань',
  'packs.addedToast.many': 'Додано {count} пакетів знань',
  'packs.addedToast.other': 'Додано {count} пакета знань',
  'packs.addPartial': 'Архіви, які не вдалося додати: {failed} з {total}.',
  'packs.addFailed.notAZim': 'Вибраний файл не є ZIM-архівом, який можна прочитати.',
  'packs.addFailed.toolsMissing':
    'Програми kiwix-tools не встановлено на цьому диску, тому додавати пакети й шукати в них не ' +
    'можна. Крок встановлення описано в посібнику з усунення несправностей, у розділі «The panel ' +
    'says kiwix-tools are missing».',
  'packs.addFailed.manager':
    'Програмі kiwix-manage не вдалося прочитати архів. Переконайтеся, що файл повний, і ' +
    'спробуйте ще раз.',
  'packs.addFailed.pathUnsupported':
    'У Windows програма kiwix-manage не може прочитати цей архів, бо назва його файлу або папки ' +
    'містить кириличну літеру, умлаут, діакритичний знак або інший символ поза ASCII. Скопіюйте ' +
    'файл у папку zim/ на диску під назвою без таких символів і додайте його ще раз.',
  'packs.addFailed.other': 'Не вдалося додати архів.',
  'packs.removedToast': 'Пакет знань прибрано',
  'packs.articleCount.one': '{count} стаття',
  'packs.articleCount.few': '{count} статті',
  'packs.articleCount.many': '{count} статей',
  'packs.articleCount.other': '{count} статті',
  'packs.state.enabled': 'Увімкнено',
  'packs.state.disabled': 'Вимкнено',
  'packs.state.missing': 'Файлу немає',
  'packs.state.missingTitle': 'Файл архіву не знайдено — чи підключено диск?',
  'packs.state.identityMismatch': 'Інший архів',
  'packs.state.identityMismatchTitle':
    'На місці файлу цього пакету лежить інший архів — приберіть цей пакет і додайте файл ще раз',
  'packs.state.notSearchable': 'Без індексу пошуку',
  'packs.state.notSearchableTitle':
    'Цей архів не має повнотекстового індексу пошуку. Під час запитань він не використовується, ' +
    'але його статті й далі можна читати.',
  'packs.state.notServed': 'Недоступний',
  'packs.state.notServedTitle':
    'Назва файлу конфліктує з пакетом «{title}», тому доступний лише той пакет — перейменуйте ' +
    'цей файл, щоб використовувати обидва.',
  'packs.state.notServedTitleUnknown':
    'Назва файлу конфліктує з назвою іншого пакету, тому доступний лише той пакет — перейменуйте ' +
    'цей файл, щоб використовувати обидва.',
  'packs.switchLabel': 'Використовувати пакет «{title}» у чатах',
  'packs.ask': 'Запитати цей пакет',
  'packs.askTitle': 'Відкрити чат, який відповідає лише на основі цього пакету',
  'packs.rowMenu': 'Інші дії з пакетом «{title}»',
  'packs.remove': 'Прибрати',
  'packs.listLabel': 'Пакети знань',
  'packs.removeTitle': 'Прибрати цей пакет знань?',
  'packs.removeConfirm': 'Прибрати пакет',
  'packs.removeBody':
    'Пакет буде прибрано лише з HilbertRaum — файл архіву на диску залишиться без змін. Чати, ' +
    'які його використовували, просто більше не братимуть із нього інформацію.',
  'chat.scope.docCount.one': '{count} документ',
  'chat.scope.docCount.few': '{count} документи',
  'chat.scope.docCount.many': '{count} документів',
  'chat.scope.docCount.other': '{count} документа',
  'chat.scope.filesInChat.one': '{count} файл у цьому чаті',
  'chat.scope.filesInChat.few': '{count} файли в цьому чаті',
  'chat.scope.filesInChat.many': '{count} файлів у цьому чаті',
  'chat.scope.filesInChat.other': '{count} файлу в цьому чаті',
  'chat.scope.sourcesTitle': 'Виберіть джерела',
  'chat.scope.librarySource': 'Бібліотека',
  'chat.scope.librarySourceHint': 'Усі ваші документи',
  'chat.scope.specificToggle': 'Окремі документи…',
  'chat.scope.allTap': 'Усі документи',
  'chat.scope.attachmentsOnlyTap': 'Лише файли в цьому чаті',
  'chat.scope.filesInChatLine': 'Файли в цьому чаті',
  'chat.scope.attachmentNotReadable': '{name} (ще не можна прочитати)',
  'chat.scope.attachmentFailedHint':
    'Файл, який ще не можна прочитати, нічого не додає до відповідей. Чому так і що робити, ' +
    'показано на екрані «Документи».',
  'chat.scope.noProjects': 'Проєктів ще немає',
  'chat.scope.noPacks': 'На цьому диску ще немає пакетів знань.',
  'chat.scope.addPacks': 'Додати пакети…',
  'chat.scope.archivedFallback':
    'Цей проєкт архівовано — відповіді беруться з розділу «Бібліотека».',
  'chat.scope.answeringFrom': 'Джерела: {source}',
  'chat.scope.wholeLibrary.one': 'уся ваша бібліотека — {count} документ',
  'chat.scope.wholeLibrary.few': 'уся ваша бібліотека — {count} документи',
  'chat.scope.wholeLibrary.many': 'уся ваша бібліотека — {count} документів',
  'chat.scope.wholeLibrary.other': 'уся ваша бібліотека — {count} документа',
  'chat.scope.narrowTitle': 'Відповідати лише на основі цього файлу?',
  'chat.scope.narrowBody':
    'Ви додали файл «{name}». Запитувати лише цей файл чи й далі брати відповіді з усієї вашої ' +
    'бібліотеки?',
  'chat.scope.narrowJust': 'Лише цей файл',
  'chat.scope.narrowWhole': 'Уся бібліотека',
  // ---- Chat — attach / drag-drop a file into a chat (plan §11.2/§13.5, Phase C) ----
  'chat.attach.button': 'Прикріпити файли',
  'chat.attach.drop': 'Відпустіть файли тут, щоб використати їх у цьому чаті',
  'chat.attach.processing': 'Обробка: {name}…',
  'chat.attach.added': 'Файл «{name}» додано до цього чату',
  'chat.attach.newDocChat': 'Розпочато новий чат для документа «{name}»',
  'chat.attach.failed': 'Не вдалося додати файл «{name}» до цього чату.',
  'chat.attach.dropUnsupported':
    'Не вдалося додати — перетягніть файл, збережений на вашому компʼютері.',
  'chat.attach.trackFailed':
    'Не вдалося відстежити імпорт файлу — результат дивіться на екрані «Документи».',
  'chat.attach.scanned':
    'Файл «{name}» схожий на скан, тому його ще не можна прочитати. На екрані «Документи» ' +
    'скористайтеся для нього кнопкою «Розпізнати текст (OCR)». Після цього він сам додасться до ' +
    'цього чату — прикріплювати його ще раз не потрібно.',
  'chat.attach.photoNeedsOcr':
    'Файл «{name}» — це фотографія сторінки, і щоб прочитати її, потрібні OCR-файли, яких ще ' +
    'немає на цьому диску. На екрані «Документи» скористайтеся кнопкою «Завантажити OCR-файли», ' +
    'а потім для цього файлу — кнопкою «Спробувати ще раз». Після цього він сам додасться до ' +
    'цього чату — прикріплювати його ще раз не потрібно.',
  'chat.attach.goToDocuments': 'Відкрити Документи',
  // ---- Images — "Ask about an image" (image-understanding §5/§11, Phase V3) ----
  'images.title': 'Аналіз зображення',
  'images.empty.body':
    'Ставте запитання щодо знімка екрана, діаграми, форми, чека або фотографії. Усе залишається ' +
    'на цьому пристрої.',
  'images.avail.noModel':
    'Для аналізу зображень потрібна локальна модель для зображень на цьому диску.',
  'images.avail.noRuntime': 'Для аналізу зображень спершу потрібно встановити ШІ-рушій.',
  'images.avail.incompatible': 'Модель для зображень на цьому диску потребує новішого ШІ-рушія.',
  'images.avail.cta': 'Відкрити ШІ-модель',
  'images.avail.ocrPointer':
    'Скановані документи? Скористайтеся кнопкою «Розпізнати текст (OCR)» на екрані «Документи».',
  'images.drop.title': 'Перетягніть зображення сюди',
  'images.drop.choose': 'або виберіть зображення',
  'images.drop.types': 'PNG, JPEG або WEBP',
  'images.drop.busy': 'Триває аналіз. Дочекайтеся його завершення, щоб розпочати новий.',
  'images.back': 'Назад до аналізів',
  'images.preview.remove': 'Прибрати',
  'images.preview.replace': 'Замінити',
  'images.preview.alt': 'Вибране зображення',
  'images.chip.summarize': 'Підсумуйте це зображення',
  'images.chip.summarize.prompt':
    'Підсумуйте видимий вміст цього зображення. Згадайте все важливе або незвичне.',
  'images.chip.extractText': 'Випишіть видимий текст',
  'images.chip.extractText.prompt':
    'Випишіть видимий текст, який вдається прочитати. Зберігайте розриви рядків, де це корисно. ' +
    'Укажіть, якщо якийсь текст нерозбірливий.',
  'images.chip.explainChart': 'Поясніть цю діаграму',
  'images.chip.explainChart.prompt':
    'Поясніть, що, імовірно, показує ця діаграма. Згадайте осі, підписи, тенденції та будь-яку ' +
    'невизначеність.',
  'images.chip.readForm': 'Прочитайте цю форму',
  'images.chip.readForm.prompt':
    'Визначте основні поля та значення, видимі в цій формі. Пишіть «нерозбірливо» там, де щось ' +
    'не вдається прочитати.',
  'images.chip.importantDetails': 'Знайдіть важливі деталі',
  'images.chip.importantDetails.prompt':
    'Перелічіть найважливіші видимі деталі. Не робіть висновків про те, чого не видно.',
  'images.chip.whatNotice': 'На що звернути увагу?',
  'images.chip.whatNotice.prompt':
    'На що звернути увагу на цьому зображенні? Назвіть лише найпомітніші видимі елементи.',
  'images.composer.placeholder': 'Запитайте про це зображення…',
  'images.composer.ask': 'Запитати',
  'images.answer.localNote': 'Згенеровано локально на основі вибраного зображення.',
  'images.answer.copy': 'Скопіювати',
  'images.answer.copied': 'Скопійовано',
  'images.answer.copyFailed': 'Не вдалося скопіювати в буфер обміну',
  'images.answer.tryAgain': 'Спробувати ще раз',
  'images.answer.reading': 'Читання зображення…',
  'images.answer.starting': 'Запуск моделі для зображень…',
  'images.answer.stop': 'Зупинити',
  'images.answer.stopped': 'Зупинено.',
  'images.err.tooLarge': 'Це зображення завелике для аналізу. Спробуйте менше зображення.',
  'images.err.unsupported': 'Цей тип файлу не підтримується. Виберіть файл PNG, JPEG або WEBP.',
  'images.err.heic':
    'Фотографії HEIC з iPhone поки що не підтримуються. Спершу перетворіть фотографію на JPEG.',
  'images.err.pdf':
    'Цей екран читає одне зображення, а не PDF-файл. Для сканованого PDF-файлу скористайтеся ' +
    'кнопкою «Розпізнати текст (OCR)» на екрані «Документи».',
  'images.err.pdfAction': 'Відкрити Документи',
  'images.err.decodeFailed':
    'Не вдалося відкрити це зображення. Можливо, воно пошкоджене або має непідтримуваний формат.',
  'images.err.multiDrop': 'Перетягуйте зображення по одному.',
  'images.err.runtimeFailed':
    'Не вдалося запустити модель для зображень. Спробуйте ще раз або виберіть іншу модель.',
  'images.err.engineCannotRun':
    'ШІ-рушій не може працювати на цьому компʼютері. Чого бракує, показано на екрані «ШІ-модель».',
  'images.err.emptyResponse':
    'На запитання щодо цього зображення не надійшло відповіді. Спробуйте сформулювати запитання ' +
    'інакше.',
  'images.err.emptyQuestion': 'Спершу введіть запитання щодо зображення.',
  'images.err.timedOut': 'Це триває задовго. Спробуйте менше зображення або запитайте ще раз.',
  'images.err.contextExceeded':
    'Ця розмова стала задовгою для цього зображення. Поставте коротше запитання або розпочніть ' +
    'новий аналіз.',
  'images.err.busy': 'Обробка попереднього запитання…',
  'images.err.openFailed': 'Не вдалося відкрити цей аналіз. Спробуйте ще раз.',
  'images.err.deleteFailed': 'Не вдалося видалити цей аналіз. Спробуйте ще раз.',
  'images.err.clearFailed': 'Не вдалося очистити історію. Спробуйте ще раз.',
  'images.history.title': 'Історія',
  'images.history.empty': 'Тут зʼявлятимуться зображення, які ви аналізуєте.',
  'images.history.running': 'Триває аналіз…',
  'images.history.runningOpen': 'Переглянути поточний аналіз',
  'images.history.turns.one': '{count} запитання',
  'images.history.turns.few': '{count} запитання',
  'images.history.turns.many': '{count} запитань',
  'images.history.turns.other': '{count} запитання',
  'images.history.delete': 'Видалити',
  'images.history.deleteAria': 'Видалити зображення «{title}»',
  'images.history.deleted': 'Видалено з історії',
  'images.history.delete.title': 'Видалити це зображення?',
  'images.history.delete.confirm': 'Видалити',
  'images.history.delete.body':
    'Зображення «{title}» і відповіді щодо нього буде остаточно видалено з цього диска.',
  'images.history.total': 'Разом: {size}',
  'images.history.clear': 'Очистити історію',
  'images.history.clear.title': 'Очистити історію зображень?',
  'images.history.clear.confirm': 'Очистити історію',
  'images.history.clear.body':
    'Усі збережені аналізи ({size}) і збережені зображення до них буде остаточно видалено з ' +
    'цього диска.',
  'images.history.cleared': 'Історію зображень очищено',
  // ---- Translate screen (TranslateGemma wave, plan §2 D6, TG-4) ----
  'translate.title': 'Переклад тексту',
  'translate.lead':
    'Введіть або вставте текст, виберіть мови й перекладіть його локально. Ніщо не виходить за ' +
    'межі цього диска.',
  'translate.starting': 'Підготовка моделі перекладу…',
  'translate.avail.noModel': 'Для перекладу потрібна модель перекладу на цьому диску.',
  'translate.avail.hint':
    'Завантажте її один раз на екрані «ШІ-модель» — після цього переклад працюватиме повністю ' +
    'офлайн.',
  'translate.avail.cta': 'Відкрити ШІ-модель',
  'translate.from': 'З мови',
  'translate.to': 'На мову',
  'translate.swap': 'Поміняти мови місцями',
  'translate.input.label': 'Текст для перекладу',
  'translate.input.placeholder': 'Введіть або вставте текст для перекладу…',
  'translate.action': 'Перекласти',
  'translate.stop': 'Зупинити',
  'translate.output.label': 'Переклад',
  'translate.output.empty': 'Тут зʼявиться переклад.',
  'translate.working': 'Переклад…',
  'translate.copy': 'Скопіювати',
  'translate.copied': 'Скопійовано',
  'translate.device.gpu': 'Переклад виконується на відеокарті (GPU, шарів: {done}/{total})',
  'translate.device.gpuUnknown': 'Переклад виконується на відеокарті (GPU)',
  'translate.device.gpuPartial':
    'Переклад лише частково виконується на відеокарті (шарів: {done}/{total}) — більшу частину ' +
    'відеопамʼяті було зайнято (зазвичай її займає модель чату), тому швидкість приблизно така, ' +
    'як на процесорі',
  'translate.device.gpuNone':
    'Переклад виконується на процесорі — відеопамʼять було повністю зайнято (зазвичай її займає ' +
    'модель чату), тому на відеокарті не вмістилося жодного шару (шарів: 0/{total})',
  'translate.device.cpu': 'Переклад виконується на процесорі (CPU)',
  'translate.device.cpuBesideChat':
    'Переклад виконується на процесорі — відеопамʼять використовує модель чату, і поруч із нею ' +
    'модель перекладу не вмістилася б',
  'translate.device.cpuChatStarting':
    'Переклад виконується на процесорі — тоді якраз запускалася модель чату, а модель чату ' +
    'отримує відеокарту першою',
  'translate.device.cpuTooLarge':
    'Переклад виконується на процесорі — модель перекладу не вміщається в памʼять цієї відеокарти',
  'translate.device.title':
    'Де працювала модель перекладу під час останнього запуску. Під час кожного запуску вона ' +
    'заново визначає, де працювати (і зупиняється приблизно через 2 хвилини після останнього ' +
    'перекладу).',
  'translate.device.partialTitle':
    'Щоб модель перекладу отримала більше місця на відеокарті, використайте меншу модель чату ' +
    'або зупиніть модель чату перед перекладом. Під час наступного запуску (приблизно через 2 ' +
    'хвилини після останнього перекладу) модель перекладу знову визначає, скільки шарів умістити ' +
    'на відеокарті.',
  'translate.device.gpuNoneTitle':
    'Щоб модель перекладу взагалі вмістилася на відеокарті, використайте меншу модель чату або ' +
    'зупиніть модель чату перед перекладом. Під час наступного запуску (приблизно через 2 ' +
    'хвилини після останнього перекладу) модель перекладу знову визначає, скільки шарів умістити ' +
    'на відеокарті.',
  'translate.err.noModel':
    'Модель перекладу більше недоступна. Відкрийте екран «ШІ-модель», щоб встановити її.',
  'translate.err.badRequest':
    'Виберіть мову оригіналу й мову перекладу та введіть текст для перекладу.',
  'translate.err.busy':
    'Переклад уже виконується. Дочекайтеся його завершення, а потім спробуйте ще раз.',
  'translate.err.docTaskBusy':
    'Виконується завдання з документом. Дочекайтеся його завершення, а потім перекладіть текст.',
  'translate.err.runtimeFailed':
    'Модель перекладу не змогла завершити роботу. Спробуйте ще раз або перекладіть коротший ' +
    'текст.',
  'translate.err.startFailed':
    'Не вдалося запустити модель перекладу — можливо, на цьому пристрої замало вільної памʼяті. ' +
    'Закрийте інші застосунки або перезапустіть HilbertRaum, а потім спробуйте ще раз.',
  'translate.err.engineCannotRun':
    'ШІ-рушій не може працювати на цьому компʼютері. Чого бракує, показано на екрані «ШІ-модель».',
  'translate.err.empty': 'Переклад не надійшов. Спробуйте ще раз або сформулюйте текст інакше.',
  'translate.err.sameLang': 'Виберіть дві різні мови.',
  'translate.err.tooLong':
    'Текст задовгий для перекладу тут (понад 200\u00A0000 символів). Розділіть його на менші ' +
    'частини або збережіть як файл і перекладіть як документ.',
  // ---- Document drag-and-drop translation (TG-5, plan §2 D7) ----
  'translate.drop.title': 'Або перетягніть сюди документ для перекладу',
  'translate.drop.choose': 'або виберіть документ',
  'translate.drop.types':
    'PDF, Word, Markdown або текст — документ буде перекладено на вибрану мову.',
  'translate.file.importing': 'Читання документа…',
  'translate.file.progress': 'Переклад… ({done}/{total})',
  'translate.file.preparing': 'Підготовка перекладу — читання документа…',
  'translate.file.saving': 'Збереження перекладеного документа…',
  'translate.file.truncated':
    'Показано початок перекладу — щоб побачити весь документ, експортуйте його або відкрийте на ' +
    'екрані «Документи».',
  'translate.file.export': 'Експортувати…',
  'translate.file.exported': 'Документ експортовано',
  'translate.file.show': 'Показати на екрані «Документи»',
  'translate.file.reset': 'Перекласти інший документ',
  'translate.file.doneAnnounce': 'Переклад документа завершено. Результат показано.',
  'translate.file.gapPages.one':
    '⚠ Частину оригіналу не перекладено (номери сторінок: {pages}) — тексту, придатного для ' +
    'читання, там не знайдено (можливо, вміст відскановано). Кожен пропуск позначено в перекладі.',
  'translate.file.gapPages.few':
    '⚠ Частину оригіналу не перекладено (номери сторінок: {pages}) — тексту, придатного для ' +
    'читання, там не знайдено (можливо, вміст відскановано). Кожен пропуск позначено в перекладі.',
  'translate.file.gapPages.many':
    '⚠ Частину оригіналу не перекладено (номери сторінок: {pages}) — тексту, придатного для ' +
    'читання, там не знайдено (можливо, вміст відскановано). Кожен пропуск позначено в перекладі.',
  'translate.file.gapPages.other':
    '⚠ Частину оригіналу не перекладено (номери сторінок: {pages}) — тексту, придатного для ' +
    'читання, там не знайдено (можливо, вміст відскановано). Кожен пропуск позначено в перекладі.',
  'translate.file.failedParts.one':
    '⚠ Не вдалося перекласти {count} частину — оригінальний текст залишено в перекладі й ' +
    'позначено.',
  'translate.file.failedParts.few':
    '⚠ Не вдалося перекласти {count} частини — оригінальний текст залишено в перекладі й ' +
    'позначено.',
  'translate.file.failedParts.many':
    '⚠ Не вдалося перекласти {count} частин — оригінальний текст залишено в перекладі й ' +
    'позначено.',
  'translate.file.failedParts.other':
    '⚠ Не вдалося перекласти {count} частини — оригінальний текст залишено в перекладі й ' +
    'позначено.',
  'translate.file.err.multiDrop': 'Перетягуйте документи по одному.',
  'translate.file.err.noPath':
    'Цей елемент не має файлу на диску. Перетягніть документ із папки або натисніть кнопку «або ' +
    'виберіть документ».',
  'translate.file.err.unsupported':
    'Файли цього типу не можна перекласти. Спробуйте файл PDF, Word, Markdown або текстовий файл.',
  'translate.file.err.scanned':
    'Схоже, цей PDF-файл — скан без придатного для читання тексту. Спершу розпізнайте в ньому ' +
    'текст на екрані «Документи» кнопкою «Розпізнати текст (OCR)», а потім перекладіть його.',
  'translate.file.err.scannedAction': 'Відкрити Документи',
  'translate.file.err.importFailed': 'Не вдалося прочитати документ. Спробуйте ще раз.',
  'translate.file.err.runtimeFailed': 'Не вдалося перекласти документ. Спробуйте ще раз.',
  // ---- Evidence review (EP-1 plan §7 — ReviewScreen.tsx + chat entry points) ----
  'review.action.start': 'Перевірити обґрунтування',
  'review.action.continue': 'Продовжити перевірку',
  'review.entry.sources': 'Перевірити відповідь і джерела',
  'review.status.draft': 'Чернетка',
  'review.status.ready': 'Завершена',
  'review.status.outdated': 'Застаріла',
  'review.readonlyHint': 'Перевірку завершено — щоб редагувати, знову відкрийте перевірку.',
  // ---- P4: Outdated banner + acknowledge (spec §15.5/§21.3/§28.6) ----
  'review.outdated.title': 'Ця перевірка застаріла.',
  'review.outdated.answerChanged':
    'Текст відповіді більше не збігається з версією, зафіксованою для перевірки.',
  'review.outdated.coverageChanged':
    'Збережені метадані охоплення більше не збігаються з версією, зафіксованою для перевірки.',
  'review.outdated.sourcesChanged.one':
    '{count} документ-джерело змінився, відколи розпочато цю перевірку.',
  'review.outdated.sourcesChanged.few':
    '{count} документи-джерела змінилися, відколи розпочато цю перевірку.',
  'review.outdated.sourcesChanged.many':
    '{count} документів-джерел змінилися, відколи розпочато цю перевірку.',
  'review.outdated.sourcesChanged.other':
    '{count} документа-джерела змінилися, відколи розпочато цю перевірку.',
  'review.outdated.keepNote':
    'Ваші збережені рішення не змінилися. Можна залишити цю перевірку як історичний запис, взяти ' +
    'зміну до відома або запитати ще раз у чаті й розпочати нову перевірку.',
  'review.outdated.acknowledge': 'Взяти зміну до відома',
  'review.outdated.acknowledgedAt': 'Зміну взято до відома {date}.',
  'review.outdated.exportHint':
    'Перш ніж експортувати пакет обґрунтування, візьміть зміну до відома.',
  'review.back': 'Назад до чату',
  'review.rename': 'Перейменувати',
  'review.rename.label': 'Назва перевірки',
  'review.rename.save': 'Зберегти',
  'review.loading': 'Відкриття перевірки…',
  'review.notFound': 'Цю перевірку не знайдено. Можливо, її видалено.',
  'review.question.toggle': 'Запитання',
  'review.answerPane.aria': 'Відповідь, що перевіряється',
  'review.autosave.saving': 'Збереження…',
  'review.autosave.saved': 'Збережено',
  'review.autosave.error': 'Деякі зміни поки що не вдалося зберегти.',
  'review.autosave.retry': 'Спробувати ще раз',
  'review.evidence.title': 'Обґрунтування',
  'review.evidence.captionRelevance':
    'Показані джерела — це уривки, які було передано локальній ШІ-моделі для цієї відповіді.',
  'review.evidence.captionWholeDoc':
    'Цю відповідь отримано з аналізу всього документа. Показані розділи — це походження з ' +
    'аналізу всього документа, без посилань на джерела для окремих речень.',
  'review.evidence.captionStructured':
    'Для цієї відповіді використано локально витягнуті дані. Нижче показано фрагменти джерел, з ' +
    'яких їх витягнуто.',
  'review.evidence.none':
    'Для цієї відповіді немає збережених уривків із джерел. Можна зафіксувати загальну ' +
    'перевірку, але перевірка на рівні джерел недоступна.',
  'review.disclaimer':
    'Посилання на джерело показує, звідки взято інформацію. Саме лише посилання не доводить, що ' +
    'відповідь правильна.',
  'review.evidence.filterLabel': 'Фільтр джерел',
  'review.evidence.filterPlaceholder': 'Фільтр за назвою або текстом…',
  'review.evidence.filterClear': 'Очистити фільтр',
  'review.evidence.filterNone': 'Немає джерел, що відповідають фільтру.',
  'review.evidence.shownCount': 'Показано джерел: {shown} з {total}',
  'review.evidence.more.one': 'і ще {count} джерело',
  'review.evidence.more.few': 'і ще {count} джерела',
  'review.evidence.more.many': 'і ще {count} джерел',
  'review.evidence.more.other': 'і ще {count} джерела',
  'review.evidence.linkingItem': 'Ви повʼязуєте обґрунтування з пунктом перевірки {n}',
  'review.source.kind.direct_excerpt': 'Прямий уривок',
  'review.source.kind.whole_document_provenance': 'Походження з аналізу всього документа',
  'review.source.kind.structured_record': 'Витягнутий запис',
  'review.source.unresolved': 'Не вдалося ідентифікувати джерело',
  'review.source.archive':
    'Стаття з пакету знань — її ідентичність і вміст не можна звірити з робочим простором',
  'review.source.missingAtCreation': 'Джерело було недоступне, коли розпочато цю перевірку',
  'review.source.changed': 'Документ-джерело змінився, відколи розпочато цю перевірку',
  'review.source.missingNow':
    'Цього джерела вже немає в робочому просторі. Збережений уривок залишається в цій перевірці.',
  'review.source.cannotVerify': 'Поточний стан цього джерела не можна перевірити',
  'review.sourceContext.open': 'Відкрити джерело в контексті',
  'review.sourceContext.title': 'Джерело в контексті',
  'review.sourceContext.loading': 'Відкриття збереженого тексту…',
  'review.sourceContext.failed': 'Не вдалося відкрити збережений текст цього джерела.',
  'review.sourceContext.hashMatch':
    'Збережений хеш документа збігається з версією, зафіксованою для перевірки.',
  'review.sourceContext.hashMismatch': 'Документ-джерело змінився, відколи розпочато цю перевірку.',
  'review.sourceContext.hashUnknown':
    'Поточний стан документа не можна звірити з версією, зафіксованою для перевірки.',
  'review.sourceContext.missing':
    'Це джерело було доступне, коли згенеровано відповідь, але його вже немає в робочому ' +
    'просторі. Збережений уривок, якщо він є, залишається в цій перевірці.',
  'review.sourceContext.notLocated':
    'Збережений уривок не вдалося знайти в поточному збереженому тексті. Нижче його показано в ' +
    'тому вигляді, у якому його зафіксовано, коли розпочато перевірку.',
  'review.sourceContext.storedNote':
    'Контекст береться зі збереженого тексту, видобутого під час імпорту, — сам оригінальний ' +
    'файл не відкривається.',
  'review.sourceContext.excerptHeading': 'Збережений уривок',
  'review.link.add': 'Повʼязати з пунктом перевірки',
  'review.link.remove': 'Прибрати звʼязок',
  'review.link.cited': 'Посилання у відповіді',
  'review.link.reviewer': 'Повʼязано під час перевірки',
  'review.link.selectHint':
    'Виберіть пункт перевірки, щоб повʼязати з ним обґрунтування або прибрати звʼязок.',
  'review.relation.label': 'Характер звʼязку',
  'review.relation.none': 'Без позначки',
  'review.relation.supports': 'Обґрунтовує',
  'review.relation.qualifies': 'Обмежує',
  'review.relation.contradicts': 'Суперечить',
  'review.relation.context': 'Лише контекст',
  'review.item.aria': 'Пункт перевірки {n}',
  'review.item.noMarker': 'У цьому тексті немає прямого посилання на джерело',
  'review.item.wholeDocDerived': 'Отримано з аналізу всього документа',
  'review.item.noteLabel': 'Нотатка',
  'review.item.notePlaceholder': 'Додайте нотатку (необовʼязково)',
  'review.item.viewEvidence': 'Переглянути обґрунтування',
  // ---- P5 reviewer text selections (spec §12.1 "Review separately"; plan §10) ----
  'review.selection.start': 'Перевірити фрагмент окремо',
  'review.selection.hint':
    'Виділіть фрагмент в оригінальному тексті нижче (показано без форматування), а потім ' +
    'натисніть кнопку «Перевірити окремо».',
  'review.selection.surfaceAria': 'Оригінальний текст пункту перевірки {n}',
  'review.selection.add': 'Перевірити окремо',
  'review.selection.close': 'Готово',
  'review.selection.added': 'Фрагмент додано як окремий пункт перевірки.',
  'review.selection.refused':
    'Не вдалося додати це виділення. Виділіть фрагмент знову й спробуйте ще раз.',
  'review.item.selectionTag': 'Текст, виділений під час перевірки',
  'review.selection.remove': 'Прибрати виділення',
  'review.decision.groupAria': 'Рішення',
  'review.decision.supported': 'Перевірено — обґрунтовано',
  'review.decision.partly_supported': 'Перевірено — частково обґрунтовано',
  'review.decision.not_supported': 'Перевірено — не обґрунтовано',
  'review.decision.follow_up': 'Потребує уточнення',
  'review.decision.not_reviewed': 'Не перевірено',
  'review.decision.not_applicable': 'Не стосується',
  'review.bulk.menu': 'Групові дії',
  'review.bulk.headingsNa': 'Позначити заголовки як «Не стосується»',
  'review.bulk.followUp': 'Позначити пункти без рішення як «Потребує уточнення»',
  'review.bulk.clear': 'Скинути всі рішення',
  'review.bulk.clearConfirmTitle': 'Скинути всі рішення?',
  'review.bulk.clearConfirmBody':
    'Для всіх пунктів цієї перевірки буде встановлено рішення «Не перевірено». Нотатки ' +
    'збережуться.',
  'review.bulk.clearConfirm': 'Скинути рішення',
  'review.progress': 'Вирішено: {decided} з {required}',
  'review.progress.followUps.one': '{count} пункт потребує уточнення',
  'review.progress.followUps.few': '{count} пункти потребують уточнення',
  'review.progress.followUps.many': '{count} пунктів потребують уточнення',
  'review.progress.followUps.other': '{count} пункту потребують уточнення',
  'review.footer.summary': 'Підсумок перевірки',
  'review.summary.status': 'Стан',
  'review.summary.decisions': 'Рішення',
  'review.summary.sources': 'Джерела',
  'review.summary.sourcesCount.one': '{count} джерело',
  'review.summary.sourcesCount.few': '{count} джерела',
  'review.summary.sourcesCount.many': '{count} джерел',
  'review.summary.sourcesCount.other': '{count} джерела',
  'review.summary.sourcesUnresolved.one': 'Не вдалося ідентифікувати {count} джерело',
  'review.summary.sourcesUnresolved.few': 'Не вдалося ідентифікувати {count} джерела',
  'review.summary.sourcesUnresolved.many': 'Не вдалося ідентифікувати {count} джерел',
  'review.summary.sourcesUnresolved.other': 'Не вдалося ідентифікувати {count} джерела',
  'review.summary.sourcesArchive.one':
    '{count} джерело з пакетів знань не можна звірити з робочим простором',
  'review.summary.sourcesArchive.few':
    '{count} джерела з пакетів знань не можна звірити з робочим простором',
  'review.summary.sourcesArchive.many':
    '{count} джерел із пакетів знань не можна звірити з робочим простором',
  'review.summary.sourcesArchive.other':
    '{count} джерела з пакетів знань не можна звірити з робочим простором',
  'review.summary.sourcesMissing.one':
    '{count} джерело було недоступне, коли розпочато цю перевірку',
  'review.summary.sourcesMissing.few':
    '{count} джерела були недоступні, коли розпочато цю перевірку',
  'review.summary.sourcesMissing.many':
    '{count} джерел були недоступні, коли розпочато цю перевірку',
  'review.summary.sourcesMissing.other':
    '{count} джерела були недоступні, коли розпочато цю перевірку',
  'review.summary.sourcesChangedNow.one':
    '{count} документ-джерело змінився, відколи розпочато цю перевірку',
  'review.summary.sourcesChangedNow.few':
    '{count} документи-джерела змінилися, відколи розпочато цю перевірку',
  'review.summary.sourcesChangedNow.many':
    '{count} документів-джерел змінилися, відколи розпочато цю перевірку',
  'review.summary.sourcesChangedNow.other':
    '{count} документа-джерела змінилися, відколи розпочато цю перевірку',
  'review.summary.sourcesMissingNow.one':
    '{count} документ-джерело вже відсутній у робочому просторі',
  'review.summary.sourcesMissingNow.few':
    '{count} документи-джерела вже відсутні в робочому просторі',
  'review.summary.sourcesMissingNow.many':
    '{count} документів-джерел уже відсутні в робочому просторі',
  'review.summary.sourcesMissingNow.other':
    '{count} документа-джерела вже відсутні в робочому просторі',
  'review.summary.truncated':
    'Згенерована відповідь може бути неповною — її обірвано, коли модель досягла ліміту довжини ' +
    'відповіді.',
  'review.summary.stopped.model':
    'Згенерована відповідь неповна — ШІ-модель було зупинено або замінено до завершення ' +
    'відповіді.',
  'review.summary.stopped.user': 'Згенерована відповідь неповна — її зупинено до завершення.',
  'review.summary.stopped.lock':
    'Згенерована відповідь неповна — робочий простір було заблоковано або застосунок закрито до ' +
    'завершення відповіді.',
  'review.summary.generation': 'Подробиці генерації',
  'review.summary.model': 'Модель',
  'review.summary.generatedAt': 'Згенеровано',
  'review.summary.appVersion': 'Версія застосунку',
  'review.summary.skill': 'Навичка',
  'review.summary.unavailable': 'Недоступно',
  'review.summary.reviewerLabel': 'Особа, яка перевіряє',
  'review.summary.reviewerPlaceholder': 'Ваше імʼя або позначка (необовʼязково)',
  'review.summary.generalNote': 'Загальна нотатка',
  'review.summary.generalNotePlaceholder': 'Загальні спостереження (необовʼязково)',
  'review.summary.exports': 'Історія експорту',
  'review.summary.markReady': 'Завершити перевірку',
  'review.summary.reopen': 'Знову відкрити перевірку',
  'review.summary.gateHint':
    'Щоб завершити перевірку, для кожного блоку відповіді потрібне рішення (вирішено: {decided} ' +
    'з {required}). Рішення «Не стосується» теж зараховується.',
  'review.toast.ready': 'Перевірку завершено.',
  'review.completedAt': 'Завершено {date}',
  'review.deleteWithConversation.one':
    'Також буде видалено {count} перевірку обґрунтування, повʼязану з цією розмовою.',
  'review.deleteWithConversation.few':
    'Також буде видалено {count} перевірки обґрунтування, повʼязані з цією розмовою.',
  'review.deleteWithConversation.many':
    'Також буде видалено {count} перевірок обґрунтування, повʼязаних із цією розмовою.',
  'review.deleteWithConversation.other':
    'Також буде видалено {count} перевірки обґрунтування, повʼязаної з цією розмовою.',
  'review.deleteWithConversation.unknown':
    'Також буде видалено всі перевірки обґрунтування, повʼязані з цією розмовою.',
  // ---- Evidence-pack export (EP-1 plan §8 — summary panel + status line) ----
  'review.status.lastExported': 'Останній експорт: {date}',
  'review.export.action': 'Створити пакет обґрунтування',
  'review.export.title': 'Експортувати пакет обґрунтування',
  'review.export.encryptionWarning':
    'Цей експортований файл зберігається поза зашифрованим робочим простором HilbertRaum, і ' +
    'пароль вашого робочого простору його не захищає.',
  'review.export.packLanguage.en': 'Цей пакет буде складено англійською мовою.',
  'review.export.packLanguage.de': 'Цей пакет буде складено німецькою мовою.',
  'review.export.options': 'Додати до пакету',
  'review.export.optNotes': 'Нотатки перевірки',
  'review.export.optExcerpts': 'Уривки з джерел',
  'review.export.optHashes': 'Хеші документів',
  'review.export.optUnreviewed': 'Неперевірені пункти',
  'review.export.optTechnical': 'Технічні подробиці',
  'review.export.format': 'Формат файлу',
  'review.export.formatHtml': 'HTML — автономна вебсторінка',
  'review.export.formatPdf': 'PDF — версія для друку (A4)',
  'review.export.confirm': 'Експортувати пакет…',
  'review.export.cancel': 'Закрити',
  'review.export.done': 'Пакет обґрунтування експортовано.',
  'review.export.error': 'Не вдалося експортувати пакет обґрунтування. Жодного файлу не записано.',
  'review.export.copyHash': 'Скопіювати SHA-256',
  'review.export.hashCopied': 'SHA-256 скопійовано в буфер обміну.'
}
