# Tareas y recordatorios en Electron

> Las rutas históricas `reports/unification/…` citadas en este documento pertenecen al [archivo interno](INTERNAL_ARCHIVE.md); los originales se conservaron fuera del árbol publicable.

El área Assistant del shell unificado incorpora **Tasks & reminders** cuando está conectada al coordinador de aplicación. La pantalla consulta el store personal del perfil activo; no contiene datos ilustrativos ni usa las tareas de Code.

- Las tareas pendientes se paginan de 20 en 20, con su total y fecha de vencimiento.
- Los últimos 100 recordatorios muestran fecha/hora, zona horaria, canal y estado persistido. `uncertain` no se presenta como entrega exitosa ni permite un reenvío automático.
- La pantalla se actualiza cada tres segundos mientras está abierta, sin solicitudes superpuestas. Cambiar de perfil descarta respuestas tardías; un fallo de lectura se muestra como indisponibilidad, no como lista vacía.
- Los formularios **Ask to create task** y **Ask to schedule reminder**, y las acciones de completar/cancelar, envían una solicitud a la conversación seleccionada. El modelo debe proponer la herramienta del core; el usuario revisa sus argumentos reales antes de aprobar. La UI no afirma éxito a partir del texto del modelo: la lista se vuelve a leer del store.
- Los recordatorios creados aquí usan el canal interno `web`, mostrado como **In app**. Son registros visibles en esta pantalla, no notificaciones del sistema operativo. Requieren el host activo; el motor aplica su política de horarios, DST y expiración.

Para usarlo, habilitar **Enable tasks and reminders** al configurar un agente, crear o seleccionar una conversación y abrir **Tasks & reminders**. Un agente sin el módulo muestra un estado explicativo y acceso a configuración. La conexión avanzada por archivo de un runtime individual no expone esta pantalla; requiere el coordinador compartido.

El endpoint `personal-state` del core es exclusivamente de lectura y valida el identificador del runtime activo antes de proyectar datos. El preload no permite invocar escrituras del store. El motor mantiene las aprobaciones y los recibos de idempotencia, incluida la revisión de la hora resuelta de un recordatorio.

## Validación

```sh
bun test tests/personal-state.test.ts
bun run --cwd packages/desktop smoke:personal:packaged
```

La prueba del core comprueba paginación, persistencia, módulo deshabilitado y rechazo de un binding de agente anterior. El smoke usa un modelo HTTP explícito de prueba, con Electron, llavero, SQLite y efectos del core reales: verifica ausencia de efectos antes de aprobar, creación de tarea/recordatorio y persistencia tras salir y reabrir. Captura la pantalla en tema claro/oscuro y ventana de 390 px.

Esta entrega no completa Hoy/agenda, notas, OAuth, proactividad ni automatizaciones; continúan como requisitos abiertos de la etapa 4.

Evidencia del paquete verificado: `docs/reports/unification/personal/report.json` y capturas en el mismo directorio. El modelo de prueba emite identificadores de llamadas distintos por solicitud y las esperas comprueban el estado persistido con polling asíncrono explícito.

La CLI instalada también consulta este mismo estado con `zhx personal tasks [offset] --json` y `zhx personal reminders --json`. El recorrido en `docs/reports/unification/personal-cli/report.json` comprueba que Node lee la tarea y el recordatorio aprobados en la app empaquetada, con el mismo identificador de agente.

## Notas personales

La pantalla Notes del shell unificado permite listar y buscar notas del agente activo, leer su contenido y solicitar guardado o borrado. Las listas son paginadas (20 notas); la búsqueda usa título y cuerpo. Listar todas ordena por creación descendente; la búsqueda conserva el orden del servicio existente. Se requiere habilitar Tasks and reminders en la configuración del agente.

El endpoint autenticado `notes` del coordinador es exclusivamente de lectura y anuncia la capacidad `application.notes`. Valida el proyecto seleccionado, parámetros, IDs y límites; nunca recibe acciones de escritura. El renderer usa un IPC acotado y recibe datos redactados por el host de desktop. El contenido se presenta como texto, no como HTML.

Guardar y borrar solicitan las herramientas existentes `daily_write_save_note` y `daily_write_delete_note` en la conversación actual. Ningún efecto ocurre hasta aprobar la revisión. Los IDs de solicitud conservan la deduplicación existente. Borrar una nota conserva el historial de conversación. No se ofrece edición en sitio: guardar crea una nueva nota.

El smoke `bun run --cwd packages/desktop smoke:personal:packaged` valida guardado y borrado con aprobación, ausencia de efectos antes de aprobar, búsqueda por contenido, texto con etiquetas sin ejecución y persistencia tras reinicio. Usa un modelo HTTP de fixture y stores/Electron reales. Las pruebas de `tests/personal-state.test.ts` verifican paginación, lectura por ID, aislamiento de agente, rechazo de parámetros inválidos, persistencia y nota eliminada. La CLI también lee estas notas mediante `personal notes`, `personal search-notes` y `personal note`; ver [CLI](CLI.md#notas-del-assistant-compartido).
