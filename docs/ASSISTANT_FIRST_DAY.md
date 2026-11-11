# Assistant: primera sesión de uso

Objetivo: probar un recorrido útil hoy y registrar problemas reproducibles.
Esto inicia el piloto; no sustituye los tres días de aceptación de
[ASSISTANT_PILOT.md](ASSISTANT_PILOT.md).

## Preparación

Desde la raíz del repositorio:

```sh
bun run build
bun run --cwd packages/assistant prepare:local
bun run --cwd packages/assistant build
bun run --cwd packages/assistant typecheck
```

Configurar en la terminal las credenciales descritas en el onboarding del piloto.
No pegar secretos en conversaciones ni en reportes. Para OpenAI se necesita
`OPENAI_API_KEY`; para Qwen, `DASHSCOPE_API_KEY` o `QWEN_API_KEY` y seleccionar
`--provider qwen`. Usar siempre el mismo proveedor/modelo y directorio al reiniciar.
Si ya existe una instancia, conservar sus opciones y clave de cifrado.

Los siguientes comandos usan OpenAI y un directorio nuevo como ejemplo.
Reemplazar `123456789` por el ID numérico de la cuenta Telegram del propietario:

```sh
bun run --cwd packages/assistant start --doctor --directory "$HOME/.zhx-pilot" --owner local-owner --provider openai --calendar --telegram-owner 123456789 --web
```

Continuar cuando devuelva `ok: true`. Es un diagnóstico offline: comprueba la
configuración local, pero no autentica contra Google, Telegram ni el modelo.
Con el host detenido, conectar Calendar si todavía no está conectado:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-pilot" --owner local-owner --calendar-connect
```

Abrir la URL OAuth local y completar el consentimiento con la cuenta de prueba.
Después iniciar el host y dejar la terminal abierta:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-pilot" --owner local-owner --provider openai --calendar --telegram-owner 123456789 --web
```

Abrir el enlace `assistant-web`. Vincular Telegram enviando al bot por privado
el `/start CODE` impreso en esa terminal. El enlace web y el código de vinculación
son privados. La interfaz Vite con `?demo=1` usa datos simulados: para esta prueba
usar exclusivamente el enlace del host.

## Recorrido de 30–45 minutos

Usar eventos de prueba y asistentes bajo control propio. Las modificaciones
aprobadas pueden notificar a los asistentes del evento.

| Paso | Acción | Qué comprobar |
| --- | --- | --- |
| 1 | Abrir agenda web y pedir por Telegram «Mostrame mi agenda de hoy y sus conflictos». | Cuenta, fecha, zona y eventos coinciden con Calendar. |
| 2 | Pedir mover un evento de prueba a una hora concreta. | La propuesta muestra evento, horario y asistentes; Calendar sigue sin cambios antes de aprobar. |
| 3 | Rechazar esa propuesta. | No cambia el evento. |
| 4 | Pedir otra propuesta y aprobarla una vez desde su revisión. | Calendar refleja exactamente el cambio; registrar cualquier notificación inesperada. |
| 5 | Dejar una propuesta pendiente, detener con Ctrl+C y esperar `assistant-stopped`. Reiniciar con el mismo comando. | La revisión sigue disponible. Si venció, cancelar y proponer de nuevo. Abrir el nuevo enlace web. |
| 6 | Configurar el resumen para dentro de unos minutos desde la web o `/daily HH:mm America/Argentina/Buenos_Aires`. | `/daily status` muestra la próxima hora; llega un resumen y coincide con la agenda. Mantener el host encendido. |
| 7 | Enviar `/daily pause`. | Estado pausado; no quedan nuevas ejecuciones habilitadas. |

Web y Telegram permiten comprobar cada superficie; no asumir que crean la misma
conversación. El resumen requiere Calendar y Telegram vinculado. Su contenido es
determinista: todavía no ejecuta instrucciones generales como investigar noticias.

Para el reinicio normal no usar `--recover`. Reservarlo para una caída real y
seguir la guía de recuperación del piloto. Si una respuesta se pierde, consultar
el estado antes de repetir la acción.

## Registro de resultados

Guardar una copia privada de esta tabla y completar una fila por intento:

| Hora y zona | Escenario | Esperado | Observado | Duración aproximada | Intervenciones manuales | ID de ejecución/operación disponible | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | Pendiente |

Resultados sugeridos: completado, bloqueado, incorrecto o incierto. Registrar
también pasos confusos, aprobaciones innecesarias y oportunidades para automatizar.
Conservar la revisión del código (`git rev-parse HEAD`) y anotar que hay cambios
locales si corresponde. No adjuntar bases, credenciales, enlaces privados ni
contenido personal al reporte compartido.

Ante una escritura no aprobada, cuenta incorrecta, duplicación o efecto incierto
sin explicación, detener el proceso y conservar el estado para diagnosticar.
Al terminar la sesión, dejar el resumen pausado o eliminarlo con `/daily delete`.
Si se continúa el piloto otro día, mantener credenciales y directorio; la
revocación final se describe en la guía completa.
