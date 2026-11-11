# Assistant — Calendar (fase 3)

Integración local de un propietario y un calendario fijo. Assistant es dueño de
OAuth, credenciales y registro de operaciones; Harness conserva la política,
aprobaciones durables y ejecución. No se agregan endpoints Google al motor.

## Conectar y ejecutar

Preparar el candidato local y construir Assistant según su [README](../packages/assistant/README.md).
En Google Cloud habilitar Calendar API, configurar consentimiento (y usuario de
prueba si corresponde) y crear un cliente OAuth de tipo **Desktop app**. Se usa
[OAuth para aplicaciones instaladas](https://developers.google.com/identity/protocols/oauth2/native-app)
con PKCE S256, estado de un solo uso y callback en `127.0.0.1` con puerto efímero.
El navegador debe poder llegar al loopback de la máquina que ejecuta Assistant.

Configurar en el entorno:

- `ASSISTANT_GOOGLE_CLIENT_ID`: cliente Desktop.
- `ASSISTANT_GOOGLE_CLIENT_SECRET`: si está incluido en la configuración del cliente.
- `ASSISTANT_CREDENTIAL_KEY`: clave aleatoria de 32 bytes codificada en base64.
  Generarla una vez (por ejemplo `openssl rand -base64 32`), guardarla fuera del
  directorio de estado y reutilizarla tras reinicios. No se genera ni reemplaza
  automáticamente; una clave distinta no puede descifrar la conexión existente.
- Credencial del proveedor del modelo y `ASSISTANT_TELEGRAM_BOT_TOKEN`, como en
  las [instrucciones Telegram](ASSISTANT_TELEGRAM.md).

Con el host detenido:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-cal" --owner local-owner --calendar-connect
```

Abrir la URL impresa en el navegador y completar el consentimiento. Se solicitan
`openid`, `email` y `calendar.events`. No enviar códigos, tokens ni la clave a
Telegram. El flujo vence en diez minutos; no ofrece un callback remoto público.
Luego iniciar el host con el mismo directorio, propietario y credenciales:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-cal" --owner local-owner --provider openai --calendar --calendar-id primary --telegram-owner 123456789
```

Reemplazar el ID por el propietario y completar la vinculación local de Telegram.
`--calendar-id` queda fijado al perfil del host; por defecto es `primary`.
Para consultar o desconectar, detener el host y ejecutar el mismo comando base
con `--calendar-status` o `--calendar-disconnect`. La desconexión elimina primero
el acceso local y reporta si Google confirmó la revocación. Si `revoked` es falso,
revocar también desde la cuenta Google. Un refresh rechazado exige nuevo consentimiento.

**Compatibilidad del directorio:** el perfil de fases anteriores permanece inmutable.
Habilitar Calendar requiere un nuevo directorio privado y nueva vinculación de
Telegram; no se migran conversaciones ni aprobaciones al perfil ampliado. Cambiar
calendario o reconectar después de desconectar también requiere un nuevo host.
Reautorizar la misma cuenta sin desconectarla conserva la identidad de conexión.
Nunca borrar `host.json` para eludir esta comprobación.

## Flujo de una modificación

1. `calendar_read_list/read` consulta el calendario. Listado: hasta 100 eventos
   por página, intervalo máximo de 90 días, paginación y completitud explícitas.
2. `calendar_read_propose` obtiene el evento y persiste una propuesta de 15 minutos.
   Devuelve al modelo solo `operationId` y digest SHA-256 de la propuesta inmutable.
3. `calendar_write_apply` solicita la aprobación normal de Harness. El host carga
   la propuesta desde su registro y muestra en Telegram evento, calendario,
   cuenta, antes/después, asistentes, vencimiento y efectos de notificación.
   El contenido mostrado queda ligado a la revisión de Telegram y al digest.
   La referencia evita que la redacción de PII del motor altere los argumentos
   durante la recuperación. No se confía en un resumen escrito por el modelo.
4. Al aprobar, se valida propietario/chat/mensaje/revisión y se vuelve a consultar
   el evento. Cualquier ETag diferente exige nueva propuesta y aprobación.
5. Antes del PATCH se persiste `dispatching`. Se envía `If-Match` con el ETag
   aprobado, `sendUpdates=all` y un marcador privado `zhivexOperation`, conservando
   las demás propiedades privadas. Un 412 produce conflicto, sin reintento.
6. Solo se confirma al verificar marcador y campos finales. Repetir una operación
   confirmada devuelve el resultado guardado, sin otro PATCH.

Se reutilizan los [ETags condicionales de Calendar](https://developers.google.com/workspace/calendar/api/guides/version-resources)
y el parámetro de notificaciones de [events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch).
El resultado confirma que se solicitó notificar; no demuestra entrega de correos.

## Recuperación y límites

Credenciales y estado OAuth se cifran con AES-256-GCM; la clave permanece externa.
El registro SQLite separado (`state/calendar.sqlite`) y sus permisos privados
protegen propuestas, que contienen datos de eventos y asistentes **sin cifrado**.
El host mantiene exclusión por proceso. Tras una caída, `--recover` solo acepta
un propietario muerto y convierte `dispatching` en `uncertain`.

`calendar_read_reconcile` lee Google: si encuentra marcador y campos exactos,
confirma; en caso contrario mantiene incertidumbre. Nunca repite un PATCH por
un timeout. Una operación incierta bloquea nuevas modificaciones del evento.
El MVP requiere inspección local cuando la lectura no puede resolverla; no tiene
un botón para forzar reenvíos ni promete entrega exactamente una vez en Google.

Se permite cambiar título e inicio/fin de eventos individuales con hora, normales,
y organizados por el calendario conectado. No se admite crear/borrar eventos,
modificar invitados, series, instancias recurrentes, eventos de día completo o
con listas de asistentes incompletas. Lecturas son herramientas de confianza del
host, limitadas a endpoints fijos; las escrituras siguen la política de Harness.
Una política que exija revisión explícita del host no se elude desde Telegram.

## Evidencia

`packages/assistant/tests/calendar.test.ts` cubre OAuth/PKCE/estado, refresh y
revocación simulados, cifrado y clave incorrecta, rechazo de otra cuenta, propuestas
vencidas/alteradas, ETags y carrera 412, respuestas perdidas antes/después de PATCH,
recuperación del registro y ausencia de reenvíos. La prueba integrada usa el host
real, aprobación Telegram persistida, reinicio de ambos y cambio de evento antes
de aprobar. El callback OAuth se verifica con HTTP loopback real.

Las APIs de Google y Telegram y el modelo se simulan. Falta validar consentimiento,
políticas del proyecto Google y entrega real de notificaciones con cuentas de prueba;
esta fase no despliega ni envía mensajes/eventos reales.

Validación local 2026-11-10: consumidor instalado con 29 pruebas, 149 aserciones,
0 fallos; typecheck y ejemplo offline Node correctos. Candidato Harness 1.6.3
no publicado, SHA-256 `37f38a0d090658981b9a085b39f11b8ba37023e608a32ca1c4dbc3f731bbf5b2`.
También pasaron arquitectura, contratos, documentación y `git diff --check`.
