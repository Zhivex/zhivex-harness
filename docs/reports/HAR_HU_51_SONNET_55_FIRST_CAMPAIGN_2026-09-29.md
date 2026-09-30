# Piloto Sonnet 5.5 — primera campaña completa

Plan `93846b89790a95ad3675947c0781f242b994ed77c6c685e600de80dcbcae5f50`, artefacto `993bc5a63bff13ce8ac015061082a1ad4384b4257d3f91b488891f6bb8700d92`. Se ejecutaron los 42 casos predeclarados, sin reintentos selectivos. Ambos participantes usaron `claude-sonnet-5-5` y el transporte del artefacto instalado.

| Participante | Aprobados | Duración acumulada | Uso completo | Aprobaciones automáticas |
| --- | ---: | ---: | ---: | ---: |
| Harness | 3/21 | 140.567 s | 6/21 | 45 |
| Referencia SDK | 18/21 | 222.646 s | 21/21 | 59 |

Los únicos casos aprobados por Harness fueron las tres cancelaciones. La referencia falló sus tres reaperturas con compactación. Los archivos protegidos se conservaron en los 42 casos. Intervenciones humanas durante casos: 0; correcciones de usuario guionadas: 0 en Harness y 3 en referencia. El costo monetario permanece desconocido por falta de evidencia de precio: no equivale a cero. Los tiempos incluyen fallos tempranos y no permiten afirmar que un participante es más rápido para completar trabajo. Los tokens de Harness son parciales y no se comparan como consumo total.

## Hallazgos y correcciones

1. Antes de esta campaña se corrigió la inyección de SDK crudo que omitía normalización de bloques firmados. La campaña anterior con Sonnet 5 queda preservada como afectada por ese defecto de instrumentación.
2. El cierre por presupuesto de Harness añadía instrucciones de sistema tras una herramienta; Anthropic rechaza esa posición. Se reprodujo por separado, se corrigió la ubicación sin reducir límites y se cubrió la misma condición en recordatorios OCI. Un nuevo tarball pasó el caso diagnóstico completo con cinco llamadas, tres aprobaciones y oráculo independiente. Ese resultado no reemplaza ninguna observación de esta campaña.
3. La configuración de cuatro mensajes para compactación no permitía conservar un grupo de herramientas indivisible más el resumen. El piloto revisado usa ocho para ambos participantes, mantiene dos recientes y sigue exigiendo compactación y reapertura. Una regresión con llamadas múltiples pasa. La campaña revisada requiere un plan nuevo.

Suite tras el arreglo del runtime: 1874 aprobadas, 1 omitida, 0 fallos; build, tipos, arquitectura y contrato pasan. La regresión posterior de configuración de compactación también pasa. Falta recertificar el nuevo artefacto y ejecutar una nueva campaña completa antes de juzgar su calidad. Muestra pequeña y referencia técnica; no hay conclusión de superioridad comercial ni recomendación de producción. Sin commit, push, PR o publicación.

Evidencia completa: `HAR_HU_51_SONNET_55_FIRST_CAMPAIGN_2026-09-29.json`; plan inmutable y diagnósticos están en reportes separados.
