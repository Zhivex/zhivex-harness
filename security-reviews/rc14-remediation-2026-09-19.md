# Verificación de correcciones — 2026-09-19

**Los cuatro hallazgos reproducidos pasan la aceptación local. GA sigue NO-GO.**
Evaluador: Codex, revisión técnica automatizada por delegación del operador.
Este documento complementa el dictamen original; no es una firma humana ni
certificación de un artefacto publicado.

Objeto: cambios locales sin commit sobre `28723ff3350b7572d5bd68f2d40b6feef1e0e6b4`,
versión `1.0.0-rc.14`, incluyendo la actualización de dependencias del checkout.
La [evidencia estructurada](../docs/reports/evidence/security-remediation-2026-09-19.json)
identifica los archivos por SHA-256 y conserva los resultados de aceptación.

| Hallazgo | Corrección y aceptación |
| --- | --- |
| SEC-04, alto | Identidad OCI ligada a workspace, estado y scope completo; metadata, runtime y patch usan esa identidad. No hay lectura cruzada mediante `runHarness`; cada dimensión del scope tiene regresiones de aislamiento, reanudación, importación y cleanup. Legacy sin scope se rechaza. |
| SEC-01, medio | Exclusión de escritores mediante SQLite fuera del repositorio, incluyendo importación y rollback. Una sola actualización acepta el digest compartido; regresiones entre procesos, muerte del propietario e importaciones OCI concurrentes pasan. |
| SEC-02, medio | `apply_reviewed_replacement` muestra contenido completo en la revisión predeterminada; texto nuevo visible incluso con texto anterior largo. |
| SEC-03, bajo | Inventario incluye `read_task` y `repair_plan`; la paridad ahora consulta sus herramientas reales. |

Validación: 519 tests de la suite completa sin fallos; después se añadió la
regresión de importaciones concurrentes y pasaron sus 30 tests de OCI/workspace.
Pasaron tipos, documentación, contratos de preparación, migraciones, evaluaciones,
benchmarks determinísticos, ambos smokes MCP y Docker real. El smoke del paquete
instalado detectó emisores distintos de declaraciones TS6/TS7; se corrigió para
usar el mismo compilador que el build y pasó al repetirse, junto a los tres tests
de firmas. `bun audit` terminó sin vulnerabilidades reportadas en 35 paquetes.

La actualización a Core 1.20.0 resuelve la incompatibilidad de dependencias con
Agents 1.8.0. TypeScript 7 compila; el alias de TypeScript 6 se limita a su Compiler
API para analizar firmas. El snapshot de firmas fue regenerado por los cambios
de declaraciones y política; su coincidencia no acredita por sí sola ausencia de
cambios semánticos en dependencias.

Límites: el bloqueo coordina escritores Harness en Linux/macOS, no programas
arbitrarios del mismo usuario ni escrituras atómicas multifichero ante pérdida de
energía. El host, daemon e imagen siguen siendo de confianza. La migración de
snapshots se documenta en `docs/EXECUTION_ENVIRONMENTS.md`; no se adopta estado
antiguo sin scope. Los contratos de ejecución y las aprobaciones pausadas cambian
deliberadamente con la nueva política.

Pendientes para GA:

1. Demostrar entrega fiable tras los cambios de recuperación. GA-01 ya tiene
   corrección y regresión de dos turnos para los tres proveedores, documentadas
   en [la remediación de presupuesto](../docs/reports/GA_BUDGET_REMEDIATION_2026-09-19.md).
   La serie de desarrollo v3 resolvió 1/3 casos con OpenAI y 0/3 con Qwen, frente
   a 3/3 por proveedor en el control. No satisface la aceptación de GA.
2. Repetir certificación live y la cohorte representativa/holdout sobre el candidato
   corregido; los resultados históricos no certifican estos cambios.
3. Obtener CI y release protegidos, artefacto inmutable, publicación y provenance;
   revisar ese candidato final y satisfacer el gate formal de GA.

No se publicó, etiquetó ni declaró GA este checkout.

Actualización local: las correcciones anteriores quedaron en el commit
`41bd1cb4ab8481a7413f096a0817f612fe9806fe`. La revisión posterior del diagnóstico
de verificadores y sus tests está todavía en el working tree. Las cuatro pruebas
adversariales y el control de digest obsoleto vuelven a pasar; la suite completa
actual tiene 533 tests correctos. El diagnóstico se entrega sólo como resultado
no confiable de herramienta, redactado y limitado a 2048 caracteres por canal;
el error genérico y la proyección de telemetría siguen omitiéndolo. La redacción
por patrones no garantiza eliminar cualquier dato de negocio que un comando
aprobado imprima. No equivale a aceptación live ni revisión de artefacto final.

## Revalidación del candidato actual

Sobre el commit `c2b2bb917d0471e61afc5f731a61c00b44fa3731`,
`bun run scripts/validate-security-review.ts` vuelve a terminar con código 0:
SEC-01, SEC-02, SEC-03, SEC-04 y el control de digest obsoleto pasan.
La [evidencia actual](../docs/reports/evidence/security-current-2026-09-19.json)
conserva los resultados y hashes de fuente. Las correcciones posteriores
referidas antes como working tree ya están incluidas en este commit.

Dictamen: los cuatro hallazgos conocidos están corregidos en la aceptación
local. Esto no acredita ausencia de otros defectos ni constituye firma humana.
La suite completa registrada para este candidato tiene 555 tests correctos;
la nueva ejecución aquí documentada es la aceptación adversarial focal.

GA sigue NO-GO. La serie de desarrollo v8 obtuvo Harness 0/1 frente a control
1/1 con Qwen; todavía falta entrega fiable, la corrección del SDK publicada y
consumida por el candidato, cohorte representativa y holdout fresco, CI/release
protegidos y revisión del artefacto final. Véase el
[informe de recuperación](../docs/reports/GA_REPAIR_RECOVERY_2026-09-19.md).
