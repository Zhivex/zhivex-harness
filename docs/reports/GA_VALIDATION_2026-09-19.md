# Validación externa automatizada de GA — 19 de septiembre de 2026

**Veredicto: NO-GO para RC.14 / promoción a 1.0.0.** Se reproduce un bloqueo
funcional de los flujos de varios turnos de Meta y OpenAI con el presupuesto
predeterminado. La suite existente pasa, pero no detecta esta combinación.

Evaluador: Codex, actuando como validador externo automatizado por pedido del
operador. Este informe no es una firma humana, una auditoría integral de seguridad
ni evidencia de publicación. No se modificaron el runtime ni los criterios de GA.

## Identidad y reproducibilidad

- Commit: `28723ff3350b7572d5bd68f2d40b6feef1e0e6b4`.
- Versión: `1.0.0-rc.14`; Bun 1.4.0, Node 22.21.0, macOS arm64.
- Se exportó el commit con `git archive` y se instaló su lockfile con
  `bun install --frozen-lockfile --ignore-scripts` en una carpeta temporal aislada.
- El checkout original tenía dependencias desactualizadas y después recibió
  cambios concurrentes en `package.json`, `bun.lock` y `node_modules`. Los
  resultados definitivos proceden de la copia aislada; no certifican esos cambios.
- [Evidencia estructurada](evidence/ga-validation-2026-09-19.json): resultados,
  hash del tarball local, versiones, CI y diagnósticos sin contenido de proveedores.
- El tarball local pasó inspección de contenido e instalación independiente de
  esos mismos bytes. No tiene identidad de release protegida ni provenance npm.

## Resultados ejecutados

| Frontera | Resultado |
| --- | --- |
| `ZHIVEX_HARNESS_OCI_REQUIRED=1 bun run check` | PASS, salida 0 en copia aislada |
| Suite existente | 512/512 tests, 59 archivos |
| Docs, contratos de preparación, tipos de fuente y tooling | PASS |
| Migraciones históricas 0.10.0 / 0.11.1 | PASS |
| Evaluaciones determinísticas | 7/7 |
| Benchmarks de workspace y safe-fix scripted | PASS; no acreditan capacidad de modelos |
| MCP e interoperabilidad con SDK oficial | PASS |
| OCI real | PASS, Docker 29.8.0, secretos excluidos, red denegada e importación gobernada |
| Paquete instalado y tarball exacto | PASS |
| Auditoría de dependencias | BLOQUEADA: servicio de advisories npm HTTP 503, dos intentos |
| Scripts de dependencias no confiables | 0 |
| Gate formal `readiness:1.0:release` | FAIL: RC.14 incompleta, revisión pendiente, fase y versión sin promover |

La imagen OCI usada fue
`node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`.

| Prueba live de fuente aislada | Meta muse-spark-1.2 | Qwen qwen3.8-max | OpenAI gpt-5.6-luna |
| --- | --- | --- | --- |
| Aprobación, persistencia y reinicio | FAIL | PASS | FAIL |
| Orquestación, hijo persistido y reapertura | PASS | PASS | PASS |
| Ejecución OCI e importación al host | FAIL | PASS | FAIL |

Routing OpenAI → Qwen: PASS, una delegación y una herramienta del revisor.
Estos smokes usan las credenciales existentes y fixtures temporales; no son la
matriz representativa de un release protegido. Gemini no pertenece a la cohorte GA.

## Hallazgo GA-01 — P1 funcional: reserva de salida impide el segundo turno

Con `subagentProfiles: []`, Meta y OpenAI activan el presupuesto de transporte en
`src/harness.ts` (`createProviderCompatibleBudget`) y `src/runtime-policy.ts`.
La integración con Core 1.14.0 vuelve a exigir la reserva completa de salida en
el preflight del siguiente turno. La reserva no cabe después del primer consumo:

| Proveedor | Límite | Consumido | Reserva solicitada | Disponible | Resultado |
| --- | ---: | ---: | ---: | ---: | --- |
| Meta | 30.000 | 2 | 30.000 | 29.998 | GuardrailTriggeredError, etapa input |
| OpenAI | 30.000 | 2 | 30.000 | 29.998 | GuardrailTriggeredError, etapa input |
| Qwen, control | 30.000 | 4 al terminar | — | — | completed |

Se reprodujo sin red ni modelo real usando un primer turno `list_files` de dos
tokens y un segundo turno de finalización. También se observó el guardrail de
presupuesto de salida en diagnósticos adicionales de los fallos live de aprobación.
Los fallos live OCI tienen el mismo fingerprint; no se afirma una inspección
independiente de su causa interna.

Ejecutar desde un checkout con el lockfile del commit evaluado:

```sh
bun run scripts/validate-ga-budget.ts
```

La nueva prueba de aceptación sale con código 1 en el candidato evaluado; Qwen
actúa como control positivo. No se incluye silenciosamente como un test verde.
El script valida finalización, salida esperada, uso y ejecución de herramienta.
Debe pasar para los tres proveedores después de corregir la coordinación entre
presupuesto acumulado y reserva por llamada, manteniendo límites y aprobaciones.

## Evidencia remota y pendientes

La consulta actual de [CI del mismo commit](https://github.com/Zhivex/zhivex-harness/actions/runs/35458111045)
mostró ambos jobs de consumidores Node 22.13/24 verdes. Los jobs de tooling macOS
y Ubuntu fallaron en auditoría de dependencias; el log de Ubuntu confirma HTTP 503.
[CodeQL del mismo commit](https://github.com/Zhivex/zhivex-harness/actions/runs/35458110958)
pasó. La indisponibilidad de advisories no equivale a cero vulnerabilidades.

Para levantar el NO-GO se requiere:

1. Corregir GA-01 y repetir esta aceptación y los smokes live afectados.
2. Resolver la retención por entrega de reparaciones registrada en
   [la validación previa de RC.14](RC14_VALIDATION_2026-09-10.md), con una cohorte
   nueva y criterios predeclarados. Esta validación no la reejecutó ni la cerró.
3. Recuperar auditoría de dependencias y CI completos.
4. Certificar el candidato final inmutable: tag, artefacto, OCI, live y matriz
   representativa completa de 42 casos; verificar publicación y SLSA. No se
   despachó publicación ni se ejecutó esa matriz sobre un candidato ya bloqueado.
5. Completar la revisión de seguridad de todas las fronteras y herramientas del
   candidato final con la identidad exigida por la política vigente. El borrador
   de RC.13 no cubre RC.14 y este informe no sustituye su firma humana.
6. Sólo después, preparar versión `1.0.0`, fase `ready` y ejecutar el gate formal.

No se cambiaron estados del ledger, se declararon cero hallazgos de seguridad,
se crearon tags ni se publicó ningún paquete. La revisión completa de seguridad
queda pendiente, no aprobada por inferencia a partir de tests o CodeQL verdes.
