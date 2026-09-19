# Revisión integral del harness y del trabajo acumulado

> Historical snapshot: versions, findings and measurements below describe the recorded run, not the current checkout. See the [report index](README.md) for follow-up work and the [documentation index](../README.md) for maintained guides.

Revisión del 10 de septiembre UTC / 9 de septiembre de 2026 en Argentina.
Base Git: `0a7b69dddaa70a54b6b5b4097691c8112d4d76eb`, versión declarada
`1.0.0-rc.13`, incluyendo los cambios locales existentes. Antes de esta revisión
había 72 entradas modificadas/no rastreadas. La versión del package.json no
identifica por sí sola estos nuevos bytes como el RC13 publicado.

**Conclusión:** la base de ejecución gobernada está más desarrollada que el
control del proceso de reparación. El siguiente avance debe convertir candidatos
en entregas verificadas dentro del presupuesto, preservando las aprobaciones.
También hay defectos concretos de integración y una brecha en la validación de
scripts que conviene cerrar antes de otra certificación.

## Historial reconstruido

Se revisaron Git, los informes locales, el historial disponible de «Revisar
eficiencia del harness», «Evaluar harness contra HUs» y «Revisa y corrige HU del
harness», y notas históricas de las auditorías de seguridad y releases.

| Etapa | Trabajo realizado | Implicación actual |
| --- | --- | --- |
| 16–18 de agosto | Edición ligada a digests, aprobaciones, operaciones durables, aislamiento OCI y publicación verificable | Son garantías centrales que deben conservarse al mejorar eficacia. |
| 20–22 de agosto | Consola multiproveedor, delegación, migración Node-first, hardening de archivos y release | El alcance ya supera un simple loop de herramientas; requiere pruebas de integración entre subsistemas. |
| RC1–RC6 | Diagnóstico de fallos previos a publicación y evidencia correlacionada/sanitizada | Un gate determinístico verde no demostraba ejecución live ni publicación. |
| RC7–RC13 | Correcciones progresivas, cohortes certificadas y preparación de revisión humana | El ledger local registra RC13 exitoso y mantiene abierta la revisión de seguridad GA. No se reconsultaron Actions/registry en esta auditoría. |
| 8–9 de septiembre | Lecturas concurrentes, búsqueda por lotes, navegación retenida, memoria de tarea, edición por reemplazos, recuperación y perfil repair | Son cambios locales posteriores a la evidencia del artefacto RC13; no heredan automáticamente su certificación. |
| Última comparación Qwen | 0/10 entregas frente a 4/10 de mini; tres candidatos correctos sin entregar | La pérdida entre edición y cierre es prioritaria. Son cinco tareas conocidas repetidas, no evidencia de generalización. |

El último arreglo del SDK para herramientas no registradas fue implementado y
validado **localmente en el SDK**, según el hilo consultado; el cierre del hilo
declara que no hubo commit, push ni publicación. El harness sigue fijando Core
1.14.0/Agents 1.4.0. No debe darse esa recuperación por integrada aquí.

## Defectos reproducidos y prioridades

### F01 — P1: MCP puede sustituir las herramientas de memoria

En `src/harness.ts:900` se rechazan colisiones con workspace, ejecución y skills,
pero no con `createTaskTools()`. El merge posterior permite que un MCP configurado
con `read_` + `task`, o `repair_` + `plan`, reemplace silenciosamente la herramienta
local. El reproductor devuelve el resultado del cliente MCP en ambos casos;
`read_file` se rechaza correctamente como control.

Impacto: confusión de identidad, pérdida de recuperación de requisitos y posible
contaminación del plan. Requiere un MCP configurado con ese nombre/prefijo. No se
demostró evasión de aprobaciones ni del aislamiento OCI; OCI rechaza MCP.

**Cambio:** construir un único registro con nombres reservados antes del merge,
comprobar colisiones de todos los grupos y vincular la clasificación de resultados
a su origen, no solamente al nombre. Aceptación: los tres casos se rechazan antes
de exponer herramientas al modelo.

### F02 — P1: el presupuesto de cierre no está reservado

`src/model-budget.ts:11` verifica uso acumulado antes de llamar, pero no estima
la siguiente petición ni separa recursos para cierre. `repair-progress.ts` limita
ciertas llamadas al superar el 70%; eso no reserva tokens. El reproductor previo,
reejecutado aquí, consume los 30.000 tokens restantes en tres peticiones ordinarias
y deja **cero** para verificar. Una respuesta también puede superar el límite.

**Cambio:** presupuesto de trabajo y cierre separado, previsión de petición
completa y margen de salida/recuperación. Persistir la contabilidad del transporte,
incluida su completitud, en lugar de reconstruirla exclusivamente desde
`state.usage` (`src/harness.ts:1437`). Probar agotamiento y reanudación sin conceder
presupuesto nuevo ni convertir uso desconocido en cero.

### F03 — P1: falta un controlador durable de reparación

`runHarness` retorna cuando el SDK termina sin aprobaciones pendientes
(`src/harness.ts:1565`). El cierre especial solo interviene cuando el modelo ya
solicitó una herramienta terminal y el operador la aprobó. Registrar un plan
marca fase `repair` aunque no exista reproducción ni edición.

**Cambio:** estados basados en evidencia: exploración, reproducción, candidato,
verificación pendiente, importación pendiente y entrega. Una revisión del candidato
invalida comprobaciones anteriores. El controlador debe preparar el próximo paso
y conservar un resultado incompleto si no puede avanzar; nunca inventar aprobación
ni asumir que un texto de éxito equivale a reparación. Mantener tareas de análisis
sin edición como una finalización legítima.

### F04 — P2: el alcance del plan no cubre lecturas por lote

`src/repair-progress.ts:60` consulta `input.path`; `read_files` usa
`files[].path`. El mismo archivo fuera del plan se bloquea en una lectura individual
y se devuelve en un lote. Reproducción revalidada. Es una incoherencia de estrategia,
no una evasión de los controles de acceso del workspace.

**Cambio:** extracción/normalización de paths por schema real; aplicar el mismo
criterio a lotes, archivos y búsquedas. Separar llamadas de cantidad de evidencia.

### F05 — P2: la compacción manual puede ampliar el contexto

`src/compaction.ts:167` añade el resumen y reinserta completas todas las solicitudes
del usuario. En veinte solicitudes sintéticas, pasa de **190.271 a 192.826 caracteres**.
Esta ruta se usa en `/compact` y cambios de proveedor/modelo; no debe confundirse
con el resumen automático del SDK.

**Cambio:** conservar íntegros los requisitos fuera de la ventana, con una
proyección acotada del objetivo activo, restricciones y referencias. Mostrar bytes
o tokens estimados antes/después en `/compact`; no inferir reducción por contar
mensajes. Probar requisitos largos y múltiples cambios de modelo.

### F06 — P2: el parser SSE de MCP elige la última línea de datos

`src/mcp.ts:361` toma la última línea `data:` y luego exige que su id coincida con
la petición. Con una respuesta a `tools/list` seguida de una notificación, el
cliente rechaza el cuerpo por id incorrecto aunque la respuesta esperada estaba
presente. Reproducido con `Response` inyectadas, sin servidor ni red.

**Cambio:** procesar eventos completos y seleccionar la respuesta por id, con
notificaciones separadas y límites de tamaño/tiempo. Añadir pruebas de eventos
múltiples, datos multilínea, fragmentación y cancelación. No se certificó aquí la
compatibilidad completa del protocolo.

### F07 — P2: scripts y tests quedan fuera del typecheck habitual

`tsconfig.json:18` incluye solo `src/**/*.ts`. Las 485 pruebas pasan con Bun, pero
compilar también `scripts/**/*.ts` y `tests/**/*.ts` bajo las mismas opciones
estrictas produce **200 diagnósticos en 37 archivos**: 114 en scripts y 86 en tests.
Hay errores en benchmarks, diagnósticos de release y verificación de registry.
Esto demuestra deuda de tipos, no 200 fallos funcionales.

**Cambio:** tsconfig separado para tooling/tests, manteniendo la declaración del
paquete limitada a src. Corregir gradualmente la deuda y hacer obligatorio el gate
de scripts de release. Evitar silenciarla globalmente con `any` o `@ts-nocheck`.

### F08 — P2: el artefacto puede aprobar con referencias internas rotas

El tarball reconstruido pasó `artifact:check`, pero incluye auditorías TypeScript
que importan `../../src` mientras `src` no se publica. Incluye también informes
que enlazan baselines bajo `benchmarks`, directorio excluido del paquete.

**Cambio:** definir qué evidencia acompaña al consumidor y qué vive en GitHub;
publicar las dependencias documentales necesarias o usar referencias a una revisión
inmutable. Comprobar enlaces internos dentro del tarball y excluir reproductores
de desarrollo no ejecutables en ese artefacto. No se detectaron secretos en este
fixture; el hallazgo es coherencia de empaquetado.

## Mejoras de arquitectura y operación

| Área | Diagnóstico | Siguiente paso y aceptación |
| --- | --- | --- |
| Verificación | El verificador exige salida cero e identidad del parche; no prueba que el comando compruebe el requisito. La recuperación terminal está especializada en `verify_and_apply_environment_patch`. | Recibos con propósito, argv, revisión y evidencia acotada; recuperación uniforme donde corresponda. Mantener evaluación independiente y rechazo de drift. |
| Memoria | `read_task` conserva requisitos, pero recuperarlos sigue dependiendo del modelo; el compactor pierde la aserción del check aunque conserve exitCode. | Proyección automática de restricciones activas, hipótesis, candidato y próximo check; enlaces a recibos completos. |
| Herramientas/contexto | Catálogo estático; estimación de compacción basada en mensajes/caracteres sin el catálogo completo. | Ablación con catálogo mínimo y previsión del contexto completo. Mantener consistencia de llamadas históricas y aprobaciones. |
| Orquestación | Subagentes se construyen por otra ruta y `runHarnessReviewGroup` llama al SDK directamente; no pasan por el wrapper repair del padre. | Factoria común de políticas, manifests efectivos por rol y pruebas de consumo agregado. No extrapolar resultados del benchmark sin subagentes a toda la orquestación. |
| Observabilidad | Las métricas repair se entregan por callback final; la CLI no proporciona `onDiagnostics`. Contabilidad y eventos útiles para benchmarks no están igualmente disponibles al operador. | Resumen durable y sanitizado por run con consumo, fases, candidato, verificación y causa de detención; inspección después de reiniciar. |
| OCI | La cohorte histórica atribuye 34,8% del tiempo instrumentado de comandos a creación/exportación, no de toda la tarea. | Medir sesión por ejecución lógica y sincronización incremental, manteniendo leases, límites, cancelación e integridad. Prioridad posterior al cierre. |
| Mantenibilidad | `cli.ts` tiene 3.259 líneas; ejecución 2.110; harness 1.641; workspace 1.525. Hay lógica de estado/aprobación repartida entre rutas. | Extraer controlador de run, transacción de cierre y ensamblado de herramientas tras asegurar regresiones; evitar un refactor general simultáneo a cambios de conducta. |
| Evaluación | Los gates mecánicos pasan; la última cohorte de cinco tareas conocidas no mejora entregas. | Ablaciones de una variable, trayectorias difíciles determinísticas y luego tareas nuevas. Métrica principal: entrega aceptada dentro de presupuesto; candidato correcto como diagnóstico separado. |

## Qué conservar y qué falta para release

Se inspeccionaron controles de filesystem, ejecución de procesos, OCI, propuestas,
leases de cierre, operaciones/sesiones/backup, perfiles, MCP, proveedores,
orquestación, contratos y CI. Lecturas por descriptor, rechazo de cambios obsoletos,
aprobación ligada al payload, importación separada, cuarentena, ámbito durable y
provenance son fundamentos útiles. No deben relajarse para aumentar un score.

La revisión humana sigue pendiente en el ledger local y el gate de preparación lo
confirma. Este informe no sustituye esa revisión. Los cambios locales de runtime,
autoridad y dependencias necesitan un candidato nuevo con evidencia propia antes
de GA; no basta actualizar la documentación de RC13.

No se volvieron a ejecutar llamadas a proveedores, Docker, MCP con servidor real,
instalación de consumidor, auditoría de dependencias en red ni verificación remota
de publicación. La evidencia histórica de esas superficies sigue identificada
como histórica, no como validación del turno actual.

## Validación ejecutada

- `bun --no-env-file test`: 485 pass, 0 fail, 2.923 aserciones, 58 archivos.
- Typecheck de src, documentación, contratos, build y migraciones: pasan.
- Evaluación determinística: 7/7; no representa calidad live del modelo.
- Reproductor arquitectónico anterior: vuelve a confirmar alcance por lote,
  reserva cero y pérdida de la aserción del verificador. Sus once hashes de
  fuentes/evidencia coinciden con el checkout revisado.
- Reproductor nuevo: colisiones MCP, compacción manual y selección de evento SSE;
  typecheck estricto propio aprobado. Solo clientes/modelos simulados y temporales.
- Empaquetado con Bun y `artifact:check`: pasan para el tarball local de revisión.
- Typecheck ampliado: falla con los 200 diagnósticos indicados, fuera del gate actual.
- `git diff --check`: pasa. No se modificó código del runtime ni se hizo commit/push.

Reproductor nuevo: `../../evaluations/audits/full-review-2026-09-10.ts` (source checkout).
Evidencia y hashes: [full-harness-review-2026-09-10.json](../../benchmarks/baselines/full-harness-review-2026-09-10.json).

## Orden recomendado

1. Corregir F01 y F04, acotar tooling/artefactos y conservar regresiones precisas.
2. Implementar controlador de cierre y reserva durable juntos; probar candidato
   temprano, reinicio, aprobación tardía, cancelación y verificador fallido.
3. Cambiar memoria proyectada y catálogo en experimentos separados; corregir
   compacción manual y parser MCP sin mezclar sus resultados con el experimento.
4. Integrar el SDK cuando exista artefacto publicado verificable; medir la mejora
   propia del harness sin esperar que esa corrección resuelva el cierre.
5. Congelar configuración, medir desarrollo y una cohorte nueva, consolidar los
   cambios en unidades revisables y certificar el siguiente candidato.
