# Coordinador compartido de aplicación

> Las rutas históricas `reports/unification/…` citadas en este documento pertenecen al [archivo interno](INTERNAL_ARCHIVE.md); los originales se conservaron fuera del árbol publicable.

El core ofrece un coordinador por directorio de datos. Tanto el worker Electron como el launcher Node utilizan `acquireApplicationCoordinator`: primero descubren el endpoint existente y sólo intentan iniciar un gestor si no está disponible. El lease de `setup.sqlite` decide quién es propietario; el segundo launcher espera la publicación del endpoint y se conecta sin crear otro gestor.

El endpoint Unix `coordinator.sock` y su archivo `coordinator.json` son privados del usuario (0600 dentro del directorio 0700). Las solicitudes requieren un token, versión compatible y un método admitido. No aceptan Origin de navegador. El cliente Node recibe rutas privadas para conectarse a los runtimes; el preload sigue exponiendo sólo las operaciones acotadas de la aplicación. Esas rutas y el token no se entregan al renderer.

## Launcher Node

Después de compilar o instalar el core, se puede iniciar el servicio completo sin abrir Electron:

```sh
node dist/service-cli.js --application-directory "$HOME/.zhx-app"
```

Este launcher permanece en primer plano y emite un documento `application-ready` sin credenciales. SIGINT/SIGTERM cierran ordenadamente su host. Si ya hay un coordinador, informa `owned: false` y termina sin detenerlo. La conexión al llavero usa la misma identidad y hash del directorio canónico que Electron; no hay fallback a secretos en texto plano.

La CLI también ofrece `zhx application start` para arranque en segundo plano, `status` sin arranque y `stop --yes` para parada explícita. Run/resume/chat/policy/sessions pueden descubrir e iniciar el host con `--area` o `--application-directory`; otros comandos todavía no tienen paridad en ese modo. El launcher de proyecto anterior con `--workspace` y `--directory` se conserva por compatibilidad.

## Cliente de aplicación

```ts
import { connectCoordinator, connectApplication } from '@zhivex-ai/harness/application/client';

const coordinator = await connectCoordinator(directory);
const snapshot = await coordinator.state();
if (snapshot.credentialsPath) {
  const assistant = await connectApplication(snapshot.credentialsPath);
  const conversations = await assistant.command({ method: 'session.list' });
}
```

Configuración, selección de proyectos, worktrees y entrega Git pasan por una cola del coordinador. Las conversaciones, eventos y decisiones siguen usando el protocolo autenticado de cada runtime, por lo que lectura y cancelación no dependen de una cola de UI. El coordinador no convierte una aprobación en autorización para otras acciones.

No se reintentan automáticamente mutaciones tras perder una respuesta. Para commit/push/PR y restauraciones se consultan sus recibos y journals. La negociación incompatible falla explícitamente; no toma ownership del gestor vivo. Un launcher adjunto puede cerrarse sin apagar el servicio. Si Electron es propietario, conserva su confirmación de salida y cierra sus runtimes.

## Evidencia y límites pendientes

- `tests/application-coordinator.test.ts`: dos adquisiciones concurrentes, único gestor, estado/conversación compartidos, cierre adjunto sin efecto sobre el dueño, credenciales privadas, autenticación, versión incompatible y reinicio.
- `desktop` → `smoke:git:unified:packaged`: app empaquetada con runtime incluido como propietario; todas las herramientas Code, revisión de archivos, commit, cierre/reapertura y recuperación del worker.
- `desktop` → `smoke:coordinator:packaged`: el launcher Node del paquete instalado es propietario; Electron se conecta, opera Assistant y Code y sale sin cerrar Node. El modelo HTTP y las respuestas del selector/diálogo son fixtures; los procesos, sockets, llavero, SQLite, Git y checks son reales.

Quedan por completar la paridad de todos los comandos de la CLI, sus comandos de automatizaciones/OAuth, seguimiento de clientes para actualizaciones, descubrimiento/notificaciones de cambios de binding en todas las interfaces y validación de suspensión y cambios de identidad del propietario externo. La conversación intenta reconectar automáticamente tras fallar una lectura, con reintentos espaciados tres segundos y sin reenviar comandos ni borrar el estado incierto. También se puede recuperar explícitamente sin reabrir Electron: Assistant settings → Retry startup (o Retry en Code) vuelve a adquirir el coordinador si el propietario externo no está disponible. No reenvía mutaciones; descarta clientes anteriores para releer credenciales y actualiza quién debe cerrar el servicio. Una credencial anterior rechazada provoca un nuevo descubrimiento con lectura privada de credenciales. Si esas credenciales nuevas también son rechazadas o la versión es incompatible, no se toma ownership. Al salir, Electron espera la recuperación en curso antes de decidir qué servicio debe cerrar. El smoke `smoke:cli:coordinator` prueba dos procesos de CLI Node instalados iniciando el host concurrentemente y verifica el único propietario persistente. La carrera Node/Electron está probada con `smoke:launch-race:packaged`: lanzamiento concurrente con propietario Node y un segundo escenario con propietario Electron ya iniciado. Ambos comparten borrador/herramientas, conservan la identidad del endpoint en arranques repetidos y respetan el cierre del propietario. Evidencia: `reports/unification/launcher-race/report.json`. La reapertura de credenciales entre identidades se verifica separadamente con `--cross-owner-restart`; el primer intento tuvo un arranque tardío y no se considera certificado a partir de esa carrera. Estos pendientes impiden dar por cerrada toda la etapa 2.

La capacidad `application.management` habilita las operaciones compartidas de agentes, conexiones y proyectos. Los comandos `zhx agents`, `connections` y `projects` consumen esa capacidad y devuelven proyecciones sin credenciales.

`bun run --cwd packages/desktop smoke:coordinator-recovery:packaged` mata el proceso Node con SIGKILL, recupera ambas áreas desde la misma ventana y el mismo worker, verifica que no se duplicaron sesiones y que al salir se retiraron las credenciales del coordinador adquirido. Evidencia: `reports/unification/coordinator-recovery/report.json`.

`bun run --cwd packages/desktop smoke:coordinator-auto-recovery:packaged` repite la caída externa sin pulsar Retry ni Refresh. Comprueba las conversaciones de ambas áreas, el mismo worker y el cierre del servicio recuperado. Evidencia en `reports/unification/coordinator-auto-recovery/`; no certifica todavía suspensión, cambio de proyecto durante una desconexión ni decisiones con respuesta perdida.

### Límites de espera del coordinador

El saludo y la consulta de estado tienen un límite total de tres segundos; las demás operaciones del coordinador conservan su límite de 120 segundos. El límite total incluye respuestas que llegan por partes sin terminar. Un timeout se identifica como `LOCAL_SERVICE_TIMEOUT`, distinto de un endpoint ausente: no autoriza adquirir un gestor nuevo ni reintentar una mutación.

`tests/coordinator-timeout.test.ts` verifica un servidor que entrega bytes indefinidamente, el cierre de la solicitud, ausencia de reenvíos y rechazo de takeover durante descubrimiento lento. El recorrido empaquetado posterior con el core actualizado pasó en `reports/unification/coordinator-deadlines/report.json`. Esto no atribuye retrospectivamente una causa al timeout de la primera prueba de recuperación automática.

El test de carrera comprueba el hash del core dentro del paquete Electron frente al tarball instalado por Node. La primera ejecución del control ampliado falló durante la reapertura después de Electron; posteriormente se observó el mismo borrador en el coordinador tardío, sin atribuir una causa al llavero. La segunda ejecución falló por un error del test al usar require en el contexto de Playwright; se corrigió con process.getBuiltinModule y se limitó la limpieza de Electron a 15 segundos. Los logs se conservan separados de la evidencia de carrera aprobada.

El control separado de reapertura Node tras Electron volvió a fallar. Una muestra del proceso temporal localiza la espera en `keyring.darwin-arm64.node` → `SecKeychainFindGenericPassword` (ver `launcher-race/keychain-wait-stack.txt`). Esto identifica la dependencia nativa bloqueada, pero no prueba la causa de autorización ni permite afirmar que la identidad firmada final funcionará. No se cambiaron permisos de llavero. En ese corte quedó pendiente acotar esa espera y validar el acceso cruzado; el resultado posterior está en la sección de aislamiento de launchers.

### Lectura de credenciales bloqueada

El gestor del core limita a diez segundos la espera de lectura del SecretStore.
Si el adaptador nativo no responde, el coordinador publica un estado `locked`
con `SETUP_KEYCHAIN_UNAVAILABLE` y sigue atendiendo estado y cierre. No interpreta
el fallo como ausencia de perfiles: los listados de agentes/conexiones fallan y
las acciones de configuración permanecen bloqueadas. `application status --json`
incluye `assistantLocked` y `assistantError`; Electron explica el estado y ofrece
Retry startup.

Una lectura nativa que vence puede seguir pendiente. Mientras tanto, Retry devuelve
`SETUP_KEYCHAIN_BUSY`, sin añadir otra llamada nativa ni permitir escrituras. Su
resultado tardío se descarta; una lectura nueva requiere Retry explícito después
de que termine. No se cambian permisos del llavero ni se reemplazan datos guardados.
Este límite acota la espera del core, no certifica cancelación de la llamada nativa
ni que su thread deje de mantener vivo un proceso Node. Para SecretStore personalizados ese límite no cancela la operación subyacente.
Los launchers usan ahora el aislamiento por procesos descrito abajo; la identidad
firmada final continúa pendiente de certificación.

Las escrituras no reciben este timeout: una escritura de resultado incierto no
puede tratarse como un fallo sin efecto. `tests/application-secrets-timeout.test.ts`
usa lecturas deliberadamente pendientes para verificar el límite, bloqueo de
listados/escrituras, respuesta del coordinador y recuperación explícita.

### Aislamiento del llavero en los launchers

Los launchers de Node y Electron ahora usan `createProcessSecretStore`: cada lectura
o escritura corre en un proceso hijo, con el servicio fijo `ai.zhivex.assistant`
y la misma cuenta SHA-256 del directorio canónico. La solicitud y respuesta viajan
por pipes; las credenciales no se pasan en argv ni se imprimen en errores. El core
comparte el transporte y recibe el adaptador nativo desde cada entrypoint, sin
importar `@napi-rs/keyring` en la capa de aplicación reutilizable.

El padre concede ocho segundos, termina el hijo si vence el plazo y espera su
salida antes de resolver o permitir otra operación. El worker dispone además de
un watchdog de doce segundos para acotar su vida si el padre desaparece durante
una llamada nativa asíncrona. Electron usa su runtime incluido con un worker y
módulos nativos en `Resources/credential-runtime`, fuera del asar; no requiere
Node externo. La política/identidad de acceso del llavero no se modifica.

Si una escritura no confirma su resultado, devuelve
`SETUP_KEYCHAIN_WRITE_UNCONFIRMED`, bloquea el gestor y prohíbe nuevas escrituras.
Retry startup relee los bytes persistidos antes de habilitar la edición: no repite
la escritura anterior ni supone que no tuvo efecto. La UI oculta formularios de
edición mientras el perfil está bloqueado. El límite de diez segundos del gestor
sigue siendo una defensa para SecretStore personalizados; el adaptador de proceso
termina antes y no deja una operación nativa ejecutándose dentro del coordinador.

`tests/credential-process.test.ts` verifica terminación real, recolección antes del
reintento, transporte Unicode y escritura persistida cuya confirmación se pierde.
La evidencia empaquetada/Node y la reapertura cruzada están en
`reports/unification/credential-process/`. El recorrido cruzado que fallaba en el
corte anterior pasó con un perfil nuevo; esto no certifica firma/notarización ni
autorización con la identidad final de distribución.

### Espera durante admisión concurrente

Si un launcher encuentra un lease vivo mientras el propietario todavía publica
su endpoint, espera hasta treinta segundos. La ventana anterior de tres segundos
no alcanzaba para las lecturas de credenciales de ocho/diez segundos. Durante esa
espera sólo reintenta ausencia de archivo o endpoint; errores de autenticación,
negociación o timeout de un endpoint existente se propagan sin tomar ownership.
La espera no lanza otro propietario ni repite operaciones de configuración.

`tests/application-coordinator.test.ts` retiene al propietario durante 3,5 segundos
antes de permitirle publicar y comprueba una única lectura y propietario. La prueba
del watchdog en `tests/credential-process.test.ts` mantiene una petición sin resolver
y verifica que el worker se termina con SIGKILL a los doce segundos sin ayuda del
plazo del padre. Es una prueba del watchdog independiente; no inyecta la muerte real
del padre ni una escritura nativa pendiente.

## Contratos de proyección para renderer

`@zhivex-ai/harness/application/protocol` es un entrypoint experimental apto para navegador. Publica `APPLICATION_PROJECTION_VERSION` (1) y los tipos de agenda, automatizaciones, tareas/recordatorios, notas y contexto de Code. Sus declaraciones dependen únicamente de `application/contracts`, sin dependencias de implementación, Node, proveedores ni SQLite. La versión identifica estas proyecciones; no reemplaza la negociación del coordinador ni sus capacidades.

Los componentes unificados de Electron consumen esos tipos desde el protocolo. `application/client` conserva sus exports previos para consumidores Node, y las rutas anteriores de tipos siguen funcionando. Los DTO no sustituyen la validación de entradas y resultados que conserva cada endpoint del host. Revisiones, gestión de agentes, worktrees y otros tipos derivados del host aún requieren extracción; este corte no declara separada toda la superficie de aplicación.

```sh
bun run --cwd packages/desktop scripts/smoke-application-protocol.ts
bun test tests/architecture.test.ts
```

El smoke comprueba el bundle de navegador y las declaraciones del paquete instalado, además de cargar su export de versión en Node. No es una prueba de todas las superficies de UI ni de todas las combinaciones de versiones.

## Catálogo de aplicación y versiones

El cliente puede exigir capacidades antes de usar una API:

```ts
const coordinator = await connectCoordinator(directory, {
  versions: [1],
  requiredCapabilities: ['application.catalog'],
});
const catalog = await coordinator.catalog();
```

`application/protocol` es browser-safe: publica `APPLICATION_PROTOCOL_VERSION`, `APPLICATION_PROJECTION_VERSION`, `ApplicationHello`, `ApplicationError`, `AssistantSetupState`, `CodeProjectState` y `ApplicationCatalogSnapshot`, además de las proyecciones personales. Los campos de configuración no contienen claves. El catálogo incluye agentes, conexiones resumidas, proyectos y herramientas/fingerprints de runtimes activos; nunca rutas de credenciales ni cuerpos de memoria/instrucciones.

`generation` cambia al reiniciar el propietario. `revision` es un digest opaco del catálogo: comparar junto con generación, no ordenar ni tratar como autorización de escritura. El fingerprint describe el binding cargado; no concede permisos. El cursor de actividad conserva su contrato v1 y recuperación por snapshot.

`ApplicationCoordinatorError` conserva `message`/`code` y, cuando el host lo publica, `detail` v1 con recuperación `upgrade`, `refresh`, `reconcile` o `review-request`. Un host anterior puede omitir esos metadatos. No reintentar automáticamente mutaciones. El renderer obtiene el catálogo por un puente acotado; `state()` con rutas privadas queda reservado al cliente Node/main.

Aceptación del paquete instalado y del consumidor Electron: [fase 1](INTERNAL_ARCHIVE.md).

### Recuperación y aceptación de fase 2

La salida `run --json --service …` obtiene su resultado del comando durable incluso si el cursor de actividad vence durante la ejecución. Avanza al cursor de recuperación sin volver a enviar el comando. Los modos de transcripción mantienen el error explícito ante pérdida de eventos: se consulta la sesión guardada antes de decidir el siguiente paso. Electron reemplaza su proyección por el snapshot cuando `cursorExpired` está activo.

Las aprobaciones concurrentes consumen una sola vez el ticket del cliente. Una respuesta perdida no autoriza repetir el efecto: otro cliente puede consultar `run.get`, y reutilizar el ticket consumido falla. Al reiniciar el coordinador cambian generación y credenciales; Electron redescubre el servicio y mantiene la comprobación de identidad del proyecto antes de reutilizar la conversación.

Aceptación reproducible sin llavero: `bun run --cwd packages/desktop smoke:phase-two:race`, `bun run --cwd packages/desktop smoke:unified` y `bun run --cwd packages/desktop smoke:phase-two:recovery`. Estos fixtures usan stores temporales, modelos locales e inyección de secretos en memoria. No son una opción de almacenamiento de credenciales de producción. Ver [fase 2](INTERNAL_ARCHIVE.md).
