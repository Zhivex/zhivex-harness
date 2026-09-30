# HU51: optimización del contexto y piloto con Sonnet 5.5

Artefacto instalado `sha256:560a1c379593fa5dfab85471ee02b7f70e749b06836be2b3cd0900f585ecc761`. Plan `sha256:4718c6f563d6f83ff811fc2e92fd1abf511e9fdf0a56ed674c2cc3c687ac0509`.

## Cambios y controles

Instrucciones comunes más concisas, catálogo progresivo mediante discover_tools, resultados extensos recuperables desde la evidencia durable y medición numérica por solicitud. Los permisos, aprobaciones, validación de argumentos, controles de archivos y oráculos se conservan. La selección explícita de herramientas de la aplicación sigue anunciada. Los catálogos explícitos sin descubrimiento se anuncian completos.

Los resultados largos se proyectan únicamente cuando su original es recuperable dentro del mismo run. Las referencias no permiten leer otro run; la evidencia original no se reescribe. Compactación estima los esquemas anunciados y conserva la reserva dinámica existente. El presupuesto compartido del piloto persiste entre runs de corrección y no se reinicia.

La entrada fija offline bajó de 21431 a 11792 caracteres serializados (45,0%). Instrucciones: 7039→3364; herramientas: 14277→8313; herramientas anunciadas: 18→11. Son tamaños de contexto, no tokens facturados.

## Método

Mismos siete fixtures, tres repeticiones, orden rotativo, un intento por celda, mismo transporte instalado y claude-sonnet-5-5. Se mantienen 150 s, 16 solicitudes, 40 herramientas, 60000 tokens de entrada, 8192 de salida y 68192 totales por caso completo. La referencia SDK conserva su comportamiento; ambos participantes incorporan instrumentación numérica. No se elevaron límites ni reintentaron celdas.

## Resultados

| Participante | Éxito | Entrada | Salida | Tiempo acumulado |
| --- | ---: | ---: | ---: | ---: |
| harness | 18/21 | 676668 | 21564 | 277.973 s |
| sdk-reference | 21/21 | 174240 | 21048 | 277.804 s |

| Tarea | Harness | Referencia SDK |
| --- | ---: | ---: |
| bug | 3/3 | 3/3 |
| multi-file | 3/3 | 3/3 |
| failed-check | 3/3 | 3/3 |
| user-correction | 0/3 | 3/3 |
| compaction-restart | 3/3 | 3/3 |
| approval | 3/3 | 3/3 |
| cancellation | 3/3 | 3/3 |

Archivos protegidos conservados: 42/42. Fallos: 3; todos preservados en el JSON. Costo monetario desconocido, no cero.

Comparación con las 18 celdas que Harness completó en ambas campañas: entrada 675750→516533 (23.6% menos). Mediana de duración 10.978→12.473 s. Es una comparación histórica de muestra fija, no una estimación causal ni una promesa de velocidad.

El JSON conserva cada medición por solicitud: caracteres por rol y esquemas, estimación conservadora, admisión, consumo reportado y caché. Los contadores se reconciliaron con los totales de cada caso; los digests de las 42 evidencias se verificaron contra el journal. La campaña anterior no tenía este desglose: no se atribuyen retrospectivamente sus tokens a componentes específicos.

## Verificación y alcance

244 archivos dist idénticos entre tarball y consumidor instalado. Cinco gates seleccionados de Anthropic pasan en este hash: aprobación/reinicio/efecto único, compactación, delegación estructurada, OCI y continuidad 6/6. La certificación anterior de seis proveedores pertenece a 1dc3375a; no se traslada a este candidato.

Suite completa: 1885 pass, 1 skip, 0 fail. Después se corrigió la selección explícita de herramientas y se añadieron regresiones de diagnóstico: 14 pruebas focalizadas pasan. Build, tipos, arquitectura, contrato y documentación pasan. El snapshot de firmas se regeneró tras revisar la adición opcional a onDiagnostics; ese snapshot y la documentación final se actualizaron localmente después de congelar el tarball del piloto, sin cambiar los bytes de runtime.

La campaña previa del candidato f24b2544 también pasó cinco gates Anthropic; se preserva separada y no se mezcla con estos resultados. No hubo commit, push, PR, publicación ni promoción formal de soporte.

Fuentes de diseño: [Claude Code](https://code.claude.com/docs/en/costs), [Cursor](https://cursor.com/blog/dynamic-context-discovery), [OpenCode V2](https://dev.opencode.ai/v2/docs/compaction/) y [Aider](https://aider.chat/docs/repomap.html). El piloto compara Harness con una referencia técnica SDK, no ejecuta esos productos comerciales.
