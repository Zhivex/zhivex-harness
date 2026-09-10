# Reevaluación de Qwen tras las mejoras del harness — 2026-09-09

> Historical snapshot: versions, findings and measurements below describe the recorded run, not the current checkout. See the [report index](README.md) for follow-up work and the [documentation index](../README.md) for maintained guides.

La [revisión estructural posterior](HARNESS_ARCHITECTURE_REVIEW_2026-09-09.md)
contrasta estas trazas con el controlador y añade reproductores offline de los
problemas pendientes. No modifica los resultados congelados de esta corrida.

Zhivex terminó con **0/10 reparaciones entregadas**, frente a **4/10 de
mini-SWE-agent**. Las mejoras no aumentaron la tasa final respecto de la corrida
anterior (0/5 frente a 2/5). La captura independiente detectó tres parches
correctos de Zhivex que quedaron sin verificar ni importar al agotarse el
presupuesto. No cuentan como éxitos finales ni como mejora frente a una
medición anterior que no capturaba ese dato.

## Diseño y evidencia

- Modelo solicitado: `qwen3.8-flash`, proveedor Qwen, endpoint internacional de
  DashScope, Chat Completions, thinking desactivado en ambos candidatos.
- SWE-bench Verified, revisión `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`:
  cinco tareas conocidas, dos repeticiones por candidato, veinte intentos.
  Es una reevaluación de desarrollo; no es un nuevo holdout ni veinte tareas
  independientes. No permite afirmar superioridad general ni aislar causalmente
  el efecto de cada mejora.
- Harness `1.0.0-rc.13`, Core `1.14.0`, Agents `1.4.0`, Qwen `0.11.4`;
  mini-SWE-agent `2.4.6`, evaluador SWE-bench `4.1.0`.
- Límites: 24 pasos, 2.048 tokens de salida por respuesta, 100.000 de entrada
  acumulada, 16.000 de salida acumulada, 300 segundos, 2 CPU y 2.048 MiB.
  El límite acumulado se comprueba entre peticiones y puede sobrepasarse en una
  respuesta. Los límites de herramientas y pasos no son idénticos entre loops.
- Ambos usan las mismas imágenes de tarea, sin red dentro del contenedor.
  Zhivex usa raíz de solo lectura, `/workspace`, aprobaciones automáticas del
  operador y cierre con verificación/importación; mini conserva su loop y
  `/testbed` escribible. El perfil repair limita salida OCI a 20.000 bytes;
  el adaptador mini recorta a 100.000 caracteres. Son diferencias declaradas.
- Preflight aprobado en cinco imágenes, sin llamadas al modelo. Veinte
  muestras únicas, ninguna faltante ni fallo de evaluación. Uso completo en
  las veinte. Los 60 hashes de fuentes coinciden con el checkout y la copia
  archivada al terminar: no se modificó el runtime durante la comparación.

La [baseline pública](../../benchmarks/baselines/external-qwen-remediation-2026-09-09.json)
conserva configuración, hashes, métricas y diagnósticos sanitizados. Los parches,
predicciones y logs oficiales permanecen en el directorio local ignorado
`results/swebench/qwen-remediation-2026-09-09/`.

## Resultados

| Tarea | Zhivex final | Zhivex candidato correcto | Mini final |
| --- | ---: | ---: | ---: |
| sympy-21930 | 0/2 | 0/2 | 0/2 |
| scikit-learn-10908 | 0/2 | 1/2 | 2/2 |
| django-15554 | 0/2 | 0/2 | 0/2 |
| scikit-learn-14141 | 0/2 | 2/2 | 2/2 |
| django-11265 | 0/2 | 0/2 | 0/2 |
| Total | **0/10** | **3/10** | **4/10** |

La captura de candidatos funcionó en los veinte intentos; capturar un candidato
vacío no significa producir un parche. Zhivex produjo tres candidatos no vacíos,
y los tres pasaron la evaluación independiente. Mini produjo ocho no vacíos y
cuatro pasaron. La diferencia final por tarea es −40 puntos porcentuales;
el intervalo bootstrap exploratorio del reporte es [−80, 0], con solo cinco
tareas como unidades de remuestreo.

| Métrica (10 intentos por candidato) | Zhivex | Mini |
| --- | ---: | ---: |
| Tokens de entrada | 943.192 | 734.184 |
| Tokens de salida | 10.327 | 12.184 |
| Llamadas al modelo | 117 | 133 |
| Mediana de duración del driver | 36,51 s | 41,50 s |
| Agotamientos de presupuesto | 9 | 4 |
| Otro fallo terminal | 1 | 0 |

La mediana incluye fracasos y excluye el evaluador externo; no demuestra mayor
velocidad para resolver. No hay tiempo a reparación exitosa de Zhivex. No se
suministraron precios: costo USD y costo por solución permanecen desconocidos.
La corrida anterior tenía uso incompleto de Zhivex y una sola repetición; no se
deduce ahorro de tokens comparando sus totales con estos resultados.

## Qué sigue fallando en el harness

**El cierre no dispone de una reserva efectiva.** Nueve intentos entraron en
modo de cierre, pero hubo cero bloqueos de llamadas amplias y cero bloqueos por
fase. Ninguno solicitó la verificación del harness. Los tres parches correctos
se quedaron dentro del entorno de ejecución; la evaluación posterior es solo
diagnóstica y no sustituye aprobación, verificación ni importación.

En scikit-learn-10908 repetición 2, la edición gobernada terminó a los 74,23 s;
el agente siguió solicitando comandos y acabó con 102.299 tokens de entrada.
En scikit-learn-14141 las ediciones gobernadas terminaron a los 41,78 y 21,98 s,
pero tampoco hubo transición a verificación antes del corte. Hay capacidad de
resolver esos casos; falta convertirla en una entrega dentro del presupuesto.

**El catálogo añadido consume contexto en cada petición.** Las definiciones de
herramientas pasaron de 6.629 a 8.995 caracteres (+35,7%); sistema más catálogo
pasó de 11.157 a 13.755 (+23,3%). La media de resultados de herramientas presentes
en cada petición bajó de 10.225,85 a 9.486,09 caracteres (−7,2%), sobre 66 y 117
peticiones respectivamente. Son mediciones de caracteres serializados, no
tokens facturados ni una ablación controlada. Las ayudas de memoria y planificación
tienen un costo fijo que debe medirse frente al beneficio que aportan.

Las siguientes intervenciones a validar son:

1. Reservar presupuesto para verificar/importar y hacer explícita la transición
   posterior a una edición, manteniendo permisos y controles de integridad.
   La reserva debe considerar el tamaño de la siguiente petición y del catálogo;
   rechazar únicamente búsquedas amplias no alcanza.
2. Exponer un catálogo pequeño por fase, conservando las herramientas necesarias
   para corregir una reparación o un fallo de verificación. Medir la reducción
   real de tokens y su efecto sobre las soluciones entregadas.
3. Ajustar compacción e historial con el costo completo de cada petición, y
   reducir exploración que continúa dentro de comandos de shell aprobados.
4. Comparar esas variantes por separado en la cohorte de desarrollo y después
   evaluar una cohorte nueva, sin modificar la métrica para contar candidatos
   sin entregar. Esta corrida no incluye esas futuras intervenciones.

## Hallazgo del SDK y HU

Un intento de SymPy falló tras una respuesta por una herramienta no registrada.
El nombre exacto no quedó en el diagnóstico sanitizado, por lo que no se atribuye
un nombre concreto a esa llamada. La reproducción offline con Core 1.14.0 muestra
que el modelo entrega uso (100 entrada, 10 salida), pero el estado durable queda
fallido con cero pasos, cero resultados y uso ausente. El middleware del harness
sí conservó los 4.132 tokens de entrada del intento live.

Creada y verificada en el área Zhivex, prioridad Alta, estado Sin empezar:
[SDK-HU — Conservar uso y diagnóstico ante herramientas no registradas; recuperación explícita acotada](https://app.notion.com/p/3d7777b104f681248ed3cecffe9328d2).

La pérdida de uso/diagnóstico durable es el defecto reproducido. Recuperar
herramientas desconocidas es una petición de funcionalidad optativa: la HU
anterior de validación de argumentos no incluía ese caso. No se propone ejecutar
herramientas desconocidas, remapear nombres ni eludir aprobaciones.

Reproducción sin red, con cero ejecuciones de herramientas:

```sh
bun --no-env-file run evaluations/audits/sdk-unknown-tool-2026-09-09.ts
```

El `../../evaluations/audits/sdk-unknown-tool-2026-09-09.ts` (source checkout) pasó typecheck
independiente. El reporte y la baseline se validaron contra las veinte muestras
y los hashes congelados. No se efectuó una nueva matriz paga, publicación ni
cambio del runtime como parte del cierre de esta reevaluación.
