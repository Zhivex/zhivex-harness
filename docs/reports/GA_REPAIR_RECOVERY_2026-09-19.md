# Recuperación de reparaciones: diagnóstico de desarrollo

> Historical snapshot: findings and outcomes apply to the checkout and attempt
> recorded below. For the subsequent stable release outcome, see
> [current release evidence](../LIVE_CERTIFICATION.md#current-public-status).
> Later publication does not change failed evaluation results.

**Corrección implementada; aceptación live y GA todavía pendientes.**

El fingerprint `fe23962a75a1376aa486d886cd84986beba7daecf721dfdce7e3fc800f8ef82d`
de los fallos OpenAI del holdout RC14 corresponde exactamente a
`REPAIR_VERIFICATION_RETRIES_EXHAUSTED`. La evidencia histórica no contiene el
stdout del verificador: no permite atribuir el fallo de su aserción a una causa
concreta, ni concluir que esta corrección resolverá todas las entregas fallidas.

Una regresión independiente reprodujo un defecto del controlador: después de
fallar una verificación, cada comando diagnóstico con exit code distinto de cero
consumía otro reintento de verificación. Tres diagnósticos agotaban el límite aun
sin haber intentado verificar nuevamente. Las mutaciones fallidas también
consumían ese contador.

Ahora esos eventos mantienen la obligación de recuperación sin incrementar el
contador de verificaciones. Los intentos reales de verificación sí lo incrementan;
tres fallos reales siguen bloqueando el run. No se elimina la aprobación ni se
importa ningún candidato sin verificación exitosa. Los límites de pasos, tokens,
herramientas y comandos de recuperación siguen vigentes.

También se corrigió el evaluador SWE-bench para el nuevo aislamiento OCI:

- La captura del candidato y el preflight usan el scope del Harness.
- El padre conserva el directorio de estado hasta terminar la limpieza, incluso
  si el proceso del driver muere.
- La limpieza usa la identidad de ejecución en metadata validada, no el hash del
  run ID público. Las regresiones rechazan metadata de otro run o directorio.

Validación local: la regresión de diagnóstico falló antes del cambio y pasó
después. Las 38 pruebas enfocadas pasan; la suite completa pasó 529 tests, junto
a contratos, tipos, migraciones, evaluaciones, benchmarks y MCP. El gate completo
se detuvo en `docker start failed` durante el smoke OCI; queda pendiente repetir
esa frontera sin la carga concurrente de restauración/reproducción.

La reproducción live usa `django__django-15851` como **dato de desarrollo**, nunca
como holdout nuevo, con límites y modelos del manifiesto anterior. El primer
intento terminó antes de llamar al modelo porque la imagen histórica había sido
eliminada. Se reconstruyó desde los digests originales con el Dockerfile guardado.
El nuevo intento conserva hashes de fuentes y resultados en
`results/swebench/ga-recovery-development-2026-09-19-restored/` y terminó: OpenAI completó y entregó patch; Qwen retuvo un candidato sin
verificador y terminó `REPAIR_INCOMPLETE`. La [evidencia sanitizada](evidence/ga-recovery-development-2026-09-19.json)
preserva ambos resultados.
La presencia de un patch entregado no equivale a corrección oficial: este intento
diagnóstico no ejecuta el grader independiente.

Antes de GA todavía se requiere completar la validación de recuperación,
congelar el candidato, predeclarar una cohorte nueva y sus criterios, ejecutar
grading independiente y reunir la matriz representativa y los gates del release.


## Segundo ajuste y validación en curso

El caso Qwen confirmó que registrar un verificador antes de editar era sólo una
instrucción. El controlador OCI ahora rechaza mutaciones sin un verificador
concreto registrado mediante `repair_plan`, antes de ejecutar la herramienta.
Una regresión comprueba ausencia de escritura al rechazar y ejecución después
de registrar el plan. Esto no certifica que el comando propuesto sea suficiente:
la aprobación y la comprobación independiente siguen siendo necesarias.

Después de este ajuste pasaron 530 tests y tipos de tooling. El smoke OCI pasó
al repetirse sin la carga concurrente. La comparación de desarrollo con grading
oficial está ejecutándose secuencialmente para OpenAI y Qwen, una repetición del
caso y control mini-SWE-agent para cada proveedor, con límites originales y hashes
de fuente congelados por el runner. Resultados en
`results/swebench/ga-recovery-graded-{openai,qwen}/`. No se presenta como holdout
nuevo ni como una aprobación de GA; el resultado se detalla a continuación.


## Resultado oficial y corrección del presupuesto proyectado

La comparación anterior terminó sin samples faltantes ni fallos del grader.
Harness resolvió 0/1 con OpenAI y 0/1 con Qwen; mini-SWE-agent resolvió 1/1 con
cada proveedor. OpenAI se detuvo en `WORK_TOKEN_BUDGET` antes de editar; Qwen
terminó `REPAIR_INCOMPLETE`. [Evidencia completa sanitizada](evidence/ga-recovery-graded-development-2026-09-19.json).
No se excluyen estos intentos ni se presentan como validación exitosa.

Se reprodujo otra inconsistencia: el presupuesto calcula el consumo proyectado
de la siguiente llamada, pero el controlador de progreso entraba en cierre sólo
por consumo ya registrado. Por eso podía detenerse después de registrar un plan
con verificador, antes de poder usar la reserva para producir el candidato.

Ahora se calcula primero esa proyección y se activa el cierre focalizado cuando
el siguiente paso alcanza el umbral. Antes de tener candidato, la reserva sólo
se habilita si hay un verificador concreto registrado. El límite total no cambia;
se siguen bloqueando exploración global y llamadas que excederían el presupuesto
total. La regresión falla antes de la corrección y pasa después, incluyendo el
rechazo al superar el límite total. Las 31 pruebas del módulo pasan.

Está en curso una segunda comparación de desarrollo en
`results/swebench/ga-recovery-graded-v2-{openai,qwen}/`, con la misma tarea, límites,
modelos, control y grading oficial. Sigue pendiente demostrar entrega correcta
antes de congelar una cohorte nueva; GA permanece NO-GO.


## Segunda comparación y obligación de recuperación

La segunda comparación terminó: Harness 0/1 y control 1/1 en ambos proveedores.
OpenAI falló por `ProviderToolCallError` con `incomplete_arguments`; ese intento
no tiene accounting completo y no puede certificar presupuesto ni entrega.
Qwen terminó `REPAIR_INCOMPLETE` durante recuperación. El grading oficial pasó
sin errores y todos los intentos permanecen en el denominador.
[Evidencia sanitizada](evidence/ga-recovery-graded-v2-2026-09-19.json).

Otra regresión reprodujo que durante recuperación el controlador dejaba la
selección de herramienta en automático, aunque existía una obligación pendiente.
Ahora solicita una herramienta (`required`) cuando el proveedor/modo lo soporta;
los modos de Qwen con restricciones de thinking conservan su compatibilidad.
Una respuesta final sigue sin autorizar importación ni satisfacer la obligación.
La prueba falla antes y pasa después; las 32 pruebas enfocadas pasan.

La siguiente serie de desarrollo queda fijada antes de observar resultados:
`ga-recovery-v3-{openai,qwen}`, misma tarea y límites, tres repeticiones para cada
agente/proveedor (12 samples contando controles), grading oficial y conservación
de todos los fallos. No constituye holdout nuevo ni sustituye los gates de GA.


## Resultado de las tres repeticiones

La serie v3 terminó sus 12 samples, sin faltantes ni fallos del grader:

| Proveedor | Harness | Control mini-SWE-agent |
| --- | --- | --- |
| OpenAI | 1/3 entregas correctas | 3/3 |
| Qwen | 0/3 entregas correctas | 3/3 |

OpenAI tuvo un fallo de verificación y otro de argumentos incompletos con
accounting incompleto. Qwen tuvo dos reparaciones incompletas y un límite de
presupuesto de entrada. [Evidencia completa](evidence/ga-recovery-v3-2026-09-19.json).
Estos resultados mantienen NO-GO y no se usan como evidencia de una cohorte nueva.

Una regresión integrada adicional confirma que, con Qwen en Chat y thinking
apagado, `toolChoice: required` llega al modelo después de aprobación y fallo de
verificación. El diagnóstico de transporte terminó por INPUT_TOKEN_BUDGET con
accounting completo: las once primeras solicitudes no incluían tool choice y
la última sí llevaba `required`, con thinking apagado. Confirma su envío, no
que el servicio lo respete en el fallo anterior. El wrapper sólo leyó `max_tokens`;
Qwen usa `max_completion_tokens`, por lo que el valor nulo registrado no prueba
ausencia de límite. No se conservaron prompts, respuestas, argumentos ni claves
en esa traza.

El tarball local del commit `41bd1cb4ab8481a7413f096a0817f612fe9806fe` pasó instalado
por separado en Node 22.13.0 y Node 24.0.0 para macOS arm64.
[Evidencia de consumidores](evidence/ga-node-consumers-2026-09-19.json). Esto no
reemplaza Linux ni los checks remotos. La subida de la rama fue rechazada por la
revisión automática de permisos; el PR permanece local y su exportación espera
autorización explícita del operador.

## Diagnóstico del verificador para recuperación

Una regresión adicional reprodujo que el fallo de verificación devolvía sólo
exit code y timeout al agente. Ahora ambos verificadores compuestos conservan
stdout/stderr redactados y limitados a 2048 caracteres por canal, preservando el
principio y el final cuando se truncan. El contenido está marcado como salida no
confiable; no cambia aprobaciones, límites ni la prohibición de importar después
de un fallo. La redacción por patrones no elimina necesariamente datos de negocio
arbitrarios impresos por el comando aprobado.

La regresión falló antes y pasa después. Se actualizó la expectativa anterior de
omisión completa en el resultado interno: las pruebas ahora distinguen feedback
del agente, mensaje genérico de error y telemetría exportable. Estas dos últimas
superficies siguen omitiendo el diagnóstico. Pasan 533 tests, tipos de runtime y
tooling, contratos de preparación y las cinco comprobaciones de seguridad local.
La eficacia live de esta corrección todavía no se ha medido; los resultados v3
corresponden al runtime anterior y siguen conservados íntegros.

[Evidencia local del diagnóstico corregido](evidence/ga-verifier-feedback-2026-09-19.json)
incluye hashes de fuentes, suite, probes de seguridad e instalación del paquete.
La serie v4 usa la misma tarea de desarrollo, una repetición por proveedor y
agente, y conserva los límites y el grader de las series anteriores. Su arranque
inicial falló antes de llamar a los proveedores por credenciales no heredadas;
el arranque posterior carga el entorno local. No es una cohorte nueva.

## Resultado v4 y finalización sin candidato

La serie terminó sus cuatro samples con grading completo: Harness 0/1 y control
1/1 en ambos proveedores. OpenAI falló por `incomplete_arguments`, sin accounting
completo; Qwen terminó `completed` sin candidato ni verificación y el grader lo
marcó incorrecto. Ninguno alcanzó el fallo de verificador que esta serie pretendía
evaluar. [Evidencia íntegra sanitizada](evidence/ga-recovery-v4-2026-09-19.json).

Una regresión local reproduce la finalización después de registrar un plan con
verificador, antes de editar. La corrección exige una acción de herramienta en
modos compatibles y rechaza la finalización sin entrega: resultado y checkpoint
quedan `failed` con `REPAIR_INCOMPLETE`. No cambia presupuestos, aprobación ni
criterios de grading. Su eficacia live queda pendiente.

Un fixture SSE independiente reproduce otra limitación en OpenAI 0.13.2: el
adaptador rechaza `output_item.done` incompleto antes de consumir el evento
terminal que contiene el uso. `bun run scripts/validate-openai-stream-usage.ts`
sale con código 1: exige simultáneamente rechazar la llamada incompleta, no
emitir herramientas y conservar los contadores exactos del fixture. No usa red
ni credenciales reales. No demuestra que el intento live tuviera ese mismo
evento terminal, pero explica una ruta concreta hacia accounting incompleto.
La limitación permanece abierta; no se estiman tokens ni se habilitan reintentos
con consumo desconocido.

Validación posterior a la corrección de finalización: 534 tests sin fallos,
tipos de runtime/tooling, contratos de preparación, documentación e instalación
del paquete correctos. El probe separado de accounting sigue fallando y no está
contabilizado como aceptación aprobada ni oculto dentro de la suite verde.

## Serie v5 y propuesta para el SDK

La siguiente serie de desarrollo mantuvo tarea, límites y una repetición por
agente/proveedor. Terminó sus cuatro samples con grading completo:
OpenAI Harness 1/1 y control 1/1; Qwen Harness 0/1 y control 1/1. Qwen produjo
una edición, solicitó verificación y ejecutó un comando de diagnóstico, pero
terminó fallido sin patch importado. Ambos intentos Harness tuvieron accounting
completo. [Evidencia completa](evidence/ga-recovery-v5-2026-09-19.json).
Una sola entrega OpenAI en datos ya conocidos no acredita mejora general ni
sustituye el holdout nuevo. La retención de release sigue vigente.

El registry sigue publicando OpenAI 0.13.2. Se preparó un parche aislado del SDK
en `upstream-fixes/openai-terminal-usage/`, fuera del paquete distribuido del
Harness y sin modificar el checkout concurrente del SDK. Difiere el rechazo de
un item incompleto hasta poder leer uso terminal válido; nunca emite la llamada
incompleta. Once regresiones y el typecheck aislado pasan. El parche todavía
requiere contrato de error público tipado, checks completos del SDK, revisión,
publicación y consumo en el presupuesto del Harness. No corrige la dependencia
instalada ni constituye evidencia de release. El probe sobre 0.13.2 sigue rojo.

Actualización del parche SDK: el contrato Core ahora incluye `usage` opcional,
validado, copiado y congelado. Una copia aislada del commit base pasó 2078 tests,
tipos, build y documentación con Bun 1.4.2, además del smoke de consumidores
instalados. Se actualizaron únicamente la firma de `errors.d.ts`, tests, README
y changeset correspondientes. No se modificó el checkout concurrente del SDK.

El presupuesto del Harness consume ese campo sólo en un `ProviderToolCallError`
del proveedor correcto, conserva el error y evita contarlo dos veces después de
un finish. El consumo ausente, inválido o de un error no reconocido sigue siendo
desconocido. Pasan 543 tests y el paquete instalado. La integración con tarballs
locales del SDK corregido conservó 12 tokens de entrada y 8 de salida, sin ejecutar
herramientas y manteniendo el run fallido. Las identidades están en la evidencia
del parche. El adapter publicado sigue en 0.13.2 sin la corrección; falta integrar,
revisar y publicar el SDK, actualizar la dependencia y certificar el candidato.

## Continuación acotada ante finalización prematura

Una regresión independiente demuestra que el controlador puede recuperar una
finalización normal del modelo que todavía deja una reparación pendiente. La
aplicación solicita `read_task` una única vez a través de los gates ordinarios,
conserva el uso real de esa respuesta y vuelve a ofrecer al modelo la tarea
original. El contador se persiste y no se reinicia al reanudar. El recordatorio
no autoriza ediciones, no aumenta presupuestos y no extiende las dos solicitudes
de selección de verificador. Errores, cancelación, límite de salida o uso
desconocido no lo activan; se espera el cierre normal del stream para evitar
continuar después de un error tardío.

Las regresiones cubren continuación hasta una edición/verificación aprobada,
rechazo de una segunda finalización prematura, restauración del contador, uso
exacto y límites. Pasan 551 tests, tipos y contratos. La serie v6 ejecuta una
repetición Qwen y su control sobre la misma tarea de desarrollo, sin modificar
límites ni grader. Su resultado no constituye holdout nuevo.

La serie v6 terminó: Harness 0/1, control 1/1, grading completo y accounting
completo. Harness agotó WORK_TOKEN_BUDGET después de intentar editar sin plan;
la mutación no se ejecutó y el siguiente turno volvió a leer archivos. No hubo
candidato ni verificación, por lo que este intento no mide la eficacia del
recordatorio ante finalización prematura. Se conserva íntegro como fallo.
[Evidencia v6](evidence/ga-recovery-v6-2026-09-19.json) y
[regresiones del recordatorio](evidence/ga-completion-reminder-2026-09-19.json).
La próxima frontera es la transición desde REPAIR_PLAN_REQUIRED hacia un plan
válido, manteniendo presupuestos y la prohibición de editar sin verificador.

## Transición desde edición sin plan

La regresión falló antes y pasó después: rechazar una edición sin verificador
ahora persiste `planRequired`. Los dos siguientes intentos como máximo ofrecen
`repair_plan` y `read_task`; un guard de ejecución impide saltarse el catálogo
restringido. El límite persiste al reanudar y no abre la reserva de cierre ni
incrementa los presupuestos. Sólo un verificador válido retira la obligación;
la edición y su verificación mantienen sus aprobaciones normales.

Una prueba integrada reproduce rechazo, planificación, edición y verificación
aprobada hasta entrega. La serie v7 mide esta variante en la misma tarea Qwen de
desarrollo, con una repetición y control, manteniendo los límites y grader.

La serie v7 terminó con Harness 0/1 y control 1/1, sin faltantes ni fallos del
grader, y accounting completo. El Harness consumió 94.008 tokens de entrada en
13 llamadas y el siguiente preflight alcanzó INPUT_TOKEN_BUDGET. Registró un
plan en el turno 9; los tres siguientes intentos fueron rechazados por
REPAIR_PLAN_SCOPE y después hubo repetición de exploración. Los códigos se
identifican comparando el fingerprint con los mensajes constantes del runtime.
No hubo intento de edición: esta muestra no ejercita la transición nueva y no
permite atribuirle eficacia live. [Evidencia v7](evidence/ga-recovery-v7-2026-09-19.json).

La validación local de esta variante pasó 554 tests, tipos, contratos, docs y
paquete instalado. [Hashes y frontera de evidencia](evidence/ga-plan-transition-2026-09-19.json).
El parche SDK quedó además en la rama local `feat/ga-terminal-usage`, commit
`989ba33`, con historial normal desde el commit base y sin modificar el checkout
concurrente. Sus ocho archivos coinciden byte a byte con la copia validada.
No se hizo push ni publicación; continúa pendiente la autorización de exportación.

## Contexto persistente del alcance del plan

Una regresión independiente encontró que la proyección de trabajo del modelo
omitía las rutas que el controlador de progreso sí persistía y restringía. Tras
restaurar un estado con historial compactado, esa proyección no recuperaba los
archivos permitidos. Ahora obtiene directamente del controlador las rutas
normalizadas y los cupos restantes de lectura/comandos de cierre. Consultar esta
vista no activa cierre ni modifica los límites; las rutas fuera del plan siguen
rechazadas. La integración del Harness también verifica que las rutas llegan a
los siguientes turnos reales del modelo simulado.

Pasan 555 tests, tipos, contratos y paquete instalado. Se revisó y regeneró el
snapshot: cambiaron los hashes transitivos de `runHarness` y `HarnessRunOptions`
porque su diagnóstico referencia el tipo del controlador; los campos públicos
de estadísticas siguen iguales. La serie v8 mide una repetición Qwen y control
con el mismo presupuesto y grader. No se atribuye causalidad a la omisión para
los fallos live anteriores sin evidencia adicional.

La serie v8 terminó con Harness 0/1 por WORK_TOKEN_BUDGET y control 1/1.
Accounting y grading completos; no se descarta el fallo ni se acredita eficacia
live a partir de las regresiones. [Evidencia v8](evidence/ga-recovery-v8-2026-09-19.json)
y [validación local por hash](evidence/ga-working-context-2026-09-19.json).
El siguiente diagnóstico debe aislar el efecto del catálogo/contexto antes de
añadir reglas nuevas. Una variante diagnóstica no sustituirá el perfil del
producto ni se contará como aceptación GA.

## Diagnóstico del catálogo reducido

La variante aislada de cinco herramientas, predeclarada en
[el plan](evidence/ga-catalog-ablation-plan-2026-09-19.json), terminó con Harness
0/1 y control 1/1; grading y accounting completos. Harness consumió 41.620
tokens de entrada y 680 de salida en nueve llamadas. Tras compactar, solicitó
una herramienta no registrada y terminó con EXECUTION_FAILED. No se atribuye
causalidad a la compactación a partir de esta sola muestra.

Se conservan ambas muestras, el informe y la identidad de fuente en
[la evidencia](evidence/ga-catalog-ablation-2026-09-19.json). Frente al baseline
v8 sólo cambió el driver: catálogo e instrucciones renderizadas conjuntamente.
El shell ya disponible usa sus propios cupos; no son las mismas rutas ejecutadas
que las lecturas nativas. La variante no modifica el perfil del producto y no
cuenta como aceptación GA. Este resultado no justifica promover el catálogo
reducido ni demuestra que el tamaño del catálogo explique los fallos previos.

La inspección del SDK instalado y una regresión de transporte descartan una
pérdida determinística del catálogo o de las instrucciones de sistema en la
compactación ordinaria: cinco solicitudes conservan ambos elementos idénticos,
con más de una compactación intermedia. Pasan 13 tests de
`tests/sdk-compaction.test.ts` y tipos de tooling. Esta prueba usa un modelo
simulado y no explica por sí sola la elección live de una herramienta no
registrada; no se introdujo un cambio especulativo del runtime. La próxima
investigación necesita evidencia del catálogo efectivo en el límite del
proveedor, conservando la política de telemetría sin prompts ni secretos.

El driver ahora instrumenta el límite de entrada al adapter, por dentro de los
middlewares del controlador y presupuesto. `modelCatalog` conserva por llamada
los nombres locales ofrecidos y, para cada llamada devuelta, si fue ofrecida y
si pertenece al registro del driver. Los nombres externos se sustituyen por
`other-tool`; no se guardan argumentos, esquemas, mensajes ni errores crudos.
La evidencia se limita a 100 solicitudes y 64 llamadas devueltas por solicitud,
con contadores explícitos de omisiones. Una interrupción conserva
`completed: false` y no modifica el error ni los eventos.

Pasan 12 tests del driver y observador, y tipos de tooling. La prueba de orden
demuestra que observa el catálogo restringido por política, no sólo el inicial.
Esto mide el contrato neutral que recibe el adapter; no captura los bytes HTTP
ni prueba qué catálogo vio el servicio remoto. Las llamadas sintéticas del
controlador no llegan al adapter y no forman parte de esta medición. Todavía
no hay una nueva muestra live con esta instrumentación; no se atribuye una
causa al fallo anterior ni se declara mejoría de entrega.

La siguiente muestra, con catálogo completo y observación en el adapter, quedó
[predeclarada](evidence/ga-catalog-observed-plan-2026-09-19.json), pero **no se
inició**: la revisión automática de permisos rechazó el envío externo por no
constar autorización específica del contenido y destino. Se solicitó permiso
para el caso público, fragmentos del repositorio de evaluación e instrucciones
del Harness hacia Qwen internacional, con una ejecución por candidato y los
límites originales. No se reintentó por otra vía.
[Estado separado de la evidencia live](evidence/ga-catalog-observed-status-2026-09-19.json).
La validación local conjunta de observación, compactación y driver pasa 25 tests.

## Integración de la corrección publicada del SDK

Tras la confirmación del operador, la consulta pública con `bun info` verifica
Core 1.22.0, OpenAI 0.13.3 y Qwen 0.14.3. El Harness fija ahora esas versiones
en package.json y bun.lock, incluido el override de Core. Agents 1.8.0,
Gemini 0.12.1 y Meta 0.2.6 siguen siendo las versiones consultadas. Se actualizó
la documentación del lote y su comprobación exacta; los relatos anteriores
sobre OpenAI 0.13.2 se conservan como evidencia histórica.

El probe `validate-openai-stream-usage.ts` pasa con el paquete publicado:
error incomplete_arguments, cero llamadas de herramienta emitidas y uso
12/8 conservado. No usa red de proveedores. Pasan 559 tests, tipos de runtime
y tooling, build y smoke del tarball instalado. El primer intento de smoke
falló por EPERM del directorio temporal; la repetición con permisos terminó
correctamente. Esto cierra la dependencia del parche local para esta aceptación,
no acredita por sí solo provenance del SDK ni una nueva certificación live.

La autorización pendiente de Qwen y la de push del Harness siguen siendo
fronteras independientes. La confirmación de publicación del SDK no se tomó
como autorización de esas operaciones. GA permanece NO-GO por los pendientes
de entrega fiable y certificación final.

La aceptación integrada también pasa con `runHarness` del workspace y el
adapter del registry: el run falla sin ejecutar herramientas y contabiliza
12 tokens de entrada y 8 de salida, con usageComplete=true. Se incorporó
como regresión automática en `tests/model-budget-error-usage.test.ts`; sus
10 casos y tipos de tooling pasan. La prueba inyecta SSE local, sin llamadas
a proveedores. [Versiones, hashes y límites](evidence/ga-published-sdk-2026-09-19.json).

## Prueba Qwen autorizada con dependencias publicadas

Tras autorización explícita, la muestra con catálogo completo terminó con
Harness 0/1 y mini-SWE-agent 1/1, grading y accounting completos. Harness
consumió 64.624 tokens de entrada y 915 de salida en nueve llamadas; el control
20.189 y 597 en ocho. El Harness terminó por WORK_TOKEN_BUDGET, sin candidato
ni verificación. Las nueve solicitudes conservaron las 13 herramientas y un
mensaje de sistema; todas las llamadas devueltas estaban ofrecidas y registradas.
No hubo omisiones de observación. Esta muestra no reproduce el fallo previo
de herramienta desconocida y no demuestra la causa de ese fallo histórico.

Se conserva la [evidencia completa saneada](evidence/ga-catalog-observed-2026-09-19.json).
El cambio conjunto de dependencias y observación impide atribuir diferencias a
una sola variable. Es una tarea conocida de desarrollo, no holdout ni aceptación
GA. Los límites y el grader no cambiaron. La autorización de la prueba Qwen no
se extiende al push ni a publicación del Harness.

El fingerprint del último error coincide exactamente con el mensaje constante
REPAIR_PLAN_REQUIRED: el modelo intentó una edición sin registrar antes el
verificador. La edición se rechazó y el siguiente turno quedó bloqueado por
el presupuesto de trabajo. La frontera a investigar es la planificación
tardía y la reserva de recuperación; esta evidencia no justifica retirar la
precondición de verificación ni ampliar los límites para obtener un aprobado.

## Reserva para recuperar una edición rechazada sin plan

La transición observada se reprodujo sin red: tras rechazar una edición sin
verificador, el controlador ofrecía sólo repair_plan/read_task, pero el budget
no consideraba esa obligación como cierre. Con el 70% ya consumido, la llamada
fallaba antes de poder registrar el plan. La nueva regresión falló antes del
arreglo y pasa después, también restaurando el estado.

La obligación planRequired habilita ahora la reserva existente para los dos
intentos restringidos de planificación. Se mantiene la prohibición de ejecutar
la edición, el límite durable de intentos y el techo total de tokens; una
segunda prueba confirma rechazo al alcanzar ese techo. El fingerprint de
política pasa a repair-v3-reserved-plan-recovery para distinguir los checkpoints
del contrato anterior. No se incrementaron los límites del benchmark.

Pasan 562 tests tras la corrección de reserva, además de tipos. Esta aceptación
es determinística: todavía no demuestra una mejora de entrega live.

La repetición Qwen con la corrección terminó: Harness 0/1 y control 1/1,
grading y accounting completos. Harness consumió 22.916 tokens de entrada y
949 de salida en cinco llamadas. Intentó editar sin plan en el tercer turno;
los dos turnos de selección explícita ofrecieron repair_plan/read_task pero
no devolvieron llamadas desde el adapter. El read_task observado en el cuarto
turno es el recordatorio sintético del controlador, no una llamada de Qwen.
No hubo candidato ni verificación. El fallo ocurrió antes de alcanzar la
reserva, por lo que esta muestra no evalúa su eficacia live.
[Evidencia íntegra saneada](evidence/ga-plan-reserve-2026-09-19.json).

Una nueva prueba sin red verifica el cuerpo Chat serializado por Qwen 0.14.3
con el controlador real: tool_choice selecciona explícitamente repair_plan,
enable_thinking=false y el catálogo contiene sólo repair_plan/read_task.
Pasan la prueba y tipos de tooling. Esta comprobación verifica serialización
local; no acredita los bytes de la solicitud live histórica ni identifica la
causa de la ausencia de llamadas en la respuesta remota. No se relajó la
verificación ni se aumentaron intentos o presupuestos.

## Pérdida de llamadas Qwen al finalizar con stop

Un diagnóstico live mínimo con fixture sintético aisló una diferencia entre
servicio y adapter. Con selección explícita repair_plan, el servicio devolvió
25 fragmentos tool_calls y finish_reason=stop; Qwen 0.14.3 emitió cero llamadas.
Con selección required devolvió 24 fragmentos y finish_reason=tool_calls, y el
adapter sí emitió repair_plan. Ninguna herramienta se ejecutó.
[Evidencia saneada](evidence/ga-qwen-tool-choice-2026-09-19.json).

La inspección del adapter confirma que sólo vacía los buffers cuando el motivo
es tool_calls. `bun run scripts/validate-qwen-terminal-tool-call.ts` reproduce
sin red la pérdida con JSON completo y final stop: exit 1, cero llamadas, uso
12/8 conservado. Este defecto es del adapter; aún falta corregirlo y validar
que length, streams truncados y argumentos inválidos nunca habiliten ejecución.
No se infieren los bytes de las respuestas del benchmark a partir del fixture.

La corrección está preparada en la rama local SDK
`feat/qwen-terminal-tool-calls`, sobre el commit posterior al release
identificado en [la PR del SDK](https://github.com/Zhivex/zhivex-ai-sdk/pull/103).
Pasan 209 tests Qwen, 2.424 tests SDK, tipos, docs y build. El adapter compilado
pasa el mismo fixture que falla en Qwen 0.14.3: una llamada emitida, finish
normalizado tool-calls y uso 12/8. El parche valida el lote completo antes de
emitir efectos; casos truncados o inválidos se rechazan. Incluye changeset y
el mínimo Core 1.22.0. No está publicado ni instalado en el Harness; no se
hizo push. La prueba del build local no acredita aún el paquete publicado.

La corrección Qwen quedó en el commit local SDK `35e2bb4`. Pasó el smoke de
consumidores instalados (51 entrypoints y golden path determinístico con Bun
1.4.2). El diagnóstico live sintético con el adapter compilado recupera ahora
repair_plan tanto con selección explícita y final stop como con required y
final tool_calls, conservando uso.
[Evidencia posterior](evidence/ga-qwen-tool-choice-patched-2026-09-19.json).
No ejecutó herramientas ni evaluó una reparación; falta integrar el paquete
publicado y repetir la aceptación del Harness. No se hizo push ni publicación.

## Reparación completa con tarball Qwen corregido

Una copia aislada del Harness instaló el tarball local construido del commit
SDK 35e2bb4, conservando el catálogo, política, tarea, límites y grader. Los
hashes de fuente congelados sólo difieren del baseline en package.json y
bun.lock; el hash SHA-256 del tarball queda ligado al plan y resultado.

Resultado: **Harness 1/1 y control 1/1**, grading y accounting completos.
Harness registró plan, verificó e importó el parche y pasó el evaluador
independiente, con 71.480 tokens de entrada y 1.252 de salida. El control
consumió 19.344 y 545. Se preservan todas las muestras y fallos anteriores.
[Evidencia](evidence/ga-qwen-patched-package-2026-09-19.json).

Es una sola tarea conocida de desarrollo y un paquete local con el mismo
número de versión que el publicado, distinguido por hash; no constituye
certificación del registry, holdout ni prueba estadística de fiabilidad.
El Harness principal sigue fijando Qwen 0.14.3 publicado. El siguiente gate
es revisar/publicar la corrección SDK, integrarla por versión y verificar la
cohorte representativa y holdout con el candidato final. No se hizo push ni
se promovió el ledger a GA.

La revisión final añadió una regresión de error explícito tardío del proveedor:
el lote ya completo no debe emitirse si después llega ese error. Falló antes y
pasó después. El commit local SDK `c850ae0` lo rechaza conservando uso reportado
sin propagar detalles crudos. Pasan 2.425 tests, tipos, docs, build y aceptación
offline del adapter compilado. La evidencia live y de consumidores anterior
sigue vinculada a `35e2bb4`; no se atribuye al nuevo commit. El parche y el
texto de PR quedaron actualizados; no se hizo push.

El smoke de consumidores instalados se repitió y pasó sobre el commit final
SDK c850ae0 (51 entrypoints, Bun 1.4.2). La evidencia live sigue ligada al
commit anterior. Se solicitó autorización específica para subir la rama SDK
y abrir un PR; sigue pendiente. No hay publicación del parche Qwen ni se
puede certificar el candidato final del Harness contra esa versión publicada.

Por autorización explícita del operador, se ejecutó version-packages: Qwen
0.14.4 y changelog preparados, Core/SDK sin bump. Se incorporó main, resolviendo
sólo un comentario del gate de rangos, y pasaron de nuevo 2.425 tests, tipos,
docs, build y consumidores instalados (51 entrypoints). La rama se subió y
la [PR #103](https://github.com/Zhivex/zhivex-ai-sdk/pull/103) quedó abierta
sin draft, head e4cc9eb3e8218b604f58eccc3a8830f24e9fa71b. CI y CodeQL estaban
en curso al comprobarla. No se hizo merge ni publicación.

## Integración del Qwen publicado y nueva muestra

La PR #103 fue mergeada externamente. CI, CodeQL y consumidores Node pasaron;
provider conformance provenance quedó skipped. El release
[35477096556](https://github.com/Zhivex/zhivex-ai-sdk/actions/runs/35477096556)
terminó success y el registry publica Qwen 0.14.4. El Harness ahora fija esa
versión, incluida la documentación y el gate del lote. La aceptación offline
de terminal-stop pasa contra el paquete instalado. Pasan 563 tests, tipos,
docs, contrato de preparación y smoke del paquete Harness instalado.

La nueva comparación live produjo **Harness 0/1 y control 1/1**, con grading y
accounting completos. Harness terminó completed tras cinco llamadas, sin plan,
candidato, verificación ni importación; el grader rechazó la entrega. Consumió
32.073 tokens de entrada y 281 de salida. El control resolvió con 26.718 y 820.
[Evidencia publicada](evidence/ga-qwen-published-2026-09-19.json).

Se conserva el éxito anterior con tarball local, sin sustituir este fallo.
El defecto del adapter está corregido, pero queda una frontera del Harness:
la obligación actual sólo nace al registrar un plan o intentar/realizar una
edición; una finalización temprana desde exploración puede quedar completed
sin entregar una reparación. Se requiere un contrato explícito de entrega
para tareas que la exijan, preservando usos legítimos de inspección sin edición.
No se declara GA ni se atribuye causalidad de la variación a las dependencias.

## Contrato explícito de entrega verificada

Se añadió requireVerifiedDelivery, false por defecto y válido sólo con perfil
repair. Al activarlo, la obligación nace antes del primer plan o edición; una
finalización desde exploración no puede quedar completed sin entrega verificada.
Persiste en el controlador y se liga al fingerprint del run. No abre por sí sola
la reserva ni añade aprobaciones, intentos o presupuesto. El recordatorio único
y la obligación de verificación existentes se mantienen. El driver SWE-bench
lo activa porque su contrato exige reparación e importación. Inspección sin
edición sigue disponible dejando false.

La regresión falló antes y pasa después: salida y checkpoint quedan failed
cuando el modelo finaliza sin reparar, incluso conservando la obligación al
restaurar con opciones por defecto. Pasan 566 tests de la suite y una prueba
adicional de validación/fingerprint; las cuatro pruebas focales, tipos, docs,
contratos y paquete instalado pasan. Se regeneró el snapshot de firmas por la
nueva opción pública y sus tipos transitivos.
[Evidencia por hash](evidence/ga-required-delivery-2026-09-19.json).
Esto elimina un falso completed; todavía no demuestra mayor resolución live.

La comparación con entrega requerida terminó con **Harness 0/1 y control
1/1**, grading y accounting completos. Harness quedó failed por
INPUT_TOKEN_BUDGET tras 96.896 tokens de entrada y 1.330 de salida en trece
llamadas facturadas. Registró un plan, intentó editar y verificar, pero la
verificación produjo error y la recuperación no terminó. Dos lecturas fueron
rechazadas por REPAIR_PLAN_SCOPE y una nueva edición por REPAIR_PLAN_REQUIRED.
El control resolvió con 16.988 tokens de entrada y 544 de salida.
[Evidencia íntegra saneada](evidence/ga-required-delivery-live-2026-09-19.json).

Esta muestra no terminó con respuesta final desde exploración: no prueba
causalmente la eficacia del nuevo gate, aunque conserva correctamente el fallo.
La regresión determinística sigue siendo la evidencia del cierre del falso
completed. El error inicial de verificación sólo tiene un fingerprint genérico
en esta telemetría; no se atribuye su causa sin evidencia adicional. El siguiente
diagnóstico debe separar fallo del comando, rechazo por deriva del parche y
error de importación para enfocar la recuperación, sin publicar logs crudos.

### Offline verifier diagnosis and feedback regression

The required-delivery development run failed its verifier with exit code 1. The fixed `TerminalVerificationFailure` message hashes exactly to `d22955ecb1810cd7e960e732636eec570e04ab3b19eab276ebf23e2096a3c941`. Inspection of the full turn 9 also confirms existing structured evidence: exit 1, no timeout, failed verification, and 436 output characters. A later null-output projection does not establish missing model feedback. The underlying reason for verifier failure remains unknown; this is not evidence of a defective repair versus a defective verifier or environment.

Telemetry now recognizes only the exact fixed failure template and emits a bounded numeric exit code even for message-only serialized exceptions. It exports no raw message or verifier output. A regression checks strict and repair recovery at the next model request boundary, in addition to persisted state: bounded verifier diagnostics reach the model while external telemetry omits their content. All 18 focused tests and runtime/tooling typechecks passed. No new provider call, benchmark rerun, or change to prior failed samples was made. Evidence: `docs/reports/evidence/ga-verifier-failure-identification-2026-09-19.json`. GA remains unproven.

### Validation follow-up and one bounded diagnostic pair

The complete local suite passed 568 tests across 68 files before the verifier-output marker projection was added. After that telemetry-only change, 19 focused tests and the tooling typecheck passed. Documentation, preparation contract and five local security probes passed. The contract still reports one open GA blocker. Source hashes and check boundaries are retained in `evidence/ga-local-validation-followup-2026-09-19.json`.

The predeclared `ga-verifier-hints` pair is complete: Harness 0/1 versus control 1/1, with complete usage and grading. Harness used 94,600 input / 1,580 output tokens and stopped at INPUT_TOKEN_BUDGET. Its verifier returned exit 1 without a timeout at turn 13; no allowed Python exception marker was observed. The control used 27,051 input / 673 output tokens. No repair, prompt, model or budget setting was changed for this run. There was no repeat after completion.

This result does not identify the cause of verifier failure. The model had already spent turns on a missing path, a tool-input schema error and two plan-scope rejections before the edit. These are observed costs, not proof of the verifier's cause. A further diagnosis needs the exact approved verifier and bounded local failure details at the execution boundary; widening exception-label guesses or repeating the same pair would be insufficient. The temporary run state was intentionally cleaned by the runner, so the previous raw failure output cannot be recovered from retained samples. Evidence: `evidence/ga-verifier-hints-plan-2026-09-19.json` and `evidence/ga-verifier-hints-live-2026-09-19.json`. This remains development evidence and does not satisfy representative or fresh-holdout acceptance.

### Private execution diagnosis: unavailable runner and incorrect candidate scope

A single predeclared Harness-only diagnostic retained at most three verifier failure records in a private local temporary directory. The driver used the same Qwen model and limits; no control or acceptance evaluation was claimed. It stopped at INPUT_TOKEN_BUDGET (92,923 input / 1,028 output tokens). The captured approved verifier used `python -m pytest`; Python reported that pytest was not installed. This directly establishes the verifier infrastructure failure for this diagnostic, not every previous sample. The benchmark prompt had recommended pytest without checking availability. That recommendation is now replaced by discovering the project runner and available dependencies, or using a self-contained assertion; no dependencies or budget limits were changed.

Retained environment metadata also reproduced a candidate-capture defect: the actual run was unscoped, but the final diagnostic capture acquired config.scope and therefore inspected a different, empty snapshot. Candidate capture now uses the actual state.runId and state.scope. A real filesystem/OCI-session regression demonstrates that the configuration scope is empty while the run scope contains its edit. Historical candidatePresent=false values therefore cannot prove absence of a candidate. Imported host patches and official task failures remain unchanged.

The private observer preserves approval metadata, original error identity and normal execution even if its callback throws. Its callback is disabled by default and does not add raw records to exported benchmark results. Thirteen focused tests and the tooling typecheck pass. Evidence: `evidence/ga-private-verifier-plan-2026-09-19.json` and `evidence/ga-private-verifier-root-cause-2026-09-19.json`. The retained private snapshot now permits offline candidate diagnosis without another model request. No live effectiveness claim is made for either correction.

### Retained candidate passes official grading without another model call

The corrected scope-aware capture recovered one updated file, `django/db/backends/postgresql/client.py`, from the prior private diagnostic. Capture validated the retained execution binding and content digests. The existing candidate exporter reconstructed the diff in a separate disposable checkout and verified its base digests; no protected files changed. The pinned official evaluator completed with `resolved: true` for patch SHA-256 `15989da845ac1f766848c5c2e153296d7eef926a752ec658548702ac0e028bc7`. No model request or provider credential was involved in this grading.

This distinguishes a correct retained repair from unsuccessful delivery: the original verifier required unavailable pytest, import did not succeed, and the original run remains failed at its input budget. It does not demonstrate that the corrected prompt now completes the entire live flow. Historical failed samples remain unchanged. The current complete local suite passes 571 tests across 70 files. Evidence: `evidence/ga-retained-candidate-grading-2026-09-19.json`. The next live check should test the corrected verifier-discovery instruction and successful verified import under the unchanged limits; GA representative and fresh-holdout gates remain open.

### Verifier-discovery instruction: complete matched pair, delivery still fails

The single predeclared `ga-verifier-discovery` pair completed with full grading and usage: Harness delivered 0/1 and control delivered 1/1. Harness consumed 95,888 input / 1,241 output tokens. The corrected capture now finds its candidate and the official evaluator resolves that candidate, but neither verifier succeeded (exit codes 1 and 2), no patch was imported, and the run reached INPUT_TOKEN_BUDGET. The discovery instruction alone therefore does not establish reliable verification and delivery. No further retry or budget increase was made.

The scope correction has direct live evidence; delivery remains blocked. The next improvement must address actual verifier selection/execution failures rather than treating a correct retained patch as successful delivery. Source-bound samples and the unchanged-budget plan are retained in `evidence/ga-verifier-discovery-live-2026-09-19.json` and `evidence/ga-verifier-discovery-plan-2026-09-19.json`. This result does not alter any earlier sample or satisfy GA acceptance.

The current installed-package smoke also passed for `@zhivex-ai/harness@1.0.0-rc.14` after the verifier-discovery pair. No package publication was performed.

### Python editable-install shadowing reproduced and fixed in candidate images

Offline execution of the documented Django runner exposed another environment defect: running `python tests/runtests.py dbshell --settings=test_sqlite --parallel=1` reported Django from `/testbed/django`, outside the mounted candidate. Its apparent pass did not verify the retained edit. The image's editable installation took precedence when Python used the nested script directory rather than the checkout root.

Derived candidate images now set `PYTHONPATH=/workspace:/workspace/src:/testbed:/testbed/src`; the image tag derivation includes this policy. Both candidates still receive the same image, and the control retains `/testbed` resolution. Native preflight checks top-level checkout package origins without relying on `-c`'s current-directory shortcut and fails closed on absent or shadowed checkout packages. Old prepared images must be rebuilt; old results remain immutable development evidence, not proof of candidate-bound verification.

The corrected image `sha256:4c8b7a320988313b8881a96f334a189bfd0d6fda47cc0219d648867ffe765b80` resolves Django from `/workspace` for Harness and `/testbed` for the control. The public runner now genuinely sees the candidate and fails one historical test expecting the old argument order (26 tests, 5 skips); that is distinct from infrastructure availability. A separate four-case assertion derived solely from the public issue rejects the old image's source origin, fails against the baseline under the corrected image, and passes against the retained candidate. No repository tests, evaluator tests or host source were changed.

Twelve focused tests, tooling typecheck, Python compilation and native OCI preflight pass. No model/provider request was made. Evidence: `evidence/ga-python-checkout-imports-2026-09-19.json`. The next live comparison must use the corrected pinned image; this offline validation does not prove reliable verified delivery.

### Corrected-image diagnostic stopped on unknown tool selection

One private Qwen run with the corrected image stopped on the first model turn after two unregistered tool calls (4,652 input / 97 output tokens, zero executions and approvals). No verifier ran, so this cannot establish delivery effectiveness for the image correction. No retry was made. The result is retained in `evidence/ga-python-origin-delivery-2026-09-19.json`. Relative to the previous private diagnostic both the verifier-discovery instruction and image differ; this is not a causal A/B claim.

Installed Core 1.22.0 already supports opt-in unknownToolMode `tool-result`, but repair mode enabled only argument-schema recovery. Repair now also returns unknown selections as structured errors while leaving strict mode unchanged. The run fingerprint changes to bind this policy. Tests cover successful correction, strict/explicit fail-fast behavior, the tool-error ceiling, preserved token accounting and approval required for a subsequent mutation. No unknown tool is registered, renamed or executed.

Validation after the selection-recovery change: 577 tests across 72 files pass, including five focused regressions. Runtime/tooling types, documentation and the preparation contract pass. Evidence: `evidence/ga-tool-selection-recovery-2026-09-19.json`. No live retry or GA acceptance claim was made.

### Corrected-image end-to-end delivery passes one development diagnostic

The predeclared single Qwen run at implementation commit `fbceb4f` completed in 7 recorded turns, with 8 tools and 2 approvals. It used 47,739 input / 860 output tokens under the unchanged limits. Verification exited 0, the governed import completed, and the independent pinned official evaluator resolved the actual host patch. The imported patch SHA-256 is `15989da845ac1f766848c5c2e153296d7eef926a752ec658548702ac0e028bc7`, matching the independently graded retained candidate. No protected files changed.

No unknown-tool error occurred in this successful run, so it validates the current bundle's delivery path rather than proving the causal live effect of unknown-tool recovery. That behavior remains supported by focused regressions. This is one known development instance, without a concurrent control; previous failed attempts stay failed. It is not GA acceptance, a reliability rate, or fresh holdout evidence. Further repetitions of this same case are closed; the next external evaluation should use a fresh predeclared cohort and freeze implementation throughout. Evidence: `evidence/ga-tool-selection-live-plan-2026-09-19.json` and `evidence/ga-tool-selection-live-2026-09-19.json`.

### Fresh five-task cohort: complete, no GA approval

The predeclared cohort excluded all 17 previously used task IDs, pinned five new tasks and their images, and passed all five native preflights before paid calls. The frozen implementation was `1886644`. All ten planned model runs and their independent grading completed; usage is complete and there are no missing rows or grading failures. No retries, replacements or source changes occurred during the cohort.

Harness resolved 0/5; mini-SWE-agent resolved 1/5 (Requests). Harness stopped before any plan/candidate in three Django cases at WORK_TOKEN_BUDGET, exhausted total input on Requests, and completed/imported Pylint without satisfying the independent evaluator. The candidate-only score was also 0/5. The comparative bootstrap interval is exploratory for only five tasks and does not support a broad accuracy or safety claim.

The input target was 100,000 for both, but enforcement differs: the control checks between calls and observed totals ranged from 100,223 to 107,327; Harness predicts the next request and reserves work capacity for closure. Actual consumed-token parity is therefore not claimed. Three Harness work-budget stops occurred after 57,786–62,053 input tokens with no repair plan, leaving a substantial unused closure reserve. The next implementation investigation is whether required-delivery runs transition into bounded planning before the work boundary rejects another call. This is a hypothesis to reproduce locally, not proof of a fix.

The fresh holdout is now complete and these five cases join the exclusion set for future fresh evaluation. Its results do not support GA approval. Preparation, plan and all sanitized samples are preserved in `evidence/ga-fresh-cohort-preparation-2026-09-19.json`, `evidence/ga-fresh-cohort-plan-2026-09-19.json`, and `evidence/ga-fresh-cohort-result-2026-09-19.json`. All protected release, representative and final security requirements remain unchanged.

### Work-budget boundary regression and bounded planning transition

The three fresh-cohort work-budget failures had no plan/candidate and no verifier attempt. A local middleware regression reproduced the transition defect: with 60% of input already consumed and a large current exploration catalogue, the next request exceeded the 70% work ceiling and failed before offering planning. The positive regression failed with WORK_TOKEN_BUDGET before the change; optional-delivery inspection retained its expected rejection.

Required-delivery OCI runs now estimate the current request, including the working-state projection, before the budget gate. If exploration would reach the work boundary and there is no verifier/candidate, the controller enters its existing durable planning obligation: only repair_plan/read_task, at most two attempts across resumes. The budget then estimates the narrowed request and enforces the unchanged total ceilings. Tests also cover the output work boundary, no calls after total input/output exhaustion, rejected exploration during planning, and persistence of attempt limits. No task-specific answer or verifier was injected.

An initial implementation exposed the estimator through the internal budget return type, which unnecessarily changed transitive declaration hashes. The estimator was moved to a standalone internal helper; the existing Stable signature snapshot remains unchanged and the contract check passes. The runtime fingerprint advances to bind the new scheduling behavior. The failed fresh cohort remains immutable evidence; no live retry has yet validated this change.

Final local validation: 584 tests across 72 files, runtime/tooling types, documentation, preparation contract and installed-package smoke pass. Stable signatures remain unchanged. Evidence: `evidence/ga-work-budget-planning-2026-09-19.json`. No live provider call was made for this change.

Continuation review reproduced two additional failures: registering the forced plan cleared the transient reserve eligibility before an edit, and an already registered plan prevented boundary activation. Required-delivery OCI work now durably enters closure reserve at the boundary, with or without an existing verifier. Missing verifiers still require bounded planning. Checkpoint restoration preserves reserve eligibility without replenishing usage; total-input exhaustion still prevents dispatch. Both regressions failed before this correction and pass after it. Reserve availability alone does not prove a successful repair.

### Work-boundary live development check: plan reached, delivery still fails

The predeclared single rerun selected django__django-10914, the first previous work-budget failure in manifest order. Implementation a6d6540, all source hashes, prepared image and original limits were frozen. Native preflight passed. One Qwen attempt consumed 93,522 input and 1,275 output tokens across nine model calls with complete usage. The observed progress records enteredClosure=true and planRecorded=true; the run then failed INPUT_TOKEN_BUDGET without an imported patch. Independent grading completed with empty-patch-no-solution / resolved=false.

This supports the narrow observation that the run could record a plan and continue beyond the prior work-budget stop, not that the change improves correctness. Subsequent calls requested environment shells and patch inspection; no deliverable was established. A local postprocessing helper initially rejected the empty patch, so grading was resumed from the stored terminal result without another model call. The failed attempt remains the sole attempt.

The fresh 0/5 holdout remains unchanged. Further investigation should examine whether the remaining context and tool sequence allow the planned repair and verification to finish inside the fixed total budget; another indiscriminate retry is not justified. Evidence: evidence/ga-work-boundary-live-plan-2026-09-19.json and evidence/ga-work-boundary-live-2026-09-19.json.

### Complete local release preparation check

At implementation a6d581a, bun run check completed with exit 0: 584 tests, both typechecks, documentation, preparation contract, historical migrations, deterministic evaluation, workspace/safe-fix benchmark checks, both MCP interoperability smokes, native OCI smoke and installed-package smoke. bun audit found no vulnerabilities among 35 packages; bun pm untrusted reported no untrusted dependencies with scripts. This is local evidence, not a protected release result.

The release-readiness script remains red: RC14 is intentionally Unreleased without a dated release heading, the check ran on the feature branch, and the evidence additions were uncommitted when checked. Do not date a release or mark these gates passing before the corresponding release action. The formal GA ledger additionally requires final representative evaluation, immutable publication/provenance and named artifact-bound human security review. Context analysis of the latest failed development run is retained separately; it does not justify changing acceptance criteria or an unmeasured runtime tuning.

Evidence: evidence/ga-complete-local-check-2026-09-19.json and evidence/ga-work-boundary-context-analysis-2026-09-19.json.
