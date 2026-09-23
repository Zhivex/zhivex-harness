# Qwen: aceptación y redacción durable

## Hallazgo confirmado

Reproductor **offline**, Core 1.23.0-next.1 / Agents 1.9.0-next.1, sólo fixtures
sintéticos: `bun run scripts/diagnostics/reproduce-redaction-state-divergence.ts`.

| Caso | Guardrail posterior ve valor sintético | outputText devuelve valor | Estado/store conservan valor |
| --- | --- | --- | --- |
| Redacción, sin rechazo posterior | No | No | Sí |
| Redacción y rechazo posterior | No | Sí | Sí |

El SDK entrega `cloneState(output.state)` a los guardrails. La política de
redacción modifica ese snapshot y `output.outputText`, pero no el estado real que
se persiste. El rechazo posterior reconstruye la salida desde el estado original.
No es un fallo HTTP ni una propiedad del modelo: se reproduce sin red. La prueba
actual cubre runAgent y store en memoria; streaming, store durable, checkpoints e
historial son criterios pendientes de la HU, no cobertura afirmada.

[HU SDK de prioridad alta](https://app.notion.com/p/3e4777b104f681ef9774cb65fc9450f5).
No se desactiva redacción ni se copia ciegamente el snapshot sobre el estado.

## Interacción con aceptación

La regla de redacción `api-key` reconoce etiquetas `token:` seguidas de cadenas
alphanuméricas largas. Un fixture de hijo que lee correctamente y devuelve
`Acceptance token: ACCEPTED` reproduce el rechazo DELEGATION_ACCEPTANCE_FAILED.
El guardrail ve el marcador eliminado, mientras el estado original lo conserva.
La regresión exige que una cadena con forma de credencial no evada la redacción;
no establece la persistencia insegura como comportamiento deseado.

Esto explica una forma determinística de producir la contradicción observada en
live. No demuestra el texto exacto del fallo histórico, porque no se retuvo. La
corrección del Harness pide ahora un marcador en una línea sin etiqueta ni prefijo;
conserva marcadores, lectura obligatoria, presupuestos, redacción y assertions.
Su identidad durable cambia a completion-marker-v3. Esta mitigación todavía no
se validó live y no repara el defecto de persistencia del SDK.

## Nuevos diagnósticos live acotados

- Un caso falló con padre y hijo mostrando sus marcadores, hijo failed y una
  herramienta sin error; evento tipado: guardrail de aceptación.
- Otro caso inspeccionó el hijo persistido: dos pasos, read_file exitoso, último
  paso stop con marcador; error DELEGATION_ACCEPTANCE_FAILED.
- El probe del guardrail a través del padre falló antes de delegar, sin hijos.
  Es una variante adicional de incumplimiento del coordinador, no evidencia de
  ejecución del hook del hijo.
- Tres controles directos del hijo por Responses pasaron. Sus guardrails vieron
  marcador y lectura correctos. Esta ruta explícita difiere de la configuración
  heredada del hijo Qwen; no se usa para declarar resuelta la delegación completa.

También se corrigió el diagnóstico del smoke: conservar la causa tipada en memoria
y sanear una sola vez al serializar. Sanear/restaurar antes de envolver el error
hacía perder sus detalles anidados. El raw no se escribe ni se imprime.

## Verificación y siguiente frontera

46 tests focalizados y typecheck de tooling aprobados tras los cambios finales.
CI de PR #103 estaba verde en 4cb7706; debe renovarse para el nuevo commit.
No se ejecutó la matriz restante tras confirmar el defecto SDK. La publicación
permanece bloqueada. Requiere corregir/publicar el SDK, instalar sus bytes exactos,
verificar este reproductor y volver a certificar el candidato completo; los
verdes anteriores no satisfacen ese requisito.

[Evidencia saneada](evidence/qwen-redaction-attribution-2026-09-23.json). Sólo
booleanos, contadores y enums; sin payloads, headers, credenciales ni SQLite.

## Ampliación después de integrar PR #103

PR #103 se integró como 2d3100d con cabeza 4cb7706; el seguimiento 5336527
quedó fuera del merge y se presenta desde una rama nueva basada en ese main.
El registry sigue ofreciendo Core 1.23.0-next.1 / Agents 1.9.0-next.1.

La reproducción ampliada confirma ocho casos: generate/stream, memoria/archivo
reabierto, con/sin rechazo. En los ocho persisten el texto, mensajes y pasos con
el fixture; en los cuatro rechazos vuelve a aparecer en outputText. Los chunks
streaming anteriores al guardrail también contienen el fixture, pero son una
observación separada: un guardrail terminal no promete censura de chunks previos.

`bun run check:sdk-redaction` ejecuta el repro con `--require-fixed` y exige que
texto final devuelto/persistido, mensajes y pasos persistidos estén saneados.
Se añade al principio de release:check, después de metadata y antes de gates
costosos. Con el SDK actual falla intencionalmente. No se puentea ese gate;
una versión SDK reparada debe demostrarlo con los paquetes realmente instalados.
