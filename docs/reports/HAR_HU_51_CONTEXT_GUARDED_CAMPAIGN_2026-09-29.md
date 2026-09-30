# HU51: optimización del contexto y piloto con Sonnet 5.5

Artefacto instalado `sha256:2f4af7d422825d466bafa2ab3f08b9675d024471924a258c46b07005b001bafc`. Plan `sha256:c487195791749b76247c923a0ca321d60beb6065c1114737893af3e9e74ab1e7`.

## Cambios y controles

Instrucciones comunes más concisas, catálogo progresivo mediante discover_tools, resultados extensos recuperables desde la evidencia durable y medición numérica por solicitud. Los permisos, aprobaciones, validación de argumentos, controles de archivos y oráculos se conservan. La selección explícita de herramientas de la aplicación sigue anunciada. Los catálogos explícitos sin descubrimiento se anuncian completos.

Los resultados largos se proyectan únicamente cuando su original es recuperable dentro del mismo run. Las referencias no permiten leer otro run; la evidencia original no se reescribe. Compactación estima los esquemas anunciados y conserva la reserva dinámica existente. El presupuesto compartido del piloto persiste entre runs de corrección y no se reinicia.

La entrada fija offline bajó de 21431 a 9547 caracteres serializados (55,5%). Instrucciones: 7039→3364; herramientas: 14277→6068; herramientas anunciadas: 18→8. Son tamaños de contexto, no tokens facturados.

## Método

Mismos siete fixtures, tres repeticiones, orden rotativo, un intento por celda, mismo transporte instalado y claude-sonnet-5-5. Se mantienen 150 s, 16 solicitudes, 40 herramientas, 60000 tokens de entrada, 8192 de salida y 68192 totales por caso completo. La referencia SDK conserva su comportamiento; ambos participantes incorporan instrumentación numérica. Se mantiene requireVerifiedDelivery:false, projectContext:false y sin subagentes, como en el piloto original; la entrega obligatoria tiene regresiones determinísticas separadas. El identificador de modelo solicitado no fija de manera independiente los pesos del proveedor. No se elevaron límites ni reintentaron celdas.

Cancelación aprueba por ausencia de efectos, no por reparar el código. La reapertura del piloto usa el mismo worker; los gates Anthropic verifican por separado reinicios entre procesos. Las aprobaciones son automáticas bajo la política fija, no intervención humana.

## Resultados

| Participante | Éxito | Entrada | Salida | Tiempo acumulado |
| --- | ---: | ---: | ---: | ---: |
| harness | 21/21 | 591576 | 22518 | 313.014 s |
| sdk-reference | 21/21 | 166511 | 20894 | 263.318 s |

| Tarea | Harness | Referencia SDK |
| --- | ---: | ---: |
| bug | 3/3 | 3/3 |
| multi-file | 3/3 | 3/3 |
| failed-check | 3/3 | 3/3 |
| user-correction | 3/3 | 3/3 |
| compaction-restart | 3/3 | 3/3 |
| approval | 3/3 | 3/3 |
| cancellation | 3/3 | 3/3 |

Archivos protegidos conservados: 42/42. Fallos: 0; las 42 observaciones están preservadas en el JSON. Costo monetario desconocido, no cero.

Comparación con las 18 celdas que Harness completó en ambas campañas: entrada 675750→430254 (36.3% menos). Mediana de duración 10.978→13.327 s. Es una comparación histórica de muestra fija, no una estimación causal ni una promesa de velocidad.

El JSON conserva cada medición por solicitud: caracteres por rol y esquemas, estimación conservadora, admisión, consumo reportado y caché. Los contadores se reconciliaron con los totales de cada caso; los digests de las 42 evidencias se verificaron contra el journal. La campaña anterior no tenía este desglose: no se atribuyen retrospectivamente sus tokens a componentes específicos.

## Brecha restante

Las tres correcciones pasan dentro del presupuesto original. En esta campaña Harness todavía consume 3,55 veces la entrada de la referencia SDK: 114 solicitudes frente a 89, con cero tokens de caché reportados en ambos. Sus controles y herramientas son distintos, por lo que el diferencial no se atribuye íntegramente a desperdicio. No se observó una mejora de velocidad frente a la campaña histórica; estos resultados justifican revisar la mejora, no una recomendación general de producción. Aprobaciones automáticas: 60/65; intervenciones humanas: 0; correcciones guionadas: 3 por participante.

## Verificación y alcance

244 archivos dist idénticos entre tarball y consumidor instalado. Cinco gates seleccionados de Anthropic pasan en este hash: aprobación/reinicio/efecto único, compactación, delegación estructurada, OCI y continuidad 6/6. La certificación anterior de seis proveedores pertenece a 1dc3375a; no se traslada a este candidato.

Suite completa final: 1889 pass, 1 skip, 0 fail. Las regresiones cubren selección explícita, recuperación de edición y entrega verificada, diagnóstico incompleto, aprobación/reapertura y referencias de resultados limitadas al run. Build, tipos, arquitectura, contrato y documentación pasan. El snapshot de firmas se regeneró tras revisar la adición opcional a onDiagnostics y está incluido en este tarball.

La primera optimización (560a1c37) conservó 18/21 éxitos y redujo 23,6% la entrada en las 18 celdas históricas comparables. Se preserva completa en CONTEXT_CAMPAIGN. El candidato intermedio 76ae5206 pasó gates Anthropic pero presentó 12 regresiones determinísticas de contratos internos; no se ejecutó su piloto completo. Se restauraron las herramientas requeridas por recuperación/entrega antes de congelar este candidato. El precursor f24b2544 conserva sus gates separados. Ningún resultado de esos candidatos se mezcla con esta campaña. No hubo commit, push, PR, publicación ni promoción formal de soporte.

Fuentes de diseño: [Claude Code](https://code.claude.com/docs/en/costs), [Cursor](https://cursor.com/blog/dynamic-context-discovery), [OpenCode V2](https://dev.opencode.ai/v2/docs/compaction/) y [Aider](https://aider.chat/docs/repomap.html). El piloto compara Harness con una referencia técnica SDK, no ejecuta esos productos comerciales.
