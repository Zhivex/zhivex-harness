# GA-01: corrección y validación

> Historical snapshot: findings and outcomes apply to the checkout and attempt
> recorded below. For the subsequent stable release outcome, see
> [current release evidence](../LIVE_CERTIFICATION.md#current-public-status).
> Later publication does not change failed evaluation results.

**GA-01 resuelto en el checkout local. GA continúa pendiente.**

El SDK calculaba una sola vez el máximo de salida al iniciar la invocación y lo
reutilizaba para el preflight de cada turno. Después de consumir 2 tokens volvía
a reservar 30.000, aunque quedaban 29.998; Meta y OpenAI fallaban antes de la
segunda llamada. Core 1.20.0 todavía presenta esa combinación.

El Harness conserva los guardrails durables y calcula el máximo de transporte
por llamada usando consumo observado y checkpoints persistidos. El consumo
observado cubre turnos que aún no aparecen en el store; la reanudación incorpora
el checkpoint sin sumar dos veces. Se conserva un máximo explícito más pequeño.
Se rechazan respuestas que exceden los límites antes de ejecutar sus herramientas.
Qwen y el camino de subagentes conservan su política de transporte existente.
Los límites siguen dependiendo del usage reportado por el proveedor; este cambio
no convierte estimaciones en una garantía de facturación.

Validación ejecutada:

- Reproducción original: Meta, OpenAI y Qwen completan dos turnos.
- Siete regresiones: máximo decreciente, agotamiento, máximo explícito,
  reanudación con aprobación y no ejecución de herramientas al exceder tokens.
- `bun run check`: salida 0; 527 tests, documentación, contratos, tipos,
  migraciones, evaluaciones, benchmarks, MCP, Docker y paquete instalado.
- Live aprobación/reinicio: Meta `muse-spark-1.2`, OpenAI `gpt-5.6-luna` y Qwen
  `qwen3.8-max` pasan, con una sola ejecución y entrada de journal.
- Live OCI: los tres proveedores pasan comando, inspección, aprobación e
  importación verificada al host.

La [evidencia estructurada](evidence/ga-budget-remediation-2026-09-19.json)
incluye hashes y delimita la secuencia de validación respecto de los últimos
ajustes. No es evidencia de un release protegido ni de publicación.

Pendientes: mejorar y reproducir la entrega de reparaciones descrita en
[el holdout de RC14](RC14_VALIDATION_2026-09-10.md), congelar una cohorte nueva,
completar la matriz representativa y reunir los gates de CI, revisión y release
sobre un candidato inmutable. No se modificaron esos criterios de aprobación.
