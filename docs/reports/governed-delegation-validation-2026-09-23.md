# Implementación y validación de delegación gobernada

## Entrega

Se integra el batch SDK next verificado, con un único Core 1.23.0-next.1 y Agents
1.9.0-next.1. OpenAI 0.13.5-next.1, Qwen 0.15.1-next.0, Meta 0.2.7-next.0 y Gemini
0.12.2-next.0 quedan fijados en manifest y lockfile. Se mantiene envelope OpenAI
como mitigación compatible; los fixtures nativos usan metadatos coherentes.

El nuevo modo Beta `delegationContracts` está controlado por la aplicación:

- El padre sólo selecciona un taskId. La tarea original se resuelve dentro del
  Harness y no se aceptan prompt/system del modelo ni campos extra.
- El padre no dispone de herramientas de repositorio. Los hijos reviewer/explorer
  sólo pueden leer rutas exactas autorizadas mediante read_file.
- Se exige al menos una lectura exitosa y el marcador de aceptación. Un padre no
  puede completar con éxito si falta un hijo aceptado.
- Los contratos se copian y se vinculan al fingerprint de padre e hijo. Se
  conservan guardrails, presupuestos, persistencia y contabilidad del SDK.
- Los errores exponen enums de contrato/ruta/aceptación, sin contenido de tareas.

`toolNames` permite a aplicaciones strict declarar un catálogo mínimo vinculado
al fingerprint. El smoke base usa propose_edits/apply_patch y conserva todas sus
assertions. Una discrepancia de aprobación puede identificar el campo afectado
sin conservar el valor, el payload del modelo ni datos del repositorio.

El modo general anterior sigue disponible para compatibilidad, incluyendo
implementer/tester y sus aprobaciones. Esta entrega no convierte todas las
delegaciones del CLI en contratos inmutables. El ejemplo y alcance exacto están
en [EXTENSIBILITY](../EXTENSIBILITY.md).

## Resultados live, con todos los fallos retenidos

| Campaña | Resultado | Límite de la conclusión |
| --- | --- | --- |
| Orquestación gobernada Flash, 3 ejecuciones predefinidas | 3/3 pasan; una lectura por hijo, marcador correcto, jerarquía y reapertura comprobadas | Muestra pequeña local; no es certificación de un release |
| Base con catálogo general | Falla resume_output | El diagnóstico posterior recibió un recibo completo, hizo una escritura y pasó el marcador; confirma variabilidad, no permite reconstruir aquel fallo borrado |
| Base con catálogo mínimo, 3 ejecuciones predefinidas | 2/3 pasan; la tercera falla request_arguments | El payload propuesto no coincide con el requerido; se bloqueó antes de aprobar la escritura |

La campaña de orquestación conservó los presupuestos originales de 4/4 para el
padre y 2/1 para el hijo. Sus consumos agregados fueron 3.869, 3.792 y 3.829 tokens.
El nuevo contrato reduce también las instrucciones y schemas expuestos; no se
atribuye la mejora exclusivamente a una de esas intervenciones.

La comprobación de lectura obligatoria se añadió después de esa campaña; las
tres ejecuciones ya habían realizado una lectura exitosa. Las regresiones cubren
también rechazo del marcador sin lectura. Se realiza una comprobación live
adicional del contrato final y se conserva por separado en la evidencia: pasó, con una lectura y 3.710 tokens agregados.

## Verificación y frontera pendiente

Las regresiones cubren transporte generate/stream, rechazo de taskId desconocido,
system/prompt o campos extra, tarea exacta recibida por el hijo, ruta no autorizada,
aceptación ausente, marcador sin lectura, presupuesto de lote, linkage/uso en
fallo, copia de configuración, fingerprints y proyección segura de errores.
`bun run check` final aprobado: 983 tests pasan, uno omitido por plataforma y cero fallos.
Los gates completos incluyen typecheck, contratos de API, suite del Harness y
Desktop, migraciones, evaluaciones, MCP, OCI y consumidor instalado.

**No se publica otra RC.** La orquestación está corregida en este modo, pero Flash
sigue sin superar consistentemente la certificación base de edición. No se
ejecutó la matriz representativa ni otros proveedores después de ese fallo.
Un verde posterior no debe borrar el rojo de esta campaña. La siguiente frontera
es clasificar y resolver la desviación del payload de edición conservando la
comparación exacta, la aprobación y los efectos verificados.

[Evidencia saneada](evidence/governed-delegation-validation-2026-09-23.json)
identifica las versiones y hashes del árbol implementado. Los datos históricos
del diagnóstico inicial permanecen separados en los informes del 22 y 23 de
septiembre. No se adjuntan SQLite, prompts/respuestas live, headers ni credenciales.

## Cierre de revisión

Se cubren tanto `GenerateResult.message` como `messages` y el transporte streaming.
La primera CI remota detectó un timeout de 5 segundos en un test Desktop que
agrupaba tres escenarios Git. Se separaron manteniendo sus assertions; la suite
completa local volvió a pasar con 983 aprobados, uno omitido y cero fallos.
