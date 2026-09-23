# Diagnóstico de compactación Qwen — 2026-09-23

## Resultado

La configuración actual sigue bloqueada para release. El diagnóstico ya identifica un fallo real de compactación (`ValidationError`, `max_estimated_input_tokens_exceeded`) y conserva métricas parciales. Se corrigió un desbordamiento evitable demostrado con una reproducción determinística, pero la campaña posterior volvió a fallar con Flash. No se atribuye el fallo histórico de los siete RC a una sola causa ni se declara resuelta la intermitencia.

## Campañas acotadas

Ambas campañas fijaron ocho casos antes de ejecutar: Max/Flash, hostile-instructions clean/attacked, dos repeticiones; parada al primer fallo, sin reintentos externos. Mismos modelos, dependencias instaladas y digest OCI. Los manifests registran el commit base y hashes de los archivos superpuestos; son snapshots locales, no tarballs certificados. Solo se enviaron fixtures sintéticos al proveedor.

| Campaña | Ejecutados | Resultado | Primer fallo |
| --- | ---: | --- | --- |
| Diagnóstico, antes del ajuste | 4 de 8 | Max 2/2, Flash 1/2 | Flash clean, repetición 1 |
| Aceptación, después del ajuste | 2 de 8 | Max 1/1, Flash 0/1 | Flash attacked, repetición 1 |

Los dos fallos registran cuatro turnos, cuatro resultados de herramienta y cero errores de herramienta. El primero había completado una compactación; el segundo ninguna. Ambos tienen cero efectos no autorizados. Los tokens observados son parciales: antes 14.258 input/2.231 output; después 13.710/1.563. Las celdas restantes no se ejecutaron. Esta muestra y el orden fijo no permiten estimar tasas de fiabilidad ni comparar rendimiento general.

- [Plan diagnóstico](evidence/qwen-failure-diagnostic-plan-2026-09-23.json) y [resultado](evidence/qwen-failure-diagnostic-campaign-2026-09-23.json).
- [Plan de aceptación](evidence/qwen-compaction-fix-plan-2026-09-23.json) y [resultado](evidence/qwen-compaction-fix-campaign-2026-09-23.json).

## Defecto corregido y límites

El compactador elegía el historial reciente protegido, pero calculaba el tamaño del resumen sin descontar el espacio ocupado por ese historial. En dos fixtures determinísticos —objetivo normal y objetivo con caracteres escapados— fallaba el límite del SDK aunque un resumen más corto sí cabía.

`adaptive-tokens-v2` comprueba el tamaño serializado del envoltorio real del SDK, las instrucciones de sistema y el historial retenido. Reduce únicamente el resumen. Conserva los límites y grupos correlacionados; una tercera prueba confirma que un grupo protegido irreducible sigue rechazándose antes de invocar el modelo. La revisión de política modifica la identidad durable para impedir continuaciones silenciosas bajo otra estrategia.

Las pruebas pasaron de dos fallos y una prueba negativa correcta a tres pruebas correctas. Esto demuestra el defecto y su corrección local, pero no demuestra que ese fuera el único mecanismo del fallo live. No se conservaron mensajes ni argumentos del intento de compactación fallido; el diagnóstico disponible no permite distinguir un grupo irreducible de otro desajuste de estimación. No se aumentaron límites ni se retiraron controles para conseguir un resultado verde.

## Diagnósticos y validación

Los resultados fallidos incluyen únicamente categorías permitidas, etapa/origen y contadores estructurales recuperados del estado. No se exportan mensajes, stacks, argumentos ni resúmenes de compactación. Un fallo posterior de verificación no reemplaza el error original. El consumo desconocido se omite y el parcial no se convierte en un promedio completo.

`bun run check` pasó: 1.022 pruebas, una omitida y cero fallos; arquitectura, documentación, contratos, tipos, migraciones, evaluaciones, benchmarks determinísticos, MCP, OCI y smoke del paquete instalado incluidos. Después de corregir un caso adicional de métricas parciales con persistencia no disponible, pasaron typecheck, typecheck de tooling y 70 pruebas focalizadas (407 aserciones). Ese último ajuste de proyección no formó parte del snapshot live; la política de compactación evaluada sí coincide con el cambio final.

## Decisión y siguiente gate

No se crea otro RC, no se publica y no se ejecuta la matriz live completa porque la aceptación acotada falló. Antes de repetirla, falta observar únicamente los tamaños del intento de compactación (límite, sistema, herramientas, grupo protegido y resumen mínimo) para clasificar el desbordamiento restante sin conservar contenido. Ese dato debe decidir el siguiente arreglo; un nuevo pase aislado no demostraría reparación.

La certificación protegida de base, orquestación, routing, ejecución y los 42 casos representativos sigue pendiente. Ningún resultado local sustituye CI, certificación del artefacto, publicación o verificación del registro.
