# Assistant MVP por fases

Plan acordado el 2026-11-10. Producto hermano de Code sobre Harness.
Objetivo: un usuario, Telegram privado, Google Calendar y una sola máquina.

> Cada mañana revisá mi agenda y avisame si hay conflictos. Si proponés cambiar
> una reunión, mostrame el cambio y pedime aprobación.

Harness controla cómo se ejecuta una tarea con garantías. Assistant controla
quién la solicita, cuándo se ejecuta, con qué aplicaciones y dónde se entrega.
Los contratos y decisiones de fase 0 están en [ASSISTANT_CONTRACTS.md](ASSISTANT_CONTRACTS.md).

## Fase 0 — Contratos y límites

**Harness:** inventariar APIs públicas, definir extensiones mínimas para perfiles
y efectos externos, preservar compatibilidad con Code y estado existente.

**Assistant:** crear `@zhivex-ai/assistant` independiente; definir propietario,
conversación, conexión, automatización y entrega; separar estado mediante IDs.
Sin grupos, voz, navegador, marketplace ni múltiples usuarios en el MVP.

**Salida:** contratos documentados y ejemplo que ejecuta una tarea consumiendo
un paquete Harness instalado sin imports internos. No requiere cambiar el motor.

## Fase 1 — Asistente general y host persistente

**Harness:** perfil configurable de instrucciones/herramientas; perfil general
sin programación; identidad y versión del perfil ligadas a recuperación;
perfil actual predeterminado para Code.

**Assistant:** proceso permanente, inicio/apagado/recuperación, directorio propio,
conversaciones y serialización por conversación, configuración/logs/diagnóstico.
Conservar el workspace interno en este MVP.

**Salida:** conversación de prueba recuperable tras reinicio, con aprobaciones
pendientes intactas y sin repetir acciones completadas.

## Fase 2 — Telegram e identidad

**Harness:** reutilizar comandos, eventos, cancelación y aprobaciones; completar
solo datos genéricos faltantes para presentar decisiones fuera de la terminal.

**Assistant:** vincular propietario, persistir/deduplicar entradas, asociar chats
y sesiones, responder/cancelar/aprobar, persistir entregas y reintentos. Cada
decisión queda ligada a propietario, acción, revisión y vencimiento.

**Salida:** entradas duplicadas producen una tarea; decisiones repetidas no
duplican efectos; usuarios ajenos no pueden operar el asistente.

## Fase 3 — Calendar y autorización

**Harness:** evaluar contratos existentes de efectos externos y completar
estados pendiente/confirmado/fallido/incierto; políticas acotadas de lectura;
aprobación ligada a argumentos exactos para escrituras.

**Assistant:** OAuth, credenciales protegidas y renovación, herramientas Calendar,
propuesta con reunión/horarios/asistentes, reconciliación específica del proveedor.
Revalidar el evento al ejecutar; cualquier cambio relevante invalida la propuesta.

**Salida:** leer agenda y modificar una reunión aprobada; reconciliar cortes sin
repetir escrituras a ciegas. Las notificaciones a asistentes también son efectos
que deben aparecer en la propuesta.

## Fase 4 — Automatizaciones y memoria personal

**Harness:** reutilizar ejecución durable y presupuestos; interfaz genérica de
contexto con procedencia si falta; memoria nunca equivale a permiso.

**Assistant:** scheduler persistente, zona horaria y política de horarios perdidos,
identidad por ocurrencia, entregas persistentes, límites de frecuencia/consumo.
Preferencias explícitas: horario, calendario y definición de conflicto; listar,
corregir y olvidar. Sin búsqueda semántica ni consolidación automática inicial.

**Salida:** resumen diario tras reinicio, zona horaria correcta, pausa/eliminación.

## Fase 5 — Validación y piloto

**Harness:** regresiones de Code y contratos; aislamiento de scopes, cancelación,
vencimientos, recuperación y contenido externo sin autoridad sobre políticas.

**Assistant:** onboarding completo, diagnóstico, desconexión/revocación, pruebas
de reinicios, duplicados, credenciales vencidas y eventos modificados en paralelo.

**Salida:** piloto de varios días con trazabilidad mensaje → ejecución → resultado.

## Secuencia y estado

Conversación → canal → acciones aprobadas → proactividad. Cada fase requiere sus
criterios de salida antes de habilitar la siguiente para usuarios.

- Fase 0: completada; contratos, scaffold y aceptación de paquete instalado.
  Evidencia y límites en el documento de contratos.
- Fase 1: implementada; perfil general aditivo, host local persistente y recuperación
  probada con procesos Node separados. Ver [guía y límites](ASSISTANT_HOST.md).
- Fase 2: integración Telegram implementada y validada offline; vinculación,
  deduplicación, entregas y aprobaciones persistentes. Ver [Telegram](ASSISTANT_TELEGRAM.md).
  La validación con un bot real queda para el despliegue.
- Fase 3: Calendar y OAuth implementados y validados con APIs simuladas; aprobación
  Telegram, revalidación e idempotencia persistente. Ver [Calendar](ASSISTANT_CALENDAR.md).
  Pendiente validación con cuentas reales; no hay migración automática del perfil anterior.
- Fase 4: implementada; scheduler diario persistente, preferencias explícitas con
  procedencia, zonas/DST, recuperación y outbox Telegram. Ver [automatizaciones](ASSISTANT_AUTOMATIONS.md).
  Resumen determinista de solo lectura; validación con APIs simuladas.
- Fase 5: validación local y preparación del piloto implementadas; onboarding,
  preflight offline y matriz de aceptación en [piloto](ASSISTANT_PILOT.md).
  El piloto de varios días y la certificación con cuentas reales siguen pendientes.
- Este trabajo no autoriza publicación, despliegue ni merge a `main`.

## Extensión posterior al MVP

Proveedores OpenAI compatibles configurables y módulos componibles implementados
en Assistant, manteniendo una instancia por propietario. Calendar es el primer
módulo y puede combinarse con herramientas MCP. Ver [contrato, ejemplos y evidencia](ASSISTANT_EXTENSIONS.md).
