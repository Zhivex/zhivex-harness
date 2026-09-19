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
