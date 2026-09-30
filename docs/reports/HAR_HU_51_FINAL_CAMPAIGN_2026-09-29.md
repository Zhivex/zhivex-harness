# HU51: resultado final del piloto Sonnet 5.5

Plan `sha256:e9d7bd8c3dc5de45be95e31d4a6729bce9d96014fae014c8f490cb69be3320b1`. Tarball `1dc3375ab8c4a70a4c100fec45087ee9569d3522970e04be8b4ce65e5a5ea7ec`. Los 42 casos predeclarados terminaron, con un intento por celda; no hubo reintentos selectivos.

## Método

Harness 1.3.0-rc.3 frente a una referencia construida con SDK core 1.26.0 / agents 1.10.1; transporte Anthropic 0.12.4 compartido desde el artefacto instalado. Versiones y bytes de SDK del evaluador y del consumidor instalado son iguales y se comprueban antes de cada caso. Ambos solicitan `claude-sonnet-5-5` por API directa y streaming. No es una comparación con productos comerciales ni garantiza un snapshot inmutable de los pesos del modelo.

Siete fixtures HU44, tres repeticiones y orden rotativo. Límites comunes por caso completo: 150 s, 16 solicitudes de modelo, 40 llamadas de herramienta, 60000 tokens de entrada, 8192 de salida y 68192 totales. El contador persiste entre aprobaciones, reapertura y corrección del usuario. No se aumentaron los límites al observar fallos.

Los tests independientes y package.json permanecen protegidos. Las aprobaciones de cambios permitidos y del check exacto son automáticas y se cuentan aparte de intervención humana. Cancelación aprueba por ausencia de efectos; no significa que se haya reparado el bug. La reapertura del piloto ocurre dentro del mismo worker, con compactación exigida; HU45 aporta pruebas separadas entre procesos.

## Resultados

| Participante | Éxito | Tiempo acumulado | Entrada reportada | Salida reportada | Uso completo | Aprobaciones automáticas |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| harness | 18/21 | 237.375 s | 832712 | 19072 | True | 51 |
| sdk-reference | 21/21 | 274.598 s | 173007 | 20892 | True | 67 |

| Tarea | Harness | Referencia SDK |
| --- | ---: | ---: |
| bug | 3/3 | 3/3 |
| multi-file | 3/3 | 3/3 |
| failed-check | 3/3 | 3/3 |
| user-correction | 0/3 | 3/3 |
| compaction-restart | 3/3 | 3/3 |
| approval | 3/3 | 3/3 |
| cancellation | 3/3 | 3/3 |

Archivos protegidos conservados en 42/42 casos. Intervenciones humanas: 0. Correcciones guionadas: 6. Costo monetario desconocido, no cero: no se fijó una fuente de precios. Los tokens no constituyen facturación.

Los fallos observados y sus motivos están íntegros en el JSON. Los rechazos por presupuesto son decisiones de admisión conservadoras antes de una nueva solicitud; no significan que se hayan consumido los 60000 tokens. No se convierten en éxito por haber producido una modificación parcial.

Para las 18 parejas en que ambos completaron: mediana de duración Harness 10.978 s, referencia 12.531 s; entrada acumulada 675750 frente a 117904 tokens. Se excluyen de esta comparación los fallos, pero permanecen en la tasa total. Esta muestra pequeña y no aleatoria no prueba superioridad de velocidad o mercado.

## Qué sirve y qué falta para producción

La muestra verifica edición gobernada, checks, aprobación, cancelación y continuidad en los escenarios indicados. El límite de corrección con presupuesto compartido impide una recomendación general de producción para esta configuración. Conviene reducir el contexto y los esquemas enviados por solicitud, medir retención de contexto por turno y dimensionar presupuestos con evidencia; conservar siempre permisos, aprobación y verificación independiente. No se justifica un mapa de repositorio: los fallos no son de descubrimiento en repositorios grandes.

Se corrigieron durante la investigación: el piloto omitía normalización de bloques firmados; el cierre por presupuesto/OCI situaba mal instrucciones de sistema; el umbral de compactación del piloto no admitía grupos indivisibles; la carga de memoria separaba instrucciones de sistema al continuar, y se duplicaban instrucciones actuales. Cada campaña anterior conserva plan, observaciones y fallos; sus cifras no se mezclan con este candidato.

HU45 del mismo hash: seis rutas pasan los gates seleccionados, continuidad 36/36 y cuatro rutas cruzadas; nueve escenarios OCI y 18 fases de delegación instaladas en Node 22.13. Suite final: 1878 pass, 1 skip, 0 fail. Build, tipos, arquitectura, contrato y documentación pasan; el inventario del piloto se validó adicionalmente con tipos y preparación de plan.

Evidencia completa: HAR_HU_51_FINAL_CAMPAIGN_2026-09-29.json y HAR_HU_51_SONNET_55_FINAL_PLAN_2026-09-29.json. No hay commit, push, PR, publicación de paquetes ni promoción formal de soporte. La implementación queda para revisión; el informe describe límites, no una certificación general de producción.
