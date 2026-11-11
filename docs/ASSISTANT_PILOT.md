# Assistant — validación y preparación del piloto

Estado: candidato local, no publicado. Fases 0–4 implementadas. La fase 5 prepara
el onboarding y valida el software localmente; el piloto de varios días con
cuentas reales tiene su propia aceptación y **todavía no está ejecutado**.

Para la primera sesión de uso, seguir la [guía de pruebas de hoy](ASSISTANT_FIRST_DAY.md).

## Onboarding de punta a punta

Usar una máquina local con Node >=22.13, Bun >=1.4, red y navegador local. Elegir
un directorio corto y privado (por ejemplo `$HOME/.zhx-pilot`) y un propietario
estable (`local-owner`). Si ya se usa fase 3/4, conservar directorio y configuración;
si se viene del perfil sin Calendar, usar un directorio nuevo.

1. Desde la raíz del repo, preparar el candidato de esta rama:

   ```sh
   bun run build
   bun run --cwd packages/assistant prepare:local
   bun run --cwd packages/assistant build
   ```

   La dependencia publicada 1.6.3 todavía no incluye los exports experimentales
   usados por Assistant. `prepare:local` instala el artefacto local sin cambiar el
   manifiesto. Después de reinstalar dependencias, repetir esa preparación.

2. Crear un bot dedicado a polling, obtener su token y el ID numérico propio
   mediante una fuente de confianza. Configurar `ASSISTANT_TELEGRAM_BOT_TOKEN` en
   el entorno. El bot no debe tener webhook activo. No compartir token, clave ni
   código de vinculación en el repo o en evidencias del piloto.

3. Habilitar Calendar API y configurar un cliente OAuth Desktop y su consentimiento
   según [Calendar](ASSISTANT_CALENDAR.md). Configurar en el entorno
   `ASSISTANT_GOOGLE_CLIENT_ID`, `ASSISTANT_GOOGLE_CLIENT_SECRET` si corresponde y
   `ASSISTANT_CREDENTIAL_KEY` (32 bytes aleatorios, base64). Conservar esa clave
   fuera del directorio de estado y reutilizarla después de reinicios. Configurar
   también la credencial del proveedor del modelo elegido; para OpenAI, seguir
   la [guía de credenciales](CREDENTIALS.md).

4. Ejecutar la comprobación offline, sustituyendo el ID de ejemplo:

   ```sh
   bun run --cwd packages/assistant start --doctor --directory "$HOME/.zhx-pilot" --owner local-owner --provider openai --calendar --telegram-owner 123456789
   ```

   Debe terminar con `ok: true`. Valida forma de configuración, versión de Node
   y directorio, proveedor reconocido y configuración local del proveedor; no
   crea estado ni consulta servicios. No prueba validez remota de credenciales,
   permisos Google, webhook, propietario remoto ni compatibilidad del estado
   existente. La salida enumera expresamente estas comprobaciones pendientes.

5. Con el host detenido, conectar Google desde el mismo equipo:

   ```sh
   bun run --cwd packages/assistant start --directory "$HOME/.zhx-pilot" --owner local-owner --calendar-connect
   bun run --cwd packages/assistant start --directory "$HOME/.zhx-pilot" --owner local-owner --calendar-status
   ```

   Abrir la URL impresa y consentir con la cuenta de prueba prevista. El callback
   es loopback; no usar una sesión remota sin acceso al navegador de esa máquina.
   `calendar-status` consulta estado local, no certifica vigencia remota del token.

6. Iniciar el proceso en primer plano:

   ```sh
   bun run --cwd packages/assistant start --directory "$HOME/.zhx-pilot" --owner local-owner --provider openai --calendar --calendar-id primary --telegram-owner 123456789 --web
   ```

   Debe imprimir `assistant-ready`. Desde la cuenta elegida, enviar al bot por
   privado el `/start CODE` mostrado localmente, dentro de diez minutos. Esperar
   “Propietario vinculado”. Un usuario distinto, grupo o código vencido no vincula.
   Conservar los mismos flags al reiniciar. No ejecutar dos hosts sobre el mismo
   estado ni dos consumidores polling del mismo bot.
   Abrir también el enlace privado `assistant-web` para probar agenda,
   conversaciones y revisiones desde el navegador. El enlace cambia al reiniciar.

7. Pedir la agenda y luego un cambio acotado sobre un evento de prueba organizado
   por la cuenta. Usar asistentes de prueba bajo control del piloto: aprobar
   solicita notificaciones a todos. Verificar antes/después, horario, calendario
   y asistentes en la revisión; solo sus botones aprueban/rechazan. El texto del
   modelo no concede permisos. Comprobar el resultado en Calendar.

8. Activar el resumen explícitamente desde Telegram:

   ```text
   /daily 08:00 America/Argentina/Buenos_Aires
   /memory set conflictBufferMinutes 15
   /memory list
   /daily status
   ```

   Ajustar hora y zona al piloto. El próximo horario siempre es futuro al activar.
   Verificar recepción y conflictos, luego probar `/daily pause`, `/daily resume`
   y `/daily delete`. Detalles de DST, recuperación, presupuesto y olvido en
   [automatizaciones](ASSISTANT_AUTOMATIONS.md).

## Recuperación y cierre

- Apagado normal: SIGINT/SIGTERM (Ctrl+C), esperar `assistant-stopped`; reiniciar
  con el mismo comando, **sin** `--recover`.
- Caída real: comprobar que el proceso anterior murió y reiniciar con `--recover`.
  Un propietario vivo se rechaza. No borrar locks, `host.json` ni bases para saltar
  esta protección. `--recover` no es el inicio normal: sin un lock recuperable el
  servicio puede responder ENOENT.
- Aprobación pendiente: `/pending` muestra el estado persistido. No renueva el
  vencimiento; una revisión cambiada o vencida exige cancelar y proponer de nuevo.
- Escritura incierta Calendar: pedir reconciliación de la operación existente.
  No crear otra modificación para forzar un reenvío. Si no se puede confirmar por
  lectura, inspeccionar el evento localmente y detener esa prueba del piloto.
- Envío incierto Telegram: no se reenvía automáticamente. Registrar incertidumbre
  y comprobar el chat antes de cualquier intervención manual.
- Refresh rechazado: detener host y repetir `--calendar-connect` con la misma
  cuenta sin desconectarla primero; así se conserva su identidad. Una cuenta
  distinta falla cerrada. Clave incorrecta requiere recuperar la clave original,
  no reemplazar el archivo de estado.
- Finalizar piloto: pausar/eliminar resumen, detener host y ejecutar
  `--calendar-disconnect` con directorio/owner. Si devuelve `revoked: false`,
  completar revocación desde Google. Revocar también el bot si deja de usarse.
  Desconectar y reconectar crea otra identidad: usar un nuevo host para ella.

## Matriz de aceptación del piloto real

Registrar al menos tres días locales, sin afirmar que la validación offline los
sustituye. El operador completa una fila por escenario y conserva la evidencia
privada fuera del repo:

| Escenario | Resultado esperado | Estado real |
| --- | --- | --- |
| OAuth, vínculo, conversación y lectura | Cuenta y propietario correctos | Pendiente |
| Cambio aprobado y callback repetido | Un cambio; segundo callback sin efecto | Pendiente |
| Rechazo/cancelación/vencimiento | Ninguna escritura | Pendiente |
| Evento editado por otro cliente antes de aprobar | Conflicto y nueva aprobación | Pendiente |
| Reinicio con revisión pendiente | Misma acción/digest; no permisos nuevos | Pendiente |
| Resumen durante tres días | Día/zona/conflictos correctos; una ocurrencia por día | Pendiente |
| Caída antes del horario y recuperación ese día | Solo el día actual, sin backlog | Pendiente |
| Pausa, corrección y olvido | Sin nuevos envíos pendientes ni activación implícita | Pendiente |
| Expiración/revocación y reconsentimiento | Diagnóstico; recuperación sin cambiar de cuenta | Pendiente |
| Cierre del piloto | Automatización detenida y credenciales revocadas | Pendiente |

Criterio para detener el piloto: escritura sin aprobación, propietario equivocado,
cuenta/calendario incorrectos, efecto duplicado, datos secretos en salidas o
incertidumbre que no pueda explicar el registro. Detener proceso y conservar
estado para diagnóstico. No borrar evidencia ni aprobar repetidamente para “probar”.

## Trazabilidad y evidencia

Conversación: update Telegram → inbox/intent → sesión/run Harness → revisión con
digest → operación Calendar → resultado → outbox/message_id. Resumen:
comando propietario → revisión del horario/preferencias → `daily:AAAA-MM-DD` →
fragmentos outbox/message_id. La entrega es independiente de la ejecución:
`enqueued` no significa recibido; `uncertain` no significa fallido.

Usar `/pending`, `/daily status`, `/memory list` y diagnóstico del host embebido.
Si hace falta investigar, detener primero el host y examinar una copia privada de
sus stores Assistant; no modificar tablas internas de Harness. Las bases contienen
datos personales aunque los tokens OAuth estén cifrados. No adjuntar tokens,
claves, URL OAuth ni bases completas al reporte compartido.

Plantilla por observación: fecha/hora UTC y zona local; escenario; revisión de
código y hash de candidato; updateId; runId/operationId u occurrenceId; IDs de
mensajes; esperado/observado; intervención manual; estado final. Usar identificadores
opacos en el reporte compartido y mantener contenido privado por separado.

## Validación reproducible local

```sh
bun run typecheck
bun run typecheck:tooling
bun run architecture:check
bun run contract:check
bun run docs:check
bun run migration:check
bun run test
bun run test:code
bun run --cwd packages/assistant smoke:installed
```

Reconstruir el candidato primero si cambió Harness. Los tests de recuperación
usan sockets locales y procesos Node; necesitan un entorno que los permita.
La aceptación instalada cubre onboarding offline y comandos CLI, OAuth simulado,
Calendar → host → Telegram → resumen, datos hostiles sin autoridad, aprobaciones,
ETags, duplicados, respuesta perdida, SIGKILL, zonas/DST y preferencias. Los tests
no hacen un consentimiento real, no demuestran entrega de correos ni certifican
la configuración de una cuenta de producción.

## Evidencia local — 2026-11-10

| Comprobación | Resultado |
| --- | --- |
| Harness + Desktop (`bun run test`) | 2376 pass, 1 skip por plataforma, 0 fail; 14990 aserciones, 292 archivos |
| Code (`bun run test:code`) | 170 pass, 0 fail; 2583 aserciones |
| Assistant consumidor instalado | 42 pass, 0 fail; 226 aserciones; tipos, build y ejemplo Node correctos |
| Tipos raíz y tooling | Aprobados |
| Arquitectura y contratos públicos | Aprobados |
| Migraciones históricas 0.10.0/0.11.1 | Aprobadas |
| Documentación y whitespace | Aprobados |

Candidato instalado: Harness 1.6.3 no publicado, SHA-256
`773a1929d356d5b2a72bf6a5d4b2215f425573992dd8dabee97c01228b9474b5`.
El hash identifica ese artefacto ensayado; no certifica el paquete de registry.
La prueba omitida corresponde al rechazo del handoff nativo en plataformas no
soportadas, condición que no aplica en esta máquina. No hubo fallos omitidos.

La validación local incluye reinicios reales de procesos y SIGKILL; los servicios
Google, Telegram y modelos se simulan. No se ejecutaron despliegues, publicación,
merge, consentimiento real ni piloto de varios días. La rama sigue siendo
`feat/assistant-phase-0`; la matriz real anterior permanece pendiente.
