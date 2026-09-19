# Harness: implementación de la revisión completa

> Historical snapshot: versions, findings and measurements below describe the recorded run, not the current checkout. See the [report index](README.md) for follow-up work and the [documentation index](../README.md) for maintained guides.

Esta implementación continúa la [revisión del 10 de septiembre](./FULL_HARNESS_REVIEW_2026-09-10.md)
y conserva los cambios locales anteriores. La revisión original es evidencia
histórica; sus resultados no describen el runtime modificado.

## Cambios implementados

| Hallazgo | Resultado |
| --- | --- |
| F01: colisiones MCP | Registro central de nombres locales, incluso herramientas deshabilitadas; rechazo antes del ensamblado. |
| F02: reserva de cierre | Previsión del contexto completo, separación trabajo/cierre, contabilidad durable y rechazo de consumo desconocido. Cap de salida cuando el transporte lo admite. |
| F03: cierre dependiente del modelo | Controlador durable: candidato, verificador registrado, llamada automática por el flujo normal de aprobación, recuperación acotada y rechazo de finales sin verificar. |
| F04: alcance por lote | Cada `files[].path` normalizado se compara con el plan durante el cierre antes de leer. |
| F05: compacción que crece | Resumen acotado en el prompt; fuentes completas fuera del prompt, conservadas por la CLI en metadata. |
| F06: SSE incorrecto | Unión de líneas dentro de cada evento y correlación por id; rechazo de respuestas ambiguas o ausentes. |
| F07: deuda de tipos | `tsconfig.tooling.json` compila src/scripts/tests; corregidos los 200 diagnósticos originales e incluido el gate en `check`/CI. |
| F08: paquete incoherente | Baselines públicos incluidos, auditorías de desarrollo excluidas y enlaces internos comprobados contra los bytes del tarball. |

Se extrajeron módulos para controlador, checkpoints, registro de herramientas,
políticas y diagnóstico. El registro de comprobaciones relaciona propósito,
digest de argumentos, revisión, candidato y resultado. Una proyección acotada de
la tarea y el estado se añade automáticamente a cada petición real.

`runs inspect <runId>` muestra fase y consumo; `--json` añade diagnóstico y
manifest efectivo sanitizados. La reanudación conserva métricas acumuladas.
Las políticas del padre y los hijos comparten la misma factoría de presupuestos;
el manifest identifica sus diferencias y el entorno OCI también se propaga a
los grupos de revisión. Las pruebas comprueban consumo agregado de hijos.

Los rechazos tipados del verificador se pueden recuperar tanto en el import del
parche existente como en la transacción de edición y verificación. Cada intento
necesita autorización nueva. Los efectos parciales se reinspeccionan y siguen
siendo una obligación pendiente; una cancelación no importa el candidato.

## Límites explícitos

- La previsión de tokens es heurística. Qwen Responses no admite `maxTokens`:
  se conserva la ruta elegida y se expone `outputCapApplied: false`. Qwen Chat
  explícito sí recibe el cap. Qwen con razonamiento activo recibe un catálogo
  restringido con selección automática, porque rechaza herramientas forzadas
  por nombre. Los contratos se probaron con el adapter publicado y HTTP inyectado.
- Un checkpoint `running` abandonado no demuestra contabilidad completa después
  de una caída: se bloquea gasto nuevo. Una pausa de aprobación con contabilidad
  completa puede reanudarse. No se presenta persistencia de facturación como una
  transacción atómica con el proveedor.
- El propósito del verificador y su exit code no prueban cobertura semántica del
  requisito. La evaluación independiente sigue siendo necesaria.
- Los hijos gestionados directamente por el SDK usan los guardrails compartidos,
  pero no el scheduler de cierre del run principal. El manifest lo declara;
  no se afirma paridad de reparación entre todas las rutas del SDK.
- La API de compacción que devuelve un array conserva las fuentes por referencia
  dentro del proceso. Al serializar el array por separado, el consumidor debe
  conservar también `zhivexTaskSources`; la CLI ya lo hace.

## Evidencia y release

La validación abarca tests determinísticos, tipos estrictos, contratos,
migraciones, evaluación 7/7, benchmarks offline, MCP loopback y servidor oficial,
Docker real, build, consumidor instalado y comprobación del artefacto.
El gate completo pasó con 511 tests; después pasó la suite de 27 regresiones
con la transacción combinada añadida y el test de estado final del stream.
El tarball final pasó el control de contenido y enlaces internos.

Las trayectorias nuevas incluyen candidato temprano, pausa, denegación,
cancelación, corrección de un verificador fallido, final no verificado, escritura
parcial, uso desconocido, alcance por lote y SSE fragmentado/ambiguo.

Se midió OCI con 100 archivos de fixture, tres repeticiones y un calentamiento.
El primer comando tuvo p50 310,27 ms; seis comandos reutilizados tuvieron p50
112,71 ms. El escenario registró un inicio de contenedor, cuatro reutilizaciones,
cinco publicaciones y una exportación de workspace. Es una medición local
pequeña, no un p99 representativo ni una comparación causal con otro release.
[Resultado completo](../../benchmarks/baselines/oci-remediation-2026-09-10.json).

El [protocolo de experimentos](../../evaluations/repair-controller-experiment.json)
predeclara ablaciones de una variable, identidad del artefacto y una cohorte
nueva separada de las cinco tareas históricas. No se ejecutó una nueva campaña
live de modelos y no se afirma mejora de tasa de resolución a partir de mocks.

El registry público consultado sigue ofreciendo Core 1.14.0 y Agents 1.4.0;
la corrección local de herramientas desconocidas del SDK no tiene un artefacto
posterior publicado para integrar. Se mantienen esas dependencias verificadas.

La revisión humana de seguridad continúa pendiente en el ledger. Esta
implementación no cambia esa decisión ni certifica GA. El fingerprint de runtime
cambia: las aprobaciones pausadas del artefacto anterior necesitan ese artefacto
para terminarse o denegarse. No se hizo commit, push, tag ni publicación.
