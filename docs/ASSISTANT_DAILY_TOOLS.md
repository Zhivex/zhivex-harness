# Assistant: herramientas para el día a día

Implementación del 2026-11-11. Módulos opcionales sobre las APIs públicas de
Harness; las acciones conservan su aprobación exacta en web y Telegram.
No conecta cuentas ni habilita automatizaciones por instalar o construir el paquete.

## Capacidades

| Módulo | Herramientas | Comportamiento |
| --- | --- | --- |
| `daily` | `daily_read_clock`, `daily_read_tasks`, `daily_write_create_task`, `daily_write_complete_task` | Tareas locales persistentes, fecha opcional, paginación, fecha/hora actual en zona explícita |
| `daily` | `daily_read_reminders`, `daily_write_schedule_reminder`, `daily_write_cancel_reminder` | Avisos puntuales en web o Telegram, fecha/hora/zona explícitas y estado durable |
| `daily` | `daily_write_save_note`, `daily_read_search_notes`, `daily_read_read_note`, `daily_write_delete_note` | Notas explícitas, búsqueda literal y borrado por ID; no memoria semántica ni extracción automática |
| `google` con `mail` | `google_read_mail_search`, `google_read_mail_thread`, `google_write_mail_create_draft`, `google_read_mail_draft_status` | Consulta de Gmail y creación de borradores aprobados; no envía correo |
| `google` con `drive` | `google_read_knowledge_search`, `google_read_knowledge_read` | Búsqueda de Drive y lectura de Google Docs, texto, Markdown y CSV |
| `github` | `github_remote_search_issues`, `github_remote_issue_read`, `github_remote_search_pull_requests`, `github_remote_pull_request_read`, `github_remote_actions_list`, `github_remote_actions_get` | Catálogo fijo del MCP oficial remoto de lectura |
| `web` | `web_read_search`, `web_read_page` | Brave Search y lectura de páginas HTTPS públicas, disponibles para modelos con herramientas |

## Empezar con tareas locales

Usar una instancia nueva para no cambiar el perfil ligado a conversaciones y
aprobaciones existentes. Preparar el candidato local como indica el README.
Desde la raíz del repo:

```sh
bun run --cwd packages/assistant build
bun run --cwd packages/assistant start --directory "$HOME/.zhx-daily" --owner local-owner --provider openai --web --config packages/assistant/examples/daily-tools.json
```

Configurar la credencial del proveedor en su variable habitual antes del arranque.
El archivo de ejemplo solo activa `daily`; no necesita servicios externos para
almacenar tareas y notas. La conversación sí requiere el modelo configurado.

En la web administrada, crear un agente, elegir su modelo y abrir **Herramientas**.
Marcar tareas/recordatorios/notas y pulsar **Guardar herramientas** antes de iniciar.
Las integraciones se muestran luego en Configuración. Cambiar la composición
requiere un agente nuevo; no se reescribe el binding de un agente existente.
Solo el agente seleccionado permanece activo en el host administrado.

Ejemplos de pedidos:

- «Guardá comprar los pasajes como tarea para el 20 de noviembre».
- «Recordame mañana a las 09:00 en America/Argentina/Buenos_Aires por Telegram».
- «Guardá esta decisión como nota: usamos Bun para los proyectos TypeScript».
- «Mostrá mis pendientes y marcá la compra de pasajes como completada».

El asistente consulta la hora cuando necesita interpretar fechas relativas y pide
la zona si no está definida. Las escrituras usan `requestId` UUID: repetir la misma
operación devuelve su recibo; reutilizarlo con otros argumentos falla. No hace
falta que el usuario escriba el UUID. La vista Inicio/Automatizaciones muestra
20 pendientes y hasta 100 recordatorios recientes; las herramientas paginan tareas.

## Recordatorios y resumen diario

Los recordatorios admiten hasta 366 días hacia adelante y necesitan el host en
marcha. La web es una notificación persistente dentro de Assistant, no una alarma
del sistema operativo ni una notificación push del navegador. Telegram requiere
un chat privado ya vinculado y usa la cuenta fijada por el host.

El scheduler comprueba avisos cada segundo. Una hora duplicada por DST usa la
primera aparición; una hora inexistente usa el primer minuto posterior válido.
Un día inexistente se rechaza. La revisión muestra el instante resuelto y la zona.
Tras una suspensión se recuperan avisos con hasta 24 horas de retraso; los demás
quedan `expired`. No despierta una computadora suspendida.

Estados: `pending`, `available` (web), `sending`, `delivered`, `uncertain`,
`expired`, `cancelled`. El estado `sending` se persiste antes de enviar. Una
respuesta perdida o un reinicio durante ese estado produce `uncertain` y no se
reenvía automáticamente. Incluso un rechazo del transporte queda conservadoramente
como incierto; el usuario puede inspeccionarlo. Cancelar retira avisos pendientes
o descarta avisos web; no retira envíos ya iniciados.

Con Telegram vinculado, `/daily 08:00 America/Argentina/Buenos_Aires` activa un
resumen con las fuentes configuradas. Funciona con tareas o Gmail aunque no haya
Calendar. El resumen muestra hasta 20 tareas y hasta 5 hilos de la primera página
de correo no leído, con procedencia y límites. Una fuente que falla se identifica
como no disponible; no se presenta como vacía. Calendar conserva su algoritmo de
conflictos y compatibilidad anteriores. `/daily pause|resume|delete|status` mantiene
el comportamiento documentado en [automatizaciones](ASSISTANT_AUTOMATIONS.md).
GitHub se consulta por conversación; no se sondea automáticamente en el resumen.

## Gmail y Drive

OAuth es independiente de Calendar y guarda las credenciales cifradas en
`google/state` dentro del directorio del agente. Solicita los scopes de lectura y
composición de Gmail y/o lectura de Drive según la selección, además de identidad.
La API de composición de Google tiene permisos más amplios que las herramientas
expuestas: Assistant solo ofrece creación de borradores, no envío.

En el asistente de creación web, seleccionar Gmail/Drive en **Herramientas**,
indicar el cliente OAuth de Google (o usar `ASSISTANT_GOOGLE_CLIENT_ID` del host),
y completar **Autorizar en Google**. La clave de cifrado se guarda con la
configuración protegida por el llavero. Calendar usa su autorización separada.

En CLI, agregar `{ "kind": "google", "mail": true, "drive": true }` al JSON.
Configurar `ASSISTANT_GOOGLE_CLIENT_ID`, `ASSISTANT_GOOGLE_CLIENT_SECRET` si corresponde
y `ASSISTANT_CREDENTIAL_KEY` (32 bytes aleatorios codificados en base64, conservados
fuera del repo). Detener el host y conectar usando el mismo directorio:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-connected" --owner local-owner --config packages/assistant/examples/connected-tools.json --google-connect
```

`--google-status` inspecciona la conexión; `--google-disconnect` elimina credenciales
locales e intenta revocar el token. Si falla la revocación, devuelve `revoked: false`.
Para iniciar después, quitar el flag OAuth y elegir el proveedor/modelo. El ejemplo
conectado también requiere las credenciales de GitHub y Brave; quitar esos módulos
antes del primer arranque si no se van a usar.

La revisión de borradores contiene destinatarios, asunto, texto y, para respuestas,
el hilo y mensaje padre. Antes del POST se verifica que ese mensaje siga siendo el
último y que el asunto coincida. Se conservan `threadId`, `In-Reply-To` y `References`.
Google no ofrece aquí una escritura condicional del hilo: otro mensaje puede llegar
entre lectura y creación. El resultado incierto se guarda y nunca se reintenta con
el mismo UUID. Inspeccionar Borradores de Gmail antes de autorizar uno nuevo; no hay
reconciliación automática que garantice identificar un borrador de respuesta perdida.

La búsqueda de correo devuelve hasta 20 IDs por página y token de continuación.
La lectura de hilo muestra los últimos 20 mensajes, texto plano y snippets; no carga
adjuntos. Drive devuelve hasta 20 resultados por página y conserva sus enlaces.
Lecturas limitadas a 256 KiB y 24000 caracteres con indicador de truncamiento.
PDF, imágenes y hojas de cálculo no se convierten en esta versión.

## GitHub y web con otros proveedores

Configurar las variables en el entorno que inicia Assistant:

- `ZHIVEX_MCP_GITHUB_AUTH`: cabecera completa `Bearer TOKEN`. Usar un token con
  acceso de lectura a los repositorios necesarios. La configuración declara la
  cuenta para fijar su identidad; al cambiar de cuenta usar un agente nuevo.
- `BRAVE_SEARCH_API_KEY`: clave de Brave Search. Las consultas consumen su cuota.

El wizard permite seleccionar GitHub y Brave indicando los nombres de las variables;
no devuelve sus valores al navegador. Solo verifica presencia al guardar; acceso
real y compatibilidad se comprueban al llamar las herramientas.
El JSON [connected-tools.json](../packages/assistant/examples/connected-tools.json)
muestra ambos módulos. Reemplazar `account` por la cuenta correspondiente.

GitHub usa `https://api.githubcopilot.com/mcp/x/all/readonly` y un catálogo fijo;
los permisos de Harness siguen aplicando. Un cambio del catálogo remoto puede
hacer fallar la conexión: no se habilitan automáticamente herramientas nuevas.
No sustituye la certificación del servidor real con una cuenta.

Brave devuelve hasta 5 fuentes por consulta y offset para continuar. La lectura
web acepta solo HTTPS público en el puerto estándar, resuelve DNS y fija una IP
validada para evitar cambios de resolución entre validación y conexión. Rechaza
redirecciones, credenciales embebidas, redes privadas y formatos que no sean
HTML/texto. Descarga hasta 512 KiB, devuelve hasta 24000 caracteres y no ejecuta
JavaScript. La búsqueda hospedada OpenAI existente sigue siendo independiente.

## Estado, límites y validación

`daily/telegram.sqlite` es un store privado separado: reutiliza el mecanismo de
lease de Telegram, pero no comparte sus tablas ni su archivo con el bridge. Guarda
tareas, notas, recordatorios y recibos. Sus textos tienen permisos locales privados,
sin cifrado adicional; borrar notas no borra conversaciones ni backups. Límite de
10000 operaciones locales y 10000 recibos de borradores; no se borran recibos para
simular idempotencia ilimitada. Un lock de dueño vivo nunca se recupera; tras caída,
el arranque CLI requiere `--recover`.

Las pruebas offline cubren persistencia, idempotencia, aislamiento por propietario,
DST, cancelación, expiración, recuperación de envíos inciertos, aprobación Harness,
OAuth/scopes/renovación, paginación, MIME de respuestas, borradores inciertos,
lectura acotada de documentos y rechazo de destinos privados. No certifican claves,
cuentas, cuotas ni entregas externas reales. No se publicó ni desplegó el producto.

Validación local de esta entrega: 102 pruebas, 850 aserciones, sin fallos;
TypeScript, build, arquitectura, documentación y contratos aprobados. Chromium
verificó creación/configuración del agente, persistencia de la selección y panel
de tareas a 1440px y 390px, sin errores de página ni desborde horizontal.
La prueba de caída mata un proceso Node durante el envío y verifica en otro
proceso que el recordatorio queda incierto y no se repite.

Para repetir las verificaciones desde la raíz (Chromium debe estar instalado
para Playwright; los servidores y proveedores de estas pruebas son simulados):

```sh
bun run --cwd packages/assistant typecheck
bun run --cwd packages/assistant test
bun run --cwd packages/assistant smoke:daily-web
```

Fuentes de los contratos externos:

- [Gmail REST](https://developers.google.com/workspace/gmail/api/reference/rest) y [threads](https://developers.google.com/workspace/gmail/api/guides/threads).
- [Drive search](https://developers.google.com/workspace/drive/api/guides/search-files).
- [GitHub MCP remoto](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md).
- [Brave Search](https://api-dashboard.search.brave.com/api-reference/web/search/get).

La sincronización con Google Tasks sigue siendo una extensión posterior: las tareas
implementadas son locales. El campo `due` de Google Tasks representa una fecha y
no reemplazaría el scheduler con hora/zona de Assistant.

La [primera versión proactiva](ASSISTANT_PROACTIVE.md) agrega avisos opt-in de conflictos,
tareas por vencer y respuestas pendientes, con políticas y seguimientos persistentes.
