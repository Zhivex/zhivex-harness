# Qwen 3.8 Flash: diagnóstico previo a otra RC

Fecha local: 2026-09-22 (America/Argentina/Buenos_Aires). Código analizado:
`5b7273fd7e4edd36bfc1d1954a63138412d66c05`; agents 1.8.0, core 1.22.0,
qwen 0.15.0. Decisión vigente: mantener Flash y la publicación bloqueada.
Este trabajo no crea otra RC, no cambia modelos ni relaja controles.

Actualización 2026-09-23: el [análisis con paquetes next publicados](qwen-next-analysis-2026-09-23.md)
confirma que se corrigió el enlace/consumo de hijos fallidos, pero persiste la
desviación de delegación de Flash. Las referencias a corrección SDK pendiente
de este informe describen la versión stable examinada en la fecha original.

## Conclusión

Hay una interacción concreta entre fidelidad de delegación y diseño del Harness.
En cinco de las seis pruebas con padre, Qwen sustituyó la tarea exacta por otra
revisión, omitió el marcador requerido y añadió instrucciones `system` al hijo.
El hijo recibió esa tarea alterada y solicitó más herramientas de las permitidas
o una ruta ajena al workspace. El Harness bloqueó esas operaciones. El transporte
capturado ya contenía la desviación: no fue introducida por el parser del SDK en
estos casos.

No hay evidencia de agotamiento de tokens, truncamiento o timeout en estas ocho
pruebas. Sí hay un límite de herramientas deliberadamente estrecho y un contrato
de delegación que permite al modelo cambiar el alcance. Subir límites a ciegas o
añadir una frase al prompt no produjo una solución fiable.

Existe además un defecto independiente del SDK: cuando el hijo lanza un error,
su estado persiste pero falta en `parent.childRuns`; el agregado de presupuesto
del padre omite su consumo. Esto dificulta el diagnóstico y debe corregirse,
pero no explica que Qwen cambie la tarea antes de ejecutar al hijo.

## Experimento controlado live

Ocho ejecuciones secuenciales, dos por variante, sin repetir hasta conseguir verde.
Misma cuenta/configuración local, modelo `qwen3.8-flash`, fixture Git sintético,
perfil strict, herramientas de revisión de sólo lectura. Padre streaming y
hijo generate/no streaming; ambos usaron Responses. Cada ejecución puede incluir
varias solicitudes HTTP. No es una estimación estadística de fiabilidad ni una
certificación del tarball RC8. El orden fue A, B, C, D, A, B, C, D.

| Variante | Cambio controlado | Resultado observado |
| --- | --- | --- |
| A: baseline | Prompt y límites del smoke oficial: padre 4 pasos/4 herramientas, hijo 2/1 | 0/2 completadas: lote de 2 herramientas rechazado; ruta fuera del workspace rechazada |
| B: direct | Entregar al mismo hijo el prompt exacto sin reescritura del padre | 2/2 completadas, un `read_file`, marcador presente |
| C: roomy | Hijo 4 pasos/3 herramientas, padre sin cambios | 0/2 completadas: tareas alteradas, peticiones acumuladas de 5 y 4 herramientas |
| D: clarified | Instrucción adicional de exactitud y presupuesto en el sistema del padre; límites originales | 1/2 completadas; en el fallo volvió a cambiar la tarea y pidió 2 herramientas |

La variante D es exploratoria, no un fix probado. B aísla que el hijo puede resolver
la tarea con una sola herramienta cuando recibe el alcance correcto; no prueba
la fiabilidad del sistema completo. Todas conservaron intacto `review-target.txt`.
No se ensayaron tareas de escritura en este experimento.

Cadena de evidencia del caso A0:

1. La solicitud al padre contiene el marcador del hijo y el JSON exacto solicitado.
2. `function_call_arguments.done`, `output_item.done` y el item terminal contienen
   una delegación diferente, sin ese marcador y con `system` adicional.
3. El input de la llamada persistido también difiere del esperado; el hijo no
   recibe el marcador en su mensaje de usuario.
4. El hijo pide `list_files` y `git_diff` juntos. Preflight rechaza el lote antes
   de ejecutar ninguna: `maxToolCalls`, limit 1, required 2, actual 0.
5. Ambos estados terminan failed. Todas las respuestas HTTP observadas son 200 y
   las respuestas del proveedor terminan completed: completar una respuesta HTTP
   no equivale a completar correctamente una tarea de agente.

En A4 la ruta solicitada es absoluta, no corresponde al fixture y el error de
workspace confirma escape. Se conserva sólo esa clasificación, sin publicar la
ruta ni los argumentos. El bloqueo de filesystem funcionó.

La proyección de argumentos compara eventos finales, no demuestra cada delta de
stream individual. `argumentEventsAgree` sólo es significativo aquí para la única
delegación del padre; no usarlo como detector de corrupción en lotes heterogéneos.

## Tokens y límites

| Caso | Tokens padre | Tokens hijo | Salida hijo | Límite que detuvo la ejecución |
| --- | ---: | ---: | ---: | --- |
| A0 | 4.605 | 1.724 | 78 | Herramientas: 2 solicitadas / 1 permitida |
| B1 | — | 3.845 | 509 | Ninguno |
| C2 | 4.675 | 4.169 | 303 | Herramientas: 5 acumuladas / 3 permitidas |
| D3 | 10.083 | 4.105 | 769 | Ninguno |
| A4 | 4.597 | 1.722 | 92 | Ruta fuera del workspace |
| B5 | — | 4.313 | 977 | Ninguno |
| C6 | 4.673 | 7.002 | 312 | Herramientas: 4 acumuladas / 3 permitidas |
| D7 | 4.755 | 1.884 | 154 | Herramientas: 2 solicitadas / 1 permitida |

Uso acumulado declarado por proveedor, no precio ni factura; los totales incluyen
entrada y salida. Los tokens de razonamiento se registran por separado cuando el
proveedor los informa: no sumarlos otra vez al total. Padre e hijo se suman desde
sus registros individuales, porque el agregado del padre fallido es incompleto.

Límites efectivos observados: padre entrada 100.000, salida 30.000, total 120.000;
hijo entrada 30.000, salida 8.000, total 36.000. Timeout padre 900 s, hijo 300 s.
Ningún caso agotó esos límites y no hubo compactaciones. No apareció cap de tokens
por solicitud en el cuerpo HTTP de estos escenarios de orquestación.

La primera petición del padre lleva 18 herramientas y unos 12.472 caracteres de
schemas; la del hijo 7 herramientas y 4.551 caracteres. Son caracteres, no tokens.
El padre baseline consume 4.451 tokens de entrada antes de delegar. Es overhead
significativo para leer un archivo, aunque está muy lejos del presupuesto actual.

`required` de los guardrails puede ser acumulativo dentro de la invocación del
SDK; `actual: 0` no significa que ninguna herramienta se haya ejecutado en pasos
anteriores. En C6 ya se ejecutaron tres. El SDK mantiene una reserva acumulada
antes de ejecutar lotes; la presentación del diagnóstico debe distinguir reserva
y consumo confirmado. No se ha demostrado doble contabilización de herramientas.

## Restricciones del diseño que conviene revisar

1. **Fidelidad de la tarea delegada.** `createSubAgentTool` admite `prompt` y
   `system` generados por el padre. El Harness limita capacidades pero no obliga
   a preservar el alcance ni los criterios de aceptación del usuario. Para una
   delegación gobernada, usar un contrato inmutable con task ID, alcance, recursos,
   presupuesto y aceptación; el modelo propone un plan dentro de ese contrato.
   No elevar automáticamente texto generado a instrucciones de sistema.
2. **Política y presupuesto visibles.** Las instrucciones generales piden inspección,
   diffs y auditoría de mutaciones; el smoke pide una lectura y un token exacto.
   El reviewer tiene siete herramientas y una descripción de revisión general,
   sin un presupuesto dinámico explícito en su prompt. Esa tensión es una hipótesis
   de contribución; el experimento no aísla cada instrucción. Separar instrucciones
   por rol/tarea y presentar el presupuesto restante de forma confiable.
3. **Lote y recuperación.** Strict aborta ante el lote que excede presupuesto. Esto
   preserva el límite, pero no ofrece una oportunidad acotada de corregir la
   propuesta. Evaluar un rechazo estructurado y como máximo una reparación dentro
   del mismo presupuesto, sin ejecutar parcialmente un lote ni ampliar autoridad.
4. **Pruebas de contrato frente a conducta del modelo.** El smoke actual mezcla
   fidelidad literal, tool choice, límites mínimos, persistencia y jerarquía.
   Mantener pruebas determinísticas para contrato/durabilidad y una prueba live
   de comportamiento con aceptación explícita. No retirar marcadores o assertions
   para convertir un fallo real en verde; agregar evidencia de en qué contrato falló.
5. **Uso y topología en error.** Hacer durable el vínculo padre-hijo desde el inicio
   y reconciliar todo estado terminal. El UsageLedger opt-in ve las dos llamadas,
   pero no repara el agregado del SDK ni la jerarquía. Habilitar observabilidad de
   uso de forma sistemática y mantener distintos los conceptos medido/desconocido.
6. **Opciones de transporte.** Padre y subagente siguen caminos stream/generate
   distintos; las opciones de entrada del padre no se heredan automáticamente.
   Definir herencia explícita de API mode, razonamiento, cap y timeouts por rol,
   sin copiar indiscriminadamente instrucciones o credenciales.
7. **Tokens como control de costo.** El Harness separa los límites durables del
   presupuesto de transporte. El cap por checkpoint se aplica sin subagentes;
   en esta orquestación no hay cap HTTP. Auditar reserva de tokens entre hijos,
   estimación previa y reconciliación posterior para evitar sobrepasar un límite
   antes de poder observar el uso. Es un riesgo de diseño, no la causa observada.
8. **Orden de certificación.** Actualmente se hacen todos los proveedores de base
   antes de orquestación. Al fallar Qwen se omite OpenAI en orquestación y fases
   posteriores, pero OpenAI base ya consumió. Para el objetivo de ahorro indicado
   por el usuario, completar primero todas las fases de Qwen, después los otros
   proveedores, manteniendo la matriz completa sólo en diagnóstico explícito.

## Defecto SDK reproducible sin red

[Reproductor](../../scripts/diagnostics/reproduce-failed-child-accounting.ts):

```sh
bun run scripts/diagnostics/reproduce-failed-child-accounting.ts
```

Usa modelos mock, store en memoria y un workspace temporal propio; no requiere
credenciales ni cambia configuración. Es diagnóstico, no un test que declare el
bug como comportamiento esperado. Emite `accountingDefectObserved`.

Padre reporta 3 tokens y delega. Hijo reporta 5 y propone dos herramientas con
presupuesto 1. El SDK bloquea correctamente antes de ejecutarlas, persiste ambos
estados failed, conserva `child.parentRunId`, pero deja `parent.childRuns=[]`.
`getAgentBudgetStatus(...includeChildRuns=true)` devuelve 3 en vez de 8. Con ledger
activado éste registra 8, mientras el agregado sigue en 3.

Causa en core 1.22.0: `createSubAgentTool` invoca `onFinish` después de esperar
`runAgent`; cuando éste persiste failed y relanza, no se construye/notifica el
childRun. Hay que preservar el error original y asegurar enlace/uso terminal,
sin duplicar consumos ni reejecutar herramientas en recovery.

[HU preparada en Notion](https://app.notion.com/p/3e4777b104f6812b9c5af2fab375bf67),
con reproducción, alcance, implementación propuesta, variantes de fallo,
persistencia, seguridad, publicación SDK y aceptación del consumidor.

## Qué se puede afirmar de los releases anteriores

| Release | Evidencia disponible | Límite de la conclusión |
| --- | --- | --- |
| RC4, Qwen Max | Representative: 12/14; fallan hostile-instructions/rule_file y sqlite-restart-and-resume/clean con EXECUTION_FAILED, duraciones 82,2 s y 54,2 s | Error genérico; no permite atribuir tokens o herramientas. Max también tuvo fallos |
| RC5, Qwen Flash | Logs registran progreso 1/14 a 14/14 y luego UNCLASSIFIED_FAILURE; diagnóstico final informa 0 casos | El cero no prueba que no hubo ejecución. La pérdida del reporte impide reconstruir resultados por caso con esa evidencia |
| RC6 | Bloqueo OpenAI base | No es evidencia de fallo de Qwen |
| RC7 | OpenAI resume_output falla; se identificó pérdida de recibo de función apply_patch en adapter | Defecto de transporte distinto, mitigado con envelope en PR100 |
| RC8, intentos 1 y 2 | Validación del artefacto y base de los tres proveedores pasan; Meta orquestación pasa, Qwen falla; publicación omitida | Tag anterior a PR101: no contiene detalle de guardrail. Los casos locales explican mecanismos reproducidos, no prueban la causa exacta de cada error cloud |

Fuentes: [RC4](https://github.com/Zhivex/zhivex-harness/actions/runs/35798449496),
[RC5](https://github.com/Zhivex/zhivex-harness/actions/runs/35801092086),
[RC6](https://github.com/Zhivex/zhivex-harness/actions/runs/35804362922),
[RC7](https://github.com/Zhivex/zhivex-harness/actions/runs/35806499955),
[RC8](https://github.com/Zhivex/zhivex-harness/actions/runs/35808383244).

La matriz representative actual es otro perfil: 24 pasos, 64 herramientas,
8.192 tokens de salida acumulados y 300 s; sin subagentes. En Qwen se usa Responses
sin pasar `maxTokens` desde el driver. Compactación governed: 16 mensajes/12.000
tokens estimados y 2 mensajes recientes (el SDK conserva grupos correlacionados).
Por tanto no se puede extrapolar el guardrail hijo 1-tool del smoke a RC4/RC5.
Antes de atribuir allí un problema de tokens hace falta progreso durable con uso,
presupuesto efectivo, compactaciones y punto de fallo por caso. Este análisis no
pagó otra matriz completa para intentar reconstruir evidencia histórica perdida.

## Trabajo previo a autorizar otra RC

1. Resolver el contrato de delegación gobernada y añadir tests determinísticos de
   tarea inmutable, autoridad de sistema, límite de lotes y aceptación final.
2. Corregir el enlace/uso del SDK, o implementar una mitigación durable verificable
   en Harness. Publicar/consumir la corrección según la HU; no editar node_modules.
3. Añadir diagnóstico saneado por fase: violación de contrato, guardrail preciso,
   estado padre/hijo, uso confirmado, reservas, duración y ruta de API como enum.
   Retener progreso por caso aunque la generación del reporte final falle.
4. Validar offline primero. Ejecutar una campaña Flash predefinida, con tamaño y
   criterio de aceptación fijados antes del primer intento; conservar todos los
   resultados. Una muestra pequeña verde no certifica fiabilidad general.
5. Sólo después, probar la matriz representative de Qwen con observabilidad actual.
   Si falla, clasificar la frontera antes de gastar en otros proveedores.
6. Con esos gates resueltos, producir un tag nuevo inmutable y certificar/publicar
   su tarball exacto. Nunca reetiquetar RC8 ni reutilizar estos resultados locales
   como evidencia de certificación de un artefacto posterior.

La elección Flash se conserva. El análisis está terminado; los cambios de diseño,
la corrección SDK y la certificación/publicación siguen pendientes.

## Evidencia conservada

[Proyección JSON](evidence/qwen-flash-analysis-2026-09-22.json): ocho casos live,
presupuestos efectivos, métricas de transporte, conteos y reproducción offline.
No incluye prompts, argumentos, respuestas completas, razonamiento textual,
cabeceras, credenciales, rutas privadas ni bases SQLite. Se excluye el log crudo de
GitHub. La instrumentación de diagnóstico no debe incorporarse automáticamente
como logging de producción: allí se requiere esquema allowlist estricto y límites
de tamaño antes de recolectar cuerpos, no sólo antes de guardarlos.
