# Assistant web

La interfaz local implementa la propuesta visual aprobada: inicio con agenda,
aprobaciones, resumen diario, conversaciones, conexiones y módulos. Es una
instancia por propietario. No incorpora todavía un catálogo de agentes ni múltiples bots.

## Configuración sin terminal

Abrir el lanzador local de macOS con doble clic. El nuevo modo administrado
permite probar el modelo y conectar Calendar/Telegram desde la web, antes de
crear el host. Ver [onboarding web](ASSISTANT_WEB_ONBOARDING.md) para uso,
preparación del lanzador y límites de distribución.

## Ejecutar el host CLI avanzado

Preparar el candidato local según `packages/assistant/README.md`, luego:

```sh
bun run --cwd packages/assistant build
bun run --cwd packages/assistant start --directory "$HOME/.zhx-a" --owner local-owner --config /ruta/assistant.json --web
```

Abrir el enlace privado del registro `assistant-web`. El puerto es dinámico;
`--web-port 4176` permite fijarlo. El servidor escucha exclusivamente en
`127.0.0.1`. El token aleatorio viaja en el fragmento inicial, se guarda en
sessionStorage y se retira de la URL. Cambia al reiniciar: volver a abrir el nuevo
enlace. No publicar mediante un proxy ni compartir el enlace.

Las conversaciones y aprobaciones conservan la persistencia del host. La web usa
el protocolo público del Harness y vuelve a consultar la revisión al aprobar;
una revisión cambiada o vencida exige actualizarla. Una decisión repetida no
repite el efecto. Calendar conserva su revalidación e idempotencia existentes.
La vista muestra las últimas 20 conversaciones y hasta 10 ejecuciones por cada una.

El resumen diario requiere Calendar y Telegram vinculado. Su edición, pausa y
eliminación usan el scheduler persistente existente. La zona de la agenda toma
la zona del sistema; una aplicación que embeba el host puede pasar `web.timeZone`.
La zona del resumen se configura por separado desde su formulario.

En el host CLI avanzado, conexiones, proveedor y módulos muestran el estado
real y se configuran con los flujos del host. En el modo administrado, el botón
Configuración abre los formularios web para las credenciales y conexiones. No se modifican eventos al abrir la agenda.

## Demostración visual

```sh
bun run --cwd packages/assistant dev:web --host 127.0.0.1 --port 4175
```

Abrir `http://127.0.0.1:4175/?demo=1`. La etiqueta indica datos de ejemplo.
Los cambios son simulados en memoria y se reinician al recargar: no se llama al
host, a Telegram ni a Calendar. El servidor Vite sirve para esta vista de diseño;
para datos reales usar el host con `--web`, que sirve el build y la API juntos.

## Validación

`bun run --cwd packages/assistant smoke:installed` construye la interfaz y valida
el consumidor aislado. `tests/web.test.ts` cubre autenticación, Host/Origin,
confinamiento de assets, deduplicación del envío, recuperación y rotación del
token, revisión obsoleta, efecto único y agenda incompleta. Las regresiones
existentes cubren reinicios reales, Telegram, Calendar y scheduler.

Evidencia visual y diferencias intencionales: `packages/assistant/web/design-qa.md`.
