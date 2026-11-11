# Assistant — Automatizaciones y memoria personal (fase 4)

Un resumen diario por propietario, sobre el calendario conectado. Se activa
explícitamente desde el chat privado vinculado; iniciar el host no lo activa.
Requiere Calendar y Telegram configurados según [Calendar](ASSISTANT_CALENDAR.md).
No necesita otra clave ni cambia el perfil de fase 3: se puede reutilizar ese
directorio, cuenta y vinculación. La migración del store Telegram es aditiva.

## Uso desde Telegram

```text
/daily 08:00 America/Argentina/Buenos_Aires
/daily status
/daily pause
/daily resume
/daily delete
```

El primer comando guarda hora y zona, el calendario fijado por el host y un margen
de conflicto inicial de cero minutos. Activa el próximo horario futuro. Pausar
cancela lecturas/entregas pendientes; reanudar programa el próximo horario, sin
recuperar ejecuciones canceladas. Eliminar quita la automatización, conservando
preferencias y recibos de ocurrencias para impedir duplicados al recrearla.
Un envío que ya empezó no puede retirarse.

Memoria personal explícita, limitada a preferencias de esta automatización:

```text
/memory list
/memory set conflictBufferMinutes 15
/memory set localTime 09:00
/memory set timeZone Europe/Madrid
/memory set calendarId primary
/memory forget localTime
/memory forget all
```

Cada valor conserva procedencia del mensaje autenticado del propietario y fecha.
Corregir una preferencia recalcula el horario futuro y cancela trabajo pendiente;
no activa una automatización pausada. El calendario solo puede ser el configurado
en el host, nunca una cuenta seleccionada por un mensaje. El margen admite 0–120
minutos. Olvidar elimina la preferencia activa y pausa el resumen hasta completar
la configuración; no borra mensajes ya enviados, inbox, historial conversacional
ni recibos operativos. No hay extracción automática, memoria semántica ni texto
libre convertido en instrucciones. Las preferencias nunca conceden permisos.

## Horario, reinicios y presupuesto

- Se usa la zona explícita mediante `Intl`, independientemente de la zona del SO.
  Una hora repetida por DST se ejecuta en su primera aparición. Si la hora no
  existe por un salto, se usa el primer minuto existente posterior de ese día.
  Un día completo inexistente se omite. El intervalo leído respeta días de 23/25 horas.
- El scheduler consulta cada 30 segundos con el host en ejecución. No instala un
  servicio del SO ni puede despertar una máquina suspendida.
- Política `catch-up-today`: tras reiniciar recupera solo la ocurrencia pendiente
  del día local actual, si ya pasó su horario. Omite fechas anteriores; no acumula
  un backlog. Un resumen en cola vence al terminar su día, incluso si el proceso
  reinicia antes de que el scheduler vuelva a consultar.
- Una ocurrencia por fecha local, con al menos 20 horas entre admisiones. Ese límite
  también rige al cambiar zona/horario o recrear la automatización; una recuperación
  muy tardía puede hacer que se omita el horario siguiente para evitar una ráfaga.
- Máximo tres intentos de lectura, separados por cinco minutos, con presupuesto
  de 60 segundos por intento y hasta diez páginas de 100 eventos. El contador
  persiste incluso si se interrumpe la lectura. Una agenda incompleta produce un
  aviso de fallo, nunca un resumen que afirme que no hay conflictos.
- Hasta 3660 recibos de ocurrencia, sin borrado automático que pierda deduplicación.
  Al alcanzar el límite se detienen nuevas admisiones y se informa fallo en
  diagnóstico. No hay consumo de tokens de modelo en este resumen determinista.

## Contenido y seguridad

El resumen incluye agenda, zona, calendario y conflictos. Compara intervalos
ocupados y el margen explícito; dos eventos adyacentes no chocan con margen cero.
Incluye eventos de día completo y excluye de conflictos eventos cancelados,
marcados libres o rechazados por el propietario. Muestra hasta 60 eventos y 20
pares en conflicto, indicando el total; analiza todos los eventos recuperados.
Es una lectura informativa del momento, no una instantánea transaccional de Google.

Títulos son datos, no instrucciones: se entregan como texto sin formato y sin
pasar por el modelo. El scheduler recibe únicamente la capacidad de listar el
calendario; no puede modificarlo. Las modificaciones conversacionales conservan
la aprobación, revalidación e idempotencia de fase 3. No se agregan permisos,
herramientas ni memoria al perfil de Harness.

## Persistencia y entrega

Assistant agrega `personal_preferences`, `daily_schedule`, `daily_occurrences`
y vencimiento opcional de outbox a su propio `state/telegram.sqlite`. Comparte
el lease exclusivo de Telegram y su binding propietario/bot/chat. La fuente queda
además ligada a la conexión/calendario. No lee tablas internas de Harness.

La clave `daily:AAAA-MM-DD` identifica la ocurrencia dentro del propietario y
conexión fijados. Registrar el resumen en outbox y marcarlo preparado es una sola
transacción. Reiniciar después de ese commit entrega el texto persistido sin otra
lectura. Si el proceso muere durante la lectura, puede repetirla dentro del
presupuesto; nunca repite una escritura Calendar. Pausar, eliminar o corregir
preferencias invalida los resultados en curso por revisión y estado.

Las entregas usan la cola de Telegram existente: deduplicación local, reintentos
acotados para rechazos reintentables y estado incierto si el envío pudo ocurrir.
Un envío incierto no se repite automáticamente. `/daily status` muestra estado,
próximo horario, últimas ocurrencias y contadores de fragmentos de entrega. Un
resumen preparado no implica que todos sus fragmentos hayan llegado.

Preferencias, recibos y textos de agenda están en el store privado con permisos
locales, sin cifrado adicional; OAuth sigue cifrado con la clave externa de fase 3.

## Validación

`tests/automation.test.ts` cubre zonas y DST, recuperación del día actual, omisión
de días anteriores, deduplicación, pausa durante lecturas, edición/olvido de
preferencias, límites de reintentos y paginación, conflictos y expiración de envíos.
La aceptación integrada usa host y Telegram bridge reales con APIs simuladas.
`tests/fixtures/daily-process.mjs` prueba SIGKILL durante una lectura, recuperación
con otro proceso Node, entrega única y un segundo reinicio sin otra lectura.
No se enviaron mensajes reales ni se habilitó una automatización en una cuenta.

Aceptación local 2026-11-10: `smoke:installed` pasó con 39 pruebas, 204 aserciones,
0 fallos, typecheck y ejemplo offline Node. Candidato Harness 1.6.3 no publicado,
SHA-256 `54b1e7aaab287f3b37fa3d6194fe3b3904375956bf48507ffefdf52d5e495052`.
También pasaron `architecture:check`, `contract:check`, `docs:check` y
`git diff --check`. No se hizo merge ni publicación.
