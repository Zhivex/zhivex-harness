# Piloto Sonnet 5.5: candidato c92ddbc7

Plan `0d788017cc143e49069f3879d4f344136cf31020328ac0ab2cae71b246ea7fe8`; 42/42 casos ejecutados, tres repeticiones por tarea/participante, sin reintentos selectivos. Mismo modelo `claude-sonnet-5-5`, transporte instalado y límites comunes. Tarball `c92ddbc73184d5bcdabcf33fb7f68680d3ad5945cfce2d1923508882a9df342c`, 242 archivos instalados idénticos. Cinco gates Anthropic, nueve escenarios OCI y 18 fases de delegación pasan sobre ese hash.

| Participante | Éxito | Tiempo acumulado | Uso completo | Aprobaciones automáticas |
| --- | ---: | ---: | ---: | ---: |
| Harness | 18/21 | 215.540 s | 18/21 | 51 |
| Referencia SDK | 21/21 | 272.429 s | 21/21 | 65 |

Todas las tareas salvo corrección del usuario pasan 3/3 en ambos participantes. Harness falla las tres correcciones por inserción de memoria entre instrucciones de sistema del historial al iniciar el turno siguiente. El consumo de esos fallos queda desconocido en el agregado; los tiempos incluyen salidas tempranas y no prueban mayor velocidad. Costo monetario desconocido, no cero; no se fijó una fuente de precios. Hubo tres correcciones guionadas por participante y cero intervenciones humanas dentro de los casos. Los archivos protegidos se conservaron en 42/42.

## Corrección posterior y límite observado

Un diagnóstico separado identifica la posición inválida y la regresión la reproduce a través del transporte Anthropic. El nuevo runtime reúne las instrucciones iniciales antes de la inserción de memoria y elimina solo un prefijo exactamente igual a las instrucciones actuales que el SDK ya añade. Conserva restricciones adicionales, políticas históricas distintas, contenido opaco y mensajes de sistema posteriores. La suite previa al último ajuste pasa 1877 tests (1 omitido); después, 28 tests dirigidos cubren continuidad, deduplicación, presupuesto y cliente. Build y tipos pasan.

En el nuevo tarball `1dc3375ab8c4a70a4c100fec45087ee9569d3522970e04be8b4ce65e5a5ea7ec` desaparece el error de transporte, pero el caso se detiene por presupuesto antes de otra llamada: 52066 tokens de entrada reportados, uso completo, límite de 60000 conservado. No se declara que el caso pasó ni se reemplaza el fallo de la campaña. Este hash aún requiere certificación y campaña completa.

La evidencia justifica priorizar reducción del contexto/instrucciones y del catálogo de herramientas enviado por solicitud, conservando permisos, revisiones y checks. No sustenta añadir un mapa de repositorio: los fixtures son diminutos y no muestran problemas de descubrimiento. Este piloto identifica fallos y límites útiles para producción, pero no demuestra superioridad de mercado ni preparación general para producción.

Evidencia: JSON de esta campaña, plan separado y `HAR_HU_51_FRESH_INSTRUCTIONS_FIX_2026-09-29.json`. Sin commit, push, PR ni publicación de paquetes.
