# Contexto restaurado: eficiencia sin recortar evidencia — 2026-11-15

La representación nueva reduce **8,04–8,29 % los tokens** y **7,93–7,95 % el costo por tarea aceptada** frente a la versión actual que ya conservaba las lecturas. Las ocho tareas por versión aprobaron contexto, calidad ejecutable y seguridad. No se demostró una mejora consistente de latencia.

## Cambio implementado

`numbered-read-lines.ts` elimina exclusivamente los prefijos secuenciales agregados por el renderizador (`1: `, `2: `, …) de las lecturas históricas restauradas. Conserva el texto fuente completo, el número inicial y una regla exacta de reconstrucción. No selecciona fragmentos ni resume código. Espacios, líneas vacías, finales CR/LF y Unicode sobreviven al round trip. Para lecturas cortas, numeración irregular o representaciones mayores se conserva la alternativa anterior. Se elige la menor representación serializada entre esta codificación y la de sufijos existente; esa selección por bytes/caracteres no garantiza ahorro de tokens para cualquier contenido.

El cambio se aplica a `read_file` y a cada contenido de `read_files` restaurados; errores y `read_tool_result` permanecen intactos. Metadatos, identificadores, argumentos originales y orden se conservan. El caché por ejecución sigue limitado a 8 MiB y exige igualdad del contenido original. Se actualizó la versión del fingerprint de contexto.

La restauración sigue siendo exclusiva del transporte: no se guarda nuevamente en el historial compacto. Conserva roles de herramientas y aviso de evidencia histórica no confiable; no concede permisos ni sustituye la lectura fresca exigida para editar. Los límites de transporte contabilizan la petición expandida. No cambian aprobación, aislamiento, herramientas autorizadas ni trazabilidad de lecturas fallidas.

## Comparación real predefinida

- Dos modelos (`gpt-6-luna`, `gpt-6.1-sol`), dos tareas de reparación reales (`path-policy`, `text-integrity`), dos repeticiones: ocho pares / 16 ejecuciones. Orden AB/BA alternado por tarea y repetición, sin reintentos ni selección posterior de resultados.
- Antes: bundle inmutable del runtime final de la campaña anterior, SHA-256 `f00f820066152df486f0a24078bc6a2395b9996b9e3b2776d9674186a49d5f9c`. Después: `7afcdc77ddfe147529af7e3bf03febde82619e23fa53bd23f3b064e5f416737b`.
- Mismos hashes de tareas que en la validación anterior: seis archivos completos, unos 67.000 caracteres de código real poco repetitivo, restricciones tempranas y tardías y un comentario adversarial. No se reemplazaron por ejemplos más fáciles o padding repetitivo.
- OpenAI Responses, historial completo, razonamiento bajo, ocho pasos, 4.096 tokens máximos de salida por petición; presupuesto por tarea 300.000 entrada / 16.000 salida / 316.000 total. Umbral de compactación 12.000 estimados. Sin aumento de los límites actuales.
- Costos: todos los intentos divididos por tareas **aceptadas**, incluyendo evaluación funcional, contexto, orden/completitud de lecturas, seguridad y conciliación de consumo SDK/proveedor. Ningún intento fue excluido. Latencia incluye la evaluación Bun aislada.

| Modelo | Aceptadas antes → después | Tokens totales, 4 tareas por versión | Tokens/tarea aceptada | USD/tarea aceptada | Latencia media verificada |
| --- | --- | --- | --- | --- | --- |
| gpt-6-luna | 4/4 → 4/4 | 363.495 → 333.371 (−8,29 %) | 90.873,75 → 83.342,75 | 0,009269875 → 0,008534375 (−7,93 %) | 11,518 s → 11,814 s |
| gpt-6.1-sol | 4/4 → 4/4 | 361.434 → 332.366 (−8,04 %) | 90.358,50 → 83.091,50 | 0,182913 → 0,168379 (−7,95 %) | 11,751 s → 11,616 s |

Los ocho pares consumieron menos tokens con el cambio. Luna tuvo una llamada adicional a `discover_tools` en un intento optimizado; su consumo y latencia están incluidos. La entrada total bajó de 361.670 a 331.370 tokens en Luna y de 360.336 a 331.268 en Sol. La salida fue 1.825 → 2.001 y 1.098 → 1.098, respectivamente. No hubo tokens cacheados reportados ni consumo desconocido: el ahorro no depende de descuentos de caché.

Las llamadas optimizadas incluyeron el nuevo formato en **36 peticiones** y ejecutaron **21 compactaciones SDK**. En ambos brazos, las 16 ejecuciones conservaron identificadores de contexto temprano/tardío y política `bun-only`, completaron las seis lecturas sin truncar y aprobaron las tres familias de pruebas funcionales de su módulo. No hubo accesos prohibidos, herramientas no autorizadas, filtraciones de canarios ni modificaciones de las entradas. Las 16 trazas de producción coinciden con la reconstrucción de intentos desde pasos durables. Esta campaña no produjo lecturas fallidas; su conservación se comprueba con regresiones locales que sí fuerzan errores.

Costo estimado de toda la campaña: **USD 1,476385**, con **1.390.666 tokens** en 113 llamadas. Tarifas Standard consultadas el 2026-11-15: Luna entrada/salida/cache USD 0,10/0,50/0,01 por millón; Sol USD 2/10/0,10. [Fuente oficial](https://developers.openai.com/api/docs/pricing). Es una estimación por tarifas públicas, no una factura; razonamiento está incluido en salida.

## Verificación y límites

Se comprobó con Bun la reconstrucción exacta en los 12 archivos de ambas tareas y en entradas con Unicode, espacios, líneas vacías, números iniciales altos y finales CR/LF. Las regresiones cubren lecturas por lotes, metadatos, errores intactos, roles sin promoción a sistema, idempotencia, no mutación del estado, invalidación del caché, continuidad tras compactación y rechazo por presupuesto antes de despachar. El evaluador detecta ambos defectos introducidos y acepta los módulos correctos. Su sandbox bloquea lectura del hogar, escritura externa y red; no recibe credenciales.

`bun run typecheck` y `bun run typecheck:tooling` aprobaron. `bun run test`: **2.738 pass, 1 skip, 0 fail**, 18.305 aserciones en 367 archivos (257,72 s), con Bun 1.4.3. La omisión corresponde al ensayo de plataformas no soportadas. `git diff --check` también aprobó.

La muestra contiene dos tipos de reparación y cuatro pares por modelo: no establece equivalencia universal de calidad o seguridad. La pérdida de información de esta codificación se descarta por reconstrucción exacta; eso no garantiza que cualquier modelo aproveche igual todo contexto ni cambia otras partes del resumen de conversación. Los intervalos descriptivos de latencia incluyen cero mejora (Luna −1,511 a +1,027 s de reducción; Sol −0,449 a +0,491 s). La suite local se ejecutó concurrentemente y puede añadir ruido de CPU: no se atribuye una mejora de velocidad al cambio.

## Reproducción y evidencia

```sh
bun scripts/benchmarks/code-context/freeze-numbered-replay.ts /ruta/runtime-anterior /tmp/runtime-nuevo
bun scripts/benchmark-numbered-read-replay.ts --live --runtimes /tmp/runtime-nuevo --directory /tmp/campana-nueva
bun scripts/analyze-code-context-replay.ts /tmp/campana-nueva/campaign.json /tmp/resumen.json
bun test ./tests/numbered-read-lines.test.ts ./tests/working-read-replay.test.ts ./tests/request-projection.test.ts
bun run typecheck
bun run typecheck:tooling
bun run test
```

La ejecución live requiere credenciales locales y tiene un límite de campaña de 2,4 millones de tokens. [Resumen legible por máquina](evidence/numbered-read-replay-2026-11-15/summary.json), [todos los intentos y recibos](evidence/numbered-read-replay-2026-11-15/campaign.json) y [ledger de hashes y fuentes](evidence/numbered-read-replay-2026-11-15/ledger.json). Se archivan ambos bundles, fuentes de runtime/medición/evaluación y registros de pruebas; ninguna clave ni encabezado de autenticación.
