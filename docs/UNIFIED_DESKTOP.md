# Primer flujo Core / CLI / Electron

Estado: primer recorrido compartido implementado. Assistant y Code tienen arranque autónomo en Electron; ver [uso y proyectos](CODE_ELECTRON.md). Este documento describe el modo de conexión a un servicio externo.

## Qué funciona

- La CLI de Harness y la de Code consumen `connectApplication` del core para su modo servicio.
- `@zhivex-ai/harness/application/client` carga sólo el cliente Node y sus contratos; no inicia el motor ni importa SQLite o la implementación del host.
- `@zhivex-ai/harness/application` expone el host de aplicación y la proyección/recibos de revisión que antes pertenecían a desktop.
- Un host mantiene el estado autoritativo. Electron se conecta al mismo servicio que la terminal; no abre una segunda instancia del motor para esa conversación.
- El shell React implementa la dirección visual del HTML: navegación, conversación, diff/revisión, historial del run seleccionado, temas claro/oscuro, búsqueda de conversaciones y layout compacto.
- Iniciar una tarea en CLI, aprobar su edición en Electron, continuar desde Electron y consultar el resultado en CLI funciona con el mismo estado persistido.
- Borradores y tema sobreviven al reload. La app puede reconectar cuando se reinicia el host. Cerrar la ventana la oculta; salir de Electron no detiene el servicio externo.

Los endpoints de revisión de aplicación son opt-in del host. El endpoint genérico de comandos sigue rechazando aprobaciones positivas que requieren revisión explícita. La aplicación emite una proyección completa y un recibo acotado a cliente/generación de host; la decisión consume ese recibo antes de ejecutar. Revisión incompleta, caducada o desactualizada no autoriza el efecto.

## Preparar el checkout

Desde la raíz, con las dependencias del repositorio y desktop instaladas:

```sh
bun run build
bun pm pack --ignore-scripts --quiet --filename /tmp/zhx-unification-core.tgz
bun run --cwd packages/desktop prepare:harness /tmp/zhx-unification-core.tgz
bun run --cwd packages/desktop build
```

Esto instala explícitamente un candidato local con sus nuevos exports. Un paquete del registry con el mismo número de versión puede no contenerlos: el build desktop registra el hash del tarball utilizado. No se publicó una versión nueva.

Para desarrollar Code contra este core, existe `bun run dev:code`; respeta dependencias ya instaladas y avisa si no pudo enlazar el checkout. No asumir que un `bun install` desde el registry conserva el candidato local.

## Abrir una conversación compartida

En una terminal, iniciar el servicio con la configuración real de proveedor que ya utiliza el core:

```sh
bun run service --workspace /ruta/absoluta/al/repositorio --directory /tmp/zhx-shared
```

El servicio imprime un objeto `service-ready` con `credentialsPath`. Usar esa ruta en las otras dos terminales:

```sh
bun run --cwd packages/desktop start:unified --service-file /ruta/impresa/por/el/servicio.json
bun run start chat --service /ruta/impresa/por/el/servicio.json
```

También se puede iniciar con `run --json`, listar con `sessions list --json` e inspeccionar con `sessions inspect <id> --json`, siempre pasando `--service`.

La nueva ventana también acepta `--assistant-service-file` para conectar un host personal existente. En modo conexión sólo habilita áreas con una conexión suministrada. Sin esos flags abre el gestor autónomo de Assistant, con onboarding y selección de agentes; las pantallas avanzadas de integraciones siguen pendientes. Un host Assistant anterior sin canal de revisión de aplicación no soporta el nuevo panel de aprobación; sus integraciones conservan sus interfaces originales.

En modo conexión externa, el host debe permanecer ejecutándose. `Refresh` renegocia la conexión después de un reinicio y consulta el estado; nunca vuelve a enviar la última tarea. El comando `--recover` del servicio conserva la recuperación explícita de un propietario muerto. No hay daemon ni autoarranque al login en este corte.

## Validación reproducible

```sh
bun run architecture:check
bun run contract:check
bun run typecheck
bun run --cwd packages/desktop typecheck
bun run typecheck:code
bun test tests/application-host.test.ts tests/architecture.test.ts tests/local-service.test.ts tests/service-client-cli.test.ts tests/client-contract.test.ts packages/desktop/tests/review-tickets.test.ts packages/desktop/tests/approval-review.test.ts
bun run --cwd packages/desktop smoke:unified
```

El smoke usa el Playwright ya instalado para Assistant, un proceso Node real con el core instalado, una CLI compilada y Electron real. Sólo el modelo es una fixture offline: la edición revisada, SQLite, IPC, sockets, cancelación y recuperación son reales. No contacta proveedores ni servicios externos; trabaja en un repositorio temporal y devuelve su directorio de evidencia con capturas y `report.json`.

El [reporte del primer recorrido verificado](INTERNAL_ARCHIVE.md) incluye hashes de los artefactos. La [captura de revisión](INTERNAL_ARCHIVE.md) muestra la nueva interfaz conectada a una aprobación real del motor.

El chequeo de arquitectura ahora recorre también `packages/cli/src`. Ocho imports hacia fuentes internas fueron sustituidos por exports declarados de `code-support`, conservando su comportamiento. Los tests verifican límites motor → aplicación → UI y que el bundle del cliente no carga el host.

## Alcance pendiente

El [inventario](INTERNAL_ARCHIVE.md) conserva el resto del alcance: registro central de agentes/proyectos, bootstrap desde la app, traslado de módulos Assistant al core, revisión de acciones personales, paridad completa de CLI, integraciones nativas Tauri, migración de stores/keychain y distribución firmada. Las carpetas no se han movido todavía a `packages/core`, `packages/cli` y `packages/desktop`; primero se estabilizan estas fronteras funcionales.

Las fuentes Tauri históricas se localizaron en `612af25` y `eebddf0`, pero no se restauraron sobre este checkout. No se declara paridad con la aplicación Tauri instalada ni se retira la aplicación anterior.

## Cierre del servicio

Cerrar la ventana mantiene el host activo. La opción Quit muestra una confirmación nativa con el recuento disponible de tareas sin terminar y revisiones pendientes por área. **Keep running** es la opción predeterminada y Escape cancela la salida. Consultar este resumen no pausa admisiones ni resuelve decisiones.

**Stop service and quit** detiene el runtime propio de la app: cancela ejecuciones activas, conserva revisiones pendientes y conversaciones, y detiene sus recordatorios, automatizaciones e integraciones. Los clientes conectados a ese servicio pierden la conexión. El resumen es una fotografía informativa; puede cambiar mientras el usuario decide. Si no se puede consultar en tres segundos, el diálogo advierte que puede haber trabajo activo. Un host externo al que la app sólo se conectó no se detiene al salir.

La cancelación ordenada de Assistant pertenece al gestor del core; Electron aporta el diálogo y el cierre del proceso. La prueba `tests/application-shutdown.test.ts` verifica que inspeccionar no cambie una revisión ni bloquee nuevas conversaciones y que la revisión persista al reabrir. El smoke autónomo ejercita el handler real de salida con respuestas nativas simuladas, tanto cancelar como confirmar; comprueba cierre de ventana, disponibilidad posterior a cancelar y reapertura.

El [coordinador compartido](APPLICATION_COORDINATOR.md) permite que Electron descubra también un host completo iniciado por Node, conservando el ownership y el cierre del launcher correspondiente.

## Selección y navegación por workspace

El shell conserva la conversación seleccionada y la pantalla por `projectId` y área (Assistant/Code), junto con los borradores que ya se guardaban por proyecto y conversación. Cambiar de proyecto y volver recupera esa selección; el arranque sigue entrando por Assistant. Las preferencias tienen una versión y una lista de páginas admitidas; datos corruptos, futuros o páginas de otra área regresan a Workspace.

La lista de conversaciones del core valida la selección guardada antes de pedir su snapshot. Si ya no existe, se elige una conversación disponible o ninguna si la lista está vacía. Una preferencia local nunca crea conversaciones ni reemplaza la autoridad del core. Los callbacks conservan el proyecto de origen para que una respuesta tardía no cambie la navegación de otro workspace.

La persistencia usa el almacenamiento local del renderer con fallback en memoria existente. No sincroniza navegación entre instalaciones ni conserva todavía todos los formularios internos al desmontar una pantalla. El smoke de herramientas verifica volver de un segundo proyecto a la pantalla Execution, recuperar la conversación elegida y su borrador sin mezclarlo con Assistant; también comprueba el borrador personal tras reiniciar la app.

## Historial de decisiones por ejecución

Decision history permite elegir cualquier ejecución de la conversación seleccionada y recorrer sus decisiones paginadas. La selección muestra turno, fecha, modelo y estado; los datos se leen con `run.get` y `decisionOffset`, sin abrir stores ni resolver aprobaciones. Cambiar de conversación/proyecto desmonta el historial anterior y descarta respuestas tardías.

La pantalla distingue aprobación, rechazo, cambios aplicados, éxito, fallo y resultado no confirmado según la proyección del core. Muestra origen/canal de la decisión y código de salida cuando hay evidencia. Una aprobación no se presenta como ejecución exitosa. Carga, error y página vacía tienen estados distintos, con recarga explícita. El historial sigue acotado a una conversación: no agrega todavía una búsqueda global entre todos los agentes/proyectos.

El smoke personal del paquete selecciona una decisión anterior de creación de tarea después de reiniciar, cambia a un run sin decisiones y vuelve al anterior. Las pruebas de `approval-history`/`approval-diff` conservan la validación de resultados y evidencia; la paginación usa los offsets del contrato existente.

## Teclado en navegación compacta

Por debajo de 850 px, el panel lateral abierto tiene semántica de diálogo modal y nombre accesible. El contenido principal queda `inert`, el foco entra al botón Close navigation (o a Search conversations al usar Cmd/Ctrl+K), y Tab/Shift+Tab se mantienen dentro de los controles visibles del panel. Escape y Close navigation cierran el panel y devuelven el foco al control de origen. El fondo también permite cerrar con el puntero. El panel cerrado queda inactivo y oculto para evitar recorrer controles fuera de pantalla.

El smoke autónomo del paquete verifica apertura con Enter, foco inicial, ciclo de Tab en ambas direcciones, Escape, retorno al botón y al editor, Cmd+K en macOS y salida del modo compacto. Son pruebas de DOM/teclado reales en Electron; no reemplazan una certificación con VoiceOver ni completan la auditoría de todos los diálogos.
