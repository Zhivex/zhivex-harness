# Cierre de implementación de la auditoría del harness

> Historical snapshot: findings and outcomes apply to the checkout and attempt
> recorded below. For the subsequent stable release outcome, see
> [current release evidence](../LIVE_CERTIFICATION.md#current-public-status).
> Later publication does not change failed evaluation results.

> Historical snapshot: versions, findings and measurements below describe the recorded run, not the current checkout. See the [report index](README.md) for follow-up work and the [documentation index](../README.md) for maintained guides.

Las correcciones pertenecen al harness y utilizan las versiones del SDK instaladas
(Core 1.14.0 / Agents 1.4.0). No se modificó el SDK ni se abrió una HU nueva.
La evidencia original permanece en `harness-audit-2026-09-09.json`; la nueva está
separada en `harness-remediation-2026-09-09.json`.

| Hallazgo | Implementación | Regresión principal |
| --- | --- | --- |
| H01 | Deadline y cancelación en aprobaciones/importación; lease renovable, revisión del estado, checkpoints y rollback de publicación | Cancelar antes, durante, después del verificador y durante publicación; conflicto/pérdida de lease |
| H02 | Apertura sin symlinks en toda la ruta, macOS y Linux | Intercalado de sustitución del ancestro; descriptor probe en Node/Bun macOS y Node Linux |
| H03 | Fuente completa de requisitos en metadata durable, `read_task`, plan acotado y continuidad entre turnos | Compactación real del SDK y aprobación/reanudación conservando criterio final y redacción |
| H04 | Límite agregado de búsquedas, continuación y límite por turno del perfil repair | Recorrer todas las páginas sin perder coincidencias; presupuesto serializado |
| H05 | Cobertura incompleta y motivos tipados de omisión | Archivo demasiado grande con única coincidencia no se presenta como ausencia concluyente |
| H06 | Instrucciones por catálogo/backend; búsqueda de archivo exacto | Herramientas ausentes no instruidas; memoria permitida por la política OCI |
| H07 | Audit privado por run sobrevive reacquisición | Registro previo conservado junto al parche OCI |
| H08 | Hashes de evidencia/solapamiento, observaciones de solo lectura y cupos de cierre durables | Inspeccionar no resetea duplicados; cambiar texto de consulta no oculta misma evidencia; reanudar no renueva cupos |
| H09 | `agentProfile: repair` compartido, CLI/config/resume y recuperación acotada | Perfil real con compactación, aprobación y recuperación de verificador |
| H10 | Captura privada de candidato; checkout y grading independiente | Digest, rutas, aislamiento del host y filtros Git externos rechazados |
| H11 | Diagnósticos tipados, herramientas solicitadas, etapas y tiempos | Fallos de parsing sin payload, ausencia de usage explícita y timings de fallo |

También se corrigió la pérdida de `maxSteps` entre rondas de aprobación. La
regresión observacional conserva `requestedMaxSteps=1` y ahora ejecuta una sola
petición al modelo. Agotar ese límite sigue siendo un resultado fallido, no éxito.

En el fixture de búsqueda de la auditoría, el resultado bajó de 310975 a 28618
caracteres (~90,8%), con paginación explícita. Es una reducción de ese payload,
no una medición de reducción general de tokens o mejora del score live.

## Validación y límites

Las pruebas ejercitan SDK publicado, stores, aprobación, snapshots, importación
y rollback reales; en las regresiones de cancelación se simula únicamente el
proceso OCI. El smoke OCI adicional usa Docker real y los smokes MCP usan el
servidor local, incluido el SDK oficial. El descriptor probe ejecuta el mismo
helper de producción en macOS y Linux.

La política repair es opt-in: `--agent-profile repair`, o `agentProfile: "repair"`.
El benchmark usa ese mismo perfil. El perfil strict sigue disponible. La nueva
estrategia cambia la huella de compatibilidad: no se reinterpreta una aprobación
pausada emitida por otro artifact/perfil.

Queda por medir eficacia con modelos reales: una campaña nueva debe congelar
fuentes, imágenes, catálogo, límites y preflight, hacer ablaciones y usar holdout
con repeticiones. No se ejecutaron nuevas llamadas pagas ni se modificaron scores
históricos. Las pruebas locales no establecen superioridad frente a un externo.

Los límites operativos se documentan en CONTEXT_ENGINEERING.md,
REPOSITORY_EDITING.md y EXTERNAL_COMPARISON.md: el presupuesto por fase no garantiza
una fracción exacta de tokens; el audit no es una transacción ACID de filesystem;
y la protección de lecturas no certifica todas las carreras de publicación.

## Resultado de los checks

- Suite completa: **485 tests, 0 fallos, 58 archivos**. Tras ajustar tipos de los
  fixtures, se repitieron las 23 regresiones de auditoría/verificador: todas verdes.
- TypeScript del producto, scripts modificados y nuevos tests: sin errores.
- Documentación, contratos públicos y firmas: pasan; el gate de preparación sigue
  mostrando su blocker de GA preexistente, no se declara un release GA.
- Migraciones publicadas 0.10.0/0.11.1: pasan. Evaluaciones determinísticas: **7/7**.
- Benchmarks CI de workspace y safe-fix e integridad de imagen: pasan.
- Smokes MCP controlado y SDK oficial: pasan con puertos locales autorizados.
- Smoke OCI real: pasa con Docker 29.7.2. Descriptor seguro: Node/Bun en macOS y
  Node 24 en Linux, sin red en el contenedor.
- Paquete reconstruido e instalado como consumidor Node/Bun: pasa para rc.13.
- `git diff --check`: sin errores. No se hizo commit, push ni publicación.

El comando compuesto `bun run check` llegó hasta MCP y encontró la restricción de
puertos del sandbox. Los smokes restantes se ejecutaron por separado con el
acceso local necesario; no se interpreta ese fallo del sandbox como suite verde
ni como defecto del producto. El smoke de paquete también necesitó acceso al
caché/directorio temporal de Bun.
