# Dictamen de seguridad de RC.14 — 2026-09-19

**Revisión técnica completada. Dictamen: NO APROBADO para GA.**

Evaluador: **Codex, revisión automatizada**, por delegación expresa del operador.
La confianza delegada habilita este dictamen técnico; no convierte al evaluador
en una persona ni este documento en una atestación humana. No se solicita una
firma para continuar con las correcciones identificadas.

Objeto: commit `28723ff3350b7572d5bd68f2d40b6feef1e0e6b4`, versión
`1.0.0-rc.14`. Se revisó una exportación aislada con su lockfile exacto; los
cambios concurrentes de dependencias del checkout original quedan excluidos.
El [expediente JSON](rc14-automated-review-2026-09-19.json) contiene hashes de
fuente y artefacto local, cobertura por elemento, riesgos residuales y resultados.

## Hallazgos confirmados

### SEC-04 — Alto: snapshots OCI compartidos entre scopes distintos

En [execution-environment.ts](../src/execution-environment.ts), la adquisición
elige `environments/<hash(runId)>`. La metadata comprueba run, workspace e imagen,
pero no `tenantId`, `userId` ni `namespace` (líneas 1633–1650 del commit revisado).
La identidad del entorno tampoco incorpora esos campos.

**Reproducción:** dos scopes distintos, mismo workspace, directorio de estado y
`runId`. El primer scope deja un archivo privado en su snapshot pendiente. El
segundo llama a la API pública `runHarness` y a `read_file`: obtiene ese archivo
y completa el run. Se simula únicamente la inspección de imagen; adquisición,
metadata, snapshot, persistencia y ejecución de herramientas son reales. No se
ejecutan contenedores ni llamadas a proveedores y todos los datos son fixtures.

**Impacto:** ruptura de confidencialidad e integridad del aislamiento de runs por
scope cuando coinciden sus IDs. El runId es suministrable por la aplicación; no
se necesita una colisión criptográfica. La prueba demuestra lectura cruzada, no
escape del contenedor, importación al host sin aprobación ni acceso a otra máquina.
Los UUID generados automáticamente reducen colisiones accidentales, pero no son
un control de aislamiento entre tenants. La afectación a importación y cleanup
debe quedar cubierta al corregir la identidad compartida.

**Corrección requerida:** identidad canónica de workspace + scope completo + run
en directorios, metadata, recursos del runtime, patch y cleanup. Rechazar o migrar
explícitamente artefactos antiguos sin scope. Añadir regresiones de read/resume,
importación, cancelación y cleanup entre tenants con el mismo ID, preservando
la reanudación legítima del mismo scope. Hasta entonces, no compartir directorio
de estado OCI entre scopes; esa mitigación operativa no cierra el hallazgo.

### SEC-01 — Medio: dos escrituras incompatibles aceptan el mismo digest

En [workspace.ts](../src/workspace.ts), el último control de digest y `rename`
están separados por operaciones asíncronas, incluido `assertActive`
(líneas 1226–1232). No existe exclusión mutua del workspace entre ambos escritores.

**Reproducción:** dos instancias de `Workspace` actualizan el mismo archivo desde
el mismo digest a contenidos distintos. Una barrera en el checkpoint público
previo a publicación hace que ambas validen antes de renombrar: ambas devuelven
éxito y una sobrescribe a la otra. Una prueba adicional sin instrumentación
reprodujo la doble aceptación en 18 de 20 intentos. El control de escritura
obsoleta secuencial sí fue rechazado.

**Impacto:** pérdida de actualización y precondición de aprobación obsoleta.
Los leases por run no coordinan dos runs diferentes sobre el mismo archivo.
No se demostró evasión de aprobación ni escritura fuera del workspace.

**Corrección requerida:** serialización de transacciones de mutación entre runs
y procesos, con propiedad recuperable tras fallos, validación dentro de la
sección protegida y rollback que no sobrescriba cambios ajenos. La aceptación
exige exactamente un éxito y un conflicto para dos actualizaciones incompatibles,
incluidas importaciones OCI concurrentes.

### SEC-02 — Medio: la aprobación de reemplazo oculta el texto nuevo

[terminal-ui.ts](../src/terminal-ui.ts) omite `apply_reviewed_replacement` de
`EXACT_REVIEW_TOOLS` (líneas 9–22). Con un `oldText` de 2.000 caracteres,
la tarjeta predeterminada trunca antes de mostrar `newText`.

**Impacto:** una mutación incorporada puede aprobarse sin ver por defecto el
reemplazo que se ejecutará. Hay aviso de omisión y vista completa mediante `v`;
esto limita la severidad y no constituye ejecución silenciosa.

**Corrección requerida:** incluir la herramienta en el conjunto de revisión
completa y probar exhaustivamente todas las mutaciones del catálogo. Mantener
el escape de secuencias de control de terminal.

### SEC-03 — Bajo: inventario de seguridad incompleto

[security-review-evidence.ts](../scripts/security-review-evidence.ts) no enumera
`read_task` ni `repair_plan`. Su prueba de paridad tampoco incorpora
`createTaskTools`, por lo que pasa a pesar de omitir ambas herramientas.

**Impacto:** el gate puede declarar completa una cobertura que no incluye lectura
de solicitudes originales ni selección del verificador por el controlador.
La inspección de estas herramientas no mostró autorización directa de comandos;
el verificador sigue pasando por aprobación. El defecto es de cobertura.

**Corrección requerida:** comparar el inventario con el catálogo completo real,
actualizar el expediente y demostrar que retirar cualquiera de estas clases
rompe la prueba. Ambas ya están evaluadas en el JSON de esta revisión.

## Cobertura y evidencia

La inspección dirigida cubrió **10 controles, 11 fronteras y 31 clases de
herramientas**, incluidos los añadidos de RC.14. Cada fila del JSON identifica
código inspeccionado, evidencia pertinente, hallazgos y límites. No se declara
una auditoría línea por línea de todas las dependencias transitivas.

- **152/152** pruebas focales de seguridad, edición, MCP, contexto, perfiles,
  estado, sesiones, OCI, orquestación, backups y contrato de revisión.
- **51/51** pruebas adicionales de terminal, entrada/adjuntos, recuperación del
  verificador, workflow y procedencia del release.
- Nueva aceptación adversarial: cuatro fallos confirmados y control positivo
  de rechazo de digest obsoleto. Tipos de tooling: PASS.
- Se conserva la evidencia de la [validación GA previa de esta misma sesión](../docs/reports/GA_VALIDATION_2026-09-19.md):
  512 tests, OCI real y consumidor del tarball exacto pasaron. Ninguno de estos
  resultados invalida los nuevos hallazgos.

Reproducción sin credenciales ni red, con las dependencias del commit revisado:

```sh
bun run scripts/validate-security-review.ts
```

Salida esperada del candidato defectuoso: código **1**, `SEC-01`, `SEC-02`,
`SEC-03` y `SEC-04` con `passed: false`. El programa crea y elimina sólo fixtures
temporales. Los resultados corresponden al baseline aislado, no a dependencias
que se estén actualizando en paralelo.

## Controles conservados y límites

Se inspeccionaron lecturas mediante descriptor sin seguir enlaces, restricciones
de paths y archivos sensibles, propuestas ligadas por digest, aprobaciones
durables y recuperación del verificador. En OCI: red deshabilitada, raíz de sólo
lectura, capacidades eliminadas, límites de recursos, validación del snapshot e
importación separada. MCP mantiene permisos, límites e identidad JSON-RPC; las
expresiones contra prompt injection son una heurística, nunca una garantía.

La configuración explícita de servicios, el proceso de la aplicación, la cuenta
del operador, el kernel y el daemon siguen siendo confiables por diseño. El
backend sin OCI ejecuta checks aprobados en el host. La redacción no detecta todo
secreto posible; el proveedor observa el contexto que se le envía. Un verificador
con exit 0 no prueba por sí solo el cumplimiento de requisitos.

No se ha obtenido una auditoría actual de dependencias: npm devolvió HTTP 503.
La revisión del workflow y sus verificadores no acredita una publicación que
todavía no existe. RC.14 sigue sin evidencia final protegida de release/SLSA.

## Decisión y siguiente trabajo

Hay **1 hallazgo alto, 2 medios y 1 bajo abiertos**, sin críticos identificados.
Son conteos de lo encontrado, no una garantía de ausencia de otros defectos.
SEC-04 bloquea la aprobación de seguridad; no debe aceptarse sólo como riesgo
residual. Este expediente usa un tipo explícito de revisión automatizada de
fuente, distinto del JSON que acredita un release publicado y aprobado.

El siguiente paso es corregir **SEC-04 → SEC-01 → SEC-02/03**, conservar estas
reproducciones como regresiones y revisar de nuevo el candidato resultante.
Después quedan GA-01 (presupuesto), la retención de entrega de reparaciones,
auditoría/CI y certificación protegida de artefacto/live/matriz representativa.
El cierre deberá ligarse a los bytes y commit del candidato final.

No se modificaron runtime, dependencias, política ni ledger para declarar un
aprobado. Los cambios concurrentes originales se preservaron.
