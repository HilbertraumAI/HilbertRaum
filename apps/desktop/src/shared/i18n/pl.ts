import type { UiCatalog } from './languages'

// The POLISH catalog (interface only). Typed `UiCatalog<'pl'>`: a missing, stale or extra key
// is a typecheck failure. `packExport.*` is not part of it (evidence packs stay en/de).
//
// Style (design-guidelines §7 "Polish microcopy"): informal "ty", lower case. Buttons and
// instructions take the imperative (Zapisz, Wybierz plik; negative: Nie odłączaj dysku). What
// happened is impersonal (Zapisano, Nie udało się ..., Nie znaleziono ...): a Polish past-tense
// verb shows gender, so neither the user nor the app is ever its subject, and no adjective or
// participle describes the user. The copy ADAPTS the calm spec-§11.4 tone. Quotes are low-high
// (U+201E ... U+201D, not the German closing mark), inner guillemets only inside them, no
// apostrophe, the ellipsis as one character, the spaced en dash (never the em dash).
// "HilbertRaum" is never translated and never declined (w aplikacji HilbertRaum).
//
// A placeholder never carries grammar: no ending glued to it and no preposition right before a
// name; a generic noun in front takes the case (w dokumencie {title}, modelu {model}).
//
// Plurals: one / few / many / other on consecutive lines. one = exactly 1 (no {count} added);
// few = 2-4, 22-24 (nominative plural: 2 dokumenty); many = 0, 5-21, 25-31 (genitive plural:
// 21 dokumentów); other = fractions only (genitive singular: 1,5 dokumentu).
//
// Glossary — keep terms consistent across ALL Polish copy:
//   workspace                  → obszar roboczy
//   drive / disk               → dysk (never pendrive, nośnik, napęd, pamięć USB)
//   vault / encrypted workspace→ zaszyfrowany obszar roboczy
//   model                      → model (AI model → model AI; never SI)
//   document                   → dokument
//   re-index                   → indeksować ponownie (Indeksuj ponownie)
//   offline                    → offline
//   "Ask my documents"         → Zapytaj moje dokumenty
//   lock / unlock              → zablokować / odblokować
//   password                   → hasło
//   settings                   → Ustawienia
//   plaintext (developer) mode → bez szyfrowania (tryb programisty)
//   delete, remove / cancel    → usunąć / anulować
//   skill / token / chat       → umiejętność / token (gen. tokena) / czat
//   check, verify (not review) → sprawdzić (weryfikacja belongs to the Review screen)
//
// Evidence-review glossary (MIRROR of the canonical record in design-guidelines §7; change BOTH
// together):
//   evidence                   → potwierdzenie / potwierdzenia — never dowód, never ewidencja
//   review (the artifact)      → weryfikacja (evidence review → weryfikacja potwierdzeń)
//   review item                → punkt weryfikacji
//   evidence pack              → pakiet potwierdzeń
//   citation / source marker   → odwołanie do źródła (never cytat, przypis)
//   whole-document provenance  → pochodzenie z analizy całego dokumentu; the negation is always
//                                bez odwołań do źródeł dla poszczególnych zdań
//   direct excerpt             → bezpośredni fragment (never wyciąg: that is the bank statement)
//   source / source document   → źródło / dokument źródłowy
//   reviewer                   → Osoba weryfikująca (label) / osoba weryfikująca (prose);
//                                compounds with "weryfikacji"
//   mark ready / reopen        → Zakończ weryfikację / Wznów weryfikację
//   outdated                   → nieaktualna
//   review creation            → the review is "rozpoczęta", the ANSWER is "wygenerowana" —
//                                never mixed
//   supported-ness             → ma potwierdzenie / częściowe potwierdzenie / brak
//                                potwierdzenia; "dowodzić" only in negated disclaimers

export const pl: UiCatalog<'pl'> = {
  // ---- App shell (App.tsx) ----
  'nav.aria': 'Nawigacja główna',
  'nav.home': 'Start',
  'nav.chat': 'Czat',
  'nav.documents': 'Dokumenty',
  'nav.translate': 'Tłumacz',
  'nav.images': 'Obrazy',
  'nav.models': 'Model AI',
  'nav.performance': 'Wydajność',
  'nav.settings': 'Ustawienia',
  'app.lockNow': 'Zablokuj teraz',
  'app.lockNowTitle': 'Ponownie zaszyfruj i zablokuj obszar roboczy',
  'app.noticeDetails': 'Szczegóły',
  'app.noticeGoToModels': 'Otwórz Model AI',
  'app.fatal.title': 'Nie udało się uruchomić aplikacji',
  'app.fatal.hintBefore':
    'Lokalna usługa aplikacji nie uruchomiła się, więc nie można niczego wczytać. Uruchom ' +
    'aplikację ponownie; jeśli problem się powtarza, sprawdź plik ',
  'app.fatal.hintAfter': ' na dysku i zajrzyj do pliku „docs/troubleshooting.md”.',
  'app.loadingWorkspace': 'Wczytywanie obszaru roboczego…',
  'app.loadingScreen': 'Wczytywanie…',
  // ---- Error boundary (ErrorBoundary.tsx — audit FE-1) ----
  'errorBoundary.title': 'Na tym ekranie coś poszło nie tak',
  'errorBoundary.body':
    'Na tym ekranie wystąpił nieoczekiwany problem. Twoja praca i dane są bezpieczne – nic nie ' +
    'zostało utracone. Spróbuj ponownie albo wróć do ekranu Start.',
  'errorBoundary.retry': 'Spróbuj ponownie',
  'errorBoundary.home': 'Otwórz ekran Start',
  'errorBoundary.app.title': 'W aplikacji wystąpił problem',
  'errorBoundary.app.body':
    'Stało się coś nieoczekiwanego. Twoje dane na dysku są bezpieczne. Wczytaj aplikację ' +
    'ponownie, aby kontynuować.',
  'errorBoundary.app.reload': 'Wczytaj ponownie',
  // ---- Home (HomeScreen.tsx) ----
  'home.headline.ready': 'Wszystko gotowe do rozmowy.',
  'home.headline.starting': 'Przygotowywanie…',
  'home.headline.almost': 'Konfiguracja prawie gotowa.',
  'home.lead':
    'Prywatny obszar roboczy AI, który działa offline. Twoje pytania, dokumenty i historia ' +
    'czatów zostają na tym urządzeniu.',
  'home.preflight.continue':
    'Możesz mimo to kontynuować. Jeśli aplikacja się nie otworzy, zajrzyj do instrukcji ' +
    'rozwiązywania problemów w folderze {folder} na dysku.',
  'home.moved.restored':
    'Ten dysk był ostatnio używany na innym komputerze. Wyniki dla tego komputera pochodzą z ' +
    'wcześniejszego sprawdzenia (data: {when}) – przed chwilą niczego nie zmierzono.',
  'home.moved.restoredUndated':
    'Ten dysk był ostatnio używany na innym komputerze. Wyniki dla tego komputera pochodzą z ' +
    'wcześniejszego sprawdzenia – przed chwilą niczego nie zmierzono.',
  'home.moved.measuring':
    'Ten dysk nie był wcześniej używany na tym komputerze. W tle trwa sprawdzanie; ekran ' +
    'Wydajność pokaże wyniki, gdy sprawdzanie się zakończy.',
  'home.moved.owed':
    'Ten dysk nie został jeszcze sprawdzony na tym komputerze, więc nie ma dla niego wyników.',
  'home.checking': 'Sprawdzanie…',
  'home.workspace.label': 'Obszar roboczy',
  'home.workspace.encrypted': 'Zaszyfrowany – po zamknięciu aplikacji zablokowany twoim hasłem',
  'home.workspace.plaintext': 'Bez szyfrowania (tryb programisty)',
  'home.workspace.badgeProtected': 'Chroniony',
  'home.workspace.badgeDeveloper': 'Tryb programisty',
  'home.model.label': 'Model AI',
  'home.model.fallbackName': 'Twój model',
  'home.model.running': '{model} działa na tym urządzeniu',
  'home.model.selected': 'Wybrany model: {model} – może się jeszcze wczytywać',
  'home.model.none': 'Nie wybrano jeszcze modelu',
  'home.model.badgeRunning': 'Działa',
  'home.model.badgeStarting': 'Uruchamianie',
  'home.model.badgeNeedsModel': 'Wymaga modelu',
  'home.model.open': 'Otwórz Model AI',
  'home.model.engineCannotRun':
    'Silnik AI nie może działać na tym komputerze – odpowiedzi są symulowane',
  'home.model.badgeEngine': 'Nie działa',
  'home.model.demo': '{model} działa w trybie demo – odpowiedzi są symulowane',
  'home.model.badgeDemo': 'Tryb demo',
  'home.model.choose': 'Wybierz model',
  'home.docs.label': 'Dokumenty',
  'home.docs.none': 'Nie ma jeszcze dokumentów – dodaj kilka, aby móc o nie pytać',
  'home.docsReady.one': '{count} dokument gotowy do pytań',
  'home.docsReady.few': '{count} dokumenty gotowe do pytań',
  'home.docsReady.many': '{count} dokumentów gotowych do pytań',
  'home.docsReady.other': '{count} dokumentu gotowego do pytań',
  'home.docs.badgeReady': 'Gotowe',
  'home.docs.badgeNone': 'Jeszcze brak',
  'home.docs.add': 'Dodaj dokumenty',
  'home.packs.label': 'Pakiety wiedzy',
  'home.packsReady.one': '{count} pakiet wiedzy gotowy do pytań',
  'home.packsReady.few': '{count} pakiety wiedzy gotowe do pytań',
  'home.packsReady.many': '{count} pakietów wiedzy gotowych do pytań',
  'home.packsReady.other': '{count} pakietu wiedzy gotowego do pytań',
  'home.packs.none':
    'Nie ma jeszcze pakietów – dodaj Wikipedię offline, aby zadawać ogólne pytania',
  'home.packs.noneReady':
    'Żaden pakiet nie jest gotowy do pytań – sprawdź pakiety na ekranie Dokumenty',
  'home.packs.badgeNoneReady': 'Brak gotowych',
  'home.packs.add': 'Dodaj pakiety',
  'home.packs.open': 'Otwórz pakiety wiedzy',
  'home.actions.startChat': 'Rozpocznij czat',
  'home.actions.askDocs': 'Zapytaj moje dokumenty',
  // ---- Chat (ChatScreen.tsx) ----
  'chat.title': 'Czat',
  'chat.noModel.title': 'Żaden model nie działa',
  'chat.noModel.startingTitle': 'Model AI się uruchamia',
  'chat.noModel.hintBefore':
    'Czat i pytania do dokumentów wymagają wczytanego modelu. Otwórz ekran Model AI, wybierz ' +
    'pobrany model, a następnie przycisk ',
  'chat.noModel.hintAction': 'Użyj tego modelu',
  'chat.noModel.hintAfter':
    '. Wszystko zostaje lokalnie – nic nie jest pobierane ani wysyłane przez internet.',
  'chat.noModel.stillLoading':
    'Jeśli dopiero otwarto aplikację, wybrany model może się jeszcze wczytywać – gdy będzie ' +
    'gotowy, ten ekran przejdzie dalej automatycznie.',
  'chat.noModel.starting':
    'Twój model się uruchamia – wczytywanie dużych modeli chwilę trwa. Gdy model będzie gotowy, ' +
    'ten ekran przejdzie dalej automatycznie.',
  'chat.noModel.startingProgress':
    'Twój model się uruchamia – trwa odczyt pliku modelu ({gb}\u00A0GB), na razie około {pct}%. Gdy ' +
    'model będzie gotowy, ten ekran przejdzie dalej automatycznie.',
  'chat.noModel.open': 'Otwórz Model AI',
  'chat.noModel.recheck': 'Sprawdź ponownie',
  'chat.empty.title': 'Zadaj pytanie albo zapytaj o swoje dokumenty.',
  'chat.empty.lineDocuments': 'Odpowiedzi pochodzą z twoich dokumentów i podają swoje źródła.',
  'chat.empty.lineChat':
    'Odpowiedzi napływają na bieżąco z modelu na tym dysku – nic nie opuszcza tego urządzenia.',
  'chat.empty.fillTitle': 'Wstaw do pola wiadomości',
  'chat.empty.addDocs': 'Dodaj dokumenty, aby o nie pytać',
  'chat.exampleChat.explain': 'Wyjaśnij pojęcie prostymi słowami',
  'chat.exampleChat.draftEmail': 'Pomóż mi napisać uprzejmy e-mail',
  'chat.exampleChat.brainstorm': 'Zaproponuj pomysły na projekt',
  'chat.example.summarize': 'Streść ten dokument',
  'chat.example.paymentTerms': 'Jakie są warunki płatności?',
  'chat.example.indemnity': 'Znajdź każde wystąpienie słowa „odszkodowanie”',
  'chat.modeAria': 'Tryb czatu',
  'chat.mode.chat': 'Czat',
  'chat.mode.documents': 'Zapytaj moje dokumenty',
  'chat.listShow': 'Pokaż listę rozmów',
  'chat.runtime.gpu': '{model} · GPU ({name})',
  'chat.runtime.cpu': '{model} · CPU',
  'chat.runtime.cpuCompat': '{model} · CPU (tryb zgodności)',
  'chat.runtime.demo': '{model} · tryb demo',
  'chat.runtime.title':
    'Model AI, który odpowiada w tym czacie, i informacja, czy działa na karcie graficznej ' +
    '(GPU), czy na procesorze (CPU). Szczegóły: Ustawienia → Diagnostyka.',
  'chat.runtime.compatTitle':
    'Ze względu na stabilność włączono tryb zgodności, więc odpowiedzi są generowane na ' +
    'procesorze i mogą powstawać wolniej. Kartę graficzną możesz wypróbować ponownie tutaj: ' +
    'Ustawienia → Diagnostyka.',
  'chat.convOptions': 'Opcje rozmowy',
  'chat.saveConversation': 'Zapisz tę rozmowę',
  'chat.savedTo': 'Zapisano: {path}',
  'chat.copied': 'Skopiowano',
  'chat.copyFailed': 'Nie udało się skopiować do schowka',
  'chat.transcript.label': 'Zapis rozmowy',
  'chat.stopped': 'Zatrzymano – odpowiedź może być niepełna',
  'chat.warmup.hint':
    'Pierwsza odpowiedź trwa nieco dłużej – model się przygotowuje. Kolejne odpowiedzi będą ' +
    'szybsze.',
  'chat.scopeNotice': 'Odpowiedzi tylko na podstawie: {titles}',
  'chat.cancelDocTask': 'Anuluj zadanie dotyczące dokumentu',
  'chat.placeholder.documents': 'Zapytaj o swoje dokumenty…',
  'chat.placeholder.chat': 'Wiadomość…',
  'chat.send.ask': 'Zapytaj',
  'chat.send.send': 'Wyślij',
  'chat.composer.stop': 'Zatrzymaj',
  // ---- Chat: conversation list (ConversationList.tsx) ----
  'chat.list.title': 'Rozmowy',
  'chat.list.aria': 'Historia rozmów',
  'chat.list.newChat': '+ Nowy czat',
  'chat.list.newDocQa': '+ Nowe pytania do dokumentów',
  'chat.list.hide': 'Ukryj listę rozmów',
  'chat.list.empty': 'Nie ma jeszcze rozmów.',
  'chat.list.docMeta': 'Dokumenty',
  'chat.list.otherGroup': 'Inne / Biblioteka',
  'chat.list.rowOptionsAria': 'Opcje rozmowy „{title}”',
  'chat.search.placeholder': 'Szukaj w rozmowach…',
  'chat.search.aria': 'Szukaj w rozmowach',
  'chat.search.resultsAria': 'Wyniki wyszukiwania',
  'chat.search.resultsFor': 'Wyniki wyszukiwania: „{query}”',
  'chat.search.noMatches': 'Nie znaleziono dopasowań. Spróbuj sformułować to inaczej.',
  'chat.search.count.one': '{count} wynik',
  'chat.search.count.few': '{count} wyniki',
  'chat.search.count.many': '{count} wyników',
  'chat.search.count.other': '{count} wyniku',
  'chat.group.today': 'Dzisiaj',
  'chat.group.yesterday': 'Wczoraj',
  'chat.group.last7days': 'Ostatnie 7 dni',
  'chat.group.earlier': 'Wcześniej',
  'chat.delete.menuItem': 'Usuń rozmowę',
  'chat.delete.title': 'Usunąć tę rozmowę?',
  'chat.delete.confirm': 'Usuń',
  'chat.delete.body': 'Czat „{title}” i jego wiadomości zostaną trwale usunięte z tego dysku.',
  // ---- Chat: answer depth (DepthMenu.tsx; ids stay fast|balanced|deep) ----
  'chat.depth.trigger': 'Odpowiedź: {label}',
  'chat.depth.fast': 'Krótka',
  'chat.depth.balanced': 'Wyważona',
  'chat.depth.deep': 'Dokładna',
  'chat.depth.fastHint': 'Krótkie, rzeczowe odpowiedzi',
  'chat.depth.balancedHint': 'Ustawienie domyślne na co dzień',
  'chat.depth.deepHint': 'Model przemyśli problem przed odpowiedzią – to trwa dłużej',
  // ---- Chat: skill picker + per-message glyph (skills plan §10/§15) ----
  'chat.skill.trigger': 'Umiejętność: {label}',
  'chat.skill.none': 'Brak',
  'chat.skill.suggested': 'Propozycja: {title} – użyć jej?',
  'chat.skill.suggestedHint': 'Propozycja: {title}',
  'chat.skill.used': 'Umiejętność: {title}',
  'chat.skill.usedTitle': 'Tę odpowiedź ukształtowała umiejętność „{title}”.',
  'chat.skill.autoFired': 'Użyto automatycznie: {title}',
  'chat.skill.autoFiredTitle':
    'Do tej odpowiedzi automatycznie zastosowano umiejętność „{title}”. Możesz ponowić pytanie ' +
    'bez niej.',
  'chat.skill.answerWithout': 'Ponów bez umiejętności',
  'chat.skill.answerWithoutBlockedByReview':
    'Dla tej odpowiedzi rozpoczęto weryfikację potwierdzeń. Ponowne wygenerowanie odpowiedzi ' +
    'usunęłoby tę weryfikację wraz z jej decyzjami i notatkami.',
  'chat.skill.removed': '(usunięta umiejętność)',
  'chat.skill.offer.lead': 'To wygląda na zadanie dla umiejętności.',
  'chat.skill.offer.run': 'Uruchom umiejętność „{title}” dla tego pytania',
  'chat.skill.offer.model': 'Propozycja lokalnego modelu',
  'chat.skill.offer.unavailable':
    'Ta umiejętność jest wyłączona lub została usunięta – aby ją uruchomić, włącz ją w ' +
    'Ustawieniach na karcie Umiejętności.',
  'chat.skill.clear': 'Wyczyść umiejętność {title}',
  'chat.skill.keep': 'Zachowaj dla tej rozmowy',
  'chat.skill.infoButton': 'O umiejętności „{title}”',
  'chat.skill.info.close': 'Ukryj to wyjaśnienie',
  'chat.skill.info.needsLabel': 'Wymaga:',
  'chat.skill.info.limitsLabel': 'Pamiętaj:',
  'chat.skill.info.perTurn':
    'Umiejętność dotyczy twoich pytań w tym czacie, dopóki jej nie zmienisz lub nie wyczyścisz – ' +
    'opcja „Zachowaj dla tej rozmowy” zapisuje ją także na później.',
  'chat.skill.info.learnMore': 'Więcej informacji',
  'chat.skill.tool.extractTransactions': 'Wyodrębnij transakcje',
  'chat.skill.tool.validateBalances': 'Sprawdź salda',
  'chat.skill.tool.categorize': 'Przypisz kategorie',
  'chat.skill.tool.summarize': 'Podsumuj przepływy pieniężne',
  'chat.skill.tool.exportCsv': 'Eksportuj do CSV',
  'chat.skill.tool.extractInvoice': 'Wyodrębnij dane faktury',
  'chat.skill.tool.validateInvoiceTotals': 'Sprawdź sumy',
  'chat.skill.tool.exportInvoiceCsv': 'Eksportuj do CSV',
  'chat.skill.tool.exportInvoiceJson': 'Eksportuj do JSON',
  'chat.skill.tool.exportInvoiceXml': 'Eksportuj do XML',
  'chat.skill.tool.redactDocument': 'Ukryj dane osobowe',
  'chat.skill.tool.applyDocumentEdits': 'Zastosuj zmiany w tekście',
  'chat.skill.categorize.breakdownQuestion': 'Podziel moje wydatki według kategorii.',
  'chat.skill.summarize.question': 'Podsumuj moje przychody i wydatki.',
  'chat.skill.run.running.one': 'W toku: {tool} – {count} dokument…',
  'chat.skill.run.running.few': 'W toku: {tool} – {count} dokumenty…',
  'chat.skill.run.running.many': 'W toku: {tool} – {count} dokumentów…',
  'chat.skill.run.running.other': 'W toku: {tool} – {count} dokumentu…',
  'chat.skill.run.runningOn': 'W toku: {tool} – {document}…',
  'chat.skill.run.chooseDocument': 'Wybierz dokument docelowy',
  'chat.skill.run.thisDocument': 'ten dokument',
  'chat.skill.run.cancel': 'Anuluj',
  'chat.skill.run.done.one': 'Wyodrębniono {count} transakcję.',
  'chat.skill.run.done.few': 'Wyodrębniono {count} transakcje.',
  'chat.skill.run.done.many': 'Wyodrębniono {count} transakcji.',
  'chat.skill.run.done.other': 'Wyodrębniono {count} transakcji.',
  'chat.skill.run.done.categorize.one': 'Skategoryzowano {count} transakcję.',
  'chat.skill.run.done.categorize.few': 'Skategoryzowano {count} transakcje.',
  'chat.skill.run.done.categorize.many': 'Skategoryzowano {count} transakcji.',
  'chat.skill.run.done.categorize.other': 'Skategoryzowano {count} transakcji.',
  'chat.skill.run.done.summarize.one': 'Podsumowano {count} transakcję.',
  'chat.skill.run.done.summarize.few': 'Podsumowano {count} transakcje.',
  'chat.skill.run.done.summarize.many': 'Podsumowano {count} transakcji.',
  'chat.skill.run.done.summarize.other': 'Podsumowano {count} transakcji.',
  'chat.skill.run.done.export.one': 'Zapisano {count} wiersz.',
  'chat.skill.run.done.export.few': 'Zapisano {count} wiersze.',
  'chat.skill.run.done.export.many': 'Zapisano {count} wierszy.',
  'chat.skill.run.done.export.other': 'Zapisano {count} wiersza.',
  'chat.skill.run.done.reconciled': 'Salda się zgadzają.',
  'chat.skill.run.done.unreconciled.one':
    '{count} wiersz się nie zgadza – sprawdź go, zanim na nim oprzesz dalsze kroki.',
  'chat.skill.run.done.unreconciled.few':
    '{count} wiersze się nie zgadzają – sprawdź je, zanim na nich oprzesz dalsze kroki.',
  'chat.skill.run.done.unreconciled.many':
    '{count} wierszy się nie zgadza – sprawdź je, zanim na nich oprzesz dalsze kroki.',
  'chat.skill.run.done.unreconciled.other':
    '{count} wiersza się nie zgadza – sprawdź je, zanim na nich oprzesz dalsze kroki.',
  'chat.skill.run.done.unchecked': 'Na wyciągu nie ma bieżącego salda do porównania.',
  'chat.skill.run.done.extractInvoice.one': 'Wyodrębniono {count} pozycję faktury.',
  'chat.skill.run.done.extractInvoice.few': 'Wyodrębniono {count} pozycje faktury.',
  'chat.skill.run.done.extractInvoice.many': 'Wyodrębniono {count} pozycji faktury.',
  'chat.skill.run.done.extractInvoice.other': 'Wyodrębniono {count} pozycji faktury.',
  'chat.skill.run.done.invoiceReconciled': 'Sumy na fakturze się zgadzają.',
  'chat.skill.run.done.invoiceUnreconciled.one':
    '{count} suma się nie zgadza – sprawdź ją, zanim na niej oprzesz dalsze kroki.',
  'chat.skill.run.done.invoiceUnreconciled.few':
    '{count} sumy się nie zgadzają – sprawdź je, zanim na nich oprzesz dalsze kroki.',
  'chat.skill.run.done.invoiceUnreconciled.many':
    '{count} sum się nie zgadza – sprawdź je, zanim na nich oprzesz dalsze kroki.',
  'chat.skill.run.done.invoiceUnreconciled.other':
    '{count} sumy się nie zgadza – sprawdź je, zanim na nich oprzesz dalsze kroki.',
  'chat.skill.run.done.invoiceUnchecked': 'Na fakturze nie ma sum do porównania.',
  'chat.skill.run.done.redacted.one':
    'Zapisano kopię z ukrytymi danymi osobowymi – ukryto {count} element. Wykrywanie działa w ' +
    'miarę możliwości, bez gwarancji – sprawdź kopię przed udostępnieniem.',
  'chat.skill.run.done.redacted.few':
    'Zapisano kopię z ukrytymi danymi osobowymi – ukryto {count} elementy. Wykrywanie działa w ' +
    'miarę możliwości, bez gwarancji – sprawdź kopię przed udostępnieniem.',
  'chat.skill.run.done.redacted.many':
    'Zapisano kopię z ukrytymi danymi osobowymi – ukryto {count} elementów. Wykrywanie działa w ' +
    'miarę możliwości, bez gwarancji – sprawdź kopię przed udostępnieniem.',
  'chat.skill.run.done.redacted.other':
    'Zapisano kopię z ukrytymi danymi osobowymi – ukryto {count} elementu. Wykrywanie działa w ' +
    'miarę możliwości, bez gwarancji – sprawdź kopię przed udostępnieniem.',
  'chat.skill.run.done.redactedClean':
    'Nie wykryto danych osobowych; zapisano kopię. Wykrywanie działa w miarę możliwości, bez ' +
    'gwarancji – sprawdź kopię przed udostępnieniem.',
  'chat.skill.run.done.redactedFloor.one':
    'Zapisano kopię z ukrytymi danymi osobowymi – ukryto {count} element (tylko wykrywanie ' +
    'offline na podstawie reguł, bez działającego modelu). Sprawdź kopię przed udostępnieniem.',
  'chat.skill.run.done.redactedFloor.few':
    'Zapisano kopię z ukrytymi danymi osobowymi – ukryto {count} elementy (tylko wykrywanie ' +
    'offline na podstawie reguł, bez działającego modelu). Sprawdź kopię przed udostępnieniem.',
  'chat.skill.run.done.redactedFloor.many':
    'Zapisano kopię z ukrytymi danymi osobowymi – ukryto {count} elementów (tylko wykrywanie ' +
    'offline na podstawie reguł, bez działającego modelu). Sprawdź kopię przed udostępnieniem.',
  'chat.skill.run.done.redactedFloor.other':
    'Zapisano kopię z ukrytymi danymi osobowymi – ukryto {count} elementu (tylko wykrywanie ' +
    'offline na podstawie reguł, bez działającego modelu). Sprawdź kopię przed udostępnieniem.',
  'chat.skill.run.done.redactedCleanFloor':
    'Nie wykryto danych osobowych (tylko wykrywanie offline na podstawie reguł, bez działającego ' +
    'modelu); zapisano kopię. Sprawdź ją przed udostępnieniem.',
  'chat.skill.run.done.redactedCapped.one':
    'Zapisano kopię z ukrytymi danymi osobowymi – ukryto {count} element. Ten dokument jest ' +
    'bardzo duży, więc automatyczne wykrywanie zatrzymało się na swoim limicie i dalsze elementy ' +
    'mogą pozostać widoczne – sprawdź całą kopię przed udostępnieniem.',
  'chat.skill.run.done.redactedCapped.few':
    'Zapisano kopię z ukrytymi danymi osobowymi – ukryto {count} elementy. Ten dokument jest ' +
    'bardzo duży, więc automatyczne wykrywanie zatrzymało się na swoim limicie i dalsze elementy ' +
    'mogą pozostać widoczne – sprawdź całą kopię przed udostępnieniem.',
  'chat.skill.run.done.redactedCapped.many':
    'Zapisano kopię z ukrytymi danymi osobowymi – ukryto {count} elementów. Ten dokument jest ' +
    'bardzo duży, więc automatyczne wykrywanie zatrzymało się na swoim limicie i dalsze elementy ' +
    'mogą pozostać widoczne – sprawdź całą kopię przed udostępnieniem.',
  'chat.skill.run.done.redactedCapped.other':
    'Zapisano kopię z ukrytymi danymi osobowymi – ukryto {count} elementu. Ten dokument jest ' +
    'bardzo duży, więc automatyczne wykrywanie zatrzymało się na swoim limicie i dalsze elementy ' +
    'mogą pozostać widoczne – sprawdź całą kopię przed udostępnieniem.',
  'chat.skill.run.done.edited.one':
    'Wprowadzono {count} zmianę i zapisano edytowaną kopię. Sprawdź ją przed udostępnieniem.',
  'chat.skill.run.done.edited.few':
    'Wprowadzono {count} zmiany i zapisano edytowaną kopię. Sprawdź ją przed udostępnieniem.',
  'chat.skill.run.done.edited.many':
    'Wprowadzono {count} zmian i zapisano edytowaną kopię. Sprawdź ją przed udostępnieniem.',
  'chat.skill.run.done.edited.other':
    'Wprowadzono {count} zmiany i zapisano edytowaną kopię. Sprawdź ją przed udostępnieniem.',
  'chat.skill.run.done.editedPartial.one':
    'Wprowadzono {count} zmianę; części wskazanego tekstu nie znaleziono, więc ją pominięto. ' +
    'Zapisano edytowaną kopię – sprawdź ją przed udostępnieniem.',
  'chat.skill.run.done.editedPartial.few':
    'Wprowadzono {count} zmiany; części wskazanego tekstu nie znaleziono, więc ją pominięto. ' +
    'Zapisano edytowaną kopię – sprawdź ją przed udostępnieniem.',
  'chat.skill.run.done.editedPartial.many':
    'Wprowadzono {count} zmian; części wskazanego tekstu nie znaleziono, więc ją pominięto. ' +
    'Zapisano edytowaną kopię – sprawdź ją przed udostępnieniem.',
  'chat.skill.run.done.editedPartial.other':
    'Wprowadzono {count} zmiany; części wskazanego tekstu nie znaleziono, więc ją pominięto. ' +
    'Zapisano edytowaną kopię – sprawdź ją przed udostępnieniem.',
  'chat.skill.run.done.editedNone':
    'Nie znaleziono żadnego ze wskazanych fragmentów tekstu – niczego nie zmieniono i nie ' +
    'zapisano kopii.',
  'chat.skill.run.done.editedCapped.one':
    'Wprowadzono {count} zmianę. Ten dokument jest bardzo duży, więc wyszukiwanie miejsc do ' +
    'zmiany zatrzymało się na swoim limicie – sprawdź kopię; dalsze miejsca mogą pozostać ' +
    'niezmienione.',
  'chat.skill.run.done.editedCapped.few':
    'Wprowadzono {count} zmiany. Ten dokument jest bardzo duży, więc wyszukiwanie miejsc do ' +
    'zmiany zatrzymało się na swoim limicie – sprawdź kopię; dalsze miejsca mogą pozostać ' +
    'niezmienione.',
  'chat.skill.run.done.editedCapped.many':
    'Wprowadzono {count} zmian. Ten dokument jest bardzo duży, więc wyszukiwanie miejsc do ' +
    'zmiany zatrzymało się na swoim limicie – sprawdź kopię; dalsze miejsca mogą pozostać ' +
    'niezmienione.',
  'chat.skill.run.done.editedCapped.other':
    'Wprowadzono {count} zmiany. Ten dokument jest bardzo duży, więc wyszukiwanie miejsc do ' +
    'zmiany zatrzymało się na swoim limicie – sprawdź kopię; dalsze miejsca mogą pozostać ' +
    'niezmienione.',
  'chat.skill.run.failedGeneric': 'To się nie udało. Niczego nie zmieniono.',
  'chat.skill.run.error.unavailable': 'To narzędzie jest niedostępne.',
  'chat.skill.run.error.needsExtraction':
    'Najpierw odczytaj dokument przyciskiem „{button}”, a potem uruchom to narzędzie.',
  'chat.skill.run.error.persistFailed': 'Nie udało się tego zapisać. Niczego nie zmieniono.',
  'chat.skill.run.error.exportWriteFailed': 'Nie udało się zapisać pliku. Niczego nie zmieniono.',
  'chat.skill.run.error.needsModel':
    'Najpierw uruchom model – punktowe zmiany wymagają działającego modelu, który znajdzie tekst ' +
    'do zmiany.',
  'chat.skill.run.error.needsInstruction':
    'Najpierw napisz, co zmienić (na przykład „zamień X na Y”), a potem uruchom to ponownie.',
  'chat.skill.run.error.editFailed': 'Nie udało się ukończyć zmian. Niczego nie zmieniono.',
  'chat.skill.run.error.redactionModelStopped':
    'Model AI zatrzymał się przed zakończeniem ukrywania danych. Niczego nie zapisano. Uruchom ' +
    'ukrywanie danych ponownie – jeśli to się powtarza, uruchom model ponownie na ekranie Model ' +
    'AI.',
  'chat.skill.run.error.redactionTooLong':
    'Części tego dokumentu są za długie dla okna kontekstu bieżącego modelu. Niczego nie ' +
    'zapisano. Wybierz większy rozmiar kontekstu na ekranie Model AI i uruchom model ponownie, a ' +
    'potem ponów ukrywanie danych.',
  'chat.skill.run.cancelled': 'Zatrzymano. Niczego nie zapisano.',
  'chat.skill.run.stateUnknown':
    'Nie udało się sprawdzić stanu tej umiejętności – jej wynik może być niepełny.',
  'chat.skill.run.otherChatBusy': 'Umiejętność działa w innym czacie.',
  'chat.skill.run.categorizeOffer': 'Przypisz kategorie transakcjom',
  'chat.skill.run.dismiss': 'Ukryj',
  'chat.skill.confirm.title': 'Uruchomić to narzędzie?',
  'chat.skill.confirm.body':
    'To narzędzie tworzy lub eksportuje plik na podstawie dokumentów na tym dysku.',
  'chat.skill.confirm.target': 'Dokument: {document}',
  'chat.skill.confirm.outputDocx': 'Zapisana kopia zachowa format Word tego dokumentu (.docx).',
  'chat.skill.confirm.redactionScope':
    'Ukrywanie obejmuje tekst dokumentu (także nagłówki, stopki, przypisy, komentarze i śledzone ' +
    'zmiany) oraz usuwa metadane autora i adresy linków. Obrazy, zeskanowane strony i osadzone ' +
    'obiekty nie są sprawdzane – sprawdź zapisaną kopię przed udostępnieniem.',
  'chat.skill.confirm.outputText':
    'Zapisana kopia będzie plikiem tekstowym (.txt) – oryginalny układ i formatowanie nie ' +
    'zostaną zachowane.',
  'chat.skill.confirm.outputMatrix':
    'Dokumenty Word (.docx) zachowują swój format; pliki PDF i inne formaty są zapisywane jako ' +
    'kopia tekstowa (.txt).',
  'chat.skill.confirm.ok': 'Uruchom',
  // ---- Chat: transcript + message actions ----
  'chat.role.user': 'Ty',
  'chat.role.assistant': 'HilbertRaum',
  'chat.thinking': 'Myśli…',
  'chat.actions.tryAgain': 'Spróbuj ponownie',
  'chat.actions.sendAgain': 'Wyślij ponownie',
  'chat.actions.copy': 'Kopiuj',
  'chat.actions.save': 'Zapisz',
  'chat.actions.saveTitle': 'Zapisz tę rozmowę jako plik (zostaje lokalnie)',
  'chat.actions.exportCsv': 'Eksportuj do CSV',
  'chat.actions.exportCsvTitle': 'Zapisz tabelę z tej odpowiedzi jako plik CSV (zostaje lokalnie)',
  'chat.code.copy': 'Kopiuj',
  'chat.code.copyTitle': 'Skopiuj ten blok kodu do schowka',
  'chat.code.save': 'Zapisz',
  'chat.code.saveTitle': 'Zapisz ten blok kodu jako plik .{ext} (zostaje lokalnie)',
  // ---- Chat: context compaction (context-compaction plan §5.1–§5.3) ----
  'chat.compaction.inProgress':
    'Streszczanie wcześniejszych wiadomości, aby zwolnić miejsce w kontekście…',
  'chat.analysis.inProgress': 'Odczytywanie całego dokumentu…',
  'chat.compaction.markerLabel': 'Streszczono wcześniejsze wiadomości',
  'chat.compaction.viewSummary': 'Pokaż streszczenie wcześniejszych wiadomości',
  'chat.context.label': 'Pamięć',
  'chat.context.usageTooltip':
    'Pamięć tej rozmowy: zapełniona w {pct}% (tokeny: około {used} z {window}).',
  'chat.context.willSummarize':
    'Gdy się zapełni, starsze wiadomości są automatycznie streszczane, aby zwolnić miejsce.',
  'chat.truncated.label': 'Odpowiedź obcięta',
  'chat.endedEarly.label': 'Odpowiedź zatrzymana',
  'chat.endedEarly.hint.model':
    'Model AI został zatrzymany lub zmieniony przed ukończeniem tej odpowiedzi.',
  'chat.endedEarly.hint.user':
    'Tę odpowiedź zatrzymano przyciskiem „Zatrzymaj”, zanim została ukończona.',
  'chat.endedEarly.hint.lock':
    'Obszar roboczy został zablokowany lub aplikacja została zamknięta przed ukończeniem tej ' +
    'odpowiedzi.',
  'chat.unanswered.model': 'Brak odpowiedzi – model AI został zatrzymany.',
  'chat.unanswered.user': 'Brak odpowiedzi – użyto przycisku „Zatrzymaj”.',
  'chat.unanswered.lock':
    'Brak odpowiedzi – obszar roboczy został zablokowany lub aplikacja została zamknięta.',
  'chat.truncated.hint.context':
    'Modelowi zabrakło miejsca, aby dokończyć tę odpowiedź. Poproś model o kontynuowanie, ' +
    'rozpocznij nowy czat albo zwiększ rozmiar kontekstu na ekranie Model AI.',
  'chat.truncated.hint.cap':
    'Ta odpowiedź oparta na dokumentach osiągnęła stałą długość, na jaką aplikacja pozwala w ' +
    'jednej odpowiedzi. Poproś model o kontynuowanie od miejsca, w którym odpowiedź się urwała.',
  'chat.speed.line': '{tps}\u00A0tok/s · {ttft}\u00A0s do pierwszego tokena · tokeny: {tokens}',
  'chat.speed.hint':
    'Szybkość generowania tej odpowiedzi: szybkość dekodowania podawana przez silnik AI, czas ' +
    'oczekiwania na pierwsze słowo i liczba wygenerowanych tokenów. Wyświetlane tylko dla ' +
    'odpowiedzi z tej sesji.',
  // ---- Chat: document scope (ScopePopover.tsx) ----
  'chat.scope.none': 'Jeszcze brak dokumentów · Dodaj dokumenty',
  'chat.scope.stopAsking': 'Nie pytaj już: {title}',
  'chat.scope.askToo': 'Pytaj też: {title}',
  'chat.scope.removedDoc': 'Usunięty dokument',
  // ---- Chat: sources (SourcesDisclosure.tsx) ----
  'chat.sources.toggle': 'Źródła ({count})',
  'chat.sources.marker': 'Ź{n}',
  'chat.sources.page': 'Strona {page}',
  'chat.sources.wholeDoc.one': 'Zaczerpnięto z dokumentu – {count} sekcja',
  'chat.sources.wholeDoc.few': 'Zaczerpnięto z dokumentu – {count} sekcje',
  'chat.sources.wholeDoc.many': 'Zaczerpnięto z dokumentu – {count} sekcji',
  'chat.sources.wholeDoc.other': 'Zaczerpnięto z dokumentu – {count} sekcji',
  'chat.sources.wholeDocCaption': 'Objęte sekcje',
  'chat.sources.more.one': 'i jeszcze {count} sekcja',
  'chat.sources.more.few': 'i jeszcze {count} sekcje',
  'chat.sources.more.many': 'i jeszcze {count} sekcji',
  'chat.sources.more.other': 'i jeszcze {count} sekcji',
  // ---- Chat: dictation (DictationButton.tsx) ----
  'chat.dictation.start': 'Podyktuj wiadomość',
  'chat.dictation.unavailable': 'Dyktowanie nie jest zainstalowane na tym dysku',
  'chat.dictation.unavailableSystem': 'Dyktowanie nie jest dostępne w tym systemie operacyjnym',
  'chat.dictation.needsModel':
    'Do dyktowania wiadomości potrzebny jest model mowy, który nie jest zainstalowany na tym ' +
    'dysku. Możesz go dodać na ekranie Model AI.',
  'chat.dictation.needsEngine':
    'Do dyktowania wiadomości potrzebny jest silnik mowy, który nie jest zainstalowany na tym ' +
    'dysku. Możesz go zainstalować na ekranie Model AI.',
  'chat.dictation.needsModelAndEngine':
    'Do dyktowania wiadomości potrzebne są model mowy i silnik mowy, których jeszcze nie ma na ' +
    'tym dysku. Możesz dodać oba na ekranie Model AI.',
  'chat.dictation.engineUnsupported':
    'Dyktowanie nie jest jeszcze dostępne w tym systemie operacyjnym: aplikacja nie może tu ' +
    'zainstalować potrzebnego silnika mowy.',
  'chat.dictation.getModel': 'Pobierz model mowy',
  'chat.dictation.getEngine': 'Pobierz silnik mowy',
  'chat.dictation.setUp': 'Skonfiguruj dyktowanie',
  'chat.dictation.stop': 'Zakończ dyktowanie i wstaw tekst',
  'chat.dictation.transcribing': 'Trwa zamiana mowy na tekst',
  'chat.dictation.noSpeech': 'Nie rozpoznano mowy – spróbuj powiedzieć to ponownie.',
  'chat.dictation.silent':
    'Do mikrofonu nie dotarł żaden dźwięk. Sprawdź, czy nie jest wyciszony i czy w ustawieniach ' +
    'systemu aplikacja HilbertRaum ma do niego dostęp, a potem spróbuj ponownie.',
  'chat.dictation.noSignal':
    'Do mikrofonu nie dociera żaden dźwięk – sprawdź, czy nie jest wyciszony i czy wybrano ' +
    'właściwe urządzenie wejściowe.',
  'chat.dictation.micBlocked':
    'Nie udało się użyć mikrofonu. Sprawdź ustawienia mikrofonu w systemie, a potem spróbuj ' +
    'ponownie.',
  // ---- Documents (DocumentsScreen.tsx) ----
  'docs.title': 'Dokumenty',
  'docs.lead':
    'Zaimportuj dokumenty, aby zadawać pytania na ich temat. Każdy plik jest kopiowany do ' +
    'twojego obszaru roboczego i przygotowywany do wyszukiwania – wszystko zostaje na tym dysku. ' +
    'Pytaj w trybie „Zapytaj moje dokumenty” na ekranie Czat.',
  'docs.status.queued': 'Oczekuje',
  'docs.status.extracting': 'Odczytywanie',
  'docs.status.preparing': 'Przygotowywanie',
  'docs.status.indexed': 'Gotowy',
  'docs.status.failed': 'Błąd',
  'docs.status.deleted': 'Usunięty',
  'docs.status.transcribing': 'Transkrybowanie…',
  'docs.task.summaryBusy': 'Streszczanie…',
  'docs.task.translationBusy': 'Tłumaczenie…',
  'docs.task.compareBusy': 'Porównywanie…',
  'docs.task.ocrBusy': 'Odczytywanie skanu…',
  'docs.task.treeBusy': 'Tworzenie indeksu pogłębionego…',
  'docs.task.extractBusy': 'Wyszukiwanie szczegółów…',
  'docs.task.summaryBusyTitle': 'Trwa tworzenie streszczenia',
  'docs.task.translationBusyTitle': 'Trwa tworzenie tłumaczenia',
  'docs.task.compareBusyTitle': 'Trwa tworzenie porównania',
  'docs.task.ocrBusyTitle': 'Trwa odczytywanie zeskanowanych stron',
  'docs.task.treeBusyTitle': 'Trwa tworzenie indeksu pogłębionego dla całego dokumentu',
  'docs.task.extractBusyTitle':
    'Trwa przeszukiwanie całego dokumentu, aby można było odpowiadać na pytania typu „wymień ' +
    'wszystkie…”',
  'docs.task.categorizeBusy': 'Kategoryzowanie transakcji…',
  'docs.task.categorizeBusyTitle': 'Trwa kategoryzowanie transakcji z wyciągu',
  'docs.task.ocrFinishing': 'Kończenie – przygotowywanie tekstu do wyszukiwania…',
  'docs.task.stopping': 'Zatrzymywanie, jeśli to możliwe…',
  'docs.error.noSupported': 'Wśród wybranych plików nie znaleziono obsługiwanych dokumentów.',
  'docs.removedDocFallback': 'usunięty dokument',
  'docs.provenance.compareBefore': 'Porównanie dokumentów: ',
  'docs.provenance.compareMiddle': ' i ',
  'docs.provenance.translatedBefore': 'Przetłumaczono z dokumentu: ',
  'docs.provenance.summaryBefore': 'Streszczenie dokumentu: ',
  'docs.provenance.generatedBefore': 'Wygenerowano z dokumentu: ',
  'docs.provenance.articleBefore': 'Zapisano z pakietu wiedzy: ',
  'docs.provenance.articleUnknownArchive': '(nazwa nieznana)',
  'docs.import.busy': 'Importowanie…',
  'docs.import.files': 'Importuj pliki',
  'docs.import.folder': 'Importuj folder',
  'docs.import.walkCut.one':
    'Folder był za duży, aby przejrzeć go w całości – policzono {count} element.',
  'docs.import.walkCut.few':
    'Folder był za duży, aby przejrzeć go w całości – policzono {count} elementy.',
  'docs.import.walkCut.many':
    'Folder był za duży, aby przejrzeć go w całości – policzono {count} elementów.',
  'docs.import.walkCut.other':
    'Folder był za duży, aby przejrzeć go w całości – policzono {count} elementu.',
  'docs.refresh': 'Odśwież',
  'docs.loading': 'Wczytywanie dokumentów…',
  'docs.askSelected': 'Zapytaj te dokumenty ({count})',
  'docs.askSelectedTitle': 'Otwórz czat z pytaniami tylko do zaznaczonych dokumentów',
  'docs.compareBtn': 'Porównaj (2)',
  'docs.compareBtnTitle':
    'Napisz porównanie dwóch zaznaczonych dokumentów za pomocą lokalnego modelu – nic nie ' +
    'opuszcza tego dysku',
  'docs.reindexAll': 'Indeksuj ponownie wszystko ({count})',
  'docs.reindexAllTitle':
    'Indeksuj ponownie każdy dokument, który został zindeksowany innym modelem wyszukiwania',
  'docs.reindexAllConfirm.title.one': 'Zindeksować ponownie {count} dokument?',
  'docs.reindexAllConfirm.title.few': 'Zindeksować ponownie {count} dokumenty?',
  'docs.reindexAllConfirm.title.many': 'Zindeksować ponownie {count} dokumentów?',
  'docs.reindexAllConfirm.title.other': 'Zindeksować ponownie {count} dokumentu?',
  'docs.reindexAllConfirm.body':
    'Każdy nieaktualny dokument zostanie po kolei ponownie odczytany i przygotowany do ' +
    'wyszukiwania. Może to potrwać kilka minut i mocno obciąża procesor – możesz dalej pracować, ' +
    'ale do czasu zakończenia odpowiedzi mogą być wolniejsze.',
  'docs.reindexAllConfirm.confirm': 'Indeksuj ponownie wszystko',
  'docs.retryAllFailed': 'Ponów wszystkie ({count})',
  'docs.retryAllFailedTitle': 'Indeksuj ponownie każdy dokument, którego nie udało się zindeksować',
  'docs.retryAllConfirm.title.one': 'Ponowić {count} nieudany import?',
  'docs.retryAllConfirm.title.few': 'Ponowić {count} nieudane importy?',
  'docs.retryAllConfirm.title.many': 'Ponowić {count} nieudanych importów?',
  'docs.retryAllConfirm.title.other': 'Ponowić {count} nieudanego importu?',
  'docs.retryAllConfirm.body':
    'Każdy dokument, którego nie udało się zindeksować, zostanie po kolei ponownie odczytany i ' +
    'przygotowany do wyszukiwania. Może to potrwać kilka minut i mocno obciąża procesor – możesz ' +
    'dalej pracować, ale do czasu zakończenia odpowiedzi mogą być wolniejsze. Dokumenty, których ' +
    'znowu nie uda się zindeksować, zostają w sekcji „Wymaga uwagi”.',
  'docs.retryAllConfirm.confirm': 'Ponów wszystkie',
  'docs.reindexAllProgress': 'Ponowne indeksowanie: {done} z {total}…',
  'docs.reindexAllCancel': 'Anuluj',
  'docs.reindexAllCancelled': 'Zatrzymano ponowne indeksowanie. Ukończono: {done} z {total}.',
  'docs.reindexAllDone.one': 'Ponownie zindeksowano {count} dokument.',
  'docs.reindexAllDone.few': 'Ponownie zindeksowano {count} dokumenty.',
  'docs.reindexAllDone.many': 'Ponownie zindeksowano {count} dokumentów.',
  'docs.reindexAllDone.other': 'Ponownie zindeksowano {count} dokumentu.',
  'docs.reindexAllPartial':
    'Ponownie zindeksowano: {done} z {total}. Niepowodzenia: {failed}. Te dokumenty zostają w ' +
    'sekcji „Wymaga uwagi”.',
  'docs.supported.base':
    'Obsługiwane formaty: TXT, Markdown, PDF, DOCX, CSV, a także nagrania audio (WAV, MP3, FLAC, ' +
    'OGG), które są transkrybowane na tym dysku',
  'docs.supported.ocrExtra': ', oraz zdjęcia stron (PNG, JPG), które są odczytywane na tym dysku',
  'docs.preparing': 'Trwa przygotowywanie dokumentów, aby można było o nie pytać…',
  'docs.empty.title': 'Nie ma jeszcze dokumentów',
  'docs.empty.line':
    'Zaimportuj pliki, aby zadawać pytania na ich temat – wszystko zostaje na tym dysku.',
  'docs.selectAria': 'Zaznacz dokument „{title}” do pytań',
  'docs.selectTitle': 'Zaznacz, aby pytać tylko wybrane dokumenty',
  'docs.selectAllAria': 'Zaznacz wszystkie dokumenty',
  'docs.selectAllTitle': 'Zaznacz wszystkie widoczne dokumenty albo wyczyść zaznaczenie',
  'docs.meta.sectionsCount.one': '{count} sekcja',
  'docs.meta.sectionsCount.few': '{count} sekcje',
  'docs.meta.sectionsCount.many': '{count} sekcji',
  'docs.meta.sectionsCount.other': '{count} sekcji',
  'docs.meta.summary': 'Streszczenie',
  'docs.meta.type.text': 'Tekst',
  'docs.meta.type.audio': 'Audio',
  'docs.meta.type.image': 'Obraz',
  'docs.scan.ocrOffer':
    'Użyj „Umożliw wyszukiwanie (OCR)” w tym wierszu, aby odczytać strony na tym dysku.',
  'docs.scan.ocrMissing':
    'Aby umożliwić wyszukiwanie, potrzebne są pliki OCR, których nie ma na tym dysku. Pobierz je ' +
    'poniżej – albo, na samodzielnie skonfigurowanym dysku, dodaj je poleceniem „fetch-runtime ' +
    '--family ocr”.',
  'docs.scan.ocrMissingOffline':
    'Aby umożliwić wyszukiwanie, potrzebne są pliki OCR, których nie ma na tym dysku. Aby je ' +
    'dodać, uruchom ponownie konfigurację dysku z opcją „--with-assets” albo pobierz same pliki ' +
    'OCR poleceniem „fetch-runtime --family ocr”.',
  'docs.photo.ocrMissing':
    'Pobierz poniżej pliki OCR, a potem wybierz „Spróbuj ponownie”, aby odczytać to zdjęcie.',
  'docs.photo.ocrMissingOffline':
    'Dodaj pliki OCR za pomocą konfiguracji dysku („fetch-runtime --family ocr”), a potem ' +
    'wybierz „Spróbuj ponownie”, aby odczytać to zdjęcie.',
  'docs.photo.ocrReady':
    'Rozpoznawanie tekstu jest już gotowe – wybierz „Spróbuj ponownie”, aby odczytać to zdjęcie.',
  'docs.scan.ocrUnavailable':
    'Aby umożliwić wyszukiwanie, potrzebne jest rozpoznawanie tekstu (OCR), którego nie udało ' +
    'się uruchomić w tej wersji aplikacji.',
  'docs.ocr.unavailableBanner':
    'Rozpoznawanie tekstu (OCR) nie jest dostępne w tej wersji aplikacji: pliki OCR są na tym ' +
    'dysku, ale nie udało się uruchomić rozpoznawania. Zdjęcia są zapisywane bez czytelnego ' +
    'tekstu, a w zeskanowanych plikach PDF nie można umożliwić wyszukiwania, dopóki problem nie ' +
    'zostanie rozwiązany.',
  'docs.stale.banner':
    'Ten dokument został przygotowany innym modelem wyszukiwania – zindeksuj go ponownie, aby ' +
    'odpowiedzi mogły go znaleźć.',
  'docs.preview': 'Podgląd',
  'docs.previewBusy': 'Otwieranie…',
  'docs.previewTitle':
    'Przeczytaj wyodrębniony tekst (tylko do odczytu; nic nie opuszcza aplikacji)',
  'docs.cancel': 'Anuluj',
  'docs.cancelOcrTitle': 'Zatrzymaj odczytywanie skanu',
  'docs.cancelTaskTitle': 'Zatrzymaj zadanie',
  'docs.task.stateUnknown': 'Nie udało się sprawdzić stanu tego zadania – może nadal trwać.',
  'docs.task.dismiss': 'Ukryj',
  'docs.makeSearchable': 'Umożliw wyszukiwanie (OCR)',
  'docs.makeSearchableTitle':
    'Odczytaj zeskanowane strony za pomocą lokalnego rozpoznawania tekstu – nic nie opuszcza ' +
    'tego dysku',
  'docs.makeSearchableAgain': 'Odczytaj ponownie (OCR)',
  'docs.makeSearchableAgainPhotoTitle':
    'Odczytaj zdjęcie ponownie za pomocą lokalnego rozpoznawania tekstu',
  'docs.makeSearchableAgainTitle':
    'Uruchom ponownie lokalne rozpoznawanie tekstu i zastąp zapisany odczyt – „Indeksuj ' +
    'ponownie” używa zapisanego odczytu',
  'docs.summarize': 'Streść',
  'docs.summarizeAgain': 'Streść ponownie',
  'docs.translate': 'Przetłumacz',
  'docs.translateNoModel': 'Pobierz model tłumaczenia…',
  'docs.translateNoModelTitle':
    'Do tłumaczenia potrzebny jest model tłumaczenia – pobierz go na ekranie Model AI',
  'docs.export': 'Eksportuj',
  'docs.exportOriginal': 'Eksportuj oryginalny plik',
  'docs.exportOriginal.gone':
    'Zapisanej kopii tego pliku nie ma na tym dysku, więc nie można jej wyeksportować. Nadal ' +
    'możesz wyeksportować wyodrębniony tekst.',
  'docs.exportOriginalConfirm.title': 'Wyeksportować oryginalny plik?',
  'docs.exportOriginal.warning':
    'Ten wyeksportowany plik jest przechowywany poza zaszyfrowanym obszarem roboczym aplikacji ' +
    'HilbertRaum i nie jest chroniony hasłem twojego obszaru roboczego.',
  'docs.reindex': 'Indeksuj ponownie',
  'docs.reindexBusy': 'Ponowne indeksowanie…',
  'docs.reindexTitle': 'Odczytaj i przygotuj zapisaną kopię ponownie',
  'docs.reindexDone': 'Ponownie zindeksowano dokument „{title}”.',
  'docs.delete': 'Usuń',
  'docs.deleteBusy': 'Usuwanie…',
  'docs.deleteDone': 'Usunięto dokument „{title}”.',
  'docs.failed.remove': 'Usuń z listy',
  'docs.failed.removeTitle': 'Usuń ten nieudany import z listy',
  'docs.failed.retry': 'Spróbuj ponownie',
  'docs.failed.lead': 'Nie udało się dodać tego pliku.',
  'docs.backToChat': 'Wróć do czatu',
  'docs.failed.retryTitle': 'Odczytaj i przygotuj ten plik ponownie',
  'docs.moreActions': 'Więcej działań dla dokumentu „{title}”',
  'docs.audioConfirm.title': 'Zaimportować duże nagrania audio?',
  'docs.audioConfirm.confirm': 'Importuj i transkrybuj',
  'docs.audioConfirm.contains.one': 'Wybrane pliki zawierają {count} nagranie audio ({size}).',
  'docs.audioConfirm.contains.few': 'Wybrane pliki zawierają {count} nagrania audio ({size}).',
  'docs.audioConfirm.contains.many': 'Wybrane pliki zawierają {count} nagrań audio ({size}).',
  'docs.audioConfirm.contains.other': 'Wybrane pliki zawierają {count} nagrania audio ({size}).',
  'docs.audioConfirm.body':
    'Każde nagranie jest kopiowane do twojego obszaru roboczego i transkrybowane na tym dysku – ' +
    'długie nagranie może zająć trochę czasu. W tym czasie możesz dalej korzystać z aplikacji.',
  'docs.deleteConfirm.title': 'Usunąć dokument „{title}”?',
  'docs.deleteConfirm.body':
    'Dokument, jego wyodrębniony tekst i indeks wyszukiwania zostaną trwale usunięte z twojego ' +
    'obszaru roboczego. Oryginalny plik poza obszarem roboczym zostaje bez zmian.',
  'docs.translateModal.title': 'Przetłumacz dokument „{title}”',
  'docs.translateModal.aria': 'Przetłumacz dokument „{title}”',
  'docs.translateModal.hint':
    'Lokalny model zapisuje przetłumaczoną kopię jako nowy dokument – można go przeszukiwać i ' +
    'pytać o niego jak o każdy zaimportowany dokument, a nic nie opuszcza tego dysku. ' +
    'Tłumaczenia maszynowe mogą zawierać błędy.',
  'docs.translateModal.from': 'Z języka',
  'docs.translateModal.to': 'Na język',
  'docs.translateModal.start': 'Przetłumacz',
  'docs.translateModal.sameLang': 'Wybierz dwa różne języki.',
  'docs.previewModal.aria': 'Podgląd dokumentu „{title}”',
  'docs.previewModal.hint':
    'Wyodrębniony tekst tylko do odczytu – na nim opierają się wyszukiwanie w dokumentach i ' +
    'odpowiedzi.',
  'docs.previewModal.ocrInfo.one':
    'Tekst rozpoznany na tym dysku (OCR) – {count} strona. Rozpoznany tekst może zawierać błędy.',
  'docs.previewModal.ocrInfo.few':
    'Tekst rozpoznany na tym dysku (OCR) – {count} strony. Rozpoznany tekst może zawierać błędy.',
  'docs.previewModal.ocrInfo.many':
    'Tekst rozpoznany na tym dysku (OCR) – {count} stron. Rozpoznany tekst może zawierać błędy.',
  'docs.previewModal.ocrInfo.other':
    'Tekst rozpoznany na tym dysku (OCR) – {count} strony. Rozpoznany tekst może zawierać błędy.',
  'docs.previewModal.ocrInfoPhoto':
    'Tekst rozpoznany na tym dysku (OCR) z tego zdjęcia. Rozpoznany tekst może zawierać błędy.',
  'docs.previewModal.ocrInfoPartial':
    'Tekst rozpoznany na tym dysku (OCR) – strony z tekstem: {count} z {total}. Rozpoznany tekst ' +
    'może zawierać błędy.',
  'docs.previewModal.ocrInfoNone.one':
    'Rozpoznawanie tekstu (OCR) odczytało na tym dysku {count} zeskanowaną stronę i nie znalazło ' +
    'na niej tekstu.',
  'docs.previewModal.ocrInfoNone.few':
    'Rozpoznawanie tekstu (OCR) odczytało na tym dysku {count} zeskanowane strony i nie znalazło ' +
    'na nich tekstu.',
  'docs.previewModal.ocrInfoNone.many':
    'Rozpoznawanie tekstu (OCR) odczytało na tym dysku {count} zeskanowanych stron i nie ' +
    'znalazło na nich tekstu.',
  'docs.previewModal.ocrInfoNone.other':
    'Rozpoznawanie tekstu (OCR) odczytało na tym dysku {count} zeskanowanej strony i nie ' +
    'znalazło na niej tekstu.',
  'docs.ocr.unsure.page': 'Wynik rozpoznawania tekstu na tej stronie jest niepewny.',
  'docs.ocr.unsure.onlyRecognized':
    'Wynik rozpoznawania tekstu na jedynej rozpoznanej stronie jest niepewny.',
  'docs.ocr.unsure.photo': 'Wynik rozpoznawania tekstu na tym zdjęciu jest niepewny.',
  'docs.ocr.unsure.some':
    'Rozpoznane strony z niepewnym wynikiem rozpoznawania tekstu: {count} z {total}.',
  'docs.ocr.unsure.all':
    'Rozpoznane strony z niepewnym wynikiem rozpoznawania tekstu: wszystkie ({count}).',
  'docs.ocr.scannedPages': 'Zeskanowane strony jeszcze bez czytelnego tekstu: {count} z {total}.',
  'docs.ocr.scannedPagesNeedsOcr': 'Do ich odczytania potrzebne są pliki OCR (ekran Model AI).',
  'docs.ocr.unsure.causes':
    'Rozmazany, przekrzywiony lub pisany odręcznie oryginał odczytuje się słabo – podobnie jak ' +
    'tekst w języku innym niż niemiecki lub angielski.',
  'docs.previewModal.summary': 'Streszczenie',
  'docs.previewModal.generatedBy': 'Wygenerowano przez model {model}',
  'docs.previewModal.truncated':
    'Ten dokument jest długi – streszczenie obejmuje jego początek. Pozostałą część nadal można ' +
    'przeszukiwać i pytać o nią w czacie.',
  'docs.previewModal.regenerate': 'Wygeneruj ponownie',
  'docs.previewModal.copy': 'Kopiuj',
  'docs.previewModal.save': 'Zapisz',
  'docs.previewModal.copied': 'Skopiowano streszczenie',
  'docs.previewModal.copyFailed': 'Nie udało się skopiować do schowka',
  'docs.previewModal.savedTo': 'Zapisano streszczenie: {path}',
  'docs.previewModal.noText': 'Nie udało się wyodrębnić tekstu z tego dokumentu.',
  'docs.previewModal.documentText': 'Tekst dokumentu',
  'docs.previewModal.page': 'Strona {page}',
  'docs.previewModal.showMore': 'Pokaż więcej',
  'docs.previewModal.loadingMore': 'Wczytywanie…',
  'docs.previewModal.segmentProgress': 'Pokazano {shown} z {total}',
  // ---- Deep index + coverage (whole-document-analysis plan §5.2) ----
  'docs.deepIndex.build': 'Utwórz indeks pogłębiony',
  'docs.deepIndex.reindexFirst': 'Indeksuj ponownie (indeks pogłębiony)',
  'docs.deepIndex.ready': 'Indeks pogłębiony',
  'docs.deepIndex.readyTitle':
    'Indeks pogłębiony całego dokumentu jest gotowy – streszczenia i odpowiedzi w formie listy ' +
    'mogą objąć całą treść',
  'coverage.relevance': 'Na podstawie najtrafniejszych fragmentów – nie całego dokumentu',
  'coverage.relevance.counted': 'Użyte sekcje: {covered} z {total}',
  'coverage.capped.whole': 'Obejmuje cały dokument',
  'coverage.capped.beginning': 'Obejmuje początek dokumentu',
  'coverage.tree.whole': 'Obejmuje cały dokument (indeks pogłębiony)',
  'coverage.tree.beginning': 'Obejmuje początek dokumentu – był za duży, aby odczytać go w całości',
  'coverage.tree.partial': 'Trwa tworzenie indeksu pogłębionego – sekcje: {covered} z {total}',
  'coverage.tree.pending': 'Brak indeksu pogłębionego',
  'coverage.depth': 'Szczegółowość: {label}',
  'coverage.tier.1': 'Zarys',
  'coverage.tier.2': 'Sekcja po sekcji',
  'coverage.tier.3': 'Szczegóły (pełne pokrycie)',
  'coverage.tier.hint.1': 'Najszybciej – zapisany zarys',
  'coverage.tier.hint.2': 'Dokładniejsze przejście przez sekcje',
  'coverage.tier.hint.3': 'Najwięcej szczegółów, w całym dokumencie',
  'coverage.tierSelect.trigger': 'Szczegółowość: {label}',
  'coverage.extract.whole': 'Odczytano cały dokument – przeanalizowane sekcje: {scanned}',
  'coverage.extract.wholeUnparsed':
    'Odczytano cały dokument – przeanalizowane sekcje: {scanned}, nie udało się odczytać: ' +
    '{unparsed}',
  'coverage.extract.sections': 'Przeanalizowane sekcje: {scanned}',
  'coverage.extract.sectionsUnparsed':
    'Przeanalizowane sekcje: {scanned}, nie udało się odczytać: {unparsed}',
  // ---- "List every X" answer (whole-document-analysis plan §4.2, Phase 3) ----
  'analysis.kind.generic': 'elementy',
  'analysis.kind.date': 'daty',
  'analysis.kind.amount': 'kwoty',
  'analysis.kind.party': 'strony umowy',
  'analysis.kind.obligation': 'zobowiązania',
  'analysis.listing.coverageWhole':
    'Znaleziono w całym dokumencie ({kind}): {count} – przeanalizowane sekcje: ' +
    '{scanned}{unparsed}:',
  'analysis.listing.coverageSections':
    'Znaleziono ({kind}): {count} – przeanalizowane sekcje: {scanned}{unparsed}:',
  'analysis.listing.empty':
    'Nic nie znaleziono ({kind}) – przeanalizowane sekcje: {scanned}{unparsed}.',
  'analysis.listing.unparsedSuffix': ' (nie udało się odczytać: {k})',
  'analysis.listing.item': '- {value} (×{count})',
  'analysis.listing.caveat':
    'Ta lista obejmuje wszystkie przeanalizowane sekcje – nie ma gwarancji, że jest kompletna ' +
    '(mały model może pominąć element, a bardzo podobne wpisy mogą zostać połączone).',
  'analysis.listing.refPage': 's. {n}',
  'analysis.listing.refSection': 'sekcja {n}',
  'analysis.listing.unparsedHint':
    '**Uwaga:** podczas indeksowania tego dokumentu nie udało się odczytać większości sekcji, ' +
    'więc ten wynik nie jest wiarygodny. Otwórz ekran Dokumenty i ponownie wybierz „Utwórz ' +
    'indeks pogłębiony” – aplikacja spróbuje wtedy odczytać nieodczytane sekcje (pomaga większy ' +
    'model).',
  'analysis.listing.unparsedHintAmountSkill':
    'W przypadku wyciągu bankowego umiejętność „Analiza wyciągu bankowego” z menu umiejętności w ' +
    'czacie odczytuje kwoty dokładnie.',
  'analysis.listing.aggregationHint':
    '**Uwaga:** pytasz o kategorie lub sumy, ale ta odpowiedź może tylko wymienić wartości ' +
    'znalezione w dokumencie wraz z liczbą ich wystąpień – nie potrafi ich pogrupować ani ' +
    'zsumować.',
  'analysis.listing.aggregationHintAmountSkill':
    'W przypadku wyciągu bankowego wybierz umiejętność „Analiza wyciągu bankowego” w menu ' +
    'umiejętności w czacie i zapytaj ponownie – pogrupuje ona transakcje w kategorie i dokładnie ' +
    'zsumuje każdą kategorię.',
  'analysis.wholeDocHint':
    '**Uwaga:** ta odpowiedź opiera się tylko na najtrafniejszych sekcjach, więc może pomijać ' +
    'niektóre elementy. Aby uzyskać listę obejmującą każdą sekcję, otwórz ekran Dokumenty, ' +
    'wybierz „Utwórz indeks pogłębiony” dla tego dokumentu i zapytaj ponownie.',
  'analysis.partialAnswerHint':
    '**Uwaga:** ta odpowiedź opiera się tylko na najtrafniejszych sekcjach, więc może pomijać ' +
    'niektóre elementy.',
  'analysis.wholeReadSumHint':
    '**Uwaga:** model sam oblicza sumy i może pominąć lub źle policzyć niektóre pozycje. ' +
    'Porównaj każdą sumę ze źródłami.',
  // ---- Bank-statement analysis answer (full-doc-skills plan §3.1, Phase 2) ----
  'skills.bankAnalysis.count': 'Transakcje odczytane z całego wyciągu: **{count}**.',
  'skills.bankAnalysis.countPartial':
    'Odczytane transakcje: **{count}**. Wiersze z kwotą, której nie udało się przetworzyć na ' +
    'transakcję: **{dropped}** – to mogą więc nie być wszystkie transakcje. Porównaj te wiersze ' +
    'z dokumentem.',
  'skills.bankAnalysis.countContradicted':
    'Odczytane transakcje: **{count}**, ale salda podane na tym wyciągu się z nimi nie zgadzają ' +
    '– nie można więc potwierdzić, że to wszystkie transakcje.',
  'skills.bankAnalysis.empty':
    'Przeanalizowano cały dokument, ale nie udało się odczytać z niego żadnych transakcji. ' +
    'Wiersze mogą znajdować się na zeskanowanym obrazie albo mieć nietypowy układ, którego ' +
    'mechanizm odczytu nie potrafi przetworzyć. Jeśli to skan, najpierw uruchom na nim ' +
    'rozpoznawanie tekstu (OCR); w przeciwnym razie układ może nie nadawać się do odczytu ' +
    'maszynowego – otwórz wyciąg i odczytaj kwoty bezpośrednio.',
  'skills.bankAnalysis.couldNotRead':
    'Nie udało się odczytać tego wyciągu, więc nie można go przeanalizować.',
  'skills.bankAnalysis.unreconciledHeading':
    'Najpierw sprawdź te wiersze – podane w nich saldo bieżące nie zgadza się z kwotami:',
  'skills.bankAnalysis.unreconciledItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.totals':
    'Wpływy: **{inAmount} {currency}** · Wypływy: **{outAmount} {currency}** · Zmiana netto: ' +
    '**{netAmount} {currency}**.',
  'skills.bankAnalysis.noCurrency':
    'Te transakcje są w więcej niż jednej walucie, więc nie ma jednej łącznej sumy – sumę trzeba ' +
    'by podzielić według walut.',
  'skills.bankAnalysis.incompleteNoTotal':
    'Nie udało się potwierdzić, że odczytano cały wyciąg – podane na nim salda nie zgadzają się ' +
    'z odczytanymi transakcjami, więc kwoty mogą być błędnie odczytane lub niepełne. Suma nie ' +
    'jest tu podawana, bo mogłaby być błędna; otwórz wyciąg i sprawdź kwoty samodzielnie.',
  'skills.bankAnalysis.categoryHeading': 'Według kategorii:',
  'skills.bankAnalysis.categoryItem': '- {category}: {amount} {currency} ({count})',
  'skills.bankAnalysis.categoryAssisted':
    '_Kategorie przypisano z pomocą modelu – któraś etykieta może być nietrafna, ale powyższe ' +
    'sumy się nie zmieniają._',
  'skills.bankAnalysis.categoryRuleBased':
    '_To szybkie grupowanie na podstawie reguł (bez użycia modelu). Aby uzyskać dokładniejszy ' +
    'podział z pomocą modelu, użyj przycisku „Przypisz kategorie”._',
  'skills.bankCategory.Groceries': 'Zakupy spożywcze',
  'skills.bankCategory.Dining': 'Restauracje',
  'skills.bankCategory.Transport': 'Transport',
  'skills.bankCategory.Utilities': 'Media',
  'skills.bankCategory.Rent': 'Czynsz',
  'skills.bankCategory.Insurance': 'Ubezpieczenia',
  'skills.bankCategory.Subscriptions': 'Subskrypcje',
  'skills.bankCategory.Health': 'Zdrowie',
  'skills.bankCategory.Shopping': 'Zakupy',
  'skills.bankCategory.Income': 'Przychody',
  'skills.bankCategory.Transfer': 'Przelewy',
  'skills.bankCategory.Fees': 'Opłaty',
  'skills.bankCategory.Cash': 'Gotówka',
  'skills.bankCategory.Tax': 'Podatki',
  'skills.bankCategory.Spending': 'Wydatki',
  'skills.bankCategory.Uncategorized': 'Bez kategorii',
  'skills.bankAnalysis.caveat':
    'Te kwoty pochodzą bezpośrednio z wyciągu i odczytano je z całego dokumentu – nic tu nie ' +
    'zostało zsumowane z tekstu opisowego ani wymyślone.',
  'skills.bankAnalysis.unverifiedCaveat':
    'Te kwoty to suma transakcji odczytanych z całego dokumentu (liczba transakcji: ' +
    '**{count}**). Wyciąg nie podaje salda początkowego ani końcowego, więc nie można ' +
    'potwierdzić, że to wszystkie transakcje – traktuj te kwoty jako sumę pokazanych wierszy, a ' +
    'nie sprawdzoną sumę z wyciągu. Nic tu nie zostało zsumowane z tekstu opisowego ani ' +
    'wymyślone.',
  'skills.bankAnalysis.dateOrderCaveat':
    'Uwaga dotycząca dat: na tym wyciągu nic nie wskazuje, czy dzień stoi przed miesiącem, czy ' +
    'po nim, więc daty odczytano z dniem na początku (dzień.miesiąc.rok) – data taka jak 03.05. ' +
    'może oznaczać 3 maja albo 5 marca. Każdą ważną datę sprawdź w dokumencie.',
  'skills.bankAnalysis.transactionsHeading': 'Transakcje:',
  'skills.bankAnalysis.transactionItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.transactionsMore':
    '… i jeszcze **{count}**. Aby zobaczyć wszystkie wiersze, użyj przycisku **Eksportuj do ' +
    'CSV** na pasku narzędzi umiejętności i zapisz cały wyciąg albo po prostu poproś tutaj, w ' +
    'czacie, o wyciąg w formacie CSV lub JSON.',
  'skills.bankAnalysis.figureEcho':
    'Sumy obliczone na podstawie odczytanych transakcji: {figures}.',
  'skills.bankAnalysis.figureEchoIn': 'wpływy {amount} {currency}',
  'skills.bankAnalysis.figureEchoOut': 'wypływy {amount} {currency}',
  'skills.bankAnalysis.figureEchoNet': 'zmiana netto {amount} {currency}',
  'skills.bankAnalysis.formatIntro':
    'Oto wyciąg w formacie {format}, utworzony wyłącznie z odczytanych kwot – nic nie zostało ' +
    'zsumowane z tekstu opisowego ani wymyślone:',
  'skills.bankAnalysis.formatIntroCsv':
    'Oto wyciąg w formacie CSV – tylko wiersze transakcji, utworzone z odczytanych kwot (nic nie ' +
    'zostało zsumowane z tekstu opisowego ani wymyślone). Podsumowania przepływów pieniężnych ' +
    'ani sald początkowego i końcowego nie ma w formacie CSV; aby je również otrzymać, poproś o ' +
    'wyciąg w formacie JSON.',
  'skills.bankAnalysis.customCategoriesNeedModel':
    'Do przypisania transakcji do własnych kategorii ({categories}) potrzebny jest działający ' +
    'model lokalny – wbudowane szybkie reguły znają tylko swój stały zestaw. Uruchom model, a ' +
    'potem zapytaj ponownie.',
  'skills.bankAnalysis.customTaxonomyNotFound':
    'Nie znaleziono pliku „{name}” wśród twoich dokumentów. Najpierw zaimportuj ten plik ' +
    '(Dokumenty → Importuj pliki), a potem zapytaj ponownie.',
  'skills.bankAnalysis.customTaxonomyUnparseable':
    'Odczytano plik „{name}”, ale nie udało się go użyć jako listy kategorii. Oczekiwany format: ' +
    'jedna kategoria w każdym wierszu, czyli etykieta, po której opcjonalnie następują słowa ' +
    'kluczowe po średniku (na przykład „Dzieci;Szkoła, Przedszkole, Kieszonkowe”).',
  'skills.bankAnalysis.derivedColumnsNote':
    '_Kolumny uzupełnione przez model lokalny na podstawie opisu każdej transakcji: {columns}. W ' +
    'razie wątpliwości pola pozostawiono puste. Wszystkie kwoty pochodzą z deterministycznego ' +
    'mechanizmu odczytu i nie zostały zmienione._',
  // ---- Invoice analysis answer (full-doc-skills plan §3.1, Phase 4 / D49) ----
  'skills.invoiceAnalysis.count': 'Odczytano całą fakturę – pozycje faktury: **{count}**.',
  'skills.invoiceAnalysis.countPartial':
    'Odczytane pozycje faktury: **{count}**. Wiersze z kwotą, której nie udało się przetworzyć ' +
    'na pozycję faktury: **{dropped}** – to mogą więc nie być wszystkie wiersze. Porównaj te ' +
    'wiersze z dokumentem.',
  'skills.invoiceAnalysis.empty':
    'Przeanalizowano cały dokument, ale nie udało się odczytać z niego żadnych pozycji ani sum. ' +
    'Kwoty mogą znajdować się na zeskanowanym obrazie albo mieć nietypowy układ, którego ' +
    'mechanizm odczytu nie potrafi przetworzyć. Jeśli to skan, najpierw uruchom na nim ' +
    'rozpoznawanie tekstu (OCR); w przeciwnym razie układ może nie nadawać się do odczytu ' +
    'maszynowego – otwórz fakturę i odczytaj kwoty bezpośrednio.',
  'skills.invoiceAnalysis.couldNotRead':
    'Nie udało się odczytać tej faktury, więc nie można jej przeanalizować.',
  'skills.invoiceAnalysis.unreconciledHeading': 'Najpierw sprawdź te sumy – nie zgadzają się:',
  'skills.invoiceAnalysis.checkLineItemsSumToNet':
    'suma pozycji nie zgadza się z podaną kwotą netto',
  'skills.invoiceAnalysis.checkNetPlusTaxIsGross':
    'kwota netto plus podatek nie zgadza się z podaną sumą brutto',
  'skills.invoiceAnalysis.checkTaxMatchesRate':
    'kwota podatku nie zgadza się z podaną stawką podatku',
  'skills.invoiceAnalysis.unreconciledItem': '- {check}',
  'skills.invoiceAnalysis.totalsHeading': 'Sumy dokładnie tak, jak podano na fakturze:',
  'skills.invoiceAnalysis.net': '- Netto: **{value}**',
  'skills.invoiceAnalysis.tax': '- Podatek: **{value}**',
  'skills.invoiceAnalysis.taxWithRate': '- Podatek ({rate}%): **{value}**',
  'skills.invoiceAnalysis.gross': '- Suma brutto (do zapłaty): **{value}**',
  'skills.invoiceAnalysis.positionsHeading': 'Pozycje faktury:',
  'skills.invoiceAnalysis.positionItem': '- {description} · {amount} {currency}',
  'skills.invoiceAnalysis.positionsMore':
    '… i jeszcze **{count}** – aby zobaczyć wszystkie wiersze, poproś o eksport faktury do ' +
    'formatu CSV.',
  'skills.invoiceAnalysis.formatIntro':
    'Oto faktura w formacie {format}, utworzona wyłącznie z odczytanych kwot – nic nie zostało ' +
    'zsumowane z tekstu opisowego ani wymyślone:',
  'skills.invoiceAnalysis.formatIntroCsv':
    'Oto faktura w formacie CSV – tylko pozycje faktury, utworzone z odczytanych kwot (nic nie ' +
    'zostało zsumowane z tekstu opisowego ani wymyślone). Nagłówka (sprzedawca, numer faktury, ' +
    'daty) ani sum nie ma w formacie CSV; aby je również otrzymać, poproś o fakturę w formacie ' +
    'JSON lub XML.',
  'skills.invoiceAnalysis.noTotals':
    'Na fakturze nie udało się odczytać kwoty netto, podatku ani sumy brutto.',
  'skills.invoiceAnalysis.caveat':
    'Te kwoty pochodzą bezpośrednio z faktury i odczytano je z całego dokumentu – nic tu nie ' +
    'zostało zsumowane z tekstu opisowego ani wymyślone.',
  'skills.invoiceAnalysis.dateOrderCaveat':
    'Uwaga dotycząca dat: na tej fakturze nic nie wskazuje, czy dzień stoi przed miesiącem, czy ' +
    'po nim, więc daty odczytano z dniem na początku (dzień.miesiąc.rok) – data taka jak 03.05. ' +
    'może oznaczać 3 maja albo 5 marca. Każdą ważną datę sprawdź w dokumencie.',
  'skills.invoiceAnalysis.detailsHeading': 'Szczegóły tak, jak podano na fakturze:',
  'skills.invoiceAnalysis.detailVendor': '- Sprzedawca: {vendor}',
  'skills.invoiceAnalysis.detailRecipient': '- Nabywca (odbiorca faktury): {recipient}',
  'skills.invoiceAnalysis.detailInvoiceNumber': '- Numer faktury: {number}',
  'skills.invoiceAnalysis.detailInvoiceDate': '- Data wystawienia: {date}',
  'skills.invoiceAnalysis.detailDueDate': '- Termin płatności: {date}',
  'skills.invoiceAnalysis.figureEcho':
    'Kwoty w odczytanej postaci, dosłownie z dokumentu: {figures}.',
  'skills.invoiceAnalysis.figureEchoNet': 'netto {value}',
  'skills.invoiceAnalysis.figureEchoTax': 'podatek {value}',
  'skills.invoiceAnalysis.figureEchoGross': 'brutto {value}',
  'skills.invoiceAnalysis.totalsHeadingUnverified':
    'Kwoty tak, jak podano – **nie zgadzają się**, więc traktuj je jako niesprawdzone:',
  'skills.invoiceAnalysis.unreconciledCaveat':
    'Te podane kwoty są ze sobą sprzeczne, co zwykle oznacza, że tekstu dokumentu nie udało się ' +
    'poprawnie wyodrębnić (skan, plik PDF złożony z obrazów lub nietypowy układ). Nie polegaj na ' +
    'żadnej z tych liczb bez sprawdzenia ich w samym dokumencie.',
  'skills.invoiceAnalysis.figureEchoSuppressed':
    'Odczytane sumy nie są tu powtarzane: nie zgadzają się ze sobą ani z pozycjami faktury, więc ' +
    'podawanie ich jako wiarygodnych kwot wprowadzałoby w błąd. Sprawdź sam dokument.',
  'skills.invoiceAnalysis.unreadableLayout':
    'Tekstu tego dokumentu nie da się poprawnie wyodrębnić – znaki są pomieszane (znak po ' +
    'znaku), co zwykle oznacza plik PDF złożony z obrazów lub nietypowo zakodowany. Nie udało ' +
    'się odczytać z niego wiarygodnych pozycji ani sum, więc kwoty nie zostaną podane. Jeśli to ' +
    'skan, najpierw uruchom na nim rozpoznawanie tekstu (OCR); w przeciwnym razie otwórz fakturę ' +
    'i odczytaj kwoty bezpośrednio.',
  'skills.invoiceAnalysis.textQualityCaveat':
    'Uwaga: część tekstu tego dokumentu została wyodrębniona w pomieszanym układzie (znak po ' +
    'znaku). Powyższe kwoty się zgadzają, ale wszystko, co ważne, sprawdź w samym dokumencie.',
  'skills.analysis.refusePartial':
    'Dokładna odpowiedź na to pytanie wymaga całego dokumentu, a ten nie jest jeszcze w pełni ' +
    'zindeksowany. Otwórz ekran Dokumenty i wybierz „Indeksuj ponownie”, a potem zapytaj ' +
    'ponownie.',
  'skills.analysis.scopeNarrowed':
    'Odpowiedź opiera się tylko na dokumencie **{title}**. Pozostałe wybrane dokumenty, których ' +
    'nie odczytano: {count}. Aby przeanalizować inny dokument, zaznacz tylko ten jeden (albo ' +
    'podaj nazwę jego pliku w pytaniu) i zapytaj ponownie.',
  'skills.analysis.selectOne':
    'Do pełnej analizy potrzebny jest jeden dokument. W tej chwili wybrane dokumenty: {count}, ' +
    'więc widać tylko kilka fragmentów z nich. Zaznacz jeden dokument (albo podaj nazwę jego ' +
    'pliku w pytaniu) i zapytaj ponownie.',
  'skills.analysis.selectTwo':
    'Aby porównać, zaznacz dokładnie **dwa** dokumenty (albo dwie wersje). W tej chwili wybrane ' +
    'dokumenty: {count}. Zaznacz te dwa, które chcesz porównać, i zapytaj ponownie.',
  'skills.redactionRouting.answer':
    'Aby ukryć dane osobowe w tym dokumencie, kliknij przycisk **{button}** tuż nad polem ' +
    'wiadomości, a potem wybierz, gdzie zapisać kopię. Narzędzie działa w całości na tym ' +
    'urządzeniu, odczytuje cały dokument i ukrywa dane osobowe w wyraźnym formacie – adresy ' +
    'e-mail, numery telefonów, numery IBAN, daty i linki. To wstępny etap, działający w miarę ' +
    'możliwości, bez gwarancji: nie wykrywa imion i nazwisk ani nietypowych formatów, więc przed ' +
    'udostępnieniem sprawdź zapisaną kopię.',
  'skills.redactionRouting.answerMulti':
    'Aby ukryć dane osobowe w dokumencie, kliknij przycisk **{button}** tuż nad polem wiadomości ' +
    'i wybierz dokument, a potem miejsce zapisu kopii. Narzędzie przetwarza jeden dokument ' +
    'naraz, działa w całości na tym urządzeniu, odczytuje cały dokument i ukrywa dane osobowe w ' +
    'wyraźnym formacie – adresy e-mail, numery telefonów, numery IBAN, numery kart płatniczych, ' +
    'daty i linki. To wstępny etap, działający w miarę możliwości, bez gwarancji: nie wykrywa ' +
    'imion i nazwisk ani nietypowych formatów, więc przed udostępnieniem sprawdź zapisaną kopię.',
  'skills.editRouting.answer':
    'Aby wprowadzić te zmiany, kliknij przycisk **{button}** tuż nad polem wiadomości, a potem ' +
    'wybierz, gdzie zapisać edytowaną kopię. Narzędzie działa w całości na tym urządzeniu i ' +
    'wprowadza tylko dokładne zmiany metodą „znajdź i zamień”, o które prosisz – wszędzie tam, gdzie ' +
    'tekst występuje dosłownie, a całą resztę pozostawia bez zmian. Nigdy nie przepisuje dokumentu, ' +
    'więc niczego nie może wymyślić ani przeredagować. Dokument Word zachowuje format .docx; ' +
    'dokumenty w innych formatach są zapisywane jako pliki tekstowe (.txt). Sprawdź kopię przed ' +
    'udostępnieniem.',
  'skills.editRouting.answerMulti':
    'Aby wprowadzić te zmiany, kliknij przycisk **{button}** tuż nad polem wiadomości i wybierz ' +
    'dokument do edycji, a potem miejsce zapisu edytowanej kopii. Narzędzie przetwarza jeden ' +
    'dokument naraz, działa w całości na tym urządzeniu i wprowadza tylko dokładne zmiany metodą ' +
    '„znajdź i zamień”, o które prosisz – wszędzie tam, gdzie tekst występuje dosłownie, a całą ' +
    'resztę pozostawia bez zmian. Nigdy nie przepisuje dokumentu. Dokument Word zachowuje format ' +
    '.docx; dokumenty w innych formatach są zapisywane jako pliki tekstowe (.txt). Sprawdź kopię ' +
    'przed udostępnieniem.',
  'skills.redactionRouting.scan':
    'Przeszukano cały dokument pod kątem danych osobowych w wyraźnym formacie. Wykryte dane – ' +
    'adresy e-mail: {email}, numery telefonów: {phone}, numery IBAN: {iban}, numery kart ' +
    'płatniczych: {card}, daty: {date}, linki: {url}. To wyszukiwanie wzorców działające w miarę ' +
    'możliwości: nie wykrywa imion i nazwisk, adresów pocztowych ani nietypowych formatów, więc ' +
    'traktuj te liczby jako minimum, a nie pełny spis. Aby utworzyć kopię z ukrytymi danymi ' +
    'osobowymi, kliknij przycisk **{button}** tuż nad polem wiadomości i wybierz, gdzie ją ' +
    'zapisać.',
  // ---- Models (ModelsScreen.tsx) ----
  'models.title': 'Model AI',
  'models.library.title': 'Biblioteka modeli',
  'models.library.view': 'Widok biblioteki modeli',
  'models.library.onDrive': 'Na tym dysku',
  'models.library.browse': 'Przeglądaj modele',
  'models.library.search': 'Szukaj modeli',
  'models.library.searchPlaceholder': 'Nazwa, rodzina lub wariant…',
  'models.library.task': 'Zadanie',
  'models.library.allTasks': 'Wszystkie zadania',
  'models.library.family': 'Rodzina',
  'models.library.allFamilies': 'Wszystkie rodziny',
  'models.library.familyNotInView': '{name} (brak w tym widoku)',
  'models.library.resetFamily': 'Wszystkie rodziny',
  'models.library.noFamilyForTask': 'Żaden model z rodziny {family} nie pasuje do tego zadania.',
  'models.library.noFamilyOnDrive.one':
    'Na tym dysku nie ma modeli z rodziny {family}. Widok „Przeglądaj modele” pokazuje {count} ' +
    'model.',
  'models.library.noFamilyOnDrive.few':
    'Na tym dysku nie ma modeli z rodziny {family}. Widok „Przeglądaj modele” pokazuje {count} ' +
    'modele.',
  'models.library.noFamilyOnDrive.many':
    'Na tym dysku nie ma modeli z rodziny {family}. Widok „Przeglądaj modele” pokazuje {count} ' +
    'modeli.',
  'models.library.noFamilyOnDrive.other':
    'Na tym dysku nie ma modeli z rodziny {family}. Widok „Przeglądaj modele” pokazuje {count} ' +
    'modelu.',
  'models.library.chat': 'Czat',
  'models.library.translation': 'Tłumaczenie',
  'models.library.images': 'Obrazy',
  'models.library.voice': 'Mowa',
  'models.library.memory': 'Minimalna pamięć: {size}',
  'models.library.clear': 'Wyczyść filtry',
  'models.library.showVariants': 'Pokaż wszystkie warianty ({count})',
  'models.library.hideVariants': 'Pokaż mniej wariantów ({count})',
  'models.library.results.one': '{count} pasujący wariant',
  'models.library.results.few': '{count} pasujące warianty',
  'models.library.results.many': '{count} pasujących wariantów',
  'models.library.results.other': '{count} pasującego wariantu',
  'models.library.noMatches':
    'Żaden model nie pasuje do tych filtrów. Spróbuj innego wyszukiwania albo wyczyść filtry.',
  'models.library.noneInstalled': 'Na tym dysku nie ma jeszcze modeli gotowych do użycia.',
  'models.library.onlyActive':
    'Twój zainstalowany model jest widoczny powyżej. Przejrzyj katalog, aby znaleźć inne modele.',
  'models.library.noAlternatives': 'W tym katalogu nie ma innych modeli.',
  'models.library.download': 'Bieżące pobieranie modelu',
  'models.lead':
    'Model AI odpowiada na twoje pytania, działając w całości na tym urządzeniu. Wszystko jest ' +
    'sprawdzane przed użyciem, a nic nie jest pobierane bez twojego wyraźnego potwierdzenia.',
  'models.loadError': 'Nie udało się wczytać modeli: {error}',
  'models.checking':
    'Sprawdzanie plików modeli… Pierwsze sprawdzenie po dodaniu lub zaktualizowaniu modelu może ' +
    'w przypadku dużych plików potrwać kilka minut; potem wynik jest zapamiętywany i sprawdzanie ' +
    'odbywa się natychmiast.',
  'models.checkingProgress': 'Sprawdzanie modelu {n} z {m}: {name} – {pct}%',
  'models.state.installed': 'Zainstalowany',
  'models.state.missing': 'Niepobrany',
  'models.state.checksumFailed': 'Nie można sprawdzić',
  'models.state.unsupported': 'Nieobsługiwany',
  'models.state.notRecommended': 'Niezalecany',
  'models.state.ready': 'Gotowy',
  'models.state.running': 'Działa',
  'models.badge.notResponding': 'Nie odpowiada',
  'models.notRespondingHint':
    'Model AI przestał odpowiadać. Ponowne uruchomienie zwykle rozwiązuje ten problem.',
  'models.restart': 'Uruchom ponownie',
  'models.hint.embeddings': 'Przygotowuje dokumenty, żeby można było o nie pytać.',
  'models.hint.reranker': 'Lepiej dobiera fragmenty dokumentów używane w odpowiedziach.',
  'models.hint.transcriber':
    'Zamienia nagrania audio w tekst, który można przeszukiwać – i włącza w czacie przycisk ' +
    'dyktowania 🎤.',
  'models.hint.translation': 'Tłumaczy dokumenty i tekst między językami, całkowicie offline.',
  'models.hint.vision':
    'Odpowiada na pytania dotyczące jednego obrazu naraz. Nie odczytuje plików PDF i nie ' +
    'umożliwia wyszukiwania w skanach.',
  'models.hint.small': 'Mały i zwinny – szybkie odpowiedzi na prawie każdym komputerze.',
  'models.hint.balanced': 'Zrównoważony – dobrze działa na większości laptopów.',
  'models.hint.large': 'Duży – najlepsze odpowiedzi; wymaga wydajnego komputera.',
  'models.usesSpace': 'Zajmuje {size} miejsca na dysku',
  'models.downloads.blockedByPolicy': 'Pobieranie jest wyłączone przez zasady tego dysku.',
  'models.downloads.enableInSettings':
    'Aby rozpocząć pobieranie, włącz w Ustawieniach opcję „Zezwalaj na dostęp do internetu, aby ' +
    'pobierać pliki i aktualizacje”.',
  'models.download.verifying': 'Sprawdzanie pobranego pliku…',
  'models.download.progress': 'Pobieranie… {pct}% ({received} z {total})',
  'models.download.progressNoTotal': 'Pobieranie… pobrano: {received}',
  'models.download.cancel': 'Anuluj pobieranie',
  'models.download.cancelled':
    'Anulowano pobieranie – ponowne rozpoczęcie wznowi je od miejsca, w którym zostało przerwane.',
  'models.download.stoppedNetworkOff':
    'Pobieranie zostało zatrzymane, ponieważ wyłączono dostęp do internetu – gdy znów będzie ' +
    'włączony, ponowne rozpoczęcie pobierania wznowi je od miejsca, w którym zostało przerwane.',
  'models.download.unverifiedBefore':
    'Pobrano, ale manifest tego modelu nie ma jeszcze prawdziwej sumy kontrolnej, więc plik ' +
    'zostaje niesprawdzony. Wygeneruj ją poleceniem ',
  'models.download.unverifiedAfter': '.',
  'models.download.otherRunning': 'Trwa już inne pobieranie – modele są pobierane pojedynczo',
  'models.download.titled': 'Pobierz model {name} ({size})',
  'models.download.resume': 'Wznów pobieranie',
  'models.download.start': 'Pobierz',
  'models.download.failed': 'Pobieranie modelu {name} nie powiodło się.',
  'models.download.retry': 'Pobierz ponownie',
  'models.download.dismiss': 'Ukryj',
  'models.download.retryUnavailable':
    'Ten model nie jest już tutaj oferowany do pobrania, więc nie można ponowić pobierania z ' +
    'tego wyniku. Ukryj ten wynik albo poszukaj modelu w bibliotece.',
  'models.download.retryInstalled': 'Jest już na tym dysku.',
  'models.download.withdrawn':
    'Pobieranie nie jest już możliwe: wydawca usunął dokładnie ten plik ({reason}). Kopie, które ' +
    'już są na dysku, nadal działają i wciąż można je sprawdzić.',
  'models.engine.title': 'Zainstaluj silnik AI',
  'models.engine.explain':
    'Dopóki silnik AI nie zostanie zainstalowany, modele działają we wbudowanym trybie demo (z ' +
    'wyraźnie symulowanymi odpowiedziami); dyktowanie wymaga silnika mowy. Zainstaluj silniki ' +
    'raz – a potem uruchom model, aby otrzymywać prawdziwe odpowiedzi.',
  'models.engine.install': 'Zainstaluj silnik AI',
  'models.engine.retry': 'Spróbuj ponownie',
  'models.engineProblem.title': 'Silnik AI nie może działać na tym komputerze',
  'models.engineProblem.voiceTitle': 'Silnik mowy nie może działać na tym komputerze.',
  'models.engineProblem.libraryMissingPackage':
    'Brakuje potrzebnej mu biblioteki systemowej: {library}. Zainstaluj pakiet {debPackage} ' +
    '(Ubuntu, Debian, Linux Mint) albo {rpmPackage} (Fedora) za pomocą menedżera oprogramowania ' +
    'lub terminala, a potem wybierz „Sprawdź ponownie”.',
  'models.engineProblem.libraryMissing':
    'Brakuje potrzebnej mu biblioteki systemowej: {library}. Zainstaluj ją za pomocą menedżera ' +
    'oprogramowania lub terminala, a potem wybierz „Sprawdź ponownie”.',
  'models.engineProblem.systemTooOldLinux':
    'Wymaga nowszego systemu Linux: Ubuntu 22.04, Debian 12, Fedora 36 lub nowszego.',
  'models.engineProblem.systemTooOldMac':
    'Wymaga nowszej wersji systemu macOS. Zaktualizuj macOS, a potem wybierz „Sprawdź ponownie”.',
  'models.engineProblem.systemTooOld': 'Wymaga nowszej wersji systemu operacyjnego.',
  'models.engineProblem.vcRuntimeMissing':
    'W systemie Windows brakuje potrzebnego mu pakietu Microsoft Visual C++ Redistributable ' +
    '(x64). Zainstaluj go, a potem wybierz „Sprawdź ponownie”.',
  'models.engineProblem.filesDamaged':
    'Brakuje niektórych jego plików na tym dysku albo są one uszkodzone. Instrukcja ' +
    'rozwiązywania problemów wyjaśnia, jak go ponownie skonfigurować.',
  'models.engineProblem.filesDamagedReinstall':
    'Brakuje niektórych jego plików na tym dysku albo są one uszkodzone. Zainstaluj go ponownie, ' +
    'aby je zastąpić.',
  'models.engineProblem.filesDamagedAfterInstall':
    'Został właśnie zainstalowany i nadal nie może się uruchomić, więc jego pliki raczej nie są ' +
    'przyczyną. Instrukcja rozwiązywania problemów wyjaśnia, co jeszcze sprawdzić.',
  'models.engineProblem.filesDamagedAfterInstallWin':
    'Został właśnie zainstalowany i nadal nie może się uruchomić, więc jego pliki raczej nie są ' +
    'przyczyną. Może to też powodować nieaktualny pakiet Microsoft Visual C++ Redistributable ' +
    '(x64): zainstaluj aktualną wersję, a potem wybierz „Sprawdź ponownie”.',
  'models.engineProblem.reinstall': 'Zainstaluj silnik AI ponownie',
  'models.engineProblem.voiceReinstall': 'Zainstaluj silnik mowy ponownie',
  'models.engineProblem.reinstalled': 'Silnik AI został ponownie zainstalowany.',
  'models.engineProblem.voiceReinstalled': 'Silnik mowy został ponownie zainstalowany.',
  'models.engineUpdate.title': 'Dostępna jest aktualizacja silnika AI',
  'models.engineUpdate.voiceTitle': 'Dostępna jest aktualizacja silnika mowy',
  'models.engineUpdate.bothTitle': 'Dostępne są aktualizacje silnika AI i silnika mowy',
  'models.engineUpdate.explain':
    'Na tym dysku jest starsza wersja, niż wymaga ta aplikacja. Aktualizacja najpierw pobiera ' +
    'nową wersję; potem modele wstrzymują pracę na kilka sekund, gdy pliki są zastępowane, a ' +
    'wybrany model uruchamia się ponownie.',
  'models.engineUpdate.update': 'Aktualizuj',
  'models.engineUpdate.done': 'Silnik AI został zaktualizowany.',
  'models.engineUpdate.voiceDone': 'Silnik mowy został zaktualizowany.',
  'models.engineUpdate.bothDone': 'Silnik AI i silnik mowy zostały zaktualizowane.',
  'models.engineProblem.blocked':
    'Zabezpieczenia Windows zablokowały go (Inteligentna kontrola aplikacji lub program ' +
    'antywirusowy). Instrukcja rozwiązywania problemów wyjaśnia, co możesz zrobić.',
  'models.engineProblem.demoNote':
    'Do tego czasu modele odpowiadają w trybie demo – odpowiedzi są symulowane.',
  'models.engineProblem.check': 'Sprawdź ponownie',
  'models.engineProblem.checking': 'Sprawdzanie…',
  'models.engineProblem.stillFailing':
    'Nadal nie może się uruchomić. Sprawdź, czy instalacja się zakończyła, i spróbuj ponownie.',
  'models.engineProblem.fixed': 'Silnik AI znów działa.',
  'models.engineProblem.voiceFixed': 'Silnik mowy znów działa.',
  'models.engine.progress': 'Pobieranie silnika AI… {pct}%',
  'models.engine.downloadingNoTotal': 'Pobieranie silnika AI…',
  'models.engine.verifying': 'Sprawdzanie silnika AI…',
  'models.engine.extracting': 'Rozpakowywanie silnika AI…',
  'models.voiceEngine.title': 'Dodaj dyktowanie (opcjonalnie)',
  'models.voiceEngine.explain':
    'Odpowiedzi w czacie i odpowiedzi na podstawie dokumentów już działają na tym dysku. Silnik ' +
    'mowy jest opcjonalny – zainstaluj go tylko wtedy, gdy chcesz dyktować wiadomości przez ' +
    'mikrofon.',
  'models.voiceEngine.install': 'Zainstaluj silnik mowy',
  'models.packTools.row': 'Narzędzia pakietów wiedzy: niezainstalowane',
  'models.packTools.install': 'Zainstaluj…',
  'models.ocr.row': 'Rozpoznawanie tekstu w skanach i zdjęciach (opcjonalne)',
  'models.ocr.rowOrientation':
    'Do obracania skanów ułożonych bokiem potrzebny jest jeszcze jeden plik OCR (opcjonalny)',
  'ocr.install.action': 'Pobierz pliki OCR',
  'ocr.install.actionTitle': 'Pobierz pliki językowe rozpoznawania tekstu (OCR) dla skanów i zdjęć',
  'ocr.install.confirm.title': 'Pobrać pliki OCR?',
  'ocr.install.confirm.explain':
    'Rozpoznawanie tekstu (OCR) odczytuje zeskanowane pliki PDF i sfotografowane strony na tym ' +
    'komputerze. Potrzebuje do tego poniższych plików na tym dysku – nic innego nie jest ' +
    'pobierane, a twoje dokumenty nigdy nie opuszczają tego komputera.',
  'ocr.install.confirm.languages': 'Pliki',
  'ocr.install.confirm.hint':
    'Przed użyciem każdy plik jest porównywany z oczekiwaną sumą kontrolną.',
  'ocr.install.confirm.start': 'Pobierz',
  'ocr.install.lang.deu': 'niemiecki',
  'ocr.install.lang.eng': 'angielski',
  'ocr.install.lang.osd': 'orientacja stron (obraca strony ułożone bokiem)',
  'ocr.install.starting': 'Rozpoczynanie pobierania…',
  'ocr.install.progress': 'Pobieranie plików OCR… {pct}%',
  'ocr.install.verifying': 'Sprawdzanie plików OCR…',
  'ocr.install.activating': 'Uruchamianie rozpoznawania tekstu…',
  'ocr.install.failed': 'Nie udało się zainstalować plików OCR.',
  'ocr.install.retry': 'Pobierz ponownie pliki OCR',
  'ocr.install.cancel': 'Anuluj pobieranie plików OCR',
  'ocr.install.alreadyPresent':
    'Pliki OCR są już na tym dysku. Uruchom ponownie aplikację HilbertRaum, aby ich użyć.',
  'ocr.install.outcome.activated':
    'Rozpoznawanie tekstu jest gotowe – ponowne uruchomienie nie jest potrzebne.',
  'ocr.install.outcome.restartRequired':
    'Pliki OCR są na miejscu. Uruchom ponownie aplikację HilbertRaum, aby używać nowych plików ' +
    'językowych.',
  'ocr.install.outcome.unchanged':
    'Pliki OCR są na miejscu. Jeśli rozpoznawanie tekstu nadal nie jest dostępne, uruchom ' +
    'ponownie aplikację HilbertRaum.',
  'models.ram.needs': 'Wymaga co najmniej {min}\u00A0GB pamięci RAM',
  'models.ram.machine': ' – ten komputer ma około {ram}\u00A0GB',
  'models.ram.advice': '. Wybierz mniejszy model – jakość pozostanie bardzo dobra.',
  'models.badge.active': 'Aktywny',
  'models.badge.recommended': 'Zalecany dla tego komputera',
  'models.badge.ramNeeded': 'Wymaga ≥{min}\u00A0GB RAM',
  'models.automatic.installed':
    'Zainstalowany – używany automatycznie. Nie trzeba niczego uruchamiać.',
  'models.automatic.notInstalled':
    'Po zainstalowaniu jest używany automatycznie – nie wymaga konfiguracji.',
  'models.transcriber.engineUnsupported':
    'W tym systemie operacyjnym aplikacja nie może jeszcze zainstalować silnika mowy, więc ten ' +
    'model nie włącza tu dyktowania ani importu nagrań audio.',
  'models.vision.installed':
    'Zainstalowany – używany automatycznie na ekranie Obrazy. Nie trzeba tu niczego uruchamiać.',
  'models.vision.notInstalled':
    'Po zainstalowaniu jest używany automatycznie na ekranie Obrazy – nie wymaga konfiguracji.',
  'models.vision.goToImages': 'Otwórz ekran Obrazy',
  'models.translation.installed':
    'Zainstalowany – używany automatycznie do tłumaczenia. Nie trzeba tu niczego uruchamiać.',
  'models.translation.notInstalled':
    'Po zainstalowaniu jest używany automatycznie do tłumaczenia – nie wymaga konfiguracji.',
  'models.use': 'Użyj tego modelu',
  'models.useTitle': 'Wybierz ten model i uruchom go, aby rozpocząć czat',
  'models.stopRuntime': 'Zatrzymaj model',
  'models.answeringNote':
    'Trwa pisanie odpowiedzi. Zatrzymanie lub zmiana modelu ją zakończy – dotychczasowy tekst ' +
    'zostanie zachowany.',
  'models.startMock': 'Wypróbuj w trybie demo',
  'models.starting': 'Uruchamianie…',
  'models.startingTitle':
    'Ten model się wczytuje – w przypadku dużych modeli może to chwilę potrwać',
  'models.startMockTitle':
    'Nie ma jeszcze pliku modelu – wypróbuj aplikację w trybie demo, z wyraźnie symulowanymi ' +
    'odpowiedziami',
  'models.tech.summary': 'Szczegóły techniczne',
  'models.tech.id': 'Identyfikator modelu',
  'models.tech.family': 'Rodzina',
  'models.tech.format': 'Format',
  'models.tech.runtime': 'Silnik',
  'models.tech.license': 'Licencja',
  'models.tech.sizeOnDisk': 'Rozmiar na dysku',
  'models.tech.minRam': 'Minimalna pamięć RAM',
  'models.tech.recRam': 'Zalecana pamięć RAM',
  'models.tech.context': 'Okno kontekstu',
  'models.tech.contextValue.one': '{count} token',
  'models.tech.contextValue.few': '{count} tokeny',
  'models.tech.contextValue.many': '{count} tokenów',
  'models.tech.contextValue.other': '{count} tokena',
  'models.tech.file': 'Plik',
  // ---- Context-size picker (2026-07-04 user report — the truncation hint points here) ----
  'models.context.title': 'Rozmiar kontekstu',
  'models.context.label': 'Okno kontekstu dla odpowiedzi:',
  'models.context.auto': 'Automatycznie – rozmiar zalecany dla modelu',
  'models.context.autoResolved.one': 'Automatycznie – rozmiar zalecany dla modelu ({count} token)',
  'models.context.autoResolved.few': 'Automatycznie – rozmiar zalecany dla modelu ({count} tokeny)',
  'models.context.autoResolved.many':
    'Automatycznie – rozmiar zalecany dla modelu ({count} tokenów)',
  'models.context.autoResolved.other':
    'Automatycznie – rozmiar zalecany dla modelu ({count} tokena)',
  'models.context.bigWarning':
    'Bardzo duże okna kontekstu wymagają dużo dodatkowej pamięci podczas działania modelu. Na ' +
    'komputerach z mniejszą ilością pamięci model może się nie uruchomić albo odpowiadać ' +
    'znacznie wolniej – w takim przypadku wybierz mniejszy rozmiar albo opcję „Automatycznie”.',
  'models.context.hint':
    'Większy kontekst pozwala rozmowie lub odpowiedzi na podstawie dokumentów objąć więcej ' +
    'tekstu naraz, ale wymaga więcej pamięci i może spowolnić odpowiedzi. Zmiana działa od ' +
    'następnego uruchomienia modelu.',
  'models.context.restartHint':
    'Teraz działa model – zatrzymaj go i uruchom ponownie, aby zastosować nowy rozmiar.',
  'models.verifyTitle':
    'Ponownie oblicz sumę kontrolną pliku na dysku i porównaj ją z oczekiwaną sumą SHA-256 (z ' +
    'pominięciem pamięci podręcznej)',
  'models.verifying': 'Sprawdzanie…',
  'models.verify': 'Sprawdź plik',
  'models.verifyAll': 'Sprawdź wszystkie pliki modeli',
  'models.verifyingAll': 'Sprawdzanie wszystkich plików modeli…',
  'models.verifyAllTitle': 'Ponownie porównaj każdy plik modelu na tym dysku z jego sumą SHA-256',
  'models.verifyAllHint':
    'Każdy model jest sprawdzany przy uruchomieniu. Ta opcja sprawdza zamiast tego wszystkie ' +
    'pliki modeli na tym dysku – na powolnym dysku może to potrwać kilka minut. Możesz to ' +
    'zatrzymać w dowolnym momencie; wyniki już sprawdzonych plików zostają zachowane.',
  'models.verifyAllStop': 'Zatrzymaj sprawdzanie',
  'models.verifyAllStopping': 'Zatrzymywanie…',
  'models.confirm.title': 'Pobrać model {name}?',
  'models.confirm.start': 'Rozpocznij pobieranie',
  'models.confirm.size': 'Rozmiar',
  'models.confirm.license': 'Licencja',
  'models.confirm.from': 'Źródło',
  'models.confirm.readLicense': 'Przeczytaj licencję',
  'models.confirm.hint':
    'Pobrany plik jest sprawdzany przed użyciem. To jedyne połączenie z siecią, jakie nawiązuje ' +
    'aplikacja – nie są wysyłane żadne informacje o tobie ani o twoich dokumentach.',
  'models.confirm.licenseAck':
    'Potwierdzam zapoznanie się z warunkami licencji tego modelu i akceptuję je',
  'models.empty.title': 'Nie znaleziono manifestów modeli',
  'models.empty.lineBefore': 'Dodaj manifesty YAML w folderze ',
  'models.empty.lineAfter': ' na dysku.',
  'models.section.yourModel': 'Twój model AI',
  'models.section.docSearch': 'Wyszukiwanie w dokumentach',
  // ---- Settings (SettingsScreen.tsx — chrome + the General tab) ----
  'settings.title': 'Ustawienia',
  'settings.tabsAria': 'Sekcje ustawień',
  'settings.tab.general': 'Ogólne',
  'settings.tab.privacy': 'Prywatność i dane',
  'settings.tab.skills': 'Umiejętności',
  'settings.tab.diagnostics': 'Diagnostyka (zaawansowane)',
  'settings.loading': 'Wczytywanie ustawień…',
  'settings.saved': 'Zapisano',
  'settings.saveFailed': 'Nie udało się zapisać tego ustawienia. Spróbuj ponownie.',
  'settings.network.title': 'Prywatność i tryb offline',
  'settings.network.allow': 'Zezwalaj na dostęp do internetu, aby pobierać pliki i aktualizacje',
  'settings.network.hint':
    'Domyślnie włączone, aby nowa instalacja mogła od razu pobrać model. Gdy ta opcja jest ' +
    'wyłączona, aplikacja nie łączy się z internetem. Po jej włączeniu można pobierać modele, ' +
    'silnik AI, opcjonalne narzędzia pakietów wiedzy i opcjonalne pliki rozpoznawania tekstu ' +
    '(OCR) – każde pobieranie najpierw wymaga potwierdzenia, a zasady dysku mogą całkowicie ' +
    'wyłączyć pobieranie. Twoje pytania i dokumenty nigdy nie opuszczają tego urządzenia, ' +
    'niezależnie od tego ustawienia.',
  'settings.appearance.title': 'Wygląd',
  'settings.appearance.aria': 'Motyw',
  'settings.appearance.system': 'Systemowy',
  'settings.appearance.light': 'Jasny',
  'settings.appearance.dark': 'Ciemny',
  'settings.appearance.hint':
    '„Systemowy” używa jasnego lub ciemnego motywu zgodnie z ustawieniem systemu operacyjnego. ' +
    'Ekran blokady zawsze używa motywu systemu.',
  'settings.language.title': 'Język',
  'settings.language.aria': 'Język',
  'settings.language.system': 'Systemowy',
  'settings.language.hint':
    '„Systemowy” używa języka systemu operacyjnego, jeśli HilbertRaum go oferuje, a w przeciwnym ' +
    'razie angielskiego. Zmiany działają od razu.',
  'settings.performance.title': 'Wydajność',
  'settings.performance.gpu': 'Używaj akceleracji GPU',
  'settings.performance.gpuHint':
    'Przyspiesza odpowiedzi za pomocą karty graficznej, jeśli jest dostępna. Wyłącz tylko wtedy, ' +
    'gdy zauważysz problemy ze stabilnością – w obu przypadkach wszystko działa dalej.',
  'settings.performance.rerankWideScope':
    'Oceniaj trafność większej liczby fragmentów z pakietów wiedzy',
  'settings.performance.rerankWideScopeHint':
    'Odpowiedź na każde pytanie trwa dłużej. Działa tylko na komputerze z wystarczającą liczbą ' +
    'wątków procesora i zainstalowanym modelem oceny trafności; komputer z kartą graficzną, ' +
    'której można użyć, i tak ocenia trafność każdego fragmentu.',
  'settings.performance.autoStart': 'Wczytuj wybrany model automatycznie po uruchomieniu aplikacji',
  'settings.performance.autoStartHint':
    'Domyślnie włączone. Model wybrany na ekranie Model AI jest wczytywany w tle przy ' +
    'uruchomieniu (w zaszyfrowanym obszarze roboczym – po odblokowaniu), dzięki czemu ekran Czat ' +
    'jest gotowy bez dodatkowych kliknięć.',
  // ---- Settings: Chat / conversation compaction (context-compaction plan §5.4) ----
  'settings.chat.title': 'Czat',
  'settings.chatCompaction.label':
    'Streszczaj starsze wiadomości, aby zwolnić miejsce w kontekście',
  'settings.chatCompaction.help':
    'Domyślnie włączone. Gdy długa rozmowa zbliża się do limitu kontekstu modelu, starsze ' +
    'wiadomości są jednorazowo streszczane w zwięzłej notatce – zapisanej na tym dysku – zamiast ' +
    'znikać bez ostrzeżenia. Wyłącz, aby zachowywać tylko najnowsze wiadomości, które się ' +
    'mieszczą.',
  'settings.developer.title': 'Dla programistów',
  'settings.developer.toggle':
    'Tryb programisty (pozwala na obszar roboczy bez szyfrowania i niesprawdzone modele)',
  'settings.developer.hint':
    'Domyślnie wyłączone. Wersje rozwojowe aplikacji zawsze działają w trybie programisty. ' +
    'Decydują zasady dysku: na dysku komercyjnym niesprawdzone modele nadal są odrzucane, ' +
    'niezależnie od tego ustawienia.',
  'settings.workspace.title': 'Obszar roboczy',
  'settings.workspace.mode': 'Tryb',
  'settings.workspace.modeEncrypted': 'Zaszyfrowany',
  'settings.workspace.modePlaintext': 'Bez szyfrowania (tryb programisty)',
  'settings.workspace.contextTokens': 'Rozmiar kontekstu (tokeny)',
  'settings.workspace.contextAuto':
    'Automatycznie (domyślna wartość modelu) – możesz ją zmienić na ekranie Model AI',
  'settings.workspace.encryptedHint':
    'Ten obszar roboczy jest przechowywany w postaci zaszyfrowanej. Użyj przycisku „Zablokuj ' +
    'teraz” na pasku bocznym, aby ponownie go zaszyfrować i zablokować; po zamknięciu aplikacji ' +
    'blokuje się też automatycznie.',
  'settings.workspace.plaintextHint':
    'Obszar roboczy w trybie programisty bez szyfrowania – dane są przechowywane w postaci ' +
    'niezaszyfrowanej. Tryb zaszyfrowany jest domyślny w wersji komercyjnej.',
  'settings.changePassword.title': 'Zmień hasło',
  'settings.changePassword.hint':
    'Wybierz nowe hasło do tego obszaru roboczego. Będziesz go używać od następnego ' +
    'odblokowania. Nie da się go odzyskać ani zresetować, więc wybierz coś, co zapamiętasz.',
  'settings.changePassword.current': 'Obecne hasło',
  'settings.changePassword.new': 'Nowe hasło',
  'settings.changePassword.confirm': 'Potwierdź nowe hasło',
  'settings.changePassword.busy':
    'Zabezpieczanie dokumentów nowym hasłem… W przypadku dużej biblioteki może to potrwać kilka ' +
    'minut.',
  'settings.changePassword.failed': 'Coś poszło nie tak. Obecne hasło nadal działa.',
  'settings.changePassword.submit': 'Zmień hasło',
  'settings.changePassword.submitBusy': 'Zmienianie…',
  'settings.changePassword.toast': 'Zmieniono hasło',
  // ---- Skills (settings/SkillsTab.tsx, skills plan §15) ----
  'skills.intro':
    'Umiejętności uczą asystenta wykonywania konkretnego zadania. Dodają wskazówki do jego ' +
    'odpowiedzi – nigdy nie łączą się z internetem ani nie sięgają do innych folderów na twoim ' +
    'komputerze.',
  'skills.info.meeting-protocol.what':
    'Nadaje następnej odpowiedzi formę przejrzystego protokołu ze spotkania: decyzje, zadania do ' +
    'wykonania i otwarte kwestie.',
  'skills.info.meeting-protocol.needs':
    'Transkrypcja lub notatki wśród źródeł tego czatu (dołącz plik albo wklej tekst).',
  'skills.info.meeting-protocol.limits':
    'Działa na jednym dokumencie naraz i zapisuje tylko to, co rzeczywiście jest w notatkach.',
  'skills.info.contract-brief.what':
    'Streszcza umowę prostym językiem: strony umowy, daty, obowiązki, kluczowe postanowienia i ' +
    'pytania, które warto zadać.',
  'skills.info.contract-brief.needs': 'Umowa wśród źródeł tego czatu.',
  'skills.info.contract-brief.limits':
    'Pomoc w czytaniu jednego dokumentu naraz – to nie jest porada prawna.',
  'skills.info.deadline-obligation-finder.what':
    'Wyszukuje terminy, okresy wypowiedzenia, daty przedłużenia i płatności oraz związane z nimi ' +
    'obowiązki.',
  'skills.info.deadline-obligation-finder.needs': 'Dokument wśród źródeł tego czatu.',
  'skills.info.deadline-obligation-finder.limits':
    'Odczytuje jeden dokument naraz; zanim podejmiesz działania na podstawie kluczowych dat, ' +
    'sprawdź je w samym dokumencie.',
  'skills.info.what-changed.what':
    'Porównuje dwie wersje dokumentu i wskazuje istotne zmiany, a nie surowe różnice.',
  'skills.info.what-changed.needs':
    'Dokładnie dwa dokumenty (lub dwie wersje) wśród źródeł tego czatu.',
  'skills.info.what-changed.limits':
    'Gdy wśród źródeł jest więcej lub mniej niż dwa dokumenty, nie może ich porównać i odpowiada ' +
    'w zwykły sposób.',
  'skills.info.share-safe-review.what':
    'Sprawdza dokument przed udostępnieniem: widoczne informacje wrażliwe i praktyczne ryzyka ' +
    'związane z udostępnianiem.',
  'skills.info.share-safe-review.needs': 'Dokument wśród źródeł tego czatu.',
  'skills.info.share-safe-review.limits':
    'Ma wyłącznie charakter doradczy – nigdy nie twierdzi, że dokument jest zanonimizowany lub ' +
    'bezpieczny do opublikowania.',
  'skills.info.invoice.what':
    'Odczytuje fakturę z dokładnym, sprawdzalnym wyodrębnianiem danych: pozycje i sumy, ' +
    'sprawdzenie sum, eksport do CSV/JSON/XML.',
  'skills.info.invoice.needs':
    'Dokument przypominający fakturę wśród źródeł; działania tej umiejętności pojawiają się jako ' +
    'przyciski tuż nad polem wiadomości.',
  'skills.info.invoice.limits':
    'Jedna faktura naraz; suma, której nie da się sprawdzić, jest oznaczana jako niesprawdzona i ' +
    'nigdy nie jest przemilczana.',
  'skills.info.bank-statement.what':
    'Odczytuje wyciąg bankowy z dokładnym, sprawdzalnym wyodrębnianiem danych: transakcje, ' +
    'kategorie, sprawdzanie sald, eksport do CSV.',
  'skills.info.bank-statement.needs':
    'Dokument przypominający wyciąg wśród źródeł; działania tej umiejętności pojawiają się jako ' +
    'przyciski tuż nad polem wiadomości.',
  'skills.info.bank-statement.limits':
    'Jeden wyciąg naraz; przypisywanie kategorii transakcjom wymaga działającego modelu.',
  'skills.info.document-redaction.what':
    'Zapisuje kopię dokumentu z ukrytymi danymi osobowymi: wykrywanie adresów e-mail, numerów i ' +
    'dat na podstawie reguł oraz imion, nazwisk i adresów wskazanych przez model.',
  'skills.info.document-redaction.needs':
    'Dokument wśród źródeł; przycisk „Ukryj dane osobowe” pojawia się tuż nad polem wiadomości.',
  'skills.info.document-redaction.limits':
    'Wykrywanie działa w miarę możliwości, bez gwarancji – bez działającego modelu używane są ' +
    'tylko reguły; pliki Word zachowują format .docx, inne formaty są zapisywane jako .txt.',
  'skills.info.document-edit.what':
    'Wprowadza dokładne zmiany metodą „znajdź i zamień” i zapisuje edytowaną kopię – nigdy nie ' +
    'przepisuje twojego dokumentu.',
  'skills.info.document-edit.needs':
    'Działający model, dokument wśród źródeł i twoje polecenie (na przykład „zamień X na Y”); ' +
    'przycisk „Zastosuj zmiany w tekście” pojawia się tuż nad polem wiadomości.',
  'skills.info.document-edit.limits':
    'Tekst, którego nie znaleziono w dosłownym brzmieniu, jest pomijany i zgłaszany; pliki Word ' +
    'zachowują format .docx, inne formaty są zapisywane jako .txt.',
  'skills.autoFire.title': 'Automatycznie stosuj pasującą umiejętność',
  'skills.autoFire.toggle': 'Automatycznie stosuj pasującą umiejętność',
  'skills.autoFire.hint':
    'Gdy ta opcja jest włączona, aplikacja może sama zastosować do odpowiedzi wyraźnie pasującą ' +
    'umiejętność aplikacji, więc nie musisz jej wybierać. Dotyczy to tylko umiejętności ' +
    'aplikacji, nigdy własnych ani zaimportowanych. Zawsze zobaczysz, której umiejętności użyto, ' +
    'i dla danej odpowiedzi możesz ponowić pytanie bez niej. Domyślnie wyłączone.',
  'skills.autoFire.on': 'Automatyczne umiejętności włączone',
  'skills.autoFire.off': 'Automatyczne umiejętności wyłączone',
  'skills.autoFire.saveFailed': 'Nie udało się zapisać ustawienia automatycznych umiejętności.',
  'skills.import': 'Importuj umiejętność…',
  'skills.import.menuAria': 'Importuj umiejętność',
  'skills.import.fromFile': 'Z pliku (.skill.zip)…',
  'skills.import.fromFolder': 'Z folderu…',
  'skills.loading': 'Wczytywanie umiejętności…',
  'skills.loadFailed': 'Nie udało się wczytać umiejętności.',
  'skills.reconcile.folderErrors.one':
    'Pominięto {count} folder umiejętności, którego nie udało się odczytać. Jego plik SKILL.md ' +
    'nie istnieje, jest nieprawidłowy albo nieczytelny.',
  'skills.reconcile.folderErrors.few':
    'Pominięto {count} foldery umiejętności, których nie udało się odczytać. Każdy folder wymaga ' +
    'prawidłowego pliku SKILL.md.',
  'skills.reconcile.folderErrors.many':
    'Pominięto {count} folderów umiejętności, których nie udało się odczytać. Każdy folder ' +
    'wymaga prawidłowego pliku SKILL.md.',
  'skills.reconcile.folderErrors.other':
    'Pominięto {count} folderu umiejętności, którego nie udało się odczytać. Każdy folder wymaga ' +
    'prawidłowego pliku SKILL.md.',
  'skills.empty.title': 'Nie ma jeszcze umiejętności',
  'skills.empty.line':
    'Umiejętności uczą asystenta wykonywania konkretnego zadania. Dodaj umiejętność, aby zacząć.',
  'skills.trusted.app': 'Aplikacja',
  'skills.trusted.user': 'Własna',
  'skills.row.enableLabel': 'Włączona',
  'skills.row.on': 'Umiejętność włączona',
  'skills.row.off': 'Umiejętność wyłączona',
  'skills.row.onFailed': 'Nie udało się włączyć tej umiejętności.',
  'skills.row.offFailed': 'Nie udało się wyłączyć tej umiejętności.',
  'skills.dup.chip': 'Powtórzona nazwa',
  'skills.dup.title':
    'Tej nazwy używa inna zainstalowana umiejętność. W danej chwili tylko jedna może być aktywna.',
  'skills.unavailable.chip': 'Brak plików',
  'skills.unavailable.title': 'Plików tej umiejętności nie ma już na dysku.',
  'skills.incompatible.chip': 'Wymaga nowszej aplikacji',
  'skills.incompatible.title':
    'Ta umiejętność wymaga nowszej wersji aplikacji; zaktualizuj aplikację, aby ją włączyć.',
  'skills.review.chip': 'Sprawdź',
  'skills.warn.title': 'Sprawdź, co może ta umiejętność',
  'skills.warn.body':
    'Utworzona przez ciebie lub zaimportowana. Sprawdź, co może, zanim zaczniesz na niej polegać.',
  'skills.warn.ack': 'Rozumiem',
  'skills.menu.aria': 'Działania umiejętności',
  'skills.menu.export': 'Eksportuj…',
  'skills.menu.delete': 'Usuń',
  'skills.export.done': 'Wyeksportowano umiejętność',
  'skills.export.failed': 'Nie udało się wyeksportować tej umiejętności.',
  'skills.delete.title': 'Usunąć tę umiejętność?',
  'skills.delete.body':
    'Umiejętność zostanie usunięta z dysku. Czaty, w których już jej użyto, będą nadal działać.',
  'skills.delete.confirm': 'Usuń',
  'skills.delete.done': 'Usunięto umiejętność',
  'skills.delete.failed': 'Nie udało się usunąć tej umiejętności.',
  'skills.detail.aria': 'Szczegóły umiejętności',
  'skills.detail.version': 'Wersja',
  'skills.detail.author': 'Autor',
  'skills.detail.language': 'Język',
  'skills.detail.kind': 'Typ',
  'skills.kind.instruction': 'Wskazówki',
  'skills.kind.tool': 'Używa narzędzi',
  'skills.tool.note':
    'Na razie ta umiejętność dodaje tylko wskazówki. Opisane w niej narzędzia pojawią się w ' +
    'późniejszej wersji.',
  'skills.tool.note.active':
    'Na twoją prośbę ta umiejętność może uruchamiać zatwierdzone narzędzia lokalne na wybranym ' +
    'przez ciebie dokumencie. Narzędzia tylko do odczytu mogą też działać automatycznie, aby ' +
    'odpowiedzieć na twoje pytanie; wszystko, co zapisuje lub eksportuje plik, zawsze najpierw ' +
    'prosi cię o zgodę. Narzędzia widzą tylko ten dokument.',
  'skills.perm.heading': 'Co może ta umiejętność',
  'skills.perm.canTitle': 'Ta umiejętność może:',
  'skills.perm.cannotTitle': 'Ta umiejętność nie może:',
  'skills.perm.can.instructions': 'Dodawać instrukcje do odpowiedzi AI',
  'skills.perm.can.documents': 'Odczytywać tylko wybrane przez ciebie dokumenty',
  'skills.perm.can.tools': 'Używać zatwierdzonych narzędzi lokalnych na twoją prośbę',
  'skills.perm.cannot.network': 'Łączyć się z internetem',
  'skills.perm.cannot.files': 'Odczytywać innych folderów na twoim komputerze',
  'skills.perm.cannot.scripts': 'Uruchamiać skryptów ani instalować oprogramowania',
  'skills.tech.summary': 'Szczegóły techniczne',
  'skills.tech.id': 'Identyfikator umiejętności',
  'skills.tech.installId': 'Identyfikator instalacji',
  'skills.tech.source': 'Źródło',
  'skills.tech.permissions': 'Uprawnienia',
  'skills.import.title': 'Dodać tę umiejętność?',
  'skills.import.confirm': 'Dodaj umiejętność',
  'skills.import.added': 'Dodano umiejętność',
  'skills.import.failedTitle': 'Nie można dodać tej umiejętności',
  'skills.import.failed': 'Nie udało się dodać tej umiejętności.',
  'skills.import.collision':
    'Umiejętność o tej nazwie jest już zainstalowana. Dodanie tej umiejętności ją zastąpi.',
  'skills.import.collisionApp':
    'Tej nazwy używa już umiejętność aplikacji. Twoja umiejętność zostanie dodana, ale będzie ' +
    'wyłączona, dopóki umiejętność aplikacji jest włączona.',
  'skills.import.upgrade': 'Aktualizuje zainstalowaną wersję ({from} → {to}).',
  'skills.import.replace': 'Zastępuje zainstalowaną wersję ({version}).',
  'skills.import.downgrade': 'Ta wersja jest starsza niż zainstalowana ({installed}).',
  'skills.import.downgradeBlocked':
    'Instalacja starszej wersji wymaga trybu programisty. Aby na to zezwolić, włącz go tutaj: ' +
    'Ustawienia → Ogólne.',
  'skills.import.error.notFound': 'Nie znaleziono wybranej umiejętności.',
  'skills.import.error.notZipOrFolder':
    'Umiejętność musi być plikiem .skill.zip lub folderem zawierającym plik SKILL.md.',
  'skills.import.error.unreadableZip':
    'Nie udało się odczytać pakietu umiejętności jako prawidłowego archiwum ZIP.',
  'skills.import.error.encryptedZip':
    'Pakiet umiejętności używa nieobsługiwanego formatu ZIP (zaszyfrowanego lub ZIP64).',
  'skills.import.error.unsupportedCompression':
    'Pakiet umiejętności używa nieobsługiwanej metody kompresji.',
  'skills.import.error.pathTraversal':
    'Pakiet zawiera plik, którego ścieżka wychodzi poza folder pakietu.',
  'skills.import.error.absolutePath':
    'Pakiet zawiera plik ze ścieżką bezwzględną lub ze ścieżką zawierającą literę dysku.',
  'skills.import.error.invalidPath': 'Pakiet zawiera plik z nieprawidłową ścieżką.',
  'skills.import.error.symlink': 'Pakiet zawiera dowiązanie symboliczne, co jest niedozwolone.',
  'skills.import.error.tooDeep':
    'Pakiet ma więcej poziomów zagnieżdżonych folderów, niż jest to dozwolone.',
  'skills.import.error.pathTooLong': 'Pakiet zawiera za długą ścieżkę pliku.',
  'skills.import.error.tooManyFiles': 'Pakiet zawiera więcej plików, niż jest to dozwolone.',
  'skills.import.error.tooLarge': 'Pakiet przekracza dozwolony rozmiar.',
  'skills.import.error.fileTooLarge': 'Plik w pakiecie przekracza dozwolony rozmiar.',
  'skills.import.error.duplicatePath':
    'Pakiet zawiera dwa pliki, którym odpowiada ta sama ścieżka.',
  'skills.import.error.badExtension': 'Pakiet zawiera niedozwolony typ pliku.',
  'skills.import.error.nestedArchive': 'Pakiet zawiera osadzone archiwum, co jest niedozwolone.',
  'skills.import.error.noSkillMd': 'Pakiet nie zawiera pliku SKILL.md.',
  'skills.import.error.invalidManifest': 'Manifest umiejętności jest nieprawidłowy.',
  'skills.import.error.idMismatch': 'Identyfikator umiejętności nie jest prawidłową nazwą.',
  'skills.import.error.downgradeBlocked':
    'Zainstalowano już nowszą wersję tej umiejętności. Włącz tryb programisty, aby zainstalować ' +
    'starszą wersję.',
  'skills.import.error.appReadOnly': 'Umiejętności aplikacji nie można zmieniać ani usuwać.',
  'skills.import.error.locked': 'Odblokuj obszar roboczy, aby zarządzać umiejętnościami.',
  'skills.import.note.permissionNotString':
    'Uprawnienie „{field}” nie jest wartością tekstową; używana jest wartość domyślna „{value}”.',
  'skills.import.note.permissionUnrecognized':
    'Uprawnienie „{field}” ma wartość, której ta aplikacja nie rozpoznaje; używana jest wartość ' +
    'domyślna „{value}”.',
  'skills.import.note.permissionClamped':
    'Umiejętność prosi o szerszy dostęp w zakresie „{field}”, niż pozwala ta aplikacja; ' +
    'ograniczono go do wartości „{value}”.',
  'skills.import.note.listInvalid': 'Lista „{field}” nie jest listą tekstów i jest pomijana.',
  'skills.import.note.listItemsTooLong':
    'Niektóre wpisy na liście „{field}” są za długie i są pomijane.',
  'skills.import.note.listTruncated':
    'Lista „{field}” ma więcej wpisów, niż jest to dozwolone; zachowano tylko pierwsze {max}.',
  'skills.import.note.languageInvalid':
    'Pole „language” nie zawiera prawidłowego kodu języka; używany jest kod „en”.',
  'skills.import.note.allowedToolsIgnored':
    'Zadeklarowane narzędzia są pomijane w umiejętności typu „Wskazówki” (narzędzia pojawią się ' +
    'w późniejszej wersji).',
  'skills.import.note.analysisInvalid': 'Pole „analysis” ma nieznaną wartość i jest pomijane.',
  'skills.import.note.analysisIgnoredForTool':
    'Pole „analysis” jest pomijane w umiejętności typu „Używa narzędzi” (sposób analizy całego ' +
    'dokumentu określa aplikacja).',
  'skills.import.note.triggersInvalid': 'Blok „triggers” jest nieprawidłowy i jest pomijany.',
  'skills.import.note.autoFireInvalid':
    'Pole „triggers.autoFire” musi mieć wartość true albo false; jest traktowane jako false.',
  'skills.import.note.localizedInvalid': 'Blok „localized” jest nieprawidłowy i jest pomijany.',
  'skills.import.note.localizedLocaleInvalid':
    'Wpis w bloku „localized” ma nieprawidłowy klucz języka i jest pomijany.',
  'skills.import.note.localizedEntryInvalid':
    'Wpis w bloku „localized” jest nieprawidłowy i jest pomijany.',
  'skills.import.note.localizedTitleIgnored':
    'Pominięto przetłumaczony tytuł (musi to być jeden krótki wiersz).',
  'skills.import.note.localizedDescriptionIgnored':
    'Pominięto przetłumaczony opis (musi to być jeden krótki wiersz).',
  'skills.import.note.localizedTooMany':
    'Blok „localized” zawiera więcej języków, niż jest to dozwolone; zachowano tylko pierwsze ' +
    '{max}.',
  'skills.import.note.trustIgnored':
    'Pole „trust” w umiejętności jest pomijane; poziom zaufania przypisuje sama aplikacja.',
  'skills.import.note.manifestJsonConflict':
    'Pole „{field}” w dołączonym pliku manifest.json różni się od SKILL.md; używany jest plik ' +
    'SKILL.md.',
  'skills.replace.title': 'Użyć tej umiejętności zamiast drugiej?',
  'skills.replace.body':
    'Włączona jest inna umiejętność o tej nazwie. Włączenie tej umiejętności wyłączy tamtą.',
  'skills.replace.confirm': 'Włącz',
  // ---- Settings → Privacy & data tab (PrivacyTab.tsx) ----
  'privacy.offlineOn': '● Tryb offline: włączony',
  'privacy.offlineOff': '○ Dostęp do sieci włączony',
  'privacy.statement.offline':
    'Tryb offline jest włączony. HilbertRaum uruchamia model AI na tym komputerze. Twoje pytania, ' +
    'dokumenty, dane wyszukiwania i historia czatów zostają lokalnie.',
  'privacy.statement.online':
    'HilbertRaum uruchamia model AI na tym komputerze. Twoje pytania, dokumenty, dane wyszukiwania i ' +
    'historia czatów zostają lokalnie – nawet gdy dostęp do internetu jest włączony, z sieci ' +
    'korzysta tylko pobieranie (modeli, silnika AI, opcjonalnych narzędzi pakietów wiedzy i ' +
    'opcjonalnych plików rozpoznawania tekstu (OCR)).',
  'privacy.statement.noUploads':
    'Ta aplikacja nie wysyła twoich danych do dostawców AI w chmurze. Nie przesyła pytań, ' +
    'dokumentów ani danych wyszukiwania; nie ma w niej telemetrii, analityki ani zdalnego ' +
    'raportowania awarii.',
  'privacy.network.title': 'Bieżący stan sieci',
  'privacy.networkState.noPolicy': 'Tryb offline jest włączony.',
  'privacy.networkState.disabledByPolicy': 'Dostęp do sieci wyłączony przez zasady dysku.',
  'privacy.networkState.offDefault':
    'Tryb offline jest włączony (dostęp do internetu jest wyłączony w Ustawieniach).',
  'privacy.networkState.enabled':
    'Dostęp do internetu jest włączony na potrzeby pobierania modeli, silnika AI, opcjonalnych ' +
    'narzędzi pakietów wiedzy i opcjonalnych plików rozpoznawania tekstu (OCR).',
  'privacy.network.noFiles': 'Żadne pytania ani pliki nie opuszczają tego urządzenia.',
  'privacy.network.effective': 'Rzeczywisty stan',
  'privacy.network.effectiveOffline': 'Offline (bez połączeń z internetem)',
  'privacy.network.effectiveAllowed': 'Sieć dozwolona',
  'privacy.network.byPolicy': 'Dozwolone przez zasady dysku',
  'privacy.network.policyYes': 'Tak',
  'privacy.network.policyNo': 'Nie (wyłączone przez zasady dysku)',
  'privacy.network.yourSetting': 'Twoje ustawienie',
  'privacy.network.settingAllowed': 'Dostęp do internetu dozwolony',
  'privacy.network.settingOff': 'Wyłączone',
  'privacy.network.telemetry': 'Telemetria',
  'privacy.network.telemetryValue':
    'Nic nie opuszcza tego urządzenia – nie ma śledzenia do wyłączenia',
  'privacy.network.hint':
    'Aplikacja ostrzega przed każdym działaniem w internecie. Aplikacja pobiera wyłącznie modele ' +
    'AI, silnik AI, opcjonalne narzędzia pakietów wiedzy i opcjonalne pliki rozpoznawania tekstu ' +
    '(OCR) – każdy z nich dopiero po twoim potwierdzeniu i każdy sprawdzany przed użyciem. Ta ' +
    'opcja jest domyślnie włączona i można ją wyłączyć na karcie Ogólne. Zasady dysku mogą ją ' +
    'całkowicie wyłączyć. Lokalne API poniżej to osobna, domyślnie wyłączona funkcja, która ' +
    'nigdy nie korzysta z internetu.',
  'privacy.data.title': 'Gdzie są przechowywane twoje dane',
  'privacy.data.driveRoot': 'Katalog główny dysku',
  'privacy.data.workspace': 'Obszar roboczy',
  'privacy.data.models': 'Modele',
  'privacy.data.logs': 'Dzienniki',
  'privacy.data.loading': 'Wczytywanie ścieżek…',
  'privacy.data.hint':
    'Wszystko – zaimportowane dokumenty, wyodrębniony tekst, dane wyszukiwania, historia czatów, ' +
    'wygenerowane wyniki i ustawienia – jest przechowywane lokalnie w twoim obszarze roboczym. ' +
    'Aby wszystko usunąć, usuń folder obszaru roboczego.',
  'privacy.logs.title': 'Tylko lokalne dzienniki',
  'privacy.logs.hintBefore':
    'Dzienniki debugowania i diagnostyki są zapisywane w pliku z rotacją w folderze dzienników ' +
    'podanym wyżej i ',
  'privacy.logs.never': 'nigdy nie są wysyłane',
  'privacy.logs.hintAfter': '. Diagnostyka niczego nie przesyła poza to urządzenie.',
  'privacy.protection.title': 'Ochrona obszaru roboczego',
  'privacy.protection.encryptedBefore': 'Twój obszar roboczy działa w trybie ',
  'privacy.protection.encryptedWord': 'zaszyfrowanym',
  'privacy.protection.encryptedAfter': '.',
  'privacy.protection.plainBefore': 'Twój obszar roboczy działa w trybie ',
  'privacy.protection.plainWord': 'programisty bez szyfrowania',
  'privacy.protection.plainAfter':
    '. Pliki są przechowywane na dysku w postaci niezaszyfrowanej, co przyspiesza prace ' +
    'programistyczne.',
  'privacy.protection.plainWarning':
    'Tryb programisty bez szyfrowania nie jest domyślny w wersji komercyjnej. Dyski komercyjne ' +
    'używają trybu zaszyfrowanego – klucz jest wyprowadzany z hasła, a nic nie jest zapisywane ' +
    'bez szyfrowania. Nie przechowuj poufnych dokumentów w trybie bez szyfrowania na ' +
    'współdzielonym ani wymiennym dysku.',
  // ---- Settings → Privacy & data → "Local API" card (local-api wave P4) ----
  'settings.localApi.title': 'Lokalne API',
  'settings.localApi.lead':
    'Pozwól innym programom na tym komputerze wysyłać tekst do twojego modelu AI i odczytywać ' +
    'odpowiedzi. Ta funkcja jest wyłączona, dopóki jej nie włączysz.',
  'settings.localApi.toggle':
    'Pozwalaj innym aplikacjom na tym komputerze korzystać z mojego modelu AI',
  'settings.localApi.hint':
    'Połączenie nigdy nie wychodzi poza ten komputer – nic nie jest wysyłane przez internet.',
  'settings.localApi.policyOff': 'Wyłączone przez zasady dysku.',
  'settings.localApi.confirm.title': 'Pozwolić innym aplikacjom korzystać z twojego modelu?',
  'settings.localApi.confirm.what':
    'Inne programy na tym komputerze będą mogły wysyłać tekst do twojego modelu AI i odczytywać ' +
    'jego odpowiedzi.',
  'settings.localApi.confirm.boundary':
    'Nie widzą twoich dokumentów, plików ani rozmów, a za pośrednictwem aplikacji HilbertRaum ' +
    'nic nie opuszcza tego komputera. HilbertRaum nie może jednak kontrolować, co podłączony ' +
    'program robi z otrzymanymi odpowiedziami – zanim podłączysz aplikację, sprawdź, czy ' +
    'zapisuje lub synchronizuje swoje dane.',
  'settings.localApi.confirm.persists': 'Funkcja będzie włączona, dopóki jej nie wyłączysz.',
  'settings.localApi.confirm.neverStored':
    'Zapytania innych aplikacji otrzymują odpowiedź i są zapominane – nie trafiają do historii ' +
    'czatów ani do dzienników.',
  'settings.localApi.confirm.ack': 'Rozumiem, co inne aplikacje będą mogły robić.',
  'settings.localApi.confirm.cta': 'Włącz',
  'settings.localApi.connect.title': 'Połącz inną aplikację',
  'settings.localApi.connect.hint':
    'Wklej te dwie wartości do aplikacji, którą chcesz połączyć. Większość aplikacji nazywa je ' +
    '„base URL” (adres bazowy) i „API key” (klucz API).',
  'settings.localApi.connect.address': 'Adres serwera',
  'settings.localApi.connect.key': 'Klucz dostępu',
  'settings.localApi.connect.copy': 'Kopiuj',
  'settings.localApi.connect.copyAddressAria': 'Kopiuj adres serwera',
  'settings.localApi.connect.copyKeyAria': 'Kopiuj klucz dostępu',
  'settings.localApi.connect.copiedAddress': 'Skopiowano adres serwera.',
  'settings.localApi.connect.copiedKey':
    'Skopiowano – schowek zostanie automatycznie wyczyszczony za minutę. Historia schowka lub ' +
    'synchronizacja w systemie Windows może zachować kopie.',
  'settings.localApi.connect.copyFailed': 'Nie udało się skopiować. Spróbuj ponownie.',
  'settings.localApi.connect.noKey':
    'Gdy wymaganie klucza jest wyłączone, klucz dostępu nie jest potrzebny.',
  'settings.localApi.model.running': 'Model działa – inne aplikacje mogą otrzymywać odpowiedzi.',
  'settings.localApi.model.stopped':
    'Żaden model nie działa – inne aplikacje będą otrzymywać komunikat o błędzie, dopóki nie ' +
    'uruchomisz modelu.',
  'settings.localApi.status.port': 'Nasłuchuje na porcie {port}.',
  'settings.localApi.status.served.one': 'Obsłużono dotąd {count} zapytanie.',
  'settings.localApi.status.served.few': 'Obsłużono dotąd {count} zapytania.',
  'settings.localApi.status.served.many': 'Obsłużono dotąd {count} zapytań.',
  'settings.localApi.status.served.other': 'Obsłużono dotąd {count} zapytania.',
  'settings.localApi.status.off': 'Nie działa.',
  'settings.localApi.busyWarning':
    'Inna aplikacja właśnie korzysta z twojego modelu. Czat tutaj w tym samym czasie może ' +
    'spowolnić jedno i drugie – twój własny czat zawsze ma pierwszeństwo.',
  'settings.localApi.preemptedWarning':
    'Przed chwilą twoje korzystanie z aplikacji HilbertRaum przerwało zapytanie innej aplikacji. ' +
    'Ta aplikacja może po prostu spróbować ponownie.',
  'settings.localApi.token.toggle': 'Wymagaj klucza dostępu',
  'settings.localApi.token.hint': 'Zalecane: zostaw włączone.',
  'settings.localApi.token.confirm.title': 'Wyłączyć wymaganie klucza dostępu?',
  'settings.localApi.token.confirm.body':
    'Bez klucza dostępu każdy program na tym komputerze może korzystać z twojego modelu AI bez ' +
    'pytania. Nie wyłączaj go, chyba że aplikacja naprawdę nie może podać klucza.',
  'settings.localApi.token.confirm.cta': 'Wyłącz',
  'settings.localApi.token.regenerate': 'Utwórz nowy klucz',
  'settings.localApi.token.regenerate.title': 'Utworzyć nowy klucz dostępu?',
  'settings.localApi.token.regenerate.body':
    'Aplikacje korzystające ze starego klucza przestaną działać, dopóki nie wkleisz do nich ' +
    'nowego klucza.',
  'settings.localApi.token.regenerate.cta': 'Utwórz nowy klucz',
  'settings.localApi.token.regenerated': 'Utworzono nowy klucz dostępu.',
  'settings.localApi.token.regenerateFailed':
    'Nie udało się utworzyć nowego klucza. Spróbuj ponownie.',
  'settings.localApi.port.label': 'Numer portu',
  'settings.localApi.port.hint':
    'Zmień go tylko wtedy, gdy inny program już używa tego numeru. Zakres: od 1024 do 65535.',
  'settings.localApi.error.portInUse':
    'Inny program na tym komputerze już używa tego numeru – może to też oznaczać, że inny ' +
    'program podszywa się pod aplikację HilbertRaum, więc nie wklejaj nigdzie klucza dostępu, ' +
    'dopóki tego nie wyjaśnisz. Ustaw inny numer (na przykład {suggestion}) i włącz funkcję ' +
    'ponownie; jeśli jakaś aplikacja była już połączona, wklej do niej również nowy adres ' +
    'serwera.',
  'settings.localApi.error.startFailed':
    'Nie udało się uruchomić lokalnego API. Szczegóły są na karcie Diagnostyka.',
  // ---- Settings → Diagnostics tab (DiagnosticsTab.tsx) ----
  'diag.localOnly': 'Diagnostyka tylko lokalna. Nic stąd nigdy nie jest wysyłane.',
  'diag.localApi.label': 'Lokalne API',
  'diag.localApi.off': 'Wyłączone',
  'diag.localApi.running':
    'Włączone · port {port} · obsłużone zapytania: {served}, odrzucone: {rejected}',
  'diag.localApi.portInUse': 'Wyłączone – ten numer portu jest już używany',
  'diag.localApi.startFailed': 'Wyłączone – nie udało się go uruchomić',
  'diag.audit.runtime_started': 'Uruchomiono model',
  'diag.audit.runtime_stopped': 'Zatrzymano model',
  'diag.audit.runtime_crashed': 'Model nieoczekiwanie przestał działać',
  'diag.audit.runtime_fallback': 'Tryb zgodności',
  'diag.audit.model_selected': 'Wybrano model',
  'diag.audit.model_verified': 'Sprawdzono sumę kontrolną modelu',
  'diag.audit.model_download_started': 'Rozpoczęto pobieranie',
  'diag.audit.model_download_verified': 'Sprawdzono pobrany plik',
  'diag.audit.model_download_failed': 'Pobieranie nie powiodło się',
  'diag.audit.document_imported': 'Zaimportowano dokument',
  'diag.audit.document_reindexed': 'Ponownie zindeksowano dokument',
  'diag.audit.document_deleted': 'Usunięto dokument',
  'diag.audit.document_task_completed': 'Ukończono zadanie dokumentu',
  'diag.audit.document_task_failed': 'Zadanie dokumentu nie powiodło się',
  'diag.audit.document_exported': 'Wyeksportowano dokument',
  'diag.audit.summary_exported': 'Wyeksportowano streszczenie',
  'diag.audit.conversation_deleted': 'Usunięto rozmowę',
  'diag.audit.conversation_exported': 'Wyeksportowano rozmowę',
  'diag.audit.message_table_exported': 'Wyeksportowano tabelę z odpowiedzi',
  'diag.audit.code_block_exported': 'Zapisano blok kodu jako plik',
  'diag.audit.workspace_created': 'Utworzono obszar roboczy',
  'diag.audit.workspace_unlocked': 'Odblokowano obszar roboczy',
  'diag.audit.workspace_locked': 'Zablokowano obszar roboczy',
  'diag.audit.workspace_unlock_failed': 'Próba odblokowania nie powiodła się',
  'diag.audit.workspace_lock_failed':
    'Próba zablokowania nie powiodła się (obszar roboczy pozostał odblokowany)',
  'diag.audit.workspace_password_changed': 'Zmieniono hasło obszaru roboczego',
  'diag.audit.settings_changed': 'Zmieniono ustawienia',
  'diag.audit.local_api_toggled': 'Włączono lub wyłączono lokalne API',
  'diag.audit.policy_warning': 'Komunikat zasad dysku',
  'diag.audit.offline_guard_violation': 'Wykryto próbę połączenia z siecią',
  'diag.audit.collection_created': 'Utworzono projekt',
  'diag.audit.collection_renamed': 'Zmieniono nazwę projektu',
  'diag.audit.collection_archived': 'Zarchiwizowano projekt lub przywrócono go z archiwum',
  'diag.audit.collection_deleted': 'Usunięto projekt',
  'diag.audit.documents_added_to_collection': 'Dodano dokumenty do sekcji lub projektu',
  'diag.audit.documents_removed_from_collection': 'Usunięto dokumenty z sekcji lub projektu',
  'diag.audit.document_lifecycle_changed': 'Zmieniono status dokumentu',
  'diag.audit.skill_imported': 'Zaimportowano umiejętność',
  'diag.audit.skill_deleted': 'Usunięto umiejętność',
  'diag.audit.skill_enabled': 'Włączono umiejętność',
  'diag.audit.skill_disabled': 'Wyłączono umiejętność',
  'diag.audit.skill_run_started': 'Uruchomiono narzędzie umiejętności',
  'diag.audit.skill_run_done': 'Narzędzie umiejętności zakończyło działanie',
  'diag.audit.skill_run_failed': 'Działanie narzędzia umiejętności nie powiodło się',
  'diag.audit.evidence_review_created': 'Rozpoczęto weryfikację potwierdzeń',
  'diag.audit.evidence_review_ready': 'Zakończono weryfikację potwierdzeń',
  'diag.audit.evidence_review_deleted': 'Usunięto weryfikację potwierdzeń',
  'diag.audit.evidence_pack_exported': 'Wyeksportowano pakiet potwierdzeń',
  'diag.audit.knowledge_pack_added': 'Dodano pakiet wiedzy',
  'diag.audit.knowledge_pack_removed': 'Usunięto pakiet wiedzy',
  'diag.audit.knowledge_pack_article_saved': 'Zapisano artykuł z pakietu wiedzy jako dokument',
  'diag.accel.gpuFallbackName': 'Karta graficzna',
  'diag.accel.gpu': '{name} (GPU)',
  'diag.accel.mock': 'Wbudowany tryb demo',
  'diag.app.engine': 'Silnik AI',
  'diag.app.voiceEngine': 'Silnik mowy',
  'diag.engine.cannotRun': 'Nie może działać – {reason}',
  'diag.engine.reason.libraryMissing': 'brakuje biblioteki systemowej',
  'diag.engine.reason.systemTooOld': 'wersja systemu jest za stara',
  'diag.engine.reason.filesDamaged': 'brakuje plików silnika lub są one uszkodzone',
  'diag.engine.reason.filesDamagedAfterInstall':
    'sprawdzenie zaraz po nowej instalacji wykazało uszkodzone pliki silnika',
  'diag.engine.reason.vcRuntimeMissing': 'brak bibliotek uruchomieniowych Visual C++',
  'diag.engine.reason.blocked': 'zablokowany przez Zabezpieczenia Windows',
  'diag.accel.cpu': 'CPU',
  'diag.accel.gpuAvailable': '{name} (można użyć GPU)',
  'diag.app.title': 'Aplikacja i silnik',
  'diag.app.version': 'Wersja aplikacji',
  'diag.app.unknown': 'brak danych',
  'diag.app.selectedModel': 'Wybrany model',
  'diag.app.noneSelected': 'nie wybrano',
  'diag.app.profile': 'Profil komputera',
  'diag.app.runtime': 'Silnik',
  'diag.app.unknownModel': 'nieznany model',
  'diag.app.onPort': ' pod adresem 127.0.0.1:{port}',
  'diag.app.healthy': 'odpowiada',
  'diag.app.unhealthy': 'nie odpowiada',
  'diag.app.runtimeRunning': 'Działa – {model}{onPort} ({health})',
  'diag.app.stopped': 'Zatrzymany',
  'diag.app.acceleration': 'Akceleracja',
  'diag.app.runtimeBuild': 'Kompilacja silnika',
  'diag.app.noInstallMarker': 'brak znacznika instalacji (dysk przygotowany ręcznie)',
  'diag.app.engineVersions': 'Wersje silników',
  'diag.engineVersion.older': '{engine} {installed}, ta aplikacja oczekuje wersji {pinned}',
  'diag.engineVersion.newer':
    '{engine} {installed}, wersja nowsza niż oczekiwana przez tę aplikację ({pinned})',
  'diag.engineVersion.unknown':
    '{engine}: brak zapisanej wersji, ta aplikacja oczekuje wersji {pinned}',
  'diag.engineVersion.cpuNet': '{engine} (zapasowy wariant CPU)',
  'diag.gpu.compat':
    'Włączony jest tryb zgodności: odpowiedzi są generowane przez CPU, co działa na każdym ' +
    'komputerze.',
  'diag.gpu.tryHint':
    'Jeśli sterownik karty graficznej został zaktualizowany, możesz ponownie wypróbować kartę ' +
    'graficzną.',
  'diag.gpu.offHint':
    'Akceleracja GPU jest wyłączona w Ustawieniach – włącz ją tam ponownie, aby znów używać ' +
    'karty graficznej.',
  'diag.gpu.tryAgain': 'Wypróbuj GPU ponownie',
  'diag.gpu.tryFailed': 'Ponowna próba użycia karty graficznej nie powiodła się: {error}',
  'diag.refresh': 'Odśwież',
  // ---- Performance screen (PerformanceScreen.tsx; benchmark.md "Performance screen") ----
  'perf.title': 'Wydajność',
  'perf.lead':
    'Jak szybko twój model AI działa na tym komputerze – pomiar odbywa się na tym urządzeniu. ' +
    'Nic nie jest nigdzie wysyłane.',
  'perf.card.title': 'Ten komputer',
  'perf.checkedAt': 'Sprawdzono: {when}',
  'perf.notChecked': 'Jeszcze nie sprawdzono',
  'perf.otherMachine':
    'Ten wynik zmierzono na innym komputerze. Sprawdź ponownie, aby zmierzyć ten komputer.',
  'perf.report.otherComputer': 'Inny komputer: {cpu}, {ram}\u00A0GB RAM',
  'perf.verdict.speed': 'Na tym komputerze {model} działa z szybkością około {tps}\u00A0tok/s.',
  'perf.verdict.noSpeed':
    '{model} najlepiej pasuje do tego komputera (podstawa oceny: {basis}). Szybkość zostanie ' +
    'zmierzona po pierwszym uruchomieniu modelu.',
  'perf.basis.discrete': 'pamięć karty graficznej',
  'perf.basis.unified': 'pamięć zunifikowana',
  'perf.basis.cpu': 'pamięć RAM',
  'perf.recommendation.atCheckTime': 'Zalecenie w chwili sprawdzenia',
  'perf.recommendation.next': 'Zalecenie na następne uruchomienie',
  'perf.recommendation.nextOnThisComputer': 'Zalecenie na następne uruchomienie na tym komputerze',
  'perf.verdict.noRecommendation': 'Żaden model z katalogu nie pasuje jeszcze do tego komputera.',
  'perf.verdict.notChecked':
    'Szybkie sprawdzenie mierzy pamięć, szybkość dysku i – gdy działa model – szybkość ' +
    'generowania.',
  'perf.verdict.driveFast': 'Modele uruchamiają się z tego dysku szybko.',
  'perf.verdict.driveSlow': 'Modele uruchamiają się z tego dysku wolno.',
  'perf.tile.speed': 'Szybkość',
  'perf.tile.speed.unit': 'tok/s',
  'perf.tile.speed.sub': 'Pomiar: {model}, {when}',
  'perf.tile.speed.approx':
    'W przybliżeniu: zliczone fragmenty odpowiedzi, a nie pomiary czasu silnika',
  'perf.tile.speed.chunks': 'fragmenty: {chunks}',
  'perf.tile.speed.none': 'Jeszcze nie zmierzono',
  'perf.tile.speed.noneHint': 'Uruchom model, a potem sprawdź ponownie',
  'perf.tile.memory': 'Pamięć',
  'perf.tile.memory.unit': 'GB RAM',
  'perf.tile.memory.unified': 'Pamięć zunifikowana',
  'perf.tile.memory.unifiedSub': 'Wspólna dla procesora i rdzeni graficznych',
  'perf.model.title': 'Twój model',
  'perf.model.line.one': '{model} · {size}\u00A0GB na dysku · kontekst: {context} token',
  'perf.model.line.few': '{model} · {size}\u00A0GB na dysku · kontekst: {context} tokeny',
  'perf.model.line.many': '{model} · {size}\u00A0GB na dysku · kontekst: {context} tokenów',
  'perf.model.line.other': '{model} · {size}\u00A0GB na dysku · kontekst: {context} tokena',
  'perf.model.none': 'Nie wybrano jeszcze modelu. Wybierz model na ekranie Model AI.',
  'perf.model.need': 'Zajmuje {need}\u00A0GB przy tym rozmiarze kontekstu.',
  'perf.model.needEstimate':
    'Wymaga co najmniej {need}\u00A0GB na wagi modelu oraz miejsca na pamięć podręczną kontekstu, ' +
    'którą zmierzy pierwsze uruchomienie.',
  'perf.model.gpu':
    'Mieści się w pamięci karty graficznej ({budget}\u00A0GB): na GPU są wszystkie warstwy ' +
    '({layers}).',
  'perf.model.gpuEstimate': 'Prawdopodobnie zmieści się w pamięci karty graficznej ({budget}\u00A0GB).',
  'perf.model.partial':
    'Pamięć karty graficznej mieści {budget}\u00A0GB. Warstwy na GPU: {gpuLayers} z {layers}, w ' +
    'pamięci RAM: około {spill}\u00A0GB. Odpowiedzi są wolniejsze.',
  'perf.model.partialFree':
    'Warstwy na GPU: {gpuLayers} z {layers}, w pamięci RAM: około {spill}\u00A0GB. Przy uruchamianiu ' +
    'modelu wolna pamięć karty wynosiła tylko {free}\u00A0GB z {budget}\u00A0GB, a silnik zachowuje ' +
    '{margin}\u00A0GB marginesu bezpieczeństwa. Odpowiedzi są wolniejsze. Uruchom model ponownie, ' +
    'gdy karta będzie wolna.',
  'perf.model.partialMargin':
    'Warstwy na GPU: {gpuLayers} z {layers}, w pamięci RAM: około {spill}\u00A0GB. Karta była wolna ' +
    '({free} z {budget}\u00A0GB), ale silnik rezerwuje też {working}\u00A0GB na bufory robocze i ' +
    '{margin}\u00A0GB marginesu bezpieczeństwa, a gdy suma zbliża się do limitu, przenosi całe ' +
    'warstwy z karty. Odpowiedzi są wolniejsze.',
  'perf.model.partialMarginNoWorking':
    'Warstwy na GPU: {gpuLayers} z {layers}, w pamięci RAM: około {spill}\u00A0GB. Karta była wolna ' +
    '({free} z {budget}\u00A0GB), ale silnik rezerwuje też pamięć na bufory robocze i ' +
    '{margin}\u00A0GB marginesu bezpieczeństwa, a gdy suma zbliża się do limitu, przenosi całe ' +
    'warstwy z karty. Odpowiedzi są wolniejsze.',
  'perf.model.partialEstimate':
    'Pamięć karty graficznej mieści {budget}\u00A0GB, więc część modelu (około {spill}\u00A0GB) ' +
    'będzie działać z pamięci RAM. Odpowiedzi będą wolniejsze.',
  'perf.model.cpu': 'Działa na procesorze, z pamięci RAM ({budget}\u00A0GB).',
  'perf.model.cpuEstimate': 'Będzie działać na procesorze, z pamięci RAM ({budget}\u00A0GB).',
  'perf.model.unified':
    'Mieści się w pamięci zunifikowanej ({ram}\u00A0GB, dla modelu dostępne: do {budget}\u00A0GB).',
  'perf.model.unifiedEstimate':
    'Prawdopodobnie zmieści się w pamięci zunifikowanej ({ram}\u00A0GB, dla modelu dostępne: do ' +
    '{budget}\u00A0GB).',
  'perf.model.tooLarge':
    'Za duży na ten komputer (dostępne: {budget}\u00A0GB). Wybierz mniejszy model.',
  'perf.model.unknown':
    'Rozmieszczenie modelu zostanie zmierzone przy jego pierwszym uruchomieniu na tym komputerze.',
  'perf.model.unknownObserved': 'Silnik nie podał, gdzie umieścił model.',
  'perf.model.perDrive':
    'Dysk przechowuje jeden zapis na model, więc uruchomienie na innym komputerze zastępuje ' +
    'pomiar wykonany tutaj.',
  'perf.model.measuredOther.one':
    'Wcześniejszy pomiar (kontekst: {context} token, data: {when}); powyższe oszacowanie dotyczy ' +
    'bieżących ustawień.',
  'perf.model.measuredOther.few':
    'Wcześniejszy pomiar (kontekst: {context} tokeny, data: {when}); powyższe oszacowanie ' +
    'dotyczy bieżących ustawień.',
  'perf.model.measuredOther.many':
    'Wcześniejszy pomiar (kontekst: {context} tokenów, data: {when}); powyższe oszacowanie ' +
    'dotyczy bieżących ustawień.',
  'perf.model.measuredOther.other':
    'Wcześniejszy pomiar (kontekst: {context} tokena, data: {when}); powyższe oszacowanie ' +
    'dotyczy bieżących ustawień.',
  'perf.model.runningOnCard': 'Działa teraz na karcie graficznej.',
  'perf.model.choose': 'Wybierz mniejszy model',
  'perf.models.title': 'Modele na tym komputerze',
  'perf.models.hint':
    'Czat i tłumaczenie współdzielą kartę graficzną. Obrazy, wyszukiwanie w dokumentach i mowa ' +
    'celowo działają na procesorze, więc zajmują pamięć RAM, a nie pamięć karty graficznej.',
  'perf.role.chat': 'Czat',
  'perf.role.translation': 'Tłumaczenie',
  'perf.role.vision': 'Obrazy',
  'perf.role.reranker': 'Wyszukiwanie w dokumentach (ocena trafności)',
  'perf.role.embeddings': 'Wyszukiwanie w dokumentach (indeks)',
  'perf.role.transcriber': 'Mowa',
  'perf.models.row': '{model} · {size}\u00A0GB',
  'perf.models.rowNoSize': '{model}',
  'perf.models.none': 'Brak zainstalowanego modelu do tego zadania.',
  'perf.models.device.gpu': 'karta graficzna',
  'perf.models.device.cpu': 'procesor, z założenia',
  'perf.models.device.processor': 'procesor',
  'perf.models.loaded': 'teraz wczytany',
  'perf.models.notLoaded': 'niewczytany',
  'perf.models.lifetime.session': 'zostaje w pamięci',
  'perf.models.lifetime.idle': 'zwalnia pamięć przy bezczynności',
  'perf.models.lifetime.per-use': 'działa tylko podczas pracy',
  'perf.models.split': 'warstwy na karcie: {gpuLayers} z {layers}',
  'perf.models.card':
    'Karta graficzna: czat {chat}\u00A0GB + tłumaczenie {translation}\u00A0GB, z {vram}\u00A0GB.',
  'perf.models.cardReranker': 'Karta graficzna: ocena trafności {reranker}\u00A0GB, z {vram}\u00A0GB.',
  'perf.models.cardBoth':
    'Oba modele są teraz na karcie. Model uruchomiony jako drugi dostał pozostałą pamięć i ' +
    'działa wolniej; zatrzymaj go i uruchom ponownie, gdy pierwszy zwolni pamięć.',
  'perf.models.ram': 'Wszystko wczytane naraz wymaga około {sum}\u00A0GB z {ram}\u00A0GB pamięci RAM.',
  'perf.models.memory':
    'Wszystko wczytane naraz wymaga około {sum}\u00A0GB z {budget}\u00A0GB pamięci zunifikowanej ' +
    'dostępnej dla modeli.',
  'perf.models.ramTooMuch': 'Za dużo naraz',
  'perf.models.ramOk': 'Pasuje',
  'perf.place.gpu': 'Na GPU',
  'perf.place.partial': 'Częściowo na GPU',
  'perf.place.cpu': 'Na procesorze',
  'perf.place.tooLarge': 'Za duży',
  'perf.place.unknown': 'Nie zmierzono',
  'perf.tile.graphics': 'Pamięć karty graficznej',
  'perf.tile.graphics.unit': 'GB VRAM',
  'perf.tile.graphics.none':
    'Brak karty graficznej, której można użyć. Modele działają na procesorze.',
  'perf.tile.graphics.engine':
    'Silnik AI nie może działać na tym komputerze, więc nie udało się sprawdzić karty graficznej.',
  'perf.tile.graphics.off': 'Akceleracja graficzna jest wyłączona. Modele działają na procesorze.',
  'perf.tile.graphics.small': 'Poniżej {min}\u00A0GB: modele działają na procesorze.',
  'perf.tile.graphics.integrated':
    'Karta zintegrowana, pamięć współdzielona: modele działają na procesorze.',
  'perf.tile.graphics.unitShared': 'GB pamięci współdzielonej',
  'perf.tile.graphics.notRecorded':
    'Podczas tamtego sprawdzenia nie zapisano danych karty graficznej.',
  'perf.rating.usable': 'Wystarcza',
  'perf.rating.small': 'Mała',
  'perf.rating.integrated': 'Zintegrowana',
  'perf.rating.notRecorded': 'Nie zapisano',
  'perf.rating.none': 'Brak',
  'perf.rating.unknown': 'Nieznana',
  'perf.others.subGpu': '{cpu}, {ram}\u00A0GB RAM, {vram}\u00A0GB VRAM · {when}',
  'perf.tile.drive': 'Dysk',
  'perf.tile.drive.unit': 'MB/s odczytu',
  'perf.tile.drive.load': 'Pomiar przy uruchomieniu modelu: {when}, odczytano {gb}\u00A0GB',
  'perf.tile.drive.hash': 'Pomiar przy sprawdzaniu pliku: {when}, odczytano {gb}\u00A0GB',
  'perf.tile.drive.none': 'Jeszcze nie zmierzono',
  'perf.tile.drive.noneHint': 'Pomiar przy pierwszym uruchomieniu modelu lub sprawdzeniu pliku',
  'perf.rating.good': 'Dobrze',
  'perf.rating.slow': 'Wolno',
  'perf.rating.fast': 'Szybko',
  'perf.rating.pending': 'Oczekuje',
  'perf.rating.approx': 'W przybliżeniu',
  'perf.rating.slowDrive': 'Powolny dysk',
  'perf.profile.TINY': 'Minimalny',
  'perf.profile.LITE': 'Lekki',
  'perf.profile.BALANCED': 'Zrównoważony',
  'perf.profile.PRO': 'Pro',
  'perf.profile.UNKNOWN': 'Nieznany',
  'perf.check': 'Sprawdź ten komputer',
  'perf.checkAgain': 'Sprawdź ponownie',
  'perf.running': 'Sprawdzanie…',
  'perf.startAndMeasure': 'Uruchom i zmierz: {model}',
  'perf.contextSize': 'Zmień rozmiar kontekstu',
  'perf.copy': 'Kopiuj raport',
  'perf.autoNote':
    'Sprawdzenie uruchamia się samo za pierwszym razem i za każdym razem, gdy ten dysk zostanie ' +
    'podłączony do innego komputera.',
  'perf.failed': 'Sprawdzenie nie powiodło się: {error}',
  'perf.loadFailed': 'Nie udało się odczytać najnowszych wyników: {error}',
  'perf.retry': 'Spróbuj ponownie',
  'perf.step.system': 'Wykrywanie podzespołów',
  'perf.step.drive': 'Szybkość dysku',
  'perf.step.speed': 'Szybkość generowania (model: {model})',
  'perf.step.speedSkipped': 'Szybkość generowania (pominięto – żaden model nie działa)',
  'perf.step.hint': 'Około pół minuty. Możesz dalej korzystać z aplikacji.',
  'perf.running.background': 'Trwa sprawdzanie tego komputera w tle.',
  'perf.step.state.done': '{step}: zakończono',
  'perf.step.state.active': '{step}: w toku',
  'perf.step.state.todo': '{step}: oczekuje',
  'perf.observed.title': 'Zaobserwowane podczas pracy',
  'perf.observed.hint':
    'Rzeczywiste wyniki z normalnego używania, a nie z pytania testowego. Te wiersze są dostępne ' +
    'do końca tej sesji; pokazane szybkości odczytu są też zapisywane razem z wynikami dysku ' +
    'powyżej.',
  'perf.observed.none':
    'W tej sesji niczego jeszcze nie zaobserwowano. Zadaj modelowi pytanie albo go uruchom.',
  'perf.observed.answer': 'Ostatnia odpowiedź: {tps}\u00A0tok/s, {ttft}\u00A0s do pierwszego tokena',
  'perf.observed.answerSub': '{model}, {when}, tokeny: {tokens}',
  'perf.observed.load': 'Uruchomienie modelu: {seconds}\u00A0s',
  'perf.observed.loadSub': '{model}, odczytano {gb}\u00A0GB z tego dysku z szybkością {mbps}\u00A0MB/s',
  'perf.observed.check': 'Sprawdzenie pliku: {seconds}\u00A0s',
  'perf.observed.checkSub':
    'Pełne sprawdzenie pliku (model: {model}, data: {when}), odczytano {gb}\u00A0GB',
  'perf.observed.oncePerModel': 'Raz na model',
  'perf.others.title': 'Inne komputery, na których używano tego dysku',
  'perf.others.hint':
    'Każdy komputer ma własny wynik, więc zalecany model zależy od komputera, a nie od dysku.',
  'perf.others.none':
    'Jeszcze brak. Podłącz dysk do innego komputera, a sprawdzenie uruchomi się samo.',
  'perf.others.row': '{tps}\u00A0tok/s (model: {model})',
  'perf.others.rowNoSpeed': 'Zalecany model: {model}, szybkość nie została zmierzona',
  'perf.others.sub': '{cpu}, {ram}\u00A0GB RAM · {when}',
  'perf.others.load': 'uruchomienie modelu: {seconds}\u00A0s',
  'perf.others.check': 'sprawdzenie pliku: {seconds}\u00A0s',
  'perf.footer':
    'Pełny raport techniczny ze wszystkimi surowymi wynikami znajduje się w Ustawieniach, na ' +
    'karcie Diagnostyka.',
  'perf.footerLink': 'Otwórz kartę Diagnostyka',
  'perf.unknownModel': 'wczytany model',
  'perf.unknownCpu': 'Nieznany procesor',
  'diag.bench.title': 'Test wydajności komputera',
  'diag.bench.hint':
    'Surowe wyniki ostatniego sprawdzenia na tym komputerze, do przekazania pomocy technicznej. ' +
    'Ekran Wydajność wyjaśnia, co oznaczają, i uruchamia nowe sprawdzenie. Wszystkie pomiary ' +
    'odbywają się offline – żadne dane nie opuszczają twojego komputera.',
  'diag.bench.empty':
    'Na tym komputerze nie przeprowadzono jeszcze sprawdzenia. Otwórz ekran Wydajność, aby je ' +
    'uruchomić.',
  'diag.bench.profile': 'Przypisany profil',
  'diag.bench.noMatch': 'Brak pasującego modelu',
  'diag.bench.ram': 'Pamięć RAM',
  'diag.bench.cpu': 'Procesor',
  'diag.bench.cores.one': ' ({count} rdzeń)',
  'diag.bench.cores.few': ' ({count} rdzenie)',
  'diag.bench.cores.many': ' ({count} rdzeni)',
  'diag.bench.cores.other': ' ({count} rdzenia)',
  'diag.bench.osArch': 'System / architektura',
  'diag.bench.gpu': 'GPU',
  'diag.bench.notDetected': 'nie wykryto',
  'diag.bench.effectiveRead': 'Zmierzona szybkość odczytu',
  'diag.bench.effectiveReadNone': 'jeszcze nie zmierzono – pomiar nastąpi przy uruchomieniu modelu',
  'diag.bench.effectiveReadLoad': 'pomiar przy uruchomieniu modelu: {when}, odczytano {gb}\u00A0GB',
  'diag.bench.effectiveReadHash': 'pomiar przy sprawdzaniu pliku: {when}, odczytano {gb}\u00A0GB',
  'diag.bench.driveWrite': 'Zapis na dysk',
  'diag.bench.notMeasured': 'nie zmierzono',
  'diag.bench.tokens': 'Szybkość dekodowania (tok/s)',
  'diag.bench.tokensNotMeasured': 'nie zmierzono (najpierw uruchom model)',
  'diag.bench.tokensModel': 'pomiar z wczytanym modelem {model}',
  'diag.bench.tokensOver': 'liczba tokenów: {tokens}',
  'diag.bench.tokensApprox':
    'w przybliżeniu – zliczone fragmenty odpowiedzi, a nie pomiary czasu silnika',
  'diag.bench.lastRun': 'Ostatni pomiar',
  'diag.system.title': 'System',
  'diag.system.osPlatform': 'System / platforma',
  'diag.system.freeSpace': 'Wolne miejsce',
  'diag.system.imagesSize': 'Rozmiar historii obrazów',
  'diag.system.loadFailed':
    'Nie udało się jeszcze wczytać informacji o systemie. Spróbuj ponownie otworzyć tę kartę.',
  'diag.paths.title': 'Ścieżki',
  'diag.paths.prepared': 'Przygotowany dysk',
  'diag.paths.yes': 'Tak',
  'diag.paths.noFallback': 'Nie (używany jest zapasowy folder danych aplikacji)',
  'diag.paths.writable': 'Możliwość zapisu',
  'diag.paths.no': 'Nie',
  'diag.paths.loadFailed':
    'Nie udało się jeszcze wczytać informacji o dysku i obszarze roboczym. Spróbuj ponownie ' +
    'otworzyć tę kartę.',
  'diag.activity.title': 'Aktywność',
  'diag.activity.hint':
    'Lokalny zapis działań aplikacji: uruchomienia modeli, pobierania, importy dokumentów, ' +
    'zdarzenia obszaru roboczego. Zostaje w twoim obszarze roboczym (zaszyfrowany, jeśli obszar ' +
    'roboczy jest zaszyfrowany) i nigdy nie jest wysyłany. Nigdy nie zawiera tekstu czatów ani ' +
    'treści dokumentów.',
  'diag.activity.show': 'Pokaż aktywność',
  'diag.activity.hide': 'Ukryj aktywność',
  'diag.activity.export': 'Eksportuj do pliku…',
  'diag.activity.savedTo': 'Zapisano dziennik aktywności: {path}',
  'diag.activity.filterShow': 'Pokaż',
  'diag.activity.filterAll': 'Wszystkie zdarzenia',
  'diag.activity.loading': 'Wczytywanie…',
  'diag.activity.empty':
    'Jeszcze nic nie zapisano – aktywność pojawia się tutaj w miarę korzystania z aplikacji.',
  'diag.activity.earlier': 'Pokaż wcześniejszą aktywność',
  'diag.logs.title': 'Najnowsze wpisy dziennika',
  'diag.logs.hintBefore': 'Ostatnie wiersze pliku ',
  'diag.logs.hintAfter':
    ' na tym urządzeniu. Dzienniki są przechowywane tylko lokalnie i nigdy nie są wysyłane; nie ' +
    'zawierają treści dokumentów ani tekstu czatów.',
  'diag.logs.show': 'Pokaż dzienniki',
  'diag.logs.hide': 'Ukryj dzienniki',
  'diag.logs.empty': '(dziennik jest pusty)',
  'diag.logs.save': 'Zapisz do pliku…',
  'diag.logs.savedTo': 'Zapisano dzienniki: {path}',
  'diag.copy': 'Kopiuj',
  'diag.copyTitle': 'Skopiuj te informacje do schowka',
  'diag.copied': 'Skopiowano do schowka',
  'diag.copyFailed': 'Nie udało się skopiować do schowka',
  // ---- Shared components' built-in copy (receive a bound t — i18n record §5 ⑤) ----
  'common.dismiss': 'Ukryj',
  'common.close': 'Zamknij',
  'common.cancel': 'Anuluj',
  'common.remove': 'Usuń',
  'common.apply': 'Zastosuj',
  'common.labelValue': '{label}: {value}',
  'common.percent': '{pct}%',
  'indicator.offline': 'Lokalnie · Offline',
  'indicator.online': 'Lokalnie · Pobieranie dozwolone',
  'indicator.offlineDetail':
    'Wszystko zostaje na tym dysku. Połączenie z internetem nie jest używane.',
  'indicator.onlineDetail': 'Pobieranie dozwolone – czaty i dokumenty zostają lokalnie.',
  'indicator.short.offline': 'Offline',
  'indicator.short.online': 'Sieć aktywna',
  'indicator.withLocalApi': '{state} · API aktywne',
  'indicator.localApiDetail':
    'Inne aplikacje na tym komputerze mogą korzystać z twojego modelu. Nic nie opuszcza tego ' +
    'komputera.',
  // ---- Shared password copy ----
  'password.mismatch': 'Hasła nie są zgodne.',
  'password.show': 'Pokaż hasło',
  'password.hide': 'Ukryj hasło',
  'password.strength.tooShort': 'Za krótkie',
  'password.strength.weak': 'Słabe',
  'password.strength.okay': 'Średnie',
  'password.strength.strong': 'Silne',
  'password.strength.veryStrong': 'Bardzo silne',
  'password.strength.minHint': 'Użyj co najmniej {min} znaków.',
  'password.strength.longerHint':
    'Dłuższe znaczy silniejsze – dobrze sprawdza się 12 lub więcej znaków albo kilka ' +
    'niepowiązanych słów.',
  // ---- Workspace gate (WorkspaceGate.tsx) ----
  'gate.passwordPlaceholder': 'Hasło',
  'gate.unlock.title': 'Odblokuj obszar roboczy',
  'gate.unlock.hint':
    'Wpisz hasło, aby otworzyć obszar roboczy na tym dysku. Wszystko zostaje na tym dysku.',
  'gate.unlock.submit': 'Odblokuj',
  'gate.unlock.submitBusy': 'Odblokowywanie…',
  'gate.welcome.title': 'Witaj',
  'gate.welcome.intro':
    'To twój prywatny obszar roboczy AI. Rozmawiaj z modelem AI i zadawaj pytania o swoje ' +
    'dokumenty – wszystko działa z tego dysku.',
  'gate.welcome.stays': 'Wszystko zostaje na tym dysku.',
  'gate.welcome.staysRest': 'Bez internetu, bez konta, bez śledzenia.',
  'gate.welcome.start': 'Rozpocznij',
  'gate.finishing.title': 'Trwa konfiguracja…',
  'gate.finishing.hint':
    'Sprawdzanie, co już jest na tym dysku. Pierwsze sprawdzenie dużego pliku modelu AI może ' +
    'potrwać kilka minut.',
  'gate.finishing.progress': 'Sprawdzanie modelu AI {n} z {m}: {name} – {pct}%',
  'gate.finishing.skip': 'Pomiń – przejdź do aplikacji',
  'gate.starter.title': 'Jeszcze jedno',
  'gate.starter.noModel':
    'Na tym dysku nie ma jeszcze zainstalowanego modelu AI – czat potrzebuje go, aby odpowiadać. ' +
    'Możesz dodać model teraz albo w dowolnym momencie później na ekranie Model AI.',
  'gate.starter.optional':
    'Pobieranie modelu jest opcjonalne i zawsze najpierw wymaga twojego potwierdzenia. Twoje ' +
    'dokumenty i czaty niezależnie od tego nigdy nie korzystają z internetu.',
  'gate.starter.skip': 'Na razie pomiń',
  'gate.starter.addDocuments': 'Dodaj dokumenty',
  'gate.starter.chooseModel': 'Wybierz model AI',
  'gate.create.title': 'Utwórz hasło',
  'gate.create.hint':
    'To hasło blokuje wszystko w twoim obszarze roboczym na tym dysku – dokumenty, czaty i ' +
    'notatki. Nie da się go odzyskać ani zresetować, więc wybierz coś, co zapamiętasz.',
  'gate.create.plaintextToggle': 'Użyj obszaru roboczego bez szyfrowania (tryb programisty)',
  'gate.create.plaintextWarning':
    'Tryb bez szyfrowania przechowuje twoje dane na tym dysku w postaci niezaszyfrowanej. Używaj ' +
    'go tylko do prac programistycznych.',
  'gate.create.confirmPlaceholder': 'Potwierdź hasło',
  'gate.create.back': 'Wstecz',
  'gate.create.submit': 'Utwórz obszar roboczy',
  'gate.create.submitBusy': 'Tworzenie…',
  'gate.error.generic': 'Coś poszło nie tak. Spróbuj ponownie.',
  // ---- Main-process strings (Phase 41, i18n record §3.3 two-rule boundary) --------------
  'main.ingest.pdfScanDetected': 'Ten plik PDF wygląda na skan – nie ma jeszcze czytelnego tekstu.',
  'main.ingest.audioNeedsTranscriber':
    'Import nagrań audio wymaga modelu transkrypcji – pobierz go na ekranie Model AI.',
  'main.ingest.audioNeedsEngine':
    'Import nagrań audio wymaga silnika mowy – zainstaluj go na ekranie Model AI.',
  'main.ingest.audioNeedsModelAndEngine':
    'Import nagrań audio wymaga modelu transkrypcji i silnika mowy – dodaj oba na ekranie Model ' +
    'AI.',
  'main.ingest.audioEngineUnsupported':
    'Import nagrań audio nie jest jeszcze dostępny w tym systemie operacyjnym: aplikacja nie ' +
    'może zainstalować tutaj potrzebnego silnika mowy.',
  'main.ingest.audioUnreadable':
    'Nie udało się odczytać tego pliku audio. Przekonwertuj go do formatu WAV lub MP3 i ' +
    'zaimportuj ponownie.',
  'main.ingest.audioTranscriptionFailed':
    'Nie udało się transkrybować nagrania. Zindeksuj ten dokument ponownie, aby powtórzyć próbę.',
  'main.ingest.engineCannotRun':
    'Silnik AI nie może działać na tym komputerze, więc nie udało się zindeksować tego ' +
    'dokumentu. Na ekranie Model AI widać, co zrobić – a potem spróbuj ponownie.',
  'main.ingest.engineLibraryMissing':
    'Silnik AI nie może działać na tym komputerze, ponieważ brakuje biblioteki systemowej ' +
    '{library}. Na ekranie Model AI widać, jak to naprawić – a potem spróbuj ponownie.',
  'main.ingest.voiceEngineCannotRun':
    'Silnik mowy nie może działać na tym komputerze, więc nie udało się transkrybować tego ' +
    'nagrania. Na ekranie Model AI widać, co zrobić – a potem zindeksuj ten dokument ponownie.',
  'main.ingest.searchModelTimeout':
    'Model wyszukiwania nie odpowiedział na czas, więc nie udało się zindeksować tego dokumentu. ' +
    'Spróbuj ponownie.',
  'main.ingest.searchModelCannotStart':
    'Model wyszukiwania się nie uruchomił, więc nie udało się zindeksować tego dokumentu. Na ' +
    'ekranie Model AI wybierz „Sprawdź wszystkie pliki modeli” – a potem spróbuj ponownie.',
  'main.ingest.searchModelFailed':
    'W modelu wyszukiwania wystąpił problem, więc nie udało się zindeksować tego dokumentu. ' +
    'Spróbuj ponownie.',
  'main.ingest.imageNeedsOcr':
    'Import zdjęć wymaga plików rozpoznawania tekstu (OCR), których nie ma na tym dysku.',
  'main.ingest.imageNoText':
    'Na tym zdjęciu nie znaleziono czytelnego tekstu. Spróbuj zrobić ostrzejsze zdjęcie strony z ' +
    'bliższej odległości.',
  'main.ingest.imageOcrFailed':
    'Nie udało się odczytać tego zdjęcia. Zindeksuj je ponownie, aby powtórzyć próbę.',
  'main.ingest.imageOcrUnavailable':
    'Nie udało się uruchomić rozpoznawania tekstu (OCR) w tej wersji aplikacji, więc to zdjęcie ' +
    'zostało zapisane bez czytelnego tekstu. Zindeksuj je ponownie, gdy rozpoznawanie tekstu ' +
    'będzie dostępne.',
  'main.ingest.sourceMissing': 'Nie znaleziono importowanego pliku na dysku.',
  'main.ingest.interrupted':
    'Przetwarzanie zostało przerwane, zanim się zakończyło. Zindeksuj dokument ponownie, aby ' +
    'powtórzyć próbę.',
  'main.ingest.fileTooLarge':
    'Ten plik jest za duży, aby można go było bezpiecznie zaimportować. Podziel go na mniejsze ' +
    'pliki i spróbuj ponownie.',
  'main.ingest.tooManyChunks':
    'Ten dokument jest za duży, aby można go było zindeksować w całości. Podziel go na mniejsze ' +
    'pliki i zaimportuj poszczególne części.',
  'main.ingest.parseTimeout':
    'Przetwarzanie tego pliku trwało zbyt długo, więc go pominięto. Plik może być uszkodzony ' +
    'albo wyjątkowo duży.',
  'main.ingest.unsupportedType':
    'Ten typ pliku nie jest obsługiwany ({ext}). Użyj formatu TXT, PDF, DOCX, CSV albo ' +
    'obsługiwanego formatu audio.',
  'main.rag.noContext':
    'Nie znaleziono tego w twoich dokumentach. Spróbuj przeformułować pytanie albo sprawdź, o ' +
    'które dokumenty pytasz.',
  'main.rag.reindexNeeded':
    'Twoje dokumenty wymagają szybkiego ponownego indeksowania, zanim będzie można je przeszukać ' +
    '– zostały zindeksowane innym modelem wyszukiwania. Otwórz ekran Dokumenty i wybierz ' +
    '„Indeksuj ponownie”.',
  'main.chat.docTaskBusy':
    'Trwa zadanie dotyczące dokumentu. Możesz je anulować albo poczekać, aż się zakończy, zanim ' +
    'wrócisz do czatu.',
  'main.chat.defaultTitle': 'Nowy czat',
  'main.evidenceReviews.defaultTitle': 'Weryfikacja potwierdzeń',
  'main.benchmark.warnTiny':
    'To urządzenie najlepiej nadaje się do najmniejszego, najszybszego modelu. Większe modele ' +
    'mogą działać wolno.',
  'main.benchmark.warnUnknown':
    'Nie udało się w pełni rozpoznać parametrów tego komputera, więc wybrano bezpieczny, lekki ' +
    'model. W każdej chwili możesz wypróbować większy model.',
  'main.benchmark.warnDriveProbe':
    'Nie udało się zmierzyć szybkości dysku, więc zalecenie uwzględnia tylko pamięć RAM i ' +
    'procesor.',
  'main.benchmark.warnSlowDrive':
    'Ten dysk jest raczej powolny. Modele będą działać, ale ich wczytywanie może trwać dłużej.',
  'main.benchmark.warnSpeedSkipped':
    'Tym razem nie zmierzono szybkości generowania tekstu, ponieważ model był zajęty czymś ' +
    'innym. Profil poniżej uwzględnia tylko pamięć RAM, procesor i szybkość dysku – aby uzyskać ' +
    'pełny pomiar, uruchom test wydajności ponownie, gdy nic innego nie korzysta z modelu.',
  'main.benchmark.warnSlowRead':
    'Zmierzona szybkość odczytu z tego dysku: około {mbps}\u00A0MB/s. Uruchomienie modelu wczytuje ' +
    'cały jego plik z tą szybkością, więc modele będą się na tym dysku uruchamiać wolno.',
  'main.benchmark.warnVeryLowTokens':
    'Generowanie tekstu z wczytanym modelem ({model}) było bardzo wolne, więc przypisany profil ' +
    'obniżono o jeden poziom. Jeśli ten model jest większy od zalecanego, uruchom zalecany model ' +
    'i ponownie uruchom test wydajności.',
  'main.benchmark.warnRecommendationLowered':
    'Zmierzona szybkość generowania tekstu z wczytanym modelem ({model}) wyniosła około ' +
    '{tps}\u00A0tok/s, więc zalecany model obniżono o jeden poziom rozmiaru, aby odpowiedzi na tym ' +
    'komputerze były szybkie.',
  'main.benchmark.locked':
    'Obszar roboczy jest zablokowany. Odblokuj go, aby uruchomić test wydajności.',
  'main.benchmark.lockedDuringRun':
    'Obszar roboczy został zablokowany w trakcie testu wydajności, więc wyniku nie zapisano. ' +
    'Uruchom test wydajności ponownie.',
  'main.dialog.openLink.title': 'Otworzyć ten link w przeglądarce?',
  'main.dialog.openLink.message': 'Otworzyć ten link w przeglądarce?',
  'main.dialog.openLink.site': 'Witryna: {site}',
  'main.dialog.openLink.truncated': 'Link jest tu skrócony – pominięte znaki: {hidden}.',
  'main.dialog.openLink.credentials':
    'Adres zawiera nazwę użytkownika – faktycznie zostanie otwarta witryna podana w wierszu ' +
    '„Witryna”.',
  'main.dialog.openLink.hint':
    'Ten link pochodzi z odpowiedzi lub z manifestu modelu, a nie z aplikacji HilbertRaum. Twoja ' +
    'przeglądarka połączy się z tą witryną.',
  'main.dialog.openLink.open': 'Otwórz',
  'main.dialog.openLink.cancel': 'Anuluj',
  'main.workspace.wrongPassword':
    'To hasło nie odblokowało twojego obszaru roboczego. Sprawdź je i spróbuj ponownie.',
  'main.workspace.openFailed': 'Nie udało się otworzyć obszaru roboczego.',
  'main.workspace.vaultDamaged':
    'Hasło jest prawidłowe, ale dane obszaru roboczego na dysku są uszkodzone i nie udało się ' +
    'ich otworzyć. Ponowne wpisanie hasła nie pomoże. Nie twórz nowego obszaru roboczego – ' +
    'zostaw pliki bez zmian i przywróć folder obszaru roboczego z kopii zapasowej.',
  'main.workspace.recoveryBlocked':
    'Nie udało się jeszcze otworzyć obszaru roboczego: inny program ma otwarty plik odzyskiwania ' +
    'z twoimi najnowszymi danymi. Zamknij wszystko, co może skanować dysk (program antywirusowy, ' +
    'indeksowanie wyszukiwania, okno z folderem obszaru roboczego), chwilę zaczekaj i spróbuj ' +
    'ponownie. Nic nie zostało utracone.',
  'main.workspace.newer':
    'Ten obszar roboczy został zapisany przez nowszą wersję aplikacji HilbertRaum – zaktualizuj ' +
    'aplikację, aby go otworzyć. Niczego nie zmieniono.',
  'main.workspace.createFailed': 'Nie udało się utworzyć obszaru roboczego.',
  'main.workspace.passwordTooShort': 'Hasło musi mieć co najmniej {min} znaków.',
  'main.workspace.newPasswordTooShort': 'Nowe hasło musi mieć co najmniej {min} znaków.',
  'main.workspace.unlockBeforeChange': 'Odblokuj obszar roboczy, zanim zmienisz jego hasło.',
  'main.workspace.wrongCurrentPassword':
    'Podane hasło nie zgadza się z obecnym hasłem. Sprawdź je i spróbuj ponownie.',
  'main.workspace.changeFailed': 'Nie udało się zmienić hasła. Obecne hasło nadal działa.',
  'main.workspace.busyPasswordChange':
    'Hasło obszaru roboczego jest właśnie zmieniane. Spróbuj ponownie za chwilę.',
  'main.workspace.lockFailed':
    'Nie udało się zablokować obszaru roboczego – nadal jest otwarty, a twoje dane są ' +
    'bezpieczne. Zwolnij trochę miejsca na dysku i spróbuj ponownie.',
  'main.runtime.compatibilityMode':
    'Ze względu na stabilność przełączono na tryb zgodności. Wszystko działa dalej – odpowiedzi ' +
    'mogą być nieco wolniejsze.',
  'main.runtime.speedUpDisabled':
    'Ze względu na stabilność wyłączono opcjonalne przyspieszenie. Model jest uruchamiany od ' +
    'nowa – wyślij wiadomość ponownie.',
  'main.runtime.crashRestarting':
    'Model AI nieoczekiwanie przestał działać i jest uruchamiany od nowa. Za chwilę wyślij ' +
    'wiadomość ponownie.',
  'main.runtime.crashStopped':
    'Model AI znów nieoczekiwanie przestał działać, więc nie uruchomiono go ponownie. Możesz go ' +
    'uruchomić na ekranie Model AI.',
  'main.runtime.modelCannotLoad':
    'Nie udało się wczytać modelu {model} na tym komputerze – odpowiedzi są symulowane, dopóki ' +
    'nie wybierzesz innego modelu.',
  'main.runtime.engineCannotRun':
    'Silnik AI nie może działać na tym komputerze, więc odpowiedzi są symulowane. Na ekranie ' +
    'Model AI widać, czego brakuje.',
  'main.engine.cannotRun':
    'Silnik AI nie może działać na tym komputerze. Na ekranie Model AI widać, czego brakuje.',
  'main.noModelRunning':
    'Żaden model AI nie działa. Otwórz ekran Model AI i najpierw uruchom model.',
  'main.modelStarting': 'Model AI się uruchamia. Spróbuj ponownie za chwilę.',
  'main.translation.noModel':
    'Do tłumaczenia potrzebny jest model tłumaczenia, który nie jest zainstalowany na tym dysku. ' +
    'Możesz go pobrać na ekranie Model AI.',
  'main.translation.startFailed':
    'Nie udało się uruchomić modelu tłumaczenia – na urządzeniu może brakować pamięci. Zamknij ' +
    'inne aplikacje lub uruchom ponownie aplikację HilbertRaum, a następnie spróbuj ponownie.',
  'main.translation.failedWindowNotice':
    '> ⚠ Tej części ({part} z {total}) nie udało się przetłumaczyć – poniżej zachowano ' +
    'oryginalny tekst bez zmian.',
  'main.translation.missingPageNotice':
    '> ⚠ Strona {page} oryginału nie została przetłumaczona – nie zawiera czytelnego tekstu ' +
    '(może to być zeskanowany obraz).',
  'main.translation.missingPageRangeNotice':
    '> ⚠ Strony {from}–{to} oryginału nie zostały przetłumaczone – nie zawierają czytelnego ' +
    'tekstu (mogą to być zeskanowane obrazy).',
  'main.translation.attributionLine':
    'Przetłumaczono maszynowo za pomocą modelu {modelId} – tłumaczenie może zawierać błędy.',
  'main.model.contextExceeded':
    'To jest za duże dla okna kontekstu bieżącego modelu. Zwiększ rozmiar kontekstu na ekranie ' +
    'Model AI (ustawiona na stałe wartość go ogranicza) albo spróbuj z mniejszym dokumentem.',
  'main.chat.streamInFlight': 'Odpowiedź w tej rozmowie jest już generowana.',
  'main.chat.emptyCompletion':
    'Model zwrócił pustą odpowiedź. Spróbuj ponownie albo przeformułuj wiadomość.',
  'main.chat.runtimeUnresponsive':
    'Model AI przestał odpowiadać. Spróbuj ponownie – jeśli to się powtarza, uruchom model ' +
    'ponownie na ekranie Model AI.',
  'main.chat.connectionLost':
    'Model AI zatrzymał się przed ukończeniem odpowiedzi. Wyślij wiadomość ponownie – jeśli to ' +
    'się powtarza, uruchom model ponownie na ekranie Model AI.',
  'main.chat.streamError':
    'W modelu AI wystąpił błąd przed ukończeniem odpowiedzi. Spróbuj ponownie – jeśli to się ' +
    'powtarza, uruchom model ponownie na ekranie Model AI.',
  'main.chat.searchModelTimeout':
    'Model wyszukiwania nie odpowiedział na czas, więc nie udało się przeszukać twoich ' +
    'dokumentów. Spróbuj ponownie.',
  'main.chat.searchModelCannotStart':
    'Model wyszukiwania się nie uruchomił, więc nie udało się przeszukać twoich dokumentów. Na ' +
    'ekranie Model AI wybierz „Sprawdź wszystkie pliki modeli” – a potem spróbuj ponownie.',
  'main.chat.searchModelFailed':
    'W modelu wyszukiwania wystąpił problem, więc nie udało się przeszukać twoich dokumentów. ' +
    'Spróbuj ponownie.',
  'main.chat.nothingToRegenerate': 'Nie ma jeszcze odpowiedzi do ponownego wygenerowania.',
  'main.chat.nothingToResend':
    'To pytanie nie jest już ostatnią wiadomością w tej rozmowie, więc nie można go wysłać ' +
    'ponownie.',
  'main.chat.skillUnavailable':
    'Ta umiejętność nie jest już dostępna – została wyłączona lub usunięta. Włącz ją w ' +
    'Ustawieniach na karcie Umiejętności albo zapytaj ponownie bez niej.',
  'main.chat.reviewBlocksRegenerate':
    'Dla tej odpowiedzi rozpoczęto weryfikację potwierdzeń. Ponowne wygenerowanie odpowiedzi ' +
    'usunęłoby tę weryfikację wraz z jej decyzjami i notatkami – zamiast tego zadaj pytanie ' +
    'ponownie jako nową wiadomość.',
  'main.chat.emptyMessage': 'Nie można wysłać pustej wiadomości.',
  'main.chat.emptyQuestion': 'Nie można wysłać pustego pytania.',
  'main.chat.stopFirst': 'Odpowiedź w tej rozmowie jest jeszcze generowana. Najpierw ją zatrzymaj.',
  'main.chat.locked': 'Obszar roboczy jest zablokowany. Odblokuj go, aby korzystać z czatu.',
  'main.busy.chat':
    'Właśnie powstaje odpowiedź. Poczekaj, aż się zakończy (albo ją zatrzymaj), a potem spróbuj ' +
    'ponownie.',
  'main.busy.docTask':
    'Zadanie dotyczące dokumentu korzysta z modelu. Poczekaj, aż się zakończy, albo je anuluj, a ' +
    'potem spróbuj ponownie.',
  'main.busy.skillRun':
    'Umiejętność pracuje nad dokumentem. Poczekaj, aż skończy, albo anuluj ją na pasku narzędzi ' +
    'umiejętności, a potem spróbuj ponownie.',
  'main.busy.benchmark': 'Trwa test wydajności tego komputera. Spróbuj ponownie za chwilę.',
  'main.task.unknownKind': 'Nieznane zadanie dotyczące dokumentu.',
  'main.task.refusedChatStreaming':
    'Trwa generowanie odpowiedzi. Zaczekaj, aż się zakończy (albo ją zatrzymaj), a potem spróbuj ' +
    'ponownie.',
  'main.task.comparePickTwo': 'Wybierz dokładnie dwa dokumenty do porównania.',
  'main.task.compareReindex':
    'Te dokumenty wymagają szybkiego ponownego indeksowania, zanim będzie można je porównać – co ' +
    'najmniej jeden z nich został przygotowany innym modelem wyszukiwania. Otwórz ekran ' +
    'Dokumenty i wybierz „Indeksuj ponownie”, a następnie spróbuj ponownie.',
  'main.task.documentNotReady':
    'Ten dokument nie ma jeszcze czytelnego tekstu. Najpierw go zaimportuj albo zindeksuj ' +
    'ponownie, a następnie spróbuj ponownie.',
  'main.task.genericFailure':
    'Nie udało się ukończyć zadania. Upewnij się, że model nadal działa, a potem spróbuj ' +
    'ponownie.',
  'main.task.expired': 'To zadanie nie jest już dostępne.',
  'main.task.translationTarget':
    'Wybierz obsługiwany język źródłowy i inny język docelowy tłumaczenia.',
  'main.task.sourceUnreadable':
    'Nie udało się odczytać zapisanej kopii tego dokumentu. Zaimportuj dokument ponownie, a ' +
    'następnie spróbuj ponownie.',
  'main.task.needsOcr':
    'Rozpoznawanie tekstu wymaga plików OCR, których nie ma na tym dysku. Pobierz je przyciskiem ' +
    '„Pobierz pliki OCR” przy zeskanowanym dokumencie albo na ekranie Model AI – albo, na ' +
    'samodzielnie skonfigurowanym dysku, dodaj je poleceniem „fetch-runtime --family ocr”.',
  'main.task.ocrUnavailable':
    'Rozpoznawanie tekstu (OCR) nie jest dostępne w tej wersji aplikacji: pliki OCR są na tym ' +
    'dysku, ale nie udało się uruchomić rozpoznawania.',
  'main.task.ocrNotAScan':
    'W ten sposób można umożliwić wyszukiwanie tylko w pliku PDF rozpoznanym jako skan albo ' +
    'zawierającym zeskanowane strony.',
  'main.task.ocrNoText':
    'W tym skanie nie znaleziono czytelnego tekstu. Strony mogą być puste albo zbyt rozmazane.',
  'main.task.ocrFailed':
    'Nie udało się odczytać tego skanu. Upewnij się, że dokument nadal jest na dysku, a potem ' +
    'spróbuj ponownie.',
  'main.task.documentBusyIngesting':
    'Ten dokument jest jeszcze importowany albo ponownie indeksowany. Zaczekaj, aż to się ' +
    'zakończy, a potem spróbuj ponownie.',
  'main.task.pickOneTranslate': 'Wybierz dokładnie jeden dokument do przetłumaczenia.',
  'main.task.pickOneOcr':
    'Wybierz dokładnie jeden zeskanowany plik PDF, w którym chcesz umożliwić wyszukiwanie.',
  'main.task.pickOneSummarize': 'Wybierz dokładnie jeden dokument do streszczenia.',
  'main.task.unavailable': 'Zadania dotyczące dokumentów nie są dostępne.',
  'main.task.workspaceLocked':
    'Obszar roboczy jest zablokowany. Odblokuj go, aby pracować z dokumentami.',
  'main.download.policyDisabled': 'Pobieranie jest wyłączone przez zasady tego dysku.',
  'main.download.networkOff':
    'Dostęp do internetu jest wyłączony. Najpierw włącz w Ustawieniach opcję „Zezwalaj na dostęp do ' +
    'internetu, aby pobierać pliki i aktualizacje”.',
  'main.download.alreadyRunning': 'Trwa już inne pobieranie. Modele są pobierane pojedynczo.',
  'main.download.stoppedNetworkOff':
    'Dostęp do internetu jest wyłączony, więc trwające pobieranie zostało zatrzymane. Aby je ' +
    'dokończyć, ponownie włącz dostęp do internetu w Ustawieniach.',
  'main.download.noSource': 'Model „{modelId}” nie ma w swoim manifeście źródła pobierania.',
  'main.download.sourceWithdrawn':
    'Wydawca modelu „{modelId}” usunął dokładnie ten plik, więc nie można go już pobrać ' +
    '({reason}). Modele, które już są na tym dysku, nadal działają.',
  'main.download.alreadyVerified': 'Ten model jest już pobrany i sprawdzony.',
  'main.download.presentUnverified':
    'Plik tego modelu już jest na dysku. Jego manifest nie zawiera jeszcze prawdziwej sumy ' +
    'kontrolnej, więc nie można go sprawdzić – wygeneruj ją poleceniem „verify-models ' +
    '--generate”.',
  'main.download.licenseFirst':
    'Przed pobraniem przeczytaj i zaakceptuj licencję modelu ({license}).',
  'main.download.notEnoughSpace':
    'Na tym dysku jest za mało wolnego miejsca: pobieranie wymaga {needed}, wolne miejsce: ' +
    '{free}. Zwolnij miejsce na dysku albo wybierz mniejszy model.',
  'main.download.unknownJob': 'Nieznane zadanie pobierania.',
  'main.download.checksumMismatch':
    'Pobrany plik nie zgadzał się z oczekiwaną sumą kontrolną, więc został usunięty. Spróbuj ' +
    'ponownie.',
  'main.download.fileMissing': 'Pobrany plik zniknął, zanim można było go sprawdzić.',
  'main.download.httpFailed':
    'Nie udało się rozpocząć pobierania ({reason}). Sprawdź połączenie i spróbuj ponownie.',
  'main.download.interrupted':
    'Pobieranie zostało przerwane ({reason}). Pobrana część zostaje zachowana – ponowne ' +
    'rozpoczęcie wznowi pobieranie od miejsca, w którym zostało przerwane.',
  'main.download.writeFailed':
    'Nie udało się zapisać pliku modelu na tym dysku. Sprawdź, czy dysk nie jest pełny ani ' +
    'chroniony przed zapisem, i spróbuj ponownie.',
  'main.download.resumeDiscarded':
    'Serwer wysłał niewłaściwą część pliku, więc częściowo pobrany plik został usunięty. Po ' +
    'ponownym rozpoczęciu pobieranie zacznie się od początku.',
  'main.engine.alreadyRunning': 'Silnik AI jest już pobierany.',
  'main.engine.noSources':
    'Na tym dysku nie znaleziono źródeł silnika (brak pliku runtime-sources.yaml).',
  'main.engine.noHostBuild': 'Dla tego komputera nie ma dostępnej wersji silnika AI.',
  'main.engine.alreadyInstalled': 'Silnik AI jest już zainstalowany.',
  'main.engine.unknownJob': 'Nieznane zadanie pobierania silnika.',
  'main.engine.checksumMismatch':
    'Pobrany silnik nie zgadzał się z oczekiwaną sumą kontrolną, więc został usunięty. Spróbuj ' +
    'ponownie.',
  'main.engine.fileMissing': 'Pobrany silnik zniknął, zanim można było go sprawdzić.',
  'main.engine.unverifiablePlaceholder':
    'To źródło silnika AI nie ma prawdziwej sumy kontrolnej, więc nie udało się sprawdzić ' +
    'pobranego pliku i nie zainstalowano go. Dysk może być nieprawidłowo skonfigurowany.',
  'main.engine.binaryMissing':
    'Silnik został pobrany, ale nie udało się go rozpakować (układ archiwum mógł się zmienić).',
  'main.engine.extractFailed':
    'Silnik AI został pobrany, ale nie udało się go rozpakować. Spróbuj ponownie.',
  'main.engine.httpFailed':
    'Nie udało się rozpocząć pobierania silnika ({reason}). Sprawdź połączenie i spróbuj ' +
    'ponownie.',
  'main.engine.interrupted': 'Pobieranie silnika zostało przerwane ({reason}). Spróbuj ponownie.',
  'main.engine.runtimeRunning':
    'Nie można zastąpić silnika AI, gdy działa model. Zatrzymaj model na ekranie Model AI i ' +
    'spróbuj ponownie.',
  'main.engine.transcriptionRunning':
    'Nie można zastąpić silnika mowy podczas transkrypcji nagrania. Zaczekaj, aż się zakończy, i ' +
    'spróbuj ponownie.',
  'main.engine.knowledgePackToolsRunning':
    'Nie można zastąpić narzędzi pakietów wiedzy, gdy pakiet jest w użyciu. Zablokuj obszar ' +
    'roboczy albo zaczekaj, aż bieżące pytanie zostanie obsłużone, i spróbuj ponownie – albo ' +
    'uruchom aplikację ponownie, jeśli ten komunikat nie zniknie.',
  'main.engine.badRequest': 'Nie rozpoznano polecenia instalacji silnika. Spróbuj ponownie.',
  'main.engine.nothingToRepair':
    'Nie ma czego naprawiać: silnik na tym dysku nie został uznany za uszkodzony.',
  'main.engine.nothingToUpdate':
    'Nie ma czego aktualizować: silniki na tym dysku mają już wersję używaną przez tę aplikację ' +
    'albo nowszą.',
  'main.engine.updateBusy':
    'Silnik AI jest teraz w użyciu (trwa generowanie odpowiedzi, import, tłumaczenie lub zadanie ' +
    'dotyczące dokumentu). Spróbuj ponownie zaktualizować silnik, gdy praca się zakończy.',
  'main.ocr.badRequest': 'Nie rozpoznano polecenia pobrania plików OCR. Spróbuj ponownie.',
  'main.ocr.alreadyRunning': 'Pliki OCR są już pobierane.',
  'main.ocr.noSources':
    'Na tym dysku nie ma listy pobierania plików OCR. Zamiast tego dodaj je za pomocą skryptów ' +
    'konfiguracji dysku („fetch-runtime --family ocr”).',
  'main.ocr.sourcesMismatch':
    'Lista pobierania plików OCR na tym dysku nie pasuje do tej wersji aplikacji HilbertRaum, ' +
    'więc niczego nie pobrano. Zamiast tego dodaj pliki za pomocą skryptów konfiguracji dysku ' +
    '(„fetch-runtime --family ocr”).',
  'main.ocr.alreadyInstalled':
    'Pliki OCR są już na tym dysku. Jeśli rozpoznawanie tekstu nadal nie jest dostępne, uruchom ' +
    'ponownie aplikację HilbertRaum.',
  'main.ocr.unsafeFolder':
    'Folder „ocr” na tym dysku nie jest zwykłym folderem (może wskazywać inne miejsce), więc ' +
    'niczego nie zapisano. Zastąp go zwykłym folderem o nazwie „ocr”, a potem spróbuj ponownie.',
  'main.ocr.writeFailed':
    'Nie udało się zapisać plików OCR na tym dysku. Sprawdź, czy dysk nie jest pełny ani ' +
    'chroniony przed zapisem, a potem spróbuj ponownie.',
  'main.ocr.downloadFailed':
    'Nie udało się pobrać plików OCR. Sprawdź połączenie z internetem, a potem spróbuj ponownie.',
  'main.ocr.checksumMismatch':
    'Pobrany plik OCR nie zgadzał się z oczekiwaną sumą kontrolną, więc został odrzucony – ' +
    'pliki, które już są na tym dysku, nie zostały zmienione. Spróbuj ponownie.',
  'main.ocr.readFailed':
    'Nie udało się odczytać plików OCR, które już są na tym dysku – dysk mógł zostać odłączony ' +
    'albo inny program używa tych plików. Sprawdź dysk, a potem spróbuj ponownie.',
  'main.ocr.unknownJob':
    'To pobieranie plików OCR nie jest już śledzone. Jeśli plików nadal brakuje, rozpocznij ' +
    'pobieranie ponownie.',
  'main.docs.locked': 'Obszar roboczy jest zablokowany. Odblokuj go, aby zarządzać dokumentami.',
  'main.docs.processing':
    'Ten dokument jest jeszcze przetwarzany. Zaczekaj, aż import się zakończy.',
  'main.docs.tooManyPaths': 'Wybrano jednocześnie zbyt wiele plików. Zamiast tego wybierz folder.',
  'main.docs.taskRunning':
    'Dla tego dokumentu trwa zadanie. Anuluj je albo zaczekaj, aż się zakończy.',
  'main.docs.skillRunning':
    'Na tym dokumencie właśnie działa umiejętność. Anuluj ją albo zaczekaj, aż się zakończy.',
  'main.docs.previewEncrypted':
    'Ten dokument jest zaszyfrowany. Odblokuj obszar roboczy, aby zobaczyć jego podgląd.',
  'main.docs.previewGone':
    'Pliku dokumentu nie ma już na dysku. Zaimportuj go ponownie, aby zobaczyć podgląd.',
  'main.docs.exportTextOnly':
    'W ten sposób można eksportować tylko dokumenty tekstowe (Markdown, TXT, CSV).',
  'main.docs.exportEncrypted':
    'Ten dokument jest zaszyfrowany. Odblokuj obszar roboczy, aby go wyeksportować.',
  'main.docs.exportGone':
    'Pliku dokumentu nie ma już na dysku. Zaimportuj go ponownie, aby go wyeksportować.',
  'main.docs.exportOriginalChanged':
    'Dostępna jest już tylko twoja własna kopia tego pliku, a od importu została zmieniona – nie ' +
    'jest więc już oryginałem. Zamiast tego wyeksportuj wyodrębniony tekst.',
  'main.docs.noStoredTranscript':
    'Dla tego nagrania nie zapisano jeszcze transkrypcji. Zindeksuj je ponownie, aby wykonać ' +
    'nową transkrypcję.',
  'main.models.noManifests':
    'Na tym dysku nie znaleziono listy modeli – brak folderu model-manifests.',
  'main.models.autoSelected':
    'Ten model jest używany automatycznie po zainstalowaniu – nie trzeba go wybierać.',
  'main.models.locked': 'Obszar roboczy jest zablokowany. Odblokuj go, aby zarządzać modelami AI.',
  'main.audit.locked': 'Obszar roboczy jest zablokowany. Odblokuj go, aby zobaczyć aktywność.',
  'main.settings.locked': 'Obszar roboczy jest zablokowany. Odblokuj go, aby zmienić ustawienia.',
  'main.evidenceReviews.locked':
    'Obszar roboczy jest zablokowany. Odblokuj go, aby pracować nad weryfikacjami potwierdzeń.',
  'main.evidenceReviews.invalidRequest': 'To zapytanie dotyczące weryfikacji jest nieprawidłowe.',
  'main.evidenceReviews.exportNotRecorded':
    'Nie udało się zarejestrować pakietu potwierdzeń w historii eksportu, dlatego wyeksportowany ' +
    'plik został usunięty. Nic nie zapisano – spróbuj ponownie wyeksportować pakiet.',
  'main.evidenceReviews.exportFileNotRecorded':
    'Plik pakietu potwierdzeń został zapisany, ale nie udało się go zarejestrować w historii ' +
    'eksportu ani usunąć. Jego suma kontrolna nie została zarejestrowana – wyeksportuj pakiet ' +
    'ponownie i zastąp ten plik.',
  'main.evidenceReviews.exportOutdated':
    'Ta weryfikacja jest nieaktualna – od jej rozpoczęcia zmieniło się źródło lub odpowiedź. ' +
    'Przed eksportem przyjmij zmianę do wiadomości w weryfikacji.',
  'main.settings.invalidPatch': 'Ta zmiana ustawień jest nieprawidłowa i nie została zapisana.',
  'main.dictation.locked':
    'Obszar roboczy jest zablokowany. Odblokuj go, aby korzystać z dyktowania.',
  'main.dictation.silent':
    'Do mikrofonu nie dotarł żaden dźwięk. Sprawdź, czy nie jest wyciszony i czy w ustawieniach ' +
    'systemu aplikacja HilbertRaum ma do niego dostęp, a potem spróbuj ponownie.',
  'main.dictation.tooShort': 'Nagranie było za krótkie, aby zawierać mowę – spróbuj ponownie.',
  'main.dictation.unavailable':
    'Dyktowanie nie jest jeszcze dostępne na tym dysku – ekran Model AI pokazuje, czego brakuje.',
  'main.dictation.failed': 'Nie udało się tego transkrybować – spróbuj ponownie.',
  'main.dictation.tooLong':
    'To nagranie jest za długie na dyktowanie. W przypadku długich nagrań zaimportuj plik audio ' +
    'jako dokument.',
  'main.dictation.busy': 'Trwa jeszcze transkrypcja ostatniego dyktowania – to potrwa chwilę.',
  'main.dictation.engineCannotRun':
    'Silnik mowy nie może działać na tym komputerze. Ekran Model AI pokazuje, czego brakuje.',
  'main.preflight.readOnly':
    'Wygląda na to, że ten dysk jest tylko do odczytu, więc aplikacja nie może utworzyć obszaru ' +
    'roboczego. Użyj innego portu USB albo zajrzyj do instrukcji rozwiązywania problemów.',
  'main.preflight.lowSpace':
    'Na tym dysku zostało mało wolnego miejsca. Możesz mimo to kontynuować, ale import dużych ' +
    'dokumentów może się nie udać, dopóki nie zwolnisz miejsca.',
  'main.dialog.importDocuments': 'Importuj dokumenty',
  'main.dialog.importFolder': 'Importuj folder z dokumentami',
  'main.dialog.exportDocument': 'Eksportuj dokument',
  'main.dialog.exportOriginal': 'Eksportuj oryginalny plik',
  'main.dialog.exportSummary': 'Eksportuj streszczenie',
  'main.dialog.exportChat': 'Eksportuj zapis rozmowy',
  'main.dialog.exportTableCsv': 'Eksportuj tabelę jako CSV',
  'main.dialog.exportCodeBlock': 'Zapisz blok kodu jako plik',
  'main.dialog.exportAudit': 'Eksportuj dziennik aktywności',
  'main.dialog.exportEvidencePack': 'Eksportuj pakiet potwierdzeń',
  'main.dialog.exportLog': 'Zapisz dzienniki diagnostyczne',
  'main.dialog.filterDocuments': 'Dokumenty',
  'main.dialog.filterAll': 'Wszystkie pliki',
  'main.zim.unavailable': 'Pakiety wiedzy nie są dostępne w tej sesji.',
  'main.zim.articleUnavailable':
    'Ten artykuł jest teraz niedostępny, więc nie udało się go zapisać. Pakiet mógł zostać ' +
    'wyłączony lub usunięty albo jego dysk mógł zostać odłączony.',
  'main.zim.saveFailed': 'Nie udało się dodać artykułu do twoich dokumentów. Spróbuj ponownie.',
  'main.zim.dialogTitle': 'Dodaj pakiety wiedzy',
  'main.zim.filterZim': 'Archiwa ZIM',
  'main.dialog.chooseImage': 'Wybierz obraz',
  'main.dialog.filterImages': 'Obrazy',
  'main.images.unsupportedType':
    'Ten typ pliku nie jest obsługiwany. Wybierz plik PNG, JPEG lub WEBP.',
  'main.images.tooLarge': 'Ten obraz jest za duży do analizy. Spróbuj użyć mniejszego obrazu.',
  'main.dialog.importSkill': 'Importuj pakiet umiejętności',
  'main.dialog.importSkillFolder': 'Importuj folder umiejętności',
  'main.dialog.exportSkill': 'Eksportuj umiejętność',
  'main.dialog.filterSkill': 'Pakiet umiejętności',
  'main.dialog.exportCsv': 'Eksportuj transakcje',
  'main.dialog.filterCsv': 'Plik CSV',
  'main.dialog.exportJson': 'Eksportuj jako JSON',
  'main.dialog.filterJson': 'Plik JSON',
  'main.dialog.exportXml': 'Eksportuj jako XML',
  'main.dialog.filterXml': 'Plik XML',
  'main.dialog.exportRedacted': 'Zapisz kopię z ukrytymi danymi osobowymi',
  'main.dialog.exportEdited': 'Zapisz edytowaną kopię',
  'main.dialog.filterText': 'Plik tekstowy',
  'main.dialog.filterDocx': 'Dokument Word',
  'main.collections.builtinUndeletable':
    'Wbudowanych sekcji „Biblioteka” i „Tymczasowe” nie można usunąć.',
  'main.skills.locked':
    'Obszar roboczy jest zablokowany. Odblokuj go, aby zarządzać umiejętnościami.',
  'main.skills.notPicked': 'Najpierw wybierz pakiet umiejętności w oknie wyboru pliku.',
  'main.skills.incompatible':
    'Ta umiejętność wymaga nowszej wersji aplikacji. Zaktualizuj aplikację, aby jej używać.',
  'main.skills.run.unavailable': 'Narzędzie tej umiejętności jest teraz niedostępne.',
  'main.skills.run.noDocument': 'Najpierw dodaj dokument do tego czatu, a potem spróbuj ponownie.',
  'main.skills.run.busy': 'Umiejętność już pracuje. Poczekaj, aż skończy, albo najpierw ją anuluj.',
  'main.skills.run.documentOutOfScope':
    'Tego dokumentu nie ma wśród dokumentów tego czatu. Wybierz jeden z nich i spróbuj ponownie.',
  // ---- Document organization — Documents screen sections + actions (plan §12) ----
  'docs.section.heading': 'Sekcje',
  'docs.section.library': 'Biblioteka',
  'docs.section.projects': 'Projekty',
  'docs.section.temporary': 'Tymczasowe',
  'docs.section.generated': 'Wygenerowane',
  'docs.section.archived': 'Archiwum',
  'docs.section.all': 'Wszystkie dokumenty',
  'docs.section.newProject': 'Nowy projekt',
  'docs.mode.aria': 'Widok dokumentów',
  'docs.mode.documents': 'Moje dokumenty',
  'docs.mode.packs': 'Pakiety wiedzy',
  'docs.filter.placeholder': 'Filtruj według nazwy…',
  'docs.filter.aria': 'Filtruj dokumenty według nazwy',
  'docs.filter.noMatch': 'Żaden dokument nie pasuje do filtra „{query}”.',
  'docs.empty.packsLine':
    'Możesz też dodać pakiet wiedzy – Wikipedię offline, na podstawie której czat może ' +
    'odpowiadać.',
  'docs.empty.packsAction': 'Pakiety wiedzy',
  'docs.rail.hide': 'Ukryj sekcje',
  'docs.rail.show': 'Pokaż sekcje',
  'docs.project.createTitle': 'Utwórz projekt',
  'docs.project.namePlaceholder': 'Nazwa projektu',
  'docs.project.nameAria': 'Nazwa projektu',
  'docs.project.create': 'Utwórz',
  'docs.project.rename': 'Zmień nazwę',
  'docs.project.renameTitle': 'Zmień nazwę projektu',
  'docs.project.archive': 'Archiwizuj',
  'docs.project.unarchive': 'Przywróć z archiwum',
  'docs.project.delete': 'Usuń projekt',
  'docs.project.deleteTitle': 'Usunąć ten projekt?',
  'docs.project.deleteBody': 'Wybierz, co ma się stać z dokumentami w tym projekcie:',
  'docs.project.deleteKeep': 'Usuń tylko projekt – zachowaj jego dokumenty',
  'docs.project.deleteKeepHint': 'Dokumenty zostają w twojej bibliotece i w innych projektach.',
  'docs.project.deleteWith': 'Usuń projekt i dokumenty, które są tylko w nim',
  'docs.project.deleteWithHint':
    'Usuwane są tylko dokumenty, których nie ma w twojej bibliotece ani w innym projekcie. ' +
    'Zawartość biblioteki nigdy nie jest naruszana.',
  'docs.project.archivedNote':
    'Zarchiwizowany – ukryty jako źródło, ale o jego dokumenty nadal można pytać w innych ' +
    'miejscach.',
  'docs.project.options': 'Opcje projektu',
  'docs.action.moveToProject': 'Przenieś do projektu…',
  'docs.action.addToLibrary': 'Zachowaj w bibliotece',
  'docs.action.removeFromProject': 'Usuń z tego projektu',
  'docs.action.markTemporary': 'Zachowaj tymczasowo',
  'docs.action.markPermanent': 'Zachowaj na stałe',
  'docs.action.archive': 'Archiwizuj',
  'docs.action.unarchive': 'Przywróć z archiwum',
  'docs.action.chooseProject': 'Wybierz projekt',
  'docs.chip.library': 'Biblioteka',
  'docs.chip.temporary': 'Tymczasowy',
  'docs.chip.generated': 'Wygenerowany',
  'docs.chip.archived': 'W archiwum',
  'docs.bulk.selected.one': 'Zaznaczono {count} dokument',
  'docs.bulk.selected.few': 'Zaznaczono {count} dokumenty',
  'docs.bulk.selected.many': 'Zaznaczono {count} dokumentów',
  'docs.bulk.selected.other': 'Zaznaczono {count} dokumentu',
  'docs.selectionAria': 'Działania dla zaznaczonych dokumentów',
  'docs.bulk.delete': 'Usuń',
  'docs.bulk.deleteConfirm.title.one': 'Usunąć {count} dokument?',
  'docs.bulk.deleteConfirm.title.few': 'Usunąć {count} dokumenty?',
  'docs.bulk.deleteConfirm.title.many': 'Usunąć {count} dokumentów?',
  'docs.bulk.deleteConfirm.title.other': 'Usunąć {count} dokumentu?',
  'docs.bulk.deleteConfirm.body':
    'Zaznaczone dokumenty, ich wyodrębniony tekst i indeks wyszukiwania zostaną trwale usunięte ' +
    'z twojego obszaru roboczego. Oryginalne pliki poza obszarem roboczym zostają bez zmian.',
  'docs.empty.section': 'Nic tu jeszcze nie ma.',
  // ---- Document organization — smart views (plan §7.6/§12.1, Phase E; regrouped §11.16) ----
  'docs.smart.recentlyAdded': 'Ostatnio dodane',
  'docs.smart.unfiled': 'Bez projektu',
  'docs.smart.attention': 'Wymaga uwagi',
  'docs.smart.attentionTitle':
    'Nieudane importy i dokumenty, które wymagają ponownego indeksowania',
  'docs.smart.more': 'Więcej',
  'docs.provenance.staleBadge': 'Nieaktualny',
  'docs.provenance.staleChanged':
    'Od powstania tego dokumentu jedno ze źródeł się zmieniło – uruchom zadanie ponownie, aby go ' +
    'zaktualizować.',
  'docs.provenance.staleRemoved':
    'Od powstania tego dokumentu jedno ze źródeł zostało usunięte – uruchom zadanie ponownie, ' +
    'aby go zaktualizować.',
  // ---- Chat — composite source scope (multi-select picker + footer union, plan §13) ----
  'chat.scope.library': 'Biblioteka',
  'chat.scope.projectNamed': 'Projekt „{name}”',
  'chat.scope.projectCount.one': '{count} projekt',
  'chat.scope.projectCount.few': '{count} projekty',
  'chat.scope.projectCount.many': '{count} projektów',
  'chat.scope.projectCount.other': '{count} projektu',
  // ---- Knowledge packs (ZIM wave: ScopePopover / SourcesDisclosure / ArticleModal / PacksPanel) ----
  'chat.scope.packsTitle': 'Pakiety wiedzy',
  'chat.scope.packUnavailable': 'niedostępny',
  'chat.scope.packNamed': 'Pakiet „{name}”',
  'chat.scope.packNamedState': 'Pakiet „{name}” ({state})',
  'chat.scope.packCount.one': '{count} pakiet wiedzy',
  'chat.scope.packCount.few': '{count} pakiety wiedzy',
  'chat.scope.packCount.many': '{count} pakietów wiedzy',
  'chat.scope.packCount.other': '{count} pakietu wiedzy',
  'chat.scope.documentsToggle': 'Szukaj w moich dokumentach',
  'chat.scope.documentsToggleHint':
    'Wyłączone: odpowiedzi pochodzą tylko z zaznaczonych pakietów wiedzy. Pliki dołączone do ' +
    'tego czatu są nadal używane.',
  'chat.scope.documentsOffSuffix': 'dokumenty wyłączone',
  'chat.scope.documentsOffNoPacks': 'brak – włącz dokumenty albo zaznacz pakiet wiedzy',
  'chat.scope.packDisabled': 'wyłączony',
  'chat.scope.packRemoved': 'Usunięty pakiet',
  'chat.scope.packLimit.one': 'Maksymalnie {count} pakiet wiedzy na czat',
  'chat.scope.packLimit.few': 'Maksymalnie {count} pakiety wiedzy na czat',
  'chat.scope.packLimit.many': 'Maksymalnie {count} pakietów wiedzy na czat',
  'chat.scope.packLimit.other': 'Maksymalnie {count} pakietu wiedzy na czat',
  // ---- Per-answer knowledge-pack outcomes (#301 P4, findings M6/M7 — PackOutcomesNotice) ----
  'chat.packs.outcome.summary':
    'Pakiety wiedzy – przeszukane: {searched} · nieprzeszukane lub z błędem: {other}',
  'chat.packs.outcome.removedPack': 'usunięty pakiet',
  'chat.packs.outcome.passages.one': '{count} fragment',
  'chat.packs.outcome.passages.few': '{count} fragmenty',
  'chat.packs.outcome.passages.many': '{count} fragmentów',
  'chat.packs.outcome.passages.other': '{count} fragmentu',
  'chat.packs.outcome.unknown':
    'Pakiety wiedzy: przy tej starszej odpowiedzi nie zapisano przebiegu wyszukiwania',
  'chat.packs.outcome.searched': 'przeszukano',
  'chat.packs.outcome.selection-limit': 'nie przeszukano: limit wyboru (12 na czat)',
  'chat.packs.outcome.removed': 'nie przeszukano: pakiet usunięty',
  'chat.packs.outcome.disabled': 'nie przeszukano: pakiet wyłączony',
  'chat.packs.outcome.file-missing': 'nie przeszukano: brak pliku',
  'chat.packs.outcome.identity-mismatch': 'nie przeszukano: inne archiwum w tej lokalizacji',
  'chat.packs.outcome.not-served': 'nie przeszukano: nazwa koliduje z innym pakietem',
  'chat.packs.outcome.not-searchable': 'nie przeszukano: brak indeksu pełnotekstowego',
  'chat.packs.outcome.tools-missing': 'nie przeszukano: nie zainstalowano narzędzi kiwix-tools',
  'chat.packs.outcome.mode':
    'nie przeszukano: odpowiedzi na podstawie całego dokumentu korzystają tylko z dokumentu',
  'chat.packs.outcome.search-failed': 'nie udało się: błąd wyszukiwania',
  'chat.packs.outcome.read-failed': 'nie udało się: nie odczytano żadnego artykułu',
  'chat.packs.outcome.timeout': 'nie udało się: przekroczono limit czasu',
  'chat.packs.outcome.deadline': 'nie przeszukano: zabrakło czasu na to pytanie',
  'chat.packs.outcome.server-restarted':
    'nie udało się: serwer pakietów został uruchomiony ponownie w trakcie tego pytania',
  'chat.sources.openArticle': 'Otwórz artykuł',
  'chat.article.title': 'Artykuł',
  'chat.article.from': 'Źródło: {archive} – kopia offline',
  'chat.article.loading': 'Wczytywanie artykułu…',
  'chat.article.unavailable':
    'Ten artykuł jest teraz niedostępny. Pakiet może być wyłączony lub usunięty albo jego dysk ' +
    'może być odłączony.',
  'chat.article.partial': 'Udało się wyświetlić tylko pierwszą część tego artykułu.',
  'chat.article.save': 'Zapisz w moich dokumentach',
  'chat.article.saveAria': 'Zapisz w moich dokumentach: {title}',
  'chat.article.saving': 'Zapisywanie w dokumentach…',
  'chat.article.saved':
    'Zapisano w twoich dokumentach pod nazwą „{title}”. Ten dokument można przeszukiwać także ' +
    'bez pakietu.',
  'chat.article.alreadySaved': 'Ten artykuł jest już w twoich dokumentach pod nazwą „{title}”.',
  // ---- #301 P6 (a11y pass; plan §9.23 (b)4/(b)6 and decision (c)5) — BEGIN -----------------
  'chat.scope.packMissing': 'brak pliku',
  'chat.scope.packMismatch': 'inne archiwum w tej lokalizacji',
  'chat.scope.packNotSearchable': 'brak indeksu pełnotekstowego',
  'chat.sources.openArticleNamed': 'Otwórz artykuł: {title}',
  // ---- #301 P6 — END ------------------------------------------------------------------------
  'packs.add': 'Dodaj pakiety…',
  'packs.addBusy': 'Dodawanie…',
  'packs.refresh': 'Odśwież',
  'packs.lead':
    'Archiwa wiedzy offline (pliki ZIM – na przykład Wikipedia offline), na podstawie których ' +
    'czat może odpowiadać. Pliki są używane w miejscu, w którym się znajdują, i nigdy nie są ' +
    'kopiowane: umieść je w folderze „zim” na dysku albo dodaj je tutaj.',
  'packs.summary.count.one': '{count} pakiet',
  'packs.summary.count.few': '{count} pakiety',
  'packs.summary.count.many': '{count} pakietów',
  'packs.summary.count.other': '{count} pakietu',
  'packs.summary.enabled.one': '{count} włączony',
  'packs.summary.enabled.few': '{count} włączone',
  'packs.summary.enabled.many': '{count} włączonych',
  'packs.summary.enabled.other': '{count} włączonego',
  'packs.summary.size': '{size} na tym dysku',
  'packs.loading': 'Wczytywanie pakietów…',
  'packs.refreshing': 'Wyszukiwanie pakietów na dysku…',
  'packs.emptyTitle': 'Nie ma jeszcze pakietów wiedzy',
  'packs.emptyLine':
    'Pobierz jednoplikowe archiwum .zim ze strony library.kiwix.org, a potem dodaj je tutaj albo ' +
    'skopiuj do folderu „zim” na dysku.',
  'packs.copyLibrary': 'Kopiuj adres biblioteki',
  'packs.copiedToast': 'Skopiowano adres library.kiwix.org',
  'packs.copyFailed': 'Nie udało się skopiować – adres to library.kiwix.org',
  'packs.setup.title': 'Jednorazowa konfiguracja: narzędzia pakietów wiedzy',
  'packs.toolsMissing':
    'Na tym dysku nie zainstalowano programów kiwix-tools, więc nie można dodawać ani ' +
    'przeszukiwać pakietów. Krok instalacji znajdziesz w instrukcji rozwiązywania problemów, w ' +
    'części „The panel says kiwix-tools are missing”.',
  'packs.tools.install': 'Zainstaluj narzędzia pakietów wiedzy…',
  'packs.tools.confirm.title': 'Zainstalować narzędzia pakietów wiedzy?',
  'packs.tools.confirm.explain':
    'Narzędzia kiwix-tools {version} – programy, które obsługują pakiety wiedzy (archiwa ZIM) – ' +
    'zostaną pobrane z serwera projektu Kiwix i sprawdzone przed użyciem. Są opcjonalne: czat i ' +
    'dokumenty działają bez nich.',
  'packs.tools.confirm.hint':
    'Pobrany plik jest sprawdzany przed użyciem i nie są wysyłane żadne informacje o tobie ani o ' +
    'twoich dokumentach. Narzędzia są potrzebne tylko do pakietów wiedzy.',
  'packs.tools.confirm.ack':
    'Potwierdzam zapoznanie się z warunkami licencji {license} narzędzi kiwix-tools i akceptuję ' +
    'je',
  'packs.tools.confirm.start': 'Rozpocznij pobieranie',
  'packs.tools.sizeUnknown': 'nieznany',
  'packs.tools.progress': 'Instalowanie narzędzi pakietów wiedzy… {pct}%',
  'packs.tools.downloadingNoTotal': 'Instalowanie narzędzi pakietów wiedzy…',
  'packs.tools.verifying': 'Sprawdzanie narzędzi pakietów wiedzy…',
  'packs.tools.extracting': 'Rozpakowywanie narzędzi pakietów wiedzy…',
  'packs.tools.failed': 'Nie udało się zainstalować narzędzi pakietów wiedzy.',
  'packs.tools.doneToast': 'Zainstalowano narzędzia pakietów wiedzy',
  'packs.addedToast.one': 'Dodano pakiet wiedzy',
  'packs.addedToast.few': 'Dodano {count} pakiety wiedzy',
  'packs.addedToast.many': 'Dodano {count} pakietów wiedzy',
  'packs.addedToast.other': 'Dodano {count} pakietu wiedzy',
  'packs.addPartial': 'Archiwa, których nie udało się dodać: {failed} z {total}.',
  'packs.addFailed.notAZim': 'Wybrany plik nie jest czytelnym archiwum ZIM.',
  'packs.addFailed.toolsMissing':
    'Na tym dysku nie zainstalowano programów kiwix-tools, więc nie można dodawać ani ' +
    'przeszukiwać pakietów. Krok instalacji znajdziesz w instrukcji rozwiązywania problemów, w ' +
    'części „The panel says kiwix-tools are missing”.',
  'packs.addFailed.manager':
    'Nie udało się odczytać archiwum za pomocą programu kiwix-manage. Sprawdź, czy plik jest ' +
    'kompletny, i spróbuj ponownie.',
  'packs.addFailed.pathUnsupported':
    'W systemie Windows program kiwix-manage nie może odczytać tego archiwum, ponieważ nazwa ' +
    'pliku lub folderu zawiera literę ze znakiem diakrytycznym (na przykład ą, ł, ü, é) albo ' +
    'inny znak spoza ASCII. Skopiuj plik do folderu „zim/” na dysku pod nazwą bez takich znaków ' +
    'i dodaj go ponownie.',
  'packs.addFailed.other': 'Nie udało się dodać archiwum.',
  'packs.removedToast': 'Usunięto pakiet wiedzy',
  'packs.articleCount.one': '{count} artykuł',
  'packs.articleCount.few': '{count} artykuły',
  'packs.articleCount.many': '{count} artykułów',
  'packs.articleCount.other': '{count} artykułu',
  'packs.state.enabled': 'Włączony',
  'packs.state.disabled': 'Wyłączony',
  'packs.state.missing': 'Brak pliku',
  'packs.state.missingTitle': 'Nie znaleziono pliku archiwum – czy dysk jest podłączony?',
  'packs.state.identityMismatch': 'Inne archiwum',
  'packs.state.identityMismatchTitle':
    'Plik w lokalizacji tego pakietu to inne archiwum – usuń ten pakiet i dodaj plik ponownie',
  'packs.state.notSearchable': 'Brak indeksu pełnotekstowego',
  'packs.state.notSearchableTitle':
    'To archiwum nie ma indeksu wyszukiwania pełnotekstowego. Jest pomijane przy zadawaniu ' +
    'pytań, ale jego artykuły nadal można czytać.',
  'packs.state.notServed': 'Nieużywany',
  'packs.state.notServedTitle':
    'Nazwa pliku tego pakietu koliduje z pakietem „{title}”, więc używany jest tylko tamten ' +
    'pakiet – zmień nazwę tego pliku, aby używać obu.',
  'packs.state.notServedTitleUnknown':
    'Nazwa pliku tego pakietu koliduje z nazwą innego pakietu, więc używany jest tylko tamten ' +
    'pakiet – zmień nazwę tego pliku, aby używać obu.',
  'packs.switchLabel': 'Używaj pakietu „{title}” w czatach',
  'packs.ask': 'Zapytaj ten pakiet',
  'packs.askTitle': 'Otwórz czat, który odpowiada wyłącznie na podstawie tego pakietu',
  'packs.rowMenu': 'Więcej działań dla pakietu „{title}”',
  'packs.remove': 'Usuń',
  'packs.listLabel': 'Pakiety wiedzy',
  'packs.removeTitle': 'Usunąć ten pakiet wiedzy?',
  'packs.removeConfirm': 'Usuń pakiet',
  'packs.removeBody':
    'Pakiet zostanie usunięty tylko z aplikacji HilbertRaum – plik archiwum na dysku zostaje bez ' +
    'zmian. Czaty, które z niego korzystały, po prostu przestaną z niego korzystać.',
  'chat.scope.docCount.one': '{count} dokument',
  'chat.scope.docCount.few': '{count} dokumenty',
  'chat.scope.docCount.many': '{count} dokumentów',
  'chat.scope.docCount.other': '{count} dokumentu',
  'chat.scope.filesInChat.one': '{count} plik w tym czacie',
  'chat.scope.filesInChat.few': '{count} pliki w tym czacie',
  'chat.scope.filesInChat.many': '{count} plików w tym czacie',
  'chat.scope.filesInChat.other': '{count} pliku w tym czacie',
  'chat.scope.sourcesTitle': 'Wybierz źródła',
  'chat.scope.librarySource': 'Biblioteka',
  'chat.scope.librarySourceHint': 'Wszystkie twoje dokumenty',
  'chat.scope.specificToggle': 'Wybrane dokumenty…',
  'chat.scope.allTap': 'Wszystkie dokumenty',
  'chat.scope.attachmentsOnlyTap': 'Tylko pliki z tego czatu',
  'chat.scope.filesInChatLine': 'Pliki w tym czacie',
  'chat.scope.attachmentNotReadable': '{name} (jeszcze nie do odczytania)',
  'chat.scope.attachmentFailedHint':
    'Plik, którego nie da się jeszcze odczytać, nie wnosi niczego do odpowiedzi. Ekran Dokumenty ' +
    'pokazuje, dlaczego tak jest i co zrobić.',
  'chat.scope.noProjects': 'Nie ma jeszcze projektów',
  'chat.scope.noPacks': 'Na tym dysku nie ma jeszcze pakietów wiedzy.',
  'chat.scope.addPacks': 'Dodaj pakiety…',
  'chat.scope.archivedFallback':
    'Ten projekt został zarchiwizowany – odpowiedzi pochodzą z twojej biblioteki.',
  'chat.scope.answeringFrom': 'Źródła odpowiedzi: {source}',
  'chat.scope.wholeLibrary.one': 'cała biblioteka – {count} dokument',
  'chat.scope.wholeLibrary.few': 'cała biblioteka – {count} dokumenty',
  'chat.scope.wholeLibrary.many': 'cała biblioteka – {count} dokumentów',
  'chat.scope.wholeLibrary.other': 'cała biblioteka – {count} dokumentu',
  'chat.scope.narrowTitle': 'Odpowiadać tylko na podstawie tego pliku?',
  'chat.scope.narrowBody':
    'Dodano plik {name}. Pytać tylko ten plik czy nadal odpowiadać na podstawie całej biblioteki?',
  'chat.scope.narrowJust': 'Tylko ten plik',
  'chat.scope.narrowWhole': 'Cała biblioteka',
  // ---- Chat — attach / drag-drop a file into a chat (plan §11.2/§13.5, Phase C) ----
  'chat.attach.button': 'Dołącz pliki',
  'chat.attach.drop': 'Upuść pliki, aby użyć ich w tym czacie',
  'chat.attach.processing': 'Przetwarzanie: {name}…',
  'chat.attach.added': 'Dodano do tego czatu: {name}',
  'chat.attach.newDocChat': 'Rozpoczęto nowy czat z dokumentem: {name}',
  'chat.attach.failed': 'Nie udało się dodać pliku {name} do tego czatu.',
  'chat.attach.dropUnsupported':
    'Nie udało się tego dodać – przeciągnij plik zapisany na komputerze.',
  'chat.attach.trackFailed':
    'Nie udało się śledzić importu pliku – wynik sprawdź na ekranie Dokumenty.',
  'chat.attach.scanned':
    'Plik {name} wygląda na skan, więc nie można go jeszcze odczytać. Na ekranie Dokumenty użyj ' +
    'przy nim opcji „Umożliw wyszukiwanie (OCR)”. Potem plik sam dołączy do tego czatu – nie ' +
    'trzeba go dołączać ponownie.',
  'chat.attach.photoNeedsOcr':
    'Plik {name} to zdjęcie strony, a do jego odczytania potrzebne są pliki OCR, których nie ma ' +
    'jeszcze na tym dysku. Na ekranie Dokumenty użyj przycisku „Pobierz pliki OCR”, a następnie ' +
    'wybierz przy tym pliku „Spróbuj ponownie”. Potem plik sam dołączy do tego czatu – nie ' +
    'trzeba go dołączać ponownie.',
  'chat.attach.goToDocuments': 'Otwórz ekran Dokumenty',
  // ---- Images — "Ask about an image" (image-understanding §5/§11, Phase V3) ----
  'images.title': 'Przeanalizuj obraz',
  'images.empty.body':
    'Pytaj o zrzut ekranu, wykres, formularz, paragon lub zdjęcie. Wszystko zostaje lokalnie.',
  'images.avail.noModel': 'Analiza obrazów wymaga lokalnego modelu wizyjnego na tym dysku.',
  'images.avail.noRuntime': 'Analiza obrazów wymaga najpierw zainstalowania silnika AI.',
  'images.avail.incompatible': 'Model wizyjny na tym dysku wymaga nowszego silnika AI.',
  'images.avail.cta': 'Otwórz Model AI',
  'images.avail.ocrPointer':
    'Zeskanowane dokumenty? Na ekranie Dokumenty użyj przycisku „Umożliw wyszukiwanie (OCR)”.',
  'images.drop.title': 'Upuść obraz tutaj',
  'images.drop.choose': 'lub wybierz obraz',
  'images.drop.types': 'PNG, JPEG lub WEBP',
  'images.drop.busy': 'Trwa analiza. Zaczekaj, aż się zakończy, aby rozpocząć kolejną.',
  'images.back': 'Wróć do analiz',
  'images.preview.remove': 'Usuń',
  'images.preview.replace': 'Zastąp',
  'images.preview.alt': 'Wybrany obraz',
  'images.chip.summarize': 'Streść ten obraz',
  'images.chip.summarize.prompt':
    'Streść widoczną zawartość tego obrazu. Wspomnij o wszystkim, co ważne lub nietypowe.',
  'images.chip.extractText': 'Wyodrębnij widoczny tekst',
  'images.chip.extractText.prompt':
    'Wyodrębnij widoczny tekst, który możesz odczytać. Zachowaj podziały wierszy tam, gdzie to ' +
    'pomaga. Napisz, jeśli jakiś tekst jest nieczytelny.',
  'images.chip.explainChart': 'Wyjaśnij ten wykres',
  'images.chip.explainChart.prompt':
    'Wyjaśnij, co ten wykres zdaje się przedstawiać. Wymień osie, etykiety, trendy i wszelkie ' +
    'niepewności.',
  'images.chip.readForm': 'Odczytaj formularz',
  'images.chip.readForm.prompt':
    'Wskaż najważniejsze pola i wartości widoczne w tym formularzu. Wpisz „nieczytelne” tam, ' +
    'gdzie nie możesz czegoś odczytać.',
  'images.chip.importantDetails': 'Znajdź ważne szczegóły',
  'images.chip.importantDetails.prompt':
    'Wymień najważniejsze widoczne szczegóły. Nie dopowiadaj niczego, czego nie widać.',
  'images.chip.whatNotice': 'Na co zwrócić uwagę?',
  'images.chip.whatNotice.prompt':
    'Na co warto zwrócić uwagę na tym obrazie? Wskaż tylko najbardziej wyróżniające się widoczne ' +
    'elementy.',
  'images.composer.placeholder': 'Zapytaj o ten obraz…',
  'images.composer.ask': 'Zapytaj',
  'images.answer.localNote': 'Wygenerowano lokalnie na podstawie wybranego obrazu.',
  'images.answer.copy': 'Kopiuj',
  'images.answer.copied': 'Skopiowano',
  'images.answer.copyFailed': 'Nie udało się skopiować do schowka',
  'images.answer.tryAgain': 'Spróbuj ponownie',
  'images.answer.reading': 'Odczytywanie obrazu…',
  'images.answer.starting': 'Uruchamianie modelu wizyjnego…',
  'images.answer.stop': 'Zatrzymaj',
  'images.answer.stopped': 'Zatrzymano.',
  'images.err.tooLarge': 'Ten obraz jest za duży do analizy. Spróbuj użyć mniejszego obrazu.',
  'images.err.unsupported': 'Ten typ pliku nie jest obsługiwany. Wybierz plik PNG, JPEG lub WEBP.',
  'images.err.heic':
    'Zdjęcia w formacie HEIC z telefonu iPhone nie są jeszcze obsługiwane. Najpierw ' +
    'przekonwertuj zdjęcie do formatu JPEG.',
  'images.err.pdf':
    'Ten ekran odczytuje jeden obraz, a nie plik PDF. W przypadku zeskanowanego pliku PDF użyj ' +
    'przycisku „Umożliw wyszukiwanie (OCR)” na ekranie Dokumenty.',
  'images.err.pdfAction': 'Otwórz ekran Dokumenty',
  'images.err.decodeFailed':
    'Nie udało się otworzyć tego obrazu. Może być uszkodzony albo mieć nieobsługiwany format.',
  'images.err.multiDrop': 'Upuszczaj obrazy pojedynczo.',
  'images.err.runtimeFailed':
    'Nie udało się uruchomić modelu wizyjnego. Spróbuj ponownie albo wybierz inny model.',
  'images.err.engineCannotRun':
    'Silnik AI nie może działać na tym komputerze. Na ekranie Model AI widać, czego brakuje.',
  'images.err.emptyResponse':
    'Nie otrzymano odpowiedzi dotyczącej tego obrazu. Spróbuj inaczej sformułować pytanie.',
  'images.err.emptyQuestion': 'Najpierw wpisz pytanie o obraz.',
  'images.err.timedOut':
    'To trwa zbyt długo. Spróbuj użyć mniejszego obrazu albo zapytaj ponownie.',
  'images.err.contextExceeded':
    'Ta rozmowa stała się za długa dla tego obrazu. Zadaj krótsze pytanie albo rozpocznij nową ' +
    'analizę.',
  'images.err.busy': 'Trwa odpowiadanie na poprzednie pytanie…',
  'images.err.openFailed': 'Nie udało się otworzyć tej analizy. Spróbuj ponownie.',
  'images.err.deleteFailed': 'Nie udało się usunąć tej analizy. Spróbuj ponownie.',
  'images.err.clearFailed': 'Nie udało się wyczyścić historii. Spróbuj ponownie.',
  'images.history.title': 'Historia',
  'images.history.empty': 'Tutaj pojawią się analizowane obrazy.',
  'images.history.running': 'Trwa analiza…',
  'images.history.runningOpen': 'Pokaż trwającą analizę',
  'images.history.turns.one': '{count} pytanie',
  'images.history.turns.few': '{count} pytania',
  'images.history.turns.many': '{count} pytań',
  'images.history.turns.other': '{count} pytania',
  'images.history.delete': 'Usuń',
  'images.history.deleteAria': 'Usuń obraz „{title}”',
  'images.history.deleted': 'Usunięto z historii',
  'images.history.delete.title': 'Usunąć ten obraz?',
  'images.history.delete.confirm': 'Usuń',
  'images.history.delete.body':
    'Obraz „{title}” i jego odpowiedzi zostaną trwale usunięte z tego dysku.',
  'images.history.total': 'Łącznie: {size}',
  'images.history.clear': 'Wyczyść historię',
  'images.history.clear.title': 'Wyczyścić historię obrazów?',
  'images.history.clear.confirm': 'Wyczyść historię',
  'images.history.clear.body':
    'Wszystkie zapisane analizy ({size}) i zapisane z nimi obrazy zostaną trwale usunięte z tego ' +
    'dysku.',
  'images.history.cleared': 'Wyczyszczono historię obrazów',
  // ---- Translate screen (TranslateGemma wave, plan §2 D6, TG-4) ----
  'translate.title': 'Przetłumacz tekst',
  'translate.lead':
    'Wpisz lub wklej tekst, wybierz języki i przetłumacz go lokalnie. Nic nie opuszcza tego ' +
    'dysku.',
  'translate.starting': 'Przygotowywanie modelu tłumaczenia…',
  'translate.avail.noModel': 'Do tłumaczenia potrzebny jest model tłumaczenia na tym dysku.',
  'translate.avail.hint':
    'Pobierz go raz na ekranie Model AI – potem tłumaczenie działa w pełni offline.',
  'translate.avail.cta': 'Otwórz Model AI',
  'translate.from': 'Z języka',
  'translate.to': 'Na język',
  'translate.swap': 'Zamień języki',
  'translate.input.label': 'Tekst do przetłumaczenia',
  'translate.input.placeholder': 'Wpisz lub wklej tekst do przetłumaczenia…',
  'translate.action': 'Przetłumacz',
  'translate.stop': 'Zatrzymaj',
  'translate.output.label': 'Tłumaczenie',
  'translate.output.empty': 'Tutaj pojawi się tłumaczenie.',
  'translate.working': 'Tłumaczenie…',
  'translate.copy': 'Kopiuj',
  'translate.copied': 'Skopiowano',
  'translate.device.gpu': 'Tłumaczenie działa na karcie graficznej (GPU, warstwy: {done}/{total})',
  'translate.device.gpuUnknown': 'Tłumaczenie działa na karcie graficznej (GPU)',
  'translate.device.gpuPartial':
    'Tłumaczenie działa tylko częściowo na karcie graficznej (warstwy: {done}/{total}) – pamięć ' +
    'karty graficznej była w większości zajęta, zwykle przez model czatu, więc tłumaczenie ' +
    'działa mniej więcej z szybkością procesora',
  'translate.device.gpuNone':
    'Tłumaczenie działa na procesorze – pamięć karty graficznej była całkowicie zajęta, zwykle ' +
    'przez model czatu, więc żadna warstwa nie zmieściła się na karcie graficznej (warstwy: ' +
    '0/{total})',
  'translate.device.cpu': 'Tłumaczenie działa na procesorze (CPU)',
  'translate.device.cpuBesideChat':
    'Tłumaczenie działa na procesorze – model czatu korzysta z pamięci karty graficznej, a ' +
    'tłumaczenie nie zmieściłoby się obok niego',
  'translate.device.cpuChatStarting':
    'Tłumaczenie działa na procesorze – trwało uruchamianie modelu czatu, a model czatu ma ' +
    'pierwszeństwo w dostępie do karty graficznej',
  'translate.device.cpuTooLarge':
    'Tłumaczenie działa na procesorze – model tłumaczenia nie mieści się w pamięci tej karty ' +
    'graficznej',
  'translate.device.title':
    'Gdzie działał model tłumaczenia przy ostatnim uruchomieniu. Przy każdym uruchomieniu ' +
    'wybiera od nowa (zwalnia pamięć około 2 minut po ostatnim tłumaczeniu).',
  'translate.device.partialTitle':
    'Aby model tłumaczenia mógł zająć więcej pamięci karty: użyj mniejszego modelu czatu albo ' +
    'zatrzymaj go przed tłumaczeniem. Model tłumaczenia dopasuje się ponownie przy następnym ' +
    'uruchomieniu (około 2 minut po ostatnim tłumaczeniu).',
  'translate.device.gpuNoneTitle':
    'Aby model tłumaczenia w ogóle zmieścił się na karcie: użyj mniejszego modelu czatu albo ' +
    'zatrzymaj go przed tłumaczeniem. Model tłumaczenia dopasuje się ponownie przy następnym ' +
    'uruchomieniu (około 2 minut po ostatnim tłumaczeniu).',
  'translate.err.noModel':
    'Model tłumaczenia nie jest już dostępny. Otwórz ekran Model AI, aby go zainstalować.',
  'translate.err.badRequest':
    'Wybierz język źródłowy i docelowy, a potem wpisz tekst do przetłumaczenia.',
  'translate.err.busy': 'Tłumaczenie już trwa. Zaczekaj, aż się zakończy, i spróbuj ponownie.',
  'translate.err.docTaskBusy':
    'Trwa zadanie dotyczące dokumentu. Zaczekaj, aż się zakończy, a potem przetłumacz tekst.',
  'translate.err.runtimeFailed':
    'Modelowi tłumaczenia nie udało się dokończyć pracy. Spróbuj ponownie albo użyj krótszego ' +
    'tekstu.',
  'translate.err.startFailed':
    'Nie udało się uruchomić modelu tłumaczenia – na urządzeniu może brakować pamięci. Zamknij ' +
    'inne aplikacje lub uruchom ponownie aplikację HilbertRaum, a następnie spróbuj ponownie.',
  'translate.err.engineCannotRun':
    'Silnik AI nie może działać na tym komputerze. Na ekranie Model AI widać, czego brakuje.',
  'translate.err.empty': 'Nie otrzymano tłumaczenia. Spróbuj ponownie albo przeformułuj tekst.',
  'translate.err.sameLang': 'Wybierz dwa różne języki.',
  'translate.err.tooLong':
    'Tekst jest za długi, aby przetłumaczyć go tutaj (ponad 200\u00A0000 znaków). Podziel go na ' +
    'mniejsze części albo zapisz go jako plik i przetłumacz jako dokument.',
  // ---- Document drag-and-drop translation (TG-5, plan §2 D7) ----
  'translate.drop.title': 'Albo upuść dokument do przetłumaczenia',
  'translate.drop.choose': 'lub wybierz dokument',
  'translate.drop.types': 'PDF, Word, Markdown lub tekst – tłumaczenie na wybrany język.',
  'translate.file.importing': 'Odczytywanie dokumentu…',
  'translate.file.progress': 'Tłumaczenie… ({done}/{total})',
  'translate.file.preparing': 'Przygotowywanie tłumaczenia – odczytywanie dokumentu…',
  'translate.file.saving': 'Zapisywanie przetłumaczonego dokumentu…',
  'translate.file.truncated':
    'Widać początek tłumaczenia – aby zobaczyć cały dokument, wyeksportuj je lub otwórz na ' +
    'ekranie Dokumenty.',
  'translate.file.export': 'Eksportuj…',
  'translate.file.exported': 'Wyeksportowano dokument',
  'translate.file.show': 'Pokaż na ekranie Dokumenty',
  'translate.file.reset': 'Przetłumacz inny dokument',
  'translate.file.doneAnnounce': 'Zakończono tłumaczenie dokumentu. Wynik jest widoczny.',
  'translate.file.gapPages.one':
    '⚠ Strona {pages} oryginału nie została przetłumaczona – nie zawiera czytelnego tekstu (może ' +
    'to być skan). W wyniku zaznaczono lukę.',
  'translate.file.gapPages.few':
    '⚠ Strony {pages} oryginału nie zostały przetłumaczone – nie zawierają czytelnego tekstu ' +
    '(mogą to być skany). W wyniku zaznaczono każdą lukę.',
  'translate.file.gapPages.many':
    '⚠ Strony {pages} oryginału nie zostały przetłumaczone – nie zawierają czytelnego tekstu ' +
    '(mogą to być skany). W wyniku zaznaczono każdą lukę.',
  'translate.file.gapPages.other':
    '⚠ Strony {pages} oryginału nie zostały przetłumaczone – nie zawierają czytelnego tekstu ' +
    '(mogą to być skany). W wyniku zaznaczono każdą lukę.',
  'translate.file.failedParts.one':
    '⚠ {count} część nie została przetłumaczona – w zaznaczonym miejscu wyniku zachowano ' +
    'oryginalny tekst.',
  'translate.file.failedParts.few':
    '⚠ {count} części nie zostały przetłumaczone – w zaznaczonych miejscach wyniku zachowano ' +
    'oryginalny tekst.',
  'translate.file.failedParts.many':
    '⚠ {count} części nie zostało przetłumaczonych – w zaznaczonych miejscach wyniku zachowano ' +
    'oryginalny tekst.',
  'translate.file.failedParts.other':
    '⚠ {count} części nie zostało przetłumaczone – w zaznaczonych miejscach wyniku zachowano ' +
    'oryginalny tekst.',
  'translate.file.err.multiDrop': 'Upuszczaj dokumenty pojedynczo.',
  'translate.file.err.noPath':
    'Ten element nie ma pliku na dysku. Przeciągnij dokument z folderu albo użyj opcji „wybierz ' +
    'dokument”.',
  'translate.file.err.unsupported':
    'Nie można przetłumaczyć pliku tego typu. Spróbuj użyć pliku PDF, Word, Markdown lub pliku ' +
    'tekstowego.',
  'translate.file.err.scanned':
    'Ten plik PDF wygląda na skan bez czytelnego tekstu. Najpierw na ekranie Dokumenty umożliw w ' +
    'nim wyszukiwanie – „Umożliw wyszukiwanie (OCR)” – a potem go przetłumacz.',
  'translate.file.err.scannedAction': 'Otwórz ekran Dokumenty',
  'translate.file.err.importFailed': 'Nie udało się odczytać dokumentu. Spróbuj ponownie.',
  'translate.file.err.runtimeFailed': 'Nie udało się przetłumaczyć dokumentu. Spróbuj ponownie.',
  // ---- Evidence review (EP-1 plan §7 — ReviewScreen.tsx + chat entry points) ----
  'review.action.start': 'Zweryfikuj potwierdzenia',
  'review.action.continue': 'Kontynuuj weryfikację',
  'review.entry.sources': 'Zweryfikuj odpowiedź i źródła',
  'review.status.draft': 'Wersja robocza',
  'review.status.ready': 'Zakończona',
  'review.status.outdated': 'Nieaktualna',
  'review.readonlyHint': 'Weryfikacja zakończona – aby wprowadzać zmiany, wznów weryfikację.',
  // ---- P4: Outdated banner + acknowledge (spec §15.5/§21.3/§28.6) ----
  'review.outdated.title': 'Ta weryfikacja jest nieaktualna.',
  'review.outdated.answerChanged':
    'Tekst odpowiedzi nie zgadza się już ze stanem zapisanym w weryfikacji.',
  'review.outdated.coverageChanged':
    'Zapisane metadane pokrycia nie zgadzają się już ze stanem zapisanym w weryfikacji.',
  'review.outdated.sourcesChanged.one':
    '{count} dokument źródłowy zmienił się od rozpoczęcia tej weryfikacji.',
  'review.outdated.sourcesChanged.few':
    '{count} dokumenty źródłowe zmieniły się od rozpoczęcia tej weryfikacji.',
  'review.outdated.sourcesChanged.many':
    '{count} dokumentów źródłowych zmieniło się od rozpoczęcia tej weryfikacji.',
  'review.outdated.sourcesChanged.other':
    '{count} dokumentu źródłowego zmieniło się od rozpoczęcia tej weryfikacji.',
  'review.outdated.keepNote':
    'Twoje zapisane decyzje nie uległy zmianie. Możesz zachować tę weryfikację jako historyczną, ' +
    'przyjąć zmianę do wiadomości albo zadać pytanie ponownie w czacie i rozpocząć nową ' +
    'weryfikację.',
  'review.outdated.acknowledge': 'Przyjmij zmianę do wiadomości',
  'review.outdated.acknowledgedAt': 'Zmianę przyjęto do wiadomości: {date}.',
  'review.outdated.exportHint':
    'Przed wyeksportowaniem pakietu potwierdzeń przyjmij zmianę do wiadomości.',
  'review.back': 'Wróć do czatu',
  'review.rename': 'Zmień nazwę',
  'review.rename.label': 'Tytuł weryfikacji',
  'review.rename.save': 'Zapisz',
  'review.loading': 'Wczytywanie weryfikacji…',
  'review.notFound': 'Nie znaleziono tej weryfikacji. Mogła zostać usunięta.',
  'review.question.toggle': 'Pytanie',
  'review.answerPane.aria': 'Weryfikowana odpowiedź',
  'review.autosave.saving': 'Zapisywanie…',
  'review.autosave.saved': 'Zapisano',
  'review.autosave.error': 'Nie udało się jeszcze zapisać części zmian.',
  'review.autosave.retry': 'Spróbuj ponownie',
  'review.evidence.title': 'Potwierdzenia',
  'review.evidence.captionRelevance':
    'Pokazane źródła to fragmenty przekazane lokalnemu modelowi AI na potrzeby tej odpowiedzi.',
  'review.evidence.captionWholeDoc':
    'Ta odpowiedź pochodzi z analizy całego dokumentu. Pokazane sekcje wskazują to pochodzenie – ' +
    'bez odwołań do źródeł dla poszczególnych zdań.',
  'review.evidence.captionStructured':
    'Ta odpowiedź opiera się na danych wyodrębnionych lokalnie. Poniżej widać fragmenty źródeł, ' +
    'z których je wyodrębniono.',
  'review.evidence.none':
    'Dla tej odpowiedzi nie zapisano fragmentów źródeł. Możesz zapisać ogólną weryfikację, ale ' +
    'weryfikacja na poziomie źródeł nie jest dostępna.',
  'review.disclaimer':
    'Odwołanie do źródła pokazuje, skąd pochodzi informacja. Samo w sobie nie dowodzi, że ' +
    'odpowiedź jest poprawna.',
  'review.evidence.filterLabel': 'Filtruj źródła',
  'review.evidence.filterPlaceholder': 'Filtruj według tytułu lub tekstu…',
  'review.evidence.filterClear': 'Wyczyść filtr',
  'review.evidence.filterNone': 'Żadne źródło nie pasuje do filtra.',
  'review.evidence.shownCount': 'Pokazane źródła: {shown} z {total}',
  'review.evidence.more.one': 'i jeszcze {count} źródło',
  'review.evidence.more.few': 'i jeszcze {count} źródła',
  'review.evidence.more.many': 'i jeszcze {count} źródeł',
  'review.evidence.more.other': 'i jeszcze {count} źródła',
  'review.evidence.linkingItem': 'Powiązywanie potwierdzeń z punktem weryfikacji {n}',
  'review.source.kind.direct_excerpt': 'Bezpośredni fragment',
  'review.source.kind.whole_document_provenance': 'Pochodzenie z analizy całego dokumentu',
  'review.source.kind.structured_record': 'Wyodrębniony rekord',
  'review.source.unresolved': 'Nie udało się ustalić tożsamości źródła',
  'review.source.archive':
    'Artykuł z pakietu wiedzy – nie można zweryfikować jego tożsamości ani treści względem ' +
    'obszaru roboczego',
  'review.source.missingAtCreation':
    'Źródło nie było dostępne w chwili rozpoczęcia tej weryfikacji',
  'review.source.changed': 'Dokument źródłowy zmienił się od rozpoczęcia tej weryfikacji',
  'review.source.missingNow':
    'Tego źródła nie ma już w obszarze roboczym. Zapisany fragment zostaje w tej weryfikacji.',
  'review.source.cannotVerify': 'Nie można zweryfikować bieżącego stanu tego źródła',
  'review.sourceContext.open': 'Otwórz źródło w kontekście',
  'review.sourceContext.title': 'Źródło w kontekście',
  'review.sourceContext.loading': 'Wczytywanie zapisanego tekstu…',
  'review.sourceContext.failed': 'Nie udało się wczytać zapisanego tekstu tego źródła.',
  'review.sourceContext.hashMatch':
    'Zapisana suma kontrolna dokumentu zgadza się z sumą zapisaną w weryfikacji.',
  'review.sourceContext.hashMismatch':
    'Dokument źródłowy zmienił się od rozpoczęcia tej weryfikacji.',
  'review.sourceContext.hashUnknown':
    'Nie można zweryfikować bieżącego stanu dokumentu względem stanu zapisanego w weryfikacji.',
  'review.sourceContext.missing':
    'To źródło było dostępne, gdy wygenerowano odpowiedź, ale nie ma go już w obszarze roboczym. ' +
    'Zapisany fragment, jeśli istnieje, zostaje w tej weryfikacji.',
  'review.sourceContext.notLocated':
    'Nie udało się odnaleźć zapisanego fragmentu w bieżącym zapisanym tekście. Poniżej pokazano ' +
    'go w postaci zapisanej przy rozpoczęciu weryfikacji.',
  'review.sourceContext.storedNote':
    'Kontekst pochodzi z tekstu wyodrębnionego i zapisanego podczas importu – sam plik dokumentu ' +
    'źródłowego nie jest otwierany.',
  'review.sourceContext.excerptHeading': 'Zapisany fragment',
  'review.link.add': 'Powiąż z punktem',
  'review.link.remove': 'Usuń powiązanie',
  'review.link.cited': 'Przywołano w odpowiedzi',
  'review.link.reviewer': 'Powiązano podczas weryfikacji',
  'review.link.selectHint':
    'Wybierz punkt weryfikacji, aby powiązać z nim potwierdzenia lub usunąć powiązania.',
  'review.relation.label': 'Rodzaj powiązania',
  'review.relation.none': 'Bez oznaczenia',
  'review.relation.supports': 'Potwierdza',
  'review.relation.qualifies': 'Ogranicza',
  'review.relation.contradicts': 'Przeczy',
  'review.relation.context': 'Tylko kontekst',
  'review.item.aria': 'Punkt weryfikacji {n}',
  'review.item.noMarker': 'Brak bezpośredniego odwołania do źródła w tym tekście',
  'review.item.wholeDocDerived': 'Pochodzi z analizy całego dokumentu',
  'review.item.noteLabel': 'Notatka',
  'review.item.notePlaceholder': 'Dodaj notatkę (opcjonalnie)',
  'review.item.viewEvidence': 'Pokaż potwierdzenia',
  // ---- P5 reviewer text selections (spec §12.1 "Review separately"; plan §10) ----
  'review.selection.start': 'Zweryfikuj fragment osobno',
  'review.selection.hint':
    'Zaznacz fragment w oryginalnym tekście poniżej (pokazanym bez formatowania), a następnie ' +
    'wybierz „Zweryfikuj osobno”.',
  'review.selection.surfaceAria': 'Oryginalny tekst punktu weryfikacji {n}',
  'review.selection.add': 'Zweryfikuj osobno',
  'review.selection.close': 'Gotowe',
  'review.selection.added': 'Fragment dodano jako osobny punkt weryfikacji.',
  'review.selection.refused':
    'Nie udało się dodać tego zaznaczenia. Zaznacz fragment od nowa i spróbuj ponownie.',
  'review.item.selectionTag': 'Fragment zaznaczony podczas weryfikacji',
  'review.selection.remove': 'Usuń zaznaczenie',
  'review.decision.groupAria': 'Decyzja',
  'review.decision.supported': 'Zweryfikowano – ma potwierdzenie',
  'review.decision.partly_supported': 'Zweryfikowano – częściowe potwierdzenie',
  'review.decision.not_supported': 'Zweryfikowano – brak potwierdzenia',
  'review.decision.follow_up': 'Do wyjaśnienia',
  'review.decision.not_reviewed': 'Nie zweryfikowano',
  'review.decision.not_applicable': 'Nie dotyczy',
  'review.bulk.menu': 'Działania zbiorcze',
  'review.bulk.headingsNa': 'Oznacz nagłówki jako „Nie dotyczy”',
  'review.bulk.followUp': 'Oznacz punkty bez decyzji jako „Do wyjaśnienia”',
  'review.bulk.clear': 'Wyczyść wszystkie decyzje',
  'review.bulk.clearConfirmTitle': 'Wyczyścić wszystkie decyzje?',
  'review.bulk.clearConfirmBody':
    'Każda decyzja w tej weryfikacji wróci do stanu „Nie zweryfikowano”. Notatki zostaną ' +
    'zachowane.',
  'review.bulk.clearConfirm': 'Wyczyść decyzje',
  'review.progress': 'Rozstrzygnięto: {decided} z {required}',
  'review.progress.followUps.one': '{count} punkt do wyjaśnienia',
  'review.progress.followUps.few': '{count} punkty do wyjaśnienia',
  'review.progress.followUps.many': '{count} punktów do wyjaśnienia',
  'review.progress.followUps.other': '{count} punktu do wyjaśnienia',
  'review.footer.summary': 'Podsumowanie weryfikacji',
  'review.summary.status': 'Status',
  'review.summary.decisions': 'Decyzje',
  'review.summary.sources': 'Źródła',
  'review.summary.sourcesCount.one': '{count} źródło',
  'review.summary.sourcesCount.few': '{count} źródła',
  'review.summary.sourcesCount.many': '{count} źródeł',
  'review.summary.sourcesCount.other': '{count} źródła',
  'review.summary.sourcesUnresolved.one': '{count} źródło ma nieustaloną tożsamość',
  'review.summary.sourcesUnresolved.few': '{count} źródła mają nieustaloną tożsamość',
  'review.summary.sourcesUnresolved.many': '{count} źródeł ma nieustaloną tożsamość',
  'review.summary.sourcesUnresolved.other': '{count} źródła ma nieustaloną tożsamość',
  'review.summary.sourcesArchive.one':
    '{count} źródło to artykuł z pakietu wiedzy i nie można go zweryfikować względem obszaru ' +
    'roboczego',
  'review.summary.sourcesArchive.few':
    '{count} źródła to artykuły z pakietów wiedzy i nie można ich zweryfikować względem obszaru ' +
    'roboczego',
  'review.summary.sourcesArchive.many':
    '{count} źródeł to artykuły z pakietów wiedzy i nie można ich zweryfikować względem obszaru ' +
    'roboczego',
  'review.summary.sourcesArchive.other':
    '{count} źródła to artykuły z pakietów wiedzy i nie można ich zweryfikować względem obszaru ' +
    'roboczego',
  'review.summary.sourcesMissing.one':
    '{count} źródło nie było dostępne w chwili rozpoczęcia tej weryfikacji',
  'review.summary.sourcesMissing.few':
    '{count} źródła nie były dostępne w chwili rozpoczęcia tej weryfikacji',
  'review.summary.sourcesMissing.many':
    '{count} źródeł nie było dostępnych w chwili rozpoczęcia tej weryfikacji',
  'review.summary.sourcesMissing.other':
    '{count} źródła nie było dostępne w chwili rozpoczęcia tej weryfikacji',
  'review.summary.sourcesChangedNow.one':
    '{count} dokument źródłowy zmienił się od rozpoczęcia tej weryfikacji',
  'review.summary.sourcesChangedNow.few':
    '{count} dokumenty źródłowe zmieniły się od rozpoczęcia tej weryfikacji',
  'review.summary.sourcesChangedNow.many':
    '{count} dokumentów źródłowych zmieniło się od rozpoczęcia tej weryfikacji',
  'review.summary.sourcesChangedNow.other':
    '{count} dokumentu źródłowego zmieniło się od rozpoczęcia tej weryfikacji',
  'review.summary.sourcesMissingNow.one':
    '{count} dokument źródłowy nie znajduje się już w obszarze roboczym',
  'review.summary.sourcesMissingNow.few':
    '{count} dokumenty źródłowe nie znajdują się już w obszarze roboczym',
  'review.summary.sourcesMissingNow.many':
    '{count} dokumentów źródłowych nie znajduje się już w obszarze roboczym',
  'review.summary.sourcesMissingNow.other':
    '{count} dokumentu źródłowego nie znajduje się już w obszarze roboczym',
  'review.summary.truncated':
    'Wygenerowana odpowiedź może być niepełna – została obcięta po osiągnięciu limitu długości ' +
    'odpowiedzi modelu.',
  'review.summary.stopped.model':
    'Wygenerowana odpowiedź jest niepełna – model AI został zatrzymany lub zmieniony przed jej ' +
    'ukończeniem.',
  'review.summary.stopped.user':
    'Wygenerowana odpowiedź jest niepełna – została zatrzymana przed ukończeniem.',
  'review.summary.stopped.lock':
    'Wygenerowana odpowiedź jest niepełna – obszar roboczy został zablokowany lub aplikacja ' +
    'została zamknięta przed jej ukończeniem.',
  'review.summary.generation': 'Szczegóły generowania',
  'review.summary.model': 'Model',
  'review.summary.generatedAt': 'Wygenerowano',
  'review.summary.appVersion': 'Wersja aplikacji',
  'review.summary.skill': 'Umiejętność',
  'review.summary.unavailable': 'Brak danych',
  'review.summary.reviewerLabel': 'Osoba weryfikująca',
  'review.summary.reviewerPlaceholder': 'Twoje imię i nazwisko lub oznaczenie (opcjonalnie)',
  'review.summary.generalNote': 'Notatka ogólna',
  'review.summary.generalNotePlaceholder': 'Ogólne uwagi (opcjonalnie)',
  'review.summary.exports': 'Historia eksportu',
  'review.summary.markReady': 'Zakończ weryfikację',
  'review.summary.reopen': 'Wznów weryfikację',
  'review.summary.gateHint':
    'Każdy blok odpowiedzi wymaga decyzji, zanim będzie można zakończyć weryfikację ' +
    '(rozstrzygnięto: {decided} z {required}). „Nie dotyczy” liczy się jako decyzja.',
  'review.toast.ready': 'Zakończono weryfikację.',
  'review.completedAt': 'Zakończono: {date}',
  'review.deleteWithConversation.one':
    '{count} weryfikacja potwierdzeń powiązana z tą rozmową również zostanie usunięta.',
  'review.deleteWithConversation.few':
    '{count} weryfikacje potwierdzeń powiązane z tą rozmową również zostaną usunięte.',
  'review.deleteWithConversation.many':
    '{count} weryfikacji potwierdzeń powiązanych z tą rozmową również zostanie usuniętych.',
  'review.deleteWithConversation.other':
    '{count} weryfikacji potwierdzeń powiązanej z tą rozmową również zostanie usunięte.',
  'review.deleteWithConversation.unknown':
    'Weryfikacje potwierdzeń powiązane z tą rozmową, jeśli istnieją, również zostaną usunięte.',
  // ---- Evidence-pack export (EP-1 plan §8 — summary panel + status line) ----
  'review.status.lastExported': 'Ostatni eksport: {date}',
  'review.export.action': 'Utwórz pakiet potwierdzeń',
  'review.export.title': 'Eksportuj pakiet potwierdzeń',
  'review.export.encryptionWarning':
    'Ten wyeksportowany plik jest przechowywany poza zaszyfrowanym obszarem roboczym aplikacji ' +
    'HilbertRaum i nie jest chroniony hasłem twojego obszaru roboczego.',
  'review.export.packLanguage.en': 'Ten pakiet zostanie zapisany po angielsku.',
  'review.export.packLanguage.de': 'Ten pakiet zostanie zapisany po niemiecku.',
  'review.export.options': 'Uwzględnij w pakiecie',
  'review.export.optNotes': 'Notatki z weryfikacji',
  'review.export.optExcerpts': 'Fragmenty źródeł',
  'review.export.optHashes': 'Sumy kontrolne dokumentów',
  'review.export.optUnreviewed': 'Niezweryfikowane punkty',
  'review.export.optTechnical': 'Szczegóły techniczne',
  'review.export.format': 'Format pliku',
  'review.export.formatHtml': 'HTML – samodzielna strona internetowa',
  'review.export.formatPdf': 'PDF – gotowy do druku (A4)',
  'review.export.confirm': 'Eksportuj pakiet…',
  'review.export.cancel': 'Zamknij',
  'review.export.done': 'Wyeksportowano pakiet potwierdzeń.',
  'review.export.error':
    'Nie udało się wyeksportować pakietu potwierdzeń. Nie zapisano żadnego pliku.',
  'review.export.copyHash': 'Kopiuj SHA-256',
  'review.export.hashCopied': 'Skopiowano SHA-256 do schowka.'
}
