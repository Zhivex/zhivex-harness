# Assistant: primera versión proactiva

El módulo `daily` incorpora detección periódica de conflictos de agenda, tareas
por vencer y seguimientos explícitos de respuestas. Reutiliza su store SQLite y
lease, las conexiones de Calendar/Gmail/Outlook y la entrega privada de Telegram.
La instalación no activa avisos, conecta cuentas ni envía mensajes.

## Activación y uso

En Inicio o Automatizaciones, dentro de **Tareas y recordatorios**, abrir
**Configurar avisos**. Elegir zona horaria, canal, tipos de aviso, horario de silencio,
margen entre reuniones y límite diario. Marcar **Activar avisos** y guardar.
La web requiere el módulo `daily`; Telegram necesita un chat privado vinculado.
El botón **Pausar avisos** detiene nuevas detecciones y entregas. Los avisos web
se pueden descartar; los mensajes ya enviados no se retiran.

Para configurar desde la conversación y registrar seguimientos, crear un agente
con tareas locales y **Configurar avisos proactivos y seguimientos desde el chat**
en la pestaña Herramientas. En CLI, la configuración equivalente es:

```json
{ "kind": "daily", "proactive": true }
```

Este opt-in expone cuatro herramientas nuevas: `daily_read_proactive_status`,
`daily_write_configure_proactive`, `daily_write_watch_reply` y
`daily_write_cancel_reply_watch`. Las tres escrituras requieren la aprobación
exacta de Harness, tanto desde web como desde Telegram. El calendario y el correo
se conectan con sus módulos habituales; no se amplían los permisos OAuth.

Ejemplos para el chat:

- «Activá avisos de conflictos y tareas en esta web, zona America/Argentina/Buenos_Aires,
  silencio de 22:00 a 08:00 y máximo cinco avisos por día».
- «Buscá mi conversación sobre el presupuesto con ana@example.com y seguí su respuesta.
  Avisame si no contesta antes de mañana a las 15:00, hora de Buenos Aires».
- «Mostrá los seguimientos y dejá de seguir el del presupuesto».

Para registrar un seguimiento, el agente lee primero el hilo y propone la cuenta,
hilo, mensaje de referencia, remitente esperado y plazo con offset explícito.
Guardar un seguimiento no activa una política pausada. El panel muestra los
seguimientos y permite cancelarlos directamente.

Los perfiles existentes conservan su catálogo y binding `daily` v1. La configuración
web de avisos es aditiva para esos agentes. Las herramientas nuevas usan `daily`
v2: requieren un agente/directorio nuevo; no se reescriben conversaciones ni
aprobaciones pendientes. Los módulos de Google y Microsoft mantienen sus perfiles.

## Qué detecta

- **Agenda:** lee las próximas 24 horas del calendario conectado, con hasta diez
  páginas de cien eventos. Detecta superposiciones y márgenes insuficientes,
  incluye eventos de día completo y omite cancelados, libres o declinados cuando
  el adaptador los marca libres. Solo admite una lectura completa. Cada aviso
  identifica ambos eventos y sus horarios. Cambiar los horarios o el margen puede
  producir un nuevo aviso; un conflicto sin cambios no se repite. Los avisos web
  se resuelven en la siguiente lectura completa si el conflicto desaparece.
- **Tareas:** usa fechas locales: vence mañana, vence hoy o vencida. Emite como
  máximo un aviso por tarea, fecha y etapa, sujeto al presupuesto global. Las
  tareas sin fecha se excluyen; completar una tarea retira sus avisos web activos
  en la siguiente revisión. No sincroniza Google Tasks ni Microsoft To Do.
- **Respuestas:** solo revisa los hilos elegidos explícitamente. Gmail usa
  `threadId`; Outlook usa `conversationId`. El mensaje de referencia debe existir
  y no ser borrador. Una respuesta es un mensaje posterior, no borrador, del
  remitente exacto esperado. Otros participantes, borradores y mensajes anteriores
  no cierran el seguimiento. Al detectar la respuesta queda `replied`; si llega
  el plazo sin respuesta se avisa una sola vez y se continúa observando hasta
  respuesta o cancelación. No interpreta el contenido: una respuesta automática
  del remitente también puede cerrar el seguimiento.

Una lectura incompleta, credencial revocada, mensaje de referencia ausente o cuenta
cambiada deja la fuente como no disponible: nunca se convierte en «sin respuesta».
La cuenta queda fijada por el binding de la conexión. Gmail lee hasta 1000 mensajes
con metadata; Outlook hasta diez páginas de cien mensajes, validando las URLs de
continuación antes de enviar credenciales. No se descargan cuerpos ni adjuntos
para la detección.

## Ejecución, límites y recuperación

El servicio comprueba su vencimiento cada segundo y ejecuta una revisión cada cinco
minutos, mientras el host esté activo. Persiste el próximo vencimiento, permite una
sola revisión en vuelo y limita las lecturas de cada revisión a 60 segundos.
No recupera revisiones históricas: al reiniciar vuelve a evaluar el estado actual.
El host no es un servicio del sistema, no despierta equipos suspendidos y solo el
agente seleccionado permanece activo en el host administrado.

El silencio se evalúa en la zona configurada, incluyendo cambios de horario de verano.
Si inicio y fin coinciden, no hay silencio. Durante el silencio se pueden detectar
respuestas y resolver estados, pero no emitir avisos; al salir se reevalúan las fuentes.
El límite predeterminado es cinco avisos, configurable entre uno y veinte. Cuenta el
día local y, adicionalmente, las últimas 24 horas para evitar ráfagas al cambiar de
zona o cruzar medianoche. Se comparte entre los tres detectores; el orden de
admisión es agenda, tareas, respuestas. Los candidatos sin cupo se reevalúan después.

Cada aviso tiene una clave determinística persistida antes de entregar. Telegram usa
la misma capacidad de entrega del servicio diario: un envío incierto, incluso si
el proceso cae mientras envía, queda `uncertain` y nunca se repite automáticamente.
Los avisos web son persistentes dentro de Assistant, no notificaciones push del
navegador. Al vencer o resolverse quedan en el historial. Cambiar la política o
pausarla invalida los resultados de lecturas en vuelo; un envío ya iniciado puede
terminar. Los recibos de deduplicación no se borran al cambiar la política.

Hay un máximo de veinte seguimientos activos y diez mil seguimientos/avisos
históricos por store. Alcanzar el límite detiene nuevas admisiones. Los textos,
políticas y recibos están en el store privado de `daily`, sin cifrado adicional.
OAuth conserva su almacenamiento cifrado existente.

Esta versión produce avisos y sugerencias de siguiente paso con reglas determinísticas,
sin llamadas al modelo en segundo plano. La conversación posterior puede preparar
cambios de calendario o borradores usando las herramientas y aprobaciones existentes.
No genera automáticamente propuestas de modificación, no envía correo ni concede
permisos a partir de títulos, mensajes o preferencias.

## API local autenticada

`GET /api/daily` agrega `proactive`: política, capacidades, salud de fuentes,
seguimientos y últimos cien avisos. Los controles web usan POST con autenticación
y validación de origen existentes:

- `/api/proactive/policy`: política completa; `enabled: false` pausa.
- `/api/proactive/watch`: `requestId`, `source` (`google` o `microsoft`), `threadId`,
  `baselineMessageId`, `expectedFrom`, `title`, `dueAt`.
- `/api/proactive/cancel-watch`: `watchId`.
- `/api/proactive/dismiss`: `alertId`.

Estas acciones web son decisiones directas del propietario autenticado; la ruta
conversacional conserva la aprobación Harness. Los reintentos de registro usan el
mismo UUID; el mismo UUID con otro contenido falla. Un segundo seguimiento activo
con la misma cuenta, hilo, referencia y remitente se rechaza.

## Validación

```sh
bun run --cwd packages/assistant typecheck
bun run --cwd packages/assistant test
bun run --cwd packages/assistant smoke:daily-web
```

Las pruebas cubren deduplicación y reinicios, silencio, cupo, fallos parciales,
conflictos con paginación, cancelación en vuelo, cierre de seguimientos, aislamiento
de cuenta, envío incierto y aprobación exacta a través del host. Los adaptadores
Gmail/Outlook usan APIs simuladas. Chromium verifica la configuración, persistencia,
pausa, autenticación y diseño móvil. No certifica entregas ni cuentas externas reales.

Contratos consultados: [Gmail threads.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get),
[Gmail messages](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages),
[Microsoft Graph list messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
y [message](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0).
