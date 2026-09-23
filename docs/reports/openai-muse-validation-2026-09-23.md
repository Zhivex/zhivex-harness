# OpenAI y Muse Spark 1.3: pruebas live

Pruebas locales del commit `1e01ac6500b60601904e395436c7fd00a2306a91`, con el
SDK next integrado en la PR #102. No cambian los modelos predeterminados.
El identificador `muse-spark-1.3` se verificó en la
[documentación oficial de Meta](https://dev.meta.ai/docs/models); se usó el modelo
Standard, sin la variante Contributor.

## Campaña predefinida

Tres ejecuciones por proveedor y flujo, deteniendo cada serie al primer fallo.
El smoke base conserva su política existente de hasta tres intentos ante errores
HTTP transitorios. Su salida no cuenta esos intentos internos; estos resultados
no afirman ausencia de retries internos.

| Modelo | Edición con aprobación y reanudación | Delegación gobernada |
| --- | --- | --- |
| OpenAI `gpt-6-luna` | 3/3 pasan | 3/3 pasan |
| Meta `muse-spark-1.3` | 3/3 pasan | 0/1 pasa; dos casos restantes no ejecutados |

La edición comprueba argumentos exactos, aprobación persistida, reinicio del
proceso, efecto exacto y una sola ejecución de herramienta/entrada de journal.
La delegación exige un hijo, lectura autorizada, marcadores de hijo/padre,
presupuestos originales, jerarquía persistida y reapertura.

## Diagnóstico separado de Muse

Se ejecutó un caso adicional con la misma lógica y una proyección previa a las
aserciones que conserva solamente booleanos, contadores y error saneado:

- El padre terminó `completed`, pero su respuesta no contenía el marcador requerido.
- Hubo una delegación y un hijo completado con el marcador correcto.
- El hijo realizó una llamada de herramienta y tuvo cero errores.
- No hubo error terminal del runtime.

El diagnóstico volvió a fallar y conserva el mismo fingerprint que el primer
caso. Localiza la aserción de salida del padre en esta ejecución; el diagnóstico
original no registraba el checkpoint, por lo que no se reconstruye su contenido.
No hay evidencia suficiente para atribuirlo al SDK. No se relajó la aserción ni
se repitió la campaña hasta conseguir un verde. La reapertura posterior a esa
aserción no se alcanzó en los casos fallidos de Muse.

## Alcance

OpenAI pasó los seis casos de esta muestra; Muse pasó edición y falló el contrato
de salida del padre en delegación. No son una certificación del artefacto de
release ni garantizan fiabilidad general. La publicación sigue bloqueada por el
fallo previo de Qwen Flash; estas pruebas adicionales fueron solicitadas
expresamente después de detener aquella campaña. No se lanzó una RC.

[Evidencia saneada](evidence/openai-muse-validation-2026-09-23.json). No se conservan
credenciales, headers, prompts, respuestas, argumentos de herramientas ni SQLite.
