import type { UiCatalog } from './languages'

// The SPANISH catalog. Style: docs/design-guidelines.md §7 "Spanish microcopy".
// Neutral international Spanish; informal «tú» in lower case, never «usted», «vosotros» or voseo;
// nothing agrees with the user's gender. HilbertRaum, "HilbertRaum Lite" and
// "HilbertRaum AI Kit" are never translated; language names in the picker stay native.
//
// Glossary (keep terms consistent across ALL Spanish copy):
//   workspace                  → espacio de trabajo
//   drive                      → unidad            (computer → equipo; device → dispositivo)
//   vault / encrypted workspace→ espacio de trabajo cifrado   (cifrar, never «encriptar»)
//   model                      → modelo (AI model → modelo de IA)
//   document                   → documento         (file → archivo)
//   re-index                   → reindexar
//   offline                    → sin conexión
//   "Ask my documents"         → «Preguntar a mis documentos»
//   lock / unlock              → bloquear / desbloquear
//   password                   → contraseña
//   settings                   → Ajustes
//   plaintext (developer) mode → sin cifrar (desarrollo)
//
// EP-1 review glossary (MIRROR of design-guidelines §7; change BOTH together):
//   evidence                   → evidencia — never «prueba»; supported → respaldado
//                                (verb «respaldar»); «por sí sola no demuestra»
//   review (the artifact)      → revisión (evidence review → revisión de evidencia)
//   review item                → punto de revisión
//   evidence pack              → paquete de evidencia
//   citation / source marker   → referencia a la fuente / marcador de fuente (never «cita»)
//   whole-document provenance  → procedencia de un análisis del documento completo; the
//                                negation is always «no son referencias a frases concretas»
//   direct excerpt             → extracto directo
//   source (document)          → fuente / documento fuente
//   reviewer                   → «Revisado por» (label) / la persona que revisa (prose)
//   mark ready / reopen        → marcar la revisión como lista / reabrir la revisión
//   outdated                   → desactualizada
//   review creation            → crear la revisión (the ANSWER is «generada»; never mix)
//
// Typed `UiCatalog<'es'>` (i18n record D-L10): a missing, misspelt or extra key is a
// `npm run typecheck` failure. `packExport.*` is not part of it: evidence packs stay English
// or German (D-L11).

export const es: UiCatalog<'es'> = {
  // ---- App shell (App.tsx) ----
  'nav.aria': 'Navegación principal',
  'nav.home': 'Inicio',
  'nav.chat': 'Chat',
  'nav.documents': 'Documentos',
  'nav.translate': 'Traducir',
  'nav.images': 'Imágenes',
  'nav.models': 'Modelo de IA',
  'nav.performance': 'Rendimiento',
  'nav.settings': 'Ajustes',
  'app.lockNow': 'Bloquear ahora',
  'app.lockNowTitle': 'Volver a cifrar y bloquear el espacio de trabajo',
  'app.noticeDetails': 'Detalles',
  'app.noticeGoToModels': 'Ir a Modelo de IA',
  'app.fatal.title': 'No se pudo iniciar la aplicación',
  'app.fatal.hintBefore':
    'El servicio local de la aplicación no se inició, así que no se puede cargar nada. Reinicia ' +
    'la aplicación; si el problema se repite, abre ',
  'app.fatal.hintAfter': ' en tu unidad y lee «docs/troubleshooting.md».',
  'app.loadingWorkspace': 'Cargando el espacio de trabajo…',
  'app.loadingScreen': 'Cargando…',
  // ---- Error boundary (ErrorBoundary.tsx — audit FE-1) ----
  'errorBoundary.title': 'Algo salió mal en esta pantalla',
  'errorBoundary.body':
    'Esta pantalla tuvo un problema inesperado. Tu trabajo y tus datos están a salvo: no se ' +
    'perdió nada. Vuelve a intentarlo o ve a Inicio.',
  'errorBoundary.retry': 'Volver a intentarlo',
  'errorBoundary.home': 'Ir a Inicio',
  'errorBoundary.app.title': 'La aplicación tuvo un problema',
  'errorBoundary.app.body':
    'Ocurrió algo inesperado. Tus datos en la unidad están a salvo. Vuelve a cargar la ' +
    'aplicación para continuar.',
  'errorBoundary.app.reload': 'Volver a cargar',
  // ---- Home (HomeScreen.tsx) ----
  'home.headline.ready': 'Todo listo para chatear.',
  'home.headline.starting': 'Preparando todo…',
  'home.headline.almost': 'Casi todo listo.',
  'home.lead':
    'Un espacio de trabajo de IA privado y sin conexión. Tus preguntas, documentos e historial ' +
    'de chat se quedan en este dispositivo.',
  'home.preflight.continue':
    'Puedes continuar de todos modos. Si la aplicación no se abre, lee la guía de solución de ' +
    'problemas que está en la carpeta {folder} de la unidad.',
  'home.moved.restored':
    'Esta unidad se usó por última vez en otro equipo. Los valores de este equipo son de una ' +
    'comprobación anterior, del {when}: esta vez no se midió nada.',
  'home.moved.restoredUndated':
    'Esta unidad se usó por última vez en otro equipo. Los valores de este equipo son de una ' +
    'comprobación anterior: esta vez no se midió nada.',
  'home.moved.measuring':
    'Es la primera vez que se usa esta unidad en este equipo. Hay una comprobación en curso en ' +
    'segundo plano; la pantalla Rendimiento mostrará los valores cuando termine.',
  'home.moved.owed':
    'Esta unidad no se ha comprobado todavía en este equipo, así que no hay valores.',
  'home.checking': 'Comprobando…',
  'home.workspace.label': 'Espacio de trabajo',
  'home.workspace.encrypted': 'Cifrado: se bloquea con tu contraseña al cerrar la aplicación',
  'home.workspace.plaintext': 'Sin cifrar (modo de desarrollo)',
  'home.workspace.badgeProtected': 'Protegido',
  'home.workspace.badgeDeveloper': 'Desarrollo',
  'home.model.label': 'Modelo de IA',
  'home.model.fallbackName': 'Tu modelo',
  'home.model.running': '{model} se está ejecutando en este dispositivo',
  'home.model.selected': 'Modelo seleccionado: {model} (puede que aún se esté cargando)',
  'home.model.none': 'Todavía no hay ningún modelo seleccionado',
  'home.model.badgeRunning': 'En ejecución',
  'home.model.badgeStarting': 'Iniciando',
  'home.model.badgeNeedsModel': 'Falta un modelo',
  'home.model.open': 'Ir a Modelo de IA',
  'home.model.engineCannotRun':
    'El motor de IA no puede funcionar en este equipo: las respuestas son simuladas',
  'home.model.badgeEngine': 'No se ejecuta',
  'home.model.demo':
    '{model} se está ejecutando en modo de demostración: las respuestas son simuladas',
  'home.model.badgeDemo': 'Demostración',
  'home.model.choose': 'Elegir un modelo',
  'home.docs.label': 'Documentos',
  'home.docs.none': 'Todavía no hay documentos: agrega algunos para hacer preguntas sobre ellos',
  'home.docsReady.one': '{count} documento listo para tus preguntas',
  'home.docsReady.many': '{count} de documentos listos para tus preguntas',
  'home.docsReady.other': '{count} documentos listos para tus preguntas',
  'home.docs.badgeReady': 'Listo',
  'home.docs.badgeNone': 'Ninguno aún',
  'home.docs.add': 'Agregar documentos',
  'home.packs.label': 'Paquetes de conocimiento',
  'home.packsReady.one': '{count} paquete de conocimiento listo para tus preguntas',
  'home.packsReady.many': '{count} de paquetes de conocimiento listos para tus preguntas',
  'home.packsReady.other': '{count} paquetes de conocimiento listos para tus preguntas',
  'home.packs.none':
    'Todavía no hay paquetes: agrega una Wikipedia sin conexión para hacer preguntas generales',
  'home.packs.noneReady':
    'Ningún paquete está listo para preguntas: comprueba su estado en Documentos',
  'home.packs.badgeNoneReady': 'Ninguno listo',
  'home.packs.add': 'Agregar paquetes',
  'home.packs.open': 'Abrir paquetes de conocimiento',
  'home.actions.startChat': 'Empezar a chatear',
  'home.actions.askDocs': 'Preguntar a mis documentos',
  // ---- Chat (ChatScreen.tsx) ----
  'chat.title': 'Chat',
  'chat.noModel.title': 'No hay ningún modelo en ejecución',
  'chat.noModel.startingTitle': 'El modelo de IA se está iniciando',
  'chat.noModel.hintBefore':
    'El chat y las preguntas sobre documentos necesitan un modelo cargado. Abre la pantalla ' +
    'Modelo de IA, elige un modelo descargado y luego selecciona ',
  'chat.noModel.hintAction': 'Usar este modelo',
  'chat.noModel.hintAfter':
    '. Nada sale de tu equipo: no se descarga ni se envía nada por internet.',
  'chat.noModel.stillLoading':
    'Si acabas de abrir la aplicación, puede que el modelo que elegiste todavía se esté ' +
    'cargando: esta pantalla continuará automáticamente cuando esté listo.',
  'chat.noModel.starting':
    'Tu modelo se está iniciando: los modelos grandes tardan un poco en cargarse. Esta pantalla ' +
    'continuará automáticamente cuando esté listo.',
  'chat.noModel.startingProgress':
    'Tu modelo se está iniciando: se está leyendo el archivo del modelo ({gb} GB) y va ' +
    'aproximadamente por el {pct}\u00A0%. Esta pantalla continuará automáticamente cuando esté ' +
    'listo.',
  'chat.noModel.open': 'Ir a Modelo de IA',
  'chat.noModel.recheck': 'Volver a comprobar',
  'chat.empty.title': 'Haz una pregunta general o sobre tus documentos.',
  'chat.empty.lineDocuments': 'Las respuestas salen de tus documentos e indican sus fuentes.',
  'chat.empty.lineChat':
    'Las respuestas se generan con el modelo de esta unidad: nada sale de este dispositivo.',
  'chat.empty.fillTitle': 'Insertar en el cuadro de mensaje',
  'chat.empty.addDocs': 'Agregar documentos para preguntar sobre ellos',
  'chat.exampleChat.explain': 'Explica un concepto con palabras sencillas',
  'chat.exampleChat.draftEmail': 'Ayúdame a escribir un correo cortés',
  'chat.exampleChat.brainstorm': 'Propón ideas para un proyecto',
  'chat.example.summarize': 'Resume este documento',
  'chat.example.paymentTerms': '¿Cuáles son las condiciones de pago?',
  'chat.example.indemnity': 'Busca cada mención de «indemnización»',
  'chat.modeAria': 'Modo de chat',
  'chat.mode.chat': 'Chat',
  'chat.mode.documents': 'Preguntar a mis documentos',
  'chat.listShow': 'Mostrar la lista de conversaciones',
  'chat.runtime.gpu': '{model} · GPU ({name})',
  'chat.runtime.cpu': '{model} · procesador',
  'chat.runtime.cpuCompat': '{model} · procesador (modo de compatibilidad)',
  'chat.runtime.demo': '{model} · modo de demostración',
  'chat.runtime.title':
    'El modelo de IA que responde en este chat y si se ejecuta en la tarjeta gráfica (GPU) o en ' +
    'el procesador (CPU). Detalles: Ajustes → Diagnóstico.',
  'chat.runtime.compatTitle':
    'El modo de compatibilidad está activado por estabilidad, así que las respuestas se generan ' +
    'en el procesador y pueden ser más lentas. Puedes volver a probar la tarjeta gráfica en ' +
    'Ajustes → Diagnóstico.',
  'chat.convOptions': 'Opciones de la conversación',
  'chat.saveConversation': 'Guardar esta conversación',
  'chat.savedTo': 'Se guardó en {path}',
  'chat.copied': 'Copiado',
  'chat.copyFailed': 'No se pudo copiar en el portapapeles',
  'chat.transcript.label': 'Transcripción de la conversación',
  'chat.stopped': 'Se detuvo: puede que la respuesta esté incompleta',
  'chat.warmup.hint':
    'La primera respuesta tarda un poco más: el modelo se está preparando. Las siguientes serán ' +
    'más rápidas.',
  'chat.scopeNotice': 'Respuesta solo a partir de: {titles}',
  'chat.cancelDocTask': 'Cancelar la tarea de documentos',
  'chat.placeholder.documents': 'Pregunta sobre tus documentos…',
  'chat.placeholder.chat': 'Mensaje…',
  'chat.send.ask': 'Preguntar',
  'chat.send.send': 'Enviar',
  'chat.composer.stop': 'Detener',
  // ---- Chat: conversation list (ConversationList.tsx) ----
  'chat.list.title': 'Conversaciones',
  'chat.list.aria': 'Historial de conversaciones',
  'chat.list.newChat': '+ Nuevo chat',
  'chat.list.newDocQa': '+ Nuevo chat sobre documentos',
  'chat.list.hide': 'Ocultar la lista de conversaciones',
  'chat.list.empty': 'Aún no hay conversaciones.',
  'chat.list.docMeta': 'Documentos',
  'chat.list.otherGroup': 'Otros / Biblioteca',
  'chat.list.rowOptionsAria': 'Opciones de la conversación «{title}»',
  'chat.search.placeholder': 'Buscar conversaciones…',
  'chat.search.aria': 'Buscar conversaciones',
  'chat.search.resultsAria': 'Resultados de la búsqueda',
  'chat.search.resultsFor': 'Resultados para «{query}»',
  'chat.search.noMatches': 'No encontré ninguna coincidencia. Prueba con otras palabras.',
  'chat.search.count.one': '{count} resultado',
  'chat.search.count.many': '{count} de resultados',
  'chat.search.count.other': '{count} resultados',
  'chat.group.today': 'Hoy',
  'chat.group.yesterday': 'Ayer',
  'chat.group.last7days': 'Últimos 7 días',
  'chat.group.earlier': 'Anteriores',
  'chat.delete.menuItem': 'Eliminar conversación',
  'chat.delete.title': '¿Eliminar esta conversación?',
  'chat.delete.confirm': 'Eliminar',
  'chat.delete.body': '«{title}» y sus mensajes se eliminarán de esta unidad de forma permanente.',
  // ---- Chat: answer depth (DepthMenu.tsx; ids stay fast|balanced|deep) ----
  'chat.depth.trigger': 'Detalle de la respuesta: {label}',
  'chat.depth.fast': 'Rápido',
  'chat.depth.balanced': 'Equilibrado',
  'chat.depth.deep': 'Minucioso',
  'chat.depth.fastHint': 'Respuestas breves y directas',
  'chat.depth.balancedHint': 'La opción predeterminada para el día a día',
  'chat.depth.deepHint': 'Analiza el problema a fondo antes de responder: tarda más',
  // ---- Chat: skill picker + per-message glyph (skills plan §10/§15) ----
  'chat.skill.trigger': 'Habilidad: {label}',
  'chat.skill.none': 'Sin habilidad',
  'chat.skill.suggested': 'Sugerencia: «{title}». ¿Usarla?',
  'chat.skill.suggestedHint': 'Sugerencia: {title}',
  'chat.skill.used': 'Habilidad: {title}',
  'chat.skill.usedTitle': 'Esta respuesta se generó con la habilidad «{title}».',
  'chat.skill.autoFired': 'Se respondió con «{title}»',
  'chat.skill.autoFiredTitle':
    'La aplicación usó automáticamente la habilidad «{title}» en esta respuesta. Puedes ' +
    'responder sin ella.',
  'chat.skill.answerWithout': 'Responder sin ella',
  'chat.skill.answerWithoutBlockedByReview':
    'Esta respuesta tiene una revisión de evidencia. Volver a responder eliminaría la revisión ' +
    'con sus decisiones y notas.',
  'chat.skill.removed': '(habilidad eliminada)',
  'chat.skill.offer.lead': 'Esto parece una tarea para una habilidad.',
  'chat.skill.offer.run': 'Ejecutar «{title}» para esta pregunta',
  'chat.skill.offer.model': 'Sugerencia del modelo local',
  'chat.skill.offer.unavailable':
    'Esta habilidad está desactivada o se eliminó: actívala en la pestaña Habilidades de Ajustes ' +
    'para ejecutarla.',
  'chat.skill.clear': 'Quitar la habilidad «{title}»',
  'chat.skill.keep': 'Mantener en esta conversación',
  'chat.skill.infoButton': 'Acerca de «{title}»',
  'chat.skill.info.close': 'Ocultar esta explicación',
  'chat.skill.info.needsLabel': 'Necesita:',
  'chat.skill.info.limitsLabel': 'Ten en cuenta:',
  'chat.skill.info.perTurn':
    'Se aplica a tus preguntas en este chat hasta que la cambies o la quites. «Mantener en esta ' +
    'conversación» también la guarda para más adelante.',
  'chat.skill.info.learnMore': 'Más información',
  'chat.skill.tool.extractTransactions': 'Extraer movimientos',
  'chat.skill.tool.validateBalances': 'Comprobar saldos',
  'chat.skill.tool.categorize': 'Clasificar',
  'chat.skill.tool.summarize': 'Resumir el flujo de caja',
  'chat.skill.tool.exportCsv': 'Exportar a CSV',
  'chat.skill.tool.extractInvoice': 'Extraer factura',
  'chat.skill.tool.validateInvoiceTotals': 'Comprobar totales',
  'chat.skill.tool.exportInvoiceCsv': 'Exportar a CSV',
  'chat.skill.tool.exportInvoiceJson': 'Exportar a JSON',
  'chat.skill.tool.exportInvoiceXml': 'Exportar a XML',
  'chat.skill.tool.redactDocument': 'Ocultar datos personales',
  'chat.skill.tool.applyDocumentEdits': 'Aplicar cambios al texto',
  'chat.skill.categorize.breakdownQuestion': 'Desglosa mis gastos por categoría.',
  'chat.skill.summarize.question': 'Resume mis ingresos y gastos.',
  'chat.skill.run.running.one': 'Ejecutando: {tool} en {count} documento…',
  'chat.skill.run.running.many': 'Ejecutando: {tool} en {count} de documentos…',
  'chat.skill.run.running.other': 'Ejecutando: {tool} en {count} documentos…',
  'chat.skill.run.runningOn': 'Ejecutando: {tool} en {document}…',
  'chat.skill.run.chooseDocument': 'Elegir el documento de destino',
  'chat.skill.run.thisDocument': 'este documento',
  'chat.skill.run.cancel': 'Cancelar',
  'chat.skill.run.done.one': 'Se extrajo {count} movimiento.',
  'chat.skill.run.done.many': 'Se extrajeron {count} de movimientos.',
  'chat.skill.run.done.other': 'Se extrajeron {count} movimientos.',
  'chat.skill.run.done.categorize.one': 'Se clasificó {count} movimiento.',
  'chat.skill.run.done.categorize.many': 'Se clasificaron {count} de movimientos.',
  'chat.skill.run.done.categorize.other': 'Se clasificaron {count} movimientos.',
  'chat.skill.run.done.summarize.one': 'Se resumió {count} movimiento.',
  'chat.skill.run.done.summarize.many': 'Se resumieron {count} de movimientos.',
  'chat.skill.run.done.summarize.other': 'Se resumieron {count} movimientos.',
  'chat.skill.run.done.export.one': 'Se guardó {count} fila.',
  'chat.skill.run.done.export.many': 'Se guardaron {count} de filas.',
  'chat.skill.run.done.export.other': 'Se guardaron {count} filas.',
  'chat.skill.run.done.reconciled': 'Los saldos cuadran.',
  'chat.skill.run.done.unreconciled.one':
    '{count} fila no cuadra: comprueba el resultado antes de confiar en él.',
  'chat.skill.run.done.unreconciled.many':
    '{count} de filas no cuadran: comprueba el resultado antes de confiar en él.',
  'chat.skill.run.done.unreconciled.other':
    '{count} filas no cuadran: comprueba el resultado antes de confiar en él.',
  'chat.skill.run.done.unchecked': 'No había ningún saldo acumulado impreso con el que comparar.',
  'chat.skill.run.done.extractInvoice.one': 'Se extrajo {count} línea.',
  'chat.skill.run.done.extractInvoice.many': 'Se extrajeron {count} de líneas.',
  'chat.skill.run.done.extractInvoice.other': 'Se extrajeron {count} líneas.',
  'chat.skill.run.done.invoiceReconciled': 'Los totales de la factura cuadran.',
  'chat.skill.run.done.invoiceUnreconciled.one':
    '{count} total no cuadra: comprueba el resultado antes de confiar en él.',
  'chat.skill.run.done.invoiceUnreconciled.many':
    '{count} de totales no cuadran: comprueba el resultado antes de confiar en él.',
  'chat.skill.run.done.invoiceUnreconciled.other':
    '{count} totales no cuadran: comprueba el resultado antes de confiar en él.',
  'chat.skill.run.done.invoiceUnchecked': 'No había ningún total impreso con el que comparar.',
  'chat.skill.run.done.redacted.one':
    'Se guardó una copia con datos ocultos: {count} elemento oculto. La detección se hace en la ' +
    'medida de lo posible, sin garantías: revisa la copia antes de compartirla.',
  'chat.skill.run.done.redacted.many':
    'Se guardó una copia con datos ocultos: {count} de elementos ocultos. La detección se hace ' +
    'en la medida de lo posible, sin garantías: revisa la copia antes de compartirla.',
  'chat.skill.run.done.redacted.other':
    'Se guardó una copia con datos ocultos: {count} elementos ocultos. La detección se hace en ' +
    'la medida de lo posible, sin garantías: revisa la copia antes de compartirla.',
  'chat.skill.run.done.redactedClean':
    'No se detectaron datos personales; se guardó una copia. La detección se hace en la medida ' +
    'de lo posible, sin garantías: revisa la copia antes de compartirla.',
  'chat.skill.run.done.redactedFloor.one':
    'Se guardó una copia con datos ocultos: {count} elemento oculto (solo se usó la detección ' +
    'sin conexión basada en reglas, sin ningún modelo en ejecución). Revisa la copia antes de ' +
    'compartirla.',
  'chat.skill.run.done.redactedFloor.many':
    'Se guardó una copia con datos ocultos: {count} de elementos ocultos (solo se usó la ' +
    'detección sin conexión basada en reglas, sin ningún modelo en ejecución). Revisa la copia ' +
    'antes de compartirla.',
  'chat.skill.run.done.redactedFloor.other':
    'Se guardó una copia con datos ocultos: {count} elementos ocultos (solo se usó la detección ' +
    'sin conexión basada en reglas, sin ningún modelo en ejecución). Revisa la copia antes de ' +
    'compartirla.',
  'chat.skill.run.done.redactedCleanFloor':
    'No se detectaron datos personales (solo se usó la detección sin conexión basada en reglas, ' +
    'sin ningún modelo en ejecución); se guardó una copia. Revísala antes de compartirla.',
  'chat.skill.run.done.redactedCapped.one':
    'Se guardó una copia con datos ocultos: {count} elemento oculto. Este documento es muy ' +
    'grande, así que la detección automática se detuvo en su límite y puede que los elementos ' +
    'posteriores no estén ocultos: revisa toda la copia antes de compartirla.',
  'chat.skill.run.done.redactedCapped.many':
    'Se guardó una copia con datos ocultos: {count} de elementos ocultos. Este documento es muy ' +
    'grande, así que la detección automática se detuvo en su límite y puede que los elementos ' +
    'posteriores no estén ocultos: revisa toda la copia antes de compartirla.',
  'chat.skill.run.done.redactedCapped.other':
    'Se guardó una copia con datos ocultos: {count} elementos ocultos. Este documento es muy ' +
    'grande, así que la detección automática se detuvo en su límite y puede que los elementos ' +
    'posteriores no estén ocultos: revisa toda la copia antes de compartirla.',
  'chat.skill.run.done.edited.one':
    'Se aplicó {count} cambio y se guardó una copia editada. Revísala antes de compartirla.',
  'chat.skill.run.done.edited.many':
    'Se aplicaron {count} de cambios y se guardó una copia editada. Revísala antes de ' +
    'compartirla.',
  'chat.skill.run.done.edited.other':
    'Se aplicaron {count} cambios y se guardó una copia editada. Revísala antes de compartirla.',
  'chat.skill.run.done.editedPartial.one':
    'Se aplicó {count} cambio; parte del texto indicado no se encontró y se omitió. Se guardó ' +
    'una copia editada: revísala antes de compartirla.',
  'chat.skill.run.done.editedPartial.many':
    'Se aplicaron {count} de cambios; parte del texto indicado no se encontró y se omitió. Se ' +
    'guardó una copia editada: revísala antes de compartirla.',
  'chat.skill.run.done.editedPartial.other':
    'Se aplicaron {count} cambios; parte del texto indicado no se encontró y se omitió. Se ' +
    'guardó una copia editada: revísala antes de compartirla.',
  'chat.skill.run.done.editedNone':
    'No se encontró nada del texto indicado: no se cambió nada y no se guardó ninguna copia.',
  'chat.skill.run.done.editedCapped.one':
    'Se aplicó {count} cambio. Este documento es muy grande, así que la búsqueda de partes que ' +
    'cambiar se detuvo en su límite: revisa la copia, porque puede que las partes posteriores ' +
    'sigan sin cambios.',
  'chat.skill.run.done.editedCapped.many':
    'Se aplicaron {count} de cambios. Este documento es muy grande, así que la búsqueda de ' +
    'partes que cambiar se detuvo en su límite: revisa la copia, porque puede que las partes ' +
    'posteriores sigan sin cambios.',
  'chat.skill.run.done.editedCapped.other':
    'Se aplicaron {count} cambios. Este documento es muy grande, así que la búsqueda de partes ' +
    'que cambiar se detuvo en su límite: revisa la copia, porque puede que las partes ' +
    'posteriores sigan sin cambios.',
  'chat.skill.run.failedGeneric': 'No se pudo completar. No se cambió nada.',
  'chat.skill.run.error.unavailable': 'Esta herramienta no está disponible.',
  'chat.skill.run.error.needsExtraction':
    'Primero procesa el documento con el botón «{button}» y después ejecuta esta herramienta.',
  'chat.skill.run.error.persistFailed': 'No se pudo guardar. No se cambió nada.',
  'chat.skill.run.error.exportWriteFailed': 'No se pudo guardar el archivo. No se cambió nada.',
  'chat.skill.run.error.needsModel':
    'Primero inicia un modelo: los cambios puntuales necesitan un modelo en ejecución para ' +
    'encontrar el texto que hay que cambiar.',
  'chat.skill.run.error.needsInstruction':
    'Primero indica qué hay que cambiar (por ejemplo, «reemplaza X por Y») y después vuelve a ' +
    'ejecutar la herramienta.',
  'chat.skill.run.error.editFailed': 'No se pudieron completar los cambios. No se cambió nada.',
  'chat.skill.run.error.redactionModelStopped':
    'El modelo de IA se detuvo antes de terminar la ocultación de datos. No se guardó nada. ' +
    'Vuelve a ejecutarla; si el problema se repite, reinicia el modelo en la pantalla Modelo de ' +
    'IA.',
  'chat.skill.run.error.redactionTooLong':
    'Algunas partes de este documento son demasiado largas para el tamaño de contexto del modelo ' +
    'actual. No se guardó nada. Elige un tamaño de contexto mayor en la pantalla Modelo de IA, ' +
    'reinicia el modelo y vuelve a ejecutar la ocultación de datos.',
  'chat.skill.run.cancelled': 'Se detuvo. No se guardó nada.',
  'chat.skill.run.stateUnknown':
    'No se pudo comprobar el estado de esta habilidad: puede que su resultado esté incompleto.',
  'chat.skill.run.otherChatBusy': 'Una habilidad está trabajando en otro chat.',
  'chat.skill.run.categorizeOffer': 'Clasificar movimientos',
  'chat.skill.run.dismiss': 'Descartar',
  'chat.skill.confirm.title': '¿Ejecutar esta herramienta?',
  'chat.skill.confirm.body':
    'Esto crea o exporta un archivo a partir de los documentos de esta unidad.',
  'chat.skill.confirm.target': 'Documento: {document}',
  'chat.skill.confirm.outputDocx':
    'La copia guardada conserva el formato Word de este documento (.docx).',
  'chat.skill.confirm.redactionScope':
    'La ocultación abarca el texto del documento (incluidos encabezados, pies de página, notas ' +
    'al pie, comentarios y cambios registrados) y borra los metadatos de autoría y los destinos ' +
    'de los vínculos. Las imágenes, las páginas escaneadas y los objetos incrustados no se ' +
    'comprueban: revisa la copia guardada antes de compartirla.',
  'chat.skill.confirm.outputText':
    'La copia guardada será texto sin formato (.txt): no se conservan el diseño ni el formato ' +
    'originales.',
  'chat.skill.confirm.outputMatrix':
    'Los documentos de Word (.docx) conservan su formato; los PDF y los demás formatos se ' +
    'guardan como una copia de texto sin formato (.txt).',
  'chat.skill.confirm.ok': 'Ejecutar',
  // ---- Chat: transcript + message actions ----
  'chat.role.user': 'Tú',
  'chat.role.assistant': 'HilbertRaum',
  'chat.thinking': 'Pensando…',
  'chat.actions.tryAgain': 'Volver a intentarlo',
  'chat.actions.sendAgain': 'Volver a enviar',
  'chat.actions.copy': 'Copiar',
  'chat.actions.save': 'Guardar',
  'chat.actions.saveTitle': 'Guardar esta conversación como archivo (no sale de tu equipo)',
  'chat.actions.exportCsv': 'Exportar CSV',
  'chat.actions.exportCsvTitle':
    'Guardar la tabla de esta respuesta como archivo CSV (no sale de tu equipo)',
  'chat.code.copy': 'Copiar',
  'chat.code.copyTitle': 'Copiar este bloque de código en el portapapeles',
  'chat.code.save': 'Guardar',
  'chat.code.saveTitle': 'Guardar este bloque de código como archivo .{ext} (no sale de tu equipo)',
  // ---- Chat: context compaction (context-compaction plan §5.1–§5.3) ----
  'chat.compaction.inProgress': 'Resumiendo los mensajes anteriores para liberar contexto…',
  'chat.analysis.inProgress': 'Leyendo todo el documento…',
  'chat.compaction.markerLabel': 'Mensajes anteriores resumidos',
  'chat.compaction.viewSummary': 'Mostrar el resumen de los mensajes anteriores',
  'chat.context.label': 'Memoria',
  'chat.context.usageTooltip':
    'Memoria de esta conversación: {pct}\u00A0% ocupada (unos {used} de {window} tokens).',
  'chat.context.willSummarize':
    'Cuando se llena, los mensajes más antiguos se resumen automáticamente para dejar espacio.',
  'chat.truncated.label': 'Respuesta cortada',
  'chat.endedEarly.label': 'Respuesta detenida',
  'chat.endedEarly.hint.model':
    'Se detuvo o se cambió el modelo de IA antes de que terminara esta respuesta.',
  'chat.endedEarly.hint.user': 'Detuviste esta respuesta antes de que terminara.',
  'chat.endedEarly.hint.lock':
    'Se bloqueó el espacio de trabajo o se cerró la aplicación antes de que terminara esta ' +
    'respuesta.',
  'chat.unanswered.model': 'Sin respuesta: el modelo de IA se detuvo.',
  'chat.unanswered.user': 'Sin respuesta: la detuviste.',
  'chat.unanswered.lock':
    'Sin respuesta: se bloqueó el espacio de trabajo o se cerró la aplicación.',
  'chat.truncated.hint.context':
    'El modelo se quedó sin espacio para terminar esta respuesta. Pídele que continúe, empieza ' +
    'un nuevo chat o aumenta el tamaño de contexto en la pantalla Modelo de IA.',
  'chat.truncated.hint.cap':
    'Esta respuesta sobre documentos alcanzó la longitud fija que la aplicación permite para una ' +
    'respuesta. Pide al modelo que continúe donde se detuvo.',
  'chat.speed.line': '{tps} tok/s · {ttft} s hasta el primer token · tokens: {tokens}',
  'chat.speed.hint':
    'Con qué rapidez se generó esta respuesta: la velocidad de decodificación del motor de IA, ' +
    'la espera hasta la primera palabra y el número de tokens generados. Solo se muestra en las ' +
    'respuestas de esta sesión.',
  // ---- Chat: document scope (ScopePopover.tsx) ----
  'chat.scope.none': 'Sin documentos aún · Agregar documentos',
  'chat.scope.stopAsking': 'Dejar de preguntar a «{title}»',
  'chat.scope.askToo': 'Preguntar también a «{title}»',
  'chat.scope.removedDoc': 'Documento eliminado',
  // ---- Chat: sources (SourcesDisclosure.tsx) ----
  'chat.sources.toggle': 'Fuentes ({count})',
  'chat.sources.marker': 'F{n}',
  'chat.sources.page': 'Página {page}',
  'chat.sources.wholeDoc.one': 'A partir del documento: {count} sección',
  'chat.sources.wholeDoc.many': 'A partir del documento: {count} de secciones',
  'chat.sources.wholeDoc.other': 'A partir del documento: {count} secciones',
  'chat.sources.wholeDocCaption': 'Secciones abarcadas',
  'chat.sources.more.one': 'y {count} sección más',
  'chat.sources.more.many': 'y {count} de secciones más',
  'chat.sources.more.other': 'y {count} secciones más',
  // ---- Chat: dictation (DictationButton.tsx) ----
  'chat.dictation.start': 'Dictar un mensaje',
  'chat.dictation.unavailable': 'El dictado por voz no está instalado en esta unidad',
  'chat.dictation.unavailableSystem':
    'El dictado por voz no está disponible en este sistema operativo',
  'chat.dictation.needsModel':
    'Para dictar un mensaje se necesita el modelo de voz, que no está instalado en esta unidad. ' +
    'Puedes agregarlo en la pantalla Modelo de IA.',
  'chat.dictation.needsEngine':
    'Para dictar un mensaje se necesita el motor de voz, que no está instalado en esta unidad. ' +
    'Puedes instalarlo en la pantalla Modelo de IA.',
  'chat.dictation.needsModelAndEngine':
    'Para dictar un mensaje se necesitan el modelo de voz y el motor de voz, que aún no están en ' +
    'esta unidad. Puedes agregar ambos en la pantalla Modelo de IA.',
  'chat.dictation.engineUnsupported':
    'El dictado por voz aún no está disponible en este sistema operativo: la aplicación no puede ' +
    'instalar aquí el motor de voz que necesita.',
  'chat.dictation.getModel': 'Obtener el modelo de voz',
  'chat.dictation.getEngine': 'Obtener el motor de voz',
  'chat.dictation.setUp': 'Configurar el dictado por voz',
  'chat.dictation.stop': 'Detener el dictado e insertar el texto',
  'chat.dictation.transcribing': 'Convirtiendo tu voz en texto',
  'chat.dictation.noSpeech': 'No se reconoció ninguna palabra: intenta hablar de nuevo.',
  'chat.dictation.silent':
    'No llegó ningún sonido al micrófono. Comprueba que no esté silenciado y que HilbertRaum ' +
    'tenga permiso para usarlo en la configuración del sistema; luego vuelve a intentarlo.',
  'chat.dictation.noSignal':
    'No llega ningún sonido al micrófono: comprueba que no esté silenciado y que esté ' +
    'seleccionado el dispositivo de entrada correcto.',
  'chat.dictation.micBlocked':
    'No se pudo usar el micrófono. Comprueba la configuración del micrófono del sistema y luego ' +
    'vuelve a intentarlo.',
  // ---- Documents (DocumentsScreen.tsx) ----
  'docs.title': 'Documentos',
  'docs.lead':
    'Importa documentos para hacer preguntas sobre ellos. Cada archivo se copia en tu espacio de ' +
    'trabajo y se prepara para la búsqueda: todo se queda en esta unidad. Pregunta desde el modo ' +
    '«Preguntar a mis documentos» de la pantalla Chat.',
  'docs.status.queued': 'En espera',
  'docs.status.extracting': 'Leyendo',
  'docs.status.preparing': 'Preparando',
  'docs.status.indexed': 'Listo',
  'docs.status.failed': 'Error',
  'docs.status.deleted': 'Eliminado',
  'docs.status.transcribing': 'Transcribiendo…',
  'docs.task.summaryBusy': 'Resumiendo…',
  'docs.task.translationBusy': 'Traduciendo…',
  'docs.task.compareBusy': 'Comparando…',
  'docs.task.ocrBusy': 'Leyendo el escaneo…',
  'docs.task.treeBusy': 'Creando un índice profundo…',
  'docs.task.extractBusy': 'Buscando detalles…',
  'docs.task.summaryBusyTitle': 'Se está escribiendo el resumen',
  'docs.task.translationBusyTitle': 'Se está escribiendo la traducción',
  'docs.task.compareBusyTitle': 'Se está escribiendo la comparación',
  'docs.task.ocrBusyTitle': 'Se están leyendo las páginas escaneadas',
  'docs.task.treeBusyTitle': 'Se está creando un índice profundo de todo el documento',
  'docs.task.extractBusyTitle':
    'Se está analizando todo el documento para poder responder a preguntas del tipo «enumera ' +
    'todos los…»',
  'docs.task.categorizeBusy': 'Clasificando movimientos…',
  'docs.task.categorizeBusyTitle': 'Se están clasificando los movimientos del extracto',
  'docs.task.ocrFinishing': 'Terminando: habilitando la búsqueda en el texto…',
  'docs.task.stopping': 'Deteniendo, si es posible…',
  'docs.error.noSupported': 'No se encontró ningún documento compatible en esa selección.',
  'docs.removedDocFallback': 'un documento eliminado',
  'docs.provenance.compareBefore': 'Comparación de ',
  'docs.provenance.compareMiddle': ' con ',
  'docs.provenance.translatedBefore': 'Traducción de ',
  'docs.provenance.summaryBefore': 'Resumen de ',
  'docs.provenance.generatedBefore': 'Generado a partir de ',
  'docs.provenance.articleBefore': 'Guardado de un paquete de conocimiento: ',
  'docs.provenance.articleUnknownArchive': 'nombre desconocido',
  'docs.import.busy': 'Importando…',
  'docs.import.files': 'Importar archivos',
  'docs.import.folder': 'Importar carpeta',
  'docs.import.walkCut.one':
    'La carpeta era demasiado grande para analizarla por completo: se contó {count} elemento.',
  'docs.import.walkCut.many':
    'La carpeta era demasiado grande para analizarla por completo: se contaron {count} de ' +
    'elementos.',
  'docs.import.walkCut.other':
    'La carpeta era demasiado grande para analizarla por completo: se contaron {count} elementos.',
  'docs.refresh': 'Actualizar',
  'docs.loading': 'Cargando documentos…',
  'docs.askSelected': 'Preguntar a estos documentos ({count})',
  'docs.askSelectedTitle': 'Abrir un chat que responde solo con los documentos seleccionados',
  'docs.compareBtn': 'Comparar (2)',
  'docs.compareBtnTitle':
    'Escribir una comparación de los dos documentos seleccionados con el modelo local: nada sale ' +
    'de esta unidad',
  'docs.reindexAll': 'Reindexar todos ({count})',
  'docs.reindexAllTitle':
    'Reindexar todos los documentos que se indexaron con otro modelo de búsqueda',
  'docs.reindexAllConfirm.title.one': '¿Reindexar {count} documento?',
  'docs.reindexAllConfirm.title.many': '¿Reindexar {count} de documentos?',
  'docs.reindexAllConfirm.title.other': '¿Reindexar {count} documentos?',
  'docs.reindexAllConfirm.body':
    'Se vuelve a leer cada documento desactualizado y se vuelven a generar sus embeddings, uno ' +
    'por uno. Puede tardar varios minutos y usa mucho el procesador: puedes seguir trabajando, ' +
    'pero las respuestas pueden ser más lentas hasta que termine.',
  'docs.reindexAllConfirm.confirm': 'Reindexar todos',
  'docs.retryAllFailed': 'Volver a intentar todos ({count})',
  'docs.retryAllFailedTitle': 'Reindexar todos los documentos que no se pudieron indexar',
  'docs.retryAllConfirm.title.one': '¿Volver a intentar {count} documento con errores?',
  'docs.retryAllConfirm.title.many': '¿Volver a intentar {count} de documentos con errores?',
  'docs.retryAllConfirm.title.other': '¿Volver a intentar {count} documentos con errores?',
  'docs.retryAllConfirm.body':
    'Se vuelve a leer cada documento con errores y se vuelven a generar sus embeddings, uno por ' +
    'uno. Puede tardar varios minutos y usa mucho el procesador: puedes seguir trabajando, pero ' +
    'las respuestas pueden ser más lentas hasta que termine. Los documentos que vuelvan a fallar ' +
    'se quedan en esta lista.',
  'docs.retryAllConfirm.confirm': 'Volver a intentar todos',
  'docs.reindexAllProgress': 'Reindexando {done} de {total}…',
  'docs.reindexAllCancel': 'Cancelar',
  'docs.reindexAllCancelled': 'Reindexación detenida. Completado: {done} de {total}.',
  'docs.reindexAllDone.one': 'Se reindexó {count} documento.',
  'docs.reindexAllDone.many': 'Se reindexaron {count} de documentos.',
  'docs.reindexAllDone.other': 'Se reindexaron {count} documentos.',
  'docs.reindexAllPartial':
    'Documentos reindexados: {done} de {total}; con errores: {failed}. Los documentos con ' +
    'errores se quedan en la lista de importaciones con errores.',
  'docs.supported.base':
    'Formatos compatibles: TXT, Markdown, PDF, DOCX, CSV y grabaciones de audio (WAV, MP3, FLAC, ' +
    'OGG), que se transcriben en esta unidad',
  'docs.supported.ocrExtra': ', además de fotos de páginas (PNG, JPG), que se leen en esta unidad',
  'docs.preparing': 'Preparando tus documentos para que puedas hacer preguntas sobre ellos…',
  'docs.empty.title': 'Todavía no hay documentos',
  'docs.empty.line':
    'Importa archivos para hacer preguntas sobre ellos: todo se queda en esta unidad.',
  'docs.selectAria': 'Seleccionar «{title}» para hacer preguntas',
  'docs.selectTitle': 'Seleccionar para preguntar solo a los documentos elegidos',
  'docs.selectAllAria': 'Seleccionar todos los documentos',
  'docs.selectAllTitle': 'Seleccionar todos los documentos visibles o borrar la selección',
  'docs.meta.sectionsCount.one': '{count} sección',
  'docs.meta.sectionsCount.many': '{count} de secciones',
  'docs.meta.sectionsCount.other': '{count} secciones',
  'docs.meta.summary': 'Resumen',
  'docs.scan.ocrOffer':
    'Usa «Habilitar búsqueda (OCR)» en esta fila para leer las páginas en esta unidad.',
  'docs.scan.ocrMissing':
    'Para habilitar la búsqueda hacen falta los archivos de OCR, que no están en esta unidad. ' +
    'Descárgalos aquí abajo o, en una unidad que hayas configurado tú, agrégalos con ' +
    '«fetch-runtime --family ocr».',
  'docs.scan.ocrMissingOffline':
    'Para habilitar la búsqueda hacen falta los archivos de OCR, que no están en esta unidad. ' +
    'Para agregarlos, vuelve a ejecutar la configuración de la unidad con «--with-assets» o ' +
    'descarga solo los archivos de OCR con «fetch-runtime --family ocr».',
  'docs.photo.ocrMissing':
    'Descarga aquí abajo los archivos de OCR y luego usa «Volver a intentarlo» para leer esta ' +
    'foto.',
  'docs.photo.ocrMissingOffline':
    'Agrega los archivos de OCR con la configuración de la unidad («fetch-runtime --family ocr») ' +
    'y luego usa «Volver a intentarlo» para leer esta foto.',
  'docs.photo.ocrReady':
    'El reconocimiento de texto ya está listo: usa «Volver a intentarlo» para leer esta foto.',
  'docs.scan.ocrUnavailable':
    'Para habilitar la búsqueda hace falta el reconocimiento de texto (OCR), que no pudo ' +
    'iniciarse en esta versión.',
  'docs.ocr.unavailableBanner':
    'El reconocimiento de texto (OCR) no está disponible en esta versión: los archivos de OCR ' +
    'están en esta unidad, pero el reconocimiento de texto no pudo iniciarse. Las fotos se ' +
    'guardan sin texto legible y no se puede habilitar la búsqueda en los PDF escaneados hasta ' +
    'que se solucione.',
  'docs.stale.banner':
    'Este documento se preparó con otro modelo de búsqueda: reindéxalo para que las respuestas ' +
    'puedan encontrarlo.',
  'docs.preview': 'Vista previa',
  'docs.previewBusy': 'Abriendo…',
  'docs.previewTitle': 'Leer el texto extraído (solo lectura; nada sale de la aplicación)',
  'docs.cancel': 'Cancelar',
  'docs.cancelOcrTitle': 'Detener la lectura del escaneo',
  'docs.cancelTaskTitle': 'Detener la tarea',
  'docs.task.stateUnknown':
    'No se pudo comprobar el estado de esta tarea. Puede que siga en curso.',
  'docs.task.dismiss': 'Descartar',
  'docs.makeSearchable': 'Habilitar búsqueda (OCR)',
  'docs.makeSearchableTitle':
    'Leer las páginas escaneadas con el reconocimiento de texto local: nada sale de esta unidad',
  'docs.makeSearchableAgain': 'Volver a leer (OCR)',
  'docs.makeSearchableAgainPhotoTitle':
    'Volver a leer la foto con el reconocimiento de texto local',
  'docs.makeSearchableAgainTitle':
    'Volver a ejecutar el reconocimiento de texto local y reemplazar la lectura guardada, que ' +
    '«Reindexar» reutiliza',
  'docs.summarize': 'Resumir',
  'docs.summarizeAgain': 'Volver a resumir',
  'docs.translate': 'Traducir',
  'docs.translateNoModel': 'Obtener el modelo de traducción…',
  'docs.translateNoModelTitle':
    'Para traducir hace falta el modelo de traducción: descárgalo en la pantalla Modelo de IA',
  'docs.export': 'Exportar',
  'docs.exportOriginal': 'Exportar archivo original',
  'docs.exportOriginal.gone':
    'La copia guardada de este archivo no está en esta unidad, así que no se puede exportar. Aun ' +
    'así, puedes exportar su texto extraído.',
  'docs.exportOriginalConfirm.title': '¿Exportar el archivo original?',
  'docs.exportOriginal.warning':
    'Este archivo exportado se guarda fuera del espacio de trabajo cifrado de HilbertRaum y no ' +
    'está protegido por la contraseña de tu espacio de trabajo.',
  'docs.reindex': 'Reindexar',
  'docs.reindexBusy': 'Reindexando…',
  'docs.reindexTitle': 'Volver a leer y preparar la copia guardada',
  'docs.reindexDone': 'Se reindexó «{title}».',
  'docs.delete': 'Eliminar',
  'docs.deleteBusy': 'Eliminando…',
  'docs.deleteDone': 'Se eliminó «{title}».',
  'docs.failed.remove': 'Quitar',
  'docs.failed.removeTitle': 'Quitar de la lista esta importación con errores',
  'docs.failed.retry': 'Volver a intentarlo',
  'docs.backToChat': 'Volver al chat',
  'docs.failed.retryTitle': 'Volver a leer y preparar este archivo',
  'docs.moreActions': 'Más acciones para «{title}»',
  'docs.audioConfirm.title': '¿Importar archivos de audio grandes?',
  'docs.audioConfirm.confirm': 'Importar y transcribir',
  'docs.audioConfirm.contains.one': 'Esta selección contiene {count} grabación de audio ({size}).',
  'docs.audioConfirm.contains.many':
    'Esta selección contiene {count} de grabaciones de audio ({size}).',
  'docs.audioConfirm.contains.other':
    'Esta selección contiene {count} grabaciones de audio ({size}).',
  'docs.audioConfirm.body':
    'Cada grabación se copia en tu espacio de trabajo y se transcribe en esta unidad; una ' +
    'grabación larga puede tardar bastante. Mientras tanto, puedes seguir usando la aplicación.',
  'docs.deleteConfirm.title': '¿Eliminar «{title}»?',
  'docs.deleteConfirm.body':
    'Esto elimina de forma permanente el documento, su texto extraído y su índice de búsqueda de ' +
    'tu espacio de trabajo. El archivo original fuera del espacio de trabajo no se toca.',
  'docs.translateModal.title': 'Traducir «{title}»',
  'docs.translateModal.aria': 'Traducir «{title}»',
  'docs.translateModal.hint':
    'El modelo local escribe una copia traducida como documento nuevo: puedes buscar en ella y ' +
    'hacerle preguntas como con cualquier importación, y nada sale de esta unidad. Las ' +
    'traducciones automáticas pueden contener errores.',
  'docs.translateModal.from': 'De',
  'docs.translateModal.to': 'A',
  'docs.translateModal.start': 'Traducir',
  'docs.translateModal.sameLang': 'Elige dos idiomas distintos.',
  'docs.previewModal.aria': 'Vista previa de «{title}»',
  'docs.previewModal.hint':
    'Texto extraído (solo lectura): en él se basan la búsqueda en documentos y las respuestas.',
  'docs.previewModal.ocrInfo.one':
    'Texto reconocido en esta unidad (OCR): {count} página. El reconocimiento puede contener ' +
    'errores.',
  'docs.previewModal.ocrInfo.many':
    'Texto reconocido en esta unidad (OCR): {count} de páginas. El reconocimiento puede contener ' +
    'errores.',
  'docs.previewModal.ocrInfo.other':
    'Texto reconocido en esta unidad (OCR): {count} páginas. El reconocimiento puede contener ' +
    'errores.',
  'docs.previewModal.ocrInfoPhoto':
    'Texto reconocido en esta unidad (OCR) a partir de esta foto. El reconocimiento puede ' +
    'contener errores.',
  'docs.previewModal.ocrInfoPartial':
    'Texto reconocido en esta unidad (OCR): {count} de {total} páginas. El reconocimiento puede ' +
    'contener errores.',
  'docs.previewModal.ocrInfoNone.one':
    'El reconocimiento de texto (OCR) leyó {count} página escaneada en esta unidad y no encontró ' +
    'ningún texto.',
  'docs.previewModal.ocrInfoNone.many':
    'El reconocimiento de texto (OCR) leyó {count} de páginas escaneadas en esta unidad y no ' +
    'encontró ningún texto.',
  'docs.previewModal.ocrInfoNone.other':
    'El reconocimiento de texto (OCR) leyó {count} páginas escaneadas en esta unidad y no ' +
    'encontró ningún texto.',
  'docs.ocr.unsure.page': 'El reconocimiento de texto tuvo dudas con esta página.',
  'docs.ocr.unsure.onlyRecognized':
    'El reconocimiento de texto tuvo dudas con la única página que reconoció.',
  'docs.ocr.unsure.photo': 'El reconocimiento de texto tuvo dudas con esta foto.',
  'docs.ocr.unsure.some':
    'El reconocimiento de texto tuvo dudas en {count} de las {total} páginas reconocidas.',
  'docs.ocr.unsure.all':
    'El reconocimiento de texto tuvo dudas en todas las páginas reconocidas ({count}).',
  'docs.ocr.scannedPages': 'Páginas escaneadas todavía sin texto legible: {count} de {total}.',
  'docs.ocr.scannedPagesNeedsOcr':
    'Para leerlas hacen falta los archivos de OCR (pantalla Modelo de IA).',
  'docs.ocr.unsure.causes':
    'Un original borroso, torcido o escrito a mano se reconoce mal, y lo mismo ocurre con los ' +
    'idiomas distintos del alemán y el inglés.',
  'docs.previewModal.summary': 'Resumen',
  'docs.previewModal.generatedBy': 'Generado por {model}',
  'docs.previewModal.truncated':
    'Este documento es largo: el resumen abarca su comienzo. En el resto puedes seguir buscando ' +
    'y haciendo preguntas en el chat.',
  'docs.previewModal.regenerate': 'Volver a generar',
  'docs.previewModal.copy': 'Copiar',
  'docs.previewModal.save': 'Guardar',
  'docs.previewModal.copied': 'Resumen copiado',
  'docs.previewModal.copyFailed': 'No se pudo copiar en el portapapeles',
  'docs.previewModal.savedTo': 'Resumen guardado en {path}',
  'docs.previewModal.noText': 'No se pudo extraer texto de este documento.',
  'docs.previewModal.documentText': 'Texto del documento',
  'docs.previewModal.page': 'Página {page}',
  'docs.previewModal.showMore': 'Mostrar más',
  'docs.previewModal.loadingMore': 'Cargando…',
  'docs.previewModal.segmentProgress': 'Mostrando {shown} de {total}',
  // ---- Deep index + coverage (whole-document-analysis plan §5.2) ----
  'docs.deepIndex.build': 'Crear índice profundo',
  'docs.deepIndex.reindexFirst': 'Reindexar para el índice profundo',
  'docs.deepIndex.ready': 'Índice profundo',
  'docs.deepIndex.readyTitle':
    'Ya hay un índice profundo de todo el documento: los resúmenes y las respuestas con listas ' +
    'pueden abarcarlo todo',
  'coverage.relevance': 'A partir de los pasajes más relevantes, no de todo el documento',
  'coverage.relevance.counted': 'Secciones usadas: {covered} de {total}',
  'coverage.capped.whole': 'Abarca todo el documento',
  'coverage.capped.beginning': 'Abarca el principio del documento',
  'coverage.tree.whole': 'Abarca todo el documento (índice profundo)',
  'coverage.tree.beginning':
    'Abarca el principio del documento: era demasiado grande para leerlo entero',
  'coverage.tree.partial': 'Índice profundo en curso (secciones: {covered} de {total})',
  'coverage.tree.pending': 'Aún sin índice profundo',
  'coverage.depth': 'Detalle: {label}',
  'coverage.tier.1': 'General',
  'coverage.tier.2': 'Sección por sección',
  'coverage.tier.3': 'Detallado (cobertura completa)',
  'coverage.tier.hint.1': 'Lo más rápido: la visión general guardada',
  'coverage.tier.hint.2': 'Un repaso más a fondo de las secciones',
  'coverage.tier.hint.3': 'El máximo detalle, en todo el documento',
  'coverage.tierSelect.trigger': 'Detalle: {label}',
  'coverage.extract.whole': 'Lectura de todo el documento (secciones analizadas: {scanned})',
  'coverage.extract.wholeUnparsed':
    'Lectura de todo el documento (secciones analizadas: {scanned}; no legibles: {unparsed})',
  'coverage.extract.sections': 'Secciones analizadas: {scanned}',
  'coverage.extract.sectionsUnparsed': 'Secciones analizadas: {scanned}; no legibles: {unparsed}',
  // ---- "List every X" answer (whole-document-analysis plan §4.2, Phase 3) ----
  'analysis.kind.generic': 'elementos',
  'analysis.kind.date': 'fechas',
  'analysis.kind.amount': 'importes',
  'analysis.kind.party': 'partes',
  'analysis.kind.obligation': 'obligaciones',
  'analysis.listing.coverageWhole':
    'Resultados en todo el documento ({kind}): {count}. Secciones analizadas: ' +
    '{scanned}{unparsed}.',
  'analysis.listing.coverageSections':
    'Resultados ({kind}): {count}. Secciones analizadas: {scanned}{unparsed}.',
  'analysis.listing.empty': 'Sin resultados ({kind}). Secciones analizadas: {scanned}{unparsed}.',
  'analysis.listing.unparsedSuffix': ' (no legibles: {k})',
  'analysis.listing.item': '- {value} (×{count})',
  'analysis.listing.caveat':
    'Esta lista abarca todas las secciones analizadas, pero no se garantiza que esté completa ' +
    '(un modelo pequeño puede pasar por alto algún elemento, y las entradas muy parecidas pueden ' +
    'combinarse).',
  'analysis.listing.refPage': 'página {n}',
  'analysis.listing.refSection': 'sección {n}',
  'analysis.listing.unparsedHint':
    '**Aviso:** la mayoría de las secciones no se pudieron leer al indexar este documento, así ' +
    'que este resultado no es fiable. Abre Documentos y vuelve a elegir «Crear índice profundo»: ' +
    'las secciones que no se pudieron leer se vuelven a procesar (un modelo más grande ayuda).',
  'analysis.listing.unparsedHintAmountSkill':
    'Para un extracto bancario, la habilidad «Análisis de extractos bancarios» del menú de ' +
    'habilidades del chat lee los importes con exactitud.',
  'analysis.listing.aggregationHint':
    '**Aviso:** pediste categorías o sumas, pero esta respuesta solo puede enumerar los valores ' +
    'encontrados en el documento y cuántas veces aparece cada uno: no puede agruparlos ni ' +
    'sumarlos.',
  'analysis.listing.aggregationHintAmountSkill':
    'Para un extracto bancario, activa la habilidad «Análisis de extractos bancarios» en el menú ' +
    'de habilidades del chat y vuelve a preguntar: agrupa los movimientos por categorías y suma ' +
    'cada categoría con exactitud.',
  'analysis.wholeDocHint':
    '**Aviso:** esta respuesta se basa solo en las secciones más relevantes, así que puede ' +
    'omitir elementos. Para obtener una lista que abarque todas las secciones, abre Documentos, ' +
    'elige «Crear índice profundo» para el documento y vuelve a preguntar.',
  'analysis.partialAnswerHint':
    '**Aviso:** esta respuesta se basa solo en las secciones más relevantes, así que puede ' +
    'omitir elementos.',
  'analysis.wholeReadSumHint':
    '**Aviso:** el modelo calcula los totales por sí mismo y puede omitir o contar mal algunos ' +
    'elementos. Comprueba cada total con las fuentes.',
  // ---- Bank-statement analysis answer (full-doc-skills plan §3.1, Phase 2) ----
  'skills.bankAnalysis.count': 'Movimientos leídos en todo el extracto: **{count}**.',
  'skills.bankAnalysis.countPartial':
    'Movimientos leídos: **{count}**. Líneas del documento con una cifra que no pude convertir ' +
    'en movimiento: **{dropped}**. Por eso puede que falten movimientos: comprueba esas líneas ' +
    'en el documento.',
  'skills.bankAnalysis.countContradicted':
    'Movimientos leídos: **{count}**. Sin embargo, los saldos impresos de este extracto no ' +
    'cuadran con los movimientos leídos, así que no puedo confirmar que no falte ninguno.',
  'skills.bankAnalysis.empty':
    'Analicé todo el documento, pero no pude extraer ningún movimiento. Puede que las filas ' +
    'estén en una imagen escaneada o en un diseño poco habitual que mi lector no puede seguir. ' +
    'Si es un escaneo, primero aplícale el reconocimiento de texto (OCR); si no, puede que el ' +
    'diseño no se pueda leer de forma automática: abre el extracto y lee las cifras directamente.',
  'skills.bankAnalysis.couldNotRead': 'No pude leer este extracto, así que no puedo analizarlo.',
  'skills.bankAnalysis.unreconciledHeading':
    'Comprueba primero estas filas, porque su saldo acumulado impreso no cuadra con los importes:',
  'skills.bankAnalysis.unreconciledItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.totals':
    'Entradas: **{inAmount} {currency}** · Salidas: **{outAmount} {currency}** · Variación neta: ' +
    '**{netAmount} {currency}**.',
  'skills.bankAnalysis.noCurrency':
    'Estos movimientos usan más de una moneda, así que no hay un único total combinado: habría ' +
    'que separar el total por moneda.',
  'skills.bankAnalysis.incompleteNoTotal':
    'No pude confirmar que haya leído el extracto completo: sus saldos impresos no cuadran con ' +
    'los movimientos que leí, así que puede que las cifras estén mal leídas o incompletas. Para ' +
    'no darte un total que podría ser incorrecto, aquí no indico ninguna suma; abre el extracto ' +
    'y comprueba las cifras directamente.',
  'skills.bankAnalysis.categoryHeading': 'Por categoría:',
  'skills.bankAnalysis.categoryItem': '- {category}: {amount} {currency} ({count})',
  'skills.bankAnalysis.categoryAssisted':
    '_Las categorías se asignan con ayuda del modelo: alguna puede no ser correcta, pero los ' +
    'totales de arriba no cambian._',
  'skills.bankAnalysis.categoryRuleBased':
    '_Es una agrupación rápida basada en reglas (sin usar ningún modelo). Para un desglose más ' +
    'completo con ayuda del modelo, usa el botón «Clasificar»._',
  'skills.bankCategory.Groceries': 'Alimentación',
  'skills.bankCategory.Dining': 'Restaurantes',
  'skills.bankCategory.Transport': 'Transporte',
  'skills.bankCategory.Utilities': 'Servicios básicos',
  'skills.bankCategory.Rent': 'Alquiler',
  'skills.bankCategory.Insurance': 'Seguros',
  'skills.bankCategory.Subscriptions': 'Suscripciones',
  'skills.bankCategory.Health': 'Salud',
  'skills.bankCategory.Shopping': 'Compras',
  'skills.bankCategory.Income': 'Ingresos',
  'skills.bankCategory.Transfer': 'Transferencias',
  'skills.bankCategory.Fees': 'Comisiones',
  'skills.bankCategory.Cash': 'Efectivo',
  'skills.bankCategory.Tax': 'Impuestos',
  'skills.bankCategory.Spending': 'Gastos',
  'skills.bankCategory.Uncategorized': 'Sin categoría',
  'skills.bankAnalysis.caveat':
    'Estas cifras son los importes impresos en el propio extracto, leídos en todo el documento: ' +
    'nada de esto se obtiene sumando cifras mencionadas en el texto ni se inventa.',
  'skills.bankAnalysis.unverifiedCaveat':
    'Estas cifras son la suma de los movimientos que leí en todo el documento (número de ' +
    'movimientos: **{count}**). El extracto no indica ningún saldo inicial ni final, así que no ' +
    'puedo confirmar que no falte ninguno: tómalas como la suma de las filas mostradas, no como ' +
    'un total verificado del extracto. Nada de esto se obtiene sumando cifras mencionadas en el ' +
    'texto ni se inventa.',
  'skills.bankAnalysis.dateOrderCaveat':
    'Una nota sobre las fechas: este extracto no indica si llevan primero el día o el mes, así ' +
    'que las leí con el día primero (día.mes.año). Una fecha como 03.05. puede ser 3 de mayo o 5 ' +
    'de marzo. Comprueba en el documento cualquier fecha que sea importante.',
  'skills.bankAnalysis.transactionsHeading': 'Movimientos:',
  'skills.bankAnalysis.transactionItem': '- {date} · {description} · {amount} {currency}',
  'skills.bankAnalysis.transactionsMore':
    '… y **{count}** más. Para ver todas las filas, usa el botón **Exportar a CSV** de la barra ' +
    'de ejecución para guardar el extracto completo, o pídelo en CSV o JSON aquí mismo en el ' +
    'chat.',
  'skills.bankAnalysis.figureEcho':
    'Totales calculados a partir de los movimientos extraídos: {figures}.',
  'skills.bankAnalysis.figureEchoIn': 'entradas {amount} {currency}',
  'skills.bankAnalysis.figureEchoOut': 'salidas {amount} {currency}',
  'skills.bankAnalysis.figureEchoNet': 'variación neta {amount} {currency}',
  'skills.bankAnalysis.formatIntro':
    'Aquí tienes el extracto en {format}, creado solo a partir de las cifras que leí, sin sumar ' +
    'cifras mencionadas en el texto ni inventar nada:',
  'skills.bankAnalysis.formatIntroCsv':
    'Aquí tienes el extracto en CSV: solo las filas de movimientos, creadas a partir de las ' +
    'cifras que leí (sin sumar cifras mencionadas en el texto ni inventar nada). El resumen del ' +
    'flujo de caja y los saldos inicial y final no van en el CSV; pídelo en JSON para obtenerlos ' +
    'también.',
  'skills.bankAnalysis.customCategoriesNeedModel':
    'Para clasificar los movimientos en tus propias categorías ({categories}) necesito un modelo ' +
    'local en ejecución: las reglas rápidas integradas solo conocen su conjunto fijo. Inicia un ' +
    'modelo y vuelve a preguntar.',
  'skills.bankAnalysis.customTaxonomyNotFound':
    'No encontré «{name}» entre tus documentos. Primero importa el archivo (Documentos → ' +
    'Importar archivos) y luego vuelve a preguntar.',
  'skills.bankAnalysis.customTaxonomyUnparseable':
    'Leí el archivo «{name}», pero no pude usarlo como lista de categorías. Se espera una ' +
    'categoría por línea: un nombre de categoría, seguido opcionalmente de palabras clave ' +
    'después de un punto y coma (por ejemplo, «Hijos;Escuela, Guardería, Material escolar»).',
  'skills.bankAnalysis.derivedColumnsNote':
    '_Columnas que completó el modelo local a partir de la descripción de cada movimiento: ' +
    '{columns}. Las celdas en las que el modelo no estaba seguro quedaron en blanco. Todas las ' +
    'cifras vienen del analizador determinista y no cambian._',
  // ---- Invoice analysis answer (full-doc-skills plan §3.1, Phase 4 / D49) ----
  'skills.invoiceAnalysis.count': 'Leí la factura completa; líneas de factura: **{count}**.',
  'skills.invoiceAnalysis.countPartial':
    'Líneas de factura leídas: **{count}**. Líneas del documento con una cifra que no pude ' +
    'convertir en línea de factura: **{dropped}**. Por eso puede que falten líneas de factura: ' +
    'comprueba esas líneas en el documento.',
  'skills.invoiceAnalysis.empty':
    'Analicé todo el documento, pero no pude extraer ninguna línea ni ningún total. Puede que ' +
    'las cifras estén en una imagen escaneada o en un diseño poco habitual que mi lector no ' +
    'puede seguir. Si es un escaneo, primero aplícale el reconocimiento de texto (OCR); si no, ' +
    'puede que el diseño no se pueda leer de forma automática: abre la factura y lee las cifras ' +
    'directamente.',
  'skills.invoiceAnalysis.couldNotRead': 'No pude leer esta factura, así que no puedo analizarla.',
  'skills.invoiceAnalysis.unreconciledHeading':
    'Comprueba primero estos totales, porque no cuadran:',
  'skills.invoiceAnalysis.checkLineItemsSumToNet': 'las líneas no suman el total neto impreso',
  'skills.invoiceAnalysis.checkNetPlusTaxIsGross':
    'el neto más el impuesto no coincide con el total bruto impreso',
  'skills.invoiceAnalysis.checkTaxMatchesRate':
    'el importe del impuesto no coincide con el porcentaje de impuesto indicado',
  'skills.invoiceAnalysis.unreconciledItem': '- {check}',
  'skills.invoiceAnalysis.totalsHeading': 'Totales, tal como aparecen impresos:',
  'skills.invoiceAnalysis.net': '- Neto: **{value}**',
  'skills.invoiceAnalysis.tax': '- Impuesto: **{value}**',
  'skills.invoiceAnalysis.taxWithRate': '- Impuesto ({rate}\u00A0%): **{value}**',
  'skills.invoiceAnalysis.gross': '- Total bruto (importe a pagar): **{value}**',
  'skills.invoiceAnalysis.positionsHeading': 'Líneas de factura:',
  'skills.invoiceAnalysis.positionItem': '- {description} · {amount} {currency}',
  'skills.invoiceAnalysis.positionsMore':
    '… y **{count}** más. Pídeme que exporte la factura en CSV para ver todas las líneas.',
  'skills.invoiceAnalysis.formatIntro':
    'Aquí tienes la factura en {format}, creada solo a partir de las cifras que leí, sin sumar ' +
    'cifras mencionadas en el texto ni inventar nada:',
  'skills.invoiceAnalysis.formatIntroCsv':
    'Aquí tienes la factura en CSV: solo las líneas, creadas a partir de las cifras que leí (sin ' +
    'sumar cifras mencionadas en el texto ni inventar nada). El encabezado (proveedor, número de ' +
    'factura, fechas) y los totales no van en el CSV; pídela en JSON o XML para obtenerlos ' +
    'también.',
  'skills.invoiceAnalysis.noTotals':
    'La factura no muestra ningún total neto, de impuesto ni bruto que yo pudiera leer.',
  'skills.invoiceAnalysis.caveat':
    'Estas cifras son los importes impresos en la propia factura, leídos en todo el documento: ' +
    'nada de esto se obtiene sumando cifras mencionadas en el texto ni se inventa.',
  'skills.invoiceAnalysis.dateOrderCaveat':
    'Una nota sobre las fechas: esta factura no indica si llevan primero el día o el mes, así ' +
    'que las leí con el día primero (día.mes.año). Una fecha como 03.05. puede ser 3 de mayo o 5 ' +
    'de marzo. Comprueba en el documento cualquier fecha que sea importante.',
  'skills.invoiceAnalysis.detailsHeading': 'Datos, tal como aparecen impresos:',
  'skills.invoiceAnalysis.detailVendor': '- Proveedor: {vendor}',
  'skills.invoiceAnalysis.detailRecipient': '- Destinatario (facturado a): {recipient}',
  'skills.invoiceAnalysis.detailInvoiceNumber': '- Número de factura: {number}',
  'skills.invoiceAnalysis.detailInvoiceDate': '- Fecha de factura: {date}',
  'skills.invoiceAnalysis.detailDueDate': '- Fecha de vencimiento: {date}',
  'skills.invoiceAnalysis.figureEcho':
    'Cifras tal como se extrajeron, copiadas literalmente del documento: {figures}.',
  'skills.invoiceAnalysis.figureEchoNet': 'neto {value}',
  'skills.invoiceAnalysis.figureEchoTax': 'impuesto {value}',
  'skills.invoiceAnalysis.figureEchoGross': 'bruto {value}',
  'skills.invoiceAnalysis.totalsHeadingUnverified':
    'Cifras tal como aparecen impresas. **No cuadran**, así que tómalas como no verificadas:',
  'skills.invoiceAnalysis.unreconciledCaveat':
    'Estas cifras impresas se contradicen entre sí, lo que suele significar que el texto del ' +
    'documento no se extrajo bien (un escaneo, un PDF basado en imágenes o un diseño poco ' +
    'habitual). No confíes en ninguna de estas cifras sin comprobarlas en el propio documento.',
  'skills.invoiceAnalysis.figureEchoSuppressed':
    'Aquí no repito los totales extraídos: no cuadran entre sí ni con las líneas, así que ' +
    'presentarlos como cifras fiables sería engañoso. Compruébalos en el propio documento.',
  'skills.invoiceAnalysis.unreadableLayout':
    'El texto de este documento no se extrae bien: los caracteres salen desordenados (glifo a ' +
    'glifo), lo que suele indicar un PDF basado en imágenes o con una codificación poco ' +
    'habitual. No pude leer líneas ni totales fiables, así que no daré cifras. Si es un escaneo, ' +
    'primero aplícale el reconocimiento de texto (OCR); si no, abre la factura y lee las cifras ' +
    'directamente.',
  'skills.invoiceAnalysis.textQualityCaveat':
    'Un aviso: partes del texto de este documento se extrajeron desordenadas (glifo a glifo). ' +
    'Las cifras de arriba sí cuadran, pero comprueba todo lo importante en el propio documento.',
  'skills.analysis.refusePartial':
    'Solo puedo responder a esto con exactitud a partir del documento completo, y este todavía ' +
    'no está indexado por completo. Abre la pantalla Documentos, elige «Reindexar» y vuelve a ' +
    'preguntar.',
  'skills.analysis.scopeNarrowed':
    'Respondí solo a partir de **{title}**. Otros documentos del ámbito que no se leyeron: ' +
    '{count}. Para analizar otro, selecciona solo ese documento (o escribe el nombre de su ' +
    'archivo en tu pregunta) y vuelve a preguntar.',
  'skills.analysis.selectOne':
    'Para analizar esto por completo necesito un solo documento. Ahora mismo hay varios en el ' +
    'ámbito (documentos: {count}), así que solo veo algunos pasajes repartidos entre ellos. ' +
    'Selecciona un documento (o escribe el nombre de su archivo en tu pregunta) y vuelve a ' +
    'preguntar.',
  'skills.analysis.selectTwo':
    'Para comparar, selecciona exactamente **dos** documentos (o dos versiones). Documentos en ' +
    'el ámbito ahora mismo: {count}. Elige los dos que quieres comparar y vuelve a preguntar.',
  'skills.redactionRouting.answer':
    'Para ocultar los datos personales de este documento, haz clic en el botón **{button}**, ' +
    'justo encima del cuadro de mensaje, y luego elige dónde guardar la copia. Se ejecuta por ' +
    'completo en este dispositivo y oculta los datos personales con un formato claro ' +
    '(direcciones de correo electrónico, números de teléfono, IBAN, fechas y vínculos) leyendo ' +
    'todo el documento. Es una primera pasada que se hace en la medida de lo posible, sin ' +
    'garantías: no detecta nombres ni formatos poco habituales, así que revisa la copia guardada ' +
    'antes de compartirla.',
  'skills.redactionRouting.answerMulti':
    'Para ocultar los datos personales de un documento, haz clic en el botón **{button}**, justo ' +
    'encima del cuadro de mensaje, elige el documento y luego dónde guardar la copia. Trabaja ' +
    'con un documento a la vez, se ejecuta por completo en este dispositivo y oculta los datos ' +
    'personales con un formato claro (direcciones de correo electrónico, números de teléfono, ' +
    'IBAN, números de tarjetas de pago, fechas y vínculos) leyendo todo el documento. Es una ' +
    'primera pasada que se hace en la medida de lo posible, sin garantías: no detecta nombres ni ' +
    'formatos poco habituales, así que revisa la copia guardada antes de compartirla.',
  'skills.editRouting.answer':
    'Para hacer estos cambios, haz clic en el botón **{button}**, justo encima del cuadro de ' +
    'mensaje, y luego elige dónde guardar la copia editada. Se ejecuta por completo en este ' +
    'dispositivo y solo aplica los cambios exactos de buscar y reemplazar que pediste, en todos ' +
    'los lugares donde el texto aparece tal cual, sin cambiar nada más. Nunca reescribe el ' +
    'documento, así que no puede inventar ni reformular nada. En esta fase se guarda una copia ' +
    'de texto sin formato (.txt); revísala antes de compartirla.',
  'skills.editRouting.answerMulti':
    'Para hacer estos cambios, haz clic en el botón **{button}**, justo encima del cuadro de ' +
    'mensaje, elige el documento que quieres editar y luego dónde guardar la copia editada. ' +
    'Trabaja con un documento a la vez, se ejecuta por completo en este dispositivo y solo ' +
    'aplica los cambios exactos de buscar y reemplazar que pediste, en todos los lugares donde ' +
    'el texto aparece tal cual, sin cambiar nada más. Nunca reescribe el documento. En esta fase ' +
    'se guarda una copia de texto sin formato (.txt); revísala antes de compartirla.',
  'skills.redactionRouting.scan':
    'Analicé todo el documento en busca de datos personales con un formato claro. Esto es lo que ' +
    'detecté. Direcciones de correo electrónico: {email}; números de teléfono: {phone}; IBAN: ' +
    '{iban}; números de tarjetas de pago: {card}; fechas: {date}; vínculos: {url}. Es una ' +
    'búsqueda de patrones que se hace en la medida de lo posible: no detecta nombres, ' +
    'direcciones postales ni formatos poco habituales, así que toma estas cifras como un mínimo, ' +
    'no como un inventario completo. Para crear una copia con datos ocultos, haz clic en el ' +
    'botón **{button}**, justo encima del cuadro de mensaje, y elige dónde guardarla.',
  // ---- Models (ModelsScreen.tsx) ----
  'models.title': 'Modelo de IA',
  'models.library.title': 'Biblioteca de modelos',
  'models.library.view': 'Vista de la biblioteca de modelos',
  'models.library.onDrive': 'En esta unidad',
  'models.library.browse': 'Explorar modelos',
  'models.library.search': 'Buscar modelos',
  'models.library.searchPlaceholder': 'Nombre, familia o variante…',
  'models.library.task': 'Tarea',
  'models.library.allTasks': 'Todas las tareas',
  'models.library.family': 'Familia',
  'models.library.allFamilies': 'Todas las familias',
  'models.library.familyNotInView': '{name} (sin modelos en esta vista)',
  'models.library.resetFamily': 'Todas las familias',
  'models.library.noFamilyForTask': 'No hay modelos de la familia {family} para esta tarea.',
  'models.library.noFamilyOnDrive.one':
    'No hay modelos de la familia {family} en esta unidad. En «Explorar modelos» hay {count} ' +
    'modelo.',
  'models.library.noFamilyOnDrive.many':
    'No hay modelos de la familia {family} en esta unidad. En «Explorar modelos» hay {count} de ' +
    'modelos.',
  'models.library.noFamilyOnDrive.other':
    'No hay modelos de la familia {family} en esta unidad. En «Explorar modelos» hay {count} ' +
    'modelos.',
  'models.library.chat': 'Chat',
  'models.library.translation': 'Traducción',
  'models.library.images': 'Imágenes',
  'models.library.voice': 'Voz',
  'models.library.memory': 'Memoria mínima: {size}',
  'models.library.clear': 'Borrar filtros',
  'models.library.showVariants': 'Mostrar todas las variantes ({count})',
  'models.library.hideVariants': 'Mostrar menos variantes ({count})',
  'models.library.results.one': '{count} variante coincidente',
  'models.library.results.many': '{count} de variantes coincidentes',
  'models.library.results.other': '{count} variantes coincidentes',
  'models.library.noMatches':
    'Ningún modelo coincide con estos filtros. Prueba otra búsqueda o borra los filtros.',
  'models.library.noneInstalled': 'Todavía no hay modelos listos para usar en esta unidad.',
  'models.library.onlyActive':
    'Arriba se muestra tu modelo instalado. Explora el catálogo para encontrar alternativas.',
  'models.library.noAlternatives': 'No hay más modelos en este catálogo.',
  'models.library.download': 'Descarga del modelo en curso',
  'models.lead':
    'El modelo de IA responde a tus preguntas, completamente en este dispositivo. Todo se ' +
    'verifica antes de usarse y nada se descarga sin tu confirmación expresa.',
  'models.loadError': 'No se pudieron cargar los modelos: {error}',
  'models.checking':
    'Comprobando los archivos de los modelos… La primera comprobación después de agregar o ' +
    'actualizar un modelo puede tardar unos minutos con archivos grandes; después, el resultado ' +
    'se recuerda y es instantáneo.',
  'models.checkingProgress': 'Comprobando el modelo {n} de {m}: {name} ({pct}\u00A0%)',
  'models.state.installed': 'Instalado',
  'models.state.missing': 'Sin descargar',
  'models.state.checksumFailed': 'No verificable',
  'models.state.unsupported': 'No compatible',
  'models.state.notRecommended': 'No recomendado',
  'models.state.ready': 'Listo',
  'models.state.running': 'En ejecución',
  'models.badge.notResponding': 'No responde',
  'models.notRespondingHint': 'El modelo de IA dejó de responder. Reiniciarlo suele solucionarlo.',
  'models.restart': 'Reiniciar',
  'models.hint.embeddings': 'Prepara tus documentos para que puedas hacer preguntas sobre ellos.',
  'models.hint.reranker':
    'Mejora la elección de los pasajes de documentos que se usan en las respuestas.',
  'models.hint.transcriber':
    'Convierte grabaciones de audio en texto en el que puedes buscar y activa el botón 🎤 de ' +
    'dictado por voz en el chat.',
  'models.hint.translation':
    'Traduce tus documentos y textos entre idiomas, completamente sin conexión.',
  'models.hint.vision':
    'Responde a tus preguntas sobre una imagen cada vez. No lee archivos PDF ni habilita la ' +
    'búsqueda en documentos escaneados.',
  'models.hint.small': 'Pequeño y ágil: respuestas rápidas en casi cualquier equipo.',
  'models.hint.balanced': 'Equilibrado: funciona bien en la mayoría de los equipos.',
  'models.hint.large': 'Grande: las mejores respuestas; necesita un equipo potente.',
  'models.usesSpace': 'Ocupa {size} de espacio en la unidad.',
  'models.downloads.blockedByPolicy':
    'Las descargas están desactivadas por la política de esta unidad.',
  'models.downloads.enableInSettings':
    'Para descargar modelos, activa «Permitir el acceso a internet para descargar modelos y ' +
    'actualizaciones» en Ajustes.',
  'models.download.verifying': 'Verificando el archivo descargado…',
  'models.download.progress': 'Descargando… {pct}\u00A0% ({received} de {total})',
  'models.download.progressNoTotal': 'Descargando… {received} hasta ahora',
  'models.download.cancel': 'Cancelar descarga',
  'models.download.cancelled':
    'Descarga cancelada. Si la vuelves a iniciar, continuará donde se quedó.',
  'models.download.stoppedNetworkOff':
    'La descarga se detuvo porque se desactivó el acceso a internet. Cuando vuelva a estar ' +
    'activado, inicia de nuevo la descarga y continuará donde se quedó.',
  'models.download.unverifiedBefore':
    'Descargado, pero el manifiesto de este modelo todavía no tiene una suma de comprobación ' +
    'real, así que el archivo queda sin verificar. Genera una con ',
  'models.download.unverifiedAfter': '.',
  'models.download.otherRunning':
    'Ya hay otra descarga en curso: los modelos se descargan de uno en uno',
  'models.download.titled': 'Descargar {name} ({size})',
  'models.download.resume': 'Reanudar descarga',
  'models.download.start': 'Descargar',
  'models.download.failed': 'No se pudo descargar {name}.',
  'models.download.retry': 'Volver a intentar la descarga',
  'models.download.dismiss': 'Descartar',
  'models.download.retryUnavailable':
    'Este modelo ya no se ofrece para descargar aquí, así que no se puede volver a intentar ' +
    'desde este resultado. Descártalo o busca el modelo en la biblioteca.',
  'models.download.retryInstalled': 'Ya está en esta unidad.',
  'models.download.withdrawn':
    'Ya no se puede descargar: el proveedor retiró este archivo concreto ({reason}). Las copias ' +
    'que ya están en una unidad siguen funcionando y se pueden seguir verificando.',
  'models.engine.title': 'Instalar el motor de IA',
  'models.engine.explain':
    'Hasta que se instale el motor de IA, los modelos funcionan en un modo de demostración ' +
    'integrado (con respuestas visiblemente simuladas); el dictado por voz necesita el motor de ' +
    'voz. Instala los motores una vez y luego inicia un modelo para obtener respuestas reales.',
  'models.engine.install': 'Instalar motor de IA',
  'models.engine.retry': 'Volver a intentarlo',
  'models.engineProblem.title': 'El motor de IA no puede funcionar en este equipo',
  'models.engineProblem.voiceTitle': 'El motor de voz no puede funcionar en este equipo.',
  'models.engineProblem.libraryMissingPackage':
    'Falta una biblioteca del sistema que el motor necesita: {library}. Instala el paquete ' +
    '{debPackage} (Ubuntu, Debian, Linux Mint) o el paquete {rpmPackage} (Fedora) con tu gestor ' +
    'de software o desde una terminal y luego elige «Volver a comprobar».',
  'models.engineProblem.libraryMissing':
    'Falta una biblioteca del sistema que el motor necesita: {library}. Instálala con tu gestor ' +
    'de software o desde una terminal y luego elige «Volver a comprobar».',
  'models.engineProblem.systemTooOldLinux':
    'El motor necesita una versión más reciente de Linux: Ubuntu 22.04, Debian 12, Fedora 36 o ' +
    'posterior.',
  'models.engineProblem.systemTooOldMac':
    'El motor necesita una versión más reciente de macOS. Actualiza macOS y luego elige «Volver ' +
    'a comprobar».',
  'models.engineProblem.systemTooOld':
    'El motor necesita una versión más reciente del sistema operativo.',
  'models.engineProblem.vcRuntimeMissing':
    'En Windows falta el Microsoft Visual C++ Redistributable (x64) que el motor necesita. ' +
    'Instálalo y luego elige «Volver a comprobar».',
  'models.engineProblem.filesDamaged':
    'Algunos archivos del motor en esta unidad faltan o están dañados. La guía de solución de ' +
    'problemas explica cómo volver a configurarlo.',
  'models.engineProblem.filesDamagedReinstall':
    'Algunos archivos del motor en esta unidad faltan o están dañados. Vuelve a instalarlo para ' +
    'reemplazarlos.',
  'models.engineProblem.filesDamagedAfterInstall':
    'El motor se acaba de instalar y sigue sin poder iniciarse, así que probablemente sus ' +
    'archivos no son la causa. La guía de solución de problemas explica qué más puedes comprobar.',
  'models.engineProblem.filesDamagedAfterInstallWin':
    'El motor se acaba de instalar y sigue sin poder iniciarse, así que probablemente sus ' +
    'archivos no son la causa. Un Microsoft Visual C++ Redistributable (x64) desactualizado ' +
    'también puede causarlo: instala la versión actual y luego elige «Volver a comprobar».',
  'models.engineProblem.reinstall': 'Volver a instalar el motor de IA',
  'models.engineProblem.voiceReinstall': 'Volver a instalar el motor de voz',
  'models.engineProblem.reinstalled': 'Se volvió a instalar el motor de IA.',
  'models.engineProblem.voiceReinstalled': 'Se volvió a instalar el motor de voz.',
  'models.engineUpdate.title': 'Hay una actualización disponible del motor de IA',
  'models.engineUpdate.voiceTitle': 'Hay una actualización disponible del motor de voz',
  'models.engineUpdate.bothTitle':
    'Hay actualizaciones disponibles del motor de IA y del motor de voz',
  'models.engineUpdate.explain':
    'Esta unidad tiene una versión más antigua que la que espera esta aplicación. La ' +
    'actualización descarga primero la versión nueva; después, los modelos se pausan unos ' +
    'segundos mientras se reemplazan los archivos y el modelo seleccionado vuelve a iniciarse.',
  'models.engineUpdate.update': 'Actualizar',
  'models.engineUpdate.done': 'Se actualizó el motor de IA.',
  'models.engineUpdate.voiceDone': 'Se actualizó el motor de voz.',
  'models.engineUpdate.bothDone': 'Se actualizaron el motor de IA y el motor de voz.',
  'models.engineProblem.blocked':
    'La seguridad de Windows bloqueó el motor (Control inteligente de aplicaciones o tu ' +
    'antivirus). La guía de solución de problemas explica qué puedes hacer.',
  'models.engineProblem.demoNote':
    'Hasta entonces, los modelos responden en modo de demostración: las respuestas son simuladas.',
  'models.engineProblem.check': 'Volver a comprobar',
  'models.engineProblem.checking': 'Comprobando…',
  'models.engineProblem.stillFailing':
    'El motor sigue sin poder iniciarse. Comprueba que la instalación haya terminado y vuelve a ' +
    'intentarlo.',
  'models.engineProblem.fixed': 'El motor de IA vuelve a funcionar.',
  'models.engineProblem.voiceFixed': 'El motor de voz vuelve a funcionar.',
  'models.engine.progress': 'Descargando el motor de IA… {pct}\u00A0%',
  'models.engine.downloadingNoTotal': 'Descargando el motor de IA…',
  'models.engine.verifying': 'Verificando el motor de IA…',
  'models.engine.extracting': 'Descomprimiendo el motor de IA…',
  'models.voiceEngine.title': 'Agregar el dictado por voz (opcional)',
  'models.voiceEngine.explain':
    'El chat y las respuestas sobre documentos ya funcionan en esta unidad. El motor de voz es ' +
    'opcional: instálalo solo si quieres dictar mensajes con el micrófono.',
  'models.voiceEngine.install': 'Instalar motor de voz',
  'models.packTools.row': 'Herramientas de los paquetes de conocimiento: sin instalar',
  'models.packTools.install': 'Instalar…',
  'models.ocr.row': 'Reconocimiento de texto para escaneos y fotos (opcional)',
  'models.ocr.rowOrientation':
    'Para enderezar los escaneos girados hace falta un archivo de OCR más (opcional)',
  'ocr.install.action': 'Descargar archivos de OCR',
  'ocr.install.actionTitle':
    'Descargar los archivos de idioma del reconocimiento de texto (OCR) para escaneos y fotos',
  'ocr.install.confirm.title': '¿Descargar los archivos de OCR?',
  'ocr.install.confirm.explain':
    'El reconocimiento de texto (OCR) lee los PDF escaneados y las páginas fotografiadas en este ' +
    'equipo. Necesita los archivos de abajo en esta unidad: no se descarga nada más, y tus ' +
    'documentos nunca salen de este equipo.',
  'ocr.install.confirm.languages': 'Archivos',
  'ocr.install.confirm.hint':
    'Antes de usar cada archivo, se compara con su suma de comprobación esperada.',
  'ocr.install.confirm.start': 'Descargar',
  'ocr.install.lang.deu': 'Alemán',
  'ocr.install.lang.eng': 'Inglés',
  'ocr.install.lang.osd': 'Orientación de la página (endereza las páginas giradas)',
  'ocr.install.starting': 'Iniciando la descarga…',
  'ocr.install.progress': 'Descargando los archivos de OCR… {pct}\u00A0%',
  'ocr.install.verifying': 'Comprobando los archivos de OCR…',
  'ocr.install.activating': 'Iniciando el reconocimiento de texto…',
  'ocr.install.failed': 'No se pudieron instalar los archivos de OCR.',
  'ocr.install.retry': 'Volver a intentar la descarga de OCR',
  'ocr.install.cancel': 'Cancelar la descarga de OCR',
  'ocr.install.alreadyPresent':
    'Los archivos de OCR ya están en esta unidad. Reinicia HilbertRaum para usarlos.',
  'ocr.install.outcome.activated':
    'El reconocimiento de texto está listo; no hace falta reiniciar.',
  'ocr.install.outcome.restartRequired':
    'Los archivos de OCR ya están en su sitio. Reinicia HilbertRaum para usar los archivos de ' +
    'idioma nuevos.',
  'ocr.install.outcome.unchanged':
    'Los archivos de OCR ya están en su sitio. Si el reconocimiento de texto sigue sin estar ' +
    'disponible, reinicia HilbertRaum.',
  'models.ram.needs': 'Necesita al menos {min} GB de RAM',
  'models.ram.machine': '; este equipo tiene unos {ram} GB',
  'models.ram.advice': '. Elige un modelo más pequeño: la calidad sigue siendo excelente.',
  'models.badge.active': 'Activo',
  'models.badge.recommended': 'Recomendado para este equipo',
  'models.badge.ramNeeded': 'Necesita ≥{min} GB de RAM',
  'models.automatic.installed': 'Instalado: se usa automáticamente. No hay nada que iniciar.',
  'models.automatic.notInstalled':
    'Se usa automáticamente una vez instalado: no hace falta configurar nada.',
  'models.transcriber.engineUnsupported':
    'En este sistema operativo, la aplicación todavía no puede instalar el motor de voz, así que ' +
    'este modelo no habilita aquí el dictado por voz ni la importación de audio.',
  'models.vision.installed':
    'Instalado: se usa automáticamente en la pantalla Imágenes. Aquí no hay nada que iniciar.',
  'models.vision.notInstalled':
    'Se usa automáticamente en la pantalla Imágenes una vez instalado: no hace falta configurar ' +
    'nada.',
  'models.vision.goToImages': 'Ir a Imágenes',
  'models.translation.installed':
    'Instalado: se usa automáticamente para traducir. Aquí no hay nada que iniciar.',
  'models.translation.notInstalled':
    'Se usa automáticamente para traducir una vez instalado: no hace falta configurar nada.',
  'models.use': 'Usar este modelo',
  'models.useTitle': 'Usarlo como tu modelo e iniciarlo para poder chatear',
  'models.stopRuntime': 'Detener modelo',
  'models.answeringNote':
    'Se está escribiendo una respuesta. Si detienes o cambias el modelo, la respuesta termina, ' +
    'pero se conserva el texto escrito hasta ahora.',
  'models.startMock': 'Probar en modo de demostración',
  'models.starting': 'Iniciando…',
  'models.startingTitle': 'Este modelo se está cargando: con modelos grandes puede tardar un poco',
  'models.startMockTitle':
    'Todavía no hay ningún archivo de modelo: prueba la aplicación en modo de demostración, con ' +
    'respuestas visiblemente simuladas',
  'models.tech.summary': 'Detalles técnicos',
  'models.tech.id': 'ID del modelo',
  'models.tech.family': 'Familia',
  'models.tech.format': 'Formato',
  'models.tech.runtime': 'Motor',
  'models.tech.license': 'Licencia',
  'models.tech.sizeOnDisk': 'Tamaño en la unidad',
  'models.tech.minRam': 'RAM mínima',
  'models.tech.recRam': 'RAM recomendada',
  'models.tech.context': 'Tamaño de contexto',
  'models.tech.contextValue.one': '{count} token',
  'models.tech.contextValue.many': '{count} de tokens',
  'models.tech.contextValue.other': '{count} tokens',
  'models.tech.file': 'Archivo',
  // ---- Context-size picker (2026-07-04 user report — the truncation hint points here) ----
  'models.context.title': 'Tamaño de contexto',
  'models.context.label': 'Tamaño de contexto para las respuestas:',
  'models.context.auto': 'Automático: el tamaño recomendado del modelo',
  'models.context.autoResolved.one': 'Automático: el tamaño recomendado del modelo ({count} token)',
  'models.context.autoResolved.many':
    'Automático: el tamaño recomendado del modelo ({count} de tokens)',
  'models.context.autoResolved.other':
    'Automático: el tamaño recomendado del modelo ({count} tokens)',
  'models.context.bigWarning':
    'Los contextos muy grandes necesitan mucha memoria adicional mientras el modelo se ejecuta. ' +
    'En equipos con menos memoria, puede que el modelo no se inicie o que responda mucho más ' +
    'despacio; si pasa eso, elige un tamaño más pequeño o «Automático».',
  'models.context.hint':
    'Un contexto más grande permite que una conversación o una respuesta sobre documentos ' +
    'abarque más texto a la vez, pero necesita más memoria y puede hacer más lentas las ' +
    'respuestas. Se aplica la próxima vez que se inicie un modelo.',
  'models.context.restartHint':
    'Ahora mismo hay un modelo en ejecución: detenlo y vuelve a iniciarlo para aplicar el tamaño ' +
    'nuevo.',
  'models.verifyTitle':
    'Volver a calcular el hash del archivo en la unidad y compararlo con su SHA-256 (sin usar la ' +
    'caché)',
  'models.verifying': 'Verificando…',
  'models.verify': 'Verificar suma de comprobación',
  'models.verifyAll': 'Comprobar todos los archivos de modelo',
  'models.verifyingAll': 'Comprobando todos los archivos de modelo…',
  'models.verifyAllTitle':
    'Volver a comprobar cada archivo de modelo de esta unidad con su SHA-256',
  'models.verifyAllHint':
    'Cada modelo se comprueba al iniciarlo. Con esta opción se comprueban, en cambio, todos los ' +
    'archivos de modelo de esta unidad; en una unidad lenta, puede tardar varios minutos. Puedes ' +
    'detener la comprobación en cualquier momento: los archivos ya comprobados quedan ' +
    'comprobados.',
  'models.verifyAllStop': 'Detener la comprobación',
  'models.verifyAllStopping': 'Deteniendo…',
  'models.confirm.title': '¿Descargar {name}?',
  'models.confirm.start': 'Iniciar descarga',
  'models.confirm.size': 'Tamaño',
  'models.confirm.license': 'Licencia',
  'models.confirm.from': 'Dirección de descarga',
  'models.confirm.readLicense': 'leer la licencia',
  'models.confirm.hint':
    'El archivo descargado se verifica antes de usarse. Es la única solicitud de red que hace la ' +
    'aplicación: no se envía nada sobre ti ni sobre tus documentos.',
  'models.confirm.licenseAck': 'He leído y acepto los términos de la licencia de este modelo',
  'models.empty.title': 'No se encontraron manifiestos de modelos',
  'models.empty.lineBefore': 'Agrega manifiestos YAML a la carpeta ',
  'models.empty.lineAfter': ' de la unidad.',
  'models.section.yourModel': 'Tu modelo de IA',
  'models.section.docSearch': 'Búsqueda en documentos',
  // ---- Settings (SettingsScreen.tsx — chrome + the General tab) ----
  'settings.title': 'Ajustes',
  'settings.tabsAria': 'Secciones de Ajustes',
  'settings.tab.general': 'General',
  'settings.tab.privacy': 'Privacidad y datos',
  'settings.tab.skills': 'Habilidades',
  'settings.tab.diagnostics': 'Diagnóstico (avanzado)',
  'settings.loading': 'Cargando los ajustes…',
  'settings.saved': 'Guardado',
  'settings.saveFailed': 'No se pudo guardar este ajuste. Vuelve a intentarlo.',
  'settings.network.title': 'Privacidad y modo sin conexión',
  'settings.network.allow':
    'Permitir el acceso a internet para descargar modelos y actualizaciones',
  'settings.network.hint':
    'Activado de forma predeterminada, para que una instalación nueva pueda descargar un modelo ' +
    'desde el primer momento. Si está desactivado, la aplicación no se conecta a internet. Si lo ' +
    'activas, se permiten las descargas de modelos, del motor de IA, de las herramientas ' +
    'opcionales de los paquetes de conocimiento y de los archivos opcionales de reconocimiento ' +
    'de texto (OCR); cada una pide confirmación antes, y una política de la unidad puede ' +
    'mantener las descargas desactivadas por completo. Tus preguntas y documentos nunca salen de ' +
    'este dispositivo, sea cual sea este ajuste.',
  'settings.appearance.title': 'Apariencia',
  'settings.appearance.aria': 'Tema',
  'settings.appearance.system': 'Sistema',
  'settings.appearance.light': 'Claro',
  'settings.appearance.dark': 'Oscuro',
  'settings.appearance.hint':
    '«Sistema» sigue el tema claro u oscuro de tu sistema operativo. La pantalla de bloqueo ' +
    'siempre sigue el tema del sistema.',
  'settings.language.title': 'Idioma',
  'settings.language.aria': 'Idioma',
  'settings.language.system': 'System',
  'settings.language.hint':
    '«Sistema» sigue el idioma de tu sistema operativo: un sistema en alemán usa Deutsch y ' +
    'cualquier otro usa English. Los cambios se aplican de inmediato.',
  'settings.performance.title': 'Rendimiento',
  'settings.performance.gpu': 'Usar la aceleración por GPU',
  'settings.performance.gpuHint':
    'Acelera las respuestas con tu tarjeta gráfica cuando hay una disponible. Desactívalo solo ' +
    'si notas problemas de estabilidad: todo sigue funcionando en ambos casos.',
  'settings.performance.rerankWideScope': 'Reordenar más pasajes de los paquetes de conocimiento',
  'settings.performance.rerankWideScopeHint':
    'Más lento en cada pregunta. Solo se usa en un equipo con suficientes hilos de procesador y ' +
    'con el modelo de reordenación instalado; un equipo con una tarjeta gráfica utilizable ya ' +
    'reordena todos los pasajes.',
  'settings.performance.autoStart':
    'Cargar el modelo seleccionado automáticamente al iniciar la aplicación',
  'settings.performance.autoStartHint':
    'Activado de forma predeterminada. El modelo seleccionado en la pantalla Modelo de IA se ' +
    'carga en segundo plano al iniciar la aplicación (en los espacios de trabajo cifrados, ' +
    'después de desbloquear), para que el chat esté listo sin clics adicionales.',
  // ---- Settings: Chat / conversation compaction (context-compaction plan §5.4) ----
  'settings.chat.title': 'Chat',
  'settings.chatCompaction.label': 'Resumir los mensajes antiguos para liberar contexto',
  'settings.chatCompaction.help':
    'Activado de forma predeterminada. Cuando una conversación larga se acerca al límite de ' +
    'contexto del modelo, los mensajes más antiguos se resumen una sola vez en una nota compacta ' +
    '(guardada en esta unidad) en lugar de descartarse sin aviso. Desactívalo para conservar ' +
    'solo los mensajes más recientes que quepan.',
  'settings.developer.title': 'Desarrollo',
  'settings.developer.toggle':
    'Modo de desarrollo (permite un espacio de trabajo sin cifrar y modelos sin verificar)',
  'settings.developer.hint':
    'Desactivado de forma predeterminada. Las compilaciones de desarrollo siempre cuentan como ' +
    'modo de desarrollo. La política de la unidad tiene prioridad: en una unidad comercial, los ' +
    'modelos sin verificar se siguen rechazando sea cual sea este ajuste.',
  'settings.workspace.title': 'Espacio de trabajo',
  'settings.workspace.mode': 'Modo',
  'settings.workspace.modeEncrypted': 'Cifrado',
  'settings.workspace.modePlaintext': 'Sin cifrar (desarrollo)',
  'settings.workspace.contextTokens': 'Tokens de contexto',
  'settings.workspace.contextAuto':
    'Automático (el predeterminado del modelo): puedes cambiarlo en la pantalla Modelo de IA',
  'settings.workspace.encryptedHint':
    'Este espacio de trabajo se guarda cifrado. Usa «Bloquear ahora» en la barra lateral para ' +
    'volver a cifrarlo y bloquearlo; también se bloquea automáticamente al cerrar la aplicación.',
  'settings.workspace.plaintextHint':
    'Espacio de trabajo de desarrollo sin cifrar: los datos se guardan sin cifrar. El modo ' +
    'cifrado es el predeterminado de la versión comercial.',
  'settings.changePassword.title': 'Cambiar la contraseña',
  'settings.changePassword.hint':
    'Elige una contraseña nueva para este espacio de trabajo. La usarás a partir del próximo ' +
    'desbloqueo. No se puede recuperar ni restablecer, así que elige una que vayas a recordar.',
  'settings.changePassword.current': 'Contraseña actual',
  'settings.changePassword.new': 'Contraseña nueva',
  'settings.changePassword.confirm': 'Confirmar la contraseña nueva',
  'settings.changePassword.busy':
    'Protegiendo tus documentos con la contraseña nueva… En una biblioteca grande, esto puede ' +
    'tardar unos minutos.',
  'settings.changePassword.failed': 'Algo salió mal. Tu contraseña actual sigue funcionando.',
  'settings.changePassword.submit': 'Cambiar la contraseña',
  'settings.changePassword.submitBusy': 'Cambiando…',
  'settings.changePassword.toast': 'Contraseña cambiada',
  // ---- Skills (settings/SkillsTab.tsx, skills plan §15) ----
  'skills.intro':
    'Las habilidades le enseñan al asistente a hacer una tarea concreta. Agregan indicaciones a ' +
    'sus respuestas y nunca acceden a internet ni a otras carpetas de tu equipo.',
  'skills.info.meeting-protocol.what':
    'Da a la próxima respuesta la forma de un acta de reunión ordenada: decisiones, tareas ' +
    'pendientes y preguntas abiertas.',
  'skills.info.meeting-protocol.needs':
    'La transcripción o las notas en el ámbito de este chat (adjunta el archivo o pega el texto).',
  'skills.info.meeting-protocol.limits':
    'Trabaja con un documento a la vez y solo recoge lo que dicen realmente las notas.',
  'skills.info.contract-brief.what':
    'Resume un contrato en lenguaje sencillo: partes, fechas, obligaciones, cláusulas ' +
    'principales y preguntas que conviene hacer.',
  'skills.info.contract-brief.needs': 'El contrato en el ámbito de este chat.',
  'skills.info.contract-brief.limits':
    'Una ayuda de lectura para un documento a la vez; no es asesoramiento legal.',
  'skills.info.deadline-obligation-finder.what':
    'Encuentra plazos, periodos de preaviso, fechas de renovación y de pago, y las obligaciones ' +
    'que hay detrás.',
  'skills.info.deadline-obligation-finder.needs': 'El documento en el ámbito de este chat.',
  'skills.info.deadline-obligation-finder.limits':
    'Lee un documento a la vez; verifica las fechas importantes en el propio documento antes de ' +
    'actuar.',
  'skills.info.what-changed.what':
    'Compara dos versiones de un documento y explica los cambios que importan, no una ' +
    'comparación línea a línea.',
  'skills.info.what-changed.needs':
    'Exactamente dos documentos (o versiones) en el ámbito de este chat.',
  'skills.info.what-changed.limits':
    'Con más o menos de dos documentos en el ámbito no puede comparar y responde con normalidad.',
  'skills.info.share-safe-review.what':
    'Revisa un documento antes de que lo compartas: información sensible visible y riesgos ' +
    'prácticos al compartirlo.',
  'skills.info.share-safe-review.needs': 'El documento en el ámbito de este chat.',
  'skills.info.share-safe-review.limits':
    'Solo ofrece orientación: nunca afirma que un documento esté anonimizado ni que sea seguro ' +
    'publicarlo.',
  'skills.info.invoice.what':
    'Lee una factura con una extracción exacta y comprobable: líneas y totales, comprobación de ' +
    'los totales y exportación a CSV, JSON o XML.',
  'skills.info.invoice.needs':
    'Un documento parecido a una factura en el ámbito; sus acciones aparecen como botones justo ' +
    'encima del cuadro de mensaje.',
  'skills.info.invoice.limits':
    'Una factura a la vez; un total que no puede verificar se indica como no verificado, nunca ' +
    'se pasa por alto.',
  'skills.info.bank-statement.what':
    'Lee un extracto bancario con una extracción exacta y comprobable: movimientos, categorías, ' +
    'comprobación de saldos y exportación a CSV.',
  'skills.info.bank-statement.needs':
    'Un documento parecido a un extracto bancario en el ámbito; sus acciones aparecen como ' +
    'botones justo encima del cuadro de mensaje.',
  'skills.info.bank-statement.limits':
    'Un extracto a la vez; para clasificar los movimientos hace falta un modelo en ejecución.',
  'skills.info.document-redaction.what':
    'Guarda una copia de un documento con datos ocultos: detección basada en reglas de correos ' +
    'electrónicos, números y fechas, y además nombres y direcciones que localiza el modelo.',
  'skills.info.document-redaction.needs':
    'El documento en el ámbito; el botón «Ocultar datos personales» aparece justo encima del ' +
    'cuadro de mensaje.',
  'skills.info.document-redaction.limits':
    'Se hace en la medida de lo posible y nunca es una garantía: sin un modelo en ejecución solo ' +
    'funciona la detección basada en reglas; los documentos de Word se guardan como .docx y los ' +
    'demás formatos, como .txt.',
  'skills.info.document-edit.what':
    'Aplica cambios exactos de buscar y reemplazar y guarda una copia editada; nunca reescribe ' +
    'tu documento.',
  'skills.info.document-edit.needs':
    'Un modelo en ejecución, el documento en el ámbito y tu instrucción (por ejemplo, «reemplaza ' +
    'X por Y»); el botón «Aplicar cambios al texto» aparece justo encima del cuadro de mensaje.',
  'skills.info.document-edit.limits':
    'El texto que no aparece tal cual se omite y se indica; los documentos de Word se guardan ' +
    'como .docx y los demás formatos, como .txt.',
  'skills.autoFire.title': 'Aplicar automáticamente una habilidad adecuada',
  'skills.autoFire.toggle': 'Aplicar automáticamente una habilidad adecuada',
  'skills.autoFire.hint':
    'Si está activado, la aplicación puede aplicar por sí sola a una respuesta una habilidad ' +
    'integrada que encaje claramente, para que no tengas que elegirla. Solo habilidades ' +
    'integradas, nunca las que creaste o importaste. Siempre verás qué habilidad se usó y podrás ' +
    'responder sin ella a esa pregunta. Desactivado de forma predeterminada.',
  'skills.autoFire.on': 'Habilidades automáticas activadas',
  'skills.autoFire.off': 'Habilidades automáticas desactivadas',
  'skills.autoFire.saveFailed': 'No se pudo guardar el ajuste de habilidades automáticas.',
  'skills.import': 'Importar habilidad…',
  'skills.import.menuAria': 'Importar una habilidad',
  'skills.import.fromFile': 'Desde un archivo (.skill.zip)…',
  'skills.import.fromFolder': 'Desde una carpeta…',
  'skills.loading': 'Cargando habilidades…',
  'skills.loadFailed': 'No se pudieron cargar las habilidades.',
  'skills.reconcile.folderErrors.one':
    'No se pudo leer {count} carpeta de habilidad y se omite. Su archivo «SKILL.md» falta, no es ' +
    'válido o no se puede leer.',
  'skills.reconcile.folderErrors.many':
    'No se pudieron leer {count} de carpetas de habilidades y se omiten. Cada carpeta necesita ' +
    'un archivo «SKILL.md» válido.',
  'skills.reconcile.folderErrors.other':
    'No se pudieron leer {count} carpetas de habilidades y se omiten. Cada carpeta necesita un ' +
    'archivo «SKILL.md» válido.',
  'skills.empty.title': 'Aún no hay habilidades',
  'skills.empty.line':
    'Las habilidades le enseñan al asistente a hacer una tarea concreta. Agrega una para empezar.',
  'skills.trusted.app': 'Integrada',
  'skills.trusted.user': 'Creada por ti',
  'skills.row.enableLabel': 'Activada',
  'skills.row.on': 'Habilidad activada',
  'skills.row.off': 'Habilidad desactivada',
  'skills.row.onFailed': 'No se pudo activar esta habilidad.',
  'skills.row.offFailed': 'No se pudo desactivar esta habilidad.',
  'skills.dup.chip': 'Nombre duplicado',
  'skills.dup.title':
    'Otra habilidad instalada usa este nombre. Solo puede estar activa una a la vez.',
  'skills.unavailable.chip': 'Faltan archivos',
  'skills.unavailable.title': 'Los archivos de esta habilidad ya no están en la unidad.',
  'skills.incompatible.chip': 'Requiere actualizar',
  'skills.incompatible.title':
    'Esta habilidad necesita una versión más reciente de la aplicación: actualiza la aplicación ' +
    'para activarla.',
  'skills.review.chip': 'Revisar',
  'skills.warn.title': 'Revisa lo que puede hacer esta habilidad',
  'skills.warn.body':
    'Creada por ti o importada. Comprueba lo que puede hacer antes de confiar en ella.',
  'skills.warn.ack': 'Entendido',
  'skills.menu.aria': 'Acciones de la habilidad',
  'skills.menu.export': 'Exportar…',
  'skills.menu.delete': 'Eliminar',
  'skills.export.done': 'Habilidad exportada',
  'skills.export.failed': 'No se pudo exportar esta habilidad.',
  'skills.delete.title': '¿Eliminar esta habilidad?',
  'skills.delete.body':
    'Esto elimina la habilidad de la unidad. Los chats que ya la usaron siguen funcionando.',
  'skills.delete.confirm': 'Eliminar',
  'skills.delete.done': 'Habilidad eliminada',
  'skills.delete.failed': 'No se pudo eliminar esta habilidad.',
  'skills.detail.aria': 'Detalles de la habilidad',
  'skills.detail.version': 'Versión',
  'skills.detail.author': 'Autoría',
  'skills.detail.language': 'Idioma',
  'skills.detail.kind': 'Tipo',
  'skills.kind.instruction': 'Indicaciones',
  'skills.kind.tool': 'Usa herramientas',
  'skills.tool.note':
    'Por ahora solo agrega indicaciones. Las herramientas que describe llegarán en una versión ' +
    'posterior.',
  'skills.tool.note.active':
    'Cuando lo pidas, esta habilidad puede ejecutar herramientas locales aprobadas en un ' +
    'documento que elijas. Las herramientas de solo lectura también pueden ejecutarse ' +
    'automáticamente para responder a tu pregunta; todo lo que escriba o exporte un archivo ' +
    'siempre te pide confirmación antes. Solo ven ese documento.',
  'skills.perm.heading': 'Lo que puede hacer esta habilidad',
  'skills.perm.canTitle': 'Esta habilidad puede:',
  'skills.perm.cannotTitle': 'Esta habilidad no puede:',
  'skills.perm.can.instructions': 'Agregar instrucciones a las respuestas de la IA',
  'skills.perm.can.documents': 'Leer solo los documentos que elijas',
  'skills.perm.can.tools': 'Usar herramientas locales aprobadas cuando lo pidas',
  'skills.perm.cannot.network': 'Acceder a internet',
  'skills.perm.cannot.files': 'Leer otras carpetas de tu equipo',
  'skills.perm.cannot.scripts': 'Ejecutar scripts o instalar software',
  'skills.tech.summary': 'Detalles técnicos',
  'skills.tech.id': 'ID de la habilidad',
  'skills.tech.installId': 'ID de instalación',
  'skills.tech.source': 'Procedencia',
  'skills.tech.permissions': 'Permisos',
  'skills.import.title': '¿Agregar esta habilidad?',
  'skills.import.confirm': 'Agregar habilidad',
  'skills.import.added': 'Habilidad agregada',
  'skills.import.failedTitle': 'No se puede agregar esta habilidad',
  'skills.import.failed': 'No se pudo agregar esta habilidad.',
  'skills.import.collision':
    'Ya hay una habilidad instalada con este nombre. Al agregar esta, se reemplaza la instalada.',
  'skills.import.collisionApp':
    'Una habilidad integrada ya usa este nombre. Tu habilidad se agrega, pero permanece ' +
    'desactivada mientras la habilidad integrada esté activada.',
  'skills.import.upgrade': 'Actualiza la versión instalada ({from} → {to}).',
  'skills.import.replace': 'Reemplaza la versión instalada ({version}).',
  'skills.import.downgrade': 'Esta versión es más antigua que la instalada ({installed}).',
  'skills.import.downgradeBlocked':
    'Para instalar una versión más antigua hace falta el modo de desarrollo. Actívalo en Ajustes ' +
    '→ General para permitirlo.',
  'skills.import.error.notFound': 'No se encontró la habilidad seleccionada.',
  'skills.import.error.notZipOrFolder':
    'Una habilidad debe ser un archivo .skill.zip o una carpeta que contenga «SKILL.md».',
  'skills.import.error.unreadableZip':
    'No se pudo leer el paquete de la habilidad como un archivo ZIP válido.',
  'skills.import.error.encryptedZip':
    'El paquete de la habilidad usa un formato ZIP no compatible (cifrado o ZIP64).',
  'skills.import.error.unsupportedCompression':
    'El paquete de la habilidad usa un método de compresión no compatible.',
  'skills.import.error.pathTraversal':
    'El paquete contiene un archivo cuya ruta sale de la carpeta del paquete.',
  'skills.import.error.absolutePath':
    'El paquete contiene un archivo con una ruta absoluta o con letra de unidad.',
  'skills.import.error.invalidPath': 'El paquete contiene un archivo con una ruta no válida.',
  'skills.import.error.symlink':
    'El paquete contiene un vínculo simbólico, lo que no está permitido.',
  'skills.import.error.tooDeep':
    'El paquete tiene carpetas anidadas en más niveles de los permitidos.',
  'skills.import.error.pathTooLong': 'El paquete contiene una ruta de archivo demasiado larga.',
  'skills.import.error.tooManyFiles': 'El paquete contiene más archivos de los permitidos.',
  'skills.import.error.tooLarge': 'El paquete supera el tamaño permitido.',
  'skills.import.error.fileTooLarge': 'Un archivo del paquete supera el tamaño permitido.',
  'skills.import.error.duplicatePath':
    'El paquete contiene dos archivos que corresponden a la misma ruta.',
  'skills.import.error.badExtension':
    'El paquete contiene un tipo de archivo que no está permitido.',
  'skills.import.error.nestedArchive':
    'El paquete contiene un archivo comprimido incrustado, lo que no está permitido.',
  'skills.import.error.noSkillMd': 'El paquete no contiene ningún archivo «SKILL.md».',
  'skills.import.error.invalidManifest': 'El manifiesto de la habilidad no es válido.',
  'skills.import.error.idMismatch': 'El ID de la habilidad no es un nombre válido.',
  'skills.import.error.downgradeBlocked':
    'Ya hay instalada una versión más reciente de esta habilidad. Activa el modo de desarrollo ' +
    'para instalar una versión más antigua.',
  'skills.import.error.appReadOnly': 'Las habilidades integradas no se pueden cambiar ni eliminar.',
  'skills.import.error.locked':
    'Desbloquea el espacio de trabajo para administrar las habilidades.',
  'skills.import.note.permissionNotString':
    'El permiso «{field}» no es un valor de texto; se usa el valor predeterminado «{value}».',
  'skills.import.note.permissionUnrecognized':
    'El permiso «{field}» tiene un valor que esta aplicación no reconoce; se usa el valor ' +
    'predeterminado «{value}».',
  'skills.import.note.permissionClamped':
    'La habilidad pide más acceso de tipo «{field}» del que permite esta aplicación; se limita a ' +
    '«{value}».',
  'skills.import.note.listInvalid': 'La lista «{field}» no es una lista de textos y se ignora.',
  'skills.import.note.listItemsTooLong':
    'Algunas entradas de «{field}» son demasiado largas y se ignoran.',
  'skills.import.note.listTruncated':
    'La lista «{field}» tiene más entradas de las permitidas; solo se conservan las primeras ' +
    '{max}.',
  'skills.import.note.languageInvalid':
    'El campo «language» no es una etiqueta de idioma válida; se usa «en».',
  'skills.import.note.allowedToolsIgnored':
    'Las herramientas declaradas se ignoran en una habilidad de indicaciones (las herramientas ' +
    'llegarán en una versión posterior).',
  'skills.import.note.analysisInvalid':
    'El campo «analysis» tiene un valor desconocido y se ignora.',
  'skills.import.note.analysisIgnoredForTool':
    'El campo «analysis» se ignora en una habilidad con herramientas (la aplicación decide cómo ' +
    'trabaja con el documento completo).',
  'skills.import.note.triggersInvalid': 'El bloque «triggers» no es válido y se ignora.',
  'skills.import.note.autoFireInvalid':
    'El campo «triggers.autoFire» debe ser «true» o «false»; se trata como «false».',
  'skills.import.note.localizedInvalid': 'El bloque «localized» no es válido y se ignora.',
  'skills.import.note.localizedLocaleInvalid':
    'Una entrada de «localized» tiene un código de idioma no válido y se ignora.',
  'skills.import.note.localizedEntryInvalid':
    'Una entrada de «localized» no es válida y se ignora.',
  'skills.import.note.localizedTitleIgnored':
    'Se ignoró un título traducido (debe ser una sola línea corta).',
  'skills.import.note.localizedDescriptionIgnored':
    'Se ignoró una descripción traducida (debe ser una sola línea corta).',
  'skills.import.note.localizedTooMany':
    'El bloque «localized» tiene más idiomas de los permitidos; solo se conservan los primeros ' +
    '{max}.',
  'skills.import.note.trustIgnored':
    'Se ignora el campo «trust» de la habilidad; la aplicación asigna la confianza por sí misma.',
  'skills.import.note.manifestJsonConflict':
    'El campo «{field}» del archivo «manifest.json» incluido no coincide con «SKILL.md»; se usa ' +
    '«SKILL.md».',
  'skills.replace.title': '¿Usar esta habilidad en su lugar?',
  'skills.replace.body':
    'Hay otra habilidad activada con este nombre. Si activas esta, la otra se desactiva.',
  'skills.replace.confirm': 'Activar',
  // ---- Settings → Privacy & data tab (PrivacyTab.tsx) ----
  'privacy.offlineOn': '● Modo sin conexión: activado',
  'privacy.offlineOff': '○ Acceso a la red activado',
  'privacy.statement.offline':
    'El modo sin conexión está activado. HilbertRaum ejecuta el modelo de IA en tu equipo. Tus ' +
    'preguntas, documentos, embeddings e historial de chat no salen de él.',
  'privacy.statement.online':
    'HilbertRaum ejecuta el modelo de IA en tu equipo. Tus preguntas, documentos, embeddings e ' +
    'historial de chat no salen de él. Aunque el acceso a internet esté activado, solo usan la ' +
    'red las descargas: modelos, el motor de IA, las herramientas opcionales de los paquetes de ' +
    'conocimiento y los archivos opcionales de reconocimiento de texto (OCR).',
  'privacy.statement.noUploads':
    'Esta aplicación no envía tus datos a proveedores de IA en la nube. No hay envíos de ' +
    'preguntas, documentos ni embeddings, ni telemetría, ni analítica, ni informes de errores a ' +
    'servidores remotos.',
  'privacy.network.title': 'Estado actual de la red',
  'privacy.networkState.noPolicy': 'El modo sin conexión está activado.',
  'privacy.networkState.disabledByPolicy':
    'Acceso a la red desactivado por la política de la unidad.',
  'privacy.networkState.offDefault':
    'El modo sin conexión está activado (red desactivada de forma predeterminada).',
  'privacy.networkState.enabled':
    'El acceso a internet está activado para las descargas: modelos, el motor de IA y las ' +
    'herramientas opcionales de los paquetes de conocimiento.',
  'privacy.network.noFiles': 'Ni las preguntas ni los archivos salen de este dispositivo.',
  'privacy.network.effective': 'Estado efectivo',
  'privacy.network.effectiveOffline': 'Sin conexión (no se usa internet)',
  'privacy.network.effectiveAllowed': 'Red permitida',
  'privacy.network.byPolicy': 'Permitido por la política',
  'privacy.network.policyYes': 'Sí',
  'privacy.network.policyNo': 'No (desactivado por la política)',
  'privacy.network.yourSetting': 'Tu ajuste',
  'privacy.network.settingAllowed': 'Acceso a internet permitido',
  'privacy.network.settingOff': 'Desactivado (predeterminado)',
  'privacy.network.telemetry': 'Telemetría',
  'privacy.network.telemetryValue':
    'Nada sale de este dispositivo: no hay ningún rastreo que desactivar',
  'privacy.network.hint':
    'La aplicación avisa antes de cualquier acción en internet. Lo único que descarga son ' +
    'modelos de IA, el motor de IA, las herramientas opcionales de los paquetes de conocimiento ' +
    'y los archivos opcionales de reconocimiento de texto (OCR), cada uno solo después de que lo ' +
    'confirmes y siempre verificado antes de usarlo. Está activado de forma predeterminada y se ' +
    'puede desactivar en la pestaña General. Una política de la unidad puede desactivarlo por ' +
    'completo. La API local de más abajo es una función aparte, que solo funciona si la activas ' +
    'y que nunca usa internet.',
  'privacy.data.title': 'Dónde se guardan tus datos',
  'privacy.data.driveRoot': 'Raíz de la unidad',
  'privacy.data.workspace': 'Espacio de trabajo',
  'privacy.data.models': 'Modelos',
  'privacy.data.logs': 'Registros',
  'privacy.data.loading': 'Cargando las rutas…',
  'privacy.data.hint':
    'Todo (documentos importados, texto extraído, embeddings, historial de chat, resultados ' +
    'generados y ajustes) se guarda localmente en tu espacio de trabajo. Para eliminarlo todo, ' +
    'elimina la carpeta del espacio de trabajo.',
  'privacy.logs.title': 'Solo registros locales',
  'privacy.logs.hintBefore':
    'Los registros de depuración y diagnóstico se escriben en un archivo rotativo de la carpeta ' +
    'de registros indicada arriba y ',
  'privacy.logs.never': 'nunca se envían',
  'privacy.logs.hintAfter': '. La pestaña Diagnóstico no transmite nada fuera de este dispositivo.',
  'privacy.protection.title': 'Protección del espacio de trabajo',
  'privacy.protection.encryptedBefore': 'Tu espacio de trabajo está en modo ',
  'privacy.protection.encryptedWord': 'cifrado',
  'privacy.protection.encryptedAfter': '.',
  'privacy.protection.plainBefore': 'Tu espacio de trabajo está en ',
  'privacy.protection.plainWord': 'modo de desarrollo sin cifrar',
  'privacy.protection.plainAfter':
    '. Los archivos se guardan sin cifrar en la unidad para agilizar el desarrollo.',
  'privacy.protection.plainWarning':
    'El modo de desarrollo sin cifrar no es el predeterminado de la versión comercial. Las ' +
    'unidades comerciales usan el modo cifrado: una clave derivada de la contraseña y nada ' +
    'guardado sin cifrar. No guardes documentos confidenciales en modo sin cifrar en una unidad ' +
    'compartida o extraíble.',
  // ---- Settings → Privacy & data → "Local API" card (local-api wave P4) ----
  'settings.localApi.title': 'API local',
  'settings.localApi.lead':
    'Permite que otros programas de este equipo envíen texto a tu modelo de IA y lean las ' +
    'respuestas. Esto está desactivado hasta que lo actives.',
  'settings.localApi.toggle': 'Permitir que otras aplicaciones de este equipo usen mi modelo de IA',
  'settings.localApi.hint': 'La conexión nunca sale de este equipo: no se envía nada por internet.',
  'settings.localApi.policyOff': 'Desactivado por la política de tu unidad.',
  'settings.localApi.confirm.title': '¿Permitir que otras aplicaciones usen tu modelo?',
  'settings.localApi.confirm.what':
    'Otros programas de este equipo podrán enviar texto a tu modelo de IA y leer sus respuestas.',
  'settings.localApi.confirm.boundary':
    'Esos programas no pueden ver tus documentos, archivos ni conversaciones, y nada sale de ' +
    'este equipo a través de HilbertRaum. Pero HilbertRaum no puede controlar lo que hace un ' +
    'programa conectado con las respuestas que recibe: comprueba si una aplicación guarda o ' +
    'sincroniza sus datos antes de conectarla.',
  'settings.localApi.confirm.persists': 'Esto seguirá activado hasta que lo desactives.',
  'settings.localApi.confirm.neverStored':
    'Las solicitudes de otras aplicaciones se responden y se olvidan: no se guardan en tu ' +
    'historial de chat ni en los registros.',
  'settings.localApi.confirm.ack': 'Entiendo lo que podrán hacer otras aplicaciones.',
  'settings.localApi.confirm.cta': 'Activar',
  'settings.localApi.connect.title': 'Conectar otra aplicación',
  'settings.localApi.connect.hint':
    'Pega estos dos valores en la aplicación que quieres conectar. La mayoría de las ' +
    'aplicaciones los llaman «URL base» y «clave de API» (en inglés, «base URL» y «API key»).',
  'settings.localApi.connect.address': 'Dirección del servidor',
  'settings.localApi.connect.key': 'Clave de acceso',
  'settings.localApi.connect.copy': 'Copiar',
  'settings.localApi.connect.copyAddressAria': 'Copiar la dirección del servidor',
  'settings.localApi.connect.copyKeyAria': 'Copiar la clave de acceso',
  'settings.localApi.connect.copiedAddress': 'Dirección del servidor copiada.',
  'settings.localApi.connect.copiedKey':
    'Clave copiada: se borrará del portapapeles automáticamente en un minuto. El historial o la ' +
    'sincronización del portapapeles de Windows pueden conservar copias.',
  'settings.localApi.connect.copyFailed': 'No se pudo copiar. Vuelve a intentarlo.',
  'settings.localApi.connect.noKey':
    'No hace falta ninguna clave de acceso mientras el requisito de clave esté desactivado.',
  'settings.localApi.model.running':
    'Hay un modelo en ejecución: otras aplicaciones pueden obtener respuestas.',
  'settings.localApi.model.stopped':
    'No hay ningún modelo en ejecución: otras aplicaciones recibirán un error hasta que inicies ' +
    'uno.',
  'settings.localApi.status.port': 'Disponible en el puerto {port}.',
  'settings.localApi.status.served.one': '{count} solicitud respondida hasta ahora.',
  'settings.localApi.status.served.many': '{count} de solicitudes respondidas hasta ahora.',
  'settings.localApi.status.served.other': '{count} solicitudes respondidas hasta ahora.',
  'settings.localApi.status.off': 'No está en ejecución.',
  'settings.localApi.busyWarning':
    'Una aplicación está usando tu modelo en este momento. Si chateas aquí a la vez, ambos ' +
    'pueden ir más lentos; tu propio chat siempre tiene prioridad.',
  'settings.localApi.preemptedWarning':
    'Hace un momento, tu propio uso de HilbertRaum interrumpió la solicitud de una aplicación. ' +
    'La aplicación puede simplemente volver a intentarlo.',
  'settings.localApi.token.toggle': 'Exigir una clave de acceso',
  'settings.localApi.token.hint': 'Recomendado: mantenlo activado.',
  'settings.localApi.token.confirm.title': '¿Desactivar la clave de acceso?',
  'settings.localApi.token.confirm.body':
    'Sin clave de acceso, cualquier programa de este equipo puede usar tu modelo de IA sin ' +
    'preguntar. Mantenla activada salvo que una aplicación de verdad no pueda introducir una ' +
    'clave.',
  'settings.localApi.token.confirm.cta': 'Desactivar',
  'settings.localApi.token.regenerate': 'Crear una clave nueva',
  'settings.localApi.token.regenerate.title': '¿Crear una clave de acceso nueva?',
  'settings.localApi.token.regenerate.body':
    'Las aplicaciones que usan la clave antigua dejarán de funcionar hasta que pegues en ellas ' +
    'la clave nueva.',
  'settings.localApi.token.regenerate.cta': 'Crear clave nueva',
  'settings.localApi.token.regenerated': 'Se creó una clave de acceso nueva.',
  'settings.localApi.token.regenerateFailed':
    'No se pudo crear una clave nueva. Vuelve a intentarlo.',
  'settings.localApi.port.label': 'Número de puerto',
  'settings.localApi.port.hint':
    'Cámbialo solo si otro programa ya usa este número. Entre 1024 y 65535.',
  'settings.localApi.error.portInUse':
    'Otro programa de este equipo ya está usando este número. Eso también puede significar que ' +
    'otro programa se hace pasar por HilbertRaum, así que no pegues tu clave de acceso en ningún ' +
    'sitio hasta resolverlo. Cambia el número (por ejemplo, a {suggestion}) y vuelve a activar ' +
    'la API local; si ya había una aplicación conectada, pega también en ella la nueva dirección ' +
    'del servidor.',
  'settings.localApi.error.startFailed':
    'No se pudo iniciar la API local. Encontrarás los detalles en la pestaña Diagnóstico.',
  // ---- Settings → Diagnostics tab (DiagnosticsTab.tsx) ----
  'diag.localOnly': 'Diagnóstico solo local. Nada de esto se envía nunca.',
  'diag.localApi.label': 'API local',
  'diag.localApi.off': 'Desactivada',
  'diag.localApi.running':
    'Activada · puerto {port} · respondidas: {served}, rechazadas: {rejected}',
  'diag.localApi.portInUse': 'Desactivada: el número de puerto ya está en uso',
  'diag.localApi.startFailed': 'Desactivada: no se pudo iniciar',
  'diag.audit.runtime_started': 'Modelo iniciado',
  'diag.audit.runtime_stopped': 'Modelo detenido',
  'diag.audit.runtime_crashed': 'Modelo detenido de forma inesperada',
  'diag.audit.runtime_fallback': 'Modo de compatibilidad',
  'diag.audit.model_selected': 'Modelo seleccionado',
  'diag.audit.model_verified': 'Suma de comprobación del modelo verificada',
  'diag.audit.model_download_started': 'Descarga iniciada',
  'diag.audit.model_download_verified': 'Descarga verificada',
  'diag.audit.model_download_failed': 'Error en la descarga',
  'diag.audit.document_imported': 'Documento importado',
  'diag.audit.document_reindexed': 'Documento reindexado',
  'diag.audit.document_deleted': 'Documento eliminado',
  'diag.audit.document_task_completed': 'Tarea de documentos completada',
  'diag.audit.document_task_failed': 'Error en una tarea de documentos',
  'diag.audit.document_exported': 'Documento exportado',
  'diag.audit.summary_exported': 'Resumen exportado',
  'diag.audit.conversation_deleted': 'Conversación eliminada',
  'diag.audit.conversation_exported': 'Conversación exportada',
  'diag.audit.message_table_exported': 'Tabla de una respuesta exportada',
  'diag.audit.code_block_exported': 'Bloque de código guardado como archivo',
  'diag.audit.workspace_created': 'Espacio de trabajo creado',
  'diag.audit.workspace_unlocked': 'Espacio de trabajo desbloqueado',
  'diag.audit.workspace_locked': 'Espacio de trabajo bloqueado',
  'diag.audit.workspace_unlock_failed': 'Intento de desbloqueo fallido',
  'diag.audit.workspace_lock_failed':
    'Intento de bloqueo fallido (el espacio de trabajo siguió abierto)',
  'diag.audit.workspace_password_changed': 'Contraseña del espacio de trabajo cambiada',
  'diag.audit.settings_changed': 'Ajustes cambiados',
  'diag.audit.local_api_toggled': 'API local activada o desactivada',
  'diag.audit.policy_warning': 'Aviso de política',
  'diag.audit.offline_guard_violation': 'Intento de acceso a la red detectado',
  'diag.audit.collection_created': 'Proyecto creado',
  'diag.audit.collection_renamed': 'Nombre de proyecto cambiado',
  'diag.audit.collection_archived': 'Proyecto archivado o desarchivado',
  'diag.audit.collection_deleted': 'Proyecto eliminado',
  'diag.audit.documents_added_to_collection': 'Documentos agregados a una sección o un proyecto',
  'diag.audit.documents_removed_from_collection':
    'Documentos quitados de una sección o un proyecto',
  'diag.audit.document_lifecycle_changed': 'Estado de un documento cambiado',
  'diag.audit.skill_imported': 'Habilidad importada',
  'diag.audit.skill_deleted': 'Habilidad eliminada',
  'diag.audit.skill_enabled': 'Habilidad activada',
  'diag.audit.skill_disabled': 'Habilidad desactivada',
  'diag.audit.skill_run_started': 'Herramienta de habilidad iniciada',
  'diag.audit.skill_run_done': 'Herramienta de habilidad completada',
  'diag.audit.skill_run_failed': 'Error en una herramienta de habilidad',
  'diag.audit.evidence_review_created': 'Revisión de evidencia creada',
  'diag.audit.evidence_review_ready': 'Revisión de evidencia marcada como lista',
  'diag.audit.evidence_review_deleted': 'Revisión de evidencia eliminada',
  'diag.audit.evidence_pack_exported': 'Paquete de evidencia exportado',
  'diag.audit.knowledge_pack_added': 'Paquete de conocimiento agregado',
  'diag.audit.knowledge_pack_removed': 'Paquete de conocimiento quitado',
  'diag.audit.knowledge_pack_article_saved':
    'Artículo de un paquete de conocimiento guardado como documento',
  'diag.accel.gpuFallbackName': 'Tarjeta gráfica',
  'diag.accel.gpu': '{name} (GPU)',
  'diag.accel.mock': 'Modo de demostración integrado',
  'diag.app.engine': 'Motor de IA',
  'diag.app.voiceEngine': 'Motor de voz',
  'diag.engine.cannotRun': 'No puede funcionar: {reason}',
  'diag.engine.reason.libraryMissing': 'falta una biblioteca del sistema',
  'diag.engine.reason.systemTooOld': 'hace falta una versión más reciente del sistema operativo',
  'diag.engine.reason.filesDamaged': 'faltan archivos del motor o están dañados',
  'diag.engine.reason.filesDamagedAfterInstall':
    'archivos del motor marcados como dañados justo después de una instalación nueva',
  'diag.engine.reason.vcRuntimeMissing': 'falta Microsoft Visual C++ Redistributable',
  'diag.engine.reason.blocked': 'bloqueado por la seguridad de Windows',
  'diag.accel.cpu': 'Procesador (CPU)',
  'diag.accel.gpuAvailable': '{name} (GPU disponible)',
  'diag.app.title': 'Aplicación y motor',
  'diag.app.version': 'Versión de la aplicación',
  'diag.app.unknown': 'sin datos',
  'diag.app.selectedModel': 'Modelo seleccionado',
  'diag.app.noneSelected': 'ninguno seleccionado',
  'diag.app.profile': 'Perfil de hardware',
  'diag.app.runtime': 'Motor',
  'diag.app.unknownModel': 'modelo desconocido',
  'diag.app.onPort': ' en 127.0.0.1:{port}',
  'diag.app.healthy': 'responde',
  'diag.app.unhealthy': 'no responde',
  'diag.app.runtimeRunning': 'En ejecución: {model}{onPort} ({health})',
  'diag.app.stopped': 'Detenido',
  'diag.app.acceleration': 'Aceleración',
  'diag.app.runtimeBuild': 'Compilación del motor',
  'diag.app.noInstallMarker': 'sin marca de instalación (unidad preparada a mano)',
  'diag.app.engineVersions': 'Versiones de los motores',
  'diag.engineVersion.older': '{engine} {installed}, esta aplicación espera {pinned}',
  'diag.engineVersion.newer':
    '{engine} {installed}, más reciente de lo que espera esta aplicación ({pinned})',
  'diag.engineVersion.unknown': '{engine}: sin versión registrada, esta aplicación espera {pinned}',
  'diag.engineVersion.cpuNet': '{engine} (compilación de reserva para el procesador)',
  'diag.gpu.compat':
    'Modo de compatibilidad activado: las respuestas usan el procesador, que funciona en ' +
    'cualquier equipo.',
  'diag.gpu.tryHint':
    'Si actualizaste el controlador gráfico, puedes volver a probar la tarjeta gráfica.',
  'diag.gpu.offHint':
    'La aceleración por GPU está desactivada en Ajustes: vuelve a activarla allí para usar de ' +
    'nuevo la tarjeta gráfica.',
  'diag.gpu.tryAgain': 'Volver a probar la GPU',
  'diag.gpu.tryFailed': 'No funcionó volver a probar la tarjeta gráfica: {error}',
  'diag.refresh': 'Actualizar',
  // ---- Performance screen (PerformanceScreen.tsx; benchmark.md "Performance screen") ----
  'perf.title': 'Rendimiento',
  'perf.lead':
    'La velocidad a la que este equipo ejecuta tu modelo de IA, medida en este dispositivo. No ' +
    'se envía nada a ninguna parte.',
  'perf.card.title': 'Este equipo',
  'perf.checkedAt': 'Comprobado el {when}',
  'perf.notChecked': 'Todavía sin comprobar',
  'perf.otherMachine':
    'Este resultado se midió en otro equipo. Vuelve a hacer la comprobación para medir este.',
  'perf.report.otherComputer': 'Otro equipo: {cpu}, {ram} GB de RAM',
  'perf.verdict.speed': 'Este equipo ejecuta {model} a unos {tps} tok/s.',
  'perf.verdict.noSpeed':
    '{model} es el que mejor se ajusta a la memoria de este equipo ({basis}). La velocidad se ' +
    'mide después de ejecutar un modelo.',
  'perf.basis.discrete': 'memoria gráfica',
  'perf.basis.unified': 'memoria unificada',
  'perf.basis.cpu': 'RAM',
  'perf.recommendation.atCheckTime': 'Recomendado en el momento de la comprobación',
  'perf.recommendation.next': 'Recomendado para el próximo inicio',
  'perf.recommendation.nextOnThisComputer': 'Recomendado para el próximo inicio en este equipo',
  'perf.verdict.noRecommendation':
    'Todavía no hay ningún modelo del catálogo adecuado para este equipo.',
  'perf.verdict.notChecked':
    'Una comprobación rápida mide la memoria, la velocidad de la unidad y, cuando hay un modelo ' +
    'en ejecución, la velocidad de generación.',
  'perf.verdict.driveFast': 'Los modelos se inician rápido desde esta unidad.',
  'perf.verdict.driveSlow': 'Los modelos se inician despacio desde esta unidad.',
  'perf.tile.speed': 'Velocidad',
  'perf.tile.speed.unit': 'tok/s',
  'perf.tile.speed.sub': 'Medida con {model} el {when}',
  'perf.tile.speed.approx': 'Aproximada: fragmentos contados, no tiempos medidos por el motor',
  'perf.tile.speed.chunks': 'fragmentos: {chunks}',
  'perf.tile.speed.none': 'Todavía sin medir',
  'perf.tile.speed.noneHint': 'Inicia un modelo y vuelve a hacer la comprobación',
  'perf.tile.memory': 'Memoria',
  'perf.tile.memory.unit': 'GB de RAM',
  'perf.tile.memory.unified': 'Memoria unificada',
  'perf.tile.memory.unifiedSub': 'Compartida por el procesador y los núcleos gráficos',
  'perf.model.title': 'Tu modelo',
  'perf.model.line.one': '{model} · {size} GB en la unidad · contexto de {context} token',
  'perf.model.line.many': '{model} · {size} GB en la unidad · contexto de {context} de tokens',
  'perf.model.line.other': '{model} · {size} GB en la unidad · contexto de {context} tokens',
  'perf.model.none':
    'Todavía no hay ningún modelo seleccionado. Elige uno en la pantalla Modelo de IA.',
  'perf.model.need': 'Ocupa {need} GB con este contexto.',
  'perf.model.needEstimate':
    'Necesita al menos {need} GB para los pesos, más la caché de contexto, que se mide en el ' +
    'primer inicio.',
  'perf.model.gpu':
    'Cabe en la memoria gráfica ({budget} GB): todas las capas ({layers}) en la GPU.',
  'perf.model.gpuEstimate': 'Debería caber en la memoria gráfica ({budget} GB).',
  'perf.model.partial':
    'La memoria gráfica tiene {budget} GB. Capas en la GPU: {gpuLayers} de {layers}; unos ' +
    '{spill} GB se ejecutan desde la RAM. Las respuestas son más lentas.',
  'perf.model.partialFree':
    'Capas en la GPU: {gpuLayers} de {layers}; unos {spill} GB se ejecutan desde la RAM, porque ' +
    'al iniciarse el modelo había {free} GB libres de los {budget} GB de la tarjeta y el motor ' +
    'reserva un margen de seguridad de {margin} GB. Las respuestas son más lentas. Reinicia el ' +
    'modelo cuando la tarjeta esté libre.',
  'perf.model.partialMargin':
    'Capas en la GPU: {gpuLayers} de {layers}; unos {spill} GB se ejecutan desde la RAM. La ' +
    'tarjeta estaba libre ({free} de {budget} GB), pero el motor también reserva {working} GB ' +
    'para búferes de trabajo y un margen de seguridad de {margin} GB, y saca capas enteras de la ' +
    'tarjeta cuando la suma se acerca al límite. Las respuestas son más lentas.',
  'perf.model.partialMarginNoWorking':
    'Capas en la GPU: {gpuLayers} de {layers}; unos {spill} GB se ejecutan desde la RAM. La ' +
    'tarjeta estaba libre ({free} de {budget} GB), pero el motor también reserva búferes de ' +
    'trabajo y un margen de seguridad de {margin} GB, y saca capas enteras de la tarjeta cuando ' +
    'la suma se acerca al límite. Las respuestas son más lentas.',
  'perf.model.partialEstimate':
    'La memoria gráfica tiene {budget} GB: unos {spill} GB se ejecutarán desde la RAM. Las ' +
    'respuestas serán más lentas.',
  'perf.model.cpu': 'Se ejecuta en el procesador desde la RAM ({budget} GB).',
  'perf.model.cpuEstimate': 'Se ejecutará en el procesador desde la RAM ({budget} GB).',
  'perf.model.unified':
    'Cabe en la memoria unificada ({ram} GB, con hasta {budget} GB disponibles para el modelo).',
  'perf.model.unifiedEstimate':
    'Debería caber en la memoria unificada ({ram} GB, con hasta {budget} GB disponibles para el ' +
    'modelo).',
  'perf.model.tooLarge':
    'Es demasiado grande para este equipo ({budget} GB disponibles). Elige un modelo más pequeño.',
  'perf.model.unknown':
    'Se medirá dónde se carga el modelo la primera vez que se inicie en este equipo.',
  'perf.model.unknownObserved': 'El motor no informó dónde se cargó el modelo.',
  'perf.model.perDrive':
    'La unidad guarda una sola medición por modelo, así que si se inicia en otro equipo, esa ' +
    'medición reemplaza la que se tomó aquí.',
  'perf.model.measuredOther.one':
    'Se midió antes con un contexto de {context} token, el {when}; la estimación de arriba ' +
    'corresponde a los ajustes actuales.',
  'perf.model.measuredOther.many':
    'Se midió antes con un contexto de {context} de tokens, el {when}; la estimación de arriba ' +
    'corresponde a los ajustes actuales.',
  'perf.model.measuredOther.other':
    'Se midió antes con un contexto de {context} tokens, el {when}; la estimación de arriba ' +
    'corresponde a los ajustes actuales.',
  'perf.model.runningOnCard': 'Ahora mismo se ejecuta en la tarjeta gráfica.',
  'perf.model.choose': 'Elegir un modelo más pequeño',
  'perf.models.title': 'Modelos en este equipo',
  'perf.models.hint':
    'El chat y la traducción comparten la tarjeta gráfica. Las imágenes, la búsqueda en ' +
    'documentos y la voz se ejecutan en el procesador por diseño, así que usan RAM, no memoria ' +
    'gráfica.',
  'perf.role.chat': 'Chat',
  'perf.role.translation': 'Traducción',
  'perf.role.vision': 'Imágenes',
  'perf.role.reranker': 'Búsqueda en documentos (reordenación)',
  'perf.role.embeddings': 'Búsqueda en documentos (índice)',
  'perf.role.transcriber': 'Voz',
  'perf.models.row': '{model} · {size} GB',
  'perf.models.rowNoSize': '{model}',
  'perf.models.none': 'No hay ningún modelo instalado para esta función.',
  'perf.models.device.gpu': 'tarjeta gráfica',
  'perf.models.device.cpu': 'procesador, por diseño',
  'perf.models.device.processor': 'procesador',
  'perf.models.loaded': 'cargado ahora',
  'perf.models.notLoaded': 'sin cargar',
  'perf.models.lifetime.session': 'permanece cargado',
  'perf.models.lifetime.idle': 'se libera de la memoria si está inactivo',
  'perf.models.lifetime.per-use': 'solo se ejecuta mientras se usa',
  'perf.models.split': 'capas en la tarjeta: {gpuLayers} de {layers}',
  'perf.models.card':
    'Tarjeta gráfica: chat {chat} GB + traducción {translation} GB, de {vram} GB.',
  'perf.models.cardReranker': 'Tarjeta gráfica: reordenación {reranker} GB, de {vram} GB.',
  'perf.models.cardBoth':
    'Ahora mismo los dos están en la tarjeta. El que se inició en segundo lugar recibió lo que ' +
    'quedaba y va más lento; detenlo y vuelve a iniciarlo cuando el otro haya liberado la ' +
    'memoria.',
  'perf.models.ram': 'Todo cargado a la vez necesita unos {sum} GB de los {ram} GB de RAM.',
  'perf.models.memory':
    'Todo cargado a la vez necesita unos {sum} GB de los {budget} GB de memoria unificada ' +
    'disponibles para los modelos.',
  'perf.models.ramTooMuch': 'Demasiado a la vez',
  'perf.models.ramOk': 'Cabe',
  'perf.place.gpu': 'En la GPU',
  'perf.place.partial': 'Parte en la GPU',
  'perf.place.cpu': 'En el procesador',
  'perf.place.tooLarge': 'No cabe',
  'perf.place.unknown': 'Sin medir',
  'perf.tile.graphics': 'Memoria gráfica',
  'perf.tile.graphics.unit': 'GB de VRAM',
  'perf.tile.graphics.none':
    'No hay ninguna tarjeta gráfica utilizable. Los modelos se ejecutan en el procesador.',
  'perf.tile.graphics.engine':
    'El motor de IA no puede funcionar en este equipo, así que no se pudo comprobar la tarjeta ' +
    'gráfica.',
  'perf.tile.graphics.off':
    'La aceleración por GPU está desactivada. Los modelos se ejecutan en el procesador.',
  'perf.tile.graphics.small': 'Menos de {min} GB: los modelos se ejecutan en el procesador.',
  'perf.tile.graphics.integrated':
    'Integrada, con memoria compartida: los modelos se ejecutan en el procesador.',
  'perf.tile.graphics.unitShared': 'GB compartidos',
  'perf.tile.graphics.notRecorded': 'Esa comprobación no registró la tarjeta gráfica.',
  'perf.rating.usable': 'Utilizable',
  'perf.rating.small': 'Pequeña',
  'perf.rating.integrated': 'Integrada',
  'perf.rating.notRecorded': 'Sin registrar',
  'perf.rating.none': 'Ninguna',
  'perf.rating.unknown': 'Desconocida',
  'perf.others.subGpu': '{cpu}, {ram} GB de RAM, {vram} GB de VRAM · {when}',
  'perf.tile.drive': 'Unidad',
  'perf.tile.drive.unit': 'MB/s de lectura',
  'perf.tile.drive.load': 'Medida al cargar un modelo el {when}; lectura: {gb} GB',
  'perf.tile.drive.hash': 'Medida en una comprobación de archivos el {when}; lectura: {gb} GB',
  'perf.tile.drive.none': 'Todavía sin medir',
  'perf.tile.drive.noneHint':
    'Se mide en la primera carga de un modelo o en la primera comprobación de archivos',
  'perf.rating.good': 'Buena',
  'perf.rating.slow': 'Lenta',
  'perf.rating.fast': 'Rápida',
  'perf.rating.pending': 'Pendiente',
  'perf.rating.approx': 'Aproximada',
  'perf.rating.slowDrive': 'Unidad lenta',
  'perf.profile.TINY': 'Mínimo',
  'perf.profile.LITE': 'Ligero',
  'perf.profile.BALANCED': 'Equilibrado',
  'perf.profile.PRO': 'Pro',
  'perf.profile.UNKNOWN': 'Desconocido',
  'perf.check': 'Comprobar este equipo',
  'perf.checkAgain': 'Volver a comprobar',
  'perf.running': 'Comprobando…',
  'perf.startAndMeasure': 'Iniciar {model} y medir',
  'perf.contextSize': 'Cambiar el tamaño de contexto',
  'perf.copy': 'Copiar informe',
  'perf.autoNote':
    'La comprobación se hace automáticamente la primera vez y cada vez que conectas esta unidad ' +
    'a otro equipo.',
  'perf.failed': 'No se pudo hacer la comprobación: {error}',
  'perf.loadFailed': 'No se pudieron leer los valores más recientes: {error}',
  'perf.retry': 'Volver a intentarlo',
  'perf.step.system': 'Hardware detectado',
  'perf.step.drive': 'Velocidad de la unidad',
  'perf.step.speed': 'Velocidad de generación con {model}',
  'perf.step.speedSkipped': 'Velocidad de generación (omitida: no hay ningún modelo en ejecución)',
  'perf.step.hint': 'Tarda alrededor de medio minuto. Puedes seguir usando la aplicación.',
  'perf.running.background': 'Se está comprobando este equipo en segundo plano.',
  'perf.step.state.done': '{step}: completado',
  'perf.step.state.active': '{step}: en curso',
  'perf.step.state.todo': '{step}: en espera',
  'perf.observed.title': 'Observado mientras trabajabas',
  'perf.observed.hint':
    'Valores reales del uso normal, no de la pregunta de la prueba de rendimiento. Estas filas ' +
    'solo duran esta sesión; las velocidades de lectura que muestran también se guardan con los ' +
    'valores de la unidad de arriba.',
  'perf.observed.none':
    'En esta sesión todavía no se observó nada. Hazle una pregunta al modelo o inícialo.',
  'perf.observed.answer': 'Última respuesta: {tps} tok/s, primer token a los {ttft} s',
  'perf.observed.answerSub': '{model}, {when}, tokens: {tokens}',
  'perf.observed.load': 'Carga del modelo: {seconds} s',
  'perf.observed.loadSub': '{model}; lectura desde esta unidad: {gb} GB a {mbps} MB/s',
  'perf.observed.check': 'Comprobación de archivos: {seconds} s',
  'perf.observed.checkSub':
    '{model}: comprobación completa de archivos el {when}; lectura: {gb} GB',
  'perf.observed.oncePerModel': 'Una vez por modelo',
  'perf.others.title': 'Otros equipos en los que se usó esta unidad',
  'perf.others.hint':
    'Cada equipo conserva su propio resultado, así que el modelo recomendado depende del equipo, ' +
    'no de la unidad.',
  'perf.others.none':
    'Todavía no hay ninguno. Si conectas la unidad a otro equipo, ese equipo se comprobará ' +
    'automáticamente.',
  'perf.others.row': '{tps} tok/s con {model}',
  'perf.others.rowNoSpeed': 'Recomendado: {model}; velocidad sin medir',
  'perf.others.sub': '{cpu}, {ram} GB de RAM · {when}',
  'perf.others.load': 'carga del modelo: {seconds} s',
  'perf.others.check': 'comprobación de archivos: {seconds} s',
  'perf.footer':
    'El informe técnico completo, con todos los valores sin procesar, está en la pestaña ' +
    'Diagnóstico de Ajustes.',
  'perf.footerLink': 'Abrir Diagnóstico',
  'perf.unknownModel': 'el modelo cargado',
  'perf.unknownCpu': 'Procesador desconocido',
  'diag.bench.title': 'Prueba de rendimiento del hardware',
  'diag.bench.hint':
    'Los valores sin procesar de la última comprobación en este equipo, para un mensaje al ' +
    'soporte técnico. La pantalla Rendimiento explica qué significan y hace una nueva ' +
    'comprobación. Todo se mide sin conexión: ningún dato sale de tu equipo.',
  'diag.bench.empty':
    'Todavía no se hizo ninguna comprobación en este equipo. Abre la pantalla Rendimiento para ' +
    'hacer una.',
  'diag.bench.profile': 'Perfil asignado',
  'diag.bench.noMatch': 'Ningún modelo adecuado',
  'diag.bench.ram': 'RAM',
  'diag.bench.cpu': 'Procesador',
  'diag.bench.cores.one': ' ({count} núcleo)',
  'diag.bench.cores.many': ' ({count} de núcleos)',
  'diag.bench.cores.other': ' ({count} núcleos)',
  'diag.bench.osArch': 'Sistema operativo / arquitectura',
  'diag.bench.gpu': 'Tarjeta gráfica',
  'diag.bench.notDetected': 'no detectada',
  'diag.bench.effectiveRead': 'Velocidad de lectura medida',
  'diag.bench.effectiveReadNone': 'todavía sin medir: se mide al iniciar un modelo',
  'diag.bench.effectiveReadLoad': 'al cargar un modelo el {when}; lectura: {gb} GB',
  'diag.bench.effectiveReadHash': 'en una comprobación de archivos el {when}; lectura: {gb} GB',
  'diag.bench.driveWrite': 'Escritura en la unidad',
  'diag.bench.notMeasured': 'sin medir',
  'diag.bench.tokens': 'Velocidad de generación (tok/s)',
  'diag.bench.tokensNotMeasured': 'sin medir (primero inicia un modelo)',
  'diag.bench.tokensModel': 'medida con el modelo cargado {model}',
  'diag.bench.tokensOver': 'tokens medidos: {tokens}',
  'diag.bench.tokensApprox': 'aproximada: fragmentos contados, no tiempos medidos por el motor',
  'diag.bench.lastRun': 'Última comprobación',
  'diag.system.title': 'Sistema',
  'diag.system.osPlatform': 'Sistema operativo / plataforma',
  'diag.system.freeSpace': 'Espacio libre',
  'diag.system.imagesSize': 'Tamaño del historial de imágenes',
  'diag.system.loadFailed':
    'Todavía no se pudieron cargar los detalles del sistema. Prueba a volver a abrir esta ' +
    'pestaña.',
  'diag.paths.title': 'Rutas',
  'diag.paths.prepared': 'Unidad preparada',
  'diag.paths.yes': 'Sí',
  'diag.paths.noFallback': 'No (se usa la carpeta de datos de la aplicación)',
  'diag.paths.writable': 'Se puede escribir',
  'diag.paths.no': 'No',
  'diag.paths.loadFailed':
    'Todavía no se pudieron cargar los detalles de la unidad y del espacio de trabajo. Prueba a ' +
    'volver a abrir esta pestaña.',
  'diag.activity.title': 'Actividad',
  'diag.activity.hint':
    'Un registro local de lo que hizo la aplicación: inicios de modelos, descargas, ' +
    'importaciones de documentos y eventos del espacio de trabajo. Se queda en tu espacio de ' +
    'trabajo (cifrado si el espacio de trabajo lo está) y nunca se envía. Nunca contiene texto ' +
    'de chats ni el contenido de los documentos.',
  'diag.activity.show': 'Mostrar la actividad',
  'diag.activity.hide': 'Ocultar la actividad',
  'diag.activity.export': 'Exportar a un archivo…',
  'diag.activity.savedTo': 'Registro de actividad guardado en {path}',
  'diag.activity.filterShow': 'Mostrar',
  'diag.activity.filterAll': 'Toda la actividad',
  'diag.activity.loading': 'Cargando…',
  'diag.activity.empty':
    'Todavía no hay nada registrado: la actividad aparece aquí a medida que usas la aplicación.',
  'diag.activity.earlier': 'Mostrar actividad anterior',
  'diag.logs.title': 'Registros recientes',
  'diag.logs.hintBefore': 'El final de ',
  'diag.logs.hintAfter':
    ' en este dispositivo. Los registros son solo locales y nunca se envían; no contienen el ' +
    'contenido de los documentos ni texto de chats.',
  'diag.logs.show': 'Mostrar los registros',
  'diag.logs.hide': 'Ocultar los registros',
  'diag.logs.empty': '(el registro está vacío)',
  'diag.logs.save': 'Guardar en un archivo…',
  'diag.logs.savedTo': 'Registros guardados en {path}',
  'diag.copy': 'Copiar',
  'diag.copyTitle': 'Copiar estos detalles en el portapapeles',
  'diag.copied': 'Copiado en el portapapeles',
  'diag.copyFailed': 'No se pudo copiar en el portapapeles',
  // ---- Shared components' built-in copy (receive a bound t — i18n record §5 ⑤) ----
  'common.dismiss': 'Descartar',
  'common.close': 'Cerrar',
  'common.cancel': 'Cancelar',
  'common.remove': 'Quitar',
  'common.apply': 'Aplicar',
  'indicator.offline': 'Local · Sin conexión',
  'indicator.online': 'Local · Descargas permitidas',
  'indicator.offlineDetail': 'Todo se queda en esta unidad. No se usa ninguna conexión a internet.',
  'indicator.onlineDetail':
    'Descargas permitidas: los chats y los documentos no salen de tu equipo.',
  'indicator.short.offline': 'Sin conexión',
  'indicator.short.online': 'Descargas activadas',
  'indicator.withLocalApi': '{state} · API activada',
  'indicator.localApiDetail':
    'Otras aplicaciones de este equipo pueden usar tu modelo. Nada sale de este equipo.',
  // ---- Shared password copy ----
  'password.mismatch': 'Las contraseñas no coinciden.',
  'password.show': 'Mostrar la contraseña',
  'password.hide': 'Ocultar la contraseña',
  'password.strength.tooShort': 'Demasiado corta',
  'password.strength.weak': 'Débil',
  'password.strength.okay': 'Aceptable',
  'password.strength.strong': 'Fuerte',
  'password.strength.veryStrong': 'Muy fuerte',
  'password.strength.minHint': 'Usa al menos 8 caracteres.',
  'password.strength.longerHint':
    'Cuanto más larga, más fuerte: funcionan bien 12 caracteres o más, o unas cuantas palabras ' +
    'sin relación entre sí.',
  // ---- Workspace gate (WorkspaceGate.tsx) ----
  'gate.passwordPlaceholder': 'Contraseña',
  'gate.unlock.title': 'Desbloquea tu espacio de trabajo',
  'gate.unlock.hint':
    'Escribe tu contraseña para abrir el espacio de trabajo de esta unidad. Todo se queda en ' +
    'esta unidad.',
  'gate.unlock.submit': 'Desbloquear',
  'gate.unlock.submitBusy': 'Desbloqueando…',
  'gate.welcome.title': 'Te damos la bienvenida',
  'gate.welcome.intro':
    'Este es tu espacio de trabajo de IA privado. Chatea con un modelo de IA y haz preguntas ' +
    'sobre tus documentos: todo funciona desde esta unidad.',
  'gate.welcome.stays': 'Todo se queda en esta unidad.',
  'gate.welcome.staysRest': 'Sin internet, sin cuenta y sin rastreo.',
  'gate.welcome.start': 'Empezar',
  'gate.finishing.title': 'Configurando todo…',
  'gate.finishing.hint':
    'Comprobando lo que ya hay en esta unidad. La primera lectura de un archivo grande de modelo ' +
    'de IA puede tardar unos minutos.',
  'gate.finishing.progress': 'Comprobando el modelo de IA {n} de {m}: {name} ({pct}\u00A0%)',
  'gate.finishing.skip': 'Omitir y abrir la aplicación',
  'gate.starter.title': 'Una última cosa',
  'gate.starter.noModel':
    'Todavía no hay ningún modelo de IA instalado en esta unidad, y el chat necesita uno para ' +
    'responder. Puedes agregar uno ahora o en cualquier momento más adelante desde la pantalla ' +
    'Modelo de IA.',
  'gate.starter.optional':
    'Descargar un modelo es opcional y siempre se te pide confirmación antes. Tus documentos y ' +
    'chats nunca usan internet, en ningún caso.',
  'gate.starter.skip': 'Omitir por ahora',
  'gate.starter.addDocuments': 'Agregar documentos',
  'gate.starter.chooseModel': 'Elegir tu modelo de IA',
  'gate.create.title': 'Crea tu contraseña',
  'gate.create.hint':
    'Esta contraseña protege todo lo que hay en tu espacio de trabajo (documentos, chats y ' +
    'notas) en esta unidad. No se puede recuperar ni restablecer, así que elige una que vayas a ' +
    'recordar.',
  'gate.create.plaintextToggle': 'Usar un espacio de trabajo de desarrollo sin cifrar',
  'gate.create.plaintextWarning':
    'El modo sin cifrar guarda tus datos en esta unidad sin ningún cifrado. Úsalo solo para ' +
    'desarrollo.',
  'gate.create.confirmPlaceholder': 'Confirmar la contraseña',
  'gate.create.back': 'Volver',
  'gate.create.submit': 'Crear espacio de trabajo',
  'gate.create.submitBusy': 'Creando…',
  'gate.error.generic': 'Algo salió mal. Vuelve a intentarlo.',
  // ---- Main-process strings (Phase 41, i18n record §3.3 two-rule boundary) --------------
  'main.ingest.pdfScanDetected': 'Este PDF parece un escaneo: todavía no tiene texto legible.',
  'main.ingest.audioNeedsTranscriber':
    'Para importar audio hace falta el modelo de transcripción: descárgalo en la pantalla Modelo ' +
    'de IA.',
  'main.ingest.audioNeedsEngine':
    'Para importar audio hace falta el motor de voz: instálalo en la pantalla Modelo de IA.',
  'main.ingest.audioNeedsModelAndEngine':
    'Para importar audio hacen falta el modelo de transcripción y el motor de voz: agrega los ' +
    'dos en la pantalla Modelo de IA.',
  'main.ingest.audioEngineUnsupported':
    'La importación de audio todavía no está disponible en este sistema operativo: la aplicación ' +
    'no puede instalar aquí el motor de voz que necesita.',
  'main.ingest.audioUnreadable':
    'No se pudo leer este archivo de audio. Conviértelo a WAV o MP3 y vuelve a importarlo.',
  'main.ingest.audioTranscriptionFailed':
    'No se pudo transcribir la grabación. Reindexa este documento para volver a intentarlo.',
  'main.ingest.engineCannotRun':
    'El motor de IA no puede funcionar en este equipo, así que no se pudo indexar este ' +
    'documento. En la pantalla Modelo de IA se indica qué hacer; después, vuelve a intentarlo.',
  'main.ingest.engineLibraryMissing':
    'El motor de IA no puede funcionar en este equipo porque falta la biblioteca del sistema ' +
    '{library}. En la pantalla Modelo de IA se indica cómo solucionarlo; después, vuelve a ' +
    'intentarlo.',
  'main.ingest.voiceEngineCannotRun':
    'El motor de voz no puede funcionar en este equipo, así que no se pudo transcribir esta ' +
    'grabación. En la pantalla Modelo de IA se indica qué hacer; después, reindexa este ' +
    'documento.',
  'main.ingest.searchModelTimeout':
    'El modelo de búsqueda no respondió a tiempo, así que no se pudo indexar este documento. ' +
    'Vuelve a intentarlo.',
  'main.ingest.searchModelCannotStart':
    'El modelo de búsqueda no pudo iniciarse, así que no se pudo indexar este documento. En la ' +
    'pantalla Modelo de IA, elige «Comprobar todos los archivos de modelo» y después vuelve a ' +
    'intentarlo.',
  'main.ingest.searchModelFailed':
    'El modelo de búsqueda tuvo un problema, así que no se pudo indexar este documento. Vuelve a ' +
    'intentarlo.',
  'main.ingest.imageNeedsOcr':
    'Para importar fotos hacen falta los archivos de reconocimiento de texto (OCR), que no están ' +
    'en esta unidad.',
  'main.ingest.imageNoText':
    'No se encontró texto legible en esta foto. Prueba con una imagen de la página más nítida y ' +
    'más cercana.',
  'main.ingest.imageOcrFailed': 'No se pudo leer esta foto. Reindéxala para volver a intentarlo.',
  'main.ingest.imageOcrUnavailable':
    'El reconocimiento de texto (OCR) no pudo funcionar en esta versión, así que esta foto se ' +
    'guardó sin texto legible. Reindéxala cuando el OCR esté disponible.',
  'main.ingest.sourceMissing': 'No se encontró el archivo original.',
  'main.ingest.interrupted':
    'La indexación se interrumpió antes de terminar. Reindexa el documento para volver a ' +
    'intentarlo.',
  'main.ingest.fileTooLarge':
    'Este archivo es demasiado grande para importarlo de forma segura. Divídelo en archivos más ' +
    'pequeños y vuelve a intentarlo.',
  'main.ingest.tooManyChunks':
    'Este documento es demasiado grande para indexarlo por completo. Divídelo en archivos más ' +
    'pequeños e importa las partes.',
  'main.ingest.parseTimeout':
    'Este archivo tardó demasiado en procesarse y se omitió. Puede que esté dañado o que sea ' +
    'extremadamente grande.',
  'main.ingest.unsupportedType':
    'Este tipo de archivo no es compatible ({ext}). Prueba con TXT, PDF, DOCX, CSV o un formato ' +
    'de audio compatible.',
  'main.rag.noContext':
    'No encontré esto en tus documentos. Intenta formular la pregunta de otra manera o comprueba ' +
    'a qué documentos estás preguntando.',
  'main.rag.reindexNeeded':
    'Tus documentos necesitan una reindexación rápida antes de poder buscar en ellos: se ' +
    'indexaron con otro modelo de búsqueda. Abre la pantalla Documentos y elige «Reindexar».',
  'main.chat.docTaskBusy':
    'Hay una tarea de documentos en curso. Puedes cancelarla o esperar a que termine antes de ' +
    'chatear.',
  'main.chat.defaultTitle': 'Nuevo chat',
  'main.evidenceReviews.defaultTitle': 'Revisión de evidencia',
  'main.benchmark.warnTiny':
    'A este dispositivo le va mejor el modelo más pequeño y rápido. Los modelos más grandes ' +
    'pueden ir despacio.',
  'main.benchmark.warnUnknown':
    'No pudimos detectar del todo este hardware, así que elegimos un modelo ligero y seguro. ' +
    'Puedes probar un modelo más grande cuando quieras.',
  'main.benchmark.warnDriveProbe':
    'No se pudo medir la velocidad de la unidad, así que la recomendación solo tiene en cuenta ' +
    'la RAM y el procesador.',
  'main.benchmark.warnSlowDrive':
    'Esta unidad es algo lenta. Los modelos seguirán funcionando, pero pueden tardar más en ' +
    'cargarse.',
  'main.benchmark.warnSpeedSkipped':
    'Esta vez no se midió la velocidad de generación de texto porque el modelo estaba ocupado ' +
    'con otra tarea. El perfil de abajo solo tiene en cuenta la RAM, el procesador y la ' +
    'velocidad de la unidad: para obtener una medición completa, vuelve a hacer la prueba de ' +
    'rendimiento cuando nada más esté usando el modelo.',
  'main.benchmark.warnSlowRead':
    'La lectura desde esta unidad fue de unos {mbps} MB/s. Al iniciar un modelo se lee todo su ' +
    'archivo a esa velocidad, así que en esta unidad los modelos tardarán en iniciarse.',
  'main.benchmark.warnVeryLowTokens':
    'La generación de texto fue muy lenta con el modelo cargado ({model}), así que el perfil ' +
    'asignado bajó un nivel. Si ese modelo es más grande que el recomendado, inicia el modelo ' +
    'recomendado y vuelve a hacer la prueba de rendimiento.',
  'main.benchmark.warnRecommendationLowered':
    'La generación de texto alcanzó unos {tps} tok/s con el modelo cargado ({model}), así que el ' +
    'modelo recomendado bajó un nivel de tamaño para que las respuestas sigan siendo rápidas en ' +
    'este equipo.',
  'main.benchmark.locked':
    'El espacio de trabajo está bloqueado. Desbloquéalo para hacer la prueba de rendimiento.',
  'main.benchmark.lockedDuringRun':
    'El espacio de trabajo se bloqueó mientras se hacía la prueba de rendimiento, así que el ' +
    'resultado no se guardó. Vuelve a hacer la prueba de rendimiento.',
  'main.dialog.openLink.title': '¿Abrir este vínculo en tu navegador?',
  'main.dialog.openLink.message': '¿Abrir este vínculo en tu navegador?',
  'main.dialog.openLink.site': 'Sitio: {site}',
  'main.dialog.openLink.truncated':
    'Aquí el vínculo aparece acortado. Caracteres no mostrados: {hidden}.',
  'main.dialog.openLink.credentials':
    'La dirección incluye un nombre de usuario: el sitio que se abre realmente es el que aparece ' +
    'en la línea «Sitio».',
  'main.dialog.openLink.hint':
    'Este vínculo procede de una respuesta o del manifiesto de un modelo, no de HilbertRaum. Tu ' +
    'navegador se conectará a este sitio.',
  'main.dialog.openLink.open': 'Abrir',
  'main.dialog.openLink.cancel': 'Cancelar',
  'main.workspace.wrongPassword':
    'Esa contraseña no desbloqueó tu espacio de trabajo. Compruébala y vuelve a intentarlo.',
  'main.workspace.openFailed': 'No se pudo abrir el espacio de trabajo.',
  'main.workspace.vaultDamaged':
    'Tu contraseña es correcta, pero los datos del espacio de trabajo en la unidad están dañados ' +
    'y no se pudieron abrir. Volver a escribir la contraseña no servirá. No crees un espacio de ' +
    'trabajo nuevo: deja los archivos como están y restaura la carpeta «workspace» desde una ' +
    'copia de seguridad.',
  'main.workspace.recoveryBlocked':
    'Todavía no se pudo abrir el espacio de trabajo: otro programa tiene abierto un archivo de ' +
    'recuperación con tus datos más recientes. Cierra todo lo que pueda estar analizando la ' +
    'unidad (el antivirus, la indexación de búsqueda, una ventana de archivos abierta en la ' +
    'carpeta «workspace»), espera un momento y vuelve a intentarlo. No se perdió nada.',
  'main.workspace.newer':
    'Este espacio de trabajo lo escribió una versión más reciente de HilbertRaum: actualiza la ' +
    'aplicación para abrirlo. No se modificó nada.',
  'main.workspace.createFailed': 'No se pudo crear el espacio de trabajo.',
  'main.workspace.passwordTooShort': 'La contraseña debe tener al menos {min} caracteres.',
  'main.workspace.newPasswordTooShort': 'La contraseña nueva debe tener al menos {min} caracteres.',
  'main.workspace.unlockBeforeChange':
    'Desbloquea el espacio de trabajo antes de cambiar su contraseña.',
  'main.workspace.wrongCurrentPassword':
    'Esa contraseña no coincide con tu contraseña actual. Compruébala y vuelve a intentarlo.',
  'main.workspace.changeFailed':
    'No se pudo cambiar la contraseña. Tu contraseña actual sigue funcionando.',
  'main.workspace.busyPasswordChange':
    'Se está cambiando la contraseña del espacio de trabajo. Vuelve a intentarlo en unos ' +
    'instantes.',
  'main.workspace.lockFailed':
    'No se pudo bloquear el espacio de trabajo: sigue abierto y tus datos están a salvo. Libera ' +
    'algo de espacio en la unidad y vuelve a intentarlo.',
  'main.runtime.compatibilityMode':
    'Se cambió al modo de compatibilidad para mayor estabilidad. Todo sigue funcionando, aunque ' +
    'las respuestas pueden ser un poco más lentas.',
  'main.runtime.speedUpDisabled':
    'Se desactivó una aceleración opcional para mayor estabilidad. El modelo se está ' +
    'reiniciando: vuelve a enviar tu mensaje.',
  'main.runtime.crashRestarting':
    'El modelo de IA se detuvo de forma inesperada y se está volviendo a iniciar. Vuelve a ' +
    'enviar tu mensaje en unos instantes.',
  'main.runtime.crashStopped':
    'El modelo de IA volvió a detenerse de forma inesperada, así que no se reinició. Puedes ' +
    'volver a iniciarlo en la pantalla Modelo de IA.',
  'main.runtime.modelCannotLoad':
    'No se pudo cargar el modelo {model} en este equipo: las respuestas son simuladas hasta que ' +
    'elijas otro modelo.',
  'main.runtime.engineCannotRun':
    'El motor de IA no puede funcionar en este equipo, así que las respuestas son simuladas. En ' +
    'la pantalla Modelo de IA se indica qué falta.',
  'main.engine.cannotRun':
    'El motor de IA no puede funcionar en este equipo. En la pantalla Modelo de IA se indica qué ' +
    'falta.',
  'main.noModelRunning':
    'No hay ningún modelo de IA en ejecución. Abre la pantalla Modelo de IA e inicia uno primero.',
  'main.modelStarting': 'El modelo de IA se está iniciando. Vuelve a intentarlo en unos instantes.',
  'main.translation.noModel':
    'Para traducir hace falta el modelo de traducción, que no está instalado en esta unidad. ' +
    'Puedes descargarlo en la pantalla Modelo de IA.',
  'main.translation.startFailed':
    'El modelo de traducción no pudo iniciarse: puede que quede poca memoria libre en el ' +
    'dispositivo. Cierra otras aplicaciones o reinicia HilbertRaum y vuelve a intentarlo.',
  'main.translation.failedWindowNotice':
    '> ⚠ No se pudo traducir esta parte ({part} de {total}): el texto original se conserva abajo ' +
    'sin cambios.',
  'main.translation.missingPageNotice':
    '> ⚠ No se pudo traducir la página {page} del original: no contiene texto legible (puede que ' +
    'sea una imagen escaneada).',
  'main.translation.missingPageRangeNotice':
    '> ⚠ No se pudieron traducir las páginas {from}–{to} del original: no contienen texto ' +
    'legible (puede que sean imágenes escaneadas).',
  'main.translation.attributionLine':
    'Traducción automática con el modelo {modelId}: puede contener errores.',
  'main.model.contextExceeded':
    'Esto es demasiado grande para el tamaño de contexto del modelo actual. Aumenta el tamaño de ' +
    'contexto en la pantalla Modelo de IA (si elegiste un tamaño fijo, ese es el límite) o ' +
    'prueba con un documento más pequeño.',
  'main.chat.streamInFlight': 'Ya se está generando una respuesta para esta conversación.',
  'main.chat.emptyCompletion':
    'El modelo devolvió una respuesta vacía. Vuelve a intentarlo o formula tu mensaje de otra ' +
    'manera.',
  'main.chat.runtimeUnresponsive':
    'El modelo de IA dejó de responder. Vuelve a intentarlo; si el problema se repite, reinicia ' +
    'el modelo en la pantalla Modelo de IA.',
  'main.chat.connectionLost':
    'El modelo de IA se detuvo antes de terminar la respuesta. Vuelve a enviar tu mensaje; si el ' +
    'problema se repite, reinicia el modelo en la pantalla Modelo de IA.',
  'main.chat.streamError':
    'El modelo de IA tuvo un error antes de terminar la respuesta. Vuelve a intentarlo; si el ' +
    'problema se repite, reinicia el modelo en la pantalla Modelo de IA.',
  'main.chat.searchModelTimeout':
    'El modelo de búsqueda no respondió a tiempo, así que no se pudo buscar en tus documentos. ' +
    'Vuelve a intentarlo.',
  'main.chat.searchModelCannotStart':
    'El modelo de búsqueda no pudo iniciarse, así que no se pudo buscar en tus documentos. En la ' +
    'pantalla Modelo de IA, elige «Comprobar todos los archivos de modelo» y después vuelve a ' +
    'intentarlo.',
  'main.chat.searchModelFailed':
    'El modelo de búsqueda tuvo un problema, así que no se pudo buscar en tus documentos. Vuelve ' +
    'a intentarlo.',
  'main.chat.nothingToRegenerate': 'Todavía no hay nada que volver a generar.',
  'main.chat.nothingToResend':
    'Esta pregunta ya no es el último mensaje de esta conversación, así que no se puede volver a ' +
    'enviar.',
  'main.chat.skillUnavailable':
    'Esta habilidad ya no está disponible: se desactivó o se eliminó. Actívala en la pestaña ' +
    'Habilidades de Ajustes o vuelve a preguntar sin ella.',
  'main.chat.reviewBlocksRegenerate':
    'Esta respuesta tiene una revisión de evidencia. Volver a responder eliminaría la revisión ' +
    'con sus decisiones y notas: en su lugar, vuelve a hacer tu pregunta como un mensaje nuevo.',
  'main.chat.emptyMessage': 'No se puede enviar un mensaje vacío.',
  'main.chat.emptyQuestion': 'No se puede enviar una pregunta vacía.',
  'main.chat.stopFirst':
    'Todavía se está generando una respuesta para esta conversación. Detenla primero.',
  'main.chat.locked': 'El espacio de trabajo está bloqueado. Desbloquéalo para chatear.',
  'main.busy.chat':
    'Ahora mismo se está escribiendo una respuesta. Espera a que termine (o detenla) y luego ' +
    'vuelve a intentarlo.',
  'main.busy.docTask':
    'Una tarea de documentos está usando el modelo. Espera a que termine o cancélala, y luego ' +
    'vuelve a intentarlo.',
  'main.busy.skillRun':
    'Una habilidad está trabajando con un documento. Espera a que termine o cancélala en la ' +
    'barra de ejecución, y luego vuelve a intentarlo.',
  'main.busy.benchmark':
    'Ahora mismo hay una prueba de rendimiento midiendo este equipo. Vuelve a intentarlo en unos ' +
    'instantes.',
  'main.task.unknownKind': 'Tarea de documentos desconocida.',
  'main.task.refusedChatStreaming':
    'Ahora mismo se está escribiendo una respuesta. Espera a que termine (o detenla) y vuelve a ' +
    'intentarlo.',
  'main.task.comparePickTwo': 'Elige exactamente dos documentos para compararlos.',
  'main.task.compareReindex':
    'Estos documentos necesitan una reindexación rápida antes de poder compararlos: al menos uno ' +
    'se preparó con otro modelo de búsqueda. Abre la pantalla Documentos, elige «Reindexar» y ' +
    'vuelve a intentarlo.',
  'main.task.documentNotReady':
    'Este documento todavía no tiene texto legible. Primero impórtalo o reindéxalo y luego ' +
    'vuelve a intentarlo.',
  'main.task.genericFailure':
    'No se pudo terminar la tarea. Comprueba que el modelo siga en ejecución y vuelve a ' +
    'intentarlo.',
  'main.task.expired': 'Esta tarea ya no está disponible.',
  'main.task.translationTarget':
    'Elige un idioma de origen compatible y un idioma de destino distinto para la traducción.',
  'main.task.sourceUnreadable':
    'No se pudo leer la copia guardada de este documento. Importa de nuevo el documento y vuelve ' +
    'a intentarlo.',
  'main.task.needsOcr':
    'El reconocimiento de texto necesita los archivos de OCR, que no están en esta unidad. ' +
    'Descárgalos con «Descargar archivos de OCR» en el documento escaneado o en la pantalla ' +
    'Modelo de IA. En una unidad que hayas configurado tú, también puedes agregarlos con ' +
    '«fetch-runtime --family ocr».',
  'main.task.ocrUnavailable':
    'El reconocimiento de texto (OCR) no está disponible en esta versión: los archivos de OCR ' +
    'están en esta unidad, pero el reconocimiento de texto no pudo iniciarse.',
  'main.task.ocrNotAScan':
    'Solo se puede habilitar la búsqueda de esta forma en un PDF que se detectó como escaneo o ' +
    'que tiene páginas escaneadas.',
  'main.task.ocrNoText':
    'No se encontró texto legible en este escaneo. Puede que las páginas estén en blanco o ' +
    'demasiado borrosas.',
  'main.task.ocrFailed':
    'No se pudo leer este escaneo. Comprueba que el documento siga en la unidad y vuelve a ' +
    'intentarlo.',
  'main.task.documentBusyIngesting':
    'Este documento todavía se está importando o reindexando. Espera a que termine y vuelve a ' +
    'intentarlo.',
  'main.task.pickOneTranslate': 'Elige exactamente un documento para traducirlo.',
  'main.task.pickOneOcr': 'Elige exactamente un PDF escaneado para habilitar la búsqueda en él.',
  'main.task.pickOneSummarize': 'Elige exactamente un documento para resumirlo.',
  'main.task.unavailable': 'Las tareas de documentos no están disponibles.',
  'main.task.workspaceLocked':
    'El espacio de trabajo está bloqueado. Desbloquéalo para trabajar con documentos.',
  'main.download.policyDisabled':
    'Las descargas están desactivadas por la política de esta unidad.',
  'main.download.networkOff':
    'El acceso a internet está desactivado. Primero activa «Permitir el acceso a internet para ' +
    'descargar modelos y actualizaciones» en Ajustes.',
  'main.download.alreadyRunning':
    'Ya hay otra descarga en curso. Los modelos se descargan de uno en uno.',
  'main.download.stoppedNetworkOff':
    'El acceso a internet está desactivado, así que la descarga en curso se detuvo. Para ' +
    'terminarla, vuelve a activar el acceso a internet en Ajustes.',
  'main.download.noSource':
    'El modelo «{modelId}» no tiene ninguna dirección de descarga en su manifiesto.',
  'main.download.sourceWithdrawn':
    'El proveedor de «{modelId}» retiró este archivo concreto, así que ya no se puede descargar ' +
    '({reason}). Los modelos que ya están en esta unidad siguen funcionando.',
  'main.download.alreadyVerified': 'Este modelo ya está descargado y verificado.',
  'main.download.presentUnverified':
    'El archivo de este modelo ya está en la unidad. Su manifiesto todavía no tiene una suma de ' +
    'comprobación real, así que no se puede verificar: genera una con «verify-models --generate».',
  'main.download.licenseFirst':
    'Revisa y acepta la licencia del modelo ({license}) antes de descargarlo.',
  'main.download.notEnoughSpace':
    'No hay suficiente espacio libre en esta unidad: la descarga necesita {needed} y el espacio ' +
    'libre es de {free}. Libera espacio en la unidad o elige un modelo más pequeño.',
  'main.download.unknownJob': 'Tarea de descarga desconocida.',
  'main.download.checksumMismatch':
    'El archivo descargado no coincidió con la suma de comprobación esperada, así que se ' +
    'descartó. Vuelve a intentarlo.',
  'main.download.fileMissing':
    'El archivo descargado desapareció antes de que se pudiera verificar.',
  'main.download.httpFailed':
    'No se pudo iniciar la descarga ({reason}). Comprueba la conexión y vuelve a intentarlo.',
  'main.download.interrupted':
    'La descarga se interrumpió ({reason}). La parte ya descargada se conserva: si la vuelves a ' +
    'iniciar, continuará donde se quedó.',
  'main.download.writeFailed':
    'No se pudo guardar el archivo del modelo en esta unidad. Comprueba que no esté llena ni ' +
    'protegida contra escritura y vuelve a intentarlo.',
  'main.download.resumeDiscarded':
    'El servidor envió una parte incorrecta del archivo, así que se descartó la descarga ' +
    'parcial. Si la vuelves a iniciar, empezará desde el principio.',
  'main.engine.alreadyRunning': 'El motor de IA ya se está descargando.',
  'main.engine.noSources':
    'No se encontró la lista de descargas del motor en esta unidad (falta ' +
    '«runtime-sources.yaml»).',
  'main.engine.noHostBuild': 'No hay ninguna versión del motor de IA disponible para este equipo.',
  'main.engine.alreadyInstalled': 'El motor de IA ya está instalado.',
  'main.engine.unknownJob': 'Tarea desconocida de descarga del motor.',
  'main.engine.checksumMismatch':
    'El motor descargado no coincidió con la suma de comprobación esperada, así que se descartó. ' +
    'Vuelve a intentarlo.',
  'main.engine.fileMissing': 'El motor descargado desapareció antes de que se pudiera verificar.',
  'main.engine.unverifiablePlaceholder':
    'Esta descarga del motor de IA no tiene una suma de comprobación real, así que no se pudo ' +
    'verificar y no se instaló. Puede que la unidad no esté bien configurada.',
  'main.engine.binaryMissing':
    'El motor se descargó, pero no se pudo descomprimir (puede que haya cambiado la estructura ' +
    'del archivo comprimido).',
  'main.engine.extractFailed':
    'El motor de IA se descargó, pero no se pudo descomprimir. Vuelve a intentarlo.',
  'main.engine.httpFailed':
    'No se pudo iniciar la descarga del motor ({reason}). Comprueba la conexión y vuelve a ' +
    'intentarlo.',
  'main.engine.interrupted':
    'La descarga del motor se interrumpió ({reason}). Vuelve a intentarlo.',
  'main.engine.runtimeRunning':
    'El motor de IA no se puede reemplazar mientras hay un modelo en ejecución. Detén el modelo ' +
    'en la pantalla Modelo de IA y vuelve a intentarlo.',
  'main.engine.transcriptionRunning':
    'El motor de voz no se puede reemplazar mientras se transcribe audio. Espera a que termine y ' +
    'vuelve a intentarlo.',
  'main.engine.knowledgePackToolsRunning':
    'Las herramientas de los paquetes de conocimiento no se pueden reemplazar mientras se usa un ' +
    'paquete. Bloquea el espacio de trabajo o espera a que termine la pregunta actual y vuelve a ' +
    'intentarlo. Si el aviso no desaparece, reinicia la aplicación.',
  'main.engine.badRequest':
    'No se entendió la solicitud de instalación del motor. Vuelve a intentarlo.',
  'main.engine.nothingToRepair':
    'No hay nada que reparar: no se detectaron daños en el motor de esta unidad.',
  'main.engine.nothingToUpdate':
    'No hay nada que actualizar: los motores de esta unidad ya tienen la versión que usa esta ' +
    'aplicación o una más reciente.',
  'main.engine.updateBusy':
    'El motor de IA está en uso ahora mismo (hay una respuesta, una importación, una traducción ' +
    'o una tarea de documentos en curso). Vuelve a intentar la actualización cuando termine.',
  'main.ocr.badRequest': 'No se entendió la solicitud de descarga de OCR. Vuelve a intentarlo.',
  'main.ocr.alreadyRunning': 'Los archivos de OCR ya se están descargando.',
  'main.ocr.noSources':
    'Esta unidad no tiene una lista de descargas para los archivos de OCR. En su lugar, ' +
    'agrégalos con los scripts de configuración de la unidad («fetch-runtime --family ocr»).',
  'main.ocr.sourcesMismatch':
    'La lista de descargas de OCR de esta unidad no corresponde a esta versión de HilbertRaum, ' +
    'así que no se descargó nada. En su lugar, agrega los archivos con los scripts de ' +
    'configuración de la unidad («fetch-runtime --family ocr»).',
  'main.ocr.alreadyInstalled':
    'Los archivos de OCR ya están en esta unidad. Si el reconocimiento de texto sigue sin estar ' +
    'disponible, reinicia HilbertRaum.',
  'main.ocr.unsafeFolder':
    'La carpeta «ocr» de esta unidad no es una carpeta normal (puede que apunte a otra ' +
    'ubicación), así que no se escribió nada. Reemplázala por una carpeta normal llamada «ocr» y ' +
    'vuelve a intentarlo.',
  'main.ocr.writeFailed':
    'No se pudieron guardar los archivos de OCR en esta unidad. Comprueba que no esté llena ni ' +
    'protegida contra escritura y vuelve a intentarlo.',
  'main.ocr.downloadFailed':
    'No se pudieron descargar los archivos de OCR. Comprueba la conexión a internet y vuelve a ' +
    'intentarlo.',
  'main.ocr.checksumMismatch':
    'Un archivo de OCR descargado no coincidió con su suma de comprobación esperada, así que se ' +
    'descartó. Los archivos que ya estaban en esta unidad no cambiaron. Vuelve a intentarlo.',
  'main.ocr.readFailed':
    'No se pudieron leer los archivos de OCR que ya están en esta unidad. Puede que la unidad se ' +
    'haya desconectado o que otro programa esté usando los archivos. Comprueba la unidad y ' +
    'vuelve a intentarlo.',
  'main.ocr.unknownJob':
    'La aplicación ya no tiene registrada esta descarga de OCR. Vuelve a iniciarla si todavía ' +
    'faltan los archivos.',
  'main.docs.locked':
    'El espacio de trabajo está bloqueado. Desbloquéalo para administrar los documentos.',
  'main.docs.processing':
    'Este documento todavía se está procesando. Espera a que termine la importación.',
  'main.docs.tooManyPaths':
    'Se seleccionaron demasiados archivos a la vez. Elige una carpeta en su lugar.',
  'main.docs.taskRunning':
    'Hay una tarea en curso para este documento. Cancélala o espera a que termine.',
  'main.docs.skillRunning':
    'Una habilidad está trabajando con este documento. Cancélala o espera a que termine.',
  'main.docs.previewEncrypted':
    'Este documento está cifrado; desbloquea el espacio de trabajo para ver la vista previa.',
  'main.docs.previewGone':
    'El archivo del documento ya no está disponible. Vuelve a importarlo para ver la vista ' +
    'previa.',
  'main.docs.exportTextOnly':
    'Solo los documentos de texto (Markdown, TXT, CSV) se pueden exportar de esta forma.',
  'main.docs.exportEncrypted':
    'Este documento está cifrado; desbloquea el espacio de trabajo para exportarlo.',
  'main.docs.exportGone':
    'El archivo del documento ya no está disponible. Vuelve a importarlo para exportarlo.',
  'main.docs.exportOriginalChanged':
    'Solo queda disponible tu propia copia de este archivo, y ha cambiado desde que se importó, ' +
    'así que ya no es el original. Exporta el texto extraído en su lugar.',
  'main.docs.noStoredTranscript':
    'Todavía no hay ninguna transcripción guardada para esta grabación. Reindéxala para volver a ' +
    'transcribirla.',
  'main.models.noManifests':
    'No se encontró ninguna lista de modelos en esta unidad: falta la carpeta «model-manifests».',
  'main.models.autoSelected':
    'Este modelo se usa automáticamente una vez instalado: no hay nada que seleccionar.',
  'main.models.locked':
    'El espacio de trabajo está bloqueado. Desbloquéalo para administrar los modelos de IA.',
  'main.audit.locked': 'El espacio de trabajo está bloqueado. Desbloquéalo para ver la actividad.',
  'main.settings.locked':
    'El espacio de trabajo está bloqueado. Desbloquéalo para cambiar los ajustes.',
  'main.evidenceReviews.locked':
    'El espacio de trabajo está bloqueado. Desbloquéalo para trabajar en revisiones de evidencia.',
  'main.evidenceReviews.invalidRequest': 'Esta solicitud de revisión no es válida.',
  'main.evidenceReviews.exportNotRecorded':
    'No se pudo registrar el paquete de evidencia en el historial de exportaciones, así que se ' +
    'eliminó el archivo exportado. No se guardó nada: vuelve a intentar la exportación.',
  'main.evidenceReviews.exportFileNotRecorded':
    'El archivo del paquete de evidencia se guardó, pero no se pudo registrar en el historial de ' +
    'exportaciones ni eliminar. Su hash no quedó registrado: vuelve a exportar el paquete y ' +
    'reemplaza el archivo.',
  'main.evidenceReviews.exportOutdated':
    'Esta revisión está desactualizada: una fuente o la respuesta ha cambiado desde que se creó ' +
    'la revisión. Confirma el cambio en la revisión antes de exportar.',
  'main.settings.invalidPatch': 'Este cambio en los ajustes no es válido y no se guardó.',
  'main.dictation.locked':
    'El espacio de trabajo está bloqueado. Desbloquéalo para usar el dictado por voz.',
  'main.dictation.silent':
    'No llegó ningún sonido al micrófono. Comprueba que no esté silenciado y que HilbertRaum ' +
    'tenga permiso para usarlo en la configuración del sistema; luego vuelve a intentarlo.',
  'main.dictation.tooShort':
    'La grabación era demasiado corta para reconocer palabras: vuelve a intentarlo.',
  'main.dictation.unavailable':
    'El dictado por voz aún no está disponible en esta unidad: en la pantalla Modelo de IA se ' +
    'indica qué falta.',
  'main.dictation.failed': 'No se pudo transcribir: vuelve a intentarlo.',
  'main.dictation.tooLong':
    'Esa grabación es demasiado larga para el dictado. Para grabaciones largas, importa mejor el ' +
    'archivo de audio como documento.',
  'main.dictation.busy': 'Todavía se está transcribiendo el último dictado: un momento.',
  'main.dictation.engineCannotRun':
    'El motor de voz no puede funcionar en este equipo. En la pantalla Modelo de IA se indica ' +
    'qué falta.',
  'main.preflight.readOnly':
    'Parece que esta unidad es de solo lectura, así que la aplicación no puede crear su espacio ' +
    'de trabajo. Prueba con otro puerto USB o lee la guía de solución de problemas.',
  'main.preflight.lowSpace':
    'A esta unidad le queda poco espacio libre. Puedes continuar de todos modos, pero importar ' +
    'documentos grandes puede fallar hasta que liberes espacio.',
  'main.dialog.importDocuments': 'Importar documentos',
  'main.dialog.importFolder': 'Importar una carpeta de documentos',
  'main.dialog.exportDocument': 'Exportar documento',
  'main.dialog.exportOriginal': 'Exportar archivo original',
  'main.dialog.exportSummary': 'Exportar resumen',
  'main.dialog.exportChat': 'Exportar la transcripción del chat',
  'main.dialog.exportTableCsv': 'Exportar la tabla como CSV',
  'main.dialog.exportCodeBlock': 'Guardar el bloque de código como archivo',
  'main.dialog.exportAudit': 'Exportar el registro de actividad',
  'main.dialog.exportEvidencePack': 'Exportar paquete de evidencia',
  'main.dialog.exportLog': 'Guardar los registros de diagnóstico',
  'main.dialog.filterDocuments': 'Documentos',
  'main.dialog.filterAll': 'Todos los archivos',
  'main.zim.unavailable': 'Los paquetes de conocimiento no están disponibles en esta sesión.',
  'main.zim.articleUnavailable':
    'Este artículo no está disponible ahora mismo, así que no se pudo guardar. Puede que el ' +
    'paquete esté desactivado o se haya quitado, o que su unidad esté desconectada.',
  'main.zim.saveFailed': 'No se pudo agregar el artículo a tus documentos. Vuelve a intentarlo.',
  'main.zim.dialogTitle': 'Agregar paquetes de conocimiento',
  'main.zim.filterZim': 'Archivos ZIM',
  'main.dialog.chooseImage': 'Elegir una imagen',
  'main.dialog.filterImages': 'Imágenes',
  'main.images.unsupportedType':
    'Ese tipo de archivo no es compatible. Elige una imagen PNG, JPEG o WEBP.',
  'main.images.tooLarge':
    'Esa imagen es demasiado grande para analizarla. Prueba con una imagen más pequeña.',
  'main.dialog.importSkill': 'Importar un paquete de habilidad',
  'main.dialog.importSkillFolder': 'Importar una carpeta de habilidad',
  'main.dialog.exportSkill': 'Exportar habilidad',
  'main.dialog.filterSkill': 'Paquete de habilidad',
  'main.dialog.exportCsv': 'Exportar movimientos',
  'main.dialog.filterCsv': 'Archivo CSV',
  'main.dialog.exportJson': 'Exportar como JSON',
  'main.dialog.filterJson': 'Archivo JSON',
  'main.dialog.exportXml': 'Exportar como XML',
  'main.dialog.filterXml': 'Archivo XML',
  'main.dialog.exportRedacted': 'Guardar la copia con datos ocultos',
  'main.dialog.exportEdited': 'Guardar la copia editada',
  'main.dialog.filterText': 'Archivo de texto',
  'main.dialog.filterDocx': 'Documento de Word',
  'main.collections.builtinUndeletable':
    'Las secciones integradas Biblioteca y Temporales no se pueden eliminar.',
  'main.skills.locked':
    'El espacio de trabajo está bloqueado. Desbloquéalo para administrar las habilidades.',
  'main.skills.notPicked': 'Primero elige el paquete de la habilidad con el selector de archivos.',
  'main.skills.incompatible':
    'Esta habilidad necesita una versión más reciente de la aplicación. Actualiza la aplicación ' +
    'para usarla.',
  'main.skills.run.unavailable':
    'La herramienta de esta habilidad no está disponible en este momento.',
  'main.skills.run.noDocument':
    'Primero agrega un documento a este chat y luego vuelve a intentarlo.',
  'main.skills.run.busy':
    'Ya hay una habilidad trabajando. Espera a que termine o cancélala primero.',
  'main.skills.run.documentOutOfScope':
    'Ese documento no está entre los documentos de este chat. Elige uno de ellos y vuelve a ' +
    'intentarlo.',
  // ---- Document organization — Documents screen sections + actions (plan §12) ----
  'docs.section.heading': 'Secciones',
  'docs.section.library': 'Biblioteca',
  'docs.section.projects': 'Proyectos',
  'docs.section.temporary': 'Temporales',
  'docs.section.generated': 'Generados',
  'docs.section.archived': 'Archivados',
  'docs.section.all': 'Todos los documentos',
  'docs.section.newProject': 'Nuevo proyecto',
  'docs.mode.aria': 'Vista de Documentos',
  'docs.mode.documents': 'Mis documentos',
  'docs.mode.packs': 'Paquetes de conocimiento',
  'docs.filter.placeholder': 'Filtrar por nombre…',
  'docs.filter.aria': 'Filtrar documentos por nombre',
  'docs.filter.noMatch': 'Ningún documento coincide con «{query}».',
  'docs.empty.packsLine':
    'O agrega un paquete de conocimiento: una Wikipedia sin conexión con la que el chat puede ' +
    'responder.',
  'docs.empty.packsAction': 'Paquetes de conocimiento',
  'docs.rail.hide': 'Ocultar secciones',
  'docs.rail.show': 'Mostrar secciones',
  'docs.project.createTitle': 'Crear un proyecto',
  'docs.project.namePlaceholder': 'Nombre del proyecto',
  'docs.project.nameAria': 'Nombre del proyecto',
  'docs.project.create': 'Crear',
  'docs.project.rename': 'Cambiar nombre',
  'docs.project.renameTitle': 'Cambiar el nombre del proyecto',
  'docs.project.archive': 'Archivar',
  'docs.project.unarchive': 'Desarchivar',
  'docs.project.delete': 'Eliminar proyecto',
  'docs.project.deleteTitle': '¿Eliminar este proyecto?',
  'docs.project.deleteBody': 'Elige qué pasa con los documentos de este proyecto:',
  'docs.project.deleteKeep': 'Quitar solo el proyecto y conservar sus documentos',
  'docs.project.deleteKeepHint':
    'Los documentos se quedan en tu Biblioteca y en cualquier otro proyecto en el que estén.',
  'docs.project.deleteWith': 'Eliminar el proyecto y los documentos que solo están aquí',
  'docs.project.deleteWithHint':
    'Solo se eliminan los documentos que no están en tu Biblioteca ni en otro proyecto. El ' +
    'contenido de la Biblioteca nunca se toca.',
  'docs.project.archivedNote':
    'Archivado: oculto como fuente, pero sus documentos siguen disponibles para las respuestas ' +
    'desde otras secciones o proyectos.',
  'docs.project.options': 'Opciones del proyecto',
  'docs.action.moveToProject': 'Mover a un proyecto…',
  'docs.action.addToLibrary': 'Conservar en la Biblioteca',
  'docs.action.removeFromProject': 'Quitar de este proyecto',
  'docs.action.markTemporary': 'Marcar como temporal',
  'docs.action.markPermanent': 'Marcar como permanente',
  'docs.action.archive': 'Archivar',
  'docs.action.unarchive': 'Desarchivar',
  'docs.action.chooseProject': 'Elegir un proyecto',
  'docs.chip.library': 'Biblioteca',
  'docs.chip.temporary': 'Temporal',
  'docs.chip.generated': 'Generado',
  'docs.chip.archived': 'Archivado',
  'docs.bulk.selected.one': '{count} seleccionado',
  'docs.bulk.selected.many': '{count} de seleccionados',
  'docs.bulk.selected.other': '{count} seleccionados',
  'docs.selectionAria': 'Acciones para los documentos seleccionados',
  'docs.bulk.delete': 'Eliminar',
  'docs.bulk.deleteConfirm.title.one': '¿Eliminar {count} documento?',
  'docs.bulk.deleteConfirm.title.many': '¿Eliminar {count} de documentos?',
  'docs.bulk.deleteConfirm.title.other': '¿Eliminar {count} documentos?',
  'docs.bulk.deleteConfirm.body':
    'Esto elimina de forma permanente los documentos seleccionados, su texto extraído y su ' +
    'índice de búsqueda de tu espacio de trabajo. Los archivos originales fuera del espacio de ' +
    'trabajo no se tocan.',
  'docs.empty.section': 'Todavía no hay nada aquí.',
  // ---- Document organization — smart views (plan §7.6/§12.1, Phase E; regrouped §11.16) ----
  'docs.smart.recentlyAdded': 'Últimos agregados',
  'docs.smart.unfiled': 'Sin proyecto',
  'docs.smart.attention': 'Requiere atención',
  'docs.smart.attentionTitle':
    'Importaciones con errores y documentos que necesitan una reindexación',
  'docs.smart.more': 'Más',
  'docs.provenance.staleBadge': 'Desactualizado',
  'docs.provenance.staleChanged':
    'Una fuente ha cambiado desde que se creó este documento: vuelve a ejecutar la tarea para ' +
    'actualizarlo.',
  'docs.provenance.staleRemoved':
    'Se eliminó una fuente desde que se creó este documento: vuelve a ejecutar la tarea para ' +
    'actualizarlo.',
  // ---- Chat — composite source scope (multi-select picker + footer union, plan §13) ----
  'chat.scope.library': 'Biblioteca',
  'chat.scope.projectNamed': 'Proyecto: {name}',
  'chat.scope.projectCount.one': '{count} proyecto',
  'chat.scope.projectCount.many': '{count} de proyectos',
  'chat.scope.projectCount.other': '{count} proyectos',
  // ---- Knowledge packs (ZIM wave: ScopePopover / SourcesDisclosure / ArticleModal / PacksPanel) ----
  'chat.scope.packsTitle': 'Paquetes de conocimiento',
  'chat.scope.packUnavailable': 'no disponible',
  'chat.scope.packNamed': 'Paquete: {name}',
  'chat.scope.packNamedState': 'Paquete: {name} ({state})',
  'chat.scope.packCount.one': '{count} paquete de conocimiento',
  'chat.scope.packCount.many': '{count} de paquetes de conocimiento',
  'chat.scope.packCount.other': '{count} paquetes de conocimiento',
  'chat.scope.documentsToggle': 'Buscar en mis documentos',
  'chat.scope.documentsToggleHint':
    'Desactivado: las respuestas solo salen de los paquetes de conocimiento marcados. Los ' +
    'archivos adjuntos a este chat se siguen usando.',
  'chat.scope.documentsOffSuffix': 'documentos desactivados',
  'chat.scope.documentsOffNoPacks':
    'sin fuentes (activa los documentos o marca un paquete de conocimiento)',
  'chat.scope.packDisabled': 'desactivado',
  'chat.scope.packRemoved': 'Paquete quitado',
  'chat.scope.packLimit.one': 'Hasta {count} paquete de conocimiento por chat',
  'chat.scope.packLimit.many': 'Hasta {count} de paquetes de conocimiento por chat',
  'chat.scope.packLimit.other': 'Hasta {count} paquetes de conocimiento por chat',
  // ---- Per-answer knowledge-pack outcomes (#301 P4, findings M6/M7 — PackOutcomesNotice) ----
  'chat.packs.outcome.summary':
    'Paquetes de conocimiento consultados: {searched} · sin consultar o con error: {other}',
  'chat.packs.outcome.removedPack': 'un paquete quitado',
  'chat.packs.outcome.passages.one': '{count} pasaje',
  'chat.packs.outcome.passages.many': '{count} de pasajes',
  'chat.packs.outcome.passages.other': '{count} pasajes',
  'chat.packs.outcome.unknown':
    'Paquetes de conocimiento: no se registró el resultado de esta respuesta antigua',
  'chat.packs.outcome.searched': 'consultado',
  'chat.packs.outcome.selection-limit': 'sin consultar: límite de selección (12 por chat)',
  'chat.packs.outcome.removed': 'sin consultar: paquete quitado',
  'chat.packs.outcome.disabled': 'sin consultar: paquete desactivado',
  'chat.packs.outcome.file-missing': 'sin consultar: falta el archivo',
  'chat.packs.outcome.identity-mismatch': 'sin consultar: hay otro archivo en esta ubicación',
  'chat.packs.outcome.not-served': 'sin consultar: su nombre coincide con el de otro paquete',
  'chat.packs.outcome.not-searchable': 'sin consultar: no tiene índice de texto completo',
  'chat.packs.outcome.tools-missing':
    'sin consultar: los programas de kiwix-tools no están instalados',
  'chat.packs.outcome.mode':
    'sin consultar: las respuestas sobre el documento completo solo leen el documento',
  'chat.packs.outcome.search-failed': 'error: no se pudo hacer la búsqueda',
  'chat.packs.outcome.read-failed': 'error: no se pudo leer ningún artículo',
  'chat.packs.outcome.timeout': 'error: se agotó el tiempo de espera',
  'chat.packs.outcome.deadline': 'sin consultar: no quedaba tiempo para esta pregunta',
  'chat.packs.outcome.server-restarted':
    'error: el servidor de paquetes se reinició durante esta pregunta',
  'chat.sources.openArticle': 'Abrir el artículo',
  'chat.article.title': 'Artículo',
  'chat.article.from': 'Paquete: {archive} (copia sin conexión)',
  'chat.article.loading': 'Cargando el artículo…',
  'chat.article.unavailable':
    'Este artículo no está disponible en este momento. Puede que el paquete esté desactivado o ' +
    'quitado, o que su unidad esté desconectada.',
  'chat.article.partial': 'Solo se pudo mostrar la primera parte de este artículo.',
  'chat.article.save': 'Guardar en mis documentos',
  'chat.article.saveAria': 'Guardar en mis documentos: {title}',
  'chat.article.saving': 'Guardando en tus documentos…',
  'chat.article.saved':
    'Se guardó en tus documentos como «{title}». Se podrá seguir buscando en él incluso sin el ' +
    'paquete.',
  'chat.article.alreadySaved': 'Este artículo ya está en tus documentos como «{title}».',
  // ---- #301 P6 (a11y pass; plan §9.23 (b)4/(b)6 and decision (c)5) — BEGIN -----------------
  'chat.scope.packMissing': 'falta el archivo',
  'chat.scope.packMismatch': 'otro archivo en esta ubicación',
  'chat.scope.packNotSearchable': 'sin índice de texto completo',
  'chat.sources.openArticleNamed': 'Abrir el artículo: {title}',
  // ---- #301 P6 — END ------------------------------------------------------------------------
  'packs.add': 'Agregar paquetes…',
  'packs.addBusy': 'Agregando…',
  'packs.refresh': 'Actualizar',
  'packs.lead':
    'Obras de referencia sin conexión (archivos ZIM, por ejemplo una Wikipedia sin conexión) con ' +
    'las que el chat puede responder. Los archivos se usan donde están y nunca se copian: ponlos ' +
    'en la carpeta «zim» de la unidad o agrégalos aquí.',
  'packs.summary.count.one': '{count} paquete',
  'packs.summary.count.many': '{count} de paquetes',
  'packs.summary.count.other': '{count} paquetes',
  'packs.summary.enabled.one': '{count} activado',
  'packs.summary.enabled.many': '{count} de activados',
  'packs.summary.enabled.other': '{count} activados',
  'packs.summary.size': '{size} en esta unidad',
  'packs.loading': 'Cargando paquetes…',
  'packs.refreshing': 'Comprobando si hay paquetes en la unidad…',
  'packs.emptyTitle': 'Todavía no hay paquetes de conocimiento',
  'packs.emptyLine':
    'Descarga un archivo .zim no dividido en partes desde library.kiwix.org y luego agrégalo ' +
    'aquí o cópialo en la carpeta «zim» de la unidad.',
  'packs.copyLibrary': 'Copiar la dirección de la biblioteca',
  'packs.copiedToast': 'Dirección copiada: library.kiwix.org',
  'packs.copyFailed': 'No se pudo copiar. La dirección es library.kiwix.org',
  'packs.setup.title': 'Configuración única: las herramientas de los paquetes de conocimiento',
  'packs.toolsMissing':
    'Los programas de kiwix-tools no están instalados en esta unidad, así que no se pueden ' +
    'agregar paquetes ni buscar en ellos. Lee el paso de instalación en la guía de solución de ' +
    'problemas, en la sección «The panel says kiwix-tools are missing».',
  'packs.tools.install': 'Instalar las herramientas de los paquetes de conocimiento…',
  'packs.tools.confirm.title': '¿Instalar las herramientas de los paquetes de conocimiento?',
  'packs.tools.confirm.explain':
    'Los programas kiwix-tools {version}, que hacen funcionar los paquetes de conocimiento ' +
    '(archivos ZIM), se descargarán del servidor del proyecto Kiwix y se verificarán antes de ' +
    'usarlos. Son opcionales: el chat y los documentos funcionan sin ellos.',
  'packs.tools.confirm.hint':
    'La descarga se verifica antes de usarse y no se envía nada sobre ti ni sobre tus ' +
    'documentos. Las herramientas solo hacen falta para los paquetes de conocimiento.',
  'packs.tools.confirm.ack':
    'He leído y acepto los términos de la licencia {license} de kiwix-tools',
  'packs.tools.confirm.start': 'Iniciar descarga',
  'packs.tools.sizeUnknown': 'desconocido',
  'packs.tools.progress':
    'Instalando las herramientas de los paquetes de conocimiento… {pct}\u00A0%',
  'packs.tools.downloadingNoTotal': 'Instalando las herramientas de los paquetes de conocimiento…',
  'packs.tools.verifying': 'Verificando las herramientas de los paquetes de conocimiento…',
  'packs.tools.extracting': 'Descomprimiendo las herramientas de los paquetes de conocimiento…',
  'packs.tools.failed': 'No se pudieron instalar las herramientas de los paquetes de conocimiento.',
  'packs.tools.doneToast': 'Herramientas de los paquetes de conocimiento instaladas',
  'packs.addedToast.one': 'Paquete de conocimiento agregado',
  'packs.addedToast.many': '{count} de paquetes de conocimiento agregados',
  'packs.addedToast.other': '{count} paquetes de conocimiento agregados',
  'packs.addPartial': 'Archivos que no se pudieron agregar: {failed} de {total}.',
  'packs.addFailed.notAZim': 'El archivo elegido no es un archivo ZIM legible.',
  'packs.addFailed.toolsMissing':
    'Los programas de kiwix-tools no están instalados en esta unidad, así que no se pueden ' +
    'agregar paquetes ni buscar en ellos. Lee el paso de instalación en la guía de solución de ' +
    'problemas, en la sección «The panel says kiwix-tools are missing».',
  'packs.addFailed.manager':
    'La herramienta kiwix-manage no pudo leer el archivo. Comprueba que el archivo esté completo ' +
    'y vuelve a intentarlo.',
  'packs.addFailed.pathUnsupported':
    'En Windows, la herramienta kiwix-manage no puede leer este archivo porque su nombre o el de ' +
    'su carpeta contiene una diéresis, un acento u otro carácter que no es ASCII. Copia el ' +
    'archivo en la carpeta «zim/» de la unidad con un nombre sin esos caracteres y vuelve a ' +
    'agregarlo.',
  'packs.addFailed.other': 'No se pudo agregar el archivo.',
  'packs.removedToast': 'Paquete de conocimiento quitado',
  'packs.articleCount.one': '{count} artículo',
  'packs.articleCount.many': '{count} de artículos',
  'packs.articleCount.other': '{count} artículos',
  'packs.state.enabled': 'Activado',
  'packs.state.disabled': 'Desactivado',
  'packs.state.missing': 'Falta el archivo',
  'packs.state.missingTitle': 'No se encontró el archivo. ¿Está conectada la unidad?',
  'packs.state.identityMismatch': 'Otro archivo',
  'packs.state.identityMismatchTitle':
    'En la ubicación de este paquete hay un archivo distinto: quita este paquete y vuelve a ' +
    'agregar el archivo',
  'packs.state.notSearchable': 'Sin índice de texto',
  'packs.state.notSearchableTitle':
    'Este archivo no tiene índice de búsqueda de texto completo. Se omite al hacer preguntas, ' +
    'pero sus artículos se pueden seguir leyendo.',
  'packs.state.notServed': 'No se usa',
  'packs.state.notServedTitle':
    'Su nombre de archivo coincide con el de «{title}», así que solo se usa ese paquete. Cambia ' +
    'el nombre de este archivo para usar los dos.',
  'packs.state.notServedTitleUnknown':
    'Su nombre de archivo coincide con el de otro paquete, así que solo se usa ese otro paquete. ' +
    'Cambia el nombre de este archivo para usar los dos.',
  'packs.switchLabel': 'Usar «{title}» en los chats',
  'packs.ask': 'Preguntar a este paquete',
  'packs.askTitle': 'Abrir un chat que responde solo con este paquete',
  'packs.rowMenu': 'Más acciones para «{title}»',
  'packs.remove': 'Quitar',
  'packs.listLabel': 'Paquetes de conocimiento',
  'packs.removeTitle': '¿Quitar este paquete de conocimiento?',
  'packs.removeConfirm': 'Quitar paquete',
  'packs.removeBody':
    'El paquete solo se quita de HilbertRaum: el archivo ZIM en sí no se toca. Los chats que lo ' +
    'usaban simplemente dejan de buscar en él.',
  'chat.scope.docCount.one': '{count} documento',
  'chat.scope.docCount.many': '{count} de documentos',
  'chat.scope.docCount.other': '{count} documentos',
  'chat.scope.filesInChat.one': '{count} archivo en este chat',
  'chat.scope.filesInChat.many': '{count} de archivos en este chat',
  'chat.scope.filesInChat.other': '{count} archivos en este chat',
  'chat.scope.sourcesTitle': 'Elige tus fuentes',
  'chat.scope.librarySource': 'Biblioteca',
  'chat.scope.librarySourceHint': 'Todos tus documentos',
  'chat.scope.specificToggle': 'Documentos concretos…',
  'chat.scope.allTap': 'Todos los documentos',
  'chat.scope.attachmentsOnlyTap': 'Solo los archivos de este chat',
  'chat.scope.filesInChatLine': 'Archivos de este chat',
  'chat.scope.attachmentNotReadable': '{name} (aún no legible)',
  'chat.scope.attachmentFailedHint':
    'Un archivo que aún no se puede leer no aporta nada a las respuestas. En Documentos se ' +
    'indica por qué y qué hacer.',
  'chat.scope.noProjects': 'Aún no hay proyectos',
  'chat.scope.noPacks': 'Aún no hay paquetes de conocimiento en esta unidad.',
  'chat.scope.addPacks': 'Agregar paquetes…',
  'chat.scope.archivedFallback': 'Este proyecto se archivó: las respuestas salen de tu Biblioteca.',
  'chat.scope.answeringFrom': 'Respuestas a partir de: {source}',
  'chat.scope.wholeLibrary.one': 'toda tu Biblioteca ({count} documento)',
  'chat.scope.wholeLibrary.many': 'toda tu Biblioteca ({count} de documentos)',
  'chat.scope.wholeLibrary.other': 'toda tu Biblioteca ({count} documentos)',
  'chat.scope.narrowTitle': '¿Responder solo con este archivo?',
  'chat.scope.narrowBody':
    'Agregaste «{name}». ¿Preguntar solo a este archivo o seguir respondiendo con toda tu ' +
    'Biblioteca?',
  'chat.scope.narrowJust': 'Solo este archivo',
  'chat.scope.narrowWhole': 'Toda la Biblioteca',
  // ---- Chat — attach / drag-drop a file into a chat (plan §11.2/§13.5, Phase C) ----
  'chat.attach.button': 'Adjuntar archivos',
  'chat.attach.drop': 'Suelta archivos aquí para usarlos en este chat',
  'chat.attach.processing': 'Procesando {name}…',
  'chat.attach.added': 'Se agregó «{name}» a este chat',
  'chat.attach.newDocChat': 'Se inició un nuevo chat sobre documentos para «{name}»',
  'chat.attach.failed': 'No se pudo agregar «{name}» a este chat.',
  'chat.attach.dropUnsupported': 'No se pudo agregar: arrastra un archivo guardado en tu equipo.',
  'chat.attach.trackFailed':
    'No se pudo seguir la importación del archivo: comprueba el resultado en Documentos.',
  'chat.attach.scanned':
    '{name} parece un escaneo, así que aún no se puede leer. En Documentos, usa «Habilitar ' +
    'búsqueda (OCR)» en ese archivo. Después se agregará a este chat por sí solo: no hace falta ' +
    'volver a adjuntarlo.',
  'chat.attach.photoNeedsOcr':
    '{name} es la foto de una página, y para leerla se necesitan los archivos de OCR, que aún no ' +
    'están en esta unidad. En Documentos, usa «Descargar archivos de OCR» y luego «Volver a ' +
    'intentarlo» en ese archivo. Después se agregará a este chat por sí solo: no hace falta ' +
    'volver a adjuntarlo.',
  'chat.attach.goToDocuments': 'Ir a Documentos',
  // ---- Images — "Ask about an image" (image-understanding §5/§11, Phase V3) ----
  'images.title': 'Entender una imagen',
  'images.empty.body':
    'Haz preguntas sobre una captura de pantalla, un gráfico, un formulario, un recibo o una ' +
    'foto. Nada sale de tu equipo.',
  'images.avail.noModel':
    'Para entender imágenes hace falta un modelo local para imágenes en esta unidad.',
  'images.avail.noRuntime': 'Para entender imágenes, primero hay que instalar el motor de IA.',
  'images.avail.incompatible':
    'El modelo para imágenes de esta unidad necesita un motor de IA más reciente.',
  'images.avail.cta': 'Ir a Modelo de IA',
  'images.avail.ocrPointer':
    '¿Documentos escaneados? Usa «Habilitar búsqueda (OCR)» en Documentos.',
  'images.drop.title': 'Suelta una imagen aquí',
  'images.drop.choose': 'o elige una imagen',
  'images.drop.types': 'PNG, JPEG o WEBP',
  'images.drop.busy': 'Hay un análisis en curso. Espera a que termine para empezar otro.',
  'images.back': 'Volver a los análisis',
  'images.preview.remove': 'Quitar',
  'images.preview.replace': 'Reemplazar',
  'images.preview.alt': 'Imagen seleccionada',
  'images.chip.summarize': 'Resumir esta imagen',
  'images.chip.summarize.prompt':
    'Resume el contenido visible de esta imagen. Menciona todo lo que sea importante o poco ' +
    'habitual.',
  'images.chip.extractText': 'Extraer el texto visible',
  'images.chip.extractText.prompt':
    'Extrae el texto visible que puedas leer. Conserva los saltos de línea cuando sea útil. ' +
    'Indica si algún texto no está claro.',
  'images.chip.explainChart': 'Explicar este gráfico',
  'images.chip.explainChart.prompt':
    'Explica qué parece mostrar este gráfico. Menciona los ejes, las etiquetas, las tendencias y ' +
    'cualquier incertidumbre.',
  'images.chip.readForm': 'Leer este formulario',
  'images.chip.readForm.prompt':
    'Identifica los campos y valores principales que se ven en este formulario. Escribe ' +
    '«ilegible» donde no puedas leer algo.',
  'images.chip.importantDetails': 'Buscar detalles importantes',
  'images.chip.importantDetails.prompt':
    'Enumera los detalles visibles más importantes. No deduzcas nada que no se vea.',
  'images.chip.whatNotice': '¿En qué debo fijarme?',
  'images.chip.whatNotice.prompt':
    '¿En qué debo fijarme en esta imagen? Señala solo los elementos visibles más destacados.',
  'images.composer.placeholder': 'Pregunta algo sobre esta imagen…',
  'images.composer.ask': 'Preguntar',
  'images.answer.localNote': 'Generada de forma local a partir de la imagen seleccionada.',
  'images.answer.copy': 'Copiar',
  'images.answer.copied': 'Copiado',
  'images.answer.copyFailed': 'No se pudo copiar en el portapapeles',
  'images.answer.tryAgain': 'Volver a intentarlo',
  'images.answer.reading': 'Leyendo la imagen…',
  'images.answer.starting': 'Iniciando el modelo para imágenes…',
  'images.answer.stop': 'Detener',
  'images.answer.stopped': 'Se detuvo.',
  'images.err.tooLarge':
    'Esta imagen es demasiado grande para analizarla. Prueba con una imagen más pequeña.',
  'images.err.unsupported':
    'Ese tipo de archivo no es compatible. Elige una imagen PNG, JPEG o WEBP.',
  'images.err.heic':
    'Las fotos HEIC del iPhone aún no son compatibles. Primero convierte la foto a JPEG.',
  'images.err.pdf':
    'Esta pantalla lee una sola imagen, no un PDF. Para un PDF escaneado, usa «Habilitar ' +
    'búsqueda (OCR)» en Documentos.',
  'images.err.pdfAction': 'Ir a Documentos',
  'images.err.decodeFailed':
    'No se pudo abrir esa imagen. Puede que esté dañada o en un formato no compatible.',
  'images.err.multiDrop': 'Suelta una sola imagen cada vez.',
  'images.err.runtimeFailed':
    'El modelo para imágenes no pudo iniciarse. Vuelve a intentarlo o elige otro modelo.',
  'images.err.engineCannotRun':
    'El motor de IA no puede funcionar en este equipo. En la pantalla Modelo de IA se indica qué ' +
    'falta.',
  'images.err.emptyResponse':
    'No se recibió ninguna respuesta sobre esa imagen. Prueba a formular la pregunta de otra ' +
    'manera.',
  'images.err.emptyQuestion': 'Primero escribe una pregunta sobre la imagen.',
  'images.err.timedOut':
    'Esto está tardando demasiado. Prueba con una imagen más pequeña o vuelve a preguntar.',
  'images.err.contextExceeded':
    'Esta conversación es demasiado larga para esta imagen. Haz una pregunta más corta o empieza ' +
    'un análisis nuevo.',
  'images.err.busy': 'Respondiendo a la pregunta anterior…',
  'images.err.openFailed': 'No se pudo abrir ese análisis. Vuelve a intentarlo.',
  'images.err.deleteFailed': 'No se pudo eliminar ese análisis. Vuelve a intentarlo.',
  'images.err.clearFailed': 'No se pudo borrar el historial. Vuelve a intentarlo.',
  'images.history.title': 'Historial',
  'images.history.empty': 'Las imágenes que analices aparecerán aquí.',
  'images.history.running': 'Análisis en curso…',
  'images.history.runningOpen': 'Ver el análisis en curso',
  'images.history.turns.one': '{count} pregunta',
  'images.history.turns.many': '{count} de preguntas',
  'images.history.turns.other': '{count} preguntas',
  'images.history.delete': 'Eliminar',
  'images.history.deleteAria': 'Eliminar «{title}»',
  'images.history.deleted': 'Se eliminó del historial',
  'images.history.delete.title': '¿Eliminar esta imagen?',
  'images.history.delete.confirm': 'Eliminar',
  'images.history.delete.body':
    '«{title}» y sus respuestas se eliminarán de esta unidad de forma permanente.',
  'images.history.total': 'Total: {size}',
  'images.history.clear': 'Borrar historial',
  'images.history.clear.title': '¿Borrar el historial de imágenes?',
  'images.history.clear.confirm': 'Borrar historial',
  'images.history.clear.body':
    'Todos los análisis guardados ({size}) y las imágenes guardadas con ellos se eliminarán de ' +
    'esta unidad de forma permanente.',
  'images.history.cleared': 'Historial de imágenes borrado',
  // ---- Translate screen (TranslateGemma wave, plan §2 D6, TG-4) ----
  'translate.title': 'Traducir texto',
  'translate.lead':
    'Escribe o pega un texto, elige los idiomas y tradúcelo de forma local. Nada sale de esta ' +
    'unidad.',
  'translate.starting': 'Preparando el modelo de traducción…',
  'translate.avail.noModel': 'Para traducir hace falta el modelo de traducción en esta unidad.',
  'translate.avail.hint':
    'Descárgalo una vez en la pantalla Modelo de IA y después la traducción funcionará ' +
    'completamente sin conexión.',
  'translate.avail.cta': 'Ir a Modelo de IA',
  'translate.from': 'De',
  'translate.to': 'A',
  'translate.swap': 'Intercambiar idiomas',
  'translate.input.label': 'Texto para traducir',
  'translate.input.placeholder': 'Escribe o pega el texto que quieres traducir…',
  'translate.action': 'Traducir',
  'translate.stop': 'Detener',
  'translate.output.label': 'Traducción',
  'translate.output.empty': 'La traducción aparecerá aquí.',
  'translate.working': 'Traduciendo…',
  'translate.copy': 'Copiar',
  'translate.copied': 'Copiado',
  'translate.device.gpu':
    'La traducción se ejecuta en la tarjeta gráfica (GPU, capas: {done}/{total})',
  'translate.device.gpuUnknown': 'La traducción se ejecuta en la tarjeta gráfica (GPU)',
  'translate.device.gpuPartial':
    'La traducción solo se ejecuta en parte en la tarjeta gráfica (capas: {done}/{total}): la ' +
    'memoria gráfica estaba casi toda ocupada, normalmente por el modelo de chat, así que va más ' +
    'o menos a la velocidad del procesador',
  'translate.device.gpuNone':
    'La traducción se ejecuta en el procesador: la memoria gráfica estaba totalmente ocupada, ' +
    'normalmente por el modelo de chat, así que no cupo ninguna capa en la tarjeta gráfica ' +
    '(capas: 0/{total})',
  'translate.device.cpu': 'La traducción se ejecuta en el procesador (CPU)',
  'translate.device.cpuBesideChat':
    'La traducción se ejecuta en el procesador: el modelo de chat está usando la memoria gráfica ' +
    'y la traducción no cabría a su lado',
  'translate.device.cpuChatStarting':
    'La traducción se ejecuta en el procesador: se estaba iniciando un modelo de chat, y el ' +
    'modelo de chat tiene prioridad en la tarjeta gráfica',
  'translate.device.cpuTooLarge':
    'La traducción se ejecuta en el procesador: el modelo de traducción no cabe en la memoria de ' +
    'esta tarjeta gráfica',
  'translate.device.title':
    'Indica dónde se ejecutó el modelo de traducción la última vez que se inició. Se vuelve a ' +
    'decidir en cada inicio (el modelo se libera de la memoria unos 2 minutos después de la ' +
    'última traducción).',
  'translate.device.partialTitle':
    'Para que el modelo de traducción tenga más espacio en la tarjeta: usa un modelo de chat más ' +
    'pequeño o detén el modelo de chat antes de traducir. El modelo de traducción se vuelve a ' +
    'ajustar en su próximo inicio (unos 2 minutos después de la última traducción).',
  'translate.device.gpuNoneTitle':
    'Para que el modelo de traducción pueda usar la tarjeta: usa un modelo de chat más pequeño o ' +
    'detén el modelo de chat antes de traducir. El modelo de traducción se vuelve a ajustar en ' +
    'su próximo inicio (unos 2 minutos después de la última traducción).',
  'translate.err.noModel':
    'El modelo de traducción ya no está disponible. Abre la pantalla Modelo de IA para ' +
    'instalarlo.',
  'translate.err.badRequest':
    'Elige un idioma de origen y un idioma de destino, y escribe un texto para traducir.',
  'translate.err.busy':
    'Ya hay una traducción en curso. Espera a que termine y vuelve a intentarlo.',
  'translate.err.docTaskBusy':
    'Hay una tarea de documentos en curso. Espera a que termine y luego traduce.',
  'translate.err.runtimeFailed':
    'El modelo de traducción no pudo terminar. Vuelve a intentarlo o prueba con un texto más ' +
    'corto.',
  'translate.err.startFailed':
    'El modelo de traducción no pudo iniciarse: puede que quede poca memoria libre en el ' +
    'dispositivo. Cierra otras aplicaciones o reinicia HilbertRaum y vuelve a intentarlo.',
  'translate.err.engineCannotRun':
    'El motor de IA no puede funcionar en este equipo. En la pantalla Modelo de IA se indica qué ' +
    'falta.',
  'translate.err.empty':
    'No se recibió ninguna traducción. Vuelve a intentarlo o formula el texto de otra manera.',
  'translate.err.sameLang': 'Elige dos idiomas distintos.',
  'translate.err.tooLong':
    'El texto es demasiado largo para traducirlo aquí (más de 200.000 caracteres). Divídelo en ' +
    'partes más pequeñas o guárdalo como archivo y tradúcelo como documento.',
  // ---- Document drag-and-drop translation (TG-5, plan §2 D7) ----
  'translate.drop.title': 'O suelta aquí un documento para traducirlo',
  'translate.drop.choose': 'o elige un documento',
  'translate.drop.types': 'PDF, Word, Markdown o texto: se traducen al idioma elegido.',
  'translate.file.importing': 'Leyendo el documento…',
  'translate.file.progress': 'Traduciendo… ({done}/{total})',
  'translate.file.preparing': 'Preparando la traducción: leyendo el documento…',
  'translate.file.saving': 'Guardando el documento traducido…',
  'translate.file.truncated':
    'Se muestra el principio de la traducción. Para ver el documento completo, expórtalo o ' +
    'ábrelo en Documentos.',
  'translate.file.export': 'Exportar…',
  'translate.file.exported': 'Documento exportado',
  'translate.file.show': 'Mostrar en Documentos',
  'translate.file.reset': 'Traducir otro documento',
  'translate.file.doneAnnounce': 'La traducción del documento terminó. Se muestra el resultado.',
  'translate.file.gapPages.one':
    '⚠ No se pudo traducir la página {pages} del original: no contiene texto legible (puede que ' +
    'sea una página escaneada). El resultado señala el hueco.',
  'translate.file.gapPages.many':
    '⚠ No se pudieron traducir las páginas {pages} del original: no contienen texto legible ' +
    '(puede que sean páginas escaneadas). El resultado señala cada hueco.',
  'translate.file.gapPages.other':
    '⚠ No se pudieron traducir las páginas {pages} del original: no contienen texto legible ' +
    '(puede que sean páginas escaneadas). El resultado señala cada hueco.',
  'translate.file.failedParts.one':
    '⚠ No se pudo traducir {count} parte: el texto original se conserva en el lugar marcado del ' +
    'resultado.',
  'translate.file.failedParts.many':
    '⚠ No se pudieron traducir {count} de partes: el texto original se conserva en los lugares ' +
    'marcados del resultado.',
  'translate.file.failedParts.other':
    '⚠ No se pudieron traducir {count} partes: el texto original se conserva en los lugares ' +
    'marcados del resultado.',
  'translate.file.err.multiDrop': 'Suelta un solo documento cada vez.',
  'translate.file.err.noPath':
    'Ese elemento no es un archivo guardado en tu equipo. Arrastra un documento desde una ' +
    'carpeta o usa la opción «elige un documento».',
  'translate.file.err.unsupported':
    'Ese tipo de archivo no se puede traducir. Prueba con un archivo PDF, Word, Markdown o de ' +
    'texto.',
  'translate.file.err.scanned':
    'Este PDF parece un escaneo sin texto legible. Primero habilita la búsqueda en Documentos ' +
    'con «Habilitar búsqueda (OCR)» y luego tradúcelo.',
  'translate.file.err.scannedAction': 'Ir a Documentos',
  'translate.file.err.importFailed': 'No se pudo leer el documento. Vuelve a intentarlo.',
  'translate.file.err.runtimeFailed': 'No se pudo traducir el documento. Vuelve a intentarlo.',
  // ---- Evidence review (EP-1 plan §7 — ReviewScreen.tsx + chat entry points) ----
  'review.action.start': 'Revisar evidencia',
  'review.action.continue': 'Continuar revisión',
  'review.entry.sources': 'Revisar respuesta y fuentes',
  'review.status.draft': 'Borrador',
  'review.status.ready': 'Lista',
  'review.status.outdated': 'Desactualizada',
  'review.readonlyHint': 'Marcada como lista: reabre la revisión para editarla.',
  // ---- P4: Outdated banner + acknowledge (spec §15.5/§21.3/§28.6) ----
  'review.outdated.title': 'Esta revisión está desactualizada.',
  'review.outdated.answerChanged':
    'El texto de la respuesta ya no coincide con la instantánea revisada.',
  'review.outdated.coverageChanged':
    'Los metadatos de cobertura registrados ya no coinciden con la instantánea revisada.',
  'review.outdated.sourcesChanged.one':
    '{count} documento fuente ha cambiado desde que se creó esta revisión.',
  'review.outdated.sourcesChanged.many':
    '{count} de documentos fuente han cambiado desde que se creó esta revisión.',
  'review.outdated.sourcesChanged.other':
    '{count} documentos fuente han cambiado desde que se creó esta revisión.',
  'review.outdated.keepNote':
    'Tus decisiones registradas no cambian. Puedes conservar la revisión histórica, confirmar el ' +
    'cambio o volver a preguntar en el chat y empezar una revisión nueva.',
  'review.outdated.acknowledge': 'Confirmar el cambio',
  'review.outdated.acknowledgedAt': 'Cambio confirmado: {date}.',
  'review.outdated.exportHint': 'Confirma el cambio antes de exportar un paquete de evidencia.',
  'review.back': 'Volver al chat',
  'review.rename': 'Cambiar nombre',
  'review.rename.label': 'Título de la revisión',
  'review.rename.save': 'Guardar',
  'review.loading': 'Cargando la revisión…',
  'review.notFound': 'No se encontró esta revisión. Puede que se haya eliminado.',
  'review.question.toggle': 'Pregunta',
  'review.answerPane.aria': 'Respuesta en revisión',
  'review.autosave.saving': 'Guardando…',
  'review.autosave.saved': 'Guardado',
  'review.autosave.error': 'Algunos cambios todavía no se pudieron guardar.',
  'review.autosave.retry': 'Volver a intentarlo',
  'review.evidence.title': 'Evidencia',
  'review.evidence.captionRelevance':
    'Las fuentes que se muestran son los extractos que se le proporcionaron al modelo de IA ' +
    'local para esta respuesta.',
  'review.evidence.captionWholeDoc':
    'Esta respuesta se obtuvo mediante un análisis del documento completo. Las secciones que se ' +
    'muestran son su procedencia y no son referencias a frases concretas.',
  'review.evidence.captionStructured':
    'Esta respuesta usó datos extraídos de forma local. Abajo se muestran los pasajes de las ' +
    'fuentes de los que se extrajeron.',
  'review.evidence.none':
    'Esta respuesta no tiene extractos de fuentes guardados. Puedes registrar una revisión ' +
    'general, pero no se puede hacer una verificación fuente por fuente.',
  'review.disclaimer':
    'Una referencia a la fuente muestra de dónde procede la información. Por sí sola no ' +
    'demuestra que la respuesta sea correcta.',
  'review.evidence.filterLabel': 'Filtrar fuentes',
  'review.evidence.filterPlaceholder': 'Filtrar por título o texto…',
  'review.evidence.filterClear': 'Borrar filtro',
  'review.evidence.filterNone': 'Ninguna fuente coincide con tu filtro.',
  'review.evidence.shownCount': 'Fuentes mostradas: {shown} de {total}',
  'review.evidence.more.one': 'y {count} fuente más',
  'review.evidence.more.many': 'y {count} de fuentes más',
  'review.evidence.more.other': 'y {count} fuentes más',
  'review.evidence.linkingItem': 'Vinculando evidencia al punto de revisión {n}',
  'review.source.kind.direct_excerpt': 'Extracto directo',
  'review.source.kind.whole_document_provenance':
    'Procedencia de un análisis del documento completo',
  'review.source.kind.structured_record': 'Datos extraídos',
  'review.source.unresolved': 'No se pudo determinar la identidad de la fuente',
  'review.source.archive':
    'Artículo de un paquete de conocimiento: su identidad y su contenido no se pueden verificar ' +
    'comparándolos con el espacio de trabajo',
  'review.source.missingAtCreation': 'La fuente no estaba disponible cuando se creó esta revisión',
  'review.source.changed': 'El documento fuente ha cambiado desde que se creó esta revisión',
  'review.source.missingNow':
    'Esta fuente ya no está en el espacio de trabajo. El extracto guardado se conserva en esta ' +
    'revisión.',
  'review.source.cannotVerify': 'No se puede verificar el estado actual de esta fuente',
  'review.sourceContext.open': 'Abrir la fuente en contexto',
  'review.sourceContext.title': 'Fuente en contexto',
  'review.sourceContext.loading': 'Cargando el texto guardado…',
  'review.sourceContext.failed': 'No se pudo cargar el texto guardado de esta fuente.',
  'review.sourceContext.hashMatch':
    'El hash guardado del documento coincide con la instantánea de la revisión.',
  'review.sourceContext.hashMismatch':
    'El documento fuente ha cambiado desde que se creó esta revisión.',
  'review.sourceContext.hashUnknown':
    'No se puede verificar el estado actual del documento comparándolo con la instantánea de la ' +
    'revisión.',
  'review.sourceContext.missing':
    'Esta fuente estaba disponible cuando se generó la respuesta, pero ya no está en el espacio ' +
    'de trabajo. El extracto guardado se conserva en esta revisión, si está disponible.',
  'review.sourceContext.notLocated':
    'No se pudo localizar el extracto guardado en el texto guardado actual. Abajo se muestra tal ' +
    'como se registró al crear la revisión.',
  'review.sourceContext.storedNote':
    'El contexto procede del texto guardado que se extrajo al importar: el archivo original en ' +
    'sí no se abre.',
  'review.sourceContext.excerptHeading': 'Extracto guardado',
  'review.link.add': 'Vincular al punto',
  'review.link.remove': 'Quitar vínculo',
  'review.link.cited': 'Referenciado por la respuesta',
  'review.link.reviewer': 'Vinculado en la revisión',
  'review.link.selectHint':
    'Selecciona un punto de revisión para vincular evidencia o quitar vínculos.',
  'review.relation.label': 'Relación',
  'review.relation.none': 'Sin especificar',
  'review.relation.supports': 'Respalda',
  'review.relation.qualifies': 'Matiza',
  'review.relation.contradicts': 'Contradice',
  'review.relation.context': 'Solo contexto',
  'review.item.aria': 'Punto de revisión {n}',
  'review.item.noMarker': 'Este texto no tiene ningún marcador de fuente directo',
  'review.item.wholeDocDerived': 'Obtenido mediante un análisis del documento completo',
  'review.item.noteLabel': 'Nota',
  'review.item.notePlaceholder': 'Agregar una nota (opcional)',
  'review.item.viewEvidence': 'Ver evidencia',
  // ---- P5 reviewer text selections (spec §12.1 "Review separately"; plan §10) ----
  'review.selection.start': 'Revisar un pasaje por separado',
  'review.selection.hint':
    'Selecciona el pasaje en el texto original de abajo (se muestra sin formato) y luego elige ' +
    '«Revisar por separado».',
  'review.selection.surfaceAria': 'Texto original del punto de revisión {n}',
  'review.selection.add': 'Revisar por separado',
  'review.selection.close': 'Hecho',
  'review.selection.added': 'El pasaje se agregó como un punto de revisión propio.',
  'review.selection.refused':
    'No se pudo agregar esa selección. Selecciona el pasaje otra vez y vuelve a intentarlo.',
  'review.item.selectionTag': 'Texto seleccionado en la revisión',
  'review.selection.remove': 'Quitar selección',
  'review.decision.groupAria': 'Decisión',
  'review.decision.supported': 'Revisado: respaldado',
  'review.decision.partly_supported': 'Revisado: respaldado en parte',
  'review.decision.not_supported': 'Revisado: no respaldado',
  'review.decision.follow_up': 'Requiere seguimiento',
  'review.decision.not_reviewed': 'Sin revisar',
  'review.decision.not_applicable': 'No aplicable',
  'review.bulk.menu': 'Acciones en lote',
  'review.bulk.headingsNa': 'Marcar los encabezados como «No aplicable»',
  'review.bulk.followUp': 'Marcar los puntos sin decisión como «Requiere seguimiento»',
  'review.bulk.clear': 'Borrar todas las decisiones',
  'review.bulk.clearConfirmTitle': '¿Borrar todas las decisiones?',
  'review.bulk.clearConfirmBody':
    'Todas las decisiones de esta revisión vuelven a «Sin revisar». Las notas se conservan.',
  'review.bulk.clearConfirm': 'Borrar decisiones',
  'review.progress': 'Con decisión: {decided} de {required}',
  'review.progress.followUps.one': '{count} punto requiere seguimiento',
  'review.progress.followUps.many': '{count} de puntos requieren seguimiento',
  'review.progress.followUps.other': '{count} puntos requieren seguimiento',
  'review.footer.summary': 'Resumen de la revisión',
  'review.summary.status': 'Estado',
  'review.summary.decisions': 'Decisiones',
  'review.summary.sources': 'Fuentes',
  'review.summary.sourcesCount.one': '{count} fuente',
  'review.summary.sourcesCount.many': '{count} de fuentes',
  'review.summary.sourcesCount.other': '{count} fuentes',
  'review.summary.sourcesUnresolved.one': 'No se pudo determinar la identidad de {count} fuente',
  'review.summary.sourcesUnresolved.many':
    'No se pudo determinar la identidad de {count} de fuentes',
  'review.summary.sourcesUnresolved.other': 'No se pudo determinar la identidad de {count} fuentes',
  'review.summary.sourcesArchive.one':
    '{count} fuente es un artículo de un paquete de conocimiento que no se puede verificar ' +
    'comparándolo con el espacio de trabajo',
  'review.summary.sourcesArchive.many':
    '{count} de fuentes son artículos de paquetes de conocimiento que no se pueden verificar ' +
    'comparándolos con el espacio de trabajo',
  'review.summary.sourcesArchive.other':
    '{count} fuentes son artículos de paquetes de conocimiento que no se pueden verificar ' +
    'comparándolos con el espacio de trabajo',
  'review.summary.sourcesMissing.one':
    '{count} fuente no estaba disponible cuando se creó esta revisión',
  'review.summary.sourcesMissing.many':
    '{count} de fuentes no estaban disponibles cuando se creó esta revisión',
  'review.summary.sourcesMissing.other':
    '{count} fuentes no estaban disponibles cuando se creó esta revisión',
  'review.summary.sourcesChangedNow.one':
    '{count} documento fuente ha cambiado desde que se creó esta revisión',
  'review.summary.sourcesChangedNow.many':
    '{count} de documentos fuente han cambiado desde que se creó esta revisión',
  'review.summary.sourcesChangedNow.other':
    '{count} documentos fuente han cambiado desde que se creó esta revisión',
  'review.summary.sourcesMissingNow.one':
    '{count} documento fuente ya no está en el espacio de trabajo',
  'review.summary.sourcesMissingNow.many':
    '{count} de documentos fuente ya no están en el espacio de trabajo',
  'review.summary.sourcesMissingNow.other':
    '{count} documentos fuente ya no están en el espacio de trabajo',
  'review.summary.truncated':
    'Puede que la respuesta generada esté incompleta: se cortó al llegar al límite de salida del ' +
    'modelo.',
  'review.summary.stopped.model':
    'La respuesta generada está incompleta: se detuvo o se cambió el modelo de IA antes de que ' +
    'terminara.',
  'review.summary.stopped.user':
    'La respuesta generada está incompleta: se detuvo antes de que terminara.',
  'review.summary.stopped.lock':
    'La respuesta generada está incompleta: se bloqueó el espacio de trabajo o se cerró la ' +
    'aplicación antes de que terminara.',
  'review.summary.generation': 'Detalles de la generación',
  'review.summary.model': 'Modelo',
  'review.summary.generatedAt': 'Fecha de generación',
  'review.summary.appVersion': 'Versión de la aplicación',
  'review.summary.skill': 'Habilidad',
  'review.summary.unavailable': 'No disponible',
  'review.summary.reviewerLabel': 'Revisado por',
  'review.summary.reviewerPlaceholder': 'Tu nombre o un identificador (opcional)',
  'review.summary.generalNote': 'Nota general',
  'review.summary.generalNotePlaceholder': 'Observaciones generales (opcional)',
  'review.summary.exports': 'Historial de exportaciones',
  'review.summary.markReady': 'Marcar la revisión como lista',
  'review.summary.reopen': 'Reabrir la revisión',
  'review.summary.gateHint':
    'Cada bloque de la respuesta necesita una decisión antes de poder marcar la revisión como ' +
    'lista (con decisión: {decided} de {required}). La opción «No aplicable» cuenta como ' +
    'decisión.',
  'review.toast.ready': 'Revisión marcada como lista.',
  'review.completedAt': 'Marcada como lista: {date}',
  'review.deleteWithConversation.one':
    'También se eliminará {count} revisión de evidencia asociada a esta conversación.',
  'review.deleteWithConversation.many':
    'También se eliminarán {count} de revisiones de evidencia asociadas a esta conversación.',
  'review.deleteWithConversation.other':
    'También se eliminarán {count} revisiones de evidencia asociadas a esta conversación.',
  'review.deleteWithConversation.unknown':
    'También se eliminarán las revisiones de evidencia asociadas a esta conversación, si las hay.',
  // ---- Evidence-pack export (EP-1 plan §8 — summary panel + status line) ----
  'review.status.lastExported': 'Última exportación: {date}',
  'review.export.action': 'Crear paquete de evidencia',
  'review.export.title': 'Exportar paquete de evidencia',
  'review.export.encryptionWarning':
    'Este archivo exportado se guarda fuera del espacio de trabajo cifrado de HilbertRaum y no ' +
    'está protegido por la contraseña de tu espacio de trabajo.',
  'review.export.packLanguage.en': 'Este paquete se escribirá en inglés.',
  'review.export.packLanguage.de': 'Este paquete se escribirá en alemán.',
  'review.export.options': 'Incluir en el paquete',
  'review.export.optNotes': 'Notas de la revisión',
  'review.export.optExcerpts': 'Extractos de las fuentes',
  'review.export.optHashes': 'Hashes de los documentos',
  'review.export.optUnreviewed': 'Puntos sin revisar',
  'review.export.optTechnical': 'Detalles técnicos',
  'review.export.format': 'Formato de archivo',
  'review.export.formatHtml': 'HTML: página web independiente',
  'review.export.formatPdf': 'PDF: listo para imprimir (A4)',
  'review.export.confirm': 'Exportar paquete…',
  'review.export.cancel': 'Cerrar',
  'review.export.done': 'Paquete de evidencia exportado.',
  'review.export.error':
    'No se pudo exportar el paquete de evidencia. No se escribió ningún archivo.',
  'review.export.copyHash': 'Copiar SHA-256',
  'review.export.hashCopied': 'SHA-256 copiado en el portapapeles.'
}
