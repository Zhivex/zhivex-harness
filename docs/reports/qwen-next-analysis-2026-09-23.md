# Qwen Flash con SDK next publicado

Fecha: 2026-09-23. Continuación del [análisis inicial](qwen-flash-analysis-2026-09-22.md).
Resultado: **next corrige la pérdida de enlace/uso de hijos fallidos y el transporte
de recibos OpenAI; no resuelve la desviación de la tarea delegada por Qwen Flash**.
La publicación permanece bloqueada y el modelo sigue siendo Flash.

## Paquetes comprobados

Se consultaron los dist-tags del registry con Bun y se instalaron versiones
exactas en una copia temporal del mismo código Harness
`5b7273fd7e4edd36bfc1d1954a63138412d66c05`. No se modificaron `package.json`,
`bun.lock` ni `node_modules` del checkout principal.

| Paquete | Baseline | Next instalado |
| --- | --- | --- |
| agents | 1.8.0 | 1.9.0-next.1 |
| core | 1.22.0 | 1.23.0-next.1 |
| qwen | 0.15.0 | 0.15.1-next.0 |
| openai | 0.13.4 | 0.13.5-next.1 |
| meta | 0.2.6 | 0.2.7-next.0 |
| gemini | 0.12.1 | 0.12.2-next.0 |

Core quedó fijado también en overrides a 1.23.0-next.1 para evitar varias
resoluciones. Agents depende de `^1.23.0-next.1`; los providers admiten
`^1.23.0-next.0`, compatible con esa revisión del mismo prerelease.

El changelog de Core identifica el fix de hijos fallidos en
[15cd12e](https://github.com/Zhivex/zhivex-ai-sdk/commit/15cd12e).
La implementación instalada incluye observación de checkpoints, proyección del
hijo en errores y reconciliación por scope/runId. OpenAI incluye la selección de
protocolo por metadatos y validación de correspondencia llamada/resultado.
El `dist/index.js` de Qwen next es **idéntico byte por byte** al de 0.15.0:
su changelog sólo declara actualización de Core. Por tanto no hay un cambio del
adapter Qwen en ese entrypoint que corrija cómo el modelo redacta una delegación.

Versiones, hashes del entrypoint e integridades disponibles del registry se
conservan en la [evidencia JSON](evidence/qwen-next-analysis-2026-09-23.json).
Esta comprobación no equivale a una auditoría de provenance del release SDK.

## Reproducción de contabilización

El mismo [reproductor offline](../../scripts/diagnostics/reproduce-failed-child-accounting.ts),
sin modificaciones, produce:

| Invariante | Stable | Next |
| --- | ---: | ---: |
| Estados padre/hijo | failed/failed | failed/failed |
| Enlaces del padre | 0 | 1 |
| Tokens individuales sumados | 8 | 8 |
| Tokens agregados por el SDK | 3 | 8 |
| Herramientas ejecutadas del lote rechazado | 0 | 0 |

Resultado repetido con UsageLedger apagado y encendido. El guardrail permanece
activo y el fallo conserva su clasificación. La corrección no convierte la tarea
fallida en completada; repara su estado y consumo observables.

## Tres pruebas live Flash

Campaña acotada definida antes de ejecutarla: baseline, hijo directo, baseline.
Mismo fixture, prompts y presupuestos del análisis anterior. Sin reintentos
hasta obtener verde. Cada caso puede contener varias solicitudes HTTP.

| Caso | Resultado | Evidencia |
| --- | --- | --- |
| Baseline 0 | Falla | Padre cambia la tarea, omite marcador y añade system; hijo ejecuta list_files y después propone read_file + mutation_audit; límite 1, reserva acumulada 3 |
| Hijo directo 1 | Completa | Recibe la tarea exacta, ejecuta un read_file e incluye el marcador; 4.319 tokens |
| Baseline 2 | Falla | Padre cambia la tarea y omite marcador, esta vez sin system adicional; hijo ejecuta list_files y luego propone read_file + git_diff; límite 1, reserva acumulada 3 |

En ambos fallos el SDK next conserva un hijo failed enlazado. Al reabrir SQLite
en modo lectura y calcular el agregado con el SDK instalado, se obtiene:

- Baseline 0: padre 4.690 + hijo 3.656 = **8.346**, agregado 8.346.
- Baseline 2: padre 4.565 + hijo 3.529 = **8.094**, agregado 8.094.
- Ningún run con uso desconocido en esos agregados.

Todas las respuestas HTTP fueron 200/completed, los eventos finales de argumentos
del padre concordaron, no hubo compactación y el fixture quedó intacto. No se
alcanzaron los límites de tokens. Las reservas rechazadas no se ejecutaron.

El segundo fallo demuestra que añadir `system` no es condición necesaria para
la desviación: restringir ese campo por sí solo no garantiza preservar el alcance.
El problema que bloquea la orquestación sigue en la combinación de conducta del
modelo y contrato de delegación del Harness, que admite reescribir libremente
el prompt. No se ha demostrado una alteración del input por el parser del SDK.
Tres casos no permiten calcular una tasa de fiabilidad ni declarar GA.

## Compatibilidad OpenAI y pruebas offline

Primera ejecución de cinco archivos del Harness: **54 pass, 2 fail**. Los fallos
fueron fixtures nativos apply_patch que marcaban sólo el resultado como nativo,
mientras la llamada original no tenía ese metadato. El SDK nuevo rechaza esa
incoherencia con ConfigurationError antes del HTTP. Es una incompatibilidad del
fixture con el contrato nuevo, no evidencia de pérdida del recibo de función.

Sólo en la copia temporal se añadió a la llamada original el mismo
`providerMetadata.responsesToolType` que al resultado. Se mantuvieron todos los
assertions. Después se duplicó la prueba de transporte sin el middleware envelope,
verificando el payload raw correspondiente: función apply_patch/shell/computer y
ordinary_tool, éxito/error, generate/stream; además de apply_patch nativo explícito.

Resultado: **74 pass, 0 fail en seis archivos**; `bun run typecheck:tooling` aprobado.
Incluye orquestación, presupuesto de tokens, uso de error, recuperación de
diagnósticos y recibos OpenAI. La prueba sin wrapper confirma que el fix está en
el adapter publicado. La mitigación envelope del Harness sigue siendo compatible
y permanece en el checkout principal. No se hicieron llamadas live OpenAI, Meta
o Gemini ni la suite completa de publicación.

## Decisión y siguiente frontera

1. Consumir next ayuda: permite contabilizar correctamente los fallos y contiene
   el fix de recibos OpenAI. Una integración deberá fijar las versiones y migrar
   los dos fixtures nativos, ejecutar los gates completos y conservar evidencia
   de paquete instalado. Este experimento aislado no cambia el proyecto principal.
2. Actualizar dependencias no basta para desbloquear Qwen. La siguiente corrección
   debe preservar el contrato de tarea delegada y sus criterios de aceptación,
   con presupuestos visibles y rechazo estructurado de desviaciones. No aumentar
   herramientas ni quitar assertions para obtener un verde.
3. Validar esos cambios offline y con Flash antes de otra RC. No hay motivo para
   gastar en otra matriz completa de proveedores mientras el baseline de Qwen
   sigue fallando en este punto conocido.

La [HU de enlaces/uso](https://app.notion.com/p/3e4777b104f6812b9c5af2fab375bf67)
queda actualizada con verificación del consumidor desde registry y evidencia live.
No se cierra automáticamente: aún falta integrar las dependencias en Harness y
completar los criterios de entrega. La observación histórica del SDK stable se
conserva, pero ya no describe estos paquetes next.
