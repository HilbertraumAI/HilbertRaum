import type { UiCatalog } from './languages'

// The TURKISH catalog (interface only). Typed `UiCatalog<'tr'>`: a missing, stale or extra key
// is a typecheck failure. `packExport.*` is not part of it (evidence packs stay en/de).
// Plural forms: one / other. A noun stays singular after a number, so both forms are often the
// same text: that is correct Turkish.
//
// Style (design-guidelines §7 "Turkish microcopy"): «siz» in sentences with the short polite
// imperative (seçin, deneyin), lower case and usually dropped; the bare imperative on buttons
// (Kaydet, Sil, İndir), "Cancel" is İptal. The copy ADAPTS the calm spec-§11.4 tone. Quotes “…”
// (no nesting), apostrophe ’ only after proper names, ellipsis …, en dash " – " between a label
// and its gloss (never —), percent before the figure (%{pct}). "HilbertRaum" is never
// translated.
//
// NEVER attach anything to a {placeholder} or to a closing quote: no suffix, no apostrophe plus
// suffix, no de/da or mi/mı/mu/mü right after it. Use the passive with the placeholder as the
// subject ({name} indirilemedi), a generic noun ({model} modelinde, “{title}” başlıklı sohbet,
// “Kaydet” düğmesine), a label and colon (Model: {model}) or ile / için / adlı.
//
// Glossary — keep terms consistent across ALL Turkish copy:
//   workspace                  → çalışma alanı
//   drive / disk               → sürücü (a graphics driver is always «ekran kartı sürücüsü»)
//   vault / encrypted workspace→ şifreli çalışma alanı
//   model                      → model (AI model → yapay zekâ modeli; zekâ with â, never YZ/AI)
//   document                   → belge (never doküman)
//   re-index                   → yeniden dizinle
//   offline                    → çevrimdışı (one word)
//   "Ask my documents"         → «Belgelerime sor»
//   lock / unlock              → kilitle / kilidini aç (buttons: Şimdi kilitle, Kilidi aç)
//   password                   → parola (never şifre; the şifre- stem means encryption)
//   settings                   → Ayarlar (reference: Ayarlar ekranında)
//   plaintext (developer) mode → şifrelenmemiş (geliştirici)
//   chat / conversation        → sohbet;  answer → yanıt;  skill → beceri;  token → token
//   knowledge pack             → bilgi paketi;  image → görsel
//   delete / cancel / remove   → sil / İptal / kaldır
//   install / load / download  → kur / yükle / indir
//   check / verify (checksum)  → kontrol et / doğrula (incele- belongs to the review surface)
//
// Evidence-review glossary (MIRROR of the canonical record in design-guidelines §7; change BOTH
// together):
//   evidence                   → dayanak / dayanaklar — never kanıt, delil
//   review (the artifact)      → inceleme (evidence review → dayanak incelemesi)
//   review item                → inceleme maddesi
//   evidence pack              → dayanak paketi
//   citation / source marker   → kaynak atfı (never alıntı, referans)
//   whole-document provenance  → belgenin tamamının analizine dayanan köken; the negation is
//                                always «cümle düzeyinde kaynak atfı yok»
//   direct excerpt             → doğrudan alıntı
//   source / source document   → kaynak / kaynak belge
//   reviewer                   → İnceleyen (label) / inceleyen kişi (prose)
//   mark ready / reopen        → Hazır olarak işaretle / İncelemeyi yeniden aç
//   outdated                   → güncel değil
//   review creation            → the review is «başlatıldı», the ANSWER is «oluşturuldu» — never
//                                mixed
//   supported-ness             → «dayanağı var / kısmen dayanağı var / dayanağı yok»;
//                                «kanıtlamak» only in negated disclaimers

export const tr: UiCatalog<'tr'> = {
  // ---- App shell (App.tsx) ----
  'nav.aria': 'Ana gezinti',
  'nav.home': 'Ana sayfa',
  'nav.chat': 'Sohbet',
  'nav.documents': 'Belgeler',
  'nav.translate': 'Çeviri',
  'nav.images': 'Görseller',
  'nav.models': 'Yapay zekâ modeli',
  'nav.performance': 'Performans',
  'nav.settings': 'Ayarlar',
  'app.lockNow': 'Şimdi kilitle',
  'app.lockNowTitle': 'Çalışma alanını yeniden şifreler ve kilitler',
  'app.noticeDetails': 'Ayrıntılar',
  'app.noticeGoToModels': 'Yapay zekâ modeli ekranına git',
  'app.fatal.title': 'Uygulama başlatılamadı',
  'app.fatal.hintBefore':
    'Yerel arka uç hizmeti başlamadı, bu yüzden hiçbir şey yüklenemiyor. Uygulamayı yeniden ' +
    'başlatın; sorun sürerse sürücünüzdeki ',
  'app.fatal.hintAfter': ' dosyasına ve docs/troubleshooting.md belgesine bakın.',
  'app.loadingWorkspace': 'Çalışma alanı yükleniyor…',
  'app.loadingScreen': 'Yükleniyor…',
  // ---- Error boundary (ErrorBoundary.tsx — audit FE-1) ----
  'errorBoundary.title': 'Bu ekranda bir sorun oluştu',
  'errorBoundary.body':
    'Bu ekran beklenmedik bir sorunla karşılaştı. Çalışmalarınız ve verileriniz güvende: hiçbir ' +
    'şey kaybolmadı. Yeniden deneyin veya Ana sayfaya dönün.',
  'errorBoundary.retry': 'Yeniden dene',
  'errorBoundary.home': 'Ana sayfaya git',
  'errorBoundary.app.title': 'Uygulama bir sorunla karşılaştı',
  'errorBoundary.app.body':
    'Beklenmedik bir şey oldu. Sürücüdeki verileriniz güvende. Devam etmek için yeniden yükleyin.',
  'errorBoundary.app.reload': 'Yeniden yükle',
  // ---- Home (HomeScreen.tsx) ----
  'home.headline.ready': 'Sohbete hazır.',
  'home.headline.starting': 'Hazırlanıyor…',
  'home.headline.almost': 'Kurulum neredeyse tamam.',
  'home.lead':
    'Özel ve çevrimdışı bir yapay zekâ çalışma alanı. Sorularınız, belgeleriniz ve sohbet ' +
    'geçmişiniz bu cihazda kalır.',
  'home.preflight.continue':
    'Yine de devam edebilirsiniz. Uygulama açılmazsa sürücüdeki {folder} klasöründe bulunan ' +
    'sorun giderme kılavuzuna bakın.',
  'home.moved.restored':
    'Bu sürücü en son farklı bir bilgisayarda kullanıldı. Bu bilgisayarın değerleri daha önceki ' +
    'bir kontrolden ({when}) geliyor; az önce hiçbir şey ölçülmedi.',
  'home.moved.restoredUndated':
    'Bu sürücü en son farklı bir bilgisayarda kullanıldı. Bu bilgisayarın değerleri daha önceki ' +
    'bir kontrolden geliyor; az önce hiçbir şey ölçülmedi.',
  'home.moved.measuring':
    'Bu sürücü daha önce bu bilgisayarda kullanılmadı. Arka planda bir kontrol çalışıyor; ' +
    'kontrol bitince Performans ekranı değerleri gösterir.',
  'home.moved.owed':
    'Bu sürücü bu bilgisayarda henüz kontrol edilmedi, bu yüzden bu bilgisayar için değer yok.',
  'home.checking': 'Kontrol ediliyor…',
  'home.workspace.label': 'Çalışma alanı',
  'home.workspace.encrypted': 'Şifreli – uygulama kapalıyken parolanızla kilitli',
  'home.workspace.plaintext': 'Şifrelenmemiş (geliştirici modu)',
  'home.workspace.badgeProtected': 'Korumalı',
  'home.workspace.badgeDeveloper': 'Geliştirici',
  'home.model.label': 'Yapay zekâ modeli',
  'home.model.fallbackName': 'Modeliniz',
  'home.model.running': '{model} bu cihazda çalışıyor',
  'home.model.selected': '{model} seçili; hâlâ yükleniyor olabilir',
  'home.model.none': 'Henüz model seçilmedi',
  'home.model.badgeRunning': 'Çalışıyor',
  'home.model.badgeStarting': 'Başlıyor',
  'home.model.badgeNeedsModel': 'Model gerekli',
  'home.model.open': 'Yapay zekâ modeli ekranına git',
  'home.model.engineCannotRun':
    'Yapay zekâ motoru bu bilgisayarda çalışamıyor; yanıtlar simüle ediliyor',
  'home.model.badgeEngine': 'Çalışamıyor',
  'home.model.demo': '{model} demo modunda çalışıyor; yanıtlar simüle ediliyor',
  'home.model.badgeDemo': 'Demo modu',
  'home.model.choose': 'Model seç',
  'home.docs.label': 'Belgeler',
  'home.docs.none': 'Henüz belge yok; soru sorabilmek için belge ekleyin',
  'home.docsReady.one': '{count} belge sorularınıza hazır',
  'home.docsReady.other': '{count} belge sorularınıza hazır',
  'home.docs.badgeReady': 'Hazır',
  'home.docs.badgeNone': 'Henüz yok',
  'home.docs.add': 'Belge ekle',
  'home.packs.label': 'Bilgi paketleri',
  'home.packsReady.one': '{count} bilgi paketi sorularınıza hazır',
  'home.packsReady.other': '{count} bilgi paketi sorularınıza hazır',
  'home.packs.none':
    'Henüz bilgi paketi yok; genel sorular sormak için çevrimdışı bir Wikipedia ekleyin',
  'home.packs.noneReady':
    'Sorularınıza hazır bilgi paketi yok; paketleri Belgeler ekranında kontrol edin',
  'home.packs.badgeNoneReady': 'Hazır olan yok',
  'home.packs.add': 'Paket ekle',
  'home.packs.open': 'Bilgi paketlerini aç',
  'home.actions.startChat': 'Sohbete başla',
  'home.actions.askDocs': 'Belgelerime sor',
  // ---- Chat (ChatScreen.tsx) ----
  'chat.title': 'Sohbet',
  'chat.noModel.title': 'Çalışan bir model yok',
  'chat.noModel.startingTitle': 'Yapay zekâ modeli başlatılıyor',
  'chat.noModel.hintBefore':
    'Sohbet etmek ve belgelere soru sormak için yüklü bir model gerekir. Yapay zekâ modeli ' +
    'ekranını açın, indirilmiş bir model seçin ve ',
  'chat.noModel.hintAction': 'Bu modeli kullan',
  'chat.noModel.hintAfter':
    ' düğmesine tıklayın. Her şey yerelde kalır: hiçbir şey indirilmez veya internet üzerinden ' +
    'gönderilmez.',
  'chat.noModel.stillLoading':
    'Uygulamayı yeni açtıysanız seçtiğiniz model hâlâ yükleniyor olabilir; model hazır olduğunda ' +
    'bu ekran kendiliğinden devam eder.',
  'chat.noModel.starting':
    'Modeliniz başlatılıyor; büyük modellerin yüklenmesi biraz zaman alır. Model hazır olduğunda ' +
    'bu ekran kendiliğinden devam eder.',
  'chat.noModel.startingProgress':
    'Modeliniz başlatılıyor: model dosyası okunuyor ({gb}\u00A0GB), şu ana kadar yaklaşık %{pct}. ' +
    'Model hazır olduğunda bu ekran kendiliğinden devam eder.',
  'chat.noModel.open': 'Yapay zekâ modeli ekranına git',
  'chat.noModel.recheck': 'Yeniden kontrol et',
  'chat.empty.title': 'Bir soru sorun ya da belgelerinize sorun.',
  'chat.empty.lineDocuments': 'Yanıtlar belgelerinizden gelir ve kaynaklarını gösterir.',
  'chat.empty.lineChat':
    'Yanıtlar bu sürücüdeki modelden gelir; hiçbir şey bu cihazdan dışarı çıkmaz.',
  'chat.empty.fillTitle': 'Mesaj kutusunu doldurur',
  'chat.empty.addDocs': 'Soru sormak için belge ekle',
  'chat.exampleChat.explain': 'Bir kavramı basit bir dille açıkla',
  'chat.exampleChat.draftEmail': 'Kibar bir e-posta yazmama yardım et',
  'chat.exampleChat.brainstorm': 'Bir proje için fikirler üret',
  'chat.example.summarize': 'Bu belgeyi özetle',
  'chat.example.paymentTerms': 'Ödeme koşulları neler?',
  'chat.example.indemnity': '“tazminat” sözcüğünün geçtiği her yeri bul',
  'chat.modeAria': 'Sohbet modu',
  'chat.mode.chat': 'Sohbet',
  'chat.mode.documents': 'Belgelerime sor',
  'chat.listShow': 'Sohbet listesini göster',
  'chat.runtime.gpu': '{model} · GPU ({name})',
  'chat.runtime.cpu': '{model} · CPU',
  'chat.runtime.cpuCompat': '{model} · CPU (uyumluluk modu)',
  'chat.runtime.demo': '{model} · demo modu',
  'chat.runtime.title':
    'Bu sohbette yanıt veren yapay zekâ modeli ve modelin ekran kartında (GPU) mı yoksa ' +
    'işlemcide (CPU) mi çalıştığı. Ayrıntılar: Ayarlar → Tanılama.',
  'chat.runtime.compatTitle':
    'Kararlılık için uyumluluk modu açık; bu yüzden yanıtlar işlemcide çalışır ve daha yavaş ' +
    'olabilir. Ekran kartını Ayarlar → Tanılama sekmesinde yeniden deneyebilirsiniz.',
  'chat.convOptions': 'Sohbet seçenekleri',
  'chat.saveConversation': 'Sohbeti kaydet',
  'chat.savedTo': 'Kaydedildi: {path}',
  'chat.copied': 'Kopyalandı',
  'chat.copyFailed': 'Panoya kopyalanamadı',
  'chat.transcript.label': 'Sohbet metni',
  'chat.stopped': 'Durduruldu – yanıt eksik olabilir',
  'chat.warmup.hint':
    'İlk yanıt biraz daha uzun sürer: model ısınıyor. Sonraki yanıtlar daha hızlı olur.',
  'chat.scopeNotice': 'Yalnızca şunlardan yanıt veriliyor: {titles}',
  'chat.cancelDocTask': 'Belge görevini iptal et',
  'chat.placeholder.documents': 'Belgeleriniz hakkında soru sorun…',
  'chat.placeholder.chat': 'Mesaj…',
  'chat.send.ask': 'Sor',
  'chat.send.send': 'Gönder',
  'chat.composer.stop': 'Durdur',
  // ---- Chat: conversation list (ConversationList.tsx) ----
  'chat.list.title': 'Sohbetler',
  'chat.list.aria': 'Sohbet geçmişi',
  'chat.list.newChat': '+ Yeni sohbet',
  'chat.list.newDocQa': '+ Yeni belge sohbeti',
  'chat.list.hide': 'Sohbet listesini gizle',
  'chat.list.empty': 'Henüz sohbet yok.',
  'chat.list.docMeta': 'Belgeler',
  'chat.list.otherGroup': 'Diğer / Kitaplık',
  'chat.list.rowOptionsAria': 'Sohbet seçenekleri: “{title}”',
  'chat.search.placeholder': 'Sohbetlerde ara…',
  'chat.search.aria': 'Sohbetlerde ara',
  'chat.search.resultsAria': 'Arama sonuçları',
  'chat.search.resultsFor': '“{query}” için sonuçlar',
  'chat.search.noMatches': 'Eşleşme bulamadım. Farklı bir ifadeyle deneyin.',
  'chat.search.count.one': '{count} sonuç',
  'chat.search.count.other': '{count} sonuç',
  'chat.group.today': 'Bugün',
  'chat.group.yesterday': 'Dün',
  'chat.group.last7days': 'Son 7 gün',
  'chat.group.earlier': 'Daha önce',
  'chat.delete.menuItem': 'Sohbeti sil',
  'chat.delete.title': 'Bu sohbet silinsin mi?',
  'chat.delete.confirm': 'Sohbeti sil',
  'chat.delete.body': '“{title}” ve mesajları bu sürücüden kalıcı olarak kaldırılacak.',
  // ---- Chat: answer depth (DepthMenu.tsx; ids stay fast|balanced|deep) ----
  'chat.depth.trigger': 'Yanıt ayrıntısı: {label}',
  'chat.depth.fast': 'Hızlı',
  'chat.depth.balanced': 'Dengeli',
  'chat.depth.deep': 'Ayrıntılı',
  'chat.depth.fastHint': 'Kısa ve öz yanıtlar',
  'chat.depth.balancedHint': 'Günlük kullanım için varsayılan',
  'chat.depth.deepHint': 'Yanıt vermeden önce sorunu enine boyuna düşünür; daha uzun sürer',
  // ---- Chat: skill picker + per-message glyph (skills plan §10/§15) ----
  'chat.skill.trigger': 'Beceri: {label}',
  'chat.skill.none': 'Beceri yok',
  'chat.skill.suggested': 'Önerilen: {title} – kullanılsın mı?',
  'chat.skill.suggestedHint': 'Önerilen: {title}',
  'chat.skill.used': 'Beceri: {title}',
  'chat.skill.usedTitle': 'Bu yanıt “{title}” becerisiyle biçimlendirildi.',
  'chat.skill.autoFired': '{title} ile yanıtlandı',
  'chat.skill.autoFiredTitle':
    'Uygulama “{title}” becerisini bu yanıta otomatik olarak uyguladı. Yanıtı beceri olmadan ' +
    'yeniden alabilirsiniz.',
  'chat.skill.answerWithout': 'Beceri olmadan yanıtla',
  'chat.skill.answerWithoutBlockedByReview':
    'Bu yanıtın bir dayanak incelemesi var. Yeniden yanıtlamak, incelemeyi kararları ve ' +
    'notlarıyla birlikte siler.',
  'chat.skill.removed': '(kaldırılmış beceri)',
  'chat.skill.offer.lead': 'Bu iş bir beceriye uygun görünüyor.',
  'chat.skill.offer.run': 'Bu soru için “{title}” becerisini çalıştır',
  'chat.skill.offer.model': 'Yerel model tarafından önerildi',
  'chat.skill.offer.unavailable':
    'Bu beceri devre dışı veya kaldırılmış. Çalıştırmak için Ayarlar ekranının Beceriler ' +
    'sekmesinde etkinleştirin.',
  'chat.skill.clear': 'Beceri seçimini temizle: {title}',
  'chat.skill.keep': 'Bu sohbet için sakla',
  'chat.skill.infoButton': '“{title}” hakkında',
  'chat.skill.info.close': 'Bu açıklamayı gizle',
  'chat.skill.info.needsLabel': 'Gerekenler:',
  'chat.skill.info.limitsLabel': 'Unutmayın:',
  'chat.skill.info.perTurn':
    'Siz değiştirene veya temizleyene kadar bu sohbetteki sorularınıza uygulanır; “Bu sohbet ' +
    'için sakla” seçeneği beceriyi daha sonrası için de kaydeder.',
  'chat.skill.info.learnMore': 'Daha fazla bilgi',
  'chat.skill.tool.extractTransactions': 'İşlemleri çıkar',
  'chat.skill.tool.validateBalances': 'Bakiyeleri kontrol et',
  'chat.skill.tool.categorize': 'Kategorilere ayır',
  'chat.skill.tool.summarize': 'Nakit akışını özetle',
  'chat.skill.tool.exportCsv': 'CSV olarak dışa aktar',
  'chat.skill.tool.extractInvoice': 'Fatura bilgilerini çıkar',
  'chat.skill.tool.validateInvoiceTotals': 'Toplamları kontrol et',
  'chat.skill.tool.exportInvoiceCsv': 'CSV olarak dışa aktar',
  'chat.skill.tool.exportInvoiceJson': 'JSON olarak dışa aktar',
  'chat.skill.tool.exportInvoiceXml': 'XML olarak dışa aktar',
  'chat.skill.tool.redactDocument': 'Kişisel verileri karart',
  'chat.skill.tool.applyDocumentEdits': 'Metin değişikliklerini uygula',
  'chat.skill.categorize.breakdownQuestion': 'Harcamalarımı kategorilere göre ayır.',
  'chat.skill.summarize.question': 'Gelirlerimi ve giderlerimi özetle.',
  'chat.skill.run.running.one': 'Çalışıyor: {tool} ({count} belge)…',
  'chat.skill.run.running.other': 'Çalışıyor: {tool} ({count} belge)…',
  'chat.skill.run.runningOn': 'Çalışıyor: {tool} ({document})…',
  'chat.skill.run.chooseDocument': 'Hedef belgeyi seç',
  'chat.skill.run.thisDocument': 'bu belge',
  'chat.skill.run.cancel': 'İptal',
  'chat.skill.run.done.one': '{count} işlem çıkarıldı.',
  'chat.skill.run.done.other': '{count} işlem çıkarıldı.',
  'chat.skill.run.done.categorize.one': '{count} işlem kategorilere ayrıldı.',
  'chat.skill.run.done.categorize.other': '{count} işlem kategorilere ayrıldı.',
  'chat.skill.run.done.summarize.one': '{count} işlem özetlendi.',
  'chat.skill.run.done.summarize.other': '{count} işlem özetlendi.',
  'chat.skill.run.done.export.one': '{count} satır kaydedildi.',
  'chat.skill.run.done.export.other': '{count} satır kaydedildi.',
  'chat.skill.run.done.reconciled': 'Bakiyeler tutuyor.',
  'chat.skill.run.done.unreconciled.one': '{count} satır tutmuyor; güvenmeden önce kontrol edin.',
  'chat.skill.run.done.unreconciled.other': '{count} satır tutmuyor; güvenmeden önce kontrol edin.',
  'chat.skill.run.done.unchecked': 'Karşılaştırma için hesap özetinde basılı bir bakiye yoktu.',
  'chat.skill.run.done.extractInvoice.one': '{count} fatura kalemi çıkarıldı.',
  'chat.skill.run.done.extractInvoice.other': '{count} fatura kalemi çıkarıldı.',
  'chat.skill.run.done.invoiceReconciled': 'Fatura toplamları tutuyor.',
  'chat.skill.run.done.invoiceUnreconciled.one':
    '{count} toplam tutmuyor; güvenmeden önce kontrol edin.',
  'chat.skill.run.done.invoiceUnreconciled.other':
    '{count} toplam tutmuyor; güvenmeden önce kontrol edin.',
  'chat.skill.run.done.invoiceUnchecked': 'Karşılaştırma için faturada basılı bir toplam yoktu.',
  'chat.skill.run.done.redacted.one':
    'Karartılmış bir kopya kaydedildi; {count} öğe gizlendi. Algılama elden geldiğince yapılır, ' +
    'garanti değildir: paylaşmadan önce kopyayı gözden geçirin.',
  'chat.skill.run.done.redacted.other':
    'Karartılmış bir kopya kaydedildi; {count} öğe gizlendi. Algılama elden geldiğince yapılır, ' +
    'garanti değildir: paylaşmadan önce kopyayı gözden geçirin.',
  'chat.skill.run.done.redactedClean':
    'Kişisel veri algılanmadı; bir kopya kaydedildi. Algılama elden geldiğince yapılır, garanti ' +
    'değildir: paylaşmadan önce kopyayı gözden geçirin.',
  'chat.skill.run.done.redactedFloor.one':
    'Karartılmış bir kopya kaydedildi; {count} öğe gizlendi (yalnızca çevrimdışı, kurala dayalı ' +
    'algılama; çalışan model yok). Paylaşmadan önce kopyayı gözden geçirin.',
  'chat.skill.run.done.redactedFloor.other':
    'Karartılmış bir kopya kaydedildi; {count} öğe gizlendi (yalnızca çevrimdışı, kurala dayalı ' +
    'algılama; çalışan model yok). Paylaşmadan önce kopyayı gözden geçirin.',
  'chat.skill.run.done.redactedCleanFloor':
    'Kişisel veri algılanmadı (yalnızca çevrimdışı, kurala dayalı algılama; çalışan model yok); ' +
    'bir kopya kaydedildi. Paylaşmadan önce kopyayı gözden geçirin.',
  'chat.skill.run.done.redactedCapped.one':
    'Karartılmış bir kopya kaydedildi; {count} öğe gizlendi. Bu belge çok büyük olduğu için ' +
    'otomatik algılama sınırına ulaşınca durdu ve sonraki öğeler karartılmamış olabilir: ' +
    'paylaşmadan önce kopyanın tamamını gözden geçirin.',
  'chat.skill.run.done.redactedCapped.other':
    'Karartılmış bir kopya kaydedildi; {count} öğe gizlendi. Bu belge çok büyük olduğu için ' +
    'otomatik algılama sınırına ulaşınca durdu ve sonraki öğeler karartılmamış olabilir: ' +
    'paylaşmadan önce kopyanın tamamını gözden geçirin.',
  'chat.skill.run.done.edited.one':
    '{count} değişiklik uygulandı ve düzenlenmiş bir kopya kaydedildi. Paylaşmadan önce kopyayı ' +
    'gözden geçirin.',
  'chat.skill.run.done.edited.other':
    '{count} değişiklik uygulandı ve düzenlenmiş bir kopya kaydedildi. Paylaşmadan önce kopyayı ' +
    'gözden geçirin.',
  'chat.skill.run.done.editedPartial.one':
    '{count} değişiklik uygulandı; istenen metnin bir kısmı bulunamadı ve atlandı. Düzenlenmiş ' +
    'bir kopya kaydedildi: paylaşmadan önce kopyayı gözden geçirin.',
  'chat.skill.run.done.editedPartial.other':
    '{count} değişiklik uygulandı; istenen metnin bir kısmı bulunamadı ve atlandı. Düzenlenmiş ' +
    'bir kopya kaydedildi: paylaşmadan önce kopyayı gözden geçirin.',
  'chat.skill.run.done.editedNone':
    'İstenen metinlerin hiçbiri bulunamadı: hiçbir şey değiştirilmedi ve kopya kaydedilmedi.',
  'chat.skill.run.done.editedCapped.one':
    '{count} değişiklik uygulandı. Bu belge çok büyük olduğu için değiştirilecek yerlerin ' +
    'aranması sınırına ulaşınca durdu: kopyayı gözden geçirin; sonraki yerler değiştirilmemiş ' +
    'olabilir.',
  'chat.skill.run.done.editedCapped.other':
    '{count} değişiklik uygulandı. Bu belge çok büyük olduğu için değiştirilecek yerlerin ' +
    'aranması sınırına ulaşınca durdu: kopyayı gözden geçirin; sonraki yerler değiştirilmemiş ' +
    'olabilir.',
  'chat.skill.run.failedGeneric': 'Bu işlem tamamlanamadı. Hiçbir şey değiştirilmedi.',
  'chat.skill.run.error.unavailable': 'Bu araç kullanılamıyor.',
  'chat.skill.run.error.needsExtraction':
    'Önce belgeyi “{button}” düğmesiyle okuyun, ardından bu aracı çalıştırın.',
  'chat.skill.run.error.persistFailed': 'Bu kaydedilemedi. Hiçbir şey değiştirilmedi.',
  'chat.skill.run.error.exportWriteFailed': 'Dosya kaydedilemedi. Hiçbir şey değiştirilmedi.',
  'chat.skill.run.error.needsModel':
    'Önce bir model başlatın: hedefli düzenlemeler, değiştirilecek metni bulmak için çalışan bir ' +
    'model gerektirir.',
  'chat.skill.run.error.needsInstruction':
    'Önce neyin değişeceğini yazın (örneğin “X yerine Y yaz”), ardından bunu yeniden çalıştırın.',
  'chat.skill.run.error.editFailed': 'Düzenlemeler tamamlanamadı. Hiçbir şey değiştirilmedi.',
  'chat.skill.run.error.redactionModelStopped':
    'Yapay zekâ modeli karartma bitmeden durdu. Hiçbir şey kaydedilmedi. Karartmayı yeniden ' +
    'çalıştırın; bu sürekli oluyorsa Yapay zekâ modeli ekranında modeli yeniden başlatın.',
  'chat.skill.run.error.redactionTooLong':
    'Bu belgenin bazı kısımları geçerli modelin bağlam penceresi için fazla uzun. Hiçbir şey ' +
    'kaydedilmedi. Yapay zekâ modeli ekranında daha büyük bir bağlam boyutu seçip modeli yeniden ' +
    'başlatın, ardından karartmayı yeniden çalıştırın.',
  'chat.skill.run.cancelled': 'Durduruldu. Hiçbir şey kaydedilmedi.',
  'chat.skill.run.stateUnknown': 'Bu becerinin durumu kontrol edilemedi; sonucu eksik olabilir.',
  'chat.skill.run.otherChatBusy': 'Başka bir sohbette bir beceri çalışıyor.',
  'chat.skill.run.categorizeOffer': 'İşlemleri kategorilere ayır',
  'chat.skill.run.dismiss': 'Kapat',
  'chat.skill.confirm.title': 'Bu araç çalıştırılsın mı?',
  'chat.skill.confirm.body':
    'Bu işlem, bu sürücüdeki belgelerden bir dosya oluşturur veya dışa aktarır.',
  'chat.skill.confirm.target': 'Belge: {document}',
  'chat.skill.confirm.outputDocx': 'Kaydedilen kopya bu belgenin Word biçimini (.docx) korur.',
  'chat.skill.confirm.redactionScope':
    'Karartma, belgenin metnini (üst bilgiler, alt bilgiler, dipnotlar, açıklamalar ve izlenen ' +
    'değişiklikler dahil) kapsar; yazar meta verilerini ve bağlantı hedeflerini de temizler. ' +
    'Görseller, taranmış sayfalar ve gömülü nesneler kontrol edilmez: paylaşmadan önce ' +
    'kaydedilen kopyayı gözden geçirin.',
  'chat.skill.confirm.outputText':
    'Kaydedilen kopya bir metin dosyası (.txt) olacak; özgün düzen ve biçimlendirme korunmaz.',
  'chat.skill.confirm.outputMatrix':
    'Word belgeleri (.docx) biçimini korur; PDF dosyaları ve diğer biçimler metin dosyası (.txt) ' +
    'olarak kaydedilir.',
  'chat.skill.confirm.ok': 'Aracı çalıştır',
  // ---- Chat: transcript + message actions ----
  'chat.role.user': 'Siz',
  'chat.role.assistant': 'HilbertRaum',
  'chat.thinking': 'Düşünüyor…',
  'chat.actions.tryAgain': 'Yeniden dene',
  'chat.actions.sendAgain': 'Yeniden gönder',
  'chat.actions.copy': 'Kopyala',
  'chat.actions.save': 'Kaydet',
  'chat.actions.saveTitle': 'Bu sohbeti bir dosya olarak kaydeder (yerelde kalır)',
  'chat.actions.exportCsv': 'CSV olarak dışa aktar',
  'chat.actions.exportCsvTitle': 'Bu yanıttaki tabloyu CSV dosyası olarak kaydeder (yerelde kalır)',
  'chat.code.copy': 'Kopyala',
  'chat.code.copyTitle': 'Bu kod bloğunu panoya kopyalar',
  'chat.code.save': 'Kaydet',
  'chat.code.saveTitle': 'Bu kod bloğunu .{ext} dosyası olarak kaydeder (yerelde kalır)',
  // ---- Chat: context compaction (context-compaction plan §5.1–§5.3) ----
  'chat.compaction.inProgress': 'Bağlamda yer açmak için önceki mesajlar özetleniyor…',
  'chat.analysis.inProgress': 'Belgenin tamamı okunuyor…',
  'chat.compaction.markerLabel': 'Önceki mesajlar özetlendi',
  'chat.compaction.viewSummary': 'Önceki mesajların özetini göster',
  'chat.context.label': 'Bellek',
  'chat.context.usageTooltip':
    'Bu sohbetin belleği: %{pct} dolu (yaklaşık {used} / {window} token).',
  'chat.context.willSummarize':
    'Bellek dolduğunda yer açmak için eski mesajlar otomatik olarak özetlenir.',
  'chat.truncated.label': 'Yanıt kesildi',
  'chat.endedEarly.label': 'Yanıt yarıda kaldı',
  'chat.endedEarly.hint.model':
    'Bu yanıt tamamlanmadan önce yapay zekâ modeli durduruldu veya değiştirildi.',
  'chat.endedEarly.hint.user': 'Bu yanıtı tamamlanmadan durdurdunuz.',
  'chat.endedEarly.hint.lock':
    'Bu yanıt tamamlanmadan önce çalışma alanı kilitlendi veya uygulama kapatıldı.',
  'chat.unanswered.model': 'Yanıtlanmadı: yapay zekâ modeli durduruldu.',
  'chat.unanswered.user': 'Yanıtlanmadı: yanıtı siz durdurdunuz.',
  'chat.unanswered.lock': 'Yanıtlanmadı: çalışma alanı kilitlendi veya uygulama kapatıldı.',
  'chat.truncated.hint.context':
    'Modelin bu yanıtı bitirmek için yeri kalmadı. Modelden devam etmesini isteyin, yeni bir ' +
    'sohbet başlatın veya Yapay zekâ modeli ekranında bağlam boyutunu artırın.',
  'chat.truncated.hint.cap':
    'Belgelere dayalı bu yanıt, uygulamanın tek bir yanıt için izin verdiği sabit uzunluğa ' +
    'ulaştı. Modelden kaldığı yerden devam etmesini isteyin.',
  'chat.speed.line': '{tps}\u00A0tok/s · ilk token: {ttft}\u00A0s · {tokens} token',
  'chat.speed.hint':
    'Bu yanıtın ne kadar hızlı oluşturulduğu: yapay zekâ motorunun üretim hızı, ilk sözcüğe ' +
    'kadar geçen bekleme süresi ve üretilen token sayısı. Yalnızca bu oturumdaki yanıtlar için ' +
    'gösterilir.',
  // ---- Chat: document scope (ScopePopover.tsx) ----
  'chat.scope.none': 'Henüz belge yok · Belge ekle',
  'chat.scope.stopAsking': 'Sormayı bırak: {title}',
  'chat.scope.askToo': 'Ayrıca sor: {title}',
  'chat.scope.removedDoc': 'Kaldırılmış belge',
  // ---- Chat: sources (SourcesDisclosure.tsx) ----
  'chat.sources.toggle': 'Kaynaklar ({count})',
  'chat.sources.marker': 'K{n}',
  'chat.sources.page': 'Sayfa {page}',
  'chat.sources.wholeDoc.one': 'Belgenin {count} bölümünden yararlanıldı',
  'chat.sources.wholeDoc.other': 'Belgenin {count} bölümünden yararlanıldı',
  'chat.sources.wholeDocCaption': 'Kapsanan bölümler',
  'chat.sources.more.one': 've {count} bölüm daha',
  'chat.sources.more.other': 've {count} bölüm daha',
  // ---- Chat: dictation (DictationButton.tsx) ----
  'chat.dictation.start': 'Mesaj dikte et',
  'chat.dictation.unavailable': 'Sesle dikte bu sürücüde kurulu değil',
  'chat.dictation.unavailableSystem': 'Sesle dikte bu işletim sisteminde kullanılamıyor',
  'chat.dictation.needsModel':
    'Mesaj dikte etmek için konuşma modeli gerekir; bu model bu sürücüde kurulu değil. Modeli ' +
    'Yapay zekâ modeli ekranında ekleyebilirsiniz.',
  'chat.dictation.needsEngine':
    'Mesaj dikte etmek için ses motoru gerekir; ses motoru bu sürücüde kurulu değil. Motoru ' +
    'Yapay zekâ modeli ekranında kurabilirsiniz.',
  'chat.dictation.needsModelAndEngine':
    'Mesaj dikte etmek için konuşma modeli ve ses motoru gerekir; bunlar henüz bu sürücüde yok. ' +
    'İkisini de Yapay zekâ modeli ekranında ekleyebilirsiniz.',
  'chat.dictation.engineUnsupported':
    'Sesle dikte bu işletim sisteminde henüz kullanılamıyor: uygulama, gereken ses motorunu ' +
    'burada kuramıyor.',
  'chat.dictation.getModel': 'Konuşma modelini indir',
  'chat.dictation.getEngine': 'Ses motorunu kur',
  'chat.dictation.setUp': 'Sesle dikteyi kur',
  'chat.dictation.stop': 'Dikteyi durdur ve metni ekle',
  'chat.dictation.transcribing': 'Konuşmanız metne dönüştürülüyor',
  'chat.dictation.noSpeech': 'Konuşma algılanmadı; yeniden konuşmayı deneyin.',
  'chat.dictation.silent':
    'Mikrofona ses ulaşmadı. Mikrofonun sessize alınmadığını ve sistem ayarlarında HilbertRaum ' +
    'için mikrofon izninin verildiğini kontrol edin, ardından yeniden deneyin.',
  'chat.dictation.noSignal':
    'Mikrofona ses ulaşmıyor: mikrofonun sessize alınmadığını ve doğru giriş cihazının ' +
    'seçildiğini kontrol edin.',
  'chat.dictation.micBlocked':
    'Mikrofon kullanılamadı. Sistemin mikrofon ayarlarını kontrol edin, ardından yeniden deneyin.',
  // ---- Documents (DocumentsScreen.tsx) ----
  'docs.title': 'Belgeler',
  'docs.lead':
    'Soru sormak istediğiniz belgeleri içe aktarın. Her dosya çalışma alanınıza kopyalanır ve ' +
    'aramaya hazırlanır; her şey bu sürücüde kalır. Sorularınızı Sohbet ekranındaki “Belgelerime ' +
    'sor” modunda sorun.',
  'docs.status.queued': 'Bekliyor',
  'docs.status.extracting': 'Okunuyor',
  'docs.status.preparing': 'Hazırlanıyor',
  'docs.status.indexed': 'Hazır',
  'docs.status.failed': 'Başarısız',
  'docs.status.deleted': 'Silindi',
  'docs.status.transcribing': 'Yazıya dökülüyor…',
  'docs.task.summaryBusy': 'Özetleniyor…',
  'docs.task.translationBusy': 'Çevriliyor…',
  'docs.task.compareBusy': 'Karşılaştırılıyor…',
  'docs.task.ocrBusy': 'Tarama okunuyor…',
  'docs.task.treeBusy': 'Derin dizin oluşturuluyor…',
  'docs.task.extractBusy': 'Ayrıntılar aranıyor…',
  'docs.task.summaryBusyTitle': 'Özet yazılıyor',
  'docs.task.translationBusyTitle': 'Çeviri yazılıyor',
  'docs.task.compareBusyTitle': 'Karşılaştırma yazılıyor',
  'docs.task.ocrBusyTitle': 'Taranmış sayfalar okunuyor',
  'docs.task.treeBusyTitle': 'Belgenin tamamı için derin dizin oluşturuluyor',
  'docs.task.extractBusyTitle':
    'Belgenin tamamı taranıyor; böylece “Tümünü listele…” gibi sorular yanıtlanabilir',
  'docs.task.categorizeBusy': 'İşlemler kategorilere ayrılıyor…',
  'docs.task.categorizeBusyTitle': 'Hesap özetindeki işlemler kategorilere ayrılıyor',
  'docs.task.ocrFinishing': 'Tamamlanıyor: metin aranabilir yapılıyor…',
  'docs.task.stopping': 'Mümkünse durduruluyor…',
  'docs.error.noSupported': 'Bu seçimde desteklenen bir belge bulunamadı.',
  'docs.removedDocFallback': 'kaldırılmış bir belge',
  'docs.provenance.compareBefore': 'Karşılaştırılan belgeler: ',
  'docs.provenance.compareMiddle': ' ve ',
  'docs.provenance.translatedBefore': 'Çevirinin kaynağı: ',
  'docs.provenance.summaryBefore': 'Özeti çıkarılan belge: ',
  'docs.provenance.generatedBefore': 'Şu belgeden oluşturuldu: ',
  'docs.provenance.articleBefore': 'Bilgi paketinden kaydedildi: ',
  'docs.provenance.articleUnknownArchive': 'adı bilinmeyen bir paket',
  'docs.import.busy': 'İçe aktarılıyor…',
  'docs.import.files': 'Dosya içe aktar',
  'docs.import.folder': 'Klasör içe aktar',
  'docs.import.walkCut.one': 'Klasör tamamen taranamayacak kadar büyüktü; {count} öğe sayıldı.',
  'docs.import.walkCut.other': 'Klasör tamamen taranamayacak kadar büyüktü; {count} öğe sayıldı.',
  'docs.refresh': 'Yenile',
  'docs.loading': 'Belgeler yükleniyor…',
  'docs.askSelected': 'Bu belgelere sor ({count})',
  'docs.askSelectedTitle': 'Yalnızca seçili belgeleri kapsayan bir soru-yanıt sohbeti açar',
  'docs.compareBtn': 'Karşılaştır (2)',
  'docs.compareBtnTitle':
    'Seçili iki belgenin karşılaştırmasını yerel modelle yazar; hiçbir şey bu sürücüden dışarı ' +
    'çıkmaz',
  'docs.reindexAll': 'Tümünü yeniden dizinle ({count})',
  'docs.reindexAllTitle': 'Farklı bir arama modeliyle dizinlenmiş her belgeyi yeniden dizinler',
  'docs.reindexAllConfirm.title.one': '{count} belge yeniden dizinlensin mi?',
  'docs.reindexAllConfirm.title.other': '{count} belge yeniden dizinlensin mi?',
  'docs.reindexAllConfirm.body':
    'Bu işlem, güncel olmayan her belgeyi tek tek yeniden okur ve gömme vektörlerini yeniden ' +
    'oluşturur. Birkaç dakika sürebilir ve işlemciyi yoğun olarak kullanır. Çalışmaya devam ' +
    'edebilirsiniz, ancak işlem bitene kadar yanıtlar yavaşlayabilir.',
  'docs.reindexAllConfirm.confirm': 'Tümünü yeniden dizinle',
  'docs.retryAllFailed': 'Tümünü yeniden dene ({count})',
  'docs.retryAllFailedTitle': 'Dizinlenemeyen her belgeyi yeniden dizinler',
  'docs.retryAllConfirm.title.one': 'Dizinlenemeyen {count} belge yeniden dizinlensin mi?',
  'docs.retryAllConfirm.title.other': 'Dizinlenemeyen {count} belge yeniden dizinlensin mi?',
  'docs.retryAllConfirm.body':
    'Bu işlem, dizinlenemeyen her belgeyi tek tek yeniden okur ve gömme vektörlerini yeniden ' +
    'oluşturur. Birkaç dakika sürebilir ve işlemciyi yoğun olarak kullanır. Çalışmaya devam ' +
    'edebilirsiniz, ancak işlem bitene kadar yanıtlar yavaşlayabilir. Yine dizinlenemeyen ' +
    'belgeler “Dikkat gerektirenler” bölümünde kalır.',
  'docs.retryAllConfirm.confirm': 'Tümünü yeniden dene',
  'docs.reindexAllProgress': 'Yeniden dizinleniyor: {done} / {total}…',
  'docs.reindexAllCancel': 'İptal',
  'docs.reindexAllCancelled': 'Yeniden dizinleme durduruldu. Tamamlanan: {done} / {total}.',
  'docs.reindexAllDone.one': '{count} belge yeniden dizinlendi.',
  'docs.reindexAllDone.other': '{count} belge yeniden dizinlendi.',
  'docs.reindexAllPartial':
    'Yeniden dizinlenen: {done} / {total}. Tamamlanamayan: {failed}. Tamamlanamayan belgeler ' +
    '“Dikkat gerektirenler” bölümünde kalır.',
  'docs.supported.base':
    'Desteklenen biçimler: TXT, Markdown, PDF, DOCX, CSV; bu sürücüde yazıya dökülen ses ' +
    'kayıtları (WAV, MP3, FLAC, OGG)',
  'docs.supported.ocrExtra': ', ayrıca bu sürücüde okunan sayfa fotoğrafları (PNG, JPG)',
  'docs.preparing': 'Belgeleriniz, soru sorabilmeniz için hazırlanıyor…',
  'docs.empty.title': 'Henüz belge yok',
  'docs.empty.line': 'Soru sormak istediğiniz dosyaları içe aktarın. Her şey bu sürücüde kalır.',
  'docs.selectAria': 'Soru sormak için seç: {title}',
  'docs.selectTitle': 'Yalnızca seçilen belgelere soru sormak için bu belgeyi seçer',
  'docs.selectAllAria': 'Tüm belgeleri seç',
  'docs.selectAllTitle': 'Görünen tüm belgeleri seçer veya seçimi temizler',
  'docs.meta.sectionsCount.one': '{count} bölüm',
  'docs.meta.sectionsCount.other': '{count} bölüm',
  'docs.meta.summary': 'Özet',
  'docs.meta.type.text': 'Metin',
  'docs.meta.type.audio': 'Ses',
  'docs.meta.type.image': 'Görsel',
  'docs.scan.ocrOffer':
    'Sayfaları bu sürücüde okumak için bu satırdaki “Aranabilir yap (OCR)” düğmesini kullanın.',
  'docs.scan.ocrMissing':
    'Aranabilir yapmak için OCR dosyaları gerekir; bu dosyalar bu sürücüde yok. Dosyaları ' +
    'aşağıdan indirin veya sürücüyü kendiniz kurduysanız “fetch-runtime --family ocr” komutuyla ' +
    'ekleyin.',
  'docs.scan.ocrMissingOffline':
    'Aranabilir yapmak için OCR dosyaları gerekir; bu dosyalar bu sürücüde yok. Eklemek için ' +
    'sürücü kurulumunu “--with-assets” seçeneğiyle yeniden çalıştırın veya yalnızca OCR ' +
    'dosyalarını “fetch-runtime --family ocr” komutuyla indirin.',
  'docs.photo.ocrMissing':
    'OCR dosyalarını aşağıdan indirin, ardından bu fotoğrafı okumak için “Yeniden dene” ' +
    'düğmesini kullanın.',
  'docs.photo.ocrMissingOffline':
    'OCR dosyalarını sürücü kurulumuyla (“fetch-runtime --family ocr”) ekleyin, ardından bu ' +
    'fotoğrafı okumak için “Yeniden dene” düğmesini kullanın.',
  'docs.photo.ocrReady':
    'Metin tanıma artık hazır; bu fotoğrafı okumak için “Yeniden dene” düğmesini kullanın.',
  'docs.scan.ocrUnavailable':
    'Aranabilir yapmak için metin tanıma (OCR) gerekir; ancak metin tanıma bu sürümde ' +
    'başlatılamadı.',
  'docs.ocr.unavailableBanner':
    'Metin tanıma (OCR) bu sürümde kullanılamıyor: OCR dosyaları bu sürücüde, ancak tanıma ' +
    'motoru başlatılamadı. Sorun giderilene kadar fotoğraflar okunabilir metin olmadan saklanır ' +
    've taranmış PDF dosyaları aranabilir yapılamaz.',
  'docs.stale.banner':
    'Bu belge farklı bir arama modeliyle hazırlandı; yanıtların onu bulabilmesi için belgeyi ' +
    'yeniden dizinleyin.',
  'docs.preview': 'Önizle',
  'docs.previewBusy': 'Açılıyor…',
  'docs.previewTitle':
    'Çıkarılan metni gösterir (salt okunur; hiçbir şey uygulamadan dışarı çıkmaz)',
  'docs.cancel': 'İptal',
  'docs.cancelOcrTitle': 'Taramanın okunmasını durdurur',
  'docs.cancelTaskTitle': 'Görevi durdurur',
  'docs.task.stateUnknown': 'Bu görevin durumu kontrol edilemedi; hâlâ çalışıyor olabilir.',
  'docs.task.dismiss': 'Kapat',
  'docs.makeSearchable': 'Aranabilir yap (OCR)',
  'docs.makeSearchableTitle':
    'Taranmış sayfaları yerel metin tanımayla okur; hiçbir şey bu sürücüden dışarı çıkmaz',
  'docs.makeSearchableAgain': 'Yeniden oku (OCR)',
  'docs.makeSearchableAgainPhotoTitle': 'Fotoğrafı yerel metin tanımayla yeniden okur',
  'docs.makeSearchableAgainTitle':
    'Yerel metin tanımayı yeniden çalıştırır ve kayıtlı okuma sonucunu yenisiyle değiştirir; ' +
    '“Yeniden dizinle” seçeneği ise kayıtlı sonucu yeniden kullanır',
  'docs.summarize': 'Özetle',
  'docs.summarizeAgain': 'Yeniden özetle',
  'docs.translate': 'Çevir',
  'docs.translateNoModel': 'Çeviri modelini indir…',
  'docs.translateNoModelTitle':
    'Çeviri için çeviri modeli gerekir; modeli Yapay zekâ modeli ekranında indirin',
  'docs.export': 'Dışa aktar',
  'docs.exportOriginal': 'Özgün dosyayı dışa aktar',
  'docs.exportOriginal.gone':
    'Bu dosyanın kayıtlı kopyası bu sürücüde değil; bu yüzden dışa aktarılamaz. Çıkarılan ' +
    'metnini yine de dışa aktarabilirsiniz.',
  'docs.exportOriginalConfirm.title': 'Özgün dosya dışa aktarılsın mı?',
  'docs.exportOriginal.warning':
    'Dışa aktarılan bu dosya, şifreli HilbertRaum çalışma alanının dışında saklanır ve çalışma ' +
    'alanı parolanızla korunmaz.',
  'docs.reindex': 'Yeniden dizinle',
  'docs.reindexBusy': 'Yeniden dizinleniyor…',
  'docs.reindexTitle': 'Kayıtlı kopyayı yeniden okur ve hazırlar',
  'docs.reindexDone': '“{title}” yeniden dizinlendi.',
  'docs.delete': 'Sil',
  'docs.deleteBusy': 'Siliniyor…',
  'docs.deleteDone': '“{title}” silindi.',
  'docs.failed.remove': 'Kaldır',
  'docs.failed.removeTitle': 'İçe aktarılamayan bu belgeyi listeden kaldırır',
  'docs.failed.retry': 'Yeniden dene',
  'docs.failed.lead': 'Bu dosya işlenemedi.',
  'docs.backToChat': 'Sohbete dön',
  'docs.failed.retryTitle': 'Bu dosyayı yeniden okur ve hazırlar',
  'docs.moreActions': 'Diğer işlemler: {title}',
  'docs.audioConfirm.title': 'Büyük ses kayıtları içe aktarılsın mı?',
  'docs.audioConfirm.confirm': 'İçe aktar ve yazıya dök',
  'docs.audioConfirm.contains.one': 'Bu seçimde {count} ses kaydı var ({size}).',
  'docs.audioConfirm.contains.other': 'Bu seçimde {count} ses kaydı var ({size}).',
  'docs.audioConfirm.body':
    'Her kayıt çalışma alanınıza kopyalanır ve bu sürücüde yazıya dökülür; uzun bir kayıt biraz ' +
    'zaman alabilir. Bu sırada uygulamayı kullanmaya devam edebilirsiniz.',
  'docs.deleteConfirm.title': '“{title}” silinsin mi?',
  'docs.deleteConfirm.body':
    'Bu işlem belgeyi, çıkarılan metnini ve arama dizinini çalışma alanınızdan kalıcı olarak ' +
    'kaldırır. Çalışma alanının dışındaki özgün dosyaya dokunulmaz.',
  'docs.translateModal.title': '“{title}” belgesini çevir',
  'docs.translateModal.aria': '{title} belgesini çevir',
  'docs.translateModal.hint':
    'Yerel model, çevrilmiş bir kopyayı yeni bir belge olarak yazar. Bu belgede, içe aktarılan ' +
    'her belgede olduğu gibi arama yapabilir ve soru sorabilirsiniz; hiçbir şey bu sürücüden ' +
    'dışarı çıkmaz. Makine çevirileri hata içerebilir.',
  'docs.translateModal.from': 'Kaynak dil',
  'docs.translateModal.to': 'Hedef dil',
  'docs.translateModal.start': 'Çevir',
  'docs.translateModal.sameLang': 'İki farklı dil seçin.',
  'docs.previewModal.aria': 'Önizleme: {title}',
  'docs.previewModal.hint':
    'Çıkarılan metin (salt okunur): belge araması ve yanıtlar bu metne dayanır.',
  'docs.previewModal.ocrInfo.one':
    'Bu sürücüde tanınan metin (OCR): {count} sayfa. Tanıma sonuçları hata içerebilir.',
  'docs.previewModal.ocrInfo.other':
    'Bu sürücüde tanınan metin (OCR): {count} sayfa. Tanıma sonuçları hata içerebilir.',
  'docs.previewModal.ocrInfoPhoto':
    'Bu fotoğraftaki metin bu sürücüde tanındı (OCR). Tanıma sonuçları hata içerebilir.',
  'docs.previewModal.ocrInfoPartial':
    'Metin bu sürücüde tanındı (OCR). Metin bulunan sayfa: {count} / {total}. Tanıma sonuçları ' +
    'hata içerebilir.',
  'docs.previewModal.ocrInfoNone.one':
    'Metin tanıma (OCR) bu sürücüde {count} taranmış sayfayı okudu ve metin bulamadı.',
  'docs.previewModal.ocrInfoNone.other':
    'Metin tanıma (OCR) bu sürücüde {count} taranmış sayfayı okudu ve metin bulamadı.',
  'docs.ocr.unsure.page': 'Metin tanıma bu sayfadan emin olamadı.',
  'docs.ocr.unsure.onlyRecognized': 'Metin tanıma, tanıdığı tek sayfadan emin olamadı.',
  'docs.ocr.unsure.photo': 'Metin tanıma bu fotoğraftan emin olamadı.',
  'docs.ocr.unsure.some':
    'Metin tanıma, tanınan sayfaların bir kısmından emin olamadı: {count} / {total}.',
  'docs.ocr.unsure.all': 'Metin tanıma, tanınan {count} sayfanın hiçbirinden emin olamadı.',
  'docs.ocr.scannedPages': 'Henüz okunabilir metni olmayan taranmış sayfalar: {count} / {total}.',
  'docs.ocr.scannedPagesNeedsOcr':
    'Bunları okumak için OCR dosyaları gerekir (Yapay zekâ modeli ekranı).',
  'docs.ocr.unsure.causes':
    'Bulanık, eğik veya el yazısıyla yazılmış bir özgün belge kötü okunur; Almanca veya ' +
    'İngilizce dışındaki diller de öyle.',
  'docs.previewModal.summary': 'Özet',
  'docs.previewModal.generatedBy': 'Oluşturan: {model}',
  'docs.previewModal.truncated':
    'Bu belge uzun; özet belgenin başlangıcını kapsar. Geri kalanında yine arama yapılabilir ve ' +
    'sohbette soru sorulabilir.',
  'docs.previewModal.regenerate': 'Yeniden oluştur',
  'docs.previewModal.copy': 'Kopyala',
  'docs.previewModal.save': 'Kaydet',
  'docs.previewModal.copied': 'Özet kopyalandı',
  'docs.previewModal.copyFailed': 'Panoya kopyalanamadı',
  'docs.previewModal.savedTo': 'Özet kaydedildi: {path}',
  'docs.previewModal.noText': 'Bu belgeden metin çıkarılamadı.',
  'docs.previewModal.documentText': 'Belge metni',
  'docs.previewModal.page': 'Sayfa {page}',
  'docs.previewModal.showMore': 'Daha fazla göster',
  'docs.previewModal.loadingMore': 'Yükleniyor…',
  'docs.previewModal.segmentProgress': 'Gösterilen: {shown} / {total}',
  // ---- Deep index + coverage (whole-document-analysis plan §5.2) ----
  'docs.deepIndex.build': 'Derin dizin oluştur',
  'docs.deepIndex.reindexFirst': 'Derin dizin için yeniden dizinle',
  'docs.deepIndex.ready': 'Derin dizin hazır',
  'docs.deepIndex.readyTitle':
    'Belgenin tamamı için derin dizin hazır; özetler ve listeleme yanıtları belgenin her yerini ' +
    'kapsayabilir',
  'coverage.relevance': 'En ilgili metin bölümlerine dayanır, belgenin tamamına değil',
  'coverage.relevance.counted': '{covered} / {total} bölüme dayanır',
  'coverage.capped.whole': 'Belgenin tamamını kapsar',
  'coverage.capped.beginning': 'Belgenin başını kapsar',
  'coverage.tree.whole': 'Belgenin tamamını kapsar (derin dizin üzerinden)',
  'coverage.tree.beginning': 'Belgenin başını kapsar; belge tamamen okunamayacak kadar büyüktü',
  'coverage.tree.partial': 'Derin dizin oluşturuluyor: {covered} / {total} bölüm',
  'coverage.tree.pending': 'Henüz derin dizin yok',
  'coverage.depth': 'Ayrıntı: {label}',
  'coverage.tier.1': 'Genel bakış',
  'coverage.tier.2': 'Bölüm bölüm',
  'coverage.tier.3': 'Ayrıntılı (tam kapsam)',
  'coverage.tier.hint.1': 'En hızlı – kaydedilmiş genel bakış',
  'coverage.tier.hint.2': 'Bölümler üzerinde daha ayrıntılı bir tarama',
  'coverage.tier.hint.3': 'Belgenin tamamında en fazla ayrıntı',
  'coverage.tierSelect.trigger': 'Ayrıntı: {label}',
  'coverage.extract.whole': 'Belgenin tamamı okundu: {scanned} bölüm tarandı',
  'coverage.extract.wholeUnparsed':
    'Belgenin tamamı okundu: {scanned} bölüm tarandı, {unparsed} bölüm okunamadı',
  'coverage.extract.sections': 'Taranan {scanned} bölüm okundu',
  'coverage.extract.sectionsUnparsed': 'Taranan {scanned} bölüm okundu, {unparsed} bölüm okunamadı',
  // ---- "List every X" answer (whole-document-analysis plan §4.2, Phase 3) ----
  'analysis.kind.generic': 'öğeler',
  'analysis.kind.date': 'tarihler',
  'analysis.kind.amount': 'tutarlar',
  'analysis.kind.party': 'taraflar',
  'analysis.kind.obligation': 'yükümlülükler',
  'analysis.listing.coverageWhole':
    'Belgenin tamamında bulunanlar ({kind}): {count}; taranan bölüm: {scanned}{unparsed}:',
  'analysis.listing.coverageSections':
    'Bulunanlar ({kind}): {count}; taranan bölüm: {scanned}{unparsed}:',
  'analysis.listing.empty': 'Hiçbir şey bulunamadı ({kind}); taranan bölüm: {scanned}{unparsed}.',
  'analysis.listing.unparsedSuffix': ' ({k} okunamadı)',
  'analysis.listing.item': '- {value} (×{count})',
  'analysis.listing.caveat':
    'Bu liste taranan bölümlerin tamamını kapsar, ancak eksiksiz olduğu garanti edilmez (küçük ' +
    'bir model bir öğeyi atlayabilir ve birbirine çok benzeyen girdiler birleştirilebilir).',
  'analysis.listing.refPage': 'sayfa {n}',
  'analysis.listing.refSection': 'bölüm {n}',
  'analysis.listing.unparsedHint':
    '**Not:** bu belge dizinlenirken bölümlerin çoğu okunamadı; bu yüzden bu sonuç güvenilir ' +
    'değil. Belgeler ekranını açıp “Derin dizin oluştur” seçeneğini yeniden kullanın: okunamayan ' +
    'bölümler yeniden denenir (daha büyük bir model yardımcı olur).',
  'analysis.listing.unparsedHintAmountSkill':
    'Banka hesap özetleri için sohbetin beceri menüsündeki “Banka hesap özeti analizi” becerisi ' +
    'tutarları tam olarak okur.',
  'analysis.listing.aggregationHint':
    '**Not:** kategoriler veya toplamlar istediniz, ancak bu yanıt yalnızca belgede bulunan ' +
    'değerleri ve her birinin kaç kez geçtiğini listeleyebilir; değerleri gruplayamaz veya ' +
    'toplayamaz.',
  'analysis.listing.aggregationHintAmountSkill':
    'Banka hesap özetleri için sohbetin beceri menüsünde “Banka hesap özeti analizi” becerisini ' +
    'etkinleştirip yeniden sorun: bu beceri işlemleri kategorilere ayırır ve her kategoriyi tam ' +
    'olarak toplar.',
  'analysis.wholeDocHint':
    '**Not:** bu yanıt yalnızca en ilgili bölümlere dayanıyor; bu yüzden bazı öğeler eksik ' +
    'olabilir. Her bölümü kapsayan bir liste için Belgeler ekranını açın, belge için “Derin ' +
    'dizin oluştur” seçeneğini kullanın ve yeniden sorun.',
  'analysis.partialAnswerHint':
    '**Not:** bu yanıt yalnızca en ilgili bölümlere dayanıyor; bu yüzden bazı öğeler eksik ' +
    'olabilir.',
  'analysis.wholeReadSumHint':
    '**Not:** toplamları model kendisi hesaplar ve bazı öğeleri atlayabilir veya yanlış ' +
    'sayabilir. Her toplamı kaynaklarla karşılaştırarak kontrol edin.',
  // ---- Bank-statement analysis answer (full-doc-skills plan §3.1, Phase 2) ----
  'skills.bankAnalysis.count': 'Hesap özetinin tamamında **{count}** işlem okudum.',
  'skills.bankAnalysis.countPartial':
    '**{count}** işlem okudum. **{dropped}** satırda işleme dönüştüremediğim bir tutar vardı; bu ' +
    'yüzden bunlar tüm işlemler olmayabilir. Bu satırları belgeyle karşılaştırarak kontrol edin.',
  'skills.bankAnalysis.countContradicted':
    '**{count}** işlem okudum, ancak bu hesap özetindeki basılı bakiyeler bu işlemlerle ' +
    'tutmuyor; bu yüzden bunların tüm işlemler olduğundan emin olamıyorum.',
  'skills.bankAnalysis.empty':
    'Belgenin tamamını taradım, ancak içinden hiçbir işlem çıkaramadım. Satırlar taranmış bir ' +
    'görselde veya okuyucumun izleyemediği alışılmadık bir düzende olabilir. Bu bir taramaysa ' +
    'önce üzerinde metin tanıma (OCR) çalıştırın; değilse bu düzen otomatik olarak okunamıyor ' +
    'olabilir: rakamları doğrudan okumak için hesap özetini açın.',
  'skills.bankAnalysis.couldNotRead': 'Bu hesap özetini okuyamadım; bu yüzden analiz edemiyorum.',
  'skills.bankAnalysis.unreconciledHeading':
    'Önce bu satırları kontrol edin; bu satırlarda basılı bakiye, işlem tutarlarıyla tutmuyor:',
  'skills.bankAnalysis.unreconciledItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.totals':
    'Gelen para: **{inAmount} {currency}** · Giden para: **{outAmount} {currency}** · Net ' +
    'değişim: **{netAmount} {currency}**.',
  'skills.bankAnalysis.noCurrency':
    'Bu işlemlerde birden fazla para birimi kullanılıyor; bu yüzden tek bir birleşik toplam yok. ' +
    'Toplamın para birimine göre ayrılması gerekir.',
  'skills.bankAnalysis.incompleteNoTotal':
    'Hesap özetinin tamamını okuduğumdan emin olamadım: basılı bakiyeler okuduğum işlemlerle ' +
    'tutmuyor; bu yüzden rakamlar yanlış okunmuş veya eksik olabilir. Size yanlış olabilecek bir ' +
    'toplam vermemek için burada bir toplam belirtmiyorum; hesap özetini açıp rakamları kendiniz ' +
    'kontrol edin.',
  'skills.bankAnalysis.categoryHeading': 'Kategoriye göre:',
  'skills.bankAnalysis.categoryItem': '- {category}: {amount} {currency} ({count})',
  'skills.bankAnalysis.categoryAssisted':
    '_Kategoriler model yardımıyla belirlendi: bir etiket yanlış olabilir, ancak yukarıdaki ' +
    'toplamlar değişmedi._',
  'skills.bankAnalysis.categoryRuleBased':
    '_Bu, kurallara dayalı hızlı bir gruplamadır (model kullanılmadı). Model yardımıyla daha ' +
    'ayrıntılı bir kategori dağılımı için “Kategorilere ayır” düğmesini kullanın._',
  'skills.bankCategory.Groceries': 'Market alışverişi',
  'skills.bankCategory.Dining': 'Yeme-içme',
  'skills.bankCategory.Transport': 'Ulaşım',
  'skills.bankCategory.Utilities': 'Faturalar',
  'skills.bankCategory.Rent': 'Kira',
  'skills.bankCategory.Insurance': 'Sigorta',
  'skills.bankCategory.Subscriptions': 'Abonelikler',
  'skills.bankCategory.Health': 'Sağlık',
  'skills.bankCategory.Shopping': 'Alışveriş',
  'skills.bankCategory.Income': 'Gelir',
  'skills.bankCategory.Transfer': 'Para transferi',
  'skills.bankCategory.Fees': 'Ücretler',
  'skills.bankCategory.Cash': 'Nakit',
  'skills.bankCategory.Tax': 'Vergi',
  'skills.bankCategory.Spending': 'Harcamalar',
  'skills.bankCategory.Uncategorized': 'Kategorisiz',
  'skills.bankAnalysis.caveat':
    'Bu rakamlar, hesap özetinin kendi basılı tutarlarıdır ve belgenin tamamından okunmuştur; ' +
    'buradaki hiçbir şey metin içinden toplanmadı veya uydurulmadı.',
  'skills.bankAnalysis.unverifiedCaveat':
    'Bu rakamlar, belgenin tamamında okuduğum **{count}** işlemin toplamıdır. Hesap özetinde ' +
    'açılış veya kapanış bakiyesi basılı değil; bu yüzden bunların tüm işlemler olduğundan emin ' +
    'olamıyorum. Bunları teyit edilmiş bir hesap özeti toplamı olarak değil, gösterilen ' +
    'satırların toplamı olarak değerlendirin. Buradaki hiçbir şey metin içinden toplanmadı veya ' +
    'uydurulmadı.',
  'skills.bankAnalysis.dateOrderCaveat':
    'Tarihlerle ilgili bir not: bu hesap özeti, tarihlerde önce günün mü yoksa önce ayın mı ' +
    'geldiğine dair bir ipucu vermiyor; bu yüzden tarihleri önce gün gelecek şekilde ' +
    '(gün.ay.yıl) okudum. 03.05. gibi bir tarih 3 Mayıs da olabilir, 5 Mart da. Önemli her ' +
    'tarihi belgeyle karşılaştırarak kontrol edin.',
  'skills.bankAnalysis.transactionsHeading': 'İşlemler:',
  'skills.bankAnalysis.transactionItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.transactionsMore':
    '… ve **{count}** tane daha. Tüm satırları görmek için beceri çubuğundaki **CSV olarak dışa ' +
    'aktar** düğmesiyle hesap özetinin tamamını kaydedin veya burada, sohbette CSV ya da JSON ' +
    'biçiminde isteyin.',
  'skills.bankAnalysis.figureEcho': 'Okunan işlemlerden hesaplanan toplamlar: {figures}.',
  'skills.bankAnalysis.figureEchoIn': 'gelen para {amount} {currency}',
  'skills.bankAnalysis.figureEchoOut': 'giden para {amount} {currency}',
  'skills.bankAnalysis.figureEchoNet': 'net değişim {amount} {currency}',
  'skills.bankAnalysis.formatIntro':
    'Hesap özeti, {format} biçiminde aşağıdadır. Yalnızca okuduğum rakamlardan oluşturuldu; ' +
    'metin içinden hiçbir şey toplanmadı veya uydurulmadı:',
  'skills.bankAnalysis.formatIntroCsv':
    'Hesap özeti, CSV biçiminde aşağıdadır: yalnızca işlem satırları, okuduğum rakamlardan ' +
    'oluşturuldu (metin içinden hiçbir şey toplanmadı veya uydurulmadı). Nakit akışı özeti ile ' +
    'açılış ve kapanış bakiyeleri CSV biçimine dahil değildir; bunları da almak için hesap ' +
    'özetini JSON olarak isteyin.',
  'skills.bankAnalysis.customCategoriesNeedModel':
    'İşlemleri kendi kategorilerinize ({categories}) ayırmak için çalışan bir yerel modele ' +
    'ihtiyacım var; yerleşik hızlı kurallar yalnızca kendi sabit kategorilerini bilir. Bir model ' +
    'başlatın, ardından yeniden sorun.',
  'skills.bankAnalysis.customTaxonomyNotFound':
    '“{name}” adlı dosyayı belgeleriniz arasında bulamadım. Önce dosyayı içe aktarın (Belgeler → ' +
    'Dosya içe aktar), ardından yeniden sorun.',
  'skills.bankAnalysis.customTaxonomyUnparseable':
    '“{name}” adlı dosyayı okudum, ancak kategori listesi olarak kullanamadım. Her satırda bir ' +
    'kategori bekleniyor: bir etiket ve isteğe bağlı olarak noktalı virgülden sonra anahtar ' +
    'sözcükler (örneğin “Çocuk;Okul, Kreş, Harçlık”).',
  'skills.bankAnalysis.derivedColumnsNote':
    '_Yerel modelin her işlemin açıklamasından doldurduğu sütunlar: {columns}. Model emin ' +
    'olmadığında hücre boş bırakıldı. Tüm rakamlar kurallara dayalı ayrıştırıcıdan gelir ve ' +
    'değiştirilmedi._',
  // ---- Invoice analysis answer (full-doc-skills plan §3.1, Phase 4 / D49) ----
  'skills.invoiceAnalysis.count': 'Faturanın tamamını okudum: **{count}** fatura kalemi.',
  'skills.invoiceAnalysis.countPartial':
    '**{count}** fatura kalemi okudum. **{dropped}** satırda fatura kalemine dönüştüremediğim ' +
    'bir tutar vardı; bu yüzden bunlar tüm satırlar olmayabilir. Bu satırları belgeyle ' +
    'karşılaştırarak kontrol edin.',
  'skills.invoiceAnalysis.empty':
    'Belgenin tamamını taradım, ancak içinden hiçbir fatura kalemi veya toplam çıkaramadım. ' +
    'Rakamlar taranmış bir görselde veya okuyucumun izleyemediği alışılmadık bir düzende ' +
    'olabilir. Bu bir taramaysa önce üzerinde metin tanıma (OCR) çalıştırın; değilse bu düzen ' +
    'otomatik olarak okunamıyor olabilir: rakamları doğrudan okumak için faturayı açın.',
  'skills.invoiceAnalysis.couldNotRead': 'Bu faturayı okuyamadım; bu yüzden analiz edemiyorum.',
  'skills.invoiceAnalysis.unreconciledHeading':
    'Önce bu toplamları kontrol edin; birbirini tutmuyor:',
  'skills.invoiceAnalysis.checkLineItemsSumToNet':
    'fatura kalemlerinin toplamı basılı net toplamı tutmuyor',
  'skills.invoiceAnalysis.checkNetPlusTaxIsGross':
    'net tutar ile verginin toplamı basılı brüt toplamı tutmuyor',
  'skills.invoiceAnalysis.checkTaxMatchesRate': 'vergi tutarı belirtilen vergi oranıyla uyuşmuyor',
  'skills.invoiceAnalysis.unreconciledItem': '- {check}',
  'skills.invoiceAnalysis.totalsHeading': 'Toplamlar, tam olarak basıldığı gibi:',
  'skills.invoiceAnalysis.net': '- Net tutar: **{value}**',
  'skills.invoiceAnalysis.tax': '- Vergi: **{value}**',
  'skills.invoiceAnalysis.taxWithRate': '- Vergi (%{rate}): **{value}**',
  'skills.invoiceAnalysis.gross': '- Brüt toplam (ödenecek tutar): **{value}**',
  'skills.invoiceAnalysis.positionsHeading': 'Fatura kalemleri:',
  'skills.invoiceAnalysis.positionItem': '- {description} · {amount} {currency}',
  'skills.invoiceAnalysis.positionsMore':
    '… ve **{count}** tane daha. Tüm satırları görmek için faturayı CSV olarak dışa aktarmamı ' +
    'isteyin.',
  'skills.invoiceAnalysis.formatIntro':
    'Fatura, {format} biçiminde aşağıdadır. Yalnızca okuduğum rakamlardan oluşturuldu; metin ' +
    'içinden hiçbir şey toplanmadı veya uydurulmadı:',
  'skills.invoiceAnalysis.formatIntroCsv':
    'Fatura, CSV biçiminde aşağıdadır: yalnızca fatura kalemleri, okuduğum rakamlardan ' +
    'oluşturuldu (metin içinden hiçbir şey toplanmadı veya uydurulmadı). Üst bilgiler (satıcı, ' +
    'fatura numarası, tarihler) ve toplamlar CSV biçimine dahil değildir; bunları da almak için ' +
    'faturayı JSON veya XML olarak isteyin.',
  'skills.invoiceAnalysis.noTotals':
    'Faturada okuyabildiğim basılı bir net, vergi veya brüt toplam yok.',
  'skills.invoiceAnalysis.caveat':
    'Bu rakamlar, faturanın kendi basılı tutarlarıdır ve belgenin tamamından okunmuştur; ' +
    'buradaki hiçbir şey metin içinden toplanmadı veya uydurulmadı.',
  'skills.invoiceAnalysis.dateOrderCaveat':
    'Tarihlerle ilgili bir not: bu fatura, tarihlerde önce günün mü yoksa önce ayın mı geldiğine ' +
    'dair bir ipucu vermiyor; bu yüzden tarihleri önce gün gelecek şekilde (gün.ay.yıl) okudum. ' +
    '03.05. gibi bir tarih 3 Mayıs da olabilir, 5 Mart da. Önemli her tarihi belgeyle ' +
    'karşılaştırarak kontrol edin.',
  'skills.invoiceAnalysis.detailsHeading': 'Ayrıntılar, basıldığı gibi:',
  'skills.invoiceAnalysis.detailVendor': '- Satıcı: {vendor}',
  'skills.invoiceAnalysis.detailRecipient': '- Alıcı (fatura edilen): {recipient}',
  'skills.invoiceAnalysis.detailInvoiceNumber': '- Fatura numarası: {number}',
  'skills.invoiceAnalysis.detailInvoiceDate': '- Fatura tarihi: {date}',
  'skills.invoiceAnalysis.detailDueDate': '- Son ödeme tarihi: {date}',
  'skills.invoiceAnalysis.figureEcho': 'Belgeden aynen okunan rakamlar: {figures}.',
  'skills.invoiceAnalysis.figureEchoNet': 'net {value}',
  'skills.invoiceAnalysis.figureEchoTax': 'vergi {value}',
  'skills.invoiceAnalysis.figureEchoGross': 'brüt {value}',
  'skills.invoiceAnalysis.totalsHeadingUnverified':
    'Basıldığı gibi rakamlar: **birbirini tutmuyor**; bu yüzden bunları teyit edilmemiş kabul ' +
    'edin:',
  'skills.invoiceAnalysis.unreconciledCaveat':
    'Bu basılı rakamlar birbiriyle çelişiyor; bu genellikle belgenin metninin düzgün ' +
    'çıkarılamadığı anlamına gelir (bir tarama, görsel tabanlı bir PDF veya alışılmadık bir ' +
    'düzen). Özgün belgeyi kontrol etmeden bu rakamların hiçbirine güvenmeyin.',
  'skills.invoiceAnalysis.figureEchoSuppressed':
    'Okunan toplamları burada tekrarlamıyorum: ne birbirini ne de fatura kalemlerini tutuyorlar; ' +
    'bu yüzden onları güvenilir rakamlar olarak aktarmak yanıltıcı olur. Özgün belgeyi kontrol ' +
    'edin.',
  'skills.invoiceAnalysis.unreadableLayout':
    'Bu belgenin metni düzgün çıkarılamıyor: karakterler karışık olarak (glif glif) çıkıyor; bu ' +
    'genellikle görsel tabanlı veya alışılmadık biçimde kodlanmış bir PDF anlamına gelir. ' +
    'Belgeden güvenilir fatura kalemleri veya toplamlar okuyamadım; bu yüzden rakam ' +
    'aktarmayacağım. Bu bir taramaysa önce üzerinde metin tanıma (OCR) çalıştırın; değilse ' +
    'faturayı açıp rakamları doğrudan okuyun.',
  'skills.invoiceAnalysis.textQualityCaveat':
    'Not: bu belgenin metninin bazı kısımları karışık bir düzende (glif glif) çıkarıldı. ' +
    'Yukarıdaki rakamlar birbirini tutuyor, ancak önemli her şeyi özgün belgeyle karşılaştırarak ' +
    'kontrol edin.',
  'skills.analysis.refusePartial':
    'Bunu ancak belgenin tamamına dayanarak doğru yanıtlayabilirim ve bu belge henüz tam olarak ' +
    'dizinlenmedi. Belgeler ekranını açıp “Yeniden dizinle” seçeneğini kullanın, ardından ' +
    'yeniden sorun.',
  'skills.analysis.scopeNarrowed':
    'Yalnızca **{title}** adlı belgeye dayanarak yanıt verdim; kapsamdaki diğer {count} belge ' +
    'okunmadı. Başka bir belgeyi analiz etmek için yalnızca o belgeyi seçin (veya sorunuzda ' +
    'dosyasının adını belirtin) ve yeniden sorun.',
  'skills.analysis.selectOne':
    'Bunu tam olarak analiz etmek için tek bir belgeye ihtiyacım var. Şu anda kapsamdaki belge ' +
    'sayısı: {count}; bu yüzden bu belgelerden yalnızca birkaç metin bölümü görebiliyorum. Bir ' +
    'belge seçin (veya sorunuzda dosyasının adını belirtin) ve yeniden sorun.',
  'skills.analysis.selectTwo':
    'Karşılaştırmak için tam olarak **iki** belge (veya iki sürüm) seçin. Şu anda kapsamdaki ' +
    'belge sayısı: {count}. Karşılaştırmak istediğiniz ikisini seçip yeniden sorun.',
  'skills.redactionRouting.answer':
    'Bu belgedeki kişisel verileri karartmak için mesaj kutusunun hemen üstündeki **{button}** ' +
    'düğmesine tıklayın, ardından kopyanın kaydedileceği yeri seçin. Bu işlem tamamen bu cihazda ' +
    'çalışır ve belgenin tamamını okuyarak biçimi açıkça belli olan kişisel verileri (e-posta ' +
    'adresleri, telefon numaraları, IBAN numaraları, tarihler ve bağlantılar) karartır. Bu, ' +
    'elden geldiğince yapılan bir ilk taramadır, garanti değildir: adları veya alışılmadık ' +
    'biçimleri yakalayamaz; bu yüzden kaydedilen kopyayı paylaşmadan önce gözden geçirin.',
  'skills.redactionRouting.answerMulti':
    'Bir belgedeki kişisel verileri karartmak için mesaj kutusunun hemen üstündeki **{button}** ' +
    'düğmesine tıklayıp karartılacak belgeyi seçin, ardından kopyanın kaydedileceği yeri seçin. ' +
    'Bu işlem her seferinde tek bir belgeyi işler, tamamen bu cihazda çalışır ve belgenin ' +
    'tamamını okuyarak biçimi açıkça belli olan kişisel verileri (e-posta adresleri, telefon ' +
    'numaraları, IBAN numaraları, ödeme kartı numaraları, tarihler ve bağlantılar) karartır. Bu, ' +
    'elden geldiğince yapılan bir ilk taramadır, garanti değildir: adları veya alışılmadık ' +
    'biçimleri yakalayamaz; bu yüzden kaydedilen kopyayı paylaşmadan önce gözden geçirin.',
  'skills.editRouting.answer':
    'Bu düzenlemeleri yapmak için mesaj kutusunun hemen üstündeki **{button}** düğmesine tıklayın, ' +
    'ardından düzenlenmiş kopyanın kaydedileceği yeri seçin. Bu işlem tamamen bu cihazda çalışır ve ' +
    'yalnızca istediğiniz bul ve değiştir düzenlemelerini birebir uygular: metnin aynen bulunduğu ' +
    'her yeri değiştirir, geri kalan her şeyi olduğu gibi bırakır. Belgeyi hiçbir zaman baştan ' +
    'yazmaz; bu yüzden hiçbir şey uyduramaz veya başka sözcüklerle yeniden yazamaz. Word belgeleri ' +
    '.docx biçimini korur; diğer biçimler metin dosyası (.txt) olarak kaydedilir. Paylaşmadan önce ' +
    'kopyayı gözden geçirin.',
  'skills.editRouting.answerMulti':
    'Bu düzenlemeleri yapmak için mesaj kutusunun hemen üstündeki **{button}** düğmesine tıklayıp ' +
    'düzenlenecek belgeyi seçin, ardından düzenlenmiş kopyanın kaydedileceği yeri seçin. Bu işlem ' +
    'her seferinde tek bir belgeyi işler, tamamen bu cihazda çalışır ve yalnızca istediğiniz bul ve ' +
    'değiştir düzenlemelerini birebir uygular: metnin aynen bulunduğu her yeri değiştirir, geri ' +
    'kalan her şeyi olduğu gibi bırakır. Belgeyi hiçbir zaman baştan yazmaz. Word belgeleri .docx ' +
    'biçimini korur; diğer biçimler metin dosyası (.txt) olarak kaydedilir. Paylaşmadan önce kopyayı ' +
    'gözden geçirin.',
  'skills.redactionRouting.scan':
    'Belgenin tamamını, biçimi açıkça belli olan kişisel veriler için taradım. Algılananlar – ' +
    'e-posta adresleri: {email}, telefon numaraları: {phone}, IBAN numaraları: {iban}, ödeme ' +
    'kartı numaraları: {card}, tarihler: {date}, bağlantılar: {url}. Bu, elden geldiğince ' +
    'yapılan bir örüntü taramasıdır: adları, posta adreslerini veya alışılmadık biçimleri ' +
    'yakalayamaz; bu yüzden bu sayıları eksiksiz bir liste değil, alt sınır olarak ' +
    'değerlendirin. Karartılmış bir kopya oluşturmak için mesaj kutusunun hemen üstündeki ' +
    '**{button}** düğmesine tıklayın ve kopyanın kaydedileceği yeri seçin.',
  // ---- Models (ModelsScreen.tsx) ----
  'models.title': 'Yapay zekâ modeli',
  'models.library.title': 'Model kitaplığı',
  'models.library.view': 'Model kitaplığı görünümü',
  'models.library.onDrive': 'Bu sürücüde',
  'models.library.browse': 'Modellere göz at',
  'models.library.search': 'Modellerde ara',
  'models.library.searchPlaceholder': 'Ad, aile veya varyant…',
  'models.library.task': 'Görev',
  'models.library.allTasks': 'Tüm görevler',
  'models.library.family': 'Aile',
  'models.library.allFamilies': 'Tüm aileler',
  'models.library.familyNotInView': '{name} (bu görünümde yok)',
  'models.library.resetFamily': 'Tüm aileler',
  'models.library.noFamilyForTask': 'Bu göreve uyan {family} modeli yok.',
  'models.library.noFamilyOnDrive.one':
    'Bu sürücüde {family} modeli yok. “Modellere göz at” görünümünde {count} model gösteriliyor.',
  'models.library.noFamilyOnDrive.other':
    'Bu sürücüde {family} modeli yok. “Modellere göz at” görünümünde {count} model gösteriliyor.',
  'models.library.chat': 'Sohbet',
  'models.library.translation': 'Çeviri',
  'models.library.images': 'Görseller',
  'models.library.voice': 'Ses',
  'models.library.memory': 'Gereken bellek: en az {size}',
  'models.library.clear': 'Filtreleri temizle',
  'models.library.showVariants': 'Tüm varyantları göster ({count})',
  'models.library.hideVariants': 'Daha az varyant göster ({count})',
  'models.library.results.one': '{count} eşleşen varyant',
  'models.library.results.other': '{count} eşleşen varyant',
  'models.library.noMatches':
    'Bu filtrelere uyan model yok. Başka bir arama deneyin veya filtreleri temizleyin.',
  'models.library.noneInstalled': 'Bu sürücüde henüz kullanıma hazır model yok.',
  'models.library.onlyActive':
    'Kurulu modeliniz yukarıda gösteriliyor. Alternatifler için kataloğa göz atın.',
  'models.library.noAlternatives': 'Bu katalogda başka model yok.',
  'models.library.download': 'Devam eden model indirmesi',
  'models.lead':
    'Yapay zekâ modeli sorularınızı tamamen bu cihazda yanıtlar. Her şey kullanılmadan önce ' +
    'doğrulanır; siz açıkça onaylamadan hiçbir şey indirilmez.',
  'models.loadError': 'Model listesi yüklenemedi: {error}',
  'models.checking':
    'Model dosyaları kontrol ediliyor… Bir model eklendikten veya güncellendikten sonraki ilk ' +
    'kontrol, büyük dosyalarda birkaç dakika sürebilir; sonrasında sonuç hatırlanır ve bu işlem ' +
    'anında tamamlanır.',
  'models.checkingProgress': 'Model kontrol ediliyor ({n} / {m}): {name} – %{pct}',
  'models.state.installed': 'Kurulu',
  'models.state.missing': 'İndirilmedi',
  'models.state.checksumFailed': 'Doğrulanamıyor',
  'models.state.unsupported': 'Desteklenmiyor',
  'models.state.notRecommended': 'Önerilmez',
  'models.state.ready': 'Hazır',
  'models.state.running': 'Çalışıyor',
  'models.badge.notResponding': 'Yanıt vermiyor',
  'models.notRespondingHint':
    'Yapay zekâ modeli yanıt vermeyi bıraktı. Yeniden başlatmak genellikle sorunu çözer.',
  'models.restart': 'Yeniden başlat',
  'models.hint.embeddings': 'Belgelerinizi hazırlar; böylece onlar hakkında soru sorabilirsiniz.',
  'models.hint.reranker':
    'Yanıtlarda kullanılacak metin bölümlerinin belgelerden daha iyi seçilmesini sağlar.',
  'models.hint.transcriber':
    'Ses kayıtlarını aranabilir metne dönüştürür; ayrıca sohbetteki 🎤 sesle dikte düğmesini ' +
    'etkinleştirir.',
  'models.hint.translation':
    'Belgelerinizi ve metinlerinizi diller arasında tamamen çevrimdışı çevirir.',
  'models.hint.vision':
    'Her seferinde tek bir görsel hakkındaki sorularınızı yanıtlar. PDF dosyalarını okumaz ve ' +
    'taramaları aranabilir yapmaz.',
  'models.hint.small': 'Küçük ve hızlı: neredeyse her bilgisayarda çabuk yanıtlar.',
  'models.hint.balanced': 'Dengeli: çoğu dizüstü bilgisayarda iyi çalışır.',
  'models.hint.large': 'Büyük: en güçlü yanıtlar; yüksek performanslı bir bilgisayar gerektirir.',
  'models.usesSpace': 'Sürücüde {size} yer kaplar',
  'models.downloads.blockedByPolicy': 'İndirmeler bu sürücünün ilkesi gereği kapalı.',
  'models.downloads.enableInSettings':
    'İndirme yapmak için Ayarlar ekranında “İndirmeler ve güncellemeler için internet erişimine izin ' +
    'ver” seçeneğini açın.',
  'models.download.verifying': 'İndirilen dosya doğrulanıyor…',
  'models.download.progress': 'İndiriliyor… %{pct} ({received} / {total})',
  'models.download.progressNoTotal': 'İndiriliyor… şu ana kadar {received}',
  'models.download.cancel': 'İndirmeyi iptal et',
  'models.download.cancelled':
    'İndirme iptal edildi; yeniden başlatıldığında kaldığı yerden devam eder.',
  'models.download.stoppedNetworkOff':
    'İnternet erişimi kapatıldığı için durduruldu; erişim yeniden açıldıktan sonra indirme ' +
    'yeniden başlatılırsa kaldığı yerden devam eder.',
  'models.download.unverifiedBefore':
    'İndirildi, ancak bu modelin manifest dosyasında henüz gerçek bir sağlama toplamı yok; bu ' +
    'yüzden dosya doğrulanmamış kalıyor. Sağlama toplamını şu komutla oluşturun: ',
  'models.download.unverifiedAfter': '.',
  'models.download.otherRunning': 'Başka bir indirme sürüyor; modeller tek tek indirilir',
  'models.download.titled': 'İndir: {name} ({size})',
  'models.download.resume': 'İndirmeyi sürdür',
  'models.download.start': 'İndir',
  'models.download.failed': '{name} indirilemedi.',
  'models.download.retry': 'İndirmeyi yeniden dene',
  'models.download.dismiss': 'Kapat',
  'models.download.retryUnavailable':
    'Bu model artık burada indirilmek üzere sunulmuyor; bu yüzden bu sonuçtan yeniden denenemez. ' +
    'Sonucu kapatın veya modeli kitaplıkta arayın.',
  'models.download.retryInstalled': 'Zaten bu sürücüde.',
  'models.download.withdrawn':
    'Artık indirilemiyor: yayıncı tam olarak bu dosyayı kaldırdı ({reason}). Bir sürücüde zaten ' +
    'bulunan kopyalar çalışmaya devam eder ve doğrulanabilir kalır.',
  'models.engine.title': 'Yapay zekâ motorunu kurun',
  'models.engine.explain':
    'Yapay zekâ motoru kurulana kadar modeller yerleşik bir demo modunda çalışır (yanıtlar ' +
    'görünür biçimde simüle edilir); sesle dikte için ses motoru gerekir. Motorları bir kez ' +
    'kurun; ardından gerçek yanıtlar için bir model başlatın.',
  'models.engine.install': 'Yapay zekâ motorunu kur',
  'models.engine.retry': 'Yeniden dene',
  'models.engineProblem.title': 'Yapay zekâ motoru bu bilgisayarda çalışamıyor',
  'models.engineProblem.voiceTitle': 'Ses motoru bu bilgisayarda çalışamıyor.',
  'models.engineProblem.libraryMissingPackage':
    'Gereken bir sistem kitaplığı eksik: {library}. Yazılım yöneticinizle veya bir terminalle ' +
    '{debPackage} paketini (Ubuntu, Debian, Linux Mint) ya da {rpmPackage} paketini (Fedora) ' +
    'kurun, ardından “Yeniden kontrol et” düğmesine tıklayın.',
  'models.engineProblem.libraryMissing':
    'Gereken bir sistem kitaplığı eksik: {library}. Kitaplığı yazılım yöneticinizle veya bir ' +
    'terminalle kurun, ardından “Yeniden kontrol et” düğmesine tıklayın.',
  'models.engineProblem.systemTooOldLinux':
    'Daha yeni bir Linux sürümü gerekiyor: Ubuntu 22.04, Debian 12, Fedora 36 veya daha yenisi.',
  'models.engineProblem.systemTooOldMac':
    'Daha yeni bir macOS sürümü gerekiyor. macOS sürümünüzü güncelleyin, ardından “Yeniden ' +
    'kontrol et” düğmesine tıklayın.',
  'models.engineProblem.systemTooOld': 'İşletim sisteminin daha yeni bir sürümü gerekiyor.',
  'models.engineProblem.vcRuntimeMissing':
    'Windows’ta gereken Microsoft Visual C++ Redistributable (x64) paketi eksik. Paketi kurun, ' +
    'ardından “Yeniden kontrol et” düğmesine tıklayın.',
  'models.engineProblem.filesDamaged':
    'Motorun bu sürücüdeki bazı dosyaları eksik veya hasarlı. Sorun giderme kılavuzu, motoru ' +
    'nasıl yeniden kuracağınızı açıklar.',
  'models.engineProblem.filesDamagedReinstall':
    'Motorun bu sürücüdeki bazı dosyaları eksik veya hasarlı. Bu dosyaları yenileriyle ' +
    'değiştirmek için motoru yeniden kurun.',
  'models.engineProblem.filesDamagedAfterInstall':
    'Motor az önce kuruldu ve yine de başlayamıyor; bu yüzden sorunun nedeni büyük olasılıkla ' +
    'dosyaları değil. Başka neleri kontrol edebileceğinizi sorun giderme kılavuzu açıklar.',
  'models.engineProblem.filesDamagedAfterInstallWin':
    'Motor az önce kuruldu ve yine de başlayamıyor; bu yüzden sorunun nedeni büyük olasılıkla ' +
    'dosyaları değil. Güncel olmayan bir Microsoft Visual C++ Redistributable (x64) paketi de ' +
    'buna yol açabilir: güncel sürümü kurun, ardından “Yeniden kontrol et” düğmesine tıklayın.',
  'models.engineProblem.reinstall': 'Yapay zekâ motorunu yeniden kur',
  'models.engineProblem.voiceReinstall': 'Ses motorunu yeniden kur',
  'models.engineProblem.reinstalled': 'Yapay zekâ motoru yeniden kuruldu.',
  'models.engineProblem.voiceReinstalled': 'Ses motoru yeniden kuruldu.',
  'models.engineUpdate.title': 'Yapay zekâ motoru için bir güncelleme var',
  'models.engineUpdate.voiceTitle': 'Ses motoru için bir güncelleme var',
  'models.engineUpdate.bothTitle': 'Yapay zekâ motoru ve ses motoru için güncellemeler var',
  'models.engineUpdate.explain':
    'Bu sürücüdeki sürüm, bu uygulamanın beklediğinden daha eski. Güncelleme önce yeni sürümü ' +
    'indirir; ardından dosyalar değiştirilirken modeller birkaç saniye duraklar ve seçili model ' +
    'yeniden başlar.',
  'models.engineUpdate.update': 'Güncelle',
  'models.engineUpdate.done': 'Yapay zekâ motoru güncellendi.',
  'models.engineUpdate.voiceDone': 'Ses motoru güncellendi.',
  'models.engineUpdate.bothDone': 'Yapay zekâ motoru ve ses motoru güncellendi.',
  'models.engineProblem.blocked':
    'Windows Güvenliği motoru engelledi (Akıllı Uygulama Denetimi veya virüsten koruma ' +
    'programınız). Neler yapabileceğinizi sorun giderme kılavuzu açıklar.',
  'models.engineProblem.demoNote':
    'O zamana kadar modeller demo modunda yanıt verir; yanıtlar simüle ediliyor.',
  'models.engineProblem.check': 'Yeniden kontrol et',
  'models.engineProblem.checking': 'Kontrol ediliyor…',
  'models.engineProblem.stillFailing':
    'Motor hâlâ başlayamıyor. Kurulumun tamamlandığını kontrol edin, ardından yeniden deneyin.',
  'models.engineProblem.fixed': 'Yapay zekâ motoru yeniden çalışıyor.',
  'models.engineProblem.voiceFixed': 'Ses motoru yeniden çalışıyor.',
  'models.engine.progress': 'Yapay zekâ motoru indiriliyor… %{pct}',
  'models.engine.downloadingNoTotal': 'Yapay zekâ motoru indiriliyor…',
  'models.engine.verifying': 'Yapay zekâ motoru doğrulanıyor…',
  'models.engine.extracting': 'Yapay zekâ motoru arşivden çıkarılıyor…',
  'models.voiceEngine.title': 'Sesle dikte ekleyin (isteğe bağlı)',
  'models.voiceEngine.explain':
    'Sohbet ve belge yanıtları bu sürücüde zaten çalışıyor. Ses motoru isteğe bağlıdır; yalnızca ' +
    'mesajlarınızı mikrofonunuzla dikte etmek istiyorsanız kurun.',
  'models.voiceEngine.install': 'Ses motorunu kur',
  'models.packTools.row': 'Bilgi paketi araçları: kurulu değil',
  'models.packTools.install': 'Kur…',
  'models.ocr.row': 'Taramalar ve fotoğraflar için metin tanıma (isteğe bağlı)',
  'models.ocr.rowOrientation':
    'Yan dönmüş taramaları dik konuma getirmek için bir OCR dosyası daha gerekiyor (isteğe bağlı)',
  'ocr.install.action': 'OCR dosyalarını indir',
  'ocr.install.actionTitle':
    'Taramalar ve fotoğraflar için metin tanıma (OCR) dil dosyalarını indirir',
  'ocr.install.confirm.title': 'OCR dosyaları indirilsin mi?',
  'ocr.install.confirm.explain':
    'Metin tanıma (OCR), taranmış PDF dosyalarını ve fotoğrafı çekilmiş sayfaları bu ' +
    'bilgisayarda okur. Bunun için aşağıdaki dosyaların bu sürücüde olması gerekir; başka hiçbir ' +
    'şey indirilmez ve belgeleriniz hiçbir zaman bu bilgisayardan dışarı çıkmaz.',
  'ocr.install.confirm.languages': 'Dosyalar',
  'ocr.install.confirm.hint':
    'Her dosya kullanılmadan önce beklenen sağlama toplamıyla karşılaştırılır.',
  'ocr.install.confirm.start': 'İndir',
  'ocr.install.lang.deu': 'Almanca',
  'ocr.install.lang.eng': 'İngilizce',
  'ocr.install.lang.osd': 'Sayfa yönü (yan dönmüş sayfaları dik konuma getirir)',
  'ocr.install.starting': 'İndirme başlatılıyor…',
  'ocr.install.progress': 'OCR dosyaları indiriliyor… %{pct}',
  'ocr.install.verifying': 'OCR dosyaları kontrol ediliyor…',
  'ocr.install.activating': 'Metin tanıma başlatılıyor…',
  'ocr.install.failed': 'OCR dosyaları kurulamadı.',
  'ocr.install.retry': 'OCR indirmesini yeniden dene',
  'ocr.install.cancel': 'OCR indirmesini iptal et',
  'ocr.install.alreadyPresent':
    'OCR dosyaları zaten bu sürücüde. Kullanmak için HilbertRaum’u yeniden başlatın.',
  'ocr.install.outcome.activated': 'Metin tanıma hazır; yeniden başlatma gerekmez.',
  'ocr.install.outcome.restartRequired':
    'OCR dosyaları yerinde. Yeni dil dosyalarını kullanmak için HilbertRaum’u yeniden başlatın.',
  'ocr.install.outcome.unchanged':
    'OCR dosyaları yerinde. Metin tanıma hâlâ sunulmuyorsa HilbertRaum’u yeniden başlatın.',
  'models.ram.needs': 'En az {min}\u00A0GB RAM gerekir',
  'models.ram.machine': ' (bu bilgisayarda yaklaşık {ram}\u00A0GB var)',
  'models.ram.advice': '. Daha küçük bir model seçin: kalite yine çok iyi olur.',
  'models.badge.active': 'Etkin',
  'models.badge.recommended': 'Bu bilgisayar için önerilir',
  'models.badge.ramNeeded': '≥{min}\u00A0GB RAM gerekir',
  'models.automatic.installed': 'Kurulu – otomatik olarak kullanılır. Başlatılacak bir şey yok.',
  'models.automatic.notInstalled':
    'Kurulduktan sonra otomatik olarak kullanılır; ek ayar gerekmez.',
  'models.transcriber.engineUnsupported':
    'Uygulama bu işletim sisteminde ses motorunu henüz kuramıyor; bu yüzden bu model burada ' +
    'sesle dikteyi veya ses içe aktarmayı etkinleştirmez.',
  'models.vision.installed':
    'Kurulu – Görseller ekranında otomatik olarak kullanılır. Burada başlatılacak bir şey yok.',
  'models.vision.notInstalled':
    'Kurulduktan sonra Görseller ekranında otomatik olarak kullanılır; ek ayar gerekmez.',
  'models.vision.goToImages': 'Görseller ekranına git',
  'models.translation.installed':
    'Kurulu – çeviri için otomatik olarak kullanılır. Burada başlatılacak bir şey yok.',
  'models.translation.notInstalled':
    'Kurulduktan sonra çeviri için otomatik olarak kullanılır; ek ayar gerekmez.',
  'models.use': 'Bu modeli kullan',
  'models.useTitle': 'Bu modeli seçer ve sohbet edebilmeniz için başlatır',
  'models.stopRuntime': 'Modeli durdur',
  'models.answeringNote':
    'Şu anda bir yanıt yazılıyor. Modeli durdurmak veya değiştirmek yanıtı sonlandırır; o ana ' +
    'kadar yazılan metin korunur.',
  'models.startMock': 'Demo modunda dene',
  'models.starting': 'Başlatılıyor…',
  'models.startingTitle': 'Bu model yükleniyor; büyük modellerde bu biraz zaman alabilir',
  'models.startMockTitle':
    'Henüz model dosyası yok; uygulamayı, yanıtların görünür biçimde simüle edildiği demo ' +
    'modunda deneyin',
  'models.tech.summary': 'Teknik ayrıntılar',
  'models.tech.id': 'Model kimliği',
  'models.tech.family': 'Aile',
  'models.tech.format': 'Biçim',
  'models.tech.runtime': 'Motor',
  'models.tech.license': 'Lisans',
  'models.tech.sizeOnDisk': 'Sürücüdeki boyut',
  'models.tech.minRam': 'En az RAM',
  'models.tech.recRam': 'Önerilen RAM',
  'models.tech.context': 'Bağlam penceresi',
  'models.tech.contextValue.one': '{count} token',
  'models.tech.contextValue.other': '{count} token',
  'models.tech.file': 'Dosya',
  // ---- Context-size picker (2026-07-04 user report — the truncation hint points here) ----
  'models.context.title': 'Bağlam boyutu',
  'models.context.label': 'Yanıtlar için bağlam penceresi:',
  'models.context.auto': 'Otomatik – modelin önerdiği boyut',
  'models.context.autoResolved.one': 'Otomatik – modelin önerdiği boyut ({count} token)',
  'models.context.autoResolved.other': 'Otomatik – modelin önerdiği boyut ({count} token)',
  'models.context.bigWarning':
    'Çok büyük bağlam pencereleri, model çalışırken çok fazla ek bellek gerektirir. Daha küçük ' +
    'bilgisayarlarda model başlamayabilir veya çok daha yavaş yanıt verebilir; böyle olursa daha ' +
    'küçük bir boyut ya da “Otomatik” seçeneğini seçin.',
  'models.context.hint':
    'Daha büyük bir bağlam, bir sohbetin veya belge yanıtının aynı anda daha fazla metin ' +
    'taşımasını sağlar; ancak daha fazla bellek gerektirir ve yanıtları yavaşlatabilir. Bir ' +
    'model bir sonraki kez başladığında geçerli olur.',
  'models.context.restartHint':
    'Şu anda bir model çalışıyor; yeni boyutu uygulamak için modeli durdurup yeniden başlatın.',
  'models.verifyTitle':
    'Sürücüdeki dosyanın SHA-256 değerini yeniden hesaplar ve kayıtlı değerle karşılaştırır ' +
    '(önbelleği atlar)',
  'models.verifying': 'Doğrulanıyor…',
  'models.verify': 'Sağlama toplamını doğrula',
  'models.verifyAll': 'Tüm model dosyalarını kontrol et',
  'models.verifyingAll': 'Tüm model dosyaları kontrol ediliyor…',
  'models.verifyAllTitle':
    'Bu sürücüdeki her model dosyasını SHA-256 değerine göre yeniden kontrol eder',
  'models.verifyAllHint':
    'Her model, siz başlattığınızda kontrol edilir. Bu işlem ise bu sürücüdeki tüm model ' +
    'dosyalarını kontrol eder; yavaş bir sürücüde birkaç dakika sürebilir. İstediğiniz zaman ' +
    'durdurabilirsiniz; önceden kontrol edilmiş dosyalar kontrol edilmiş olarak kalır.',
  'models.verifyAllStop': 'Kontrolü durdur',
  'models.verifyAllStopping': 'Durduruluyor…',
  'models.confirm.title': '{name} indirilsin mi?',
  'models.confirm.start': 'İndirmeyi başlat',
  'models.confirm.size': 'Boyut',
  'models.confirm.license': 'Lisans',
  'models.confirm.from': 'Kaynak',
  'models.confirm.readLicense': 'Lisansı oku',
  'models.confirm.hint':
    'İndirilen dosya kullanılmadan önce doğrulanır. Uygulamanın yaptığı tek ağ isteği budur; ' +
    'sizinle veya belgelerinizle ilgili hiçbir şey gönderilmez.',
  'models.confirm.licenseAck': 'Bu modelin lisans koşullarını okudum ve kabul ediyorum',
  'models.empty.title': 'Model manifest dosyası bulunamadı',
  'models.empty.lineBefore': 'YAML manifest dosyalarını sürücüdeki ',
  'models.empty.lineAfter': ' klasörüne ekleyin.',
  'models.section.yourModel': 'Yapay zekâ modeliniz',
  'models.section.docSearch': 'Belge arama',
  // ---- Settings (SettingsScreen.tsx — chrome + the General tab) ----
  'settings.title': 'Ayarlar',
  'settings.tabsAria': 'Ayar bölümleri',
  'settings.tab.general': 'Genel',
  'settings.tab.privacy': 'Gizlilik ve veriler',
  'settings.tab.skills': 'Beceriler',
  'settings.tab.diagnostics': 'Tanılama (gelişmiş)',
  'settings.loading': 'Ayarlar yükleniyor…',
  'settings.saved': 'Kaydedildi',
  'settings.saveFailed': 'Bu ayar kaydedilemedi. Yeniden deneyin.',
  'settings.network.title': 'Gizlilik ve çevrimdışı mod',
  'settings.network.allow': 'İndirmeler ve güncellemeler için internet erişimine izin ver',
  'settings.network.hint':
    'Varsayılan olarak açıktır; böylece yeni bir kurulum ilk açılışta bir model indirebilir. ' +
    'Kapalıyken uygulama internete hiç bağlanmaz. Açıldığında modeller, yapay zekâ motoru, ' +
    'isteğe bağlı bilgi paketi araçları ve isteğe bağlı metin tanıma (OCR) dosyaları ' +
    'indirilebilir; her biri önce onayınızı ister ve bir sürücü ilkesi indirmeleri tamamen ' +
    'kapalı tutabilir. Bu ayar ne olursa olsun sorularınız ve belgeleriniz bu cihazdan dışarı ' +
    'çıkmaz.',
  'settings.appearance.title': 'Görünüm',
  'settings.appearance.aria': 'Tema',
  'settings.appearance.system': 'Sistem',
  'settings.appearance.light': 'Açık',
  'settings.appearance.dark': 'Koyu',
  'settings.appearance.hint':
    '“Sistem” seçeneği, işletim sisteminizin açık/koyu tercihini izler. Kilit ekranı her zaman ' +
    'sistem temasını izler.',
  'settings.language.title': 'Dil',
  'settings.language.aria': 'Dil',
  'settings.language.system': 'Sistem',
  'settings.language.hint':
    '“Sistem”, HilbertRaum sunuyorsa işletim sisteminizin dilini kullanır; sunmuyorsa İngilizce ' +
    'kullanılır. Değişiklikler hemen uygulanır.',
  'settings.performance.title': 'Performans',
  'settings.performance.gpu': 'GPU hızlandırmasını kullan',
  'settings.performance.gpuHint':
    'Varsa yanıtları hızlandırmak için ekran kartınızı kullanır. Yalnızca kararlılık sorunları ' +
    'fark ederseniz kapatın; her iki durumda da her şey çalışmaya devam eder.',
  'settings.performance.rerankWideScope':
    'Bilgi paketlerinden daha fazla metin bölümünü yeniden sırala',
  'settings.performance.rerankWideScopeHint':
    'Soru başına daha yavaştır. Yalnızca yeterli sayıda işlemci iş parçacığı olan ve yeniden ' +
    'sıralama modeli kurulu bir bilgisayarda kullanılır; kullanılabilir bir ekran kartı olan ' +
    'bilgisayar zaten her metin bölümünü yeniden sıralar.',
  'settings.performance.autoStart': 'Uygulama açıldığında seçili modeli otomatik olarak yükle',
  'settings.performance.autoStartHint':
    'Varsayılan olarak açıktır. Yapay zekâ modeli ekranında seçilen model, uygulama açılırken ' +
    'arka planda yüklenir (şifreli çalışma alanlarında kilit açıldıktan sonra); böylece Sohbet ' +
    'ekranı ek tıklama gerekmeden hazır olur.',
  // ---- Settings: Chat / conversation compaction (context-compaction plan §5.4) ----
  'settings.chat.title': 'Sohbet',
  'settings.chatCompaction.label': 'Bağlamda yer açmak için eski mesajları özetle',
  'settings.chatCompaction.help':
    'Varsayılan olarak açıktır. Uzun bir sohbet modelin bağlam sınırına yaklaştığında eski ' +
    'mesajlar sessizce atılmak yerine bir kez kısa bir not hâlinde özetlenir; bu not bu sürücüde ' +
    'saklanır. Yalnızca sığan en son mesajları tutmak için kapatın.',
  'settings.developer.title': 'Geliştirici',
  'settings.developer.toggle':
    'Geliştirici modu (şifrelenmemiş çalışma alanına ve doğrulanmamış modellere izin verir)',
  'settings.developer.hint':
    'Varsayılan olarak kapalıdır. Geliştirme derlemeleri her zaman geliştirici modunda sayılır. ' +
    'Belirleyici olan sürücü ilkesidir: ticari bir sürücüde doğrulanmamış modeller bu ayardan ' +
    'bağımsız olarak reddedilmeye devam eder.',
  'settings.workspace.title': 'Çalışma alanı',
  'settings.workspace.mode': 'Mod',
  'settings.workspace.modeEncrypted': 'Şifreli',
  'settings.workspace.modePlaintext': 'Şifrelenmemiş (geliştirici)',
  'settings.workspace.contextTokens': 'Bağlam boyutu (token)',
  'settings.workspace.contextAuto':
    'Otomatik (modelin varsayılanı); Yapay zekâ modeli ekranında değiştirebilirsiniz',
  'settings.workspace.encryptedHint':
    'Bu çalışma alanı sürücüde şifreli olarak saklanır. Yeniden şifrelemek ve kilitlemek için ' +
    'kenar çubuğundaki “Şimdi kilitle” düğmesini kullanın; uygulamadan çıkıldığında da otomatik ' +
    'olarak kilitlenir.',
  'settings.workspace.plaintextHint':
    'Şifrelenmemiş geliştirici çalışma alanı: veriler şifrelenmeden saklanır. Ticari varsayılan, ' +
    'şifreli moddur.',
  'settings.changePassword.title': 'Parolayı değiştir',
  'settings.changePassword.hint':
    'Bu çalışma alanı için yeni bir parola seçin. Bu parolayı bir sonraki kilit açma işleminden ' +
    'itibaren kullanacaksınız. Parola kurtarılamaz veya sıfırlanamaz; bu yüzden hatırlayacağınız ' +
    'bir parola seçin.',
  'settings.changePassword.current': 'Mevcut parola',
  'settings.changePassword.new': 'Yeni parola',
  'settings.changePassword.confirm': 'Yeni parolayı yeniden girin',
  'settings.changePassword.busy':
    'Belgeleriniz yeni parolayla güvenceye alınıyor… Büyük bir kitaplıkta bu işlem birkaç dakika ' +
    'sürebilir.',
  'settings.changePassword.failed': 'Bir sorun oluştu. Mevcut parolanız hâlâ geçerli.',
  'settings.changePassword.submit': 'Parolayı değiştir',
  'settings.changePassword.submitBusy': 'Değiştiriliyor…',
  'settings.changePassword.toast': 'Parola değiştirildi',
  // ---- Skills (settings/SkillsTab.tsx, skills plan §15) ----
  'skills.intro':
    'Beceriler, asistana belirli bir işi nasıl yapacağını öğretir. Yanıtlarına yönlendirme ' +
    'ekler; internete veya bilgisayarınızdaki diğer klasörlere hiçbir zaman erişmez.',
  'skills.info.meeting-protocol.what':
    'Bir sonraki yanıtı düzenli bir toplantı tutanağına dönüştürür: kararlar, yapılacak işler ve ' +
    'açık kalan sorular.',
  'skills.info.meeting-protocol.needs':
    'Bu sohbetin kapsamındaki transkript veya notlar (dosyayı ekleyin veya metni yapıştırın).',
  'skills.info.meeting-protocol.limits':
    'Her seferinde tek bir belge üzerinde çalışır ve yalnızca notlarda gerçekten yazanları ' +
    'kaydeder.',
  'skills.info.contract-brief.what':
    'Bir sözleşmeyi sade bir dille özetler: taraflar, tarihler, yükümlülükler, önemli hükümler ' +
    've sorulmaya değer sorular.',
  'skills.info.contract-brief.needs': 'Bu sohbetin kapsamındaki sözleşme.',
  'skills.info.contract-brief.limits':
    'Her seferinde tek bir belge için bir okuma yardımıdır; hukuki tavsiye değildir.',
  'skills.info.deadline-obligation-finder.what':
    'Son tarihleri, ihbar sürelerini, yenileme ve ödeme tarihlerini ve bunların ardındaki ' +
    'yükümlülükleri bulur.',
  'skills.info.deadline-obligation-finder.needs': 'Bu sohbetin kapsamındaki belge.',
  'skills.info.deadline-obligation-finder.limits':
    'Her seferinde tek bir belgeyi okur; önemli tarihlere göre harekete geçmeden önce bunları ' +
    'özgün belgeyle karşılaştırarak kontrol edin.',
  'skills.info.what-changed.what':
    'Bir belgenin iki sürümünü karşılaştırır ve ham farkları değil, önemli değişiklikleri ' +
    'bildirir.',
  'skills.info.what-changed.needs': 'Bu sohbetin kapsamında tam olarak iki belge (veya sürüm).',
  'skills.info.what-changed.limits':
    'Kapsamda ikiden fazla veya az belge varsa karşılaştırma yapamaz ve normal şekilde yanıt ' +
    'verir.',
  'skills.info.share-safe-review.what':
    'Bir belgeyi paylaşmadan önce kontrol eder: görünür hassas bilgiler ve paylaşımın pratik ' +
    'riskleri.',
  'skills.info.share-safe-review.needs': 'Bu sohbetin kapsamındaki belge.',
  'skills.info.share-safe-review.limits':
    'Yalnızca tavsiye niteliğindedir; bir belgenin anonimleştirildiğini veya yayımlanmaya uygun ' +
    'olduğunu hiçbir zaman iddia etmez.',
  'skills.info.invoice.what':
    'Bir faturayı kesin ve kontrol edilebilir biçimde okur: fatura kalemleri ve toplamlar, ' +
    'toplam kontrolü, CSV/JSON/XML olarak dışa aktarma.',
  'skills.info.invoice.needs':
    'Kapsamda fatura benzeri bir belge; araçları, mesaj kutusunun hemen üstünde düğmeler olarak ' +
    'görünür.',
  'skills.info.invoice.limits':
    'Her seferinde tek bir fatura; teyit edemediği bir toplam hiçbir zaman geçiştirilmez, teyit ' +
    'edilmemiş olarak bildirilir.',
  'skills.info.bank-statement.what':
    'Bir banka hesap özetini kesin ve kontrol edilebilir biçimde okur: işlemler, kategoriler, ' +
    'bakiye kontrolleri, CSV olarak dışa aktarma.',
  'skills.info.bank-statement.needs':
    'Kapsamda hesap özeti benzeri bir belge; araçları, mesaj kutusunun hemen üstünde düğmeler ' +
    'olarak görünür.',
  'skills.info.bank-statement.limits':
    'Her seferinde tek bir hesap özeti; işlemleri kategorilere ayırmak için çalışan bir model ' +
    'gerekir.',
  'skills.info.document-redaction.what':
    'Bir belgenin karartılmış bir kopyasını kaydeder: e-postalar, numaralar ve tarihler ' +
    'kurallara dayalı olarak algılanır; adları ve adresleri ise model bulur.',
  'skills.info.document-redaction.needs':
    'Kapsamdaki belge; “Kişisel verileri karart” düğmesi mesaj kutusunun hemen üstünde görünür.',
  'skills.info.document-redaction.limits':
    'Elden geldiğince yapılır, hiçbir zaman garanti değildir: çalışan bir model olmadan yalnızca ' +
    'kurallara dayalı algılama çalışır; Word belgeleri .docx olarak kalır, diğer biçimler .txt ' +
    'olarak kaydedilir.',
  'skills.info.document-edit.what':
    'Bul ve değiştir düzenlemelerini birebir uygular ve düzenlenmiş bir kopya kaydeder; ' +
    'belgenizi hiçbir zaman baştan yazmaz.',
  'skills.info.document-edit.needs':
    'Çalışan bir model, kapsamdaki belge ve talimatınız (örneğin “X yerine Y yaz”); “Metin ' +
    'değişikliklerini uygula” düğmesi mesaj kutusunun hemen üstünde görünür.',
  'skills.info.document-edit.limits':
    'Aynen bulunamayan metin atlanır ve bildirilir; Word belgeleri .docx olarak kalır, diğer ' +
    'biçimler .txt olarak kaydedilir.',
  'skills.autoFire.title': 'Uygun bir beceriyi otomatik olarak uygula',
  'skills.autoFire.toggle': 'Uygun bir beceriyi otomatik olarak uygula',
  'skills.autoFire.hint':
    'Açık olduğunda uygulama, açıkça uyan bir uygulama becerisini bir yanıta kendiliğinden ' +
    'uygulayabilir; böylece beceriyi sizin seçmeniz gerekmez. Yalnızca uygulama becerileri ' +
    'uygulanır; sizin oluşturduğunuz veya içe aktardığınız beceriler hiçbir zaman uygulanmaz. ' +
    'Hangi becerinin kullanıldığını her zaman görürsünüz ve o yanıtı beceri olmadan yeniden ' +
    'alabilirsiniz. Varsayılan olarak kapalıdır.',
  'skills.autoFire.on': 'Otomatik beceriler açık',
  'skills.autoFire.off': 'Otomatik beceriler kapalı',
  'skills.autoFire.saveFailed': 'Otomatik beceri ayarı kaydedilemedi.',
  'skills.import': 'Beceri içe aktar…',
  'skills.import.menuAria': 'Beceri içe aktar',
  'skills.import.fromFile': 'Dosyadan (.skill.zip)…',
  'skills.import.fromFolder': 'Klasörden…',
  'skills.loading': 'Beceriler yükleniyor…',
  'skills.loadFailed': 'Beceriler yüklenemedi.',
  'skills.reconcile.folderErrors.one':
    '{count} beceri klasörü okunamadı ve atlanıyor. Bu klasördeki SKILL.md dosyası eksik, ' +
    'geçersiz veya okunamıyor.',
  'skills.reconcile.folderErrors.other':
    '{count} beceri klasörü okunamadı ve atlanıyor. Her klasörde geçerli bir SKILL.md dosyası ' +
    'olmalıdır.',
  'skills.empty.title': 'Henüz beceri yok',
  'skills.empty.line':
    'Beceriler, asistana belirli bir işi nasıl yapacağını öğretir. Başlamak için bir beceri ' +
    'ekleyin.',
  'skills.trusted.app': 'Uygulama',
  'skills.trusted.user': 'Kendi beceriniz',
  'skills.row.enableLabel': 'Etkin',
  'skills.row.on': 'Beceri açık',
  'skills.row.off': 'Beceri kapalı',
  'skills.row.onFailed': 'Bu beceri etkinleştirilemedi.',
  'skills.row.offFailed': 'Bu beceri devre dışı bırakılamadı.',
  'skills.dup.chip': 'Yinelenen ad',
  'skills.dup.title':
    'Kurulu başka bir beceri de bu adı kullanıyor. Aynı anda yalnızca biri etkin olabilir.',
  'skills.unavailable.chip': 'Dosyalar eksik',
  'skills.unavailable.title': 'Bu becerinin dosyaları artık sürücüde değil.',
  'skills.incompatible.chip': 'Yeni sürüm gerekli',
  'skills.incompatible.title':
    'Bu beceri uygulamanın daha yeni bir sürümünü gerektiriyor; etkinleştirmek için uygulamayı ' +
    'güncelleyin.',
  'skills.review.chip': 'Kontrol et',
  'skills.warn.title': 'Bu becerinin neler yapabildiğini kontrol edin',
  'skills.warn.body':
    'Sizin oluşturduğunuz veya içe aktarılmış bir beceri. Güvenmeden önce neler yapabildiğini ' +
    'kontrol edin.',
  'skills.warn.ack': 'Anladım',
  'skills.menu.aria': 'Beceri işlemleri',
  'skills.menu.export': 'Dışa aktar…',
  'skills.menu.delete': 'Sil',
  'skills.export.done': 'Beceri dışa aktarıldı',
  'skills.export.failed': 'Bu beceri dışa aktarılamadı.',
  'skills.delete.title': 'Bu beceri silinsin mi?',
  'skills.delete.body':
    'Bu işlem beceriyi sürücüden kaldırır. Beceriyi daha önce kullanmış sohbetler çalışmaya ' +
    'devam eder.',
  'skills.delete.confirm': 'Beceriyi sil',
  'skills.delete.done': 'Beceri silindi',
  'skills.delete.failed': 'Bu beceri silinemedi.',
  'skills.detail.aria': 'Beceri ayrıntıları',
  'skills.detail.version': 'Sürüm',
  'skills.detail.author': 'Yazar',
  'skills.detail.language': 'Dil',
  'skills.detail.kind': 'Tür',
  'skills.kind.instruction': 'Yönlendirme',
  'skills.kind.tool': 'Araç kullanır',
  'skills.tool.note':
    'Şimdilik bu beceri yalnızca yönlendirme ekler. Açıkladığı araçlar sonraki bir sürümde ' +
    'gelecek.',
  'skills.tool.note.active':
    'İstediğinizde bu beceri, seçtiğiniz bir belge üzerinde izin verilmiş yerel araçları ' +
    'çalıştırabilir. Yalnızca okuyan araçlar sorunuzu yanıtlamak için otomatik olarak da ' +
    'çalışabilir; dosya yazan veya dışa aktaran her işlem önce her zaman size sorar. Araçlar ' +
    'yalnızca o belgeyi görür.',
  'skills.perm.heading': 'Bu becerinin yapabilecekleri',
  'skills.perm.canTitle': 'Bu beceri şunları yapabilir:',
  'skills.perm.cannotTitle': 'Bu beceri şunları yapamaz:',
  'skills.perm.can.instructions': 'Yapay zekâ yanıtlarına talimat ekleme',
  'skills.perm.can.documents': 'Yalnızca seçtiğiniz belgeleri okuma',
  'skills.perm.can.tools': 'İstediğinizde izin verilmiş yerel araçları kullanma',
  'skills.perm.cannot.network': 'İnternete erişme',
  'skills.perm.cannot.files': 'Bilgisayarınızdaki diğer klasörleri okuma',
  'skills.perm.cannot.scripts': 'Betik çalıştırma veya yazılım kurma',
  'skills.tech.summary': 'Teknik ayrıntılar',
  'skills.tech.id': 'Beceri kimliği',
  'skills.tech.installId': 'Kurulum kimliği',
  'skills.tech.source': 'Kaynak',
  'skills.tech.permissions': 'İzinler',
  'skills.import.title': 'Bu beceri eklensin mi?',
  'skills.import.confirm': 'Beceriyi ekle',
  'skills.import.added': 'Beceri eklendi',
  'skills.import.failedTitle': 'Bu beceri eklenemiyor',
  'skills.import.failed': 'Bu beceri eklenemedi.',
  'skills.import.collision':
    'Bu ada sahip bir beceri zaten kurulu. Bunu eklerseniz kurulu becerinin yerini alır.',
  'skills.import.collisionApp':
    'Bu adı zaten bir uygulama becerisi kullanıyor. Beceriniz eklenir, ancak uygulama becerisi ' +
    'açık olduğu sürece kapalı kalır.',
  'skills.import.upgrade': 'Kurulu sürümü günceller ({from} → {to}).',
  'skills.import.replace': 'Kurulu sürümün yerini alır ({version}).',
  'skills.import.downgrade': 'Bu sürüm, kurulu sürümden daha eski ({installed}).',
  'skills.import.downgradeBlocked':
    'Daha eski bir sürümü kurmak için geliştirici modu gerekir. Buna izin vermek için ' +
    'geliştirici modunu Ayarlar → Genel sekmesinde açın.',
  'skills.import.error.notFound': 'Seçilen beceri bulunamadı.',
  'skills.import.error.notZipOrFolder':
    'Beceri, bir .skill.zip dosyası veya SKILL.md dosyası içeren bir klasör olmalıdır.',
  'skills.import.error.unreadableZip': 'Beceri paketi geçerli bir ZIP arşivi olarak okunamadı.',
  'skills.import.error.encryptedZip':
    'Beceri paketi desteklenmeyen bir ZIP biçimi (şifrelenmiş veya ZIP64) kullanıyor.',
  'skills.import.error.unsupportedCompression':
    'Beceri paketi desteklenmeyen bir sıkıştırma yöntemi kullanıyor.',
  'skills.import.error.pathTraversal': 'Pakette, yolu paket klasörünün dışına çıkan bir dosya var.',
  'skills.import.error.absolutePath':
    'Pakette, mutlak bir yola veya sürücü harfiyle başlayan bir yola sahip bir dosya var.',
  'skills.import.error.invalidPath': 'Pakette geçersiz bir yola sahip bir dosya var.',
  'skills.import.error.symlink': 'Pakette sembolik bir bağlantı var; buna izin verilmez.',
  'skills.import.error.tooDeep': 'Paketteki klasörler izin verilenden daha derin iç içe geçmiş.',
  'skills.import.error.pathTooLong': 'Pakette çok uzun bir dosya yolu var.',
  'skills.import.error.tooManyFiles': 'Pakette izin verilenden fazla dosya var.',
  'skills.import.error.tooLarge': 'Paket, izin verilen boyuttan büyük.',
  'skills.import.error.fileTooLarge': 'Paketteki bir dosya izin verilen boyuttan büyük.',
  'skills.import.error.duplicatePath': 'Pakette aynı yola karşılık gelen iki dosya var.',
  'skills.import.error.badExtension': 'Pakette izin verilmeyen bir dosya türü var.',
  'skills.import.error.nestedArchive': 'Pakette gömülü bir arşiv var; buna izin verilmez.',
  'skills.import.error.noSkillMd': 'Pakette SKILL.md dosyası yok.',
  'skills.import.error.invalidManifest': 'Becerinin manifest dosyası geçersiz.',
  'skills.import.error.idMismatch': 'Beceri kimliği geçerli bir ad değil.',
  'skills.import.error.downgradeBlocked':
    'Bu becerinin daha yeni bir sürümü zaten kurulu. Daha eski bir sürümü kurmak için ' +
    'geliştirici modunu açın.',
  'skills.import.error.appReadOnly': 'Uygulamayla gelen beceriler değiştirilemez veya silinemez.',
  'skills.import.error.locked': 'Becerileri yönetmek için çalışma alanının kilidini açın.',
  'skills.import.note.permissionNotString':
    '“{field}” izni bir metin değeri değil; varsayılan “{value}” değeri kullanılıyor.',
  'skills.import.note.permissionUnrecognized':
    '“{field}” izni, bu uygulamanın tanımadığı bir değere sahip; varsayılan “{value}” değeri ' +
    'kullanılıyor.',
  'skills.import.note.permissionClamped':
    'Beceri, bu uygulamanın izin verdiğinden daha fazla “{field}” erişimi istiyor; erişim ' +
    '“{value}” değeriyle sınırlandırıldı.',
  'skills.import.note.listInvalid': '“{field}” listesi bir metin listesi değil ve yok sayılıyor.',
  'skills.import.note.listItemsTooLong':
    '“{field}” alanındaki bazı girdiler çok uzun ve yok sayılıyor.',
  'skills.import.note.listTruncated':
    '“{field}” alanında izin verilenden fazla girdi var; yalnızca ilk {max} girdi tutulur.',
  'skills.import.note.languageInvalid':
    '“language” alanı geçerli bir dil etiketi değil; “en” kullanılıyor.',
  'skills.import.note.allowedToolsIgnored':
    'Bir yönlendirme becerisinde bildirilen araçlar yok sayılıyor (araçlar sonraki bir sürümde ' +
    'gelecek).',
  'skills.import.note.analysisInvalid':
    '“analysis” alanında bilinmeyen bir değer var; alan yok sayılıyor.',
  'skills.import.note.analysisIgnoredForTool':
    'Araç kullanan bir beceride “analysis” alanı yok sayılıyor (belgenin tamamıyla ilgili ' +
    'davranışına uygulama karar verir).',
  'skills.import.note.triggersInvalid': '“triggers” bloğu geçersiz ve yok sayılıyor.',
  'skills.import.note.autoFireInvalid':
    '“triggers.autoFire” alanı true veya false olmalıdır; false olarak değerlendiriliyor.',
  'skills.import.note.localizedInvalid': '“localized” bloğu geçersiz ve yok sayılıyor.',
  'skills.import.note.localizedLocaleInvalid':
    'Bir “localized” girdisinin dil anahtarı geçersiz; girdi yok sayılıyor.',
  'skills.import.note.localizedEntryInvalid': 'Bir “localized” girdisi geçersiz ve yok sayılıyor.',
  'skills.import.note.localizedTitleIgnored':
    'Çevrilmiş bir başlık yok sayıldı (kısa ve tek satır olmalıdır).',
  'skills.import.note.localizedDescriptionIgnored':
    'Çevrilmiş bir açıklama yok sayıldı (kısa ve tek satır olmalıdır).',
  'skills.import.note.localizedTooMany':
    '“localized” bloğunda izin verilenden fazla dil var; yalnızca ilk {max} dil tutulur.',
  'skills.import.note.trustIgnored':
    'Becerideki “trust” alanı yok sayılıyor; güven düzeyini uygulama kendisi belirler.',
  'skills.import.note.manifestJsonConflict':
    'Paketteki manifest.json dosyasında “{field}” alanı, SKILL.md dosyasındakinden farklı; ' +
    'SKILL.md kullanılıyor.',
  'skills.replace.title': 'Bunun yerine bu beceri kullanılsın mı?',
  'skills.replace.body': 'Bu ada sahip başka bir beceri açık. Bunu açmak diğerini kapatır.',
  'skills.replace.confirm': 'Bu beceriyi etkinleştir',
  // ---- Settings → Privacy & data tab (PrivacyTab.tsx) ----
  'privacy.offlineOn': '● Çevrimdışı mod: açık',
  'privacy.offlineOff': '○ Ağ erişimi açık',
  'privacy.statement.offline':
    'Çevrimdışı mod açık. HilbertRaum yapay zekâ modelini bu bilgisayarda çalıştırır. Sorularınız, ' +
    'belgeleriniz, gömme vektörleriniz ve sohbet geçmişiniz yerelde kalır.',
  'privacy.statement.online':
    'HilbertRaum yapay zekâ modelini bu bilgisayarda çalıştırır. Sorularınız, belgeleriniz, gömme ' +
    'vektörleriniz ve sohbet geçmişiniz yerelde kalır; internet erişimi açıkken bile ağı yalnızca ' +
    'indirmeler (modeller, yapay zekâ motoru, isteğe bağlı bilgi paketi araçları ve isteğe bağlı ' +
    'metin tanıma (OCR) dosyaları) kullanır.',
  'privacy.statement.noUploads':
    'Bu uygulama verilerinizi bulut tabanlı yapay zekâ sağlayıcılarına göndermez. Soru, belge ' +
    'veya gömme vektörü gönderimi, telemetri, kullanım analizi ve uzaktan çökme raporlaması ' +
    'yoktur.',
  'privacy.network.title': 'Şu anki ağ durumu',
  'privacy.networkState.noPolicy': 'Çevrimdışı mod açık.',
  'privacy.networkState.disabledByPolicy': 'Ağ erişimi ilke gereği kapalı.',
  'privacy.networkState.offDefault': 'Çevrimdışı mod açık (internet erişimi Ayarlar ekranında kapalı).',
  'privacy.networkState.enabled':
    'İnternet erişimi indirmeler için açık: modeller, yapay zekâ motoru, isteğe bağlı bilgi paketi ' +
    'araçları ve isteğe bağlı metin tanıma (OCR) dosyaları.',
  'privacy.network.noFiles': 'Hiçbir soru veya dosya bu cihazdan dışarı çıkmaz.',
  'privacy.network.effective': 'Uygulanan durum',
  'privacy.network.effectiveOffline': 'Çevrimdışı (internete bağlanılmıyor)',
  'privacy.network.effectiveAllowed': 'Ağ erişimine izin verildi',
  'privacy.network.byPolicy': 'İlke izin veriyor',
  'privacy.network.policyYes': 'Evet',
  'privacy.network.policyNo': 'Hayır (ilke gereği kapalı)',
  'privacy.network.yourSetting': 'Ayarınız',
  'privacy.network.settingAllowed': 'İnternet erişimine izin verildi',
  'privacy.network.settingOff': 'Kapalı',
  'privacy.network.telemetry': 'Telemetri',
  'privacy.network.telemetryValue':
    'Hiçbir şey bu cihazdan dışarı çıkmaz; kapatılacak bir izleme yok',
  'privacy.network.hint':
    'Uygulama, internete bağlanan her işlemden önce uyarır. Uygulamanın indirdiği tek şeyler ' +
    'yapay zekâ modelleri, yapay zekâ motoru, isteğe bağlı bilgi paketi araçları ve isteğe bağlı ' +
    'metin tanıma (OCR) dosyalarıdır; her biri yalnızca onayınızdan sonra indirilir ve ' +
    'kullanılmadan önce doğrulanır. Bu özellik varsayılan olarak açıktır ve Genel sekmesinde ' +
    'kapatılabilir. Bir sürücü ilkesi onu tamamen devre dışı bırakabilir. Aşağıdaki yerel API, ' +
    'internete hiç bağlanmayan, ayrı ve isteğe bağlı bir özelliktir.',
  'privacy.data.title': 'Verileriniz nerede saklanır',
  'privacy.data.driveRoot': 'Sürücünün kök klasörü',
  'privacy.data.workspace': 'Çalışma alanı',
  'privacy.data.models': 'Modeller',
  'privacy.data.logs': 'Günlükler',
  'privacy.data.loading': 'Konumlar yükleniyor…',
  'privacy.data.hint':
    'Her şey (içe aktarılan belgeler, çıkarılan metinler, gömme vektörleri, sohbet geçmişi, ' +
    'oluşturulan çıktılar, ayarlar) çalışma alanınızın altında yerel olarak saklanır. Bunların ' +
    'hepsini silmek için çalışma alanı klasörünü kaldırın.',
  'privacy.logs.title': 'Yalnızca yerel günlükler',
  'privacy.logs.hintBefore':
    'Hata ayıklama ve tanılama günlükleri, yukarıda gösterilen günlük klasöründeki dönüşümlü bir ' +
    'dosyaya yazılır ve ',
  'privacy.logs.never': 'hiçbir yere gönderilmez',
  'privacy.logs.hintAfter': '. Tanılama sekmesi bu cihazdan dışarıya hiçbir şey göndermez.',
  'privacy.protection.title': 'Çalışma alanı koruması',
  'privacy.protection.encryptedBefore': 'Çalışma alanınız ',
  'privacy.protection.encryptedWord': 'şifreli',
  'privacy.protection.encryptedAfter': ' modda.',
  'privacy.protection.plainBefore': 'Çalışma alanınız ',
  'privacy.protection.plainWord': 'şifrelenmemiş geliştirici modunda',
  'privacy.protection.plainAfter':
    '. Dosyalar geliştirme hızı için sürücüde şifrelenmeden saklanır.',
  'privacy.protection.plainWarning':
    'Şifrelenmemiş geliştirici modu ticari varsayılan değildir. Ticari sürücüler şifreli modu ' +
    'kullanır: anahtar paroladan türetilir ve hiçbir şey şifrelenmeden saklanmaz. Paylaşılan ' +
    'veya çıkarılabilir bir sürücüde, şifrelenmemiş modda hassas belgeler saklamayın.',
  // ---- Settings → Privacy & data → "Local API" card (local-api wave P4) ----
  'settings.localApi.title': 'Yerel API',
  'settings.localApi.lead':
    'Bu bilgisayardaki diğer programların yapay zekâ modelinize metin göndermesine ve yanıtları ' +
    'okumasına izin verin. Bu özellik, siz açana kadar kapalı kalır.',
  'settings.localApi.toggle':
    'Bu bilgisayardaki diğer uygulamaların yapay zekâ modelimi kullanmasına izin ver',
  'settings.localApi.hint':
    'Bağlantı bu bilgisayarın dışına çıkmaz; internet üzerinden hiçbir şey gönderilmez.',
  'settings.localApi.policyOff': 'Sürücünüzün ilkesi gereği kapalı.',
  'settings.localApi.confirm.title': 'Diğer uygulamalar modelinizi kullanabilsin mi?',
  'settings.localApi.confirm.what':
    'Bu bilgisayardaki diğer programlar yapay zekâ modelinize metin gönderebilecek ve ' +
    'yanıtlarını okuyabilecek.',
  'settings.localApi.confirm.boundary':
    'Bu programlar belgelerinizi, dosyalarınızı veya sohbetlerinizi göremez ve HilbertRaum ' +
    'üzerinden hiçbir şey bu bilgisayardan dışarı çıkmaz. Ancak HilbertRaum, bağlanan bir ' +
    'programın aldığı yanıtlarla ne yaptığını kontrol edemez; bir uygulamayı bağlamadan önce ' +
    'verilerini saklayıp saklamadığına veya eşitleyip eşitlemediğine bakın.',
  'settings.localApi.confirm.persists': 'Bu özellik, siz kapatana kadar açık kalır.',
  'settings.localApi.confirm.neverStored':
    'Diğer uygulamalardan gelen istekler yanıtlanır ve unutulur; sohbet geçmişinize veya ' +
    'günlüklere kaydedilmez.',
  'settings.localApi.confirm.ack': 'Diğer uygulamaların neler yapabileceğini anlıyorum.',
  'settings.localApi.confirm.cta': 'İzin ver',
  'settings.localApi.connect.title': 'Başka bir uygulama bağla',
  'settings.localApi.connect.hint':
    'Bu iki değeri bağlamak istediğiniz uygulamaya yapıştırın. Çoğu uygulama bu alanlara “base ' +
    'URL” (temel URL) ve “API key” (API anahtarı) adını verir.',
  'settings.localApi.connect.address': 'Sunucu adresi',
  'settings.localApi.connect.key': 'Erişim anahtarı',
  'settings.localApi.connect.copy': 'Kopyala',
  'settings.localApi.connect.copyAddressAria': 'Sunucu adresini kopyala',
  'settings.localApi.connect.copyKeyAria': 'Erişim anahtarını kopyala',
  'settings.localApi.connect.copiedAddress': 'Sunucu adresi kopyalandı.',
  'settings.localApi.connect.copiedKey':
    'Kopyalandı; bir dakika içinde otomatik olarak temizlenecek. Windows pano geçmişi veya ' +
    'eşitleme kopyaları saklayabilir.',
  'settings.localApi.connect.copyFailed': 'Kopyalanamadı. Yeniden deneyin.',
  'settings.localApi.connect.noKey': 'Anahtar zorunluluğu kapalıyken erişim anahtarı gerekmez.',
  'settings.localApi.model.running': 'Bir model çalışıyor; diğer uygulamalar yanıt alabilir.',
  'settings.localApi.model.stopped':
    'Çalışan model yok; siz bir model başlatana kadar diğer uygulamalar hata alır.',
  'settings.localApi.status.port': 'Dinlenen port: {port}.',
  'settings.localApi.status.served.one': 'Şu ana kadar {count} istek yanıtlandı.',
  'settings.localApi.status.served.other': 'Şu ana kadar {count} istek yanıtlandı.',
  'settings.localApi.status.off': 'Çalışmıyor.',
  'settings.localApi.busyWarning':
    'Şu anda bir uygulama modelinizi kullanıyor. Aynı anda burada sohbet etmek ikisini de ' +
    'yavaşlatabilir; kendi sohbetiniz her zaman önceliklidir.',
  'settings.localApi.preemptedWarning':
    'HilbertRaum’u kendiniz kullandığınız için bir uygulamanın isteği az önce yarıda kesildi. ' +
    'Uygulamanın yeniden denemesi yeterli.',
  'settings.localApi.token.toggle': 'Erişim anahtarı iste',
  'settings.localApi.token.hint': 'Önerilen: açık bırakın.',
  'settings.localApi.token.confirm.title': 'Erişim anahtarı kapatılsın mı?',
  'settings.localApi.token.confirm.body':
    'Erişim anahtarı olmadan bu bilgisayardaki her program, izin istemeden yapay zekâ modelinizi ' +
    'kullanabilir. Yalnızca bir uygulama gerçekten anahtar giremiyorsa kapatın.',
  'settings.localApi.token.confirm.cta': 'Anahtarı kapat',
  'settings.localApi.token.regenerate': 'Yeni anahtar oluştur',
  'settings.localApi.token.regenerate.title': 'Yeni erişim anahtarı oluşturulsun mu?',
  'settings.localApi.token.regenerate.body':
    'Eski anahtarı kullanan uygulamalar, siz yeni anahtarı bu uygulamalara yapıştırana kadar ' +
    'çalışmaz.',
  'settings.localApi.token.regenerate.cta': 'Yeni anahtar oluştur',
  'settings.localApi.token.regenerated': 'Yeni erişim anahtarı oluşturuldu.',
  'settings.localApi.token.regenerateFailed': 'Yeni anahtar oluşturulamadı. Yeniden deneyin.',
  'settings.localApi.port.label': 'Port numarası',
  'settings.localApi.port.hint':
    'Bunu yalnızca başka bir program bu numarayı zaten kullanıyorsa değiştirin. Değer 1024 ile ' +
    '65535 arasında olmalıdır.',
  'settings.localApi.error.portInUse':
    'Bu bilgisayardaki başka bir program bu numarayı zaten kullanıyor. Bu, başka bir programın ' +
    'kendini HilbertRaum gibi gösterdiği anlamına da gelebilir; sorunu çözene kadar erişim ' +
    'anahtarınızı hiçbir yere yapıştırmayın. Numarayı değiştirin (örneğin {suggestion}) ve ' +
    'yeniden açın; önceden bağlanmış bir uygulama varsa yeni sunucu adresini ona da yapıştırın.',
  'settings.localApi.error.startFailed': 'Yerel API başlatılamadı. Ayrıntılar Tanılama sekmesinde.',
  // ---- Settings → Diagnostics tab (DiagnosticsTab.tsx) ----
  'diag.localOnly': 'Yalnızca yerel tanılama. Buradaki hiçbir şey hiçbir yere gönderilmez.',
  'diag.localApi.label': 'Yerel API',
  'diag.localApi.off': 'Kapalı',
  'diag.localApi.running': 'Açık · port {port} · yanıtlanan: {served}, reddedilen: {rejected}',
  'diag.localApi.portInUse': 'Kapalı – port numarası zaten kullanımda',
  'diag.localApi.startFailed': 'Kapalı – başlatılamadı',
  'diag.audit.runtime_started': 'Model başlatıldı',
  'diag.audit.runtime_stopped': 'Model durduruldu',
  'diag.audit.runtime_crashed': 'Model beklenmedik şekilde durdu',
  'diag.audit.runtime_fallback': 'Uyumluluk modu',
  'diag.audit.model_selected': 'Model seçildi',
  'diag.audit.model_verified': 'Modelin sağlama toplamı kontrol edildi',
  'diag.audit.model_download_started': 'İndirme başlatıldı',
  'diag.audit.model_download_verified': 'İndirme doğrulandı',
  'diag.audit.model_download_failed': 'İndirme başarısız oldu',
  'diag.audit.document_imported': 'Belge içe aktarıldı',
  'diag.audit.document_reindexed': 'Belge yeniden dizinlendi',
  'diag.audit.document_deleted': 'Belge silindi',
  'diag.audit.document_task_completed': 'Belge görevi tamamlandı',
  'diag.audit.document_task_failed': 'Belge görevi başarısız oldu',
  'diag.audit.document_exported': 'Belge dışa aktarıldı',
  'diag.audit.summary_exported': 'Özet dışa aktarıldı',
  'diag.audit.conversation_deleted': 'Sohbet silindi',
  'diag.audit.conversation_exported': 'Sohbet dışa aktarıldı',
  'diag.audit.message_table_exported': 'Yanıt tablosu dışa aktarıldı',
  'diag.audit.code_block_exported': 'Kod bloğu dosya olarak kaydedildi',
  'diag.audit.workspace_created': 'Çalışma alanı oluşturuldu',
  'diag.audit.workspace_unlocked': 'Çalışma alanının kilidi açıldı',
  'diag.audit.workspace_locked': 'Çalışma alanı kilitlendi',
  'diag.audit.workspace_unlock_failed': 'Kilit açma denemesi başarısız oldu',
  'diag.audit.workspace_lock_failed':
    'Kilitleme denemesi başarısız oldu (çalışma alanının kilidi açık kaldı)',
  'diag.audit.workspace_password_changed': 'Çalışma alanı parolası değiştirildi',
  'diag.audit.settings_changed': 'Ayarlar değiştirildi',
  'diag.audit.local_api_toggled': 'Yerel API açıldı veya kapatıldı',
  'diag.audit.policy_warning': 'İlke bildirimi',
  'diag.audit.offline_guard_violation': 'Ağ erişimi denemesi fark edildi',
  'diag.audit.collection_created': 'Proje oluşturuldu',
  'diag.audit.collection_renamed': 'Projenin adı değiştirildi',
  'diag.audit.collection_archived': 'Projenin arşiv durumu değiştirildi',
  'diag.audit.collection_deleted': 'Proje silindi',
  'diag.audit.documents_added_to_collection': 'Belgeler bir projeye veya bölüme eklendi',
  'diag.audit.documents_removed_from_collection': 'Belgeler bir projeden veya bölümden kaldırıldı',
  'diag.audit.document_lifecycle_changed': 'Belgenin yaşam döngüsü durumu değiştirildi',
  'diag.audit.skill_imported': 'Beceri içe aktarıldı',
  'diag.audit.skill_deleted': 'Beceri silindi',
  'diag.audit.skill_enabled': 'Beceri etkinleştirildi',
  'diag.audit.skill_disabled': 'Beceri devre dışı bırakıldı',
  'diag.audit.skill_run_started': 'Beceri aracı başlatıldı',
  'diag.audit.skill_run_done': 'Beceri aracı tamamlandı',
  'diag.audit.skill_run_failed': 'Beceri aracı başarısız oldu',
  'diag.audit.evidence_review_created': 'Dayanak incelemesi başlatıldı',
  'diag.audit.evidence_review_ready': 'Dayanak incelemesi hazır olarak işaretlendi',
  'diag.audit.evidence_review_deleted': 'Dayanak incelemesi silindi',
  'diag.audit.evidence_pack_exported': 'Dayanak paketi dışa aktarıldı',
  'diag.audit.knowledge_pack_added': 'Bilgi paketi eklendi',
  'diag.audit.knowledge_pack_removed': 'Bilgi paketi kaldırıldı',
  'diag.audit.knowledge_pack_article_saved': 'Bilgi paketi makalesi belge olarak kaydedildi',
  'diag.accel.gpuFallbackName': 'Ekran kartı',
  'diag.accel.gpu': '{name} (GPU)',
  'diag.accel.mock': 'Yerleşik demo modu',
  'diag.app.engine': 'Yapay zekâ motoru',
  'diag.app.voiceEngine': 'Ses motoru',
  'diag.engine.cannotRun': 'Çalışamıyor – {reason}',
  'diag.engine.reason.libraryMissing': 'bir sistem kitaplığı eksik',
  'diag.engine.reason.systemTooOld': 'işletim sisteminin daha yeni bir sürümü gerekiyor',
  'diag.engine.reason.filesDamaged': 'motor dosyaları eksik veya hasarlı',
  'diag.engine.reason.filesDamagedAfterInstall':
    'motor dosyaları, yeni bir kurulumun hemen ardından hasarlı olarak bildirildi',
  'diag.engine.reason.vcRuntimeMissing': 'Visual C++ Redistributable paketi eksik',
  'diag.engine.reason.blocked': 'Windows Güvenliği tarafından engellendi',
  'diag.accel.cpu': 'CPU',
  'diag.accel.gpuAvailable': '{name} (GPU kullanılabilir)',
  'diag.app.title': 'Uygulama ve motor',
  'diag.app.version': 'Uygulama sürümü',
  'diag.app.unknown': 'bilinmiyor',
  'diag.app.selectedModel': 'Seçili model',
  'diag.app.noneSelected': 'yok',
  'diag.app.profile': 'Donanım profili',
  'diag.app.runtime': 'Motor',
  'diag.app.unknownModel': 'bilinmeyen model',
  'diag.app.onPort': ', adres: 127.0.0.1:{port}',
  'diag.app.healthy': 'sorunsuz',
  'diag.app.unhealthy': 'sorunlu',
  'diag.app.runtimeRunning': 'Çalışıyor – {model}{onPort} ({health})',
  'diag.app.stopped': 'Çalışmıyor',
  'diag.app.acceleration': 'Hızlandırma',
  'diag.app.runtimeBuild': 'Motor derlemesi',
  'diag.app.noInstallMarker': 'kurulum işareti yok (elle hazırlanmış sürücü)',
  'diag.app.engineVersions': 'Motor sürümleri',
  'diag.engineVersion.older': '{engine} {installed}, bu uygulamanın beklediği sürüm: {pinned}',
  'diag.engineVersion.newer':
    '{engine} {installed}, bu uygulamanın beklediğinden daha yeni ({pinned})',
  'diag.engineVersion.unknown':
    '{engine}: kayıtlı sürüm yok, bu uygulamanın beklediği sürüm: {pinned}',
  'diag.engineVersion.cpuNet': '{engine} CPU yedek derlemesi',
  'diag.gpu.compat':
    'Uyumluluk modunda çalışıyor: yanıtlar CPU üzerinde üretilir; bu her bilgisayarda çalışır.',
  'diag.gpu.tryHint':
    'Ekran kartı sürücünüzü güncellediyseniz ekran kartını yeniden deneyebilirsiniz.',
  'diag.gpu.offHint':
    'GPU hızlandırması Ayarlar ekranında kapalı; ekran kartını yeniden kullanmak için ' +
    'hızlandırmayı orada yeniden açın.',
  'diag.gpu.tryAgain': 'GPU ile yeniden dene',
  'diag.gpu.tryFailed': 'Ekran kartıyla yeniden deneme başarılı olmadı: {error}',
  'diag.refresh': 'Yenile',
  // ---- Performance screen (PerformanceScreen.tsx; benchmark.md "Performance screen") ----
  'perf.title': 'Performans',
  'perf.lead':
    'Bu bilgisayarın yapay zekâ modelinizi ne kadar hızlı çalıştırdığını gösterir; ölçüm bu ' +
    'cihazda yapılır. Hiçbir şey hiçbir yere gönderilmez.',
  'perf.card.title': 'Bu bilgisayar',
  'perf.checkedAt': 'Son kontrol: {when}',
  'perf.notChecked': 'Henüz kontrol edilmedi',
  'perf.otherMachine':
    'Bu sonuç farklı bir bilgisayarda ölçüldü. Bu bilgisayarı ölçmek için “Yeniden kontrol et” ' +
    'düğmesini kullanın.',
  'perf.report.otherComputer': 'Başka bir bilgisayar: {cpu}, {ram}\u00A0GB RAM',
  'perf.verdict.speed': '{model} yaklaşık {tps}\u00A0tok/s hızında çalışıyor.',
  'perf.verdict.noSpeed':
    'Bu bilgisayara en uygun model: {model} (ölçüt: {basis}). Hız, bir model çalıştıktan sonra ' +
    'ölçülür.',
  'perf.basis.discrete': 'ekran kartı belleği',
  'perf.basis.unified': 'birleşik bellek',
  'perf.basis.cpu': 'RAM',
  'perf.recommendation.atCheckTime': 'Kontrol sırasında önerilen',
  'perf.recommendation.next': 'Bir sonraki başlatma için önerilen',
  'perf.recommendation.nextOnThisComputer': 'Bu bilgisayarda bir sonraki başlatma için önerilen',
  'perf.verdict.noRecommendation': 'Katalogdaki hiçbir model henüz bu bilgisayara uymuyor.',
  'perf.verdict.notChecked':
    'Hızlı bir kontrolle bellek, sürücü hızı ve bir model çalıştığında üretim hızı ölçülür.',
  'perf.verdict.driveFast': 'Bu sürücüden modeller hızlı başlar.',
  'perf.verdict.driveSlow': 'Bu sürücüden modeller yavaş başlar.',
  'perf.tile.speed': 'Hız',
  'perf.tile.speed.unit': 'tok/s',
  'perf.tile.speed.sub': '{model} ile ölçüldü ({when})',
  'perf.tile.speed.approx': 'Yaklaşık: sayılan parçalar, yapay zekâ motorunun süre ölçümleri değil',
  'perf.tile.speed.chunks': '{chunks} parça',
  'perf.tile.speed.none': 'Henüz ölçülmedi',
  'perf.tile.speed.noneHint': 'Bir model başlatın, ardından yeniden kontrol edin',
  'perf.tile.memory': 'Bellek',
  'perf.tile.memory.unit': 'GB RAM',
  'perf.tile.memory.unified': 'Birleşik bellek',
  'perf.tile.memory.unifiedSub': 'İşlemci ve grafik çekirdekleri tarafından paylaşılır',
  'perf.model.title': 'Modeliniz',
  'perf.model.line.one': '{model} · sürücüde {size}\u00A0GB · {context} token bağlam',
  'perf.model.line.other': '{model} · sürücüde {size}\u00A0GB · {context} token bağlam',
  'perf.model.none': 'Henüz model seçilmedi. Yapay zekâ modeli ekranında bir model seçin.',
  'perf.model.need': 'Bu bağlamla {need}\u00A0GB gerektirir.',
  'perf.model.needEstimate':
    'Ağırlıklar için en az {need}\u00A0GB gerekir; buna, ilk başlatmada ölçülen bağlam önbelleği ' +
    'eklenir.',
  'perf.model.gpu':
    'Ekran kartı belleğine sığıyor ({budget}\u00A0GB): {layers} katmanın tamamı GPU üzerinde.',
  'perf.model.gpuEstimate': 'Ekran kartı belleğine sığması bekleniyor ({budget}\u00A0GB).',
  'perf.model.partial':
    'Ekran kartı belleği: {budget}\u00A0GB. GPU üzerinde {gpuLayers} / {layers} katman var, yaklaşık ' +
    '{spill}\u00A0GB ise RAM üzerinden çalışıyor. Yanıtlar daha yavaş.',
  'perf.model.partialFree':
    'GPU üzerinde {gpuLayers} / {layers} katman var, yaklaşık {spill}\u00A0GB ise RAM üzerinden ' +
    'çalışıyor: model başladığında kartın {budget}\u00A0GB belleğinden yalnızca {free}\u00A0GB boştu ' +
    've yapay zekâ motoru {margin}\u00A0GB güvenlik payı ayırıyor. Yanıtlar daha yavaş. Kart ' +
    'boşaldığında modeli yeniden başlatın.',
  'perf.model.partialMargin':
    'GPU üzerinde {gpuLayers} / {layers} katman var, yaklaşık {spill}\u00A0GB ise RAM üzerinden ' +
    'çalışıyor. Kart boştu ({free} / {budget}\u00A0GB boş), ancak yapay zekâ motoru ayrıca ' +
    '{working}\u00A0GB çalışma arabelleği ve {margin}\u00A0GB güvenlik payı ayırır ve toplam sınıra ' +
    'yaklaştığında katmanları bütün olarak karttan çıkarır. Yanıtlar daha yavaş.',
  'perf.model.partialMarginNoWorking':
    'GPU üzerinde {gpuLayers} / {layers} katman var, yaklaşık {spill}\u00A0GB ise RAM üzerinden ' +
    'çalışıyor. Kart boştu ({free} / {budget}\u00A0GB boş), ancak yapay zekâ motoru ayrıca çalışma ' +
    'arabellekleri ve {margin}\u00A0GB güvenlik payı ayırır ve toplam sınıra yaklaştığında ' +
    'katmanları bütün olarak karttan çıkarır. Yanıtlar daha yavaş.',
  'perf.model.partialEstimate':
    'Ekran kartı belleği: {budget}\u00A0GB; yaklaşık {spill}\u00A0GB ise RAM üzerinden çalışacak. ' +
    'Yanıtlar daha yavaş.',
  'perf.model.cpu': 'İşlemcide RAM üzerinden çalışıyor ({budget}\u00A0GB).',
  'perf.model.cpuEstimate': 'İşlemcide RAM üzerinden çalışacak ({budget}\u00A0GB).',
  'perf.model.unified':
    'Birleşik belleğe sığıyor ({ram}\u00A0GB; modelin kullanabileceği en fazla bellek: ' +
    '{budget}\u00A0GB).',
  'perf.model.unifiedEstimate':
    'Birleşik belleğe sığması bekleniyor ({ram}\u00A0GB; modelin kullanabileceği en fazla bellek: ' +
    '{budget}\u00A0GB).',
  'perf.model.tooLarge':
    'Bu bilgisayar için fazla büyük (kullanılabilir bellek: {budget}\u00A0GB). Daha küçük bir model ' +
    'seçin.',
  'perf.model.unknown': 'Modelin nereye yerleşeceği, bu bilgisayarda ilk kez başladığında ölçülür.',
  'perf.model.unknownObserved': 'Yapay zekâ motoru, modelin nereye yerleştiğini bildirmedi.',
  'perf.model.perDrive':
    'Sürücü her model için tek bir kayıt tutar; bu yüzden başka bir bilgisayardaki bir başlatma, ' +
    'burada ölçülen kaydın yerine geçer.',
  'perf.model.measuredOther.one':
    'Daha önce {context} token bağlamla ölçüldü ({when}); yukarıdaki tahmin geçerli ayarlar ' +
    'içindir.',
  'perf.model.measuredOther.other':
    'Daha önce {context} token bağlamla ölçüldü ({when}); yukarıdaki tahmin geçerli ayarlar ' +
    'içindir.',
  'perf.model.runningOnCard': 'Şu anda ekran kartında çalışıyor.',
  'perf.model.choose': 'Daha küçük bir model seç',
  'perf.models.title': 'Bu bilgisayardaki modeller',
  'perf.models.hint':
    'Sohbet ve çeviri ekran kartını paylaşır. Görseller, belge arama ve ses tasarım gereği ' +
    'işlemcide çalışır; bu yüzden ekran kartı belleği değil, RAM kullanır.',
  'perf.role.chat': 'Sohbet',
  'perf.role.translation': 'Çeviri',
  'perf.role.vision': 'Görseller',
  'perf.role.reranker': 'Belge arama (sıralama)',
  'perf.role.embeddings': 'Belge arama (dizin)',
  'perf.role.transcriber': 'Ses',
  'perf.models.row': '{model} · {size}\u00A0GB',
  'perf.models.rowNoSize': '{model}',
  'perf.models.none': 'Bunun için kurulu model yok.',
  'perf.models.device.gpu': 'ekran kartı',
  'perf.models.device.cpu': 'işlemci, tasarım gereği',
  'perf.models.device.processor': 'işlemci',
  'perf.models.loaded': 'şu an yüklü',
  'perf.models.notLoaded': 'yüklü değil',
  'perf.models.lifetime.session': 'yüklü kalır',
  'perf.models.lifetime.idle': 'boştayken bellekten çıkarılır',
  'perf.models.lifetime.per-use': 'yalnızca iş sırasında çalışır',
  'perf.models.split': 'kartta {gpuLayers} / {layers} katman',
  'perf.models.card':
    'Ekran kartı: sohbet {chat}\u00A0GB + çeviri {translation}\u00A0GB; kart belleği {vram}\u00A0GB.',
  'perf.models.cardReranker': 'Ekran kartı: sıralama {reranker}\u00A0GB; kart belleği {vram}\u00A0GB.',
  'perf.models.cardBoth':
    'İkisi de şu anda kartta. İkinci başlayan, kalan belleği aldı ve daha yavaş çalışıyor; ' +
    'diğeri bellekten çıkarıldığında yavaş çalışan modeli durdurup yeniden başlatın.',
  'perf.models.ram':
    'Hepsi aynı anda yüklendiğinde yaklaşık {sum}\u00A0GB gerekir (RAM: {ram}\u00A0GB).',
  'perf.models.memory':
    'Hepsi aynı anda yüklendiğinde yaklaşık {sum}\u00A0GB gerekir (modellerin kullanabileceği ' +
    'birleşik bellek: {budget}\u00A0GB).',
  'perf.models.ramTooMuch': 'Aynı anda çok fazla',
  'perf.models.ramOk': 'Sığar',
  'perf.place.gpu': 'GPU’da',
  'perf.place.partial': 'Kısmen GPU’da',
  'perf.place.cpu': 'İşlemcide',
  'perf.place.tooLarge': 'Fazla büyük',
  'perf.place.unknown': 'Ölçülmedi',
  'perf.tile.graphics': 'Ekran kartı belleği',
  'perf.tile.graphics.unit': 'GB VRAM',
  'perf.tile.graphics.none': 'Kullanılabilir ekran kartı yok. Modeller işlemcide çalışır.',
  'perf.tile.graphics.engine':
    'Yapay zekâ motoru bu bilgisayarda çalışamıyor; bu yüzden ekran kartı kontrol edilemedi.',
  'perf.tile.graphics.off': 'GPU hızlandırması kapalı. Modeller işlemcide çalışır.',
  'perf.tile.graphics.small': '{min}\u00A0GB altında: modeller işlemcide çalışır.',
  'perf.tile.graphics.integrated': 'Tümleşik, paylaşılan bellek: modeller işlemcide çalışır.',
  'perf.tile.graphics.unitShared': 'GB paylaşılan bellek',
  'perf.tile.graphics.notRecorded': 'Bu kontrolde ekran kartı bilgisi kaydedilmedi.',
  'perf.rating.usable': 'Uygun',
  'perf.rating.small': 'Küçük',
  'perf.rating.integrated': 'Tümleşik',
  'perf.rating.notRecorded': 'Kaydedilmedi',
  'perf.rating.none': 'Yok',
  'perf.rating.unknown': 'Bilinmiyor',
  'perf.others.subGpu': '{cpu}, {ram}\u00A0GB RAM, {vram}\u00A0GB VRAM · {when}',
  'perf.tile.drive': 'Sürücü',
  'perf.tile.drive.unit': 'MB/s okuma',
  'perf.tile.drive.load': 'Model yüklemesinden ({when}); okunan: {gb}\u00A0GB',
  'perf.tile.drive.hash': 'Dosya kontrolünden ({when}); okunan: {gb}\u00A0GB',
  'perf.tile.drive.none': 'Henüz ölçülmedi',
  'perf.tile.drive.noneHint': 'İlk model başlatmada veya dosya kontrolünde ölçülür',
  'perf.rating.good': 'İyi',
  'perf.rating.slow': 'Yavaş',
  'perf.rating.fast': 'Hızlı',
  'perf.rating.pending': 'Bekliyor',
  'perf.rating.approx': 'Yaklaşık',
  'perf.rating.slowDrive': 'Yavaş sürücü',
  'perf.profile.TINY': 'Mini',
  'perf.profile.LITE': 'Hafif',
  'perf.profile.BALANCED': 'Dengeli',
  'perf.profile.PRO': 'Pro',
  'perf.profile.UNKNOWN': 'Bilinmiyor',
  'perf.check': 'Bu bilgisayarı kontrol et',
  'perf.checkAgain': 'Yeniden kontrol et',
  'perf.running': 'Kontrol ediliyor…',
  'perf.startAndMeasure': 'Başlat ve ölç: {model}',
  'perf.contextSize': 'Bağlam boyutunu değiştir',
  'perf.copy': 'Raporu kopyala',
  'perf.autoNote':
    'İlk seferde ve bu sürücü farklı bir bilgisayara her takıldığında kendiliğinden çalışır.',
  'perf.failed': 'Kontrol tamamlanamadı: {error}',
  'perf.loadFailed': 'En güncel değerler okunamadı: {error}',
  'perf.retry': 'Yeniden dene',
  'perf.step.system': 'Donanım algılandı',
  'perf.step.drive': 'Sürücü hızı',
  'perf.step.speed': '{model} ile üretim hızı',
  'perf.step.speedSkipped': 'Üretim hızı (çalışan model yok, atlandı)',
  'perf.step.hint': 'Yaklaşık yarım dakika sürer. Uygulamayı kullanmaya devam edebilirsiniz.',
  'perf.running.background': 'Bu bilgisayar arka planda kontrol ediliyor.',
  'perf.step.state.done': '{step}: tamamlandı',
  'perf.step.state.active': '{step}: sürüyor',
  'perf.step.state.todo': '{step}: bekliyor',
  'perf.observed.title': 'Siz çalışırken gözlemlenenler',
  'perf.observed.hint':
    'Bir test sorusundan değil, normal kullanımdan gelen gerçek değerler. Bu satırlar bu oturum ' +
    'boyunca kalır; gösterdikleri okuma hızları ayrıca yukarıdaki sürücü değerleriyle birlikte ' +
    'saklanır.',
  'perf.observed.none':
    'Bu oturumda henüz bir şey gözlemlenmedi. Modele bir şey sorun veya modeli başlatın.',
  'perf.observed.answer': 'Son yanıt: {tps}\u00A0tok/s, ilk token: {ttft}\u00A0s',
  'perf.observed.answerSub': '{model}, {when}, {tokens} token',
  'perf.observed.load': 'Model başlatma: {seconds}\u00A0s',
  'perf.observed.loadSub': '{model}, bu sürücüden okunan: {gb}\u00A0GB ({mbps}\u00A0MB/s)',
  'perf.observed.check': 'Dosya kontrolü: {seconds}\u00A0s',
  'perf.observed.checkSub': 'Tam dosya kontrolü: {model} ({when}), okunan: {gb}\u00A0GB',
  'perf.observed.oncePerModel': 'Model başına bir kez',
  'perf.others.title': 'Bu sürücünün kullanıldığı diğer bilgisayarlar',
  'perf.others.hint':
    'Her bilgisayar kendi sonucunu saklar; böylece önerilen model sürücüye değil, bilgisayara ' +
    'göre belirlenir.',
  'perf.others.none':
    'Henüz yok. Sürücüyü başka bir bilgisayara takın; kontrol kendiliğinden yapılır.',
  'perf.others.row': '{model} ile {tps}\u00A0tok/s',
  'perf.others.rowNoSpeed': '{model} önerildi, hız ölçülmedi',
  'perf.others.sub': '{cpu}, {ram}\u00A0GB RAM · {when}',
  'perf.others.load': 'model başlatma {seconds}\u00A0s',
  'perf.others.check': 'dosya kontrolü {seconds}\u00A0s',
  'perf.footer':
    'Tüm ham değerleri içeren tam teknik rapor, Ayarlar ekranının Tanılama sekmesinde yer alır.',
  'perf.footerLink': 'Tanılama sekmesini aç',
  'perf.unknownModel': 'Yüklü model',
  'perf.unknownCpu': 'Bilinmeyen CPU',
  'diag.bench.title': 'Donanım hız testi',
  'diag.bench.hint':
    'Bu bilgisayarda yapılan son kontrolün ham değerleri (bir destek mesajı için). Performans ' +
    'ekranı bu değerlerin ne anlama geldiğini açıklar ve yeni bir kontrol çalıştırır. Her şey ' +
    'çevrimdışı ölçülür: hiçbir veri bilgisayarınızdan dışarı çıkmaz.',
  'diag.bench.empty':
    'Bu bilgisayarda henüz kontrol çalıştırılmadı. Bir kontrol çalıştırmak için Performans ' +
    'ekranını açın.',
  'diag.bench.profile': 'Atanan profil',
  'diag.bench.noMatch': 'Uygun model yok',
  'diag.bench.ram': 'RAM',
  'diag.bench.cpu': 'CPU',
  'diag.bench.cores.one': ' ({count} çekirdek)',
  'diag.bench.cores.other': ' ({count} çekirdek)',
  'diag.bench.osArch': 'İşletim sistemi / mimari',
  'diag.bench.gpu': 'GPU',
  'diag.bench.notDetected': 'algılanmadı',
  'diag.bench.effectiveRead': 'Ölçülen okuma hızı',
  'diag.bench.effectiveReadNone': 'henüz ölçülmedi; bir model başlatıldığında ölçülür',
  'diag.bench.effectiveReadLoad': 'model yüklemesinden ({when}); okunan: {gb}\u00A0GB',
  'diag.bench.effectiveReadHash': 'dosya kontrolünden ({when}); okunan: {gb}\u00A0GB',
  'diag.bench.driveWrite': 'Sürücü yazma hızı',
  'diag.bench.notMeasured': 'ölçülmedi',
  'diag.bench.tokens': 'Üretim hızı (tok/s)',
  'diag.bench.tokensNotMeasured': 'ölçülmedi (önce bir model başlatın)',
  'diag.bench.tokensModel': 'yüklü modelle ölçüldü: {model}',
  'diag.bench.tokensOver': '{tokens} token üzerinden',
  'diag.bench.tokensApprox': 'yaklaşık: yapay zekâ motorunun ölçümü değil, sayılan parçalar',
  'diag.bench.lastRun': 'Son çalıştırma',
  'diag.system.title': 'Sistem',
  'diag.system.osPlatform': 'İşletim sistemi / platform',
  'diag.system.freeSpace': 'Boş alan',
  'diag.system.imagesSize': 'Görsel geçmişi boyutu',
  'diag.system.loadFailed':
    'Sistem ayrıntıları henüz yüklenemedi. Bu sekmeyi yeniden açmayı deneyin.',
  'diag.paths.title': 'Konumlar',
  'diag.paths.prepared': 'Hazırlanmış sürücü',
  'diag.paths.yes': 'Evet',
  'diag.paths.noFallback': 'Hayır (uygulama verileri klasörü kullanılıyor)',
  'diag.paths.writable': 'Yazılabilir',
  'diag.paths.no': 'Hayır',
  'diag.paths.loadFailed':
    'Sürücü ve çalışma alanı ayrıntıları henüz yüklenemedi. Bu sekmeyi yeniden açmayı deneyin.',
  'diag.activity.title': 'Etkinlik',
  'diag.activity.hint':
    'Uygulamanın yaptıklarının yerel kaydı: model başlatmalar, indirmeler, belge içe ' +
    'aktarmaları, çalışma alanı olayları. Bu kayıt çalışma alanınızda kalır (çalışma alanı ' +
    'şifreliyse şifreli olarak) ve hiçbir yere gönderilmez. Sohbet metni veya belge içeriği ' +
    'hiçbir zaman içermez.',
  'diag.activity.show': 'Etkinliği göster',
  'diag.activity.hide': 'Etkinliği gizle',
  'diag.activity.export': 'Dosya olarak dışa aktar…',
  'diag.activity.savedTo': 'Etkinlik günlüğü kaydedildi: {path}',
  'diag.activity.filterShow': 'Gösterilen:',
  'diag.activity.filterAll': 'Tüm etkinlikler',
  'diag.activity.loading': 'Yükleniyor…',
  'diag.activity.empty': 'Henüz kayıt yok. Uygulamayı kullandıkça etkinlikler burada görünür.',
  'diag.activity.earlier': 'Daha önceki etkinlikleri göster',
  'diag.logs.title': 'Son günlükler',
  'diag.logs.hintBefore': 'Bu cihazdaki ',
  'diag.logs.hintAfter':
    ' dosyasının son kısmı. Günlükler yalnızca yereldir ve hiçbir yere gönderilmez; belge ' +
    'içeriği veya sohbet metni içermez.',
  'diag.logs.show': 'Günlükleri göster',
  'diag.logs.hide': 'Günlükleri gizle',
  'diag.logs.empty': '(günlük boş)',
  'diag.logs.save': 'Dosyaya kaydet…',
  'diag.logs.savedTo': 'Günlükler kaydedildi: {path}',
  'diag.copy': 'Kopyala',
  'diag.copyTitle': 'Bu ayrıntıları panoya kopyalar',
  'diag.copied': 'Panoya kopyalandı',
  'diag.copyFailed': 'Panoya kopyalanamadı',
  // ---- Shared components' built-in copy (receive a bound t — i18n record §5 ⑤) ----
  'common.dismiss': 'Kapat',
  'common.close': 'Kapat',
  'common.cancel': 'İptal',
  'common.remove': 'Kaldır',
  'common.apply': 'Uygula',
  'common.labelValue': '{label}: {value}',
  'common.percent': '%{pct}',
  'indicator.offline': 'Yerel · Çevrimdışı',
  'indicator.online': 'Yerel · İndirmeye izin verildi',
  'indicator.offlineDetail': 'Her şey bu sürücüde kalır. İnternet bağlantısı kullanılmaz.',
  'indicator.onlineDetail': 'İndirmeye izin verildi; sohbetler ve belgeler yerelde kalır.',
  'indicator.short.offline': 'Çevrimdışı',
  'indicator.short.online': 'İndirme açık',
  'indicator.withLocalApi': '{state} · API açık',
  'indicator.localApiDetail':
    'Bu bilgisayardaki diğer uygulamalar modelinizi kullanabilir. Hiçbir şey bu bilgisayardan ' +
    'dışarı çıkmaz.',
  // ---- Shared password copy ----
  'password.mismatch': 'Parolalar eşleşmiyor.',
  'password.show': 'Parolayı göster',
  'password.hide': 'Parolayı gizle',
  'password.strength.tooShort': 'Çok kısa',
  'password.strength.weak': 'Zayıf',
  'password.strength.okay': 'Orta',
  'password.strength.strong': 'Güçlü',
  'password.strength.veryStrong': 'Çok güçlü',
  'password.strength.minHint': 'En az {min} karakter kullanın.',
  'password.strength.longerHint':
    'Uzun parola daha güçlüdür: 12 veya daha fazla karakter ya da birbiriyle ilgisiz birkaç ' +
    'sözcük iyi sonuç verir.',
  // ---- Workspace gate (WorkspaceGate.tsx) ----
  'gate.passwordPlaceholder': 'Parola',
  'gate.unlock.title': 'Çalışma alanınızın kilidini açın',
  'gate.unlock.hint':
    'Bu sürücüdeki çalışma alanını açmak için parolanızı girin. Her şey bu sürücüde kalır.',
  'gate.unlock.submit': 'Kilidi aç',
  'gate.unlock.submitBusy': 'Kilit açılıyor…',
  'gate.welcome.title': 'Hoş geldiniz',
  'gate.welcome.intro':
    'Burası özel yapay zekâ çalışma alanınız. Bir yapay zekâ modeliyle sohbet edin ve ' +
    'belgeleriniz hakkında sorular sorun; hepsi bu sürücüden çalışır.',
  'gate.welcome.stays': 'Her şey bu sürücüde kalır.',
  'gate.welcome.staysRest': 'İnternet yok, hesap yok, izleme yok.',
  'gate.welcome.start': 'Başla',
  'gate.finishing.title': 'Her şey hazırlanıyor…',
  'gate.finishing.hint':
    'Bu sürücüde zaten neler olduğu kontrol ediliyor. Büyük bir yapay zekâ modeli dosyasının ilk ' +
    'kontrolü birkaç dakika sürebilir.',
  'gate.finishing.progress': 'Yapay zekâ modeli kontrol ediliyor ({n} / {m}): {name} – %{pct}',
  'gate.finishing.skip': 'Atla ve uygulamaya geç',
  'gate.starter.title': 'Son bir adım',
  'gate.starter.noModel':
    'Bu sürücüde henüz kurulu bir yapay zekâ modeli yok; sohbetin yanıt verebilmesi için bir ' +
    'model gerekir. Şimdi bir model ekleyebilir veya daha sonra istediğiniz zaman Yapay zekâ ' +
    'modeli ekranından ekleyebilirsiniz.',
  'gate.starter.optional':
    'Model indirmek isteğe bağlıdır ve her zaman önce onayınızı ister. Belgeleriniz ve ' +
    'sohbetleriniz her iki durumda da hiçbir zaman internet kullanmaz.',
  'gate.starter.skip': 'Şimdilik atla',
  'gate.starter.addDocuments': 'Belge ekle',
  'gate.starter.chooseModel': 'Yapay zekâ modelini seç',
  'gate.create.title': 'Parolanızı oluşturun',
  'gate.create.hint':
    'Bu parola, bu sürücüdeki çalışma alanınızda bulunan her şeyi (belgeleri, sohbetleri ve ' +
    'notları) kilitler. Parola kurtarılamaz veya sıfırlanamaz; bu yüzden hatırlayacağınız bir ' +
    'parola seçin.',
  'gate.create.plaintextToggle': 'Şifrelenmemiş geliştirici çalışma alanı kullan (şifreleme yok)',
  'gate.create.plaintextWarning':
    'Şifrelenmemiş mod, verilerinizi bu sürücüde şifrelemeden saklar. Yalnızca geliştirme için ' +
    'kullanın.',
  'gate.create.confirmPlaceholder': 'Parolayı yeniden girin',
  'gate.create.back': 'Geri',
  'gate.create.submit': 'Çalışma alanı oluştur',
  'gate.create.submitBusy': 'Oluşturuluyor…',
  'gate.error.generic': 'Bir sorun oluştu. Yeniden deneyin.',
  // ---- Main-process strings (Phase 41, i18n record §3.3 two-rule boundary) --------------
  'main.ingest.pdfScanDetected': 'Bu PDF bir tarama gibi görünüyor; henüz okunabilir metni yok.',
  'main.ingest.audioNeedsTranscriber':
    'Ses içe aktarma için konuşma modeli gerekir; modeli Yapay zekâ modeli ekranında indirin.',
  'main.ingest.audioNeedsEngine':
    'Ses içe aktarma için ses motoru gerekir; motoru Yapay zekâ modeli ekranında kurun.',
  'main.ingest.audioNeedsModelAndEngine':
    'Ses içe aktarma için konuşma modeli ve ses motoru gerekir; ikisini de Yapay zekâ modeli ' +
    'ekranında ekleyin.',
  'main.ingest.audioEngineUnsupported':
    'Ses içe aktarma bu işletim sisteminde henüz kullanılamıyor: uygulama, gereken ses motorunu ' +
    'burada kuramıyor.',
  'main.ingest.audioUnreadable':
    'Bu ses dosyası okunamadı. Dosyayı WAV veya MP3 biçimine dönüştürüp yeniden içe aktarın.',
  'main.ingest.audioTranscriptionFailed':
    'Kayıt yazıya dökülemedi. Yeniden denemek için bu belgeyi yeniden dizinleyin.',
  'main.ingest.engineCannotRun':
    'Yapay zekâ motoru bu bilgisayarda çalışamıyor; bu yüzden bu belge dizinlenemedi. Ne ' +
    'yapmanız gerektiği Yapay zekâ modeli ekranında gösteriliyor; ardından yeniden deneyin.',
  'main.ingest.engineLibraryMissing':
    'Gereken bir sistem kitaplığı eksik olduğu için yapay zekâ motoru bu bilgisayarda ' +
    'çalışamıyor: {library}. Sorunun nasıl çözüleceği Yapay zekâ modeli ekranında gösteriliyor; ' +
    'ardından yeniden deneyin.',
  'main.ingest.voiceEngineCannotRun':
    'Ses motoru bu bilgisayarda çalışamıyor; bu yüzden bu kayıt yazıya dökülemedi. Ne yapmanız ' +
    'gerektiği Yapay zekâ modeli ekranında gösteriliyor; ardından bu belgeyi yeniden dizinleyin.',
  'main.ingest.searchModelTimeout':
    'Arama modeli zamanında yanıt vermedi; bu yüzden bu belge dizinlenemedi. Yeniden deneyin.',
  'main.ingest.searchModelCannotStart':
    'Arama modeli başlatılamadı; bu yüzden bu belge dizinlenemedi. Yapay zekâ modeli ekranında ' +
    '“Tüm model dosyalarını kontrol et” düğmesine tıklayın, ardından yeniden deneyin.',
  'main.ingest.searchModelFailed':
    'Arama modelinde bir sorun oluştu; bu yüzden bu belge dizinlenemedi. Yeniden deneyin.',
  'main.ingest.imageNeedsOcr':
    'Fotoğraf içe aktarma için metin tanıma (OCR) dosyaları gerekir; bu dosyalar bu sürücüde yok.',
  'main.ingest.imageNoText':
    'Bu fotoğrafta okunabilir metin bulunamadı. Sayfanın daha net ve daha yakından çekilmiş bir ' +
    'fotoğrafını deneyin.',
  'main.ingest.imageOcrFailed':
    'Bu fotoğraf okunamadı. Yeniden denemek için fotoğrafı yeniden dizinleyin.',
  'main.ingest.imageOcrUnavailable':
    'Metin tanıma (OCR) bu sürümde çalışamadı; bu yüzden bu fotoğraf okunabilir metin olmadan ' +
    'saklandı. OCR kullanılabilir olduğunda fotoğrafı yeniden dizinleyin.',
  'main.ingest.sourceMissing': 'Kaynak dosya sürücüde bulunamadı.',
  'main.ingest.interrupted':
    'Belgenin işlenmesi tamamlanmadan yarıda kesildi. Yeniden denemek için belgeyi yeniden ' +
    'dizinleyin.',
  'main.ingest.fileTooLarge':
    'Bu dosya güvenli biçimde içe aktarılamayacak kadar büyük. Dosyayı daha küçük dosyalara ' +
    'bölün ve yeniden deneyin.',
  'main.ingest.tooManyChunks':
    'Bu belge tamamen dizinlenemeyecek kadar büyük. Belgeyi daha küçük dosyalara bölün ve ' +
    'parçaları içe aktarın.',
  'main.ingest.parseTimeout':
    'Bu dosyanın işlenmesi çok uzun sürdüğü için dosya atlandı. Dosya hasarlı veya çok büyük ' +
    'olabilir.',
  'main.ingest.unsupportedType':
    'Bu dosya türü desteklenmiyor ({ext}). TXT, PDF, DOCX, CSV veya desteklenen bir ses biçimi ' +
    'deneyin.',
  'main.rag.noContext':
    'Bunu belgelerinizde bulamadım. Sorunuzu farklı bir şekilde sormayı deneyin veya hangi ' +
    'belgelere sorduğunuzu kontrol edin.',
  'main.rag.reindexNeeded':
    'Belgelerinizin aranabilmesi için kısa bir yeniden dizinleme gerekiyor: belgeler farklı bir ' +
    'arama modeliyle dizinlenmiş. Belgeler ekranını açıp “Yeniden dizinle” seçeneğini kullanın.',
  'main.chat.docTaskBusy':
    'Bir belge görevi çalışıyor. Görevi iptal edebilir veya sohbet etmeden önce bitmesini ' +
    'bekleyebilirsiniz.',
  'main.chat.defaultTitle': 'Yeni sohbet',
  'main.evidenceReviews.defaultTitle': 'Dayanak incelemesi',
  'main.benchmark.warnTiny':
    'Bu cihaz için en uygunu, en küçük ve en hızlı modeldir. Daha büyük modeller yavaş ' +
    'çalışabilir.',
  'main.benchmark.warnUnknown':
    'Bu donanım tam olarak algılanamadı; bu yüzden güvenli, hafif bir model seçildi. İstediğiniz ' +
    'zaman daha büyük bir model deneyebilirsiniz.',
  'main.benchmark.warnDriveProbe':
    'Sürücü hızı ölçülemedi; bu yüzden öneride yalnızca RAM ve CPU dikkate alınıyor.',
  'main.benchmark.warnSlowDrive':
    'Bu sürücü görece yavaş. Modeller yine de çalışır, ancak yüklenmeleri daha uzun sürebilir.',
  'main.benchmark.warnSpeedSkipped':
    'Model başka bir işle meşgul olduğu için metin üretim hızı bu kez ölçülmedi. Aşağıdaki ' +
    'profil yalnızca RAM, CPU ve sürücü hızına dayanıyor; tam bir ölçüm için modeli başka hiçbir ' +
    'şey kullanmıyorken hız testini yeniden çalıştırın.',
  'main.benchmark.warnSlowRead':
    'Bu sürücüden okuma hızı yaklaşık {mbps}\u00A0MB/s olarak ölçüldü. Bir model başlatılırken ' +
    'dosyasının tamamı bu hızla okunur; bu yüzden bu sürücüde model başlatma yavaş olacak.',
  'main.benchmark.warnVeryLowTokens':
    'Yüklü modelle ({model}) metin üretimi çok yavaştı; bu yüzden atanan profil bir düzey ' +
    'düşürüldü. Bu model önerilen modelden büyükse önerilen modeli başlatın ve hız testini ' +
    'yeniden çalıştırın.',
  'main.benchmark.warnRecommendationLowered':
    'Yüklü modelle ({model}) metin üretimi yaklaşık {tps}\u00A0tok/s olarak ölçüldü; bu yüzden ' +
    'yanıtların bu bilgisayarda hızlı kalması için önerilen model bir boyut kademesi aşağı indirildi.',
  'main.benchmark.locked': 'Çalışma alanı kilitli. Hız testini çalıştırmak için kilidini açın.',
  'main.benchmark.lockedDuringRun':
    'Hız testi sürerken çalışma alanı kilitlendi; bu yüzden sonuç kaydedilmedi. Hız testini ' +
    'yeniden çalıştırın.',
  'main.dialog.openLink.title': 'Bu bağlantı tarayıcınızda açılsın mı?',
  'main.dialog.openLink.message': 'Bu bağlantı tarayıcınızda açılsın mı?',
  'main.dialog.openLink.site': 'Web sitesi: {site}',
  'main.dialog.openLink.truncated': 'Bağlantı burada kısaltıldı; gösterilmeyen karakter: {hidden}.',
  'main.dialog.openLink.credentials':
    'Adreste bir kullanıcı adı var; gerçekte açılan site, “Web sitesi” satırında yazan sitedir.',
  'main.dialog.openLink.hint':
    'Bu bağlantı HilbertRaum uygulamasından değil, bir yanıttan veya bir model manifest ' +
    'dosyasından geliyor. Tarayıcınız bu siteye bağlanacak.',
  'main.dialog.openLink.open': 'Bağlantıyı aç',
  'main.dialog.openLink.cancel': 'İptal',
  'main.workspace.wrongPassword':
    'Bu parola çalışma alanınızın kilidini açmadı. Parolayı kontrol edip yeniden deneyin.',
  'main.workspace.openFailed': 'Çalışma alanı açılamadı.',
  'main.workspace.vaultDamaged':
    'Parolanız doğru, ancak sürücüdeki çalışma alanı verileri hasarlı ve açılamadı. Parolayı ' +
    'yeniden yazmak işe yaramaz. Yeni bir çalışma alanı oluşturmayın: dosyaları olduğu gibi ' +
    'bırakın ve çalışma alanı klasörünü bir yedekten geri yükleyin.',
  'main.workspace.recoveryBlocked':
    'Çalışma alanı henüz açılamadı: başka bir program, en yeni verilerinizi içeren bir kurtarma ' +
    'dosyasını kullanıyor. Sürücüyü tarıyor olabilecek her şeyi kapatın (virüsten koruma, arama ' +
    'dizini oluşturma, çalışma alanı klasörünü gösteren bir dosya penceresi), biraz bekleyin ve ' +
    'yeniden deneyin. Hiçbir şey kaybolmadı.',
  'main.workspace.newer':
    'Bu çalışma alanı daha yeni bir HilbertRaum sürümüyle yazılmış; açmak için uygulamayı ' +
    'güncelleyin. Hiçbir şey değiştirilmedi.',
  'main.workspace.createFailed': 'Çalışma alanı oluşturulamadı.',
  'main.workspace.passwordTooShort': 'Parola en az {min} karakter olmalıdır.',
  'main.workspace.newPasswordTooShort': 'Yeni parola en az {min} karakter olmalıdır.',
  'main.workspace.unlockBeforeChange':
    'Parolasını değiştirmeden önce çalışma alanının kilidini açın.',
  'main.workspace.wrongCurrentPassword':
    'Bu, mevcut parolanızla eşleşmiyor. Parolayı kontrol edip yeniden deneyin.',
  'main.workspace.changeFailed': 'Parola değiştirilemedi. Mevcut parolanız hâlâ geçerli.',
  'main.workspace.busyPasswordChange':
    'Çalışma alanının parolası şu anda değiştiriliyor. Biraz sonra yeniden deneyin.',
  'main.workspace.lockFailed':
    'Çalışma alanı kilitlenemedi; kilidi açık kalıyor ve verileriniz güvende. Sürücüde biraz yer ' +
    'açın, sonra yeniden deneyin.',
  'main.runtime.compatibilityMode':
    'Kararlılık için uyumluluk moduna geçildi. Her şey çalışmaya devam ediyor; yanıtlar biraz ' +
    'daha yavaş olabilir.',
  'main.runtime.speedUpDisabled':
    'Kararlılık için isteğe bağlı bir hızlandırma kapatıldı. Model yeniden başlıyor; mesajınızı ' +
    'yeniden gönderin.',
  'main.runtime.crashRestarting':
    'Yapay zekâ modeli beklenmedik şekilde durdu ve yeniden başlıyor. Birazdan mesajınızı ' +
    'yeniden gönderin.',
  'main.runtime.crashStopped':
    'Yapay zekâ modeli yine beklenmedik şekilde durdu; bu yüzden yeniden başlatılmadı. Modeli ' +
    'Yapay zekâ modeli ekranında yeniden başlatabilirsiniz.',
  'main.runtime.modelCannotLoad':
    '{model} bu bilgisayarda yüklenemedi; siz başka bir model seçene kadar yanıtlar simüle ' +
    'ediliyor.',
  'main.runtime.engineCannotRun':
    'Yapay zekâ motoru bu bilgisayarda çalışamıyor; bu yüzden yanıtlar simüle ediliyor. Neyin ' +
    'eksik olduğu Yapay zekâ modeli ekranında gösteriliyor.',
  'main.engine.cannotRun':
    'Yapay zekâ motoru bu bilgisayarda çalışamıyor. Neyin eksik olduğu Yapay zekâ modeli ' +
    'ekranında gösteriliyor.',
  'main.noModelRunning':
    'Çalışan bir yapay zekâ modeli yok. Yapay zekâ modeli ekranını açıp önce bir model başlatın.',
  'main.modelStarting': 'Yapay zekâ modeli başlatılıyor. Birazdan yeniden deneyin.',
  'main.translation.noModel':
    'Çeviri için çeviri modeli gerekir; bu model bu sürücüde kurulu değil. Modeli Yapay zekâ ' +
    'modeli ekranında indirebilirsiniz.',
  'main.translation.startFailed':
    'Çeviri modeli başlatılamadı; cihazda boş bellek azalmış olabilir. Diğer uygulamaları ' +
    'kapatın veya HilbertRaum’u yeniden başlatın, ardından yeniden deneyin.',
  'main.translation.failedWindowNotice':
    '> ⚠ Bu kısım ({part} / {total}) çevrilemedi; özgün metin aşağıda değiştirilmeden korunuyor.',
  'main.translation.missingPageNotice':
    '> ⚠ Özgün belgenin şu sayfası çevrilemedi: {page}. Okunabilir metin içermiyor (taranmış bir ' +
    'görsel olabilir).',
  'main.translation.missingPageRangeNotice':
    '> ⚠ Özgün belgenin şu sayfaları çevrilemedi: {from}–{to}. Okunabilir metin içermiyorlar ' +
    '(taranmış görseller olabilir).',
  'main.translation.attributionLine':
    '{modelId} tarafından makine çevirisi yapıldı; hata içerebilir.',
  'main.model.contextExceeded':
    'Bu, geçerli modelin bağlam penceresi için fazla büyük. Yapay zekâ modeli ekranında bağlam ' +
    'boyutunu artırın (sabit bir boyut seçiliyse sınır o boyuttur) veya daha küçük bir belge ' +
    'deneyin.',
  'main.chat.streamInFlight': 'Bu sohbet için zaten bir yanıt oluşturuluyor.',
  'main.chat.emptyCompletion':
    'Model boş bir yanıt döndürdü. Yeniden deneyin veya mesajınızı farklı bir şekilde yazın.',
  'main.chat.runtimeUnresponsive':
    'Yapay zekâ modeli yanıt vermeyi bıraktı. Yeniden deneyin; bu sürekli oluyorsa Yapay zekâ ' +
    'modeli ekranında modeli yeniden başlatın.',
  'main.chat.connectionLost':
    'Yapay zekâ modeli yanıt bitmeden durdu. Mesajınızı yeniden gönderin; bu sürekli oluyorsa ' +
    'Yapay zekâ modeli ekranında modeli yeniden başlatın.',
  'main.chat.streamError':
    'Yapay zekâ modeli yanıtı bitirmeden bir sorunla karşılaştı. Yeniden deneyin; bu sürekli ' +
    'oluyorsa Yapay zekâ modeli ekranında modeli yeniden başlatın.',
  'main.chat.searchModelTimeout':
    'Arama modeli zamanında yanıt vermedi; bu yüzden belgeleriniz aranamadı. Yeniden deneyin.',
  'main.chat.searchModelCannotStart':
    'Arama modeli başlatılamadı; bu yüzden belgeleriniz aranamadı. Yapay zekâ modeli ekranında ' +
    '“Tüm model dosyalarını kontrol et” düğmesine tıklayın, ardından yeniden deneyin.',
  'main.chat.searchModelFailed':
    'Arama modeli bir sorunla karşılaştı; bu yüzden belgeleriniz aranamadı. Yeniden deneyin.',
  'main.chat.nothingToRegenerate': 'Henüz yeniden oluşturulacak bir yanıt yok.',
  'main.chat.nothingToResend':
    'Bu soru artık bu sohbetteki son mesaj değil; bu yüzden yeniden gönderilemez.',
  'main.chat.skillUnavailable':
    'Bu beceri artık kullanılamıyor: devre dışı bırakılmış veya kaldırılmış. Ayarlar ekranının ' +
    'Beceriler sekmesinde etkinleştirin ya da sorunuzu beceri olmadan yeniden sorun.',
  'main.chat.reviewBlocksRegenerate':
    'Bu yanıtın bir dayanak incelemesi var. Yeniden yanıtlamak, incelemeyi kararları ve ' +
    'notlarıyla birlikte siler; bunun yerine sorunuzu yeni bir mesaj olarak yeniden sorun.',
  'main.chat.emptyMessage': 'Boş bir mesaj gönderilemez.',
  'main.chat.emptyQuestion': 'Boş bir soru gönderilemez.',
  'main.chat.stopFirst': 'Bu sohbet için hâlâ bir yanıt oluşturuluyor. Önce yanıtı durdurun.',
  'main.chat.locked': 'Çalışma alanı kilitli. Sohbet etmek için kilidini açın.',
  'main.busy.chat':
    'Şu anda bir yanıt yazılıyor. Bitmesini bekleyin (veya durdurun), ardından yeniden deneyin.',
  'main.busy.docTask':
    'Bir belge görevi modeli kullanıyor. Bitmesini bekleyin veya görevi iptal edin, ardından ' +
    'yeniden deneyin.',
  'main.busy.skillRun':
    'Bir beceri bir belge üzerinde çalışıyor. Bitmesini bekleyin veya beceri çubuğundan iptal ' +
    'edin, ardından yeniden deneyin.',
  'main.busy.benchmark': 'Şu anda bir hız testi bu bilgisayarı ölçüyor. Birazdan yeniden deneyin.',
  'main.task.unknownKind': 'Bilinmeyen belge görevi.',
  'main.task.refusedChatStreaming':
    'Şu anda bir yanıt yazılıyor. Bitmesini bekleyin (veya yanıtı durdurun), ardından yeniden ' +
    'deneyin.',
  'main.task.comparePickTwo': 'Karşılaştırmak için tam olarak iki belge seçin.',
  'main.task.compareReindex':
    'Bu belgelerin karşılaştırılabilmesi için önce kısa bir yeniden dizinleme gerekiyor: en az ' +
    'biri farklı bir arama modeliyle hazırlanmış. Belgeler ekranını açıp “Yeniden dizinle” ' +
    'seçeneğini kullanın, ardından yeniden deneyin.',
  'main.task.documentNotReady':
    'Bu belgede henüz okunabilir metin yok. Önce belgeyi içe aktarın veya yeniden dizinleyin, ' +
    'ardından yeniden deneyin.',
  'main.task.genericFailure':
    'Görev tamamlanamadı. Modelin hâlâ çalıştığından emin olun, ardından yeniden deneyin.',
  'main.task.expired': 'Bu görev artık kullanılamıyor.',
  'main.task.translationTarget':
    'Çeviri için desteklenen bir kaynak dil ve farklı bir hedef dil seçin.',
  'main.task.sourceUnreadable':
    'Bu belgenin kayıtlı kopyası okunamadı. Belgeyi yeniden içe aktarın, ardından yeniden ' +
    'deneyin.',
  'main.task.needsOcr':
    'Metin tanıma için OCR dosyaları gerekir; bu dosyalar bu sürücüde yok. Dosyaları taranmış ' +
    'belgedeki veya Yapay zekâ modeli ekranındaki “OCR dosyalarını indir” düğmesiyle indirin ya ' +
    'da sürücüyü kendiniz kurduysanız “fetch-runtime --family ocr” komutuyla ekleyin.',
  'main.task.ocrUnavailable':
    'Metin tanıma (OCR) bu sürümde kullanılamıyor: OCR dosyaları bu sürücüde, ancak tanıma ' +
    'motoru başlatılamadı.',
  'main.task.ocrNotAScan':
    'Bu yolla yalnızca tarama olarak algılanan veya taranmış sayfalar içeren bir PDF aranabilir ' +
    'yapılabilir.',
  'main.task.ocrNoText':
    'Bu taramada okunabilir metin bulunamadı. Sayfalar boş veya çok bulanık olabilir.',
  'main.task.ocrFailed':
    'Bu tarama okunamadı. Belgenin hâlâ sürücüde olduğundan emin olun, ardından yeniden deneyin.',
  'main.task.documentBusyIngesting':
    'Bu belge hâlâ içe aktarılıyor veya yeniden dizinleniyor. Bu işlemin bitmesini bekleyin, ' +
    'ardından yeniden deneyin.',
  'main.task.pickOneTranslate': 'Çevirmek için tam olarak bir belge seçin.',
  'main.task.pickOneOcr': 'Aranabilir yapmak için tam olarak bir taranmış PDF seçin.',
  'main.task.pickOneSummarize': 'Özetlemek için tam olarak bir belge seçin.',
  'main.task.unavailable': 'Belge görevleri kullanılamıyor.',
  'main.task.workspaceLocked': 'Çalışma alanı kilitli. Belgelerle çalışmak için kilidini açın.',
  'main.download.policyDisabled': 'İndirmeler bu sürücünün ilkesi gereği kapalı.',
  'main.download.networkOff':
    'İnternet erişimi kapalı. Önce Ayarlar ekranında “İndirmeler ve güncellemeler için internet ' +
    'erişimine izin ver” seçeneğini açın.',
  'main.download.alreadyRunning': 'Başka bir indirme zaten sürüyor. Modeller tek tek indirilir.',
  'main.download.stoppedNetworkOff':
    'İnternet erişimi kapalı olduğu için süren indirme durdu. İndirmeyi tamamlamak için Ayarlar ' +
    'ekranında internet erişimini yeniden açın.',
  'main.download.noSource': '“{modelId}” modelinin manifest dosyasında indirme kaynağı yok.',
  'main.download.sourceWithdrawn':
    '“{modelId}” modelinin yayıncısı tam olarak bu dosyayı kaldırdı; bu yüzden dosya artık ' +
    'indirilemiyor ({reason}). Bu sürücüde zaten bulunan modeller çalışmaya devam eder.',
  'main.download.alreadyVerified': 'Bu model zaten indirildi ve doğrulandı.',
  'main.download.presentUnverified':
    'Bu modelin dosyası zaten mevcut. Manifest dosyasında henüz gerçek bir sağlama toplamı yok; ' +
    'bu yüzden dosya doğrulanamıyor. Sağlama toplamını “verify-models --generate” komutuyla ' +
    'oluşturun.',
  'main.download.licenseFirst': 'İndirmeden önce modelin lisansını ({license}) okuyup kabul edin.',
  'main.download.notEnoughSpace':
    'Bu sürücüde yeterli boş alan yok (gereken: {needed}, boş alan: {free}). Sürücüde yer açın ' +
    'veya daha küçük bir model seçin.',
  'main.download.unknownJob': 'Bilinmeyen indirme işi.',
  'main.download.checksumMismatch':
    'İndirilen dosya beklenen sağlama toplamıyla eşleşmediği için atıldı. Yeniden deneyin.',
  'main.download.fileMissing': 'İndirilen dosya doğrulanamadan kayboldu.',
  'main.download.httpFailed':
    'İndirme başlatılamadı ({reason}). Bağlantıyı kontrol edip yeniden deneyin.',
  'main.download.interrupted':
    'İndirme yarıda kesildi ({reason}). Tamamlanan kısım korunur; yeniden başlatıldığında ' +
    'kaldığı yerden devam eder.',
  'main.download.writeFailed':
    'Model dosyası bu sürücüye kaydedilemedi. Sürücünün dolu veya yazmaya karşı korumalı ' +
    'olmadığını kontrol edin, ardından yeniden deneyin.',
  'main.download.resumeDiscarded':
    'Sunucu dosyanın yanlış kısmını gönderdi; bu yüzden yarım kalan indirme atıldı. Yeniden ' +
    'başlatıldığında indirme baştan başlar.',
  'main.engine.alreadyRunning': 'Yapay zekâ motoru zaten indiriliyor.',
  'main.engine.noSources':
    'Bu sürücüde motor kaynağı bulunamadı (runtime-sources.yaml dosyası eksik).',
  'main.engine.noHostBuild':
    'Bu bilgisayar için kullanılabilir bir yapay zekâ motoru derlemesi yok.',
  'main.engine.alreadyInstalled': 'Yapay zekâ motoru zaten kurulu.',
  'main.engine.unknownJob': 'Bilinmeyen motor indirme işi.',
  'main.engine.checksumMismatch':
    'İndirilen motor beklenen sağlama toplamıyla eşleşmediği için atıldı. Yeniden deneyin.',
  'main.engine.fileMissing': 'İndirilen motor doğrulanamadan kayboldu.',
  'main.engine.unverifiablePlaceholder':
    'Bu yapay zekâ motoru kaynağında gerçek bir sağlama toplamı yok; bu yüzden indirme ' +
    'doğrulanamadı ve kurulmadı. Sürücü yanlış yapılandırılmış olabilir.',
  'main.engine.binaryMissing':
    'Motor indirildi ancak arşivden çıkarılamadı (arşiv yapısı değişmiş olabilir).',
  'main.engine.extractFailed':
    'Yapay zekâ motoru indirildi ancak arşivden çıkarılamadı. Yeniden deneyin.',
  'main.engine.httpFailed':
    'Motor indirmesi başlatılamadı ({reason}). Bağlantıyı kontrol edip yeniden deneyin.',
  'main.engine.interrupted': 'Motor indirmesi yarıda kesildi ({reason}). Yeniden deneyin.',
  'main.engine.runtimeRunning':
    'Bir model çalışırken yapay zekâ motoru değiştirilemez. Modeli Yapay zekâ modeli ekranında ' +
    'durdurun, ardından yeniden deneyin.',
  'main.engine.transcriptionRunning':
    'Ses yazıya dökülürken ses motoru değiştirilemez. İşlemin bitmesini bekleyin, ardından ' +
    'yeniden deneyin.',
  'main.engine.knowledgePackToolsRunning':
    'Bir paket sunulurken bilgi paketi araçları değiştirilemez. Çalışma alanını kilitleyin veya ' +
    'geçerli sorunun yanıtlanmasını bekleyin, ardından yeniden deneyin. Bu bildirim kaybolmazsa ' +
    'uygulamayı yeniden başlatın.',
  'main.engine.badRequest': 'Motor kurulum isteği anlaşılamadı. Yeniden deneyin.',
  'main.engine.nothingToRepair': 'Onarılacak bir şey yok: bu sürücüdeki motorda hasar bulunmadı.',
  'main.engine.nothingToUpdate':
    'Güncellenecek bir şey yok: bu sürücüdeki motorlar zaten bu uygulamanın kullandığı sürümde ' +
    'veya daha yeni.',
  'main.engine.updateBusy':
    'Yapay zekâ motoru şu anda kullanımda (bir yanıt, içe aktarma, çeviri veya belge görevi ' +
    'sürüyor). Bu işlem bittiğinde güncellemeyi yeniden deneyin.',
  'main.ocr.badRequest': 'OCR indirme isteği anlaşılamadı. Yeniden deneyin.',
  'main.ocr.alreadyRunning': 'OCR dosyaları zaten indiriliyor.',
  'main.ocr.noSources':
    'Bu sürücüde OCR dosyaları için bir indirme listesi yok. Dosyaları bunun yerine sürücü ' +
    'kurulum betikleriyle ekleyin (“fetch-runtime --family ocr”).',
  'main.ocr.sourcesMismatch':
    'Bu sürücüdeki OCR indirme listesi bu HilbertRaum sürümüyle eşleşmiyor; bu yüzden hiçbir şey ' +
    'indirilmedi. Dosyaları bunun yerine sürücü kurulum betikleriyle ekleyin (“fetch-runtime ' +
    '--family ocr”).',
  'main.ocr.alreadyInstalled':
    'OCR dosyaları zaten bu sürücüde. Metin tanıma hâlâ sunulmuyorsa HilbertRaum’u yeniden ' +
    'başlatın.',
  'main.ocr.unsafeFolder':
    'Bu sürücüdeki “ocr” klasörü sıradan bir klasör değil (başka bir konuma yönlendiriyor ' +
    'olabilir); bu yüzden hiçbir şey yazılmadı. Bunu “ocr” adlı sıradan bir klasörle değiştirin, ' +
    'ardından yeniden deneyin.',
  'main.ocr.writeFailed':
    'OCR dosyaları bu sürücüye kaydedilemedi. Sürücünün dolu veya yazmaya karşı korumalı ' +
    'olmadığını kontrol edin, ardından yeniden deneyin.',
  'main.ocr.downloadFailed':
    'OCR dosyaları indirilemedi. İnternet bağlantısını kontrol edin, ardından yeniden deneyin.',
  'main.ocr.checksumMismatch':
    'İndirilen bir OCR dosyası beklenen sağlama toplamıyla eşleşmediği için atıldı; bu sürücüde ' +
    'zaten bulunan dosyalar değiştirilmedi. Yeniden deneyin.',
  'main.ocr.readFailed':
    'Bu sürücüde zaten bulunan OCR dosyaları okunamadı: sürücü çıkarılmış olabilir veya ' +
    'dosyaları başka bir program kullanıyor olabilir. Sürücüyü kontrol edin, ardından yeniden ' +
    'deneyin.',
  'main.ocr.unknownJob':
    'Bu OCR indirmesi artık izlenmiyor. Dosyalar hâlâ eksikse indirmeyi yeniden başlatın.',
  'main.docs.locked': 'Çalışma alanı kilitli. Belgeleri yönetmek için kilidini açın.',
  'main.docs.processing': 'Bu belge hâlâ işleniyor. İçe aktarmanın bitmesini bekleyin.',
  'main.docs.tooManyPaths': 'Aynı anda çok fazla dosya seçildi. Bunun yerine bir klasör seçin.',
  'main.docs.taskRunning':
    'Bu belge için bir görev çalışıyor. Görevi iptal edin veya bitmesini bekleyin.',
  'main.docs.skillRunning':
    'Bu belge üzerinde bir beceri çalışıyor. Beceriyi iptal edin veya bitmesini bekleyin.',
  'main.docs.previewEncrypted': 'Bu belge şifreli; önizlemek için çalışma alanının kilidini açın.',
  'main.docs.previewGone':
    'Belge dosyası artık sürücüde değil. Önizlemek için belgeyi yeniden içe aktarın.',
  'main.docs.exportTextOnly':
    'Bu yolla yalnızca metin belgeleri (Markdown, TXT, CSV) dışa aktarılabilir.',
  'main.docs.exportEncrypted':
    'Bu belge şifreli; dışa aktarmak için çalışma alanının kilidini açın.',
  'main.docs.exportGone':
    'Belge dosyası artık sürücüde değil. Dışa aktarmak için belgeyi yeniden içe aktarın.',
  'main.docs.exportOriginalChanged':
    'Bu dosyanın yalnızca size ait kopyası hâlâ mevcut ve bu kopya içe aktarıldığından beri ' +
    'değişti; yani artık özgün dosya değil. Bunun yerine çıkarılan metni dışa aktarın.',
  'main.docs.noStoredTranscript':
    'Bu kayıt için henüz saklanmış bir transkript yok. Yeniden yazıya dökmek için kaydı yeniden ' +
    'dizinleyin.',
  'main.models.noManifests': 'Bu sürücüde model listesi bulunamadı: model-manifests klasörü eksik.',
  'main.models.autoSelected':
    'Bu model kurulduktan sonra otomatik olarak kullanılır; seçilecek bir şey yok.',
  'main.models.locked':
    'Çalışma alanı kilitli. Yapay zekâ modellerini yönetmek için kilidini açın.',
  'main.audit.locked': 'Çalışma alanı kilitli. Etkinlikleri görmek için kilidini açın.',
  'main.settings.locked': 'Çalışma alanı kilitli. Ayarları değiştirmek için kilidini açın.',
  'main.evidenceReviews.locked':
    'Çalışma alanı kilitli. Dayanak incelemeleri üzerinde çalışmak için kilidini açın.',
  'main.evidenceReviews.invalidRequest': 'Bu inceleme isteği geçerli değil.',
  'main.evidenceReviews.exportNotRecorded':
    'Dayanak paketi dışa aktarma geçmişine kaydedilemedi; bu yüzden dışa aktarılan dosya ' +
    'kaldırıldı. Hiçbir şey kaydedilmedi: dışa aktarmayı yeniden deneyin.',
  'main.evidenceReviews.exportFileNotRecorded':
    'Dayanak paketi dosyası kaydedildi, ancak dışa aktarma geçmişine kaydedilemedi ve ' +
    'kaldırılamadı. Dosyanın sağlama toplamı kayıtlı değil: paketi yeniden dışa aktarın ve ' +
    'dosyayı yenisiyle değiştirin.',
  'main.evidenceReviews.exportOutdated':
    'Bu inceleme güncel değil: inceleme başlatıldığından beri bir kaynak veya yanıt değişti. ' +
    'Dışa aktarmadan önce değişikliği incelemede onaylayın.',
  'main.settings.invalidPatch': 'Bu ayar değişikliği geçerli değil ve kaydedilmedi.',
  'main.dictation.locked': 'Çalışma alanı kilitli. Sesle dikteyi kullanmak için kilidini açın.',
  'main.dictation.silent':
    'Mikrofona ses ulaşmadı. Mikrofonun sessize alınmadığını ve sistem ayarlarında HilbertRaum ' +
    'için mikrofon izninin verildiğini kontrol edin, ardından yeniden deneyin.',
  'main.dictation.tooShort': 'Kayıt, konuşma içeremeyecek kadar kısaydı; yeniden deneyin.',
  'main.dictation.unavailable':
    'Sesle dikte bu sürücüde henüz kullanılamıyor; neyin eksik olduğunu Yapay zekâ modeli ' +
    'ekranında görebilirsiniz.',
  'main.dictation.failed': 'Bu kayıt yazıya dökülemedi; yeniden deneyin.',
  'main.dictation.tooLong':
    'Bu kayıt dikte için fazla uzun. Uzun kayıtlar için ses dosyasını bunun yerine belge olarak ' +
    'içe aktarın.',
  'main.dictation.busy': 'Son dikte hâlâ yazıya dökülüyor; biraz bekleyin.',
  'main.dictation.engineCannotRun':
    'Ses motoru bu bilgisayarda çalışamıyor. Neyin eksik olduğunu Yapay zekâ modeli ekranında ' +
    'görebilirsiniz.',
  'main.preflight.readOnly':
    'Bu sürücü salt okunur görünüyor, bu yüzden uygulama çalışma alanını oluşturamıyor. Farklı ' +
    'bir USB girişi deneyin veya sorun giderme kılavuzuna bakın.',
  'main.preflight.lowSpace':
    'Bu sürücüde boş alan azaldı. Yine de devam edebilirsiniz, ancak yer açana kadar büyük ' +
    'belgeler içe aktarılamayabilir.',
  'main.dialog.importDocuments': 'Belgeleri içe aktar',
  'main.dialog.importFolder': 'Belge klasörü içe aktar',
  'main.dialog.exportDocument': 'Belgeyi dışa aktar',
  'main.dialog.exportOriginal': 'Özgün dosyayı dışa aktar',
  'main.dialog.exportSummary': 'Özeti dışa aktar',
  'main.dialog.exportChat': 'Sohbet metnini dışa aktar',
  'main.dialog.exportTableCsv': 'Tabloyu CSV olarak dışa aktar',
  'main.dialog.exportCodeBlock': 'Kod bloğunu dosya olarak kaydet',
  'main.dialog.exportAudit': 'Etkinlik günlüğünü dışa aktar',
  'main.dialog.exportEvidencePack': 'Dayanak paketini dışa aktar',
  'main.dialog.exportLog': 'Tanılama günlüklerini kaydet',
  'main.dialog.filterDocuments': 'Belgeler',
  'main.dialog.filterAll': 'Tüm dosyalar',
  'main.zim.unavailable': 'Bilgi paketleri bu oturumda kullanılamıyor.',
  'main.zim.articleUnavailable':
    'Bu makale şu anda kullanılamadığı için kaydedilemedi. Paket devre dışı bırakılmış, ' +
    'kaldırılmış veya sürücüsü çıkarılmış olabilir.',
  'main.zim.saveFailed': 'Makale belgelerinize eklenemedi. Yeniden deneyin.',
  'main.zim.dialogTitle': 'Bilgi paketi ekle',
  'main.zim.filterZim': 'ZIM arşivleri',
  'main.dialog.chooseImage': 'Görsel seç',
  'main.dialog.filterImages': 'Görseller',
  'main.images.unsupportedType': 'Bu dosya türü desteklenmiyor. PNG, JPEG veya WEBP dosyası seçin.',
  'main.images.tooLarge': 'Bu görsel analiz için fazla büyük. Daha küçük bir görsel deneyin.',
  'main.dialog.importSkill': 'Beceri paketi içe aktar',
  'main.dialog.importSkillFolder': 'Beceri klasörü içe aktar',
  'main.dialog.exportSkill': 'Beceriyi dışa aktar',
  'main.dialog.filterSkill': 'Beceri paketi',
  'main.dialog.exportCsv': 'İşlemleri dışa aktar',
  'main.dialog.filterCsv': 'CSV dosyası',
  'main.dialog.exportJson': 'JSON olarak dışa aktar',
  'main.dialog.filterJson': 'JSON dosyası',
  'main.dialog.exportXml': 'XML olarak dışa aktar',
  'main.dialog.filterXml': 'XML dosyası',
  'main.dialog.exportRedacted': 'Karartılmış kopyayı kaydet',
  'main.dialog.exportEdited': 'Düzenlenmiş kopyayı kaydet',
  'main.dialog.filterText': 'Metin dosyası',
  'main.dialog.filterDocx': 'Word belgesi',
  'main.collections.builtinUndeletable': 'Yerleşik Kitaplık ve Geçici bölümleri silinemez.',
  'main.skills.locked': 'Çalışma alanı kilitli. Becerileri yönetmek için kilidini açın.',
  'main.skills.notPicked': 'Önce dosya seçiciyle beceri paketini seçin.',
  'main.skills.incompatible':
    'Bu beceri uygulamanın daha yeni bir sürümünü gerektiriyor. Kullanmak için uygulamayı ' +
    'güncelleyin.',
  'main.skills.run.unavailable': 'Bu becerinin aracı şu anda kullanılamıyor.',
  'main.skills.run.noDocument': 'Önce bu sohbete bir belge ekleyin, ardından yeniden deneyin.',
  'main.skills.run.busy':
    'Bir beceri zaten çalışıyor. Önce bitmesini bekleyin veya beceriyi iptal edin.',
  'main.skills.run.documentOutOfScope':
    'Bu belge, bu sohbetin belgeleri arasında değil. Bunlardan birini seçip yeniden deneyin.',
  // ---- Document organization — Documents screen sections + actions (plan §12) ----
  'docs.section.heading': 'Bölümler',
  'docs.section.library': 'Kitaplık',
  'docs.section.projects': 'Projeler',
  'docs.section.temporary': 'Geçici',
  'docs.section.generated': 'Oluşturulanlar',
  'docs.section.archived': 'Arşiv',
  'docs.section.all': 'Tüm belgeler',
  'docs.section.newProject': 'Yeni proje',
  'docs.mode.aria': 'Belgeler görünümü',
  'docs.mode.documents': 'Belgelerim',
  'docs.mode.packs': 'Bilgi paketleri',
  'docs.filter.placeholder': 'Ada göre filtrele…',
  'docs.filter.aria': 'Belgeleri ada göre filtrele',
  'docs.filter.noMatch': '“{query}” ile eşleşen belge yok.',
  'docs.empty.packsLine':
    'Veya bir bilgi paketi ekleyin; örneğin sohbetin yanıtlarında kullanabileceği çevrimdışı bir ' +
    'Wikipedia.',
  'docs.empty.packsAction': 'Bilgi paketleri',
  'docs.rail.hide': 'Bölümleri gizle',
  'docs.rail.show': 'Bölümleri göster',
  'docs.project.createTitle': 'Proje oluştur',
  'docs.project.namePlaceholder': 'Proje adı',
  'docs.project.nameAria': 'Proje adı',
  'docs.project.create': 'Oluştur',
  'docs.project.rename': 'Yeniden adlandır',
  'docs.project.renameTitle': 'Projeyi yeniden adlandır',
  'docs.project.archive': 'Arşivle',
  'docs.project.unarchive': 'Arşivden geri al',
  'docs.project.delete': 'Projeyi sil',
  'docs.project.deleteTitle': 'Bu proje silinsin mi?',
  'docs.project.deleteBody': 'Bu projedeki belgelere ne olacağını seçin:',
  'docs.project.deleteKeep': 'Yalnızca projeyi kaldır, belgelerini koru',
  'docs.project.deleteKeepHint': 'Belgeler Kitaplıkta ve diğer projelerde kalır.',
  'docs.project.deleteWith': 'Projeyi ve yalnızca burada bulunan belgeleri sil',
  'docs.project.deleteWithHint':
    'Yalnızca Kitaplıkta veya başka bir projede bulunmayan belgeler silinir. Kitaplıktaki ' +
    'belgelere hiçbir zaman dokunulmaz.',
  'docs.project.archivedNote':
    'Arşivlendi – kaynak olarak gizli; belgelerine başka yerlerden yine soru sorulabilir.',
  'docs.project.options': 'Proje seçenekleri',
  'docs.action.moveToProject': 'Projeye taşı…',
  'docs.action.addToLibrary': 'Kitaplıkta tut',
  'docs.action.removeFromProject': 'Bu projeden kaldır',
  'docs.action.markTemporary': 'Geçici olarak işaretle',
  'docs.action.markPermanent': 'Kalıcı olarak işaretle',
  'docs.action.archive': 'Arşivle',
  'docs.action.unarchive': 'Arşivden geri al',
  'docs.action.chooseProject': 'Bir proje seçin',
  'docs.chip.library': 'Kitaplık',
  'docs.chip.temporary': 'Geçici',
  'docs.chip.generated': 'Oluşturuldu',
  'docs.chip.archived': 'Arşivlendi',
  'docs.bulk.selected.one': '{count} seçili',
  'docs.bulk.selected.other': '{count} seçili',
  'docs.selectionAria': 'Seçili belgeler için işlemler',
  'docs.bulk.delete': 'Sil',
  'docs.bulk.deleteConfirm.title.one': '{count} belge silinsin mi?',
  'docs.bulk.deleteConfirm.title.other': '{count} belge silinsin mi?',
  'docs.bulk.deleteConfirm.body':
    'Bu işlem seçili belgeleri, çıkarılan metinlerini ve arama dizinlerini çalışma alanınızdan ' +
    'kalıcı olarak kaldırır. Çalışma alanının dışındaki özgün dosyalara dokunulmaz.',
  'docs.empty.section': 'Burada henüz bir şey yok.',
  // ---- Document organization — smart views (plan §7.6/§12.1, Phase E; regrouped §11.16) ----
  'docs.smart.recentlyAdded': 'Son eklenenler',
  'docs.smart.unfiled': 'Projesiz',
  'docs.smart.attention': 'Dikkat gerektirenler',
  'docs.smart.attentionTitle': 'İçe aktarılamayan ve yeniden dizinlenmesi gereken belgeler',
  'docs.smart.more': 'Diğer',
  'docs.provenance.staleBadge': 'Güncel değil',
  'docs.provenance.staleChanged':
    'Oluşturulduğundan beri bir kaynak değişti; güncellemek için yeniden çalıştırın.',
  'docs.provenance.staleRemoved':
    'Oluşturulduğundan beri bir kaynak kaldırıldı; güncellemek için yeniden çalıştırın.',
  // ---- Chat — composite source scope (multi-select picker + footer union, plan §13) ----
  'chat.scope.library': 'Kitaplık',
  'chat.scope.projectNamed': '“{name}” projesi',
  'chat.scope.projectCount.one': '{count} proje',
  'chat.scope.projectCount.other': '{count} proje',
  // ---- Knowledge packs (ZIM wave: ScopePopover / SourcesDisclosure / ArticleModal / PacksPanel) ----
  'chat.scope.packsTitle': 'Bilgi paketleri',
  'chat.scope.packUnavailable': 'kullanılamıyor',
  'chat.scope.packNamed': '“{name}” paketi',
  'chat.scope.packNamedState': '“{name}” paketi ({state})',
  'chat.scope.packCount.one': '{count} bilgi paketi',
  'chat.scope.packCount.other': '{count} bilgi paketi',
  'chat.scope.documentsToggle': 'Belgelerimde ara',
  'chat.scope.documentsToggleHint':
    'Kapalı: yanıtlar yalnızca işaretli bilgi paketlerinden gelir. Bu sohbete eklenen dosyalar ' +
    'yine kullanılır.',
  'chat.scope.documentsOffSuffix': 'belgeler kapalı',
  'chat.scope.documentsOffNoPacks': 'kaynak yok; belgeleri açın veya bir bilgi paketi işaretleyin',
  'chat.scope.packDisabled': 'devre dışı',
  'chat.scope.packRemoved': 'Kaldırılmış paket',
  'chat.scope.packLimit.one': 'Sohbet başına en fazla {count} bilgi paketi',
  'chat.scope.packLimit.other': 'Sohbet başına en fazla {count} bilgi paketi',
  // ---- Per-answer knowledge-pack outcomes (#301 P4, findings M6/M7 — PackOutcomesNotice) ----
  'chat.packs.outcome.summary':
    'Bilgi paketleri: {searched} paket arandı · {other} paket aranmadı veya başarısız oldu',
  'chat.packs.outcome.removedPack': 'kaldırılmış bir paket',
  'chat.packs.outcome.passages.one': '{count} metin bölümü',
  'chat.packs.outcome.passages.other': '{count} metin bölümü',
  'chat.packs.outcome.unknown': 'Bilgi paketleri: bu eski yanıt için sonuç kaydedilmemiş',
  'chat.packs.outcome.searched': 'arandı',
  'chat.packs.outcome.selection-limit': 'aranmadı: seçim sınırı (sohbet başına 12)',
  'chat.packs.outcome.removed': 'aranmadı: paket kaldırıldı',
  'chat.packs.outcome.disabled': 'aranmadı: paket devre dışı',
  'chat.packs.outcome.file-missing': 'aranmadı: dosya eksik',
  'chat.packs.outcome.identity-mismatch': 'aranmadı: bu konumda farklı bir arşiv var',
  'chat.packs.outcome.not-served': 'aranmadı: başka bir paketle ad çakışması',
  'chat.packs.outcome.not-searchable': 'aranmadı: tam metin dizini yok',
  'chat.packs.outcome.tools-missing': 'aranmadı: kiwix-tools kurulu değil',
  'chat.packs.outcome.mode':
    'aranmadı: belgenin tamamını okuyan yanıtlar yalnızca belgeyi kullanır',
  'chat.packs.outcome.search-failed': 'başarısız: arama yapılamadı',
  'chat.packs.outcome.read-failed': 'başarısız: hiçbir makale okunamadı',
  'chat.packs.outcome.timeout': 'başarısız: zaman aşımı',
  'chat.packs.outcome.deadline': 'aranmadı: bu soru için süre yetmedi',
  'chat.packs.outcome.server-restarted':
    'başarısız: paket sunucusu bu soru sırasında yeniden başladı',
  'chat.sources.openArticle': 'Makaleyi aç',
  'chat.article.title': 'Makale',
  'chat.article.from': 'Kaynak: {archive} (çevrimdışı kopya)',
  'chat.article.loading': 'Makale yükleniyor…',
  'chat.article.unavailable':
    'Bu makale şu anda kullanılamıyor. Paket devre dışı bırakılmış, kaldırılmış veya sürücüsü ' +
    'çıkarılmış olabilir.',
  'chat.article.partial': 'Bu makalenin yalnızca ilk kısmı gösterilebildi.',
  'chat.article.save': 'Belgelerime kaydet',
  'chat.article.saveAria': 'Belgelerime kaydet: {title}',
  'chat.article.saving': 'Belgelerinize kaydediliyor…',
  'chat.article.saved':
    'Belgelerinize “{title}” adıyla kaydedildi. Paket olmadan da aranabilir kalır.',
  'chat.article.alreadySaved': 'Bu makale belgelerinizde zaten “{title}” adıyla var.',
  // ---- #301 P6 (a11y pass; plan §9.23 (b)4/(b)6 and decision (c)5) — BEGIN -----------------
  'chat.scope.packMissing': 'dosya eksik',
  'chat.scope.packMismatch': 'bu konumda farklı bir arşiv var',
  'chat.scope.packNotSearchable': 'tam metin dizini yok',
  'chat.sources.openArticleNamed': 'Makaleyi aç: {title}',
  // ---- #301 P6 — END ------------------------------------------------------------------------
  'packs.add': 'Paket ekle…',
  'packs.addBusy': 'Ekleniyor…',
  'packs.refresh': 'Yenile',
  'packs.lead':
    'Sohbetin yanıt verirken kullanabileceği çevrimdışı başvuru arşivleri (ZIM dosyaları; ' +
    'örneğin çevrimdışı bir Wikipedia). Dosyalar bulundukları yerde kullanılır ve hiçbir zaman ' +
    'kopyalanmaz: dosyaları sürücüdeki zim klasörüne koyun veya buradan ekleyin.',
  'packs.summary.count.one': '{count} paket',
  'packs.summary.count.other': '{count} paket',
  'packs.summary.enabled.one': '{count} etkin',
  'packs.summary.enabled.other': '{count} etkin',
  'packs.summary.size': 'bu sürücüde {size}',
  'packs.loading': 'Paketler yükleniyor…',
  'packs.refreshing': 'Sürücüde paketler aranıyor…',
  'packs.emptyTitle': 'Henüz bilgi paketi yok',
  'packs.emptyLine':
    'Tek dosyalık bir .zim arşivini library.kiwix.org adresinden indirin, ardından buradan ' +
    'ekleyin veya sürücüdeki zim klasörüne kopyalayın.',
  'packs.copyLibrary': 'Kiwix kitaplığının adresini kopyala',
  'packs.copiedToast': 'library.kiwix.org kopyalandı',
  'packs.copyFailed': 'Kopyalanamadı; adres: library.kiwix.org',
  'packs.setup.title': 'Tek seferlik kurulum: bilgi paketi araçları',
  'packs.toolsMissing':
    'Bu sürücüde kiwix-tools programları kurulu değil; bu yüzden paket eklenemez ve paketlerde ' +
    'arama yapılamaz. Kurulum adımı için sorun giderme kılavuzundaki “The panel says kiwix-tools ' +
    'are missing” başlığına bakın.',
  'packs.tools.install': 'Bilgi paketi araçlarını kur…',
  'packs.tools.confirm.title': 'Bilgi paketi araçları kurulsun mu?',
  'packs.tools.confirm.explain':
    'Bilgi paketlerini (ZIM arşivlerini) sunan programlar olan kiwix-tools {version}, Kiwix ' +
    'projesinin sunucusundan indirilecek ve kullanılmadan önce doğrulanacak. Bu araçlar isteğe ' +
    'bağlıdır: sohbet ve belgeler onlar olmadan da çalışır.',
  'packs.tools.confirm.hint':
    'İndirilen dosyalar kullanılmadan önce doğrulanır; sizinle veya belgelerinizle ilgili hiçbir ' +
    'şey gönderilmez. Bu araçlar yalnızca bilgi paketleri için gerekir.',
  'packs.tools.confirm.ack': 'kiwix-tools lisans koşullarını ({license}) okudum ve kabul ediyorum',
  'packs.tools.confirm.start': 'İndirmeyi başlat',
  'packs.tools.sizeUnknown': 'Bilinmiyor',
  'packs.tools.progress': 'Bilgi paketi araçları kuruluyor… %{pct}',
  'packs.tools.downloadingNoTotal': 'Bilgi paketi araçları kuruluyor…',
  'packs.tools.verifying': 'Bilgi paketi araçları doğrulanıyor…',
  'packs.tools.extracting': 'Bilgi paketi araçları arşivden çıkarılıyor…',
  'packs.tools.failed': 'Bilgi paketi araçları kurulamadı.',
  'packs.tools.doneToast': 'Bilgi paketi araçları kuruldu',
  'packs.addedToast.one': 'Bilgi paketi eklendi',
  'packs.addedToast.other': '{count} bilgi paketi eklendi',
  'packs.addPartial': 'Eklenemeyen arşiv: {failed} / {total}.',
  'packs.addFailed.notAZim': 'Seçilen dosya okunabilir bir ZIM arşivi değil.',
  'packs.addFailed.toolsMissing':
    'Bu sürücüde kiwix-tools programları kurulu değil; bu yüzden paket eklenemez ve paketlerde ' +
    'arama yapılamaz. Kurulum adımı için sorun giderme kılavuzundaki “The panel says kiwix-tools ' +
    'are missing” başlığına bakın.',
  'packs.addFailed.manager':
    'Arşiv kiwix-manage tarafından okunamadı. Dosyanın eksiksiz olduğunu kontrol edip yeniden ' +
    'deneyin.',
  'packs.addFailed.pathUnsupported':
    'Windows’ta kiwix-manage bu arşivi okuyamıyor, çünkü dosyanın adı veya klasörü bir umlaut, ' +
    'aksanlı bir harf ya da başka bir ASCII dışı karakter (ç, ğ, ı, ş gibi) içeriyor. Dosyayı bu ' +
    'tür karakterler içermeyen bir adla sürücünün zim/ klasörüne kopyalayın ve yeniden ekleyin.',
  'packs.addFailed.other': 'Arşiv eklenemedi.',
  'packs.removedToast': 'Bilgi paketi kaldırıldı',
  'packs.articleCount.one': '{count} makale',
  'packs.articleCount.other': '{count} makale',
  'packs.state.enabled': 'Etkin',
  'packs.state.disabled': 'Devre dışı',
  'packs.state.missing': 'Dosya eksik',
  'packs.state.missingTitle': 'Arşiv dosyası bulunamadı. Sürücü takılı mı?',
  'packs.state.identityMismatch': 'Farklı arşiv',
  'packs.state.identityMismatchTitle':
    'Bu paketin konumundaki dosya farklı bir arşiv. Bu paketi kaldırıp dosyayı yeniden ekleyin.',
  'packs.state.notSearchable': 'Tam metin dizini yok',
  'packs.state.notSearchableTitle':
    'Bu arşivin tam metin arama dizini yok. Soru sorarken atlanır, ancak makaleleri okunabilir ' +
    'kalır.',
  'packs.state.notServed': 'Sunulmuyor',
  'packs.state.notServedTitle':
    'Dosya adı “{title}” paketinin dosya adıyla çakıştığı için yalnızca o paket sunuluyor; ' +
    'ikisini de kullanmak için bu dosyayı yeniden adlandırın.',
  'packs.state.notServedTitleUnknown':
    'Dosya adı başka bir paketin dosya adıyla çakıştığı için yalnızca o paket sunuluyor; ikisini ' +
    'de kullanmak için bu dosyayı yeniden adlandırın.',
  'packs.switchLabel': '{title} paketini sohbetlerde kullan',
  'packs.ask': 'Bu pakete sor',
  'packs.askTitle': 'Yalnızca bu paketten yanıt veren bir sohbet açar',
  'packs.rowMenu': 'Diğer işlemler: {title}',
  'packs.remove': 'Kaldır',
  'packs.listLabel': 'Bilgi paketleri',
  'packs.removeTitle': 'Bu bilgi paketi kaldırılsın mı?',
  'packs.removeConfirm': 'Paketi kaldır',
  'packs.removeBody':
    'Paket yalnızca HilbertRaum uygulamasından kaldırılır; sürücüdeki arşiv dosyasına ' +
    'dokunulmaz. Bu paketi kullanan sohbetler artık ondan bilgi almaz.',
  'chat.scope.docCount.one': '{count} belge',
  'chat.scope.docCount.other': '{count} belge',
  'chat.scope.filesInChat.one': 'bu sohbetteki {count} dosya',
  'chat.scope.filesInChat.other': 'bu sohbetteki {count} dosya',
  'chat.scope.sourcesTitle': 'Kaynaklarınızı seçin',
  'chat.scope.librarySource': 'Kitaplık',
  'chat.scope.librarySourceHint': 'Tüm bilgi tabanınız',
  'chat.scope.specificToggle': 'Belirli belgeler…',
  'chat.scope.allTap': 'Tüm belgeler',
  'chat.scope.attachmentsOnlyTap': 'Yalnızca bu sohbetteki dosyalar',
  'chat.scope.filesInChatLine': 'Bu sohbetteki dosyalar',
  'chat.scope.attachmentNotReadable': '{name} (henüz okunamıyor)',
  'chat.scope.attachmentFailedHint':
    'Henüz okunamayan bir dosya yanıtlara hiçbir şey katmaz. Nedenini ve ne yapmanız gerektiğini ' +
    'Belgeler ekranında görebilirsiniz.',
  'chat.scope.noProjects': 'Henüz proje yok',
  'chat.scope.noPacks': 'Bu sürücüde henüz bilgi paketi yok.',
  'chat.scope.addPacks': 'Paket ekle…',
  'chat.scope.archivedFallback': 'Bu proje arşivlendi; yanıtlar Kitaplığınızdan geliyor.',
  'chat.scope.answeringFrom': 'Yanıt kaynağı: {source}',
  'chat.scope.wholeLibrary.one': 'tüm kitaplığınız – {count} belge',
  'chat.scope.wholeLibrary.other': 'tüm kitaplığınız – {count} belge',
  'chat.scope.narrowTitle': 'Yalnızca bu dosyadan yanıt verilsin mi?',
  'chat.scope.narrowBody':
    '{name} eklendi. Yalnızca bu dosyaya mı sormak istersiniz, yoksa tüm kitaplığınızdan yanıt ' +
    'almaya devam etmek mi?',
  'chat.scope.narrowJust': 'Yalnızca bu dosya',
  'chat.scope.narrowWhole': 'Tüm kitaplık',
  // ---- Chat — attach / drag-drop a file into a chat (plan §11.2/§13.5, Phase C) ----
  'chat.attach.button': 'Dosya ekle',
  'chat.attach.drop': 'Bu sohbette kullanmak için dosyaları buraya bırakın',
  'chat.attach.processing': '{name} işleniyor…',
  'chat.attach.added': '{name} bu sohbete eklendi',
  'chat.attach.newDocChat': '{name} için yeni bir belge sohbeti başlatıldı',
  'chat.attach.failed': '{name} bu sohbete eklenemedi.',
  'chat.attach.dropUnsupported': 'Bu eklenemedi; bilgisayarınızda kayıtlı bir dosyayı sürükleyin.',
  'chat.attach.trackFailed':
    'Dosyanın içe aktarılması izlenemedi; sonucu Belgeler ekranında kontrol edin.',
  'chat.attach.scanned':
    '{name} bir tarama gibi görünüyor, bu yüzden henüz okunamıyor. Belgeler ekranında bu dosya ' +
    'için “Aranabilir yap (OCR)” düğmesini kullanın. Dosya ardından bu sohbete kendiliğinden ' +
    'katılır; yeniden eklemeniz gerekmez.',
  'chat.attach.photoNeedsOcr':
    '{name} bir sayfanın fotoğrafı; okunması için OCR dosyaları gerekiyor ve bu dosyalar henüz ' +
    'bu sürücüde yok. Belgeler ekranında “OCR dosyalarını indir” düğmesini, ardından bu dosya ' +
    'için “Yeniden dene” düğmesini kullanın. Dosya ardından bu sohbete kendiliğinden katılır; ' +
    'yeniden eklemeniz gerekmez.',
  'chat.attach.goToDocuments': 'Belgeler ekranına git',
  // ---- Images — "Ask about an image" (image-understanding §5/§11, Phase V3) ----
  'images.title': 'Görsel anlama',
  'images.empty.body':
    'Bir ekran görüntüsü, grafik, form, fiş veya fotoğraf hakkında soru sorun. Her şey yerelde ' +
    'kalır.',
  'images.avail.noModel': 'Görsel anlama için bu sürücüde yerel bir görsel modeli gerekir.',
  'images.avail.noRuntime': 'Görsel anlama için önce yapay zekâ motorunun kurulması gerekir.',
  'images.avail.incompatible':
    'Bu sürücüdeki görsel modeli daha yeni bir yapay zekâ motoru gerektiriyor.',
  'images.avail.cta': 'Yapay zekâ modeli ekranına git',
  'images.avail.ocrPointer':
    'Taranmış belgeler mi? Belgeler ekranındaki “Aranabilir yap (OCR)” düğmesini kullanın.',
  'images.drop.title': 'Bir görseli buraya bırakın',
  'images.drop.choose': 'veya bir görsel seç',
  'images.drop.types': 'PNG, JPEG veya WEBP',
  'images.drop.busy': 'Bir analiz çalışıyor. Yenisini başlatmak için bitmesini bekleyin.',
  'images.back': 'Analizlere dön',
  'images.preview.remove': 'Kaldır',
  'images.preview.replace': 'Değiştir',
  'images.preview.alt': 'Seçili görsel',
  'images.chip.summarize': 'Bu görseli özetle',
  'images.chip.summarize.prompt':
    'Bu görselin görünen içeriğini özetle. Önemli veya alışılmadık her şeyi belirt.',
  'images.chip.extractText': 'Görünen metni çıkar',
  'images.chip.extractText.prompt':
    'Görünen ve okunabilen metni çıkar. Yararlı olduğu yerlerde satır sonlarını koru. Net ' +
    'olmayan bir metin varsa belirt.',
  'images.chip.explainChart': 'Bu grafiği açıkla',
  'images.chip.explainChart.prompt':
    'Bu grafiğin ne gösteriyor gibi göründüğünü açıkla. Eksenleri, etiketleri, eğilimleri ve ' +
    'varsa belirsizlikleri belirt.',
  'images.chip.readForm': 'Bu formu oku',
  'images.chip.readForm.prompt':
    'Bu formda görünen önemli alanları ve değerleri belirle. Okunamayan yerler için “net değil” ' +
    'yaz.',
  'images.chip.importantDetails': 'Önemli ayrıntıları bul',
  'images.chip.importantDetails.prompt':
    'Görünen en önemli ayrıntıları listele. Görünmeyen hiçbir şey hakkında çıkarım yapma.',
  'images.chip.whatNotice': 'Neye dikkat etmeliyim?',
  'images.chip.whatNotice.prompt':
    'Bu görselde neye dikkat etmeliyim? Yalnızca en belirgin görünen öğeleri belirt.',
  'images.composer.placeholder': 'Bu görsel hakkında soru sorun…',
  'images.composer.ask': 'Sor',
  'images.answer.localNote': 'Seçili görselden yerel olarak oluşturuldu.',
  'images.answer.copy': 'Kopyala',
  'images.answer.copied': 'Kopyalandı',
  'images.answer.copyFailed': 'Panoya kopyalanamadı',
  'images.answer.tryAgain': 'Yeniden dene',
  'images.answer.reading': 'Görsel okunuyor…',
  'images.answer.starting': 'Görsel modeli başlatılıyor…',
  'images.answer.stop': 'Durdur',
  'images.answer.stopped': 'Durduruldu.',
  'images.err.tooLarge': 'Bu görsel analiz için fazla büyük. Daha küçük bir görsel deneyin.',
  'images.err.unsupported': 'Bu dosya türü desteklenmiyor. PNG, JPEG veya WEBP dosyası seçin.',
  'images.err.heic':
    'iPhone HEIC fotoğrafları henüz desteklenmiyor. Fotoğrafı önce JPEG biçimine dönüştürün.',
  'images.err.pdf':
    'Bu ekran PDF dosyası değil, tek bir görsel okur. Taranmış bir PDF için Belgeler ekranındaki ' +
    '“Aranabilir yap (OCR)” düğmesini kullanın.',
  'images.err.pdfAction': 'Belgeler ekranına git',
  'images.err.decodeFailed':
    'Bu görsel açılamadı. Hasarlı veya desteklenmeyen bir biçimde olabilir.',
  'images.err.multiDrop': 'Bir seferde tek bir görsel bırakın.',
  'images.err.runtimeFailed':
    'Görsel modeli başlatılamadı. Yeniden deneyin veya başka bir model seçin.',
  'images.err.engineCannotRun':
    'Yapay zekâ motoru bu bilgisayarda çalışamıyor. Neyin eksik olduğu Yapay zekâ modeli ' +
    'ekranında gösteriliyor.',
  'images.err.emptyResponse':
    'Bu görsel için yanıt gelmedi. Sorunuzu farklı bir şekilde sormayı deneyin.',
  'images.err.emptyQuestion': 'Önce görsel hakkında bir soru yazın.',
  'images.err.timedOut':
    'Bu işlem çok uzun sürüyor. Daha küçük bir görsel deneyin veya yeniden sorun.',
  'images.err.contextExceeded':
    'Bu sohbet, bu görsel için fazla uzadı. Daha kısa bir soru sorun veya yeni bir analiz ' +
    'başlatın.',
  'images.err.busy': 'Önceki soru üzerinde çalışılıyor…',
  'images.err.openFailed': 'Bu analiz açılamadı. Yeniden deneyin.',
  'images.err.deleteFailed': 'Bu analiz silinemedi. Yeniden deneyin.',
  'images.err.clearFailed': 'Geçmiş temizlenemedi. Yeniden deneyin.',
  'images.history.title': 'Geçmiş',
  'images.history.empty': 'Analiz ettiğiniz görseller burada görünür.',
  'images.history.running': 'Analiz çalışıyor…',
  'images.history.runningOpen': 'Çalışan analizi göster',
  'images.history.turns.one': '{count} soru',
  'images.history.turns.other': '{count} soru',
  'images.history.delete': 'Sil',
  'images.history.deleteAria': 'Sil: {title}',
  'images.history.deleted': 'Geçmişten kaldırıldı',
  'images.history.delete.title': 'Bu görsel silinsin mi?',
  'images.history.delete.confirm': 'Görseli sil',
  'images.history.delete.body': '“{title}” ve yanıtları bu sürücüden kalıcı olarak kaldırılacak.',
  'images.history.total': 'Toplam: {size}',
  'images.history.clear': 'Geçmişi temizle',
  'images.history.clear.title': 'Görsel geçmişi temizlensin mi?',
  'images.history.clear.confirm': 'Geçmişi temizle',
  'images.history.clear.body':
    'Kaydedilen tüm analizler ({size}) ve saklanan görselleri bu sürücüden kalıcı olarak ' +
    'kaldırılacak.',
  'images.history.cleared': 'Görsel geçmişi temizlendi',
  // ---- Translate screen (TranslateGemma wave, plan §2 D6, TG-4) ----
  'translate.title': 'Metin çevir',
  'translate.lead':
    'Metni yazın veya yapıştırın, dilleri seçin ve yerel olarak çevirin. Hiçbir şey bu sürücüden ' +
    'dışarı çıkmaz.',
  'translate.starting': 'Çeviri modeli hazırlanıyor…',
  'translate.avail.noModel': 'Çeviri için bu sürücüde çeviri modeli gerekir.',
  'translate.avail.hint':
    'Modeli Yapay zekâ modeli ekranında bir kez indirin; sonrasında çeviri tamamen çevrimdışı ' +
    'çalışır.',
  'translate.avail.cta': 'Yapay zekâ modeli ekranına git',
  'translate.from': 'Kaynak dil',
  'translate.to': 'Hedef dil',
  'translate.swap': 'Dillerin yerini değiştir',
  'translate.input.label': 'Çevrilecek metin',
  'translate.input.placeholder': 'Çevrilecek metni yazın veya yapıştırın…',
  'translate.action': 'Çevir',
  'translate.stop': 'Durdur',
  'translate.output.label': 'Çeviri',
  'translate.output.empty': 'Çeviri burada görünecek.',
  'translate.working': 'Çevriliyor…',
  'translate.copy': 'Kopyala',
  'translate.copied': 'Kopyalandı',
  'translate.device.gpu': 'Çeviri ekran kartında çalışıyor (GPU, {done} / {total} katman)',
  'translate.device.gpuUnknown': 'Çeviri ekran kartında çalışıyor (GPU)',
  'translate.device.gpuPartial':
    'Çeviri yalnızca kısmen ekran kartında çalışıyor ({done} / {total} katman): ekran kartı ' +
    'belleğinin büyük kısmı doluydu (bunun nedeni çoğunlukla sohbet modelidir); bu yüzden çeviri ' +
    'yaklaşık işlemci hızında çalışıyor',
  'translate.device.gpuNone':
    'Çeviri işlemcide çalışıyor: ekran kartı belleğinin tamamı doluydu (bunun nedeni çoğunlukla ' +
    'sohbet modelidir); bu yüzden ekran kartına hiç katman sığmadı (0 / {total} katman)',
  'translate.device.cpu': 'Çeviri işlemcide çalışıyor (CPU)',
  'translate.device.cpuBesideChat':
    'Çeviri işlemcide çalışıyor: ekran kartı belleğini sohbet modeli kullanıyor ve çeviri onun ' +
    'yanına sığmazdı',
  'translate.device.cpuChatStarting':
    'Çeviri işlemcide çalışıyor: o sırada bir sohbet modeli başlatılıyordu ve ekran kartı önce ' +
    'sohbet modeline verilir',
  'translate.device.cpuTooLarge':
    'Çeviri işlemcide çalışıyor: çeviri modeli bu ekran kartının belleğine sığmıyor',
  'translate.device.title':
    'Çeviri modelinin son başlatıldığında nerede çalıştığını gösterir. Model her başlatmada ' +
    'yeniden karar verir (son çeviriden yaklaşık 2 dakika sonra bellekten çıkarılır).',
  'translate.device.partialTitle':
    'Çeviri modelinin kartta daha fazla yer bulabilmesi için daha küçük bir sohbet modeli ' +
    'kullanın veya sohbet modelini çeviriden önce durdurun. Çeviri modeli, bir sonraki ' +
    'başlatmada (son çeviriden yaklaşık 2 dakika sonra) karttaki yerini yeniden belirler.',
  'translate.device.gpuNoneTitle':
    'Çeviri modelinin karta sığabilmesi için daha küçük bir sohbet modeli kullanın veya sohbet ' +
    'modelini çeviriden önce durdurun. Çeviri modeli, bir sonraki başlatmada (son çeviriden ' +
    'yaklaşık 2 dakika sonra) karttaki yerini yeniden belirler.',
  'translate.err.noModel':
    'Çeviri modeli artık kullanılamıyor. Kurmak için Yapay zekâ modeli ekranını açın.',
  'translate.err.badRequest':
    'Bir kaynak dil ve hedef dil seçin, ardından çevrilecek bir metin girin.',
  'translate.err.busy': 'Zaten bir çeviri çalışıyor. Bitmesini bekleyin, ardından yeniden deneyin.',
  'translate.err.docTaskBusy': 'Bir belge görevi çalışıyor. Bitmesini bekleyin, ardından çevirin.',
  'translate.err.runtimeFailed':
    'Çeviri modeli işlemi tamamlayamadı. Yeniden deneyin veya daha kısa bir metin deneyin.',
  'translate.err.startFailed':
    'Çeviri modeli başlatılamadı; cihazda boş bellek azalmış olabilir. Diğer uygulamaları ' +
    'kapatın veya HilbertRaum’u yeniden başlatın, ardından yeniden deneyin.',
  'translate.err.engineCannotRun':
    'Yapay zekâ motoru bu bilgisayarda çalışamıyor. Neyin eksik olduğu Yapay zekâ modeli ' +
    'ekranında gösteriliyor.',
  'translate.err.empty': 'Çeviri gelmedi. Yeniden deneyin veya metni farklı bir şekilde yazın.',
  'translate.err.sameLang': 'İki farklı dil seçin.',
  'translate.err.tooLong':
    'Metin burada çevrilemeyecek kadar uzun (200.000 karakterden fazla). Metni daha küçük ' +
    'kısımlara bölün veya bir dosya olarak kaydedip belge olarak çevirin.',
  // ---- Document drag-and-drop translation (TG-5, plan §2 D7) ----
  'translate.drop.title': 'Ya da çevirmek için bir belgeyi buraya bırakın',
  'translate.drop.choose': 'veya bir belge seç',
  'translate.drop.types': 'PDF, Word, Markdown veya metin: seçilen dile çevrilir.',
  'translate.file.importing': 'Belge okunuyor…',
  'translate.file.progress': 'Çevriliyor… ({done} / {total})',
  'translate.file.preparing': 'Çeviri hazırlanıyor: belge okunuyor…',
  'translate.file.saving': 'Çevrilen belge kaydediliyor…',
  'translate.file.truncated':
    'Çevirinin başı gösteriliyor; belgenin tamamı için çeviriyi dışa aktarın veya Belgeler ' +
    'ekranında açın.',
  'translate.file.export': 'Dışa aktar…',
  'translate.file.exported': 'Belge dışa aktarıldı',
  'translate.file.show': 'Belgeler ekranında göster',
  'translate.file.reset': 'Başka bir belge çevir',
  'translate.file.doneAnnounce': 'Belge çevirisi tamamlandı. Sonuç gösteriliyor.',
  'translate.file.gapPages.one':
    '⚠ Özgün belgenin şu sayfası çevrilemedi: {pages}. Okunabilir metin içermiyor (taranmış bir ' +
    'sayfa olabilir). Çıktıda bu boşluk işaretlidir.',
  'translate.file.gapPages.other':
    '⚠ Özgün belgenin şu sayfaları çevrilemedi: {pages}. Okunabilir metin içermiyorlar (taranmış ' +
    'sayfalar olabilir). Çıktıda her boşluk işaretlidir.',
  'translate.file.failedParts.one':
    '⚠ {count} kısım çevrilemedi; özgün metin çıktıda işaretli yerde korunuyor.',
  'translate.file.failedParts.other':
    '⚠ {count} kısım çevrilemedi; özgün metin çıktıda işaretli yerlerde korunuyor.',
  'translate.file.err.multiDrop': 'Bir seferde tek bir belge bırakın.',
  'translate.file.err.noPath':
    'Bu öğenin sürücüde bir dosyası yok. Bir klasörden belge sürükleyin veya “bir belge seç” ' +
    'düğmesini kullanın.',
  'translate.file.err.unsupported':
    'Bu dosya türü çevrilemez. PDF, Word, Markdown veya metin dosyası deneyin.',
  'translate.file.err.scanned':
    'Bu PDF, okunabilir metni olmayan bir tarama gibi görünüyor. Önce Belgeler ekranında ' +
    '“Aranabilir yap (OCR)” düğmesiyle aranabilir yapın, ardından çevirin.',
  'translate.file.err.scannedAction': 'Belgeler ekranına git',
  'translate.file.err.importFailed': 'Belge okunamadı. Yeniden deneyin.',
  'translate.file.err.runtimeFailed': 'Belge çevrilemedi. Yeniden deneyin.',
  // ---- Evidence review (EP-1 plan §7 — ReviewScreen.tsx + chat entry points) ----
  'review.action.start': 'Dayanakları incele',
  'review.action.continue': 'İncelemeye devam et',
  'review.entry.sources': 'Yanıtı ve kaynakları incele',
  'review.status.draft': 'Taslak',
  'review.status.ready': 'Hazır',
  'review.status.outdated': 'Güncel değil',
  'review.readonlyHint': 'Hazır olarak işaretlendi: düzenlemek için incelemeyi yeniden açın.',
  // ---- P4: Outdated banner + acknowledge (spec §15.5/§21.3/§28.6) ----
  'review.outdated.title': 'Bu inceleme güncel değil.',
  'review.outdated.answerChanged': 'Yanıt metni, incelemede kaydedilen durumla artık eşleşmiyor.',
  'review.outdated.coverageChanged':
    'Kaydedilen kapsam meta verileri, incelemede kaydedilen durumla artık eşleşmiyor.',
  'review.outdated.sourcesChanged.one':
    'Bu inceleme başlatıldığından beri {count} kaynak belge değişti.',
  'review.outdated.sourcesChanged.other':
    'Bu inceleme başlatıldığından beri {count} kaynak belge değişti.',
  'review.outdated.keepNote':
    'Kaydedilen kararlarınız değişmedi. İncelemeyi geçmişteki hâliyle koruyabilir, değişikliği ' +
    'onaylayabilir veya sohbette yeniden sorup yeni bir inceleme başlatabilirsiniz.',
  'review.outdated.acknowledge': 'Değişikliği onayla',
  'review.outdated.acknowledgedAt': 'Değişiklik onaylandı: {date}.',
  'review.outdated.exportHint': 'Dayanak paketini dışa aktarmadan önce değişikliği onaylayın.',
  'review.back': 'Sohbete dön',
  'review.rename': 'Yeniden adlandır',
  'review.rename.label': 'İnceleme başlığı',
  'review.rename.save': 'Kaydet',
  'review.loading': 'İnceleme açılıyor…',
  'review.notFound': 'Bu inceleme bulunamadı. Silinmiş olabilir.',
  'review.question.toggle': 'Soru',
  'review.answerPane.aria': 'İncelenen yanıt',
  'review.autosave.saving': 'Kaydediliyor…',
  'review.autosave.saved': 'Kaydedildi',
  'review.autosave.error': 'Bazı değişiklikler henüz kaydedilemedi.',
  'review.autosave.retry': 'Yeniden dene',
  'review.evidence.title': 'Dayanaklar',
  'review.evidence.captionRelevance':
    'Gösterilen kaynaklar, bu yanıt için yerel yapay zekâ modeline verilen alıntılardır.',
  'review.evidence.captionWholeDoc':
    'Bu yanıt, belgenin tamamının analiziyle elde edildi. Gösterilen bölümler köken bilgisidir; ' +
    'cümle düzeyinde kaynak atfı yok.',
  'review.evidence.captionStructured':
    'Bu yanıt, yerel olarak çıkarılan verileri kullandı. Verilerin çıkarıldığı kaynak metin ' +
    'bölümleri aşağıda gösteriliyor.',
  'review.evidence.none':
    'Bu yanıt için kaydedilmiş kaynak alıntısı yok. Genel bir inceleme kaydedebilirsiniz, ancak ' +
    'kaynak düzeyinde inceleme yapılamaz.',
  'review.disclaimer':
    'Kaynak atfı, bir bilginin nereden geldiğini gösterir. Tek başına yanıtın doğru olduğunu ' +
    'kanıtlamaz.',
  'review.evidence.filterLabel': 'Kaynakları filtrele',
  'review.evidence.filterPlaceholder': 'Başlığa veya metne göre filtreleyin…',
  'review.evidence.filterClear': 'Filtreyi temizle',
  'review.evidence.filterNone': 'Filtrenizle eşleşen kaynak yok.',
  'review.evidence.shownCount': 'Gösterilen kaynak: {shown} / {total}',
  'review.evidence.more.one': 've {count} kaynak daha',
  'review.evidence.more.other': 've {count} kaynak daha',
  'review.evidence.linkingItem': 'İnceleme maddesi {n} için dayanaklar bağlanıyor',
  'review.source.kind.direct_excerpt': 'Doğrudan alıntı',
  'review.source.kind.whole_document_provenance': 'Belgenin tamamının analizine dayanan köken',
  'review.source.kind.structured_record': 'Çıkarılan kayıt',
  'review.source.unresolved': 'Kaynağın kimliği belirlenemedi',
  'review.source.archive':
    'Bilgi paketi makalesi – kimliği ve içeriği çalışma alanıyla karşılaştırılarak kontrol ' +
    'edilemez',
  'review.source.missingAtCreation': 'Bu inceleme başlatıldığında kaynak mevcut değildi',
  'review.source.changed': 'Bu inceleme başlatıldığından beri kaynak belge değişti',
  'review.source.missingNow':
    'Bu kaynak artık çalışma alanında yok. Kaydedilen alıntı bu incelemede kalır.',
  'review.source.cannotVerify': 'Bu kaynağın güncel durumu kontrol edilemiyor',
  'review.sourceContext.open': 'Kaynağı bağlamında aç',
  'review.sourceContext.title': 'Kaynağın bağlamı',
  'review.sourceContext.loading': 'Kayıtlı metin açılıyor…',
  'review.sourceContext.failed': 'Bu kaynağın kayıtlı metni açılamadı.',
  'review.sourceContext.hashMatch':
    'Kayıtlı belgenin sağlama toplamı, incelemede kaydedilen durumla eşleşiyor.',
  'review.sourceContext.hashMismatch': 'Bu inceleme başlatıldığından beri kaynak belge değişti.',
  'review.sourceContext.hashUnknown':
    'Belgenin güncel durumu, incelemede kaydedilen durumla karşılaştırılamıyor.',
  'review.sourceContext.missing':
    'Bu kaynak, yanıt oluşturulduğunda vardı, ancak artık çalışma alanında yok. Kaydedilen ' +
    'alıntı, varsa bu incelemede kalır.',
  'review.sourceContext.notLocated':
    'Kaydedilen alıntı, güncel kayıtlı metinde bulunamadı. Aşağıda, inceleme başlatıldığında ' +
    'kaydedildiği hâliyle gösteriliyor.',
  'review.sourceContext.storedNote':
    'Bağlam, içe aktarma sırasında çıkarılan kayıtlı metinden gelir; kaynak dosyanın kendisi ' +
    'açılmaz.',
  'review.sourceContext.excerptHeading': 'Kaydedilen alıntı',
  'review.link.add': 'Maddeye bağla',
  'review.link.remove': 'Bağlantıyı kaldır',
  'review.link.cited': 'Yanıtta atıf yapıldı',
  'review.link.reviewer': 'İncelemede bağlandı',
  'review.link.selectHint':
    'Dayanak bağlamak veya bağlantısını kaldırmak için bir inceleme maddesi seçin.',
  'review.relation.label': 'İlişki',
  'review.relation.none': 'Belirtilmedi',
  'review.relation.supports': 'Dayanak sağlar',
  'review.relation.qualifies': 'Sınırlandırır',
  'review.relation.contradicts': 'Çelişir',
  'review.relation.context': 'Yalnızca bağlam',
  'review.item.aria': 'İnceleme maddesi {n}',
  'review.item.noMarker': 'Bu metinde doğrudan kaynak atfı yok',
  'review.item.wholeDocDerived': 'Belgenin tamamının analiziyle elde edildi',
  'review.item.noteLabel': 'Not',
  'review.item.notePlaceholder': 'Not ekleyin (isteğe bağlı)',
  'review.item.viewEvidence': 'Dayanakları göster',
  // ---- P5 reviewer text selections (spec §12.1 "Review separately"; plan §10) ----
  'review.selection.start': 'Bir metin bölümünü ayrı olarak incele',
  'review.selection.hint':
    'Aşağıdaki özgün metinde (biçimlendirme olmadan gösterilir) metin bölümünü seçin, ardından ' +
    '“Ayrı olarak incele” düğmesini kullanın.',
  'review.selection.surfaceAria': 'İnceleme maddesi {n}: özgün metin',
  'review.selection.add': 'Ayrı olarak incele',
  'review.selection.close': 'Tamam',
  'review.selection.added': 'Metin bölümü ayrı bir inceleme maddesi olarak eklendi.',
  'review.selection.refused': 'Bu seçim eklenemedi. Metin bölümünü yeniden seçip yeniden deneyin.',
  'review.item.selectionTag': 'İncelemede seçilen metin',
  'review.selection.remove': 'Seçimi kaldır',
  'review.decision.groupAria': 'Karar',
  'review.decision.supported': 'İncelendi – dayanağı var',
  'review.decision.partly_supported': 'İncelendi – kısmen dayanağı var',
  'review.decision.not_supported': 'İncelendi – dayanağı yok',
  'review.decision.follow_up': 'Takip gerekiyor',
  'review.decision.not_reviewed': 'İncelenmedi',
  'review.decision.not_applicable': 'Uygulanamaz',
  'review.bulk.menu': 'Toplu işlemler',
  'review.bulk.headingsNa': 'Başlıkları “Uygulanamaz” olarak işaretle',
  'review.bulk.followUp': 'Karar verilmeyenleri “Takip gerekiyor” olarak işaretle',
  'review.bulk.clear': 'Tüm kararları temizle',
  'review.bulk.clearConfirmTitle': 'Tüm kararlar temizlensin mi?',
  'review.bulk.clearConfirmBody':
    'Bu incelemedeki her karar “İncelenmedi” durumuna döner. Notlar korunur.',
  'review.bulk.clearConfirm': 'Kararları temizle',
  'review.progress': 'Karar verilen: {decided} / {required}',
  'review.progress.followUps.one': 'Takip gerekiyor: {count}',
  'review.progress.followUps.other': 'Takip gerekiyor: {count}',
  'review.footer.summary': 'İnceleme özeti',
  'review.summary.status': 'Durum',
  'review.summary.decisions': 'Kararlar',
  'review.summary.sources': 'Kaynaklar',
  'review.summary.sourcesCount.one': '{count} kaynak',
  'review.summary.sourcesCount.other': '{count} kaynak',
  'review.summary.sourcesUnresolved.one': '{count} kaynağın kimliği belirlenemedi',
  'review.summary.sourcesUnresolved.other': '{count} kaynağın kimliği belirlenemedi',
  'review.summary.sourcesArchive.one':
    '{count} kaynak bir bilgi paketi makalesidir ve çalışma alanıyla karşılaştırılarak kontrol ' +
    'edilemez',
  'review.summary.sourcesArchive.other':
    '{count} kaynak bilgi paketi makalesidir ve çalışma alanıyla karşılaştırılarak kontrol ' +
    'edilemez',
  'review.summary.sourcesMissing.one': 'Bu inceleme başlatıldığında {count} kaynak mevcut değildi',
  'review.summary.sourcesMissing.other':
    'Bu inceleme başlatıldığında {count} kaynak mevcut değildi',
  'review.summary.sourcesChangedNow.one':
    'Bu inceleme başlatıldığından beri {count} kaynak belge değişti',
  'review.summary.sourcesChangedNow.other':
    'Bu inceleme başlatıldığından beri {count} kaynak belge değişti',
  'review.summary.sourcesMissingNow.one': '{count} kaynak belge artık çalışma alanında yok',
  'review.summary.sourcesMissingNow.other': '{count} kaynak belge artık çalışma alanında yok',
  'review.summary.truncated': 'Oluşturulan yanıt eksik olabilir: modelin çıktı sınırında kesildi.',
  'review.summary.stopped.model':
    'Oluşturulan yanıt eksik: yapay zekâ modeli, yanıt bitmeden durduruldu veya değiştirildi.',
  'review.summary.stopped.user': 'Oluşturulan yanıt eksik: yanıt bitmeden durduruldu.',
  'review.summary.stopped.lock':
    'Oluşturulan yanıt eksik: yanıt bitmeden çalışma alanı kilitlendi veya uygulama kapatıldı.',
  'review.summary.generation': 'Oluşturma ayrıntıları',
  'review.summary.model': 'Model',
  'review.summary.generatedAt': 'Oluşturulma zamanı',
  'review.summary.appVersion': 'Uygulama sürümü',
  'review.summary.skill': 'Beceri',
  'review.summary.unavailable': 'Mevcut değil',
  'review.summary.reviewerLabel': 'İnceleyen',
  'review.summary.reviewerPlaceholder': 'Adınız veya bir etiket (isteğe bağlı)',
  'review.summary.generalNote': 'Genel not',
  'review.summary.generalNotePlaceholder': 'Genel gözlemler (isteğe bağlı)',
  'review.summary.exports': 'Dışa aktarma geçmişi',
  'review.summary.markReady': 'Hazır olarak işaretle',
  'review.summary.reopen': 'İncelemeyi yeniden aç',
  'review.summary.gateHint':
    'İncelemenin hazır olarak işaretlenebilmesi için her yanıt bloğunda bir karar gerekir (karar ' +
    'verilen: {decided} / {required}). “Uygulanamaz” da karar sayılır.',
  'review.toast.ready': 'İnceleme hazır olarak işaretlendi.',
  'review.completedAt': 'Hazır olarak işaretlendi: {date}',
  'review.deleteWithConversation.one': 'Bu sohbete bağlı {count} dayanak incelemesi de silinecek.',
  'review.deleteWithConversation.other':
    'Bu sohbete bağlı {count} dayanak incelemesi de silinecek.',
  'review.deleteWithConversation.unknown':
    'Bu sohbete bağlı dayanak incelemeleri varsa onlar da silinecek.',
  // ---- Evidence-pack export (EP-1 plan §8 — summary panel + status line) ----
  'review.status.lastExported': 'Son dışa aktarma: {date}',
  'review.export.action': 'Dayanak paketi oluştur',
  'review.export.title': 'Dayanak paketini dışa aktar',
  'review.export.encryptionWarning':
    'Dışa aktarılan bu dosya, şifreli HilbertRaum çalışma alanının dışında saklanır ve çalışma ' +
    'alanı parolanızla korunmaz.',
  'review.export.packLanguage.en': 'Bu paket İngilizce yazılacak.',
  'review.export.packLanguage.de': 'Bu paket Almanca yazılacak.',
  'review.export.options': 'Pakete dahil et',
  'review.export.optNotes': 'İnceleme notları',
  'review.export.optExcerpts': 'Kaynak alıntıları',
  'review.export.optHashes': 'Belge sağlama toplamları',
  'review.export.optUnreviewed': 'İncelenmemiş maddeler',
  'review.export.optTechnical': 'Teknik ayrıntılar',
  'review.export.format': 'Dosya biçimi',
  'review.export.formatHtml': 'HTML – bağımsız web sayfası',
  'review.export.formatPdf': 'PDF – yazdırmaya hazır (A4)',
  'review.export.confirm': 'Paketi dışa aktar…',
  'review.export.cancel': 'Kapat',
  'review.export.done': 'Dayanak paketi dışa aktarıldı.',
  'review.export.error': 'Dayanak paketi dışa aktarılamadı. Hiçbir dosya yazılmadı.',
  'review.export.copyHash': 'SHA-256 değerini kopyala',
  'review.export.hashCopied': 'SHA-256 değeri panoya kopyalandı.'
}
