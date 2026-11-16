# Today y agenda en Electron

> Las rutas históricas `reports/unification/…` citadas en este documento pertenecen al [archivo interno](INTERNAL_ARCHIVE.md); los originales se conservaron fuera del árbol publicable.

Assistant → **Agenda** lee el calendario del agente activo. Permite elegir fecha y zona IANA, volver a la fecha actual de esa zona y refrescar explícitamente. Muestra la zona y hora de lectura, eventos de día completo y horarios locales, cancelaciones y disponibilidad libre. Desde la pantalla se accede a tareas/recordatorios o a la configuración de Calendar.

La pantalla distingue cuatro estados: calendario no conectado, agenda completa vacía, resultado incompleto y error de lectura. Un error descarta el resultado mostrado y no se convierte en “sin eventos”. Un resultado incompleto advierte que los eventos faltantes no representan tiempo libre. Los títulos se renderizan como texto.

El endpoint `agenda` del core valida el agente seleccionado, la fecha y la zona, calcula los límites locales del día (incluidos cambios de horario), consulta hasta diez páginas de cien eventos, detecta ciclos de paginación y deduplica por ID. Si la fuente no termina correctamente la paginación devuelve `complete: false`. No modifica eventos ni calcula una garantía de disponibilidad.

Las lecturas externas no ocupan la cola de cambios del coordinador ni la cola de control del worker Electron. Cambiar de agente invalida una respuesta anterior; salir del coordinador cancela las lecturas pendientes. La operación tiene un límite de veinte segundos y pasa una señal de cancelación a la fuente. El renderer descarta respuestas de componentes desmontados. Actualizar la pantalla no repite ninguna escritura o aprobación.

## Validación

```sh
bun test tests/application-agenda.test.ts tests/application-coordinator.test.ts tests/coordinator-timeout.test.ts
bun run --cwd packages/desktop smoke:agenda:packaged
```

Las pruebas del core verifican un día de 23 horas, deduplicación, bucles de paginación, fuente caída, fecha inválida, aislamiento tras cambio de agente y cierre con una fuente que no responde. El smoke empaquetado autoriza Calendar con Google simulado y recorre agenda completa, incompleta, con error y vacía, además de temas claro/oscuro y ventana de 390 px. Core instalado, OAuth loopback, SQLite, IPC y Electron son reales; no se accede a una cuenta externa. Evidencia en `reports/unification/agenda/`.

La entrada **Today** es ahora un dashboard separado con agenda, decisiones pendientes, briefing, tareas y editor persistente. Su validación offline está en `reports/unification/today-web/`. Las integraciones live y la certificación de toda la propuesta permanecen abiertas.

## Resumen personal en Hoy

Today combina lecturas independientes de agenda, tareas y programación del briefing con las conversaciones pendientes del core. Muestra hasta tres tareas y permite desplegar hasta cinco recordatorios guardados con fecha, zona, canal y estado. Incluye entregas completadas e inciertas; no se presenta como una lista exhaustiva de vencimientos del día. La gestión y paginación permanecen en Tasks & reminders.

Refresh overview vuelve a leer las fuentes sin repetir escrituras. Los errores no se presentan como ceros; resultados tardíos se descartan al salir o cambiar de agente. El editor conserva el borrador al navegar y al recargar; el primer envío crea una conversación y abre su resultado. La paleta Cmd/Ctrl+K permite navegar a páginas y conversaciones del área activa.

`bun run --cwd packages/desktop smoke:today` verifica el dashboard y una tarea revisada con core instalado, SQLite, transporte y Electron reales; modelo, Google HTTP y SecretStore son fixtures. No accede al llavero ni a una cuenta externa.

## Cambios revisados de eventos existentes

Los eventos con horario ofrecen Edit event cuando hay una conversación seleccionada y no hay trabajo/revisión pendiente. El formulario permite solicitar título, inicio y fin. Los campos de edición muestran UTC explícitamente, aunque la agenda use otra zona. Cancel event edit descarta el formulario sin una llamada de escritura.

Ask to change event pide al agente preparar la propuesta con `calendar_read_propose` y solicitar `calendar_write_apply` con la referencia inmutable del core. La revisión confiable muestra antes/después, asistentes notificados y alcance. El core vuelve a leer el evento, comprueba ETag y autorización; sólo admite eventos no recurrentes organizados por la cuenta, con horario y datos completos. Notificar a los asistentes se solicita con `sendUpdates=all`, pero no se afirma entrega individual. Un resultado incierto se reconcilia por lectura, sin reenvío automático.

Este corte modifica eventos existentes. Crear/eliminar eventos, eventos de día completo y edición de recurrencias siguen pendientes; no hay controles que simulen esas capacidades. El resultado queda en la conversación y Refresh agenda vuelve a leer el calendario.

```sh
bun run --cwd packages/desktop smoke:agenda-edit:packaged
bun test tests/assistant/calendar.test.ts
```

El recorrido usa OAuth, stores, revisión y Electron reales con modelo y Google HTTP de fixture. Comprueba asistentes visibles, cero PATCH antes de aprobar y un único PATCH condicional seguido de lectura. No prueba una cuenta Google live ni envía notificaciones reales.

La proyección privada de revisión del calendario conserva las direcciones de los asistentes para autorizar su notificación. Sigue eliminando secretos conocidos y patrones de credenciales; si éstos alteran la revisión, la aprobación permanece bloqueada. El resto de las proyecciones conserva su política de redacción de correo.

La revisión de cambios incluye una presentación estructurada del antes/después, horas UTC y lista de asistentes que se notificará, obtenida exclusivamente de la propuesta guardada por el core. Los argumentos completos quedan disponibles en un detalle desplegable. La proyección no acepta operaciones despachadas, inciertas o terminadas como nuevas aprobaciones; el ticket vence como máximo al vencer la propuesta. El smoke comprueba las secciones y la distribución compacta, además del PATCH condicionado existente.

## Backend de creación durable

El servicio del core incluye `creation.propose/reference/reviewReference/apply/reconcile`. Guarda un diario separado `create_operations` en la misma base privada. La propuesta usa un requestId estable, campos acotados y un ID de evento derivado; reutilizar el requestId con otro contenido se rechaza. No hay POST al proponer. Aplicar requiere una referencia exacta, no caducada y del mismo binding. La operación se reclama antes de enviar; las respuestas perdidas, colisiones y estados inciertos sólo se reconcilian por GET, incluso después de reiniciar. Un evento sin el marcador propio o con campos/destinatarios distintos no confirma la operación. Las notificaciones se solicitan para todos los asistentes, sin afirmar su entrega.

El formato de ID y `sendUpdates` siguen [Events: insert de Google](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert). La exposición a herramientas y Electron requiere la capacidad explícita descrita abajo. No cambian las capacidades de perfiles existentes.

Las pruebas `tests/calendar-create.test.ts` cubren propuesta, repetición, digest, binding, caducidad, cancelación, denegación, respuestas perdidas, colisión, reinicio tras claim y concurrencia. `packages/desktop/scripts/smoke-calendar-create.mjs` valida un consumidor Node instalado con HTTP simulado; no crea eventos reales.

## Creación desde Electron con capacidad explícita

Al configurar Google Calendar para un agente nuevo, Enable reviewed event creation habilita las herramientas de creación y un perfil de calendario versión 2. Sin esa selección se conserva el perfil anterior y no se publican herramientas de creación. No se modifica silenciosamente la capacidad de perfiles existentes: para usarla se configura un agente con ese binding explícito.

En Hoy aparece New calendar event sólo cuando el host anuncia esa capacidad. El formulario solicita título, tiempos UTC y hasta 100 direcciones de asistentes. Su borrador y requestId se conservan por proyecto al navegar. El formulario prepara la propuesta mediante el canal privado del coordinador: los correos llegan al core sin pasar por el prompt del modelo. Al modelo se envía únicamente operationId y proposalDigest; la revisión obtiene los campos y destinatarios de la propuesta guardada. Preparar no crea nada en Google; `calendar_write_create` queda pendiente de una revisión estructurada del evento y destinatarios. El usuario puede rechazarla. Un resultado ya confirmado, despachado o incierto no ofrece una nueva aprobación de creación; la recuperación usa lectura y el mismo identificador.

Este flujo reemplaza el pendiente de herramientas/UI indicado en el corte anterior. Sigue limitado a eventos con horario y no recurrentes; no agrega eliminación ni edición de recurrencias. Las pruebas de UI y OAuth usan fixtures, no una cuenta real.

```sh
bun run --cwd packages/desktop smoke:agenda-create:packaged
bun test tests/calendar-create-tools.test.ts tests/calendar-create.test.ts
```

Evidencia del recorrido empaquetado: `reports/unification/calendar-create-tools/report.json`, con revisión normal/compacta, cero POST antes de aprobar, un POST después y repetición sin duplicado. Incluye regresión de edición y 30 pruebas focalizadas.
