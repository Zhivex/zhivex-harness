# Automatizaciones en Electron

> Las rutas históricas `reports/unification/…` citadas en este documento pertenecen al [archivo interno](INTERNAL_ARCHIVE.md); los originales se conservaron fuera del árbol publicable.

Assistant → Automations consulta el scheduler de resumen diario del core. Muestra disponibilidad, vinculación de Telegram, estado activo/pausado, próxima ejecución, preferencias guardadas y las últimas siete ocurrencias. Una respuesta ausente no se interpreta como un historial vacío. `enqueued` significa encolado, no recepción confirmada.

Se puede revisar un horario y zona IANA, activar, pausar, reanudar, eliminar el horario u olvidar preferencias. Cada cambio requiere una revisión visible y una confirmación explícita. Activar o reanudar autoriza los resúmenes futuros en la cuenta Telegram vinculada; no dispara un resumen inmediato. Pausar/eliminar cancela entregas pendientes, pero no retira un envío ya iniciado. Olvidar limpia preferencias y pausa el horario.

La revisión incluye un digest de configuración, selección de agente y estado de vinculación. El core rechaza un cambio si otra interfaz modificó esa configuración desde la lectura. Las mutaciones no se reenvían automáticamente; después de una respuesta fallida, la pantalla vuelve a leer el estado y pide una nueva revisión. El endpoint `automation` usa el mismo scheduler y la cola del coordinador, sin un segundo motor en Electron.

El agente necesita una fuente de resumen y Telegram configurados. Telegram puede vincularse al crear un borrador desde [Assistant settings](TELEGRAM_ELECTRON.md). Calendar OAuth también está disponible para nuevos borradores; otras integraciones OAuth y la revinculación de agentes existentes siguen pendientes en Electron; un agente sin scheduler muestra el requisito. No ofrece reenvíos de entregas fallidas o inciertas. Los horarios requieren el host activo y pueden demorarse durante suspensión.

## Validación

```sh
bun test tests/application-automation.test.ts tests/assistant/automation.test.ts
bun run --cwd packages/desktop smoke:automations:packaged
```

La prueba de Electron usa el core instalado, el scheduler, SQLite, IPC y la app empaquetada reales. Inyecta una vinculación Telegram y una fuente de agenda de prueba; no llama a Telegram ni envía mensajes. Verifica ausencia de efectos antes de confirmar, configuración guardada, revisión obsoleta rechazada, pausa y ausencia de scheduler. Reporte y capturas: `reports/unification/automations/`.

Estos resultados no certifican onboarding OAuth/Telegram, recepción real de mensajes ni todas las condiciones de suspensión. La etapa 4 del plan continúa abierta.

La CLI también consume este endpoint: `zhx automations status --json` y `zhx automations apply - --yes`. El segundo recibe una configuración revisada con `projectId` y `expectedDigest`; ver [sintaxis y semántica](CLI.md#automatizaciones-compartidas). Los cambios de una interfaz invalidan la revisión anterior de la otra.

La evidencia de la CLI instalada y sus transiciones está en `reports/unification/cli-automations/report.json`. Las cuentas y la fuente de agenda de las pruebas de configuración son fixtures; no equivalen a recepción de mensajes real.
