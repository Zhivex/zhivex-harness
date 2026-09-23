# Atribución de fallos: SDK, providers y Harness

## Conclusión

No se confirmó un defecto nuevo del SDK o de los adaptadores en los fallos
investigados. Sí se reprodujo un incumplimiento de salida de Muse Spark 1.3 en
la respuesta HTTP original. La desviación histórica de Qwen en argumentos sigue
sin atribución concluyente: sus tres controles nuevos fueron correctos. Esto
no permite cerrar el bloqueo ni reemplazar el resultado histórico.

Base de ejecución: Harness `410e17c`, runtime idéntico a `1e01ac6`. Core
1.23.0-next.1, Agents 1.9.0-next.1, Meta 0.2.7-next.0, Qwen 0.15.1-next.0 y
OpenAI 0.13.5-next.1. Scripts diagnósticos añadidos durante el análisis; sin cambios
a producción, predeterminados, aprobaciones ni presupuestos.

## Método y seguridad

Se observó la respuesta HTTP con `Response.clone()` sin cambiar el cuerpo que
recibe el adaptador. Los cuerpos sólo existen en memoria. Se comparó su texto con
los eventos normalizados del modelo y con el resultado del Harness. Los ficheros
contienen booleanos, contadores, roles fijos y errores estructurales saneados.
No se guardan headers, endpoints, credenciales, payloads, prompts, respuestas ni
SQLite. No hay reintentos externos hasta obtener verde.

Para Qwen se compararon las llamadas Responses `function_call` con la aprobación
construida por el runtime y con el contrato esperado. Son pruebas de solicitud:
no se aprobó ni ejecutó ninguna modificación.

## Muse Spark 1.3

Histórico inmediato: edición 3/3 aprobada; primera delegación fallida y serie
interrumpida; diagnóstico posterior también fallido por ausencia del marcador
final del padre, con hijo correcto.

La nueva comparación por Chat Completions obtuvo un éxito y un fallo. En el
fallo:

- La petición final contenía la instrucción del marcador del padre y el recibo del hijo.
- Las cuatro respuestas HTTP fueron 200. La última terminó en `stop`, no `length`.
- La API devolvió 246 caracteres con el marcador del hijo, sin el del padre.
- Los cuatro textos normalizados coincidieron exactamente con los recibidos.
- El Harness conservó los 282 caracteres acumulados de ambos pasos del padre;
  coinciden exactamente con su concatenación. No perdió el marcador: nunca llegó.
- El hijo completó una lectura, sin errores, y produjo su marcador correcto.

**Atribución confirmada:** incumplimiento del contrato de salida en el contenido
producido por el servicio/modelo Meta para esta entrada. No es HTTP 5xx, parsing,
pérdida de texto del adaptador ni agotamiento observado del presupuesto.
No se puede atribuir al entrenamiento, routing interno o infraestructura de Meta
sin evidencia de su servicio.

Existe una posible interacción de instrucciones: el sistema pide responder usando
el resultado del hijo y el usuario exige un marcador específico. La respuesta
fallida conserva el marcador del hijo. Es una hipótesis de sensibilidad al contexto,
no una causa demostrada ni prueba de que el modelo sea defectuoso en general.

El smoke usa Chat por defecto para Meta. La documentación oficial recomienda
[Responses para bucles de herramientas](https://dev.meta.ai/docs/protocols/chat-completions).
Los tres controles de atribución por Responses pasaron con ambos marcadores, un
hijo correcto y texto API/SDK idéntico. Los dos últimos también comprobaron igualdad
de la salida acumulada. Estos probes no incluyen reapertura del proceso. Cambiar
a Responses no está integrado ni certificado; esos verdes no borran el fallo Chat.

## Qwen 3.8 Flash

La campaña previa de edición mínima pasó dos casos y falló el tercero antes de
aprobar, en `request_arguments`. No se conservó el payload ni el campo divergente
porque el diagnóstico de campos se añadió después. No es posible reconstruirlos.

Tres nuevas solicitudes hasta aprobación, con captura de frontera API, pasaron:
`propose_edits` y `apply_patch` contenían exactamente los argumentos esperados;
los argumentos de `apply_patch` recibidos del servicio coinciden con los que se
persisten para aprobar. Cero fallos de captura. No se ejecutó la fase resume.

**Atribución pendiente:** estas ejecuciones descartan una transformación sistemática
en su recorrido observado, pero no excluyen defectos intermitentes del adaptador
ni permiten atribuir al modelo el payload histórico que ya no existe. La HU debe
ser de investigación, no una acusación de corrupción de argumentos del SDK.

La orquestación anterior sin contrato fallaba por desviación de tarea y presupuesto.
El modo actual con tarea fijada por la aplicación pasó las cuatro comprobaciones
previas; ese resultado no certifica todas las tareas CLI ni la edición de archivos.

## OpenAI y defectos SDK ya conocidos

OpenAI `gpt-6-luna` conserva 3/3 casos base y 3/3 de orquestación aprobados en la
campaña anterior. No se repitieron llamadas live sin un fallo nuevo que lo justificara.
Se ejecutaron 44 regresiones offline de recibos OpenAI, contratos de delegación
y diagnósticos: cero fallos; typecheck de tooling aprobado.

El Harness sigue usando el envelope OpenAI compatible. Las regresiones comprueban
recibos success/error, nombres coincidentes con herramientas nativas y metadatos
nativos explícitos. No se confunde esta cobertura con retirar la mitigación.

El reproductor offline de contabilidad se volvió a ejecutar con y sin ledger:
padre 3 + hijo fallido 5 = 8 tokens, un enlace de hijo, cero herramientas rechazadas
ejecutadas. El defecto anterior está corregido para estos casos en el next instalado.
Las HU existentes de contabilidad y recibos no deben duplicarse ni cerrarse por
estos checks si falta su definición completa de terminado.

## Harness y límites de la certificación

El guardrail de delegación garantiza el hijo aceptado; el marcador final del padre
se verifica en el smoke. Por eso un run puede estar `completed` y fallar la
certificación. No implica que se haya saltado el guardrail del hijo.

`outputText` acumula varios pasos. La aserción actual busca el marcador con
`includes`, no igualdad de toda la salida con el texto solicitado. Los verdes
certifican presencia del marcador junto con los demás efectos, no fidelidad textual
absoluta. Si se exige salida terminal exacta, debe validarse la última respuesta y
su contrato explícitamente, con regresiones para marcadores en preámbulos.

La observabilidad del smoke de orquestación conserva una aserción genérica sin
checkpoint. La traza diagnóstica permitió localizar este caso, pero conviene
incorporar checkpoints y contadores allowlisted al flujo normal. No conservar
respuestas brutas como atajo.

## Siguiente trabajo y cierre

1. Registrar el fallo de Meta a nivel servicio/modelo y evaluar Responses mediante
   una campaña predefinida con las mismas assertions, presupuestos y persistencia.
2. Registrar la investigación Qwen y capturar el próximo fallo con campo divergente
   y comparación entre API y aprobación; detener la campaña, sin repetir hasta verde.
3. Mantener Flash y el bloqueo de publicación. No sustituirlo por Max ni iniciar otra
   RC hasta resolver el gate y certificar el artefacto exacto con la matriz requerida.

Los resultados y limitaciones de instrumentación están en la
[evidencia saneada](evidence/provider-attribution-2026-09-23.json).

## HU creadas

- [Muse: incumplimiento de salida y evaluación de Responses](https://app.notion.com/p/3e4777b104f681f88997ec07d8b2f400). Error observado del servicio/modelo para esta entrada, sin defecto nuevo confirmado del adaptador.
- [Qwen: atribución de argumentos intermitentes](https://app.notion.com/p/3e4777b104f681b9a8f0cfad243afd1f). Investigación, origen pendiente.

Ambas incluyen reproducción, versiones, límites, criterios de aceptación y definición
de terminado; prioridad alta, responsables por asignar. No se crean duplicados de
las HU SDK existentes.
