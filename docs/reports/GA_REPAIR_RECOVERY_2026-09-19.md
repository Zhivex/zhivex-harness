# Recuperación de reparaciones: diagnóstico de desarrollo

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
