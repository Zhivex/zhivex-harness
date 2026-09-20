# Revisión estructural del harness tras la reevaluación Qwen

> Historical snapshot: findings and outcomes apply to the checkout and attempt
> recorded below. For the subsequent stable release outcome, see
> [current release evidence](../LIVE_CERTIFICATION.md#current-public-status).
> Later publication does not change failed evaluation results.

> Historical snapshot: versions, findings and measurements below describe the recorded run, not the current checkout. See the [report index](README.md) for follow-up work and the [documentation index](../README.md) for maintained guides.

El principal margen de mejora está en el controlador de reparación. El harness
dispone de mecanismos de ejecución gobernada, pero sigue delegando en el modelo
la decisión de abandonar la exploración, recuperar memoria, seleccionar una
verificación e importar. Las políticas añadidas restringen ciertas herramientas;
no implementan todavía un flujo de reparación con progreso comprobable y
presupuesto de cierre. Más instrucciones y herramientas no resolvieron esa
carencia y aumentaron el contexto fijo.

## Alcance y método

Revisión del checkout actual, incluidos cambios locales: instrucciones y catálogo,
lectura/búsqueda/edición, progreso, compacción/memoria, presupuesto, aprobación y
finalización, ciclo OCI, configuración CLI/orquestación, driver, métricas y pruebas.
Se contrastó con las veinte muestras archivadas de la última comparación y con
los informes históricos. No se hicieron llamadas nuevas a proveedores ni se
modificó el runtime. No es una recertificación completa de seguridad, proveedores,
servicios externos, concurrencia, plataformas o publicación.

Se ejecutaron 46 pruebas focalizadas en cinco archivos: progreso, remediación,
compacción, recuperación de verificación y SWE-bench. Pasaron todas. El nuevo
`../../evaluations/audits/repair-architecture-2026-09-09.ts` (source checkout)
usa herramientas reales de lectura sobre archivos temporales y llamadas simuladas
al middleware presupuestario. Pasó typecheck con las opciones estrictas del repo.
La [evidencia estructurada](../../benchmarks/baselines/repair-architecture-audit-2026-09-09.json)
incluye hashes de fuentes, resultados de los reproductores y métricas derivadas.

## Por qué las iteraciones no dieron el avance esperado

1. Se corrigieron defectos reales de integridad, cancelación, compatibilidad y
   observabilidad. Esas correcciones son necesarias, pero su aprobación local
   no demostraba que el agente fuera a resolver más tareas.
2. Se intervino con frecuencia sobre síntomas: más contexto recuperable,
   instrucciones de cierre y contadores de exploración. Ninguno obliga a que
   un candidato llegue a verificación con recursos suficientes.
3. La remediación agrupó once mejoras. La última matriz permite evaluar el
   paquete completo, pero no atribuir el resultado a cada intervención. Sí hubo
   un estudio anterior aislado de recuperación de verificador; no alcanzaba a
   reparar intentos que nunca llegaban al verificador.
4. Se reutilizaron cinco tareas conocidas. Sirven para depurar; repetirlas no
   amplía cobertura de generalización. Dos repeticiones tampoco estabilizan
   suficientemente resultados de un agente estocástico.
5. Las nuevas ayudas también cuestan: sistema más catálogo aumentó de 11.157
   a 13.755 caracteres por petición. No se exigió una mejora de resultado final
   antes de considerar completada la mejora del mecanismo.

El resultado actual sigue siendo 0/10 entregas de Zhivex frente a 4/10 de mini
con el mismo Qwen solicitado. Los tres candidatos correctos de Zhivex identifican
una pérdida posterior a la edición, no tres éxitos ni una mejora medida respecto
de una baseline que no capturaba candidatos.

## Hallazgos y cambios necesarios

| ID | Prioridad | Diagnóstico | Cambio y criterio de aceptación |
| --- | --- | --- | --- |
| A01 | P1 | El cierre depende de otra decisión del modelo | Controlador durable por etapas y revisión de parche. Una edición activa una obligación pendiente de verificación; completar requiere recibo válido. |
| A02 | P1 | No hay reserva efectiva para cerrar | Separar presupuesto de trabajo y cierre, estimar la siguiente petición completa, reservar inspección/verificación y recuperación acotada. El trabajo ordinario no puede consumir la reserva. |
| A03 | P1 | La fase declarada no representa evidencia de progreso | Transiciones basadas en reproducción, digest del candidato y recibos; un plan es una hipótesis, no una reparación. |
| A04 | P2 | El alcance del plan no se aplica a lecturas por lotes | Normalizar y validar todos los paths de cada herramienta. La política debe ser consistente entre lectura individual, lote y búsqueda. |
| A05 | P1 | Recuperar memoria sigue siendo opcional; checks compactados pierden identidad | Proyección automática y acotada del estado de trabajo: requisito activo, hipótesis, evidencia, revisión del candidato y próximo check. Conservar vínculos a recibos completos. |
| A06 | P2 | Catálogo estático y estimación parcial del contexto | Catálogo mínimo por etapa y medición de mensajes + sistema + esquemas + margen del transporte; verificar compatibilidad con historia y aprobaciones. |
| A07 | P2 | El contrato de verificación exige salida cero, no suficiencia del check | Registrar propósito, aserciones y revisión probada; distinguir ejecución exitosa, reproducción corregida y regresión. No sustituir pruebas independientes por autoevaluación del modelo. |
| A08 | P2 | Crear/sincronizar el entorno consume una parte medible de los comandos | Explorar sesión por ejecución lógica y sincronización incremental conservando leases, cancelación e integridad. Medir por separado antes de cambiar. |
| A09 | P1 | Los gates de mecanismo no prueban mejora del agente | Regresiones de trayectorias difíciles, ablaciones pequeñas y promoción por resultados entregados, sin alterar métricas ni presupuestos tras observar fallos. |
| A10 | P2 | Perfil y entorno del benchmark difieren del producto y el competidor | Manifiesto efectivo exportable para CLI y benchmark; comparar calidad del candidato y entrega gobernada por separado. |

### A01–A03: cambiar quién controla el progreso

`runHarness` retorna un resultado no pendiente de aprobación sin conducir una
transición de reparación. La ruta terminal solo se activa si el modelo ya pidió
una herramienta terminal y quedó una aprobación única aprobada. Es una
optimización útil del cierre solicitado, no un controlador que garantice llegar a él.

`createRepairProgress` establece `phase=repair` al recibir `repair_plan`, incluso
antes de reproducir o editar. No tiene estados basados en candidato modificado,
verificación necesaria o importación pendiente. `closing()` activa un booleano
al 70% de uso y permite hasta cuatro lecturas y tres comandos adicionales. Un
modelo puede gastar lo restante antes de agotar esos contadores.

El reproductor consume 70.000 tokens, acepta tres respuestas de 10.000 y bloquea
la siguiente: reserva efectiva cero. En las trazas reales, nueve intentos entran
en cierre con cero bloqueos de fase y ninguno solicita verificación. No hace
falta una avería del SDK para explicar ese comportamiento.

Propuesta de flujo: explorar → reproducir → editar → verificar → importar →
completar. Debe permitir corregir hipótesis, reproducir con fixtures nuevos y
volver a editar tras una verificación fallida. La transición puede automatizar
inspección y preparación del próximo paso; nunca debe inventar aprobaciones,
usar pruebas ocultas ni importar candidatos solo porque el evaluador posterior
los considere correctos. Si falta autorización, termina como pendiente; si falta
evidencia o presupuesto, conserva candidato y causa sin declarar éxito.

La reserva debe calcularse antes de pedir otra respuesta, no solo después del
70%. Debe incluir el catálogo, la petición de cierre y una recuperación acotada.
Un porcentaje fijo puede ser un límite inicial, pero su efectividad depende del
tamaño de las peticiones. No se propone subir los 100.000 tokens para ocultar el
problema. La telemetría de transporte debe persistir como contabilidad propia;
restaurarla únicamente desde uso del SDK hereda los huecos ya documentados.

### A04: el plan no cubre la herramienta más utilizada

El wrapper consulta `input.path`. `read_files` usa `input.files[].path`, por lo
que queda fuera de esa comprobación. El reproductor registra `planned.txt`:
`read_file(unplanned.txt)` se rechaza por alcance y el lote equivalente devuelve
el archivo. Es un defecto de estrategia; las restricciones de seguridad del
workspace continúan aplicándose.

Hubo 52 ejecuciones de `read_files`, 27 de `search_files` y 7 de `search_many`.
Por ello no basta probar un wrapper con un schema ficticio que solo contiene
`path`: hay que probar los schemas reales y sus equivalencias. Contar un lote
como una lectura también separa cantidad de llamadas de cantidad de evidencia.

### A05–A06: memoria utilizable, no solo disponible

Las trazas contienen 14 eventos de compacción y una solicitud de `read_task`.
Esto no demuestra por sí solo qué requisito olvidó cada intento, pero sí que la
instrucción de recuperar la tarea después de compactar no se cumple de forma
sistemática. La tarea completa ahora está conservada en metadata; el siguiente
paso es presentarle al modelo automáticamente la parte necesaria, con acceso
a la fuente completa, sin reinyectar documentos enteros en todas las peticiones.

El compactor conserva paths, digests y códigos de salida, pero el reproductor
muestra que pierde `assert 2 + 2 == 4` y mantiene `exitCode=0`. Hace falta un
registro de evidencias ligado a `commandId`, propósito y revisión, cuya proyección
resuma resultados y ubicación de fallos. Los logs completos deben quedar acotados
y accesibles bajo la política de redacción; no incorporarse indiscriminadamente.

El estimador usado por compacción recibe mensajes y divide caracteres por cuatro;
no recibe el catálogo de herramientas. El medidor de transporte sí lo observa,
pero esa observación no alimenta una predicción del costo siguiente. Catálogo
y sistema crecieron 23,3%, mientras los resultados de herramientas presentes por
petición bajaron solo 7,2% en la cohorte. Es evidencia de un tradeoff; no prueba
causal de que retirar memoria aumente la tasa de resolución.

Un catálogo dinámico debe conservar consistencia del protocolo de herramientas
anteriores y de aprobaciones pendientes. No basta eliminar nombres del objeto
antes de cada llamada. Primero conviene medir una variante estática mínima,
manteniendo edición gobernada e importación, y luego agregar selección por fase.

### A07–A08: calidad de verificación y costo OCI

`verify_and_apply_environment_patch` verifica patchId, ejecuta argv aprobado,
exige salida cero, rechaza cambios producidos por el verificador e importa bajo
las comprobaciones existentes. Esas garantías deben conservarse. Una salida cero
no demuestra que el comando haya comprobado el requisito: un contrato de evidencia
debe hacer explícito qué se comprobó, sin confundirlo con una prueba matemática
de cobertura. El evaluador independiente sigue siendo necesario.

En los 17 comandos nativos observados, las métricas acumulan 68,84 s, de los cuales
11,60 s corresponden a creación de sesión y 12,35 s a exportación de workspace:
34,8% del tiempo instrumentado de comandos entre ambas fases. No es 34,8% de toda
la ejecución ni demuestra que OCI explique el fracaso. El runtime elimina los
contenedores al liberar una sesión; su calentamiento depende de la duración de
la adquisición. Hay margen para estudiar persistencia bajo una misma ejecución
lógica, pero corregir el cierre y el contexto tiene prioridad sobre este ahorro.

### A09–A10: evaluar resultados y trasladarlos al producto

Los tests de progreso verifican contadores y excepciones. Los de recuperación
usan un modelo simulado que emite `read_task` o el verificador cuando el fixture
lo programa. Son regresiones válidas del mecanismo; no evidencia de que Qwen
vaya a tomar esas decisiones. `scripts/evaluate.ts` también usa modelos simulados.

Añadir trayectorias con edición correcta temprana seguida de exploración,
memoria compactada, lotes fuera de alcance, aprobación tardía, cancelación,
verificación fallida y reinicio durable. Medir qué decisiones puede forzar el
controlador sin depender de que el mock le entregue el final feliz. En live,
registrar tokens hasta primera edición, primera reproducción y verificación,
tokens después del último candidato, candidato correcto y entrega final.

El benchmark activa `repair`, desactiva contexto de proyecto y subagentes, y
recorta el catálogo. La CLI por defecto resuelve `strict`. No se concluye que
estos resultados cubran toda la CLI, MCP, skills u orquestación. El siguiente
experimento debe exportar el perfil efectivo y reutilizar el mismo ensamblado
del producto donde sea posible.

## Orden de trabajo y criterio de avance

1. **Cerrar correctamente un candidato existente.** Regresión de flujo sin modelo
   real que conserve permisos, integridad y cancelación; luego un ensayo live
   acotado. El objetivo es elevar entregas, no solo llegar a editar.
2. **Integrar presupuesto y estado de reparación.** Hacer imposible gastar la
   reserva en exploración ordinaria; persistir estado/contabilidad y probar resume.
3. **Reducir contexto efectivo.** Variante mínima del catálogo y memoria proyectada,
   cambiadas por separado para identificar el aporte de cada una.
4. **Evaluar generalización.** Tras una mejora repetida en desarrollo, congelar
   configuración y abrir una cohorte nueva por tipo de tarea y repositorio.

Predeclarar para cada ensayo hipótesis, cambio, tareas, repeticiones, límites,
métrica principal y regla de parada. Mantener comparables modelo, razonamiento y
transporte; la comparación anterior OpenAI/Qwen variaba esas tres dimensiones.
No iniciar otra matriz completa por cada ajuste menor. Un resultado sin mejora
final exige revisar la hipótesis, no acumular más herramientas por defecto.

La HU del SDK sobre herramientas desconocidas y pérdida de uso durable ya está
[en Zhivex](https://app.notion.com/p/3d7777b104f681248ed3cecffe9328d2).
Los nuevos hallazgos reproducidos aquí pertenecen al harness y no requieren
esperar al SDK. Muse o un modelo con mayor razonamiento podrían cambiar las
decisiones, pero no garantizan resolver estos defectos del controlador.
