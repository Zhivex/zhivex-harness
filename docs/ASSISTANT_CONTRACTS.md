# Assistant: contratos y frontera con Harness

Estado: contratos de fase 0 con implementación de fases 1–4, 2026-11-10.
Ver [host persistente y perfil general](ASSISTANT_HOST.md).
Esquemas v1 experimentales; no son aún un
formato de base de datos publicado. Implementación: `packages/assistant`.

## Inventario de APIs existentes

| API pública | Uso previsto | Fase |
| --- | --- | --- |
| `/engine`: `createHarness`, `runHarness`, `CreateHarnessOptions` | Construcción, ejecución, cierre, scopes y presupuestos | 0 |
| `/engine`: `toolNames`, `subagentProfiles`, `projectContext`, `projectMemory` | Acotar catálogo y contexto del bootstrap | 0 |
| `/client`: `createHarnessClientAdapter` | Despacho, revisión, idempotencia y cancelación | 1–2 |
| `/protocol` | Contratos de cliente y eventos sin implementación de terminal | 1–2 |
| `/service` | Transporte local autenticado y recuperación; no gateway remoto | Evaluar en 1 |
| `/engine`: `openSessionStore` | Índice de conversaciones del engine | 1 |
| `/engine`: MCP, políticas y persistencia | Herramientas externas y aprobaciones | 3 |
| `/engine`: memoria de proyecto | Referencia de diseño; no mezclar memoria personal automáticamente | 4 |

Las opciones son campos de `CreateHarnessOptions`, no exports separados.
Cada API conserva su tier en `contracts/engine-api.json`; esta tabla no estabiliza
APIs experimentales. Assistant no lee tablas SQLite internas ni importa `src/`,
Code, Desktop o el export raíz de compatibilidad de Harness.

## Propiedad y almacenamiento

Harness posee runs, checkpoints, recibos de herramientas, decisiones de aprobación,
presupuestos y estado del motor. Assistant posee identidad, conexiones, reglas de
automatización, entradas, entregas y preferencias personales.

En fase 1 Assistant guarda su binding propietario/perfil en `state/host.json`,
separado físicamente del store de Harness. Solo enlaza `sessionId`/`runId`; no duplica checkpoints ni decide por su
cuenta que una aprobación fue aceptada. No hay transacción distribuida entre ambos
stores: usar IDs estables, registrar intención y reconciliar tras reinicio.
La fase 2 agrega `state/telegram.sqlite` para vinculación, asociación de sesión,
entradas, entregas y revisiones. Ver [Telegram](ASSISTANT_TELEGRAM.md). Calendar usa su propio registro; fase 4 añade preferencias y ocurrencias al store
Telegram. Ver [automatizaciones](ASSISTANT_AUTOMATIONS.md). Los esquemas de este
documento son contratos de dominio; no reflejan literalmente cada tabla SQLite.

| Registro | Campos y significado |
| --- | --- |
| Owner | ID local y vinculación explícita a usuario/chat privado Telegram. IDs remotos como strings decimales. |
| Conversation | Propietario, canal/chat y enlace opcional a sesión Harness. |
| Connection | Propietario, cuenta Calendar, scopes, estado y referencia opaca a credenciales. Nunca tokens. |
| Automation | Propietario, conversación, conexión, calendario, horario local/zona, próxima ocurrencia y enabled. |
| Delivery | Run u ocurrencia de automatización origen (exactamente uno), destino por conversación, clave de deduplicación, intentos, texto y estado de envío. |

Todos llevan `schemaVersion: 1`; las claves desconocidas y versiones no soportadas
se rechazan. Los esquemas validan forma, no propiedad: el host y sus stores verifican
que conversación, conexión y automatización pertenecen al mismo propietario.
`credentialRef` se resuelve en el host, nunca como ruta o código suministrado por
mensajes. Validar un registro no concede acceso a una cuenta.

## Flujos y garantías a implementar

1. **Entrada:** `(channel, account, updateId)` único → persistir → autenticar
   propietario/chat → resolver conversación → despachar con clave estable.
   Un payload no selecciona workspace, scope, credenciales ni política.
2. **Ejecución:** serializar por conversación; guardar relación tarea/run antes de
   entregar resultados. Tras caída, consultar el estado existente antes de repetir.
3. **Aprobación:** token opaco de callback → propietario/chat → solicitud del engine,
   revisión, digest, vencimiento → resolución por Harness. Nunca aprobar por texto
   generado por el modelo. No almacenar un booleano que sustituya su decisión.
4. **Automatización (decisión de fase 4):** clave por automatización/fecha local
   bajo el binding de propietario/conexión y lease Telegram. Recuperar el día
   actual, omitir fechas anteriores; no ejecutar backlog. Horas inexistentes
   avanzan al primer minuto válido del día; horas repetidas usan su primera
   aparición. Días inexistentes se omiten. Cambios recalculan el futuro.
   Esta política concreta reemplaza el borrador de fase 0 que omitía toda hora perdida.
5. **Entrega:** `pending → sending → sent`; error comprobado → `failed`, timeout o
   caída tras envío potencial → `uncertain`. Deduplicar localmente no garantiza
   exactamente una entrega en Telegram. No reintentar a ciegas estados inciertos.
6. **Calendar:** propuesta concreta con versión del recurso y efecto sobre
   asistentes; revalidación previa. Una respuesta incierta requiere reconciliación
   específica; no afirmar exactly-once si el proveedor no permite demostrarlo.

Las guías de cada fase documentan stores, leases, retención, scopes y conflictos. No hay promesa de ejecución
24/7 mientras la máquina esté apagada. Memoria y datos externos no otorgan permisos.

## Extensiones mínimas propuestas para Harness

- **Fase 1, implementada:** `createProfiledHarness` y `GENERAL_ASSISTANT_PROFILE`
  en `/engine`, con fingerprint de contenido y catálogo. `createHarness` conserva
  la firma estable y el perfil de Code. Assistant consume el candidato local;
  estos exports todavía no están en la versión publicada.
- **Fase 2:** usar el protocolo actual; extenderlo solo si falta información para
  representar o resolver una aprobación remota sin perder sus garantías.
- **Fase 3:** auditar journals/reconciliación MCP antes de diseñar otro journal.
  Agregar estados/contratos genéricos solo donde falten; OAuth, Google y Telegram
  nunca entran al motor.
- **Fase 4:** scheduler y memoria personal permanecen en Assistant. El resumen
  determinista usa solo lectura y no requiere contexto de modelo ni nuevos
  contratos del motor. Preferencias explícitas con procedencia no son autoridad.

En fase 0 no se modificó Harness. En fase 1 el bootstrap y el host usan el perfil
general; no se modificó el snapshot de firmas estables para acomodar el cambio.

## Aceptación de fase 0

`bun run build` en la raíz, seguido de
`bun run --cwd packages/assistant smoke:installed`, debe empaquetar Harness sin
reescribir su metadata, instalarlo en un consumidor temporal, comprobar resolución
local al consumidor, validar tipos/esquemas y ejecutar una tarea offline con Node.
El reporte imprime versión y SHA-256 del tarball. No certifica un proveedor real,
continuidad conversacional, aprobaciones remotas ni fases posteriores.

### Evidencia histórica de fase 0 — 2026-11-10

- `bun run build` (raíz): aprobado.
- `bun run architecture:check` y `bun run contract:check`: aprobados.
- Assistant `typecheck`, `test` y `smoke` contra la dependencia publicada 1.6.3:
  aprobados; 3 tests, 8 assertions; tarea offline completada con Node 22.21.0.
- `smoke:installed`: aprobado contra candidato local 1.6.3, resolución dentro
  del consumidor temporal; tipos, tests, build y tarea offline completados.
- SHA-256 del tarball candidato probado:
  `243962df5fae8cbb91625c79d83a7f02026ce9e3c128f07e977239b2fe6c8f4d`.
- Tooling: Bun 1.4.3. Sin llamadas a proveedores, publicación ni merge.

El hash identifica el artefacto de esta ejecución, no una certificación del
paquete publicado ni de builds futuros. Los cambios previos de Code/Web no forman
parte de Assistant y no se certificaron con estas pruebas.
