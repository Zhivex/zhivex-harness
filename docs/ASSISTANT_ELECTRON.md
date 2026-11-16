# Assistant en el core y Electron autónomo

> Historical monorepo integration guide. Electron now belongs to [zhivex-app](https://github.com/Zhivex/zhivex-app); use its README for current installation, artifact preparation and build commands. The instructions below retain their original integration context.

Implementado el 2026-11-14. El destino probado es macOS Apple Silicon.

## Abrir la aplicación

Abrir `packages/desktop/out/Zhivex Harness-darwin-arm64/Zhivex Harness.app` desde Finder. No requiere iniciar un servicio, Node ni Bun desde la terminal. En desarrollo: `bun run --cwd packages/desktop start`.

Al abrir, Electron inicia un proceso propio con el gestor de Assistant del core. Si ya existe un perfil activo en `~/.zhx-app`, lo carga. En una instalación vacía muestra la configuración: nombre, proveedor, modelo y clave. El formato Chat Completions/Responses se elige para OpenAI o un endpoint personalizado. La conexión se valida con una generación real antes de guardarla. La opción HTTP sólo permite modelos locales conforme a la validación del core.

La pantalla Assistant settings permite crear y seleccionar perfiles. La primera conexión ofrece OpenAI, Qwen, Meta, Mistral y Groq sin pedir una URL; la URL se solicita sólo para un endpoint personalizado. También se pueden recuperar conexiones guardadas y habilitar tareas y recordatorios al crear el perfil.

Cerrar la ventana la oculta y mantiene el host. Quit cierra el host propio, cancela ejecuciones activas y libera sus recursos. Al reabrir se recuperan perfiles y conversaciones. Después de una caída del proceso, abrir Assistant settings y usar Retry startup; la recuperación del core sólo toma locks de procesos muertos.

## Estado y credenciales

Se conserva el directorio y el formato de datos de Assistant: `~/.zhx-app`, los identificadores de perfil, sus carpetas y bases SQLite. El adaptador usa el servicio de llavero `ai.zhivex.assistant` y la cuenta SHA-256 de la ruta canónica, igual que la aplicación anterior. No hay copia masiva ni fallback a secretos en texto plano. No se modificaron datos personales reales durante la implementación: las pruebas usaron directorios temporales y claves ficticias, eliminadas del llavero al terminar.

Dos gestores no pueden abrir simultáneamente el mismo directorio. Si la aplicación anterior sigue abierta, cerrarla antes de abrir la nueva; el core rechaza al segundo propietario. Los permisos que solicite el llavero pertenecen al sistema operativo.

Para pruebas aisladas se aceptan `--assistant-directory /ruta/privada` y `--user-data /ruta/electron`. El directorio Assistant debe ser privado del usuario. Los flags de conexión `--service-file` y `--assistant-service-file` conservan el modo cliente: no arrancan ni cierran un host propio.

## Fronteras de implementación

- `src/application/assistant`: host persistente, configuración, perfiles, proveedores, módulos, tareas, integraciones y automatizaciones. El gestor recibe una interfaz `SecretStore`; no importa Electron, React ni el llavero nativo.
- `src/engine/assistant`: exports públicos explícitos y experimentales, enumerados en `contracts/engine-api.json`.
- `tests/assistant`: regresiones de dominio trasladadas al core. Las interfaces web y Tauri fueron retiradas.
- `packages/desktop/src/unified/assistant-worker.ts`: ejecuta el gestor y el adaptador de llavero en un proceso de Electron. `managed-runtime.ts` controla solicitudes, errores y cierre. [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) provee el runtime Node incluido en la aplicación.
- El renderer sólo accede a una API IPC acotada; no recibe rutas de credenciales, tokens del socket ni acceso a Node. Las claves de configuración se envían de forma transitoria y el formulario las limpia.
- Las acciones de herramientas usan recibos de revisión emitidos por el core. Assistant habilita únicamente herramientas de su perfil; cuando una integración exige detalles resueltos, el recibo requiere esos detalles completos. Las revisiones incompletas o con contenido redactado no permiten aprobación positiva.

## Build reproducible

```sh
bun run build
bun pm pack --ignore-scripts --quiet --filename /tmp/zhx-assistant-core.tgz
bun run --cwd packages/desktop prepare:harness /tmp/zhx-assistant-core.tgz
bun run --cwd packages/desktop package
```

El build consume un tarball instalado del core y registra su hash. El paquete incluye el adaptador nativo de keychain fuera del archivo ASAR. No se publicó un paquete nuevo en el registry: un `bun install` común no sustituye la preparación del candidato local. Para verificar el dominio Assistant ejecutar `bun run build && bun run test:assistant`.

```sh
bun run test:assistant
bun run --cwd packages/desktop smoke:autonomous:packaged
bun run --cwd packages/desktop smoke:unified
```

El smoke autónomo utiliza un servidor de modelo de prueba; la aplicación, el core, SQLite, IPC y el llavero son reales. Elimina su entrada temporal del llavero. Prueba la app sin Node/Bun en PATH, onboarding, streaming, persistencia, cierre de ventana, Quit, reapertura y recuperación tras matar el worker.

## Alcance pendiente de la unificación

La nueva UI todavía no contiene todas las pantallas de agenda, OAuth, Telegram, automatizaciones ni administración avanzada de conexiones; sus módulos y datos sí están en el core. Code ya puede iniciar su propio host desde la app y restaurar proyectos; ver [Assistant y Code autónomos](CODE_ELECTRON.md). No se completó la unificación de todos los comandos CLI, el retiro de interfaces anteriores, firma/notarización ni actualización de distribución. Este hito entrega Assistant autónomo y conversacional en la app, no declara concluida toda la migración del plan.

Las [tareas y recordatorios](PERSONAL_ELECTRON.md) ya tienen pantalla propia sobre el store personal del core, con solicitudes revisadas desde la conversación.

La pantalla [Automations](AUTOMATIONS_ELECTRON.md) permite revisar la configuración del resumen diario y consultar su historial. Requiere una fuente y Telegram configurados. La [vinculación de Telegram](TELEGRAM_ELECTRON.md) ya está disponible para nuevos borradores; OAuth y la revinculación de agentes existentes continúan pendientes.

[Calendar OAuth](CALENDAR_ELECTRON.md) permite autorizar Google Calendar al crear un Assistant, con apertura del navegador del sistema, cancelación y actualización del resultado sin reabrir ajustes.

[Today & agenda](AGENDA_ELECTRON.md) consulta el calendario conectado por fecha y zona, con distinción entre resultado completo, incompleto y lectura fallida.
