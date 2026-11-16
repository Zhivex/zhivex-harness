# Assistant y Code autónomos en Electron

Implementado el 2026-11-14 para macOS Apple Silicon. La app inicia los hosts necesarios; no requiere una terminal ni servicios iniciados manualmente.

## Uso

1. Abrir `packages/desktop/out/Zhivex Harness-darwin-arm64/Zhivex Harness.app` desde Finder.
2. Si todavía no hay una conexión, crearla en Assistant settings. Las credenciales permanecen en el llavero del sistema.
3. Entrar en Code, elegir la conexión y pulsar Choose project folder. El selector nativo permite elegir la raíz de un repositorio Git o de un worktree. Se aceptan repositorios sin commits; una carpeta común, un repositorio bare o una subcarpeta se rechazan sin inicializar Git ni cambiar archivos.
4. Crear una conversación. Las ediciones se revisan en Changes y se aplican sólo después de aprobarlas.
5. Alternar Assistant / Code desde la barra lateral. Code projects permite volver a proyectos anteriores.

Assistant y un proyecto Code permanecen activos simultáneamente. Cada proyecto tiene sus conversaciones y borradores. Cambiar de área no detiene una tarea. Cambiar de proyecto Code requiere terminar/cancelar sus ejecuciones y resolver revisiones pendientes; si no, se conserva el proyecto anterior. Cerrar la ventana mantiene ambos hosts. El icono de estado en la barra de menús permite mostrar u ocultar la ventana y salir; Mostrar recupera la ventana existente. Quit los cierra; al reabrir, se recuperan Assistant y el último proyecto Code. Si el proceso falla, Retry startup en Assistant settings o Retry Code startup en Code projects recuperan el runtime y sus datos.

Se reutilizan las conexiones guardadas de Assistant sin copiar claves al renderer ni a los proyectos. Una conexión seleccionada queda asociada al proyecto. Code projects permite aplicar otra conexión guardada al proyecto activo; exige finalizar tareas y resolver revisiones pendientes. El core conserva conversaciones y restaura el host anterior si falla el guardado.

## Core compartido

- `src/application/code/host.ts`: `startCodeHost` compone el motor y el host de aplicación con recuperación y revisión compartida. La CLI de servicio también utiliza esta función.
- `src/application/code/projects.ts`: registro de proyectos, rutas canónicas, conexión elegida, cambio de proyecto, persistencia y restauración. No depende de Electron o React.
- El gestor de aplicación conserva el registro no secreto en `~/.zhx-app/setup.sqlite`, bajo el mismo ownership exclusivo de Assistant. No admite dos gestores simultáneos sobre ese directorio.
- Las conversaciones Code usan el estado habitual del motor en `<proyecto>/.zhivex-harness`; los sockets privados viven en `~/.zhx-app/code`. El nombre del socket identifica workspace y scope; no se anidan directorios por proyecto para evitar el límite de rutas Unix en macOS.
- El runtime incluido en Electron ejecuta ambos hosts. El proceso principal abre el selector nativo y conecta los clientes. El renderer recibe una API acotada para abrir una carpeta seleccionada o un proyecto registrado; no recibe claves ni tokens de transporte.
- La conexión externa mediante `--service-file` / `--assistant-service-file` sigue disponible. En ese modo, Electron no inicia ni cierra servicios ajenos.

Una carpeta que desaparece o deja de ser un checkout Git produce un error de restauración sin crear silenciosamente otra ni borrar el registro anterior. La validación vive en el core y se repite al seleccionar o restaurar el proyecto. Un cambio fallido conserva el proyecto anterior. La recuperación sólo toma ownership cuando el proceso anterior murió.

## Build y validación

```sh
bun run build
bun pm pack --ignore-scripts --quiet --filename /tmp/zhx-code-core.tgz
bun run --cwd packages/desktop prepare:harness /tmp/zhx-code-core.tgz
bun run --cwd packages/desktop package
bun run --cwd packages/desktop smoke:code:packaged
```

El smoke utiliza un modelo HTTP de prueba y un directorio temporal; Electron, el core, el llavero, los sockets, SQLite y las ediciones de archivos son reales. El selector nativo se sustituye únicamente desde Playwright para escoger las carpetas temporales; la aplicación no incluye flags que simulen el proveedor ni el selector. Se verifica:

- Arranque sin servicio previo y sin Node/Bun en PATH.
- Rechazo de una carpeta sin Git desde el selector, sin registrar un proyecto ni desconectar Assistant.
- Assistant y Code disponibles simultáneamente.
- Edición pendiente sin efecto hasta la aprobación, y efecto real después.
- Rechazo del cambio de proyecto con revisión pendiente.
- Aislamiento entre dos proyectos y el perfil Assistant.
- Persistencia tras Quit/reapertura y caída forzada del worker.
- Estado de configuración sin claves, renderer aislado y compatibilidad del cliente CLI externo.

## Alcance

Este hito integra conversación, herramientas de archivos, revisión, proyectos y ciclo de vida autónomo. Ya están disponibles las [pantallas de worktrees, checkpoints y ejecución de checks](CODE_DESKTOP_TOOLS.md). La configuración visual de contenedores OCI, la entrega avanzada de cambios y las pantallas completas de integraciones siguen fuera de este corte. La CLI de servicio comparte el arranque, pero no se afirma todavía la consolidación de todos los comandos históricos en una única CLI.

## Fase 5: aceptación sin llavero

El [cierre de fase 5](INTERNAL_ARCHIVE.md) valida el recorrido completo actual con `bun run --cwd packages/desktop smoke:phase-five`: core instalado, Electron, archivos, Git y checks Bun reales, con modelo HTTP local y secretos en memoria. Incluye cambio de modelo, cancelación, caída de Electron y reinicio. Los smokes históricos empaquetados descritos arriba mantienen su alcance original y pueden requerir llavero.
