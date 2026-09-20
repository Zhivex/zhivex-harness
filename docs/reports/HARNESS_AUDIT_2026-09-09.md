# Auditoría integral del harness — 2026-09-09

> Historical snapshot: findings and outcomes apply to the checkout and attempt
> recorded below. For the subsequent stable release outcome, see
> [current release evidence](../LIVE_CERTIFICATION.md#current-public-status).
> Later publication does not change failed evaluation results.

> Historical snapshot: versions, findings and measurements below describe the recorded run, not the current checkout. See the [report index](README.md) for follow-up work and the [documentation index](../README.md) for maintained guides.

> Estado posterior: los once hallazgos tienen implementaciones y regresiones locales.
> Ver [cierre de implementación](HARNESS_REMEDIATION_2026-09-09.md).
> El cuerpo de este documento y el baseline original conservan la evidencia previa;
> sus ubicaciones de líneas son históricas y los resultados no describen el código corregido.

La revisión encontró problemas adicionales a la adaptación de Qwen. Los más
urgentes son la cancelación de la ruta terminal, una carrera en la validación de
directorios y la pérdida de requisitos durante la compactación. No hay evidencia
para atribuir estos hallazgos al SDK nuevo.

El análisis cubre el checkout de `1.0.0-rc.13`, incluido el trabajo local sin
commit, con Core 1.14.0, Agents 1.4.0 y Qwen 0.11.4. No se modificó código de
producción. Se añadieron un reproductor local y evidencia; no se hicieron llamadas
nuevas a modelos, publicación ni cambios en servicios externos.

## Alcance y método

Se inspeccionaron las fronteras entre instrucciones, herramientas, SDK, contexto,
OCI, aprobaciones, persistencia, CLI, orquestación, telemetría y evaluación. Se
revisaron también los contratos de seguridad y los gates locales de CI/release.
Esto es una auditoría de superficies y riesgos, no una certificación de todas las
líneas, plataformas o condiciones concurrentes del producto.

- **466 pruebas existentes:** pasaron, sin fallos.
- **7 evaluaciones determinísticas:** pasaron; usan modelos simulados.
- Typecheck de producción, contratos y migraciones publicadas 0.10.0/0.11.1: pasaron.
- Reproductor de auditoría: ejecutado y validado con TypeScript por separado.
- El contrato de preparación sigue declarando abierto el gate de revisión de seguridad.
- La evidencia live consultada es la matriz Qwen anterior de diez intentos; no se repitió.
- No se revalidaron servicios MCP externos, el paquete publicado, CI remoto ni OCI real en esta auditoría.

Reproducción local sin credenciales ni Docker:

```sh
bun --no-env-file run evaluations/audits/harness-review-2026-09-09.ts
```

El `../../evaluations/audits/harness-review-2026-09-09.ts` (source checkout) sólo escribe
fixtures temporales que elimina al terminar. La [evidencia estructurada](../../benchmarks/baselines/harness-audit-2026-09-09.json)
registra observaciones, versiones y hashes. No es una suite que obligue a conservar
los defectos: después de corregirlos deben cambiar las observaciones y agregarse
regresiones con el comportamiento deseado.

## Hallazgos priorizados

| ID | Prioridad | Hallazgo | Evidencia | Responsable |
| --- | --- | --- | --- | --- |
| H01 | P1 | La importación terminal puede ejecutarse después de cancelar | Reproducido | Harness |
| H02 | P1 condicional a mutación concurrente | Una lectura puede seguir un directorio padre sustituido | Reproducido con intercalado controlado | Harness/filesystem |
| H03 | P1 | La compactación elimina criterios de aceptación del objetivo | Reproducido | Harness/contexto |
| H04 | P2 | Búsquedas válidas pueden producir más de 300.000 caracteres | Reproducido | Harness/herramientas |
| H05 | P2 | Búsqueda incompleta se presenta como ausencia de coincidencias | Reproducido | Harness/herramientas |
| H06 | P2 | Las instrucciones y el catálogo de herramientas no coinciden | Código y fixture | Harness/driver |
| H07 | P2 | Readquirir OCI pierde el historial visible de mutaciones | Reproducido | Harness/OCI |
| H08 | P2 | El control de exploración no representa el progreso de reparación | Código, fixture y matriz live | Harness/estrategia |
| H09 | P2 | Las mejoras del driver no equivalen a mejoras activas en CLI | Código | Harness/producto |
| H10 | P2 | La evaluación pierde los parches candidatos y etapas intermedias | Código y resultados | Harness/evaluación |
| H11 | P2 | La telemetría no permite cerrar ciertas causas de fallo ni tiempos | Código y matriz live | Harness/observabilidad |

### H01 — Cancelación omitida en la ruta terminal

`src/harness.ts:1030`, `:1054`, `:1098`, `:1472`.

`executeTerminalReceiptTool` readquiere el entorno y construye un
`ToolExecutionContext` sin propagar el `abortSignal` del llamado. `runHarness`
tampoco vuelve a comprobarlo después de resolver la aprobación y antes de tomar
esta ruta. Se sale del circuito normal del SDK para ejecutar e importar.

La prueba canceló la señal dentro del resolver de aprobación, antes de devolver
la respuesta. Resultado: `status=completed`, una ejecución, sin señal en el runtime
e importación efectiva del archivo de prueba. El verificador fue simulado; las
aprobaciones, snapshots, journal y escritura del host fueron los reales del harness.

Alcance: ruta opt-in `terminalReceiptTools`, usada por el benchmark y disponible
en la biblioteca. No demuestra que toda cancelación de la CLI falle.

Corrección: propagar señal y deadline, comprobar cancelación antes de ejecutar y
antes de importar, y mantener la finalización de estado bajo las mismas garantías
de cancelación/concurrencia del circuito ordinario. Validar cancelación antes,
durante y después del verificador; ninguna debe producir una importación posterior.

### H02 — El descriptor protege la hoja, no toda la ruta

`src/workspace.ts:478`, `:508`; `src/file-security.ts:45`.

Se validan ancestros con `lstat`, pero después se abre una ruta absoluta. El
`O_NOFOLLOW` usado al abrir protege la hoja; un ancestro puede haber cambiado.
La prueba sustituye el directorio padre por un symlink después de `safePath` y
antes de la lectura real. Se devolvió el sentinel externo como si perteneciera a
`parent/fixture.txt` dentro del workspace.

Es un intercalado determinístico mediante instrumentación del objeto de prueba,
no una medición de probabilidad de explotación. Requiere otro actor capaz de
modificar el directorio durante la operación; un symlink estático sigue siendo
rechazado. No se usaron secretos ni se demostró escritura externa.

Corrección: ligar la resolución completa a directorios confiables y a descriptores
(o un mecanismo equivalente soportado por plataforma). Repetir `lstat` antes o
después no cierra por sí solo la carrera. Auditar también lecturas de contexto y
operaciones de publicación que combinan validación de padres con uso posterior de
rutas. No marcar estas otras superficies como explotadas sin reproducirlas.

### H03 — La memoria conserva ubicaciones, pero pierde la tarea

`src/compaction.ts:18`, `:75`, `:89`, `:163`; `src/harness.ts:694`.

El primer objetivo se recorta a 768 caracteres y los mensajes de seguimiento a
512. Se trata de un prefijo, no de una extracción semántica de requisitos. Un
objetivo de 1.589 caracteres perdió el criterio final `MANDATORY_ACCEPTANCE` al
compactar. Las compactaciones siguientes sólo pueden conservar lo que sobrevivió.
El SDK invoca el compactor sobre el prefijo que reemplazará; el texto completo del
objetivo no queda garantizado en el contexto enviado al modelo.

Además, se conservan códigos de salida de checks sin toda su asociación a comandos,
aserciones y revisión probada. Un historial de `exitCode=0` no permite reconstruir
por sí solo qué comportamiento fue validado. Los recibos durables son otra fuente;
no deben confundirse con esta memoria.

Corrección: mantener objetivo, restricciones y criterios activos separados del
historial comprimible; ofrecer recuperación controlada del pedido original y una
memoria de trabajo con hipótesis, decisiones, cambios y comprobaciones asociadas.
Probar requisitos ubicados al final, cambios de objetivo, varias compactaciones
y continuidad luego de aprobaciones. No aumentar simplemente el límite global.

### H04 — Se limita el número de resultados, pero no su costo agregado

`src/workspace.ts:855`, `:937`; `src/harness.ts:369`, `:688`.

Una búsqueda legal de 500 coincidencias devolvió **310.975 caracteres**. Las
lecturas ya tienen límites de contenido de 16.000/32.000 caracteres, pero búsquedas
repiten texto, path y digest en cada coincidencia sin un presupuesto equivalente.
El modelo puede recibir un payload grande de golpe. La estimación de compactación
usa caracteres de mensajes divididos por cuatro; no incluye las definiciones de
herramientas y no garantiza un límite exacto de tokens del proveedor.

Corrección: presupuesto agregado por respuesta y por turno, paginación con aviso
de cobertura, menos repetición de metadata y catálogo de herramientas por fase.
Medir tokens reales; no traducir mecánicamente los caracteres a tokens facturados.

### H05 — Cero coincidencias no implica búsqueda completa

`src/workspace.ts:891`, `:970`.

Las búsquedas de directorio descartan errores de lectura. Con un archivo de más de
1 MiB que contenía el marcador buscado, el resultado fue `matches=[]` y
`truncated=false`, sin contador de archivos omitidos. El límite de lectura es
razonable; la falsa impresión de cobertura completa no lo es.

Corrección: informar archivos inspeccionados/omitidos y motivos tipados, con
`incomplete` independiente de la truncación por cantidad de coincidencias. La
búsqueda por archivo exacto debe mantener sus errores explícitos.

### H06 — Instrucciones que no corresponden a las herramientas activas

`src/harness.ts:154`, `:369`; `scripts/swebench/zhivex-driver.ts:51`, `:75`.

El benchmark selecciona nueve herramientas, pero reutiliza instrucciones que
ordenan inspeccionar `mutation_audit` y mencionan `git_diff`, `load_skill`,
`apply_patch` y `run_check`. Varias no están disponibles. El prompt indica usar
rutas relativas y después introduce `/workspace`; las descripciones de herramientas
no explican uniformemente la diferencia entre ruta de herramienta y cwd del shell.
La matriz muestra errores ENOENT iniciales, pero no conserva sus argumentos:
no se puede atribuir esos errores concretos a esta ambigüedad.

En el harness normal, `search_files` sólo acepta directorios aunque la guía general
recomienda buscar en el archivo exacto. El fixture falla con `search_files` y
funciona con `search_many` sobre ese mismo archivo.

Corrección: generar instrucciones a partir del catálogo y backend efectivos,
unificar contratos de búsqueda y dar ejemplos breves de rutas válidas. Validar que
cada instrucción ejecutable tenga una herramienta disponible.

### H07 — El journal durable y mutation_audit cuentan historias distintas

`src/execution-environment.ts:1677`; `src/workspace.ts:442`, `:1006`;
`src/harness.ts:486`.

Cada adquisición crea otra instancia de `Workspace`, cuyo audit es un array en
memoria. Tras editar y readquirir la misma sesión OCI: entradas de audit **1 → 0**,
pero el parche conservaba una entrada. Esto ocurre dentro del flujo de un run;
no requiere reiniciar toda la aplicación.

No demuestra pérdida del journal de ejecución del SDK ni del parche. Demuestra
que la herramienta de audit no reconstruye la historia que el modelo y la
documentación esperan consultar al final.

Corrección: reconstruir por run desde eventos persistidos o mantener un registro
ligado a la sesión durable. Distinguir las ediciones directas de los cambios hechos
por comandos y probar continuidad a través de varias aprobaciones.

### H08 — El contador de duplicados no mide estancamiento

`src/repair-progress.ts:28`, `:34`; baseline Qwen actualizado.

El controlador borra su memoria ante toda herramienta fuera de la lista de lecturas.
Eso incluye `inspect_environment_patch`, que es de sólo lectura. Alternar cuatro
lecturas idénticas con esa inspección produjo cero duplicados y cero supresiones.

La fase de cierre bloquea listados y búsquedas en la raíz; permite distintas
lecturas, búsquedas en directorios y exploración vía shell. En la matriz se activó
en cuatro intentos, bloqueó una llamada y no evitó cuatro agotamientos de presupuesto.
No existe una reserva rígida del 30% ni una transición obligatoria hacia un parche.

Corrección: invalidar sólo por posibles efectos reales, detectar solapamiento y
progreso semántico, y asignar presupuestos a explorar/reproducir/editar/verificar.
No bloquear una lectura necesaria para corregir con seguridad ni ejecutar cambios
sólo porque se agotó el tiempo de exploración.

### H09 — Driver experimental y producto tienen políticas distintas

`src/harness.ts:966`, `:1345`; `scripts/swebench/zhivex-driver.ts:38`, `:93`.

La recuperación de schemas, el middleware de presupuesto de transporte y el
control de progreso se habilitan en el driver. El runtime ordinario mantiene
`stopOnError=true`, recuperación terminal deshabilitada por defecto y no instala
el controlador de progreso automáticamente. Compactación v3 y herramientas nuevas
sí están compartidas.

Es una elección conservadora explícita, no un bug del SDK. Pero impide presentar
el comportamiento de la corrida como el comportamiento general de la CLI.

Corrección: perfiles de política explícitos, versionados y comprobables, con
recuperación acotada por clase de error. Mantener denegaciones, límites, cancelación
y errores de integridad como fronteras estrictas. Validar el mismo perfil desde
la CLI, biblioteca y evaluación antes de habilitarlo por defecto.

### H10 — La métrica final oculta dónde se perdió la reparación

`scripts/swebench/run.py:214`; `mini_driver.py:101`;
`zhivex-driver.ts:109`.

Mini exporta el diff existente de su contenedor incluso tras terminar por límites.
Zhivex entrega el diff del host, que sólo recibe cambios mediante importación
verificada. Después borra el directorio de estado, incluido el snapshot candidato.

El score 0/5 frente a 2/5 sigue describiendo los resultados de esas dos políticas
completas. No aísla calidad de razonamiento, calidad del parche candidato, costo
adicional de gobierno ni el efecto del SDK. **Un diff exportado vacío no permite
concluir que el agente nunca editó dentro de OCI.** Las llamadas de shell pueden
editar; la telemetría proyectada no permite reconstruir siempre su intención.

Corrección: conservar separadamente candidato, verificado e importado; registrar
etapas alcanzadas; evaluar el candidato en un entorno independiente después de
terminar, sin importarlo ni mostrarle tests ocultos al agente. Mantener el score
oficial de reparación segura y añadir un diagnóstico comparable de capacidad.
Usar holdout nuevo y varias repeticiones una vez congelada cada variante.

### H11 — Telemetría insuficiente para atribución y rendimiento

`scripts/swebench/telemetry.ts`; `zhivex-driver.ts:111`, `:126`;
`scripts/time-to-safe-fix-efficiency.ts`.

SymPy terminó con un fingerprint sin causa identificada y uso incompleto. Algunas
filas tienen `status=failed` y `failure=null`; la causa está en guardrails. El
instrumentador recoge tiempos por herramienta, pero el driver devuelve sólo la
suma de llamadas. Se observan respuestas, no todas las transiciones de etapa, y
los códigos de salida del verificador no explican la aserción que falló.

Corrección: taxonomía estructurada para transporte/parsing/schema/herramienta/
verificación/presupuesto/cancelación; conservar finish reason, herramientas
solicitadas con nombres permitidos, etapa y uso faltante. Añadir latencia de modelo,
TTFT cuando exista, herramientas, aprobaciones, OCI y grading. Mantener artefactos
de diagnóstico privados y acotados; no imprimir prompts, secretos o logs crudos.

## Superficies revisadas sin nuevo fallo confirmado

| Superficie | Qué se contrastó | Límite de la conclusión |
| --- | --- | --- |
| Persistencia y sesiones | revisiones, scope, leases del SDK, migraciones, backup y estados activos | No se ensayó caída real del proceso durante cada escritura ni multi-host |
| Presupuestos | guardrails, medición de transporte, continuación por aprobación | El probe `maxSteps=1` hizo una petición y terminó por límite; no se confirmó un reset de steps |
| Orquestación | selección de roles, presupuestos hijos, promoción de aprobación e herencia de entorno del SDK | Grupos de review y perfiles necesitan evaluaciones de calidad, además de mocks |
| MCP | límites de payload, permisos, aprobación, tratamiento no confiable | No se ensayaron todos los servidores/transportes externos; filtros de texto no son garantía universal contra inyección |
| OCI | políticas, transacciones por comando, rechazo de drift, importación | El nuevo probe usa un proceso simulado; no constituye certificación del daemon |
| Proveedores | configuración instalada, capability gate y recuperación comprobada | Sin llamadas live nuevas ni comparación de modelos con reasoning equivalente |
| Build/release | contratos, CI declarada, versiones y gate de seguridad | Sin consulta de registry ni certificación del paquete publicado |

Otros puntos para el backlog: `tester` ejecuta scripts de `package.json` y no es
un verificador genérico de repositorios Python; un `read_files` con un archivo
inválido pierde todos los resultados del batch; la compactación no guarda una
hipótesis estructurada; el contexto de proyecto puede consumir una parte grande
del prompt fijo. Son superficies de producto que requieren pruebas de uso y
medición antes de rediseñar la API.

## Orden recomendado de trabajo

1. **Cerrar H01/H02** con regresiones adversariales y validación en las plataformas soportadas.
2. **Corregir H03/H04/H05/H06**: objetivo recuperable, salidas acotadas, cobertura explícita e instrucciones coherentes.
3. **Resolver H07/H08/H09**: continuidad de audit y perfiles de ejecución compartidos con presupuesto por fase.
4. **Instrumentar H10/H11** antes de otra campaña de gasto live.
5. Ablaciones: contrato/instrucciones; memoria de tarea; control de exploración;
   herramientas por fase. Cambiar una familia a la vez, manteniendo modelo,
   reasoning, imágenes y límites. Luego confirmar en un holdout nuevo.

Medir resolución candidata/verificada/importada, tokens completos por reparación,
tiempo hasta primer cambio y primera verificación, errores recuperados, cobertura
de búsqueda y uso incompleto. Comparar presupuesto bajo, medio y alto para saber
si la curva mejora; un solo punto de 100k no responde esa pregunta.

No hay base para prometer que Muse cierre estas brechas. Una memoria adicional
puede ayudar a la continuidad, pero no corrige cancelación, resolución de rutas,
contratos incompatibles ni una evaluación que pierde etapas. Los hallazgos
confirmados de esta revisión pertenecen al harness; no se creó una HU nueva del SDK.
