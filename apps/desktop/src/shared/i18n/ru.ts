import type { UiCatalog } from './languages'

// The RUSSIAN catalog. Style (design-guidelines §7 "Russian microcopy"): formal «вы», lower case
// mid-sentence; buttons in the infinitive; the app never speaks in the first-person past tense;
// placeholders never carry grammar (put a generic noun in front). No letter ё. Quotes «…» (inner „…“),
// em dash with spaces, ellipsis …. Unit symbols stay Latin (GB, MB, KB, tok/s, s). Every plural base
// has one / few / many / other, each showing {count}.
//
// Glossary — keep terms consistent across ALL Russian copy:
//   workspace                  → рабочее пространство
//   drive                      → диск
//   vault / encrypted workspace→ зашифрованное рабочее пространство
//   model                      → модель (AI model → ИИ-модель)
//   document                   → документ
//   re-index                   → переиндексировать
//   offline                    → офлайн
//   "Ask my documents"         → «Спросить по моим документам»
//   lock / unlock              → заблокировать / разблокировать (rail: «Блокировка»)
//   password                   → пароль
//   settings                   → настройки
//   plaintext (developer) mode → без шифрования (режим разработчика)
//   screens                    → Главная, Чат, Документы, Перевод, Картинки, ИИ-модель, Скорость, Настройки
//
// Evidence-review glossary (MIRROR of the canonical record in design-guidelines §7):
//   evidence                   → подтверждение (the noun «доказательство» is banned)
//   supported                  → подтверждено; "does not prove" → «не доказывает» (disclaimers only)
//   review / evidence review   → проверка / проверка подтверждений
//   review item                → пункт проверки
//   evidence pack              → пакет подтверждений
//   citation / source marker   → ссылка на источник (never «цитата» / «сноска»)
//   whole-document provenance  → происхождение из анализа документа целиком; negation always
//                                «без ссылок на отдельные предложения»
//   direct excerpt             → прямая выдержка
//   source (document)          → источник / исходный документ
//   reviewer                   → проверяющий (never a gendered verb form)
//   mark ready / reopen        → завершить проверку / вернуть проверку в работу
//   outdated                   → устарела
//   review creation            → создание проверки (the ANSWER is «сформирован» — never mixed)
//
// Typed `UiCatalog<'ru'>` (i18n record D-L10): a missing, misspelt or extra key is a
// `npm run typecheck` failure. `packExport.*` is not part of it: evidence packs stay English
// or German (D-L11).

export const ru: UiCatalog<'ru'> = {
  // ---- App shell (App.tsx) ----
  'nav.aria': 'Основная навигация',
  'nav.home': 'Главная',
  'nav.chat': 'Чат',
  'nav.documents': 'Документы',
  'nav.translate': 'Перевод',
  'nav.images': 'Картинки',
  'nav.models': 'ИИ-модель',
  'nav.performance': 'Скорость',
  'nav.settings': 'Настройки',
  'app.lockNow': 'Блокировка',
  'app.lockNowTitle': 'Снова зашифровать и заблокировать рабочее пространство',
  'app.noticeDetails': 'Подробности',
  'app.noticeGoToModels': 'Открыть «ИИ-модель»',
  'app.fatal.title': 'Не удалось запустить приложение',
  'app.fatal.hintBefore':
    'Локальная серверная часть приложения не запустилась, поэтому загрузить ничего не получится. ' +
    'Перезапустите приложение; если это повторяется, проверьте файл ',
  'app.fatal.hintAfter': ' на вашем диске и загляните в «docs/troubleshooting.md».',
  'app.loadingWorkspace': 'Загрузка рабочего пространства…',
  'app.loadingScreen': 'Загрузка…',
  // ---- Error boundary (ErrorBoundary.tsx — audit FE-1) ----
  'errorBoundary.title': 'На этом экране что-то пошло не так',
  'errorBoundary.body':
    'На этом экране возникла непредвиденная проблема. Ваша работа и ваши данные в безопасности — ' +
    'ничего не потеряно. Попробуйте еще раз или вернитесь на экран «Главная».',
  'errorBoundary.retry': 'Повторить',
  'errorBoundary.home': 'Открыть экран «Главная»',
  'errorBoundary.app.title': 'В приложении возникла проблема',
  'errorBoundary.app.body':
    'Произошло что-то непредвиденное. Ваши данные на диске в безопасности. Чтобы продолжить, ' +
    'нажмите «Перезагрузить».',
  'errorBoundary.app.reload': 'Перезагрузить',
  // ---- Home (HomeScreen.tsx) ----
  'home.headline.ready': 'Все готово для чата.',
  'home.headline.starting': 'Подготовка…',
  'home.headline.almost': 'Настройка почти завершена.',
  'home.lead':
    'Личное рабочее пространство с ИИ, которое работает офлайн. Ваши запросы, документы и ' +
    'история чатов остаются на этом устройстве.',
  'home.preflight.continue':
    'Вы можете продолжить. Если приложение не откроется, руководство по устранению неполадок ' +
    'лежит в папке {folder} на диске.',
  'home.moved.restored':
    'В последний раз этот диск использовался на другом компьютере. Значения для этого компьютера ' +
    'взяты из более ранней проверки от {when} — сейчас ничего не измерялось.',
  'home.moved.restoredUndated':
    'В последний раз этот диск использовался на другом компьютере. Значения для этого компьютера ' +
    'взяты из более ранней проверки — сейчас ничего не измерялось.',
  'home.moved.measuring':
    'Этот диск еще не использовался на этом компьютере. В фоновом режиме идет проверка скорости; ' +
    'когда она завершится, значения появятся на экране «Скорость».',
  'home.moved.owed':
    'На этом компьютере проверка скорости с этим диском еще не проводилась, поэтому значений ' +
    'пока нет.',
  'home.checking': 'Проверка…',
  'home.workspace.label': 'Рабочее пространство',
  'home.workspace.encrypted': 'Зашифровано — после закрытия приложения заблокировано вашим паролем',
  'home.workspace.plaintext': 'Без шифрования (режим разработчика)',
  'home.workspace.badgeProtected': 'Защищено',
  'home.workspace.badgeDeveloper': 'Разработчик',
  'home.model.label': 'ИИ-модель',
  'home.model.fallbackName': 'без названия',
  'home.model.running': 'Модель {model} работает на этом устройстве',
  'home.model.selected': 'Выбрана модель {model} — возможно, она еще загружается',
  'home.model.none': 'Модель еще не выбрана',
  'home.model.badgeRunning': 'Работает',
  'home.model.badgeStarting': 'Запускается',
  'home.model.badgeNeedsModel': 'Нужна модель',
  'home.model.open': 'Открыть «ИИ-модель»',
  'home.model.engineCannotRun':
    'ИИ-движок не может работать на этом компьютере — ответы имитируются',
  'home.model.badgeEngine': 'Не запускается',
  'home.model.demo': 'Модель {model} работает в демо-режиме — ответы имитируются',
  'home.model.badgeDemo': 'Демо-режим',
  'home.model.choose': 'Выбрать модель',
  'home.docs.label': 'Документы',
  'home.docs.none': 'Документов пока нет — добавьте их, чтобы задавать по ним вопросы',
  'home.docsReady.one': '{count} документ готов к вопросам',
  'home.docsReady.few': '{count} документа готовы к вопросам',
  'home.docsReady.many': '{count} документов готовы к вопросам',
  'home.docsReady.other': '{count} документа готовы к вопросам',
  'home.docs.badgeReady': 'Готово',
  'home.docs.badgeNone': 'Пока нет',
  'home.docs.add': 'Добавить документы',
  'home.packs.label': 'Пакеты знаний',
  'home.packsReady.one': '{count} пакет знаний готов к вопросам',
  'home.packsReady.few': '{count} пакета знаний готовы к вопросам',
  'home.packsReady.many': '{count} пакетов знаний готовы к вопросам',
  'home.packsReady.other': '{count} пакета знаний готовы к вопросам',
  'home.packs.none':
    'Пакетов знаний пока нет — добавьте офлайн-версию Википедии, чтобы задавать общие вопросы',
  'home.packs.noneReady':
    'Ни один пакет знаний не готов к вопросам — проверьте их на экране «Документы»',
  'home.packs.badgeNoneReady': 'Нет готовых',
  'home.packs.add': 'Добавить пакеты',
  'home.packs.open': 'Открыть пакеты знаний',
  'home.actions.startChat': 'Начать чат',
  'home.actions.askDocs': 'Спросить по моим документам',
  // ---- Chat (ChatScreen.tsx) ----
  'chat.title': 'Чат',
  'chat.noModel.title': 'Ни одна модель не запущена',
  'chat.noModel.startingTitle': 'ИИ-модель запускается',
  'chat.noModel.hintBefore':
    'Для чата и вопросов по документам нужна загруженная модель. Откройте экран «ИИ-модель», ' +
    'выберите скачанную модель и нажмите ',
  'chat.noModel.hintAction': 'Использовать эту модель',
  'chat.noModel.hintAfter':
    '. Все остается локально — ничего не скачивается и не отправляется в интернет.',
  'chat.noModel.stillLoading':
    'Если вы только что открыли приложение, выбранная модель, возможно, еще загружается — как ' +
    'только она будет готова, чат откроется автоматически.',
  'chat.noModel.starting':
    'Модель запускается — большим моделям нужно немного времени на загрузку. Как только она ' +
    'будет готова, чат откроется автоматически.',
  'chat.noModel.startingProgress':
    'Модель запускается — идет чтение файла модели ({gb} GB), прочитано около {pct}%. Как только ' +
    'она будет готова, чат откроется автоматически.',
  'chat.noModel.open': 'Открыть «ИИ-модель»',
  'chat.noModel.recheck': 'Проверить снова',
  'chat.empty.title': 'Задайте вопрос — общий или по вашим документам.',
  'chat.empty.lineDocuments': 'Ответы основаны на ваших документах и содержат ссылки на источники.',
  'chat.empty.lineChat': 'Ответы пишет модель на этом диске — ничто не покидает это устройство.',
  'chat.empty.fillTitle': 'Вставить в поле сообщения',
  'chat.empty.addDocs': 'Добавить документы для вопросов',
  'chat.exampleChat.explain': 'Объясните понятие простыми словами',
  'chat.exampleChat.draftEmail': 'Помогите написать вежливое письмо',
  'chat.exampleChat.brainstorm': 'Предложите идеи для проекта',
  'chat.example.summarize': 'Кратко изложите этот документ',
  'chat.example.paymentTerms': 'Каковы условия оплаты?',
  'chat.example.indemnity': 'Найдите все упоминания «возмещения убытков»',
  'chat.modeAria': 'Режим чата',
  'chat.mode.chat': 'Чат',
  'chat.mode.documents': 'Спросить по моим документам',
  'chat.listShow': 'Показать список чатов',
  'chat.runtime.gpu': '{model} · видеокарта ({name})',
  'chat.runtime.cpu': '{model} · процессор',
  'chat.runtime.cpuCompat': '{model} · процессор (режим совместимости)',
  'chat.runtime.demo': '{model} · демо-режим',
  'chat.runtime.title':
    'ИИ-модель, которая отвечает в этом чате, и где она работает: на видеокарте (GPU) или на ' +
    'процессоре (CPU). Подробности: Настройки → Диагностика.',
  'chat.runtime.compatTitle':
    'Для стабильности включен режим совместимости, поэтому ответы формируются на процессоре и ' +
    'могут приходить медленнее. Снова попробовать видеокарту можно здесь: Настройки → ' +
    'Диагностика.',
  'chat.convOptions': 'Действия с чатом',
  'chat.saveConversation': 'Сохранить этот чат',
  'chat.savedTo': 'Сохранено в файл {path}',
  'chat.copied': 'Скопировано',
  'chat.copyFailed': 'Не удалось скопировать в буфер обмена',
  'chat.transcript.label': 'Сообщения чата',
  'chat.stopped': 'Остановлено — ответ может быть неполным',
  'chat.warmup.hint':
    'Первый ответ занимает чуть больше времени — модель готовится к работе. Следующие ответы ' +
    'будут быстрее.',
  'chat.scopeNotice': 'Ответ только по документам: {titles}',
  'chat.cancelDocTask': 'Отменить задачу по документу',
  'chat.placeholder.documents': 'Задайте вопрос по вашим документам…',
  'chat.placeholder.chat': 'Сообщение…',
  'chat.send.ask': 'Спросить',
  'chat.send.send': 'Отправить',
  'chat.composer.stop': 'Остановить',
  // ---- Chat: conversation list (ConversationList.tsx) ----
  'chat.list.title': 'Чаты',
  'chat.list.aria': 'История чатов',
  'chat.list.newChat': '+ Новый чат',
  'chat.list.newDocQa': '+ Новый чат по документам',
  'chat.list.hide': 'Скрыть список чатов',
  'chat.list.empty': 'Чатов пока нет.',
  'chat.list.docMeta': 'Документы',
  'chat.list.otherGroup': 'Прочие / Библиотека',
  'chat.list.rowOptionsAria': 'Действия с чатом «{title}»',
  'chat.search.placeholder': 'Поиск по чатам…',
  'chat.search.aria': 'Поиск по чатам',
  'chat.search.resultsAria': 'Результаты поиска',
  'chat.search.resultsFor': 'Результаты по запросу «{query}»',
  'chat.search.noMatches': 'Совпадений не найдено. Попробуйте сформулировать иначе.',
  'chat.search.count.one': '{count} результат',
  'chat.search.count.few': '{count} результата',
  'chat.search.count.many': '{count} результатов',
  'chat.search.count.other': '{count} результата',
  'chat.group.today': 'Сегодня',
  'chat.group.yesterday': 'Вчера',
  'chat.group.last7days': 'Последние 7 дней',
  'chat.group.earlier': 'Ранее',
  'chat.delete.menuItem': 'Удалить чат',
  'chat.delete.title': 'Удалить этот чат?',
  'chat.delete.confirm': 'Удалить',
  'chat.delete.body': 'Чат «{title}» и его сообщения будут безвозвратно удалены с этого диска.',
  // ---- Chat: answer depth (DepthMenu.tsx; ids stay fast|balanced|deep) ----
  'chat.depth.trigger': 'Ответ: {label}',
  'chat.depth.fast': 'Быстрый',
  'chat.depth.balanced': 'Обычный',
  'chat.depth.deep': 'Тщательный',
  'chat.depth.fastHint': 'Короткие ответы по существу',
  'chat.depth.balancedHint': 'Стандартный вариант на каждый день',
  'chat.depth.deepHint': 'Модель продумывает задачу перед ответом — это занимает больше времени',
  // ---- Chat: skill picker + per-message glyph (skills plan §10/§15) ----
  'chat.skill.trigger': 'Навык: {label}',
  'chat.skill.none': 'Без навыка',
  'chat.skill.suggested': 'Предлагается: {title} — использовать?',
  'chat.skill.suggestedHint': 'Предлагается: {title}',
  'chat.skill.used': 'Навык: {title}',
  'chat.skill.usedTitle': 'При подготовке этого ответа использован навык «{title}».',
  'chat.skill.autoFired': 'Ответ с навыком «{title}»',
  'chat.skill.autoFiredTitle':
    'Приложение автоматически применило к этому ответу навык «{title}». Можно получить ответ и ' +
    'без этого навыка.',
  'chat.skill.answerWithout': 'Ответить без навыка',
  'chat.skill.answerWithoutBlockedByReview':
    'Для этого ответа есть проверка подтверждений. Новый ответ удалит эту проверку вместе с ' +
    'решениями и примечаниями.',
  'chat.skill.removed': '(навык удален)',
  'chat.skill.offer.lead': 'Похоже, здесь поможет навык.',
  'chat.skill.offer.run': 'Запустить навык «{title}» для этого вопроса',
  'chat.skill.offer.model': 'Предложено локальной моделью',
  'chat.skill.offer.unavailable':
    'Этот навык выключен или удален — чтобы запустить навык, включите его на экране «Настройки» ' +
    'на вкладке «Навыки».',
  'chat.skill.clear': 'Убрать навык «{title}»',
  'chat.skill.keep': 'Сохранить для этого чата',
  'chat.skill.infoButton': 'О навыке «{title}»',
  'chat.skill.info.close': 'Скрыть пояснение',
  'chat.skill.info.needsLabel': 'Требуется:',
  'chat.skill.info.limitsLabel': 'Учтите:',
  'chat.skill.info.perTurn':
    'Действует для ваших вопросов в этом чате, пока вы не смените или не уберете навык. Флажок ' +
    '«Сохранить для этого чата» также запоминает его на будущее.',
  'chat.skill.info.learnMore': 'Подробнее',
  'chat.skill.tool.extractTransactions': 'Извлечь транзакции',
  'chat.skill.tool.validateBalances': 'Проверить остатки',
  'chat.skill.tool.categorize': 'Распределить по категориям',
  'chat.skill.tool.summarize': 'Сводка движения средств',
  'chat.skill.tool.exportCsv': 'Экспорт в CSV',
  'chat.skill.tool.extractInvoice': 'Прочитать счет на оплату',
  'chat.skill.tool.validateInvoiceTotals': 'Проверить итоговые суммы',
  'chat.skill.tool.exportInvoiceCsv': 'Экспорт в CSV',
  'chat.skill.tool.exportInvoiceJson': 'Экспорт в JSON',
  'chat.skill.tool.exportInvoiceXml': 'Экспорт в XML',
  'chat.skill.tool.redactDocument': 'Скрыть персональные данные',
  'chat.skill.tool.applyDocumentEdits': 'Внести правки в текст',
  'chat.skill.categorize.breakdownQuestion': 'Распределите мои расходы по категориям.',
  'chat.skill.summarize.question': 'Подведите итоги по моим доходам и расходам.',
  'chat.skill.run.running.one': 'Выполняется: {tool} — {count} документ…',
  'chat.skill.run.running.few': 'Выполняется: {tool} — {count} документа…',
  'chat.skill.run.running.many': 'Выполняется: {tool} — {count} документов…',
  'chat.skill.run.running.other': 'Выполняется: {tool} — {count} документа…',
  'chat.skill.run.runningOn': 'Выполняется: {tool} — {document}…',
  'chat.skill.run.chooseDocument': 'Выбрать целевой документ',
  'chat.skill.run.thisDocument': 'этот документ',
  'chat.skill.run.cancel': 'Отмена',
  'chat.skill.run.done.one': 'Извлечена {count} транзакция.',
  'chat.skill.run.done.few': 'Извлечено {count} транзакции.',
  'chat.skill.run.done.many': 'Извлечено {count} транзакций.',
  'chat.skill.run.done.other': 'Извлечено {count} транзакции.',
  'chat.skill.run.done.categorize.one': 'По категориям распределена {count} транзакция.',
  'chat.skill.run.done.categorize.few': 'По категориям распределено {count} транзакции.',
  'chat.skill.run.done.categorize.many': 'По категориям распределено {count} транзакций.',
  'chat.skill.run.done.categorize.other': 'По категориям распределено {count} транзакции.',
  'chat.skill.run.done.summarize.one': 'В сводку вошла {count} транзакция.',
  'chat.skill.run.done.summarize.few': 'В сводку вошло {count} транзакции.',
  'chat.skill.run.done.summarize.many': 'В сводку вошло {count} транзакций.',
  'chat.skill.run.done.summarize.other': 'В сводку вошло {count} транзакции.',
  'chat.skill.run.done.export.one': 'Сохранена {count} строка.',
  'chat.skill.run.done.export.few': 'Сохранено {count} строки.',
  'chat.skill.run.done.export.many': 'Сохранено {count} строк.',
  'chat.skill.run.done.export.other': 'Сохранено {count} строки.',
  'chat.skill.run.done.reconciled': 'Остатки сходятся.',
  'chat.skill.run.done.unreconciled.one':
    '{count} строка не сходится — проверьте перед использованием.',
  'chat.skill.run.done.unreconciled.few':
    '{count} строки не сходятся — проверьте перед использованием.',
  'chat.skill.run.done.unreconciled.many':
    '{count} строк не сходятся — проверьте перед использованием.',
  'chat.skill.run.done.unreconciled.other':
    '{count} строки не сходятся — проверьте перед использованием.',
  'chat.skill.run.done.unchecked': 'В выписке не указан текущий остаток для сверки.',
  'chat.skill.run.done.extractInvoice.one': 'Извлечена {count} позиция.',
  'chat.skill.run.done.extractInvoice.few': 'Извлечено {count} позиции.',
  'chat.skill.run.done.extractInvoice.many': 'Извлечено {count} позиций.',
  'chat.skill.run.done.extractInvoice.other': 'Извлечено {count} позиции.',
  'chat.skill.run.done.invoiceReconciled': 'Итоговые суммы счета сходятся.',
  'chat.skill.run.done.invoiceUnreconciled.one':
    '{count} итог не сходится — проверьте перед использованием.',
  'chat.skill.run.done.invoiceUnreconciled.few':
    '{count} итога не сходятся — проверьте перед использованием.',
  'chat.skill.run.done.invoiceUnreconciled.many':
    '{count} итогов не сходятся — проверьте перед использованием.',
  'chat.skill.run.done.invoiceUnreconciled.other':
    '{count} итога не сходятся — проверьте перед использованием.',
  'chat.skill.run.done.invoiceUnchecked': 'В счете не указаны итоговые суммы для сверки.',
  'chat.skill.run.done.redacted.one':
    'Сохранена копия со скрытыми данными — скрыт {count} фрагмент. Без гарантии полноты — ' +
    'проверьте копию перед отправкой.',
  'chat.skill.run.done.redacted.few':
    'Сохранена копия со скрытыми данными — скрыто {count} фрагмента. Без гарантии полноты — ' +
    'проверьте копию перед отправкой.',
  'chat.skill.run.done.redacted.many':
    'Сохранена копия со скрытыми данными — скрыто {count} фрагментов. Без гарантии полноты — ' +
    'проверьте копию перед отправкой.',
  'chat.skill.run.done.redacted.other':
    'Сохранена копия со скрытыми данными — скрыто {count} фрагмента. Без гарантии полноты — ' +
    'проверьте копию перед отправкой.',
  'chat.skill.run.done.redactedClean':
    'Персональные данные не обнаружены; копия сохранена. Без гарантии полноты — проверьте копию ' +
    'перед отправкой.',
  'chat.skill.run.done.redactedFloor.one':
    'Сохранена копия со скрытыми данными — скрыт {count} фрагмент (только офлайн-обнаружение по ' +
    'правилам, модель не запущена). Проверьте копию перед отправкой.',
  'chat.skill.run.done.redactedFloor.few':
    'Сохранена копия со скрытыми данными — скрыто {count} фрагмента (только офлайн-обнаружение ' +
    'по правилам, модель не запущена). Проверьте копию перед отправкой.',
  'chat.skill.run.done.redactedFloor.many':
    'Сохранена копия со скрытыми данными — скрыто {count} фрагментов (только офлайн-обнаружение ' +
    'по правилам, модель не запущена). Проверьте копию перед отправкой.',
  'chat.skill.run.done.redactedFloor.other':
    'Сохранена копия со скрытыми данными — скрыто {count} фрагмента (только офлайн-обнаружение ' +
    'по правилам, модель не запущена). Проверьте копию перед отправкой.',
  'chat.skill.run.done.redactedCleanFloor':
    'Персональные данные не обнаружены (только офлайн-обнаружение по правилам, модель не ' +
    'запущена); копия сохранена. Проверьте копию перед отправкой.',
  'chat.skill.run.done.redactedCapped.one':
    'Сохранена копия со скрытыми данными — скрыт {count} фрагмент. Документ очень большой, ' +
    'поэтому автоматическое обнаружение остановилось на своем пределе и дальнейшие фрагменты ' +
    'могут остаться нескрытыми — проверьте всю копию перед отправкой.',
  'chat.skill.run.done.redactedCapped.few':
    'Сохранена копия со скрытыми данными — скрыто {count} фрагмента. Документ очень большой, ' +
    'поэтому автоматическое обнаружение остановилось на своем пределе и дальнейшие фрагменты ' +
    'могут остаться нескрытыми — проверьте всю копию перед отправкой.',
  'chat.skill.run.done.redactedCapped.many':
    'Сохранена копия со скрытыми данными — скрыто {count} фрагментов. Документ очень большой, ' +
    'поэтому автоматическое обнаружение остановилось на своем пределе и дальнейшие фрагменты ' +
    'могут остаться нескрытыми — проверьте всю копию перед отправкой.',
  'chat.skill.run.done.redactedCapped.other':
    'Сохранена копия со скрытыми данными — скрыто {count} фрагмента. Документ очень большой, ' +
    'поэтому автоматическое обнаружение остановилось на своем пределе и дальнейшие фрагменты ' +
    'могут остаться нескрытыми — проверьте всю копию перед отправкой.',
  'chat.skill.run.done.edited.one':
    'Внесена {count} правка, отредактированная копия сохранена. Проверьте копию перед отправкой.',
  'chat.skill.run.done.edited.few':
    'Внесено {count} правки, отредактированная копия сохранена. Проверьте копию перед отправкой.',
  'chat.skill.run.done.edited.many':
    'Внесено {count} правок, отредактированная копия сохранена. Проверьте копию перед отправкой.',
  'chat.skill.run.done.edited.other':
    'Внесено {count} правки, отредактированная копия сохранена. Проверьте копию перед отправкой.',
  'chat.skill.run.done.editedPartial.one':
    'Внесена {count} правка; часть запрошенного текста не найдена и пропущена. Отредактированная ' +
    'копия сохранена — проверьте ее перед отправкой.',
  'chat.skill.run.done.editedPartial.few':
    'Внесено {count} правки; часть запрошенного текста не найдена и пропущена. Отредактированная ' +
    'копия сохранена — проверьте ее перед отправкой.',
  'chat.skill.run.done.editedPartial.many':
    'Внесено {count} правок; часть запрошенного текста не найдена и пропущена. Отредактированная ' +
    'копия сохранена — проверьте ее перед отправкой.',
  'chat.skill.run.done.editedPartial.other':
    'Внесено {count} правки; часть запрошенного текста не найдена и пропущена. Отредактированная ' +
    'копия сохранена — проверьте ее перед отправкой.',
  'chat.skill.run.done.editedNone':
    'Запрошенный текст не найден — ничего не изменено, копия не сохранена.',
  'chat.skill.run.done.editedCapped.one':
    'Внесена {count} правка. Документ очень большой, поэтому поиск мест для правки остановился ' +
    'на своем пределе — проверьте копию: дальнейшие места могут остаться без изменений.',
  'chat.skill.run.done.editedCapped.few':
    'Внесено {count} правки. Документ очень большой, поэтому поиск мест для правки остановился ' +
    'на своем пределе — проверьте копию: дальнейшие места могут остаться без изменений.',
  'chat.skill.run.done.editedCapped.many':
    'Внесено {count} правок. Документ очень большой, поэтому поиск мест для правки остановился ' +
    'на своем пределе — проверьте копию: дальнейшие места могут остаться без изменений.',
  'chat.skill.run.done.editedCapped.other':
    'Внесено {count} правки. Документ очень большой, поэтому поиск мест для правки остановился ' +
    'на своем пределе — проверьте копию: дальнейшие места могут остаться без изменений.',
  'chat.skill.run.failedGeneric': 'Это не сработало. Ничего не изменено.',
  'chat.skill.run.error.unavailable': 'Этот инструмент недоступен.',
  'chat.skill.run.error.needsExtraction':
    'Сначала прочитайте документ кнопкой «{button}», затем запустите этот инструмент.',
  'chat.skill.run.error.persistFailed': 'Не удалось сохранить результат. Ничего не изменено.',
  'chat.skill.run.error.exportWriteFailed': 'Не удалось сохранить файл. Ничего не изменено.',
  'chat.skill.run.error.needsModel':
    'Сначала запустите модель — для точечных правок нужна запущенная модель, которая найдет ' +
    'текст для изменения.',
  'chat.skill.run.error.needsInstruction':
    'Сначала напишите, что изменить (например, «замените X на Y»), затем запустите снова.',
  'chat.skill.run.error.editFailed': 'Не удалось внести правки. Ничего не изменено.',
  'chat.skill.run.error.redactionModelStopped':
    'ИИ-модель остановилась до завершения скрытия данных. Ничего не сохранено. Запустите скрытие ' +
    'еще раз — если это повторяется, перезапустите модель на экране «ИИ-модель».',
  'chat.skill.run.error.redactionTooLong':
    'Некоторые части этого документа не помещаются в контекст текущей модели. Ничего не ' +
    'сохранено. Выберите больший размер контекста на экране «ИИ-модель», перезапустите модель и ' +
    'запустите скрытие еще раз.',
  'chat.skill.run.cancelled': 'Остановлено. Ничего не сохранено.',
  'chat.skill.run.stateUnknown':
    'Не удалось проверить состояние навыка — результат может быть неполным.',
  'chat.skill.run.otherChatBusy': 'Навык работает в другом чате.',
  'chat.skill.run.categorizeOffer': 'Распределить транзакции по категориям',
  'chat.skill.run.dismiss': 'Скрыть',
  'chat.skill.confirm.title': 'Запустить этот инструмент?',
  'chat.skill.confirm.body': 'Будет создан или экспортирован файл из документов на этом диске.',
  'chat.skill.confirm.target': 'Документ: {document}',
  'chat.skill.confirm.outputDocx':
    'Сохраненная копия останется в формате Word (.docx), как исходный документ.',
  'chat.skill.confirm.redactionScope':
    'Скрытие охватывает текст документа (включая верхние и нижние колонтитулы, сноски, ' +
    'примечания и записанные исправления), а также удаляет сведения об авторе и адреса ссылок. ' +
    'Изображения, отсканированные страницы и внедренные объекты не проверяются — проверьте ' +
    'сохраненную копию перед отправкой.',
  'chat.skill.confirm.outputText':
    'Сохраненная копия будет обычным текстом (.txt) — исходные макет и форматирование не ' +
    'сохранятся.',
  'chat.skill.confirm.outputMatrix':
    'Документы Word (.docx) сохраняют свой формат; PDF и другие форматы сохраняются как копия в ' +
    'виде обычного текста (.txt).',
  'chat.skill.confirm.ok': 'Запустить',
  // ---- Chat: transcript + message actions ----
  'chat.role.user': 'Вы',
  'chat.role.assistant': 'HilbertRaum',
  'chat.thinking': 'Обдумывание…',
  'chat.actions.tryAgain': 'Повторить',
  'chat.actions.sendAgain': 'Отправить снова',
  'chat.actions.copy': 'Копировать',
  'chat.actions.save': 'Сохранить',
  'chat.actions.saveTitle': 'Сохранить этот чат в файл (остается локально)',
  'chat.actions.exportCsv': 'Экспорт в CSV',
  'chat.actions.exportCsvTitle': 'Сохранить таблицу из этого ответа в CSV-файл (остается локально)',
  'chat.code.copy': 'Копировать',
  'chat.code.copyTitle': 'Копировать этот блок кода в буфер обмена',
  'chat.code.save': 'Сохранить',
  'chat.code.saveTitle': 'Сохранить этот блок кода в файл .{ext} (остается локально)',
  // ---- Chat: context compaction (context-compaction plan §5.1–§5.3) ----
  'chat.compaction.inProgress': 'Краткое изложение предыдущих сообщений, чтобы освободить память…',
  'chat.analysis.inProgress': 'Чтение всего документа…',
  'chat.compaction.markerLabel': 'Предыдущие сообщения кратко изложены',
  'chat.compaction.viewSummary': 'Показать краткое содержание предыдущих сообщений',
  'chat.context.label': 'Память',
  'chat.context.usageTooltip':
    'Память этого чата: заполнена на {pct}% (около {used} из {window} токенов).',
  'chat.context.willSummarize':
    'Когда она заполнится, старые сообщения будут автоматически кратко изложены, чтобы ' +
    'освободить место.',
  'chat.truncated.label': 'Ответ обрезан',
  'chat.endedEarly.label': 'Ответ остановлен',
  'chat.endedEarly.hint.model':
    'ИИ-модель была остановлена или заменена до завершения этого ответа.',
  'chat.endedEarly.hint.user': 'Вы остановили этот ответ до его завершения.',
  'chat.endedEarly.hint.lock':
    'Рабочее пространство было заблокировано или приложение закрыто до завершения этого ответа.',
  'chat.unanswered.model': 'Без ответа — ИИ-модель была остановлена.',
  'chat.unanswered.user': 'Без ответа — вы нажали «Остановить».',
  'chat.unanswered.lock':
    'Без ответа — рабочее пространство было заблокировано или приложение закрыто.',
  'chat.truncated.hint.context':
    'Модели не хватило места, чтобы закончить этот ответ. Попросите ее продолжить, начните новый ' +
    'чат или увеличьте размер контекста на экране «ИИ-модель».',
  'chat.truncated.hint.cap':
    'Этот ответ по документам достиг предельной длины, которую приложение допускает для одного ' +
    'ответа. Попросите модель продолжить с того места, где она остановилась.',
  'chat.speed.line': '{tps} tok/s · {ttft} s до первого токена · токенов: {tokens}',
  'chat.speed.hint':
    'Насколько быстро сформирован этот ответ: скорость генерации ИИ-движка, ожидание до первого ' +
    'слова и число созданных токенов. Показывается только для ответов этого сеанса.',
  // ---- Chat: document scope (ScopePopover.tsx) ----
  'chat.scope.none': 'Документов пока нет · Добавить документы',
  'chat.scope.stopAsking': 'Не спрашивать: {title}',
  'chat.scope.askToo': 'Спросить также: {title}',
  'chat.scope.removedDoc': 'Удаленный документ',
  // ---- Chat: sources (SourcesDisclosure.tsx) ----
  'chat.sources.toggle': 'Источники ({count})',
  'chat.sources.marker': 'И{n}',
  'chat.sources.page': 'Страница {page}',
  'chat.sources.wholeDoc.one': 'Взято из документа — {count} раздел',
  'chat.sources.wholeDoc.few': 'Взято из документа — {count} раздела',
  'chat.sources.wholeDoc.many': 'Взято из документа — {count} разделов',
  'chat.sources.wholeDoc.other': 'Взято из документа — {count} раздела',
  'chat.sources.wholeDocCaption': 'Охваченные разделы',
  'chat.sources.more.one': 'и еще {count} раздел',
  'chat.sources.more.few': 'и еще {count} раздела',
  'chat.sources.more.many': 'и еще {count} разделов',
  'chat.sources.more.other': 'и еще {count} раздела',
  // ---- Chat: dictation (DictationButton.tsx) ----
  'chat.dictation.start': 'Продиктовать сообщение',
  'chat.dictation.unavailable': 'Голосовой ввод не установлен на этом диске',
  'chat.dictation.unavailableSystem': 'Голосовой ввод недоступен в этой операционной системе',
  'chat.dictation.needsModel':
    'Для диктовки сообщений нужна модель распознавания речи, а на этом диске ее нет. Добавить ее ' +
    'можно на экране «ИИ-модель».',
  'chat.dictation.needsEngine':
    'Для диктовки сообщений нужен голосовой движок, а на этом диске его нет. Установить его ' +
    'можно на экране «ИИ-модель».',
  'chat.dictation.needsModelAndEngine':
    'Для диктовки сообщений нужны модель распознавания речи и голосовой движок, а на этом диске ' +
    'их пока нет. Добавить и то, и другое можно на экране «ИИ-модель».',
  'chat.dictation.engineUnsupported':
    'Голосовой ввод пока недоступен в этой операционной системе: приложение не может установить ' +
    'здесь нужный для него голосовой движок.',
  'chat.dictation.getModel': 'Добавить модель распознавания речи',
  'chat.dictation.getEngine': 'Установить голосовой движок',
  'chat.dictation.setUp': 'Настроить голосовой ввод',
  'chat.dictation.stop': 'Остановить диктовку и вставить текст',
  'chat.dictation.transcribing': 'Речь преобразуется в текст',
  'chat.dictation.noSpeech': 'Речь не распознана — попробуйте сказать еще раз.',
  'chat.dictation.silent':
    'Звук с микрофона не поступил. Убедитесь, что звук микрофона не выключен и что в системных ' +
    'настройках приложению HilbertRaum разрешено его использовать, затем попробуйте еще раз.',
  'chat.dictation.noSignal':
    'Звук с микрофона не поступает — убедитесь, что звук микрофона не выключен и выбрано ' +
    'правильное устройство ввода.',
  'chat.dictation.micBlocked':
    'Не удалось использовать микрофон. Проверьте системные настройки микрофона, затем попробуйте ' +
    'еще раз.',
  // ---- Documents (DocumentsScreen.tsx) ----
  'docs.title': 'Документы',
  'docs.lead':
    'Импортируйте документы, чтобы задавать по ним вопросы. Каждый файл копируется в ваше ' +
    'рабочее пространство и готовится для поиска — все остается на этом диске. Задавать вопросы ' +
    'можно на экране «Чат» в режиме «Спросить по моим документам».',
  'docs.status.queued': 'В очереди',
  'docs.status.extracting': 'Чтение',
  'docs.status.preparing': 'Подготовка',
  'docs.status.indexed': 'Готов',
  'docs.status.failed': 'Ошибка',
  'docs.status.deleted': 'Удален',
  'docs.status.transcribing': 'Распознавание речи…',
  'docs.task.summaryBusy': 'Краткое изложение…',
  'docs.task.translationBusy': 'Перевод…',
  'docs.task.compareBusy': 'Сравнение…',
  'docs.task.ocrBusy': 'Чтение скана…',
  'docs.task.treeBusy': 'Создание глубокого индекса…',
  'docs.task.extractBusy': 'Сбор сведений…',
  'docs.task.summaryBusyTitle': 'Составляется краткое содержание',
  'docs.task.translationBusyTitle': 'Составляется перевод',
  'docs.task.compareBusyTitle': 'Составляется сравнение',
  'docs.task.ocrBusyTitle': 'Читаются отсканированные страницы',
  'docs.task.treeBusyTitle': 'Для всего документа создается глубокий индекс',
  'docs.task.extractBusyTitle':
    'Весь документ просматривается, чтобы по нему можно было отвечать на просьбы вида ' +
    '«перечислить все…»',
  'docs.task.categorizeBusy': 'Распределение по категориям…',
  'docs.task.categorizeBusyTitle': 'Транзакции выписки распределяются по категориям',
  'docs.task.ocrFinishing': 'Завершение — подготовка текста для поиска…',
  'docs.task.stopping': 'Остановка, если возможно…',
  'docs.error.noSupported': 'Среди выбранного не найдено поддерживаемых документов.',
  'docs.removedDocFallback': '(документ удален)',
  'docs.provenance.compareBefore': 'Сравнение документов: ',
  'docs.provenance.compareMiddle': ' и ',
  'docs.provenance.translatedBefore': 'Перевод документа: ',
  'docs.provenance.summaryBefore': 'Краткое содержание документа: ',
  'docs.provenance.generatedBefore': 'Создано на основе документа: ',
  'docs.provenance.articleBefore': 'Сохранено из пакета знаний: ',
  'docs.provenance.articleUnknownArchive': '(название неизвестно)',
  'docs.import.busy': 'Импорт…',
  'docs.import.files': 'Импортировать файлы',
  'docs.import.folder': 'Импортировать папку',
  'docs.import.walkCut.one':
    'Папка слишком большая для полного просмотра — подсчитан {count} элемент.',
  'docs.import.walkCut.few':
    'Папка слишком большая для полного просмотра — подсчитано {count} элемента.',
  'docs.import.walkCut.many':
    'Папка слишком большая для полного просмотра — подсчитано {count} элементов.',
  'docs.import.walkCut.other':
    'Папка слишком большая для полного просмотра — подсчитано {count} элемента.',
  'docs.refresh': 'Обновить',
  'docs.loading': 'Загрузка документов…',
  'docs.askSelected': 'Спросить по этим документам ({count})',
  'docs.askSelectedTitle': 'Открыть чат с вопросами только по выбранным документам',
  'docs.compareBtn': 'Сравнить (2)',
  'docs.compareBtnTitle':
    'Составить сравнение двух выбранных документов с помощью локальной модели — ничто не ' +
    'покидает этот диск',
  'docs.reindexAll': 'Переиндексировать все ({count})',
  'docs.reindexAllTitle':
    'Переиндексировать все документы, проиндексированные другой моделью поиска',
  'docs.reindexAllConfirm.title.one': 'Переиндексировать {count} документ?',
  'docs.reindexAllConfirm.title.few': 'Переиндексировать {count} документа?',
  'docs.reindexAllConfirm.title.many': 'Переиндексировать {count} документов?',
  'docs.reindexAllConfirm.title.other': 'Переиндексировать {count} документа?',
  'docs.reindexAllConfirm.body':
    'Каждый документ, подготовленный другой моделью поиска, будет по очереди прочитан и ' +
    'проиндексирован заново. Это может занять несколько минут и сильно нагружает процессор — вы ' +
    'можете продолжать работу, но до завершения ответы могут приходить медленнее.',
  'docs.reindexAllConfirm.confirm': 'Переиндексировать все',
  'docs.retryAllFailed': 'Повторить все ({count})',
  'docs.retryAllFailedTitle':
    'Переиндексировать все документы, которые не удалось проиндексировать',
  'docs.retryAllConfirm.title.one': 'Обработать заново {count} документ с ошибкой?',
  'docs.retryAllConfirm.title.few': 'Обработать заново {count} документа с ошибкой?',
  'docs.retryAllConfirm.title.many': 'Обработать заново {count} документов с ошибкой?',
  'docs.retryAllConfirm.title.other': 'Обработать заново {count} документа с ошибкой?',
  'docs.retryAllConfirm.body':
    'Каждый документ с ошибкой будет по очереди заново прочитан и заново подготовлен для поиска. ' +
    'Это может занять несколько минут и сильно нагружает процессор — вы можете продолжать ' +
    'работу, но до завершения ответы могут приходить медленнее. Документы, которые снова не ' +
    'удастся обработать, останутся в этом списке.',
  'docs.retryAllConfirm.confirm': 'Повторить все',
  'docs.reindexAllProgress': 'Переиндексация: {done} из {total}…',
  'docs.reindexAllCancel': 'Отмена',
  'docs.reindexAllCancelled': 'Переиндексация остановлена — готово {done} из {total}.',
  'docs.reindexAllDone.one': 'Переиндексирован {count} документ.',
  'docs.reindexAllDone.few': 'Переиндексировано {count} документа.',
  'docs.reindexAllDone.many': 'Переиндексировано {count} документов.',
  'docs.reindexAllDone.other': 'Переиндексировано {count} документа.',
  'docs.reindexAllPartial':
    'Переиндексировано {done} из {total} — с ошибкой: {failed}. Документы с ошибкой остаются в ' +
    'списке документов.',
  'docs.supported.base':
    'Поддерживаются: TXT, Markdown, PDF, DOCX, CSV — а также аудиозаписи (WAV, MP3, FLAC, OGG), ' +
    'которые преобразуются в текст на этом диске',
  'docs.supported.ocrExtra':
    ', и фотографии страниц (PNG, JPG), текст с которых распознается на этом диске',
  'docs.preparing': 'Ваши документы подготавливаются, чтобы по ним можно было задавать вопросы…',
  'docs.empty.title': 'Документов пока нет',
  'docs.empty.line':
    'Импортируйте файлы, чтобы задавать по ним вопросы, — все остается на этом диске.',
  'docs.selectAria': 'Выбрать для вопросов: {title}',
  'docs.selectTitle': 'Выбрать, чтобы задавать вопросы только по выбранным документам',
  'docs.selectAllAria': 'Выбрать все документы',
  'docs.selectAllTitle': 'Выбрать все видимые документы или снять выделение',
  'docs.meta.sectionsCount.one': '{count} раздел',
  'docs.meta.sectionsCount.few': '{count} раздела',
  'docs.meta.sectionsCount.many': '{count} разделов',
  'docs.meta.sectionsCount.other': '{count} раздела',
  'docs.meta.summary': 'Краткое содержание',
  'docs.scan.ocrOffer':
    'Используйте «Сделать доступным для поиска (OCR)» в этой строке, чтобы распознать текст ' +
    'страниц на этом диске.',
  'docs.scan.ocrMissing':
    'Чтобы сделать документ доступным для поиска, нужны файлы OCR, а на этом диске их нет. ' +
    'Скачайте их ниже — или, если вы настраивали диск сами, добавьте их командой «fetch-runtime ' +
    '--family ocr».',
  'docs.scan.ocrMissingOffline':
    'Чтобы сделать документ доступным для поиска, нужны файлы OCR, а на этом диске их нет. Чтобы ' +
    'добавить их, повторите настройку диска, указав «--with-assets», или скачайте только файлы ' +
    'OCR командой «fetch-runtime --family ocr».',
  'docs.photo.ocrMissing':
    'Скачайте файлы OCR ниже, затем нажмите «Повторить», чтобы распознать текст на этой ' +
    'фотографии.',
  'docs.photo.ocrMissingOffline':
    'Добавьте файлы OCR через настройку диска («fetch-runtime --family ocr»), затем нажмите ' +
    '«Повторить», чтобы распознать текст на этой фотографии.',
  'docs.photo.ocrReady':
    'Распознавание текста теперь доступно — нажмите «Повторить», чтобы распознать текст на этой ' +
    'фотографии.',
  'docs.scan.ocrUnavailable':
    'Чтобы сделать документ доступным для поиска, нужно распознавание текста (OCR), но в этой ' +
    'сборке его не удалось запустить.',
  'docs.ocr.unavailableBanner':
    'Распознавание текста (OCR) недоступно в этой сборке: файлы OCR есть на этом диске, но ' +
    'запустить распознавание не удалось. Пока это не исправлено, фотографии сохраняются без ' +
    'читаемого текста, а отсканированные PDF-файлы нельзя сделать доступными для поиска.',
  'docs.stale.banner':
    'Этот документ подготовлен другой моделью поиска — переиндексируйте его, чтобы ответы могли ' +
    'его находить.',
  'docs.preview': 'Просмотр',
  'docs.previewBusy': 'Открытие…',
  'docs.previewTitle':
    'Прочитать извлеченный текст (только просмотр; ничто не покидает приложение)',
  'docs.cancel': 'Отмена',
  'docs.cancelOcrTitle': 'Остановить чтение скана',
  'docs.cancelTaskTitle': 'Остановить задачу',
  'docs.task.stateUnknown':
    'Не удалось проверить состояние этой задачи — возможно, она еще выполняется.',
  'docs.task.dismiss': 'Скрыть',
  'docs.makeSearchable': 'Сделать доступным для поиска (OCR)',
  'docs.makeSearchableTitle':
    'Прочитать отсканированные страницы с помощью локального распознавания текста — ничто не ' +
    'покидает этот диск',
  'docs.makeSearchableAgain': 'Прочитать заново (OCR)',
  'docs.makeSearchableAgainPhotoTitle':
    'Прочитать фотографию заново с помощью локального распознавания текста',
  'docs.makeSearchableAgainTitle':
    'Заново запустить локальное распознавание текста и заменить сохраненный результат — ' +
    '«Переиндексировать» использует прежний',
  'docs.summarize': 'Кратко изложить',
  'docs.summarizeAgain': 'Кратко изложить заново',
  'docs.translate': 'Перевести',
  'docs.translateNoModel': 'Добавить модель перевода…',
  'docs.translateNoModelTitle':
    'Для перевода нужна модель перевода — скачайте ее на экране «ИИ-модель»',
  'docs.export': 'Экспортировать',
  'docs.exportOriginal': 'Экспортировать исходный файл',
  'docs.exportOriginal.gone':
    'Сохраненной копии этого файла нет на этом диске, поэтому экспортировать ее нельзя. ' +
    'Извлеченный текст по-прежнему можно экспортировать.',
  'docs.exportOriginalConfirm.title': 'Экспортировать исходный файл?',
  'docs.exportOriginal.warning':
    'Этот экспортированный файл хранится за пределами зашифрованного рабочего пространства ' +
    'HilbertRaum и не защищен паролем вашего рабочего пространства.',
  'docs.reindex': 'Переиндексировать',
  'docs.reindexBusy': 'Переиндексация…',
  'docs.reindexTitle': 'Заново прочитать и подготовить сохраненную копию',
  'docs.reindexDone': 'Документ «{title}» переиндексирован.',
  'docs.delete': 'Удалить',
  'docs.deleteBusy': 'Удаление…',
  'docs.deleteDone': 'Документ «{title}» удален.',
  'docs.failed.remove': 'Убрать',
  'docs.failed.removeTitle': 'Убрать этот документ с ошибкой импорта из списка',
  'docs.failed.retry': 'Повторить',
  'docs.backToChat': 'Назад в чат',
  'docs.failed.retryTitle': 'Заново прочитать и подготовить этот файл',
  'docs.moreActions': 'Другие действия: {title}',
  'docs.audioConfirm.title': 'Импортировать аудио большого размера?',
  'docs.audioConfirm.confirm': 'Импортировать и преобразовать в текст',
  'docs.audioConfirm.contains.one': 'Среди выбранных файлов есть {count} аудиозапись ({size}).',
  'docs.audioConfirm.contains.few': 'Среди выбранных файлов есть {count} аудиозаписи ({size}).',
  'docs.audioConfirm.contains.many': 'Среди выбранных файлов есть {count} аудиозаписей ({size}).',
  'docs.audioConfirm.contains.other': 'Среди выбранных файлов есть {count} аудиозаписи ({size}).',
  'docs.audioConfirm.body':
    'Каждая запись копируется в ваше рабочее пространство и преобразуется в текст на этом диске ' +
    '— длинная запись может обрабатываться долго. Тем временем можно продолжать работать в ' +
    'приложении.',
  'docs.deleteConfirm.title': 'Удалить документ «{title}»?',
  'docs.deleteConfirm.body':
    'Документ, его извлеченный текст и поисковый индекс будут безвозвратно удалены из вашего ' +
    'рабочего пространства. Исходный файл за пределами рабочего пространства не затрагивается.',
  'docs.translateModal.title': 'Перевести документ «{title}»',
  'docs.translateModal.aria': 'Перевести документ {title}',
  'docs.translateModal.hint':
    'Локальная модель создает переведенную копию в виде нового документа — по ней можно искать и ' +
    'задавать вопросы, как по любому импортированному документу, и ничто не покидает этот диск. ' +
    'В машинном переводе возможны ошибки.',
  'docs.translateModal.from': 'Исходный язык',
  'docs.translateModal.to': 'Язык перевода',
  'docs.translateModal.start': 'Перевести',
  'docs.translateModal.sameLang': 'Выберите два разных языка.',
  'docs.previewModal.aria': 'Просмотр: {title}',
  'docs.previewModal.hint':
    'Извлеченный текст только для чтения — на нем основаны поиск по документам и ответы.',
  'docs.previewModal.ocrInfo.one':
    'Текст распознан на этом диске (OCR) — {count} страница. В распознанном тексте возможны ' +
    'ошибки.',
  'docs.previewModal.ocrInfo.few':
    'Текст распознан на этом диске (OCR) — {count} страницы. В распознанном тексте возможны ' +
    'ошибки.',
  'docs.previewModal.ocrInfo.many':
    'Текст распознан на этом диске (OCR) — {count} страниц. В распознанном тексте возможны ' +
    'ошибки.',
  'docs.previewModal.ocrInfo.other':
    'Текст распознан на этом диске (OCR) — {count} страницы. В распознанном тексте возможны ' +
    'ошибки.',
  'docs.previewModal.ocrInfoPhoto':
    'Текст на этой фотографии распознан на этом диске (OCR). В распознанном тексте возможны ' +
    'ошибки.',
  'docs.previewModal.ocrInfoPartial':
    'Текст распознан на этом диске (OCR). Страниц с распознанным текстом: {count} из {total}. В ' +
    'распознанном тексте возможны ошибки.',
  'docs.previewModal.ocrInfoNone.one':
    'Распознавание текста (OCR) прочитало на этом диске {count} отсканированную страницу и не ' +
    'нашло текста.',
  'docs.previewModal.ocrInfoNone.few':
    'Распознавание текста (OCR) прочитало на этом диске {count} отсканированные страницы и не ' +
    'нашло текста.',
  'docs.previewModal.ocrInfoNone.many':
    'Распознавание текста (OCR) прочитало на этом диске {count} отсканированных страниц и не ' +
    'нашло текста.',
  'docs.previewModal.ocrInfoNone.other':
    'Распознавание текста (OCR) прочитало на этом диске {count} отсканированной страницы и не ' +
    'нашло текста.',
  'docs.ocr.unsure.page': 'Распознавание текста не уверено в этой странице.',
  'docs.ocr.unsure.onlyRecognized':
    'Распознавание текста не уверено в единственной распознанной странице.',
  'docs.ocr.unsure.photo': 'Распознавание текста не уверено в этой фотографии.',
  'docs.ocr.unsure.some':
    'Распознавание текста не уверено в части распознанных страниц: {count} из {total}.',
  'docs.ocr.unsure.all':
    'Распознавание текста не уверено ни в одной из распознанных страниц ({count}).',
  'docs.ocr.scannedPages':
    'Отсканированные страницы, где пока нет читаемого текста: {count} из {total}.',
  'docs.ocr.scannedPagesNeedsOcr': 'Чтобы их прочитать, нужны файлы OCR (экран «ИИ-модель»).',
  'docs.ocr.unsure.causes':
    'Размытый, перекошенный или рукописный оригинал распознается плохо, как и текст на языке, ' +
    'отличном от немецкого и английского.',
  'docs.previewModal.summary': 'Краткое содержание',
  'docs.previewModal.generatedBy': 'Создано моделью {model}',
  'docs.previewModal.truncated':
    'Документ длинный — краткое содержание охватывает его начало. Остальной текст по-прежнему ' +
    'доступен для поиска и вопросов в чате.',
  'docs.previewModal.regenerate': 'Создать заново',
  'docs.previewModal.copy': 'Копировать',
  'docs.previewModal.save': 'Сохранить',
  'docs.previewModal.copied': 'Краткое содержание скопировано',
  'docs.previewModal.copyFailed': 'Не удалось скопировать в буфер обмена',
  'docs.previewModal.savedTo': 'Краткое содержание сохранено в файл {path}',
  'docs.previewModal.noText': 'Из этого документа не удалось извлечь текст.',
  'docs.previewModal.documentText': 'Текст документа',
  'docs.previewModal.page': 'Страница {page}',
  'docs.previewModal.showMore': 'Показать еще',
  'docs.previewModal.loadingMore': 'Загрузка…',
  'docs.previewModal.segmentProgress': 'Показано: {shown} из {total}',
  // ---- Deep index + coverage (whole-document-analysis plan §5.2) ----
  'docs.deepIndex.build': 'Создать глубокий индекс',
  'docs.deepIndex.reindexFirst': 'Переиндексировать для глубокого индекса',
  'docs.deepIndex.ready': 'Глубокий индекс',
  'docs.deepIndex.readyTitle':
    'Глубокий индекс всего документа готов — краткое содержание и ответы со списками могут ' +
    'охватывать весь документ',
  'coverage.relevance': 'По наиболее подходящим фрагментам — не по всему документу',
  'coverage.relevance.counted': 'Использовано разделов: {covered} из {total}',
  'coverage.capped.whole': 'Охватывает весь документ',
  'coverage.capped.beginning': 'Охватывает начало документа',
  'coverage.tree.whole': 'Охватывает весь документ (глубокий индекс)',
  'coverage.tree.beginning':
    'Охватывает начало документа — он слишком велик, чтобы прочитать его целиком',
  'coverage.tree.partial': 'Создается глубокий индекс — готово разделов: {covered} из {total}',
  'coverage.tree.pending': 'Глубокого индекса пока нет',
  'coverage.depth': 'Детализация: {label}',
  'coverage.tier.1': 'Обзор',
  'coverage.tier.2': 'По разделам',
  'coverage.tier.3': 'Подробно (полный охват)',
  'coverage.tier.hint.1': 'Быстрее всего — сохраненный обзор',
  'coverage.tier.hint.2': 'Более подробный проход по разделам',
  'coverage.tier.hint.3': 'Больше всего подробностей — по всему документу',
  'coverage.tierSelect.trigger': 'Детализация: {label}',
  'coverage.extract.whole': 'Прочитан весь документ — просмотрено разделов: {scanned}',
  'coverage.extract.wholeUnparsed':
    'Прочитан весь документ — просмотрено разделов: {scanned}, не удалось прочитать: {unparsed}',
  'coverage.extract.sections': 'Просмотрено разделов: {scanned}',
  'coverage.extract.sectionsUnparsed':
    'Просмотрено разделов: {scanned}, не удалось прочитать: {unparsed}',
  // ---- "List every X" answer (whole-document-analysis plan §4.2, Phase 3) ----
  'analysis.kind.generic': 'записи',
  'analysis.kind.date': 'даты',
  'analysis.kind.amount': 'суммы',
  'analysis.kind.party': 'стороны',
  'analysis.kind.obligation': 'обязательства',
  'analysis.listing.coverageWhole':
    'Найдено по всему документу ({kind}): {count} — просмотрено разделов: {scanned}{unparsed}:',
  'analysis.listing.coverageSections':
    'Найдено ({kind}): {count} — просмотрено разделов: {scanned}{unparsed}:',
  'analysis.listing.empty':
    'Ничего не найдено ({kind}) — просмотрено разделов: {scanned}{unparsed}.',
  'analysis.listing.unparsedSuffix': ' (не удалось прочитать: {k})',
  'analysis.listing.item': '- {value} (×{count})',
  'analysis.listing.caveat':
    'Список составлен по всем просмотренным разделам, но его полнота не гарантирована (небольшая ' +
    'модель может пропустить запись, а очень похожие записи могут быть объединены).',
  'analysis.listing.refPage': 'страница {n}',
  'analysis.listing.refSection': 'раздел {n}',
  'analysis.listing.unparsedHint':
    '**Обратите внимание:** при индексации этого документа большую часть разделов не удалось ' +
    'прочитать, поэтому этот результат ненадежен. Откройте экран «Документы» и снова выберите ' +
    '«Создать глубокий индекс» — разделы, которые не удалось прочитать, будут обработаны ' +
    'повторно (поможет модель побольше).',
  'analysis.listing.unparsedHintAmountSkill':
    'Если это банковская выписка, навык «Анализ банковской выписки» в меню навыков чата точно ' +
    'прочитает суммы.',
  'analysis.listing.aggregationHint':
    '**Обратите внимание:** вы спросили о категориях или суммах, но этот ответ может только ' +
    'перечислить найденные в документе значения и указать, сколько раз встречается каждое. ' +
    'Группировать или складывать их он не умеет.',
  'analysis.listing.aggregationHintAmountSkill':
    'Если это банковская выписка, выберите в меню навыков чата навык «Анализ банковской выписки» ' +
    'и спросите еще раз — он распределит транзакции по категориям и точно подсчитает сумму по ' +
    'каждой.',
  'analysis.wholeDocHint':
    '**Обратите внимание:** этот ответ основан только на наиболее подходящих разделах, поэтому ' +
    'что-то могло быть упущено. Чтобы получить список по всем разделам, откройте экран ' +
    '«Документы», выберите для документа «Создать глубокий индекс» и спросите еще раз.',
  'analysis.partialAnswerHint':
    '**Обратите внимание:** этот ответ основан только на наиболее подходящих разделах, поэтому ' +
    'что-то могло быть упущено.',
  'analysis.wholeReadSumHint':
    '**Обратите внимание:** итоги модель подсчитывает сама и может что-то пропустить или ' +
    'ошибиться в расчетах. Сверяйте каждый итог с источниками.',
  // ---- Bank-statement analysis answer (full-doc-skills plan §3.1, Phase 2) ----
  'skills.bankAnalysis.count': 'Прочитано транзакций по всей выписке: **{count}**.',
  'skills.bankAnalysis.countPartial':
    'Прочитано транзакций: **{count}**. Строк с суммой, которую не удалось прочитать как ' +
    'транзакцию: **{dropped}**, поэтому здесь могут быть не все транзакции — сверьте эти строки ' +
    'с документом.',
  'skills.bankAnalysis.countContradicted':
    'Прочитано транзакций: **{count}**, но указанные в выписке остатки с ними не сходятся — ' +
    'поэтому нельзя подтвердить, что это все транзакции.',
  'skills.bankAnalysis.empty':
    'Документ просмотрен целиком, но извлечь из него транзакции не удалось. Возможно, строки ' +
    'находятся на отсканированном изображении или в необычном макете, который приложение не ' +
    'умеет разбирать. Если это скан, сначала выполните для него распознавание текста (OCR); в ' +
    'противном случае макет, возможно, не подходит для машинного чтения — откройте выписку и ' +
    'посмотрите суммы непосредственно в ней.',
  'skills.bankAnalysis.couldNotRead':
    'Не удалось прочитать эту выписку, поэтому проанализировать ее невозможно.',
  'skills.bankAnalysis.unreconciledHeading':
    'Сначала проверьте эти строки — указанный в них текущий остаток не сходится с суммами:',
  'skills.bankAnalysis.unreconciledItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.totals':
    'Поступления: **{inAmount} {currency}** · Списания: **{outAmount} {currency}** · Изменение ' +
    'остатка: **{netAmount} {currency}**.',
  'skills.bankAnalysis.noCurrency':
    'В этих транзакциях используется больше одной валюты, поэтому единой общей суммы нет — итог ' +
    'пришлось бы считать отдельно по каждой валюте.',
  'skills.bankAnalysis.incompleteNoTotal':
    'Не удалось подтвердить, что выписка прочитана полностью — указанные в ней остатки не ' +
    'сходятся с прочитанными транзакциями, поэтому суммы могли быть прочитаны с ошибками или не ' +
    'полностью. Чтобы не назвать итог, который может оказаться неверным, сумма здесь не ' +
    'приводится; откройте выписку и проверьте суммы самостоятельно.',
  'skills.bankAnalysis.categoryHeading': 'По категориям:',
  'skills.bankAnalysis.categoryItem': '- {category}: {amount} {currency} ({count})',
  'skills.bankAnalysis.categoryAssisted':
    '_Категории определены с помощью модели — какая-то из них может быть присвоена неверно, но ' +
    'итоговые суммы выше от этого не меняются._',
  'skills.bankAnalysis.categoryRuleBased':
    '_Это быстрая группировка по правилам (без модели). Для более подробной разбивки с помощью ' +
    'модели нажмите кнопку «Распределить по категориям»._',
  'skills.bankCategory.Groceries': 'Продукты',
  'skills.bankCategory.Dining': 'Кафе и рестораны',
  'skills.bankCategory.Transport': 'Транспорт',
  'skills.bankCategory.Utilities': 'Коммунальные услуги',
  'skills.bankCategory.Rent': 'Аренда',
  'skills.bankCategory.Insurance': 'Страхование',
  'skills.bankCategory.Subscriptions': 'Подписки',
  'skills.bankCategory.Health': 'Здоровье',
  'skills.bankCategory.Shopping': 'Покупки',
  'skills.bankCategory.Income': 'Доходы',
  'skills.bankCategory.Transfer': 'Переводы',
  'skills.bankCategory.Fees': 'Комиссии',
  'skills.bankCategory.Cash': 'Наличные',
  'skills.bankCategory.Tax': 'Налоги',
  'skills.bankCategory.Spending': 'Расходы',
  'skills.bankCategory.Uncategorized': 'Без категории',
  'skills.bankAnalysis.caveat':
    'Это суммы, указанные в самой выписке и прочитанные по всему документу, — ничего не ' +
    'подсчитано по свободному тексту и не придумано.',
  'skills.bankAnalysis.unverifiedCaveat':
    'Эти значения — сумма транзакций, прочитанных по всему документу (количество: **{count}**). ' +
    'В выписке не указан ни начальный, ни конечный остаток, поэтому нельзя подтвердить, что это ' +
    'все транзакции, — считайте эти значения суммой показанных строк, а не проверенным итогом по ' +
    'выписке. Ничего не подсчитано по свободному тексту и не придумано.',
  'skills.bankAnalysis.dateOrderCaveat':
    'Примечание о датах: по этой выписке не видно, идет ли в датах сначала день или сначала ' +
    'месяц, поэтому даты прочитаны в формате день.месяц.год — дата вида 03.05. может означать 3 ' +
    'мая или 5 марта. Каждую важную дату сверьте с документом.',
  'skills.bankAnalysis.transactionsHeading': 'Транзакции:',
  'skills.bankAnalysis.transactionItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.transactionsMore':
    '… и еще **{count}**. Чтобы увидеть все строки, сохраните всю выписку кнопкой **Экспорт в ' +
    'CSV** на панели выполнения навыка или просто попросите вывести ее в формате CSV или JSON ' +
    'прямо здесь, в чате.',
  'skills.bankAnalysis.figureEcho': 'Суммы, вычисленные по прочитанным транзакциям: {figures}.',
  'skills.bankAnalysis.figureEchoIn': 'поступления {amount} {currency}',
  'skills.bankAnalysis.figureEchoOut': 'списания {amount} {currency}',
  'skills.bankAnalysis.figureEchoNet': 'изменение остатка {amount} {currency}',
  'skills.bankAnalysis.formatIntro':
    'Вот выписка в формате {format}. Она составлена только из прочитанных сумм — ничего не ' +
    'подсчитано по свободному тексту и не придумано:',
  'skills.bankAnalysis.formatIntroCsv':
    'Вот выписка в формате CSV — только строки транзакций, составленные из прочитанных сумм ' +
    '(ничего не подсчитано по свободному тексту и не придумано). Сводки движения средств, ' +
    'начального и конечного остатков в CSV нет; чтобы получить и их, попросите выписку в формате ' +
    'JSON.',
  'skills.bankAnalysis.customCategoriesNeedModel':
    'Чтобы распределить транзакции по вашим собственным категориям ({categories}), нужна ' +
    'запущенная локальная модель — встроенные быстрые правила знают только свой фиксированный ' +
    'набор категорий. Запустите модель и спросите еще раз.',
  'skills.bankAnalysis.customTaxonomyNotFound':
    'Файл «{name}» не найден среди ваших документов. Сначала импортируйте его (Документы → ' +
    'Импортировать файлы), затем спросите еще раз.',
  'skills.bankAnalysis.customTaxonomyUnparseable':
    'Файл «{name}» прочитан, но использовать его как список категорий не удалось. Ожидается одна ' +
    'категория в строке — название, за которым при желании следуют ключевые слова после точки с ' +
    'запятой (например, «Дети;школа, детский сад, карманные деньги»).',
  'skills.bankAnalysis.derivedColumnsNote':
    '_Столбцы, заполненные локальной моделью по описанию каждой транзакции: {columns}. Там, где ' +
    'модель не была уверена, ячейки оставлены пустыми. Все суммы получены детерминированным ' +
    'разбором документа и не изменены._',
  // ---- Invoice analysis answer (full-doc-skills plan §3.1, Phase 4 / D49) ----
  'skills.invoiceAnalysis.count': 'Счет на оплату прочитан целиком — позиций: **{count}**.',
  'skills.invoiceAnalysis.countPartial':
    'Прочитано позиций: **{count}**. Строк с суммой, которую не удалось прочитать как позицию: ' +
    '**{dropped}**, поэтому здесь могут быть не все позиции — сверьте эти строки с документом.',
  'skills.invoiceAnalysis.empty':
    'Документ просмотрен целиком, но извлечь из него позиции или итоговые суммы не удалось. ' +
    'Возможно, суммы находятся на отсканированном изображении или в необычном макете, который ' +
    'приложение не умеет разбирать. Если это скан, сначала выполните для него распознавание ' +
    'текста (OCR); в противном случае макет, возможно, не подходит для машинного чтения — ' +
    'откройте счет на оплату и посмотрите суммы непосредственно в нем.',
  'skills.invoiceAnalysis.couldNotRead':
    'Не удалось прочитать этот счет на оплату, поэтому проанализировать его невозможно.',
  'skills.invoiceAnalysis.unreconciledHeading':
    'Сначала проверьте эти итоговые суммы — они не сходятся:',
  'skills.invoiceAnalysis.checkLineItemsSumToNet':
    'сумма позиций не совпадает с указанной суммой без налога',
  'skills.invoiceAnalysis.checkNetPlusTaxIsGross':
    'сумма без налога вместе с налогом не совпадает с указанным итогом с налогом',
  'skills.invoiceAnalysis.checkTaxMatchesRate':
    'сумма налога не соответствует указанной ставке налога',
  'skills.invoiceAnalysis.unreconciledItem': '- {check}',
  'skills.invoiceAnalysis.totalsHeading': 'Итоговые суммы в том виде, как они указаны в документе:',
  'skills.invoiceAnalysis.net': '- Сумма без налога: **{value}**',
  'skills.invoiceAnalysis.tax': '- Налог: **{value}**',
  'skills.invoiceAnalysis.taxWithRate': '- Налог ({rate}%): **{value}**',
  'skills.invoiceAnalysis.gross': '- Итого с налогом (к оплате): **{value}**',
  'skills.invoiceAnalysis.positionsHeading': 'Позиции:',
  'skills.invoiceAnalysis.positionItem': '- {description} · {amount} {currency}',
  'skills.invoiceAnalysis.positionsMore':
    '… и еще **{count}** — чтобы увидеть все позиции, попросите меня экспортировать счет на ' +
    'оплату в CSV.',
  'skills.invoiceAnalysis.formatIntro':
    'Вот счет на оплату в формате {format}. Он составлен только из прочитанных сумм — ничего не ' +
    'подсчитано по свободному тексту и не придумано:',
  'skills.invoiceAnalysis.formatIntroCsv':
    'Вот счет на оплату в формате CSV — только позиции, составленные из прочитанных сумм (ничего ' +
    'не подсчитано по свободному тексту и не придумано). Шапки (поставщик, номер счета, даты) и ' +
    'итоговых сумм в CSV нет; чтобы получить и их, попросите этот документ в формате JSON или ' +
    'XML.',
  'skills.invoiceAnalysis.noTotals':
    'В счете на оплату не удалось прочитать ни суммы без налога, ни суммы налога, ни итога с ' +
    'налогом.',
  'skills.invoiceAnalysis.caveat':
    'Это суммы, указанные в самом счете на оплату и прочитанные по всему документу, — ничего не ' +
    'подсчитано по свободному тексту и не придумано.',
  'skills.invoiceAnalysis.dateOrderCaveat':
    'Примечание о датах: по этому счету на оплату не видно, идет ли в датах сначала день или ' +
    'сначала месяц, поэтому даты прочитаны в формате день.месяц.год — дата вида 03.05. может ' +
    'означать 3 мая или 5 марта. Каждую важную дату сверьте с документом.',
  'skills.invoiceAnalysis.detailsHeading': 'Реквизиты в том виде, как они указаны в документе:',
  'skills.invoiceAnalysis.detailVendor': '- Поставщик: {vendor}',
  'skills.invoiceAnalysis.detailRecipient': '- Получатель счета (плательщик): {recipient}',
  'skills.invoiceAnalysis.detailInvoiceNumber': '- Номер счета: {number}',
  'skills.invoiceAnalysis.detailInvoiceDate': '- Дата счета: {date}',
  'skills.invoiceAnalysis.detailDueDate': '- Срок оплаты: {date}',
  'skills.invoiceAnalysis.figureEcho': 'Прочитанные суммы, дословно из документа: {figures}.',
  'skills.invoiceAnalysis.figureEchoNet': 'без налога {value}',
  'skills.invoiceAnalysis.figureEchoTax': 'налог {value}',
  'skills.invoiceAnalysis.figureEchoGross': 'итого с налогом {value}',
  'skills.invoiceAnalysis.totalsHeadingUnverified':
    'Суммы в том виде, как они указаны, — **они не сходятся**, поэтому считайте их ' +
    'непроверенными:',
  'skills.invoiceAnalysis.unreconciledCaveat':
    'Указанные суммы противоречат друг другу — обычно это значит, что текст документа извлечен с ' +
    'ошибками (скан, PDF из изображений или необычный макет). Не полагайтесь ни на одно из этих ' +
    'чисел, не сверив их с исходным документом.',
  'skills.invoiceAnalysis.figureEchoSuppressed':
    'Прочитанные итоговые суммы здесь не повторяются: они не сходятся ни между собой, ни с ' +
    'позициями, и приводить их как надежные значения значило бы ввести в заблуждение. Проверьте ' +
    'исходный документ.',
  'skills.invoiceAnalysis.unreadableLayout':
    'Текст этого документа извлекается с ошибками — символы перемешаны (по отдельным глифам); ' +
    'обычно так бывает с PDF из изображений или с необычной кодировкой. Надежно прочитать ' +
    'позиции или итоговые суммы не удалось, поэтому суммы не приводятся. Если это скан, сначала ' +
    'выполните для него распознавание текста (OCR); в противном случае откройте счет на оплату и ' +
    'посмотрите суммы непосредственно в нем.',
  'skills.invoiceAnalysis.textQualityCaveat':
    'Предупреждение: часть текста этого документа извлечена в перемешанном виде (по отдельным ' +
    'глифам). Суммы выше сходятся, но все важное сверьте с исходным документом.',
  'skills.analysis.refusePartial':
    'Точно ответить на этот вопрос можно только по всему документу, а этот документ еще не ' +
    'проиндексирован полностью. Откройте экран «Документы», выберите «Переиндексировать» и ' +
    'спросите еще раз.',
  'skills.analysis.scopeNarrowed':
    'Ответ основан только на документе **{title}** — других документов среди источников не ' +
    'прочитано: {count}. Чтобы проанализировать другой документ, выберите только его (или ' +
    'назовите его файл в вопросе) и спросите еще раз.',
  'skills.analysis.selectOne':
    'Для полного анализа нужен один документ — сейчас выбрано документов: {count}, поэтому видны ' +
    'лишь отдельные фрагменты из них. Выберите один документ (или назовите его файл в вопросе) и ' +
    'спросите еще раз.',
  'skills.analysis.selectTwo':
    'Для сравнения выберите ровно **два** документа (или две версии) — сейчас выбрано ' +
    'документов: {count}. Выберите те два, которые нужно сравнить, и спросите еще раз.',
  'skills.redactionRouting.answer':
    'Чтобы скрыть персональные данные в этом документе, нажмите кнопку **{button}** прямо над ' +
    'полем сообщения и выберите, куда сохранить копию. Инструмент работает полностью на этом ' +
    'устройстве, читает весь документ и скрывает четко оформленные персональные данные — адреса ' +
    'электронной почты, номера телефонов, IBAN, даты и ссылки. Это первый проход без гарантии ' +
    'полноты: имена и необычные форматы инструмент не обнаруживает, поэтому проверьте ' +
    'сохраненную копию перед отправкой.',
  'skills.redactionRouting.answerMulti':
    'Чтобы скрыть персональные данные в документе, нажмите кнопку **{button}** прямо над полем ' +
    'сообщения, выберите документ, а затем — куда сохранить копию. Инструмент обрабатывает по ' +
    'одному документу за раз, работает полностью на этом устройстве, читает весь документ и ' +
    'скрывает четко оформленные персональные данные — адреса электронной почты, номера ' +
    'телефонов, IBAN, номера платежных карт, даты и ссылки. Это первый проход без гарантии ' +
    'полноты: имена и необычные форматы инструмент не обнаруживает, поэтому проверьте ' +
    'сохраненную копию перед отправкой.',
  'skills.editRouting.answer':
    'Чтобы внести эти правки, нажмите кнопку **{button}** прямо над полем сообщения и выберите, ' +
    'куда сохранить отредактированную копию. Инструмент работает полностью на этом устройстве и ' +
    'вносит только запрошенные вами точные правки «найти и заменить» — везде, где текст найден ' +
    'дословно, а все остальное оставляет без изменений. Он никогда не переписывает документ, ' +
    'поэтому не может ничего придумать или перефразировать. На этом этапе сохраняется копия в ' +
    'виде обычного текста (.txt); проверьте ее перед отправкой.',
  'skills.editRouting.answerMulti':
    'Чтобы внести эти правки, нажмите кнопку **{button}** прямо над полем сообщения, выберите ' +
    'документ для правки, а затем — куда сохранить отредактированную копию. Инструмент ' +
    'обрабатывает по одному документу за раз, работает полностью на этом устройстве и вносит ' +
    'только запрошенные вами точные правки «найти и заменить» — везде, где текст найден ' +
    'дословно, а все остальное оставляет без изменений. Он никогда не переписывает документ. На ' +
    'этом этапе сохраняется копия в виде обычного текста (.txt); проверьте ее перед отправкой.',
  'skills.redactionRouting.scan':
    'Весь документ проверен на четко оформленные персональные данные. Обнаружено — адреса ' +
    'электронной почты: {email}, номера телефонов: {phone}, IBAN: {iban}, номера платежных карт: ' +
    '{card}, даты: {date}, ссылки: {url}. Это поиск по шаблонам без гарантии полноты: имена, ' +
    'почтовые адреса и необычные форматы он не обнаруживает, поэтому считайте эти числа нижней ' +
    'границей, а не полным перечнем. Чтобы создать копию со скрытыми данными, нажмите кнопку ' +
    '**{button}** прямо над полем сообщения и выберите, куда ее сохранить.',
  // ---- Models (ModelsScreen.tsx) ----
  'models.title': 'ИИ-модель',
  'models.library.title': 'Библиотека моделей',
  'models.library.view': 'Вид библиотеки моделей',
  'models.library.onDrive': 'На этом диске',
  'models.library.browse': 'Каталог моделей',
  'models.library.search': 'Поиск моделей',
  'models.library.searchPlaceholder': 'Название, семейство или вариант…',
  'models.library.task': 'Задача',
  'models.library.allTasks': 'Все задачи',
  'models.library.family': 'Семейство',
  'models.library.allFamilies': 'Все семейства',
  'models.library.familyNotInView': '{name} (нет в этом списке)',
  'models.library.resetFamily': 'Все семейства',
  'models.library.noFamilyForTask': 'Нет моделей семейства {family} для этой задачи.',
  'models.library.noFamilyOnDrive.one':
    'На этом диске нет моделей семейства {family}. «Каталог моделей» показывает {count} модель.',
  'models.library.noFamilyOnDrive.few':
    'На этом диске нет моделей семейства {family}. «Каталог моделей» показывает {count} модели.',
  'models.library.noFamilyOnDrive.many':
    'На этом диске нет моделей семейства {family}. «Каталог моделей» показывает {count} моделей.',
  'models.library.noFamilyOnDrive.other':
    'На этом диске нет моделей семейства {family}. «Каталог моделей» показывает {count} модели.',
  'models.library.chat': 'Чат',
  'models.library.translation': 'Перевод',
  'models.library.images': 'Изображения',
  'models.library.voice': 'Распознавание речи',
  'models.library.memory': 'Минимальный объем оперативной памяти: {size}',
  'models.library.clear': 'Сбросить фильтры',
  'models.library.showVariants': 'Показать все варианты ({count})',
  'models.library.hideVariants': 'Показать меньше вариантов ({count})',
  'models.library.results.one': '{count} подходящий вариант',
  'models.library.results.few': '{count} подходящих варианта',
  'models.library.results.many': '{count} подходящих вариантов',
  'models.library.results.other': '{count} подходящего варианта',
  'models.library.noMatches':
    'Нет моделей, соответствующих этим фильтрам. Измените условия поиска или сбросьте фильтры.',
  'models.library.noneInstalled': 'На этом диске пока нет моделей, готовых к работе.',
  'models.library.onlyActive':
    'Ваша установленная модель показана выше. Другие модели можно найти в каталоге.',
  'models.library.noAlternatives': 'В этом каталоге нет других моделей.',
  'models.library.download': 'Текущее скачивание модели',
  'models.lead':
    'ИИ-модель отвечает на ваши вопросы полностью на этом устройстве. Все проверяется перед ' +
    'использованием, и ничего не скачивается без вашего явного подтверждения.',
  'models.loadError': 'Не удалось загрузить модели: {error}',
  'models.checking':
    'Проверка файлов моделей… Первая проверка после добавления или обновления модели может ' +
    'занять несколько минут, если файлы большие; после этого результат запоминается, и проверка ' +
    'проходит мгновенно.',
  'models.checkingProgress': 'Проверка модели {n} из {m}: {name} — {pct}%',
  'models.state.installed': 'Установлена',
  'models.state.missing': 'Не скачана',
  'models.state.checksumFailed': 'Не удается проверить',
  'models.state.unsupported': 'Не поддерживается',
  'models.state.notRecommended': 'Не рекомендуется',
  'models.state.ready': 'Готова',
  'models.state.running': 'Работает',
  'models.badge.notResponding': 'Не отвечает',
  'models.notRespondingHint': 'ИИ-модель перестала отвечать. Обычно помогает перезапуск.',
  'models.restart': 'Перезапустить',
  'models.hint.embeddings':
    'Подготавливает ваши документы, чтобы по ним можно было задавать вопросы.',
  'models.hint.reranker': 'Улучшает выбор фрагментов документов, на которые опираются ответы.',
  'models.hint.transcriber':
    'Превращает аудиозаписи в текст, доступный для поиска, — и включает кнопку голосового ввода ' +
    '🎤 в чате.',
  'models.hint.translation':
    'Переводит ваши документы и тексты с одного языка на другой полностью офлайн.',
  'models.hint.vision':
    'Отвечает на ваши вопросы об одном изображении за раз. Не читает PDF-файлы и не делает сканы ' +
    'доступными для поиска.',
  'models.hint.small': 'Небольшая и быстрая — отвечает быстро почти на любом компьютере.',
  'models.hint.balanced': 'Сбалансированная — хорошо работает на большинстве ноутбуков.',
  'models.hint.large': 'Большая — самые качественные ответы; нужен мощный компьютер.',
  'models.usesSpace': 'Занимает на диске {size}.',
  'models.downloads.blockedByPolicy': 'Скачивание отключено политикой этого диска.',
  'models.downloads.enableInSettings':
    'Чтобы скачивать модели, включите на экране «Настройки» переключатель «Разрешить доступ в ' +
    'интернет для скачивания моделей и обновлений».',
  'models.download.verifying': 'Проверка скачанного файла…',
  'models.download.progress': 'Скачивание… {pct}% ({received} из {total})',
  'models.download.progressNoTotal': 'Скачивание… получено {received}',
  'models.download.cancel': 'Отменить скачивание',
  'models.download.cancelled':
    'Скачивание отменено — при повторном запуске оно продолжится с того места, где остановилось.',
  'models.download.stoppedNetworkOff':
    'Скачивание остановлено, потому что доступ в интернет был выключен — когда доступ снова ' +
    'будет включен, повторный запуск продолжит скачивание с того места, где оно остановилось.',
  'models.download.unverifiedBefore':
    'Скачано, но в манифесте этой модели пока нет настоящей контрольной суммы, поэтому файл ' +
    'остается непроверенным. Создайте ее командой ',
  'models.download.unverifiedAfter': '.',
  'models.download.otherRunning': 'Уже идет другое скачивание — модели скачиваются по одной',
  'models.download.titled': 'Скачать модель {name} ({size})',
  'models.download.resume': 'Продолжить скачивание',
  'models.download.start': 'Скачать',
  'models.download.failed': 'Не удалось скачать модель {name}.',
  'models.download.retry': 'Повторить скачивание',
  'models.download.dismiss': 'Скрыть',
  'models.download.retryUnavailable':
    'Эта модель здесь больше не предлагается для скачивания, поэтому повторить скачивание из ' +
    'этого результата нельзя. Скройте результат или найдите модель в библиотеке.',
  'models.download.retryInstalled': 'Уже есть на этом диске.',
  'models.download.withdrawn':
    'Больше недоступно для скачивания: издатель удалил именно этот файл ({reason}). Копии, ' +
    'которые уже есть на дисках, продолжают работать, и их по-прежнему можно проверить.',
  'models.engine.title': 'Установите ИИ-движок',
  'models.engine.explain':
    'Пока ИИ-движок не установлен, модели работают во встроенном демо-режиме (ответы ' +
    'имитируются, и это сразу видно); для голосового ввода нужен голосовой движок. Установите ' +
    'движки один раз — после этого запустите модель, чтобы получать настоящие ответы.',
  'models.engine.install': 'Установить ИИ-движок',
  'models.engine.retry': 'Повторить',
  'models.engineProblem.title': 'ИИ-движок не может работать на этом компьютере',
  'models.engineProblem.voiceTitle': 'Голосовой движок не может работать на этом компьютере.',
  'models.engineProblem.libraryMissingPackage':
    'Не хватает системной библиотеки, которая нужна движку: {library}. Установите пакет ' +
    '{debPackage} (Ubuntu, Debian, Linux Mint) или {rpmPackage} (Fedora) через менеджер программ ' +
    'или терминал, затем нажмите «Проверить снова».',
  'models.engineProblem.libraryMissing':
    'Не хватает системной библиотеки, которая нужна движку: {library}. Установите ее через ' +
    'менеджер программ или терминал, затем нажмите «Проверить снова».',
  'models.engineProblem.systemTooOldLinux':
    'Движку нужна более новая версия Linux: Ubuntu 22.04, Debian 12, Fedora 36 или новее.',
  'models.engineProblem.systemTooOldMac':
    'Движку нужна более новая версия macOS. Обновите macOS, затем нажмите «Проверить снова».',
  'models.engineProblem.systemTooOld': 'Движку нужна более новая версия операционной системы.',
  'models.engineProblem.vcRuntimeMissing':
    'В Windows нет нужного движку пакета Microsoft Visual C++ Redistributable (x64). Установите ' +
    'его, затем нажмите «Проверить снова».',
  'models.engineProblem.filesDamaged':
    'Некоторые файлы движка на этом диске отсутствуют или повреждены. Как установить его заново, ' +
    'описано в руководстве по устранению неполадок.',
  'models.engineProblem.filesDamagedReinstall':
    'Некоторые файлы движка на этом диске отсутствуют или повреждены. Установите движок заново, ' +
    'чтобы заменить их.',
  'models.engineProblem.filesDamagedAfterInstall':
    'Движок только что установлен, но все равно не запускается, поэтому дело, скорее всего, не в ' +
    'его файлах. Что еще можно проверить, описано в руководстве по устранению неполадок.',
  'models.engineProblem.filesDamagedAfterInstallWin':
    'Движок только что установлен, но все равно не запускается, поэтому дело, скорее всего, не в ' +
    'его файлах. Причиной может быть и устаревший пакет Microsoft Visual C++ Redistributable ' +
    '(x64): установите актуальную версию, затем нажмите «Проверить снова».',
  'models.engineProblem.reinstall': 'Установить ИИ-движок заново',
  'models.engineProblem.voiceReinstall': 'Установить голосовой движок заново',
  'models.engineProblem.reinstalled': 'ИИ-движок установлен заново.',
  'models.engineProblem.voiceReinstalled': 'Голосовой движок установлен заново.',
  'models.engineUpdate.title': 'Доступно обновление ИИ-движка',
  'models.engineUpdate.voiceTitle': 'Доступно обновление голосового движка',
  'models.engineUpdate.bothTitle': 'Доступны обновления ИИ-движка и голосового движка',
  'models.engineUpdate.explain':
    'На этом диске записана более старая версия, чем та, для которой собрано это приложение. ' +
    'Обновление сначала скачивает новую версию; затем модели приостанавливаются на несколько ' +
    'секунд, пока заменяются файлы, и выбранная модель запускается снова.',
  'models.engineUpdate.update': 'Обновить',
  'models.engineUpdate.done': 'ИИ-движок обновлен.',
  'models.engineUpdate.voiceDone': 'Голосовой движок обновлен.',
  'models.engineUpdate.bothDone': 'ИИ-движок и голосовой движок обновлены.',
  'models.engineProblem.blocked':
    'Защита Windows запретила запуск движка (функция «Интеллектуальное управление приложениями» ' +
    'или ваш антивирус). Что можно сделать, описано в руководстве по устранению неполадок.',
  'models.engineProblem.demoNote': 'До тех пор модели отвечают в демо-режиме — ответы имитируются.',
  'models.engineProblem.check': 'Проверить снова',
  'models.engineProblem.checking': 'Проверка…',
  'models.engineProblem.stillFailing':
    'Движок по-прежнему не запускается. Убедитесь, что установка завершилась, и попробуйте еще ' +
    'раз.',
  'models.engineProblem.fixed': 'ИИ-движок снова работает.',
  'models.engineProblem.voiceFixed': 'Голосовой движок снова работает.',
  'models.engine.progress': 'Скачивание ИИ-движка… {pct}%',
  'models.engine.downloadingNoTotal': 'Скачивание ИИ-движка…',
  'models.engine.verifying': 'Проверка ИИ-движка…',
  'models.engine.extracting': 'Распаковка ИИ-движка…',
  'models.voiceEngine.title': 'Добавьте голосовой ввод (необязательно)',
  'models.voiceEngine.explain':
    'Ответы в чате и по документам на этом диске уже работают. Голосовой движок необязателен — ' +
    'устанавливайте его, только если хотите диктовать сообщения в микрофон.',
  'models.voiceEngine.install': 'Установить голосовой движок',
  'models.packTools.row': 'Инструменты для пакетов знаний: не установлены',
  'models.packTools.install': 'Установить…',
  'models.ocr.row': 'Распознавание текста на сканах и фотографиях (необязательно)',
  'models.ocr.rowOrientation':
    'Для поворота сканов, лежащих боком, нужен еще один файл OCR (необязательно)',
  'ocr.install.action': 'Скачать файлы OCR',
  'ocr.install.actionTitle':
    'Скачать языковые файлы распознавания текста (OCR) для сканов и фотографий',
  'ocr.install.confirm.title': 'Скачать файлы OCR?',
  'ocr.install.confirm.explain':
    'Распознавание текста (OCR) читает отсканированные PDF-файлы и сфотографированные страницы ' +
    'на этом компьютере. Для его работы на этом диске нужны файлы, перечисленные ниже, — больше ' +
    'ничего не скачивается, а ваши документы никогда не покидают этот компьютер.',
  'ocr.install.confirm.languages': 'Файлы',
  'ocr.install.confirm.hint':
    'Перед использованием контрольная сумма каждого файла сверяется с ожидаемой.',
  'ocr.install.confirm.start': 'Скачать',
  'ocr.install.lang.deu': 'Немецкий',
  'ocr.install.lang.eng': 'Английский',
  'ocr.install.lang.osd': 'Ориентация страниц (поворачивает страницы, лежащие боком)',
  'ocr.install.starting': 'Запуск скачивания…',
  'ocr.install.progress': 'Скачивание файлов OCR… {pct}%',
  'ocr.install.verifying': 'Проверка файлов OCR…',
  'ocr.install.activating': 'Запуск распознавания текста…',
  'ocr.install.failed': 'Не удалось установить файлы OCR.',
  'ocr.install.retry': 'Повторить скачивание файлов OCR',
  'ocr.install.cancel': 'Отменить скачивание файлов OCR',
  'ocr.install.alreadyPresent':
    'Файлы OCR уже есть на этом диске. Перезапустите приложение HilbertRaum, чтобы использовать ' +
    'их.',
  'ocr.install.outcome.activated': 'Распознавание текста готово — перезапуск не нужен.',
  'ocr.install.outcome.restartRequired':
    'Файлы OCR на месте. Перезапустите приложение HilbertRaum, чтобы использовать новые языковые ' +
    'файлы.',
  'ocr.install.outcome.unchanged':
    'Файлы OCR на месте. Если распознавание текста по-прежнему не предлагается, перезапустите ' +
    'приложение HilbertRaum.',
  'models.ram.needs': 'Нужно не менее {min} GB оперативной памяти',
  'models.ram.machine': ' — на этом компьютере около {ram} GB',
  'models.ram.advice': '. Выберите модель поменьше — качество останется отличным.',
  'models.badge.active': 'Активна',
  'models.badge.recommended': 'Рекомендуется для этого компьютера',
  'models.badge.ramNeeded': 'Нужно ≥{min} GB памяти',
  'models.automatic.installed':
    'Установлена — используется автоматически. Запускать ничего не нужно.',
  'models.automatic.notInstalled':
    'После установки используется автоматически — настраивать ничего не нужно.',
  'models.transcriber.engineUnsupported':
    'В этой операционной системе приложение пока не может установить голосовой движок, поэтому ' +
    'здесь эта модель не включает голосовой ввод и импорт аудио.',
  'models.vision.installed':
    'Установлена — используется автоматически на экране «Картинки». Здесь запускать ничего не ' +
    'нужно.',
  'models.vision.notInstalled':
    'После установки используется автоматически на экране «Картинки» — настраивать ничего не ' +
    'нужно.',
  'models.vision.goToImages': 'Открыть «Картинки»',
  'models.translation.installed':
    'Установлена — используется автоматически для перевода. Здесь запускать ничего не нужно.',
  'models.translation.notInstalled':
    'После установки используется автоматически для перевода — настраивать ничего не нужно.',
  'models.use': 'Использовать эту модель',
  'models.useTitle': 'Выбрать эту модель и запустить ее, чтобы начать чат',
  'models.stopRuntime': 'Остановить модель',
  'models.answeringNote':
    'Сейчас пишется ответ. Если остановить или сменить модель, ответ прервется — уже написанный ' +
    'текст сохранится.',
  'models.startMock': 'Попробовать в демо-режиме',
  'models.starting': 'Запуск…',
  'models.startingTitle':
    'Модель загружается — для больших моделей это может занять некоторое время',
  'models.startMockTitle':
    'Файла модели пока нет — попробуйте приложение в демо-режиме: ответы имитируются, и это ' +
    'сразу видно',
  'models.tech.summary': 'Технические сведения',
  'models.tech.id': 'Идентификатор модели',
  'models.tech.family': 'Семейство',
  'models.tech.format': 'Формат',
  'models.tech.runtime': 'Движок',
  'models.tech.license': 'Лицензия',
  'models.tech.sizeOnDisk': 'Размер на диске',
  'models.tech.minRam': 'Минимальный объем оперативной памяти',
  'models.tech.recRam': 'Рекомендуемый объем оперативной памяти',
  'models.tech.context': 'Размер контекста',
  'models.tech.contextValue.one': '{count} токен',
  'models.tech.contextValue.few': '{count} токена',
  'models.tech.contextValue.many': '{count} токенов',
  'models.tech.contextValue.other': '{count} токена',
  'models.tech.file': 'Файл',
  // ---- Context-size picker (2026-07-04 user report — the truncation hint points here) ----
  'models.context.title': 'Размер контекста',
  'models.context.label': 'Размер контекста для ответов:',
  'models.context.auto': 'Автоматически — размер, рекомендуемый для модели',
  'models.context.autoResolved.one':
    'Автоматически — размер, рекомендуемый для модели ({count} токен)',
  'models.context.autoResolved.few':
    'Автоматически — размер, рекомендуемый для модели ({count} токена)',
  'models.context.autoResolved.many':
    'Автоматически — размер, рекомендуемый для модели ({count} токенов)',
  'models.context.autoResolved.other':
    'Автоматически — размер, рекомендуемый для модели ({count} токена)',
  'models.context.bigWarning':
    'Очень большой контекст требует много дополнительной памяти, пока модель работает. На ' +
    'компьютерах с меньшим объемом памяти модель может не запуститься или отвечать гораздо ' +
    'медленнее — в таком случае выберите размер поменьше или «Автоматически».',
  'models.context.hint':
    'Чем больше контекст, тем больше текста чат или ответ по документам может учитывать за один ' +
    'раз, но тем больше нужно памяти и тем медленнее могут быть ответы. Применяется при ' +
    'следующем запуске модели.',
  'models.context.restartHint':
    'Сейчас работает модель — остановите и снова запустите ее, чтобы применить новый размер.',
  'models.verifyTitle':
    'Заново вычислить хеш файла на диске и сверить его с SHA-256 (в обход кеша)',
  'models.verifying': 'Проверка…',
  'models.verify': 'Проверить контрольную сумму',
  'models.verifyAll': 'Проверить все файлы моделей',
  'models.verifyingAll': 'Проверка всех файлов моделей…',
  'models.verifyAllTitle': 'Заново сверить каждый файл модели на этом диске с его SHA-256',
  'models.verifyAllHint':
    'Каждая модель проверяется при запуске. Эта проверка охватывает все файлы моделей на этом ' +
    'диске — на медленном диске она может занять несколько минут. Остановить ее можно в любой ' +
    'момент; уже проверенные файлы останутся проверенными.',
  'models.verifyAllStop': 'Остановить проверку',
  'models.verifyAllStopping': 'Остановка…',
  'models.confirm.title': 'Скачать модель {name}?',
  'models.confirm.start': 'Начать скачивание',
  'models.confirm.size': 'Размер',
  'models.confirm.license': 'Лицензия',
  'models.confirm.from': 'Источник',
  'models.confirm.readLicense': 'прочитать лицензию',
  'models.confirm.hint':
    'Скачанный файл проверяется перед использованием. Это единственный сетевой запрос приложения ' +
    '— никакие сведения о вас или ваших документах не отправляются.',
  'models.confirm.licenseAck':
    'Я подтверждаю, что условия лицензии этой модели прочитаны, и принимаю их',
  'models.empty.title': 'Манифесты моделей не найдены',
  'models.empty.lineBefore': 'Добавьте YAML-манифесты в папку ',
  'models.empty.lineAfter': ' на диске.',
  'models.section.yourModel': 'Ваша ИИ-модель',
  'models.section.docSearch': 'Поиск по документам',
  // ---- Settings (SettingsScreen.tsx — chrome + the General tab) ----
  'settings.title': 'Настройки',
  'settings.tabsAria': 'Разделы настроек',
  'settings.tab.general': 'Общие',
  'settings.tab.privacy': 'Конфиденциальность и данные',
  'settings.tab.skills': 'Навыки',
  'settings.tab.diagnostics': 'Диагностика (для опытных)',
  'settings.loading': 'Загрузка настроек…',
  'settings.saved': 'Сохранено',
  'settings.saveFailed': 'Не удалось сохранить эту настройку. Попробуйте еще раз.',
  'settings.network.title': 'Конфиденциальность и офлайн-режим',
  'settings.network.allow': 'Разрешить доступ в интернет для скачивания моделей и обновлений',
  'settings.network.hint':
    'По умолчанию включено, чтобы после новой установки сразу можно было скачать модель. Когда ' +
    'эта настройка выключена, приложение не обращается к интернету. Если ее включить, станет ' +
    'доступно скачивание моделей, ИИ-движка, дополнительных инструментов для пакетов знаний и ' +
    'дополнительных файлов распознавания текста (OCR) — каждое скачивание сначала запрашивает ' +
    'подтверждение, а политика диска может полностью запретить скачивание. Ваши запросы и ' +
    'документы никогда не покидают это устройство, независимо от этой настройки.',
  'settings.appearance.title': 'Оформление',
  'settings.appearance.aria': 'Тема',
  'settings.appearance.system': 'Системная',
  'settings.appearance.light': 'Светлая',
  'settings.appearance.dark': 'Темная',
  'settings.appearance.hint':
    'Тема «Системная» следует выбору светлой или темной темы в операционной системе. Экран ' +
    'блокировки всегда использует тему системы.',
  'settings.language.title': 'Язык',
  'settings.language.aria': 'Язык',
  'settings.language.system': 'System',
  'settings.language.hint':
    'Вариант «Как в системе» повторяет язык операционной системы: для немецкой системы ' +
    'выбирается Deutsch, для всех остальных — English. Изменения применяются сразу.',
  'settings.performance.title': 'Скорость работы',
  'settings.performance.gpu': 'Использовать ускорение на видеокарте',
  'settings.performance.gpuHint':
    'Если видеокарта доступна, она используется для ускорения ответов. Выключайте, только если ' +
    'заметите проблемы со стабильностью — в любом случае все продолжит работать.',
  'settings.performance.rerankWideScope':
    'Повторно ранжировать больше фрагментов из пакетов знаний',
  'settings.performance.rerankWideScopeHint':
    'Каждый вопрос обрабатывается дольше. Работает только на компьютере с достаточным числом ' +
    'потоков процессора и установленной моделью ранжирования; на компьютере с подходящей ' +
    'видеокартой все фрагменты и так ранжируются повторно.',
  'settings.performance.autoStart':
    'Автоматически загружать выбранную модель при запуске приложения',
  'settings.performance.autoStartHint':
    'По умолчанию включено. Модель, выбранная на экране «ИИ-модель», загружается в фоновом ' +
    'режиме при запуске (в зашифрованном рабочем пространстве — после разблокировки), чтобы чат ' +
    'сразу был готов к работе без лишних действий.',
  // ---- Settings: Chat / conversation compaction (context-compaction plan §5.4) ----
  'settings.chat.title': 'Чат',
  'settings.chatCompaction.label':
    'Заменять старые сообщения кратким содержанием, чтобы освободить контекст',
  'settings.chatCompaction.help':
    'По умолчанию включено. Когда длинный чат приближается к пределу контекста модели, старые ' +
    'сообщения один раз кратко излагаются в компактной заметке, которая хранится на этом диске, ' +
    '— вместо того чтобы незаметно отбрасываться. Выключите, чтобы сохранялись только последние ' +
    'сообщения, которые помещаются в контекст.',
  'settings.developer.title': 'Для разработчиков',
  'settings.developer.toggle':
    'Режим разработчика (разрешает рабочее пространство без шифрования и непроверенные модели)',
  'settings.developer.hint':
    'По умолчанию выключено. Сборки для разработки всегда работают в режиме разработчика. ' +
    'Решающее слово за политикой диска: на коммерческом диске непроверенные модели отклоняются ' +
    'независимо от этой настройки.',
  'settings.workspace.title': 'Рабочее пространство',
  'settings.workspace.mode': 'Режим',
  'settings.workspace.modeEncrypted': 'С шифрованием',
  'settings.workspace.modePlaintext': 'Без шифрования (режим разработчика)',
  'settings.workspace.contextTokens': 'Размер контекста в токенах',
  'settings.workspace.contextAuto':
    'Автоматически (по умолчанию для модели) — изменить можно на экране «ИИ-модель»',
  'settings.workspace.encryptedHint':
    'Это рабочее пространство хранится в зашифрованном виде. Чтобы снова зашифровать и ' +
    'заблокировать его, нажмите «Блокировка» на боковой панели; при выходе из приложения оно ' +
    'блокируется автоматически.',
  'settings.workspace.plaintextHint':
    'Рабочее пространство разработчика без шифрования — данные хранятся в незашифрованном виде. ' +
    'В коммерческой версии по умолчанию используется режим с шифрованием.',
  'settings.changePassword.title': 'Смена пароля',
  'settings.changePassword.hint':
    'Выберите новый пароль для этого рабочего пространства. Он будет нужен начиная со следующей ' +
    'разблокировки. Восстановить или сбросить его невозможно, поэтому выберите то, что вы ' +
    'запомните.',
  'settings.changePassword.current': 'Текущий пароль',
  'settings.changePassword.new': 'Новый пароль',
  'settings.changePassword.confirm': 'Подтверждение нового пароля',
  'settings.changePassword.busy':
    'Защита ваших документов новым паролем… Для большой библиотеки это может занять несколько ' +
    'минут.',
  'settings.changePassword.failed':
    'Что-то пошло не так. Ваш текущий пароль по-прежнему действует.',
  'settings.changePassword.submit': 'Сменить пароль',
  'settings.changePassword.submitBusy': 'Смена пароля…',
  'settings.changePassword.toast': 'Пароль изменен',
  // ---- Skills (settings/SkillsTab.tsx, skills plan §15) ----
  'skills.intro':
    'Каждый навык учит ИИ-модель выполнять определенную задачу. Навыки дополняют ее ответы ' +
    'указаниями и никогда не обращаются к интернету или другим папкам на вашем компьютере.',
  'skills.info.meeting-protocol.what':
    'Оформляет следующий ответ как аккуратный протокол встречи — решения, задачи и открытые ' +
    'вопросы.',
  'skills.info.meeting-protocol.needs':
    'Расшифровка встречи или заметки среди источников этого чата (прикрепите файл или вставьте ' +
    'текст).',
  'skills.info.meeting-protocol.limits':
    'Работает с одним документом за раз и фиксирует только то, что действительно есть в заметках.',
  'skills.info.contract-brief.what':
    'Кратко излагает договор простым языком — стороны, даты, обязательства, ключевые условия и ' +
    'вопросы, которые стоит задать.',
  'skills.info.contract-brief.needs': 'Договор среди источников этого чата.',
  'skills.info.contract-brief.limits':
    'Помогает читать по одному документу за раз — это не юридическая консультация.',
  'skills.info.deadline-obligation-finder.what':
    'Находит крайние сроки, сроки уведомления, даты продления и оплаты, а также связанные с ними ' +
    'обязательства.',
  'skills.info.deadline-obligation-finder.needs': 'Документ среди источников этого чата.',
  'skills.info.deadline-obligation-finder.limits':
    'Читает по одному документу за раз; прежде чем действовать, сверьте важные даты с оригиналом.',
  'skills.info.what-changed.what':
    'Сравнивает две версии документа и сообщает о значимых изменениях, а не выдает построчное ' +
    'сравнение.',
  'skills.info.what-changed.needs':
    'Ровно два документа (или две версии) среди источников этого чата.',
  'skills.info.what-changed.limits':
    'Если среди источников больше или меньше двух документов, сравнение невозможно, и навык ' +
    'отвечает как обычно.',
  'skills.info.share-safe-review.what':
    'Проверяет документ перед отправкой — видимые конфиденциальные сведения и практические риски ' +
    'при передаче.',
  'skills.info.share-safe-review.needs': 'Документ среди источников этого чата.',
  'skills.info.share-safe-review.limits':
    'Только рекомендации: навык никогда не утверждает, что документ обезличен или его безопасно ' +
    'публиковать.',
  'skills.info.invoice.what':
    'Читает счет на оплату с точным, проверяемым извлечением данных: позиции и итоговые суммы, ' +
    'проверка итоговых сумм, экспорт в CSV/JSON/XML.',
  'skills.info.invoice.needs':
    'Документ, похожий на счет на оплату, среди источников; действия навыка появляются в виде ' +
    'кнопок прямо над полем сообщения.',
  'skills.info.invoice.limits':
    'Один счет на оплату за раз; итоговая сумма, которую не удается проверить, помечается как ' +
    'непроверенная, а не замалчивается.',
  'skills.info.bank-statement.what':
    'Читает банковскую выписку с точным, проверяемым извлечением данных: транзакции, категории, ' +
    'проверка остатков, экспорт в CSV.',
  'skills.info.bank-statement.needs':
    'Документ, похожий на банковскую выписку, среди источников; действия навыка появляются в ' +
    'виде кнопок прямо над полем сообщения.',
  'skills.info.bank-statement.limits':
    'Одна выписка за раз; для распределения транзакций по категориям нужна запущенная модель.',
  'skills.info.document-redaction.what':
    'Сохраняет копию документа со скрытыми данными — адреса электронной почты, номера и даты ' +
    'обнаруживаются по правилам, а имена и адреса находит модель.',
  'skills.info.document-redaction.needs':
    'Документ среди источников; кнопка «Скрыть персональные данные» появляется прямо над полем ' +
    'сообщения.',
  'skills.info.document-redaction.limits':
    'Без гарантии полноты — без запущенной модели работает только обнаружение по правилам; ' +
    'документы Word остаются в формате .docx, другие форматы сохраняются как .txt.',
  'skills.info.document-edit.what':
    'Вносит точные правки «найти и заменить» и сохраняет отредактированную копию — ваш документ ' +
    'никогда не переписывается.',
  'skills.info.document-edit.needs':
    'Запущенная модель, документ среди источников и ваше указание (например, «замените X на Y»); ' +
    'кнопка «Внести правки в текст» появляется прямо над полем сообщения.',
  'skills.info.document-edit.limits':
    'Текст, который не найден дословно, пропускается, и об этом сообщается; документы Word ' +
    'остаются в формате .docx, другие форматы сохраняются как .txt.',
  'skills.autoFire.title': 'Автоматически применять подходящий навык',
  'skills.autoFire.toggle': 'Автоматически применять подходящий навык',
  'skills.autoFire.hint':
    'Если эта настройка включена, приложение может само применить к ответу явно подходящий ' +
    'встроенный навык, чтобы вам не приходилось выбирать его. Только встроенные навыки — никогда ' +
    'не созданные или импортированные вами. Вы всегда увидите, какой навык использован, и ' +
    'сможете получить этот ответ без него. По умолчанию выключено.',
  'skills.autoFire.on': 'Автоматические навыки включены',
  'skills.autoFire.off': 'Автоматические навыки выключены',
  'skills.autoFire.saveFailed': 'Не удалось сохранить настройку автоматических навыков.',
  'skills.import': 'Импортировать навык…',
  'skills.import.menuAria': 'Импорт навыка',
  'skills.import.fromFile': 'Из файла (.skill.zip)…',
  'skills.import.fromFolder': 'Из папки…',
  'skills.loading': 'Загрузка навыков…',
  'skills.loadFailed': 'Не удалось загрузить навыки.',
  'skills.reconcile.folderErrors.one':
    '{count} папка навыка не прочитана и пропущена. Каждой папке нужен действительный файл ' +
    'SKILL.md.',
  'skills.reconcile.folderErrors.few':
    '{count} папки навыков не прочитаны и пропущены. Каждой папке нужен действительный файл ' +
    'SKILL.md.',
  'skills.reconcile.folderErrors.many':
    '{count} папок навыков не прочитаны и пропущены. Каждой папке нужен действительный файл ' +
    'SKILL.md.',
  'skills.reconcile.folderErrors.other':
    '{count} папки навыков не прочитаны и пропущены. Каждой папке нужен действительный файл ' +
    'SKILL.md.',
  'skills.empty.title': 'Навыков пока нет',
  'skills.empty.line':
    'Каждый навык учит ИИ-модель выполнять определенную задачу. Добавьте навык, чтобы начать.',
  'skills.trusted.app': 'Встроенный',
  'skills.trusted.user': 'Создан вами',
  'skills.row.enableLabel': 'Включен',
  'skills.row.on': 'Навык включен',
  'skills.row.off': 'Навык выключен',
  'skills.row.onFailed': 'Не удалось включить этот навык.',
  'skills.row.offFailed': 'Не удалось выключить этот навык.',
  'skills.dup.chip': 'Имя совпадает',
  'skills.dup.title':
    'Это имя использует другой установленный навык. Одновременно может быть активен только один ' +
    'из них.',
  'skills.unavailable.chip': 'Нет файлов',
  'skills.unavailable.title': 'Файлов этого навыка больше нет на диске.',
  'skills.incompatible.chip': 'Нужно обновление',
  'skills.incompatible.title':
    'Этому навыку нужна более новая версия приложения; обновите приложение, чтобы включить навык.',
  'skills.review.chip': 'Проверить',
  'skills.warn.title': 'Проверьте, что может этот навык',
  'skills.warn.body':
    'Создан вами или импортирован. Прежде чем полагаться на навык, проверьте, что он может ' +
    'делать.',
  'skills.warn.ack': 'Понятно',
  'skills.menu.aria': 'Действия с навыком',
  'skills.menu.export': 'Экспортировать…',
  'skills.menu.delete': 'Удалить',
  'skills.export.done': 'Навык экспортирован',
  'skills.export.failed': 'Не удалось экспортировать этот навык.',
  'skills.delete.title': 'Удалить этот навык?',
  'skills.delete.body':
    'Навык будет удален с диска. Чаты, в которых он уже использовался, продолжат работать.',
  'skills.delete.confirm': 'Удалить',
  'skills.delete.done': 'Навык удален',
  'skills.delete.failed': 'Не удалось удалить этот навык.',
  'skills.detail.aria': 'Сведения о навыке',
  'skills.detail.version': 'Версия',
  'skills.detail.author': 'Автор',
  'skills.detail.language': 'Язык',
  'skills.detail.kind': 'Тип',
  'skills.kind.instruction': 'Указания',
  'skills.kind.tool': 'Использует инструменты',
  'skills.tool.note':
    'Пока навык добавляет только указания. Описанные в нем инструменты появятся в одной из ' +
    'следующих версий.',
  'skills.tool.note.active':
    'По вашей просьбе этот навык может запускать разрешенные локальные инструменты для ' +
    'выбранного вами документа. Инструменты, которые только читают данные, могут запускаться и ' +
    'автоматически, чтобы ответить на ваш вопрос; все, что записывает или экспортирует файл, ' +
    'всегда сначала запрашивает ваше подтверждение. Инструменты видят только этот документ.',
  'skills.perm.heading': 'Что может этот навык',
  'skills.perm.canTitle': 'Этот навык может:',
  'skills.perm.cannotTitle': 'Этот навык не может:',
  'skills.perm.can.instructions': 'Добавлять указания к ответам ИИ-модели',
  'skills.perm.can.documents': 'Читать только выбранные вами документы',
  'skills.perm.can.tools': 'Использовать разрешенные локальные инструменты по вашей просьбе',
  'skills.perm.cannot.network': 'Обращаться к интернету',
  'skills.perm.cannot.files': 'Читать другие папки на вашем компьютере',
  'skills.perm.cannot.scripts': 'Запускать скрипты или устанавливать программы',
  'skills.tech.summary': 'Технические сведения',
  'skills.tech.id': 'Идентификатор навыка',
  'skills.tech.installId': 'Идентификатор установки',
  'skills.tech.source': 'Источник',
  'skills.tech.permissions': 'Разрешения',
  'skills.import.title': 'Добавить этот навык?',
  'skills.import.confirm': 'Добавить навык',
  'skills.import.added': 'Навык добавлен',
  'skills.import.failedTitle': 'Этот навык нельзя добавить',
  'skills.import.failed': 'Не удалось добавить этот навык.',
  'skills.import.collision':
    'Навык с таким именем уже установлен. При добавлении он будет заменен.',
  'skills.import.collisionApp':
    'Это имя уже использует встроенный навык. Ваш навык будет добавлен, но останется ' +
    'выключенным, пока включен встроенный навык.',
  'skills.import.upgrade': 'Обновляет установленную версию ({from} → {to}).',
  'skills.import.replace': 'Заменяет установленную версию ({version}).',
  'skills.import.downgrade': 'Это более старая версия, чем установленная ({installed}).',
  'skills.import.downgradeBlocked':
    'Для установки более старой версии нужен режим разработчика. Чтобы разрешить это, включите ' +
    'его на экране «Настройки» на вкладке «Общие».',
  'skills.import.error.notFound': 'Выбранный навык не найден.',
  'skills.import.error.notZipOrFolder':
    'Навык должен быть файлом .skill.zip или папкой с файлом SKILL.md.',
  'skills.import.error.unreadableZip':
    'Не удалось прочитать пакет навыка как действительный ZIP-архив.',
  'skills.import.error.encryptedZip':
    'Пакет навыка использует неподдерживаемый формат ZIP (зашифрованный или ZIP64).',
  'skills.import.error.unsupportedCompression':
    'Пакет навыка использует неподдерживаемый метод сжатия.',
  'skills.import.error.pathTraversal':
    'Пакет содержит файл, путь которого выходит за пределы папки пакета.',
  'skills.import.error.absolutePath':
    'Пакет содержит файл с абсолютным путем или путем с буквой диска.',
  'skills.import.error.invalidPath': 'Пакет содержит файл с недопустимым путем.',
  'skills.import.error.symlink': 'Пакет содержит символическую ссылку, а это не допускается.',
  'skills.import.error.tooDeep': 'В пакете слишком глубокая вложенность папок.',
  'skills.import.error.pathTooLong': 'Пакет содержит слишком длинный путь к файлу.',
  'skills.import.error.tooManyFiles': 'Пакет содержит больше файлов, чем допускается.',
  'skills.import.error.tooLarge': 'Размер пакета превышает допустимый.',
  'skills.import.error.fileTooLarge': 'Размер одного из файлов пакета превышает допустимый.',
  'skills.import.error.duplicatePath':
    'Пакет содержит два файла, которые указывают на один и тот же путь.',
  'skills.import.error.badExtension': 'Пакет содержит файл недопустимого типа.',
  'skills.import.error.nestedArchive': 'Пакет содержит вложенный архив, а это не допускается.',
  'skills.import.error.noSkillMd': 'В пакете нет файла SKILL.md.',
  'skills.import.error.invalidManifest': 'Манифест навыка недействителен.',
  'skills.import.error.idMismatch': 'Идентификатор навыка не является допустимым именем.',
  'skills.import.error.downgradeBlocked':
    'Более новая версия этого навыка уже установлена. Чтобы установить более старую версию, ' +
    'включите режим разработчика.',
  'skills.import.error.appReadOnly': 'Встроенные навыки нельзя изменить или удалить.',
  'skills.import.error.locked': 'Чтобы управлять навыками, разблокируйте рабочее пространство.',
  'skills.import.note.permissionNotString':
    'Разрешение «{field}» задано не текстовым значением; используется значение по умолчанию ' +
    '«{value}».',
  'skills.import.note.permissionUnrecognized':
    'У разрешения «{field}» значение, неизвестное этому приложению; используется значение по ' +
    'умолчанию «{value}».',
  'skills.import.note.permissionClamped':
    'Навык запрашивает доступ «{field}» шире, чем разрешает это приложение; доступ ограничен ' +
    'значением «{value}».',
  'skills.import.note.listInvalid':
    'Список «{field}» не является списком текстовых значений и игнорируется.',
  'skills.import.note.listItemsTooLong':
    'Некоторые записи в списке «{field}» слишком длинные и игнорируются.',
  'skills.import.note.listTruncated':
    'В списке «{field}» больше записей, чем допускается; оставлены только первые {max}.',
  'skills.import.note.languageInvalid':
    'Поле «language» не содержит допустимого кода языка; используется «en».',
  'skills.import.note.allowedToolsIgnored':
    'Для навыка с указаниями объявленные инструменты игнорируются (инструменты появятся в одной ' +
    'из следующих версий).',
  'skills.import.note.analysisInvalid':
    'Поле «analysis» имеет неизвестное значение и игнорируется.',
  'skills.import.note.analysisIgnoredForTool':
    'Для навыка с инструментами поле «analysis» игнорируется (работу с документом целиком ' +
    'определяет приложение).',
  'skills.import.note.triggersInvalid': 'Блок «triggers» недействителен и игнорируется.',
  'skills.import.note.autoFireInvalid':
    'Поле «triggers.autoFire» должно иметь значение true или false; оно считается равным false.',
  'skills.import.note.localizedInvalid': 'Блок «localized» недействителен и игнорируется.',
  'skills.import.note.localizedLocaleInvalid':
    'Запись в блоке «localized» с недопустимым ключом языка игнорируется.',
  'skills.import.note.localizedEntryInvalid':
    'Запись в блоке «localized» недействительна и игнорируется.',
  'skills.import.note.localizedTitleIgnored':
    'Переведенное название проигнорировано (оно должно быть одной короткой строкой).',
  'skills.import.note.localizedDescriptionIgnored':
    'Переведенное описание проигнорировано (оно должно быть одной короткой строкой).',
  'skills.import.note.localizedTooMany':
    'В блоке «localized» больше языков, чем допускается; оставлены только первые {max}.',
  'skills.import.note.trustIgnored':
    'Поле «trust» в навыке игнорируется; уровень доверия назначает само приложение.',
  'skills.import.note.manifestJsonConflict':
    'Поле «{field}» в файле manifest.json из пакета отличается от значения в файле SKILL.md; ' +
    'используется значение из файла SKILL.md.',
  'skills.replace.title': 'Использовать этот навык вместо другого?',
  'skills.replace.body':
    'Включен другой навык с таким же именем. Если включить этот, другой будет выключен.',
  'skills.replace.confirm': 'Включить',
  // ---- Settings → Privacy & data tab (PrivacyTab.tsx) ----
  'privacy.offlineOn': '● Офлайн-режим: включен',
  'privacy.offlineOff': '○ Доступ к сети включен',
  'privacy.statement.offline':
    'Офлайн-режим включен. Приложение HilbertRaum запускает ИИ-модель на вашем ноутбуке. Ваши ' +
    'запросы, документы, их векторные представления и история чатов хранятся локально.',
  'privacy.statement.online':
    'Приложение HilbertRaum запускает ИИ-модель на вашем ноутбуке. Ваши запросы, документы, их ' +
    'векторные представления и история чатов хранятся локально — даже при включенном доступе в ' +
    'интернет сеть используется только для скачивания (моделей, ИИ-движка, дополнительных ' +
    'инструментов для пакетов знаний и дополнительных файлов распознавания текста (OCR)).',
  'privacy.statement.noUploads':
    'Это приложение не отправляет ваши данные облачным ИИ-сервисам. Запросы, документы и ' +
    'векторные представления никуда не выгружаются; нет ни телеметрии, ни аналитики, ни ' +
    'удаленной отправки отчетов о сбоях.',
  'privacy.network.title': 'Текущее состояние сети',
  'privacy.networkState.noPolicy': 'Офлайн-режим включен.',
  'privacy.networkState.disabledByPolicy': 'Доступ к сети отключен политикой.',
  'privacy.networkState.offDefault': 'Офлайн-режим включен (по умолчанию сеть выключена).',
  'privacy.networkState.enabled':
    'Доступ в интернет включен для скачивания моделей, ИИ-движка и дополнительных инструментов ' +
    'для пакетов знаний.',
  'privacy.network.noFiles': 'Ни запросы, ни файлы не покидают это устройство.',
  'privacy.network.effective': 'Фактическое состояние',
  'privacy.network.effectiveOffline': 'Офлайн (без обращений к интернету)',
  'privacy.network.effectiveAllowed': 'Сеть разрешена',
  'privacy.network.byPolicy': 'Разрешено политикой',
  'privacy.network.policyYes': 'Да',
  'privacy.network.policyNo': 'Нет (отключено политикой)',
  'privacy.network.yourSetting': 'Ваша настройка',
  'privacy.network.settingAllowed': 'Доступ в интернет разрешен',
  'privacy.network.settingOff': 'Выключено (по умолчанию)',
  'privacy.network.telemetry': 'Телеметрия',
  'privacy.network.telemetryValue':
    'Ничто не покидает это устройство — отслеживания нет, и отключать нечего',
  'privacy.network.hint':
    'Приложение предупреждает перед любым действием в интернете. Скачивает оно только ИИ-модели, ' +
    'ИИ-движок, дополнительные инструменты для пакетов знаний и дополнительные файлы ' +
    'распознавания текста (OCR) — каждый раз только после вашего подтверждения и с проверкой ' +
    'перед использованием. По умолчанию это включено, а выключить можно на вкладке «Общие». ' +
    'Политика диска может полностью это запретить. Локальный API ниже — отдельная функция, ' +
    'которая включается только по вашему желанию и никогда не обращается к интернету.',
  'privacy.data.title': 'Где хранятся ваши данные',
  'privacy.data.driveRoot': 'Корень диска',
  'privacy.data.workspace': 'Рабочее пространство',
  'privacy.data.models': 'Модели',
  'privacy.data.logs': 'Журналы',
  'privacy.data.loading': 'Загрузка путей…',
  'privacy.data.hint':
    'Все данные — импортированные документы, извлеченный текст, векторные представления, история ' +
    'чатов, созданные результаты, настройки — хранятся локально в вашем рабочем пространстве. ' +
    'Чтобы удалить эти данные, удалите папку рабочего пространства.',
  'privacy.logs.title': 'Только локальные журналы',
  'privacy.logs.hintBefore':
    'Отладочные и диагностические журналы записываются в файл с ротацией в папке журналов, ' +
    'указанной выше, и ',
  'privacy.logs.never': 'никогда не отправляются',
  'privacy.logs.hintAfter': '. Диагностика ничего не передает за пределы этого устройства.',
  'privacy.protection.title': 'Защита рабочего пространства',
  'privacy.protection.encryptedBefore': 'Ваше рабочее пространство работает в режиме ',
  'privacy.protection.encryptedWord': 'с шифрованием',
  'privacy.protection.encryptedAfter': '.',
  'privacy.protection.plainBefore': 'Ваше рабочее пространство работает в режиме ',
  'privacy.protection.plainWord': 'разработчика без шифрования',
  'privacy.protection.plainAfter':
    '. Файлы хранятся на диске без шифрования, чтобы ускорить разработку.',
  'privacy.protection.plainWarning':
    'Режим разработчика без шифрования не используется по умолчанию в коммерческой версии. На ' +
    'коммерческих дисках применяется режим с шифрованием — ключ получается из пароля, ничего не ' +
    'хранится без шифрования. Не храните конфиденциальные документы в режиме без шифрования на ' +
    'общем или съемном диске.',
  // ---- Settings → Privacy & data → "Local API" card (local-api wave P4) ----
  'settings.localApi.title': 'Локальный API',
  'settings.localApi.lead':
    'Позволяет другим программам на этом компьютере отправлять текст вашей ИИ-модели и читать ' +
    'ответы. Функция выключена, пока вы ее не включите.',
  'settings.localApi.toggle':
    'Разрешить другим приложениям на этом компьютере использовать мою ИИ-модель',
  'settings.localApi.hint':
    'Подключение никогда не выходит за пределы этого компьютера — ничего не отправляется через ' +
    'интернет.',
  'settings.localApi.policyOff': 'Отключено политикой вашего диска.',
  'settings.localApi.confirm.title': 'Разрешить другим приложениям использовать вашу модель?',
  'settings.localApi.confirm.what':
    'Другие программы на этом компьютере смогут отправлять текст вашей ИИ-модели и читать ее ' +
    'ответы.',
  'settings.localApi.confirm.boundary':
    'Им не видны ваши документы, файлы и чаты, и через приложение HilbertRaum ничего не покидает ' +
    'этот компьютер. Но HilbertRaum не может контролировать, что подключенная программа делает с ' +
    'полученными ответами, — перед подключением проверьте, хранит или синхронизирует ли ' +
    'приложение свои данные.',
  'settings.localApi.confirm.persists': 'Функция остается включенной, пока вы ее не выключите.',
  'settings.localApi.confirm.neverStored':
    'Запросы других приложений получают ответ и сразу забываются — они не сохраняются ни в ' +
    'истории чатов, ни в журналах.',
  'settings.localApi.confirm.ack': 'Я понимаю, что смогут делать другие приложения.',
  'settings.localApi.confirm.cta': 'Включить',
  'settings.localApi.connect.title': 'Подключение другого приложения',
  'settings.localApi.connect.hint':
    'Вставьте эти два значения в приложение, которое хотите подключить. В большинстве приложений ' +
    'они называются «Base URL» и «API key».',
  'settings.localApi.connect.address': 'Адрес сервера',
  'settings.localApi.connect.key': 'Ключ доступа',
  'settings.localApi.connect.copy': 'Копировать',
  'settings.localApi.connect.copyAddressAria': 'Копировать адрес сервера',
  'settings.localApi.connect.copyKeyAria': 'Копировать ключ доступа',
  'settings.localApi.connect.copiedAddress': 'Адрес сервера скопирован.',
  'settings.localApi.connect.copiedKey':
    'Скопировано — буфер обмена автоматически очистится через минуту. Журнал буфера обмена ' +
    'Windows или синхронизация могут сохранить копии.',
  'settings.localApi.connect.copyFailed': 'Не удалось скопировать. Попробуйте еще раз.',
  'settings.localApi.connect.noKey': 'Пока требование ключа выключено, ключ доступа не нужен.',
  'settings.localApi.model.running': 'Модель работает — другие приложения могут получать ответы.',
  'settings.localApi.model.stopped':
    'Ни одна модель не запущена — другие приложения будут получать ошибку, пока вы не запустите ' +
    'модель.',
  'settings.localApi.status.port': 'Принимает подключения на порту {port}.',
  'settings.localApi.status.served.one': 'На данный момент обработан {count} запрос.',
  'settings.localApi.status.served.few': 'На данный момент обработано {count} запроса.',
  'settings.localApi.status.served.many': 'На данный момент обработано {count} запросов.',
  'settings.localApi.status.served.other': 'На данный момент обработано {count} запроса.',
  'settings.localApi.status.off': 'Не запущен.',
  'settings.localApi.busyWarning':
    'Сейчас вашу модель использует другое приложение. Если одновременно общаться здесь в чате, ' +
    'замедлится и то и другое — ваш собственный чат всегда обрабатывается первым.',
  'settings.localApi.preemptedWarning':
    'Только что ваша работа в приложении HilbertRaum прервала запрос другого приложения. Это ' +
    'приложение может просто повторить попытку.',
  'settings.localApi.token.toggle': 'Требовать ключ доступа',
  'settings.localApi.token.hint': 'Рекомендация: оставьте включенным.',
  'settings.localApi.token.confirm.title': 'Отключить ключ доступа?',
  'settings.localApi.token.confirm.body':
    'Без ключа доступа любая программа на этом компьютере сможет использовать вашу ИИ-модель без ' +
    'спроса. Оставьте ключ включенным, если только в приложении действительно некуда его ввести.',
  'settings.localApi.token.confirm.cta': 'Отключить',
  'settings.localApi.token.regenerate': 'Создать новый ключ',
  'settings.localApi.token.regenerate.title': 'Создать новый ключ доступа?',
  'settings.localApi.token.regenerate.body':
    'Приложения со старым ключом перестанут работать, пока вы не вставите в них новый ключ.',
  'settings.localApi.token.regenerate.cta': 'Создать новый ключ',
  'settings.localApi.token.regenerated': 'Новый ключ доступа создан.',
  'settings.localApi.token.regenerateFailed': 'Не удалось создать новый ключ. Попробуйте еще раз.',
  'settings.localApi.port.label': 'Номер порта',
  'settings.localApi.port.hint':
    'Меняйте его, только если этот номер уже занят другой программой. Допустимо от 1024 до 65535.',
  'settings.localApi.error.portInUse':
    'Этот номер уже использует другая программа на этом компьютере — это может также означать, ' +
    'что другая программа выдает себя за приложение HilbertRaum, поэтому никуда не вставляйте ' +
    'ключ доступа, пока не разберетесь с этим. Измените номер (например, {suggestion}) и ' +
    'включите снова; если какое-то приложение уже было подключено, вставьте в него и новый адрес ' +
    'сервера.',
  'settings.localApi.error.startFailed':
    'Не удалось запустить локальный API. Подробности — на вкладке «Диагностика».',
  // ---- Settings → Diagnostics tab (DiagnosticsTab.tsx) ----
  'diag.localOnly': 'Только локальная диагностика. Отсюда ничего никогда не отправляется.',
  'diag.localApi.label': 'Локальный API',
  'diag.localApi.off': 'Не запущен',
  'diag.localApi.running': 'Запущен · порт {port} · отвечено: {served}, отклонено: {rejected}',
  'diag.localApi.portInUse': 'Не запущен — номер порта уже занят',
  'diag.localApi.startFailed': 'Не запущен — запустить не удалось',
  'diag.audit.runtime_started': 'Модель запущена',
  'diag.audit.runtime_stopped': 'Модель остановлена',
  'diag.audit.runtime_crashed': 'Модель неожиданно остановилась',
  'diag.audit.runtime_fallback': 'Режим совместимости',
  'diag.audit.model_selected': 'Модель выбрана',
  'diag.audit.model_verified': 'Контрольная сумма модели проверена',
  'diag.audit.model_download_started': 'Скачивание начато',
  'diag.audit.model_download_verified': 'Скачанный файл проверен',
  'diag.audit.model_download_failed': 'Ошибка скачивания',
  'diag.audit.document_imported': 'Документ импортирован',
  'diag.audit.document_reindexed': 'Документ переиндексирован',
  'diag.audit.document_deleted': 'Документ удален',
  'diag.audit.document_task_completed': 'Задача с документом завершена',
  'diag.audit.document_task_failed': 'Задача с документом завершилась ошибкой',
  'diag.audit.document_exported': 'Документ экспортирован',
  'diag.audit.summary_exported': 'Краткое содержание экспортировано',
  'diag.audit.conversation_deleted': 'Чат удален',
  'diag.audit.conversation_exported': 'Чат экспортирован',
  'diag.audit.message_table_exported': 'Таблица из ответа экспортирована',
  'diag.audit.code_block_exported': 'Блок кода сохранен в файл',
  'diag.audit.workspace_created': 'Рабочее пространство создано',
  'diag.audit.workspace_unlocked': 'Рабочее пространство разблокировано',
  'diag.audit.workspace_locked': 'Рабочее пространство заблокировано',
  'diag.audit.workspace_unlock_failed': 'Неудачная попытка разблокировки',
  'diag.audit.workspace_lock_failed':
    'Неудачная попытка блокировки (рабочее пространство осталось открытым)',
  'diag.audit.workspace_password_changed': 'Пароль рабочего пространства изменен',
  'diag.audit.settings_changed': 'Настройки изменены',
  'diag.audit.local_api_toggled': 'Локальный API включен или выключен',
  'diag.audit.policy_warning': 'Уведомление о политике',
  'diag.audit.offline_guard_violation': 'Замечена попытка доступа к сети',
  'diag.audit.collection_created': 'Проект создан',
  'diag.audit.collection_renamed': 'Проект переименован',
  'diag.audit.collection_archived': 'Проект перемещен в архив или возвращен из архива',
  'diag.audit.collection_deleted': 'Проект удален',
  'diag.audit.documents_added_to_collection': 'Документы добавлены в проект',
  'diag.audit.documents_removed_from_collection': 'Документы убраны из проекта',
  'diag.audit.document_lifecycle_changed': 'Статус документа изменен',
  'diag.audit.skill_imported': 'Навык импортирован',
  'diag.audit.skill_deleted': 'Навык удален',
  'diag.audit.skill_enabled': 'Навык включен',
  'diag.audit.skill_disabled': 'Навык выключен',
  'diag.audit.skill_run_started': 'Инструмент навыка запущен',
  'diag.audit.skill_run_done': 'Инструмент навыка завершил работу',
  'diag.audit.skill_run_failed': 'Инструмент навыка завершился ошибкой',
  'diag.audit.evidence_review_created': 'Проверка подтверждений создана',
  'diag.audit.evidence_review_ready': 'Проверка подтверждений завершена',
  'diag.audit.evidence_review_deleted': 'Проверка подтверждений удалена',
  'diag.audit.evidence_pack_exported': 'Пакет подтверждений экспортирован',
  'diag.audit.knowledge_pack_added': 'Пакет знаний добавлен',
  'diag.audit.knowledge_pack_removed': 'Пакет знаний убран',
  'diag.audit.knowledge_pack_article_saved': 'Статья из пакета знаний сохранена как документ',
  'diag.accel.gpuFallbackName': 'название неизвестно',
  'diag.accel.gpu': 'Видеокарта — {name}',
  'diag.accel.mock': 'Встроенный демо-режим',
  'diag.app.engine': 'ИИ-движок',
  'diag.app.voiceEngine': 'Голосовой движок',
  'diag.engine.cannotRun': 'Не запускается — {reason}',
  'diag.engine.reason.libraryMissing': 'нет системной библиотеки',
  'diag.engine.reason.systemTooOld': 'слишком старая версия системы',
  'diag.engine.reason.filesDamaged': 'файлы движка отсутствуют или повреждены',
  'diag.engine.reason.filesDamagedAfterInstall':
    'файлы движка отмечены как поврежденные сразу после новой установки',
  'diag.engine.reason.vcRuntimeMissing': 'нет пакета Microsoft Visual C++ Redistributable',
  'diag.engine.reason.blocked': 'запуск заблокирован защитой Windows',
  'diag.accel.cpu': 'Процессор',
  'diag.accel.gpuAvailable': 'Доступна видеокарта — {name}',
  'diag.app.title': 'Приложение и движок',
  'diag.app.version': 'Версия приложения',
  'diag.app.unknown': 'неизвестно',
  'diag.app.selectedModel': 'Выбранная модель',
  'diag.app.noneSelected': 'не выбрана',
  'diag.app.profile': 'Профиль оборудования',
  'diag.app.runtime': 'Движок',
  'diag.app.unknownModel': 'неизвестная модель',
  'diag.app.onPort': ' на 127.0.0.1:{port}',
  'diag.app.healthy': 'в норме',
  'diag.app.unhealthy': 'не в норме',
  'diag.app.runtimeRunning': 'Работает — {model}{onPort} ({health})',
  'diag.app.stopped': 'Остановлен',
  'diag.app.acceleration': 'Ускорение',
  'diag.app.runtimeBuild': 'Сборка движка',
  'diag.app.noInstallMarker': 'нет отметки об установке (диск подготовлен вручную)',
  'diag.app.engineVersions': 'Версии движков',
  'diag.engineVersion.older': '{engine} {installed}, это приложение ожидает {pinned}',
  'diag.engineVersion.newer': '{engine} {installed}, новее, чем ожидает это приложение ({pinned})',
  'diag.engineVersion.unknown': '{engine}: версия не записана, это приложение ожидает {pinned}',
  'diag.engineVersion.cpuNet': '{engine} (резервная сборка для процессора)',
  'diag.gpu.compat':
    'Включен режим совместимости: ответы формируются на процессоре — это работает на любом ' +
    'компьютере.',
  'diag.gpu.tryHint': 'Если вы обновили драйвер видеокарты, можно снова попробовать видеокарту.',
  'diag.gpu.offHint':
    'Ускорение на видеокарте выключено на экране «Настройки» — включите его там, чтобы снова ' +
    'использовать видеокарту.',
  'diag.gpu.tryAgain': 'Снова попробовать видеокарту',
  'diag.gpu.tryFailed': 'Повторная попытка использовать видеокарту не удалась: {error}',
  'diag.refresh': 'Обновить',
  // ---- Performance screen (PerformanceScreen.tsx; benchmark.md "Performance screen") ----
  'perf.title': 'Скорость',
  'perf.lead':
    'С какой скоростью ваша ИИ-модель работает на этом компьютере — измерено на этом устройстве. ' +
    'Ничего никуда не отправляется.',
  'perf.card.title': 'Этот компьютер',
  'perf.checkedAt': 'Проверено {when}',
  'perf.notChecked': 'Еще не проверено',
  'perf.otherMachine':
    'Этот результат измерен на другом компьютере. Нажмите «Проверить снова», чтобы измерить этот.',
  'perf.report.otherComputer': 'Другой компьютер: {cpu}, {ram} GB оперативной памяти',
  'perf.verdict.speed': 'Модель {model} работает со скоростью около {tps} tok/s.',
  'perf.verdict.noSpeed':
    'Модель {model} лучше всего подходит для этого компьютера по объему памяти ({basis}). ' +
    'Скорость измеряется после первого запуска модели.',
  'perf.basis.discrete': 'видеопамять',
  'perf.basis.unified': 'общая память',
  'perf.basis.cpu': 'оперативная память',
  'perf.recommendation.atCheckTime': 'Рекомендация на момент проверки',
  'perf.recommendation.next': 'Рекомендация для следующего запуска',
  'perf.recommendation.nextOnThisComputer':
    'Рекомендация для следующего запуска на этом компьютере',
  'perf.verdict.noRecommendation': 'В каталоге пока нет модели, подходящей для этого компьютера.',
  'perf.verdict.notChecked':
    'Быстрая проверка измеряет память, скорость диска и — когда модель запущена — скорость ' +
    'генерации.',
  'perf.verdict.driveFast': 'Модели запускаются с этого диска быстро.',
  'perf.verdict.driveSlow': 'Модели запускаются с этого диска медленно.',
  'perf.tile.speed': 'Скорость',
  'perf.tile.speed.unit': 'tok/s',
  'perf.tile.speed.sub': 'Измерено {when} с моделью {model}',
  'perf.tile.speed.approx': 'Приблизительно: по числу фрагментов ответа, а не по замерам движка',
  'perf.tile.speed.chunks': 'фрагментов: {chunks}',
  'perf.tile.speed.none': 'Еще не измерено',
  'perf.tile.speed.noneHint': 'Запустите модель и проверьте еще раз',
  'perf.tile.memory': 'Память',
  'perf.tile.memory.unit': 'GB оперативной памяти',
  'perf.tile.memory.unified': 'Общая память',
  'perf.tile.memory.unifiedSub': 'Общая для процессора и графических ядер',
  'perf.model.title': 'Ваша модель',
  'perf.model.line.one': '{model} · {size} GB на диске · контекст: {context} токен',
  'perf.model.line.few': '{model} · {size} GB на диске · контекст: {context} токена',
  'perf.model.line.many': '{model} · {size} GB на диске · контекст: {context} токенов',
  'perf.model.line.other': '{model} · {size} GB на диске · контекст: {context} токена',
  'perf.model.none': 'Модель еще не выбрана. Выберите ее на экране «ИИ-модель».',
  'perf.model.need': 'С этим размером контекста модель занимает {need} GB.',
  'perf.model.needEstimate':
    'Нужно не менее {need} GB для весов модели, плюс кеш контекста, который измеряется при ' +
    'первом запуске.',
  'perf.model.gpu':
    'Модель помещается в видеопамять ({budget} GB): все слои ({layers}) на видеокарте.',
  'perf.model.gpuEstimate': 'Модель должна поместиться в видеопамять ({budget} GB).',
  'perf.model.partial':
    'Видеопамять вмещает {budget} GB. Слоев на видеокарте: {gpuLayers} из {layers}, около ' +
    '{spill} GB работает в оперативной памяти. Ответы приходят медленнее.',
  'perf.model.partialFree':
    'Слоев на видеокарте: {gpuLayers} из {layers}, около {spill} GB работает в оперативной ' +
    'памяти: при запуске модели на видеокарте было свободно только {free} GB из {budget} GB, а ' +
    'движок держит страховочный резерв {margin} GB. Ответы приходят медленнее. Перезапустите ' +
    'модель, когда видеокарта освободится.',
  'perf.model.partialMargin':
    'Слоев на видеокарте: {gpuLayers} из {layers}, около {spill} GB работает в оперативной ' +
    'памяти. Видеокарта была свободна (свободно {free} из {budget} GB), но движок дополнительно ' +
    'отводит {working} GB под рабочие буферы и {margin} GB под страховочный резерв и переносит ' +
    'целые слои с видеокарты, когда сумма подходит к пределу. Ответы приходят медленнее.',
  'perf.model.partialMarginNoWorking':
    'Слоев на видеокарте: {gpuLayers} из {layers}, около {spill} GB работает в оперативной ' +
    'памяти. Видеокарта была свободна (свободно {free} из {budget} GB), но движок дополнительно ' +
    'отводит память под рабочие буферы и {margin} GB под страховочный резерв и переносит целые ' +
    'слои с видеокарты, когда сумма подходит к пределу. Ответы приходят медленнее.',
  'perf.model.partialEstimate':
    'Видеопамять вмещает {budget} GB: около {spill} GB будет работать в оперативной памяти. ' +
    'Ответы будут приходить медленнее.',
  'perf.model.cpu': 'Модель работает на процессоре, в оперативной памяти ({budget} GB).',
  'perf.model.cpuEstimate':
    'Модель будет работать на процессоре, в оперативной памяти ({budget} GB).',
  'perf.model.unified':
    'Модель помещается в общую память ({ram} GB, для модели доступно до {budget} GB).',
  'perf.model.unifiedEstimate':
    'Модель должна поместиться в общую память ({ram} GB, для модели доступно до {budget} GB).',
  'perf.model.tooLarge':
    'Модель слишком велика для этого компьютера (доступно {budget} GB). Выберите модель поменьше.',
  'perf.model.unknown': 'Размещение модели измеряется при ее первом запуске на этом компьютере.',
  'perf.model.unknownObserved': 'Движок не сообщил, где разместилась модель.',
  'perf.model.perDrive':
    'Диск хранит одну запись на каждую модель, поэтому запуск на другом компьютере заменяет ' +
    'запись, сделанную здесь.',
  'perf.model.measuredOther.one':
    'Ранее измерено {when} с контекстом в {context} токен; оценка выше относится к текущим ' +
    'настройкам.',
  'perf.model.measuredOther.few':
    'Ранее измерено {when} с контекстом в {context} токена; оценка выше относится к текущим ' +
    'настройкам.',
  'perf.model.measuredOther.many':
    'Ранее измерено {when} с контекстом в {context} токенов; оценка выше относится к текущим ' +
    'настройкам.',
  'perf.model.measuredOther.other':
    'Ранее измерено {when} с контекстом в {context} токена; оценка выше относится к текущим ' +
    'настройкам.',
  'perf.model.runningOnCard': 'Сейчас работает на видеокарте.',
  'perf.model.choose': 'Выбрать модель поменьше',
  'perf.models.title': 'Модели на этом компьютере',
  'perf.models.hint':
    'Чат и перевод используют видеокарту совместно. Модели для изображений, поиска по документам ' +
    'и распознавания речи намеренно работают на процессоре, поэтому занимают оперативную память, ' +
    'а не видеопамять.',
  'perf.role.chat': 'Чат',
  'perf.role.translation': 'Перевод',
  'perf.role.vision': 'Изображения',
  'perf.role.reranker': 'Поиск по документам (ранжирование)',
  'perf.role.embeddings': 'Поиск по документам (индекс)',
  'perf.role.transcriber': 'Распознавание речи',
  'perf.models.row': '{model} · {size} GB',
  'perf.models.rowNoSize': '{model}',
  'perf.models.none': 'Модель для этого не установлена.',
  'perf.models.device.gpu': 'видеокарта',
  'perf.models.device.cpu': 'процессор (так задумано)',
  'perf.models.device.processor': 'процессор',
  'perf.models.loaded': 'сейчас в памяти',
  'perf.models.notLoaded': 'не в памяти',
  'perf.models.lifetime.session': 'не выгружается',
  'perf.models.lifetime.idle': 'выгружается при простое',
  'perf.models.lifetime.per-use': 'работает только во время задачи',
  'perf.models.split': 'слоев на видеокарте: {gpuLayers} из {layers}',
  'perf.models.card': 'Видеокарта: чат {chat} GB + перевод {translation} GB, из {vram} GB.',
  'perf.models.cardReranker': 'Видеокарта: ранжирование {reranker} GB из {vram} GB.',
  'perf.models.cardBoth':
    'Сейчас на видеокарте обе модели. Та, что запустилась второй, получила оставшуюся память и ' +
    'работает медленнее; остановите и снова запустите ее, когда другая выгрузится.',
  'perf.models.ram':
    'Если загрузить все сразу, понадобится около {sum} GB из {ram} GB оперативной памяти.',
  'perf.models.memory':
    'Если загрузить все сразу, понадобится около {sum} GB из {budget} GB общей памяти, доступной ' +
    'моделям.',
  'perf.models.ramTooMuch': 'Слишком много сразу',
  'perf.models.ramOk': 'Хватает',
  'perf.place.gpu': 'На видеокарте',
  'perf.place.partial': 'Частично на видеокарте',
  'perf.place.cpu': 'На процессоре',
  'perf.place.tooLarge': 'Слишком велика',
  'perf.place.unknown': 'Не измерено',
  'perf.tile.graphics': 'Видеопамять',
  'perf.tile.graphics.unit': 'GB видеопамяти',
  'perf.tile.graphics.none': 'Подходящей видеокарты нет. Модели работают на процессоре.',
  'perf.tile.graphics.engine':
    'ИИ-движок не может работать на этом компьютере, поэтому видеокарту проверить не удалось.',
  'perf.tile.graphics.off': 'Ускорение на видеокарте выключено. Модели работают на процессоре.',
  'perf.tile.graphics.small': 'Меньше {min} GB: модели работают на процессоре.',
  'perf.tile.graphics.integrated':
    'Встроенная видеокарта, общая память: модели работают на процессоре.',
  'perf.tile.graphics.unitShared': 'GB общей памяти',
  'perf.tile.graphics.notRecorded': 'При той проверке данные о видеокарте не записывались.',
  'perf.rating.usable': 'Подходит',
  'perf.rating.small': 'Небольшая',
  'perf.rating.integrated': 'Встроенная',
  'perf.rating.notRecorded': 'Нет данных',
  'perf.rating.none': 'Нет',
  'perf.rating.unknown': 'Неизвестно',
  'perf.others.subGpu': '{cpu}, {ram} GB оперативной памяти, {vram} GB видеопамяти · {when}',
  'perf.tile.drive': 'Диск',
  'perf.tile.drive.unit': 'MB/s при чтении',
  'perf.tile.drive.load': 'Запуск модели {when}, прочитано {gb} GB',
  'perf.tile.drive.hash': 'Проверка файла {when}, прочитано {gb} GB',
  'perf.tile.drive.none': 'Еще не измерено',
  'perf.tile.drive.noneHint': 'Измеряется при первом запуске модели или первой проверке файла',
  'perf.rating.good': 'Хорошо',
  'perf.rating.slow': 'Медленно',
  'perf.rating.fast': 'Быстро',
  'perf.rating.pending': 'Ожидается',
  'perf.rating.approx': 'Приблизительно',
  'perf.rating.slowDrive': 'Медленный диск',
  'perf.profile.TINY': 'Минимальный',
  'perf.profile.LITE': 'Легкий',
  'perf.profile.BALANCED': 'Сбалансированный',
  'perf.profile.PRO': 'Продвинутый',
  'perf.profile.UNKNOWN': 'Не определен',
  'perf.check': 'Проверить этот компьютер',
  'perf.checkAgain': 'Проверить снова',
  'perf.running': 'Проверка…',
  'perf.startAndMeasure': 'Запустить модель {model} и измерить',
  'perf.contextSize': 'Изменить размер контекста',
  'perf.copy': 'Копировать отчет',
  'perf.autoNote':
    'Запускается автоматически в первый раз и каждый раз, когда этот диск подключают к другому ' +
    'компьютеру.',
  'perf.failed': 'Проверка не удалась: {error}',
  'perf.loadFailed': 'Не удалось прочитать последние значения: {error}',
  'perf.retry': 'Повторить',
  'perf.step.system': 'Оборудование определено',
  'perf.step.drive': 'Скорость диска',
  'perf.step.speed': 'Скорость генерации с моделью {model}',
  'perf.step.speedSkipped': 'Скорость генерации (модель не запущена, пропущено)',
  'perf.step.hint': 'Около полуминуты. Вы можете продолжать пользоваться приложением.',
  'perf.running.background': 'Проверка этого компьютера идет в фоновом режиме.',
  'perf.step.state.done': '{step}: готово',
  'perf.step.state.active': '{step}: выполняется',
  'perf.step.state.todo': '{step}: ожидание',
  'perf.observed.title': 'Наблюдения во время работы',
  'perf.observed.hint':
    'Реальные значения из обычной работы, а не из тестового запроса. Эти строки хранятся только ' +
    'в текущем сеансе; показанные в них скорости чтения также сохраняются вместе со значениями ' +
    'диска выше.',
  'perf.observed.none':
    'В этом сеансе пока нет наблюдений. Задайте модели вопрос или запустите ее.',
  'perf.observed.answer': 'Последний ответ: {tps} tok/s, {ttft} s до первого токена',
  'perf.observed.answerSub': '{model}, {when}, токенов: {tokens}',
  'perf.observed.load': 'Запуск модели: {seconds} s',
  'perf.observed.loadSub': '{model}, с этого диска прочитано {gb} GB со скоростью {mbps} MB/s',
  'perf.observed.check': 'Проверка файла: {seconds} s',
  'perf.observed.checkSub': 'Полная проверка файла модели {model} ({when}), прочитано {gb} GB',
  'perf.observed.oncePerModel': 'Один раз на модель',
  'perf.others.title': 'Другие компьютеры, на которых использовался этот диск',
  'perf.others.hint':
    'Каждый компьютер хранит собственный результат, поэтому рекомендуемая модель зависит от ' +
    'компьютера, а не от диска.',
  'perf.others.none': 'Пока нет. Подключите диск к другому компьютеру — проверка запустится сама.',
  'perf.others.row': '{tps} tok/s с моделью {model}',
  'perf.others.rowNoSpeed': 'Рекомендуется модель {model}, скорость не измерена',
  'perf.others.sub': '{cpu}, {ram} GB оперативной памяти · {when}',
  'perf.others.load': 'запуск модели {seconds} s',
  'perf.others.check': 'проверка файла {seconds} s',
  'perf.footer':
    'Полный технический отчет со всеми исходными значениями находится на экране «Настройки» на ' +
    'вкладке «Диагностика».',
  'perf.footerLink': 'Открыть вкладку «Диагностика»',
  'perf.unknownModel': '(название неизвестно)',
  'perf.unknownCpu': 'Неизвестный процессор',
  'diag.bench.title': 'Проверка скорости оборудования',
  'diag.bench.hint':
    'Исходные значения последней проверки на этом компьютере — для сообщения в поддержку. Что ' +
    'они означают, объясняет экран «Скорость»; там же можно запустить новую проверку. Все ' +
    'измеряется офлайн — никакие данные не покидают ваш компьютер.',
  'diag.bench.empty':
    'На этом компьютере еще не было проверки. Откройте экран «Скорость», чтобы запустить ее.',
  'diag.bench.profile': 'Назначенный профиль',
  'diag.bench.noMatch': 'Нет подходящей модели',
  'diag.bench.ram': 'Оперативная память',
  'diag.bench.cpu': 'Процессор',
  'diag.bench.cores.one': ' ({count} ядро)',
  'diag.bench.cores.few': ' ({count} ядра)',
  'diag.bench.cores.many': ' ({count} ядер)',
  'diag.bench.cores.other': ' ({count} ядра)',
  'diag.bench.osArch': 'Операционная система / архитектура',
  'diag.bench.gpu': 'Видеокарта',
  'diag.bench.notDetected': 'не обнаружена',
  'diag.bench.effectiveRead': 'Измеренная скорость чтения',
  'diag.bench.effectiveReadNone': 'еще не измерена — измеряется при запуске модели',
  'diag.bench.effectiveReadLoad': 'запуск модели {when}, прочитано {gb} GB',
  'diag.bench.effectiveReadHash': 'проверка файла {when}, прочитано {gb} GB',
  'diag.bench.driveWrite': 'Запись на диск',
  'diag.bench.notMeasured': 'не измерено',
  'diag.bench.tokens': 'Скорость генерации (tok/s)',
  'diag.bench.tokensNotMeasured': 'не измерено (сначала запустите модель)',
  'diag.bench.tokensModel': 'измерено с загруженной моделью {model}',
  'diag.bench.tokensOver': 'токенов в замере: {tokens}',
  'diag.bench.tokensApprox': 'приблизительно — по числу фрагментов ответа, а не по замерам движка',
  'diag.bench.lastRun': 'Последняя проверка',
  'diag.system.title': 'Система',
  'diag.system.osPlatform': 'Операционная система / платформа',
  'diag.system.freeSpace': 'Свободное место',
  'diag.system.imagesSize': 'Размер истории изображений',
  'diag.system.loadFailed':
    'Пока не удалось загрузить сведения о системе. Попробуйте открыть эту вкладку заново.',
  'diag.paths.title': 'Пути',
  'diag.paths.prepared': 'Подготовленный диск',
  'diag.paths.yes': 'Да',
  'diag.paths.noFallback': 'Нет (резервная папка данных приложения)',
  'diag.paths.writable': 'Доступен для записи',
  'diag.paths.no': 'Нет',
  'diag.paths.loadFailed':
    'Пока не удалось загрузить сведения о диске и рабочем пространстве. Попробуйте открыть эту ' +
    'вкладку заново.',
  'diag.activity.title': 'Журнал действий',
  'diag.activity.hint':
    'Локальная запись того, что делало приложение: запуски моделей, скачивания, импорт ' +
    'документов, события рабочего пространства. Журнал хранится в вашем рабочем пространстве (в ' +
    'зашифрованном виде, если рабочее пространство зашифровано) и никогда не отправляется. В нем ' +
    'никогда нет текста чатов или содержимого документов.',
  'diag.activity.show': 'Показать журнал действий',
  'diag.activity.hide': 'Скрыть журнал действий',
  'diag.activity.export': 'Экспортировать в файл…',
  'diag.activity.savedTo': 'Журнал действий сохранен: {path}',
  'diag.activity.filterShow': 'Показывать',
  'diag.activity.filterAll': 'Все действия',
  'diag.activity.loading': 'Загрузка…',
  'diag.activity.empty':
    'Пока ничего не записано — действия появятся здесь, когда вы начнете работать с приложением.',
  'diag.activity.earlier': 'Показать более ранние действия',
  'diag.logs.title': 'Последние записи журнала',
  'diag.logs.hintBefore': 'Последние строки файла ',
  'diag.logs.hintAfter':
    ' на этом устройстве. Журналы хранятся только локально и никогда не отправляются; в них нет ' +
    'содержимого документов и текста чатов.',
  'diag.logs.show': 'Показать журнал',
  'diag.logs.hide': 'Скрыть журнал',
  'diag.logs.empty': '(журнал пуст)',
  'diag.logs.save': 'Сохранить в файл…',
  'diag.logs.savedTo': 'Журнал сохранен: {path}',
  'diag.copy': 'Копировать',
  'diag.copyTitle': 'Копировать эти сведения в буфер обмена',
  'diag.copied': 'Скопировано в буфер обмена',
  'diag.copyFailed': 'Не удалось скопировать в буфер обмена',
  // ---- Shared components' built-in copy (receive a bound t — i18n record §5 ⑤) ----
  'common.dismiss': 'Скрыть',
  'common.close': 'Закрыть',
  'common.cancel': 'Отмена',
  'common.remove': 'Убрать',
  'common.apply': 'Применить',
  'indicator.offline': 'Локально · Офлайн',
  'indicator.online': 'Локально · Скачивание разрешено',
  'indicator.offlineDetail': 'Все остается на этом диске. Подключение к интернету не используется.',
  'indicator.onlineDetail': 'Скачивание разрешено — чаты и документы хранятся локально.',
  'indicator.short.offline': 'Офлайн',
  'indicator.short.online': 'Скачивание включено',
  'indicator.withLocalApi': '{state} · API включен',
  'indicator.localApiDetail':
    'Другие приложения на этом компьютере могут использовать вашу модель. Ничто не покидает этот ' +
    'компьютер.',
  // ---- Shared password copy ----
  'password.mismatch': 'Пароли не совпадают.',
  'password.show': 'Показать пароль',
  'password.hide': 'Скрыть пароль',
  'password.strength.tooShort': 'Слишком короткий',
  'password.strength.weak': 'Слабый',
  'password.strength.okay': 'Средний',
  'password.strength.strong': 'Надежный',
  'password.strength.veryStrong': 'Очень надежный',
  'password.strength.minHint': 'Используйте не менее 8 символов.',
  'password.strength.longerHint':
    'Чем длиннее, тем надежнее — подойдут 12 символов и больше или несколько не связанных между ' +
    'собой слов.',
  // ---- Workspace gate (WorkspaceGate.tsx) ----
  'gate.passwordPlaceholder': 'Пароль',
  'gate.unlock.title': 'Разблокировка рабочего пространства',
  'gate.unlock.hint':
    'Введите пароль, чтобы открыть рабочее пространство на этом диске. Все остается на этом ' +
    'диске.',
  'gate.unlock.submit': 'Разблокировать',
  'gate.unlock.submitBusy': 'Разблокировка…',
  'gate.welcome.title': 'Добро пожаловать',
  'gate.welcome.intro':
    'Это ваше личное рабочее пространство с ИИ. Общайтесь с ИИ-моделью в чате и задавайте ' +
    'вопросы по своим документам — все работает прямо с этого диска.',
  'gate.welcome.stays': 'Все остается на этом диске.',
  'gate.welcome.staysRest': 'Без интернета, без учетной записи, без отслеживания.',
  'gate.welcome.start': 'Начать',
  'gate.finishing.title': 'Настройка…',
  'gate.finishing.hint':
    'Проверка того, что уже есть на этом диске. Первая проверка большого файла ИИ-модели может ' +
    'занять несколько минут.',
  'gate.finishing.progress': 'Проверка ИИ-модели {n} из {m}: {name} — {pct}%',
  'gate.finishing.skip': 'Пропустить — перейти в приложение',
  'gate.starter.title': 'Последний шаг',
  'gate.starter.noModel':
    'На этом диске пока не установлена ни одна ИИ-модель — без нее чат не сможет отвечать. ' +
    'Добавить модель можно сейчас или в любой момент позже на экране «ИИ-модель».',
  'gate.starter.optional':
    'Скачивать модель не обязательно, и перед скачиванием всегда запрашивается ваше ' +
    'подтверждение. Ваши документы и чаты в любом случае никогда не используют интернет.',
  'gate.starter.skip': 'Пока пропустить',
  'gate.starter.addDocuments': 'Добавить документы',
  'gate.starter.chooseModel': 'Выбрать ИИ-модель',
  'gate.create.title': 'Создание пароля',
  'gate.create.hint':
    'Этот пароль защищает все в вашем рабочем пространстве на этом диске — документы, чаты и ' +
    'заметки. Восстановить или сбросить его невозможно, поэтому выберите то, что вы запомните.',
  'gate.create.plaintextToggle': 'Использовать рабочее пространство разработчика без шифрования',
  'gate.create.plaintextWarning':
    'В режиме без шифрования ваши данные хранятся на этом диске в незашифрованном виде. ' +
    'Используйте его только для разработки.',
  'gate.create.confirmPlaceholder': 'Подтверждение пароля',
  'gate.create.back': 'Назад',
  'gate.create.submit': 'Создать рабочее пространство',
  'gate.create.submitBusy': 'Создание…',
  'gate.error.generic': 'Что-то пошло не так. Попробуйте еще раз.',
  // ---- Main-process strings (Phase 41, i18n record §3.3 two-rule boundary) --------------
  'main.ingest.pdfScanDetected': 'Этот PDF-файл похож на скан — в нем пока нет читаемого текста.',
  'main.ingest.audioNeedsTranscriber':
    'Для импорта аудио нужна модель распознавания речи — скачайте ее на экране «ИИ-модель».',
  'main.ingest.audioNeedsEngine':
    'Для импорта аудио нужен голосовой движок — установите его на экране «ИИ-модель».',
  'main.ingest.audioNeedsModelAndEngine':
    'Для импорта аудио нужны модель распознавания речи и голосовой движок — добавьте и то, и ' +
    'другое на экране «ИИ-модель».',
  'main.ingest.audioEngineUnsupported':
    'Импорт аудио пока недоступен в этой операционной системе: приложение не может установить ' +
    'здесь нужный для этого голосовой движок.',
  'main.ingest.audioUnreadable':
    'Не удалось прочитать этот аудиофайл. Преобразуйте его в WAV или MP3 и импортируйте снова.',
  'main.ingest.audioTranscriptionFailed':
    'Не удалось преобразовать запись в текст. Переиндексируйте этот документ, чтобы попробовать ' +
    'еще раз.',
  'main.ingest.engineCannotRun':
    'ИИ-движок не может работать на этом компьютере, поэтому этот документ не удалось ' +
    'проиндексировать. Что делать, показано на экране «ИИ-модель» — затем попробуйте еще раз.',
  'main.ingest.engineLibraryMissing':
    'ИИ-движок не может работать на этом компьютере, потому что отсутствует системная библиотека ' +
    '{library}. Как это исправить, показано на экране «ИИ-модель» — затем попробуйте еще раз.',
  'main.ingest.voiceEngineCannotRun':
    'Голосовой движок не может работать на этом компьютере, поэтому эту запись не удалось ' +
    'преобразовать в текст. Что делать, показано на экране «ИИ-модель» — затем переиндексируйте ' +
    'этот документ.',
  'main.ingest.searchModelTimeout':
    'Модель поиска не ответила вовремя, поэтому этот документ не удалось проиндексировать. ' +
    'Попробуйте еще раз.',
  'main.ingest.searchModelCannotStart':
    'Модель поиска не запустилась, поэтому этот документ не удалось проиндексировать. На экране ' +
    '«ИИ-модель» нажмите «Проверить все файлы моделей», затем попробуйте еще раз.',
  'main.ingest.searchModelFailed':
    'В работе модели поиска возникла проблема, поэтому этот документ не удалось ' +
    'проиндексировать. Попробуйте еще раз.',
  'main.ingest.imageNeedsOcr':
    'Для импорта фотографий нужны файлы распознавания текста (OCR), а на этом диске их нет.',
  'main.ingest.imageNoText':
    'На этой фотографии не найдено читаемого текста. Попробуйте сделать более четкий снимок ' +
    'страницы с более близкого расстояния.',
  'main.ingest.imageOcrFailed':
    'Не удалось прочитать эту фотографию. Переиндексируйте ее, чтобы попробовать еще раз.',
  'main.ingest.imageOcrUnavailable':
    'Распознавание текста (OCR) не удалось запустить в этой сборке, поэтому фотография сохранена ' +
    'без читаемого текста. Переиндексируйте ее, когда распознавание текста станет доступно.',
  'main.ingest.sourceMissing': 'Исходный файл не найден на диске.',
  'main.ingest.interrupted':
    'Обработка документа прервана до завершения. Переиндексируйте его, чтобы попробовать еще раз.',
  'main.ingest.fileTooLarge':
    'Этот файл слишком большой для безопасного импорта. Разделите его на файлы поменьше и ' +
    'попробуйте еще раз.',
  'main.ingest.tooManyChunks':
    'Этот документ слишком большой, чтобы проиндексировать его полностью. Разделите его на файлы ' +
    'поменьше и импортируйте части.',
  'main.ingest.parseTimeout':
    'Обработка этого файла заняла слишком много времени, и он пропущен. Возможно, файл поврежден ' +
    'или очень большой.',
  'main.ingest.unsupportedType':
    'Этот тип файлов не поддерживается ({ext}). Используйте TXT, PDF, DOCX, CSV или ' +
    'поддерживаемый аудиоформат.',
  'main.rag.noContext':
    'В ваших документах ничего не найдено по этому вопросу. Попробуйте переформулировать вопрос ' +
    'или проверьте, по каким документам вы спрашиваете.',
  'main.rag.reindexNeeded':
    'Чтобы по вашим документам можно было искать, их нужно переиндексировать (это недолго) — они ' +
    'были подготовлены другой моделью поиска. Откройте экран «Документы» и выберите ' +
    '«Переиндексировать».',
  'main.chat.docTaskBusy':
    'Выполняется задача по документу. Можно отменить ее или дождаться окончания, прежде чем ' +
    'писать в чат.',
  'main.chat.defaultTitle': 'Новый чат',
  'main.evidenceReviews.defaultTitle': 'Проверка подтверждений',
  'main.benchmark.warnTiny':
    'Этому устройству лучше всего подходит самая маленькая и быстрая модель. Более крупные ' +
    'модели могут работать медленно.',
  'main.benchmark.warnUnknown':
    'Оборудование этого компьютера не удалось определить полностью, поэтому выбрана легкая ' +
    'модель, которая наверняка подойдет. Более крупную модель можно попробовать в любой момент.',
  'main.benchmark.warnDriveProbe':
    'Скорость диска измерить не удалось, поэтому рекомендация учитывает только оперативную ' +
    'память и процессор.',
  'main.benchmark.warnSlowDrive':
    'Этот диск не из самых быстрых. Модели все равно будут работать, но загружаться могут дольше.',
  'main.benchmark.warnSpeedSkipped':
    'Скорость генерации текста в этот раз не измерена, потому что модель была занята другой ' +
    'задачей. Профиль ниже учитывает только оперативную память, процессор и скорость диска — для ' +
    'полного замера повторите проверку скорости, когда модель ничем не занята.',
  'main.benchmark.warnSlowRead':
    'Скорость чтения с этого диска — около {mbps} MB/s. При запуске модели весь ее файл читается ' +
    'с этой скоростью, поэтому модели с этого диска будут запускаться медленно.',
  'main.benchmark.warnVeryLowTokens':
    'С загруженной моделью ({model}) текст генерировался очень медленно, поэтому назначенный ' +
    'профиль понижен на один уровень. Если эта модель больше рекомендуемой, запустите ' +
    'рекомендуемую модель и повторите проверку скорости.',
  'main.benchmark.warnRecommendationLowered':
    'С загруженной моделью ({model}) скорость генерации текста составила около {tps} tok/s, ' +
    'поэтому теперь рекомендуется модель на одну ступень меньше, чтобы ответы на этом компьютере ' +
    'приходили быстро.',
  'main.benchmark.locked':
    'Рабочее пространство заблокировано. Разблокируйте его, чтобы запустить проверку скорости.',
  'main.benchmark.lockedDuringRun':
    'Рабочее пространство было заблокировано во время проверки скорости, поэтому результат не ' +
    'сохранен. Запустите проверку скорости еще раз.',
  'main.dialog.openLink.title': 'Открыть эту ссылку в браузере?',
  'main.dialog.openLink.message': 'Открыть эту ссылку в браузере?',
  'main.dialog.openLink.site': 'Сайт: {site}',
  'main.dialog.openLink.truncated':
    'Здесь ссылка показана не полностью — скрыто символов: {hidden}.',
  'main.dialog.openLink.credentials':
    'Адрес содержит имя пользователя — на самом деле откроется сайт, указанный в строке «Сайт».',
  'main.dialog.openLink.hint':
    'Эта ссылка взята из ответа или манифеста модели, а не из приложения HilbertRaum. Ваш ' +
    'браузер подключится к этому сайту.',
  'main.dialog.openLink.open': 'Открыть',
  'main.dialog.openLink.cancel': 'Отмена',
  'main.workspace.wrongPassword':
    'Этот пароль не подошел к вашему рабочему пространству. Проверьте его и попробуйте еще раз.',
  'main.workspace.openFailed': 'Не удалось открыть рабочее пространство.',
  'main.workspace.vaultDamaged':
    'Ваш пароль верный, но данные рабочего пространства на диске повреждены, и открыть их не ' +
    'удалось. Повторный ввод пароля не поможет. Не создавайте новое рабочее пространство — ' +
    'оставьте файлы как есть и восстановите папку «workspace» из резервной копии.',
  'main.workspace.recoveryBlocked':
    'Пока не удалось открыть рабочее пространство: другая программа удерживает файл ' +
    'восстановления с вашими последними данными. Закройте все, что может сейчас сканировать диск ' +
    '(антивирус, индексирование поиска, окно файлового менеджера с папкой «workspace»), ' +
    'подождите немного и попробуйте еще раз. Ничего не потеряно.',
  'main.workspace.newer':
    'Это рабочее пространство записано более новой версией HilbertRaum — обновите приложение, ' +
    'чтобы открыть его. Ничего не изменено.',
  'main.workspace.createFailed': 'Не удалось создать рабочее пространство.',
  'main.workspace.passwordTooShort': 'Пароль должен содержать не менее {min} символов.',
  'main.workspace.newPasswordTooShort': 'Новый пароль должен содержать не менее {min} символов.',
  'main.workspace.unlockBeforeChange':
    'Прежде чем менять пароль, разблокируйте рабочее пространство.',
  'main.workspace.wrongCurrentPassword':
    'Пароль не совпадает с текущим. Проверьте его и попробуйте еще раз.',
  'main.workspace.changeFailed':
    'Не удалось сменить пароль. Ваш текущий пароль по-прежнему действует.',
  'main.workspace.busyPasswordChange':
    'Сейчас идет смена пароля рабочего пространства. Попробуйте еще раз чуть позже.',
  'main.workspace.lockFailed':
    'Не удалось заблокировать рабочее пространство — оно остается открытым, и ваши данные в ' +
    'безопасности. Освободите место на диске и попробуйте еще раз.',
  'main.runtime.compatibilityMode':
    'Для стабильности включен режим совместимости. Все продолжает работать — ответы могут ' +
    'приходить чуть медленнее.',
  'main.runtime.speedUpDisabled':
    'Для стабильности отключено дополнительное ускорение. Модель перезапускается — отправьте ' +
    'сообщение еще раз.',
  'main.runtime.crashRestarting':
    'ИИ-модель неожиданно остановилась и запускается снова. Через несколько секунд отправьте ' +
    'сообщение еще раз.',
  'main.runtime.crashStopped':
    'ИИ-модель снова неожиданно остановилась, поэтому она не перезапущена. Запустить ее снова ' +
    'можно на экране «ИИ-модель».',
  'main.runtime.modelCannotLoad':
    'Модель {model} не удалось загрузить на этом компьютере — ответы имитируются, пока вы не ' +
    'выберете другую модель.',
  'main.runtime.engineCannotRun':
    'ИИ-движок не может работать на этом компьютере, поэтому ответы имитируются. Чего не ' +
    'хватает, показано на экране «ИИ-модель».',
  'main.engine.cannotRun':
    'ИИ-движок не может работать на этом компьютере. Чего не хватает, показано на экране ' +
    '«ИИ-модель».',
  'main.noModelRunning':
    'Ни одна ИИ-модель не запущена. Откройте экран «ИИ-модель» и сначала запустите модель.',
  'main.modelStarting': 'ИИ-модель запускается. Попробуйте еще раз чуть позже.',
  'main.translation.noModel':
    'Для перевода нужна модель перевода, но на этом диске она не установлена. Скачать ее можно ' +
    'на экране «ИИ-модель».',
  'main.translation.startFailed':
    'Не удалось запустить модель перевода — возможно, на устройстве не хватает памяти. Закройте ' +
    'другие программы или перезапустите приложение HilbertRaum, затем попробуйте еще раз.',
  'main.translation.failedWindowNotice':
    '> ⚠ Эту часть ({part} из {total}) не удалось перевести — ниже без изменений оставлен ' +
    'исходный текст.',
  'main.translation.missingPageNotice':
    '> ⚠ Страница {page} оригинала не переведена — на ней нет читаемого текста (возможно, это ' +
    'отсканированное изображение).',
  'main.translation.missingPageRangeNotice':
    '> ⚠ Страницы {from}–{to} оригинала не переведены — на них нет читаемого текста (возможно, ' +
    'это отсканированные изображения).',
  'main.translation.attributionLine': 'Машинный перевод (модель {modelId}) — возможны ошибки.',
  'main.model.contextExceeded':
    'Это не помещается в контекст текущей модели. Увеличьте размер контекста на экране ' +
    '«ИИ-модель» (выбранный вручную размер служит пределом) или попробуйте документ поменьше.',
  'main.chat.streamInFlight': 'Ответ в этом чате уже формируется.',
  'main.chat.emptyCompletion':
    'Модель вернула пустой ответ. Попробуйте еще раз или переформулируйте сообщение.',
  'main.chat.runtimeUnresponsive':
    'ИИ-модель перестала отвечать. Попробуйте еще раз — если это повторяется, перезапустите ' +
    'модель на экране «ИИ-модель».',
  'main.chat.connectionLost':
    'ИИ-модель остановилась до завершения ответа. Отправьте сообщение еще раз — если это ' +
    'повторяется, перезапустите модель на экране «ИИ-модель».',
  'main.chat.streamError':
    'В работе ИИ-модели произошла ошибка, и ответ не был завершен. Попробуйте еще раз — если это ' +
    'повторяется, перезапустите модель на экране «ИИ-модель».',
  'main.chat.searchModelTimeout':
    'Модель поиска не ответила вовремя, поэтому не удалось выполнить поиск по вашим документам. ' +
    'Попробуйте еще раз.',
  'main.chat.searchModelCannotStart':
    'Модель поиска не запустилась, поэтому не удалось выполнить поиск по вашим документам. На ' +
    'экране «ИИ-модель» нажмите «Проверить все файлы моделей», затем попробуйте еще раз.',
  'main.chat.searchModelFailed':
    'При работе модели поиска возникла проблема, поэтому не удалось выполнить поиск по вашим ' +
    'документам. Попробуйте еще раз.',
  'main.chat.nothingToRegenerate': 'Пока нет ответа, который можно сформировать заново.',
  'main.chat.nothingToResend':
    'Этот вопрос больше не последнее сообщение в этом чате, поэтому его нельзя отправить еще раз.',
  'main.chat.skillUnavailable':
    'Этот навык больше недоступен — он выключен или удален. Включите его на экране «Настройки» ' +
    'на вкладке «Навыки» или спросите еще раз без него.',
  'main.chat.reviewBlocksRegenerate':
    'Для этого ответа есть проверка подтверждений. Новый ответ удалит эту проверку вместе с ' +
    'решениями и примечаниями — вместо этого задайте вопрос еще раз новым сообщением.',
  'main.chat.emptyMessage': 'Нельзя отправить пустое сообщение.',
  'main.chat.emptyQuestion': 'Нельзя отправить пустой вопрос.',
  'main.chat.stopFirst': 'Ответ в этом чате еще формируется. Сначала остановите его.',
  'main.chat.locked':
    'Рабочее пространство заблокировано. Разблокируйте его, чтобы пользоваться чатом.',
  'main.busy.chat':
    'Сейчас формируется ответ. Дождитесь его окончания (или остановите его), затем попробуйте ' +
    'еще раз.',
  'main.busy.docTask':
    'Модель занята задачей по документу. Дождитесь ее окончания или отмените ее, затем ' +
    'попробуйте еще раз.',
  'main.busy.skillRun':
    'Навык обрабатывает документ. Дождитесь окончания или отмените работу навыка на панели ' +
    'выполнения, затем попробуйте еще раз.',
  'main.busy.benchmark':
    'Сейчас на этом компьютере выполняется проверка скорости. Попробуйте еще раз чуть позже.',
  'main.task.unknownKind': 'Неизвестная задача для документа.',
  'main.task.refusedChatStreaming':
    'Сейчас формируется ответ. Дождитесь его завершения (или остановите его), затем попробуйте ' +
    'еще раз.',
  'main.task.comparePickTwo': 'Выберите ровно два документа для сравнения.',
  'main.task.compareReindex':
    'Перед сравнением эти документы нужно переиндексировать (это недолго) — хотя бы один из них ' +
    'подготовлен другой моделью поиска. Откройте экран «Документы», выберите «Переиндексировать» ' +
    'и попробуйте еще раз.',
  'main.task.documentNotReady':
    'В этом документе пока нет читаемого текста. Сначала импортируйте или переиндексируйте его, ' +
    'затем попробуйте еще раз.',
  'main.task.genericFailure':
    'Не удалось завершить задачу. Убедитесь, что модель по-прежнему работает, затем попробуйте ' +
    'еще раз.',
  'main.task.expired': 'Эта задача больше недоступна.',
  'main.task.translationTarget': 'Выберите поддерживаемый исходный язык и другой язык перевода.',
  'main.task.sourceUnreadable':
    'Не удалось прочитать сохраненную копию этого документа. Импортируйте документ заново, затем ' +
    'попробуйте еще раз.',
  'main.task.needsOcr':
    'Для распознавания текста нужны файлы OCR, а на этом диске их нет. Скачайте их кнопкой ' +
    '«Скачать файлы OCR» у отсканированного документа или на экране «ИИ-модель» — или, если вы ' +
    'настраивали диск сами, добавьте их командой «fetch-runtime --family ocr».',
  'main.task.ocrUnavailable':
    'Распознавание текста (OCR) недоступно в этой сборке: файлы OCR есть на этом диске, но ' +
    'запустить распознавание не удалось.',
  'main.task.ocrNotAScan':
    'Таким способом можно сделать доступным для поиска только PDF-файл, который определен как ' +
    'скан или содержит отсканированные страницы.',
  'main.task.ocrNoText':
    'В этом скане не найдено читаемого текста. Возможно, страницы пустые или слишком размытые.',
  'main.task.ocrFailed':
    'Не удалось прочитать этот скан. Убедитесь, что документ по-прежнему на диске, затем ' +
    'попробуйте еще раз.',
  'main.task.documentBusyIngesting':
    'Этот документ еще импортируется или переиндексируется. Дождитесь завершения, затем ' +
    'попробуйте еще раз.',
  'main.task.pickOneTranslate': 'Выберите ровно один документ для перевода.',
  'main.task.pickOneOcr':
    'Выберите ровно один отсканированный PDF-файл, который нужно сделать доступным для поиска.',
  'main.task.pickOneSummarize': 'Выберите ровно один документ, чтобы кратко изложить его.',
  'main.task.unavailable': 'Задачи для документов недоступны.',
  'main.task.workspaceLocked':
    'Рабочее пространство заблокировано. Разблокируйте его, чтобы работать с документами.',
  'main.download.policyDisabled': 'Скачивание отключено политикой этого диска.',
  'main.download.networkOff':
    'Доступ в интернет выключен. Сначала включите на экране «Настройки» переключатель «Разрешить ' +
    'доступ в интернет для скачивания моделей и обновлений».',
  'main.download.alreadyRunning': 'Уже идет другое скачивание. Модели скачиваются по одной.',
  'main.download.stoppedNetworkOff':
    'Доступ в интернет выключен, поэтому текущее скачивание остановлено. Чтобы завершить его, ' +
    'снова включите доступ в интернет на экране «Настройки».',
  'main.download.noSource': 'В манифесте модели «{modelId}» нет источника для скачивания.',
  'main.download.sourceWithdrawn':
    'Издатель модели «{modelId}» удалил именно этот файл, поэтому скачать его больше нельзя ' +
    '({reason}). Модели, которые уже есть на этом диске, продолжают работать.',
  'main.download.alreadyVerified': 'Эта модель уже скачана и проверена.',
  'main.download.presentUnverified':
    'Файл этой модели уже есть. В ее манифесте пока нет настоящей контрольной суммы, поэтому ' +
    'файл нельзя проверить — создайте ее командой «verify-models --generate».',
  'main.download.licenseFirst':
    'Перед скачиванием прочитайте и примите лицензию модели ({license}).',
  'main.download.notEnoughSpace':
    'На этом диске недостаточно свободного места: для скачивания нужно {needed}, а свободно ' +
    '{free}. Освободите место на диске или выберите модель поменьше.',
  'main.download.unknownJob': 'Неизвестное задание скачивания.',
  'main.download.checksumMismatch':
    'Контрольная сумма скачанного файла не совпала с ожидаемой, поэтому файл удален. Попробуйте ' +
    'еще раз.',
  'main.download.fileMissing': 'Скачанный файл пропал до того, как его удалось проверить.',
  'main.download.httpFailed':
    'Не удалось начать скачивание ({reason}). Проверьте подключение и попробуйте еще раз.',
  'main.download.interrupted':
    'Скачивание прервано ({reason}). Уже скачанная часть сохранена — при повторном запуске ' +
    'скачивание продолжится с того места, где остановилось.',
  'main.download.writeFailed':
    'Не удалось сохранить файл модели на этот диск. Убедитесь, что диск не заполнен и не защищен ' +
    'от записи, и попробуйте еще раз.',
  'main.download.resumeDiscarded':
    'Сервер прислал не ту часть файла, поэтому частично скачанные данные удалены. При повторном ' +
    'запуске скачивание начнется заново.',
  'main.engine.alreadyRunning': 'ИИ-движок уже скачивается.',
  'main.engine.noSources':
    'На этом диске не найдены источники движка (нет файла runtime-sources.yaml).',
  'main.engine.noHostBuild': 'Для этого компьютера нет сборки ИИ-движка.',
  'main.engine.alreadyInstalled': 'ИИ-движок уже установлен.',
  'main.engine.unknownJob': 'Неизвестное задание скачивания движка.',
  'main.engine.checksumMismatch':
    'Контрольная сумма скачанного движка не совпала с ожидаемой, поэтому он удален. Попробуйте ' +
    'еще раз.',
  'main.engine.fileMissing': 'Скачанный движок пропал до того, как его удалось проверить.',
  'main.engine.unverifiablePlaceholder':
    'У этого источника ИИ-движка нет настоящей контрольной суммы, поэтому скачанный файл не ' +
    'удалось проверить и он не установлен. Возможно, диск настроен неправильно.',
  'main.engine.binaryMissing':
    'Движок скачан, но распаковать его не удалось (возможно, изменилась структура архива).',
  'main.engine.extractFailed':
    'ИИ-движок скачан, но распаковать его не удалось. Попробуйте еще раз.',
  'main.engine.httpFailed':
    'Не удалось начать скачивание движка ({reason}). Проверьте подключение и попробуйте еще раз.',
  'main.engine.interrupted': 'Скачивание движка прервано ({reason}). Попробуйте еще раз.',
  'main.engine.runtimeRunning':
    'ИИ-движок нельзя заменить, пока работает модель. Остановите модель на экране «ИИ-модель» и ' +
    'попробуйте еще раз.',
  'main.engine.transcriptionRunning':
    'Голосовой движок нельзя заменить, пока идет распознавание аудио. Дождитесь окончания и ' +
    'попробуйте еще раз.',
  'main.engine.knowledgePackToolsRunning':
    'Инструменты для пакетов знаний нельзя заменить, пока используется пакет знаний. ' +
    'Заблокируйте рабочее пространство или дождитесь ответа на текущий вопрос и попробуйте еще ' +
    'раз — а если уведомление не исчезнет, перезапустите приложение.',
  'main.engine.badRequest': 'Запрос на установку движка не распознан. Попробуйте еще раз.',
  'main.engine.nothingToRepair':
    'Исправлять нечего: повреждений движка на этом диске не обнаружено.',
  'main.engine.nothingToUpdate':
    'Обновлять нечего: движки на этом диске уже той версии, которую использует это приложение, ' +
    'или новее.',
  'main.engine.updateBusy':
    'ИИ-движок сейчас занят (идет ответ, импорт, перевод или задача с документом). Повторите ' +
    'обновление, когда он освободится.',
  'main.ocr.badRequest':
    'Не удалось обработать запрос на скачивание файлов OCR. Попробуйте еще раз.',
  'main.ocr.alreadyRunning': 'Файлы OCR уже скачиваются.',
  'main.ocr.noSources':
    'На этом диске нет списка файлов OCR для скачивания. Вместо этого добавьте их с помощью ' +
    'скриптов настройки диска («fetch-runtime --family ocr»).',
  'main.ocr.sourcesMismatch':
    'Список файлов OCR для скачивания на этом диске не соответствует этой версии приложения ' +
    'HilbertRaum, поэтому ничего не скачано. Вместо этого добавьте файлы с помощью скриптов ' +
    'настройки диска («fetch-runtime --family ocr»).',
  'main.ocr.alreadyInstalled':
    'Файлы OCR уже есть на этом диске. Если распознавание текста по-прежнему не предлагается, ' +
    'перезапустите приложение HilbertRaum.',
  'main.ocr.unsafeFolder':
    'Папка «ocr» на этом диске — не обычная папка (возможно, она указывает на другое место), ' +
    'поэтому ничего не записано. Замените ее обычной папкой с именем «ocr», затем попробуйте еще ' +
    'раз.',
  'main.ocr.writeFailed':
    'Не удалось сохранить файлы OCR на этот диск. Убедитесь, что он не заполнен и не защищен от ' +
    'записи, затем попробуйте еще раз.',
  'main.ocr.downloadFailed':
    'Не удалось скачать файлы OCR. Проверьте подключение к интернету, затем попробуйте еще раз.',
  'main.ocr.checksumMismatch':
    'Контрольная сумма скачанного файла OCR не совпала с ожидаемой, поэтому файл удален — файлы, ' +
    'которые уже есть на этом диске, не изменены. Попробуйте еще раз.',
  'main.ocr.readFailed':
    'Не удалось прочитать файлы OCR, которые уже есть на этом диске, — возможно, диск отключен ' +
    'или файлы использует другая программа. Проверьте диск, затем попробуйте еще раз.',
  'main.ocr.unknownJob':
    'Это скачивание файлов OCR больше не отслеживается. Запустите его снова, если файлов ' +
    'по-прежнему нет.',
  'main.docs.locked':
    'Рабочее пространство заблокировано. Разблокируйте его, чтобы управлять документами.',
  'main.docs.processing': 'Этот документ еще обрабатывается. Дождитесь завершения импорта.',
  'main.docs.tooManyPaths': 'Выбрано слишком много файлов сразу. Выберите вместо этого папку.',
  'main.docs.taskRunning':
    'Для этого документа выполняется задача. Отмените ее или дождитесь завершения.',
  'main.docs.skillRunning':
    'С этим документом сейчас работает навык. Отмените его или дождитесь завершения.',
  'main.docs.previewEncrypted':
    'Этот документ зашифрован. Разблокируйте рабочее пространство, чтобы просмотреть его.',
  'main.docs.previewGone':
    'Файла документа больше нет на диске. Импортируйте его заново, чтобы просмотреть.',
  'main.docs.exportTextOnly':
    'Таким способом можно экспортировать только текстовые документы (Markdown, TXT, CSV).',
  'main.docs.exportEncrypted':
    'Этот документ зашифрован. Разблокируйте рабочее пространство, чтобы экспортировать его.',
  'main.docs.exportGone':
    'Файла документа больше нет на диске. Импортируйте его заново, чтобы экспортировать.',
  'main.docs.exportOriginalChanged':
    'Сохранилась только ваша собственная копия этого файла, и она изменилась после импорта, ' +
    'поэтому это уже не оригинал. Вместо него экспортируйте извлеченный текст.',
  'main.docs.noStoredTranscript':
    'Для этой записи пока не сохранен распознанный текст. Переиндексируйте ее, чтобы снова ' +
    'преобразовать речь в текст.',
  'main.models.noManifests':
    'На этом диске не найден список моделей — нет папки «model-manifests».',
  'main.models.autoSelected':
    'Эта модель используется автоматически после установки — выбирать ничего не нужно.',
  'main.models.locked':
    'Рабочее пространство заблокировано. Разблокируйте его, чтобы управлять ИИ-моделями.',
  'main.audit.locked':
    'Рабочее пространство заблокировано. Разблокируйте его, чтобы посмотреть журнал действий.',
  'main.settings.locked':
    'Рабочее пространство заблокировано. Разблокируйте его, чтобы изменить настройки.',
  'main.evidenceReviews.locked':
    'Рабочее пространство заблокировано. Разблокируйте его, чтобы работать с проверками ' +
    'подтверждений.',
  'main.evidenceReviews.invalidRequest': 'Этот запрос к проверке недействителен.',
  'main.evidenceReviews.exportNotRecorded':
    'Не удалось внести пакет подтверждений в историю экспорта, поэтому экспортированный файл ' +
    'удален. Ничего не сохранено — выполните экспорт еще раз.',
  'main.evidenceReviews.exportFileNotRecorded':
    'Файл пакета подтверждений сохранен, но его не удалось ни внести в историю экспорта, ни ' +
    'удалить. Его хеш не внесен в историю экспорта — выполните экспорт еще раз и замените этот ' +
    'файл.',
  'main.evidenceReviews.exportOutdated':
    'Эта проверка устарела — с момента ее создания изменился источник или ответ. Перед экспортом ' +
    'примите изменение к сведению в этой проверке.',
  'main.settings.invalidPatch': 'Это изменение настроек недопустимо и не сохранено.',
  'main.dictation.locked':
    'Рабочее пространство заблокировано. Разблокируйте его, чтобы пользоваться голосовым вводом.',
  'main.dictation.silent':
    'Звук с микрофона не поступил. Убедитесь, что звук микрофона не выключен и что в системных ' +
    'настройках приложению HilbertRaum разрешено его использовать, затем попробуйте еще раз.',
  'main.dictation.tooShort': 'Запись слишком короткая для распознавания речи — попробуйте еще раз.',
  'main.dictation.unavailable':
    'Голосовой ввод на этом диске пока недоступен — чего не хватает, показано на экране ' +
    '«ИИ-модель».',
  'main.dictation.failed': 'Не удалось преобразовать речь в текст — попробуйте еще раз.',
  'main.dictation.tooLong':
    'Эта запись слишком длинная для голосового ввода. Для длинных записей лучше импортировать ' +
    'аудиофайл как документ.',
  'main.dictation.busy': 'Предыдущая диктовка еще преобразуется в текст — подождите немного.',
  'main.dictation.engineCannotRun':
    'Голосовой движок не может работать на этом компьютере. Чего не хватает, показано на экране ' +
    '«ИИ-модель».',
  'main.preflight.readOnly':
    'Похоже, этот диск доступен только для чтения, поэтому приложение не может создать рабочее ' +
    'пространство. Попробуйте другой USB-порт или загляните в руководство по устранению ' +
    'неполадок.',
  'main.preflight.lowSpace':
    'На этом диске мало свободного места. Можно продолжить, но импорт больших документов может ' +
    'не удаться, пока вы не освободите место.',
  'main.dialog.importDocuments': 'Импорт документов',
  'main.dialog.importFolder': 'Импорт папки с документами',
  'main.dialog.exportDocument': 'Экспорт документа',
  'main.dialog.exportOriginal': 'Экспорт исходного файла',
  'main.dialog.exportSummary': 'Экспорт краткого содержания',
  'main.dialog.exportChat': 'Экспорт сообщений чата',
  'main.dialog.exportTableCsv': 'Экспорт таблицы в CSV',
  'main.dialog.exportCodeBlock': 'Сохранение блока кода в файл',
  'main.dialog.exportAudit': 'Экспорт журнала действий',
  'main.dialog.exportEvidencePack': 'Экспорт пакета подтверждений',
  'main.dialog.exportLog': 'Сохранение диагностических журналов',
  'main.dialog.filterDocuments': 'Документы',
  'main.dialog.filterAll': 'Все файлы',
  'main.zim.unavailable': 'Пакеты знаний недоступны в этом сеансе.',
  'main.zim.articleUnavailable':
    'Эта статья сейчас недоступна, поэтому ее не удалось сохранить. Возможно, пакет выключен или ' +
    'убран либо диск с ним отключен.',
  'main.zim.saveFailed': 'Не удалось добавить статью в ваши документы. Попробуйте еще раз.',
  'main.zim.dialogTitle': 'Добавить пакеты знаний',
  'main.zim.filterZim': 'Архивы ZIM',
  'main.dialog.chooseImage': 'Выбор изображения',
  'main.dialog.filterImages': 'Изображения',
  'main.images.unsupportedType': 'Файлы этого типа не поддерживаются. Выберите PNG, JPEG или WEBP.',
  'main.images.tooLarge':
    'Это изображение слишком большое для анализа. Попробуйте изображение поменьше.',
  'main.dialog.importSkill': 'Импорт пакета навыка',
  'main.dialog.importSkillFolder': 'Импорт папки навыка',
  'main.dialog.exportSkill': 'Экспорт навыка',
  'main.dialog.filterSkill': 'Пакет навыка',
  'main.dialog.exportCsv': 'Экспорт транзакций',
  'main.dialog.filterCsv': 'CSV-файл',
  'main.dialog.exportJson': 'Экспорт в JSON',
  'main.dialog.filterJson': 'JSON-файл',
  'main.dialog.exportXml': 'Экспорт в XML',
  'main.dialog.filterXml': 'XML-файл',
  'main.dialog.exportRedacted': 'Сохранение копии со скрытыми данными',
  'main.dialog.exportEdited': 'Сохранение отредактированной копии',
  'main.dialog.filterText': 'Текстовый файл',
  'main.dialog.filterDocx': 'Документ Word',
  'main.collections.builtinUndeletable':
    'Встроенные разделы «Библиотека» и «Временные» удалить нельзя.',
  'main.skills.locked':
    'Рабочее пространство заблокировано. Разблокируйте его, чтобы управлять навыками.',
  'main.skills.notPicked': 'Сначала выберите пакет навыка в окне выбора файла.',
  'main.skills.incompatible':
    'Этому навыку нужна более новая версия приложения. Обновите приложение, чтобы использовать ' +
    'навык.',
  'main.skills.run.unavailable': 'Инструмент этого навыка сейчас недоступен.',
  'main.skills.run.noDocument': 'Сначала добавьте документ в этот чат, затем попробуйте еще раз.',
  'main.skills.run.busy':
    'Навык уже работает. Дождитесь окончания или сначала отмените его работу.',
  'main.skills.run.documentOutOfScope':
    'Этого документа нет среди документов этого чата. Выберите один из них и попробуйте еще раз.',
  // ---- Document organization — Documents screen sections + actions (plan §12) ----
  'docs.section.heading': 'Разделы',
  'docs.section.library': 'Библиотека',
  'docs.section.projects': 'Проекты',
  'docs.section.temporary': 'Временные',
  'docs.section.generated': 'Созданные',
  'docs.section.archived': 'В архиве',
  'docs.section.all': 'Все документы',
  'docs.section.newProject': 'Новый проект',
  'docs.mode.aria': 'Режим экрана «Документы»',
  'docs.mode.documents': 'Мои документы',
  'docs.mode.packs': 'Пакеты знаний',
  'docs.filter.placeholder': 'Фильтр по названию…',
  'docs.filter.aria': 'Фильтровать документы по названию',
  'docs.filter.noMatch': 'Ни один документ не подходит под фильтр «{query}».',
  'docs.empty.packsLine':
    'Или добавьте пакет знаний — офлайн-версию Википедии, по которой может отвечать чат.',
  'docs.empty.packsAction': 'Пакеты знаний',
  'docs.rail.hide': 'Скрыть разделы',
  'docs.rail.show': 'Показать разделы',
  'docs.project.createTitle': 'Создание проекта',
  'docs.project.namePlaceholder': 'Название проекта',
  'docs.project.nameAria': 'Название проекта',
  'docs.project.create': 'Создать',
  'docs.project.rename': 'Переименовать',
  'docs.project.renameTitle': 'Переименование проекта',
  'docs.project.archive': 'Переместить в архив',
  'docs.project.unarchive': 'Вернуть из архива',
  'docs.project.delete': 'Удалить проект',
  'docs.project.deleteTitle': 'Удалить этот проект?',
  'docs.project.deleteBody': 'Выберите, что будет с документами этого проекта:',
  'docs.project.deleteKeep': 'Удалить только проект — документы оставить',
  'docs.project.deleteKeepHint': 'Документы останутся в вашей библиотеке и в других проектах.',
  'docs.project.deleteWith': 'Удалить проект и документы, которые есть только в нем',
  'docs.project.deleteWithHint':
    'Удаляются только документы, которых нет в вашей библиотеке или в другом проекте. Документы ' +
    'библиотеки не затрагиваются никогда.',
  'docs.project.archivedNote':
    'В архиве — проект скрыт как источник, но его документы по-прежнему доступны для вопросов в ' +
    'других местах.',
  'docs.project.options': 'Действия с проектом',
  'docs.action.moveToProject': 'Переместить в проект…',
  'docs.action.addToLibrary': 'Оставить в библиотеке',
  'docs.action.removeFromProject': 'Убрать из этого проекта',
  'docs.action.markTemporary': 'Перенести во временные',
  'docs.action.markPermanent': 'Сделать постоянным',
  'docs.action.archive': 'Переместить в архив',
  'docs.action.unarchive': 'Вернуть из архива',
  'docs.action.chooseProject': 'Выбор проекта',
  'docs.chip.library': 'Библиотека',
  'docs.chip.temporary': 'Временный',
  'docs.chip.generated': 'Созданный',
  'docs.chip.archived': 'В архиве',
  'docs.bulk.selected.one': 'Выбрано: {count}',
  'docs.bulk.selected.few': 'Выбрано: {count}',
  'docs.bulk.selected.many': 'Выбрано: {count}',
  'docs.bulk.selected.other': 'Выбрано: {count}',
  'docs.selectionAria': 'Действия с выбранными документами',
  'docs.bulk.delete': 'Удалить',
  'docs.bulk.deleteConfirm.title.one': 'Удалить {count} документ?',
  'docs.bulk.deleteConfirm.title.few': 'Удалить {count} документа?',
  'docs.bulk.deleteConfirm.title.many': 'Удалить {count} документов?',
  'docs.bulk.deleteConfirm.title.other': 'Удалить {count} документа?',
  'docs.bulk.deleteConfirm.body':
    'Выбранные документы, их извлеченный текст и поисковый индекс будут безвозвратно удалены из ' +
    'вашего рабочего пространства. Исходные файлы за пределами рабочего пространства не ' +
    'затрагиваются.',
  'docs.empty.section': 'Здесь пока ничего нет.',
  // ---- Document organization — smart views (plan §7.6/§12.1, Phase E; regrouped §11.16) ----
  'docs.smart.recentlyAdded': 'Недавно добавленные',
  'docs.smart.unfiled': 'Без проекта',
  'docs.smart.attention': 'Требуют внимания',
  'docs.smart.attentionTitle':
    'Документы с ошибкой импорта и документы, которые нужно переиндексировать',
  'docs.smart.more': 'Еще',
  'docs.provenance.staleBadge': 'Устарел',
  'docs.provenance.staleChanged':
    'После создания изменился один из источников — запустите задачу снова, чтобы обновить ' +
    'результат.',
  'docs.provenance.staleRemoved':
    'После создания один из источников был удален — запустите задачу снова, чтобы обновить ' +
    'результат.',
  // ---- Chat — composite source scope (multi-select picker + footer union, plan §13) ----
  'chat.scope.library': 'Библиотека',
  'chat.scope.projectNamed': 'Проект: {name}',
  'chat.scope.projectCount.one': '{count} проект',
  'chat.scope.projectCount.few': '{count} проекта',
  'chat.scope.projectCount.many': '{count} проектов',
  'chat.scope.projectCount.other': '{count} проекта',
  // ---- Knowledge packs (ZIM wave: ScopePopover / SourcesDisclosure / ArticleModal / PacksPanel) ----
  'chat.scope.packsTitle': 'Пакеты знаний',
  'chat.scope.packUnavailable': 'недоступен',
  'chat.scope.packNamed': 'Пакет: {name}',
  'chat.scope.packNamedState': 'Пакет: {name} ({state})',
  'chat.scope.packCount.one': '{count} пакет знаний',
  'chat.scope.packCount.few': '{count} пакета знаний',
  'chat.scope.packCount.many': '{count} пакетов знаний',
  'chat.scope.packCount.other': '{count} пакета знаний',
  'chat.scope.documentsToggle': 'Искать в моих документах',
  'chat.scope.documentsToggleHint':
    'Выключено: ответы основаны только на отмеченных пакетах знаний. Файлы, прикрепленные к ' +
    'этому чату, по-прежнему используются.',
  'chat.scope.documentsOffSuffix': 'документы выключены',
  'chat.scope.documentsOffNoPacks': 'не выбраны — включите документы или отметьте пакет знаний',
  'chat.scope.packDisabled': 'выключен',
  'chat.scope.packRemoved': 'Убранный пакет',
  'chat.scope.packLimit.one': 'Пакетов знаний в одном чате: не более {count}',
  'chat.scope.packLimit.few': 'Пакетов знаний в одном чате: не более {count}',
  'chat.scope.packLimit.many': 'Пакетов знаний в одном чате: не более {count}',
  'chat.scope.packLimit.other': 'Пакетов знаний в одном чате: не более {count}',
  // ---- Per-answer knowledge-pack outcomes (#301 P4, findings M6/M7 — PackOutcomesNotice) ----
  'chat.packs.outcome.summary':
    'Пакеты знаний — поиск выполнен: {searched} · не выполнен или с ошибкой: {other}',
  'chat.packs.outcome.removedPack': '(пакет убран)',
  'chat.packs.outcome.passages.one': '{count} фрагмент',
  'chat.packs.outcome.passages.few': '{count} фрагмента',
  'chat.packs.outcome.passages.many': '{count} фрагментов',
  'chat.packs.outcome.passages.other': '{count} фрагмента',
  'chat.packs.outcome.unknown':
    'Пакеты знаний: для этого более раннего ответа результат не записан',
  'chat.packs.outcome.searched': 'поиск выполнен',
  'chat.packs.outcome.selection-limit': 'поиск не выполнен: предел выбора (12 на чат)',
  'chat.packs.outcome.removed': 'поиск не выполнен: пакет убран',
  'chat.packs.outcome.disabled': 'поиск не выполнен: пакет выключен',
  'chat.packs.outcome.file-missing': 'поиск не выполнен: нет файла',
  'chat.packs.outcome.identity-mismatch': 'поиск не выполнен: по этому пути другой архив',
  'chat.packs.outcome.not-served': 'поиск не выполнен: имя файла конфликтует с другим пакетом',
  'chat.packs.outcome.not-searchable': 'поиск не выполнен: нет поискового индекса',
  'chat.packs.outcome.tools-missing': 'поиск не выполнен: программы kiwix-tools не установлены',
  'chat.packs.outcome.mode':
    'поиск не выполнен: ответ по всему документу читает только сам документ',
  'chat.packs.outcome.search-failed': 'ошибка: сбой поиска',
  'chat.packs.outcome.read-failed': 'ошибка: не удалось прочитать ни одной статьи',
  'chat.packs.outcome.timeout': 'ошибка: время ожидания истекло',
  'chat.packs.outcome.deadline': 'поиск не выполнен: на этот вопрос не хватило времени',
  'chat.packs.outcome.server-restarted':
    'ошибка: сервер пакетов перезапустился во время ответа на этот вопрос',
  'chat.sources.openArticle': 'Открыть статью',
  'chat.article.title': 'Статья',
  'chat.article.from': 'Источник: {archive} — офлайн-копия',
  'chat.article.loading': 'Загрузка статьи…',
  'chat.article.unavailable':
    'Эта статья сейчас недоступна. Возможно, пакет выключен или убран либо диск с ним отключен.',
  'chat.article.partial': 'Удалось показать только первую часть этой статьи.',
  'chat.article.save': 'Сохранить в мои документы',
  'chat.article.saveAria': 'Сохранить в мои документы: {title}',
  'chat.article.saving': 'Сохранение в ваши документы…',
  'chat.article.saved':
    'Сохранено в ваши документы под названием «{title}». Статья останется доступной для поиска и ' +
    'без пакета.',
  'chat.article.alreadySaved': 'Эта статья уже есть в ваших документах под названием «{title}».',
  // ---- #301 P6 (a11y pass; plan §9.23 (b)4/(b)6 and decision (c)5) — BEGIN -----------------
  'chat.scope.packMissing': 'нет файла',
  'chat.scope.packMismatch': 'по этому пути другой архив',
  'chat.scope.packNotSearchable': 'нет поискового индекса',
  'chat.sources.openArticleNamed': 'Открыть статью: {title}',
  // ---- #301 P6 — END ------------------------------------------------------------------------
  'packs.add': 'Добавить пакеты…',
  'packs.addBusy': 'Добавление…',
  'packs.refresh': 'Обновить',
  'packs.lead':
    'Офлайн-справочники (файлы ZIM — например, офлайн-версия Википедии), по которым может ' +
    'отвечать чат. Файлы используются на месте и никогда не копируются: положите их в папку ' +
    '«zim» на диске или добавьте здесь.',
  'packs.summary.count.one': '{count} пакет',
  'packs.summary.count.few': '{count} пакета',
  'packs.summary.count.many': '{count} пакетов',
  'packs.summary.count.other': '{count} пакета',
  'packs.summary.enabled.one': 'включено: {count}',
  'packs.summary.enabled.few': 'включено: {count}',
  'packs.summary.enabled.many': 'включено: {count}',
  'packs.summary.enabled.other': 'включено: {count}',
  'packs.summary.size': '{size} на этом диске',
  'packs.loading': 'Загрузка пакетов…',
  'packs.refreshing': 'Поиск пакетов на диске…',
  'packs.emptyTitle': 'Пакетов знаний пока нет',
  'packs.emptyLine':
    'Скачайте однофайловый архив .zim с сайта library.kiwix.org, затем добавьте его здесь или ' +
    'скопируйте в папку «zim» на диске.',
  'packs.copyLibrary': 'Копировать адрес библиотеки Kiwix',
  'packs.copiedToast': 'Адрес library.kiwix.org скопирован',
  'packs.copyFailed': 'Не удалось скопировать — адрес: library.kiwix.org',
  'packs.setup.title': 'Однократная настройка: инструменты для пакетов знаний',
  'packs.toolsMissing':
    'Программы kiwix-tools не установлены на этом диске, поэтому добавлять пакеты и искать в них ' +
    'нельзя. Как их установить, описано в руководстве по устранению неполадок, в разделе «The ' +
    'panel says kiwix-tools are missing».',
  'packs.tools.install': 'Установить инструменты для пакетов знаний…',
  'packs.tools.confirm.title': 'Установить инструменты для пакетов знаний?',
  'packs.tools.confirm.explain':
    'Программы kiwix-tools {version}, которые обслуживают пакеты знаний (архивы ZIM), будут ' +
    'скачаны с сервера проекта Kiwix и проверены перед использованием. Они необязательны: чат и ' +
    'документы работают и без них.',
  'packs.tools.confirm.hint':
    'Скачанные файлы проверяются перед использованием, и никакие сведения о вас или ваших ' +
    'документах не отправляются. Эти инструменты нужны только для пакетов знаний.',
  'packs.tools.confirm.ack':
    'Я подтверждаю, что условия лицензии {license} для kiwix-tools прочитаны, и принимаю их',
  'packs.tools.confirm.start': 'Начать скачивание',
  'packs.tools.sizeUnknown': 'неизвестен',
  'packs.tools.progress': 'Установка инструментов для пакетов знаний… {pct}%',
  'packs.tools.downloadingNoTotal': 'Установка инструментов для пакетов знаний…',
  'packs.tools.verifying': 'Проверка инструментов для пакетов знаний…',
  'packs.tools.extracting': 'Распаковка инструментов для пакетов знаний…',
  'packs.tools.failed': 'Не удалось установить инструменты для пакетов знаний.',
  'packs.tools.doneToast': 'Инструменты для пакетов знаний установлены',
  'packs.addedToast.one': 'Добавлен {count} пакет знаний',
  'packs.addedToast.few': 'Добавлено {count} пакета знаний',
  'packs.addedToast.many': 'Добавлено {count} пакетов знаний',
  'packs.addedToast.other': 'Добавлено {count} пакета знаний',
  'packs.addPartial': 'Не удалось добавить архивы: {failed} из {total}.',
  'packs.addFailed.notAZim': 'Выбранный файл не является читаемым архивом ZIM.',
  'packs.addFailed.toolsMissing':
    'Программы kiwix-tools не установлены на этом диске, поэтому добавлять пакеты и искать в них ' +
    'нельзя. Как их установить, описано в руководстве по устранению неполадок, в разделе «The ' +
    'panel says kiwix-tools are missing».',
  'packs.addFailed.manager':
    'Программе kiwix-manage не удалось прочитать архив. Убедитесь, что файл скачан полностью, и ' +
    'попробуйте еще раз.',
  'packs.addFailed.pathUnsupported':
    'В Windows программа kiwix-manage не может прочитать этот архив, потому что в имени файла ' +
    'или папки есть кириллица, умлаут, диакритический знак или другой символ не из набора ASCII. ' +
    'Скопируйте файл в папку «zim/» на диске под именем без таких символов и добавьте его снова.',
  'packs.addFailed.other': 'Не удалось добавить архив.',
  'packs.removedToast': 'Пакет знаний убран',
  'packs.articleCount.one': '{count} статья',
  'packs.articleCount.few': '{count} статьи',
  'packs.articleCount.many': '{count} статей',
  'packs.articleCount.other': '{count} статьи',
  'packs.state.enabled': 'Включен',
  'packs.state.disabled': 'Выключен',
  'packs.state.missing': 'Нет файла',
  'packs.state.missingTitle': 'Файл архива не найден — подключен ли диск?',
  'packs.state.identityMismatch': 'Другой архив',
  'packs.state.identityMismatchTitle':
    'По пути этого пакета находится другой архив — уберите этот пакет и добавьте файл снова',
  'packs.state.notSearchable': 'Нет поискового индекса',
  'packs.state.notSearchableTitle':
    'У этого архива нет полнотекстового поискового индекса. При вопросах он пропускается, но его ' +
    'статьи по-прежнему можно читать.',
  'packs.state.notServed': 'Не обслуживается',
  'packs.state.notServedTitle':
    'Имя файла конфликтует с пакетом «{title}», поэтому обслуживается только тот пакет — ' +
    'переименуйте этот файл, чтобы использовать оба.',
  'packs.state.notServedTitleUnknown':
    'Имя файла конфликтует с файлом другого пакета, поэтому обслуживается только тот пакет — ' +
    'переименуйте этот файл, чтобы использовать оба.',
  'packs.switchLabel': 'Использовать пакет «{title}» в чатах',
  'packs.ask': 'Спросить по этому пакету',
  'packs.askTitle': 'Открыть чат, который отвечает только по этому пакету',
  'packs.rowMenu': 'Другие действия: {title}',
  'packs.remove': 'Убрать',
  'packs.listLabel': 'Пакеты знаний',
  'packs.removeTitle': 'Убрать этот пакет знаний?',
  'packs.removeConfirm': 'Убрать пакет',
  'packs.removeBody':
    'Пакет убирается только из приложения HilbertRaum — файл архива на диске не затрагивается. ' +
    'Чаты, которые его использовали, просто перестанут брать из него сведения.',
  'chat.scope.docCount.one': '{count} документ',
  'chat.scope.docCount.few': '{count} документа',
  'chat.scope.docCount.many': '{count} документов',
  'chat.scope.docCount.other': '{count} документа',
  'chat.scope.filesInChat.one': '{count} файл в этом чате',
  'chat.scope.filesInChat.few': '{count} файла в этом чате',
  'chat.scope.filesInChat.many': '{count} файлов в этом чате',
  'chat.scope.filesInChat.other': '{count} файла в этом чате',
  'chat.scope.sourcesTitle': 'Выберите источники',
  'chat.scope.librarySource': 'Библиотека',
  'chat.scope.librarySourceHint': 'Все ваши документы',
  'chat.scope.specificToggle': 'Отдельные документы…',
  'chat.scope.allTap': 'Все документы',
  'chat.scope.attachmentsOnlyTap': 'Только файлы этого чата',
  'chat.scope.filesInChatLine': 'Файлы в этом чате',
  'chat.scope.attachmentNotReadable': '{name} (прочитать пока нельзя)',
  'chat.scope.attachmentFailedHint':
    'Файл, который пока не удается прочитать, ничего не добавляет к ответам. Почему так и что ' +
    'делать, показано на экране «Документы».',
  'chat.scope.noProjects': 'Проектов пока нет',
  'chat.scope.noPacks': 'На этом диске пока нет пакетов знаний.',
  'chat.scope.addPacks': 'Добавить пакеты…',
  'chat.scope.archivedFallback':
    'Этот проект перемещен в архив — ответы основаны на вашей библиотеке.',
  'chat.scope.answeringFrom': 'Источники ответа: {source}',
  'chat.scope.wholeLibrary.one': 'вся ваша библиотека — {count} документ',
  'chat.scope.wholeLibrary.few': 'вся ваша библиотека — {count} документа',
  'chat.scope.wholeLibrary.many': 'вся ваша библиотека — {count} документов',
  'chat.scope.wholeLibrary.other': 'вся ваша библиотека — {count} документа',
  'chat.scope.narrowTitle': 'Отвечать только по этому файлу?',
  'chat.scope.narrowBody':
    'Вы добавили файл {name}. Спрашивать только по этому файлу или по-прежнему отвечать по всей ' +
    'вашей библиотеке?',
  'chat.scope.narrowJust': 'Только этот файл',
  'chat.scope.narrowWhole': 'Вся библиотека',
  // ---- Chat — attach / drag-drop a file into a chat (plan §11.2/§13.5, Phase C) ----
  'chat.attach.button': 'Прикрепить файлы',
  'chat.attach.drop': 'Перетащите файлы сюда, чтобы использовать их в этом чате',
  'chat.attach.processing': 'Обработка: {name}…',
  'chat.attach.added': 'Файл {name} добавлен в этот чат',
  'chat.attach.newDocChat': 'Начат новый чат по документу {name}',
  'chat.attach.failed': 'Не удалось добавить файл {name} в этот чат.',
  'chat.attach.dropUnsupported':
    'Не удалось добавить — перетащите файл, сохраненный на вашем компьютере.',
  'chat.attach.trackFailed':
    'Не удалось отследить импорт файла — результат смотрите на экране «Документы».',
  'chat.attach.scanned':
    'Файл {name} похож на скан, поэтому его пока не удается прочитать. На экране «Документы» ' +
    'выберите для него «Сделать доступным для поиска (OCR)». После этого он сам появится в этом ' +
    'чате — прикреплять его снова не нужно.',
  'chat.attach.photoNeedsOcr':
    'Файл {name} — это фотография страницы, и для ее чтения нужны файлы OCR, которых пока нет на ' +
    'этом диске. На экране «Документы» нажмите «Скачать файлы OCR», а затем «Повторить» у этого ' +
    'файла. После этого он сам появится в этом чате — прикреплять его снова не нужно.',
  'chat.attach.goToDocuments': 'Открыть «Документы»',
  // ---- Images — "Ask about an image" (image-understanding §5/§11, Phase V3) ----
  'images.title': 'Анализ изображения',
  'images.empty.body':
    'Задавайте вопросы о снимке экрана, диаграмме, бланке, чеке или фотографии. Все остается ' +
    'локально.',
  'images.avail.noModel':
    'Для анализа изображений нужна локальная модель для изображений на этом диске.',
  'images.avail.noRuntime': 'Для анализа изображений сначала нужно установить ИИ-движок.',
  'images.avail.incompatible':
    'Модели для изображений на этом диске нужна более новая версия ИИ-движка.',
  'images.avail.cta': 'Открыть «ИИ-модель»',
  'images.avail.ocrPointer':
    'Отсканированные документы? На экране «Документы» выберите для них «Сделать доступным для ' +
    'поиска (OCR)».',
  'images.drop.title': 'Перетащите изображение сюда',
  'images.drop.choose': 'или выбрать изображение',
  'images.drop.types': 'PNG, JPEG или WEBP',
  'images.drop.busy': 'Идет анализ изображения. Дождитесь его завершения, чтобы начать новый.',
  'images.back': 'Назад к результатам анализа',
  'images.preview.remove': 'Убрать',
  'images.preview.replace': 'Заменить',
  'images.preview.alt': 'Выбранное изображение',
  'images.chip.summarize': 'Кратко описать изображение',
  'images.chip.summarize.prompt':
    'Кратко опишите, что видно на этом изображении. Отметьте все важное или необычное.',
  'images.chip.extractText': 'Извлечь видимый текст',
  'images.chip.extractText.prompt':
    'Извлеките видимый текст, который удается прочитать. Где это полезно, сохраняйте переносы ' +
    'строк. Сообщите, если какой-то текст неразборчив.',
  'images.chip.explainChart': 'Объяснить эту диаграмму',
  'images.chip.explainChart.prompt':
    'Объясните, что, судя по всему, показывает эта диаграмма. Укажите оси, подписи, тенденции и ' +
    'любые неясности.',
  'images.chip.readForm': 'Прочитать бланк',
  'images.chip.readForm.prompt':
    'Назовите основные поля и значения, видимые в этом бланке. Если что-то не удается прочитать, ' +
    'пишите «неразборчиво».',
  'images.chip.importantDetails': 'Найти важные детали',
  'images.chip.importantDetails.prompt':
    'Перечислите самые важные видимые детали. Не делайте выводов о том, чего не видно.',
  'images.chip.whatNotice': 'На что обратить внимание?',
  'images.chip.whatNotice.prompt':
    'На что мне стоит обратить внимание на этом изображении? Укажите только самые заметные ' +
    'видимые элементы.',
  'images.composer.placeholder': 'Задайте вопрос об этом изображении…',
  'images.composer.ask': 'Спросить',
  'images.answer.localNote': 'Ответ сформирован локально по выбранному изображению.',
  'images.answer.copy': 'Копировать',
  'images.answer.copied': 'Скопировано',
  'images.answer.copyFailed': 'Не удалось скопировать в буфер обмена',
  'images.answer.tryAgain': 'Повторить',
  'images.answer.reading': 'Чтение изображения…',
  'images.answer.starting': 'Запуск модели для изображений…',
  'images.answer.stop': 'Остановить',
  'images.answer.stopped': 'Остановлено.',
  'images.err.tooLarge':
    'Это изображение слишком большое для анализа. Попробуйте изображение поменьше.',
  'images.err.unsupported': 'Файлы этого типа не поддерживаются. Выберите PNG, JPEG или WEBP.',
  'images.err.heic':
    'Фотографии HEIC с iPhone пока не поддерживаются. Сначала преобразуйте фотографию в JPEG.',
  'images.err.pdf':
    'Здесь анализируется одно изображение, а не PDF-файл. Если это отсканированный PDF-файл, на ' +
    'экране «Документы» выберите для него «Сделать доступным для поиска (OCR)».',
  'images.err.pdfAction': 'Открыть «Документы»',
  'images.err.decodeFailed':
    'Не удалось открыть это изображение. Возможно, файл поврежден или его формат не ' +
    'поддерживается.',
  'images.err.multiDrop': 'Перетаскивайте изображения по одному.',
  'images.err.runtimeFailed':
    'Не удалось запустить модель для изображений. Попробуйте еще раз или выберите другую модель.',
  'images.err.engineCannotRun':
    'ИИ-движок не может работать на этом компьютере. Чего не хватает, показано на экране ' +
    '«ИИ-модель».',
  'images.err.emptyResponse':
    'Ответ по этому изображению не получен. Попробуйте переформулировать вопрос.',
  'images.err.emptyQuestion': 'Сначала введите вопрос об изображении.',
  'images.err.timedOut':
    'Это занимает слишком много времени. Попробуйте изображение поменьше или задайте вопрос еще ' +
    'раз.',
  'images.err.contextExceeded':
    'Обсуждение этого изображения стало слишком длинным. Задайте вопрос покороче или начните ' +
    'новый анализ.',
  'images.err.busy': 'Обработка предыдущего вопроса…',
  'images.err.openFailed': 'Не удалось открыть этот анализ. Попробуйте еще раз.',
  'images.err.deleteFailed': 'Не удалось удалить этот анализ. Попробуйте еще раз.',
  'images.err.clearFailed': 'Не удалось очистить историю. Попробуйте еще раз.',
  'images.history.title': 'История',
  'images.history.empty': 'Здесь появятся изображения, которые вы проанализируете.',
  'images.history.running': 'Идет анализ…',
  'images.history.runningOpen': 'Открыть текущий анализ',
  'images.history.turns.one': '{count} вопрос',
  'images.history.turns.few': '{count} вопроса',
  'images.history.turns.many': '{count} вопросов',
  'images.history.turns.other': '{count} вопроса',
  'images.history.delete': 'Удалить',
  'images.history.deleteAria': 'Удалить изображение «{title}»',
  'images.history.deleted': 'Удалено из истории',
  'images.history.delete.title': 'Удалить это изображение?',
  'images.history.delete.confirm': 'Удалить',
  'images.history.delete.body':
    'Изображение «{title}» и полученные по нему ответы будут безвозвратно удалены с этого диска.',
  'images.history.total': 'Всего: {size}',
  'images.history.clear': 'Очистить историю',
  'images.history.clear.title': 'Очистить историю изображений?',
  'images.history.clear.confirm': 'Очистить историю',
  'images.history.clear.body':
    'Все сохраненные результаты анализа ({size}) вместе с сохраненными изображениями будут ' +
    'безвозвратно удалены с этого диска.',
  'images.history.cleared': 'История изображений очищена',
  // ---- Translate screen (TranslateGemma wave, plan §2 D6, TG-4) ----
  'translate.title': 'Перевод текста',
  'translate.lead':
    'Введите или вставьте текст, выберите языки и переведите его локально. Ничто не покидает ' +
    'этот диск.',
  'translate.starting': 'Подготовка модели перевода…',
  'translate.avail.noModel': 'Для перевода нужна модель перевода на этом диске.',
  'translate.avail.hint':
    'Скачайте ее один раз на экране «ИИ-модель» — после этого перевод работает полностью офлайн.',
  'translate.avail.cta': 'Открыть «ИИ-модель»',
  'translate.from': 'Исходный язык',
  'translate.to': 'Язык перевода',
  'translate.swap': 'Поменять языки местами',
  'translate.input.label': 'Текст для перевода',
  'translate.input.placeholder': 'Введите или вставьте текст для перевода…',
  'translate.action': 'Перевести',
  'translate.stop': 'Остановить',
  'translate.output.label': 'Перевод',
  'translate.output.empty': 'Здесь появится перевод.',
  'translate.working': 'Перевод…',
  'translate.copy': 'Копировать',
  'translate.copied': 'Скопировано',
  'translate.device.gpu': 'Перевод выполняется на видеокарте (GPU, слоев: {done}/{total})',
  'translate.device.gpuUnknown': 'Перевод выполняется на видеокарте (GPU)',
  'translate.device.gpuPartial':
    'Перевод выполняется на видеокарте лишь частично (слоев: {done}/{total}) — большая часть ' +
    'видеопамяти была занята, обычно моделью для чата, поэтому скорость примерно такая же, как ' +
    'на процессоре',
  'translate.device.gpuNone':
    'Перевод выполняется на процессоре — видеопамять была полностью занята, обычно моделью для ' +
    'чата, поэтому на видеокарту не поместилось ни одного слоя (слоев: 0/{total})',
  'translate.device.cpu': 'Перевод выполняется на процессоре (CPU)',
  'translate.device.cpuBesideChat':
    'Перевод выполняется на процессоре — видеопамять занята моделью для чата, и модель перевода ' +
    'не поместилась бы рядом с ней',
  'translate.device.cpuChatStarting':
    'Перевод выполняется на процессоре — одновременно запускалась модель для чата, а она ' +
    'получает видеокарту в первую очередь',
  'translate.device.cpuTooLarge':
    'Перевод выполняется на процессоре — модель перевода не помещается в видеопамять этой ' +
    'видеокарты',
  'translate.device.title':
    'Где работала модель перевода при последнем запуске. При каждом запуске это определяется ' +
    'заново (модель выгружается примерно через 2 минуты после последнего перевода).',
  'translate.device.partialTitle':
    'Чтобы модели перевода досталось больше места на видеокарте, используйте модель для чата ' +
    'поменьше или остановите ее перед переводом. При следующем запуске (примерно через 2 минуты ' +
    'после последнего перевода) модель перевода заново определит, сколько слоев поместится на ' +
    'видеокарту.',
  'translate.device.gpuNoneTitle':
    'Чтобы модель перевода вообще поместилась на видеокарту, используйте модель для чата ' +
    'поменьше или остановите ее перед переводом. При следующем запуске (примерно через 2 минуты ' +
    'после последнего перевода) модель перевода заново определит, сколько слоев поместится на ' +
    'видеокарту.',
  'translate.err.noModel':
    'Модель перевода больше недоступна. Откройте экран «ИИ-модель», чтобы установить ее.',
  'translate.err.badRequest':
    'Выберите исходный язык и язык перевода и введите текст для перевода.',
  'translate.err.busy':
    'Перевод уже выполняется. Дождитесь его завершения, затем попробуйте еще раз.',
  'translate.err.docTaskBusy':
    'Выполняется задача для документа. Дождитесь ее завершения, затем запустите перевод.',
  'translate.err.runtimeFailed':
    'Модели перевода не удалось завершить перевод. Попробуйте еще раз или возьмите текст ' +
    'покороче.',
  'translate.err.startFailed':
    'Не удалось запустить модель перевода — возможно, на устройстве не хватает памяти. Закройте ' +
    'другие программы или перезапустите приложение HilbertRaum, затем попробуйте еще раз.',
  'translate.err.engineCannotRun':
    'ИИ-движок не может работать на этом компьютере. Чего не хватает, показано на экране ' +
    '«ИИ-модель».',
  'translate.err.empty': 'Перевод не получен. Попробуйте еще раз или переформулируйте текст.',
  'translate.err.sameLang': 'Выберите два разных языка.',
  'translate.err.tooLong':
    'Текст слишком длинный для перевода здесь (более 200\u00A0000 символов). Разделите его на ' +
    'части поменьше или сохраните его в файл и переведите как документ.',
  // ---- Document drag-and-drop translation (TG-5, plan §2 D7) ----
  'translate.drop.title': 'Или перетащите документ для перевода',
  'translate.drop.choose': 'или выбрать документ',
  'translate.drop.types':
    'PDF, Word, Markdown или обычный текст — документ будет переведен на выбранный язык.',
  'translate.file.importing': 'Чтение документа…',
  'translate.file.progress': 'Перевод… ({done}/{total})',
  'translate.file.preparing': 'Подготовка перевода — чтение документа…',
  'translate.file.saving': 'Сохранение переведенного документа…',
  'translate.file.truncated':
    'Показано начало перевода — чтобы увидеть весь документ, экспортируйте перевод или откройте ' +
    'его на экране «Документы».',
  'translate.file.export': 'Экспортировать…',
  'translate.file.exported': 'Документ экспортирован',
  'translate.file.show': 'Показать на экране «Документы»',
  'translate.file.reset': 'Перевести другой документ',
  'translate.file.doneAnnounce': 'Перевод документа завершен. Результат показан.',
  'translate.file.gapPages.one':
    '⚠ Не переведены страницы оригинала: {pages} — на них нет читаемого текста (возможно, это ' +
    'сканы). Пропуски отмечены в результате.',
  'translate.file.gapPages.few':
    '⚠ Не переведены страницы оригинала: {pages} — на них нет читаемого текста (возможно, это ' +
    'сканы). Пропуски отмечены в результате.',
  'translate.file.gapPages.many':
    '⚠ Не переведены страницы оригинала: {pages} — на них нет читаемого текста (возможно, это ' +
    'сканы). Пропуски отмечены в результате.',
  'translate.file.gapPages.other':
    '⚠ Не переведены страницы оригинала: {pages} — на них нет читаемого текста (возможно, это ' +
    'сканы). Пропуски отмечены в результате.',
  'translate.file.failedParts.one':
    '⚠ {count} часть не переведена — исходный текст оставлен в результате без перевода.',
  'translate.file.failedParts.few':
    '⚠ {count} части не переведены — исходный текст оставлен в результате без перевода.',
  'translate.file.failedParts.many':
    '⚠ {count} частей не переведены — исходный текст оставлен в результате без перевода.',
  'translate.file.failedParts.other':
    '⚠ {count} части не переведены — исходный текст оставлен в результате без перевода.',
  'translate.file.err.multiDrop': 'Перетаскивайте документы по одному.',
  'translate.file.err.noPath':
    'У этого элемента нет файла на диске. Перетащите документ из папки или нажмите «выбрать ' +
    'документ».',
  'translate.file.err.unsupported':
    'Файлы этого типа нельзя перевести. Попробуйте PDF, Word, Markdown или текстовый файл.',
  'translate.file.err.scanned':
    'Этот PDF-файл похож на скан без читаемого текста. Сначала на экране «Документы» выберите ' +
    'для него «Сделать доступным для поиска (OCR)», затем переведите его.',
  'translate.file.err.scannedAction': 'Открыть «Документы»',
  'translate.file.err.importFailed': 'Не удалось прочитать документ. Попробуйте еще раз.',
  'translate.file.err.runtimeFailed': 'Не удалось перевести документ. Попробуйте еще раз.',
  // ---- Evidence review (EP-1 plan §7 — ReviewScreen.tsx + chat entry points) ----
  'review.action.start': 'Проверить подтверждения',
  'review.action.continue': 'Продолжить проверку',
  'review.entry.sources': 'Проверить ответ и источники',
  'review.status.draft': 'Черновик',
  'review.status.ready': 'Завершена',
  'review.status.outdated': 'Устарела',
  'review.readonlyHint': 'Проверка завершена — чтобы вносить изменения, верните проверку в работу.',
  // ---- P4: Outdated banner + acknowledge (spec §15.5/§21.3/§28.6) ----
  'review.outdated.title': 'Эта проверка устарела.',
  'review.outdated.answerChanged':
    'Текст ответа больше не совпадает с версией, зафиксированной в проверке.',
  'review.outdated.coverageChanged':
    'Сохраненные сведения об охвате больше не совпадают с версией, зафиксированной в проверке.',
  'review.outdated.sourcesChanged.one':
    'С момента создания этой проверки изменился {count} исходный документ.',
  'review.outdated.sourcesChanged.few':
    'С момента создания этой проверки изменилось {count} исходных документа.',
  'review.outdated.sourcesChanged.many':
    'С момента создания этой проверки изменилось {count} исходных документов.',
  'review.outdated.sourcesChanged.other':
    'С момента создания этой проверки изменилось {count} исходного документа.',
  'review.outdated.keepNote':
    'Ваши сохраненные решения не изменились. Вы можете оставить проверку в прежнем виде, принять ' +
    'изменение к сведению или снова задать вопрос в чате и начать новую проверку.',
  'review.outdated.acknowledge': 'Принять изменение к сведению',
  'review.outdated.acknowledgedAt': 'Изменение принято к сведению: {date}.',
  'review.outdated.exportHint':
    'Перед экспортом пакета подтверждений примите изменение к сведению.',
  'review.back': 'Назад к чату',
  'review.rename': 'Переименовать',
  'review.rename.label': 'Название проверки',
  'review.rename.save': 'Сохранить',
  'review.loading': 'Загрузка проверки…',
  'review.notFound': 'Эта проверка не найдена. Возможно, она была удалена.',
  'review.question.toggle': 'Вопрос',
  'review.answerPane.aria': 'Проверяемый ответ',
  'review.autosave.saving': 'Сохранение…',
  'review.autosave.saved': 'Сохранено',
  'review.autosave.error': 'Некоторые изменения пока не удалось сохранить.',
  'review.autosave.retry': 'Повторить',
  'review.evidence.title': 'Подтверждения',
  'review.evidence.captionRelevance':
    'Показанные источники — это выдержки, переданные локальной ИИ-модели для этого ответа.',
  'review.evidence.captionWholeDoc':
    'Этот ответ сформирован на основе анализа документа целиком. Показанные разделы указывают на ' +
    'происхождение ответа — без ссылок на отдельные предложения.',
  'review.evidence.captionStructured':
    'Этот ответ основан на данных, извлеченных локально. Ниже показаны фрагменты источников, из ' +
    'которых извлечены эти данные.',
  'review.evidence.none':
    'Для этого ответа не сохранено ни одной выдержки из источников. Вы можете провести общую ' +
    'проверку, но проверка на уровне источников недоступна.',
  'review.disclaimer':
    'Ссылка на источник показывает, откуда взяты сведения. Она сама по себе не доказывает, что ' +
    'ответ верен.',
  'review.evidence.filterLabel': 'Фильтр источников',
  'review.evidence.filterPlaceholder': 'Фильтр по названию или тексту…',
  'review.evidence.filterClear': 'Сбросить фильтр',
  'review.evidence.filterNone': 'Ни один источник не соответствует фильтру.',
  'review.evidence.shownCount': 'Показано источников: {shown} из {total}',
  'review.evidence.more.one': 'и еще {count} источник',
  'review.evidence.more.few': 'и еще {count} источника',
  'review.evidence.more.many': 'и еще {count} источников',
  'review.evidence.more.other': 'и еще {count} источника',
  'review.evidence.linkingItem': 'Связывание подтверждений с пунктом проверки {n}',
  'review.source.kind.direct_excerpt': 'Прямая выдержка',
  'review.source.kind.whole_document_provenance': 'Происхождение из анализа документа целиком',
  'review.source.kind.structured_record': 'Извлеченная запись',
  'review.source.unresolved': 'Не удалось однозначно определить источник',
  'review.source.archive':
    'Статья из пакета знаний — ни саму статью, ни ее содержание нельзя сверить с рабочим ' +
    'пространством',
  'review.source.missingAtCreation': 'Источник был недоступен при создании этой проверки',
  'review.source.changed': 'Исходный документ изменился с момента создания этой проверки',
  'review.source.missingNow':
    'Этого источника больше нет в рабочем пространстве. Сохраненная выдержка остается в этой ' +
    'проверке.',
  'review.source.cannotVerify': 'Текущее состояние этого источника нельзя проверить',
  'review.sourceContext.open': 'Открыть источник в контексте',
  'review.sourceContext.title': 'Источник в контексте',
  'review.sourceContext.loading': 'Загрузка сохраненного текста…',
  'review.sourceContext.failed': 'Не удалось загрузить сохраненный текст этого источника.',
  'review.sourceContext.hashMatch':
    'Сохраненный хеш документа совпадает с версией, зафиксированной в проверке.',
  'review.sourceContext.hashMismatch':
    'Исходный документ изменился с момента создания этой проверки.',
  'review.sourceContext.hashUnknown':
    'Текущее состояние документа нельзя сверить с версией, зафиксированной в проверке.',
  'review.sourceContext.missing':
    'Этот источник был доступен, когда формировался ответ, но больше его нет в рабочем ' +
    'пространстве. Сохраненная выдержка, если она есть, остается в этой проверке.',
  'review.sourceContext.notLocated':
    'Сохраненную выдержку не удалось найти в текущем сохраненном тексте. Ниже она показана в том ' +
    'виде, в каком была записана при создании проверки.',
  'review.sourceContext.storedNote':
    'Контекст берется из текста, который был извлечен и сохранен при импорте, — сам исходный ' +
    'файл не открывается.',
  'review.sourceContext.excerptHeading': 'Сохраненная выдержка',
  'review.link.add': 'Связать с пунктом проверки',
  'review.link.remove': 'Убрать связь',
  'review.link.cited': 'Ссылка на источник в ответе',
  'review.link.reviewer': 'Связь добавлена проверяющим',
  'review.link.selectHint':
    'Выберите пункт проверки, чтобы связать с ним подтверждения или убрать связь.',
  'review.relation.label': 'Характер связи',
  'review.relation.none': 'Не указан',
  'review.relation.supports': 'Подтверждает',
  'review.relation.qualifies': 'Ограничивает',
  'review.relation.contradicts': 'Противоречит',
  'review.relation.context': 'Только контекст',
  'review.item.aria': 'Пункт проверки {n}',
  'review.item.noMarker': 'В этом тексте нет прямой ссылки на источник',
  'review.item.wholeDocDerived': 'Сформировано на основе анализа документа целиком',
  'review.item.noteLabel': 'Примечание',
  'review.item.notePlaceholder': 'Добавьте примечание (необязательно)',
  'review.item.viewEvidence': 'Показать подтверждения',
  // ---- P5 reviewer text selections (spec §12.1 "Review separately"; plan §10) ----
  'review.selection.start': 'Проверить фрагмент отдельно',
  'review.selection.hint':
    'Выделите фрагмент в исходном тексте ниже (он показан без форматирования), затем нажмите ' +
    '«Проверить отдельно».',
  'review.selection.surfaceAria': 'Исходный текст пункта проверки {n}',
  'review.selection.add': 'Проверить отдельно',
  'review.selection.close': 'Готово',
  'review.selection.added': 'Фрагмент добавлен как отдельный пункт проверки.',
  'review.selection.refused':
    'Не удалось добавить это выделение. Выделите фрагмент еще раз и повторите попытку.',
  'review.item.selectionTag': 'Фрагмент, выделенный проверяющим',
  'review.selection.remove': 'Убрать выделение',
  'review.decision.groupAria': 'Решение',
  'review.decision.supported': 'Проверено — подтверждено',
  'review.decision.partly_supported': 'Проверено — подтверждено частично',
  'review.decision.not_supported': 'Проверено — не подтверждено',
  'review.decision.follow_up': 'Требует уточнения',
  'review.decision.not_reviewed': 'Не проверено',
  'review.decision.not_applicable': 'Неприменимо',
  'review.bulk.menu': 'Групповые действия',
  'review.bulk.headingsNa': 'Отметить заголовки как «Неприменимо»',
  'review.bulk.followUp': 'Отметить пункты без решения как «Требует уточнения»',
  'review.bulk.clear': 'Сбросить все решения',
  'review.bulk.clearConfirmTitle': 'Сбросить все решения?',
  'review.bulk.clearConfirmBody':
    'Все решения в этой проверке вернутся к значению «Не проверено». Примечания сохранятся.',
  'review.bulk.clearConfirm': 'Сбросить решения',
  'review.progress': 'Решено: {decided} из {required}',
  'review.progress.followUps.one': '{count} пункт требует уточнения',
  'review.progress.followUps.few': '{count} пункта требуют уточнения',
  'review.progress.followUps.many': '{count} пунктов требуют уточнения',
  'review.progress.followUps.other': '{count} пункта требуют уточнения',
  'review.footer.summary': 'Сводка проверки',
  'review.summary.status': 'Статус',
  'review.summary.decisions': 'Решения',
  'review.summary.sources': 'Источники',
  'review.summary.sourcesCount.one': '{count} источник',
  'review.summary.sourcesCount.few': '{count} источника',
  'review.summary.sourcesCount.many': '{count} источников',
  'review.summary.sourcesCount.other': '{count} источника',
  'review.summary.sourcesUnresolved.one': '{count} источник не удалось однозначно определить',
  'review.summary.sourcesUnresolved.few': '{count} источника не удалось однозначно определить',
  'review.summary.sourcesUnresolved.many': '{count} источников не удалось однозначно определить',
  'review.summary.sourcesUnresolved.other': '{count} источника не удалось однозначно определить',
  'review.summary.sourcesArchive.one':
    '{count} источник взят из пакета знаний и не может быть сверен с рабочим пространством',
  'review.summary.sourcesArchive.few':
    '{count} источника взяты из пакетов знаний и не могут быть сверены с рабочим пространством',
  'review.summary.sourcesArchive.many':
    '{count} источников взяты из пакетов знаний и не могут быть сверены с рабочим пространством',
  'review.summary.sourcesArchive.other':
    '{count} источника взяты из пакетов знаний и не могут быть сверены с рабочим пространством',
  'review.summary.sourcesMissing.one': '{count} источник был недоступен при создании этой проверки',
  'review.summary.sourcesMissing.few':
    '{count} источника были недоступны при создании этой проверки',
  'review.summary.sourcesMissing.many':
    '{count} источников были недоступны при создании этой проверки',
  'review.summary.sourcesMissing.other':
    '{count} источника были недоступны при создании этой проверки',
  'review.summary.sourcesChangedNow.one':
    'С момента создания этой проверки изменился {count} исходный документ',
  'review.summary.sourcesChangedNow.few':
    'С момента создания этой проверки изменилось {count} исходных документа',
  'review.summary.sourcesChangedNow.many':
    'С момента создания этой проверки изменилось {count} исходных документов',
  'review.summary.sourcesChangedNow.other':
    'С момента создания этой проверки изменилось {count} исходного документа',
  'review.summary.sourcesMissingNow.one':
    '{count} исходный документ больше не находится в рабочем пространстве',
  'review.summary.sourcesMissingNow.few':
    '{count} исходных документа больше не находятся в рабочем пространстве',
  'review.summary.sourcesMissingNow.many':
    '{count} исходных документов больше не находятся в рабочем пространстве',
  'review.summary.sourcesMissingNow.other':
    '{count} исходного документа больше не находятся в рабочем пространстве',
  'review.summary.truncated':
    'Ответ, возможно, сформирован не полностью — он был обрезан на максимальной длине ответа ' +
    'модели.',
  'review.summary.stopped.model':
    'Ответ сформирован не полностью — ИИ-модель была остановлена или заменена до завершения ' +
    'ответа.',
  'review.summary.stopped.user':
    'Ответ сформирован не полностью — его формирование было остановлено до завершения.',
  'review.summary.stopped.lock':
    'Ответ сформирован не полностью — рабочее пространство было заблокировано или приложение ' +
    'закрыто до завершения ответа.',
  'review.summary.generation': 'Сведения о формировании ответа',
  'review.summary.model': 'Модель',
  'review.summary.generatedAt': 'Время формирования',
  'review.summary.appVersion': 'Версия приложения',
  'review.summary.skill': 'Навык',
  'review.summary.unavailable': 'Недоступно',
  'review.summary.reviewerLabel': 'Проверяющий',
  'review.summary.reviewerPlaceholder': 'Ваше имя или условное обозначение (необязательно)',
  'review.summary.generalNote': 'Общее примечание',
  'review.summary.generalNotePlaceholder': 'Общие замечания (необязательно)',
  'review.summary.exports': 'История экспорта',
  'review.summary.markReady': 'Завершить проверку',
  'review.summary.reopen': 'Вернуть проверку в работу',
  'review.summary.gateHint':
    'Чтобы завершить проверку, нужно принять решение по каждому блоку ответа (решено: {decided} ' +
    'из {required}). Вариант «Неприменимо» тоже считается решением.',
  'review.toast.ready': 'Проверка завершена.',
  'review.completedAt': 'Дата завершения: {date}',
  'review.deleteWithConversation.one':
    'Вместе с этим чатом будет удалена {count} проверка подтверждений.',
  'review.deleteWithConversation.few':
    'Вместе с этим чатом будет удалено {count} проверки подтверждений.',
  'review.deleteWithConversation.many':
    'Вместе с этим чатом будет удалено {count} проверок подтверждений.',
  'review.deleteWithConversation.other':
    'Вместе с этим чатом будет удалено {count} проверки подтверждений.',
  'review.deleteWithConversation.unknown':
    'Все проверки подтверждений, связанные с этим чатом, также будут удалены.',
  // ---- Evidence-pack export (EP-1 plan §8 — summary panel + status line) ----
  'review.status.lastExported': 'Последний экспорт: {date}',
  'review.export.action': 'Создать пакет подтверждений',
  'review.export.title': 'Экспорт пакета подтверждений',
  'review.export.encryptionWarning':
    'Этот экспортированный файл хранится за пределами зашифрованного рабочего пространства ' +
    'HilbertRaum и не защищен паролем вашего рабочего пространства.',
  'review.export.packLanguage.en': 'Этот пакет будет составлен на английском языке.',
  'review.export.packLanguage.de': 'Этот пакет будет составлен на немецком языке.',
  'review.export.options': 'Включить в пакет',
  'review.export.optNotes': 'Примечания проверяющего',
  'review.export.optExcerpts': 'Выдержки из источников',
  'review.export.optHashes': 'Хеши документов',
  'review.export.optUnreviewed': 'Непроверенные пункты',
  'review.export.optTechnical': 'Технические сведения',
  'review.export.format': 'Формат файла',
  'review.export.formatHtml': 'HTML — автономная веб-страница',
  'review.export.formatPdf': 'PDF — для печати (A4)',
  'review.export.confirm': 'Экспортировать пакет…',
  'review.export.cancel': 'Закрыть',
  'review.export.done': 'Пакет подтверждений экспортирован.',
  'review.export.error': 'Не удалось экспортировать пакет подтверждений. Файл не записан.',
  'review.export.copyHash': 'Копировать SHA-256',
  'review.export.hashCopied': 'Хеш SHA-256 скопирован в буфер обмена.'
}
