# Worktrees, checkpoints y ejecución en Electron

> Las rutas históricas `reports/unification/…` citadas en este documento pertenecen al [archivo interno](INTERNAL_ARCHIVE.md); los originales se conservaron fuera del árbol publicable.

Implementado el 2026-11-14 en el shell unificado. Abrir un proyecto Code habilita tres pantallas en la navegación lateral.

## Worktrees

Crear un worktree desde el HEAD confirmado del proyecto, con título y una rama `feat/` opcional. Los cambios staged, unstaged e ignorados del checkout original no se copian. Open worktree abre su host Code y sus conversaciones; Back to source project regresa al origen. El estado del motor queda fuera del checkout gestionado para no ensuciarlo.

Para retirarlo, volver primero al proyecto origen, elegir Review removal, revisar rutas cambiadas, commits sin integrar y locks, y confirmar. La revisión expira y se consume una vez. El core vuelve a inspeccionar Git antes de retirar: si hay cambios, archivos ignorados, commits sin integrar, locks o identidad distinta, se bloquea. No usa `--force` ni elimina la rama. Los registros de creación interrumpida quedan visibles como needs-attention; no se reejecutan automáticamente.

La implementación de `packages/desktop/src/task-worktrees.ts` ahora es un adaptador hacia `src/application/code/worktrees.ts`. El gestor de proyectos controla los hosts y el registro; la UI sólo usa operaciones acotadas.

## Checkpoints

Después de completar una tarea, entrar en Checkpoints → Workspace checkpoints. Capture current files permite seleccionar el turno y rutas relativas, una por línea. Se capturan los bytes actuales de esos archivos: no versiones históricas del turno.

Prepare restore review muestra el diff exacto contra los archivos actuales. Confirm restoration requiere marcar la revisión y un recibo del host. Se conserva la conversación original y se abre una conversación derivada. Las operaciones guardadas permiten continuar tras un cierre o una respuesta incierta. Si se interrumpió la creación de la conversación derivada, el panel permite elegirla desde una lista y revisar su recuperación, sin escribir archivos nuevamente.

Límites existentes del core: hasta 20 archivos UTF-8 de 64 KiB, existentes, sin creación, eliminación, binarios ni rollback de permisos. Los conflictos, cambios posteriores o una proyección redactada/incompleta bloquean la restauración. Los comandos `restore.apply` y `restore.recoverFork` no se exponen al renderer por el canal genérico; la confirmación usa tickets ligados al cliente/host. Reconectar o cambiar de proyecto invalida los tickets de esa conexión.

La lógica compartida de recibos vive en `src/application/checkpoint-review.ts`; el panel anterior se reutiliza con la API del shell unificado inyectada explícitamente.

## Ejecución

Execution descubre los scripts permitidos por la configuración del core y muestra su contenido y argv. Ask Code to run envía una solicitud en la conversación actual; el agente debe proponer `run_check`, cuya ejecución queda pendiente de revisión. Se revisa el comando real propuesto y el motor vuelve a verificar el script antes de ejecutarlo. El modelo no sustituye la validación del core.

La salida, código de retorno, errores y estado quedan registrados en la conversación. Cancel execution solicita cancelación; la señal llega al proceso local y su árbol de hijos mediante el ejecutor portable del core. La extensión `Workspace.runCheck(..., signal?)` es opcional y compatible con los llamadores anteriores; se actualizó su snapshot de firmas públicas y las firmas transitivas que contienen Workspace.

Los checks locales requieren las herramientas del proyecto instaladas. Electron incluye su propio runtime para la app, pero no incluye todos los toolchains de cada repositorio. Al abrir desde Finder, el worker incorpora ubicaciones estándar de herramientas (`~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) además del PATH absoluto recibido. No carga un shell de login ni archivos de entorno para descubrirlas. El ejemplo validado usa Bun. Esta pantalla utiliza checks declarados; no agrega una terminal libre ni configuración visual de contenedores OCI.

## Validación

```sh
bun run --cwd packages/desktop smoke:code-tools:packaged
bun test tests/code-execution.test.ts tests/code-projects.test.ts tests/architecture.test.ts tests/application-host.test.ts packages/desktop/tests/task-worktrees.test.ts packages/desktop/tests/checkpoint-review.test.ts
```

El recorrido empaquetado usa un modelo HTTP de prueba; Git, archivos, SQLite, llavero, Electron, restauración y ejecución con Bun son reales. Comprueba la captura/restauración, bloqueo de restauración directa, ejecución sólo tras revisión, creación/apertura/retirada de worktree, preservación del origen y reapertura/recuperación de Assistant y Code. Las pruebas del core incluyen cambios concurrentes a la revisión, archivos ignorados, hooks/filtros hostiles, locks, creación interrumpida y cancelación efectiva del proceso.

## Entrega Git

La pantalla Git usa ahora los gestores compartidos del core para staging, revisión y commit local, push y pull request. Cada paso requiere su propia revisión; un commit no autoriza un push ni un PR. Los recibos y diarios persisten fuera del checkout y permiten consultar una operación incierta sin repetirla. Un run pendiente o activo bloquea las operaciones de entrega que modifican el repositorio.

Push y PR requieren un remoto HTTPS de GitHub y autenticación disponible para `gh` en el entorno del host. Su validación automatizada usa transportes simulados: no demuestra acceso a una cuenta real ni envía cambios externos. La prueba de commit usa un repositorio temporal con identidad de fixture.

```sh
bun run --cwd packages/desktop smoke:git:unified:packaged
bun test tests/code-delivery.test.ts packages/desktop/tests/git-delivery.test.ts packages/desktop/tests/remote-delivery.test.ts packages/desktop/tests/pr-delivery.test.ts packages/desktop/tests/github-git-transport.test.ts packages/desktop/tests/github-pr-transport.test.ts
```

La repetición sobre el paquete actual queda registrada en `docs/reports/unification/code-tools-final/report.json`, con capturas de worktrees, revisión de checkpoint y resultado de ejecución. Incluye arranque autónomo, reapertura, recuperación del worker y commit local; 19 pruebas focalizadas adicionales pasaron.

La revalidación del paquete actual está en `docs/reports/unification/code-tools-current/report.json`: 15 pruebas focalizadas y el recorrido autónomo empaquetado pasan. Execution permite recargar los checks; Execution y Worktrees distinguen carga de listas vacías. El recorrido vuelve a comprobar restauración revisada, ejecución real con Bun y creación/apertura/retirada del checkout, además de persistencia y recuperación del worker.

La CLI puede operar sobre los mismos checkpoints del host con `--area code` o `--service`, sin abrir stores adicionales. Ver [comandos y alcance](CLI.md#checkpoints-en-el-host-compartido) y `reports/unification/cli-checkpoints/report.json`. Las operaciones sobre checkpoint/restore IDs requieren `--session` explícito y la aplicación conserva la autoridad sobre archivos y revisiones.

La retención también está disponible desde la CLI compartida: `checkpoints storage`, `prune-review` y `prune-apply` con `--area code`. Opera en el scope del proyecto, exige un plan revisado y conserva archivos y conversaciones. Ver `reports/unification/cli-retention/report.json`; no se agregó una pantalla de retención nueva a Electron en este corte.

## Resultado visible en Execution

Execution muestra las decisiones de `run_check` del turno actual y su código de salida registrado por el core. Distingue rechazo, ausencia de evidencia, fallo y timeout; terminar la conversación no implica que el check haya pasado. Si hay más decisiones paginadas, remite a Decision history. La cancelación queda deshabilitada mientras la solicitud está pendiente.

Revalidación en `reports/unification/code-flow-results/report.json`: 18 pruebas, typecheck y empaquetado pasan. El recorrido empaquetado comprueba el resultado visible en Execution, checkpoints y worktrees, además del arranque sin servicio manual, persistencia y recuperación. El modelo HTTP es de prueba; Git, archivos y ejecución con Bun son reales.

## Contexto del proyecto

Context muestra el modelo configurado del host, si el contexto está habilitado, su fingerprint, el manifiesto y las reglas/archivos cargados con sus rutas, tamaños y digests. Lista las skills disponibles sin afirmar que hayan sido usadas. La proyección del core excluye cuerpos, descripciones de skills, configuración de credenciales y otros campos internos; filtra secretos conocidos y patrones de credenciales también en metadatos.

Refresh context vuelve a leer el bundle cargado, no recarga archivos del disco ni cambia permisos/modelos. Los turns anteriores conservan su modelo registrado. Cambiar archivos y reabrir el host genera la nueva identidad de contexto; esta pantalla no añade todavía adjuntos, recarga en caliente ni selector de modelos. Las peticiones están ligadas al projectId activo y se descartan resultados de componentes desmontados.

Evidencia: `reports/unification/code-context/report.json`, con 20 pruebas y recorrido completo de Code en Electron empaquetado.
