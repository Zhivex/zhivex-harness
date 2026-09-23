# Preparación RC9 y Muse Spark 1.3

Base main f719537 (PR #102 integrada). CI y CodeQL de esa base pasan.
Registry: latest 1.0.0, next 1.1.0-rc.3; RC8 y RC9 no publicadas. RC8 tiene tag
inmutable; RC9 se prepara sin crear tag ni iniciar publicación.

## Implementación

Muse Spark 1.3 pasa a ser el modelo predeterminado de Meta para nuevas selecciones.
Los modelos guardados se conservan. El factory integrado fuerza Responses tanto
para generate como stream, incluidos hijos. El binding de Meta incorpora la
política de transporte para rechazar reanudaciones silenciosas de runs anteriores.

El coordinador usa el resultado del hijo como evidencia y conserva el formato de
respuesta pedido por el usuario; deja explícito que los marcadores del hijo no
sustituyen la respuesta solicitada. La identidad del contrato cambia a caller-output-v2.
No se fabrican marcadores ni se relajan aserciones o presupuestos.

El smoke identifica checkpoints de estado, salida, delegación, hijo, presupuesto y
reapertura. Conserva errores terminales del SDK; captura su proyección saneada en
el stream antes de que el estado durable reduzca el error a un mensaje. Sólo se
persisten enums y contadores aprobados, no mensajes ni payloads.

RC9 tiene mapeo propio: Muse 1.3, Qwen Flash y Luna 6. No altera modelos históricos.

## Campañas (incluyen los fallos)

| Campaña | Resultado |
| --- | --- |
| Base completa Meta con Responses | 3/3 pasan, aprobación y reinicio |
| Base completa Qwen Flash | 3/3 pasan, aprobación y reinicio |
| Orquestación inicial Meta Responses | Falla el primer caso; serie detenida |
| Orquestación inicial Qwen | Falla; routing no ejecutado |
| Diagnóstico con checkpoints | Meta pasa; Qwen falla orchestration_status |
| Diagnóstico Qwen conservando error de estado | Pasa; no reconstruye el fallo anterior |
| Coordinador caller-output-v2 | Meta 3/3 pasan con jerarquía y reapertura; Qwen falla el primer caso en orchestration_status; serie detenida |
| Diagnóstico Qwen con observador de error tipado | Pasa; no demuestra resolución del fallo |

La causa original de los fallos de estado Qwen aún no está atribuida: los primeros
no conservaron el error tipado. El próximo caso fallido podrá proyectarlo sin exponer
contenido. Los verdes no sustituyen los rojos ni certifican fiabilidad general.

## Validación determinística

- Suite completa: 986 pasan, 1 omitido por plataforma, 0 fallos. Incluye Desktop,
  migraciones, MCP, OCI sin modelo y consumidor instalado RC9.
- Tras el último cambio de observación: 46 tests focalizados y typecheck de tooling.
- Metadata de release, documentación y diff check aprobados.
- Auditoría: sin vulnerabilidades en 48 paquetes; cero dependencias con scripts no confiables.
- pack:inspect aprobado. No es aún el artefacto de un tag revisado.
- Release readiness rechaza correctamente rama distinta de main y worktree sucio.

## Pendiente

Resolver/atribuir el fallo intermitente de orquestación Flash sin ampliar presupuestos,
reemplazarlo por Max ni repetir hasta verde. Después: routing, OCI live y matriz
representativa completa del artefacto exacto; revisión/integración de esta preparación,
CI del SHA final y workflow protegido. No hay una RC lista para publicar todavía.

[Evidencia saneada](evidence/muse13-rc9-readiness-2026-09-23.json).
